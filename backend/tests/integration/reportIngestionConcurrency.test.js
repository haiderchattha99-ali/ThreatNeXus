import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Real-PostgreSQL end-to-end tests for the P1-T5 ingestion orchestrator.
//
// These exist for the same reason as dedupServiceConcurrency.test.js: the
// unit-test fake Prisma client (reportIngestionService.test.js) proves
// decision logic but cannot prove PostgreSQL constraint/transaction
// behavior — real FK relationships, real unique-constraint races across
// concurrent HTTP-shaped uploads, and real JSONB round-tripping of
// RawReportRow.rawPayload.
//
// Self-skips unless TEST_DATABASE_URL is set, so the default `vitest run`
// stays green with no database and no backend/.env. Run against a disposable
// database only:
//   TEST_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_test?schema=public" npx vitest run tests/integration/reportIngestionConcurrency.test.js

const { PrismaClient } = require("@prisma/client");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// reportIngestionService requires config/env (for REPORT_MAX_ROWS), which
// validates its required variables at require time — unconditionally,
// regardless of whether TEST_DATABASE_URL is set, because Vitest imports
// this file (running every top-level statement, including this require) to
// discover its tests even when describeDb below is describe.skip. DATABASE_URL
// here is only ever read by config/env's validation and by config/prisma.js,
// which this file never requires — the real connection always goes through
// the explicit TEST_DATABASE_URL PrismaClient constructed in beforeAll,
// which itself only runs when the suite is not skipped.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://unused:unused@localhost:5432/unused";
process.env.JWT_SECRET = process.env.JWT_SECRET || "a-reasonably-strong-32-char-plus-secret-value";
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

const {
  INGESTION_OUTCOMES,
  ingestAccessibleRdpReport,
} = require("../../src/services/ingestion/reportIngestionService");
const { REPORT_SOURCES } = require("../../src/services/ingestion/reportSourceRegistry");

const MARKER = "p1t5-ingestion";
// TEST-NET-2 (RFC 5737) documentation addresses, one block per scenario so
// scenarios cannot interfere with each other's Findings.
const IP_BLOCK = Object.freeze({
  fullValid: "198.51.100.2",
  mixedValidity: "198.51.100.3",
  duplicateRows: "198.51.100.4",
  identicalUpload: "198.51.100.5",
  retry: "198.51.100.6",
  concurrent: "198.51.100.7",
  failure: "198.51.100.8",
  referential: "198.51.100.9",
});

let prisma;

const HEADER = "timestamp,ip,port,protocol,hostname,asn,as_name,country_code";
function csvRow(r) {
  return [r.timestamp, r.ip, r.port, r.protocol, r.hostname || "", r.asn || "", r.as_name || "", r.country_code || ""].join(
    ","
  );
}
function buildCsv(rows) {
  return Buffer.from([HEADER, ...rows.map(csvRow)].join("\n") + "\n", "utf8");
}

function upload(overrides = {}) {
  return {
    source: REPORT_SOURCES.SYNTHETIC_UPLOAD,
    sourceFileName: `${MARKER}.csv`,
    contentType: "text/csv",
    ingestedByUserId: null,
    ...overrides,
  };
}

// Deterministic, marker-scoped cleanup. A loose IP-prefix filter on Finding
// would also match dedupServiceConcurrency.test.js's own TEST-NET-2 range
// (198.51.100.11-15 also starts with "198.51.100."), so instead the exact set
// of Findings to delete is derived from this file's own RawReport evidence —
// self-contained regardless of what IP range any other test file picks.
async function cleanup() {
  const reports = await prisma.rawReport.findMany({
    where: { sourceFileName: { startsWith: MARKER } },
    select: { id: true },
  });
  const reportIds = reports.map((r) => r.id);

  const occurrences = await prisma.findingOccurrence.findMany({
    where: { rawReportId: { in: reportIds } },
    select: { findingId: true },
  });
  const findingIds = [...new Set(occurrences.map((o) => o.findingId))];

  await prisma.findingOccurrence.deleteMany({ where: { rawReportId: { in: reportIds } } });
  await prisma.rawReportRow.deleteMany({ where: { rawReportId: { in: reportIds } } });
  // P2-T1: ingestAccessibleRdpReport now also resolves ownership for every
  // Finding it touches, and FindingOwnership.findingId is onDelete: Restrict
  // — a Finding can no longer be deleted while it has ownership history.
  await prisma.findingOwnership.deleteMany({ where: { findingId: { in: findingIds } } });
  await prisma.finding.deleteMany({ where: { id: { in: findingIds } } });
  await prisma.rawReport.deleteMany({ where: { id: { in: reportIds } } });
}

