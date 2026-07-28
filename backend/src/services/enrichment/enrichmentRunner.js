"use strict";

// Bounded IOC enrichment runner (P2-T2d) — the worker that finally connects
// the P2-T2b queue/cache primitives to a provider's lookup() and the P2-T2c
// TTL policy. Nothing before this packet ever called a provider from the
// queue layer; this module is that one call site.
//
// Flow per claimed job, always in this order:
//   1. claim a durable PENDING candidate (P2-T2b, unchanged)
//   2. resolve the job's own stored provider name through the CALLER-injected
//      providerRegistry (never a fallback to mock; never a second registry)
//   3. call provider.lookup(...) — OUTSIDE any Prisma transaction, built only
//      from allow-listed persisted fields (never the raw database row)
//   4. resolve TTL through the CALLER-injected ttlPolicy (enrichmentTtlPolicy
//      .resolveEnrichmentTtl in production; a fake in tests)
//   5. complete the exact claimed job with the resolved expiresAt
//
// What this module deliberately does NOT do:
//   - decide provider configuration (API keys, base URLs) — the caller's
//     providerRegistry.resolve(name) already returns a configured provider;
//     importing this file never requires an AbuseIPDB key
//   - schedule work, run a daemon, retry a completed batch, or read the wall
//     clock — `now` is the caller's explicit input, used for claiming AND as
//     every job's provider `asOf`
//   - write an audit event or touch any route/controller — P2-T2e's job
//   - log anything — no console access here at all, matching every other
//     pure/orchestration module in this directory; a future caller with its
//     own logging convention wraps this function, it does not need one
//     threaded through it
//
// Concurrency: sequential, one provider call at a time, at most batchSize
// candidates per call — see BUILD_PLAN.md/STATUS.md P2-T2d for why this is
// the deliberate MVP choice (AbuseIPDB quota safety, and every concurrency
// invariant this depends on — the unique activeCacheKey, the guarded claim/
// complete updateMany — is already proven under real concurrent *processes*
// by tests/integration/iocEnrichmentQueue.test.js; racing this runner's own
// single-threaded loop against itself would prove nothing new).

const { ENRICHMENT_STATUS } = require("./iocEnrichmentTypes");
const {
  listPendingCandidates,
  claimPendingJob,
  completeClaimedJob,
  releaseClaimedJob,
  COMPLETION_OUTCOME,
  RELEASE_OUTCOME,
} = require("./iocEnrichmentRepository");
const {
  RUNNER_OUTCOME,
  assertValidRunnerConfig,
  isAborted,
  buildJobResult,
  buildBatchSummary,
} = require("./enrichmentRunnerTypes");

function isAbortError(err) {
  return Boolean(err) && err.name === "AbortError";
}

// Best-effort release used as the backstop for every "we held a claim but
// cannot complete it truthfully" path. Guarded by (status: PENDING,
// claimToken) exactly like every other completion/release call, so it is
// always safe to attempt even if the row's true state is uncertain: if the
// job already went terminal (e.g. a completion actually landed before a
// network error hid the response), this simply matches zero rows and
// reports NOT_CLAIM_OWNER rather than corrupting anything. Never throws.
async function safeRelease(prisma, id, claimToken) {
  try {
    const released = await releaseClaimedJob({ id, claimToken }, { client: prisma });
    return released.outcome === RELEASE_OUTCOME.RELEASED;
  } catch {
    return false;
  }
}

// Constructs the provider lookup input exclusively from allow-listed
// persisted fields — never the claimed database row itself, never a claim
// token, cache key, or worker id.
function buildLookupInput(record, now, signal) {
  return {
    indicatorType: record.indicatorType,
    indicator: record.indicator,
    asOf: now,
    queryParams: record.queryParams ? { ...record.queryParams } : null,
    signal: signal || undefined,
  };
}

/**
 * Processes one already-claimed job: provider lookup -> TTL -> completion.
 * Never throws for an expected provider outcome; returns a closed job
 * result for every path, including cancellation and unexpected exceptions.
 */
