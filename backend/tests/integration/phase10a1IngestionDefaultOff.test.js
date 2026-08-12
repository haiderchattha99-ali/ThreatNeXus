import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Phase 10A-1 — the DEFAULT-OFF CONTRACT, proven against the real ingestion
// pipeline rather than against the orchestration service in isolation.
//
// ===========================================================================
// What this file has to establish
// ===========================================================================
// 1. With AUTO_ENRICHMENT_ENABLED=false (the default), a report upload behaves
//    EXACTLY as it did before this milestone: legacy scheduling still runs, the
//    existing IocEnrichment row is still created, every pre-existing response
//    field is unchanged, and ZERO Phase-10 rows of any kind exist.
// 2. With it on, durable orchestration records appear — and STILL no provider
//    is contacted, no attempt row is written and no quota is reserved.
//
// The switch is read through src/config/env.js, which is frozen at first
// require. So each case runs the pipeline in a FRESH module registry with the
// environment set beforehand (vitest's resetModules), rather than trying to
// mutate a frozen config object — which would prove nothing about the real
// startup path.
//
// Self-skips unless TEST_DATABASE_URL is set.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const { PrismaClient } = require("@prisma/client");
const { REPORT_SOURCES } = require("../../src/services/ingestion/reportSourceRegistry");

const MARKER = "p10a1-default-off";
// TEST-NET-2 (RFC 5737). Deliberately NOT in 192.0.2.*: ownershipConcurrency
// blanket-deletes every Finding whose indicator starts with "192.0.2." during
// its own cleanup, which reached this suite's Finding and then failed on its
// FindingOccurrence foreign key whenever the two files ran concurrently.
// No suite prefix-deletes 198.51.100.*, and .181 is used by nothing else.
const IP = "198.51.100.181";
const OBSERVED_AT = "2026-08-11T09:00:00.000Z";

let prisma;

const HEADER = "timestamp,ip,port,protocol,hostname,asn,as_name,country_code";
function buildCsv(port = "3389") {
  return Buffer.from(
    [HEADER, [OBSERVED_AT, IP, port, "tcp", "", "64500", "Example AS", "PK"].join(",")].join("\n") +
      "\n",
    "utf8"
  );
}

function upload(sourceFileName) {
  return {
    source: REPORT_SOURCES.SYNTHETIC_UPLOAD,
    sourceFileName,
    contentType: "text/csv",
    ingestedByUserId: null,
  };
}

/**
 * Loads the ingestion pipeline in a fresh module registry with an explicitly
 * constructed environment, so env.js resolves the switch under test.
 */
async function loadPipeline({ autoEnabled, censysBudget }) {
  const vitest = await import("vitest");
  vitest.vi.resetModules();

  process.env.TNX_SKIP_DOTENV = "true";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.JWT_SECRET = "test-jwt-secret-value-32-chars-min!!";
  process.env.CORS_ORIGIN = "http://localhost:5173";
  process.env.AUTO_ENRICHMENT_ENABLED = autoEnabled ? "true" : "false";
  process.env.ENRICHMENT_WORKER_ENABLED = "false";
  // A fake credential so censys is "configured"; still never contacted.
  process.env.CENSYS_PAT = "fake-censys-pat-for-tests";
  process.env.ABUSEIPDB_API_KEY = "";
  process.env.GREYNOISE_API_KEY = "";
  process.env.SHODAN_API_KEY = "";
  process.env.NETLAS_API_KEY = "";
  process.env.CENSYS_AUTOMATIC_DAILY_BUDGET = String(censysBudget);

  // eslint-disable-next-line global-require
  return require("../../src/services/ingestion/reportIngestionService");
}

