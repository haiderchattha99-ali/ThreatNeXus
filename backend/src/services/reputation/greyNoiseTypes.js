"use strict";

// Provider-neutral GreyNoise internet-noise/reputation result types
// (Phase 8D). Mirrors backend/src/services/exposure/censysTypes.js exactly
// (same status taxonomy, same closed error-code vocabulary, same single
// validated choke point every result passes through) but is its own module:
// GreyNoise data (noise/classification/actor context) does not fit
// AbuseIPDB's reputation-score shape any more than Censys's exposure data
// did, and it is a materially different shape from Censys's own
// open-services/AS-ownership data too — the same reasoning that already
// keeps every provider's result types separate rather than one shared shape.
// No Prisma, no filesystem, no network — pure data/validation only.

const ENRICHMENT_STATUS = Object.freeze({
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

const REQUIRES_ERROR_INFO_STATUSES = Object.freeze([
  ENRICHMENT_STATUS.RATE_LIMITED,
  ENRICHMENT_STATUS.INVALID_KEY,
  ENRICHMENT_STATUS.TIMEOUT,
  ENRICHMENT_STATUS.FAILED,
  ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR,
  ENRICHMENT_STATUS.SKIPPED_DISABLED,
]);

// The SAME app-wide "safe provider error contract" every provider (AbuseIPDB,
// NVD/KEV/EPSS, Censys) already speaks, reused verbatim rather than
// reinvented.
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

const PROVIDER_ERROR_MESSAGES = Object.freeze({
  [PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED]: "Provider rate limit exceeded.",
  [PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY]: "Provider rejected the configured credentials.",
  [PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT]: "Provider request timed out.",
  [PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE]: "Provider is temporarily unavailable.",
  [PROVIDER_ERROR_CODES.PROVIDER_UNREACHABLE]: "Provider could not be reached.",
  [PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE]:
    "Provider returned a response that could not be parsed.",
  [PROVIDER_ERROR_CODES.PROVIDER_REJECTED]: "Provider rejected the request.",
  [PROVIDER_ERROR_CODES.UNSUPPORTED_INDICATOR]: "Indicator type is not supported by this provider.",
  [PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED]: "Enrichment is disabled.",
});

const MAX_RETRY_AFTER_SECONDS = 86400;
const MAX_CLASSIFICATION_LENGTH = 32;
const MAX_ACTOR_NAME_LENGTH = 256;
const MAX_LINK_LENGTH = 512;
const MAX_LAST_SEEN_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 512;

// GreyNoise's own closed classification vocabulary. A value outside this set
// is unknown output, not a fact this system will pass along as if it were
// one of the three GreyNoise actually defines.
const CLASSIFICATION_VALUES = Object.freeze(["benign", "malicious", "unknown"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function boundText(value, maxLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function buildValidatedData(data) {
  if (!isPlainObject(data)) {
    throw new TypeError("createNoiseResult: data must be a plain object for a SUCCESS result");
  }
  const { noise, riot, classification, actorName, link, lastSeen, message } = data;

  if (noise !== null && noise !== undefined && typeof noise !== "boolean") {
    throw new TypeError("createNoiseResult: data.noise must be a boolean or null");
  }
  if (riot !== null && riot !== undefined && typeof riot !== "boolean") {
    throw new TypeError("createNoiseResult: data.riot must be a boolean or null");
  }
  if (
    classification !== null &&
    classification !== undefined &&
    !CLASSIFICATION_VALUES.includes(classification)
  ) {
    throw new TypeError(
      `createNoiseResult: data.classification must be null or one of ${CLASSIFICATION_VALUES.join(", ")}`
    );
  }

  return Object.freeze({
    noise: noise ?? null,
    riot: riot ?? null,
    classification: classification ?? null,
    actorName: boundText(actorName, MAX_ACTOR_NAME_LENGTH),
    link: boundText(link, MAX_LINK_LENGTH),
    lastSeen: boundText(lastSeen, MAX_LAST_SEEN_LENGTH),
    message: boundText(message, MAX_MESSAGE_LENGTH),
  });
}

function buildValidatedErrorInfo(errorInfo) {
  if (!isPlainObject(errorInfo) || typeof errorInfo.code !== "string") {
    throw new TypeError("createNoiseResult: errorInfo.code is required for this status");
  }
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_ERROR_MESSAGES, errorInfo.code)) {
    throw new TypeError(`createNoiseResult: unknown provider error code "${errorInfo.code}"`);
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
      `createNoiseResult: retryAfterSeconds must be null or a number between 0 and ${MAX_RETRY_AFTER_SECONDS}`
    );
  }
  return retryAfterSeconds;
}

function buildValidatedHttpStatus(httpStatus) {
  if (httpStatus === null || httpStatus === undefined) return null;
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    throw new TypeError("createNoiseResult: httpStatus must be null or an integer 100-599");
  }
  return httpStatus;
}

/**
 * The one normalized-result shape the GreyNoise provider must return.
 * Validates every invariant and returns a deep-frozen, defensively-copied
 * object. Throws TypeError on any contract violation — never a status this
 * function invents on the caller's behalf.
 *
 * @param {{provider: string, indicator: string, status: string,
 *   queriedAt: Date, data?: object|null, httpStatus?: number|null,
 *   errorInfo?: {code: string}|null, retryAfterSeconds?: number|null}} input
 */
function createNoiseResult(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("createNoiseResult: input must be an object");
  }
  const {
    provider,
    indicator,
    status,
    queriedAt,
    data = null,
    httpStatus = null,
    errorInfo = null,
    retryAfterSeconds = null,
  } = input;

  if (typeof provider !== "string" || provider.trim() === "" || provider !== provider.toLowerCase()) {
    throw new TypeError("createNoiseResult: provider must be a stable lowercase identifier");
  }
  if (typeof indicator !== "string" || indicator.trim() === "") {
    throw new TypeError("createNoiseResult: indicator must be a non-empty string");
  }
  if (!ENRICHMENT_STATUS_VALUES.includes(status)) {
    throw new TypeError(`createNoiseResult: unknown status "${status}"`);
  }
  if (!(queriedAt instanceof Date) || Number.isNaN(queriedAt.getTime())) {
    throw new TypeError("createNoiseResult: queriedAt must be an explicit valid Date");
  }

  const isSuccess = status === ENRICHMENT_STATUS.SUCCESS;
  const requiresErrorInfo = REQUIRES_ERROR_INFO_STATUSES.includes(status);

  if (isSuccess) {
    if (errorInfo !== null && errorInfo !== undefined) {
      throw new TypeError("createNoiseResult: SUCCESS must not carry errorInfo");
    }
  } else if (data !== null && data !== undefined) {
    throw new TypeError(`createNoiseResult: status "${status}" must not carry data`);
  }

  if (requiresErrorInfo && (errorInfo === null || errorInfo === undefined)) {
    throw new TypeError(`createNoiseResult: status "${status}" requires errorInfo`);
  }
  if (!requiresErrorInfo && !isSuccess && errorInfo !== null && errorInfo !== undefined) {
    throw new TypeError(`createNoiseResult: status "${status}" must not carry errorInfo`);
  }

  const validatedData = isSuccess ? buildValidatedData(data) : null;
  const validatedErrorInfo = requiresErrorInfo ? buildValidatedErrorInfo(errorInfo) : null;

  return Object.freeze({
    provider,
    indicator,
    status,
    queriedAt: new Date(queriedAt.getTime()),
    data: validatedData,
    httpStatus: buildValidatedHttpStatus(httpStatus),
    errorInfo: validatedErrorInfo,
    retryAfterSeconds: buildValidatedRetryAfterSeconds(retryAfterSeconds),
  });
}

module.exports = {
  ENRICHMENT_STATUS,
  ENRICHMENT_STATUS_VALUES,
  REQUIRES_ERROR_INFO_STATUSES,
  PROVIDER_ERROR_CODES,
  PROVIDER_ERROR_MESSAGES,
  MAX_RETRY_AFTER_SECONDS,
  MAX_CLASSIFICATION_LENGTH,
  CLASSIFICATION_VALUES,
  createNoiseResult,
};
