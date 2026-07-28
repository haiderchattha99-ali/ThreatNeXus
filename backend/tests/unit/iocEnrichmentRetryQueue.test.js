import { describe, it, expect } from "vitest";

const {
  DEAD_LETTER_OUTCOME,
  findFreshCachedResult,
  listPendingCandidates,
  claimPendingJob,
  completeClaimedJob,
  releaseClaimedJob,
  deadLetterClaimedJob,
  deadLetterExhaustedJob,
} = require("../../src/services/enrichment/iocEnrichmentRepository");
const {
  SCHEDULE_OUTCOME,
  scheduleEnrichment,
} = require("../../src/services/enrichment/enrichmentQueueService");
const {
  IocEnrichmentValidationError,
  QUEUE_STATUS,
  ENRICHMENT_TERMINAL_REASON,
  DEFAULT_MAX_ATTEMPTS,
  MAX_MAX_ATTEMPTS,
  isRetryEligibleRecord,
  isAttemptBudgetExhausted,
  isClaimableRecord,
} = require("../../src/services/enrichment/iocEnrichmentCacheRules");
const { buildEnrichmentCacheIdentity } = require("../../src/services/enrichment/enrichmentCacheKey");
const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
  createEnrichmentResult,
} = require("../../src/services/enrichment/iocEnrichmentTypes");

// SCOPE NOTE, mirroring iocEnrichmentRepository.test.js: this in-memory fake
// Prisma client proves the DECISION logic of the P2-T2e-1 attempt budget,
// retry gate and dead-letter transition. It cannot prove that the attempt
// increment is atomic under genuine concurrent connections — that is
// tests/integration/enrichmentRetryDeadLetter.test.js's job.

const PROVIDER = "mock";
const INDICATOR = "198.18.0.10";
const IDENTITY_INPUT = Object.freeze({ provider: PROVIDER, indicatorType: "IPV4", indicator: INDICATOR });
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

  // Dates compare by epoch, numbers by value — one set of comparison branches
  // serves both `leaseExpiresAt` and `attemptCount`.
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

  // Prisma's atomic number operations, evaluated per row against that row's
  // own current value, exactly as the database would.
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

  function assertActiveCacheKeyUnique(candidateId, activeCacheKey) {
    if (activeCacheKey === null || activeCacheKey === undefined) return;
    const clash = [...rows.values()].find((row) => row.id !== candidateId && row.activeCacheKey === activeCacheKey);
    if (clash) throw prismaUniqueError(["activeCacheKey"]);
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
    // Schema defaults for the retry/dead-letter migration.
    attemptCount: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    nextAttemptAt: null,
    lastAttemptAt: null,
    deadLetteredAt: null,
    terminalReasonCode: null,
  };

  return {
    __rows: rows,
    __seed(row) {
      const id = nextId;
      nextId += 1;
      rows.set(id, { id, ...DEFAULTS, createdAt: T0, updatedAt: T0, ...row });
      return clone(rows.get(id));
    },
    iocEnrichment: {
      async create({ data }) {
        const id = nextId;
        nextId += 1;
        assertActiveCacheKeyUnique(id, data.activeCacheKey ?? null);
        const row = { id, ...DEFAULTS, createdAt: data.requestedAt, updatedAt: data.requestedAt, ...data };
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
}

function pendingRow(overrides = {}) {
  return {
    provider: PROVIDER,
    indicatorType: "IPV4",
    indicator: INDICATOR,
    queryParams: {},
    queryParamsHash: "hash",
    cacheKey: CACHE_KEY,
    status: ENRICHMENT_STATUS.PENDING,
    requestedAt: T0,
    activeCacheKey: CACHE_KEY,
    ...overrides,
  };
}

function successResult() {
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
      countryCode: null,
      isp: null,
      domain: null,
      usageType: null,
      isWhitelisted: false,
      lastReportedAt: null,
    },
  });
}

