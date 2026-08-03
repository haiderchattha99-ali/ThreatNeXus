import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// SCOPE NOTE, mirroring dedupService.test.js: these are unit tests against an
// in-memory fake Prisma client. They prove the orchestrator's decision logic
// — parsing/validation wiring, identity/retry branching, row-evidence
// idempotency, grouping/canonical-timestamp selection, audit shape, and
// failure handling. They are NOT proof of PostgreSQL transaction semantics;
// that is covered by the real-database suite in
// backend/tests/integration/reportIngestionConcurrency.test.js.

// reportIngestionService requires config/env (for REPORT_MAX_ROWS), which
// validates its required variables at require time — same pattern as
// authMiddleware.test.js: stage process.env, evict the cache, then require.
const { REPORT_SOURCES } = require("../../src/services/ingestion/reportSourceRegistry");
const { buildEnrichmentCacheIdentity } = require("../../src/services/enrichment/enrichmentCacheKey");

let originalEnv;
let INGESTION_OUTCOMES;
let RowEvidenceIntegrityError;
let ingestAccessibleRdpReport;

beforeAll(() => {
  originalEnv = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
    JWT_SECRET: "a-reasonably-strong-32-char-plus-secret-value",
    CORS_ORIGIN: "http://localhost:5173",
  });

  [
    require.resolve("../../src/config/env"),
    require.resolve("../../src/services/ingestion/reportIngestionService"),
  ].forEach((resolved) => delete require.cache[resolved]);

  ({
    INGESTION_OUTCOMES,
    RowEvidenceIntegrityError,
    ingestAccessibleRdpReport,
  } = require("../../src/services/ingestion/reportIngestionService"));
});

afterAll(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

function prismaError(code, message) {
  const error = new Error(message || `Prisma error ${code}`);
  error.code = code;
  return error;
}

function applyUpdateData(row, data) {
  Object.entries(data).forEach(([key, value]) => {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      Object.prototype.hasOwnProperty.call(value, "increment")
    ) {
      row[key] = (row[key] || 0) + value.increment;
    } else {
      row[key] = value;
    }
  });
}