// Wraps the real client so a specific call inside dedupService's own
// transaction can be forced to fail, while every other operation (including
// the report-level rawReport/rawReportRow calls the orchestrator makes
// directly) goes to the real Prisma client untouched.
function makeFailingClient(realPrisma, shouldFail) {
  return {
    rawReport: realPrisma.rawReport,
    rawReportRow: realPrisma.rawReportRow,
    auditLog: realPrisma.auditLog,
    $transaction: (fn, options) =>
      realPrisma.$transaction((tx) => {
        const wrappedTx = {
          finding: {
            findUnique: (args) => tx.finding.findUnique(args),
            create: (args) => {
              if (shouldFail(args)) throw new Error("injected failure for test 7");
              return tx.finding.create(args);
            },
            update: (args) => tx.finding.update(args),
          },
          findingOccurrence: {
            findUnique: (args) => tx.findingOccurrence.findUnique(args),
            create: (args) => tx.findingOccurrence.create(args),
          },
        };
        return fn(wrappedTx);
      }, options),
  };
}

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb("reportIngestionService — real PostgreSQL end-to-end", () => {
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
  });

  it("1. a fully valid fixture produces correct RawReport/RawReportRow/Finding/FindingOccurrence counts and links", async () => {
    const fileBytes = buildCsv([
      { timestamp: "2026-05-01T00:00:00Z", ip: IP_BLOCK.fullValid, port: "3389", protocol: "tcp" },
      { timestamp: "2026-05-01T00:05:00Z", ip: "198.51.100.20", port: "3389", protocol: "tcp" },
      { timestamp: "2026-05-01T00:10:00Z", ip: "198.51.100.21", port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...upload() }, { client: prisma });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.report.status).toBe("COMPLETED");

    const rows = await prisma.rawReportRow.findMany({ where: { rawReportId: result.report.id } });
    expect(rows).toHaveLength(3);
    rows.forEach((row) => {
      expect(row.status).toBe("VALID");
      expect(row.findingOccurrenceId).not.toBeNull();
    });

    const occurrences = await prisma.findingOccurrence.findMany({
      where: { rawReportId: result.report.id },
    });
    expect(occurrences).toHaveLength(3);

    const findingIds = new Set(occurrences.map((o) => o.findingId));
    expect(findingIds.size).toBe(3);
  }, 30000);

  it("2. a mixed-validity fixture preserves every row, valid and invalid alike", async () => {
    const fileBytes = buildCsv([
      { timestamp: "2026-05-02T00:00:00Z", ip: IP_BLOCK.mixedValidity, port: "3389", protocol: "tcp" },
      { timestamp: "2026-05-02T00:05:00Z", ip: "not-an-ip", port: "3389", protocol: "tcp" },
      { timestamp: "2026-05-02T00:10:00Z", ip: "198.51.100.30", port: "99999", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...upload() }, { client: prisma });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.report.status).toBe("PARTIALLY_VALID");
    expect(result.report.validRows).toBe(1);
    expect(result.report.invalidRows).toBe(2);

    const rows = await prisma.rawReportRow.findMany({
      where: { rawReportId: result.report.id },
      orderBy: { rowNumber: "asc" },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.status)).toEqual(["VALID", "INVALID", "INVALID"]);
    expect(rows[1].validationErrors).not.toBeNull();
    expect(rows[1].findingOccurrenceId).toBeNull();
    expect(rows[2].findingOccurrenceId).toBeNull();
  }, 30000);

  it("3. duplicate rows within one report create exactly one FindingOccurrence", async () => {
    const fileBytes = buildCsv([
      { timestamp: "2026-05-03T00:10:00Z", ip: IP_BLOCK.duplicateRows, port: "3389", protocol: "tcp" },
      { timestamp: "2026-05-03T00:00:00Z", ip: IP_BLOCK.duplicateRows, port: "3389", protocol: "tcp" },
      { timestamp: "2026-05-03T00:20:00Z", ip: IP_BLOCK.duplicateRows, port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...upload() }, { client: prisma });

    const occurrences = await prisma.findingOccurrence.findMany({
      where: { rawReportId: result.report.id },
    });
    expect(occurrences).toHaveLength(1);

    const finding = await prisma.finding.findUnique({ where: { id: occurrences[0].findingId } });
    expect(finding.occurrenceCount).toBe(1);
    expect(finding.lastSeen).toEqual(new Date("2026-05-03T00:20:00.000Z"));

    const rows = await prisma.rawReportRow.findMany({
      where: { rawReportId: result.report.id },
      orderBy: { rowNumber: "asc" },
    });
    expect(rows.every((r) => r.findingOccurrenceId === occurrences[0].id)).toBe(true);
    // Canonical = max observedAt = row 3 (00:20:00), not row 1 despite CSV order.
    expect(rows.map((r) => r.duplicateInReport)).toEqual([true, true, false]);
  }, 30000);

  it("4. an identical second upload creates no new evidence or lifecycle counters", async () => {
    const fileBytes = buildCsv([
      { timestamp: "2026-05-04T00:00:00Z", ip: IP_BLOCK.identicalUpload, port: "3389", protocol: "tcp" },
    ]);

    const first = await ingestAccessibleRdpReport({ fileBytes, ...upload() }, { client: prisma });
    expect(first.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);

    const reportCountBefore = await prisma.rawReport.count({
      where: { sourceFileName: { startsWith: MARKER } },
    });
    const rowCountBefore = await prisma.rawReportRow.count({
      where: { rawReportId: first.report.id },
    });
    const findingBefore = await prisma.finding.findFirst({
      where: { indicatorValue: IP_BLOCK.identicalUpload },
    });

    const second = await ingestAccessibleRdpReport({ fileBytes, ...upload() }, { client: prisma });

    expect(second.outcome).toBe(INGESTION_OUTCOMES.DUPLICATE_COMPLETED);
    expect(second.report.id).toBe(first.report.id);

    expect(
      await prisma.rawReport.count({ where: { sourceFileName: { startsWith: MARKER } } })
    ).toBe(reportCountBefore);
    expect(await prisma.rawReportRow.count({ where: { rawReportId: first.report.id } })).toBe(
      rowCountBefore
    );
    const findingAfter = await prisma.finding.findFirst({
      where: { indicatorValue: IP_BLOCK.identicalUpload },
    });
    expect(findingAfter.occurrenceCount).toBe(findingBefore.occurrenceCount);
    expect(findingAfter.updatedAt).toEqual(findingBefore.updatedAt);
  }, 30000);

  it("5. retry behavior reuses the original RawReport row rather than creating a second one", async () => {
    const fileBytes = buildCsv([
      { timestamp: "2026-05-05T00:00:00Z", ip: IP_BLOCK.retry, port: "3389", protocol: "tcp" },
    ]);

    // Simulate a prior interrupted attempt: the identity/create step ran
    // (raw evidence preserved) but processing never reached a terminal
    // status.
    const { computeSourceFileSha256 } = require("../../src/services/ingestion/reportIdentityService");
    const seeded = await prisma.rawReport.create({
      data: {
        reportType: "ACCESSIBLE_RDP",
        schemaVersion: "accessible-rdp.synthetic.v1",
        sourceFileName: `${MARKER}.csv`,
        sourceFileSha256: computeSourceFileSha256(fileBytes),
        fileSizeBytes: fileBytes.length,
        contentType: "text/csv",
        rawContent: fileBytes,
        observationDate: new Date("2026-05-05T00:00:00.000Z"),
        status: "FAILED",
        processingAttempts: 1,
        totalRows: 1,
        validRows: 1,
        invalidRows: 0,
        errorSummary: { code: "PROCESSING_ERROR", message: "simulated prior failure" },
      },
    });

    const result = await ingestAccessibleRdpReport({ fileBytes, ...upload() }, { client: prisma });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.report.id).toBe(seeded.id);
    expect(result.report.status).toBe("COMPLETED");
    expect(result.report.processingAttempts).toBe(2);

    const reportCount = await prisma.rawReport.count({
      where: { sourceFileName: { startsWith: MARKER } },
    });
    expect(reportCount).toBe(1);
  }, 30000);

  it("6. concurrent overlapping reports observing the same Finding retain correct projections", async () => {
    const t1 = new Date("2026-05-06T00:00:00.000Z");
    const t2 = new Date("2026-05-06T01:00:00.000Z");
    const csvA = buildCsv([
      { timestamp: t1.toISOString(), ip: IP_BLOCK.concurrent, port: "3389", protocol: "tcp" },
    ]);
    const csvB = buildCsv([
      { timestamp: t2.toISOString(), ip: IP_BLOCK.concurrent, port: "3389", protocol: "tcp" },
    ]);

    const [resultA, resultB] = await Promise.all([
      ingestAccessibleRdpReport({ fileBytes: csvA, ...upload({ sourceFileName: `${MARKER}-a.csv` }) }, { client: prisma }),
      ingestAccessibleRdpReport({ fileBytes: csvB, ...upload({ sourceFileName: `${MARKER}-b.csv` }) }, { client: prisma }),
    ]);

    expect(resultA.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(resultB.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(resultA.report.id).not.toBe(resultB.report.id);

    const finding = await prisma.finding.findFirst({ where: { indicatorValue: IP_BLOCK.concurrent } });
    expect(finding.occurrenceCount).toBe(2);
    expect(finding.firstSeen).toEqual(t1);
    expect(finding.lastSeen).toEqual(t2);

    const occurrences = await prisma.findingOccurrence.findMany({ where: { findingId: finding.id } });
    expect(occurrences).toHaveLength(2);
    expect(new Set(occurrences.map((o) => o.rawReportId)).size).toBe(2);
  }, 30000);

  it("7. a system failure marks the report FAILED — never leaves it looking successful", async () => {
    const fileBytes = buildCsv([
      { timestamp: "2026-05-07T00:00:00Z", ip: IP_BLOCK.failure, port: "3389", protocol: "tcp" },
    ]);
    const failingClient = makeFailingClient(prisma, () => true);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...upload() }, { client: failingClient });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.FAILED);
    expect(result.report.status).toBe("FAILED");

    const stored = await prisma.rawReport.findUnique({ where: { id: result.report.id } });
    expect(stored.status).toBe("FAILED");
    expect(["COMPLETED", "PARTIALLY_VALID"]).not.toContain(stored.status);
    expect(stored.errorSummary).toBeTruthy();
    expect(stored.errorSummary.code).toBe("PROCESSING_ERROR");

    // No Finding/occurrence was left behind for the failed group.
    const finding = await prisma.finding.findFirst({ where: { indicatorValue: IP_BLOCK.failure } });
    expect(finding).toBeNull();
    const rows = await prisma.rawReportRow.findMany({ where: { rawReportId: result.report.id } });
    expect(rows).toHaveLength(0);
  }, 30000);

  it("8. every evidence/FK relationship resolves correctly end-to-end", async () => {
    const fileBytes = buildCsv([
      { timestamp: "2026-05-08T00:00:00Z", ip: IP_BLOCK.referential, port: "3389", protocol: "tcp" },
    ]);
    const result = await ingestAccessibleRdpReport({ fileBytes, ...upload() }, { client: prisma });

    const row = await prisma.rawReportRow.findFirst({
      where: { rawReportId: result.report.id },
      include: {
        rawReport: true,
        findingOccurrence: { include: { finding: true, rawReport: true } },
      },
    });

    expect(row.rawReport.id).toBe(result.report.id);
    expect(row.findingOccurrence).not.toBeNull();
    expect(row.findingOccurrence.finding.indicatorValue).toBe(IP_BLOCK.referential);
    expect(row.findingOccurrence.rawReport.id).toBe(result.report.id);
    expect(row.findingOccurrence.action).toBe("CREATED");
  }, 30000);

  it("9. an untrusted source/report/schema tuple (P1-T6a) writes no evidence or lifecycle rows at all", async () => {
    const fileBytes = buildCsv([
      { timestamp: "2026-05-09T00:00:00Z", ip: "198.51.100.99", port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport(
      { fileBytes, ...upload({ source: "SHADOWSERVER" }) },
      { client: prisma }
    );

    expect(result.outcome).toBe(INGESTION_OUTCOMES.REJECTED);
    expect(result.reason).toBe("UNTRUSTED_SOURCE_REPORT_COMBINATION");
    expect(result.report).toBeNull();

    const reports = await prisma.rawReport.findMany({ where: { sourceFileName: { startsWith: MARKER } } });
    expect(reports).toHaveLength(0);
    const finding = await prisma.finding.findFirst({ where: { indicatorValue: "198.51.100.99" } });
    expect(finding).toBeNull();
    const rows = await prisma.rawReportRow.findMany({
      where: { rawReport: { sourceFileName: { startsWith: MARKER } } },
    });
    expect(rows).toHaveLength(0);
    const occurrences = await prisma.findingOccurrence.findMany({
      where: { rawReport: { sourceFileName: { startsWith: MARKER } } },
    });
    expect(occurrences).toHaveLength(0);
  }, 30000);
});
