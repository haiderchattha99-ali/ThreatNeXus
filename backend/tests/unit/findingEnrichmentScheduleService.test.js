import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// SCOPE NOTE, mirroring reportIngestionService.test.js: unit tests against an
// in-memory fake Prisma client. They prove the manual/forced scheduling
// service's decision logic, audit shape and failure isolation — not
// PostgreSQL concurrency semantics (see
// backend/tests/integration/enrichmentManualScheduling.test.js).

// findingEnrichmentScheduleService requires config/env (for
// ABUSEIPDB_MAX_AGE_DAYS) at import time — same staged-env pattern as
// reportIngestionService.test.js.
let originalEnv;
let scheduleFindingEnrichment;
let FindingEnrichmentNotFoundError;
let FindingEnrichmentValidationError;
let buildEnrichmentCacheIdentity;

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
    require.resolve("../../src/services/enrichment/findingEnrichmentScheduleService"),
  ].forEach((resolved) => delete require.cache[resolved]);

  ({
    scheduleFindingEnrichment,
    FindingEnrichmentNotFoundError,
    FindingEnrichmentValidationError,
  } = require("../../src/services/enrichment/findingEnrichmentScheduleService"));
  ({ buildEnrichmentCacheIdentity } = require("../../src/services/enrichment/enrichmentCacheKey"));
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

function createFakeClient() {
  // Starts well above any manually-seeded fixture id (fixtures use small,
  // fixed ids like 1) so a create() call can never silently overwrite a
  // pre-seeded row sharing the same numeric id.
  let nextId = 1000;
  let nextAuditId = 1;
  const findings = new Map();
  const iocEnrichments = new Map();
  const auditLogs = [];

  const client = {
    finding: {
      async findUnique({ where: { id } }) {
        return findings.has(id) ? { ...findings.get(id) } : null;
      },
    },
    iocEnrichment: {
      async findFirst({ where }) {
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
      },
      async findUnique({ where }) {
        if (where.activeCacheKey !== undefined) {
          return [...iocEnrichments.values()].find((r) => r.activeCacheKey === where.activeCacheKey) || null;
        }
        if (where.id !== undefined) return iocEnrichments.get(where.id) || null;
        return null;
      },
      async create({ data }) {
        if (data.activeCacheKey !== null && data.activeCacheKey !== undefined) {
          const exists = [...iocEnrichments.values()].some((r) => r.activeCacheKey === data.activeCacheKey);
          if (exists) throw prismaError("P2002", "Unique constraint failed on activeCacheKey");
        }
        const row = { id: nextId++, createdAt: new Date(), updatedAt: new Date(), ...data };
        iocEnrichments.set(row.id, row);
        return { ...row };
      },
    },
    auditLog: {
      async create({ data }) {
        const row = { id: nextAuditId++, occurredAt: new Date(), ...data };
        auditLogs.push(row);
        return row;
      },
    },
  };

  return { client, findings, iocEnrichments, auditLogs };
}

function seedFinding(findings, { id = 1, indicatorValue = "203.0.113.30" } = {}) {
  findings.set(id, { id, indicatorValue });
  return id;
}

function cacheKeyFor(indicator, maxAgeInDays = 90) {
  return buildEnrichmentCacheIdentity({
    provider: "abuseipdb",
    indicatorType: "IPV4",
    indicator,
    queryParams: { maxAgeInDays },
  }).cacheKey;
}

const NOW = new Date("2026-02-01T00:00:00Z");

describe("scheduleFindingEnrichment — normal (force=false)", () => {
  it("returns CACHE_HIT for a fresh terminal result", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);
    iocEnrichments.set(1, {
      id: 1,
      provider: "abuseipdb",
      indicatorType: "IPV4",
      indicator: "203.0.113.30",
      cacheKey: cacheKeyFor("203.0.113.30"),
      status: "SUCCESS",
      queriedAt: new Date("2026-01-31T00:00:00Z"),
      expiresAt: new Date("2026-02-02T00:00:00Z"),
      activeCacheKey: null,
    });

    const outcome = await scheduleFindingEnrichment(id, { client, now: NOW });
    expect(outcome.outcome).toBe("CACHE_HIT");
  });

  it("returns ALREADY_PENDING when an active job already exists", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);
    const cacheKey = cacheKeyFor("203.0.113.30");
    iocEnrichments.set(1, {
      id: 1,
      provider: "abuseipdb",
      indicatorType: "IPV4",
      indicator: "203.0.113.30",
      cacheKey,
      status: "PENDING",
      activeCacheKey: cacheKey,
    });

    const outcome = await scheduleFindingEnrichment(id, { client, now: NOW });
    expect(outcome.outcome).toBe("ALREADY_PENDING");
  });

  it("returns SCHEDULED for a first-time request", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);

    const outcome = await scheduleFindingEnrichment(id, { client, now: NOW });
    expect(outcome.outcome).toBe("SCHEDULED");
    expect(iocEnrichments.size).toBe(1);
  });

  it("throws FindingEnrichmentNotFoundError for an unknown Finding", async () => {
    const { client } = createFakeClient();
    await expect(scheduleFindingEnrichment(999, { client, now: NOW })).rejects.toBeInstanceOf(
      FindingEnrichmentNotFoundError
    );
  });
});

