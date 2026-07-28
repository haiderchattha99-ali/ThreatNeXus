"use strict";

// Bounded IOC enrichment runner (P2-T2d, hardened in P2-T2e-1) — the worker
// that connects the P2-T2b queue/cache primitives to a provider's lookup(),
// the P2-T2c TTL policy, and the P2-T2e-1 retry/dead-letter policy. Nothing
// before P2-T2d ever called a provider from the queue layer; this module is
// still that one call site.
//
// Flow per candidate, always in this order:
//   0. if the candidate has already spent its attempt budget, sweep it into
//      DEAD_LETTER — no claim, no provider call
//   1. claim a durable, retry-eligible PENDING candidate (P2-T2b; the claim
//      also consumes one unit of the attempt budget, atomically)
//   2. resolve the job's own stored provider name through the CALLER-injected
//      providerRegistry (never a fallback to mock; never a second registry)
//   3. call provider.lookup(...) — OUTSIDE any Prisma transaction, built only
//      from allow-listed persisted fields (never the raw database row)
//   4. re-check cancellation, then resolve TTL through the CALLER-injected
//      ttlPolicy
//   5. complete the exact claimed job with the resolved expiresAt
//
// Every failure path routes through the CALLER-injected retryPolicy
// (enrichmentRetryPolicy.resolveEnrichmentRetry in production), which decides
// between releasing with a bounded delay, dead-lettering, or holding the lease
// because the durable state is unknown. The runner never invents that
// decision and never inspects an Error's message or stack to make it.
//
// What this module deliberately does NOT do:
//   - decide provider configuration (API keys, base URLs) — the caller's
//     providerRegistry.resolve(name) already returns a configured provider;
//     importing this file never requires an AbuseIPDB key
//   - schedule work, run a daemon, retry a failed job WITHIN a batch, or read
//     the wall clock — `now` is the caller's explicit input, used for
//     claiming, for every job's provider `asOf`, and as the retry policy's
//     time base
//   - write an audit event — that belongs to enrichmentExecutionService.js,
//     which has the actor/source context this module deliberately lacks
//   - log anything — no console access here at all
//
// Concurrency: sequential, one provider call at a time, at most batchSize
// candidates per call.

const { ENRICHMENT_STATUS } = require("./iocEnrichmentTypes");
const { IocEnrichmentValidationError } = require("./iocEnrichmentCacheRules");
const {
  listPendingCandidates,
  claimPendingJob,
  completeClaimedJob,
  releaseClaimedJob,
  deadLetterClaimedJob,
  deadLetterExhaustedJob,
  COMPLETION_OUTCOME,
  RELEASE_OUTCOME,
  DEAD_LETTER_OUTCOME,
} = require("./iocEnrichmentRepository");
const { FAILURE_CLASS, RETRY_ACTION } = require("./enrichmentRetryPolicy");
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

// THE classification that Part 4A of the P2-T2d audit turned on.
//
// completeClaimedJob raises for two structurally different reasons:
//
//   IocEnrichmentValidationError — it inspected the result and refused it
//     BEFORE issuing any write. Nothing was touched. Durable state is known.
//
//   anything else — the write itself raised. It may have committed. Durable
//     state is NOT known.
//
// The distinction is made on the typed domain error the persistence layer
// throws, never by parsing `error.message`: a message is presentation, can
// change without notice, and is exactly the kind of string this codebase
// refuses to make decisions from.
function isLocalValidationError(err) {
  return err instanceof IocEnrichmentValidationError;
}

// Best-effort release used as the backstop for every "we held a claim but
// cannot complete it truthfully" path. Guarded by (status: PENDING,
// claimToken) exactly like every other completion/release call, so it is
// always safe to attempt even if the row's true state is uncertain: if the
// job already went terminal, this simply matches zero rows and reports
// NOT_CLAIM_OWNER rather than corrupting anything. Never throws.
async function safeRelease(prisma, id, claimToken, nextAttemptAt, refundAttempt) {
  try {
    const released = await releaseClaimedJob(
      { id, claimToken, nextAttemptAt: nextAttemptAt ?? null, refundAttempt: refundAttempt === true },
      { client: prisma }
    );
    return released.outcome === RELEASE_OUTCOME.RELEASED;
  } catch {
    return false;
  }
}

