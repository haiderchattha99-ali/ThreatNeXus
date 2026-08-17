import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const crypto = require("node:crypto");
const { runEnrichmentBatch } = require("../../src/services/enrichment/enrichmentRunner");
const { RUNNER_OUTCOME } = require("../../src/services/enrichment/enrichmentRunnerTypes");
const { buildEnrichmentCacheIdentity } = require("../../src/services/enrichment/enrichmentCacheKey");
const { FAILURE_CLASS } = require("../../src/services/enrichment/enrichmentRetryPolicy");
const {
  QUEUE_STATUS,
  ENRICHMENT_TERMINAL_REASON,
} = require("../../src/services/enrichment/iocEnrichmentCacheRules");
const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
  createEnrichmentResult,
} = require("../../src/services/enrichment/iocEnrichmentTypes");
const { createAbuseIpdbProvider } = require("../../src/services/enrichment/abuseIpdbProvider");

// SCOPE NOTE, mirroring iocEnrichmentRepository.test.js: this in-memory fake
// Prisma client proves runner DECISION logic — claim/lookup/TTL/completion
// sequencing, cancellation, unexpected-exception handling, provider
// selection, closed outcome taxonomy, summary shape. It cannot prove genuine
// concurrent-process behaviour; that is tests/integration/enrichmentRunner.test.js.

const T0 = new Date("2026-07-28T12:00:00.000Z");

function prismaUniqueError(target) {
  const error = new Error("Unique constraint failed");
  error.code = "P2002";
  error.meta = { target };
  return error;
}

// Same shape/behaviour as the fake client already proven in
// iocEnrichmentRepository.test.js — duplicated locally per this repository's
// existing convention of one self-contained fake per test file.
function createFakeClient() {
  let nextId = 1;
  const rows = new Map();

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

  // Prisma's atomic number operations, applied per row.
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

  const RETRY_DEFAULTS = {
    attemptCount: 0,
    maxAttempts: 3,
    nextAttemptAt: null,
    lastAttemptAt: null,
    deadLetteredAt: null,
    terminalReasonCode: null,
  };

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

  function assertActiveCacheKeyUnique(candidateId, activeCacheKey) {
    if (activeCacheKey === null || activeCacheKey === undefined) return;
    const clash = [...rows.values()].find((row) => row.id !== candidateId && row.activeCacheKey === activeCacheKey);
    if (clash) throw prismaUniqueError(["activeCacheKey"]);
  }

  const client = {
    __rows: rows,
    __seed(row) {
      const id = nextId;
      nextId += 1;
      const full = {
        id,
        ...RETRY_DEFAULTS,
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
        createdAt: row.requestedAt,
        updatedAt: row.requestedAt,
        ...row,
      };
      rows.set(id, full);
      return clone(full);
    },
    iocEnrichment: {
      async create({ data }) {
        const id = nextId;
        nextId += 1;
        assertActiveCacheKeyUnique(id, data.activeCacheKey ?? null);
        const row = {
          id,
          ...RETRY_DEFAULTS,
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
          createdAt: data.requestedAt,
          updatedAt: data.requestedAt,
          ...data,
        };
        rows.set(id, row);
        return clone(row);
      },
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
          if ("activeCacheKey" in data) assertActiveCacheKeyUnique(row.id, data.activeCacheKey);
          applyUpdateData(row, data);
          row.updatedAt = new Date();
        });
        return { count: targets.length };
      },
    },
  };
  return client;
}

function pendingRow({ provider = "mock", indicator = "198.18.0.10", requestedAt = T0, queryParams = {} } = {}) {
  const identity = buildEnrichmentCacheIdentity({ provider, indicatorType: "IPV4", indicator, queryParams });
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

function fakeProvider(name, { resultFor, onCall } = {}) {
  const calls = [];
  return {
    name,
    supports: () => true,
    async lookup(input) {
      calls.push(input);
      if (onCall) await onCall(input, calls.length);
      const outcome = typeof resultFor === "function" ? resultFor(input, calls.length) : resultFor;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    getCalls: () => calls,
  };
}

function registryOf(map) {
  return {
    resolve(name) {
      if (!Object.prototype.hasOwnProperty.call(map, name)) {
        throw new Error(`no such provider: ${name}`);
      }
      return map[name];
    },
  };
}

function realTtlPolicy() {
  // Reuse the real, already-tested pure policy rather than reimplementing
  // TTL math in a fake — proves the runner wires it correctly.
  return require("../../src/services/enrichment/enrichmentTtlPolicy").resolveEnrichmentTtl;
}

function realRetryPolicy() {
  // Same reasoning as realTtlPolicy: the retry/dead-letter decisions the
  // runner acts on are the real ones, so these tests prove the wiring rather
  // than a fake's own arithmetic.
  return require("../../src/services/enrichment/enrichmentRetryPolicy").resolveEnrichmentRetry;
}

function successResult(indicator, overrides = {}, provider = "mock") {
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
      ...overrides,
    },
  });
}

