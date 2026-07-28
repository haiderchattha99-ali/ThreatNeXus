"use strict";

// Pure IOC enrichment TTL policy (P2-T2c). Decides how long a terminal
// AbuseIPDBProvider (or MockProvider) result stays fresh in the P2-T2b
// cache. No Prisma, no network, no filesystem, and — deliberately — no wall
// clock: `queriedAt` is the only time input, so `expiresAt` is always
// `queriedAt + ttlSeconds`, never "whenever this function happened to run".
//
// This module only decides the policy; it does not apply it. The provider
// itself (abuseIpdbProvider.js) leaves `expiresAt` null on every result — the
// P2-T2d worker/completion layer is what calls resolveEnrichmentTtl() and
// writes the result into IocEnrichment.expiresAt.
//
// Every terminal status gets a conservative, finite default so "no status
// may accidentally receive an infinite cache duration" is structurally true,
// not just documented: every path through resolveEnrichmentTtl clamps its
// result into [ABSOLUTE_MIN_TTL_SECONDS, ABSOLUTE_MAX_TTL_SECONDS] before
// returning.

const { ENRICHMENT_STATUS, ENRICHMENT_STATUS_VALUES } = require("./iocEnrichmentTypes");

class EnrichmentTtlPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentTtlPolicyError";
  }
}

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;

// The backstop bounds every resolved ttlSeconds — default or overridden,
// whatever the status — must fall within.
const ABSOLUTE_MIN_TTL_SECONDS = MINUTE_SECONDS;
const ABSOLUTE_MAX_TTL_SECONDS = 24 * HOUR_SECONDS;

// Conservative per-status defaults. RATE_LIMITED is handled separately below
// (it is a floor/cap around the provider's own Retry-After, not a flat
// value), so it is intentionally absent from this table.
const DEFAULT_TTL_SECONDS = Object.freeze({
  [ENRICHMENT_STATUS.SUCCESS]: 24 * HOUR_SECONDS,
  [ENRICHMENT_STATUS.NOT_FOUND]: 6 * HOUR_SECONDS,
  [ENRICHMENT_STATUS.INVALID_KEY]: 15 * MINUTE_SECONDS,
  [ENRICHMENT_STATUS.TIMEOUT]: 5 * MINUTE_SECONDS,
  [ENRICHMENT_STATUS.FAILED]: 5 * MINUTE_SECONDS,
  [ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR]: 24 * HOUR_SECONDS,
  [ENRICHMENT_STATUS.SKIPPED_DISABLED]: 15 * MINUTE_SECONDS,
});

const DEFAULT_RATE_LIMITED_MIN_TTL_SECONDS = 15 * MINUTE_SECONDS;
const DEFAULT_RATE_LIMITED_MAX_TTL_SECONDS = 24 * HOUR_SECONDS;

// PENDING is the one non-terminal status: it never reaches this policy.
const TERMINAL_STATUSES = Object.freeze(
  ENRICHMENT_STATUS_VALUES.filter((status) => status !== ENRICHMENT_STATUS.PENDING)
);

function assertBoundedInt(value, { label, min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnrichmentTtlPolicyError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveTtlTable(overrides) {
  const table = { ...DEFAULT_TTL_SECONDS };
  if (overrides.ttlSecondsByStatus === undefined || overrides.ttlSecondsByStatus === null) {
    return table;
  }
  if (!isPlainObject(overrides.ttlSecondsByStatus)) {
    throw new EnrichmentTtlPolicyError("policyOverrides.ttlSecondsByStatus must be an object");
  }
  Object.entries(overrides.ttlSecondsByStatus).forEach(([status, ttlSeconds]) => {
    if (status === ENRICHMENT_STATUS.RATE_LIMITED) {
      throw new EnrichmentTtlPolicyError(
        "policyOverrides.ttlSecondsByStatus cannot override RATE_LIMITED — use rateLimitedMinTtlSeconds/rateLimitedMaxTtlSeconds"
      );
    }
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_TTL_SECONDS, status)) {
      throw new EnrichmentTtlPolicyError(`policyOverrides.ttlSecondsByStatus: unknown status "${status}"`);
    }
    table[status] = assertBoundedInt(ttlSeconds, {
      label: `policyOverrides.ttlSecondsByStatus.${status}`,
      min: ABSOLUTE_MIN_TTL_SECONDS,
      max: ABSOLUTE_MAX_TTL_SECONDS,
    });
  });
  return table;
}

