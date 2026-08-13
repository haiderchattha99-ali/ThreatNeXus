import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Phase 10A-2 — the core-guarantee execution suite.
//
// ===========================================================================
// What this file proves, and why each case exists
// ===========================================================================
// Every case here maps to one of the seven binding guarantees, or to a defect
// an independent design review found in the contract before any code existed.
// Nothing here asserts an implementation detail for its own sake.
//
// NO LIVE PROVIDER IS EVER CONTACTED. Direct providers are driven through an
// injected `fetchImpl`, which exercises the REAL provider parsing and the real
// normalized result model while contacting nobody. A test that stubbed the
// provider itself would prove nothing about the code that runs in production.
//
// Self-skips unless TEST_DATABASE_URL is set.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

process.env.DATABASE_URL = process.env.DATABASE_URL || TEST_DATABASE_URL || "postgresql://x:y@localhost:5432/x";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-32-chars-min!!";
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
// Fake credentials. Only their PRESENCE is ever read; no value below is a
// credential to anything that exists.
process.env.CENSYS_PAT = "fake-censys-pat-for-tests";
process.env.CENSYS_ORG_ID = "fake-censys-org";
process.env.ABUSEIPDB_API_KEY = "fake-abuseipdb-key-for-tests";
process.env.GREYNOISE_API_KEY = "";
process.env.SHODAN_API_KEY = "";
process.env.NETLAS_API_KEY = "";

const { PrismaClient } = require("@prisma/client");
const quota = require("../../src/services/enrichmentOrchestration/enrichmentQuotaService");
const repository = require("../../src/services/enrichmentOrchestration/enrichmentOrchestrationRepository");
const directExecution = require("../../src/services/enrichmentOrchestration/enrichmentDirectExecutionService");
const worker = require("../../src/services/enrichmentOrchestration/enrichmentWorker");
const { JOB_STATES } = require("../../src/services/enrichmentOrchestration/enrichmentDecisionCodes");
const {
  resolveWorkerRuntimeConfig,
  EnrichmentOrchestrationConfigError,
} = require("../../src/services/enrichmentOrchestration/enrichmentOrchestrationConfig");
const iocRepository = require("../../src/services/enrichment/iocEnrichmentRepository");

// RFC 5737 TEST-NET-2. Deliberately outside every prefix another suite
// blanket-deletes (192.0.2., 198.18., 198.19.0., 198.20.0., 198.21.,
// 203.0.113.2/.4/.5/.8/.9, and 10A-1's 198.51.100.161/.162). Cross-suite
// isolation in the shared test database is a real, recurring bug class here,
// so this suite deletes ONLY what it created.
const IP = Object.freeze({
  DIRECT: "198.51.100.191",
  RACE: "198.51.100.192",
  BUDGET: "198.51.100.193",
  ORDERING: "198.51.100.194",
  CRASH_BEFORE: "198.51.100.195",
  CRASH_AFTER: "198.51.100.196",
  TARGETED: "198.51.100.197",
  UNRELATED: "198.51.100.198",
  SENTINEL: "198.51.100.199",
  // The targeted end-to-end cases. One IP per case: these tests assert on
  // exact rows, and sharing an indicator between them would couple their
  // cleanup and hide a leak.
  T_UNCONFIGURED: "198.51.100.180",
  // NOT .181 — phase10a1IngestionDefaultOff owns that one and ingests a real
  // Finding with occurrences against it. Cross-suite collision in the shared
  // test database is the recurring bug class in this repository.
  T_BUDGET: "198.51.100.179",
  T_SUCCESS: "198.51.100.182",
  T_BOUND: "198.51.100.183",
  T_THROW: "198.51.100.184",
  T_CONTENDED: "198.51.100.185",
  T_REJECTED: "198.51.100.186",
  T_SERVER: "198.51.100.187",
  T_ATTEMPT_NO: "198.51.100.188",
  T_STARVED: "198.51.100.189",
  T_RECOVERY: "198.51.100.190",
});
const ALL_IPS = Object.freeze(Object.values(IP));

const NOW = new Date("2026-08-12T10:00:00.000Z");
const nowFn = () => new Date();
const noopAudit = async () => {};

let prisma;

const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

/** A Censys-shaped fake transport. Exercises the real provider parsing. */
function fakeFetch({ status = 200, body = null, delayMs = 0, onCall } = {}) {
  return async (...args) => {
    if (onCall) onCall(...args);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      // Censys wraps its host record in result.resource; anything else is
      // correctly normalized as a malformed response.
      json: async () => body || { result: { resource: { services: [], autonomous_system: {} } } },
      text: async () => JSON.stringify(body || {}),
    };
  };
}

async function cleanup() {
  // Only this suite's own rows, matched by exact indicator. Never a prefix.
  const jobs = await prisma.providerLookupJob.findMany({
    where: { subjectValue: { in: [...ALL_IPS] } },
    select: { id: true },
  });
  const jobIds = jobs.map((row) => row.id);
  if (jobIds.length) {
    await prisma.providerLookupAttempt.deleteMany({ where: { lookupJobId: { in: jobIds } } });
    await prisma.findingEnrichmentRunItem.deleteMany({ where: { lookupJobId: { in: jobIds } } });
    await prisma.providerLookupJob.deleteMany({ where: { id: { in: jobIds } } });
  }
  // Runs and their items reference both a Finding and a job, so they have to
  // go before either. Ordered by foreign key, never by TRUNCATE CASCADE.
  //
  // Scoped to the two indicators this suite creates Findings for — NOT to
  // every IP it touches. A wider net deletes Findings that other suites
  // ingested (with occurrences, ownership and triage hanging off them), which
  // both breaks them and fails here on their foreign keys.
  const findings = await prisma.finding.findMany({
    where: { indicatorValue: { in: [IP.T_SUCCESS, IP.T_STARVED] } },
    select: { id: true },
  });
  const findingIds = findings.map((row) => row.id);
  if (findingIds.length) {
    await prisma.findingEnrichmentRunItem.deleteMany({ where: { findingId: { in: findingIds } } });
    await prisma.findingEnrichmentRun.deleteMany({ where: { findingId: { in: findingIds } } });
    // A score owns its factor contributions — that is the whole point of Risk
    // v1's explainability — so they go first.
    const scores = await prisma.riskScore.findMany({
      where: { findingId: { in: findingIds } },
      select: { id: true },
    });
    if (scores.length) {
      await prisma.riskFactorContribution.deleteMany({
        where: { riskScoreId: { in: scores.map((row) => row.id) } },
      });
    }
    await prisma.riskScore.deleteMany({ where: { findingId: { in: findingIds } } });
    await prisma.finding.deleteMany({ where: { id: { in: findingIds } } });
  }
  await prisma.iocEnrichment.deleteMany({ where: { indicator: { in: [...ALL_IPS] } } });
  await prisma.censysEnrichment.deleteMany({ where: { indicator: { in: [...ALL_IPS] } } });
  await prisma.providerDailyUsage.deleteMany({ where: { provider: { in: ["censys", "abuseipdb"] } } });
}