function baseOptions(overrides = {}) {
  return {
    now: T0,
    batchSize: 10,
    leaseDurationSeconds: 60,
    ttlPolicy: realTtlPolicy(),
    retryPolicy: realRetryPolicy(),
    workerId: "worker-1",
    ...overrides,
  };
}

let consoleLogSpy;
let consoleWarnSpy;
let consoleErrorSpy;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runEnrichmentBatch — happy path", () => {
  it("completes one MockProvider SUCCESS job and persists a score of 0 distinctly", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ indicator: "198.18.0.1" }));
    const provider = fakeProvider("mock", { resultFor: () => successResult("198.18.0.1", { abuseConfidenceScore: 0, totalReports: 0 }) });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.completedCount).toBe(1);
    expect(summary.statusCounts).toEqual({ SUCCESS: 1 });
    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETED);
    expect(provider.getCalls()).toHaveLength(1);

    const stored = client.__rows.get(row.id);
    expect(stored.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(stored.abuseConfidenceScore).toBe(0);
    expect(stored.totalReports).toBe(0);
  });

  it("completes a NOT_FOUND job using exactly the TTL the injected policy returns, even a negative one", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.2" }));
    const provider = fakeProvider("mock", {
      resultFor: () =>
        createEnrichmentResult({
          provider: "mock",
          indicatorType: "IPV4",
          indicator: "198.18.0.2",
          status: ENRICHMENT_STATUS.NOT_FOUND,
          queriedAt: T0,
        }),
    });
    // A deliberately unusual/"negative" TTL relative to queriedAt — proves the
    // runner persists exactly what ttlPolicy returns rather than re-deriving
    // or clamping it itself.
    const negativeTtlPolicy = ({ queriedAt }) => ({
      expiresAt: new Date(queriedAt.getTime() - 1000),
      ttlSeconds: -1,
      policyReason: "TEST_NEGATIVE",
    });

    const summary = await runEnrichmentBatch({
      ...baseOptions({ ttlPolicy: negativeTtlPolicy }),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.completedCount).toBe(1);
    expect(summary.results[0].expiresAt.getTime()).toBe(T0.getTime() - 1000);
  });

  it("resolves RATE_LIMITED TTL from the provider's retryAfterSeconds via the real policy", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.3" }));
    const provider = fakeProvider("mock", {
      resultFor: () =>
        createEnrichmentResult({
          provider: "mock",
          indicatorType: "IPV4",
          indicator: "198.18.0.3",
          status: ENRICHMENT_STATUS.RATE_LIMITED,
          queriedAt: T0,
          errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED },
          retryAfterSeconds: 2000,
        }),
    });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETED);
    expect(summary.results[0].expiresAt.getTime()).toBe(T0.getTime() + 2000 * 1000);
  });

  it("processes several jobs sequentially with exact summary counts", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.4", requestedAt: T0 }));
    client.__seed(pendingRow({ indicator: "198.18.0.5", requestedAt: new Date(T0.getTime() + 1) }));
    client.__seed(pendingRow({ indicator: "198.18.0.6", requestedAt: new Date(T0.getTime() + 2) }));
    const seen = [];
    const provider = fakeProvider("mock", {
      resultFor: (input) => {
        seen.push(input.indicator);
        return successResult(input.indicator);
      },
    });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.candidateCount).toBe(3);
    expect(summary.claimedCount).toBe(3);
    expect(summary.completedCount).toBe(3);
    expect(summary.results).toHaveLength(3);
    // Deterministic requestedAt/id ordering, processed one at a time.
    expect(seen).toEqual(["198.18.0.4", "198.18.0.5", "198.18.0.6"]);
  });

  it("returns immutable/copy-safe result objects", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.7" }));
    const provider = fakeProvider("mock", { resultFor: () => successResult("198.18.0.7") });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.results)).toBe(true);
    expect(Object.isFrozen(summary.results[0])).toBe(true);
    const original = summary.results[0].outcome;
    try {
      summary.results[0].outcome = "TAMPERED";
    } catch {
      /* strict mode throws; either way nothing should change */
    }
    expect(summary.results[0].outcome).toBe(original);
  });
});