describe("iocEnrichmentCacheRules — pure retry/budget predicates", () => {
  it("treats a null nextAttemptAt as eligible and the exact boundary as eligible", () => {
    expect(isRetryEligibleRecord({ nextAttemptAt: null }, T0)).toBe(true);
    expect(isRetryEligibleRecord({ nextAttemptAt: T0 }, T0)).toBe(true);
    expect(isRetryEligibleRecord({ nextAttemptAt: new Date(T0.getTime() + 1) }, T0)).toBe(false);
  });

  it("reports the budget exhausted at or above maxAttempts", () => {
    expect(isAttemptBudgetExhausted({ attemptCount: 2, maxAttempts: 3 })).toBe(false);
    expect(isAttemptBudgetExhausted({ attemptCount: 3, maxAttempts: 3 })).toBe(true);
    expect(isAttemptBudgetExhausted({ attemptCount: 4, maxAttempts: 3 })).toBe(true);
  });

  it("refuses to call an exhausted or delayed row claimable", () => {
    const base = { status: ENRICHMENT_STATUS.PENDING, claimToken: null, attemptCount: 0, maxAttempts: 3 };
    expect(isClaimableRecord({ ...base }, T0)).toBe(true);
    expect(isClaimableRecord({ ...base, attemptCount: 3 }, T0)).toBe(false);
    expect(isClaimableRecord({ ...base, nextAttemptAt: new Date(T0.getTime() + 1) }, T0)).toBe(false);
    expect(isClaimableRecord({ ...base, status: QUEUE_STATUS.DEAD_LETTER }, T0)).toBe(false);
  });
});

describe("iocEnrichmentRepository — attempt budget", () => {
  it("gives a newly scheduled job a bounded default budget and no retry gate", async () => {
    const client = createFakeClient();
    const { record } = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    expect(record.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(record.attemptCount).toBe(0);
    expect(record.nextAttemptAt).toBeNull();
  });

  it("honours an explicit in-range maxAttempts and rejects an out-of-range one", async () => {
    const client = createFakeClient();
    const { record } = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0, maxAttempts: 5 });
    expect(record.maxAttempts).toBe(5);

    await expect(
      scheduleEnrichment(
        { ...IDENTITY_INPUT, indicator: "198.18.0.99" },
        { client, asOf: T0, maxAttempts: MAX_MAX_ATTEMPTS + 1 }
      )
    ).rejects.toThrow(IocEnrichmentValidationError);
    await expect(
      scheduleEnrichment({ ...IDENTITY_INPUT, indicator: "198.18.0.98" }, { client, asOf: T0, maxAttempts: 0 })
    ).rejects.toThrow(IocEnrichmentValidationError);
  });

  it("increments attemptCount exactly once per successful claim and records lastAttemptAt", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow());

    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    expect(claim).not.toBeNull();
    expect(client.__rows.get(record.id).attemptCount).toBe(1);
    expect(client.__rows.get(record.id).lastAttemptAt).toEqual(T0);
  });

  it("does NOT increment attemptCount for a consumer that loses the claim", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow());

    const winner = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    expect(winner).not.toBeNull();
    expect(client.__rows.get(record.id).attemptCount).toBe(1);

    const loser = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    expect(loser).toBeNull();
    expect(client.__rows.get(record.id).attemptCount).toBe(1);
  });

  it("refuses to claim a job that has already spent its budget", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow({ attemptCount: 3, maxAttempts: 3 }));

    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    expect(claim).toBeNull();
    expect(client.__rows.get(record.id).attemptCount).toBe(3);
  });

  it("release never resets the attempt budget", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow());
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });

    await releaseClaimedJob({ id: record.id, claimToken: claim.claimToken }, { client });
    expect(client.__rows.get(record.id).attemptCount).toBe(1);
  });

  it("refunds exactly one attempt when explicitly asked, never more", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow());
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    expect(client.__rows.get(record.id).attemptCount).toBe(1);

    await releaseClaimedJob({ id: record.id, claimToken: claim.claimToken, refundAttempt: true }, { client });
    expect(client.__rows.get(record.id).attemptCount).toBe(0);
  });
});