/** A directly-executable Phase-10 job for one IP. */
async function createDirectJob(indicator, { lane = "AUTOMATIC", provider = "censys" } = {}) {
  return prisma.providerLookupJob.create({
    data: {
      provider,
      subjectType: "IPV4",
      subjectValue: indicator,
      queryIdentityHash: `p10a2-${provider}-${indicator}`,
      state: JOB_STATES.PENDING,
      lane,
      trigger: "RUN_DIRECT",
      requestedAt: NOW,
      activeLookupKey: `p10a2-${provider}-${indicator}`,
      maxAttempts: 3,
    },
  });
}

describeOrSkip("Phase 10A-2 — quota reservation is atomic and conservative", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("grants exactly the configured limit under concurrent reservation (G: no overspend)", async () => {
    // The whole point of a compare-and-swap guard. Ten workers, limit three:
    // if the guard were a read-then-write, several would read 0 and all would
    // increment, overspending real third-party budget.
    const job = await createDirectJob(IP.DIRECT);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        quota.reserveProviderQuota({
          client: prisma,
          provider: "censys",
          lane: "AUTOMATIC",
          now: new Date(),
          limit: 3,
          lookupJobId: job.id,
          attemptNumber: index + 1,
        })
      )
    );
    const granted = results.filter((row) => row.outcome === quota.RESERVATION_OUTCOME.GRANTED);
    expect(granted).toHaveLength(3);

    const usage = await prisma.providerDailyUsage.findFirst({ where: { provider: "censys", lane: "AUTOMATIC" } });
    expect(usage.reservedCount).toBe(3);

    // Exactly one ledger row per granted unit — never more, never fewer.
    const attempts = await prisma.providerLookupAttempt.findMany({ where: { lookupJobId: job.id } });
    expect(attempts).toHaveLength(3);
  });

  it("keeps the automatic and manual lanes completely separate", async () => {
    // Exhausting one lane must leave the other untouched: an analyst pressing
    // a button is a different budget from ingestion-triggered work.
    const job = await createDirectJob(IP.BUDGET);
    const first = await quota.reserveProviderQuota({
      client: prisma, provider: "censys", lane: "AUTOMATIC", now: new Date(),
      limit: 1, lookupJobId: job.id, attemptNumber: 1,
    });
    const exhausted = await quota.reserveProviderQuota({
      client: prisma, provider: "censys", lane: "AUTOMATIC", now: new Date(),
      limit: 1, lookupJobId: job.id, attemptNumber: 2,
    });
    const manual = await quota.reserveProviderQuota({
      client: prisma, provider: "censys", lane: "MANUAL", now: new Date(),
      limit: 1, lookupJobId: job.id, attemptNumber: 3,
    });

    expect(first.outcome).toBe(quota.RESERVATION_OUTCOME.GRANTED);
    expect(exhausted.outcome).toBe(quota.RESERVATION_OUTCOME.REFUSED);
    expect(manual.outcome).toBe(quota.RESERVATION_OUTCOME.GRANTED);
  });

  it("writes NO usage row and NO ledger row when the budget is zero", async () => {
    // A zero budget is refused without issuing a single statement.
    const job = await createDirectJob(IP.BUDGET);
    const refused = await quota.reserveProviderQuota({
      client: prisma, provider: "censys", lane: "AUTOMATIC", now: new Date(),
      limit: 0, lookupJobId: job.id, attemptNumber: 1,
    });
    expect(refused.outcome).toBe(quota.RESERVATION_OUTCOME.REFUSED);
    expect(await prisma.providerDailyUsage.count({ where: { provider: "censys" } })).toBe(0);
    expect(await prisma.providerLookupAttempt.count({ where: { lookupJobId: job.id } })).toBe(0);
  });

  it("rolls the quota increment back when the ledger insert fails (one transaction)", async () => {
    // The reservation and its ledger row are ONE transaction. If the increment
    // could commit without the attempt, quota would be charged with nothing to
    // explain it — an unaccountable unit of real budget.
    const job = await createDirectJob(IP.BUDGET);
    const first = await quota.reserveProviderQuota({
      client: prisma, provider: "censys", lane: "AUTOMATIC", now: new Date(),
      limit: 10, lookupJobId: job.id, attemptNumber: 1,
    });
    expect(first.outcome).toBe(quota.RESERVATION_OUTCOME.GRANTED);

    // Same (lookupJobId, attemptNumber) violates the composite unique, so the
    // insert fails INSIDE the transaction.
    await expect(
      quota.reserveProviderQuota({
        client: prisma, provider: "censys", lane: "AUTOMATIC", now: new Date(),
        limit: 10, lookupJobId: job.id, attemptNumber: 1,
      })
    ).rejects.toThrow();

    const usage = await prisma.providerDailyUsage.findFirst({ where: { provider: "censys", lane: "AUTOMATIC" } });
    // Still 1, not 2: the second increment was rolled back with its insert.
    expect(usage.reservedCount).toBe(1);
  });

  it("finalizes an attempt exactly once", async () => {
    const job = await createDirectJob(IP.DIRECT);
    const reservation = await quota.reserveProviderQuota({
      client: prisma, provider: "censys", lane: "AUTOMATIC", now: new Date(),
      limit: 5, lookupJobId: job.id, attemptNumber: 1,
    });
    const first = await quota.finalizeAttempt(prisma, reservation.attempt.id, {
      outcome: quota.ATTEMPT_OUTCOMES.SUCCESS, now: new Date(),
    });
    const second = await quota.finalizeAttempt(prisma, reservation.attempt.id, {
      outcome: quota.ATTEMPT_OUTCOMES.TRANSPORT_ERROR, now: new Date(),
    });
    expect(first).toBe(true);
    // The guard matched zero rows: a recorded outcome is never overwritten.
    expect(second).toBe(false);

    const row = await prisma.providerLookupAttempt.findUnique({ where: { id: reservation.attempt.id } });
    expect(row.outcome).toBe(quota.ATTEMPT_OUTCOMES.SUCCESS);
  });
});

