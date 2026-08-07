"use strict";

// Real GreyNoise internet-noise/reputation provider (Phase 8D) — the
// GreyNoise Community API's IP lookup endpoint (GET
// {baseUrl}/{indicator}, Community base https://api.greynoise.io/v3/community),
// following the exact defensive shape censysProvider.js/abuseIpdbProvider.js
// already established for a real third-party HTTP provider: composed
// timeout+caller-signal, every expected HTTP/transport outcome mapped to a
// normalized result via createNoiseResult, never throwing for an expected
// outcome. Only throws for a genuine programmer/contract violation.
//
// Auth is a single API key sent as the `key` header (GreyNoise's own
// documented shape — not Bearer, not Basic). The key is read only to build
// that header and is never logged, returned, or included in any error.
// Automated tests only ever reach this module through an injected
// fetchImpl; nothing here touches the real internet during `npm test`.

const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
  CLASSIFICATION_VALUES,
  createNoiseResult,
} = require("./greyNoiseTypes");
const { isValidIpv4 } = require("../ownership/ipv4Cidr");
const {
  GreyNoiseConfigError,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  validateBaseUrl,
  validateTimeoutMs,
} = require("./greyNoiseConfig");

const PROVIDER_NAME = "greynoise";
const RETRY_AFTER_SECONDS_PATTERN = /^\d+$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertValidLookupRequest({ indicator, asOf } = {}) {
  if (typeof indicator !== "string" || indicator.trim() === "") {
    throw new TypeError("GreyNoiseProvider.lookup: indicator must be a non-empty string");
  }
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new TypeError("GreyNoiseProvider.lookup: asOf must be an explicit, valid Date");
  }
}

function parseRetryAfterSeconds(headerValue) {
  if (typeof headerValue !== "string") return null;
  const trimmed = headerValue.trim();
  if (!RETRY_AFTER_SECONDS_PATTERN.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds;
}

function getHeader(response, name) {
  if (!response || !response.headers || typeof response.headers.get !== "function") return null;
  return response.headers.get(name);
}

// Allow-listed extraction only — every field GreyNoise could return that this
// provider does not explicitly ask for here is dropped, never passed
// through. `classification` is restricted to GreyNoise's own documented
// closed set (benign/malicious/unknown); anything else arrives as null
// rather than being passed through as an invented fourth value.
function normalizeSuccessPayload(body) {
  if (!isPlainObject(body)) return null;

  const classification =
    typeof body.classification === "string" && CLASSIFICATION_VALUES.includes(body.classification)
      ? body.classification
      : null;

  return {
    noise: typeof body.noise === "boolean" ? body.noise : null,
    riot: typeof body.riot === "boolean" ? body.riot : null,
    classification,
    // GreyNoise itself sends the literal string "unknown" here when it has no
    // attributed actor — passed through verbatim (bounded) rather than
    // guessed at or collapsed to null, since it is GreyNoise's own real
    // answer, not a gap in this provider's parsing.
    actorName: typeof body.name === "string" ? body.name : null,
    link: typeof body.link === "string" ? body.link : null,
    lastSeen: typeof body.last_seen === "string" ? body.last_seen : null,
    message: typeof body.message === "string" ? body.message : null,
  };
}

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

  return { signal: controller.signal, cleanup, isTimedOut: () => timedOut };
}

async function mapHttpResponseToResult({ response, indicator, asOf }) {
  const base = { provider: PROVIDER_NAME, indicator, queriedAt: asOf };
  const status = Number.isInteger(response.status) ? response.status : null;

  if (status === 401 || status === 403) {
    return createNoiseResult({
      ...base,
      status: ENRICHMENT_STATUS.INVALID_KEY,
      httpStatus: status,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY },
    });
  }
  if (status === 404) {
    return createNoiseResult({ ...base, status: ENRICHMENT_STATUS.NOT_FOUND, httpStatus: status });
  }
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(getHeader(response, "retry-after"));
    return createNoiseResult({
      ...base,
      status: ENRICHMENT_STATUS.RATE_LIMITED,
      httpStatus: status,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED },
      retryAfterSeconds,
    });
  }
  if (status !== null && status >= 500 && status <= 599) {
    return createNoiseResult({
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
      return createNoiseResult({
        ...base,
        status: ENRICHMENT_STATUS.FAILED,
        httpStatus: status,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE },
      });
    }

    const normalized = normalizeSuccessPayload(body);
    if (!normalized) {
      return createNoiseResult({
        ...base,
        status: ENRICHMENT_STATUS.FAILED,
        httpStatus: status,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE },
      });
    }

    return createNoiseResult({ ...base, status: ENRICHMENT_STATUS.SUCCESS, httpStatus: status, data: normalized });
  }

  // Any other/unexpected status code — a closed fallback that never throws.
  return createNoiseResult({
    ...base,
    status: ENRICHMENT_STATUS.FAILED,
    httpStatus: status,
    errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_REJECTED },
  });
}