describe("iocEnrichmentRepository — retry eligibility", () => {
  it("hides a job whose nextAttemptAt has not been reached", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ nextAttemptAt: new Date(T0.getTime() + 1000) }));
    expect(await listPendingCandidates({}, { client, asOf: T0 })).toHaveLength(0);
  });

  it("lists a job at the exact nextAttemptAt boundary (inclusive)", async () => {
    const client = createFakeClient();
    const nextAttemptAt = new Date(T0.getTime() + 1000);
    client.__seed(pendingRow({ nextAttemptAt }));
    expect(await listPendingCandidates({}, { client, asOf: nextAttemptAt })).toHaveLength(1);
  });

  it("lists a job with a null nextAttemptAt", async () => {
    const client = createFakeClient();
    client.__seed(pendingRow({ nextAttemptAt: null }));
    expect(await listPendingCandidates({}, { client, asOf: T0 })).toHaveLength(1);
  });

  it("persists an explicit nextAttemptAt on release and blocks an early listing afterwards", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow());
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    const nextAttemptAt = new Date(T0.getTime() + 300000);

    await releaseClaimedJob({ id: record.id, claimToken: claim.claimToken, nextAttemptAt }, { client });
    expect(client.__rows.get(record.id).nextAttemptAt).toEqual(nextAttemptAt);

    expect(await listPendingCandidates({}, { client, asOf: new Date(nextAttemptAt.getTime() - 1) })).toHaveLength(0);
    expect(await listPendingCandidates({}, { client, asOf: nextAttemptAt })).toHaveLength(1);
  });

  it("rejects a non-Date nextAttemptAt", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow());
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    await expect(
      releaseClaimedJob({ id: record.id, claimToken: claim.claimToken, nextAttemptAt: "later" }, { client })
    ).rejects.toThrow(IocEnrichmentValidationError);
  });

  it("clears the retry gate when a job completes", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow({ nextAttemptAt: T0 }));
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    await completeClaimedJob(
      { id: record.id, claimToken: claim.claimToken, result: successResult(), expiresAt: new Date(T0.getTime() + 3600000) },
      { client }
    );
    expect(client.__rows.get(record.id).nextAttemptAt).toBeNull();
  });
});

