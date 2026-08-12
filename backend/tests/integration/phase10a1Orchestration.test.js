import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Phase 10A-1 — real-PostgreSQL proof of the orchestration behaviours that
// only a genuine database can demonstrate: the two independent unique
// constraints, cross-Finding job sharing, and concurrent request collapse.
//
// The headline test is T-23 (corrected for the inert milestone): an ACTIVE
// AbuseIPDB-scoped run must NOT suppress a new manual Censys-scoped run. That
// is the exact defect the v2.1 correction addendum exists to fix, and it is
// asserted here against real unique indexes rather than against a stub.
//
// Every provider credential below is a FAKE injected into process.env by this
// file. Nothing here contacts a provider — see
// tests/unit/enrichmentOrchestrationInertness.test.js for the static proof
// that the package could not, even if a path tried.
//
// Self-skips unless TEST_DATABASE_URL is set.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Injected BEFORE src/config/env.js is first required (the run service defers
// that require, so setting them here is sufficient and no real .env is ever
// consulted — tests/setup.js sets TNX_SKIP_DOTENV).
process.env.DATABASE_URL = process.env.DATABASE_URL || TEST_DATABASE_URL || "postgresql://x:y@localhost:5432/x";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-32-chars-min!!";
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
process.env.CENSYS_PAT = "fake-censys-pat-for-tests";
process.env.ABUSEIPDB_API_KEY = "fake-abuseipdb-key-for-tests";
process.env.SHODAN_API_KEY = "";
process.env.GREYNOISE_API_KEY = "";
process.env.NETLAS_API_KEY = "";

const { PrismaClient } = require("@prisma/client");
const {
  createEnrichmentRun,
} = require("../../src/services/enrichmentOrchestration/enrichmentRunService");
const {
  RUN_ITEM_DECISIONS,
  RUN_STATES,
  JOB_STATES,
  SKIP_REASONS,
} = require("../../src/services/enrichmentOrchestration/enrichmentDecisionCodes");

// RFC 5737 TEST-NET-2 — distinct from every other real-DB suite's range.
const IP_A = "198.51.100.71";
const IP_B = "198.51.100.72";
const MARKER_PORT = 33892;
const NOW = new Date("2026-08-11T16:00:00.000Z");

