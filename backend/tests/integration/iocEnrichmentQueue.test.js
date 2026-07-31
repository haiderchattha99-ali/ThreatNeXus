import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Real-PostgreSQL tests for the P2-T2b IOC enrichment cache/queue. These exist
// because a stubbed/in-memory Prisma client (see
// tests/unit/iocEnrichmentRepository.test.js) cannot prove what actually keeps
// this table correct: the `activeCacheKey` unique constraint under genuine
// concurrent INSERTs, and PostgreSQL's row-lock + WHERE re-evaluation that
// makes the guarded lease UPDATE a real compare-and-swap. Mirrors the scope
// split documented in dedupServiceConcurrency.test.js and
// ownershipConcurrency.test.js.
//
// These tests have teeth: they fail against an implementation that drops the
// active-job unique constraint (tests 1/2) or stops enforcing the claim token
// (tests 3/4/5).
//
// Self-skips unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_test?schema=public" npx vitest run tests/integration/iocEnrichmentQueue.test.js

const { PrismaClient } = require("@prisma/client");
const {
  COMPLETION_OUTCOME,
  RELEASE_OUTCOME,
  findFreshCachedResult,
  findActiveJobByCacheKey,
  listPendingCandidates,
  claimPendingJob,
  completeClaimedJob,
  releaseClaimedJob,
} = require("../../src/services/enrichment/iocEnrichmentRepository");
const {
  SCHEDULE_OUTCOME,
  scheduleEnrichment,
} = require("../../src/services/enrichment/enrichmentQueueService");
const { buildEnrichmentCacheIdentity } = require("../../src/services/enrichment/enrichmentCacheKey");
const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
  createEnrichmentResult,
} = require("../../src/services/enrichment/iocEnrichmentTypes");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// A dedicated provider marker. IocEnrichment has NO foreign key to Finding or
// anything else (cache identity is indicator-level — see D-007), so cleanup is
// a single exact-scoped delete over rows only this file creates. It cannot
// touch, and is not touched by, the Phase 1 evidence chain that
// reportIngestionConcurrency.test.js and eval/run_phase1_gate.js clean up.
const MARKER = "p2t2b-mock";
// RFC 2544 benchmarking range — distinct from 192.0.2.x (P2-T1), 198.51.100.x
// (P1-T4) and 203.0.113.x (phase1-gate fixtures), so nothing here can collide
// with another real-DB suite even when they run together.
const IP_PREFIX = "198.18.0.";

const T0 = new Date("2026-07-28T12:00:00.000Z");
const LEASE_MS = 60000;

let prisma;
// Independent PrismaClients = independent connection pools, i.e. a real
// simulation of N separate processes racing. This matters: `Promise.all` over
// ONE client serializes enough on its pool to hide the race entirely — with
// the unique index dropped, six schedulers on one shared client still produced
// exactly one row, while six separate clients produced six. Every test that
// claims to prove a concurrency invariant here therefore uses separate
// clients, or it would pass against an implementation with no invariant at all.
let racers = [];

async function cleanup() {
  await prisma.iocEnrichment.deleteMany({ where: { provider: { startsWith: MARKER } } });
}

function racerClients(count) {
  while (racers.length < count) {
    racers.push(new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }));
  }
  return racers.slice(0, count);
}

function identityFor(indicator, queryParams = null) {
  return { provider: MARKER, indicatorType: "IPV4", indicator, queryParams };
}

function successResult(indicator, overrides = {}) {
  return createEnrichmentResult({
    provider: MARKER,
    indicatorType: "IPV4",
    indicator,
    status: ENRICHMENT_STATUS.SUCCESS,
    queriedAt: T0,
    httpStatus: 200,
    data: {
      abuseConfidenceScore: 95,
      totalReports: 150,
      countryCode: "SE",
      isp: "Example ISP",
      domain: "example.test",
      usageType: "Data Center",
      isWhitelisted: false,
      lastReportedAt: new Date("2026-07-01T00:00:00.000Z"),
      ...overrides,
    },
  });
}

