import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Real-PostgreSQL tests for the P2-T2e-1 attempt budget, retry gate,
// dead-letter transition and audited execution service.
//
// Mirrors the scope split already documented in iocEnrichmentQueue.test.js and
// enrichmentRunner.test.js: an in-memory fake Prisma client proves DECISION
// logic, but only genuine concurrent connections can prove that the attempt
// increment is atomic — that two workers racing for one job produce exactly
// one increment rather than two — and that a held lease survives a real
// failed write.
//
// Self-skips unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_test?schema=public" npx vitest run tests/integration/enrichmentRetryDeadLetter.test.js

const { PrismaClient } = require("@prisma/client");
const { runEnrichmentBatch } = require("../../src/services/enrichment/enrichmentRunner");
const { RUNNER_OUTCOME } = require("../../src/services/enrichment/enrichmentRunnerTypes");
const { executeEnrichmentBatch } = require("../../src/services/enrichment/enrichmentExecutionService");
const { scheduleEnrichment } = require("../../src/services/enrichment/enrichmentQueueService");
const {
  claimPendingJob,
  listPendingCandidates,
  deadLetterClaimedJob,
  DEAD_LETTER_OUTCOME,
} = require("../../src/services/enrichment/iocEnrichmentRepository");
const {
  QUEUE_STATUS,
  ENRICHMENT_TERMINAL_REASON,
} = require("../../src/services/enrichment/iocEnrichmentCacheRules");
const {
  ENRICHMENT_STATUS,
  createEnrichmentResult,
} = require("../../src/services/enrichment/iocEnrichmentTypes");
const { resolveEnrichmentTtl } = require("../../src/services/enrichment/enrichmentTtlPolicy");
const { resolveEnrichmentRetry } = require("../../src/services/enrichment/enrichmentRetryPolicy");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Dedicated marker + a third-octet slice distinct from every other suite
// sharing 198.18.0.0/15: P2-T2b owns 198.18.0.x ("p2t2b-mock") and P2-T2d owns
// 198.19.0.x ("p2t2d-mock"). Cleanup deletes by the exact provider marker, not
// by IP prefix, so it cannot touch — and is not touched by — another suite.
const MARKER = "p2t2e1-mock";
const IP_PREFIX = "198.20.0.";

const T0 = new Date("2026-07-28T12:00:00.000Z");
const LEASE_SECONDS = 60;
const HOUR_MS = 3600000;

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
// pending, which is correct in production and hostile in a shared test
// database, where vitest runs integration files in parallel. Without this,
// this suite's batches would claim, delay and eventually dead-letter the rows
// belonging to iocEnrichmentQueue.test.js.
//
// So the worker gets a scoped view: a thin delegate whose candidate LISTING
// is filtered to this suite's marker. Nothing else is changed — the claim,
// completion, release and dead-letter statements are the real, unscoped ones,
// so every concurrency guarantee under test is still the production one.
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

function identityFor(providerName, indicator) {
  return { provider: providerName, indicatorType: "IPV4", indicator, queryParams: null };
}

