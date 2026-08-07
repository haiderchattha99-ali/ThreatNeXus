"use strict";

// Real Censys exposure/attack-surface provider (Phase 8B) — the Censys
// PLATFORM API's host-lookup endpoint (GET /v3/global/asset/host/{ip}),
// following the exact defensive shape abuseIpdbProvider.js already
// established for a real third-party HTTP provider: composed
// timeout+caller-signal, every expected HTTP/transport outcome mapped to a
// normalized result via createExposureResult, never throwing for an expected
// outcome. Only throws for a genuine programmer/contract violation.
//
// This is the CURRENT Censys API (censys.com's Platform API, base URL
// api.platform.censys.io/v3), not the older/legacy Search v2 API
// (search.censys.io) — an earlier version of this file targeted Search v2's
// Basic Auth (API ID + secret) shape, which does not accept the Personal
// Access Token credential Censys actually issues today. Auth is a single
// Bearer PAT; the response nests host data one level deeper, under
// `result.resource` rather than `result` directly; and field names differ
// (`autonomous_system.description` not `.name`; no documented certificate
// field on this endpoint, so certificateCount is always null here rather than
// guessed). The PAT is read only to build the Authorization header and is
// never logged, returned, or included in any error. Automated tests only
// ever reach this module through an injected fetchImpl; nothing here touches
// the real internet during `npm test`.

const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
  createExposureResult,
} = require("./censysTypes");
const { isValidIpv4 } = require("../ownership/ipv4Cidr");
const {
  CensysConfigError,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  validateBaseUrl,
  validateTimeoutMs,
} = require("./censysConfig");

const PROVIDER_NAME = "censys";
const RETRY_AFTER_SECONDS_PATTERN = /^\d+$/;
// Versioned Accept header the Platform API's host-lookup endpoint documents —
// distinct from a generic "application/json", and required by Censys to pin
// the response schema version this provider was written against.
const HOST_ACCEPT_HEADER = "application/vnd.censys.api.v3.host.v1+json";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertValidLookupRequest({ indicator, asOf } = {}) {
  if (typeof indicator !== "string" || indicator.trim() === "") {
    throw new TypeError("CensysProvider.lookup: indicator must be a non-empty string");
  }
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new TypeError("CensysProvider.lookup: asOf must be an explicit, valid Date");
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

// Allow-listed extraction only — every field Censys could return that this
// provider does not explicitly ask for here is dropped, never passed through.
//
// Platform API service entries carry BOTH `protocol` (the application-layer
// name, e.g. "HTTP") and `transport_protocol` (TCP/UDP) — the same two roles
// Search v2 called `service_name`/`transport_protocol`, just renamed.
function normalizeServices(rawServices) {
  if (!Array.isArray(rawServices)) return [];
  return rawServices
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      port: Number.isInteger(entry.port) ? entry.port : null,
      protocol: typeof entry.transport_protocol === "string" ? entry.transport_protocol : "UNKNOWN",
      serviceName: typeof entry.protocol === "string" ? entry.protocol : null,
    }))
    .filter((entry) => Number.isInteger(entry.port) && entry.port >= 1 && entry.port <= 65535);
}

// `resource` is the object at `result.resource` in a Platform API host
// response — one level deeper than Search v2's `result` was.
function normalizeSuccessPayload(resource) {
  if (!isPlainObject(resource)) return null;

  const services = normalizeServices(resource.services);
  const asInfo = isPlainObject(resource.autonomous_system) ? resource.autonomous_system : null;
  const autonomousSystemNumber =
    asInfo && Number.isInteger(asInfo.asn) && asInfo.asn >= 0 ? asInfo.asn : null;
  // Platform API names this field `description`, not `name` (Search v2's
  // field name) — e.g. "CLOUDFLARENET" arrives here either way.
  const autonomousSystemName =
    asInfo && typeof asInfo.description === "string" ? asInfo.description : null;
  // The documented Platform API host-lookup response carries no certificate
  // field at all (unlike Search v2, which had one) — left null rather than
  // guessed at a field name Censys has not documented, per this repo's own
  // rule that unknown stays unknown, never a fabricated value.
  const certificateCount = null;

  return { services, autonomousSystemNumber, autonomousSystemName, certificateCount };
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

    if (!isPlainObject(body) || !isPlainObject(body.result) || !isPlainObject(body.result.resource)) {
      return createExposureResult({
        ...base,
        status: ENRICHMENT_STATUS.FAILED,
        httpStatus: status,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE },
      });
    }

    const normalized = normalizeSuccessPayload(body.result.resource);
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
 * Creates the real CensysProvider. Constructible with no arguments at all —
 * no credentials required to import/construct this module; a missing PAT
 * only affects lookup() (SKIPPED_DISABLED).
 *
 * @param {{pat?: string, orgId?: string, baseUrl?: string,
 *   timeoutMs?: number, enabled?: boolean, fetchImpl?: Function}} [config]
 */
function createCensysProvider(config = {}) {
  if (!isPlainObject(config)) {
    throw new TypeError("createCensysProvider: config must be an object");
  }

  let baseUrl;
  let timeoutMs;
  try {
    baseUrl = validateBaseUrl(config.baseUrl !== undefined ? config.baseUrl : DEFAULT_BASE_URL);
    timeoutMs = validateTimeoutMs(config.timeoutMs !== undefined ? config.timeoutMs : DEFAULT_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof CensysConfigError) throw err;
    throw new CensysConfigError(err.message);
  }

  const pat = typeof config.pat === "string" ? config.pat.trim() : "";
  // Optional — Censys documents X-Organization-ID as an optional header for
  // accounts that belong to more than one organization. Most personal
  // accounts never need it.
  const orgId = typeof config.orgId === "string" ? config.orgId.trim() : "";
  const explicitlyDisabled = config.enabled === false;
  const fetchImpl = typeof config.fetchImpl === "function" ? config.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createCensysProvider: no fetch implementation available — supply config.fetchImpl");
  }

  function isEnabled() {
    return !explicitlyDisabled && pat !== "";
  }

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

    const url = `${baseUrl.replace(/\/+$/, "")}/global/asset/host/${encodeURIComponent(indicator)}`;
    const headers = { Authorization: `Bearer ${pat}`, Accept: HOST_ACCEPT_HEADER };
    if (orgId !== "") headers["X-Organization-ID"] = orgId;
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

  // Debug/ops-facing summary — deliberately excludes the PAT.
  function describe() {
    return Object.freeze({
      provider: PROVIDER_NAME,
      baseUrl,
      timeoutMs,
      enabled: isEnabled(),
      orgIdConfigured: orgId !== "",
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
  createCensysProvider,
};