function failureResult(indicator, status, code, extras = {}) {
  return createEnrichmentResult({
    provider: MARKER,
    indicatorType: "IPV4",
    indicator,
    status,
    queriedAt: T0,
    errorInfo: { code },
    ...extras,
  });
}

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb("P2-T2b IOC enrichment cache/queue — real PostgreSQL", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    // Connect the racers up front so connection setup cannot serialize the
    // very race a test is trying to provoke.
    await Promise.all(racerClients(8).map((client) => client.$connect()));
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await Promise.all(racers.map((client) => client.$disconnect()));
    racers = [];
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
  });

  it("1. concurrent scheduling of one cache key creates exactly one active PENDING row", async () => {
    const indicator = `${IP_PREFIX}10`;
    const identity = identityFor(indicator);
    const { cacheKey } = buildEnrichmentCacheIdentity(identity);

    // Six separate connection pools, all past their cache/active-job checks
    // before any of them writes — the exact window the unique constraint
    // exists to close.
    const outcomes = await Promise.all(
      racerClients(6).map((client) => scheduleEnrichment(identity, { client, asOf: T0 }))
    );

    // No opaque aborted-transaction error surfaced to any caller.
    outcomes.forEach((o) => {
      expect([SCHEDULE_OUTCOME.SCHEDULED, SCHEDULE_OUTCOME.ALREADY_PENDING, SCHEDULE_OUTCOME.CACHE_HIT]).toContain(
        o.outcome
      );
      expect(o.cacheKey).toBe(cacheKey);
    });
    expect(outcomes.filter((o) => o.outcome === SCHEDULE_OUTCOME.SCHEDULED)).toHaveLength(1);

    const rows = await prisma.iocEnrichment.findMany({ where: { cacheKey } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(rows[0].activeCacheKey).toBe(cacheKey);

    // Every caller was pointed at that same one job.
    const ids = new Set(outcomes.map((o) => o.record.id));
    expect(ids.size).toBe(1);
  }, 60000);

  it("1b. the database itself rejects a second active job for one cache key", async () => {
    const indicator = `${IP_PREFIX}11`;
    const identity = identityFor(indicator);
    const { cacheKey, queryParamsHash, queryParams } = buildEnrichmentCacheIdentity(identity);
    await scheduleEnrichment(identity, { client: prisma, asOf: T0 });

    // Bypasses the service entirely — proves the invariant is a constraint,
    // not an application-level check that a future caller could skip.
    await expect(
      prisma.iocEnrichment.create({
        data: {
          provider: MARKER,
          indicatorType: "IPV4",
          indicator,
          queryParams,
          queryParamsHash,
          cacheKey,
          status: ENRICHMENT_STATUS.PENDING,
          requestedAt: T0,
          activeCacheKey: cacheKey,
        },
      })
    ).rejects.toMatchObject({ code: "P2002" });
  }, 60000);

  it("2. different cache keys schedule independently", async () => {
    const identities = [
      identityFor(`${IP_PREFIX}20`),
      identityFor(`${IP_PREFIX}21`),
      identityFor(`${IP_PREFIX}20`, { maxAgeInDays: 90 }),
      { ...identityFor(`${IP_PREFIX}20`), provider: `${MARKER}-alt` },
    ];

    const outcomes = await Promise.all(
      identities.map((identity) => scheduleEnrichment(identity, { client: prisma, asOf: T0 }))
    );
    outcomes.forEach((o) => expect(o.outcome).toBe(SCHEDULE_OUTCOME.SCHEDULED));
    expect(new Set(outcomes.map((o) => o.cacheKey)).size).toBe(4);

    const pending = await prisma.iocEnrichment.count({
      where: { provider: { startsWith: MARKER }, status: ENRICHMENT_STATUS.PENDING },
    });
    expect(pending).toBe(4);
  }, 60000);

  it("3. concurrent claiming yields exactly one live lease owner", async () => {
    const indicator = `${IP_PREFIX}30`;
    const { record } = await scheduleEnrichment(identityFor(indicator), { client: prisma, asOf: T0 });

    const attempts = await Promise.all(
      racerClients(8).map((client) => claimPendingJob(record.id, { client, now: T0, leaseMs: LEASE_MS }))
    );

    const winners = attempts.filter(Boolean);
    expect(winners).toHaveLength(1);

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(stored.claimToken).toBe(winners[0].claimToken);
    expect(stored.leaseExpiresAt).toEqual(new Date(T0.getTime() + LEASE_MS));
    expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);

    // A live lease is not listed as claimable.
    const candidates = await listPendingCandidates({}, { client: prisma, asOf: T0 });
    expect(candidates.map((c) => c.id)).not.toContain(record.id);
  }, 60000);

  it("4. an expired lease is reclaimable; the old token can no longer complete, the new one can", async () => {
    const indicator = `${IP_PREFIX}40`;
    const { record } = await scheduleEnrichment(identityFor(indicator), { client: prisma, asOf: T0 });

    const first = await claimPendingJob(record.id, { client: prisma, now: T0, leaseMs: LEASE_MS });
    expect(first).not.toBeNull();

    const reclaimAt = new Date(T0.getTime() + LEASE_MS);
    const expiredCandidates = await listPendingCandidates({}, { client: prisma, asOf: reclaimAt });
    expect(expiredCandidates.map((c) => c.id)).toContain(record.id);

    const second = await claimPendingJob(record.id, { client: prisma, now: reclaimAt, leaseMs: LEASE_MS });
    expect(second).not.toBeNull();
    expect(second.claimToken).not.toBe(first.claimToken);

    const stale = await completeClaimedJob(
      { id: record.id, claimToken: first.claimToken, result: successResult(indicator), expiresAt: T0 },
      { client: prisma }
    );
    expect(stale.outcome).toBe(COMPLETION_OUTCOME.NOT_CLAIM_OWNER);
    expect((await prisma.iocEnrichment.findUnique({ where: { id: record.id } })).status).toBe(
      ENRICHMENT_STATUS.PENDING
    );

    const done = await completeClaimedJob(
      {
        id: record.id,
        claimToken: second.claimToken,
        result: successResult(indicator),
        expiresAt: new Date(T0.getTime() + 3600000),
      },
      { client: prisma }
    );
    expect(done.outcome).toBe(COMPLETION_OUTCOME.COMPLETED);
  }, 60000);

  it("4b. terminal completion and expired-lease reclamation cannot both succeed", async () => {
    const indicator = `${IP_PREFIX}41`;
    const { record } = await scheduleEnrichment(identityFor(indicator), { client: prisma, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client: prisma, now: T0, leaseMs: LEASE_MS });
    const atExpiry = new Date(T0.getTime() + LEASE_MS);

    const [completer, reclaimer] = racerClients(2);
    const [completion, reclaim] = await Promise.all([
      completeClaimedJob(
        {
          id: record.id,
          claimToken: claim.claimToken,
          result: successResult(indicator),
          expiresAt: new Date(T0.getTime() + 3600000),
        },
        { client: completer }
      ),
      claimPendingJob(record.id, { client: reclaimer, now: atExpiry, leaseMs: LEASE_MS }),
    ]);

    const completed = completion.outcome === COMPLETION_OUTCOME.COMPLETED;
    const reclaimed = reclaim !== null;
    expect(completed || reclaimed).toBe(true);
    expect(completed && reclaimed).toBe(false);

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    if (completed) {
      expect(stored.status).toBe(ENRICHMENT_STATUS.SUCCESS);
      expect(stored.activeCacheKey).toBeNull();
    } else {
      expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);
      expect(stored.claimToken).toBe(reclaim.claimToken);
      expect(stored.queriedAt).toBeNull();
    }
  }, 60000);

  it("5. exactly one terminal completion wins a race, and the row is immutable afterwards", async () => {
    const indicator = `${IP_PREFIX}50`;
    const { record } = await scheduleEnrichment(identityFor(indicator), { client: prisma, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client: prisma, now: T0, leaseMs: LEASE_MS });
    const expiresAt = new Date(T0.getTime() + 3600000);

    const attempts = await Promise.all(
      racerClients(5).map((client) =>
        completeClaimedJob(
          { id: record.id, claimToken: claim.claimToken, result: successResult(indicator), expiresAt },
          { client }
        )
      )
    );
    expect(attempts.filter((a) => a.outcome === COMPLETION_OUTCOME.COMPLETED)).toHaveLength(1);

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(stored.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(stored.abuseConfidenceScore).toBe(95);
    expect(stored.activeCacheKey).toBeNull();
    expect(stored.claimToken).toBeNull();

    // Immutable: neither a completion nor a release can touch it again.
    const overwrite = await completeClaimedJob(
      {
        id: record.id,
        claimToken: claim.claimToken,
        result: failureResult(indicator, ENRICHMENT_STATUS.FAILED, PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE),
        expiresAt,
      },
      { client: prisma }
    );
    expect(overwrite.outcome).toBe(COMPLETION_OUTCOME.NOT_CLAIM_OWNER);
    const release = await releaseClaimedJob({ id: record.id, claimToken: claim.claimToken }, { client: prisma });
    expect(release.outcome).toBe(RELEASE_OUTCOME.NOT_CLAIM_OWNER);

    const after = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(after.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(after.abuseConfidenceScore).toBe(95);
    expect(after.errorCode).toBeNull();
  }, 60000);

  it("6. a completed attempt stays as history; a later attempt after expiry inserts a new row", async () => {
    const indicator = `${IP_PREFIX}60`;
    const identity = identityFor(indicator);
    const { cacheKey } = buildEnrichmentCacheIdentity(identity);
    const expiresAt = new Date(T0.getTime() + 3600000);

    const first = await scheduleEnrichment(identity, { client: prisma, asOf: T0 });
    const claim = await claimPendingJob(first.record.id, { client: prisma, now: T0, leaseMs: LEASE_MS });
    await completeClaimedJob(
      { id: first.record.id, claimToken: claim.claimToken, result: successResult(indicator, { abuseConfidenceScore: 10, totalReports: 2 }), expiresAt },
      { client: prisma }
    );

    // Inside the TTL: cache hit, no new row.
    const insideTtl = await scheduleEnrichment(identity, {
      client: prisma,
      asOf: new Date(expiresAt.getTime() - 1),
    });
    expect(insideTtl.outcome).toBe(SCHEDULE_OUTCOME.CACHE_HIT);
    expect(insideTtl.record.id).toBe(first.record.id);
    expect(await prisma.iocEnrichment.count({ where: { cacheKey } })).toBe(1);

    // At/after expiry: a genuinely new attempt, prior result preserved.
    const afterTtl = await scheduleEnrichment(identity, { client: prisma, asOf: expiresAt });
    expect(afterTtl.outcome).toBe(SCHEDULE_OUTCOME.SCHEDULED);
    expect(afterTtl.record.id).not.toBe(first.record.id);

    const claim2 = await claimPendingJob(afterTtl.record.id, {
      client: prisma,
      now: expiresAt,
      leaseMs: LEASE_MS,
    });
    await completeClaimedJob(
      {
        id: afterTtl.record.id,
        claimToken: claim2.claimToken,
        result: failureResult(indicator, ENRICHMENT_STATUS.RATE_LIMITED, PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED, {
          httpStatus: 429,
          retryAfterSeconds: 3600,
        }),
        expiresAt: new Date(expiresAt.getTime() + 900000),
      },
      { client: prisma }
    );

    const history = await prisma.iocEnrichment.findMany({
      where: { cacheKey },
      orderBy: [{ queriedAt: "asc" }, { id: "asc" }],
    });
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(history[0].abuseConfidenceScore).toBe(10);
    expect(history[1].status).toBe(ENRICHMENT_STATUS.RATE_LIMITED);
    // Multiple terminal history rows coexist: the unique constraint is on
    // activeCacheKey (all null here), never on cacheKey itself.
    expect(history.every((row) => row.activeCacheKey === null)).toBe(true);

    // The newest applicable result wins deterministically — and it is the
    // failure, returned as that exact failure, never as clean context.
    const fresh = await findFreshCachedResult(identity, {
      client: prisma,
      asOf: new Date(expiresAt.getTime() + 1),
    });
    expect(fresh.id).toBe(history[1].id);
    expect(fresh.status).toBe(ENRICHMENT_STATUS.RATE_LIMITED);
    expect(fresh.abuseConfidenceScore).toBeNull();
  }, 60000);

  it("7. a forced failure during completion rolls back to the durable PENDING/leased state with no partial data", async () => {
    const indicator = `${IP_PREFIX}70`;
    const identity = identityFor(indicator);
    const { cacheKey } = buildEnrichmentCacheIdentity(identity);
    const { record } = await scheduleEnrichment(identity, { client: prisma, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client: prisma, now: T0, leaseMs: LEASE_MS });

    await expect(
      prisma.$transaction(async (tx) => {
        const done = await completeClaimedJob(
          {
            id: record.id,
            claimToken: claim.claimToken,
            result: successResult(indicator),
            expiresAt: new Date(T0.getTime() + 3600000),
          },
          { client: tx }
        );
        expect(done.outcome).toBe(COMPLETION_OUTCOME.COMPLETED);
        throw new Error("forced failure after the terminal write");
      })
    ).rejects.toThrow("forced failure");

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(stored.claimToken).toBe(claim.claimToken);
    expect(stored.leaseExpiresAt).toEqual(new Date(T0.getTime() + LEASE_MS));
    // Not one field of normalized data survived the rollback.
    expect(stored.queriedAt).toBeNull();
    expect(stored.expiresAt).toBeNull();
    expect(stored.abuseConfidenceScore).toBeNull();
    expect(stored.totalReports).toBeNull();
    expect(stored.countryCode).toBeNull();
    expect(stored.isp).toBeNull();
    expect(stored.errorCode).toBeNull();
    // The job is still the one active job for its cache key, so scheduling
    // still recognises it rather than creating a duplicate.
    expect(stored.activeCacheKey).toBe(cacheKey);
    expect((await findActiveJobByCacheKey(cacheKey, { client: prisma })).id).toBe(record.id);
    const rescheduled = await scheduleEnrichment(identity, { client: prisma, asOf: T0 });
    expect(rescheduled.outcome).toBe(SCHEDULE_OUTCOME.ALREADY_PENDING);

    // And the lease survived intact, so its owner can still complete for real.
    const retried = await completeClaimedJob(
      {
        id: record.id,
        claimToken: claim.claimToken,
        result: successResult(indicator),
        expiresAt: new Date(T0.getTime() + 3600000),
      },
      { client: prisma }
    );
    expect(retried.outcome).toBe(COMPLETION_OUTCOME.COMPLETED);
  }, 60000);

  it("8. cache expiry boundaries are exact and inclusive/exclusive as documented", async () => {
    const indicator = `${IP_PREFIX}80`;
    const identity = identityFor(indicator);
    const expiresAt = new Date(T0.getTime() + 3600000);

    const { record } = await scheduleEnrichment(identity, { client: prisma, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client: prisma, now: T0, leaseMs: LEASE_MS });
    await completeClaimedJob(
      { id: record.id, claimToken: claim.claimToken, result: successResult(indicator), expiresAt },
      { client: prisma }
    );

    // [queriedAt, expiresAt) — fresh strictly before, stale at and after.
    expect(
      (await findFreshCachedResult(identity, { client: prisma, asOf: new Date(expiresAt.getTime() - 1) })).id
    ).toBe(record.id);
    expect(
      await findFreshCachedResult(identity, { client: prisma, asOf: new Date(expiresAt.getTime()) })
    ).toBeNull();
    expect(
      await findFreshCachedResult(identity, { client: prisma, asOf: new Date(expiresAt.getTime() + 1) })
    ).toBeNull();
  }, 60000);

  it("8b. a terminal row with a null expiresAt is never a cache hit", async () => {
    const indicator = `${IP_PREFIX}81`;
    const identity = identityFor(indicator);
    const { record } = await scheduleEnrichment(identity, { client: prisma, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client: prisma, now: T0, leaseMs: LEASE_MS });
    await completeClaimedJob(
      {
        id: record.id,
        claimToken: claim.claimToken,
        result: failureResult(indicator, ENRICHMENT_STATUS.TIMEOUT, PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT),
        expiresAt: null,
      },
      { client: prisma }
    );

    expect(await findFreshCachedResult(identity, { client: prisma, asOf: T0 })).toBeNull();
    // ...and the cache key is free, so a fresh attempt can be scheduled at once.
    const next = await scheduleEnrichment(identity, { client: prisma, asOf: T0 });
    expect(next.outcome).toBe(SCHEDULE_OUTCOME.SCHEDULED);
  }, 60000);

  it("9. a PENDING row is never returned as cached evidence, however long it sits", async () => {
    const indicator = `${IP_PREFIX}90`;
    const identity = identityFor(indicator);
    await scheduleEnrichment(identity, { client: prisma, asOf: T0 });

    expect(await findFreshCachedResult(identity, { client: prisma, asOf: T0 })).toBeNull();
    expect(
      await findFreshCachedResult(identity, { client: prisma, asOf: new Date(T0.getTime() + 86400000) })
    ).toBeNull();
  }, 60000);

  it("10. no raw response body, credential, or free-text error reaches any column", async () => {
    const indicator = `${IP_PREFIX}95`;
    const SECRET = "abuseipdb-live-key-must-never-persist";
    const identity = identityFor(indicator, { maxAgeInDays: 30, apiKey: SECRET, key: SECRET });

    const { record } = await scheduleEnrichment(identity, { client: prisma, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client: prisma, now: T0, leaseMs: LEASE_MS });

    const base = failureResult(indicator, ENRICHMENT_STATUS.FAILED, PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE, {
      httpStatus: 200,
    });
    const tampered = {
      ...base,
      errorInfo: {
        code: PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE,
        message: `SyntaxError parsing https://api.example.test/check?key=${SECRET}`,
      },
    };
    await completeClaimedJob(
      { id: record.id, claimToken: claim.claimToken, result: tampered, expiresAt: new Date(T0.getTime() + 60000) },
      { client: prisma }
    );

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(stored).not.toHaveProperty("rawResponse");
    expect(stored.queryParams).toEqual({ maxAgeInDays: 30 });
    expect(stored.errorMessage).toBe("Provider returned a response that could not be parsed.");
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(JSON.stringify(stored)).not.toContain("SyntaxError");
  }, 60000);

  it("11. releasing a lease returns the job to the queue without inventing a result", async () => {
    const indicator = `${IP_PREFIX}96`;
    const identity = identityFor(indicator);
    const { record } = await scheduleEnrichment(identity, { client: prisma, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client: prisma, now: T0, leaseMs: LEASE_MS });

    const released = await releaseClaimedJob({ id: record.id, claimToken: claim.claimToken }, { client: prisma });
    expect(released.outcome).toBe(RELEASE_OUTCOME.RELEASED);
    expect(released.record.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(released.record.queriedAt).toBeNull();
    expect(released.record.errorCode).toBeNull();

    const candidates = await listPendingCandidates({}, { client: prisma, asOf: T0 });
    expect(candidates.map((c) => c.id)).toContain(record.id);

    const reclaim = await claimPendingJob(record.id, { client: prisma, now: T0, leaseMs: LEASE_MS });
    expect(reclaim).not.toBeNull();
    expect(reclaim.claimToken).not.toBe(claim.claimToken);
  }, 60000);
});