// In-memory fake covering every Prisma model reportIngestionService and (via
// recordFindingObservation) dedupService touch. $transaction is a bare
// pass-through — real transaction/serialization semantics are out of scope
// for this file; see the scope note above.
function createFakeClient() {
  let nextRawReportId = 1;
  let nextRowId = 1;
  let nextFindingId = 1;
  let nextOccurrenceId = 1;
  let nextAuditId = 1;
  let nextIocEnrichmentId = 1;
  let nextWorkflowId = 1;

  const rawReports = new Map();
  const rawReportRows = new Map();
  const findings = new Map();
  const occurrences = new Map();
  const auditLogs = [];
  const iocEnrichments = new Map();
  const cases = new Map();
  const caseFindings = new Map();
  const caseLifecycleEvents = [];
  const findingTriages = new Map();
  const recurrenceReopens = new Map();

  const findRawReportBySha = (sha) =>
    [...rawReports.values()].find((r) => r.sourceFileSha256 === sha) || null;
  const findRowByPair = (rawReportId, rowNumber) =>
    [...rawReportRows.values()].find(
      (r) => r.rawReportId === rawReportId && r.rowNumber === rowNumber
    ) || null;
  const findFindingByIdentity = (identity) =>
    [...findings.values()].find(
      (f) =>
        f.indicatorValue === identity.indicatorValue &&
        f.port === identity.port &&
        f.protocol === identity.protocol &&
        f.reportType === identity.reportType
    ) || null;
  const findOccurrenceByPair = (findingId, rawReportId) =>
    [...occurrences.values()].find(
      (o) => o.findingId === findingId && o.rawReportId === rawReportId
    ) || null;

  const client = {
    rawReport: {
      findUnique: vi.fn(async ({ where }) => {
        if (where.sourceFileSha256 !== undefined) return findRawReportBySha(where.sourceFileSha256);
        if (where.id !== undefined) return rawReports.get(where.id) || null;
        return null;
      }),
      create: vi.fn(async ({ data }) => {
        if (findRawReportBySha(data.sourceFileSha256)) {
          throw prismaError("P2002", "Unique constraint failed on sourceFileSha256");
        }
        const row = {
          id: nextRawReportId++,
          processingAttempts: 0,
          completedAt: null,
          errorSummary: null,
          ...data,
        };
        rawReports.set(row.id, row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = rawReports.get(where.id);
        if (!row) throw prismaError("P2025", "record not found");
        applyUpdateData(row, data);
        return { ...row };
      }),
    },
    rawReportRow: {
      findUnique: vi.fn(async ({ where }) => {
        const key = where.rawReportId_rowNumber;
        return findRowByPair(key.rawReportId, key.rowNumber);
      }),
      create: vi.fn(async ({ data }) => {
        const row = { id: nextRowId++, createdAt: new Date(), ...data };
        rawReportRows.set(row.id, row);
        return { ...row };
      }),
    },
    finding: {
      findUnique: vi.fn(async ({ where }) => {
        if (where.id !== undefined) return findings.get(where.id) || null;
        return findFindingByIdentity(where.finding_identity);
      }),
      create: vi.fn(async ({ data }) => {
        if (findFindingByIdentity(data)) {
          throw prismaError("P2002", "Unique constraint failed on finding_identity");
        }
        const row = { id: nextFindingId++, updatedAt: new Date(), ...data };
        findings.set(row.id, row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = findings.get(where.id);
        if (!row) throw prismaError("P2025", "record not found");
        applyUpdateData(row, data);
        row.updatedAt = new Date();
        return { ...row };
      }),
    },
    findingOccurrence: {
      findUnique: vi.fn(async ({ where }) => {
        const key = where.findingId_rawReportId;
        return findOccurrenceByPair(key.findingId, key.rawReportId);
      }),
      create: vi.fn(async ({ data }) => {
        if (findOccurrenceByPair(data.findingId, data.rawReportId)) {
          throw prismaError("P2002", "Unique constraint failed on findingId_rawReportId");
        }
        const row = { id: nextOccurrenceId++, createdAt: new Date(), ...data };
        occurrences.set(row.id, row);
        return { ...row };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }) => {
        const row = { id: nextAuditId++, occurredAt: new Date(), ...data };
        auditLogs.push(row);
        return row;
      }),
    },
    // P2-T2e-2 — minimal fake covering exactly the calls
    // enrichmentQueueService.scheduleEnrichment issues: findFreshCachedResult
    // (findFirst), findActiveJobByCacheKey (findUnique by activeCacheKey),
    // createPendingJob (create, P2002 on a duplicate activeCacheKey). Real
    // Postgres concurrency semantics are out of scope here — see
    // backend/tests/integration/enrichmentIngestionScheduling.test.js.
    iocEnrichment: {
      findFirst: vi.fn(async ({ where }) => {
        let rows = [...iocEnrichments.values()];
        if (where.cacheKey !== undefined) rows = rows.filter((r) => r.cacheKey === where.cacheKey);
        if (where.status && Array.isArray(where.status.in)) {
          rows = rows.filter((r) => where.status.in.includes(r.status));
        }
        if (where.queriedAt && where.queriedAt.not === null) {
          rows = rows.filter((r) => r.queriedAt !== null && r.queriedAt !== undefined);
        }
        if (where.expiresAt && where.expiresAt.gt !== undefined) {
          rows = rows.filter((r) => r.expiresAt && r.expiresAt.getTime() > where.expiresAt.gt.getTime());
        }
        rows.sort((a, b) => {
          const aq = a.queriedAt ? a.queriedAt.getTime() : -Infinity;
          const bq = b.queriedAt ? b.queriedAt.getTime() : -Infinity;
          if (aq !== bq) return bq - aq;
          return b.id - a.id;
        });
        return rows[0] || null;
      }),
      findUnique: vi.fn(async ({ where }) => {
        if (where.activeCacheKey !== undefined) {
          return [...iocEnrichments.values()].find((r) => r.activeCacheKey === where.activeCacheKey) || null;
        }
        if (where.id !== undefined) return iocEnrichments.get(where.id) || null;
        return null;
      }),
      create: vi.fn(async ({ data }) => {
        if (data.activeCacheKey !== null && data.activeCacheKey !== undefined) {
          const exists = [...iocEnrichments.values()].some((r) => r.activeCacheKey === data.activeCacheKey);
          if (exists) throw prismaError("P2002", "Unique constraint failed on activeCacheKey");
        }
        const row = { id: nextIocEnrichmentId++, createdAt: new Date(), updatedAt: new Date(), ...data };
        iocEnrichments.set(row.id, row);
        return { ...row };
      }),
    },
    // Phase 3 — the recurrence-reopen hook that runs after every write above
    // has committed. Modelled far enough to exercise the real code path
    // (current links, case state, the composite idempotency key and the
    // guarded transition), because leaving these tables off the fake would
    // make every recurrence silently classify as FAILED and the tests below
    // would then prove only that ingestion survives a broken client.
    caseFinding: {
      findMany: vi.fn(async ({ where = {} } = {}) =>
        [...caseFindings.values()].filter(
          (row) =>
            (where.findingId === undefined || row.findingId === where.findingId) &&
            (where.caseId === undefined || row.caseId === where.caseId) &&
            (where.state === undefined || row.state === where.state) &&
            (where.supersededAt === undefined || row.supersededAt === where.supersededAt)
        )
      ),
    },
    case: {
      findUnique: vi.fn(async ({ where }) => cases.get(where.id) || null),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = cases.get(where.id);
        if (!row || (where.lifecycleState && row.lifecycleState !== where.lifecycleState)) {
          return { count: 0 };
        }
        applyUpdateData(row, data);
        return { count: 1 };
      }),
    },
    caseLifecycleEvent: {
      create: vi.fn(async ({ data }) => {
        const row = { id: nextWorkflowId++, createdAt: new Date(), ...data };
        caseLifecycleEvents.push(row);
        return { ...row };
      }),
    },
    findingTriage: {
      findUnique: vi.fn(async ({ where }) =>
        [...findingTriages.values()].find(
          (row) => row.currentForFindingId === where.currentForFindingId
        ) || null
      ),
      update: vi.fn(async ({ where, data }) => {
        const row = findingTriages.get(where.id);
        applyUpdateData(row, data);
        return { ...row };
      }),
      create: vi.fn(async ({ data }) => {
        const row = { id: nextWorkflowId++, createdAt: new Date(), ...data };
        findingTriages.set(row.id, row);
        return { ...row };
      }),
    },
    caseRecurrenceReopen: {
      findUnique: vi.fn(async ({ where }) => {
        const key = where.findingOccurrenceId_caseId;
        return (
          [...recurrenceReopens.values()].find(
            (row) =>
              row.findingOccurrenceId === key.findingOccurrenceId && row.caseId === key.caseId
          ) || null
        );
      }),
      create: vi.fn(async ({ data }) => {
        const clash = [...recurrenceReopens.values()].some(
          (row) =>
            row.findingOccurrenceId === data.findingOccurrenceId && row.caseId === data.caseId
        );
        if (clash) throw prismaError("P2002", "Unique constraint failed on recurrence identity");
        const row = { id: nextWorkflowId++, createdAt: new Date(), ...data };
        recurrenceReopens.set(row.id, row);
        return { ...row };
      }),
    },
    $transaction: vi.fn(async (fn) => fn(client)),
  };

  return {
    client,
    rawReports,
    rawReportRows,
    findings,
    occurrences,
    auditLogs,
    iocEnrichments,
    cases,
    caseFindings,
    caseLifecycleEvents,
    findingTriages,
    recurrenceReopens,
  };
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

function baseUpload(overrides = {}) {
  return {
    source: REPORT_SOURCES.SYNTHETIC_UPLOAD,
    sourceFileName: "day-1.csv",
    contentType: "text/csv",
    ingestedByUserId: 7,
    ...overrides,
  };
}

describe("ingestAccessibleRdpReport — fully valid report", () => {
  it("creates one RawReport, links every row, and reports COMPLETED", async () => {
    const { client, rawReports, rawReportRows, findings, occurrences, auditLogs } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-01T00:05:00Z", ip: "203.0.113.11", port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.report.status).toBe("COMPLETED");
    expect(result.report.totalRows).toBe(2);
    expect(result.report.validRows).toBe(2);
    expect(result.report.invalidRows).toBe(0);
    expect(result.findingCounts.CREATED).toBe(2);

    expect(rawReports.size).toBe(1);
    expect(rawReportRows.size).toBe(2);
    expect(findings.size).toBe(2);
    expect(occurrences.size).toBe(2);
    [...rawReportRows.values()].forEach((row) => {
      expect(row.status).toBe("VALID");
      expect(row.findingOccurrenceId).not.toBeNull();
    });

    const started = auditLogs.filter((e) => e.action === "report.ingestion.started");
    const completed = auditLogs.filter((e) => e.action === "report.ingestion.completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
  });

  it("sets RawReport.observationDate to the earliest valid row timestamp, never upload time", async () => {
    const { client, rawReports } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-03-05T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.11", port: "3389", protocol: "tcp" },
      { timestamp: "2026-02-01T00:00:00Z", ip: "203.0.113.12", port: "3389", protocol: "tcp" },
    ]);

    const before = new Date();
    await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    const stored = [...rawReports.values()][0];
    expect(stored.observationDate).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(stored.observationDate.getTime()).toBeLessThan(before.getTime());
  });
});