/**
 * Resolves the cache TTL policy for one terminal enrichment result.
 *
 * @param {{status: string, queriedAt: Date, retryAfterSeconds?: number|null,
 *   policyOverrides?: {ttlSecondsByStatus?: Object<string, number>,
 *   rateLimitedMinTtlSeconds?: number, rateLimitedMaxTtlSeconds?: number}}} input
 * @returns {{expiresAt: Date, ttlSeconds: number, policyReason: string}}
 */
function resolveEnrichmentTtl({ status, queriedAt, retryAfterSeconds = null, policyOverrides = null } = {}) {
  if (status === ENRICHMENT_STATUS.PENDING) {
    throw new EnrichmentTtlPolicyError(
      "resolveEnrichmentTtl: PENDING has no TTL policy — it is not a terminal result"
    );
  }
  if (typeof status !== "string" || !TERMINAL_STATUSES.includes(status)) {
    throw new EnrichmentTtlPolicyError(`resolveEnrichmentTtl: unknown status "${String(status)}"`);
  }
  if (!(queriedAt instanceof Date) || Number.isNaN(queriedAt.getTime())) {
    throw new EnrichmentTtlPolicyError("resolveEnrichmentTtl: queriedAt must be an explicit valid Date");
  }
  if (
    retryAfterSeconds !== null &&
    retryAfterSeconds !== undefined &&
    (typeof retryAfterSeconds !== "number" || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0)
  ) {
    throw new EnrichmentTtlPolicyError(
      "resolveEnrichmentTtl: retryAfterSeconds must be null or a non-negative finite number"
    );
  }

  const overrides = isPlainObject(policyOverrides) ? policyOverrides : {};
  const ttlTable = resolveTtlTable(overrides);

  const rateLimitedMinTtlSeconds = assertBoundedInt(
    overrides.rateLimitedMinTtlSeconds ?? DEFAULT_RATE_LIMITED_MIN_TTL_SECONDS,
    { label: "policyOverrides.rateLimitedMinTtlSeconds", min: ABSOLUTE_MIN_TTL_SECONDS, max: ABSOLUTE_MAX_TTL_SECONDS }
  );
  const rateLimitedMaxTtlSeconds = assertBoundedInt(
    overrides.rateLimitedMaxTtlSeconds ?? DEFAULT_RATE_LIMITED_MAX_TTL_SECONDS,
    { label: "policyOverrides.rateLimitedMaxTtlSeconds", min: rateLimitedMinTtlSeconds, max: ABSOLUTE_MAX_TTL_SECONDS }
  );

  let ttlSeconds;
  let policyReason;

  if (status === ENRICHMENT_STATUS.RATE_LIMITED) {
    const requestedSeconds =
      retryAfterSeconds === null || retryAfterSeconds === undefined
        ? rateLimitedMinTtlSeconds
        : Math.ceil(retryAfterSeconds);

    if (requestedSeconds < rateLimitedMinTtlSeconds) {
      ttlSeconds = rateLimitedMinTtlSeconds;
      policyReason = "RATE_LIMITED_FLOORED_TO_MINIMUM";
    } else if (requestedSeconds > rateLimitedMaxTtlSeconds) {
      ttlSeconds = rateLimitedMaxTtlSeconds;
      policyReason = "RATE_LIMITED_CAPPED_TO_MAXIMUM";
    } else {
      ttlSeconds = requestedSeconds;
      policyReason = "RATE_LIMITED_RETRY_AFTER";
    }
  } else {
    ttlSeconds = ttlTable[status];
    policyReason = `${status}_DEFAULT`;
  }

  ttlSeconds = assertBoundedInt(ttlSeconds, {
    label: "resolved ttlSeconds",
    min: ABSOLUTE_MIN_TTL_SECONDS,
    max: ABSOLUTE_MAX_TTL_SECONDS,
  });

  const expiresAt = new Date(queriedAt.getTime() + ttlSeconds * 1000);

  return Object.freeze({ expiresAt, ttlSeconds, policyReason });
}

module.exports = {
  EnrichmentTtlPolicyError,
  ABSOLUTE_MIN_TTL_SECONDS,
  ABSOLUTE_MAX_TTL_SECONDS,
  DEFAULT_TTL_SECONDS,
  DEFAULT_RATE_LIMITED_MIN_TTL_SECONDS,
  DEFAULT_RATE_LIMITED_MAX_TTL_SECONDS,
  resolveEnrichmentTtl,
};