let prisma;

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
    `DELETE FROM "ProviderLookupJob" WHERE "subjectValue" IN ($1,$2,'CVE-2099-1001','CVE-2099-1002','CVE-2099-1003')`,
    IP_A,
    IP_B
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "FindingVulnerability" WHERE "findingId" IN
       (SELECT id FROM "Finding" WHERE "port" IN ($1, $1 + 1))`,
    MARKER_PORT
  );
  // AuditLog.entityId is a String column (it has to hold ids from tables with
  // non-integer keys), so the subquery is cast rather than compared directly.
  await prisma.$executeRawUnsafe(
    `DELETE FROM "AuditLog" WHERE "entityType" = 'Finding' AND "entityId" IN
       (SELECT id::text FROM "Finding" WHERE "port" IN ($1, $1 + 1))`,
    MARKER_PORT
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "Finding" WHERE "port" IN ($1, $1 + 1)`, MARKER_PORT);
  // Scoped to THIS file's own reports. "p10a1-%" also matched
  // phase10a1IngestionDefaultOff.test.js's "p10a1-default-off-*.csv", so when
  // the two files ran concurrently this delete hit reports that still had
  // RawReportRow/FindingOccurrence children and failed on their foreign keys.
  // A suite must only ever delete what it created.
  await prisma.$executeRawUnsafe(
    `DELETE FROM "RawReport" WHERE "sourceFileName" LIKE $1`,
    "p10a1-orch-%"
  );
  // Delegate rows created THROUGH the canonical queue services by this file's
  // runs. VulnerabilityEnrichmentJob holds an FK onto Vulnerability, so it must
  // go first or the Vulnerability delete below fails.
  await prisma.$executeRawUnsafe(
    `DELETE FROM "VulnerabilityEnrichmentJob" WHERE "vulnerabilityId" IN
       (SELECT id FROM "Vulnerability" WHERE "cveId" IN ('CVE-2099-1001','CVE-2099-1002','CVE-2099-1003'))`
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Vulnerability" WHERE "cveId" IN ('CVE-2099-1001','CVE-2099-1002','CVE-2099-1003')`
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "IocEnrichment" WHERE "indicator" IN ($1,$2)`, IP_A, IP_B);
}

async function makeFinding(indicatorValue) {
  return prisma.finding.create({
    data: {
      indicatorValue,
      port: MARKER_PORT,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      firstSeen: NOW,
      lastSeen: NOW,
    },
  });
}

const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

describeOrSkip("Phase 10A-1 orchestration (real PostgreSQL)", () => {
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

  // =========================================================================
  // T-23, corrected for the inert milestone (Codex amendment 2)
  // =========================================================================
  it("T-23: an active AbuseIPDB-scoped run does NOT suppress a new manual Censys-scoped run", async () => {
    const finding = await makeFinding(IP_A);

    const abuse = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["abuseipdb"],
      now: NOW,
    });
    const censys = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["censys"],
      now: NOW,
    });

    // 1. Two DISTINCT runs exist. A shared-work key must not have collapsed
    //    two different asks into one.
    expect(abuse.created).toBe(true);
    expect(censys.created).toBe(true);
    expect(censys.run.id).not.toBe(abuse.run.id);
    const runCount = await prisma.findingEnrichmentRun.count({ where: { findingId: finding.id } });
    expect(runCount).toBe(2);

    // 2. Censys has its OWN eligible item...
    const censysItems = censys.items.filter((item) => item.provider === "censys");
    expect(censysItems).toHaveLength(1);
    expect(censysItems[0].decision).toBe(RUN_ITEM_DECISIONS.ELIGIBLE);

    // 3. ...and its own PENDING job. Censys is executed directly (not
    //    delegated), so it is PENDING rather than WAITING_ON_DELEGATE.
    const censysJob = await prisma.providerLookupJob.findUnique({
      where: { id: censysItems[0].lookupJobId },
    });
    expect(censysJob.provider).toBe("censys");
    expect(censysJob.state).toBe(JOB_STATES.PENDING);
    expect(censysJob.trigger).toBe("RUN_DIRECT");

    // 4. Nothing was executed. No attempt row, no usage row, and the job was
    //    never queried. Phase 10A-2 is where Censys actually runs.
    expect(await prisma.providerLookupAttempt.count()).toBe(0);
    expect(await prisma.providerDailyUsage.count({ where: { provider: { not: { startsWith: "p10a1c-" } } } })).toBe(0);
    expect(censysJob.queriedAt).toBeNull();
    expect(censysJob.claimedAt).toBeNull();
    expect(censysJob.attemptCount).toBe(0);
  });

  it("collapses two CONCURRENT identical requests into one run", async () => {
    const finding = await makeFinding(IP_A);

    // Separate clients = separate connection pools = a real race. A single
    // shared client serializes enough on its pool to hide it.
    const racerA = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    const racerB = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    try {
      const [first, second] = await Promise.all([
        createEnrichmentRun(finding.id, {
          client: racerA,
          trigger: "MANUAL",
          providers: ["censys"],
          idempotencyKeyHash: "f".repeat(64),
          now: NOW,
        }),
        createEnrichmentRun(finding.id, {
          client: racerB,
          trigger: "MANUAL",
          providers: ["censys"],
          idempotencyKeyHash: "f".repeat(64),
          now: NOW,
        }),
      ]);

      expect(second.run.id).toBe(first.run.id);
      // Exactly one of them created it; the other converged onto it.
      expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
      expect(await prisma.findingEnrichmentRun.count({ where: { findingId: finding.id } })).toBe(1);
      // And exactly one item, not two.
      expect(
        await prisma.findingEnrichmentRunItem.count({ where: { runId: first.run.id } })
      ).toBe(1);
    } finally {
      await racerA.$disconnect();
      await racerB.$disconnect();
    }
  });

  it("creates DIFFERENT runs for different request scopes", async () => {
    const finding = await makeFinding(IP_A);

    const narrow = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["censys"],
      now: NOW,
    });
    const wide = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["censys", "abuseipdb"],
      now: NOW,
    });
    const forced = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["censys"],
      force: true,
      // Required with force=true: an unexplained freshness bypass is exactly
      // what the audit trail exists to record.
      justification: "forced for the Phase 10A-1 orchestration test",
      now: NOW,
    });

    expect(new Set([narrow.run.id, wide.run.id, forced.run.id]).size).toBe(3);
  });

  it("gives two Findings on ONE subject separate runs and items but ONE shared job", async () => {
    const findingA = await makeFinding(IP_A);
    const findingB = await prisma.finding.create({
      data: {
        // Same subject (indicator), different Finding identity. TransportProtocol
        // has only TCP, so the port is what separates the two identities.
        indicatorValue: IP_A,
        port: MARKER_PORT + 1,
        protocol: "TCP",
        reportType: "ACCESSIBLE_RDP",
        firstSeen: NOW,
        lastSeen: NOW,
      },
    });

    const runA = await createEnrichmentRun(findingA.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["censys"],
      now: NOW,
    });
    const runB = await createEnrichmentRun(findingB.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["censys"],
      now: NOW,
    });

    expect(runB.run.id).not.toBe(runA.run.id);
    expect(runA.items).toHaveLength(1);
    expect(runB.items).toHaveLength(1);
    // ONE outbound unit of work for both Findings — the whole point of
    // separating request identity from work identity.
    expect(runB.items[0].lookupJobId).toBe(runA.items[0].lookupJobId);
    expect(
      await prisma.providerLookupJob.count({ where: { subjectValue: IP_A, provider: "censys" } })
    ).toBe(1);
  });

  it("creates NO job for a policy skip", async () => {
    const finding = await makeFinding(IP_B);

    // shodan/greynoise/netlas have no credential in this file's fake env.
    const run = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["shodan", "greynoise", "netlas"],
      now: NOW,
    });

    expect(run.items).toHaveLength(3);
    // eslint-disable-next-line no-restricted-syntax
    for (const item of run.items) {
      expect(item.decision).toBe(RUN_ITEM_DECISIONS.SKIPPED_NOT_CONFIGURED);
      expect(item.skipReason).toBe(SKIP_REASONS.PROVIDER_NOT_CONFIGURED);
      expect(item.lookupJobId).toBeNull();
    }
    expect(await prisma.providerLookupJob.count({ where: { subjectValue: IP_B } })).toBe(0);
    // No item was ever eligible, so the run is SKIPPED, not SUCCEEDED.
    expect(run.run.state).toBe(RUN_STATES.SKIPPED);
  });

  it("refuses an AUTOMATIC target whose budget is 0, creating no job", async () => {
    const finding = await makeFinding(IP_A);

    // An INGESTION run is keyed on its report, so it needs a real one — the
    // service refuses to invent an idempotency key without it.
    const rawReport = await prisma.rawReport.create({
      data: {
        reportType: "ACCESSIBLE_RDP",
        schemaVersion: "accessible-rdp.synthetic.v1",
        sourceFileName: "p10a1-orch-budget.csv",
        sourceFileSha256: `p10a1budget${"0".repeat(53)}`,
        fileSizeBytes: 1,
        contentType: "text/csv",
        rawContent: Buffer.from("x"),
        observationDate: NOW,
      },
    });

    // Every automatic budget defaults to 0 — this is the ingestion default.
    const run = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "INGESTION",
      providers: ["censys", "abuseipdb"],
      rawReportId: rawReport.id,
      now: NOW,
    });

    // eslint-disable-next-line no-restricted-syntax
    for (const item of run.items) {
      expect(item.decision).toBe(RUN_ITEM_DECISIONS.SKIPPED_BUDGET);
      expect(item.skipReason).toBe(SKIP_REASONS.AUTOMATIC_BUDGET_ZERO);
      expect(item.lookupJobId).toBeNull();
    }
    expect(await prisma.providerLookupJob.count({ where: { subjectValue: IP_A } })).toBe(0);
    // Critically: a routing-time refusal creates NO reservation either.
    expect(await prisma.providerDailyUsage.count({ where: { provider: { not: { startsWith: "p10a1c-" } } } })).toBe(0);
  });

  it("creates THREE NVD jobs for three verified CVEs", async () => {
    const finding = await makeFinding(IP_A);
    const cveIds = ["CVE-2099-1001", "CVE-2099-1002", "CVE-2099-1003"];

    // eslint-disable-next-line no-restricted-syntax
    for (const cveId of cveIds) {
      // eslint-disable-next-line no-await-in-loop
      const vulnerability = await prisma.vulnerability.create({ data: { cveId } });
      // eslint-disable-next-line no-await-in-loop
      await prisma.findingVulnerability.create({
        data: {
          findingId: finding.id,
          vulnerabilityId: vulnerability.id,
          state: "ACTIVE",
          evidenceSource: "ANALYST_VERIFIED",
          justification: "verified for the Phase 10A-1 orchestration test",
          effectiveAt: NOW,
        },
      });
    }

    const run = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["nvd"],
      now: NOW,
    });

    // Three verified CVEs stay THREE subjects — never collapsed into one.
    expect(run.items).toHaveLength(3);
    expect(run.items.map((item) => item.subjectValue).sort()).toEqual(cveIds);
    // eslint-disable-next-line no-restricted-syntax
    for (const item of run.items) {
      expect(item.decision).toBe(RUN_ITEM_DECISIONS.ELIGIBLE);
      expect(item.lookupJobId).not.toBeNull();
    }
    expect(new Set(run.items.map((item) => item.lookupJobId)).size).toBe(3);
    expect(
      await prisma.providerLookupJob.count({ where: { provider: "nvd", subjectType: "CVE" } })
    ).toBe(3);
    // Still nothing executed.
    expect(await prisma.providerLookupAttempt.count()).toBe(0);
  });

  it("derives NO CVE subject from a removed association or from provider text", async () => {
    const finding = await makeFinding(IP_A);
    const vulnerability = await prisma.vulnerability.create({ data: { cveId: "CVE-2099-1001" } });

    // A REMOVED association is not a live subject...
    await prisma.findingVulnerability.create({
      data: {
        findingId: finding.id,
        vulnerabilityId: vulnerability.id,
        state: "REMOVED",
        evidenceSource: "ANALYST_VERIFIED",
        justification: "removed by an analyst",
        effectiveAt: NOW,
      },
    });

    const run = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["nvd"],
      now: NOW,
    });

    // No item at all, and the provider is reported as considered-but-unsubjected
    // rather than silently omitted.
    expect(run.items).toHaveLength(0);
    // Recorded DURABLY on the run row, not merely returned to this caller.
    expect(run.run.noSubjectProviders).toBe("nvd");
    const persisted = await prisma.findingEnrichmentRun.findUnique({ where: { id: run.run.id } });
    expect(persisted.noSubjectProviders).toBe("nvd");
    expect(await prisma.providerLookupJob.count({ where: { provider: "nvd" } })).toBe(0);

    // ...and a Shodan exposure record naming a CVE creates no association and
    // therefore no NVD subject. The only way a CVE becomes a subject is an
    // ACTIVE, ANALYST_VERIFIED FindingVulnerability row — provider text is
    // never promoted into one.
    await prisma.shodanEnrichment.create({
      data: {
        indicator: IP_A,
        status: "SUCCESS",
        queriedAt: NOW,
        vulnerabilities: ["CVE-2099-1002"],
      },
    });
    const after = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["nvd"],
      force: true,
      // Required with force=true: an unexplained freshness bypass is exactly
      // what the audit trail exists to record.
      justification: "forced for the Phase 10A-1 orchestration test",
      now: NOW,
    });
    expect(after.items).toHaveLength(0);
    expect(await prisma.providerLookupJob.count({ where: { provider: "nvd" } })).toBe(0);

    await prisma.shodanEnrichment.deleteMany({ where: { indicator: IP_A } });
  });

  // =========================================================================
  // Historical truthfulness — the second-review finding this exists to prevent
  // =========================================================================
  it("does not rewrite a historical run when a verified CVE is associated later", async () => {
    const finding = await makeFinding(IP_A);

    // At T0 the Finding has no verified CVE, so NVD is considered and has no
    // valid subject.
    const historical = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["nvd"],
      now: NOW,
    });
    expect(historical.items).toHaveLength(0);
    expect(historical.run.noSubjectProviders).toBe("nvd");

    // At T1 an analyst verifies a CVE.
    const vulnerability = await prisma.vulnerability.create({ data: { cveId: "CVE-2099-1001" } });
    await prisma.findingVulnerability.create({
      data: {
        findingId: finding.id,
        vulnerabilityId: vulnerability.id,
        state: "ACTIVE",
        evidenceSource: "ANALYST_VERIFIED",
        justification: "verified after the historical run was recorded",
        effectiveAt: NOW,
      },
    });

    // The HISTORICAL run is unchanged: same stored fact, still no NVD item.
    // T-09 holds — no NVD run item exists for a run recorded when no active
    // analyst-verified CVE existed.
    const reread = await prisma.findingEnrichmentRun.findUnique({
      where: { id: historical.run.id },
      include: { items: true },
    });
    expect(reread.noSubjectProviders).toBe("nvd");
    expect(reread.items).toHaveLength(0);

    // A NEW ask, on the other hand, sees the new subject — history is frozen,
    // the present is not.
    const current = await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["nvd"],
      now: NOW,
    });
    expect(current.run.id).not.toBe(historical.run.id);
    expect(current.run.noSubjectProviders).toBe("");
    expect(current.items).toHaveLength(1);
    expect(current.items[0].subjectValue).toBe("CVE-2099-1001");
  });

  it("records an audit event that carries counts, never a subject or a hash", async () => {
    const finding = await makeFinding(IP_A);
    await createEnrichmentRun(finding.id, {
      client: prisma,
      trigger: "MANUAL",
      providers: ["censys"],
      now: NOW,
    });

    const events = await prisma.auditLog.findMany({
      where: { entityType: "Finding", entityId: String(finding.id) },
    });
    expect(events.length).toBeGreaterThan(0);
    const created = events.find((e) => e.action === "enrichment.orchestration.run.created");
    expect(created).toBeTruthy();

    const payload = JSON.stringify(created.after);
    expect(payload).toContain("decisionCounts");
    // No subject value, no idempotency key, no work-identity hash.
    expect(payload).not.toContain(IP_A);
    expect(payload).not.toContain("idempotencyKey");
    expect(payload).not.toContain("requestScopeHash");
  });
});