// Runs/items/jobs are scoped to THIS file's indicator: the suite shares one
// database and other Phase-10 files run in parallel, so a global count would
// assert on their rows.
//
// Attempts and usage are counted GLOBALLY on purpose. Phase 10A-1 must never
// write either row anywhere, by any path, so the global zero is the strongest
// available statement of the milestone's central claim — and a parallel suite
// cannot make it flaky, because no suite is allowed to produce one.
async function countPhase10Rows() {
  const [runs, items, jobs, attempts, usage] = await Promise.all([
    prisma.findingEnrichmentRun.count({ where: { finding: { indicatorValue: IP } } }),
    prisma.findingEnrichmentRunItem.count({ where: { finding: { indicatorValue: IP } } }),
    prisma.providerLookupJob.count({ where: { subjectValue: IP } }),
    prisma.providerLookupAttempt.count(),
    prisma.providerDailyUsage.count({ where: { provider: { not: { startsWith: "p10a1c-" } } } }),
  ]);
  return { runs, items, jobs, attempts, usage };
}

async function cleanup() {
  const reports = await prisma.rawReport.findMany({
    where: { sourceFileName: { startsWith: MARKER } },
    select: { id: true },
  });
  const reportIds = reports.map((r) => r.id);

  await prisma.$executeRawUnsafe(`DELETE FROM "FindingEnrichmentRunItem" WHERE "findingId" IN
     (SELECT id FROM "Finding" WHERE "indicatorValue" = $1)`, IP);
  await prisma.$executeRawUnsafe(`DELETE FROM "FindingEnrichmentRun" WHERE "findingId" IN
     (SELECT id FROM "Finding" WHERE "indicatorValue" = $1)`, IP);
  await prisma.$executeRawUnsafe(`DELETE FROM "ProviderLookupJob" WHERE "subjectValue" = $1`, IP);
  if (reportIds.length > 0) {
    await prisma.rawReportRow.deleteMany({ where: { rawReportId: { in: reportIds } } });
  }
  await prisma.$executeRawUnsafe(`DELETE FROM "FindingOccurrence" WHERE "findingId" IN
     (SELECT id FROM "Finding" WHERE "indicatorValue" = $1)`, IP);
  // RiskFactorContribution first: it holds an FK onto RiskScore, and risk
  // scoring runs as part of the pipeline under test.
  await prisma.$executeRawUnsafe(`DELETE FROM "RiskFactorContribution" WHERE "riskScoreId" IN
     (SELECT id FROM "RiskScore" WHERE "findingId" IN
       (SELECT id FROM "Finding" WHERE "indicatorValue" = $1))`, IP);
  await prisma.$executeRawUnsafe(`DELETE FROM "RiskScore" WHERE "findingId" IN
     (SELECT id FROM "Finding" WHERE "indicatorValue" = $1)`, IP);
  await prisma.$executeRawUnsafe(`DELETE FROM "FindingOwnership" WHERE "findingId" IN
     (SELECT id FROM "Finding" WHERE "indicatorValue" = $1)`, IP);
  await prisma.$executeRawUnsafe(`DELETE FROM "Finding" WHERE "indicatorValue" = $1`, IP);
  await prisma.rawReport.deleteMany({ where: { sourceFileName: { startsWith: MARKER } } });
  await prisma.iocEnrichment.deleteMany({ where: { indicator: IP } });
}

const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