describe("iocEnrichmentRepository — dead-lettering", () => {
  it("retires a claimed job, clearing the active key and every lease field", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow());
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });

    const outcome = await deadLetterClaimedJob(
      {
        id: record.id,
        claimToken: claim.claimToken,
        reasonCode: ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_PROVIDER_ERROR,
      },
      { client, now: T0 }
    );

    expect(outcome.outcome).toBe(DEAD_LETTER_OUTCOME.DEAD_LETTERED);
    const stored = client.__rows.get(record.id);
    expect(stored.status).toBe(QUEUE_STATUS.DEAD_LETTER);
    expect(stored.deadLetteredAt).toEqual(T0);
    expect(stored.terminalReasonCode).toBe(ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_PROVIDER_ERROR);
    expect(stored.activeCacheKey).toBeNull();
    expect(stored.claimToken).toBeNull();
    expect(stored.claimedAt).toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();
    expect(stored.nextAttemptAt).toBeNull();
  });

  it("refuses a wrong or stale claim token and changes nothing", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow());
    await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });

    const outcome = await deadLetterClaimedJob(
      { id: record.id, claimToken: "not-the-owner", reasonCode: ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_EXHAUSTED },
      { client, now: T0 }
    );

    expect(outcome.outcome).toBe(DEAD_LETTER_OUTCOME.NOT_CLAIM_OWNER);
    expect(client.__rows.get(record.id).status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(client.__rows.get(record.id).deadLetteredAt).toBeNull();
  });

  it("cannot overwrite an already-terminal row", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow());
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    await completeClaimedJob(
      { id: record.id, claimToken: claim.claimToken, result: successResult(), expiresAt: new Date(T0.getTime() + 3600000) },
      { client }
    );

    const outcome = await deadLetterClaimedJob(
      { id: record.id, claimToken: claim.claimToken, reasonCode: ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_EXHAUSTED },
      { client, now: T0 }
    );

    expect(outcome.outcome).toBe(DEAD_LETTER_OUTCOME.NOT_CLAIM_OWNER);
    expect(client.__rows.get(record.id).status).toBe(ENRICHMENT_STATUS.SUCCESS);
  });

  it("preserves previously recorded provider evidence on the retired row", async () => {
    const client = createFakeClient();
    const record = client.__seed(
      pendingRow({ httpStatus: 503, errorCode: PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE })
    );
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });

    await deadLetterClaimedJob(
      {
        id: record.id,
        claimToken: claim.claimToken,
        reasonCode: ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_PROVIDER_ERROR,
      },
      { client, now: T0 }
    );

    const stored = client.__rows.get(record.id);
    expect(stored.httpStatus).toBe(503);
    expect(stored.errorCode).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE);
  });

  it("only accepts a closed terminalReasonCode — never free-form exception text", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow());
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });

    await expect(
      deadLetterClaimedJob(
        { id: record.id, claimToken: claim.claimToken, reasonCode: "TypeError: boom at line 42" },
        { client, now: T0 }
      )
    ).rejects.toThrow(IocEnrichmentValidationError);
    expect(client.__rows.get(record.id).status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(client.__rows.get(record.id).terminalReasonCode).toBeNull();
  });

  it("never lists a DEAD_LETTER row as a pending candidate", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow());
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    await deadLetterClaimedJob(
      { id: record.id, claimToken: claim.claimToken, reasonCode: ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_EXHAUSTED },
      { client, now: T0 }
    );

    expect(await listPendingCandidates({}, { client, asOf: new Date(T0.getTime() + 86400000) })).toHaveLength(0);
  });

  it("never returns a DEAD_LETTER row as a fresh cached result", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow());
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    await deadLetterClaimedJob(
      { id: record.id, claimToken: claim.claimToken, reasonCode: ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_EXHAUSTED },
      { client, now: T0 }
    );
    // Even forced to look "fresh", it must never read as reputation evidence:
    // giving up on a job is not a clean address.
    client.__rows.get(record.id).expiresAt = new Date(T0.getTime() + 3600000);
    client.__rows.get(record.id).queriedAt = T0;

    expect(await findFreshCachedResult(IDENTITY_INPUT, { client, asOf: T0 })).toBeNull();
  });

  it("sweeps an exhausted, unleased row without a claim token", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow({ attemptCount: 3, maxAttempts: 3 }));

    const outcome = await deadLetterExhaustedJob({ id: record.id }, { client, now: T0 });
    expect(outcome.outcome).toBe(DEAD_LETTER_OUTCOME.DEAD_LETTERED);
    expect(client.__rows.get(record.id).status).toBe(QUEUE_STATUS.DEAD_LETTER);
    expect(client.__rows.get(record.id).terminalReasonCode).toBe(
      ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_EXHAUSTED
    );
  });

  it("refuses to sweep a row that still has budget left", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow({ attemptCount: 1, maxAttempts: 3 }));

    const outcome = await deadLetterExhaustedJob({ id: record.id }, { client, now: T0 });
    expect(outcome.outcome).toBe(DEAD_LETTER_OUTCOME.NOT_EXHAUSTED);
    expect(client.__rows.get(record.id).status).toBe(ENRICHMENT_STATUS.PENDING);
  });

  it("refuses to sweep a row another worker holds a live lease on", async () => {
    const client = createFakeClient();
    const record = client.__seed(pendingRow({ attemptCount: 2, maxAttempts: 3 }));
    // The claim makes it exhausted AND leased — a job actively being worked.
    await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });

    const outcome = await deadLetterExhaustedJob({ id: record.id }, { client, now: T0 });
    expect(outcome.outcome).toBe(DEAD_LETTER_OUTCOME.NOT_EXHAUSTED);
    expect(client.__rows.get(record.id).status).toBe(ENRICHMENT_STATUS.PENDING);
  });

  it("lets a later explicit scheduling call create a fresh attempt after a dead letter", async () => {
    const client = createFakeClient();
    const { record } = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS });
    await deadLetterClaimedJob(
      {
        id: record.id,
        claimToken: claim.claimToken,
        reasonCode: ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_PROVIDER_ERROR,
      },
      { client, now: T0 }
    );

    // Deliberate re-scheduling (analyst/policy intervention), never automatic.
    const rescheduled = await scheduleEnrichment(IDENTITY_INPUT, { client, asOf: new Date(T0.getTime() + 1000) });
    expect(rescheduled.outcome).toBe(SCHEDULE_OUTCOME.SCHEDULED);
    expect(rescheduled.record.id).not.toBe(record.id);
    expect(rescheduled.record.attemptCount).toBe(0);
    expect(rescheduled.record.status).toBe(ENRICHMENT_STATUS.PENDING);

    // The retired row survives as history, untouched.
    expect(client.__rows.get(record.id).status).toBe(QUEUE_STATUS.DEAD_LETTER);
    // Active-job uniqueness still holds: exactly one active row per cacheKey.
    const active = [...client.__rows.values()].filter((r) => r.activeCacheKey === CACHE_KEY);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(rescheduled.record.id);
  });
});