describe("ingestAccessibleRdpReport — partially valid report", () => {
  it("persists invalid rows as evidence without creating Findings, reports PARTIALLY_VALID", async () => {
    const { client, rawReportRows, findings } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-01T00:05:00Z", ip: "not-an-ip", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-01T00:10:00Z", ip: "203.0.113.11", port: "99999", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.report.status).toBe("PARTIALLY_VALID");
    expect(result.report.validRows).toBe(1);
    expect(result.report.invalidRows).toBe(2);

    // Invalid rows never spawn a Finding — exactly one valid identity here.
    expect(findings.size).toBe(1);

    const invalidStored = [...rawReportRows.values()].filter((r) => r.status === "INVALID");
    expect(invalidStored).toHaveLength(2);
    invalidStored.forEach((row) => {
      expect(row.findingOccurrenceId).toBeNull();
      expect(Array.isArray(row.validationErrors)).toBe(true);
      expect(row.validationErrors.length).toBeGreaterThan(0);
    });
  });
});

describe("ingestAccessibleRdpReport — zero-valid-row behavior", () => {
  it("returns UNPROCESSABLE_NO_VALID_ROWS and creates no RawReport when every row is invalid", async () => {
    const { client, rawReports, findings } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "not-an-ip", port: "3389", protocol: "tcp" },
      { timestamp: "not-a-date", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.UNPROCESSABLE_NO_VALID_ROWS);
    expect(result.report).toBeNull();
    expect(rawReports.size).toBe(0);
    expect(findings.size).toBe(0);
  });

  it("returns REJECTED (not UNPROCESSABLE) for a structurally broken upload, and creates no RawReport", async () => {
    const { client, rawReports } = createFakeClient();
    const fileBytes = Buffer.from("timestamp,ip,port\n2026-01-01T00:00:00Z,1.2.3.4,80\n", "utf8");

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.REJECTED);
    expect(result.reason).toBe("MISSING_REQUIRED_HEADERS");
    expect(rawReports.size).toBe(0);
  });
});

describe("ingestAccessibleRdpReport — trusted-source validation (P1-T6a)", () => {
  it("runs before structural parsing and any database access: an invalid tuple never touches the parser or the client", async () => {
    const { client, rawReports, rawReportRows, findings, occurrences } = createFakeClient();
    // Deliberately malformed CSV bytes (would fail structural parsing too) —
    // if source validation ran after parsing, this would surface as a parser
    // rejection code instead of the source-validation one.
    const fileBytes = Buffer.from("not,even,a,valid,header\n", "utf8");

    const result = await ingestAccessibleRdpReport(
      { fileBytes, ...baseUpload({ source: "SHADOWSERVER" }) },
      { client }
    );

    expect(result.outcome).toBe(INGESTION_OUTCOMES.REJECTED);
    expect(result.reason).toBe("UNTRUSTED_SOURCE_REPORT_COMBINATION");
    expect(client.rawReport.findUnique).not.toHaveBeenCalled();
    expect(client.rawReport.create).not.toHaveBeenCalled();
    expect(rawReports.size).toBe(0);
    expect(rawReportRows.size).toBe(0);
    expect(findings.size).toBe(0);
    expect(occurrences.size).toBe(0);
  });

  it("creates no RawReport for an untrusted tuple, even with an otherwise fully valid CSV", async () => {
    const { client, rawReports } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport(
      { fileBytes, ...baseUpload({ source: "UNKNOWN_SOURCE" }) },
      { client }
    );

    expect(result.outcome).toBe(INGESTION_OUTCOMES.REJECTED);
    expect(result.report).toBeNull();
    expect(rawReports.size).toBe(0);
  });

  it("creates no RawReportRow for an untrusted tuple", async () => {
    const { client, rawReportRows } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
    ]);

    await ingestAccessibleRdpReport({ fileBytes, ...baseUpload({ source: "UNKNOWN_SOURCE" }) }, { client });

    expect(rawReportRows.size).toBe(0);
  });

  it("creates no Finding or FindingOccurrence for an untrusted tuple", async () => {
    const { client, findings, occurrences } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
    ]);

    await ingestAccessibleRdpReport({ fileBytes, ...baseUpload({ source: "UNKNOWN_SOURCE" }) }, { client });

    expect(findings.size).toBe(0);
    expect(occurrences.size).toBe(0);
  });

  it("emits exactly one safe aggregate rejection audit event, never one per row", async () => {
    const { client, auditLogs } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-01T00:05:00Z", ip: "203.0.113.11", port: "3389", protocol: "tcp" },
    ]);

    await ingestAccessibleRdpReport({ fileBytes, ...baseUpload({ source: "UNKNOWN_SOURCE" }) }, { client });

    const rejections = auditLogs.filter((e) => e.action === "report.ingestion.rejected");
    expect(rejections).toHaveLength(1);
    expect(rejections[0].after.reasonCode).toBe("UNTRUSTED_SOURCE_REPORT_COMBINATION");
    expect(rejections[0].after.requestedReportType).toBe("ACCESSIBLE_RDP");
    expect(rejections[0].after.requestedSchemaVersion).toBe("accessible-rdp.synthetic.v1");
    expect(rejections[0].after.source).toBe("UNKNOWN_SOURCE");
    // No raw bytes, no CSV rows, anywhere in the audit payload.
    const serialized = JSON.stringify(rejections[0]);
    expect(serialized).not.toContain("203.0.113.10");
  });

  it("a valid tuple changes nothing about existing P1-T5 ingestion behavior", async () => {
    const { client, rawReports, rawReportRows, findings, occurrences } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport(
      { fileBytes, ...baseUpload({ source: REPORT_SOURCES.SYNTHETIC_UPLOAD }) },
      { client }
    );

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.report.status).toBe("COMPLETED");
    expect(rawReports.size).toBe(1);
    expect(rawReportRows.size).toBe(1);
    expect(findings.size).toBe(1);
    expect(occurrences.size).toBe(1);
  });

  it("requires the caller to pass an explicit source — never an implicit default", async () => {
    const { client } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
    ]);
    const { source, ...uploadWithoutSource } = baseUpload();

    await expect(
      ingestAccessibleRdpReport({ fileBytes, ...uploadWithoutSource }, { client })
    ).rejects.toThrow(TypeError);
    await expect(
      ingestAccessibleRdpReport({ fileBytes, ...uploadWithoutSource, source: "" }, { client })
    ).rejects.toThrow(TypeError);
  });
});