describeOrSkip("Phase 10A-2 — claim, ordering and the seven guarantees", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("lets exactly one of two racing workers claim a direct job (G3, G7)", async () => {
    const job = await createDirectJob(IP.RACE);
    const [a, b] = await Promise.all([
      repository.claimLookupJob(prisma, job.id, { now: new Date(), leaseMs: 120000 }),
      repository.claimLookupJob(prisma, job.id, { now: new Date(), leaseMs: 120000 }),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);

    // The loser incremented nothing: attemptCount counts REAL attempts.
    const after = await prisma.providerLookupJob.findUnique({ where: { id: job.id } });
    expect(after.attemptCount).toBe(1);
  });

  it("reserves NO quota when the claim is lost (G2)", async () => {
    // Reservation happens strictly after a won claim, so a lost race can never
    // leak budget. If the order were reversed this count would be 1.
    const job = await createDirectJob(IP.RACE);
    await repository.claimLookupJob(prisma, job.id, { now: new Date(), leaseMs: 120000 });
    const loser = await repository.claimLookupJob(prisma, job.id, { now: new Date(), leaseMs: 120000 });
    expect(loser).toBeNull();
    expect(await prisma.providerDailyUsage.count({ where: { provider: "censys" } })).toBe(0);
  });

  it("performs ZERO provider calls when quota is refused, and leaves no stranded job (G4)", async () => {
    let calls = 0;
    const job = await createDirectJob(IP.BUDGET);
    const claim = await repository.claimLookupJob(prisma, job.id, { now: new Date(), leaseMs: 120000 });

    const result = await directExecution.executeDirectJob({
      prisma,
      job: claim.record,
      claimToken: claim.claimToken,
      nowFn,
      limit: 0, // refused
      lookupMaxMs: 60000,
      appConfig: require("../../src/config/env"),
      fetchImpl: fakeFetch({ onCall: () => { calls += 1; } }),
      audit: noopAudit,
    });

    expect(calls).toBe(0);
    expect(result.jobState).toBe(JOB_STATES.SKIPPED_BUDGET);

    const after = await prisma.providerLookupJob.findUnique({ where: { id: job.id } });
    expect(after.state).toBe(JOB_STATES.SKIPPED_BUDGET);
    // Terminal, so the work identity is released and a future ask can proceed.
    expect(after.activeLookupKey).toBeNull();
    expect(after.claimToken).toBeNull();
    // Refunded: no attempt actually took place.
    expect(after.attemptCount).toBe(0);
    expect(await prisma.providerLookupAttempt.count({ where: { lookupJobId: job.id } })).toBe(0);
  });

  it("marks the attempt IN_FLIGHT before the call, and only calls after a grant (G2, G3)", async () => {
    const observed = [];
    const job = await createDirectJob(IP.ORDERING);
    const claim = await repository.claimLookupJob(prisma, job.id, { now: new Date(), leaseMs: 120000 });

    await directExecution.executeDirectJob({
      prisma,
      job: claim.record,
      claimToken: claim.claimToken,
      nowFn,
      limit: 5,
      lookupMaxMs: 60000,
      appConfig: require("../../src/config/env"),
      // The fake reads the ledger AT THE MOMENT the request is made. This is
      // the only way to prove the ordering rather than assume it.
      fetchImpl: fakeFetch({
        onCall: async () => {
          const rows = await prisma.providerLookupAttempt.findMany({ where: { lookupJobId: job.id } });
          observed.push(...rows.map((row) => ({ state: row.state, contacted: row.contactedProvider })));
        },
      }),
      audit: noopAudit,
    });

    // A reservation existed before the call...
    expect(observed).toHaveLength(1);
    // ...and it was already IN_FLIGHT and marked contacted.
    expect(observed[0].state).toBe(quota.ATTEMPT_STATES.IN_FLIGHT);
    expect(observed[0].contacted).toBe(true);
  });

  it("persists evidence in the existing canonical table and terminalizes the job (G5)", async () => {
    const job = await createDirectJob(IP.DIRECT);
    const claim = await repository.claimLookupJob(prisma, job.id, { now: new Date(), leaseMs: 120000 });

    const result = await directExecution.executeDirectJob({
      prisma,
      job: claim.record,
      claimToken: claim.claimToken,
      nowFn,
      limit: 5,
      lookupMaxMs: 60000,
      appConfig: require("../../src/config/env"),
      fetchImpl: fakeFetch({ status: 200 }),
      audit: noopAudit,
    });

    expect(result.outcome).toBe("COMPLETED");

    const after = await prisma.providerLookupJob.findUnique({ where: { id: job.id } });
    // A real terminal answer, its evidence linked, its work identity released.
    expect([JOB_STATES.SUCCEEDED, JOB_STATES.NO_RECORD]).toContain(after.state);
    expect(after.censysEnrichmentId).not.toBeNull();
    expect(after.activeLookupKey).toBeNull();
    expect(after.freshUntil).not.toBeNull();

    // Written to the PRE-EXISTING evidence table, not a Phase-10 copy of it.
    const evidence = await prisma.censysEnrichment.findUnique({ where: { id: after.censysEnrichmentId } });
    expect(evidence.indicator).toBe(IP.DIRECT);

    const attempts = await prisma.providerLookupAttempt.findMany({ where: { lookupJobId: job.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe(quota.ATTEMPT_STATES.FINISHED);
    expect(attempts[0].contactedProvider).toBe(true);
  });

  it("records an ambiguous outcome, never a fabricated one, when the call exceeds its bound", async () => {
    // The worker's OWN end-to-end bound fires. contactedProvider is already
    // true, so what the provider did is unknowable: the only honest outcome is
    // ABANDONED, and the job must NOT be re-queued for a second paid call.
    const job = await createDirectJob(IP.CRASH_AFTER);
    const claim = await repository.claimLookupJob(prisma, job.id, { now: new Date(), leaseMs: 120000 });

    const result = await directExecution.executeDirectJob({
      prisma,
      job: claim.record,
      claimToken: claim.claimToken,
      nowFn,
      limit: 5,
      lookupMaxMs: 40, // shorter than the fake's delay
      appConfig: require("../../src/config/env"),
      fetchImpl: fakeFetch({ delayMs: 400 }),
      audit: noopAudit,
    });

    expect(result.outcome).toBe("AMBIGUOUS");

    const after = await prisma.providerLookupJob.findUnique({ where: { id: job.id } });
    expect(after.state).toBe(JOB_STATES.DEAD_LETTER);
    expect(after.terminalReasonCode).toBe("AMBIGUOUS_AFTER_CONTACT");
    // Terminal, so nothing re-claims it. Never SUCCEEDED and never NO_RECORD.
    expect(after.activeLookupKey).toBeNull();

    const attempts = await prisma.providerLookupAttempt.findMany({ where: { lookupJobId: job.id } });
    expect(attempts[0].outcome).toBe(quota.ATTEMPT_OUTCOMES.ABANDONED);
    expect(attempts[0].contactedProvider).toBe(true);
  });
});

describeOrSkip("Phase 10A-2 — the contact hold closes the duplicate-call window", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("makes a contacted row unclaimable even after its lease has expired, with NO recovery running", async () => {
    // THE case the design review caught. A worker contacts a provider and
    // dies. Its lease expires. If the hold were a DURATION, a long enough
    // outage would let it lapse and the ADMIN batch would reclaim and call the
    // provider a second time — a duplicate charge. The hold is a sentinel, so
    // no amount of elapsed time releases it.
    const row = await iocRepository.createPendingJob(
      { provider: "abuseipdb", indicatorType: "IPV4", indicator: IP.SENTINEL, queryParams: { maxAgeInDays: 90 } },
      { client: prisma, requestedAt: NOW, maxAttempts: 3 }
    );
    const claim = await iocRepository.claimPendingJob(row.id, {
      client: prisma, now: new Date(), leaseMs: 1000,
    });
    expect(claim).not.toBeNull();

    // Contact happens: the hold goes down in the same guarded statement.
    await iocRepository.holdContactedJob(
      { id: row.id, claimToken: claim.claimToken, until: quota.CONTACT_SENTINEL },
      { client: prisma }
    );

    // Far beyond ANY lease, and beyond any plausible guard duration.
    const longAfter = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
    const reclaim = await iocRepository.claimPendingJob(row.id, {
      client: prisma, now: longAfter, leaseMs: 120000,
    });
    expect(reclaim).toBeNull();

    // And it is not listed as a candidate either, so the ADMIN batch never
    // even considers it.
    const candidates = await iocRepository.listPendingCandidates({ limit: 50 }, { client: prisma, asOf: longAfter });
    expect(candidates.map((c) => c.id)).not.toContain(row.id);
  });

  it("releases the hold only through a path that knows the outcome", async () => {
    // The sweep drives the row terminal. A terminal row can never be claimed
    // again, which is what finally closes the window rather than re-opening it.
    const row = await iocRepository.createPendingJob(
      { provider: "abuseipdb", indicatorType: "IPV4", indicator: IP.SENTINEL, queryParams: { maxAgeInDays: 90 } },
      { client: prisma, requestedAt: NOW, maxAttempts: 3 }
    );
    const claim = await iocRepository.claimPendingJob(row.id, { client: prisma, now: new Date(), leaseMs: 1000 });
    await iocRepository.holdContactedJob(
      { id: row.id, claimToken: claim.claimToken, until: quota.CONTACT_SENTINEL },
      { client: prisma }
    );

    const later = new Date(Date.now() + 60000);
    const retired = await iocRepository.deadLetterUnleasedJob(
      { id: row.id, reasonCode: "AMBIGUOUS_AFTER_CONTACT" },
      { client: prisma, now: later }
    );
    expect(retired.outcome).toBe("DEAD_LETTERED");

    const after = await prisma.iocEnrichment.findUnique({ where: { id: row.id } });
    expect(after.status).toBe("DEAD_LETTER");
    // The hold is cleared on the terminal row rather than left as misleading
    // far-future history.
    expect(after.nextAttemptAt).toBeNull();
  });
});

describeOrSkip("Phase 10A-2 — targeted selection cannot widen", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("never selects an IOC row that no Phase-10 job links (G1)", async () => {
    // An unrelated PENDING AbuseIPDB row, exactly the kind the ordinary ADMIN
    // batch exists to process. The targeted selector must not see it.
    await iocRepository.createPendingJob(
      { provider: "abuseipdb", indicatorType: "IPV4", indicator: IP.UNRELATED, queryParams: { maxAgeInDays: 90 } },
      { client: prisma, requestedAt: NOW, maxAttempts: 3 }
    );

    const candidates = await repository.listTargetedDelegateCandidates(prisma, {
      asOf: new Date(),
      take: 50,
    });
    const subjects = candidates.map((job) => job.subjectValue);
    expect(subjects).not.toContain(IP.UNRELATED);
  });

  it("refuses at the DATABASE to create a delegated job with no delegate", async () => {
    // The 25th migration's CHECK constraint. The targeted path dereferences
    // iocEnrichmentId to decide which canonical row to claim, so an unlinked
    // RUN_DELEGATED job would be one no worker can execute, reconciliation can
    // never finish, and that holds activeLookupKey against every future ask
    // about that subject — permanently. Enforced by the database, not only by
    // the service that happens to create these rows today.
    await expect(
      prisma.providerLookupJob.create({
        data: {
          provider: "nvd",
          subjectType: "CVE",
          subjectValue: "CVE-2098-9001",
          queryIdentityHash: "p10a2-nvd-unlinked",
          state: JOB_STATES.WAITING_ON_DELEGATE,
          lane: "AUTOMATIC",
          trigger: "RUN_DELEGATED",
          requestedAt: NOW,
          activeLookupKey: "p10a2-nvd-unlinked",
        },
      })
    ).rejects.toThrow(/provider_lookup_job_delegated_requires_delegate/);
  });

  it("never selects a properly-linked NVD job (G1)", async () => {
    // Positive equality on provider, not a negative filter: a negative filter
    // silently admits any provider added later.
    const vulnerability = await prisma.vulnerability.create({
      data: { cveId: "CVE-2098-9001" },
    });
    const delegate = await prisma.vulnerabilityEnrichmentJob.create({
      data: { vulnerabilityId: vulnerability.id, trigger: "MANUAL", requestedAt: NOW },
    });
    const vulnJob = await prisma.providerLookupJob.create({
      data: {
        provider: "nvd",
        subjectType: "CVE",
        subjectValue: "CVE-2098-9001",
        queryIdentityHash: "p10a2-nvd-9001",
        state: JOB_STATES.WAITING_ON_DELEGATE,
        lane: "AUTOMATIC",
        trigger: "RUN_DELEGATED",
        requestedAt: NOW,
        activeLookupKey: "p10a2-nvd-9001",
        vulnerabilityEnrichmentJobId: delegate.id,
      },
    });

    // NVD stays on the ADMIN vulnerability batch. Neither pass may claim it.
    const candidates = await repository.listTargetedDelegateCandidates(prisma, { asOf: new Date(), take: 50 });
    expect(candidates.map((job) => job.id)).not.toContain(vulnJob.id);

    const direct = await repository.listDirectCandidates(prisma, {
      providers: directExecution.DIRECT_PROVIDER_NAMES,
      asOf: new Date(),
      take: 50,
    });
    expect(direct.map((job) => job.id)).not.toContain(vulnJob.id);

    await prisma.providerLookupJob.delete({ where: { id: vulnJob.id } });
    await prisma.vulnerabilityEnrichmentJob.delete({ where: { id: delegate.id } });
    await prisma.vulnerability.delete({ where: { id: vulnerability.id } });
  });

  it("skips a delegate whose lease is live, rather than re-selecting it forever", async () => {
    // Head-of-queue starvation: without the relation filter the same
    // unclaimable job is returned on every tick and later work never runs.
    const row = await iocRepository.createPendingJob(
      { provider: "abuseipdb", indicatorType: "IPV4", indicator: IP.TARGETED, queryParams: { maxAgeInDays: 90 } },
      { client: prisma, requestedAt: NOW, maxAttempts: 3 }
    );
    await prisma.providerLookupJob.create({
      data: {
        provider: "abuseipdb",
        subjectType: "IPV4",
        subjectValue: IP.TARGETED,
        queryIdentityHash: `p10a2-abuse-${IP.TARGETED}`,
        state: JOB_STATES.WAITING_ON_DELEGATE,
        lane: "AUTOMATIC",
        trigger: "RUN_DELEGATED",
        requestedAt: NOW,
        activeLookupKey: `p10a2-abuse-${IP.TARGETED}`,
        iocEnrichmentId: row.id,
      },
    });

    // Someone else holds a live lease on the delegate.
    await iocRepository.claimPendingJob(row.id, { client: prisma, now: new Date(), leaseMs: 600000 });

    const candidates = await repository.listTargetedDelegateCandidates(prisma, { asOf: new Date(), take: 50 });
    expect(candidates.map((job) => job.subjectValue)).not.toContain(IP.TARGETED);
  });
});

describe("Phase 10A-2 — worker configuration refuses unsafe timing", () => {
  it("rejects a stale threshold that could sweep a still-running lookup", () => {
    // Individually every value is legal. Together they would let recovery
    // dead-letter live work, whose real answer could then never be recorded.
    expect(() =>
      resolveWorkerRuntimeConfig({
        ENRICHMENT_LOOKUP_MAX_MS: "60000",
        ENRICHMENT_ATTEMPT_STALE_SECONDS: "60",
        ENRICHMENT_WORKER_LEASE_SECONDS: "120",
      })
    ).toThrow(EnrichmentOrchestrationConfigError);
  });

  it("rejects a lease shorter than the longest permitted lookup", () => {
    expect(() =>
      resolveWorkerRuntimeConfig({
        ENRICHMENT_LOOKUP_MAX_MS: "120000",
        ENRICHMENT_WORKER_LEASE_SECONDS: "60",
        ENRICHMENT_ATTEMPT_STALE_SECONDS: "600",
      })
    ).toThrow(EnrichmentOrchestrationConfigError);
  });

  it("accepts the shipped defaults", () => {
    const config = resolveWorkerRuntimeConfig({});
    expect(config.ENRICHMENT_WORKER_LEASE_SECONDS).toBe(120);
    expect(config.ENRICHMENT_LOOKUP_MAX_MS).toBe(60000);
    expect(config.ENRICHMENT_ATTEMPT_STALE_SECONDS).toBe(600);
  });

  it("exposes a worker that starts nothing merely by being imported", () => {
    expect(typeof worker.startEnrichmentWorker).toBe("function");
    expect(typeof worker.runWorkerTick).toBe("function");
  });
});

// ===========================================================================
// The targeted path, end to end
// ===========================================================================
// The independent implementation review found that the sections above execute
// the DIRECT service end to end but exercise only the targeted path's
// SELECTION primitives — executeTargetedJob() itself was never called. Every
// guarantee could therefore read green for direct execution while the targeted
// path violated ordering, bounding, the contact hold, the ledger or Risk v1.
//
// These cases close that hole. They drive the real service through an injected
// provider registry, so the real claim, the real quota reservation, the real
// contact transaction and the real finalization all run. NOTHING here reaches
// a live provider: the only lookup() in play is defined in this file.

const targetedExecution = require("../../src/services/enrichmentOrchestration/enrichmentTargetedIocService");
const { buildEnrichmentRuntime } = require("../../src/services/enrichment/enrichmentRuntime");
const {
  createEnrichmentResult,
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
} = require("../../src/services/enrichment/iocEnrichmentTypes");

const CONFIGURED = Object.freeze({ ABUSEIPDB_API_KEY: "fake-abuseipdb-key-for-tests" });
const UNCONFIGURED = Object.freeze({ ABUSEIPDB_API_KEY: "" });

/**
 * An offline AbuseIPDB-shaped provider. It counts its own calls, because
 * "exactly one provider call" is the guarantee most of these cases exist to
 * prove and it cannot be asserted from the database alone.
 */
function fakeTargetedProvider({
  status = ENRICHMENT_STATUS.SUCCESS,
  errorCode = null,
  httpStatus = null,
  retryAfterSeconds = null,
  delayMs = 0,
  throwAfterContact = false,
  onCall = null,
} = {}) {
  const state = { calls: 0 };
  const provider = {
    name: "abuseipdb",
    async lookup(input) {
      state.calls += 1;
      if (onCall) await onCall(input);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (throwAfterContact) throw new Error("socket hang up");
      return createEnrichmentResult({
        provider: "abuseipdb",
        indicatorType: input.indicatorType,
        indicator: input.indicator,
        status,
        queriedAt: input.asOf instanceof Date ? input.asOf : new Date(),
        data: status === ENRICHMENT_STATUS.SUCCESS ? { abuseConfidenceScore: 42, totalReports: 7 } : null,
        httpStatus,
        retryAfterSeconds,
        errorInfo: errorCode ? { code: errorCode, message: null } : null,
      });
    },
  };
  return { provider, state };
}

/** A runtime whose registry resolves every name to this one fake provider. */
function fakeRuntime(provider) {
  return buildEnrichmentRuntime({ providerRegistry: Object.freeze({ resolve: () => provider }) });
}

/** A linked delegate + Phase-10 job, exactly as the schedule service builds one. */
async function createTargetedJob(indicator, { maxAttempts = 3, lane = "AUTOMATIC" } = {}) {
  const delegate = await iocRepository.createPendingJob(
    { provider: "abuseipdb", indicatorType: "IPV4", indicator, queryParams: { maxAgeInDays: 90 } },
    { client: prisma, requestedAt: NOW, maxAttempts }
  );
  const job = await prisma.providerLookupJob.create({
    data: {
      provider: "abuseipdb",
      subjectType: "IPV4",
      subjectValue: indicator,
      queryIdentityHash: `p10a2-t-${indicator}`,
      state: JOB_STATES.WAITING_ON_DELEGATE,
      lane,
      trigger: "RUN_DELEGATED",
      requestedAt: NOW,
      activeLookupKey: `p10a2-t-${indicator}`,
      maxAttempts,
      iocEnrichmentId: delegate.id,
    },
  });
  return { delegate, job };
}

describeOrSkip("Phase 10A-2 — the targeted path, executed end to end", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("spends NOTHING and calls nobody when the provider has no credential", async () => {
    // The credential check is side-effect-free and runs after the claim but
    // BEFORE the reservation. Ordered the other way — which is how this was
    // first written — an incomplete deployment reserves real budget, creates a
    // ledger row and marks it contacted, all to reach a provider that reports
    // SKIPPED_DISABLED from inside its own lookup().
    const { delegate, job } = await createTargetedJob(IP.T_UNCONFIGURED);
    const { provider, state } = fakeTargetedProvider();

    const result = await targetedExecution.executeTargetedJob({
      prisma,
      job,
      nowFn,
      limit: 5,
      leaseMs: 120000,
      lookupMaxMs: 60000,
      runtime: fakeRuntime(provider),
      appConfig: UNCONFIGURED,
      audit: noopAudit,
    });

    expect(state.calls).toBe(0);
    expect(result.outcome).toBe(JOB_STATES.SKIPPED_NOT_CONFIGURED);

    // No unit of real budget, and no ledger row claiming an attempt happened.
    expect(await prisma.providerDailyUsage.count({ where: { provider: "abuseipdb" } })).toBe(0);
    expect(await prisma.providerLookupAttempt.count({ where: { lookupJobId: job.id } })).toBe(0);

    const after = await prisma.providerLookupJob.findUnique({ where: { id: job.id } });
    expect(after.state).toBe(JOB_STATES.SKIPPED_NOT_CONFIGURED);
    // The public `contacted` field is derived from queriedAt. Nobody was
    // asked, so it must stay null.
    expect(after.queriedAt).toBeNull();
    expect(after.activeLookupKey).toBeNull();

    // The claim was released AND refunded: no attempt took place.
    const canonical = await prisma.iocEnrichment.findUnique({ where: { id: delegate.id } });
    expect(canonical.attemptCount).toBe(0);
    expect(canonical.claimToken).toBeNull();
  });

  it("performs ZERO provider calls when the budget refuses", async () => {
    const { job } = await createTargetedJob(IP.T_BUDGET);
    const { provider, state } = fakeTargetedProvider();

    const result = await targetedExecution.executeTargetedJob({
      prisma,
      job,
      nowFn,
      limit: 0, // refused
      leaseMs: 120000,
      lookupMaxMs: 60000,
      runtime: fakeRuntime(provider),
      appConfig: CONFIGURED,
      audit: noopAudit,
    });

    expect(state.calls).toBe(0);
    expect(result.outcome).toBe(JOB_STATES.SKIPPED_BUDGET);
    expect(await prisma.providerDailyUsage.count({ where: { provider: "abuseipdb" } })).toBe(0);

    const after = await prisma.providerLookupJob.findUnique({ where: { id: job.id } });
    expect(after.state).toBe(JOB_STATES.SKIPPED_BUDGET);
    expect(after.queriedAt).toBeNull();
  });

  it("completes end to end: one call, a truthful ledger, a contacted job, and a rescored Finding", async () => {
    // The single case that proves the whole ordering actually works, rather
    // than proving each refusal path in isolation.
    const finding = await prisma.finding.create({
      data: {
        indicatorValue: IP.T_SUCCESS,
        port: 3389,
        protocol: "TCP",
        reportType: "ACCESSIBLE_RDP",
        firstSeen: NOW,
        lastSeen: NOW,
      },
    });

    const { delegate, job } = await createTargetedJob(IP.T_SUCCESS);
    const { provider, state } = fakeTargetedProvider({ status: ENRICHMENT_STATUS.SUCCESS });

    const result = await targetedExecution.executeTargetedJob({
      prisma,
      job,
      nowFn,
      limit: 5,
      leaseMs: 120000,
      lookupMaxMs: 60000,
      runtime: fakeRuntime(provider),
      appConfig: CONFIGURED,
      audit: noopAudit,
    });

    expect(state.calls).toBe(1);
    expect(result.outcome).toBe("COMPLETED");

    // The DELEGATE is the source of truth for what the provider answered.
    const canonical = await prisma.iocEnrichment.findUnique({ where: { id: delegate.id } });
    expect(canonical.status).toBe("SUCCESS");
    expect(canonical.queriedAt).not.toBeNull();

    // The Phase-10 ledger records the same call, once.
    const attempts = await prisma.providerLookupAttempt.findMany({ where: { lookupJobId: job.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe(quota.ATTEMPT_STATES.FINISHED);
    expect(attempts[0].outcome).toBe(quota.ATTEMPT_OUTCOMES.SUCCESS);
    expect(attempts[0].contactedProvider).toBe(true);

    // Reconciliation carried the delegate's OWN queriedAt across, so the API's
    // public `contacted` field reports the truth instead of its inverse.
    const after = await prisma.providerLookupJob.findUnique({ where: { id: job.id } });
    expect(after.queriedAt).not.toBeNull();
    expect(after.completedAt).not.toBeNull();
    expect(after.activeLookupKey).toBeNull();

    // The Risk v1 boundary the ADMIN path already uses was invoked. This
    // asserts only that a score now exists — never how it was computed, which
    // is the evaluator's job and must not change.
    expect(await prisma.riskScore.count({ where: { findingId: finding.id } })).toBeGreaterThan(0);
  });

  it("numbers the ledger from the CLAIMED canonical row, not from the never-incremented job", async () => {
    // The Phase-10 job is deliberately never leased and never incremented
    // (D-P10A2-05), so `job.attemptCount + 1` is always 1 — and a second
    // attempt then collides with the (lookupJobId, attemptNumber) unique,
    // which the authorization catch would misreport as a budget refusal.
    const { delegate, job } = await createTargetedJob(IP.T_ATTEMPT_NO);
    // A prior attempt that already happened.
    await prisma.iocEnrichment.update({ where: { id: delegate.id }, data: { attemptCount: 1 } });

    const { provider } = fakeTargetedProvider({ status: ENRICHMENT_STATUS.SUCCESS });
    await targetedExecution.executeTargetedJob({
      prisma,
      job,
      nowFn,
      limit: 5,
      leaseMs: 120000,
      lookupMaxMs: 60000,
      runtime: fakeRuntime(provider),
      appConfig: CONFIGURED,
      audit: noopAudit,
    });

    const attempts = await prisma.providerLookupAttempt.findMany({ where: { lookupJobId: job.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].attemptNumber).toBe(2);
    // And the Phase-10 job really was never leased.
    const after = await prisma.providerLookupJob.findUnique({ where: { id: job.id } });
    expect(after.claimToken).toBeNull();
  });

  it("bounds its own lookup, and a bound that fires is AMBIGUOUS rather than a fabricated failure", async () => {
    // No provider's internal timeout bounds lookup(): each clears it when
    // response headers arrive and reads the body afterwards. Unbounded, a
    // stalled body read runs until the stale sweep resolves an attempt that is
    // still live.
    const { delegate, job } = await createTargetedJob(IP.T_BOUND);
    const { provider, state } = fakeTargetedProvider({ delayMs: 400 });

    const result = await targetedExecution.executeTargetedJob({
      prisma,
      job,
      nowFn,
      limit: 5,
      leaseMs: 120000,
      lookupMaxMs: 40, // shorter than the provider's delay
      runtime: fakeRuntime(provider),
      appConfig: CONFIGURED,
      audit: noopAudit,
    });

    expect(state.calls).toBe(1);
    expect(result.outcome).toBe("AMBIGUOUS");

    const attempts = await prisma.providerLookupAttempt.findMany({ where: { lookupJobId: job.id } });
    expect(attempts[0].outcome).toBe(quota.ATTEMPT_OUTCOMES.ABANDONED);
    expect(attempts[0].contactedProvider).toBe(true);

    const after = await prisma.providerLookupJob.findUnique({ where: { id: job.id } });
    expect(after.state).toBe(JOB_STATES.DEAD_LETTER);
    expect(after.terminalReasonCode).toBe("AMBIGUOUS_AFTER_CONTACT");

    // The canonical row is terminal too. Only a terminal row can never be
    // claimed again, which is what actually closes the duplicate-call window
    // — the non-expiring hold alone would merely freeze it.
    const canonical = await prisma.iocEnrichment.findUnique({ where: { id: delegate.id } });
    expect(canonical.status).not.toBe("PENDING");
  });

  it("treats a throw AFTER contact as ambiguous, and never releases the row for a retry", async () => {
    const { delegate, job } = await createTargetedJob(IP.T_THROW);
    const { provider, state } = fakeTargetedProvider({ throwAfterContact: true });

    const result = await targetedExecution.executeTargetedJob({
      prisma,
      job,
      nowFn,
      limit: 5,
      leaseMs: 120000,
      lookupMaxMs: 60000,
      runtime: fakeRuntime(provider),
      appConfig: CONFIGURED,
      audit: noopAudit,
    });

    expect(state.calls).toBe(1);
    expect(result.outcome).toBe("AMBIGUOUS");

    // The ordinary retry policy would have released the claim with a delay,
    // and releasing writes nextAttemptAt — clearing the contact hold and
    // making the row claimable for a SECOND paid call. It must not run here.
    const canonical = await prisma.iocEnrichment.findUnique({ where: { id: delegate.id } });
    expect(canonical.status).not.toBe("PENDING");

    // Nothing may re-select it.
    const candidates = await repository.listTargetedDelegateCandidates(prisma, { asOf: new Date(), take: 50 });
    expect(candidates.map((row) => row.subjectValue)).not.toContain(IP.T_THROW);
  });

  it("never calls the provider when the ADMIN batch already holds the canonical claim", async () => {
    // Targeted execution and the ADMIN batch contend on the SAME
    // compare-and-swap, which is what makes "no double execution" structural.
    const { delegate, job } = await createTargetedJob(IP.T_CONTENDED);
    const admin = await iocRepository.claimPendingJob(delegate.id, {
      client: prisma,
      now: new Date(),
      leaseMs: 600000,
    });
    expect(admin).not.toBeNull();

    const { provider, state } = fakeTargetedProvider();
    const result = await targetedExecution.executeTargetedJob({
      prisma,
      job,
      nowFn,
      limit: 5,
      leaseMs: 120000,
      lookupMaxMs: 60000,
      runtime: fakeRuntime(provider),
      appConfig: CONFIGURED,
      audit: noopAudit,
    });

    expect(state.calls).toBe(0);
    expect(["TARGET_NOT_CLAIMABLE", "CLAIM_FAILED"]).toContain(result.outcome);
    expect(await prisma.providerDailyUsage.count({ where: { provider: "abuseipdb" } })).toBe(0);
    expect(await prisma.providerLookupAttempt.count({ where: { lookupJobId: job.id } })).toBe(0);

    // Still waiting on its delegate: reconciliation finishes it once whoever
    // DID execute reaches a terminal state.
    const after = await prisma.providerLookupJob.findUnique({ where: { id: job.id } });
    expect(after.state).toBe(JOB_STATES.WAITING_ON_DELEGATE);
  });

  it("records a non-authentication 4xx as PROVIDER_REJECTED, not as a transport failure", async () => {
    // "The provider refused our request", "the provider broke" and "we never
    // reached it" are three different facts. Collapsing them all into
    // TRANSPORT_ERROR makes the ledger say something untrue.
    const { job } = await createTargetedJob(IP.T_REJECTED);
    const { provider } = fakeTargetedProvider({
      status: ENRICHMENT_STATUS.FAILED,
      errorCode: PROVIDER_ERROR_CODES.PROVIDER_REJECTED,
      httpStatus: 400,
    });

    await targetedExecution.executeTargetedJob({
      prisma,
      job,
      nowFn,
      limit: 5,
      leaseMs: 120000,
      lookupMaxMs: 60000,
      runtime: fakeRuntime(provider),
      appConfig: CONFIGURED,
      audit: noopAudit,
    });

    const attempts = await prisma.providerLookupAttempt.findMany({ where: { lookupJobId: job.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].outcome).toBe(quota.ATTEMPT_OUTCOMES.PROVIDER_REJECTED);
    expect(attempts[0].httpStatus).toBe(400);
    expect(attempts[0].errorCode).toBe(PROVIDER_ERROR_CODES.PROVIDER_REJECTED);
  });

  it("records a 5xx as SERVER_ERROR", async () => {
    const { job } = await createTargetedJob(IP.T_SERVER);
    const { provider } = fakeTargetedProvider({
      status: ENRICHMENT_STATUS.FAILED,
      errorCode: PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
      httpStatus: 503,
    });

    await targetedExecution.executeTargetedJob({
      prisma,
      job,
      nowFn,
      limit: 5,
      leaseMs: 120000,
      lookupMaxMs: 60000,
      runtime: fakeRuntime(provider),
      appConfig: CONFIGURED,
      audit: noopAudit,
    });

    const attempts = await prisma.providerLookupAttempt.findMany({ where: { lookupJobId: job.id } });
    expect(attempts[0].outcome).toBe(quota.ATTEMPT_OUTCOMES.SERVER_ERROR);
    expect(attempts[0].httpStatus).toBe(503);
  });
});

describeOrSkip("Phase 10A-2 — a backlog cannot starve the queue, and a crash cannot re-buy an answer", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(cleanup);

  it("retires budget-exhausted rows instead of letting them occupy every scan window", async () => {
    // The scan is bounded at MAX_SCAN_MULTIPLIER pages on purpose. Exhausted
    // rows can never be claimed, so leaving them in the candidate query lets
    // enough of them at the head of the queue starve every eligible job behind
    // them forever — the queue looks busy and nothing ever runs.
    const exhausted = [];
    for (let i = 0; i < worker.MAX_SCAN_MULTIPLIER + 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const row = await prisma.providerLookupJob.create({
        data: {
          provider: "censys",
          subjectType: "IPV4",
          subjectValue: IP.T_STARVED,
          queryIdentityHash: `p10a2-exhausted-${i}`,
          state: JOB_STATES.PENDING,
          lane: "AUTOMATIC",
          trigger: "RUN_DIRECT",
          // Older than the eligible row, so they sort ahead of it.
          requestedAt: new Date(NOW.getTime() - 100000 + i),
          activeLookupKey: `p10a2-exhausted-${i}`,
          maxAttempts: 1,
          attemptCount: 1, // spent
        },
      });
      exhausted.push(row.id);
    }
    const eligible = await createDirectJob(IP.DIRECT);

    // The exhausted rows are already excluded from selection...
    const candidates = await repository.listDirectCandidates(prisma, {
      providers: directExecution.DIRECT_PROVIDER_NAMES,
      asOf: new Date(),
      take: worker.MAX_SCAN_MULTIPLIER, // a single page: they would fill it
    });
    expect(candidates.map((row) => row.id)).toContain(eligible.id);
    exhausted.forEach((id) => expect(candidates.map((row) => row.id)).not.toContain(id));

    // ...and the retirement pass is the other half: excluded rows must not sit
    // non-terminal forever holding their work identity.
    const retired = await worker.retireExhaustedDirectJobs({
      prisma,
      now: new Date(),
      take: 50,
      audit: noopAudit,
    });
    expect(retired).toBe(exhausted.length);

    const rows = await prisma.providerLookupJob.findMany({ where: { id: { in: exhausted } } });
    rows.forEach((row) => {
      expect(row.state).toBe(JOB_STATES.DEAD_LETTER);
      expect(row.terminalReasonCode).toBe("MAX_ATTEMPTS_EXHAUSTED");
      expect(row.activeLookupKey).toBeNull();
    });
  });

  it("does NOT requeue a contacted attempt that already finished, and terminalizes its job instead", async () => {
    // The crash window the atomic post-call transaction cannot cover: the
    // attempt row proves the provider was already asked and charged, but the
    // job's terminal transition was lost. Requeuing here buys the same answer
    // twice. Nothing else would resolve it either — the sweep looks only at
    // UNFINISHED attempts — so it would hold its lease forever.
    const job = await prisma.providerLookupJob.create({
      data: {
        provider: "censys",
        subjectType: "IPV4",
        subjectValue: IP.T_RECOVERY,
        queryIdentityHash: `p10a2-recovery-${IP.T_RECOVERY}`,
        state: JOB_STATES.LEASED,
        lane: "AUTOMATIC",
        trigger: "RUN_DIRECT",
        requestedAt: NOW,
        activeLookupKey: `p10a2-recovery-${IP.T_RECOVERY}`,
        maxAttempts: 3,
        attemptCount: 1,
        claimToken: "stale-claim-token-for-recovery",
        claimedAt: new Date(NOW.getTime() - 600000),
        leaseExpiresAt: new Date(NOW.getTime() - 300000), // long expired
      },
    });
    await prisma.providerLookupAttempt.create({
      data: {
        lookupJobId: job.id,
        provider: "censys",
        lane: "AUTOMATIC",
        attemptNumber: 1,
        usageDate: new Date("2026-08-12T00:00:00.000Z"),
        state: quota.ATTEMPT_STATES.FINISHED,
        outcome: quota.ATTEMPT_OUTCOMES.SUCCESS,
        contactedProvider: true,
        startedAt: NOW,
        fetchStartedAt: NOW,
        finishedAt: NOW,
      },
    });

    await worker.recoverStaleClaims({ prisma, now: new Date(), take: 50, audit: noopAudit });

    const after = await prisma.providerLookupJob.findUnique({ where: { id: job.id } });
    // Never returned to the queue.
    expect(after.state).not.toBe(JOB_STATES.PENDING);
    expect(after.state).toBe(JOB_STATES.DEAD_LETTER);
    expect(after.terminalReasonCode).toBe("AMBIGUOUS_AFTER_CONTACT");
    expect(after.activeLookupKey).toBeNull();
    expect(after.claimToken).toBeNull();
  });

  it("settles a run whose every job went terminal on a path with no run context", async () => {
    // Some terminalization paths have no run to refresh — a swept attempt, a
    // retired row, a job terminalized by an earlier crash. Without the general
    // pass those runs report PENDING forever while all their work has finished.
    const finding = await prisma.finding.create({
      data: {
        indicatorValue: IP.T_STARVED,
        port: 3389,
        protocol: "TCP",
        reportType: "ACCESSIBLE_RDP",
        firstSeen: NOW,
        lastSeen: NOW,
      },
    });
    const job = await prisma.providerLookupJob.create({
      data: {
        provider: "censys",
        subjectType: "IPV4",
        subjectValue: IP.T_STARVED,
        queryIdentityHash: `p10a2-run-${IP.T_STARVED}`,
        state: JOB_STATES.DEAD_LETTER,
        lane: "AUTOMATIC",
        trigger: "RUN_DIRECT",
        requestedAt: NOW,
        completedAt: NOW,
        deadLetteredAt: NOW,
        terminalReasonCode: "AMBIGUOUS_AFTER_CONTACT",
        maxAttempts: 3,
      },
    });
    const run = await prisma.findingEnrichmentRun.create({
      data: {
        findingId: finding.id,
        trigger: "MANUAL",
        state: "PENDING",
        requestedAt: NOW,
        requestScopeHash: `p10a2-scope-${IP.T_STARVED}`,
        idempotencyKey: `p10a2-idem-${IP.T_STARVED}`,
        items: {
          create: [
            {
              findingId: finding.id,
              provider: "censys",
              subjectType: "IPV4",
              subjectValue: IP.T_STARVED,
              decision: "ELIGIBLE",
              lookupJobId: job.id,
            },
          ],
        },
      },
    });

    const refreshed = await worker.reconcileRunStates({ prisma, now: new Date(), take: 50 });
    expect(refreshed).toBeGreaterThan(0);

    const after = await prisma.findingEnrichmentRun.findUnique({ where: { id: run.id } });
    expect(after.state).not.toBe("PENDING");
    expect(after.completedAt).not.toBeNull();

    // Idempotent: a second pass must not select an already-terminal run.
    const second = await worker.reconcileRunStates({ prisma, now: new Date(), take: 50 });
    expect(second).toBe(0);
  });
});