describe("runEnrichmentBatch — claim safety", () => {
  it("reports SKIPPED_NOT_CLAIMED and never calls the provider when the claim is lost", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.8" }));
    const provider = fakeProvider("mock", { resultFor: () => successResult("198.18.0.8") });

    // Simulate a racer claiming the row between listing and this worker's own
    // claim attempt: findMany (used by listPendingCandidates) is the one call
    // that happens strictly before claimPendingJob's guarded updateMany, so
    // mutate the row as a side effect of that read.
    const realFindMany = client.iocEnrichment.findMany.bind(client.iocEnrichment);
    client.iocEnrichment.findMany = async (args) => {
      const found = await realFindMany(args);
      found.forEach((row) => {
        const stored = client.__rows.get(row.id);
        stored.claimToken = "racer-token";
        stored.leaseExpiresAt = new Date(T0.getTime() + 3600000);
      });
      return found;
    };

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.SKIPPED_NOT_CLAIMED);
    expect(summary.skippedNotClaimedCount).toBe(1);
    expect(summary.claimedCount).toBe(0);
    expect(provider.getCalls()).toHaveLength(0);
  });

  it("never lets a claim token reach the summary, its JSON, or the console", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.9" }));
    const provider = fakeProvider("mock", { resultFor: () => successResult("198.18.0.9") });

    const KNOWN_TOKEN = "KNOWN-CLAIM-TOKEN-VALUE";
    const spy = vi.spyOn(crypto, "randomUUID").mockReturnValue(KNOWN_TOKEN);

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    spy.mockRestore();

    expect(JSON.stringify(summary)).not.toContain(KNOWN_TOKEN);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe("runEnrichmentBatch — provider selection", () => {
  it("selects the exact stored provider for each job", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ provider: "alpha", indicator: "198.18.0.10", requestedAt: T0 }));
    client.__seed(pendingRow({ provider: "beta", indicator: "198.18.0.11", requestedAt: new Date(T0.getTime() + 1) }));
    const alpha = fakeProvider("alpha", { resultFor: (input) => successResult(input.indicator, {}, "alpha") });
    const beta = fakeProvider("beta", { resultFor: (input) => successResult(input.indicator, {}, "beta") });

    await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ alpha, beta }),
    });

    expect(alpha.getCalls()).toHaveLength(1);
    expect(alpha.getCalls()[0].indicator).toBe("198.18.0.10");
    expect(beta.getCalls()).toHaveLength(1);
    expect(beta.getCalls()[0].indicator).toBe("198.18.0.11");
  });

  it("does not fall back to mock for an unknown provider, and releases the job", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ provider: "ghost", indicator: "198.18.0.12" }));
    const mock = fakeProvider("mock", { resultFor: () => successResult("198.18.0.12") });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock }),
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.UNKNOWN_PROVIDER);
    expect(summary.unknownProviderCount).toBe(1);
    expect(mock.getCalls()).toHaveLength(0);
    const stored = client.__rows.get(row.id);
    expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(stored.claimToken).toBeNull();
  });

  it("a missing AbuseIPDB key produces a COMPLETED SKIPPED_DISABLED terminal result, not a crash", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ provider: "abuseipdb", indicator: "198.18.0.13" }));
    // No apiKey — the real provider requires zero configuration to construct.
    const realAbuseIpdb = createAbuseIpdbProvider({ fetchImpl: async () => { throw new Error("must never be called"); } });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ abuseipdb: realAbuseIpdb }),
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETED);
    expect(summary.results[0].terminalStatus).toBe(ENRICHMENT_STATUS.SKIPPED_DISABLED);
  });

  it("completes expected TIMEOUT and FAILED results normally", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.14", requestedAt: T0 }));
    client.__seed(pendingRow({ indicator: "198.18.0.15", requestedAt: new Date(T0.getTime() + 1) }));
    const provider = fakeProvider("mock", {
      resultFor: (input) =>
        createEnrichmentResult({
          provider: "mock",
          indicatorType: "IPV4",
          indicator: input.indicator,
          status: input.indicator === "198.18.0.14" ? ENRICHMENT_STATUS.TIMEOUT : ENRICHMENT_STATUS.FAILED,
          queriedAt: T0,
          errorInfo: {
            code:
              input.indicator === "198.18.0.14"
                ? PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT
                : PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
          },
        }),
    });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.completedCount).toBe(2);
    expect(summary.statusCounts).toEqual({ TIMEOUT: 1, FAILED: 1 });
  });

  it("makes exactly one provider call per claimed job and passes only allow-listed lookup input", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.16", queryParams: { maxAgeInDays: 30 } }));
    const provider = fakeProvider("mock", { resultFor: (input) => successResult(input.indicator) });

    await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(provider.getCalls()).toHaveLength(1);
    const input = provider.getCalls()[0];
    expect(Object.keys(input).sort()).toEqual(["asOf", "indicator", "indicatorType", "queryParams", "signal"].sort());
    expect(input.queryParams).toEqual({ maxAgeInDays: 30 });
    expect(input).not.toHaveProperty("claimToken");
    expect(input).not.toHaveProperty("cacheKey");
    expect(input).not.toHaveProperty("workerId");
  });

  it("does not mutate the provider input or the underlying stored row", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ indicator: "198.18.0.17", queryParams: { maxAgeInDays: 15 } }));
    const provider = fakeProvider("mock", {
      resultFor: (input) => {
        // A misbehaving provider mutating its own input must never reach the
        // durable row.
        input.queryParams.hacked = true;
        return successResult(input.indicator);
      },
    });

    await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    const stored = client.__rows.get(row.id);
    expect(stored.queryParams).toEqual({ maxAgeInDays: 15 });
  });
});

