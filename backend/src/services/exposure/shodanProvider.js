"use strict";

// Real Shodan exposure/attack-surface provider (Phase 8E) — Shodan's host
// lookup endpoint (GET {baseUrl}/shodan/host/{ip}?key={apiKey}), following
// the exact defensive shape censysProvider.js/greyNoiseProvider.js already
// established for a real third-party HTTP provider: composed
// timeout+caller-signal, every expected HTTP/transport outcome mapped to a
// normalized result via createExposureResult, never throwing for an
// expected outcome. Only throws for a genuine programmer/contract
// violation.
//
// Auth is Shodan's own documented shape: the API key as a `key` query
// parameter, not a header (unlike Censys's Bearer PAT or GreyNoise's `key`
// header) — Shodan's REST API has no header-based auth option. The key is
// read only to build that query string and is never logged: neither this
// module nor shodanExecutionService.js ever logs the request URL, so the
// key never reaches a log line, an audit row, or an error message. Automated
// tests only ever reach this module through an injected fetchImpl; nothing
// here touches the real internet during `npm test`.

const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
  createExposureResult,
} = require("./shodanTypes");
const { isValidIpv4 } = require("../ownership/ipv4Cidr");
const {
  ShodanConfigError,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  validateBaseUrl,
  validateTimeoutMs,
} = require("./shodanConfig");

const PROVIDER_NAME = "shodan";
const RETRY_AFTER_SECONDS_PATTERN = /^\d+$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertValidLookupRequest({ indicator, asOf } = {}) {
  if (typeof indicator !== "string" || indicator.trim() === "") {
    throw new TypeError("ShodanProvider.lookup: indicator must be a non-empty string");
  }
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new TypeError("ShodanProvider.lookup: asOf must be an explicit, valid Date");
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

// Allow-listed extraction only — every field Shodan could return that this
// provider does not explicitly ask for here is dropped, never passed
// through. `data` is Shodan's per-service banner array; `vulns` (when
// present) is an array of CVE id strings on the free host-lookup endpoint.
function normalizeServices(rawData) {
  if (!Array.isArray(rawData)) return [];
  return rawData
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      port: Number.isInteger(entry.port) ? entry.port : null,
      protocol: typeof entry.transport === "string" ? entry.transport : "TCP",
      product: typeof entry.product === "string" ? entry.product : null,
      version: typeof entry.version === "string" ? entry.version : null,
    }))
    .filter((entry) => Number.isInteger(entry.port) && entry.port >= 1 && entry.port <= 65535);
}

function normalizeSuccessPayload(body, indicator) {
  if (!isPlainObject(body)) return null;

  const hostnames = Array.isArray(body.hostnames) ? body.hostnames.filter((h) => typeof h === "string") : [];
  const vulnerabilities = Array.isArray(body.vulns)
    ? body.vulns.filter((v) => typeof v === "string")
    : [];

  return {
    services: normalizeServices(body.data),
    hostnames,
    organization: typeof body.org === "string" ? body.org : null,
    isp: typeof body.isp === "string" ? body.isp : null,
    country: typeof body.country_name === "string" ? body.country_name : null,
    countryCode: typeof body.country_code === "string" ? body.country_code : null,
    city: typeof body.city === "string" ? body.city : null,
    vulnerabilities,
    lastUpdate: typeof body.last_update === "string" ? body.last_update : null,
    // Constructed from the indicator itself, never a raw upstream field —
    // safe to carry through as a human reference link.
    link: `https://www.shodan.io/host/${indicator}`,
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
    return createExposureResult({
      ...base,
      status: ENRICHMENT_STATUS.INVALID_KEY,
      httpStatus: status,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY },
    });
  }
  if (status === 404) {
    return createExposureResult({ ...base, status: ENRICHMENT_STATUS.NOT_FOUND, httpStatus: status });
  }
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(getHeader(response, "retry-after"));
    return createExposureResult({
      ...base,
      status: ENRICHMENT_STATUS.RATE_LIMITED,
      httpStatus: status,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED },
      retryAfterSeconds,
    });
  }
  if (status !== null && status >= 500 && status <= 599) {
    return createExposureResult({
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
      return createExposureResult({
        ...base,
        status: ENRICHMENT_STATUS.FAILED,
        httpStatus: status,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE },
      });
    }

    const normalized = normalizeSuccessPayload(body, indicator);
    if (!normalized) {
      return createExposureResult({
        ...base,
        status: ENRICHMENT_STATUS.FAILED,
        httpStatus: status,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE },
      });
    }

    return createExposureResult({ ...base, status: ENRICHMENT_STATUS.SUCCESS, httpStatus: status, data: normalized });
  }

  // Any other/unexpected status code — a closed fallback that never throws.
  return createExposureResult({
    ...base,
    status: ENRICHMENT_STATUS.FAILED,
    httpStatus: status,
    errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_REJECTED },
  });
}

