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
const TERMINAL_STATUSES = Object.freeze(
  ENRICHMENT_STATUS_VALUES.filter((status) => status !== ENRICHMENT_STATUS.PENDING)
);

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
 * Is this stored row claimable as of `now`? True for an unclaimed PENDING row
 * and for a PENDING row whose lease has expired (lease boundary is inclusive:
 * leaseExpiresAt === now is reclaimable). Never true for a terminal row.
 */
function isClaimableRecord(record, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new IocEnrichmentValidationError("isClaimableRecord: now must be a valid Date");
  }
  if (!record || record.status !== ENRICHMENT_STATUS.PENDING) return false;
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

module.exports = {
  IocEnrichmentValidationError,
  TERMINAL_STATUSES,
  TERMINAL_RESULT_COLUMNS,
  DEFAULT_PENDING_BATCH_SIZE,
  MAX_PENDING_BATCH_SIZE,
  MIN_LEASE_MS,
  MAX_LEASE_MS,
  isTerminalStatus,
  isFreshTerminalRecord,
  isClaimableRecord,
  buildTerminalFields,
  boundBatchSize,
  assertValidLeaseMs,
};