describe("runEnrichmentBatch — TTL/completion", () => {
  it("rejects a PENDING provider result and releases the claim without persisting partial data", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ indicator: "198.18.0.18" }));
    const provider = fakeProvider("mock", {
      resultFor: (input) => ({
        provider: "mock",
        indicatorType: "IPV4",
        indicator: input.indicator,
        status: ENRICHMENT_STATUS.PENDING,
        queriedAt: T0,
        data: null,
        queryParams: {},
        httpStatus: null,
        errorInfo: null,
        retryAfterSeconds: null,
      }),
    });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR);
    const stored = client.__rows.get(row.id);
    expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(stored.queriedAt).toBeNull();
    expect(stored.claimToken).toBeNull();
  });

  it("reports a stale claim at completion safely when the lease was reclaimed mid-lookup", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ indicator: "198.18.0.19" }));
    const provider = fakeProvider("mock", {
      resultFor: (input) => successResult(input.indicator),
      onCall: () => {
        // Simulate another worker reclaiming the expired lease while this
        // worker's own provider call was still in flight.
        const stored = client.__rows.get(row.id);
        stored.claimToken = "other-worker-token";
        stored.leaseExpiresAt = new Date(T0.getTime() + 3600000);
      },
    });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.STALE_CLAIM_ON_COMPLETION);
    expect(summary.staleCompletionCount).toBe(1);
    const stored = client.__rows.get(row.id);
    // The reclaiming worker's state must survive untouched.
    expect(stored.claimToken).toBe("other-worker-token");
    expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);
  });

  it("never overwrites an already-terminal row on a second batch run", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.20" }));
    const provider = fakeProvider("mock", { resultFor: (input) => successResult(input.indicator) });
    const registry = registryOf({ mock: provider });

    await runEnrichmentBatch({ ...baseOptions(), prisma: client, providerRegistry: registry });
    const secondSummary = await runEnrichmentBatch({
      ...baseOptions({ now: new Date(T0.getTime() + 60000) }),
      prisma: client,
      providerRegistry: registry,
    });

    expect(secondSummary.candidateCount).toBe(0);
    expect(provider.getCalls()).toHaveLength(1);
  });
});

describe("runEnrichmentBatch — cancellation", () => {
  it("keeps an already-completed job COMPLETED and starts no later candidate once cancelled", async () => {
    const client = createFakeClient();
    const row1 = client.__seed(pendingRow({ indicator: "198.18.0.21", requestedAt: T0 }));
    const row2 = client.__seed(pendingRow({ indicator: "198.18.0.22", requestedAt: new Date(T0.getTime() + 1) }));
    const row3 = client.__seed(pendingRow({ indicator: "198.18.0.23", requestedAt: new Date(T0.getTime() + 2) }));
    const controller = new AbortController();
    // Job 1 completes untouched; job 2 is the one interrupted mid-lookup;
    // job 3 must never be started at all.
    const provider = fakeProvider("mock", {
      resultFor: (input) => successResult(input.indicator),
      onCall: (input) => {
        if (input.indicator === "198.18.0.22") controller.abort();
      },
    });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
      signal: controller.signal,
    });

    expect(summary.cancelled).toBe(true);
    expect(summary.results).toHaveLength(2);
    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETED);
    // Cancelled after its provider returned but before completion — released,
    // never completed (P2-T2d audit finding M4).
    expect(summary.results[1].outcome).toBe(RUNNER_OUTCOME.RELEASED_AFTER_CANCELLATION);
    expect(provider.getCalls()).toHaveLength(2);

    // The earlier job's completion survives the later cancellation.
    expect(client.__rows.get(row1.id).status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(client.__rows.get(row2.id).status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(client.__rows.get(row2.id).claimToken).toBeNull();
    // Never claimed, never looked at.
    expect(client.__rows.get(row3.id).claimToken).toBeNull();
    expect(client.__rows.get(row3.id).attemptCount).toBe(0);
  });

  it("releases the currently claimed job when cancellation is observed before its own lookup", async () => {
    const client = createFakeClient();
    const row1 = client.__seed(pendingRow({ indicator: "198.18.0.23", requestedAt: T0 }));
    const row2 = client.__seed(pendingRow({ indicator: "198.18.0.24", requestedAt: new Date(T0.getTime() + 1) }));
    const controller = new AbortController();
    const provider = fakeProvider("mock", { resultFor: (input) => successResult(input.indicator) });

    // Abort as a side effect of the FIRST claim's own guarded update, so
    // cancellation is observed after claim success but strictly before any
    // provider call.
    const realUpdateMany = client.iocEnrichment.updateMany.bind(client.iocEnrichment);
    client.iocEnrichment.updateMany = async (args) => {
      const result = await realUpdateMany(args);
      if (args.data && args.data.claimToken && !controller.signal.aborted) {
        controller.abort();
      }
      return result;
    };

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
      signal: controller.signal,
    });

    expect(summary.cancelled).toBe(true);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.RELEASED_AFTER_CANCELLATION);
    expect(provider.getCalls()).toHaveLength(0);

    const stored1 = client.__rows.get(row1.id);
    expect(stored1.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(stored1.errorCode).toBeNull();
    expect(stored1.claimToken).toBeNull();

    // The second candidate was never even claimed.
    const stored2 = client.__rows.get(row2.id);
    expect(stored2.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(stored2.claimToken).toBeNull();
  });

  it("propagates the provider's own AbortError as cancellation, never as TIMEOUT", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ indicator: "198.18.0.25" }));
    const controller = new AbortController();
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    const provider = fakeProvider("mock", { resultFor: () => abortError });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
      signal: controller.signal,
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.RELEASED_AFTER_CANCELLATION);
    expect(summary.cancelled).toBe(true);
    const stored = client.__rows.get(row.id);
    expect(stored.status).not.toBe(ENRICHMENT_STATUS.TIMEOUT);
    expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(JSON.stringify(summary)).not.toContain("AbortError");
  });
});