// Same contract as safeRelease, for the terminal retirement path. Never
// throws; a failed dead-letter simply leaves the lease to expire.
async function safeDeadLetter(prisma, id, claimToken, reasonCode, now) {
  try {
    const outcome = await deadLetterClaimedJob({ id, claimToken, reasonCode }, { client: prisma, now });
    return outcome.outcome === DEAD_LETTER_OUTCOME.DEAD_LETTERED;
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

// Which successful-release outcome each failure class reports. Keeping the
// provenance in the OUTCOME (not only in `failureClass`) preserves the
// P2-T2d taxonomy every existing caller and test already reads, and satisfies
// the audit's Part 4C requirement that a release — successful or failed —
// always says WHY it was attempted.
const RELEASE_OUTCOME_BY_CLASS = Object.freeze({
  [FAILURE_CLASS.CALLER_CANCELLATION]: RUNNER_OUTCOME.RELEASED_AFTER_CANCELLATION,
  [FAILURE_CLASS.PROVIDER_PROGRAMMER_ERROR]: RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR,
  [FAILURE_CLASS.UNKNOWN_PROVIDER]: RUNNER_OUTCOME.UNKNOWN_PROVIDER,
  [FAILURE_CLASS.COMPLETION_VALIDATION_ERROR]: RUNNER_OUTCOME.RELEASED_AFTER_COMPLETION_VALIDATION,
});

/**
 * Applies one retry-policy decision to a claimed job and turns it into a
 * closed job result. This is the single place a failure becomes an action, so
 * every failure class is treated consistently no matter where it arose.
 */
async function applyRetryDecision({ prisma, now, retryPolicy, record, claimToken, failureClass, base, retryAfterSeconds = null }) {
  const attemptCount = Number.isInteger(record.attemptCount) ? record.attemptCount : 0;
  const maxAttempts = Number.isInteger(record.maxAttempts) ? record.maxAttempts : 1;
  const attemptFields = { attemptCount, maxAttempts };

  let decision;
  try {
    decision = retryPolicy({
      failureClass,
      currentAttemptCount: attemptCount,
      maxAttempts,
      now,
      retryAfterSeconds,
    });
  } catch {
    // A retryPolicy that itself throws is a configuration/programmer error.
    // Holding the lease is the conservative choice: it expires on its own and
    // nothing is written on a decision we could not make.
    return buildJobResult({
      ...base,
      ...attemptFields,
      outcome: RUNNER_OUTCOME.COMPLETION_FAILED,
      failureClass: FAILURE_CLASS.COMPLETION_DATABASE_ERROR,
    });
  }

  if (decision.action === RETRY_ACTION.HOLD_UNKNOWN_STATE) {
    // Touch nothing at all. The lease is kept deliberately.
    return buildJobResult({
      ...base,
      ...attemptFields,
      outcome: RUNNER_OUTCOME.COMPLETION_FAILED,
      failureClass,
    });
  }

  if (decision.action === RETRY_ACTION.DEAD_LETTER) {
    const retired = await safeDeadLetter(prisma, record.id, claimToken, decision.terminalReasonCode, now);
    return buildJobResult({
      ...base,
      ...attemptFields,
      outcome: retired ? RUNNER_OUTCOME.DEAD_LETTERED : RUNNER_OUTCOME.RELEASE_FAILED,
      failureClass,
      terminalReasonCode: retired ? decision.terminalReasonCode : null,
    });
  }

  // RELEASE_WITH_DELAY — the ordinary "try again later" path.
  const released = await safeRelease(
    prisma,
    record.id,
    claimToken,
    decision.nextAttemptAt,
    decision.refundAttempt
  );
  // The fallback can only be reached if a future failure class is added
  // without a release outcome; reporting it as a generic internal-error
  // release is safer than emitting an undefined outcome.
  const releasedOutcome =
    RELEASE_OUTCOME_BY_CLASS[failureClass] || RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR;
  return buildJobResult({
    ...base,
    ...attemptFields,
    outcome: released ? releasedOutcome : RUNNER_OUTCOME.RELEASE_FAILED,
    failureClass,
    nextAttemptAt: released ? decision.nextAttemptAt : null,
  });
}

/**
 * Processes one already-claimed job: provider lookup -> cancellation re-check
 * -> TTL -> completion. Never throws for an expected provider outcome;
 * returns a closed job result for every path, including cancellation and
 * unexpected exceptions.
 */
async function processClaimedJob({ prisma, providerRegistry, now, ttlPolicy, retryPolicy, signal, record, claimToken }) {
  const base = {
    enrichmentId: record.id,
    provider: record.provider,
    indicatorType: record.indicatorType,
    indicator: record.indicator,
  };
  const applyFailure = (failureClass, retryAfterSeconds = null) =>
    applyRetryDecision({ prisma, now, retryPolicy, record, claimToken, failureClass, base, retryAfterSeconds });

  // Cancellation observed before any provider call was made for this job:
  // release immediately, never attempt lookup.
  if (isAborted(signal)) {
    return { job: await applyFailure(FAILURE_CLASS.CALLER_CANCELLATION), cancelled: true };
  }

  let provider;
  try {
    provider = providerRegistry.resolve(record.provider);
  } catch {
    provider = null;
  }
  if (!provider || typeof provider.lookup !== "function") {
    return { job: await applyFailure(FAILURE_CLASS.UNKNOWN_PROVIDER), cancelled: false };
  }

  // Exactly one provider call for this claimed job, outside any transaction.
  let result;
  try {
    result = await provider.lookup(buildLookupInput(record, now, signal));
  } catch (err) {
    if (isAbortError(err)) {
      return { job: await applyFailure(FAILURE_CLASS.CALLER_CANCELLATION), cancelled: true };
    }
    // Unexpected programmer/system exception. `err` is never read beyond its
    // AbortError name check above — no message, no stack, ever.
    return { job: await applyFailure(FAILURE_CLASS.PROVIDER_PROGRAMMER_ERROR), cancelled: false };
  }

  // Cancellation re-check (P2-T2d audit finding M4). The provider may have
  // returned normally while the signal fired — or may simply not honour the
  // signal at all. No terminal write has begun yet, so this job is released
  // under the cancellation policy rather than completed, and the batch stops.
  // A provider result obtained but not written is not lost data: the job
  // stays PENDING and the next attempt fetches it again.
  if (isAborted(signal)) {
    return { job: await applyFailure(FAILURE_CLASS.CALLER_CANCELLATION), cancelled: true };
  }

  // Defensive: a provider returning PENDING (or nothing) is a contract
  // violation, not an expected outcome — never accepted as terminal.
  if (!result || result.status === ENRICHMENT_STATUS.PENDING) {
    return { job: await applyFailure(FAILURE_CLASS.PROVIDER_PROGRAMMER_ERROR), cancelled: false };
  }

  let ttl;
  try {
    ttl = ttlPolicy({ status: result.status, queriedAt: result.queriedAt, retryAfterSeconds: result.retryAfterSeconds });
  } catch {
    // A TTL the policy refuses to produce is the same class of fault as a
    // malformed provider result: local, repeatable, and safe to act on
    // because nothing has been written.
    return {
      job: await applyFailure(FAILURE_CLASS.COMPLETION_VALIDATION_ERROR, result.retryAfterSeconds ?? null),
      cancelled: false,
    };
  }

  let completion;
  try {
    completion = await completeClaimedJob(
      { id: record.id, claimToken, result, expiresAt: ttl.expiresAt },
      { client: prisma }
    );
  } catch (err) {
    // The audit's Part 4A split, made real. A rejected result is safe to act
    // on; an unknown write outcome is not.
    const failureClass = isLocalValidationError(err)
      ? FAILURE_CLASS.COMPLETION_VALIDATION_ERROR
      : FAILURE_CLASS.COMPLETION_DATABASE_ERROR;
    return {
      job: await applyFailure(failureClass, result.retryAfterSeconds ?? null),
      cancelled: false,
    };
  }

  if (completion.outcome === COMPLETION_OUTCOME.NOT_CLAIM_OWNER) {
    return {
      job: buildJobResult({
        ...base,
        outcome: RUNNER_OUTCOME.STALE_CLAIM_ON_COMPLETION,
        attemptCount: record.attemptCount,
        maxAttempts: record.maxAttempts,
      }),
      cancelled: false,
    };
  }

  return {
    job: buildJobResult({
      ...base,
      outcome: RUNNER_OUTCOME.COMPLETED,
      terminalStatus: completion.record.status,
      queriedAt: completion.record.queriedAt,
      expiresAt: completion.record.expiresAt,
      attemptCount: completion.record.attemptCount,
      maxAttempts: completion.record.maxAttempts,
    }),
    cancelled: false,
  };
}

// Retires a candidate that arrived already at/over its attempt budget. No
// claim is taken (claimPendingJob would refuse it anyway, which is precisely
// why such a row would otherwise be stuck PENDING forever).
async function sweepExhaustedCandidate({ prisma, now, candidate, base }) {
  const attemptFields = { attemptCount: candidate.attemptCount, maxAttempts: candidate.maxAttempts };
  let outcome;
  try {
    outcome = await deadLetterExhaustedJob({ id: candidate.id }, { client: prisma, now });
  } catch {
    return buildJobResult({ ...base, ...attemptFields, outcome: RUNNER_OUTCOME.EXHAUSTED_SWEEP_FAILED });
  }
  if (outcome.outcome !== DEAD_LETTER_OUTCOME.DEAD_LETTERED) {
    return buildJobResult({ ...base, ...attemptFields, outcome: RUNNER_OUTCOME.EXHAUSTED_SWEEP_FAILED });
  }
  return buildJobResult({
    ...base,
    ...attemptFields,
    outcome: RUNNER_OUTCOME.EXHAUSTED_DEAD_LETTERED,
    terminalReasonCode: outcome.record.terminalReasonCode,
  });
}

/**
 * Runs one bounded pass over durable, retry-eligible PENDING enrichment jobs:
 * claim, look up (outside any transaction), apply TTL, complete —
 * sequentially, at most `batchSize` candidates, never throwing for an expected
 * provider outcome, a lost claim race, caller cancellation, or an unexpected
 * per-job exception.
 *
 * @param {{prisma: object, providerRegistry: {resolve: Function}, now: Date,
 *   batchSize: number, leaseDurationSeconds: number, ttlPolicy: Function,
 *   retryPolicy: Function, workerId: string, signal?: AbortSignal}} options
 * @returns {Promise<object>} a closed, defensively-copied batch summary
 */
async function runEnrichmentBatch(options) {
  const config = assertValidRunnerConfig(options);
  const { prisma, providerRegistry, now, batchSize, leaseMs, ttlPolicy, retryPolicy, signal } = config;

  // Pre-aborted: no listing query, no claim, no provider call. The batch is
  // reported cancelled with zero candidates rather than half-started.
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

    const base = {
      enrichmentId: candidate.id,
      provider: candidate.provider,
      indicatorType: candidate.indicatorType,
      indicator: candidate.indicator,
    };

    // Budget already spent before this batch even started — retire it rather
    // than attempting a claim that is guaranteed to be refused.
    if (candidate.attemptCount >= candidate.maxAttempts) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await sweepExhaustedCandidate({ prisma, now, candidate, base }));
      continue; // eslint-disable-line no-continue
    }

    let claim;
    try {
      // eslint-disable-next-line no-await-in-loop
      claim = await claimPendingJob(candidate.id, { client: prisma, now, leaseMs });
    } catch {
      results.push(
        buildJobResult({
          ...base,
          outcome: RUNNER_OUTCOME.CLAIM_FAILED,
          attemptCount: candidate.attemptCount,
          maxAttempts: candidate.maxAttempts,
        })
      );
      continue; // eslint-disable-line no-continue
    }

    if (!claim) {
      results.push(
        buildJobResult({
          ...base,
          outcome: RUNNER_OUTCOME.SKIPPED_NOT_CLAIMED,
          attemptCount: candidate.attemptCount,
          maxAttempts: candidate.maxAttempts,
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
      retryPolicy,
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