/**
 * Creates the real ShodanProvider. Constructible with no arguments at all —
 * no credentials required to import/construct this module; a missing key
 * only affects lookup() (SKIPPED_DISABLED).
 *
 * @param {{apiKey?: string, baseUrl?: string, timeoutMs?: number,
 *   enabled?: boolean, fetchImpl?: Function}} [config]
 */
function createShodanProvider(config = {}) {
  if (!isPlainObject(config)) {
    throw new TypeError("createShodanProvider: config must be an object");
  }

  let baseUrl;
  let timeoutMs;
  try {
    baseUrl = validateBaseUrl(config.baseUrl !== undefined ? config.baseUrl : DEFAULT_BASE_URL);
    timeoutMs = validateTimeoutMs(config.timeoutMs !== undefined ? config.timeoutMs : DEFAULT_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof ShodanConfigError) throw err;
    throw new ShodanConfigError(err.message);
  }

  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const explicitlyDisabled = config.enabled === false;
  const fetchImpl = typeof config.fetchImpl === "function" ? config.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createShodanProvider: no fetch implementation available — supply config.fetchImpl");
  }

  function isEnabled() {
    return !explicitlyDisabled && apiKey !== "";
  }

  // IPv4 only, mirroring censysProvider.js/greyNoiseProvider.js and this
  // repository's IPv4-only indicator model throughout. No IPv6 validator
  // exists in this codebase to extend safely, so none is added
  // speculatively here either.
  function supports({ indicator } = {}) {
    return isValidIpv4(indicator);
  }

  async function lookup({ indicator, asOf, signal = null } = {}) {
    assertValidLookupRequest({ indicator, asOf });

    if (!isEnabled()) {
      return createExposureResult({
        provider: PROVIDER_NAME,
        indicator,
        status: ENRICHMENT_STATUS.SKIPPED_DISABLED,
        queriedAt: asOf,
        errorInfo: { code: PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED },
      });
    }

    if (!supports({ indicator })) {
      return createExposureResult({
        provider: PROVIDER_NAME,
        indicator,
        status: ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR,
        queriedAt: asOf,
        errorInfo: { code: PROVIDER_ERROR_CODES.UNSUPPORTED_INDICATOR },
      });
    }

    // Shodan's REST API authenticates via a `key` query parameter — there is
    // no header-based option. The URL (which now embeds the key) is used
    // only for this one fetch call and is never logged, returned, or
    // included in any error/audit payload anywhere in this module or its
    // caller (shodanExecutionService.js).
    const url = `${baseUrl.replace(/\/+$/, "")}/shodan/host/${encodeURIComponent(indicator)}?key=${encodeURIComponent(apiKey)}`;
    const composed = createComposedController(signal, timeoutMs);

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: composed.signal,
      });
    } catch (err) {
      composed.cleanup();
      if (err && err.name === "AbortError") {
        if (composed.isTimedOut()) {
          return createExposureResult({
            provider: PROVIDER_NAME,
            indicator,
            status: ENRICHMENT_STATUS.TIMEOUT,
            queriedAt: asOf,
            errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT },
          });
        }
        throw err; // caller cancellation, propagate verbatim
      }
      return createExposureResult({
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
  createShodanProvider,
};