describe("runEnrichmentBatch — unexpected exceptions", () => {
  it("releases the claim on a thrown TypeError, leaks no raw text, and continues to the next job", async () => {
    const client = createFakeClient();
    const failing = client.__seed(pendingRow({ indicator: "198.18.0.26", requestedAt: T0 }));
    client.__seed(pendingRow({ indicator: "198.18.0.27", requestedAt: new Date(T0.getTime() + 1) }));
    const SECRET = "internal-secret-token-should-never-leak";
    const provider = fakeProvider("mock", {
      resultFor: (input) => {
        if (input.indicator === "198.18.0.26") throw new TypeError(`boom ${SECRET}`);
        return successResult(input.indicator);
      },
    });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.cancelled).toBe(false);
    expect(summary.results.map((r) => r.outcome)).toEqual([
      RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR,
      RUNNER_OUTCOME.COMPLETED,
    ]);
    expect(summary.internalFailureCount).toBe(1);
    expect(provider.getCalls()).toHaveLength(2);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(JSON.stringify(summary)).not.toContain("TypeError");

    const stored = client.__rows.get(failing.id);
    expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(stored.claimToken).toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();
    expect(stored.queriedAt).toBeNull();
    expect(stored.abuseConfidenceScore).toBeNull();
    expect(stored.errorCode).toBeNull();
  });

  it("does not retry a failing provider within the same run", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.28" }));
    const provider = fakeProvider("mock", { resultFor: () => new TypeError("nope") });

    await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(provider.getCalls()).toHaveLength(1);
  });

  it("reports COMPLETION_FAILED without touching earlier successful jobs when the completion write throws", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.29", requestedAt: T0 }));
    client.__seed(pendingRow({ indicator: "198.18.0.30", requestedAt: new Date(T0.getTime() + 1) }));
    const provider = fakeProvider("mock", { resultFor: (input) => successResult(input.indicator) });

    let calls = 0;
    const realUpdateMany = client.iocEnrichment.updateMany.bind(client.iocEnrichment);
    client.iocEnrichment.updateMany = async (args) => {
      calls += 1;
      // Fail only the SECOND job's completion updateMany (the first job's
      // claim + completion updateMany calls, then the second job's claim
      // updateMany, must all succeed first).
      if (calls === 4) throw new Error("simulated database failure");
      return realUpdateMany(args);
    };

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.results.map((r) => r.outcome)).toEqual([RUNNER_OUTCOME.COMPLETED, RUNNER_OUTCOME.COMPLETION_FAILED]);
    expect(JSON.stringify(summary)).not.toContain("simulated database failure");
  });
});

