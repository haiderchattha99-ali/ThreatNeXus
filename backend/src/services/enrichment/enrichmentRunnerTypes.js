"use strict";

// Pure types/validation/shape-building for the P2-T2d bounded enrichment
// runner. No Prisma, no provider call, no wall clock (every time-sensitive
// value is explicit input) — mirrors the pure/orchestration split already
// used across this directory (iocEnrichmentCacheRules.js is the pure half of
// iocEnrichmentRepository.js; enrichmentTtlPolicy.js is pure and applied by
// a caller). enrichmentRunner.js is the orchestration half of this module.
//
// Every closed outcome the runner can report for one claimed/attempted job is
// enumerated in RUNNER_OUTCOME. Callers (and tests) must compare against
// these constants, never a free-form string, so the taxonomy stays closed.

const {
  MAX_PENDING_BATCH_SIZE,
  MIN_LEASE_MS,
  MAX_LEASE_MS,
  ENRICHMENT_TERMINAL_REASON_VALUES,
} = require("./iocEnrichmentCacheRules");
const { FAILURE_CLASS_VALUES } = require("./enrichmentRetryPolicy");

class EnrichmentRunnerValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentRunnerValidationError";
  }
}

// Closed runner-outcome taxonomy. One of these, and only these, is ever
// attached to a per-job result.
const RUNNER_OUTCOME = Object.freeze({
  // The claimed job's provider result was written as its new terminal state.
  COMPLETED: "COMPLETED",
  // A listed candidate could not be claimed (another worker won the race, or
  // it went terminal between listing and claiming). No provider call made.
  SKIPPED_NOT_CLAIMED: "SKIPPED_NOT_CLAIMED",
  // Claim succeeded, but an unexpected exception (a provider/programmer bug,
  // a malformed dependency) occurred before a terminal result existed. The
  // claim was released; the job stays durably PENDING for a future attempt.
  RELEASED_AFTER_INTERNAL_ERROR: "RELEASED_AFTER_INTERNAL_ERROR",
  // Claim succeeded, but the caller's AbortSignal fired before a terminal
  // result existed. The claim was released; no job past this point is
  // started. Never conflated with a provider TIMEOUT.
  RELEASED_AFTER_CANCELLATION: "RELEASED_AFTER_CANCELLATION",
  // A provider result was obtained, but by the time completion was attempted
  // this worker's claim token was no longer the lease owner (lease expired
  // and another worker reclaimed mid-lookup). The result is discarded rather
  // than retried or force-written; the reclaiming worker owns this job now.
  STALE_CLAIM_ON_COMPLETION: "STALE_CLAIM_ON_COMPLETION",
  // Attempting to claim a listed candidate raised an unexpected error (e.g. a
  // database failure), not merely "lost the race". No claim token was ever
  // held, so there is nothing to release.
  CLAIM_FAILED: "CLAIM_FAILED",
  // A provider result was obtained and TTL was resolved, but the completion
  // WRITE itself raised an unexpected (database) error. The write may have
  // committed before the error surfaced, so the durable state is unknown: the
  // lease is deliberately KEPT, nothing is released or dead-lettered, and
  // lease expiry is the recovery path. This is the runner's realization of
  // the retry policy's HOLD_UNKNOWN_STATE action.
  COMPLETION_FAILED: "COMPLETION_FAILED",
  // completeClaimedJob REJECTED the result before writing anything (identity
  // mismatch, missing queriedAt, unknown error code). Durable state is known
  // exactly, so the retry policy applies: released with a delay, or
  // dead-lettered once the budget is spent. Never conflated with the
  // unknown-database case above.
  RELEASED_AFTER_COMPLETION_VALIDATION: "RELEASED_AFTER_COMPLETION_VALIDATION",
  // A release attempt (after cancellation, an internal error, an unknown
  // provider, or a rejected completion) itself raised an unexpected error.
  // The `failureClass` field on the job result preserves WHICH of those
  // prompted it, as a closed code — never the exception's own content.
  RELEASE_FAILED: "RELEASE_FAILED",
  // The job's stored `provider` does not resolve through the injected
  // providerRegistry. Never falls back to mock. The claim is released rather
  // than inventing a terminal result on the provider's behalf.
  UNKNOWN_PROVIDER: "UNKNOWN_PROVIDER",
  // The attempt budget is spent and this job was retired to DEAD_LETTER while
  // this worker held its claim. A queue-lifecycle terminal state, never a
  // reputation outcome.
  DEAD_LETTERED: "DEAD_LETTERED",
  // The candidate was ALREADY at/over its budget when the batch listed it —
  // no claim was taken and no provider was called; the row was swept straight
  // into DEAD_LETTER. This is what stops a job stranded at its limit by an
  // earlier crash from sitting PENDING and unclaimable forever.
  EXHAUSTED_DEAD_LETTERED: "EXHAUSTED_DEAD_LETTERED",
  // The sweep above was attempted but the guarded write matched nothing or
  // raised (another worker moved the row first). Nothing was changed.
  EXHAUSTED_SWEEP_FAILED: "EXHAUSTED_SWEEP_FAILED",
  // ---- Phase 10A-2, targeted entry point only -----------------------------
  // The claim succeeded, then the caller's authorize hook refused — in
  // practice a daily-quota reservation that was declined. NO provider was
  // constructed and provider.lookup was never reached; the claim was released
  // and its attempt-budget unit refunded, because no attempt took place.
  REFUSED_BEFORE_LOOKUP: "REFUSED_BEFORE_LOOKUP",
  // The provider has no credential configured. Discovered by a side-effect-
  // free descriptor check AFTER the claim and BEFORE any reservation, so an
  // incomplete deployment cannot spend a unit of real budget on a call that
  // could never have been made. The claim is released and refunded.
  NOT_CONFIGURED_BEFORE_LOOKUP: "NOT_CONFIGURED_BEFORE_LOOKUP",
  // The guarded contact transition (attempt -> IN_FLIGHT plus the contact
  // hold) matched zero rows, which means this worker no longer owns the lease
  // — most likely it expired while quota was being reserved. Another owner
  // may already be calling the provider, so this worker must not. Nothing was
  // sent.
  CONTACT_TRANSITION_LOST: "CONTACT_TRANSITION_LOST",
  // The request reached the transport and no durable answer followed: the
  // worker's bound fired, the provider threw, it violated its contract, or
  // the completion write's outcome is unknown. What the provider did with the
  // request is UNKNOWABLE from here.
  //
  // The claim is deliberately NOT released. Releasing writes nextAttemptAt,
  // which would clear the non-expiring contact hold and make the row
  // claimable again — re-opening the duplicate-call window. The caller
  // terminalizes both rows instead, and nothing is ever retried automatically.
  AMBIGUOUS_AFTER_CONTACT: "AMBIGUOUS_AFTER_CONTACT",
  // The explicitly named job could not be claimed at all: already terminal,
  // lost to another worker, not yet retry-eligible, budget exhausted, or held
  // by the contact sentinel. Distinct from SKIPPED_NOT_CLAIMED, which follows
  // a LISTING; nothing was listed here.
  TARGET_NOT_CLAIMABLE: "TARGET_NOT_CLAIMABLE",
});

