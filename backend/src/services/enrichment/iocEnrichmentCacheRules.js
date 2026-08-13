"use strict";

// Pure cache/queue decision rules for IOC enrichment persistence (P2-T2b).
// No Prisma, no network, no filesystem, and — deliberately — no wall clock:
// every time-sensitive function takes an explicit `asOf`/`now`, so freshness
// is reproducible and testable at exact boundaries rather than "whenever the
// test happened to run".
//
// ---------------------------------------------------------------------------
// Positive and negative caching, and why both are cached
// ---------------------------------------------------------------------------
// POSITIVE cache — SUCCESS. `expiresAt` controls freshness; inside the window
// the stored normalized payload is reused and the provider is not re-queried.
//
// NEGATIVE cache — NOT_FOUND, RATE_LIMITED, INVALID_KEY, TIMEOUT, FAILED,
// UNSUPPORTED_INDICATOR, SKIPPED_DISABLED. These are cached too, on purpose:
// re-hammering a provider that just returned 429, or that just rejected the
// configured key, is exactly how the remaining quota gets burned. Each carries
// its own explicit `expiresAt` supplied by the caller (this packet does not
// choose TTL policy — P2-T2c does).
//
// The critical invariant both share:
//
//   A cached FAILURE IS NOT A CLEAN ADDRESS.
//
// `findFreshCachedResult` returns the terminal status *exactly* as stored. It
// never collapses NOT_FOUND/TIMEOUT/FAILED into "no abuse reported", and never
// substitutes a score of 0. Downstream risk scoring must therefore always be
// able to distinguish:
//
//   SUCCESS with abuseConfidenceScore === 0   -> the provider looked and found
//                                                nothing. Real evidence.
//   TIMEOUT / FAILED / RATE_LIMITED / ...     -> no reputation context exists.
//                                                Absence of data, not evidence
//                                                of safety.
//
// A missing `expiresAt`, or one that has already passed, means NOT FRESH —
// for a success and a failure alike. Freshness is the half-open window
// [queriedAt, expiresAt): `expiresAt` exactly equal to `asOf` is expired.

const {
  ENRICHMENT_STATUS,
  ENRICHMENT_STATUS_VALUES,
  PROVIDER_ERROR_MESSAGES,
} = require("./iocEnrichmentTypes");

// PENDING is the one non-terminal status: durable queued work, never a
// readable result.
//
// NOTE: this list is derived from the PROVIDER result taxonomy
// (iocEnrichmentTypes.ENRICHMENT_STATUS), which deliberately does not contain
// DEAD_LETTER. That is what makes "a dead-lettered job is never reputation
// evidence" structural rather than documented: `isTerminalStatus`,
// `buildTerminalFields` and `findFreshCachedResult` all key off this list, so
// a DEAD_LETTER row can never be returned as a cache hit or be produced by a
// provider.
const TERMINAL_STATUSES = Object.freeze(
  ENRICHMENT_STATUS_VALUES.filter((status) => status !== ENRICHMENT_STATUS.PENDING)
);

// The QUEUE lifecycle status set = every provider status plus DEAD_LETTER.
// This mirrors the Prisma `IocEnrichmentStatus` enum exactly; the provider
// taxonomy above is a strict subset of it.
const QUEUE_STATUS = Object.freeze({
  ...ENRICHMENT_STATUS,
  // "We stopped processing this job." NOT "the indicator is clean" and NOT a
  // provider outcome — see the schema comment on IocEnrichmentStatus.
  DEAD_LETTER: "DEAD_LETTER",
});

const QUEUE_STATUS_VALUES = Object.freeze(Object.values(QUEUE_STATUS));

// Attempt-budget bounds. maxAttempts is persisted per job so a job's budget
// cannot change under it between attempts; these bound what may be persisted.
const MIN_MAX_ATTEMPTS = 1;
const MAX_MAX_ATTEMPTS = 10;
const DEFAULT_MAX_ATTEMPTS = 3;

