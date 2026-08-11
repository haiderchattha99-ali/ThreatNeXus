import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Phase 10A-1 — the two behaviours the Codex independent review found missing,
// proven against real PostgreSQL because both are about what survives a crash
// and what a real unique index does under concurrency.
//
// ===========================================================================
// 1. CONVERGENT MATERIALIZATION
// ===========================================================================
// "Materialize only when the run has zero items" permanently loses targets if a
// process dies after committing some of them: the replay sees a non-empty run
// and writes nothing more. These tests delete all but one item — exactly what a
// crash mid-loop leaves behind — and prove the identical repeat request fills
// in every missing item exactly once, preserves the surviving item's identity
// and its job's identity, and converges under concurrency.
//
// ===========================================================================
// 2. NO UNLINKED DELEGATED JOB
// ===========================================================================
// A ProviderLookupJob with trigger=RUN_DELEGATED, state=PENDING and no delegate
// FK is a job nothing can ever finish — no Phase-10 worker exists to run it and
// reconciliation has no delegate row to read a verdict from. It would hold
// activeLookupKey forever and block every future ask about that subject. These
// tests prove the delegate is established through the CANONICAL queue service
// first, and that when one cannot be established the item degrades to
// SKIPPED_EXECUTION_UNAVAILABLE with no job at all.
//
// Every provider credential below is a FAKE injected into process.env by this
// file. Nothing here contacts a provider — tests/unit/…Inertness.test.js is the
// static proof that the package could not, even if a path tried.
//
// Self-skips unless TEST_DATABASE_URL is set.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

process.env.DATABASE_URL = process.env.DATABASE_URL || TEST_DATABASE_URL || "postgresql://x:y@localhost:5432/x";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-32-chars-min!!";
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
process.env.ABUSEIPDB_API_KEY = "fake-abuseipdb-key-for-tests";
process.env.CENSYS_PAT = "fake-censys-pat-for-tests";
process.env.NVD_API_KEY = "fake-nvd-key-for-tests";
process.env.SHODAN_API_KEY = "";
process.env.GREYNOISE_API_KEY = "";
process.env.NETLAS_API_KEY = "";

const { PrismaClient } = require("@prisma/client");
const {
  createEnrichmentRun,
} = require("../../src/services/enrichmentOrchestration/enrichmentRunService");
const {
  RUN_ITEM_DECISIONS,
  JOB_STATES,
  JOB_TRIGGERS,
  SKIP_REASONS,
} = require("../../src/services/enrichmentOrchestration/enrichmentDecisionCodes");
const { scheduleEnrichment } = require("../../src/services/enrichment/enrichmentQueueService");
const { INDICATOR_TYPES } = require("../../src/services/enrichment/iocEnrichmentTypes");
const env = require("../../src/config/env");

// RFC 5737 TEST-NET-2, in a range no suite prefix-deletes. Several concurrency
// suites blanket-delete by indicator PREFIX (203.0.113.2/.4/.5/.9, 192.0.2.),
// so an address is only safe if it falls outside all of them.
const IP_A = "198.51.100.161";
const IP_B = "198.51.100.162";
const MARKER_PORT = 33894;
const CVE_IDS = ["CVE-2098-2001", "CVE-2098-2002", "CVE-2098-2003"];
const NOW = new Date("2026-08-12T10:00:00.000Z");

// The IPv4 provider scope used by the recovery tests: five targets on one
// Finding, so "some items committed, some not" is a state that can exist.
const ALL_IPV4_PROVIDERS = ["abuseipdb", "censys", "greynoise", "shodan", "netlas"];

let prisma;

/** The delegate identity production uses — built from the same inputs. */
function abuseIdentity(indicator) {
  return {
    provider: "abuseipdb",
    indicatorType: INDICATOR_TYPES.IPV4,
    indicator,
    queryParams: { maxAgeInDays: env.ABUSEIPDB_MAX_AGE_DAYS },
  };
}

/**
 * A client whose IocEnrichment insert always fails with a NON-retryable error,
 * so the canonical scheduling service propagates instead of converging. That is
 * the "scheduling refusal/failure" condition, injected at the database boundary
 * rather than by stubbing the service — stubbing the service would prove only
 * that the stub was called.
 */
