import { describe, it, expect } from "vitest";

// SCOPE NOTE, mirroring findingOwnershipService.test.js: unit tests against
// an in-memory fake Prisma client. They prove the read service's decision
// logic (current/activeJob/history selection, freshness, ordering,
// pagination, serialization) — not PostgreSQL semantics.

const {
  FindingEnrichmentNotFoundError,
  FindingEnrichmentValidationError,
  getFindingEnrichmentContext,
  serializeEnrichmentRecord,
} = require("../../src/services/enrichment/findingEnrichmentReadService");

function createFakeClient() {
  const findings = new Map();
  const iocEnrichments = new Map();

  function matches(row, where = {}) {
    return Object.entries(where).every(([key, condition]) => {
      if (condition && typeof condition === "object" && !Array.isArray(condition)) {
        if ("in" in condition) return condition.in.includes(row[key]);
        if ("not" in condition) return row[key] !== condition.not;
        if ("gt" in condition) return row[key] instanceof Date && row[key].getTime() > condition.gt.getTime();
        return true;
      }
      return row[key] === condition;
    });
  }

  function sortRows(rows, orderBy) {
    return [...rows].sort((a, b) => {
      for (const clause of orderBy) {
        const [field, dir] = Object.entries(clause)[0];
        const av = a[field] instanceof Date ? a[field].getTime() : a[field] ?? -Infinity;
        const bv = b[field] instanceof Date ? b[field].getTime() : b[field] ?? -Infinity;
        if (av !== bv) return dir === "desc" ? bv - av : av - bv;
      }
      return 0;
    });
  }

  const client = {
    finding: {
      async findUnique({ where: { id } }) {
        return findings.has(id) ? { ...findings.get(id) } : null;
      },
    },
    iocEnrichment: {
      async findMany({ where = {}, orderBy = [], skip = 0, take } = {}) {
        const rows = sortRows([...iocEnrichments.values()].filter((r) => matches(r, where)), orderBy);
        return rows.slice(skip, take ? skip + take : undefined).map((r) => ({ ...r }));
      },
      async count({ where = {} } = {}) {
        return [...iocEnrichments.values()].filter((r) => matches(r, where)).length;
      },
    },
  };

  return { client, findings, iocEnrichments };
}

function seedFinding(findings, { id = 1, indicatorValue = "203.0.113.10" } = {}) {
  findings.set(id, { id, indicatorValue, port: 3389, protocol: "TCP", reportType: "ACCESSIBLE_RDP" });
  return id;
}

function seedRow(iocEnrichments, overrides = {}) {
  const id = overrides.id ?? iocEnrichments.size + 1;
  const row = {
    id,
    provider: "abuseipdb",
    indicatorType: "IPV4",
    indicator: "203.0.113.10",
    cacheKey: `key-${id}`,
    queryParamsHash: `hash-${id}`,
    activeCacheKey: null,
    claimToken: null,
    claimedAt: null,
    leaseExpiresAt: null,
    status: "PENDING",
    requestedAt: new Date("2026-01-01T00:00:00Z"),
    queriedAt: null,
    expiresAt: null,
    abuseConfidenceScore: null,
    totalReports: null,
    countryCode: null,
    isp: null,
    domain: null,
    usageType: null,
    isWhitelisted: null,
    lastReportedAt: null,
    httpStatus: null,
    errorCode: null,
    errorMessage: null,
    retryAfterSeconds: null,
    attemptCount: 0,
    maxAttempts: 3,
    nextAttemptAt: null,
    lastAttemptAt: null,
    deadLetteredAt: null,
    terminalReasonCode: null,
    ...overrides,
    id,
  };
  iocEnrichments.set(id, row);
  return row;
}

const ASOF = new Date("2026-01-15T00:00:00Z");