async function processClaimedJob({ prisma, providerRegistry, now, ttlPolicy, signal, record, claimToken }) {
  const base = { enrichmentId: record.id, provider: record.provider, indicatorType: record.indicatorType, indicator: record.indicator };

  // Cancellation observed before any provider call was made for this job:
  // release immediately, never attempt lookup.
  if (isAborted(signal)) {
    const released = await safeRelease(prisma, record.id, claimToken);
    return {
      job: buildJobResult({ ...base, outcome: released ? RUNNER_OUTCOME.RELEASED_AFTER_CANCELLATION : RUNNER_OUTCOME.RELEASE_FAILED }),
      cancelled: true,
    };
  }

  let provider;
  try {
    provider = providerRegistry.resolve(record.provider);
  } catch {
    provider = null;
  }
  if (!provider || typeof provider.lookup !== "function") {
    const released = await safeRelease(prisma, record.id, claimToken);
    return {
      job: buildJobResult({ ...base, outcome: released ? RUNNER_OUTCOME.UNKNOWN_PROVIDER : RUNNER_OUTCOME.RELEASE_FAILED }),
      cancelled: false,
    };
  }

  // Exactly one provider call for this claimed job, outside any transaction.
  let result;
  try {
    result = await provider.lookup(buildLookupInput(record, now, signal));
  } catch (err) {
    if (isAbortError(err)) {
      const released = await safeRelease(prisma, record.id, claimToken);
      return {
        job: buildJobResult({ ...base, outcome: released ? RUNNER_OUTCOME.RELEASED_AFTER_CANCELLATION : RUNNER_OUTCOME.RELEASE_FAILED }),
        cancelled: true,
      };
    }
    // Unexpected programmer/system exception (case C). Never persist
    // err.message anywhere — the closed outcome code is the only signal.
    const released = await safeRelease(prisma, record.id, claimToken);
    return {
      job: buildJobResult({ ...base, outcome: released ? RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR : RUNNER_OUTCOME.RELEASE_FAILED }),
      cancelled: false,
    };
  }

  // Defensive: a provider returning PENDING (or nothing) is a contract
  // violation, not an expected outcome — never accepted as terminal.
  if (!result || result.status === ENRICHMENT_STATUS.PENDING) {
    const released = await safeRelease(prisma, record.id, claimToken);
    return {
      job: buildJobResult({ ...base, outcome: released ? RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR : RUNNER_OUTCOME.RELEASE_FAILED }),
      cancelled: false,
    };
  }

  let ttl;
  try {
    ttl = ttlPolicy({ status: result.status, queriedAt: result.queriedAt, retryAfterSeconds: result.retryAfterSeconds });
  } catch {
    const released = await safeRelease(prisma, record.id, claimToken);
    return {
      job: buildJobResult({ ...base, outcome: released ? RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR : RUNNER_OUTCOME.RELEASE_FAILED }),
      cancelled: false,
    };
  }

  let completion;
  try {
    completion = await completeClaimedJob(
      { id: record.id, claimToken, result, expiresAt: ttl.expiresAt },
      { client: prisma }
    );
  } catch {
    return { job: buildJobResult({ ...base, outcome: RUNNER_OUTCOME.COMPLETION_FAILED }), cancelled: false };
  }

  if (completion.outcome === COMPLETION_OUTCOME.NOT_CLAIM_OWNER) {
    return { job: buildJobResult({ ...base, outcome: RUNNER_OUTCOME.STALE_CLAIM_ON_COMPLETION }), cancelled: false };
  }

  return {
    job: buildJobResult({
      ...base,
      outcome: RUNNER_OUTCOME.COMPLETED,
      terminalStatus: completion.record.status,
      queriedAt: completion.record.queriedAt,
      expiresAt: completion.record.expiresAt,
    }),
    cancelled: false,
  };
}

/**
 * Runs one bounded pass over durable PENDING enrichment jobs: claim, look up
 * (outside any transaction), apply TTL, complete — sequentially, at most
 * `batchSize` candidates, never throwing for an expected provider outcome, a
 * lost claim race, caller cancellation, or an unexpected per-job exception.
 *
 * @param {{prisma: object, providerRegistry: {resolve: Function}, now: Date,
 *   batchSize: number, leaseDurationSeconds: number, ttlPolicy: Function,
 *   workerId: string, signal?: AbortSignal}} options
 * @returns {Promise<object>} a closed, defensively-copied batch summary
 */
async function runEnrichmentBatch(options) {
  const config = assertValidRunnerConfig(options);
  const { prisma, providerRegistry, now, batchSize, leaseMs, ttlPolicy, signal } = config;

  if (isAborted(signal)) {
    return buildBatchSummary({ requestedBatchSize: batchSize, candidateCount: 0, cancelled: true, results: [] });
  }

  const candidates = await listPendingCandidates({ limit: batchSize }, { client: prisma, asOf: now });

  const results = [];
  let cancelled = false;

  // Sequential by design (see module header): one provider call in flight at
  // a time, and a batch never needs its own candidates to race each other.
  // eslint-disable-next-line no-restricted-syntax
  for (const candidate of candidates) {
    if (isAborted(signal)) {
      cancelled = true;
      break;
    }

    let claim;
    try {
      // eslint-disable-next-line no-await-in-loop
      claim = await claimPendingJob(candidate.id, { client: prisma, now, leaseMs });
    } catch {
      results.push(
        buildJobResult({
          enrichmentId: candidate.id,
          provider: candidate.provider,
          indicatorType: candidate.indicatorType,
          indicator: candidate.indicator,
          outcome: RUNNER_OUTCOME.CLAIM_FAILED,
        })
      );
      continue; // eslint-disable-line no-continue
    }

    if (!claim) {
      results.push(
        buildJobResult({
          enrichmentId: candidate.id,
          provider: candidate.provider,
          indicatorType: candidate.indicatorType,
          indicator: candidate.indicator,
          outcome: RUNNER_OUTCOME.SKIPPED_NOT_CLAIMED,
        })
      );
      continue; // eslint-disable-line no-continue
    }

    // eslint-disable-next-line no-await-in-loop
    const outcome = await processClaimedJob({
      prisma,
      providerRegistry,
      now,
      ttlPolicy,
      signal,
      record: claim.record,
      claimToken: claim.claimToken,
    });
    results.push(outcome.job);
    if (outcome.cancelled) {
      cancelled = true;
      break;
    }
  }

  return buildBatchSummary({ requestedBatchSize: batchSize, candidateCount: candidates.length, cancelled, results });
}

module.exports = {
  runEnrichmentBatch,
};