const RUNNER_OUTCOME_VALUES = Object.freeze(Object.values(RUNNER_OUTCOME));

// Outcomes that mean a claim token was actually held at some point (used to
// compute claimedCount without threading an extra internal-only field
// through every job result).
const CLAIMED_OUTCOMES = Object.freeze(
  new Set([
    RUNNER_OUTCOME.COMPLETED,
    RUNNER_OUTCOME.STALE_CLAIM_ON_COMPLETION,
    RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR,
    RUNNER_OUTCOME.RELEASED_AFTER_CANCELLATION,
    RUNNER_OUTCOME.RELEASED_AFTER_COMPLETION_VALIDATION,
    RUNNER_OUTCOME.UNKNOWN_PROVIDER,
    RUNNER_OUTCOME.COMPLETION_FAILED,
    RUNNER_OUTCOME.RELEASE_FAILED,
    RUNNER_OUTCOME.DEAD_LETTERED,
  ])
);

// Outcomes that represent a confirmed, successful release back to PENDING.
const RELEASED_OUTCOMES = Object.freeze(
  new Set([
    RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR,
    RUNNER_OUTCOME.RELEASED_AFTER_CANCELLATION,
    RUNNER_OUTCOME.RELEASED_AFTER_COMPLETION_VALIDATION,
    RUNNER_OUTCOME.UNKNOWN_PROVIDER,
  ])
);

