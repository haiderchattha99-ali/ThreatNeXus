import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// Real-PostgreSQL end-to-end tests for the P2-T2e-2 enrichment workflow:
// ingestion scheduling, the Finding-scoped read service, manual/forced
// scheduling, and administrator bounded-batch execution. Mirrors the scope
// split already documented in reportIngestionConcurrency.test.js and
// enrichmentRetryDeadLetter.test.js: unit-test fakes (reportIngestionService.
// test.js, findingEnrichment{Read,Schedule}Service.test.js) prove decision
// logic; only genuine concurrent PostgreSQL connections can prove that
// active-job uniqueness holds under a real race.
//
// Self-skips unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_test?schema=public" npx vitest run tests/integration/enrichmentWorkflowConcurrency.test.js

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://unused:unused@localhost:5432/unused";
process.env.JWT_SECRET = process.env.JWT_SECRET || "a-reasonably-strong-32-char-plus-secret-value";
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

const { PrismaClient } = require("@prisma/client");

const {
  INGESTION_OUTCOMES,
  ingestAccessibleRdpReport,
} = require("../../src/services/ingestion/reportIngestionService");
const { REPORT_SOURCES } = require("../../src/services/ingestion/reportSourceRegistry");
const {
  scheduleFindingEnrichment,
} = require("../../src/services/enrichment/findingEnrichmentScheduleService");
const {
  getFindingEnrichmentContext,
} = require("../../src/services/enrichment/findingEnrichmentReadService");
const {
  scheduleEnrichment,
  scheduleEnrichmentForced,
} = require("../../src/services/enrichment/enrichmentQueueService");
const {
  claimPendingJob,
  completeClaimedJob,
  deadLetterClaimedJob,
} = require("../../src/services/enrichment/iocEnrichmentRepository");
const { executeEnrichmentBatch } = require("../../src/services/enrichment/enrichmentExecutionService");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Dedicated /24-scale range this suite owns exclusively — distinct from
// every other suite's marker/IP convention (p2t2b/d/e1-mock own
// 198.18-20.0.x; reportIngestionConcurrency/dedupServiceConcurrency own
// 198.51.100.x). Sub-ranges separate the four scenario groups so cleanup and
// scoped batch listing can filter by one shared "198.21." prefix while each
// group's own tests never collide with each other's fixtures.
const IP_PREFIX = "198.21.";
const INGESTION_IP = (n) => `198.21.0.${n}`;
const MANUAL_IP = (n) => `198.21.1.${n}`;
const BATCH_IP = (n) => `198.21.2.${n}`;

const T0 = new Date("2026-03-01T12:00:00.000Z");

let prisma;
let racers = [];

function racerClients(count) {
  while (racers.length < count) {
    racers.push(new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }));
  }
  return racers.slice(0, count);
}

// Same isolation technique as enrichmentRetryDeadLetter.test.js's
// scopedClient, adapted to this suite's identity: ingestion and manual
// scheduling always use the real "abuseipdb" provider name (never a test
// marker), so isolation here is by indicator prefix instead of by provider
// prefix. Only the candidate LISTING is scoped; claim/complete/release/
// dead-letter remain the real, unscoped production statements.
function scopedClient(client) {
  return {
    auditLog: client.auditLog,
    iocEnrichment: {
      findMany: (args = {}) =>
        client.iocEnrichment.findMany({
          ...args,
          where: { ...(args.where || {}), indicator: { startsWith: IP_PREFIX } },
        }),
      findUnique: (args) => client.iocEnrichment.findUnique(args),
      findFirst: (args) => client.iocEnrichment.findFirst(args),
      create: (args) => client.iocEnrichment.create(args),
      update: (args) => client.iocEnrichment.update(args),
      updateMany: (args) => client.iocEnrichment.updateMany(args),
    },
  };
}

async function cleanup() {
  const findings = await prisma.finding.findMany({
    where: { indicatorValue: { startsWith: IP_PREFIX } },
    select: { id: true },
  });
  const findingIds = findings.map((f) => f.id);

  const rawReports = await prisma.rawReport.findMany({
    where: { sourceFileName: { startsWith: "p2t2e2-" } },
    select: { id: true },
  });
  const rawReportIds = rawReports.map((r) => r.id);

  await prisma.iocEnrichment.deleteMany({ where: { indicator: { startsWith: IP_PREFIX } } });
  await prisma.findingOccurrence.deleteMany({ where: { rawReportId: { in: rawReportIds } } });
  await prisma.rawReportRow.deleteMany({ where: { rawReportId: { in: rawReportIds } } });
  await prisma.findingOwnership.deleteMany({ where: { findingId: { in: findingIds } } });
  await prisma.finding.deleteMany({ where: { id: { in: findingIds } } });
  await prisma.rawReport.deleteMany({ where: { id: { in: rawReportIds } } });
}