/**
 * Creates the real GreyNoiseProvider. Constructible with no arguments at
 * all — no credentials required to import/construct this module; a missing
 * key only affects lookup() (SKIPPED_DISABLED).
 *
 * @param {{apiKey?: string, baseUrl?: string, timeoutMs?: number,
 *   enabled?: boolean, fetchImpl?: Function}} [config]
 */
function createGreyNoiseProvider(config = {}) {
  if (!isPlainObject(config)) {
    throw new TypeError("createGreyNoiseProvider: config must be an object");
  }

  let baseUrl;
  let timeoutMs;
  try {
    baseUrl = validateBaseUrl(config.baseUrl !== undefined ? config.baseUrl : DEFAULT_BASE_URL);
    timeoutMs = validateTimeoutMs(config.timeoutMs !== undefined ? config.timeoutMs : DEFAULT_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof GreyNoiseConfigError) throw err;
    throw new GreyNoiseConfigError(err.message);
  }

  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const explicitlyDisabled = config.enabled === false;
  const fetchImpl = typeof config.fetchImpl === "function" ? config.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createGreyNoiseProvider: no fetch implementation available — supply config.fetchImpl");
  }

  function isEnabled() {
    return !explicitlyDisabled && apiKey !== "";
  }

  // IPv4 only, mirroring censysProvider.js and this repository's IPv4-only
  // indicator model throughout (Finding.indicatorValue, IocEnrichment
  // INDICATOR_TYPES.IPV4). No IPv6 validator exists in this codebase to
  // extend safely, so none is added speculatively here either.
  function supports({ indicator } = {}) {
    return isValidIpv4(indicator);
  }

  async function lookup({ indicator, asOf, signal = null } = {}) {
    assertValidLookupRequest({ indicator, asOf });

    if (!isEnabled()) {
      return createNoiseResult({
        provider: PROVIDER_NAME,
        indicator,
        status: ENRICHMENT_STATUS.SKIPPED_DISABLED,
        queriedAt: asOf,
        errorInfo: { code: PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED },
      });
    }

    if (!supports({ indicator })) {
      return createNoiseResult({
        provider: PROVIDER_NAME,
        indicator,
        status: ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR,
        queriedAt: asOf,
        errorInfo: { code: PROVIDER_ERROR_CODES.UNSUPPORTED_INDICATOR },
      });
    }

    const url = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(indicator)}`;
    const headers = { key: apiKey, Accept: "application/json" };
    const composed = createComposedController(signal, timeoutMs);

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: composed.signal,
      });
    } catch (err) {
      composed.cleanup();
      if (err && err.name === "AbortError") {
        if (composed.isTimedOut()) {
          return createNoiseResult({
            provider: PROVIDER_NAME,
            indicator,
            status: ENRICHMENT_STATUS.TIMEOUT,
            queriedAt: asOf,
            errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT },
          });
        }
        throw err; // caller cancellation, propagate verbatim
      }
      return createNoiseResult({
        provider: PROVIDER_NAME,
        indicator,
        status: ENRICHMENT_STATUS.FAILED,
        queriedAt: asOf,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_UNREACHABLE },
      });
    }
    composed.cleanup();

    return mapHttpResponseToResult({ response, indicator, asOf });
  }

  // Debug/ops-facing summary — deliberately excludes the API key.
  function describe() {
    return Object.freeze({
      provider: PROVIDER_NAME,
      baseUrl,
      timeoutMs,
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
  createGreyNoiseProvider,
};