// Outcomes that represent a confirmed DEAD_LETTER transition, claimed or
// swept.
const DEAD_LETTERED_OUTCOMES = Object.freeze(
  new Set([RUNNER_OUTCOME.DEAD_LETTERED, RUNNER_OUTCOME.EXHAUSTED_DEAD_LETTERED])
);

// Outcomes where this worker deliberately still holds the lease because the
// durable state is unknown. Counted separately from an internal failure so an
// operator can tell "we do not know" from "we know it broke".
const HELD_UNKNOWN_STATE_OUTCOMES = Object.freeze(new Set([RUNNER_OUTCOME.COMPLETION_FAILED]));

// Outcomes that represent an unexpected failure of the runner/database
// itself, as opposed to an expected provider outcome or caller cancellation.
const INTERNAL_FAILURE_OUTCOMES = Object.freeze(
  new Set([
    RUNNER_OUTCOME.CLAIM_FAILED,
    RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR,
    RUNNER_OUTCOME.RELEASED_AFTER_COMPLETION_VALIDATION,
    RUNNER_OUTCOME.COMPLETION_FAILED,
    RUNNER_OUTCOME.RELEASE_FAILED,
    RUNNER_OUTCOME.EXHAUSTED_SWEEP_FAILED,
  ])
);

// Per-job output fields, in the exact allow-listed shape — nothing else is
// ever attached (no claimToken, no activeCacheKey, no raw error, no database
// row). Bounds mirror MIN/MAX_BATCH_SIZE below: at most one entry per
// candidate the batch actually looked at.
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = MAX_PENDING_BATCH_SIZE;

const MIN_LEASE_SECONDS = Math.ceil(MIN_LEASE_MS / 1000);
const MAX_LEASE_SECONDS = Math.floor(MAX_LEASE_MS / 1000);

const MAX_WORKER_ID_LENGTH = 128;
// Rejects any ASCII control character (including newline/tab) so a workerId
// can never break a single-line log record or inject a fake field into one.
const WORKER_ID_CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;

function assertValidWorkerId(workerId) {
  if (typeof workerId !== "string" || workerId.trim() === "" || workerId !== workerId.trim()) {
    throw new EnrichmentRunnerValidationError("workerId must be a non-empty, trimmed string");
  }
  if (workerId.length > MAX_WORKER_ID_LENGTH) {
    throw new EnrichmentRunnerValidationError(`workerId must be at most ${MAX_WORKER_ID_LENGTH} characters`);
  }
  if (WORKER_ID_CONTROL_CHAR_PATTERN.test(workerId)) {
    throw new EnrichmentRunnerValidationError("workerId must not contain control characters");
  }
  return workerId;
}

function assertValidDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new EnrichmentRunnerValidationError(`${label} must be an explicit, valid Date`);
  }
  return value;
}

function assertValidBatchSize(batchSize) {
  if (!Number.isInteger(batchSize) || batchSize < MIN_BATCH_SIZE || batchSize > MAX_BATCH_SIZE) {
    throw new EnrichmentRunnerValidationError(
      `batchSize must be an integer between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE}`
    );
  }
  return batchSize;
}

function assertValidLeaseDurationSeconds(leaseDurationSeconds) {
  if (
    !Number.isInteger(leaseDurationSeconds) ||
    leaseDurationSeconds < MIN_LEASE_SECONDS ||
    leaseDurationSeconds > MAX_LEASE_SECONDS
  ) {
    throw new EnrichmentRunnerValidationError(
      `leaseDurationSeconds must be an integer between ${MIN_LEASE_SECONDS} and ${MAX_LEASE_SECONDS}`
    );
  }
  return leaseDurationSeconds;
}

/**
 * Validates and normalizes runEnrichmentBatch's options into a closed,
 * frozen config. Throws EnrichmentRunnerValidationError for any violation —
 * every check here runs before the batch touches the database or a
 * provider, so a malformed caller never partially processes work.
 */