// Closed reason codes for the DEAD_LETTER transition. This is the ONLY
// vocabulary `terminalReasonCode` may hold — never a caught Error's message,
// never a provider payload fragment, never free-form operator text.
const ENRICHMENT_TERMINAL_REASON = Object.freeze({
  // Repeated provider/programmer contract violations (a thrown exception, a
  // PENDING or malformed result) exhausted the attempt budget.
  MAX_ATTEMPTS_PROVIDER_ERROR: "MAX_ATTEMPTS_PROVIDER_ERROR",
  // The job's stored provider name never resolved through the registry.
  MAX_ATTEMPTS_UNKNOWN_PROVIDER: "MAX_ATTEMPTS_UNKNOWN_PROVIDER",
  // The persistence layer rejected the provider's result on every attempt
  // (identity mismatch, missing queriedAt, unknown error code, ...).
  MAX_ATTEMPTS_COMPLETION_VALIDATION: "MAX_ATTEMPTS_COMPLETION_VALIDATION",
  // The row was found already at/over its budget before an attempt could
  // start — the sweep path for a job stranded by an earlier crash.
  MAX_ATTEMPTS_EXHAUSTED: "MAX_ATTEMPTS_EXHAUSTED",
  // Added in Phase 10A-2. The process died at or after the moment the request
  // was handed to the transport, so whether the provider received, processed
  // and CHARGED for it is unknowable from inside this system. The row is
  // retired rather than retried: a retry could double-charge a paid third
  // party, and a fabricated failure would invent an outcome no provider gave.
  // Deliberately NOT one of the MAX_ATTEMPTS_* codes — the attempt budget is
  // irrelevant here, because one ambiguous contact is already enough to stop.
  AMBIGUOUS_AFTER_CONTACT: "AMBIGUOUS_AFTER_CONTACT",
});

const ENRICHMENT_TERMINAL_REASON_VALUES = Object.freeze(Object.values(ENRICHMENT_TERMINAL_REASON));

function isValidTerminalReasonCode(reasonCode) {
  return ENRICHMENT_TERMINAL_REASON_VALUES.includes(reasonCode);
}

// Bounds on how many pending candidates one listing may return.
const DEFAULT_PENDING_BATCH_SIZE = 25;
const MAX_PENDING_BATCH_SIZE = 200;

// Bounds on a lease. A lease exists so a consumer that dies mid-flight cannot
// strand a job forever; it is not a rate limiter.
const MIN_LEASE_MS = 1000;
const MAX_LEASE_MS = 3600000;

// Every column buildTerminalFields is allowed to write. Anything not on this
// list (a raw response body, a request header, an API key, a caught Error's
// own message) has no path into the table at all.
const TERMINAL_RESULT_COLUMNS = Object.freeze([
  "abuseConfidenceScore",
  "totalReports",
  "countryCode",
  "isp",
  "domain",
  "usageType",
  "isWhitelisted",
  "lastReportedAt",
  "httpStatus",
  "errorCode",
  "errorMessage",
  "retryAfterSeconds",
]);

class IocEnrichmentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "IocEnrichmentValidationError";
  }
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Is this stored row a usable cached result as of `asOf`?
 * PENDING is never fresh — queued work is not evidence. A null/expired
 * `expiresAt` is never fresh, whatever the status.
 *
 * @param {{status: string, expiresAt: Date|null, queriedAt: Date|null}} record
 * @param {Date} asOf explicit evaluation time — never the wall clock
 */
function isFreshTerminalRecord(record, asOf) {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new IocEnrichmentValidationError("isFreshTerminalRecord: asOf must be a valid Date");
  }
  if (!record || !isTerminalStatus(record.status)) return false;
  if (!(record.queriedAt instanceof Date)) return false;
  if (!(record.expiresAt instanceof Date)) return false;
  // Half-open window: expiresAt === asOf is already expired.
  return record.expiresAt.getTime() > asOf.getTime();
}