describe("ingestAccessibleRdpReport — within-report duplicates", () => {
  it("groups rows sharing an identity into one occurrence, canonical row uses MAX observedAt independent of CSV order", async () => {
    const { client, rawReportRows, findings, occurrences } = createFakeClient();
    // Deliberately out of timestamp order: middle, earliest, latest.
    const fileBytes = buildCsv([
      { timestamp: "2026-01-10T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-20T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(findings.size).toBe(1);
    expect(occurrences.size).toBe(1);

    const finding = [...findings.values()][0];
    expect(finding.lastSeen).toEqual(new Date("2026-01-20T00:00:00.000Z"));
    expect(finding.occurrenceCount).toBe(1);

    const rows = [...rawReportRows.values()].sort((a, b) => a.rowNumber - b.rowNumber);
    expect(rows).toHaveLength(3);
    // Row 3 (2026-01-20, the max) is canonical; rows 1 and 2 are duplicates.
    expect(rows[0].duplicateInReport).toBe(true);
    expect(rows[1].duplicateInReport).toBe(true);
    expect(rows[2].duplicateInReport).toBe(false);
    // All three link to the same single occurrence.
    const occurrenceIds = new Set(rows.map((r) => r.findingOccurrenceId));
    expect(occurrenceIds.size).toBe(1);
  });

  it("does not increment occurrenceCount once per duplicate row", async () => {
    const { client, findings } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-02T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-03T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-04T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
    ]);

    await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect([...findings.values()][0].occurrenceCount).toBe(1);
  });
});

describe("ingestAccessibleRdpReport — duplicate/retry classification", () => {
  it("a completed duplicate upload is an idempotent no-op: no new rows, findings or occurrences", async () => {
    const { client, rawReports, rawReportRows, findings, occurrences } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
    ]);

    const first = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });
    expect(first.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);

    const rowCountAfterFirst = rawReportRows.size;
    const findingCountAfterFirst = findings.size;
    const occurrenceCountAfterFirst = occurrences.size;

    const second = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(second.outcome).toBe(INGESTION_OUTCOMES.DUPLICATE_COMPLETED);
    expect(second.report.id).toBe(first.report.id);
    expect(rawReports.size).toBe(1);
    expect(rawReportRows.size).toBe(rowCountAfterFirst);
    expect(findings.size).toBe(findingCountAfterFirst);
    expect(occurrences.size).toBe(occurrenceCountAfterFirst);
  });

  it("a currently PROCESSING duplicate is not retried", async () => {
    const { client, rawReports, auditLogs } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
    ]);

    rawReports.set(1, {
      id: 1,
      reportType: "ACCESSIBLE_RDP",
      schemaVersion: "accessible-rdp.synthetic.v1",
      sourceFileName: "in-flight.csv",
      sourceFileSha256: require("../../src/services/ingestion/reportIdentityService").computeSourceFileSha256(
        fileBytes
      ),
      status: "PROCESSING",
      processingAttempts: 1,
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
    });

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.DUPLICATE_IN_PROGRESS);
    expect(rawReports.get(1).processingAttempts).toBe(1); // untouched
    expect(auditLogs.filter((e) => e.action === "report.ingestion.started")).toHaveLength(0);
  });

  it.each(["FAILED", "RECEIVED"])(
    "a retryable %s report is reused (not duplicated) and reprocessed to completion",
    async (seedStatus) => {
      const { client, rawReports, rawReportRows, findings } = createFakeClient();
      const fileBytes = buildCsv([
        { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
      ]);
      const sha256 =
        require("../../src/services/ingestion/reportIdentityService").computeSourceFileSha256(fileBytes);

      rawReports.set(1, {
        id: 1,
        reportType: "ACCESSIBLE_RDP",
        schemaVersion: "accessible-rdp.synthetic.v1",
        sourceFileName: "retry-me.csv",
        sourceFileSha256: sha256,
        status: seedStatus,
        processingAttempts: seedStatus === "FAILED" ? 1 : 0,
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
        errorSummary: seedStatus === "FAILED" ? { code: "PROCESSING_ERROR" } : null,
      });

      const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

      expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
      expect(result.report.id).toBe(1);
      expect(rawReports.size).toBe(1); // reused, never a second row
      expect(rawReports.get(1).status).toBe("COMPLETED");
      expect(rawReports.get(1).processingAttempts).toBe(
        seedStatus === "FAILED" ? 2 : 1
      );
      expect(rawReportRows.size).toBe(1);
      expect(findings.size).toBe(1);
    }
  );
});

describe("ingestAccessibleRdpReport — row-evidence idempotency and integrity", () => {
  it("an interrupted attempt's already-persisted matching row is reused, not recreated", async () => {
    const { client, rawReports, rawReportRows } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-01T00:05:00Z", ip: "203.0.113.11", port: "3389", protocol: "tcp" },
    ]);
    const sha256 =
      require("../../src/services/ingestion/reportIdentityService").computeSourceFileSha256(fileBytes);

    rawReports.set(1, {
      id: 1,
      reportType: "ACCESSIBLE_RDP",
      schemaVersion: "accessible-rdp.synthetic.v1",
      sourceFileName: "interrupted.csv",
      sourceFileSha256: sha256,
      status: "FAILED",
      processingAttempts: 1,
      totalRows: 2,
      validRows: 2,
      invalidRows: 0,
    });
    // Row 1 already exists from the interrupted attempt, matching what a
    // fresh parse of these exact bytes produces — buildCsv/csvRow always
    // emit all 8 columns, so the trailing optional ones are "" (present),
    // not absent, and must match exactly for this to count as the same
    // evidence. Seeded id is deliberately out of range of the fake store's
    // own auto-increment counter (which starts at 1), so the row this test
    // expects to be newly created for rowNumber 2 can never collide with it.
    rawReportRows.set(9001, {
      id: 9001,
      rawReportId: 1,
      rowNumber: 1,
      rawPayload: {
        timestamp: "2026-01-01T00:00:00Z",
        ip: "203.0.113.10",
        port: "3389",
        protocol: "tcp",
        hostname: "",
        asn: "",
        as_name: "",
        country_code: "",
      },
      normalizedPayload: {
        timestamp: "2026-01-01T00:00:00.000Z",
        ip: "203.0.113.10",
        port: 3389,
        protocol: "TCP",
        hostname: null,
        asn: null,
        asName: null,
        countryCode: null,
      },
      status: "VALID",
      validationErrors: null,
      duplicateInReport: false,
      findingOccurrenceId: null, // not yet linked — simulating a crash before the group finished
    });

    const createSpy = client.rawReportRow.create;
    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(rawReportRows.size).toBe(2); // row 1 reused, row 2 newly created
    // Only row 2 went through rawReportRow.create — row 1 (id 1) is untouched
    // in the store because persistRowIdempotently found and reused it.
    const createdRowNumbers = createSpy.mock.calls.map((call) => call[0].data.rowNumber);
    expect(createdRowNumbers).toEqual([2]);
  });

  it("conflicting existing row evidence fails closed: report goes FAILED, no lifecycle mutation", async () => {
    const { client, rawReports, rawReportRows, findings, auditLogs } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
    ]);
    const sha256 =
      require("../../src/services/ingestion/reportIdentityService").computeSourceFileSha256(fileBytes);

    rawReports.set(1, {
      id: 1,
      reportType: "ACCESSIBLE_RDP",
      schemaVersion: "accessible-rdp.synthetic.v1",
      sourceFileName: "conflict.csv",
      sourceFileSha256: sha256,
      status: "FAILED",
      processingAttempts: 1,
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
    });
    // Row 1 exists but with DIFFERENT content than this parse will produce —
    // an impossible state for genuinely identical bytes, and exactly the
    // integrity conflict the orchestrator must fail closed on.
    rawReportRows.set(1, {
      id: 1,
      rawReportId: 1,
      rowNumber: 1,
      rawPayload: { timestamp: "2026-01-01T00:00:00Z", ip: "198.51.100.99", port: "22", protocol: "tcp" },
      normalizedPayload: null,
      status: "VALID",
      validationErrors: null,
      duplicateInReport: false,
      findingOccurrenceId: 999,
    });

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.FAILED);
    expect(rawReports.get(1).status).toBe("FAILED");
    expect(rawReports.get(1).errorSummary.code).toBe("ROW_EVIDENCE_INTEGRITY_CONFLICT");
    expect(findings.size).toBe(0);

    const failedAudit = auditLogs.filter((e) => e.action === "report.ingestion.failed");
    expect(failedAudit).toHaveLength(1);
  });
});

