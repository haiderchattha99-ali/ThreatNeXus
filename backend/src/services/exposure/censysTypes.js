"use strict";

// Provider-neutral Censys exposure/attack-surface result types (Phase 8B).
// Mirrors the shape and reasoning of iocEnrichmentTypes.js exactly (same
// status taxonomy, same closed error-code vocabulary, same single validated
// choke point every result passes through) but is its own module rather than
// an extension of iocEnrichmentTypes.js: Censys data (open services, AS
// ownership) does not fit AbuseIPDB's reputation-score shape, the same
// reasoning that already keeps vulnerability enrichment's types separate from
// IOC reputation enrichment's. No Prisma, no filesystem, no network — pure
// data/validation only.

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

// Same code vocabulary iocEnrichmentTypes.js already established, reused
// verbatim rather than reinvented — this is the app-wide "safe provider error
// contract" every provider (AbuseIPDB, NVD/KEV/EPSS, Censys) now speaks.
const PROVIDER_ERROR_CODES = Object.freeze({
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  PROVIDER_INVALID_KEY: "PROVIDER_INVALID_KEY",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  PROVIDER_UNREACHABLE: "PROVIDER_UNREACHABLE",
  PROVIDER_MALFORMED_RESPONSE: "PROVIDER_MALFORMED_RESPONSE",
  // TNX-P10C5 — the response body exceeded the shared application byte
  // bound (boundedResponseBody.js). Distinct from PROVIDER_MALFORMED_RESPONSE:
  // the body was never fully read, so it is unknown whether it would even
  // have parsed.
  PROVIDER_RESPONSE_TOO_LARGE: "PROVIDER_RESPONSE_TOO_LARGE",
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
  [PROVIDER_ERROR_CODES.PROVIDER_RESPONSE_TOO_LARGE]:
    "Provider response body exceeded the configured size limit.",
  [PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE]:
    "Provider returned a response that could not be parsed.",
  [PROVIDER_ERROR_CODES.PROVIDER_REJECTED]: "Provider rejected the request.",
  [PROVIDER_ERROR_CODES.UNSUPPORTED_INDICATOR]: "Indicator type is not supported by this provider.",
  [PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED]: "Enrichment is disabled.",
});

const MAX_RETRY_AFTER_SECONDS = 86400;
const MAX_SERVICES = 50;
const MAX_SERVICE_NAME_LENGTH = 128;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function boundText(value, maxLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

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

// Validates one {port, protocol, serviceName} entry. Throws on a genuinely
// malformed entry — the caller (censysProvider.js) is expected to have
// already dropped anything that doesn't fit before reaching here, so a throw
// here means the provider's own normalization has a bug, not that Censys sent
// something odd.
function validateServiceEntry(entry) {
  if (!isPlainObject(entry)) {
    throw new TypeError("createExposureResult: each services entry must be an object");
  }
  const { port, protocol, serviceName } = entry;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("createExposureResult: services[].port must be an integer 1-65535");
  }
  if (typeof protocol !== "string" || protocol.trim() === "") {
    throw new TypeError("createExposureResult: services[].protocol must be a non-empty string");
  }
  return Object.freeze({
    port,
    protocol: protocol.trim().toUpperCase(),
    serviceName: boundText(serviceName, MAX_SERVICE_NAME_LENGTH),
  });
}

function buildValidatedData(data) {
  if (!isPlainObject(data)) {
    throw new TypeError("createExposureResult: data must be a plain object for a SUCCESS result");
  }
  const { services, autonomousSystemNumber, autonomousSystemName, certificateCount } = data;

  let normalizedServices = [];
  if (services !== null && services !== undefined) {
    if (!Array.isArray(services)) {
      throw new TypeError("createExposureResult: data.services must be an array or null");
    }
    // Bounded rather than rejected — a host with more observed services than
    // MAX_SERVICES is real, so the evidence is truncated, never discarded.
    normalizedServices = services.slice(0, MAX_SERVICES).map(validateServiceEntry);
  }

  if (
    autonomousSystemNumber !== null &&
    autonomousSystemNumber !== undefined &&
    (!Number.isInteger(autonomousSystemNumber) || autonomousSystemNumber < 0)
  ) {
    throw new TypeError("createExposureResult: data.autonomousSystemNumber must be a non-negative integer or null");
  }
  if (
    certificateCount !== null &&
    certificateCount !== undefined &&
    (!Number.isInteger(certificateCount) || certificateCount < 0)
  ) {
    throw new TypeError("createExposureResult: data.certificateCount must be a non-negative integer or null");
  }

  return Object.freeze({
    services: deepFreeze(normalizedServices),
    autonomousSystemNumber: autonomousSystemNumber ?? null,
    autonomousSystemName: boundText(autonomousSystemName, 256),
    certificateCount: certificateCount ?? null,
  });
}

function buildValidatedErrorInfo(errorInfo) {
  if (!isPlainObject(errorInfo) || typeof errorInfo.code !== "string") {
    throw new TypeError("createExposureResult: errorInfo.code is required for this status");
  }
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_ERROR_MESSAGES, errorInfo.code)) {
    throw new TypeError(`createExposureResult: unknown provider error code "${errorInfo.code}"`);
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
      `createExposureResult: retryAfterSeconds must be null or a number between 0 and ${MAX_RETRY_AFTER_SECONDS}`
    );
  }
  return retryAfterSeconds;
}

function buildValidatedHttpStatus(httpStatus) {
  if (httpStatus === null || httpStatus === undefined) return null;
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    throw new TypeError("createExposureResult: httpStatus must be null or an integer 100-599");
  }
  return httpStatus;
}

/**
 * The one normalized-result shape the Censys provider must return. Validates
 * every invariant and returns a deep-frozen, defensively-copied object.
 * Throws TypeError on any contract violation — never a status this function
 * invents on the caller's behalf.
 *
 * @param {{provider: string, indicator: string, status: string,
 *   queriedAt: Date, data?: object|null, httpStatus?: number|null,
 *   errorInfo?: {code: string}|null, retryAfterSeconds?: number|null}} input
 */
function createExposureResult(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("createExposureResult: input must be an object");
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
    throw new TypeError("createExposureResult: provider must be a stable lowercase identifier");
  }
  if (typeof indicator !== "string" || indicator.trim() === "") {
    throw new TypeError("createExposureResult: indicator must be a non-empty string");
  }
  if (!ENRICHMENT_STATUS_VALUES.includes(status)) {
    throw new TypeError(`createExposureResult: unknown status "${status}"`);
  }
  if (!(queriedAt instanceof Date) || Number.isNaN(queriedAt.getTime())) {
    throw new TypeError("createExposureResult: queriedAt must be an explicit valid Date");
  }

  const isSuccess = status === ENRICHMENT_STATUS.SUCCESS;
  const requiresErrorInfo = REQUIRES_ERROR_INFO_STATUSES.includes(status);

  if (isSuccess) {
    if (errorInfo !== null && errorInfo !== undefined) {
      throw new TypeError("createExposureResult: SUCCESS must not carry errorInfo");
    }
  } else if (data !== null && data !== undefined) {
    throw new TypeError(`createExposureResult: status "${status}" must not carry data`);
  }

  if (requiresErrorInfo && (errorInfo === null || errorInfo === undefined)) {
    throw new TypeError(`createExposureResult: status "${status}" requires errorInfo`);
  }
  if (!requiresErrorInfo && !isSuccess && errorInfo !== null && errorInfo !== undefined) {
    throw new TypeError(`createExposureResult: status "${status}" must not carry errorInfo`);
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
  MAX_SERVICES,
  createExposureResult,
  deepFreeze,
};