/**
 * Is this stored row RETRY-ELIGIBLE as of `now`? A null `nextAttemptAt` means
 * "eligible now"; a future one hides the row until then. The boundary is
 * inclusive — `nextAttemptAt === now` is eligible — matching the `lte`
 * comparison listPendingCandidates issues, so the pure rule and the query can
 * never disagree about the exact instant.
 */
function isRetryEligibleRecord(record, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new IocEnrichmentValidationError("isRetryEligibleRecord: now must be a valid Date");
  }
  if (!record) return false;
  if (record.nextAttemptAt === null || record.nextAttemptAt === undefined) return true;
  if (!(record.nextAttemptAt instanceof Date)) return true;
  return record.nextAttemptAt.getTime() <= now.getTime();
}

/**
 * Has this row spent its attempt budget? A row at or over `maxAttempts` may
 * never be claimed again — it is dead-letter material, not work.
 */
function isAttemptBudgetExhausted(record) {
  if (!record) return false;
  const attemptCount = Number.isInteger(record.attemptCount) ? record.attemptCount : 0;
  const maxAttempts = Number.isInteger(record.maxAttempts) ? record.maxAttempts : DEFAULT_MAX_ATTEMPTS;
  return attemptCount >= maxAttempts;
}

/**
 * Is this stored row claimable as of `now`? True for an unclaimed PENDING row
 * and for a PENDING row whose lease has expired (lease boundary is inclusive:
 * leaseExpiresAt === now is reclaimable). Never true for a terminal row, a
 * row whose retry delay has not elapsed, or a row that has spent its attempt
 * budget.
 */
function isClaimableRecord(record, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new IocEnrichmentValidationError("isClaimableRecord: now must be a valid Date");
  }
  if (!record || record.status !== ENRICHMENT_STATUS.PENDING) return false;
  if (!isRetryEligibleRecord(record, now)) return false;
  if (isAttemptBudgetExhausted(record)) return false;
  if (record.claimToken === null || record.claimToken === undefined) return true;
  if (!(record.leaseExpiresAt instanceof Date)) return true;
  return record.leaseExpiresAt.getTime() <= now.getTime();
}

function assertPositiveIntegerOrNull(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value)) {
    throw new IocEnrichmentValidationError(`${label} must be an integer or null`);
  }
  return value;
}

/**
 * Projects a P2-T2a normalized result onto exactly the allow-listed terminal
 * columns. Every column is written on every completion — a failure status
 * explicitly writes `null` into each SUCCESS-payload column rather than
 * leaving stale values behind, so no partial data can ever survive.
 *
 * `errorMessage` is re-derived from `errorInfo.code` through the closed
 * PROVIDER_ERROR_MESSAGES map, never copied from the result object. Even a
 * result carrying an attacker-influenced or secret-bearing message string
 * cannot leak it into the database through this function.
 *
 * @param {object} result a normalized result from createEnrichmentResult
 * @returns {object} plain column -> value map (frozen)
 */
