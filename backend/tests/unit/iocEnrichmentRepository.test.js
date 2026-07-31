import { describe, it, expect } from "vitest";

const {
  COMPLETION_OUTCOME,
  RELEASE_OUTCOME,
  findFreshCachedResult,
  findActiveJobByCacheKey,
  createPendingJob,
  listPendingCandidates,
  claimPendingJob,
  claimPendingBatch,
  completeClaimedJob,
  releaseClaimedJob,
} = require("../../src/services/enrichment/iocEnrichmentRepository");
const {
  SCHEDULE_OUTCOME,
  scheduleEnrichment,
} = require("../../src/services/enrichment/enrichmentQueueService");
const {
  IocEnrichmentValidationError,
} = require("../../src/services/enrichment/iocEnrichmentCacheRules");
const { buildEnrichmentCacheIdentity } = require("../../src/services/enrichment/enrichmentCacheKey");
const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
  PROVIDER_ERROR_MESSAGES,
  createEnrichmentResult,
} = require("../../src/services/enrichment/iocEnrichmentTypes");

// SCOPE NOTE, mirroring findingOwnershipService.test.js: these run against an
// in-memory fake Prisma client and prove DECISION logic — cache hit/miss,
// exact-status passthrough, claim-token enforcement, terminal immutability,
// schedule outcomes. They cannot prove PostgreSQL's unique-constraint and
// row-lock semantics under genuine concurrency; that is what the mandatory
// real-database suite (tests/integration/iocEnrichmentQueue.test.js) is for.

const PROVIDER = "mock";
const INDICATOR = "198.18.0.10";
const IDENTITY_INPUT = Object.freeze({
  provider: PROVIDER,
  indicatorType: "IPV4",
  indicator: INDICATOR,
});
const CACHE_KEY = buildEnrichmentCacheIdentity(IDENTITY_INPUT).cacheKey;

const T0 = new Date("2026-07-28T12:00:00.000Z");
const LEASE_MS = 60000;

function prismaUniqueError(target) {
  const error = new Error("Unique constraint failed");
  error.code = "P2002";
  error.meta = { target };
  return error;
}