function clientRefusingIocCreate(base) {
  const iocEnrichment = new Proxy(base.iocEnrichment, {
    get(target, prop) {
      if (prop === "create") {
        return async () => {
          const error = new Error("delegate scheduling refused");
          // Not P2002/P2034, so the queue service's bounded retry does not
          // absorb it and the caller genuinely sees a failure.
          error.code = "P2010";
          throw error;
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "iocEnrichment") return iocEnrichment;
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM "FindingEnrichmentRunItem" WHERE "findingId" IN
       (SELECT id FROM "Finding" WHERE "port" IN ($1, $1 + 1))`,
    MARKER_PORT
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "FindingEnrichmentRun" WHERE "findingId" IN
       (SELECT id FROM "Finding" WHERE "port" IN ($1, $1 + 1))`,
    MARKER_PORT
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "ProviderLookupJob" WHERE "subjectValue" IN ($1,$2,$3,$4,$5)`,
    IP_A,
    IP_B,
    ...CVE_IDS
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "FindingVulnerability" WHERE "findingId" IN
       (SELECT id FROM "Finding" WHERE "port" IN ($1, $1 + 1))`,
    MARKER_PORT
  );
  // AuditLog.entityId is a String column, so the subquery is cast.
  await prisma.$executeRawUnsafe(
    `DELETE FROM "AuditLog" WHERE "entityType" = 'Finding' AND "entityId" IN
       (SELECT id::text FROM "Finding" WHERE "port" IN ($1, $1 + 1))`,
    MARKER_PORT
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "Finding" WHERE "port" IN ($1, $1 + 1)`, MARKER_PORT);
  // Delegate rows, jobs first (FK RESTRICT onto Vulnerability).
  await prisma.$executeRawUnsafe(
    `DELETE FROM "VulnerabilityEnrichmentJob" WHERE "vulnerabilityId" IN
       (SELECT id FROM "Vulnerability" WHERE "cveId" IN ($1,$2,$3))`,
    ...CVE_IDS
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Vulnerability" WHERE "cveId" IN ($1,$2,$3)`,
    ...CVE_IDS
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "IocEnrichment" WHERE "indicator" IN ($1,$2)`,
    IP_A,
    IP_B
  );
}

async function makeFinding(indicatorValue, port = MARKER_PORT) {
  return prisma.finding.create({
    data: {
      indicatorValue,
      port,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      firstSeen: NOW,
      lastSeen: NOW,
    },
  });
}

async function attachVerifiedCve(findingId, cveId) {
  const vulnerability = await prisma.vulnerability.create({ data: { cveId } });
  await prisma.findingVulnerability.create({
    data: {
      findingId,
      vulnerabilityId: vulnerability.id,
      state: "ACTIVE",
      evidenceSource: "ANALYST_VERIFIED",
      justification: "verified for the Phase 10A-1 delegate test",
      effectiveAt: NOW,
    },
  });
  return vulnerability;
}

/** The exact same ask, every time — so replays share one idempotency key. */
function ipv4Ask(client) {
  return {
    client,
    trigger: "MANUAL",
    providers: ALL_IPV4_PROVIDERS,
    idempotencyKeyHash: "a".repeat(64),
    now: NOW,
  };
}

/** How many delegate FKs a job carries. Must be exactly 1 for RUN_DELEGATED. */
function delegateLinkCount(job) {
  return [
    job.iocEnrichmentId,
    job.vulnerabilityEnrichmentJobId,
    job.censysEnrichmentId,
    job.greyNoiseEnrichmentId,
    job.shodanEnrichmentId,
    job.netlasEnrichmentId,
  ].filter((value) => value !== null && value !== undefined).length;
}

/** Nothing was executed, by any path, for any of this file's subjects. */
async function expectNothingExecuted() {
  expect(await prisma.providerLookupAttempt.count()).toBe(0);
  expect(await prisma.providerDailyUsage.count()).toBe(0);
  const jobs = await prisma.providerLookupJob.findMany({
    where: { subjectValue: { in: [IP_A, IP_B, ...CVE_IDS] } },
  });
  // eslint-disable-next-line no-restricted-syntax
  for (const job of jobs) {
    expect(job.queriedAt).toBeNull();
    expect(job.claimedAt).toBeNull();
    expect(job.claimToken).toBeNull();
    expect(job.attemptCount).toBe(0);
    // THE structural invariant: a delegated job always has exactly one FK.
    if (job.trigger === JOB_TRIGGERS.RUN_DELEGATED) {
      expect(delegateLinkCount(job)).toBe(1);
      expect(job.state).toBe(JOB_STATES.WAITING_ON_DELEGATE);
    } else {
      expect(delegateLinkCount(job)).toBe(0);
    }
  }
}

const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

describeOrSkip("Phase 10A-1 partial-materialization recovery (real PostgreSQL)", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
  });

  beforeEach(cleanup);

  afterAll(async () => {
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
  });

  it("fills in every item a crash left unwritten, exactly once, preserving what survived", async () => {
    const finding = await makeFinding(IP_A);

    const first = await createEnrichmentRun(finding.id, ipv4Ask(prisma));
    expect(first.created).toBe(true);
    expect(first.items).toHaveLength(ALL_IPV4_PROVIDERS.length);

    // Simulate a crash that committed only ONE item: keep the first, delete
    // the rest. The jobs those items pointed at deliberately survive, exactly
    // as they would after a real crash between two INSERTs.
    const survivor = first.items[0];
    await prisma.findingEnrichmentRunItem.deleteMany({
      where: { runId: first.run.id, id: { not: survivor.id } },
    });
    expect(
      await prisma.findingEnrichmentRunItem.count({ where: { runId: first.run.id } })
    ).toBe(1);

    // The IDENTICAL request again. Same idempotency key, so it must converge
    // onto the same run rather than creating a second one.
    const replay = await createEnrichmentRun(finding.id, ipv4Ask(prisma));

    expect(replay.run.id).toBe(first.run.id);
    expect(replay.created).toBe(false);
    expect(replay.outcome).toBe("ALREADY_RUNNING");
    // Every missing item is back...
    expect(replay.items).toHaveLength(ALL_IPV4_PROVIDERS.length);
    expect(replay.itemsCreated).toBe(ALL_IPV4_PROVIDERS.length - 1);
    // ...exactly once (the unique constraint would not have stopped a second
    // run row, so this counts rows rather than trusting the return value).
    expect(
      await prisma.findingEnrichmentRunItem.count({ where: { runId: first.run.id } })
    ).toBe(ALL_IPV4_PROVIDERS.length);
    expect(await prisma.findingEnrichmentRun.count({ where: { findingId: finding.id } })).toBe(1);

    // The surviving item kept its identity AND its decision — a replay adds
    // what is missing, it never rewrites what was already decided.
    const survivorAfter = await prisma.findingEnrichmentRunItem.findUnique({
      where: { id: survivor.id },
    });
    expect(survivorAfter).toBeTruthy();
    expect(survivorAfter.decision).toBe(survivor.decision);
    expect(survivorAfter.lookupJobId).toBe(survivor.lookupJobId);

    // Job identities are preserved too: the recreated items re-found the jobs
    // the first pass created rather than creating a second set.
    const firstJobIds = first.items.map((item) => item.lookupJobId).filter(Boolean).sort();
    const replayJobIds = replay.items.map((item) => item.lookupJobId).filter(Boolean).sort();
    expect(replayJobIds).toEqual(firstJobIds);

    await expectNothingExecuted();
  });

  it("converges when two identical replays race a partial write", async () => {
    const finding = await makeFinding(IP_A);

    const first = await createEnrichmentRun(finding.id, ipv4Ask(prisma));
    const survivor = first.items[0];
    await prisma.findingEnrichmentRunItem.deleteMany({
      where: { runId: first.run.id, id: { not: survivor.id } },
    });

    // Separate clients = separate connection pools = a real race. A single
    // shared client serializes enough on its pool to hide it.
    const racerA = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    const racerB = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const [a, b] = await Promise.all([
        createEnrichmentRun(finding.id, ipv4Ask(racerA)),
        createEnrichmentRun(finding.id, ipv4Ask(racerB)),
      ]);

      expect(a.run.id).toBe(first.run.id);
      expect(b.run.id).toBe(first.run.id);
      // Neither racer duplicated anything: the run has exactly its expected
      // item set, and between them they created exactly the missing four.
      expect(
        await prisma.findingEnrichmentRunItem.count({ where: { runId: first.run.id } })
      ).toBe(ALL_IPV4_PROVIDERS.length);
      expect(a.itemsCreated + b.itemsCreated).toBe(ALL_IPV4_PROVIDERS.length - 1);
      expect(await prisma.findingEnrichmentRun.count({ where: { findingId: finding.id } })).toBe(1);
      // One job per (provider, subject), never two.
      const jobs = await prisma.providerLookupJob.findMany({ where: { subjectValue: IP_A } });
      expect(new Set(jobs.map((job) => job.provider)).size).toBe(jobs.length);
    } finally {
      await racerA.$disconnect();
      await racerB.$disconnect();
    }

    await expectNothingExecuted();
  });
});

describeOrSkip("Phase 10A-1 delegated jobs are never unlinked (real PostgreSQL)", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
  });

  beforeEach(cleanup);

  afterAll(async () => {
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
  });

  it("creates the canonical IOC delegate when none exists, and links it", async () => {
    const finding = await makeFinding(IP_A);
    expect(await prisma.iocEnrichment.count({ where: { indicator: IP_A } })).toBe(0);

    const run = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["abuseipdb"],
      now: NOW,
    });

    expect(run.items).toHaveLength(1);
    expect(run.items[0].decision).toBe(RUN_ITEM_DECISIONS.ELIGIBLE);

    const job = await prisma.providerLookupJob.findUnique({
      where: { id: run.items[0].lookupJobId },
    });
    expect(job.trigger).toBe(JOB_TRIGGERS.RUN_DELEGATED);
    expect(job.state).toBe(JOB_STATES.WAITING_ON_DELEGATE);
    expect(job.iocEnrichmentId).not.toBeNull();
    expect(delegateLinkCount(job)).toBe(1);

    // The delegate is a real, canonical, still-PENDING IocEnrichment row —
    // created by the existing queue service, not by a Phase-10 copy of it.
    const delegate = await prisma.iocEnrichment.findUnique({ where: { id: job.iocEnrichmentId } });
    expect(delegate.provider).toBe("abuseipdb");
    expect(delegate.indicator).toBe(IP_A);
    expect(delegate.status).toBe("PENDING");
    expect(delegate.activeCacheKey).not.toBeNull();
    expect(delegate.queriedAt).toBeNull();
    expect(await prisma.iocEnrichment.count({ where: { indicator: IP_A } })).toBe(1);

    await expectNothingExecuted();
  });

  it("links the EXISTING active IOC delegate instead of creating a second one", async () => {
    const finding = await makeFinding(IP_A);

    // Somebody else — ingestion, or an analyst — already scheduled it.
    const existing = await scheduleEnrichment(abuseIdentity(IP_A), { client: prisma, asOf: NOW });
    expect(existing.outcome).toBe("SCHEDULED");

    const run = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["abuseipdb"],
      now: NOW,
    });

    const job = await prisma.providerLookupJob.findUnique({
      where: { id: run.items[0].lookupJobId },
    });
    expect(job.iocEnrichmentId).toBe(existing.record.id);
    // Exactly one delegate row for this indicator — the existing one.
    expect(await prisma.iocEnrichment.count({ where: { indicator: IP_A } })).toBe(1);

    await expectNothingExecuted();
  });

  it("schedules a NEW delegate past a terminal prior IOC row, preserving that history", async () => {
    const finding = await makeFinding(IP_A);

    // A prior lookup that finished and then EXPIRED: terminal, no active key,
    // no longer fresh. It must neither block new work nor be linked.
    const prior = await scheduleEnrichment(abuseIdentity(IP_A), { client: prisma, asOf: NOW });
    await prisma.iocEnrichment.update({
      where: { id: prior.record.id },
      data: {
        status: "SUCCESS",
        queriedAt: new Date(NOW.getTime() - 90 * 24 * 3600 * 1000),
        expiresAt: new Date(NOW.getTime() - 60 * 24 * 3600 * 1000),
        activeCacheKey: null,
      },
    });

    const run = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["abuseipdb"],
      now: NOW,
    });

    const job = await prisma.providerLookupJob.findUnique({
      where: { id: run.items[0].lookupJobId },
    });
    expect(job.iocEnrichmentId).not.toBeNull();
    // A NEW delegate, not the retired one.
    expect(job.iocEnrichmentId).not.toBe(prior.record.id);
    expect(delegateLinkCount(job)).toBe(1);

    // History is preserved by construction: the terminal row still exists.
    const priorAfter = await prisma.iocEnrichment.findUnique({ where: { id: prior.record.id } });
    expect(priorAfter.status).toBe("SUCCESS");
    expect(await prisma.iocEnrichment.count({ where: { indicator: IP_A } })).toBe(2);

    await expectNothingExecuted();
  });

  it("records SKIPPED_EXECUTION_UNAVAILABLE and NO job when the delegate cannot be scheduled", async () => {
    const finding = await makeFinding(IP_B);

    const run = await createEnrichmentRun(finding.id, {
      client: clientRefusingIocCreate(prisma),
      trigger: "MANUAL",
      providers: ["abuseipdb"],
      now: NOW,
    });

    expect(run.items).toHaveLength(1);
    expect(run.items[0].decision).toBe(RUN_ITEM_DECISIONS.SKIPPED_EXECUTION_UNAVAILABLE);
    expect(run.items[0].skipReason).toBe(SKIP_REASONS.DELEGATE_UNAVAILABLE);
    // The whole point: no fabricated link, and no stranded delegated job.
    expect(run.items[0].lookupJobId).toBeNull();
    expect(
      await prisma.providerLookupJob.count({ where: { subjectValue: IP_B, provider: "abuseipdb" } })
    ).toBe(0);
    // The refusal did not abort the run — it is recorded as a decision.
    expect(run.run.state).toBe("SKIPPED");

    await expectNothingExecuted();
  });

  it("creates the canonical vulnerability delegate for a verified CVE, and links it", async () => {
    const finding = await makeFinding(IP_A);
    await attachVerifiedCve(finding.id, CVE_IDS[0]);

    const run = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["nvd"],
      now: NOW,
    });

    expect(run.items).toHaveLength(1);
    expect(run.items[0].decision).toBe(RUN_ITEM_DECISIONS.ELIGIBLE);

    const job = await prisma.providerLookupJob.findUnique({
      where: { id: run.items[0].lookupJobId },
    });
    expect(job.trigger).toBe(JOB_TRIGGERS.RUN_DELEGATED);
    expect(job.state).toBe(JOB_STATES.WAITING_ON_DELEGATE);
    expect(job.vulnerabilityEnrichmentJobId).not.toBeNull();
    expect(job.iocEnrichmentId).toBeNull();
    expect(delegateLinkCount(job)).toBe(1);

    const delegate = await prisma.vulnerabilityEnrichmentJob.findUnique({
      where: { id: job.vulnerabilityEnrichmentJobId },
      include: { vulnerability: true },
    });
    expect(delegate.vulnerability.cveId).toBe(CVE_IDS[0]);
    expect(delegate.status).toBe("PENDING");
    expect(delegate.activeJobKey).not.toBeNull();

    await expectNothingExecuted();
  });

  it("keeps ONE delegated job per verified CVE for three CVEs", async () => {
    const finding = await makeFinding(IP_A);
    // eslint-disable-next-line no-restricted-syntax
    for (const cveId of CVE_IDS) {
      // eslint-disable-next-line no-await-in-loop
      await attachVerifiedCve(finding.id, cveId);
    }

    const run = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["nvd"],
      now: NOW,
    });

    expect(run.items).toHaveLength(3);
    expect(run.items.map((item) => item.subjectValue).sort()).toEqual([...CVE_IDS].sort());

    const jobIds = run.items.map((item) => item.lookupJobId);
    expect(new Set(jobIds).size).toBe(3);

    const jobs = await prisma.providerLookupJob.findMany({ where: { id: { in: jobIds } } });
    const delegateIds = jobs.map((job) => job.vulnerabilityEnrichmentJobId);
    // Three CVEs, three DISTINCT delegates — never one collapsed subject.
    expect(new Set(delegateIds).size).toBe(3);
    // eslint-disable-next-line no-restricted-syntax
    for (const job of jobs) {
      expect(delegateLinkCount(job)).toBe(1);
    }
    expect(
      await prisma.vulnerabilityEnrichmentJob.count({
        where: { vulnerability: { cveId: { in: CVE_IDS } } },
      })
    ).toBe(3);

    await expectNothingExecuted();
  });

  it("leaves the ADMIN vulnerability batch's own scheduling behaviour unchanged", async () => {
    const finding = await makeFinding(IP_A);
    await attachVerifiedCve(finding.id, CVE_IDS[0]);

    // Phase 10 schedules the delegate...
    const run = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["nvd"],
      now: NOW,
    });
    const job = await prisma.providerLookupJob.findUnique({
      where: { id: run.items[0].lookupJobId },
    });

    // ...and a SECOND Phase-10 ask (a different scope, so a different run)
    // reuses that same delegate rather than queueing the CVE twice. Active-job
    // uniqueness is the canonical service's rule and Phase 10 never bypasses it.
    const second = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["nvd"],
      force: true,
      now: NOW,
    });
    expect(second.run.id).not.toBe(run.run.id);
    const secondJob = await prisma.providerLookupJob.findUnique({
      where: { id: second.items[0].lookupJobId },
    });
    expect(secondJob.id).toBe(job.id);
    expect(
      await prisma.vulnerabilityEnrichmentJob.count({
        where: { vulnerability: { cveId: CVE_IDS[0] } },
      })
    ).toBe(1);

    await expectNothingExecuted();
  });
});