function assertValidRunnerConfig(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new EnrichmentRunnerValidationError("runEnrichmentBatch: options must be an object");
  }
  const {
    prisma,
    providerRegistry,
    now,
    batchSize,
    leaseDurationSeconds,
    ttlPolicy,
    retryPolicy,
    workerId,
    signal = null,
  } = options;

  if (!prisma || typeof prisma !== "object" || !prisma.iocEnrichment) {
    throw new EnrichmentRunnerValidationError(
      "runEnrichmentBatch: prisma must be a Prisma client exposing iocEnrichment"
    );
  }
  if (!providerRegistry || typeof providerRegistry.resolve !== "function") {
    throw new EnrichmentRunnerValidationError(
      "runEnrichmentBatch: providerRegistry must expose a resolve(providerName) function"
    );
  }
  const validNow = assertValidDate(now, "now");
  const validBatchSize = assertValidBatchSize(batchSize);
  const validLeaseDurationSeconds = assertValidLeaseDurationSeconds(leaseDurationSeconds);
  if (typeof ttlPolicy !== "function") {
    throw new EnrichmentRunnerValidationError("runEnrichmentBatch: ttlPolicy must be a function");
  }
  if (typeof retryPolicy !== "function") {
    throw new EnrichmentRunnerValidationError("runEnrichmentBatch: retryPolicy must be a function");
  }
  const validWorkerId = assertValidWorkerId(workerId);
  if (signal !== null && signal !== undefined && typeof signal.aborted !== "boolean") {
    throw new EnrichmentRunnerValidationError(
      "runEnrichmentBatch: signal must be an AbortSignal-shaped object (an `aborted` boolean) or omitted"
    );
  }

  return Object.freeze({
    prisma,
    providerRegistry,
    now: validNow,
    batchSize: validBatchSize,
    leaseMs: validLeaseDurationSeconds * 1000,
    ttlPolicy,
    retryPolicy,
    workerId: validWorkerId,
    signal: signal || null,
  });
}

function isAborted(signal) {
  return Boolean(signal && signal.aborted);
}

function cloneDateOrNull(value) {
  return value instanceof Date ? new Date(value.getTime()) : null;
}

/**
 * Builds one closed, frozen per-job result. `enrichmentId`/`provider`/
 * `indicatorType`/`indicator` describe which job this is; everything else is
 * the bounded outcome. No claim token, cache key, or database row ever
 * passes through this function.
 */
function buildJobResult({
  enrichmentId,
  provider,
  indicatorType,
  indicator,
  outcome,
  terminalStatus = null,
  queriedAt = null,
  expiresAt = null,
  failureClass = null,
  terminalReasonCode = null,
  nextAttemptAt = null,
  attemptCount = null,
  maxAttempts = null,
  // Phase 10A-2, targeted path only. The Phase-10 attempt ledger has to record
  // WHICH kind of failure a negative result was — a provider that refused the
  // request, one that broke, and one that was never reached are three
  // different facts. Without these the ledger could only ever say
  // TRANSPORT_ERROR. Additive: the ADMIN batch supplies none of them.
  httpStatus = null,
  errorCode = null,
  retryAfterSeconds = null,
}) {
  if (!RUNNER_OUTCOME_VALUES.includes(outcome)) {
    throw new EnrichmentRunnerValidationError(`buildJobResult: unknown outcome "${String(outcome)}"`);
  }
  if (!Number.isInteger(enrichmentId) || enrichmentId <= 0) {
    throw new EnrichmentRunnerValidationError("buildJobResult: enrichmentId must be a positive integer");
  }
  // Both of these are closed vocabularies. Validating them HERE (rather than
  // trusting the runner) is what keeps a free-form string — an error message,
  // a provider fragment — structurally unable to reach a caller through this
  // shape, whatever a future call site does.
  if (failureClass !== null && !FAILURE_CLASS_VALUES.includes(failureClass)) {
    throw new EnrichmentRunnerValidationError(
      `buildJobResult: unknown failureClass "${String(failureClass)}"`
    );
  }
  if (terminalReasonCode !== null && !ENRICHMENT_TERMINAL_REASON_VALUES.includes(terminalReasonCode)) {
    throw new EnrichmentRunnerValidationError(
      `buildJobResult: unknown terminalReasonCode "${String(terminalReasonCode)}"`
    );
  }
  return Object.freeze({
    enrichmentId,
    provider: typeof provider === "string" ? provider : null,
    indicatorType: typeof indicatorType === "string" ? indicatorType : null,
    indicator: typeof indicator === "string" ? indicator : null,
    outcome,
    terminalStatus: typeof terminalStatus === "string" ? terminalStatus : null,
    queriedAt: cloneDateOrNull(queriedAt),
    expiresAt: cloneDateOrNull(expiresAt),
    // Closed provenance: WHY a release/dead-letter/hold happened. This is the
    // only explanation that ever leaves the runner — never err.message.
    failureClass,
    terminalReasonCode,
    nextAttemptAt: cloneDateOrNull(nextAttemptAt),
    attemptCount: Number.isInteger(attemptCount) ? attemptCount : null,
    maxAttempts: Number.isInteger(maxAttempts) ? maxAttempts : null,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    // A closed provider error code, never free text — the same rule
    // failureClass follows above.
    errorCode: typeof errorCode === "string" ? errorCode : null,
    retryAfterSeconds: Number.isInteger(retryAfterSeconds) ? retryAfterSeconds : null,
  });
}

