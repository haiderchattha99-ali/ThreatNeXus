import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPE,
  SYSTEM_ACTOR_CONTEXT,
  EnrichmentExecutionError,
  buildBatchAuditPayload,
  executeEnrichmentBatch,
} = require("../../src/services/enrichment/enrichmentExecutionService");
const { RUNNER_OUTCOME } = require("../../src/services/enrichment/enrichmentRunnerTypes");
const { buildEnrichmentCacheIdentity } = require("../../src/services/enrichment/enrichmentCacheKey");
const {
  ENRICHMENT_STATUS,
  createEnrichmentResult,
} = require("../../src/services/enrichment/iocEnrichmentTypes");
const { DEFAULT_MAX_ATTEMPTS } = require("../../src/services/enrichment/iocEnrichmentCacheRules");

// SCOPE NOTE: this proves the AUDIT contract of the one production-composable
// entry point — that a batch is audited, that the payload carries aggregates
// only, and that an audit failure can never damage queue processing. The
// runner's own behaviour is proven in enrichmentRunner.test.js; real
// concurrency in tests/integration/enrichmentRetryDeadLetter.test.js.

const T0 = new Date("2026-07-28T12:00:00.000Z");
const SECRET_INDICATOR = "198.18.0.77";

function createFakeClient() {
  let nextId = 1;
  const rows = new Map();
  const auditRows = [];

  function clone(row) {
    return row === undefined || row === null ? null : { ...row };
  }

  function comparable(value) {
    return value instanceof Date ? value.getTime() : value;
  }

  function matchesCondition(value, condition) {
    if (condition && typeof condition === "object" && !(condition instanceof Date) && !Array.isArray(condition)) {
      if ("in" in condition) return condition.in.includes(value);
      if ("not" in condition) return value !== condition.not;
      if (value === null || value === undefined) return false;
      if ("gt" in condition) return comparable(value) > comparable(condition.gt);
      if ("gte" in condition) return comparable(value) >= comparable(condition.gte);
      if ("lt" in condition) return comparable(value) < comparable(condition.lt);
      if ("lte" in condition) return comparable(value) <= comparable(condition.lte);
      return true;
    }
    return value === condition;
  }

  function matches(row, where = {}) {
    return Object.entries(where).every(([key, condition]) => {
      if (key === "OR") return condition.some((sub) => matches(row, sub));
      if (key === "AND") return condition.every((sub) => matches(row, sub));
      return matchesCondition(row[key], condition);
    });
  }

  function compare(a, b, orderBy) {
    for (const clause of orderBy) {
      const [field, direction] = Object.entries(clause)[0];
      const av = a[field] instanceof Date ? a[field].getTime() : a[field];
      const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
      if (av === bv) continue;
      const result = av < bv ? -1 : 1;
      return direction === "desc" ? -result : result;
    }
    return 0;
  }

  function applyUpdateData(row, data) {
    Object.entries(data).forEach(([key, value]) => {
      if (value && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value)) {
        if ("increment" in value) {
          row[key] = (row[key] || 0) + value.increment;
          return;
        }
        if ("decrement" in value) {
          row[key] = (row[key] || 0) - value.decrement;
          return;
        }
      }
      row[key] = value;
    });
  }

  const DEFAULTS = {
    claimedAt: null,
    leaseExpiresAt: null,
    claimToken: null,
    activeCacheKey: null,
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
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    nextAttemptAt: null,
    lastAttemptAt: null,
    deadLetteredAt: null,
    terminalReasonCode: null,
  };

  return {
    __rows: rows,
    __auditRows: auditRows,
    __seed(row) {
      const id = nextId;
      nextId += 1;
      rows.set(id, { id, ...DEFAULTS, createdAt: T0, updatedAt: T0, ...row });
      return clone(rows.get(id));
    },
    auditLog: {
      async create({ data }) {
        auditRows.push(data);
        return { id: auditRows.length, ...data };
      },
    },
    iocEnrichment: {
      async findUnique({ where }) {
        if ("id" in where) return clone(rows.get(where.id));
        if ("activeCacheKey" in where) {
          return clone([...rows.values()].find((r) => r.activeCacheKey === where.activeCacheKey));
        }
        throw new Error("fake findUnique: unsupported where");
      },
      async findFirst({ where = {}, orderBy = [] }) {
        const found = [...rows.values()].filter((r) => matches(r, where)).sort((a, b) => compare(a, b, orderBy));
        return clone(found[0]);
      },
      async findMany({ where = {}, orderBy = [], take }) {
        const found = [...rows.values()].filter((r) => matches(r, where)).sort((a, b) => compare(a, b, orderBy));
        return (take === undefined ? found : found.slice(0, take)).map(clone);
      },
      async updateMany({ where = {}, data }) {
        const targets = [...rows.values()].filter((r) => matches(r, where));
        targets.forEach((row) => {
          applyUpdateData(row, data);
          row.updatedAt = new Date();
        });
        return { count: targets.length };
      },
    },
  };
}