describe("ingestAccessibleRdpReport — P1-T4 system failures", () => {
  it("a dedup-service failure marks the report FAILED, not an invalid row", async () => {
    const { client, rawReports, findings, rawReportRows } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.99", port: "3389", protocol: "tcp" },
    ]);

    client.finding.create.mockImplementationOnce(async () => {
      const error = new Error("simulated exhausted concurrency retry");
      // Deliberately no .code — dedupService's retry policy must not retry
      // this, and the orchestrator must not treat it as row-invalid.
      throw error;
    });

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.FAILED);
    expect(rawReports.get(1).status).toBe("FAILED");
    expect(rawReports.get(1).errorSummary.code).toBe("PROCESSING_ERROR");
    expect(findings.size).toBe(0);
    // The row was never persisted as VALID with a fabricated failure.
    expect(rawReportRows.size).toBe(0);
  });
});

describe("ingestAccessibleRdpReport — finding.reopened audit", () => {
  it("emits finding.reopened for an actual RECURRED result", async () => {
    const { client, findings, auditLogs } = createFakeClient();
    const seedBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.50", port: "3389", protocol: "tcp" },
    ]);
    const seedResult = await ingestAccessibleRdpReport(
      { fileBytes: seedBytes, ...baseUpload({ sourceFileName: "day-1.csv" }) },
      { client }
    );
    const findingId = seedResult.findingCounts && [...findings.values()][0].id;

    // Manually close the finding (no close endpoint exists yet in this phase).
    const stored = findings.get(findingId);
    Object.assign(stored, {
      status: "CLOSED",
      closedAt: new Date("2026-01-02T00:00:00Z"),
      closedByUserId: 1,
      closureReason: "remediated",
      closedThroughObservedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const laterBytes = buildCsv([
      { timestamp: "2026-01-10T00:00:00Z", ip: "203.0.113.50", port: "3389", protocol: "tcp" },
    ]);
    const result = await ingestAccessibleRdpReport(
      { fileBytes: laterBytes, ...baseUpload({ sourceFileName: "day-2.csv" }) },
      { client }
    );

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.findingCounts.RECURRED).toBe(1);
    expect(findings.get(findingId).status).toBe("OPEN");

    const reopened = auditLogs.filter((e) => e.action === "finding.reopened");
    expect(reopened).toHaveLength(1);
    expect(reopened[0].entityId).toBe(String(findingId));
    expect(reopened[0].after.status).toBe("OPEN");
  });

  it("does not emit finding.reopened for PERSISTED or CREATED actions", async () => {
    const { client, auditLogs } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.60", port: "3389", protocol: "tcp" },
    ]);

    await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(auditLogs.filter((e) => e.action === "finding.reopened")).toHaveLength(0);
  });
});

describe("ingestAccessibleRdpReport — evidence safety", () => {
  it("never includes raw bytes or full row payloads in audit output", async () => {
    const marker = "SUPER-SECRET-CSV-MARKER-VALUE";
    const { client, auditLogs } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp", as_name: marker },
    ]);

    await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    const serialized = JSON.stringify(auditLogs);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("rawContent");
  });

  it("never includes raw bytes in the FAILED error summary", async () => {
    const marker = "SUPER-SECRET-FAILURE-MARKER";
    const { client, rawReports } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.70", port: "3389", protocol: "tcp", as_name: marker },
    ]);

    client.finding.create.mockImplementationOnce(async () => {
      throw new Error(`failure mentioning ${marker}`);
    });

    await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    const summary = JSON.stringify(rawReports.get(1).errorSummary);
    expect(summary).not.toContain(marker);
  });
});

describe("ingestAccessibleRdpReport — input validation", () => {
  it("throws a controlled programmer error for a malformed input contract", async () => {
    const { client } = createFakeClient();
    await expect(ingestAccessibleRdpReport(null, { client })).rejects.toThrow(TypeError);
    await expect(
      ingestAccessibleRdpReport({ fileBytes: "not a buffer", ...baseUpload() }, { client })
    ).rejects.toThrow(TypeError);
    await expect(
      ingestAccessibleRdpReport({ fileBytes: Buffer.alloc(0), sourceFileName: "" }, { client })
    ).rejects.toThrow(TypeError);
  });
});