/**
 * Builds the closed, defensively-copied batch summary every
 * runEnrichmentBatch call returns. Every count is derived from `results`
 * itself, never tracked separately, so the summary can never drift from the
 * per-job list it is describing.
 */
function buildBatchSummary({ requestedBatchSize, candidateCount, cancelled, results }) {
  const frozenResults = Object.freeze(results.map((r) => r));

  const statusCounts = {};
  let claimedCount = 0;
  let completedCount = 0;
  let skippedNotClaimedCount = 0;
  let releasedCount = 0;
  let staleCompletionCount = 0;
  let internalFailureCount = 0;
  let unknownProviderCount = 0;
  let deadLetteredCount = 0;
  let heldUnknownStateCount = 0;

  frozenResults.forEach((job) => {
    if (CLAIMED_OUTCOMES.has(job.outcome)) claimedCount += 1;
    if (job.outcome === RUNNER_OUTCOME.COMPLETED) {
      completedCount += 1;
      const key = job.terminalStatus || "UNKNOWN";
      statusCounts[key] = (statusCounts[key] || 0) + 1;
    }
    if (job.outcome === RUNNER_OUTCOME.SKIPPED_NOT_CLAIMED) skippedNotClaimedCount += 1;
    if (RELEASED_OUTCOMES.has(job.outcome)) releasedCount += 1;
    if (job.outcome === RUNNER_OUTCOME.STALE_CLAIM_ON_COMPLETION) staleCompletionCount += 1;
    if (INTERNAL_FAILURE_OUTCOMES.has(job.outcome)) internalFailureCount += 1;
    if (job.outcome === RUNNER_OUTCOME.UNKNOWN_PROVIDER) unknownProviderCount += 1;
    if (DEAD_LETTERED_OUTCOMES.has(job.outcome)) deadLetteredCount += 1;
    if (HELD_UNKNOWN_STATE_OUTCOMES.has(job.outcome)) heldUnknownStateCount += 1;
  });

  return Object.freeze({
    requestedBatchSize,
    candidateCount,
    claimedCount,
    completedCount,
    statusCounts: Object.freeze(statusCounts),
    skippedNotClaimedCount,
    releasedCount,
    staleCompletionCount,
    internalFailureCount,
    unknownProviderCount,
    deadLetteredCount,
    heldUnknownStateCount,
    cancelled: Boolean(cancelled),
    results: frozenResults,
  });
}

module.exports = {
  EnrichmentRunnerValidationError,
  RUNNER_OUTCOME,
  RUNNER_OUTCOME_VALUES,
  CLAIMED_OUTCOMES,
  RELEASED_OUTCOMES,
  DEAD_LETTERED_OUTCOMES,
  HELD_UNKNOWN_STATE_OUTCOMES,
  INTERNAL_FAILURE_OUTCOMES,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  MIN_LEASE_SECONDS,
  MAX_LEASE_SECONDS,
  MAX_WORKER_ID_LENGTH,
  assertValidRunnerConfig,
  isAborted,
  buildJobResult,
  buildBatchSummary,
};