function pendingRow({ provider = "mock", indicator = SECRET_INDICATOR, requestedAt = T0 } = {}) {
  const identity = buildEnrichmentCacheIdentity({ provider, indicatorType: "IPV4", indicator, queryParams: {} });
  return {
    provider,
    indicatorType: "IPV4",
    indicator,
    queryParams: identity.queryParams,
    queryParamsHash: identity.queryParamsHash,
    cacheKey: identity.cacheKey,
    status: ENRICHMENT_STATUS.PENDING,
    requestedAt,
    activeCacheKey: identity.cacheKey,
  };
}

function successResult(indicator, provider = "mock") {
  return createEnrichmentResult({
    provider,
    indicatorType: "IPV4",
    indicator,
    status: ENRICHMENT_STATUS.SUCCESS,
    queriedAt: T0,
    httpStatus: 200,
    data: {
      abuseConfidenceScore: 0,
      totalReports: 0,
      countryCode: null,
      isp: null,
      domain: null,
      usageType: null,
      isWhitelisted: false,
      lastReportedAt: null,
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

// A runtime override that never touches env, the registry, or the network.
function runtimeOverrides(providerMap, extra = {}) {
  return {
    env: {
      ABUSEIPDB_API_KEY: "",
      ABUSEIPDB_BASE_URL: "https://api.example.invalid/api/v2",
      ABUSEIPDB_TIMEOUT_MS: 5000,
      ABUSEIPDB_MAX_AGE_DAYS: 30,
    },
    providerRegistry: {
      resolve(name) {
        if (!Object.prototype.hasOwnProperty.call(providerMap, name)) {
          throw new Error(`no such provider: ${name}`);
        }
        return providerMap[name];
      },
    },
    ...extra,
  };
}

let consoleErrorSpy;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enrichmentExecutionService — audit pairing", () => {
  it("writes exactly one requested/completed pair for a successful batch", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow());
    const provider = fakeProvider("mock", (input) => successResult(input.indicator));

    const summary = await executeEnrichmentBatch({
      prisma: client,
      now: T0,
      workerId: "worker-1",
      runtimeOverrides: runtimeOverrides({ mock: provider }),
    });

    expect(summary.completedCount).toBe(1);
    expect(client.__auditRows).toHaveLength(2);
    expect(client.__auditRows[0].action).toBe(AUDIT_ACTIONS.REQUESTED);
    expect(client.__auditRows[1].action).toBe(AUDIT_ACTIONS.COMPLETED);
    expect(client.__auditRows[1].entityType).toBe(AUDIT_ENTITY_TYPE);
    expect(client.__auditRows[1].outcome).toBe("SUCCESS");
  });

  it("audits a cancelled batch as cancelled, not completed", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow());
    const controller = new AbortController();
    controller.abort();

    const summary = await executeEnrichmentBatch({
      prisma: client,
      now: T0,
      workerId: "worker-1",
      signal: controller.signal,
      runtimeOverrides: runtimeOverrides({ mock: fakeProvider("mock", () => successResult(SECRET_INDICATOR)) }),
    });

    expect(summary.cancelled).toBe(true);
    expect(client.__auditRows.map((r) => r.action)).toEqual([
      AUDIT_ACTIONS.REQUESTED,
      AUDIT_ACTIONS.CANCELLED,
    ]);
  });

  it("audits a pre-processing failure and rethrows", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow());

    await expect(
      executeEnrichmentBatch({
        prisma: client,
        now: T0,
        workerId: "worker-1",
        // An invalid runtime configuration fails before any candidate is read.
        runtimeOverrides: { env: {}, defaultBatchSize: 0 },
      })
    ).rejects.toThrow();

    expect(client.__auditRows.map((r) => r.action)).toEqual([
      AUDIT_ACTIONS.REQUESTED,
      AUDIT_ACTIONS.FAILED,
    ]);
    expect(client.__auditRows[1].outcome).toBe("FAILURE");
    // Nothing was processed, so nothing may claim to have been.
    expect([...client.__rows.values()][0].attemptCount).toBe(0);
  });

  it("does not emit a per-job audit event — the count is independent of batch size", async () => {
    const client = createFakeClient();
    for (let i = 0; i < 12; i += 1) {
      client.__seed(pendingRow({ indicator: `198.18.1.${i}`, requestedAt: new Date(T0.getTime() + i) }));
    }
    const provider = fakeProvider("mock", (input) => successResult(input.indicator));

    const summary = await executeEnrichmentBatch({
      prisma: client,
      now: T0,
      batchSize: 12,
      workerId: "worker-1",
      runtimeOverrides: runtimeOverrides({ mock: provider }),
    });

    expect(summary.completedCount).toBe(12);
    // Twelve jobs, still two audit rows.
    expect(client.__auditRows).toHaveLength(2);
  });

  it("a per-job failure is counted, not audited as a failed batch", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.2.1", requestedAt: T0 }));
    client.__seed(pendingRow({ provider: "ghost", indicator: "198.18.2.2", requestedAt: new Date(T0.getTime() + 1) }));
    const provider = fakeProvider("mock", (input) => successResult(input.indicator));

    const summary = await executeEnrichmentBatch({
      prisma: client,
      now: T0,
      workerId: "worker-1",
      runtimeOverrides: runtimeOverrides({ mock: provider }),
    });

    expect(summary.unknownProviderCount).toBe(1);
    expect(client.__auditRows[1].action).toBe(AUDIT_ACTIONS.COMPLETED);
    expect(client.__auditRows[1].after.unknownProviderCount).toBe(1);
  });
});