describe("ingestAccessibleRdpReport — ownership-resolution failure isolation (P2-H1)", () => {
  // findingOwnershipService.resolveOneFinding opens its own transaction AFTER
  // recordFindingObservation's own transaction has already committed (see
  // reportIngestionService.js's module-level note above
  // resolveOwnershipSafely). These tests inject a failure at that later,
  // already-committed point and prove it is fully isolated: ingestion still
  // succeeds, every already-written row survives untouched, no partial
  // FindingOwnership row is created, and the failure is auditable without
  // leaking the raw underlying error text.
  const RAW_DB_ERROR_TEXT = "FATAL: connection to ownership replica 10.99.0.1 terminated unexpectedly";

  function withFailingOwnershipStore(client) {
    client.findingOwnership = {
      findUnique: vi.fn(async () => {
        throw new Error(RAW_DB_ERROR_TEXT);
      }),
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(async () => []),
    };
    return client;
  }

  it("a fully valid report still completes and links its row when ownership resolution fails after the lifecycle transaction commits", async () => {
    const { client, rawReports, rawReportRows, findings, occurrences, auditLogs } = createFakeClient();
    withFailingOwnershipStore(client);
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.80", port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.report.status).toBe("COMPLETED");

    expect(rawReports.size).toBe(1);
    expect(findings.size).toBe(1);
    expect(occurrences.size).toBe(1);

    const [row] = [...rawReportRows.values()];
    expect(row.status).toBe("VALID");
    expect(row.findingOccurrenceId).not.toBeNull();

    // No FindingOwnership history was partially written.
    expect(client.findingOwnership.create).not.toHaveBeenCalled();

    // The failure is auditable via the designed safe path...
    const ownershipFailures = auditLogs.filter((e) => e.action === "ownership.resolution.failed");
    expect(ownershipFailures).toHaveLength(1);
    expect(ownershipFailures[0].outcome).toBe("FAILURE");

    // ...but never carries the raw underlying database error text.
    const serialized = JSON.stringify(auditLogs);
    expect(serialized).not.toContain(RAW_DB_ERROR_TEXT);

    // The report-level outcome is unaffected: ingestion still reports its own
    // success terminal event, not a report-level failure.
    expect(auditLogs.filter((e) => e.action === "report.ingestion.completed")).toHaveLength(1);
    expect(auditLogs.filter((e) => e.action === "report.ingestion.failed")).toHaveLength(0);
  });

  it("a partially valid report still reaches PARTIALLY_VALID (not FAILED) when ownership resolution fails on the valid row's group", async () => {
    const { client, rawReports, rawReportRows, findings, auditLogs } = createFakeClient();
    withFailingOwnershipStore(client);
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.81", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-01T00:05:00Z", ip: "not-an-ip", port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.report.status).toBe("PARTIALLY_VALID");
    expect(result.report.validRows).toBe(1);
    expect(result.report.invalidRows).toBe(1);

    expect(rawReports.get(1).status).toBe("PARTIALLY_VALID");
    expect(findings.size).toBe(1);

    // The ownership failure never reclassifies the valid row as INVALID.
    const validRow = [...rawReportRows.values()].find((r) => r.status === "VALID");
    expect(validRow).toBeDefined();
    expect(validRow.findingOccurrenceId).not.toBeNull();
    const invalidRow = [...rawReportRows.values()].find((r) => r.status === "INVALID");
    expect(invalidRow).toBeDefined();

    expect(client.findingOwnership.create).not.toHaveBeenCalled();
    expect(auditLogs.filter((e) => e.action === "ownership.resolution.failed")).toHaveLength(1);
    const serialized = JSON.stringify(auditLogs);
    expect(serialized).not.toContain(RAW_DB_ERROR_TEXT);
  });
});

describe("ingestAccessibleRdpReport — IOC enrichment scheduling (P2-T2e-2)", () => {
  const MAX_AGE_IN_DAYS = 90; // env.ABUSEIPDB_MAX_AGE_DAYS default (abuseIpdbConfig.js)

  function cacheKeyFor(indicator) {
    return buildEnrichmentCacheIdentity({
      provider: "abuseipdb",
      indicatorType: "IPV4",
      indicator,
      queryParams: { maxAgeInDays: MAX_AGE_IN_DAYS },
    }).cacheKey;
  }

  it("schedules exactly one job for one distinct Finding, never once per duplicate CSV row", async () => {
    const { client, iocEnrichments, auditLogs } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.90", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-01T00:05:00Z", ip: "203.0.113.90", port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(iocEnrichments.size).toBe(1);
    const [job] = [...iocEnrichments.values()];
    expect(job.provider).toBe("abuseipdb");
    expect(job.indicator).toBe("203.0.113.90");
    expect(job.status).toBe("PENDING");

    const completed = auditLogs.filter((e) => e.action === "enrichment.ingestion.schedule.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].after.distinctFindingCount).toBe(1);
    expect(completed[0].after.scheduledCount).toBe(1);
    expect(completed[0].after.provider).toBe("abuseipdb");
  });

  it("schedules two jobs for two distinct Findings in one report", async () => {
    const { client, iocEnrichments } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.91", port: "3389", protocol: "tcp" },
      { timestamp: "2026-01-01T00:05:00Z", ip: "203.0.113.92", port: "3389", protocol: "tcp" },
    ]);

    await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(iocEnrichments.size).toBe(2);
  });

  it("counts a fresh cached terminal result as CACHE_HIT and creates no new job", async () => {
    const { client, iocEnrichments, auditLogs } = createFakeClient();
    const indicator = "203.0.113.93";
    iocEnrichments.set(1, {
      id: 1,
      provider: "abuseipdb",
      indicatorType: "IPV4",
      indicator,
      cacheKey: cacheKeyFor(indicator),
      status: "SUCCESS",
      queriedAt: new Date(Date.now() - 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      activeCacheKey: null,
    });
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: indicator, port: "3389", protocol: "tcp" },
    ]);

    await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(iocEnrichments.size).toBe(1);
    const completed = auditLogs.filter((e) => e.action === "enrichment.ingestion.schedule.completed");
    expect(completed[0].after.cacheHitCount).toBe(1);
    expect(completed[0].after.scheduledCount).toBe(0);
  });

  it("counts an existing active PENDING job as ALREADY_PENDING and creates no second job", async () => {
    const { client, iocEnrichments, auditLogs } = createFakeClient();
    const indicator = "203.0.113.94";
    const cacheKey = cacheKeyFor(indicator);
    iocEnrichments.set(1, {
      id: 1,
      provider: "abuseipdb",
      indicatorType: "IPV4",
      indicator,
      cacheKey,
      status: "PENDING",
      queriedAt: null,
      expiresAt: null,
      activeCacheKey: cacheKey,
    });
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: indicator, port: "3389", protocol: "tcp" },
    ]);

    await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(iocEnrichments.size).toBe(1);
    const completed = auditLogs.filter((e) => e.action === "enrichment.ingestion.schedule.completed");
    expect(completed[0].after.alreadyPendingCount).toBe(1);
    expect(completed[0].after.scheduledCount).toBe(0);
  });

  it("swallows a scheduling failure safely: the report still completes and no external call is made", async () => {
    const { client, rawReports, findings, auditLogs } = createFakeClient();
    const RAW_DB_ERROR_TEXT = "FATAL: connection to enrichment replica 10.99.0.2 terminated unexpectedly";
    client.iocEnrichment.create = vi.fn(async () => {
      throw new Error(RAW_DB_ERROR_TEXT);
    });
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.95", port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.report.status).toBe("COMPLETED");
    expect(rawReports.size).toBe(1);
    expect(findings.size).toBe(1);

    const completed = auditLogs.filter((e) => e.action === "enrichment.ingestion.schedule.completed");
    expect(completed[0].after.failedCount).toBe(1);
    expect(completed[0].after.scheduledCount).toBe(0);

    const serialized = JSON.stringify(auditLogs);
    expect(serialized).not.toContain(RAW_DB_ERROR_TEXT);
  });

  it("a fully idempotent duplicate-file upload creates no new enrichment work", async () => {
    const { client, iocEnrichments } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.96", port: "3389", protocol: "tcp" },
    ]);

    const first = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });
    expect(first.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(iocEnrichments.size).toBe(1);

    const second = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });
    expect(second.outcome).toBe(INGESTION_OUTCOMES.DUPLICATE_COMPLETED);
    expect(iocEnrichments.size).toBe(1);
  });

  it("the aggregate audit payload never carries an indicator, cache key or claim token", async () => {
    const { client, auditLogs } = createFakeClient();
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.97", port: "3389", protocol: "tcp" },
    ]);

    await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    const completed = auditLogs.filter((e) => e.action === "enrichment.ingestion.schedule.completed");
    expect(completed).toHaveLength(1);
    expect(Object.keys(completed[0].after).sort()).toEqual(
      [
        "alreadyPendingCount",
        "cacheHitCount",
        "distinctFindingCount",
        "failedCount",
        "provider",
        "scheduledCount",
        "unsupportedCount",
      ].sort()
    );
    const serialized = JSON.stringify(completed[0]);
    expect(serialized).not.toContain("203.0.113.97");
    expect(serialized).not.toContain("cacheKey");
    expect(serialized).not.toContain("claimToken");
  });

  it("an enrichment audit-write failure does not alter the report result", async () => {
    const { client, rawReports } = createFakeClient();
    const originalCreate = client.auditLog.create;
    client.auditLog.create = vi.fn(async (args) => {
      if (args.data.action === "enrichment.ingestion.schedule.completed") {
        throw new Error("audit sink unreachable");
      }
      return originalCreate(args);
    });
    const fileBytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.98", port: "3389", protocol: "tcp" },
    ]);

    const result = await ingestAccessibleRdpReport({ fileBytes, ...baseUpload() }, { client });

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.report.status).toBe("COMPLETED");
    expect(rawReports.size).toBe(1);
  });
});

