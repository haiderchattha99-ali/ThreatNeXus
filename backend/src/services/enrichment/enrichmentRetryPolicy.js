"use strict";

// Pure IOC enrichment retry / dead-letter policy (P2-T2e-1). Decides what a
// worker should do with a job after one processing attempt: complete it,
// return it to the queue with a bounded delay, give up on it permanently, or
// refuse to touch it because the durable state is unknown.
//
// No Prisma, no provider call, no filesystem, and — deliberately — no wall
// clock: `now` is the only time input, so `nextAttemptAt` is always
// `now + delaySeconds`, never "whenever this function happened to run". The
// same pure/orchestration split used by enrichmentTtlPolicy.js (decides) and
// enrichmentRunner.js (applies).
//
// ---------------------------------------------------------------------------
// Why this module exists
// ---------------------------------------------------------------------------
// Before P2-T2e-1 a failed attempt released its claim immediately, with no
// delay and no attempt budget. That is correct for one manual batch and wrong
// the moment execution is scheduled: a job that fails identically every time
// (a persisted queryParams value the provider's own contract check rejects, a
// provider name no longer registered) would be re-claimed, re-failed and
// re-released forever, consuming a batch slot on every invocation and starving
// real work. The three mechanisms that stop that are all here:
//
//   1. a bounded attempt budget      -> DEAD_LETTER at maxAttempts
//   2. a bounded, non-zero delay     -> no immediate re-claim loop
//   3. a class-aware decision        -> a cancelled job is not a failed job,
//                                       and an unknown database outcome is
//                                       not a failure at all
//
// ---------------------------------------------------------------------------
// The one asymmetry worth stating plainly
// ---------------------------------------------------------------------------
// COMPLETION_VALIDATION_ERROR and COMPLETION_DATABASE_ERROR both mean "the
// completion call raised", and they get opposite treatment:
//
//   COMPLETION_VALIDATION_ERROR — completeClaimedJob validated the result and
//     rejected it BEFORE issuing its guarded write. No row was touched. The
//     durable state is therefore known exactly ("still PENDING, still ours"),
//     so releasing or dead-lettering is safe.
//
//   COMPLETION_DATABASE_ERROR — the write itself raised. It may have committed
//     before the connection dropped. The durable state is NOT known, so the
//     only safe action is to do nothing at all and let the lease expire
//     naturally: HOLD_UNKNOWN_STATE. Releasing here could hand a job that has
//     already been completed to another worker, and dead-lettering it could
//     bury a row that actually holds a good result.
//
// Distinguishing the two requires typed errors from the persistence layer
// (IocEnrichmentValidationError vs anything else), never string-matching an
// error message — see enrichmentRunner.js's classification.

const { ENRICHMENT_STATUS } = require("./iocEnrichmentTypes");
const {
  ENRICHMENT_TERMINAL_REASON,
  MIN_MAX_ATTEMPTS,
  MAX_MAX_ATTEMPTS,
  isTerminalStatus,
} = require("./iocEnrichmentCacheRules");

class EnrichmentRetryPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentRetryPolicyError";
  }
}

// Closed classification of "what happened during this attempt". The runner
// maps every one of its internal paths onto exactly one of these; this module
// never inspects an Error object, a message, or a stack.
const FAILURE_CLASS = Object.freeze({
  // The provider returned a normalized terminal result — including negative
  // ones (TIMEOUT/RATE_LIMITED/FAILED/...). Not a failure of the *job*.
  EXPECTED_PROVIDER_RESULT: "EXPECTED_PROVIDER_RESULT",
  // The caller's AbortSignal fired. The attempt never happened as far as the
  // job is concerned, so it must not consume the attempt budget.
  CALLER_CANCELLATION: "CALLER_CANCELLATION",
  // The provider threw, or returned something its own contract forbids
  // (a PENDING result, a non-result). A bug, not an outcome.
  PROVIDER_PROGRAMMER_ERROR: "PROVIDER_PROGRAMMER_ERROR",
  // The job's stored provider name does not resolve through the registry.
  // Retrying helps only if the registry changes, so this backs off hard and
  // then gives up rather than spinning.
  UNKNOWN_PROVIDER: "UNKNOWN_PROVIDER",
  // completeClaimedJob rejected the result before writing anything.
  COMPLETION_VALIDATION_ERROR: "COMPLETION_VALIDATION_ERROR",
  // The completion write itself raised. Durable state unknown.
  COMPLETION_DATABASE_ERROR: "COMPLETION_DATABASE_ERROR",
  // A release write raised. The lease is still (probably) ours; do nothing.
  RELEASE_DATABASE_ERROR: "RELEASE_DATABASE_ERROR",
});

