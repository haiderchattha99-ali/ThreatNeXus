"use strict";

// Real AbuseIPDB IocEnrichmentProvider (P2-T2c) — implements the P2-T2a
// contract (iocEnrichmentProvider.js) against the AbuseIPDB v2 "check"
// endpoint. Every expected outcome (HTTP status, timeout, unreachable host,
// malformed body) is mapped to a normalized result via createEnrichmentResult
// — this module never throws for an expected outcome, only for a genuine
// programmer/contract violation (see assertValidLookupRequest and the
// queryParams.maxAgeInDays check below).
//
// No Prisma access, no audit logging, no queue/cache wiring, no retry loop —
// those belong to the caller (P2-T2b's queue/cache layer, and the P2-T2d
// runner that will call resolveIocEnrichmentProvider("abuseipdb", ...) with
// real env-sourced config). This module is only ever invoked by automated
// tests through an injected `fetchImpl`; nothing here reaches the real
// internet during `npm test`.

const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
  MAX_RETRY_AFTER_SECONDS,
  createEnrichmentResult,
} = require("./iocEnrichmentTypes");
const { isSupportedIocIndicator, assertValidLookupRequest } = require("./iocEnrichmentProvider");
const {
  AbuseIpdbConfigError,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_AGE_DAYS,
  MIN_MAX_AGE_DAYS,
  MAX_MAX_AGE_DAYS,
  validateBaseUrl,
  validateTimeoutMs,
  validateMaxAgeDays,
} = require("./abuseIpdbConfig");

const PROVIDER_NAME = "abuseipdb";
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const RETRY_AFTER_SECONDS_PATTERN = /^\d+$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Every value this module hands to createEnrichmentResult as `data` has
// already been individually type/range-checked here first, so a malformed
// or hostile provider payload is turned into a normalized
// PROVIDER_MALFORMED_RESPONSE result — never an uncaught TypeError thrown out
// of createEnrichmentResult's own (stricter, throw-on-violation) validation.
// Returns null when the payload is unusable as SUCCESS data at all.
function normalizeSuccessPayload(rawData) {
  if (!isPlainObject(rawData)) return null;

  const { abuseConfidenceScore, totalReports } = rawData;
  if (!Number.isInteger(abuseConfidenceScore) || abuseConfidenceScore < 0 || abuseConfidenceScore > 100) {
    return null;
  }
  if (!Number.isInteger(totalReports) || totalReports < 0) {
    return null;
  }

  const countryCode =
    typeof rawData.countryCode === "string" && COUNTRY_CODE_PATTERN.test(rawData.countryCode)
      ? rawData.countryCode
      : null;
  const isp = typeof rawData.isp === "string" ? rawData.isp : null;
  const domain = typeof rawData.domain === "string" ? rawData.domain : null;
  const usageType = typeof rawData.usageType === "string" ? rawData.usageType : null;
  const isWhitelisted = typeof rawData.isWhitelisted === "boolean" ? rawData.isWhitelisted : null;

  let lastReportedAt = null;
  if (typeof rawData.lastReportedAt === "string") {
    const parsed = new Date(rawData.lastReportedAt);
    if (!Number.isNaN(parsed.getTime())) lastReportedAt = parsed;
  }

  return {
    abuseConfidenceScore,
    totalReports,
    countryCode,
    isp,
    domain,
    usageType,
    isWhitelisted,
    lastReportedAt,
  };
}