const HEADER = "timestamp,ip,port,protocol,hostname,asn,as_name,country_code";
function csvRow(r) {
  return [r.timestamp, r.ip, r.port, r.protocol, r.hostname || "", r.asn || "", r.as_name || "", r.country_code || ""].join(
    ","
  );
}
function buildCsv(rows) {
  return Buffer.from([HEADER, ...rows.map(csvRow)].join("\n") + "\n", "utf8");
}

function upload(sourceFileName, overrides = {}) {
  return {
    source: REPORT_SOURCES.SYNTHETIC_UPLOAD,
    sourceFileName,
    contentType: "text/csv",
    ingestedByUserId: null,
    ...overrides,
  };
}

async function createManualFinding(indicator, { port = 3389, protocol = "TCP", reportType = "ACCESSIBLE_RDP" } = {}) {
  return prisma.finding.create({
    data: {
      indicatorValue: indicator,
      port,
      protocol,
      reportType,
      status: "OPEN",
      firstSeen: T0,
      lastSeen: T0,
    },
  });
}

function fakeProvider(name, resultFor) {
  const calls = [];
  return {
    name,
    supports: () => true,
    async lookup(input) {
      calls.push(input);
      const outcome = typeof resultFor === "function" ? resultFor(input) : resultFor;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    getCalls: () => calls,
  };
}

function registryOf(map) {
  return {
    resolve(name) {
      if (!Object.prototype.hasOwnProperty.call(map, name)) throw new Error(`no such provider: ${name}`);
      return map[name];
    },
  };
}

const { ENRICHMENT_STATUS, createEnrichmentResult } = require("../../src/services/enrichment/iocEnrichmentTypes");

// Builds a result FOR WHATEVER indicator the runner actually claimed —
// never a fixed value — so a fake provider built from this stays valid no
// matter how many/which PENDING candidates a scoped batch call picks up.
// completeClaimedJob's own assertResultMatchesRecord rejects a mismatched
// indicator, so a fixed indicator here would silently turn every completion
// in a multi-candidate batch into a release instead of a real regression
// signal.
function successResult(now, indicator) {
  return createEnrichmentResult({
    provider: "abuseipdb",
    indicatorType: "IPV4",
    indicator,
    status: ENRICHMENT_STATUS.SUCCESS,
    queriedAt: now,
    httpStatus: 200,
    data: {
      abuseConfidenceScore: 12,
      totalReports: 2,
      countryCode: null,
      isp: null,
      domain: null,
      usageType: null,
      isWhitelisted: false,
      lastReportedAt: null,
    },
  });
}

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb("P2-T2e-2 enrichment workflow — real PostgreSQL end-to-end", () => {
  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
    await Promise.all(racers.map((r) => r.$disconnect()));
  });

  it("1. one report with duplicate rows creates exactly one active enrichment job; evidence and lifecycle remain correct", async () => {
    const indicator = INGESTION_IP(10);
    const fileBytes = buildCsv([
      { timestamp: "2026-03-01T00:00:00Z", ip: indicator, port: "3389", protocol: "tcp" },
      { timestamp: "2026-03-01T00:05:00Z", ip: indicator, port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport(
      { fileBytes, ...upload("p2t2e2-1.csv") },
      { client: prisma }
    );

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.report.status).toBe("COMPLETED");
    expect(result.findingCounts.CREATED).toBe(1);

    const jobs = await prisma.iocEnrichment.findMany({ where: { indicator } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("PENDING");
    expect(jobs[0].provider).toBe("abuseipdb");
    expect(jobs[0].activeCacheKey).not.toBeNull();
  });

  it("2. a second report observing the same Finding does not create a second active job", async () => {
    const indicator = INGESTION_IP(11);

    const first = await ingestAccessibleRdpReport(
      {
        fileBytes: buildCsv([{ timestamp: "2026-03-01T00:00:00Z", ip: indicator, port: "3389", protocol: "tcp" }]),
        ...upload("p2t2e2-2a.csv"),
      },
      { client: prisma }
    );
    expect(first.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);

    const second = await ingestAccessibleRdpReport(
      {
        fileBytes: buildCsv([{ timestamp: "2026-03-02T00:00:00Z", ip: indicator, port: "3389", protocol: "tcp" }]),
        ...upload("p2t2e2-2b.csv"),
      },
      { client: prisma }
    );
    expect(second.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    // Same Finding observed twice (PERSISTED, not CREATED, the second time).
    expect(second.findingCounts.PERSISTED).toBe(1);

    const jobs = await prisma.iocEnrichment.findMany({ where: { indicator } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("PENDING");
  });

  it("3. an injected enrichment-scheduling failure never rolls back evidence or report completion", async () => {
    const indicator = INGESTION_IP(12);
    const failingClient = {
      rawReport: prisma.rawReport,
      rawReportRow: prisma.rawReportRow,
      auditLog: prisma.auditLog,
      findingOwnership: prisma.findingOwnership,
      $transaction: (fn, options) => prisma.$transaction(fn, options),
      iocEnrichment: {
        findFirst: async () => {
          throw new Error("injected enrichment scheduling failure");
        },
      },
    };

    const result = await ingestAccessibleRdpReport(
      {
        fileBytes: buildCsv([{ timestamp: "2026-03-01T00:00:00Z", ip: indicator, port: "3389", protocol: "tcp" }]),
        ...upload("p2t2e2-3.csv"),
      },
      { client: failingClient }
    );

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.report.status).toBe("COMPLETED");

    const finding = await prisma.finding.findFirst({ where: { indicatorValue: indicator } });
    expect(finding).not.toBeNull();
    expect(finding.status).toBe("OPEN");

    const jobs = await prisma.iocEnrichment.findMany({ where: { indicator } });
    expect(jobs).toHaveLength(0);
  });

  it("4. concurrent manual normal scheduling produces exactly one active PENDING row", async () => {
    const indicator = MANUAL_IP(10);
    const finding = await createManualFinding(indicator);
    const [c1, c2] = racerClients(2);

    const identity = { provider: "abuseipdb", indicatorType: "IPV4", indicator, queryParams: { maxAgeInDays: 90 } };
    const [r1, r2] = await Promise.all([
      scheduleEnrichment(identity, { client: c1, asOf: T0 }),
      scheduleEnrichment(identity, { client: c2, asOf: T0 }),
    ]);

    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(["ALREADY_PENDING", "SCHEDULED"]);

    const active = await prisma.iocEnrichment.findMany({ where: { indicator, status: "PENDING" } });
    expect(active).toHaveLength(1);
    void finding;
  });

  it("5. concurrent forced scheduling against an existing fresh terminal result creates exactly one new active PENDING row, and the prior terminal row is unchanged", async () => {
    const indicator = MANUAL_IP(11);
    await createManualFinding(indicator);
    const identity = { provider: "abuseipdb", indicatorType: "IPV4", indicator, queryParams: { maxAgeInDays: 90 } };

    const scheduled = await scheduleEnrichment(identity, { client: prisma, asOf: T0 });
    expect(scheduled.outcome).toBe("SCHEDULED");
    const claim = await claimPendingJob(scheduled.record.id, { client: prisma, now: T0, leaseMs: 60000 });
    const terminal = successResult(T0, indicator);
    const completion = await completeClaimedJob(
      {
        id: claim.record.id,
        claimToken: claim.claimToken,
        result: { ...terminal, indicator },
        expiresAt: new Date(T0.getTime() + 3600000),
      },
      { client: prisma }
    );
    expect(completion.outcome).toBe("COMPLETED");

    const [c1, c2] = racerClients(2);
    const forceAsOf = new Date(T0.getTime() + 1000);
    const [f1, f2] = await Promise.all([
      scheduleEnrichmentForced(identity, { client: c1, asOf: forceAsOf }),
      scheduleEnrichmentForced(identity, { client: c2, asOf: forceAsOf }),
    ]);

    const outcomes = [f1.outcome, f2.outcome].sort();
    expect(outcomes).toEqual(["ALREADY_PENDING", "SCHEDULED"]);

    const pending = await prisma.iocEnrichment.findMany({ where: { indicator, status: "PENDING" } });
    expect(pending).toHaveLength(1);

    const priorTerminal = await prisma.iocEnrichment.findUnique({ where: { id: completion.record.id } });
    expect(priorTerminal.status).toBe("SUCCESS");
    expect(priorTerminal.abuseConfidenceScore).toBe(12);
  });

  it("6. forced scheduling recovers a dead-lettered indicator: dead-letter history remains, a new active attempt is created, and no automatic resurrection happens without the manual action", async () => {
    const indicator = MANUAL_IP(12);
    const finding = await createManualFinding(indicator);
    const identity = { provider: "abuseipdb", indicatorType: "IPV4", indicator, queryParams: { maxAgeInDays: 90 } };

    const scheduled = await scheduleEnrichment(identity, { client: prisma, asOf: T0 });
    const claim = await claimPendingJob(scheduled.record.id, { client: prisma, now: T0, leaseMs: 60000 });
    const deadLettered = await deadLetterClaimedJob(
      { id: claim.record.id, claimToken: claim.claimToken, reasonCode: "MAX_ATTEMPTS_PROVIDER_ERROR" },
      { client: prisma, now: T0 }
    );
    expect(deadLettered.outcome).toBe("DEAD_LETTERED");

    // No automatic resurrection: reading enrichment context does not create
    // or change anything.
    const before = await getFindingEnrichmentContext(finding.id, { client: prisma, asOf: T0 });
    expect(before.current).toBeNull();
    expect(before.history.some((h) => h.status === "DEAD_LETTER")).toBe(true);
    const afterRead = await prisma.iocEnrichment.findMany({ where: { indicator } });
    expect(afterRead).toHaveLength(1);
    expect(afterRead[0].status).toBe("DEAD_LETTER");

    const recovered = await scheduleFindingEnrichment(finding.id, {
      client: prisma,
      now: new Date(T0.getTime() + 1000),
      force: true,
      justification: "Analyst manually recovering a dead-lettered indicator.",
    });
    expect(recovered.outcome).toBe("SCHEDULED");

    const rows = await prisma.iocEnrichment.findMany({ where: { indicator }, orderBy: { id: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("DEAD_LETTER");
    expect(rows[0].terminalReasonCode).toBe("MAX_ATTEMPTS_PROVIDER_ERROR");
    expect(rows[1].status).toBe("PENDING");
  });

  it("7. a scheduled job is claimed and completed by the bounded batch route, and its execution audit contains aggregate fields only", async () => {
    const indicator = BATCH_IP(1);
    await createManualFinding(indicator);
    const identity = { provider: "abuseipdb", indicatorType: "IPV4", indicator, queryParams: { maxAgeInDays: 90 } };
    await scheduleEnrichment(identity, { client: prisma, asOf: T0 });

    const provider = fakeProvider("abuseipdb", (input) => successResult(T0, input.indicator));
    const summary = await executeEnrichmentBatch({
      prisma: scopedClient(prisma),
      now: T0,
      workerId: "test-worker-7",
      batchSize: 10,
      runtimeOverrides: { providerRegistry: registryOf({ abuseipdb: provider }) },
    });

    expect(summary.completedCount).toBeGreaterThanOrEqual(1);
    expect(provider.getCalls()).toHaveLength(summary.completedCount);

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: summary.results[0].enrichmentId } });
    expect(stored.status).toBe("SUCCESS");
    expect(stored.abuseConfidenceScore).toBe(12);

    const batchAudits = await prisma.auditLog.findMany({
      where: { action: { in: ["enrichment.batch.requested", "enrichment.batch.completed"] }, entityType: "IocEnrichmentBatch" },
      orderBy: { id: "desc" },
      take: 2,
    });
    expect(batchAudits.length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(batchAudits);
    expect(serialized).not.toContain(indicator);
    expect(serialized).not.toContain("claimToken");
  });

  it("8. a missing AbuseIPDB API key yields SKIPPED_DISABLED terminal context with zero network calls, readable through the Finding enrichment service", async () => {
    const indicator = BATCH_IP(2);
    const finding = await createManualFinding(indicator);
    const identity = { provider: "abuseipdb", indicatorType: "IPV4", indicator, queryParams: { maxAgeInDays: 90 } };
    await scheduleEnrichment(identity, { client: prisma, asOf: T0 });

    // No providerRegistry override: this resolves the REAL AbuseIPDBProvider
    // from validated env. ABUSEIPDB_API_KEY is unset in this test process, so
    // the provider must short-circuit to SKIPPED_DISABLED before any fetch.
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => {
      throw new Error("fetch must never be called when ABUSEIPDB_API_KEY is unset");
    });
    let summary;
    try {
      summary = await executeEnrichmentBatch({
        prisma: scopedClient(prisma),
        now: T0,
        workerId: "test-worker-8",
        batchSize: 10,
      });
    } finally {
      global.fetch = originalFetch;
    }

    expect(summary.completedCount).toBeGreaterThanOrEqual(1);
    expect(summary.statusCounts.SKIPPED_DISABLED).toBeGreaterThanOrEqual(1);

    // SKIPPED_DISABLED is cached like any other terminal status (P2-T2c) —
    // still surfaced as `current` within its short TTL, but the status field
    // itself proves it is never mistaken for a clean/fresh reputation result.
    const context = await getFindingEnrichmentContext(finding.id, { client: prisma, asOf: T0 });
    expect(context.current).not.toBeNull();
    expect(context.current.status).toBe("SKIPPED_DISABLED");
    expect(context.current.abuseConfidenceScore).toBeNull();
    expect(context.current.errorCode).toBe("ENRICHMENT_DISABLED");
    expect(context.history[0].status).toBe("SKIPPED_DISABLED");
  });

  it("9. an audit-write failure does not prevent manual scheduling or batch completion from persisting", async () => {
    const manualIndicator = MANUAL_IP(13);
    const finding = await createManualFinding(manualIndicator);
    const brokenAuditClient = {
      finding: prisma.finding,
      iocEnrichment: prisma.iocEnrichment,
      auditLog: {
        create: async () => {
          throw new Error("audit sink unreachable");
        },
      },
    };

    const outcome = await scheduleFindingEnrichment(finding.id, { client: brokenAuditClient, now: T0 });
    expect(outcome.outcome).toBe("SCHEDULED");
    const jobs = await prisma.iocEnrichment.findMany({ where: { indicator: manualIndicator } });
    expect(jobs).toHaveLength(1);

    const batchIndicator = BATCH_IP(3);
    await createManualFinding(batchIndicator);
    await scheduleEnrichment(
      { provider: "abuseipdb", indicatorType: "IPV4", indicator: batchIndicator, queryParams: { maxAgeInDays: 90 } },
      { client: prisma, asOf: T0 }
    );
    const provider = fakeProvider("abuseipdb", (input) => successResult(T0, input.indicator));
    const scopedBroken = {
      ...scopedClient(prisma),
      auditLog: { create: async () => { throw new Error("audit sink unreachable"); } },
    };
    const summary = await executeEnrichmentBatch({
      prisma: scopedBroken,
      now: T0,
      workerId: "test-worker-9",
      batchSize: 10,
      runtimeOverrides: { providerRegistry: registryOf({ abuseipdb: provider }) },
    });
    expect(summary.completedCount).toBeGreaterThanOrEqual(1);
    const stored = await prisma.iocEnrichment.findFirst({ where: { indicator: batchIndicator } });
    expect(stored.status).toBe("SUCCESS");
  });

  it("10. a fully idempotent duplicate report upload creates no new enrichment row and no audit flood", async () => {
    const indicator = INGESTION_IP(13);
    const fileBytes = buildCsv([
      { timestamp: "2026-03-01T00:00:00Z", ip: indicator, port: "3389", protocol: "tcp" },
    ]);

    const first = await ingestAccessibleRdpReport({ fileBytes, ...upload("p2t2e2-10.csv") }, { client: prisma });
    expect(first.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);

    const second = await ingestAccessibleRdpReport({ fileBytes, ...upload("p2t2e2-10.csv") }, { client: prisma });
    expect(second.outcome).toBe(INGESTION_OUTCOMES.DUPLICATE_COMPLETED);

    const jobs = await prisma.iocEnrichment.findMany({ where: { indicator } });
    expect(jobs).toHaveLength(1);

    const scheduleAudits = await prisma.auditLog.findMany({
      where: { action: "enrichment.ingestion.schedule.completed" },
    });
    // Exactly one aggregate audit for the one report that actually processed
    // — the duplicate upload short-circuits before any of this pipeline runs.
    const forThisReport = scheduleAudits.filter((e) => Number(e.entityId) === first.report.id);
    expect(forThisReport).toHaveLength(1);
  });
});