describe("RowEvidenceIntegrityError", () => {
  it("is a distinguishable Error subclass carrying no raw evidence in its message", () => {
    const error = new RowEvidenceIntegrityError(1, 5);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RowEvidenceIntegrityError");
    expect(error.message).toMatch(/report 1, row 5/);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — recurrence-driven case reopening, integrated into ingestion
// ---------------------------------------------------------------------------
//
// The hook runs LAST, after every RawReport / RawReportRow / Finding /
// FindingOccurrence write has committed and outside every transaction this
// pipeline opened. The claims defended here are the isolation contract:
// ingestion never depends on the reopen succeeding, and re-processing the same
// report can never reopen a case twice.

const IP_PHASE3 = "203.0.113.70";

/** Seeds one Finding, then closes it so a later report classifies as RECURRED. */
async function seedClosedFinding(client, findings, ip = IP_PHASE3) {
  const seedBytes = buildCsv([
    { timestamp: "2026-01-01T00:00:00Z", ip, port: "3389", protocol: "tcp" },
  ]);
  await ingestAccessibleRdpReport(
    { fileBytes: seedBytes, ...baseUpload({ sourceFileName: "p3-day-1.csv" }) },
    { client }
  );
  const finding = [...findings.values()].find((f) => f.indicatorValue === ip);
  Object.assign(finding, {
    status: "CLOSED",
    closedAt: new Date("2026-01-02T00:00:00Z"),
    closureReason: "remediated",
    closedThroughObservedAt: new Date("2026-01-01T00:00:00Z"),
  });
  return finding;
}

/** Links the Finding into a case closed with the given Phase 3 closure reason. */
function seedLinkedClosedCase(fake, finding, closureReason) {
  const caseId = 900 + fake.cases.size + 1;
  fake.cases.set(caseId, {
    id: caseId,
    title: "Phase 3 case",
    organizationId: 1,
    lifecycleState: "CLOSED",
    closureReason,
    closedAt: new Date("2026-01-02T00:00:00Z"),
    closedByUserId: 7,
    reopenedCount: 0,
    lastReopenedAt: null,
    lastReopenTrigger: null,
  });
  const linkId = 800 + fake.caseFindings.size + 1;
  fake.caseFindings.set(linkId, {
    id: linkId,
    caseId,
    findingId: finding.id,
    state: "LINKED",
    organizationId: 1,
    supersededAt: null,
    currentLinkKey: caseId + ":" + finding.id,
  });
  return caseId;
}

function laterReport(client, name = "p3-day-2.csv", ip = IP_PHASE3) {
  const bytes = buildCsv([
    { timestamp: "2026-01-10T00:00:00Z", ip, port: "3389", protocol: "tcp" },
  ]);
  return ingestAccessibleRdpReport(
    { fileBytes: bytes, ...baseUpload({ sourceFileName: name }) },
    { client }
  );
}

describe("ingestAccessibleRdpReport — Phase 3 recurrence-driven case reopening", () => {
  it("reopens a REMEDIATED-closed case linked to the recurring Finding", async () => {
    const fake = createFakeClient();
    const finding = await seedClosedFinding(fake.client, fake.findings);
    const caseId = seedLinkedClosedCase(fake, finding, "REMEDIATED");

    const result = await laterReport(fake.client);

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.findingCounts.RECURRED).toBe(1);

    const reopened = fake.cases.get(caseId);
    expect(reopened).toMatchObject({
      lifecycleState: "OPEN",
      closureReason: null,
      closedAt: null,
      lastReopenTrigger: "RECURRENCE",
      reopenedCount: 1,
    });

    // The ledger row is keyed by the SPECIFIC occurrence that caused it.
    const ledger = [...fake.recurrenceReopens.values()];
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ caseId, findingId: finding.id, outcome: "REOPENED" });

    const occurrence = [...fake.occurrences.values()].find((o) => o.action === "RECURRED");
    expect(ledger[0].findingOccurrenceId).toBe(occurrence.id);

    // And the lifecycle event that explains it, with no actor: this is a
    // consequence of new evidence, not the uploading analyst's decision.
    const event = fake.caseLifecycleEvents.find((e) => e.eventType === "REOPENED");
    expect(event).toMatchObject({
      caseId,
      fromState: "CLOSED",
      toState: "OPEN",
      reasonCode: "REOPENED_BY_RECURRENCE",
      actorUserId: null,
    });
  });

  it("escalates the recurring Finding when that records a real change", async () => {
    const fake = createFakeClient();
    const finding = await seedClosedFinding(fake.client, fake.findings);
    seedLinkedClosedCase(fake, finding, "REMEDIATED");

    await laterReport(fake.client);

    const triage = [...fake.findingTriages.values()];
    expect(triage).toHaveLength(1);
    expect(triage[0]).toMatchObject({
      findingId: finding.id,
      decision: "ESCALATED",
      source: "RECURRENCE_REOPEN",
    });
  });

  it("never auto-reopens a FALSE_POSITIVE closure, and ledgers the refusal", async () => {
    const fake = createFakeClient();
    const finding = await seedClosedFinding(fake.client, fake.findings);
    const caseId = seedLinkedClosedCase(fake, finding, "FALSE_POSITIVE");

    await laterReport(fake.client);

    expect(fake.cases.get(caseId)).toMatchObject({
      lifecycleState: "CLOSED",
      closureReason: "FALSE_POSITIVE",
      reopenedCount: 0,
    });
    const ledger = [...fake.recurrenceReopens.values()];
    expect(ledger[0].outcome).toBe("SKIPPED_CLOSURE_REASON_NOT_REMEDIATED");
    expect(fake.caseLifecycleEvents.filter((e) => e.eventType === "REOPENED")).toHaveLength(0);
  });

  // Re-uploading the identical file short-circuits as a duplicate long before
  // the reopen hook ever runs, so it cannot reopen a second time.
  it("is idempotent: re-uploading the same report reopens nothing further", async () => {
    const fake = createFakeClient();
    const finding = await seedClosedFinding(fake.client, fake.findings);
    const caseId = seedLinkedClosedCase(fake, finding, "REMEDIATED");

    await laterReport(fake.client);
    // Re-close it so a second reopen would be plainly visible if one happened.
    Object.assign(fake.cases.get(caseId), {
      lifecycleState: "CLOSED",
      closureReason: "REMEDIATED",
    });

    const replay = await laterReport(fake.client);

    expect(replay.outcome).toBe(INGESTION_OUTCOMES.DUPLICATE_COMPLETED);
    expect(fake.cases.get(caseId).lifecycleState).toBe("CLOSED");
    expect(fake.cases.get(caseId).reopenedCount).toBe(1);
    expect([...fake.recurrenceReopens.values()]).toHaveLength(1);
  });

  it("audits the aggregate with counts only — never an indicator", async () => {
    const fake = createFakeClient();
    const finding = await seedClosedFinding(fake.client, fake.findings);
    seedLinkedClosedCase(fake, finding, "REMEDIATED");

    await laterReport(fake.client);

    const [completed] = fake.auditLogs.filter(
      (e) => e.action === "case.recurrence.reopen.completed"
    );
    expect(completed.outcome).toBe("SUCCESS");
    expect(completed.after).toMatchObject({
      evaluatedPairCount: 1,
      reopenedCaseCount: 1,
      failedCount: 0,
    });
    expect(JSON.stringify(completed)).not.toContain(IP_PHASE3);
  });

  // The isolation contract. A total reopen failure must leave a fully valid
  // ingested report with fully valid recurrence evidence and simply no reopen.
  it("never rolls back ingestion or recurrence evidence when reopening fails", async () => {
    const fake = createFakeClient();
    const finding = await seedClosedFinding(fake.client, fake.findings);
    const caseId = seedLinkedClosedCase(fake, finding, "REMEDIATED");

    const leak = 'relation "CaseRecurrenceReopen" does not exist';
    fake.client.caseRecurrenceReopen.create.mockImplementation(async () => {
      throw new Error(leak);
    });

    const result = await laterReport(fake.client);

    // Ingestion completed in full.
    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect(result.findingCounts.RECURRED).toBe(1);
    expect([...fake.rawReports.values()].every((r) => r.status === "COMPLETED")).toBe(true);
    expect(fake.findings.get(finding.id).status).toBe("OPEN");
    expect([...fake.occurrences.values()].some((o) => o.action === "RECURRED")).toBe(true);

    // No ledger row was written, so a later re-run is free to re-evaluate this
    // pair rather than being permanently suppressed by a failed attempt.
    expect([...fake.recurrenceReopens.values()]).toHaveLength(0);
    expect(caseId).toBeGreaterThan(0);
    // NOTE: this fake's $transaction does not roll back (it simply invokes the
    // callback), so the case's own state after a mid-transaction failure is not
    // assertable here. That the whole reopen transaction rolls back as a unit
    // is proven against a real engine in
    // tests/integration/caseWorkflowConcurrency.test.js, and against a
    // rollback-modelling fake in tests/unit/caseRecurrenceReopenService.test.js.

    // The failure is audited, and the raw error text never reaches AuditLog.
    const [failure] = fake.auditLogs.filter((e) => e.action === "case.recurrence.reopen.failed");
    expect(failure.outcome).toBe("FAILURE");
    expect(failure.after.failedCount).toBe(1);
    expect(JSON.stringify(fake.auditLogs)).not.toContain(leak);
  });

  it("survives a Finding that is evidence in no case at all", async () => {
    const fake = createFakeClient();
    await seedClosedFinding(fake.client, fake.findings);

    const result = await laterReport(fake.client);

    expect(result.outcome).toBe(INGESTION_OUTCOMES.PROCESSED);
    expect([...fake.recurrenceReopens.values()]).toHaveLength(0);
    const [completed] = fake.auditLogs.filter(
      (e) => e.action === "case.recurrence.reopen.completed"
    );
    expect(completed.after).toMatchObject({ evaluatedPairCount: 0, reopenedCaseCount: 0 });
  });

  it("runs no reopen processing at all for a report with no recurrence", async () => {
    const fake = createFakeClient();
    const bytes = buildCsv([
      { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.71", port: "3389", protocol: "tcp" },
    ]);

    await ingestAccessibleRdpReport(
      { fileBytes: bytes, ...baseUpload({ sourceFileName: "p3-fresh.csv" }) },
      { client: fake.client }
    );

    expect(fake.auditLogs.filter((e) => e.action.startsWith("case.recurrence.reopen"))).toHaveLength(
      0
    );
  });
});