const FAILURE_CLASS_VALUES = Object.freeze(Object.values(FAILURE_CLASS));

// Closed set of actions a caller may be told to take.
const RETRY_ACTION = Object.freeze({
  // Write the provider's terminal result (the normal path).
  COMPLETE: "COMPLETE",
  // Return the job to the queue, unclaimed, not eligible again until
  // `nextAttemptAt`.
  RELEASE_WITH_DELAY: "RELEASE_WITH_DELAY",
  // Permanently stop processing this job; record `terminalReasonCode`.
  DEAD_LETTER: "DEAD_LETTER",
  // Touch nothing. The durable state may not be what we think it is; the
  // lease expiry is the recovery mechanism.
  HOLD_UNKNOWN_STATE: "HOLD_UNKNOWN_STATE",
});

const RETRY_ACTION_VALUES = Object.freeze(Object.values(RETRY_ACTION));

// Absolute bounds every resolved delay is clamped into, whatever the class,
// the override, or the provider's Retry-After. A zero/negative delay would
// re-admit the job to the very next batch (the poison loop this module
// exists to prevent); an unbounded one would strand it effectively forever.
const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 86400; // 24h

// Per-class base delays. PROVIDER_PROGRAMMER_ERROR and
// COMPLETION_VALIDATION_ERROR back off exponentially (the fault may be
// transient-ish — a bad deploy, a provider hiccup); UNKNOWN_PROVIDER uses a
// long flat delay, because only an operator registering the provider can
// change the outcome and hammering it sooner cannot help.
const DEFAULT_PROVIDER_ERROR_BASE_DELAY_SECONDS = 300; // 5m, doubling
const DEFAULT_COMPLETION_VALIDATION_BASE_DELAY_SECONDS = 300;
const DEFAULT_UNKNOWN_PROVIDER_DELAY_SECONDS = 3600; // 1h, flat
const DEFAULT_CANCELLATION_DELAY_SECONDS = 60; // short: nothing is wrong
const DEFAULT_MAX_BACKOFF_SECONDS = 3600; // caps the exponential growth

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertBoundedInt(value, { label, min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnrichmentRetryPolicyError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function resolveOverrides(policyOverrides) {
  const overrides = isPlainObject(policyOverrides) ? policyOverrides : {};
  return Object.freeze({
    providerErrorBaseDelaySeconds: assertBoundedInt(
      overrides.providerErrorBaseDelaySeconds ?? DEFAULT_PROVIDER_ERROR_BASE_DELAY_SECONDS,
      { label: "policyOverrides.providerErrorBaseDelaySeconds", min: MIN_DELAY_SECONDS, max: MAX_DELAY_SECONDS }
    ),
    completionValidationBaseDelaySeconds: assertBoundedInt(
      overrides.completionValidationBaseDelaySeconds ?? DEFAULT_COMPLETION_VALIDATION_BASE_DELAY_SECONDS,
      { label: "policyOverrides.completionValidationBaseDelaySeconds", min: MIN_DELAY_SECONDS, max: MAX_DELAY_SECONDS }
    ),
    unknownProviderDelaySeconds: assertBoundedInt(
      overrides.unknownProviderDelaySeconds ?? DEFAULT_UNKNOWN_PROVIDER_DELAY_SECONDS,
      { label: "policyOverrides.unknownProviderDelaySeconds", min: MIN_DELAY_SECONDS, max: MAX_DELAY_SECONDS }
    ),
    cancellationDelaySeconds: assertBoundedInt(
      overrides.cancellationDelaySeconds ?? DEFAULT_CANCELLATION_DELAY_SECONDS,
      { label: "policyOverrides.cancellationDelaySeconds", min: MIN_DELAY_SECONDS, max: MAX_DELAY_SECONDS }
    ),
    maxBackoffSeconds: assertBoundedInt(overrides.maxBackoffSeconds ?? DEFAULT_MAX_BACKOFF_SECONDS, {
      label: "policyOverrides.maxBackoffSeconds",
      min: MIN_DELAY_SECONDS,
      max: MAX_DELAY_SECONDS,
    }),
  });
}

// Deterministic doubling backoff, capped before any clamping so the growth
// itself is bounded rather than relying on MAX_DELAY_SECONDS to catch it.
// attemptCount 1 -> base, 2 -> 2x, 3 -> 4x, ... Never randomized: an
// explainable schedule is worth more here than jitter, and the queue's
// contention control is the claim guard, not the delay.
function exponentialBackoffSeconds(baseSeconds, attemptCount, maxBackoffSeconds) {
  const exponent = Math.max(0, attemptCount - 1);
  // Cap the exponent before shifting so a large attemptCount cannot overflow
  // into Infinity on its way to being clamped.
  const boundedExponent = Math.min(exponent, 30);
  const raw = baseSeconds * 2 ** boundedExponent;
  return Math.min(raw, maxBackoffSeconds);
}

// A provider's Retry-After may only ever EXTEND the policy's own delay, never
// shorten it: a provider asking us back in 5 seconds does not override a
// deliberate 5-minute backoff, but one asking for 2 hours is respected.
function applyRetryAfterFloor(policySeconds, retryAfterSeconds) {
  if (retryAfterSeconds === null || retryAfterSeconds === undefined) return policySeconds;
  return Math.max(policySeconds, Math.ceil(retryAfterSeconds));
}

function clampDelaySeconds(seconds) {
  return Math.min(Math.max(seconds, MIN_DELAY_SECONDS), MAX_DELAY_SECONDS);
}

function buildDecision({ action, now, delaySeconds = null, terminalReasonCode = null, policyReason, refundAttempt = false }) {
  return Object.freeze({
    action,
    delaySeconds,
    nextAttemptAt: delaySeconds === null ? null : new Date(now.getTime() + delaySeconds * 1000),
    terminalReasonCode,
    // True only for CALLER_CANCELLATION: the claim incremented attemptCount,
    // but no processing attempt actually took place, so the budget must be
    // handed back. Reversing exactly this attempt's own increment is not a
    // reset — see releaseClaimedJob's `refundAttempt`.
    refundAttempt,
    policyReason,
  });
}

/**
 * Decides what to do with one job after one attempt.
 *
 * @param {{failureClass: string, currentAttemptCount: number,
 *   maxAttempts: number, now: Date, status?: string|null,
 *   retryAfterSeconds?: number|null, policyOverrides?: object|null}} input
 *   `currentAttemptCount` is the count AFTER this attempt's own increment
 *   (i.e. the value on the claimed row), so `currentAttemptCount >=
 *   maxAttempts` means "this was the last attempt allowed".
 * @returns {{action: string, delaySeconds: number|null,
 *   nextAttemptAt: Date|null, terminalReasonCode: string|null,
 *   refundAttempt: boolean, policyReason: string}} frozen
 */
function resolveEnrichmentRetry({
  failureClass,
  currentAttemptCount,
  maxAttempts,
  now,
  status = null,
  retryAfterSeconds = null,
  policyOverrides = null,
} = {}) {
  if (!FAILURE_CLASS_VALUES.includes(failureClass)) {
    throw new EnrichmentRetryPolicyError(
      `resolveEnrichmentRetry: unknown failureClass "${String(failureClass)}"`
    );
  }
  if (!Number.isInteger(currentAttemptCount) || currentAttemptCount < 0) {
    throw new EnrichmentRetryPolicyError(
      "resolveEnrichmentRetry: currentAttemptCount must be a non-negative integer"
    );
  }
  assertBoundedInt(maxAttempts, {
    label: "resolveEnrichmentRetry: maxAttempts",
    min: MIN_MAX_ATTEMPTS,
    max: MAX_MAX_ATTEMPTS,
  });
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new EnrichmentRetryPolicyError("resolveEnrichmentRetry: now must be an explicit valid Date");
  }
  if (
    retryAfterSeconds !== null &&
    retryAfterSeconds !== undefined &&
    (typeof retryAfterSeconds !== "number" || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0)
  ) {
    throw new EnrichmentRetryPolicyError(
      "resolveEnrichmentRetry: retryAfterSeconds must be null or a non-negative finite number"
    );
  }

  const overrides = resolveOverrides(policyOverrides);
  const budgetExhausted = currentAttemptCount >= maxAttempts;

  // --- The provider did its job -------------------------------------------
  if (failureClass === FAILURE_CLASS.EXPECTED_PROVIDER_RESULT) {
    if (status === ENRICHMENT_STATUS.PENDING) {
      throw new EnrichmentRetryPolicyError(
        "resolveEnrichmentRetry: PENDING is not an expected provider result — it is queued work"
      );
    }
    if (!isTerminalStatus(status)) {
      throw new EnrichmentRetryPolicyError(
        `resolveEnrichmentRetry: EXPECTED_PROVIDER_RESULT requires a terminal provider status, got "${String(status)}"`
      );
    }
    // Every terminal provider status completes, including the negative ones.
    // A cached RATE_LIMITED/TIMEOUT is real evidence of "no context available"
    // and is governed by the TTL policy, not by this retry budget.
    return buildDecision({ action: RETRY_ACTION.COMPLETE, now, policyReason: `${status}_COMPLETE` });
  }

  // --- We do not know what the database did -------------------------------
  // Both of these deliberately ignore the attempt budget: giving up on a job
  // whose true state is unknown is exactly as wrong as retrying it blindly.
  // The lease expiry is the only safe recovery path.
  if (failureClass === FAILURE_CLASS.COMPLETION_DATABASE_ERROR) {
    return buildDecision({
      action: RETRY_ACTION.HOLD_UNKNOWN_STATE,
      now,
      policyReason: "COMPLETION_DATABASE_ERROR_HOLD_LEASE",
    });
  }
  if (failureClass === FAILURE_CLASS.RELEASE_DATABASE_ERROR) {
    return buildDecision({
      action: RETRY_ACTION.HOLD_UNKNOWN_STATE,
      now,
      policyReason: "RELEASE_DATABASE_ERROR_HOLD_LEASE",
    });
  }

  // --- Nothing is wrong with the job; we were interrupted ------------------
  // Cancellation NEVER dead-letters, at any attempt count: an operator
  // stopping a batch three times must not permanently bury a healthy job.
  // The attempt is refunded so the budget measures real attempts only.
  if (failureClass === FAILURE_CLASS.CALLER_CANCELLATION) {
    return buildDecision({
      action: RETRY_ACTION.RELEASE_WITH_DELAY,
      now,
      delaySeconds: clampDelaySeconds(
        applyRetryAfterFloor(overrides.cancellationDelaySeconds, retryAfterSeconds)
      ),
      refundAttempt: true,
      policyReason: "CANCELLED_RELEASE_WITHOUT_PENALTY",
    });
  }

  // --- Repeatable local failures: back off, then give up -------------------
  if (failureClass === FAILURE_CLASS.UNKNOWN_PROVIDER) {
    if (budgetExhausted) {
      return buildDecision({
        action: RETRY_ACTION.DEAD_LETTER,
        now,
        terminalReasonCode: ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_UNKNOWN_PROVIDER,
        policyReason: "UNKNOWN_PROVIDER_EXHAUSTED",
      });
    }
    return buildDecision({
      action: RETRY_ACTION.RELEASE_WITH_DELAY,
      now,
      delaySeconds: clampDelaySeconds(
        applyRetryAfterFloor(overrides.unknownProviderDelaySeconds, retryAfterSeconds)
      ),
      policyReason: "UNKNOWN_PROVIDER_BACKOFF",
    });
  }

  if (failureClass === FAILURE_CLASS.PROVIDER_PROGRAMMER_ERROR) {
    if (budgetExhausted) {
      return buildDecision({
        action: RETRY_ACTION.DEAD_LETTER,
        now,
        terminalReasonCode: ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_PROVIDER_ERROR,
        policyReason: "PROVIDER_PROGRAMMER_ERROR_EXHAUSTED",
      });
    }
    return buildDecision({
      action: RETRY_ACTION.RELEASE_WITH_DELAY,
      now,
      delaySeconds: clampDelaySeconds(
        applyRetryAfterFloor(
          exponentialBackoffSeconds(
            overrides.providerErrorBaseDelaySeconds,
            currentAttemptCount,
            overrides.maxBackoffSeconds
          ),
          retryAfterSeconds
        )
      ),
      policyReason: "PROVIDER_PROGRAMMER_ERROR_BACKOFF",
    });
  }

  // COMPLETION_VALIDATION_ERROR — safe to act on, because no write happened.
  if (budgetExhausted) {
    return buildDecision({
      action: RETRY_ACTION.DEAD_LETTER,
      now,
      terminalReasonCode: ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_COMPLETION_VALIDATION,
      policyReason: "COMPLETION_VALIDATION_ERROR_EXHAUSTED",
    });
  }
  return buildDecision({
    action: RETRY_ACTION.RELEASE_WITH_DELAY,
    now,
    delaySeconds: clampDelaySeconds(
      applyRetryAfterFloor(
        exponentialBackoffSeconds(
          overrides.completionValidationBaseDelaySeconds,
          currentAttemptCount,
          overrides.maxBackoffSeconds
        ),
        retryAfterSeconds
      )
    ),
    policyReason: "COMPLETION_VALIDATION_ERROR_BACKOFF",
  });
}

module.exports = {
  EnrichmentRetryPolicyError,
  FAILURE_CLASS,
  FAILURE_CLASS_VALUES,
  RETRY_ACTION,
  RETRY_ACTION_VALUES,
  MIN_DELAY_SECONDS,
  MAX_DELAY_SECONDS,
  DEFAULT_PROVIDER_ERROR_BASE_DELAY_SECONDS,
  DEFAULT_COMPLETION_VALIDATION_BASE_DELAY_SECONDS,
  DEFAULT_UNKNOWN_PROVIDER_DELAY_SECONDS,
  DEFAULT_CANCELLATION_DELAY_SECONDS,
  DEFAULT_MAX_BACKOFF_SECONDS,
  resolveEnrichmentRetry,
};
