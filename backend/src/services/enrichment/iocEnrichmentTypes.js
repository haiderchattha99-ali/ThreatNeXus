"use strict";

// Provider-neutral IOC reputation-enrichment types (P2-T2a): the status/error
// taxonomy and the one normalized-result shape every provider (MockProvider
// now, the future AbuseIPDBProvider) must build results through. No Prisma,
// no filesystem, no network, no persistence — pure data/validation only; the
// durable IocEnrichment table/queue/cache is P2-T2b's job, not this one.
//
// createEnrichmentResult is the single choke point every provider result
// passes through: it validates every invariant below and returns a
// deep-frozen, defensively-copied object, so an invalid or leaky result can
// never leave a provider. See DECISIONS.md D-002's interpretation boundary,
// which this module exists to make structurally true, not just documented:
// reputation is supporting context, never proof of compromise — nothing here
// ever sets a "confirmed compromise" concept, only a bounded confidence score.

const INDICATOR_TYPES = Object.freeze({
  IPV4: "IPV4",
});

const ENRICHMENT_STATUS = Object.freeze({
  PENDING: "PENDING",
  SUCCESS: "SUCCESS",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  INVALID_KEY: "INVALID_KEY",
  TIMEOUT: "TIMEOUT",
  FAILED: "FAILED",
  UNSUPPORTED_INDICATOR: "UNSUPPORTED_INDICATOR",
  SKIPPED_DISABLED: "SKIPPED_DISABLED",
});

const ENRICHMENT_STATUS_VALUES = Object.freeze(Object.values(ENRICHMENT_STATUS));

// Statuses that are expected provider *failures* (in the broad sense,
// including "will not proceed" outcomes like an unsupported indicator or a
// disabled provider) — errorInfo is required, and `data` must be null, never
// a partial/best-effort payload.
const REQUIRES_ERROR_INFO_STATUSES = Object.freeze([
  ENRICHMENT_STATUS.RATE_LIMITED,
  ENRICHMENT_STATUS.INVALID_KEY,
  ENRICHMENT_STATUS.TIMEOUT,
  ENRICHMENT_STATUS.FAILED,
  ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR,
  ENRICHMENT_STATUS.SKIPPED_DISABLED,
]);

const PROVIDER_ERROR_CODES = Object.freeze({
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  PROVIDER_INVALID_KEY: "PROVIDER_INVALID_KEY",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_UNREACHABLE: "PROVIDER_UNREACHABLE",
  PROVIDER_MALFORMED_RESPONSE: "PROVIDER_MALFORMED_RESPONSE",
  PROVIDER_REJECTED: "PROVIDER_REJECTED",
  UNSUPPORTED_INDICATOR: "UNSUPPORTED_INDICATOR",
  ENRICHMENT_DISABLED: "ENRICHMENT_DISABLED",
});

// Closed, frozen code -> message map. This is the ONLY source an
// errorInfo.message may ever come from. createEnrichmentResult derives the
// message from `errorInfo.code` itself — a caller-supplied message (e.g. a
// caught error's raw `.message`, a response body fragment) is never read,
// even if present on the input object.
const PROVIDER_ERROR_MESSAGES = Object.freeze({
  [PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED]: "Provider rate limit exceeded.",
  [PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY]: "Provider rejected the configured API key.",
  [PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT]: "Provider request timed out.",
  [PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE]: "Provider is temporarily unavailable.",
  [PROVIDER_ERROR_CODES.PROVIDER_UNREACHABLE]: "Provider could not be reached.",
  [PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE]:
    "Provider returned a response that could not be parsed.",
  [PROVIDER_ERROR_CODES.PROVIDER_REJECTED]: "Provider rejected the request.",
  [PROVIDER_ERROR_CODES.UNSUPPORTED_INDICATOR]: "Indicator type is not supported by this provider.",
  [PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED]: "Enrichment is disabled.",
});

const MAX_TEXT_FIELD_LENGTH = 256;
// A provider asking for a longer backoff than this is not trusted verbatim.
const MAX_RETRY_AFTER_SECONDS = 86400;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

// Provider-neutral parameters a caller may pass through into the normalized
// result's `queryParams`. Anything else supplied to a provider's lookup() is
// used internally, if at all, and is never echoed back into the result — see
// sanitizeQueryParams below. This is the allow-list, not a denylist: an
// unrecognised key (an accidental secret, a provider-specific credential) is
// silently dropped from the output, never forwarded.
const ALLOWED_QUERY_PARAM_KEYS = Object.freeze(["maxAgeInDays"]);

function isPlainObject(value) {
  return (
    Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
  );
}