function buildTerminalFields(result) {
  if (!result || typeof result !== "object") {
    throw new IocEnrichmentValidationError("buildTerminalFields: result must be an object");
  }
  if (!isTerminalStatus(result.status)) {
    throw new IocEnrichmentValidationError(
      `buildTerminalFields: status "${String(result.status)}" is not a terminal status`
    );
  }

  const isSuccess = result.status === ENRICHMENT_STATUS.SUCCESS;
  const data = isSuccess ? result.data : null;
  if (isSuccess && (!data || typeof data !== "object")) {
    throw new IocEnrichmentValidationError("buildTerminalFields: SUCCESS result must carry data");
  }

  const errorCode =
    result.errorInfo && typeof result.errorInfo.code === "string" ? result.errorInfo.code : null;
  if (errorCode !== null && !Object.prototype.hasOwnProperty.call(PROVIDER_ERROR_MESSAGES, errorCode)) {
    throw new IocEnrichmentValidationError(
      `buildTerminalFields: unknown provider error code "${errorCode}"`
    );
  }

  // Whole seconds, rounded UP: a stored backoff is never shorter than the one
  // the provider asked for. (createEnrichmentResult permits a non-integer.)
  const retryAfterSeconds =
    result.retryAfterSeconds === null || result.retryAfterSeconds === undefined
      ? null
      : Math.ceil(result.retryAfterSeconds);

  return Object.freeze({
    abuseConfidenceScore: data ? assertPositiveIntegerOrNull(data.abuseConfidenceScore, "abuseConfidenceScore") : null,
    totalReports: data ? assertPositiveIntegerOrNull(data.totalReports, "totalReports") : null,
    countryCode: data ? data.countryCode ?? null : null,
    isp: data ? data.isp ?? null : null,
    domain: data ? data.domain ?? null : null,
    usageType: data ? data.usageType ?? null : null,
    isWhitelisted: data ? data.isWhitelisted ?? null : null,
    lastReportedAt: data && data.lastReportedAt instanceof Date ? new Date(data.lastReportedAt.getTime()) : null,
    httpStatus: assertPositiveIntegerOrNull(result.httpStatus ?? null, "httpStatus"),
    errorCode,
    errorMessage: errorCode === null ? null : PROVIDER_ERROR_MESSAGES[errorCode],
    retryAfterSeconds,
  });
}

/**
 * Normalizes a caller-supplied batch size into the bounded range. Never
 * unbounded — a queue listing must not be able to pull the whole table.
 */
function boundBatchSize(limit) {
  if (limit === null || limit === undefined) return DEFAULT_PENDING_BATCH_SIZE;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new IocEnrichmentValidationError("limit must be a positive integer");
  }
  return Math.min(limit, MAX_PENDING_BATCH_SIZE);
}

function assertValidLeaseMs(leaseMs) {
  if (!Number.isInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw new IocEnrichmentValidationError(
      `leaseMs must be an integer between ${MIN_LEASE_MS} and ${MAX_LEASE_MS}`
    );
  }
  return leaseMs;
}

/**
 * Normalizes a caller-supplied attempt budget into the bounded range. Unlike
 * boundBatchSize this never silently clamps: a caller asking for 50 attempts
 * has a bug, and quietly giving them 10 would hide it.
 */
function assertValidMaxAttempts(maxAttempts) {
  if (maxAttempts === null || maxAttempts === undefined) return DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < MIN_MAX_ATTEMPTS || maxAttempts > MAX_MAX_ATTEMPTS) {
    throw new IocEnrichmentValidationError(
      `maxAttempts must be an integer between ${MIN_MAX_ATTEMPTS} and ${MAX_MAX_ATTEMPTS}`
    );
  }
  return maxAttempts;
}

function assertValidTerminalReasonCode(reasonCode) {
  if (!isValidTerminalReasonCode(reasonCode)) {
    throw new IocEnrichmentValidationError(
      `terminalReasonCode must be one of ${ENRICHMENT_TERMINAL_REASON_VALUES.join(", ")}`
    );
  }
  return reasonCode;
}

module.exports = {
  IocEnrichmentValidationError,
  TERMINAL_STATUSES,
  TERMINAL_RESULT_COLUMNS,
  QUEUE_STATUS,
  QUEUE_STATUS_VALUES,
  ENRICHMENT_TERMINAL_REASON,
  ENRICHMENT_TERMINAL_REASON_VALUES,
  DEFAULT_PENDING_BATCH_SIZE,
  MAX_PENDING_BATCH_SIZE,
  MIN_LEASE_MS,
  MAX_LEASE_MS,
  MIN_MAX_ATTEMPTS,
  MAX_MAX_ATTEMPTS,
  DEFAULT_MAX_ATTEMPTS,
  isTerminalStatus,
  isValidTerminalReasonCode,
  isFreshTerminalRecord,
  isRetryEligibleRecord,
  isAttemptBudgetExhausted,
  isClaimableRecord,
  buildTerminalFields,
  boundBatchSize,
  assertValidLeaseMs,
  assertValidMaxAttempts,
  assertValidTerminalReasonCode,
};
