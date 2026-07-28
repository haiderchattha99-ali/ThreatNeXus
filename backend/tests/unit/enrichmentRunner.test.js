import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const crypto = require("node:crypto");
const { runEnrichmentBatch } = require("../../src/services/enrichment/enrichmentRunner");
const { RUNNER_OUTCOME } = require("../../src/services/enrichment/enrichmentRunnerTypes");
const { buildEnrichmentCacheIdentity } = require("../../src/services/enrichment/enrichmentCacheKey");
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

  function matchesCondition(value, condition) {
    if (condition && typeof condition === "object" && !(condition instanceof Date) && !Array.isArray(condition)) {
      if ("in" in condition) return condition.in.includes(value);
      if ("not" in condition) return value !== condition.not;
      if ("gt" in condition) return value !== null && value !== undefined && value.getTime() > condition.gt.getTime();
      if ("lte" in condition) return value !== null && value !== undefined && value.getTime() <= condition.lte.getTime();
      return true;
    }
    return value === condition;
  }

  function matches(row, where = {}) {
    return Object.entries(where).every(([key, condition]) => {
      if (key === "OR") return condition.some((sub) => matches(row, sub));
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
          Object.assign(row, data, { updatedAt: new Date() });
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
    client.__seed(pendingRow({ indicator: "198.18.0.21", requestedAt: T0 }));
    client.__seed(pendingRow({ indicator: "198.18.0.22", requestedAt: new Date(T0.getTime() + 1) }));
    const controller = new AbortController();
    const provider1 = fakeProvider("mock", {
      resultFor: (input) => successResult(input.indicator),
      onCall: () => controller.abort(),
    });

    const summary = await runEnrichmentBatch({
      ...baseOptions(),
      prisma: client,
      providerRegistry: registryOf({ mock: provider1 }),
      signal: controller.signal,
    });

    expect(summary.cancelled).toBe(true);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETED);
    expect(provider1.getCalls()).toHaveLength(1);
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
        json: async () => ({ data: { ipAddress: "198.18.0.33", abuseConfidenceScore: 0, totalReports: 0 } }),
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