// AbuseIPDB documents Retry-After as delta-seconds, so that is the only form
// parsed here — an HTTP-date value or any other non-numeric string is
// "malformed" and safely becomes null, never an exception. The result is
// clamped to the same MAX_RETRY_AFTER_SECONDS bound createEnrichmentResult
// itself enforces, so a hostile/broken huge value can never reach it as an
// out-of-range number (which would otherwise throw).
function parseRetryAfterSeconds(headerValue) {
  if (typeof headerValue !== "string") return null;
  const trimmed = headerValue.trim();
  if (!RETRY_AFTER_SECONDS_PATTERN.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

function getHeader(response, name) {
  if (!response || !response.headers || typeof response.headers.get !== "function") return null;
  return response.headers.get(name);
}

function buildCheckUrl(baseUrl, ipAddress, maxAgeInDays) {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/check`);
  url.searchParams.set("ipAddress", ipAddress);
  url.searchParams.set("maxAgeInDays", String(maxAgeInDays));
  return url.toString();
}

function assertValidRequestMaxAgeInDays(value) {
  if (!Number.isInteger(value) || value < MIN_MAX_AGE_DAYS || value > MAX_MAX_AGE_DAYS) {
    throw new TypeError(
      `AbuseIPDBProvider.lookup: queryParams.maxAgeInDays must be an integer between ${MIN_MAX_AGE_DAYS} and ${MAX_MAX_AGE_DAYS}`
    );
  }
  return value;
}

// Composes an internal request timeout with an optional caller-supplied
// AbortSignal into one AbortController, without relying on AbortSignal.any
// (not available on every supported Node runtime). `isTimedOut()` is what
// lets the caller distinguish "our own timeout fired" from "the caller
// cancelled us" after an AbortError is caught — the two must never be
// conflated (see lookup() below).
function createComposedController(callerSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let cleaned = false;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  function onCallerAbort() {
    controller.abort();
  }

  const hasCallerSignal = callerSignal && typeof callerSignal.addEventListener === "function";
  if (hasCallerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timeoutHandle);
    if (hasCallerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }

  return {
    signal: controller.signal,
    cleanup,
    isTimedOut: () => timedOut,
  };
}

async function mapHttpResponseToResult({ response, indicatorType, indicator, asOf, maxAgeInDays }) {
  const base = { provider: PROVIDER_NAME, indicatorType, indicator, queriedAt: asOf, queryParams: { maxAgeInDays } };
  const status = Number.isInteger(response.status) ? response.status : null;

  if (status === 400) {
    return createEnrichmentResult({
      ...base,
      status: ENRICHMENT_STATUS.FAILED,
      httpStatus: status,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_REJECTED },
    });
  }
  if (status === 401 || status === 403) {
    return createEnrichmentResult({
      ...base,
      status: ENRICHMENT_STATUS.INVALID_KEY,
      httpStatus: status,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY },
    });
  }
  if (status === 404) {
    return createEnrichmentResult({ ...base, status: ENRICHMENT_STATUS.NOT_FOUND, httpStatus: status });
  }
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(getHeader(response, "retry-after"));
    return createEnrichmentResult({
      ...base,
      status: ENRICHMENT_STATUS.RATE_LIMITED,
      httpStatus: status,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED },
      retryAfterSeconds,
    });
  }
  if (status !== null && status >= 500 && status <= 599) {
    return createEnrichmentResult({
      ...base,
      status: ENRICHMENT_STATUS.FAILED,
      httpStatus: status,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE },
    });
  }
  if (status !== null && status >= 200 && status <= 299) {
    let body;
    try {
      body = await response.json();
    } catch {
      return createEnrichmentResult({
        ...base,
        status: ENRICHMENT_STATUS.FAILED,
        httpStatus: status,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE },
      });
    }

    if (!isPlainObject(body)) {
      return createEnrichmentResult({
        ...base,
        status: ENRICHMENT_STATUS.FAILED,
        httpStatus: status,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE },
      });
    }

    const rawData = body.data;
    if (rawData === null || rawData === undefined) {
      return createEnrichmentResult({ ...base, status: ENRICHMENT_STATUS.NOT_FOUND, httpStatus: status });
    }

    const normalized = normalizeSuccessPayload(rawData);
    if (!normalized) {
      return createEnrichmentResult({
        ...base,
        status: ENRICHMENT_STATUS.FAILED,
        httpStatus: status,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE },
      });
    }

    return createEnrichmentResult({ ...base, status: ENRICHMENT_STATUS.SUCCESS, httpStatus: status, data: normalized });
  }

  // Any other/unexpected status code (e.g. 402, 3xx surfaced without being
  // followed) — a closed fallback that never throws.
  return createEnrichmentResult({
    ...base,
    status: ENRICHMENT_STATUS.FAILED,
    httpStatus: status,
    errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_REJECTED },
  });
}

/**
 * Creates the real AbuseIPDBProvider. Constructible with no arguments at all
 * — no API key required to import/construct this module or the registry it
 * plugs into; a missing key only affects lookup() (SKIPPED_DISABLED).
 *
 * @param {{
 *   apiKey?: string, baseUrl?: string, timeoutMs?: number,
 *   maxAgeInDays?: number, enabled?: boolean, fetchImpl?: Function
 * }} [config]
 */
function createAbuseIpdbProvider(config = {}) {
  if (!isPlainObject(config)) {
    throw new TypeError("createAbuseIpdbProvider: config must be an object");
  }

  let baseUrl;
  let timeoutMs;
  let defaultMaxAgeInDays;
  try {
    baseUrl = validateBaseUrl(config.baseUrl !== undefined ? config.baseUrl : DEFAULT_BASE_URL);
    timeoutMs = validateTimeoutMs(config.timeoutMs !== undefined ? config.timeoutMs : DEFAULT_TIMEOUT_MS);
    defaultMaxAgeInDays = validateMaxAgeDays(
      config.maxAgeInDays !== undefined ? config.maxAgeInDays : DEFAULT_MAX_AGE_DAYS
    );
  } catch (err) {
    if (err instanceof AbuseIpdbConfigError) throw err;
    throw new AbuseIpdbConfigError(err.message);
  }

  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const explicitlyDisabled = config.enabled === false;
  const fetchImpl = typeof config.fetchImpl === "function" ? config.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createAbuseIpdbProvider: no fetch implementation available — supply config.fetchImpl");
  }

  function isEnabled() {
    return !explicitlyDisabled && apiKey !== "";
  }

  function supports({ indicatorType, indicator } = {}) {
    return isSupportedIocIndicator({ indicatorType, indicator });
  }

  async function lookup({ indicatorType, indicator, asOf, queryParams = null, signal = null } = {}) {
    assertValidLookupRequest({ indicatorType, indicator, asOf });

    // Disabled and unsupported-indicator both short-circuit before touching
    // queryParams at all — the caller's queryParams (whatever shape it is)
    // is passed straight to createEnrichmentResult exactly as MockProvider
    // does, so a caller-supplied invalid maxAgeInDays already fails loudly
    // (a contract violation) rather than triggering a request.
    if (!isEnabled()) {
      return createEnrichmentResult({
        provider: PROVIDER_NAME,
        indicatorType,
        indicator,
        status: ENRICHMENT_STATUS.SKIPPED_DISABLED,
        queriedAt: asOf,
        queryParams,
        errorInfo: { code: PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED },
      });
    }

    if (!supports({ indicatorType, indicator })) {
      return createEnrichmentResult({
        provider: PROVIDER_NAME,
        indicatorType,
        indicator,
        status: ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR,
        queriedAt: asOf,
        queryParams,
        errorInfo: { code: PROVIDER_ERROR_CODES.UNSUPPORTED_INDICATOR },
      });
    }

    // A genuine request is about to be made — resolve+validate the exact
    // maxAgeInDays it will carry. An invalid caller-supplied value is a
    // contract violation (this queryParams should already have been
    // sanitized upstream, e.g. by P2-T2b's cache layer) and throws rather
    // than silently substituting the default or making a bad request.
    const maxAgeInDays =
      queryParams && Object.prototype.hasOwnProperty.call(queryParams, "maxAgeInDays")
        ? assertValidRequestMaxAgeInDays(queryParams.maxAgeInDays)
        : defaultMaxAgeInDays;

    const url = buildCheckUrl(baseUrl, indicator, maxAgeInDays);
    const composed = createComposedController(signal, timeoutMs);

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Key: apiKey, Accept: "application/json" },
        signal: composed.signal,
      });
    } catch (err) {
      composed.cleanup();
      if (err && err.name === "AbortError") {
        if (composed.isTimedOut()) {
          return createEnrichmentResult({
            provider: PROVIDER_NAME,
            indicatorType,
            indicator,
            status: ENRICHMENT_STATUS.TIMEOUT,
            queriedAt: asOf,
            queryParams: { maxAgeInDays },
            errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT },
          });
        }
        // Caller cancellation, not our timeout — propagate verbatim rather
        // than misclassifying it as a provider outcome of any kind.
        throw err;
      }
      // DNS/connect/socket/fetch-level failure — never our own contract bug.
      return createEnrichmentResult({
        provider: PROVIDER_NAME,
        indicatorType,
        indicator,
        status: ENRICHMENT_STATUS.FAILED,
        queriedAt: asOf,
        queryParams: { maxAgeInDays },
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_UNREACHABLE },
      });
    }
    composed.cleanup();

    return mapHttpResponseToResult({ response, indicatorType, indicator, asOf, maxAgeInDays });
  }

  // Debug/ops-facing summary — deliberately excludes apiKey. Not part of the
  // IocEnrichmentProvider contract; purely so a caller never has to build its
  // own redacted view of this provider's config to log or assert against.
  function describe() {
    return Object.freeze({
      provider: PROVIDER_NAME,
      baseUrl,
      timeoutMs,
      defaultMaxAgeInDays,
      enabled: isEnabled(),
    });
  }

  return Object.freeze({
    name: PROVIDER_NAME,
    supports,
    lookup,
    describe,
  });
}

module.exports = {
  PROVIDER_NAME,
  createAbuseIpdbProvider,
};
