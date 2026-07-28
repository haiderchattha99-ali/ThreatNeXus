import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Real-PostgreSQL tests for the P2-T2d bounded enrichment runner. Mirrors the
// scope split already documented in iocEnrichmentQueue.test.js: an in-memory
// fake Prisma client (tests/unit/enrichmentRunner.test.js) proves DECISION
// logic, but only genuine concurrent connections can prove the claim
// guard actually resolves a real race between two runner invocations, and
// that a forced write failure leaves no partial terminal row behind.
//
// Self-skips unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_test?schema=public" npx vitest run tests/integration/enrichmentRunner.test.js

const { PrismaClient } = require("@prisma/client");
const { runEnrichmentBatch } = require("../../src/services/enrichment/enrichmentRunner");
const { RUNNER_OUTCOME } = require("../../src/services/enrichment/enrichmentRunnerTypes");
const { scheduleEnrichment } = require("../../src/services/enrichment/enrichmentQueueService");
const { claimPendingJob, completeClaimedJob, COMPLETION_OUTCOME } = require("../../src/services/enrichment/iocEnrichmentRepository");
const { ENRICHMENT_STATUS, createEnrichmentResult } = require("../../src/services/enrichment/iocEnrichmentTypes");
const { resolveEnrichmentTtl } = require("../../src/services/enrichment/enrichmentTtlPolicy");
const { resolveEnrichmentRetry } = require("../../src/services/enrichment/enrichmentRetryPolicy");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Dedicated marker + a third-octet slice of the RFC 2544 benchmarking range
// distinct from every other suite sharing 198.18.0.0/15: P2-T2b's real-DB
// queue suite already owns 198.18.0.x under marker "p2t2b-mock". IocEnrichment
// has no FK to anything else, so cleanup is a single exact-scoped delete that
// cannot touch, and is not touched by, any other suite's evidence.
const MARKER = "p2t2d-mock";
const IP_PREFIX = "198.19.0.";

const T0 = new Date("2026-07-28T12:00:00.000Z");
const LEASE_SECONDS = 60;

let prisma;
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

// A runner batch is a GLOBAL queue consumer by design: it claims whatever is
// pending. That is correct in production and hostile in a shared test
// database, where vitest runs integration files in parallel — an unscoped
// batch here would claim, delay and (since P2-T2e-1) eventually dead-letter
// the rows belonging to iocEnrichmentQueue.test.js.
//
// So the worker gets a scoped view: a thin delegate whose candidate LISTING
// is filtered to this suite's marker. Nothing else is changed — the claim,
// completion and release statements are the real, unscoped ones, so every
// concurrency guarantee under test is still the production one.
function scopedClient(client) {
  return {
    auditLog: client.auditLog,
    iocEnrichment: {
      findMany: (args = {}) =>
        client.iocEnrichment.findMany({
          ...args,
          where: { ...(args.where || {}), provider: { startsWith: MARKER } },
        }),
      findUnique: (args) => client.iocEnrichment.findUnique(args),
      findFirst: (args) => client.iocEnrichment.findFirst(args),
      create: (args) => client.iocEnrichment.create(args),
      update: (args) => client.iocEnrichment.update(args),
      updateMany: (args) => client.iocEnrichment.updateMany(args),
    },
  };
}

function identityFor(providerName, indicator, queryParams = null) {
  return { provider: providerName, indicatorType: "IPV4", indicator, queryParams };
}