function boundText(value, maxLength = MAX_TEXT_FIELD_LENGTH) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

// Recursively freezes a plain-data object graph. Date instances are left
// alone here (Object.freeze cannot stop setTime()/setDate() etc. from
// mutating a Date's internal value even when frozen) — every Date this
// module stores is instead defensively copied to a fresh instance at
// construction time, so no caller-held Date reference is ever shared into a
// returned result in the first place.
function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

// Validates + normalizes the `data` payload for a SUCCESS result. Throws
// TypeError on any contract violation — a provider producing invalid data is
// a provider implementation bug, never an expected lookup outcome.
function buildValidatedData(data) {
  if (!isPlainObject(data)) {
    throw new TypeError("createEnrichmentResult: data must be a plain object for a SUCCESS result");
  }

  const {
    abuseConfidenceScore,
    totalReports,
    countryCode,
    isp,
    domain,
    usageType,
    isWhitelisted,
    lastReportedAt,
  } = data;

  if (
    !Number.isInteger(abuseConfidenceScore) ||
    abuseConfidenceScore < 0 ||
    abuseConfidenceScore > 100
  ) {
    throw new TypeError("createEnrichmentResult: data.abuseConfidenceScore must be an integer 0-100");
  }
  if (!Number.isInteger(totalReports) || totalReports < 0) {
    throw new TypeError("createEnrichmentResult: data.totalReports must be a non-negative integer");
  }
  if (countryCode !== null && countryCode !== undefined && !COUNTRY_CODE_PATTERN.test(countryCode)) {
    throw new TypeError(
      "createEnrichmentResult: data.countryCode must be a two-letter uppercase code or null"
    );
  }
  if (isWhitelisted !== null && isWhitelisted !== undefined && typeof isWhitelisted !== "boolean") {
    throw new TypeError("createEnrichmentResult: data.isWhitelisted must be a boolean or null");
  }

  let normalizedLastReportedAt = null;
  if (lastReportedAt !== null && lastReportedAt !== undefined) {
    if (!(lastReportedAt instanceof Date) || Number.isNaN(lastReportedAt.getTime())) {
      throw new TypeError("createEnrichmentResult: data.lastReportedAt must be a valid Date or null");
    }
    normalizedLastReportedAt = new Date(lastReportedAt.getTime());
  }

  return Object.freeze({
    abuseConfidenceScore,
    totalReports,
    countryCode: countryCode ?? null,
    isp: boundText(isp),
    domain: boundText(domain),
    usageType: boundText(usageType),
    isWhitelisted: isWhitelisted ?? null,
    lastReportedAt: normalizedLastReportedAt,
  });
}

function buildValidatedErrorInfo(errorInfo) {
  if (!isPlainObject(errorInfo) || typeof errorInfo.code !== "string") {
    throw new TypeError("createEnrichmentResult: errorInfo.code is required for this status");
  }
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_ERROR_MESSAGES, errorInfo.code)) {
    throw new TypeError(`createEnrichmentResult: unknown provider error code "${errorInfo.code}"`);
  }
  return Object.freeze({ code: errorInfo.code, message: PROVIDER_ERROR_MESSAGES[errorInfo.code] });
}

function buildValidatedRetryAfterSeconds(retryAfterSeconds) {
  if (retryAfterSeconds === null || retryAfterSeconds === undefined) return null;
  if (
    typeof retryAfterSeconds !== "number" ||
    !Number.isFinite(retryAfterSeconds) ||
    retryAfterSeconds < 0 ||
    retryAfterSeconds > MAX_RETRY_AFTER_SECONDS
  ) {
    throw new TypeError(
      `createEnrichmentResult: retryAfterSeconds must be null or a number between 0 and ${MAX_RETRY_AFTER_SECONDS}`
    );
  }
  return retryAfterSeconds;
}

function buildValidatedHttpStatus(httpStatus) {
  if (httpStatus === null || httpStatus === undefined) return null;
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    throw new TypeError("createEnrichmentResult: httpStatus must be null or an integer 100-599");
  }
  return httpStatus;
}

// Allow-lists queryParams into the result — never a passthrough spread of
// whatever the caller supplied. An unrecognised key (e.g. an accidentally
// included credential) is dropped, not surfaced.
function sanitizeQueryParams(queryParams) {
  if (queryParams === null || queryParams === undefined) return Object.freeze({});
  if (!isPlainObject(queryParams)) {
    throw new TypeError("createEnrichmentResult: queryParams must be a plain object");
  }
  const sanitized = {};
  ALLOWED_QUERY_PARAM_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(queryParams, key)) {
      sanitized[key] = queryParams[key];
    }
  });
  if (
    Object.prototype.hasOwnProperty.call(sanitized, "maxAgeInDays") &&
    (!Number.isInteger(sanitized.maxAgeInDays) || sanitized.maxAgeInDays <= 0)
  ) {
    throw new TypeError("createEnrichmentResult: queryParams.maxAgeInDays must be a positive integer");
  }
  return deepFreeze(sanitized);
}