function createFakeClient() {
  let nextId = 1;
  const rows = new Map();

  function clone(row) {
    return row === undefined || row === null ? null : { ...row };
  }

  // Comparable scalar: Dates compare by epoch, numbers by value. Lets one
  // set of gt/gte/lt/lte branches serve both `leaseExpiresAt` (Date) and
  // `attemptCount` (Int) without a per-field special case.
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

  // Prisma's atomic number operations. Applied per row so an increment always
  // reads the row's own current value, exactly as the database would.
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

  // Every column the retry/dead-letter migration added, defaulted exactly as
  // the schema does, so a seeded row behaves like a real one.
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
    const clash = [...rows.values()].find(
      (row) => row.id !== candidateId && row.activeCacheKey === activeCacheKey
    );
    if (clash) throw prismaUniqueError(["activeCacheKey"]);
  }

  const client = {
    __rows: rows,
    __seed(row) {
      const id = nextId;
      nextId += 1;
      rows.set(id, { id, ...RETRY_DEFAULTS, ...row });
      return clone(rows.get(id));
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

function successResult(overrides = {}) {
  return createEnrichmentResult({
    provider: PROVIDER,
    indicatorType: "IPV4",
    indicator: INDICATOR,
    status: ENRICHMENT_STATUS.SUCCESS,
    queriedAt: T0,
    httpStatus: 200,
    data: {
      abuseConfidenceScore: 0,
      totalReports: 0,
      countryCode: "SE",
      isp: "Example ISP",
      domain: null,
      usageType: null,
      isWhitelisted: false,
      lastReportedAt: null,
      ...overrides,
    },
  });
}

function failureResult(status, code, extras = {}) {
  return createEnrichmentResult({
    provider: PROVIDER,
    indicatorType: "IPV4",
    indicator: INDICATOR,
    status,
    queriedAt: T0,
    errorInfo: { code },
    ...extras,
  });
}

function terminalRow(overrides = {}) {
  return {
    provider: PROVIDER,
    indicatorType: "IPV4",
    indicator: INDICATOR,
    queryParams: {},
    queryParamsHash: "hash",
    cacheKey: CACHE_KEY,
    status: ENRICHMENT_STATUS.SUCCESS,
    requestedAt: T0,
    claimedAt: null,
    leaseExpiresAt: null,
    claimToken: null,
    activeCacheKey: null,
    queriedAt: T0,
    expiresAt: new Date(T0.getTime() + 3600000),
    abuseConfidenceScore: 0,
    totalReports: 0,
    countryCode: null,
    isp: null,
    domain: null,
    usageType: null,
    isWhitelisted: null,
    lastReportedAt: null,
    httpStatus: 200,
    errorCode: null,
    errorMessage: null,
    retryAfterSeconds: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe("iocEnrichmentRepository — findFreshCachedResult", () => {
  it("returns a fresh SUCCESS row", async () => {
    const client = createFakeClient();
    client.__seed(terminalRow());
    const found = await findFreshCachedResult(IDENTITY_INPUT, { client, asOf: T0 });
    expect(found).not.toBeNull();
    expect(found.status).toBe(ENRICHMENT_STATUS.SUCCESS);
  });

  it("a successful score of 0 stays distinguishable from an unavailable lookup", async () => {
    const client = createFakeClient();
    client.__seed(terminalRow({ abuseConfidenceScore: 0, totalReports: 0 }));
    const clean = await findFreshCachedResult(IDENTITY_INPUT, { client, asOf: T0 });
    expect(clean.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(clean.abuseConfidenceScore).toBe(0);
    expect(clean.errorCode).toBeNull();

    const other = createFakeClient();
    other.__seed(
      terminalRow({
        status: ENRICHMENT_STATUS.TIMEOUT,
        abuseConfidenceScore: null,
        totalReports: null,
        errorCode: PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT,
      })
    );
    const unavailable = await findFreshCachedResult(IDENTITY_INPUT, { client: other, asOf: T0 });
    expect(unavailable.status).toBe(ENRICHMENT_STATUS.TIMEOUT);
    // The critical distinction: absence of data, never a score of 0.
    expect(unavailable.abuseConfidenceScore).toBeNull();
  });

  it("misses an expired result", async () => {
    const client = createFakeClient();
    client.__seed(terminalRow({ expiresAt: new Date(T0.getTime() - 1) }));
    expect(await findFreshCachedResult(IDENTITY_INPUT, { client, asOf: T0 })).toBeNull();
  });

  it("misses a result whose expiresAt is exactly asOf (exclusive upper bound)", async () => {
    const client = createFakeClient();
    client.__seed(terminalRow({ expiresAt: new Date(T0.getTime()) }));
    expect(await findFreshCachedResult(IDENTITY_INPUT, { client, asOf: T0 })).toBeNull();
  });

  it("misses a result with a null expiresAt", async () => {
    const client = createFakeClient();
    client.__seed(terminalRow({ expiresAt: null }));
    expect(await findFreshCachedResult(IDENTITY_INPUT, { client, asOf: T0 })).toBeNull();
  });

  it("returns a fresh negative result with its exact status, never a clean one", async () => {
    const cases = [
      [ENRICHMENT_STATUS.NOT_FOUND, null],
      [ENRICHMENT_STATUS.RATE_LIMITED, PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED],
      [ENRICHMENT_STATUS.INVALID_KEY, PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY],
      [ENRICHMENT_STATUS.TIMEOUT, PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT],
      [ENRICHMENT_STATUS.FAILED, PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE],
      [ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR, PROVIDER_ERROR_CODES.UNSUPPORTED_INDICATOR],
      [ENRICHMENT_STATUS.SKIPPED_DISABLED, PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED],
    ];
    // eslint-disable-next-line no-restricted-syntax
    for (const [status, errorCode] of cases) {
      const client = createFakeClient();
      client.__seed(
        terminalRow({ status, errorCode, abuseConfidenceScore: null, totalReports: null })
      );
      // eslint-disable-next-line no-await-in-loop
      const found = await findFreshCachedResult(IDENTITY_INPUT, { client, asOf: T0 });
      expect(found.status).toBe(status);
      expect(found.abuseConfidenceScore).toBeNull();
    }
  });

  it("never returns a PENDING row as cached evidence", async () => {
    const client = createFakeClient();
    client.__seed(
      terminalRow({
        status: ENRICHMENT_STATUS.PENDING,
        queriedAt: null,
        expiresAt: new Date(T0.getTime() + 3600000),
        activeCacheKey: CACHE_KEY,
      })
    );
    expect(await findFreshCachedResult(IDENTITY_INPUT, { client, asOf: T0 })).toBeNull();
  });

  it("selects the newest result deterministically, breaking a timestamp tie by highest id", async () => {
    const client = createFakeClient();
    const older = client.__seed(
      terminalRow({ queriedAt: new Date(T0.getTime() - 1000), abuseConfidenceScore: 11 })
    );
    const tieA = client.__seed(terminalRow({ abuseConfidenceScore: 22 }));
    const tieB = client.__seed(terminalRow({ abuseConfidenceScore: 33 }));

    const found = await findFreshCachedResult(IDENTITY_INPUT, { client, asOf: T0 });
    expect(found.id).toBe(tieB.id);
    expect(found.id).toBeGreaterThan(tieA.id);
    expect(found.id).not.toBe(older.id);
  });

  it("does not match a different cache identity", async () => {
    const client = createFakeClient();
    client.__seed(terminalRow());
    const other = await findFreshCachedResult(
      { ...IDENTITY_INPUT, indicator: "198.18.0.11" },
      { client, asOf: T0 }
    );
    expect(other).toBeNull();
  });

  it("requires an explicit asOf", async () => {
    const client = createFakeClient();
    await expect(findFreshCachedResult(IDENTITY_INPUT, { client })).rejects.toThrow(
      IocEnrichmentValidationError
    );
  });
});

describe("enrichmentQueueService — scheduleEnrichment", () => {
  it("returns CACHE_HIT when a fresh terminal result exists and creates no job", async () => {
    const client = createFakeClient();
    client.__seed(terminalRow());
    const outcome = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    expect(outcome.outcome).toBe(SCHEDULE_OUTCOME.CACHE_HIT);
    expect(client.__rows.size).toBe(1);
  });

  it("returns CACHE_HIT for a fresh negative result too — a failure is not re-queried inside its TTL", async () => {
    const client = createFakeClient();
    client.__seed(
      terminalRow({
        status: ENRICHMENT_STATUS.RATE_LIMITED,
        errorCode: PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED,
        abuseConfidenceScore: null,
        totalReports: null,
      })
    );
    const outcome = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    expect(outcome.outcome).toBe(SCHEDULE_OUTCOME.CACHE_HIT);
    expect(outcome.record.status).toBe(ENRICHMENT_STATUS.RATE_LIMITED);
  });

  it("returns SCHEDULED when nothing is cached and nothing is pending", async () => {
    const client = createFakeClient();
    const outcome = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    expect(outcome.outcome).toBe(SCHEDULE_OUTCOME.SCHEDULED);
    expect(outcome.record.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(outcome.record.activeCacheKey).toBe(CACHE_KEY);
    expect(outcome.record.requestedAt).toEqual(T0);
    // No terminal data is invented at scheduling time.
    expect(outcome.record.queriedAt).toBeNull();
    expect(outcome.record.abuseConfidenceScore).toBeNull();
  });

  it("returns ALREADY_PENDING for a second call and creates no second job", async () => {
    const client = createFakeClient();
    const first = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    const second = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    expect(first.outcome).toBe(SCHEDULE_OUTCOME.SCHEDULED);
    expect(second.outcome).toBe(SCHEDULE_OUTCOME.ALREADY_PENDING);
    expect(second.record.id).toBe(first.record.id);
    expect(client.__rows.size).toBe(1);
  });

  it("schedules an expired cache identity again, keeping the old row as history", async () => {
    const client = createFakeClient();
    const historic = client.__seed(terminalRow({ expiresAt: new Date(T0.getTime() - 1) }));
    const outcome = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    expect(outcome.outcome).toBe(SCHEDULE_OUTCOME.SCHEDULED);
    expect(client.__rows.get(historic.id).status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(client.__rows.size).toBe(2);
  });

  it("different cache keys schedule independently", async () => {
    const client = createFakeClient();
    const a = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    const b = await scheduleEnrichment(
      { ...IDENTITY_INPUT, indicator: "198.18.0.11" },
      { client, asOf: T0 }
    );
    const c = await scheduleEnrichment(
      { ...IDENTITY_INPUT, queryParams: { maxAgeInDays: 90 } },
      { client, asOf: T0 }
    );
    expect([a.outcome, b.outcome, c.outcome]).toEqual([
      SCHEDULE_OUTCOME.SCHEDULED,
      SCHEDULE_OUTCOME.SCHEDULED,
      SCHEDULE_OUTCOME.SCHEDULED,
    ]);
    expect(new Set([a.cacheKey, b.cacheKey, c.cacheKey]).size).toBe(3);
  });

  it("recovers from a P2002 uniqueness race without throwing", async () => {
    const client = createFakeClient();
    let injected = false;
    const realCreate = client.iocEnrichment.create.bind(client.iocEnrichment);
    client.iocEnrichment.create = async (args) => {
      if (!injected) {
        injected = true;
        // Simulate a concurrent winner committing between our read and write.
        await realCreate(args);
        throw prismaUniqueError(["activeCacheKey"]);
      }
      return realCreate(args);
    };

    const outcome = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    expect(outcome.outcome).toBe(SCHEDULE_OUTCOME.ALREADY_PENDING);
    expect(client.__rows.size).toBe(1);
  });

  it("does not retry a non-concurrency error", async () => {
    const client = createFakeClient();
    client.iocEnrichment.create = async () => {
      throw new Error("connection refused");
    };
    await expect(scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 })).rejects.toThrow(
      "connection refused"
    );
  });

  it("requires an explicit asOf and a valid identity", async () => {
    const client = createFakeClient();
    await expect(scheduleEnrichment(IDENTITY_INPUT, { client })).rejects.toThrow(
      IocEnrichmentValidationError
    );
    await expect(
      scheduleEnrichment({ ...IDENTITY_INPUT, indicator: "not-an-ip" }, { client, asOf: T0 })
    ).rejects.toThrow(TypeError);
  });
});

describe("iocEnrichmentRepository — queue claiming", () => {
  it("lists claimable candidates in deterministic order without claiming them", async () => {
    const client = createFakeClient();
    await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: new Date(T0.getTime() + 1000) });
    await scheduleEnrichment({ ...IDENTITY_INPUT, indicator: "198.18.0.11" }, { client, asOf: T0 });

    const candidates = await listPendingCandidates({}, { client, asOf: T0 });
    expect(candidates.map((c) => c.indicator)).toEqual(["198.18.0.11", INDICATOR]);
    // Reading did not claim.
    candidates.forEach((c) => expect(c.claimToken).toBeNull());
    expect((await listPendingCandidates({}, { client, asOf: T0 })).length).toBe(2);
  });

  it("excludes a live lease and includes an expired one", async () => {
    const client = createFakeClient();
    const { record } = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });

    expect(await listPendingCandidates({}, { client, asOf: new Date(T0.getTime() + 1000) })).toHaveLength(0);
    expect(
      await listPendingCandidates({}, { client, asOf: new Date(T0.getTime() + LEASE_MS) })
    ).toHaveLength(1);
  });

  it("bounds the batch size", async () => {
    const client = createFakeClient();
    // eslint-disable-next-line no-restricted-syntax
    for (const octet of [10, 11, 12]) {
      // eslint-disable-next-line no-await-in-loop
      await scheduleEnrichment({ ...IDENTITY_INPUT, indicator: `198.18.0.${octet}` }, { client, asOf: T0 });
    }
    expect(await listPendingCandidates({ limit: 2 }, { client, asOf: T0 })).toHaveLength(2);
    await expect(listPendingCandidates({ limit: 0 }, { client, asOf: T0 })).rejects.toThrow(
      IocEnrichmentValidationError
    );
  });

  it("establishes a bounded lease and returns a claim token", async () => {
    const client = createFakeClient();
    const { record } = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });

    expect(typeof claim.claimToken).toBe("string");
    expect(claim.record.claimedAt).toEqual(T0);
    expect(claim.record.leaseExpiresAt).toEqual(new Date(T0.getTime() + LEASE_MS));
    expect(claim.record.status).toBe(ENRICHMENT_STATUS.PENDING);
  });

  it("a second claim against a live lease returns null", async () => {
    const client = createFakeClient();
    const { record } = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    const first = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    const second = await claimPendingJob(record.id, {
      client,
      now: new Date(T0.getTime() + 1),
      leaseMs: LEASE_MS,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("an expired lease is reclaimable with a new token", async () => {
    const client = createFakeClient();
    const { record } = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    const first = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    const reclaimAt = new Date(T0.getTime() + LEASE_MS);
    const second = await claimPendingJob(record.id, { client, now: reclaimAt, leaseMs: LEASE_MS });

    expect(second).not.toBeNull();
    expect(second.claimToken).not.toBe(first.claimToken);
  });

  it("claimPendingBatch claims only what it owns", async () => {
    const client = createFakeClient();
    // eslint-disable-next-line no-restricted-syntax
    for (const octet of [10, 11]) {
      // eslint-disable-next-line no-await-in-loop
      await scheduleEnrichment({ ...IDENTITY_INPUT, indicator: `198.18.0.${octet}` }, { client, asOf: T0 });
    }
    const claimed = await claimPendingBatch({}, { client, now: T0, leaseMs: LEASE_MS });
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((c) => c.claimToken)).size).toBe(2);

    const again = await claimPendingBatch({}, { client, now: T0, leaseMs: LEASE_MS });
    expect(again).toHaveLength(0);
  });

  it("rejects an out-of-bounds lease and an invalid id", async () => {
    const client = createFakeClient();
    await expect(claimPendingJob(1, { client, now: T0, leaseMs: 1 })).rejects.toThrow(
      IocEnrichmentValidationError
    );
    await expect(claimPendingJob(0, { client, now: T0, leaseMs: LEASE_MS })).rejects.toThrow(
      IocEnrichmentValidationError
    );
  });
});

describe("iocEnrichmentRepository — completion", () => {
  async function scheduleAndClaim(client) {
    const { record } = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    return { record, claim };
  }

  it("stores exactly the normalized result fields and frees the cache key", async () => {
    const client = createFakeClient();
    const { record, claim } = await scheduleAndClaim(client);
    const expiresAt = new Date(T0.getTime() + 86400000);

    const done = await completeClaimedJob(
      { id: record.id, claimToken: claim.claimToken, result: successResult({ abuseConfidenceScore: 95, totalReports: 150 }), expiresAt },
      { client }
    );

    expect(done.outcome).toBe(COMPLETION_OUTCOME.COMPLETED);
    expect(done.record.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(done.record.abuseConfidenceScore).toBe(95);
    expect(done.record.totalReports).toBe(150);
    expect(done.record.countryCode).toBe("SE");
    expect(done.record.isp).toBe("Example ISP");
    expect(done.record.isWhitelisted).toBe(false);
    expect(done.record.httpStatus).toBe(200);
    expect(done.record.queriedAt).toEqual(T0);
    expect(done.record.expiresAt).toEqual(expiresAt);
    // Lease + active-job metadata cleared; the row is now history.
    expect(done.record.activeCacheKey).toBeNull();
    expect(done.record.claimToken).toBeNull();
    expect(done.record.leaseExpiresAt).toBeNull();
    // Nothing raw was stored.
    expect(done.record).not.toHaveProperty("rawResponse");
  });

  it("stores no partial data for a failure state", async () => {
    const client = createFakeClient();
    const { record, claim } = await scheduleAndClaim(client);
    const done = await completeClaimedJob(
      {
        id: record.id,
        claimToken: claim.claimToken,
        result: failureResult(ENRICHMENT_STATUS.RATE_LIMITED, PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED, {
          httpStatus: 429,
          retryAfterSeconds: 3600,
        }),
        expiresAt: new Date(T0.getTime() + 900000),
      },
      { client }
    );

    expect(done.record.status).toBe(ENRICHMENT_STATUS.RATE_LIMITED);
    expect(done.record.abuseConfidenceScore).toBeNull();
    expect(done.record.totalReports).toBeNull();
    expect(done.record.countryCode).toBeNull();
    expect(done.record.isp).toBeNull();
    expect(done.record.errorCode).toBe(PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED);
    expect(done.record.retryAfterSeconds).toBe(3600);
  });

  it("persists only the closed-map error message, never a raw Error message or secret", async () => {
    const client = createFakeClient();
    const { record, claim } = await scheduleAndClaim(client);
    const SECRET = "abuseipdb-live-key";
    const base = failureResult(ENRICHMENT_STATUS.FAILED, PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE);
    const tampered = {
      ...base,
      errorInfo: {
        code: PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
        message: `connect ECONNREFUSED https://api.example.test?key=${SECRET}`,
      },
    };

    const done = await completeClaimedJob(
      { id: record.id, claimToken: claim.claimToken, result: tampered, expiresAt: null },
      { client }
    );
    expect(done.record.errorMessage).toBe(
      PROVIDER_ERROR_MESSAGES[PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE]
    );
    expect(JSON.stringify(done.record)).not.toContain(SECRET);
    expect(JSON.stringify(done.record)).not.toContain("ECONNREFUSED");
  });

  it("a null expiresAt means the terminal row is never fresh", async () => {
    const client = createFakeClient();
    const { record, claim } = await scheduleAndClaim(client);
    await completeClaimedJob(
      { id: record.id, claimToken: claim.claimToken, result: successResult(), expiresAt: null },
      { client }
    );
    expect(await findFreshCachedResult(IDENTITY_INPUT, { client, asOf: T0 })).toBeNull();
  });

  it("a wrong claim token cannot complete and changes nothing", async () => {
    const client = createFakeClient();
    const { record } = await scheduleAndClaim(client);
    const done = await completeClaimedJob(
      { id: record.id, claimToken: "not-the-token", result: successResult(), expiresAt: T0 },
      { client }
    );
    expect(done.outcome).toBe(COMPLETION_OUTCOME.NOT_CLAIM_OWNER);
    expect(client.__rows.get(record.id).status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(client.__rows.get(record.id).queriedAt).toBeNull();
  });

  it("a stale token invalidated by an expired-lease reclaim cannot complete", async () => {
    const client = createFakeClient();
    const { record, claim } = await scheduleAndClaim(client);
    const reclaimAt = new Date(T0.getTime() + LEASE_MS);
    const reclaim = await claimPendingJob(record.id, { client, now: reclaimAt, leaseMs: LEASE_MS });

    const stale = await completeClaimedJob(
      { id: record.id, claimToken: claim.claimToken, result: successResult(), expiresAt: T0 },
      { client }
    );
    expect(stale.outcome).toBe(COMPLETION_OUTCOME.NOT_CLAIM_OWNER);

    const fresh = await completeClaimedJob(
      { id: record.id, claimToken: reclaim.claimToken, result: successResult(), expiresAt: T0 },
      { client }
    );
    expect(fresh.outcome).toBe(COMPLETION_OUTCOME.COMPLETED);
  });

  it("cannot complete the same claim twice", async () => {
    const client = createFakeClient();
    const { record, claim } = await scheduleAndClaim(client);
    const first = await completeClaimedJob(
      { id: record.id, claimToken: claim.claimToken, result: successResult(), expiresAt: T0 },
      { client }
    );
    const second = await completeClaimedJob(
      { id: record.id, claimToken: claim.claimToken, result: successResult(), expiresAt: T0 },
      { client }
    );
    expect(first.outcome).toBe(COMPLETION_OUTCOME.COMPLETED);
    expect(second.outcome).toBe(COMPLETION_OUTCOME.NOT_CLAIM_OWNER);
  });

  it("a terminal result is immutable — no later completion can overwrite it", async () => {
    const client = createFakeClient();
    const { record, claim } = await scheduleAndClaim(client);
    await completeClaimedJob(
      {
        id: record.id,
        claimToken: claim.claimToken,
        result: successResult({ abuseConfidenceScore: 95, totalReports: 150 }),
        expiresAt: new Date(T0.getTime() + 3600000),
      },
      { client }
    );

    const overwrite = await completeClaimedJob(
      {
        id: record.id,
        claimToken: claim.claimToken,
        result: failureResult(ENRICHMENT_STATUS.FAILED, PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE),
        expiresAt: T0,
      },
      { client }
    );
    expect(overwrite.outcome).toBe(COMPLETION_OUTCOME.NOT_CLAIM_OWNER);

    const stored = client.__rows.get(record.id);
    expect(stored.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(stored.abuseConfidenceScore).toBe(95);
    expect(stored.errorCode).toBeNull();

    // And the freed cache key allows a genuinely new attempt after expiry.
    const next = await scheduleEnrichment(IDENTITY_INPUT, {
      client,
      asOf: new Date(T0.getTime() + 3600001),
    });
    expect(next.outcome).toBe(SCHEDULE_OUTCOME.SCHEDULED);
    expect(client.__rows.get(record.id).abuseConfidenceScore).toBe(95);
  });

  it("rejects a result whose identity does not match the claimed job", async () => {
    const client = createFakeClient();
    const { record, claim } = await scheduleAndClaim(client);
    const mismatched = createEnrichmentResult({
      provider: "abuseipdb",
      indicatorType: "IPV4",
      indicator: INDICATOR,
      status: ENRICHMENT_STATUS.NOT_FOUND,
      queriedAt: T0,
    });
    await expect(
      completeClaimedJob({ id: record.id, claimToken: claim.claimToken, result: mismatched, expiresAt: T0 }, { client })
    ).rejects.toThrow(IocEnrichmentValidationError);
    expect(client.__rows.get(record.id).status).toBe(ENRICHMENT_STATUS.PENDING);
  });

  it("rejects a PENDING 'result' — a job cannot be completed into a non-terminal status", async () => {
    const client = createFakeClient();
    const { record, claim } = await scheduleAndClaim(client);
    await expect(
      completeClaimedJob(
        {
          id: record.id,
          claimToken: claim.claimToken,
          result: { provider: PROVIDER, indicatorType: "IPV4", indicator: INDICATOR, status: ENRICHMENT_STATUS.PENDING },
          expiresAt: T0,
        },
        { client }
      )
    ).rejects.toThrow(IocEnrichmentValidationError);
  });

  it("an unknown job id fails safely", async () => {
    const client = createFakeClient();
    const done = await completeClaimedJob(
      { id: 4242, claimToken: "whatever", result: successResult(), expiresAt: T0 },
      { client }
    );
    expect(done.outcome).toBe(COMPLETION_OUTCOME.NOT_CLAIM_OWNER);
  });
});

describe("iocEnrichmentRepository — release/abandon", () => {
  it("releases a lease and leaves the job durably PENDING and reclaimable", async () => {
    const client = createFakeClient();
    const { record } = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });

    const released = await releaseClaimedJob({ id: record.id, claimToken: claim.claimToken }, { client });
    expect(released.outcome).toBe(RELEASE_OUTCOME.RELEASED);
    expect(released.record.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(released.record.claimToken).toBeNull();
    expect(released.record.claimedAt).toBeNull();
    expect(released.record.leaseExpiresAt).toBeNull();
    // No terminal status invented on the provider's behalf.
    expect(released.record.queriedAt).toBeNull();
    expect(released.record.errorCode).toBeNull();
    // Still the one active job for this cache key.
    expect(released.record.activeCacheKey).toBe(CACHE_KEY);

    const reclaimed = await claimPendingJob(record.id, {
      client,
      now: new Date(T0.getTime() + 1),
      leaseMs: LEASE_MS,
    });
    expect(reclaimed).not.toBeNull();
  });

  it("a wrong token cannot release someone else's lease", async () => {
    const client = createFakeClient();
    const { record } = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    const released = await releaseClaimedJob({ id: record.id, claimToken: "wrong" }, { client });
    expect(released.outcome).toBe(RELEASE_OUTCOME.NOT_CLAIM_OWNER);
    expect(client.__rows.get(record.id).claimToken).not.toBeNull();
  });

  it("cannot release a completed job", async () => {
    const client = createFakeClient();
    const { record } = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    await completeClaimedJob(
      { id: record.id, claimToken: claim.claimToken, result: successResult(), expiresAt: T0 },
      { client }
    );
    const released = await releaseClaimedJob({ id: record.id, claimToken: claim.claimToken }, { client });
    expect(released.outcome).toBe(RELEASE_OUTCOME.NOT_CLAIM_OWNER);
  });

  it("rejects an empty claim token rather than matching a null one", async () => {
    const client = createFakeClient();
    await expect(releaseClaimedJob({ id: 1, claimToken: "" }, { client })).rejects.toThrow(
      IocEnrichmentValidationError
    );
    await expect(releaseClaimedJob({ id: 1, claimToken: null }, { client })).rejects.toThrow(
      IocEnrichmentValidationError
    );
  });
});

describe("iocEnrichmentRepository — findActiveJobByCacheKey", () => {
  it("finds the one active job and nothing after completion", async () => {
    const client = createFakeClient();
    const { record } = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    expect((await findActiveJobByCacheKey(CACHE_KEY, { client })).id).toBe(record.id);

    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    await completeClaimedJob(
      { id: record.id, claimToken: claim.claimToken, result: successResult(), expiresAt: T0 },
      { client }
    );
    expect(await findActiveJobByCacheKey(CACHE_KEY, { client })).toBeNull();
  });

  it("rejects an empty cache key", async () => {
    const client = createFakeClient();
    await expect(findActiveJobByCacheKey("", { client })).rejects.toThrow(IocEnrichmentValidationError);
  });
});

describe("iocEnrichmentRepository — createPendingJob", () => {
  it("requires an explicit requestedAt", async () => {
    const client = createFakeClient();
    await expect(createPendingJob(IDENTITY_INPUT, { client })).rejects.toThrow(
      IocEnrichmentValidationError
    );
  });

  it("persists the sanitized queryParams and its hash, never caller-supplied extras", async () => {
    const client = createFakeClient();
    const created = await createPendingJob(
      { ...IDENTITY_INPUT, queryParams: { maxAgeInDays: 30, apiKey: "SECRET" } },
      { client, requestedAt: T0 }
    );
    expect(created.queryParams).toEqual({ maxAgeInDays: 30 });
    expect(JSON.stringify(created)).not.toContain("SECRET");
    expect(created.queryParamsHash).toBe(
      buildEnrichmentCacheIdentity({ ...IDENTITY_INPUT, queryParams: { maxAgeInDays: 30 } })
        .queryParamsHash
    );
  });
});