function successResult(providerName, indicator) {
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

describeDb("P2-T2e-1 retry / dead-letter / audited execution — real PostgreSQL", () => {
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

  it("1. two workers racing for one job produce exactly ONE attempt increment; the loser increments nothing", async () => {
    const indicator = `${IP_PREFIX}10`;
    const providerName = `${MARKER}-p1`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), { client: prisma, asOf: T0 });
    expect(record.attemptCount).toBe(0);

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

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    // The whole point: two concurrent claims, one attempt consumed.
    expect(stored.attemptCount).toBe(1);
    expect(stored.lastAttemptAt).not.toBeNull();
    expect(providerA.getCalls().length + providerB.getCalls().length).toBe(1);

    const outcomes = [...summaryA.results, ...summaryB.results].map((r) => r.outcome);
    expect(outcomes.filter((o) => o === RUNNER_OUTCOME.COMPLETED)).toHaveLength(1);
    expect(outcomes.filter((o) => o === RUNNER_OUTCOME.SKIPPED_NOT_CLAIMED)).toHaveLength(1);
  }, 60000);

  it("2. a job is not listed before nextAttemptAt and IS listed at the exact boundary", async () => {
    const indicator = `${IP_PREFIX}20`;
    const providerName = `${MARKER}-p2`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), { client: prisma, asOf: T0 });

    const nextAttemptAt = new Date(T0.getTime() + 300000);
    await prisma.iocEnrichment.update({ where: { id: record.id }, data: { nextAttemptAt } });

    const tooEarly = await listPendingCandidates(
      {},
      { client: prisma, asOf: new Date(nextAttemptAt.getTime() - 1) }
    );
    expect(tooEarly.filter((r) => r.id === record.id)).toHaveLength(0);

    const exactly = await listPendingCandidates({}, { client: prisma, asOf: nextAttemptAt });
    expect(exactly.filter((r) => r.id === record.id)).toHaveLength(1);

    // And the runner honours the same boundary end to end.
    const provider = fakeProvider(providerName, () => successResult(providerName, indicator));
    const early = await runEnrichmentBatch({
      ...runnerOptions({ now: new Date(nextAttemptAt.getTime() - 1) }),
      prisma: scopedClient(prisma),
      providerRegistry: registryOf({ [providerName]: provider }),
    });
    expect(early.candidateCount).toBe(0);
    expect(provider.getCalls()).toHaveLength(0);
  }, 60000);

  it("3. dead-lettering requires the correct claim token, clears active/lease fields, and hides the row forever", async () => {
    const indicator = `${IP_PREFIX}30`;
    const providerName = `${MARKER}-p3`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), { client: prisma, asOf: T0 });
    const claim = await claimPendingJob(record.id, { client: prisma, now: T0, leaseMs: LEASE_SECONDS * 1000 });
    expect(claim).not.toBeNull();

    // Wrong token changes nothing.
    const refused = await deadLetterClaimedJob(
      { id: record.id, claimToken: "not-the-owner", reasonCode: ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_EXHAUSTED },
      { client: prisma, now: T0 }
    );
    expect(refused.outcome).toBe(DEAD_LETTER_OUTCOME.NOT_CLAIM_OWNER);
    const untouched = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(untouched.status).toBe(ENRICHMENT_STATUS.PENDING);

    // Correct token retires it.
    const retired = await deadLetterClaimedJob(
      {
        id: record.id,
        claimToken: claim.claimToken,
        reasonCode: ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_PROVIDER_ERROR,
      },
      { client: prisma, now: T0 }
    );
    expect(retired.outcome).toBe(DEAD_LETTER_OUTCOME.DEAD_LETTERED);

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(stored.status).toBe(QUEUE_STATUS.DEAD_LETTER);
    expect(stored.terminalReasonCode).toBe(ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_PROVIDER_ERROR);
    expect(stored.deadLetteredAt).toEqual(T0);
    expect(stored.activeCacheKey).toBeNull();
    expect(stored.claimToken).toBeNull();
    expect(stored.claimedAt).toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();
    expect(stored.nextAttemptAt).toBeNull();

    const later = await listPendingCandidates({}, { client: prisma, asOf: new Date(T0.getTime() + 30 * 24 * HOUR_MS) });
    expect(later.filter((r) => r.id === record.id)).toHaveLength(0);
  }, 60000);

  it("4. a repeatedly failing provider costs at most maxAttempts calls, then the row is DEAD_LETTER and never called again", async () => {
    const indicator = `${IP_PREFIX}40`;
    const providerName = `${MARKER}-p4`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), {
      client: prisma,
      asOf: T0,
      maxAttempts: 3,
    });
    const provider = fakeProvider(providerName, () => new TypeError("always broken"));
    const registry = registryOf({ [providerName]: provider });

    // Run many more batches than the budget permits, advancing past each
    // delay so retry eligibility is never the limiting factor.
    let clock = T0;
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runEnrichmentBatch({
        ...runnerOptions({ now: clock }),
        prisma: scopedClient(prisma),
        providerRegistry: registry,
      });
      // eslint-disable-next-line no-await-in-loop
      const row = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
      clock = row.nextAttemptAt ? new Date(row.nextAttemptAt.getTime()) : new Date(clock.getTime() + HOUR_MS);
    }

    expect(provider.getCalls()).toHaveLength(3);
    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(stored.status).toBe(QUEUE_STATUS.DEAD_LETTER);
    expect(stored.terminalReasonCode).toBe(ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_PROVIDER_ERROR);
    expect(stored.attemptCount).toBe(3);
    // No exception text of any kind reached the row.
    expect(JSON.stringify(stored)).not.toContain("always broken");
    expect(JSON.stringify(stored)).not.toContain("TypeError");

    // A much later invocation must not resurrect it.
    const after = await runEnrichmentBatch({
      ...runnerOptions({ now: new Date(clock.getTime() + 30 * 24 * HOUR_MS) }),
      prisma: scopedClient(prisma),
      providerRegistry: registry,
    });
    expect(after.candidateCount).toBe(0);
    expect(provider.getCalls()).toHaveLength(3);
  }, 60000);

  it("5. a rejected completion payload writes no terminal provider fields and follows the retry policy", async () => {
    const indicator = `${IP_PREFIX}50`;
    const providerName = `${MARKER}-p5`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), {
      client: prisma,
      asOf: T0,
      maxAttempts: 2,
    });
    // A result whose provider identity does not match the claimed row: the
    // persistence layer rejects it BEFORE writing anything.
    const provider = fakeProvider(providerName, () => successResult(`${MARKER}-someone-else`, indicator));
    const registry = registryOf({ [providerName]: provider });

    const first = await runEnrichmentBatch({
      ...runnerOptions(),
      prisma: scopedClient(prisma),
      providerRegistry: registry,
    });
    expect(first.results[0].outcome).toBe(RUNNER_OUTCOME.RELEASED_AFTER_COMPLETION_VALIDATION);

    const afterFirst = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(afterFirst.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(afterFirst.queriedAt).toBeNull();
    expect(afterFirst.expiresAt).toBeNull();
    expect(afterFirst.abuseConfidenceScore).toBeNull();
    expect(afterFirst.errorCode).toBeNull();
    expect(afterFirst.claimToken).toBeNull(); // genuinely released
    expect(afterFirst.attemptCount).toBe(1);
    expect(afterFirst.nextAttemptAt).not.toBeNull();

    // Second (final) attempt exhausts the budget and retires the row.
    const second = await runEnrichmentBatch({
      ...runnerOptions({ now: afterFirst.nextAttemptAt }),
      prisma: scopedClient(prisma),
      providerRegistry: registry,
    });
    expect(second.results[0].outcome).toBe(RUNNER_OUTCOME.DEAD_LETTERED);

    const afterSecond = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(afterSecond.status).toBe(QUEUE_STATUS.DEAD_LETTER);
    expect(afterSecond.terminalReasonCode).toBe(
      ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_COMPLETION_VALIDATION
    );
    expect(afterSecond.abuseConfidenceScore).toBeNull();
  }, 60000);

  it("6. an unknown completion database error HOLDS the lease — no release, no dead-letter — and recovers by lease expiry", async () => {
    const indicator = `${IP_PREFIX}60`;
    const providerName = `${MARKER}-p6`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), { client: prisma, asOf: T0 });
    const provider = fakeProvider(providerName, () => successResult(providerName, indicator));

    const [client] = racerClients(1);
    const realUpdateMany = client.iocEnrichment.updateMany.bind(client.iocEnrichment);
    // Fail only the COMPLETION write (identifiable by `data.status`) — the
    // case where the row may or may not already carry the result.
    client.iocEnrichment.updateMany = async (args) => {
      if (args.data && "status" in args.data) throw new Error("simulated completion database failure");
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
    expect(summary.heldUnknownStateCount).toBe(1);
    expect(summary.releasedCount).toBe(0);
    expect(summary.deadLetteredCount).toBe(0);
    expect(JSON.stringify(summary)).not.toContain("simulated completion database failure");

    const held = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(held.status).toBe(ENRICHMENT_STATUS.PENDING);
    // The lease is deliberately still held and NOT returned to the queue.
    expect(held.claimToken).not.toBeNull();
    expect(held.leaseExpiresAt).not.toBeNull();
    expect(held.nextAttemptAt).toBeNull();

    // While the lease is live, no other worker may take it — the row is not
    // even listed as a candidate, so no second provider call is possible.
    const providerB = fakeProvider(providerName, () => successResult(providerName, indicator));
    const duringLease = await runEnrichmentBatch({
      ...runnerOptions({ now: new Date(T0.getTime() + 1000), workerId: "worker-b" }),
      prisma: scopedClient(prisma),
      providerRegistry: registryOf({ [providerName]: providerB }),
    });
    expect(duringLease.candidateCount).toBe(0);
    expect(duringLease.results).toHaveLength(0);
    expect(providerB.getCalls()).toHaveLength(0);

    // Recovery is lease expiry, exactly as designed.
    const afterExpiry = await runEnrichmentBatch({
      ...runnerOptions({ now: new Date(held.leaseExpiresAt.getTime()), workerId: "worker-c" }),
      prisma: scopedClient(prisma),
      providerRegistry: registryOf({ [providerName]: provider }),
    });
    expect(afterExpiry.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETED);
    const recovered = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(recovered.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(recovered.attemptCount).toBe(2);
  }, 60000);

  it("7. cancellation after the provider returns does not complete the job; it is released with a retry gate and is reclaimable", async () => {
    const indicator = `${IP_PREFIX}70`;
    const providerName = `${MARKER}-p7`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), { client: prisma, asOf: T0 });

    const controller = new AbortController();
    const provider = fakeProvider(providerName, () => {
      // A perfectly good result — but the caller cancels first.
      controller.abort();
      return successResult(providerName, indicator);
    });

    const summary = await runEnrichmentBatch({
      ...runnerOptions(),
      prisma: scopedClient(prisma),
      providerRegistry: registryOf({ [providerName]: provider }),
      signal: controller.signal,
    });

    expect(provider.getCalls()).toHaveLength(1);
    expect(summary.cancelled).toBe(true);
    expect(summary.completedCount).toBe(0);
    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.RELEASED_AFTER_CANCELLATION);

    const released = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(released.status).toBe(ENRICHMENT_STATUS.PENDING);
    expect(released.queriedAt).toBeNull();
    expect(released.abuseConfidenceScore).toBeNull();
    expect(released.claimToken).toBeNull();
    expect(released.nextAttemptAt).not.toBeNull();
    // An interrupted attempt is refunded: cancellation is not a failure.
    expect(released.attemptCount).toBe(0);

    // A later worker picks it up normally once the short gate elapses.
    const laterProvider = fakeProvider(providerName, () => successResult(providerName, indicator));
    const later = await runEnrichmentBatch({
      ...runnerOptions({ now: released.nextAttemptAt, workerId: "worker-b" }),
      prisma: scopedClient(prisma),
      providerRegistry: registryOf({ [providerName]: laterProvider }),
    });
    expect(later.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETED);
    const completed = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(completed.status).toBe(ENRICHMENT_STATUS.SUCCESS);
  }, 60000);

  it("8. a forced audit-write failure does not roll back or alter the completed batch", async () => {
    const indicator = `${IP_PREFIX}80`;
    const providerName = `${MARKER}-p8`;
    const { record } = await scheduleEnrichment(identityFor(providerName, indicator), { client: prisma, asOf: T0 });
    const provider = fakeProvider(providerName, () => successResult(providerName, indicator));

    const [client] = racerClients(1);
    const realAuditCreate = client.auditLog.create.bind(client.auditLog);
    client.auditLog.create = async () => {
      throw new Error("simulated audit outage");
    };

    let summary;
    try {
      summary = await executeEnrichmentBatch({
        prisma: scopedClient(client),
        now: T0,
        batchSize: 10,
        workerId: "worker-audit",
        runtimeOverrides: {
          env: {
            ABUSEIPDB_API_KEY: "",
            ABUSEIPDB_BASE_URL: "https://api.example.invalid/api/v2",
            ABUSEIPDB_TIMEOUT_MS: 5000,
            ABUSEIPDB_MAX_AGE_DAYS: 30,
          },
          providerRegistry: registryOf({ [providerName]: provider }),
        },
      });
    } finally {
      client.auditLog.create = realAuditCreate;
    }

    // The queue work is what must survive an audit outage.
    expect(summary.completedCount).toBe(1);
    expect(summary.results[0].outcome).toBe(RUNNER_OUTCOME.COMPLETED);

    const stored = await prisma.iocEnrichment.findUnique({ where: { id: record.id } });
    expect(stored.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(stored.abuseConfidenceScore).toBe(10);
    expect(stored.claimToken).toBeNull();
    expect(stored.activeCacheKey).toBeNull();
    expect(stored.attemptCount).toBe(1);
  }, 60000);
});