/**
 * The one normalized-result shape every IocEnrichmentProvider must return.
 * Validates every invariant and returns a deep-frozen, defensively-copied
 * object. Throws TypeError on any contract violation — never a status this
 * function invents on the caller's behalf.
 *
 * @param {{provider: string, indicatorType: string, indicator: string,
 *   status: string, queriedAt: Date, expiresAt?: Date|null, data?: object|null,
 *   queryParams?: object|null, httpStatus?: number|null,
 *   errorInfo?: {code: string}|null, retryAfterSeconds?: number|null}} input
 */
function createEnrichmentResult(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("createEnrichmentResult: input must be an object");
  }
  const {
    provider,
    indicatorType,
    indicator,
    status,
    queriedAt,
    expiresAt = null,
    data = null,
    queryParams = null,
    httpStatus = null,
    errorInfo = null,
    retryAfterSeconds = null,
  } = input;

  if (typeof provider !== "string" || provider.trim() === "" || provider !== provider.toLowerCase()) {
    throw new TypeError("createEnrichmentResult: provider must be a stable lowercase identifier");
  }
  if (typeof indicatorType !== "string" || indicatorType.trim() === "") {
    throw new TypeError("createEnrichmentResult: indicatorType must be a non-empty string");
  }
  if (typeof indicator !== "string" || indicator.trim() === "") {
    throw new TypeError("createEnrichmentResult: indicator must be a non-empty string");
  }
  if (!ENRICHMENT_STATUS_VALUES.includes(status)) {
    throw new TypeError(`createEnrichmentResult: unknown status "${status}"`);
  }
  if (!(queriedAt instanceof Date) || Number.isNaN(queriedAt.getTime())) {
    throw new TypeError("createEnrichmentResult: queriedAt must be an explicit valid Date");
  }

  let normalizedExpiresAt = null;
  if (expiresAt !== null && expiresAt !== undefined) {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
      throw new TypeError("createEnrichmentResult: expiresAt must be a valid Date or null");
    }
    normalizedExpiresAt = new Date(expiresAt.getTime());
  }

  const isSuccess = status === ENRICHMENT_STATUS.SUCCESS;
  const requiresErrorInfo = REQUIRES_ERROR_INFO_STATUSES.includes(status);

  if (isSuccess) {
    if (errorInfo !== null && errorInfo !== undefined) {
      throw new TypeError("createEnrichmentResult: SUCCESS must not carry errorInfo");
    }
  } else if (data !== null && data !== undefined) {
    // Never a partial/best-effort payload on a non-success outcome.
    throw new TypeError(`createEnrichmentResult: status "${status}" must not carry data`);
  }

  if (requiresErrorInfo && (errorInfo === null || errorInfo === undefined)) {
    throw new TypeError(`createEnrichmentResult: status "${status}" requires errorInfo`);
  }
  if (!requiresErrorInfo && !isSuccess && errorInfo !== null && errorInfo !== undefined) {
    throw new TypeError(`createEnrichmentResult: status "${status}" must not carry errorInfo`);
  }

  const validatedData = isSuccess ? buildValidatedData(data) : null;
  const validatedErrorInfo = requiresErrorInfo ? buildValidatedErrorInfo(errorInfo) : null;

  return Object.freeze({
    provider,
    indicatorType,
    indicator,
    status,
    queriedAt: new Date(queriedAt.getTime()),
    expiresAt: normalizedExpiresAt,
    data: validatedData,
    queryParams: sanitizeQueryParams(queryParams),
    httpStatus: buildValidatedHttpStatus(httpStatus),
    errorInfo: validatedErrorInfo,
    retryAfterSeconds: buildValidatedRetryAfterSeconds(retryAfterSeconds),
  });
}

module.exports = {
  INDICATOR_TYPES,
  ENRICHMENT_STATUS,
  ENRICHMENT_STATUS_VALUES,
  REQUIRES_ERROR_INFO_STATUSES,
  PROVIDER_ERROR_CODES,
  PROVIDER_ERROR_MESSAGES,
  ALLOWED_QUERY_PARAM_KEYS,
  MAX_TEXT_FIELD_LENGTH,
  MAX_RETRY_AFTER_SECONDS,
  createEnrichmentResult,
  sanitizeQueryParams,
  deepFreeze,
};