describe("enrichmentExecutionService — audit payload is aggregates only", () => {
  it("carries counts and a terminal-status histogram, and nothing else", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow());
    const provider = fakeProvider("mock", (input) => successResult(input.indicator));

    await executeEnrichmentBatch({
      prisma: client,
      now: T0,
      workerId: "worker-1",
      runtimeOverrides: runtimeOverrides({ mock: provider }),
    });

    const payload = client.__auditRows[1].after;
    expect(Object.keys(payload).sort()).toEqual(
      [
        "workerId",
        "requestedBatchSize",
        "candidateCount",
        "claimedCount",
        "completedCount",
        "skippedNotClaimedCount",
        "releasedCount",
        "staleCompletionCount",
        "internalFailureCount",
        "unknownProviderCount",
        "deadLetteredCount",
        "heldUnknownStateCount",
        "cancelled",
        "statusCounts",
      ].sort()
    );
    expect(payload.statusCounts).toEqual({ SUCCESS: 1 });
    // No per-job list can reach an audit row.
    expect(payload).not.toHaveProperty("results");
  });

  it("never writes an indicator, cache key or claim token into an audit row", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ indicator: SECRET_INDICATOR }));
    const provider = fakeProvider("mock", (input) => successResult(input.indicator));

    await executeEnrichmentBatch({
      prisma: client,
      now: T0,
      workerId: "worker-1",
      runtimeOverrides: runtimeOverrides({ mock: provider }),
    });

    const serialized = JSON.stringify(client.__auditRows);
    expect(serialized).not.toContain(SECRET_INDICATOR);
    expect(serialized).not.toContain(client.__rows.get(row.id).cacheKey);
    expect(serialized).not.toContain(client.__rows.get(row.id).queryParamsHash);
  });

  it("never writes a raw error message or stack into an audit row", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow());
    const SECRET = "provider-internal-secret-must-not-leak";
    const provider = fakeProvider("mock", () => new TypeError(`boom ${SECRET}`));

    await executeEnrichmentBatch({
      prisma: client,
      now: T0,
      workerId: "worker-1",
      runtimeOverrides: runtimeOverrides({ mock: provider }),
    });

    const serialized = JSON.stringify(client.__auditRows);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("TypeError");
  });

  it("buildBatchAuditPayload copies named fields only, ignoring anything extra", () => {
    const payload = buildBatchAuditPayload(
      {
        requestedBatchSize: 5,
        candidateCount: 1,
        claimedCount: 1,
        completedCount: 1,
        skippedNotClaimedCount: 0,
        releasedCount: 0,
        staleCompletionCount: 0,
        internalFailureCount: 0,
        unknownProviderCount: 0,
        deadLetteredCount: 0,
        heldUnknownStateCount: 0,
        cancelled: false,
        statusCounts: { SUCCESS: 1 },
        // A future summary field must not be copied by default.
        results: [{ indicator: SECRET_INDICATOR, claimToken: "tok" }],
        secretFutureField: "must-not-appear",
      },
      "worker-1"
    );

    expect(payload).not.toHaveProperty("results");
    expect(payload).not.toHaveProperty("secretFutureField");
    expect(JSON.stringify(payload)).not.toContain(SECRET_INDICATOR);
  });
});