describeOrSkip("Phase 10A-1 default-off contract (real PostgreSQL)", () => {
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

  it("with AUTO_ENRICHMENT_ENABLED=false, ingestion creates ZERO Phase-10 records", async () => {
    const before = await countPhase10Rows();
    const pipeline = await loadPipeline({ autoEnabled: false, censysBudget: 0 });

    const result = await pipeline.ingestAccessibleRdpReport(
      { fileBytes: buildCsv(), ...upload(`${MARKER}-off.csv`) },
      { client: prisma }
    );

    expect(result.outcome).toBe("PROCESSED");

    // Nothing Phase-10 exists — not a run, not an item, not a job, not an
    // attempt, not a usage row.
    const after = await countPhase10Rows();
    expect(after).toEqual(before);
    expect(
      await prisma.findingEnrichmentRun.count({
        where: { finding: { indicatorValue: IP } },
      })
    ).toBe(0);

    // The LEGACY path still ran: the existing IocEnrichment row was created,
    // exactly as before this milestone.
    expect(await prisma.iocEnrichment.count({ where: { indicator: IP } })).toBe(1);
    expect(result.enrichmentCounts.SCHEDULED).toBe(1);

    // Every pre-existing response field is untouched...
    expect(result.report).toBeTruthy();
    expect(result.findingCounts).toBeTruthy();
    expect(result.enrichmentCounts).toBeTruthy();

    // ...and the additive block is truthful about having done nothing.
    // The whole block is pinned, not just one field: the name (`enrichment`,
    // not `autoEnrichment`) and the closed `state` code are the contract.
    expect(result.autoEnrichment).toBeUndefined();
    expect(result.enrichment).toEqual({
      state: "AUTOMATIC_DISABLED",
      runsCreated: 0,
      itemsCreated: 0,
      jobsCreated: 0,
      jobsShared: 0,
      skipped: 0,
    });
    // The key set itself, so the block cannot quietly grow a field.
    expect(Object.keys(result.enrichment).sort()).toEqual([
      "itemsCreated",
      "jobsCreated",
      "jobsShared",
      "runsCreated",
      "skipped",
      "state",
    ]);

    // No Phase-10 orchestration audit event was emitted for THIS report or its
    // Findings. Scoped deliberately: the suite shares one database and other
    // Phase-10 files run in parallel, so an unscoped count would assert on
    // their rows rather than on this pipeline's behaviour.
    const findingIds = await prisma.finding.findMany({
      where: { indicatorValue: IP },
      select: { id: true },
    });
    const events = await prisma.auditLog.findMany({
      where: {
        action: { startsWith: "enrichment.orchestration." },
        OR: [
          { entityType: "RawReport", entityId: String(result.report.id) },
          { entityType: "Finding", entityId: { in: findingIds.map((f) => String(f.id)) } },
        ],
      },
    });
    expect(events).toHaveLength(0);
  });

  it("with AUTO_ENRICHMENT_ENABLED=true, ingestion records orchestration but contacts NOBODY", async () => {
    // A positive automatic budget for censys, so at least one item is genuinely
    // ELIGIBLE and a real job is created — otherwise this test would pass
    // trivially against an implementation that skipped everything.
    const pipeline = await loadPipeline({ autoEnabled: true, censysBudget: 25 });

    const result = await pipeline.ingestAccessibleRdpReport(
      { fileBytes: buildCsv(), ...upload(`${MARKER}-on.csv`) },
      { client: prisma }
    );

    expect(result.outcome).toBe("PROCESSED");
    expect(result.enrichment.state).toBe("RECORDED");
    expect(result.enrichment.runsCreated).toBe(1);
    expect(result.enrichment.itemsCreated).toBeGreaterThan(0);
    // The same six keys when enabled — the block's shape never changes with
    // the switch, only its values.
    expect(Object.keys(result.enrichment).sort()).toEqual([
      "itemsCreated",
      "jobsCreated",
      "jobsShared",
      "runsCreated",
      "skipped",
      "state",
    ]);

    // The counts are TRUTHFUL, not merely present: censys has a fake
    // credential and a budget of 25, so its target is genuinely eligible and
    // inserts one job; the four providers with no credential are policy-
    // skipped; nothing was shared, because no prior job existed for this IP.
    const createdJobs = await prisma.providerLookupJob.count({ where: { subjectValue: IP } });
    expect(result.enrichment.jobsCreated).toBe(createdJobs);
    expect(result.enrichment.jobsCreated).toBeGreaterThan(0);
    expect(result.enrichment.jobsShared).toBe(0);
    expect(result.enrichment.skipped).toBeGreaterThan(0);
    // Every item is either eligible-with-a-job or a policy skip.
    expect(result.enrichment.jobsCreated + result.enrichment.jobsShared + result.enrichment.skipped)
      .toBe(result.enrichment.itemsCreated);

    // Durable records exist.
    const runs = await prisma.findingEnrichmentRun.findMany({
      where: { finding: { indicatorValue: IP } },
      include: { items: { include: { lookupJob: true } } },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("INGESTION");
    // An INGESTION run carries its report and NO actor — attributing system
    // work to a real person would be a false attribution.
    expect(runs[0].rawReportId).not.toBeNull();
    expect(runs[0].actorUserId).toBeNull();

    const eligible = runs[0].items.filter((item) => item.decision === "ELIGIBLE");
    expect(eligible.length).toBeGreaterThan(0);

    // ...and every job created sits non-terminal, never contacted.
    // eslint-disable-next-line no-restricted-syntax
    for (const item of eligible) {
      expect(item.lookupJob).toBeTruthy();
      expect(item.lookupJob.lane).toBe("AUTOMATIC");
      expect(item.lookupJob.queriedAt).toBeNull();
      expect(item.lookupJob.claimedAt).toBeNull();
      expect(item.lookupJob.claimToken).toBeNull();
      expect(item.lookupJob.attemptCount).toBe(0);
      expect(["PENDING", "WAITING_ON_DELEGATE"]).toContain(item.lookupJob.state);
    }

    // THE core inertness assertion: not one attempt, not one reservation.
    expect(await prisma.providerLookupAttempt.count()).toBe(0);
    expect(await prisma.providerDailyUsage.count({ where: { provider: { not: { startsWith: "p10a1c-" } } } })).toBe(0);

    // The legacy path is unaffected by the switch being on.
    expect(await prisma.iocEnrichment.count({ where: { indicator: IP } })).toBe(1);
  });

  it("counts a SHARED job as shared, not as created, for a second Finding on one IP", async () => {
    const pipeline = await loadPipeline({ autoEnabled: true, censysBudget: 25 });

    // First report: port 3389. Creates the job for this IP.
    const first = await pipeline.ingestAccessibleRdpReport(
      { fileBytes: buildCsv("3389"), ...upload(`${MARKER}-share-a.csv`) },
      { client: prisma }
    );
    expect(first.enrichment.jobsCreated).toBeGreaterThan(0);
    expect(first.enrichment.jobsShared).toBe(0);

    // Second report: SAME IP, different port. The dedup key is
    // (indicator, port, protocol, reportType), so this is a DIFFERENT Finding
    // — but the same enrichment SUBJECT, so it must attach to the existing job
    // rather than create a second one.
    const second = await pipeline.ingestAccessibleRdpReport(
      { fileBytes: buildCsv("3390"), ...upload(`${MARKER}-share-b.csv`) },
      { client: prisma }
    );

    expect(second.enrichment.runsCreated).toBe(1);
    expect(second.enrichment.jobsCreated).toBe(0);
    expect(second.enrichment.jobsShared).toBe(first.enrichment.jobsCreated);

    // ONE outbound unit of work for both Findings — the whole point of keeping
    // work identity separate from request identity.
    expect(
      await prisma.providerLookupJob.count({ where: { subjectValue: IP, provider: "censys" } })
    ).toBe(1);
    expect(await prisma.providerLookupAttempt.count()).toBe(0);
  });

  it("is idempotent: re-uploading the identical report creates no second run", async () => {
    const pipeline = await loadPipeline({ autoEnabled: true, censysBudget: 25 });
    const bytes = buildCsv();

    await pipeline.ingestAccessibleRdpReport(
      { fileBytes: bytes, ...upload(`${MARKER}-idem.csv`) },
      { client: prisma }
    );
    // Identical bytes: classified as a duplicate upload, so the pipeline
    // short-circuits and no second orchestration run can be created.
    await pipeline.ingestAccessibleRdpReport(
      { fileBytes: bytes, ...upload(`${MARKER}-idem.csv`) },
      { client: prisma }
    );

    expect(
      await prisma.findingEnrichmentRun.count({ where: { finding: { indicatorValue: IP } } })
    ).toBe(1);
    expect(await prisma.providerLookupAttempt.count()).toBe(0);
  });
});