describe("runEnrichmentBatch — retry, dead-letter and unknown-state hardening (P2-T2e-1)", () => {
  it("makes zero database and provider calls when the signal is already aborted", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.34" }));
    const provider = fakeProvider("mock", { resultFor: (input) => successResult(input.indicator) });

    let findManyCalls = 0;
    let updateManyCalls = 0;
    const realFindMany = client.iocEnrichment.findMany.bind(client.iocEnrichment);
    const realUpdateMany = client.iocEnrichment.updateMany.bind(client.iocEnrichment);
    client.iocEnrichment.findMany = async (args) => {
      findManyCalls += 1;
      return realFindMany(args);
    };
    client.iocEnrichment.updateMany = async (args) => {
      updateManyCalls += 1;
      return realUpdateMany(args);
    };

    const controller = new AbortController();
    controller.abort();

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
      signal: controller.signal,
    });

    expect(summary.cancelled).toBe(true);
    expect(summary.candidateCount).toBe(0);
    expect(summary.results).toHaveLength(0);
    // Not merely "no work done" — no query was even issued.
    expect(findManyCalls).toBe(0);
    expect(updateManyCalls).toBe(0);
    expect(provider.getCalls()).toHaveLength(0);
  });

  it("reports CLAIM_FAILED without a provider call when the claim query itself throws", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.35", requestedAt: T0 }));
    client.__seed(pendingRow({ indicator: "198.18.0.36", requestedAt: new Date(T0.getTime() + 1) }));
    const provider = fakeProvider("mock", { resultFor: (input) => successResult(input.indicator) });

    // findUnique is claimPendingJob's first call; failing it once makes the
    // claim raise rather than merely lose a race.
    let claimReads = 0;
    const realFindUnique = client.iocEnrichment.findUnique.bind(client.iocEnrichment);
    client.iocEnrichment.findUnique = async (args) => {
      claimReads += 1;
      if (claimReads === 1) throw new Error("simulated claim read failure");
      return realFindUnique(args);
    };

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.CLAIM_FAILED);
    expect(summary.claimedCount).toBe(1); // only the second job
    expect(summary.internalFailureCount).toBe(1);
    // A failed claim is not a failed batch: the next job still runs.
    expect(summary.results[1].outcome).toBe(RUNNER_OUTCOME.COMPLETED);
    expect(JSON.stringify(summary)).not.toContain("simulated claim read failure");
  });

  it("reports RELEASE_FAILED and preserves the release's provenance when the release write throws", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.37" }));
    const provider = fakeProvider("mock", { resultFor: () => new TypeError("provider exploded") });

    // Let the claim through, then fail the release (identified by clearing
    // claimToken, which only the release/complete writes do).
    const realUpdateMany = client.iocEnrichment.updateMany.bind(client.iocEnrichment);
    client.iocEnrichment.updateMany = async (args) => {
      if (args.data && args.data.claimToken === null) throw new Error("simulated release failure");
      return realUpdateMany(args);
    };

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.RELEASE_FAILED);
    // Part 4C: WHY the release was attempted survives, as a closed code.
    expect(summary.results[0].failureClass).toBe(FAILURE_CLASS.PROVIDER_PROGRAMMER_ERROR);
    expect(JSON.stringify(summary)).not.toContain("simulated release failure");
    expect(JSON.stringify(summary)).not.toContain("provider exploded");
  });

  it("treats a rejected completion payload as a LOCAL validation error and releases with a delay", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ indicator: "198.18.0.38" }));
    // A result whose provider identity does not match the claimed row makes
    // completeClaimedJob throw IocEnrichmentValidationError *before* it
    // writes anything — the durable state is therefore known exactly.
    const provider = fakeProvider("mock", {
      resultFor: (input) => successResult(input.indicator, {}, "someone-else"),
    });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.RELEASED_AFTER_COMPLETION_VALIDATION);
    expect(summary.results[0].failureClass).toBe(FAILURE_CLASS.COMPLETION_VALIDATION_ERROR);
    expect(summary.results[0].nextAttemptAt).toBeInstanceOf(Date);
    expect(summary.results[0].nextAttemptAt.getTime()).toBeGreaterThan(T0.getTime());

    const stored = client.__rows.get(row.id);
    expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(stored.claimToken).toBeNull(); // genuinely released
    expect(stored.queriedAt).toBeNull(); // no partial terminal fields
    expect(stored.abuseConfidenceScore).toBeNull();
    expect(stored.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("HOLDS the lease for an unknown completion database error — never releases or dead-letters", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ indicator: "198.18.0.39" }));
    const provider = fakeProvider("mock", { resultFor: (input) => successResult(input.indicator) });

    // Fail only the completion write (identifiable by `data.status`), i.e.
    // the case where the row may or may not already carry the result.
    const realUpdateMany = client.iocEnrichment.updateMany.bind(client.iocEnrichment);
    client.iocEnrichment.updateMany = async (args) => {
      if (args.data && "status" in args.data) throw new Error("simulated completion database failure");
      return realUpdateMany(args);
    };

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETION_FAILED);
    expect(summary.results[0].failureClass).toBe(FAILURE_CLASS.COMPLETION_DATABASE_ERROR);
    expect(summary.heldUnknownStateCount).toBe(1);
    expect(summary.releasedCount).toBe(0);
    expect(summary.deadLetteredCount).toBe(0);

    const stored = client.__rows.get(row.id);
    // The lease is deliberately still held: lease expiry is the recovery path.
    expect(stored.claimToken).not.toBeNull();
    expect(stored.leaseExpiresAt).not.toBeNull();
    expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(stored.nextAttemptAt).toBeNull();
    expect(JSON.stringify(summary)).not.toContain("simulated completion database failure");
  });

  it("does not complete a job cancelled after its provider returned but before completion", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ indicator: "198.18.0.40" }));
    const controller = new AbortController();
    const provider = fakeProvider("mock", {
      // Returns a perfectly good result, but the signal fires first.
      resultFor: (input) => successResult(input.indicator),
      onCall: () => controller.abort(),
    });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
      signal: controller.signal,
    });

    expect(provider.getCalls()).toHaveLength(1);
    expect(summary.cancelled).toBe(true);
    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.RELEASED_AFTER_CANCELLATION);
    expect(summary.completedCount).toBe(0);

    const stored = client.__rows.get(row.id);
    expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(stored.queriedAt).toBeNull();
    expect(stored.claimToken).toBeNull();
    // Refunded: an interrupted attempt must not consume the budget.
    expect(stored.attemptCount).toBe(0);
  });

  it("dead-letters an unknown provider once its attempt budget is spent, and stops calling it", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ provider: "ghost", indicator: "198.18.0.41" }));
    const mock = fakeProvider("mock", { resultFor: (input) => successResult(input.indicator) });
    const registry = registryOf({ mock });

    // Three attempts, each after the previous delay has elapsed.
    const outcomes = [];
    let clock = T0;
    let lastRunAt = T0;
    for (let i = 0; i < 3; i += 1) {
      lastRunAt = clock;
      // eslint-disable-next-line no-await-in-loop
      const summary = await runEnrichmentBatch({
        ...baseOptions({ now: clock }),
        prisma: client,
        providerRegistry: registry,
      });
      outcomes.push(summary.results[0].outcome);
      const stored = client.__rows.get(row.id);
      clock = stored.nextAttemptAt ? new Date(stored.nextAttemptAt.getTime()) : new Date(clock.getTime() + 1);
    }

    expect(outcomes).toEqual([
      RUNNER_OUTCOME.UNKNOWN_PROVIDER,
      RUNNER_OUTCOME.UNKNOWN_PROVIDER,
      RUNNER_OUTCOME.DEAD_LETTERED,
    ]);

    const stored = client.__rows.get(row.id);
    expect(stored.status).toBe(QUEUE_STATUS.DEAD_LETTER);
    expect(stored.terminalReasonCode).toBe(ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_UNKNOWN_PROVIDER);
    expect(stored.activeCacheKey).toBeNull();
    expect(stored.claimToken).toBeNull();
    // Stamped with the explicit `now` of the run that retired it — never a
    // wall-clock read.
    expect(stored.deadLetteredAt).toEqual(lastRunAt);

    // A fourth invocation must not see it at all.
    const after = await runEnrichmentBatch({
      ...baseOptions({ now: new Date(clock.getTime() + 86400000) }),
      prisma: client,
      providerRegistry: registry,
    });
    expect(after.candidateCount).toBe(0);
    expect(mock.getCalls()).toHaveLength(0);
  });

  it("bounds a repeatedly-failing provider to maxAttempts calls, then dead-letters it", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ indicator: "198.18.0.42" }));
    const provider = fakeProvider("mock", { resultFor: () => new TypeError("always broken") });
    const registry = registryOf({ mock: provider });

    // Run far more batches than the budget allows.
    let clock = T0;
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runEnrichmentBatch({
        ...baseOptions({ now: clock }),
        prisma: client,
        providerRegistry: registry,
      });
      const stored = client.__rows.get(row.id);
      clock = stored.nextAttemptAt ? new Date(stored.nextAttemptAt.getTime()) : new Date(clock.getTime() + 60000);
    }

    // The poison job cost exactly its budget, not one call per batch.
    expect(provider.getCalls()).toHaveLength(3);
    const stored = client.__rows.get(row.id);
    expect(stored.status).toBe(QUEUE_STATUS.DEAD_LETTER);
    expect(stored.terminalReasonCode).toBe(ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_PROVIDER_ERROR);
    expect(stored.attemptCount).toBe(3);
  });

  it("does not let one poison job starve healthy jobs in the same batch", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ indicator: "198.18.0.43", requestedAt: T0 }));
    const healthy = client.__seed(pendingRow({ indicator: "198.18.0.44", requestedAt: new Date(T0.getTime() + 1) }));
    const provider = fakeProvider("mock", {
      resultFor: (input) => {
        if (input.indicator === "198.18.0.43") throw new TypeError("poison");
        return successResult(input.indicator);
      },
    });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.results.map((r) => r.outcome)).toEqual([
      RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR,
      RUNNER_OUTCOME.COMPLETED,
    ]);
    expect(client.__rows.get(healthy.id).status).toBe(ENRICHMENT_STATUS.SUCCESS);
  });

  it("sweeps an already-exhausted candidate into DEAD_LETTER without claiming or calling a provider", async () => {
    const client = createFakeClient();
    // A row stranded at its limit by an earlier crashed worker: claimable
    // forever in the old model, permanently unclaimable in the new one.
    const row = client.__seed(pendingRow({ indicator: "198.18.0.45" }));
    client.__rows.get(row.id).attemptCount = 3;
    const provider = fakeProvider("mock", { resultFor: (input) => successResult(input.indicator) });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.EXHAUSTED_DEAD_LETTERED);
    expect(summary.deadLetteredCount).toBe(1);
    expect(summary.claimedCount).toBe(0);
    expect(provider.getCalls()).toHaveLength(0);

    const stored = client.__rows.get(row.id);
    expect(stored.status).toBe(QUEUE_STATUS.DEAD_LETTER);
    expect(stored.terminalReasonCode).toBe(ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_EXHAUSTED);
    expect(stored.activeCacheKey).toBeNull();
    expect(stored.attemptCount).toBe(3); // never incremented by the sweep
  });

  it("does not list a job whose retry delay has not elapsed, and does at the exact boundary", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ indicator: "198.18.0.46" }));
    const nextAttemptAt = new Date(T0.getTime() + 300000);
    client.__rows.get(row.id).nextAttemptAt = nextAttemptAt;
    const provider = fakeProvider("mock", { resultFor: (input) => successResult(input.indicator) });
    const registry = registryOf({ mock: provider });

    const tooEarly = await runEnrichmentBatch({
      ...baseOptions({ now: new Date(nextAttemptAt.getTime() - 1) }),
      prisma: client,
      providerRegistry: registry,
    });
    expect(tooEarly.candidateCount).toBe(0);
    expect(provider.getCalls()).toHaveLength(0);

    const exactly = await runEnrichmentBatch({
      ...baseOptions({ now: nextAttemptAt }),
      prisma: client,
      providerRegistry: registry,
    });
    expect(exactly.candidateCount).toBe(1);
    expect(exactly.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETED);
  });

  it("never lets a raw exception, secret or claim token reach a dead-lettered summary", async () => {
    const client = createFakeClient();
    const row = client.__seed(pendingRow({ indicator: "198.18.0.47" }));
    client.__rows.get(row.id).attemptCount = 2; // one attempt left
    const SECRET = "dead-letter-secret-must-not-leak";
    const provider = fakeProvider("mock", { resultFor: () => new TypeError(`boom ${SECRET}`) });

    const KNOWN_TOKEN = "KNOWN-DEADLETTER-CLAIM-TOKEN";
    const spy = vi.spyOn(crypto, "randomUUID").mockReturnValue(KNOWN_TOKEN);
    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });
    spy.mockRestore();

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.DEAD_LETTERED);
    expect(summary.deadLetteredCount).toBe(1);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(KNOWN_TOKEN);
    expect(serialized).not.toContain("TypeError");
    expect(serialized).not.toContain(client.__rows.get(row.id).cacheKey);
  });
});