describe("enrichmentExecutionService — audit failure isolation", () => {
  it("completes the batch and persists the job even when every audit write throws", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow());
    const provider = fakeProvider("mock", (input) => successResult(input.indicator));
    client.auditLog.create = async () => {
      throw new Error("simulated audit outage");
    };

    const summary = await executeEnrichmentBatch({
      prisma: client,
      now: T0,
      workerId: "worker-1",
      runtimeOverrides: runtimeOverrides({ mock: provider }),
    });

    // The queue work is the thing that must survive.
    expect(summary.completedCount).toBe(1);
    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETED);
    expect(client.__rows.get(row.id).status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(client.__rows.get(row.id).claimToken).toBeNull();
  });
});

describe("enrichmentExecutionService — actor context and input validation", () => {
  it("defaults to a SYSTEM actor with no false user attribution", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow());
    const provider = fakeProvider("mock", (input) => successResult(input.indicator));

    await executeEnrichmentBatch({
      prisma: client,
      now: T0,
      workerId: "worker-1",
      runtimeOverrides: runtimeOverrides({ mock: provider }),
    });

    expect(SYSTEM_ACTOR_CONTEXT.actorUserId).toBeNull();
    expect(client.__auditRows[0].actorUserId).toBeUndefined();
    expect(client.__auditRows[0].actorRole).toBeUndefined();
  });

  it("carries an explicit actor context through to the audit rows", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow());
    const provider = fakeProvider("mock", (input) => successResult(input.indicator));

    await executeEnrichmentBatch({
      prisma: client,
      now: T0,
      workerId: "worker-1",
      actorContext: { actorUserId: "42", actorEmail: "analyst@threatnexus.local", actorRole: "ANALYST" },
      runtimeOverrides: runtimeOverrides({ mock: provider }),
    });

    expect(client.__auditRows[0].actorUserId).toBe("42");
    expect(client.__auditRows[0].actorRole).toBe("ANALYST");
  });

  it("rejects malformed input before writing anything", async () => {
    const client = createFakeClient();
    await expect(executeEnrichmentBatch({ prisma: null, workerId: "w" })).rejects.toThrow(
      EnrichmentExecutionError
    );
    await expect(executeEnrichmentBatch({ prisma: client, workerId: "" })).rejects.toThrow(
      EnrichmentExecutionError
    );
    await expect(
      executeEnrichmentBatch({ prisma: client, workerId: "w", now: "2026-07-28" })
    ).rejects.toThrow(EnrichmentExecutionError);
    await expect(
      executeEnrichmentBatch({ prisma: client, workerId: "w", batchSize: 0 })
    ).rejects.toThrow(EnrichmentExecutionError);
    // Nothing was audited, because nothing was attempted.
    expect(client.__auditRows).toHaveLength(0);
  });

  it("invokes the runner at most once per call and starts no timer", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow());
    const provider = fakeProvider("mock", (input) => successResult(input.indicator));

    vi.useFakeTimers();
    try {
      await executeEnrichmentBatch({
        prisma: client,
        now: T0,
        workerId: "worker-1",
        runtimeOverrides: runtimeOverrides({ mock: provider }),
      });
      // No self-rescheduling, no daemon.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(provider.getCalls()).toHaveLength(1);
  });
});