describe("getFindingEnrichmentContext", () => {
  it("throws FindingEnrichmentNotFoundError for an unknown Finding", async () => {
    const { client } = createFakeClient();
    await expect(getFindingEnrichmentContext(999, { client, asOf: ASOF })).rejects.toBeInstanceOf(
      FindingEnrichmentNotFoundError
    );
  });

  it("throws FindingEnrichmentValidationError for an invalid findingId", async () => {
    const { client } = createFakeClient();
    await expect(getFindingEnrichmentContext(-1, { client, asOf: ASOF })).rejects.toBeInstanceOf(
      FindingEnrichmentValidationError
    );
  });

  it("returns current: null when there is no fresh terminal result (no enrichment context at all)", async () => {
    const { client, findings } = createFakeClient();
    const id = seedFinding(findings);
    const result = await getFindingEnrichmentContext(id, { client, asOf: ASOF });
    expect(result.current).toBeNull();
    expect(result.activeJob).toBeNull();
    expect(result.history).toEqual([]);
  });

  it("distinguishes a fresh SUCCESS result with abuseConfidenceScore 0 from 'no result'", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);
    seedRow(iocEnrichments, {
      status: "SUCCESS",
      queriedAt: new Date("2026-01-14T00:00:00Z"),
      expiresAt: new Date("2026-01-16T00:00:00Z"),
      abuseConfidenceScore: 0,
      totalReports: 3,
    });

    const result = await getFindingEnrichmentContext(id, { client, asOf: ASOF });
    expect(result.current).not.toBeNull();
    expect(result.current.status).toBe("SUCCESS");
    expect(result.current.abuseConfidenceScore).toBe(0);
  });

  it("surfaces a fresh FAILED/TIMEOUT/RATE_LIMITED row as current, never as a clean result", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);
    seedRow(iocEnrichments, {
      status: "RATE_LIMITED",
      queriedAt: new Date("2026-01-14T00:00:00Z"),
      expiresAt: new Date("2026-01-16T00:00:00Z"),
      errorCode: "PROVIDER_RATE_LIMITED",
      errorMessage: "Provider rate limit exceeded.",
      retryAfterSeconds: 3600,
    });

    const result = await getFindingEnrichmentContext(id, { client, asOf: ASOF });
    expect(result.current.status).toBe("RATE_LIMITED");
    expect(result.current.abuseConfidenceScore).toBeNull();
  });

  it("reports an active PENDING job separately from current", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);
    seedRow(iocEnrichments, {
      status: "SUCCESS",
      queriedAt: new Date("2026-01-14T00:00:00Z"),
      expiresAt: new Date("2026-01-16T00:00:00Z"),
      abuseConfidenceScore: 5,
    });
    seedRow(iocEnrichments, {
      id: 2,
      status: "PENDING",
      requestedAt: new Date("2026-01-15T00:00:00Z"),
      activeCacheKey: "key-2",
    });

    const result = await getFindingEnrichmentContext(id, { client, asOf: ASOF });
    expect(result.current.status).toBe("SUCCESS");
    expect(result.activeJob.status).toBe("PENDING");
  });

  it("never returns DEAD_LETTER as current, but surfaces it in history", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);
    seedRow(iocEnrichments, {
      status: "DEAD_LETTER",
      requestedAt: new Date("2026-01-10T00:00:00Z"),
      deadLetteredAt: new Date("2026-01-11T00:00:00Z"),
      terminalReasonCode: "MAX_ATTEMPTS_PROVIDER_ERROR",
    });

    const result = await getFindingEnrichmentContext(id, { client, asOf: ASOF });
    expect(result.current).toBeNull();
    expect(result.history).toHaveLength(1);
    expect(result.history[0].status).toBe("DEAD_LETTER");
    expect(result.history[0].terminalReasonCode).toBe("MAX_ATTEMPTS_PROVIDER_ERROR");
  });

  it("orders history newest-requested-first, tie-broken by highest id, and paginates it", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);
    for (let i = 1; i <= 5; i += 1) {
      seedRow(iocEnrichments, {
        id: i,
        status: "NOT_FOUND",
        requestedAt: new Date("2026-01-01T00:00:00Z"),
        queriedAt: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date("2026-01-01T06:00:00Z"),
      });
    }

    const page1 = await getFindingEnrichmentContext(id, { client, asOf: ASOF, page: 1, pageSize: 2 });
    expect(page1.history.map((r) => r.id)).toEqual([5, 4]);
    expect(page1.pagination).toEqual({ page: 1, pageSize: 2, totalCount: 5, totalPages: 3 });

    const page2 = await getFindingEnrichmentContext(id, { client, asOf: ASOF, page: 2, pageSize: 2 });
    expect(page2.history.map((r) => r.id)).toEqual([3, 2]);
  });

  it("skips the history query when includeHistory is false", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);
    seedRow(iocEnrichments, { status: "NOT_FOUND", requestedAt: new Date("2026-01-01T00:00:00Z") });

    const result = await getFindingEnrichmentContext(id, { client, asOf: ASOF, includeHistory: false });
    expect(result.history).toEqual([]);
    expect(result.pagination.totalCount).toBeNull();
  });

  it("never leaks cacheKey/queryParamsHash/activeCacheKey/claimToken/leaseExpiresAt through the serializer", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings);
    seedRow(iocEnrichments, {
      status: "SUCCESS",
      queriedAt: new Date("2026-01-14T00:00:00Z"),
      expiresAt: new Date("2026-01-16T00:00:00Z"),
      cacheKey: "SECRET-CACHE-KEY",
      queryParamsHash: "SECRET-HASH",
      activeCacheKey: null,
      claimToken: "SECRET-CLAIM-TOKEN",
      leaseExpiresAt: new Date("2026-01-01T01:00:00Z"),
    });

    const result = await getFindingEnrichmentContext(id, { client, asOf: ASOF });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET-CACHE-KEY");
    expect(serialized).not.toContain("SECRET-HASH");
    expect(serialized).not.toContain("SECRET-CLAIM-TOKEN");
    expect(Object.keys(result.current)).not.toContain("cacheKey");
    expect(Object.keys(result.current)).not.toContain("claimToken");
  });

  it("uses the Finding's own canonical indicator, never a caller-supplied one", async () => {
    const { client, findings, iocEnrichments } = createFakeClient();
    const id = seedFinding(findings, { indicatorValue: "198.51.100.20" });
    seedRow(iocEnrichments, {
      indicator: "198.51.100.20",
      status: "SUCCESS",
      queriedAt: new Date("2026-01-14T00:00:00Z"),
      expiresAt: new Date("2026-01-16T00:00:00Z"),
    });

    const result = await getFindingEnrichmentContext(id, { client, asOf: ASOF });
    expect(result.indicator).toBe("198.51.100.20");
    expect(result.current).not.toBeNull();
  });
});

describe("serializeEnrichmentRecord", () => {
  it("returns null for a null row", () => {
    expect(serializeEnrichmentRecord(null)).toBeNull();
  });

  it("only exposes the allow-listed fields", () => {
    const row = seedRow(new Map(), { id: 1 });
    const serialized = serializeEnrichmentRecord(row);
    expect(Object.keys(serialized).sort()).toEqual(
      [
        "id",
        "provider",
        "indicatorType",
        "indicator",
        "status",
        "requestedAt",
        "queriedAt",
        "expiresAt",
        "nextAttemptAt",
        "attemptCount",
        "maxAttempts",
        "deadLetteredAt",
        "terminalReasonCode",
        "abuseConfidenceScore",
        "totalReports",
        "countryCode",
        "isp",
        "domain",
        "usageType",
        "isWhitelisted",
        "lastReportedAt",
        "httpStatus",
        "errorCode",
        "errorMessage",
        "retryAfterSeconds",
      ].sort()
    );
  });
});