describe("scheduleFindingEnrichment — forced (force=true)", () => {
  it("requires a non-empty justification", async () => {
    const { client, findings } = createFakeClient();
    const id = seedFinding(findings);
    await expect(
      scheduleFindingEnrichment(id, { client, now: NOW, force: true })
    ).rejects.toBeInstanceOf(FindingEnrichmentValidationError);
    await expect(
      scheduleFindingEnrichment(id, { client, now: NOW, force: true, justification: "   " })
    ).rejects.toBeInstanceOf(FindingEnrichmentValidationError);
  });

  it("bypasses a fresh terminal cache and schedules a new attempt", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);
    iocEnrichments.set(1, {
      id: 1,
      provider: "abuseipdb",
      indicatorType: "IPV4",
      indicator: "203.0.113.30",
      cacheKey: cacheKeyFor("203.0.113.30"),
      status: "SUCCESS",
      queriedAt: new Date("2026-01-31T00:00:00Z"),
      expiresAt: new Date("2026-02-02T00:00:00Z"),
      activeCacheKey: null,
    });

    const outcome = await scheduleFindingEnrichment(id, {
      client,
      now: NOW,
      force: true,
      justification: "Analyst suspects the indicator's reputation has changed.",
    });

    expect(outcome.outcome).toBe("SCHEDULED");
    expect(iocEnrichments.size).toBe(2);
    // The prior terminal row is untouched — history is preserved.
    expect(iocEnrichments.get(1).status).toBe("SUCCESS");
    expect(iocEnrichments.get(1).abuseConfidenceScore).toBeUndefined();
  });

  it("does not bypass active-job uniqueness: an active PENDING job still returns ALREADY_PENDING", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);
    const cacheKey = cacheKeyFor("203.0.113.30");
    iocEnrichments.set(1, {
      id: 1,
      provider: "abuseipdb",
      indicatorType: "IPV4",
      indicator: "203.0.113.30",
      cacheKey,
      status: "PENDING",
      activeCacheKey: cacheKey,
    });

    const outcome = await scheduleFindingEnrichment(id, {
      client,
      now: NOW,
      force: true,
      justification: "Re-check requested by analyst.",
    });

    expect(outcome.outcome).toBe("ALREADY_PENDING");
    expect(iocEnrichments.size).toBe(1);
  });
});

describe("scheduleFindingEnrichment — audit behavior", () => {
  it("audits requested + completed, with actor attribution via auditContext and a bounded justification preview", async () => {
    const { client, findings, auditLogs } = createFakeClient();
    const id = seedFinding(findings);
    const longJustification = "x".repeat(500);

    await scheduleFindingEnrichment(id, {
      client,
      now: NOW,
      force: true,
      justification: longJustification,
      auditContext: { actorUserId: "7", actorEmail: "analyst@example.com", actorRole: "ANALYST" },
    });

    const requested = auditLogs.filter((e) => e.action === "enrichment.manual.schedule.requested");
    const completed = auditLogs.filter((e) => e.action === "enrichment.manual.schedule.completed");
    expect(requested).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0].actorUserId).toBe("7");
    expect(completed[0].after.force).toBe(true);
    expect(completed[0].after.outcome).toBe("SCHEDULED");
    expect(completed[0].after.justification.length).toBeLessThanOrEqual(201);
    // Never the indicator, cache key or claim token.
    const serialized = JSON.stringify([requested, completed]);
    expect(serialized).not.toContain("203.0.113.30");
    expect(serialized).not.toContain("cacheKey");
    expect(serialized).not.toContain("claimToken");
  });

  it("audits .failed and re-throws on a genuine scheduling failure, without leaking the raw error", async () => {
    const { client, findings, auditLogs } = createFakeClient();
    const id = seedFinding(findings);
    const RAW_DB_ERROR_TEXT = "FATAL: connection to enrichment replica 10.99.0.3 terminated unexpectedly";
    client.iocEnrichment.create = vi.fn(async () => {
      throw new Error(RAW_DB_ERROR_TEXT);
    });

    await expect(scheduleFindingEnrichment(id, { client, now: NOW })).rejects.toThrow();

    const failed = auditLogs.filter((e) => e.action === "enrichment.manual.schedule.failed");
    expect(failed).toHaveLength(1);
    const serialized = JSON.stringify(auditLogs);
    expect(serialized).not.toContain(RAW_DB_ERROR_TEXT);
  });

  it("a broken audit sink does not prevent a successfully scheduled job from persisting", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);
    client.auditLog.create = vi.fn(async () => {
      throw new Error("audit sink unreachable");
    });

    const outcome = await scheduleFindingEnrichment(id, { client, now: NOW });
    expect(outcome.outcome).toBe("SCHEDULED");
    expect(iocEnrichments.size).toBe(1);
  });
});