function successResult(providerName, indicator, overrides = {}) {
  return createEnrichmentResult({
    provider: providerName,
    indicatorType: "IPV4",
    indicator,
    status: ENRICHMENT_STATUS.SUCCESS,
    queriedAt: T0,
    httpStatus: 200,
    data: {
      abuseConfidenceScore: 10,
      totalReports: 1,
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

function registryOf(map) {
  return {
    resolve(name) {
      if (!Object.prototype.hasOwnProperty.call(map, name)) throw new Error(`no such provider: ${name}`);
      return map[name];
    },
  };
}

function runnerOptions(overrides = {}) {
  return {
    now: T0,
    batchSize: 10,
    leaseDurationSeconds: LEASE_SECONDS,
    ttlPolicy: resolveEnrichmentTtl,
    retryPolicy: resolveEnrichmentRetry,
    workerId: "worker-1",
    ...overrides,
  };
}

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb("P2-T2d bounded enrichment runner — real PostgreSQL", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await Promise.all(racerClients(4).map((client) => client.$connect()));
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

  it("1. completes a claimed job, persisting terminal fields exactly and clearing lease metadata", async () => {
    const indicator = `${IP_PREFIX}10`;
    const providerName = `${MARKER}-p1`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), { client: prisma, asOf: T0 });
    const provider = fakeProvider(providerName, () =>
      successResult(providerName, indicator, { abuseConfidenceScore: 42, totalReports: 7, countryCode: "SE" })
    );

    const summary = await runEnrichmentBatch({
      ...runnerOptions(),
      prisma: scopedClient(prisma),
      providerRegistry: registryOf({ [providerName]: provider }),
    });

    expect(summary.completedCount).toBe(1);
    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETED);

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(stored.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(stored.abuseConfidenceScore).toBe(42);
    expect(stored.totalReports).toBe(7);
    expect(stored.countryCode).toBe("SE");
    expect(stored.activeCacheKey).toBeNull();
    expect(stored.claimToken).toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();
  }, 60000);

  it("2. two runners racing for one job: exactly one provider call and one completion; the loser reports safely", async () => {
    const indicator = `${IP_PREFIX}20`;
    const providerName = `${MARKER}-p2`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), { client: prisma, asOf: T0 });

    const [clientA, clientB] = racerClients(2);
    const providerA = fakeProvider(providerName, () => successResult(providerName, indicator));
    const providerB = fakeProvider(providerName, () => successResult(providerName, indicator));

    const [summaryA, summaryB] = await Promise.all([
      runEnrichmentBatch({
        ...runnerOptions({ workerId: "worker-a" }),
        prisma: scopedClient(clientA),
        providerRegistry: registryOf({ [providerName]: providerA }),
      }),
      runEnrichmentBatch({
        ...runnerOptions({ workerId: "worker-b" }),
        prisma: scopedClient(clientB),
        providerRegistry: registryOf({ [providerName]: providerB }),
      }),
    ]);

    expect(providerA.getCalls().length + providerB.getCalls().length).toBe(1);
    const outcomes = [...summaryA.results, ...summaryB.results].map((r) => r.outcome);
    expect(outcomes.filter((o) => o === RUNNER_OUTCOME.COMPLETED)).toHaveLength(1);
    expect(outcomes.filter((o) => o === RUNNER_OUTCOME.SKIPPED_NOT_CLAIMED)).toHaveLength(1);

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(stored.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(stored.claimToken).toBeNull();
  }, 60000);

  it("3. a lease expiring mid-lookup lets another worker reclaim; the stale worker cannot complete", async () => {
    const indicator = `${IP_PREFIX}30`;
    const providerName = `${MARKER}-p3`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), { client: prisma, asOf: T0 });

    // Worker A claims directly (simulating the runner's own internal claim
    // step) with a short lease, then is imagined to be mid-provider-call when
    // its lease expires.
    const shortLeaseMs = 1000;
    const claimA = await claimPendingJob(record.id, { client: prisma, now: T0, leaseMs: shortLeaseMs });
    expect(claimA).not.toBeNull();

    const reclaimAt = new Date(T0.getTime() + shortLeaseMs);
    const [clientB] = racerClients(1);
    const providerB = fakeProvider(providerName, () => successResult(providerName, indicator, { abuseConfidenceScore: 5, totalReports: 1 }));

    const summaryB = await runEnrichmentBatch({
      ...runnerOptions({ now: reclaimAt, workerId: "worker-b" }),
      prisma: scopedClient(clientB),
      providerRegistry: registryOf({ [providerName]: providerB }),
    });

    expect(summaryB.completedCount).toBe(1);
    expect(providerB.getCalls()).toHaveLength(1);

    // Worker A's provider call finishes "late" and tries to complete with its
    // now-stale token — must be rejected safely, changing nothing.
    const staleCompletion = await completeClaimedJob(
      { id: record.id, claimToken: claimA.claimToken, result: successResult(providerName, indicator), expiresAt: new Date(T0.getTime() + 3600000) },
      { client: prisma }
    );
    expect(staleCompletion.outcome).toBe(COMPLETION_OUTCOME.NOT_CLAIM_OWNER);

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(stored.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(stored.abuseConfidenceScore).toBe(5);
  }, 60000);

  it("4. a forced completion-write failure leaves no partial terminal fields; the job stays in its prior valid state", async () => {
    const indicator = `${IP_PREFIX}40`;
    const providerName = `${MARKER}-p4`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), { client: prisma, asOf: T0 });
    const provider = fakeProvider(providerName, () => successResult(providerName, indicator));

    const [client] = racerClients(1);
    const realUpdateMany = client.iocEnrichment.updateMany.bind(client.iocEnrichment);
    // Force only the COMPLETION write (identifiable by `data.status` being
    // set — the claim write never sets `status`) to fail, simulating a
    // dropped connection after the provider call already succeeded.
    client.iocEnrichment.updateMany = async (args) => {
      if (args.data && "status" in args.data) {
        throw new Error("simulated database failure during completion");
      }
      return realUpdateMany(args);
    };

    let summary;
    try {
      summary = await runEnrichmentBatch({
        ...runnerOptions(),
        prisma: scopedClient(client),
        providerRegistry: registryOf({ [providerName]: provider }),
      });
    } finally {
      client.iocEnrichment.updateMany = realUpdateMany;
    }

    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETION_FAILED);
    expect(JSON.stringify(summary)).not.toContain("simulated database failure");

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(stored.queriedAt).toBeNull();
    expect(stored.abuseConfidenceScore).toBeNull();
    expect(stored.claimToken).not.toBeNull(); // the live lease from the claim genuinely survives

    // The prior valid state (a live, still-owned lease) can still complete
    // for real once the failure is gone — proving nothing was corrupted.
    const retried = await completeClaimedJob(
      { id: record.id, claimToken: stored.claimToken, result: successResult(providerName, indicator), expiresAt: new Date(T0.getTime() + 3600000) },
      { client: prisma }
    );
    expect(retried.outcome).toBe(COMPLETION_OUTCOME.COMPLETED);
  }, 60000);

  it("5. a mixed batch (success, negative, unknown provider, internal exception) completes independently", async () => {
    const providerName = `${MARKER}-p5`;
    const successIndicator = `${IP_PREFIX}51`;
    const negativeIndicator = `${IP_PREFIX}52`;
    const unknownIndicator = `${IP_PREFIX}53`;
    const explodingIndicator = `${IP_PREFIX}54`;

    const seeded = {};
    seeded.success = (await scheduleEnrichment(identityFor(providerName, successIndicator), { client: prisma, asOf: T0 })).record;
    seeded.negative = (
      await scheduleEnrichment(identityFor(providerName, negativeIndicator), { client: prisma, asOf: new Date(T0.getTime() + 1) })
    ).record;
    seeded.unknown = (
      await scheduleEnrichment(identityFor(`${MARKER}-ghost`, unknownIndicator), { client: prisma, asOf: new Date(T0.getTime() + 2) })
    ).record;
    seeded.exploding = (
      await scheduleEnrichment(identityFor(providerName, explodingIndicator), { client: prisma, asOf: new Date(T0.getTime() + 3) })
    ).record;

    const provider = fakeProvider(providerName, (input) => {
      if (input.indicator === successIndicator) return successResult(providerName, successIndicator);
      if (input.indicator === negativeIndicator) {
        return createEnrichmentResult({
          provider: providerName,
          indicatorType: "IPV4",
          indicator: negativeIndicator,
          status: ENRICHMENT_STATUS.NOT_FOUND,
          queriedAt: T0,
        });
      }
      if (input.indicator === explodingIndicator) throw new TypeError("boom");
      throw new Error(`unexpected indicator ${input.indicator}`);
    });

    const summary = await runEnrichmentBatch({
      ...runnerOptions({ batchSize: 10 }),
      prisma: scopedClient(prisma),
      providerRegistry: registryOf({ [providerName]: provider }),
    });

    expect(summary.candidateCount).toBe(4);
    const outcomesByIndicator = new Map(summary.results.map((r) => [r.indicator, r.outcome]));
    expect(outcomesByIndicator.get(successIndicator)).toBe(RUNNER_OUTCOME.COMPLETED);
    expect(outcomesByIndicator.get(negativeIndicator)).toBe(RUNNER_OUTCOME.COMPLETED);
    expect(outcomesByIndicator.get(unknownIndicator)).toBe(RUNNER_OUTCOME.UNKNOWN_PROVIDER);
    expect(outcomesByIndicator.get(explodingIndicator)).toBe(RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR);

    const successRow = await prisma.iocEnrichment.findUnique({ where: { id: seeded.success.id } });
    expect(successRow.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    const negativeRow = await prisma.iocEnrichment.findUnique({ where: { id: seeded.negative.id } });
    expect(negativeRow.status).toBe(ENRICHMENT_STATUS.NOT_FOUND);
    const unknownRow = await prisma.iocEnrichment.findUnique({ where: { id: seeded.unknown.id } });
    expect(unknownRow.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(unknownRow.claimToken).toBeNull();
    const explodingRow = await prisma.iocEnrichment.findUnique({ where: { id: seeded.exploding.id } });
    expect(explodingRow.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(explodingRow.claimToken).toBeNull();
  }, 60000);

  it("6. a repeated runner invocation never reprocesses a terminal row", async () => {
    const indicator = `${IP_PREFIX}60`;
    const providerName = `${MARKER}-p6`;
    await scheduleEnrichment(identityFor(providerName, indicator), { client: prisma, asOf: T0 });
    const provider = fakeProvider(providerName, () => successResult(providerName, indicator));
    const registry = registryOf({ [providerName]: provider });

    const first = await runEnrichmentBatch({
      ...runnerOptions(),
      prisma: scopedClient(prisma),
      providerRegistry: registry,
    });
    expect(first.completedCount).toBe(1);

    const second = await runEnrichmentBatch({
      ...runnerOptions({ now: new Date(T0.getTime() + 60000) }),
      prisma: scopedClient(prisma),
      providerRegistry: registry,
    });
    expect(second.candidateCount).toBe(0);
    expect(provider.getCalls()).toHaveLength(1);
  }, 60000);

  it("7. a batch never processes more than batchSize, in deterministic requestedAt/id order", async () => {
    const providerName = `${MARKER}-p7`;
    const indicators = [70, 71, 72, 73, 74].map((n) => `${IP_PREFIX}${n}`);
    const records = [];
    // eslint-disable-next-line no-restricted-syntax
    for (let i = 0; i < indicators.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { record } = await scheduleEnrichment(identityFor(providerName, indicators[i]), {
        client: prisma,
        asOf: new Date(T0.getTime() + i),
      });
      records.push(record);
    }

    const seenOrder = [];
    const provider = fakeProvider(providerName, (input) => {
      seenOrder.push(input.indicator);
      return successResult(providerName, input.indicator);
    });

    const summary = await runEnrichmentBatch({
      ...runnerOptions({ batchSize: 3 }),
      prisma: scopedClient(prisma),
      providerRegistry: registryOf({ [providerName]: provider }),
    });

    expect(summary.candidateCount).toBe(3);
    expect(summary.completedCount).toBe(3);
    expect(seenOrder).toEqual(indicators.slice(0, 3));

    const untouched = await prisma.iocEnrichment.findMany({
      where: { id: { in: [records[3].id, records[4].id] } },
    });
    untouched.forEach((row) => {
      expect(row.status).toBe(ENRICHMENT_STATUS.PENDING);
      expect(row.claimToken).toBeNull();
    });
  }, 60000);

  it("8. a job released after cancellation is genuinely reclaimable, with no partial result fields", async () => {
    const indicator = `${IP_PREFIX}80`;
    const providerName = `${MARKER}-p8`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), { client: prisma, asOf: T0 });

    const controller = new AbortController();
    const [client] = racerClients(1);
    const realUpdateMany = client.iocEnrichment.updateMany.bind(client.iocEnrichment);
    client.iocEnrichment.updateMany = async (args) => {
      const result = await realUpdateMany(args);
      // Abort right after the claim's own guarded update lands, strictly
      // before any provider call.
      if (args.data && args.data.claimToken && !controller.signal.aborted) controller.abort();
      return result;
    };
    const provider = fakeProvider(providerName, () => successResult(providerName, indicator));

    let summary;
    try {
      summary = await runEnrichmentBatch({
        ...runnerOptions(),
        prisma: scopedClient(client),
        providerRegistry: registryOf({ [providerName]: provider }),
        signal: controller.signal,
      });
    } finally {
      client.iocEnrichment.updateMany = realUpdateMany;
    }

    expect(summary.cancelled).toBe(true);
    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.RELEASED_AFTER_CANCELLATION);
    expect(provider.getCalls()).toHaveLength(0);

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(stored.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(stored.claimToken).toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();
    expect(stored.queriedAt).toBeNull();
    expect(stored.errorCode).toBeNull();
    // Since P2-T2e-1 a release also carries a bounded retry gate, and an
    // interrupted attempt is refunded — cancellation is not a failed attempt.
    expect(stored.nextAttemptAt).not.toBeNull();
    expect(stored.attemptCount).toBe(0);

    // Not yet reclaimable: the retry gate is what prevents an immediate
    // re-claim loop.
    const tooEarly = await claimPendingJob(record.id, {
      client: prisma,
      now: new Date(stored.nextAttemptAt.getTime() - 1),
      leaseMs: 60000,
    });
    expect(tooEarly).toBeNull();

    // Genuinely reclaimable once the gate elapses — a fresh claim succeeds.
    const reclaim = await claimPendingJob(record.id, {
      client: prisma,
      now: stored.nextAttemptAt,
      leaseMs: 60000,
    });
    expect(reclaim).not.toBeNull();
  }, 60000);
});