describe("runEnrichmentBatch — logging/security", () => {
  it("never logs to the console across a mixed-outcome batch", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ provider: "mock", indicator: "198.18.0.31", requestedAt: T0 }));
    client.__seed(pendingRow({ provider: "ghost", indicator: "198.18.0.32", requestedAt: new Date(T0.getTime() + 1) }));
    const provider = fakeProvider("mock", { resultFor: () => new TypeError("nope") });

    await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider }),
    });

    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("a fake AbuseIPDB key appears only in the captured request header, never in the summary", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ provider: "abuseipdb", indicator: "198.18.0.33" }));
    const FAKE_KEY = "fake-abuseipdb-key-must-not-leak";
    const capturedHeaders = [];
    const fetchImpl = async (url, requestInit) => {
      capturedHeaders.push(requestInit.headers);
      return {
        status: 200,
        headers: { get: () => null },
        // TNX-P10C5 — production reads the body via .text(), not .json().
        text: async () => JSON.stringify({ data: { ipAddress: "198.18.0.33", abuseConfidenceScore: 0, totalReports: 0 } }),
      };
    };
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ abuseipdb: provider }),
    });

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETED);
    expect(capturedHeaders).toHaveLength(1);
    expect(capturedHeaders[0].Key).toBe(FAKE_KEY);
    expect(JSON.stringify(summary)).not.toContain(FAKE_KEY);
  });
});
