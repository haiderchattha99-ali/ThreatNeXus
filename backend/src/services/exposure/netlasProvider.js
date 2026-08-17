"use strict";

// Real Netlas exposure/attack-surface provider (Phase 8F) — Netlas's Host
// Info endpoint (GET {baseUrl}/api/host/{ip}/), following the exact
// defensive shape censysProvider.js/greyNoiseProvider.js/shodanProvider.js
// already established for a real third-party HTTP provider: composed
// timeout+caller-signal, every expected HTTP/transport outcome mapped to a
// normalized result via createExposureResult, never throwing for an
// expected outcome. Only throws for a genuine programmer/contract
// violation.
//
// Auth is Netlas's current documented scheme (RFC 6750 Bearer token) —
// `Authorization: Bearer <key>`, the same header shape censysProvider.js
// uses for its PAT (Netlas's older `X-Api-Key` header is documented as
// deprecated, so this provider does not use it). The key is read only to
// build that header and is never logged: neither this module nor
// netlasExecutionService.js ever logs the Authorization header or the
// request URL. Automated tests only ever reach this module through an
// injected fetchImpl; nothing here touches the real internet during
// `npm test`.
//
// Response field names below (ip/ptr/domains/geo.country/organization/
// ports[]/software[]/certificate.*/whois.asn.*/lseen/fseen) follow Netlas's
// documented Host Info response shape (docs.netlas.io/api-reference/).
// `ports[].prot4` is the transport protocol (tcp/udp); `ports[].prot7` is
// the application-layer service name Netlas detected on that port.

const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
  createExposureResult,
} = require("./netlasTypes");
const { isValidIpv4 } = require("../ownership/ipv4Cidr");
const {
  ResponseTooLargeError,
  readBoundedResponseText,
} = require("../shared/boundedResponseBody");
const {
  NetlasConfigError,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  validateBaseUrl,
  validateTimeoutMs,
} = require("./netlasConfig");

const PROVIDER_NAME = "netlas";
const RETRY_AFTER_SECONDS_PATTERN = /^\d+$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertValidLookupRequest({ indicator, asOf } = {}) {
  if (typeof indicator !== "string" || indicator.trim() === "") {
    throw new TypeError("NetlasProvider.lookup: indicator must be a non-empty string");
  }
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new TypeError("NetlasProvider.lookup: asOf must be an explicit, valid Date");
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

// Allow-listed extraction only — every field Netlas could return that this
// provider does not explicitly ask for here is dropped, never passed
// through (e.g. `whois.raw`, the full WHOIS text, never lands anywhere).
function normalizeServices(rawPorts) {
  if (!Array.isArray(rawPorts)) return [];
  return rawPorts
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      port: Number.isInteger(entry.port) ? entry.port : null,
      protocol: typeof entry.prot4 === "string" ? entry.prot4 : "TCP",
      service: typeof entry.prot7 === "string" ? entry.prot7 : null,
    }))
    .filter((entry) => Number.isInteger(entry.port) && entry.port >= 1 && entry.port <= 65535);
}

function normalizeProducts(rawSoftware) {
  if (!Array.isArray(rawSoftware)) return [];
  return rawSoftware
    .filter((entry) => entry && typeof entry === "object" && typeof entry.product === "string")
    .map((entry) => ({
      product: entry.product,
      version: typeof entry.version === "string" ? entry.version : null,
    }));
}

function normalizeSuccessPayload(body, indicator) {
  if (!isPlainObject(body)) return null;

  const geo = isPlainObject(body.geo) ? body.geo : {};
  const whois = isPlainObject(body.whois) ? body.whois : {};
  const whoisNet = isPlainObject(whois.net) ? whois.net : {};
  const whoisAsn = isPlainObject(whois.asn) ? whois.asn : {};
  const certificate = isPlainObject(body.certificate) ? body.certificate : {};
  const certificateSubject = isPlainObject(certificate.subject) ? certificate.subject : {};

  const ptr = Array.isArray(body.ptr) ? body.ptr.filter((h) => typeof h === "string") : [];
  const domains = Array.isArray(body.domains) ? body.domains.filter((h) => typeof h === "string") : [];
  const san = Array.isArray(certificate.names) ? certificate.names.filter((h) => typeof h === "string") : [];

  return {
    services: normalizeServices(body.ports),
    products: normalizeProducts(body.software),
    hostnames: ptr,
    dnsNames: domains,
    organization:
      typeof body.organization === "string"
        ? body.organization
        : typeof whoisNet.organization === "string"
          ? whoisNet.organization
          : null,
    asn: Number.isInteger(whoisAsn.number) ? whoisAsn.number : null,
    asnOrg: typeof whoisAsn.name === "string" ? whoisAsn.name : null,
    country: typeof geo.country === "string" ? geo.country : null,
    certificateSubject: typeof certificateSubject.common_name === "string" ? certificateSubject.common_name : null,
    certificateIssuer: typeof certificate.issuer_dn === "string" ? certificate.issuer_dn : null,
    certificateSan: san,
    lastSeen: typeof body.lseen === "string" ? body.lseen : null,
    firstSeen: typeof body.fseen === "string" ? body.fseen : null,
    // Constructed from the indicator itself, never a raw upstream field —
    // safe to carry through as a human reference link.
    link: `https://app.netlas.io/host/${indicator}/`,
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
  // 402 is Netlas's own "out of subscription plan limits" response — a
  // quota-exhaustion signal, not an auth failure. This closed vocabulary has
  // no separate "quota" status, and RATE_LIMITED ("try again later, not a
  // credentials problem") is the closer fit of the two, same as 429.
  if (status === 402 || status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(getHeader(response, "retry-after"));
    return createExposureResult({
      ...base,
      status: ENRICHMENT_STATUS.RATE_LIMITED,
      httpStatus: status,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED },
      retryAfterSeconds,
    });
  }
  if (status === 400) {
    return createExposureResult({
      ...base,
      status: ENRICHMENT_STATUS.FAILED,
      httpStatus: status,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_REJECTED },
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
    // TNX-P10C5 — read through the shared bounded-body seam rather than
    // response.json() directly: an oversized body is refused before it is
    // ever fully materialized or parsed (boundedResponseBody.js).
    let bodyText;
    try {
      bodyText = await readBoundedResponseText(response);
    } catch (err) {
      if (err instanceof ResponseTooLargeError) {
        return createExposureResult({
          ...base,
          status: ENRICHMENT_STATUS.FAILED,
          httpStatus: status,
          errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_RESPONSE_TOO_LARGE },
        });
      }
      return createExposureResult({
        ...base,
        status: ENRICHMENT_STATUS.FAILED,
        httpStatus: status,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE },
      });
    }

    let body;
    try {
      body = JSON.parse(bodyText);
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
 * Creates the real NetlasProvider. Constructible with no arguments at all —
 * no credentials required to import/construct this module; a missing key
 * only affects lookup() (SKIPPED_DISABLED).
 *
 * @param {{apiKey?: string, baseUrl?: string, timeoutMs?: number,
 *   enabled?: boolean, fetchImpl?: Function}} [config]
 */
function createNetlasProvider(config = {}) {
  if (!isPlainObject(config)) {
    throw new TypeError("createNetlasProvider: config must be an object");
  }

  let baseUrl;
  let timeoutMs;
  try {
    baseUrl = validateBaseUrl(config.baseUrl !== undefined ? config.baseUrl : DEFAULT_BASE_URL);
    timeoutMs = validateTimeoutMs(config.timeoutMs !== undefined ? config.timeoutMs : DEFAULT_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof NetlasConfigError) throw err;
    throw new NetlasConfigError(err.message);
  }

  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const explicitlyDisabled = config.enabled === false;
  const fetchImpl = typeof config.fetchImpl === "function" ? config.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createNetlasProvider: no fetch implementation available — supply config.fetchImpl");
  }

  function isEnabled() {
    return !explicitlyDisabled && apiKey !== "";
  }

  // IPv4 only, mirroring censysProvider.js/greyNoiseProvider.js/
  // shodanProvider.js and this repository's IPv4-only indicator model
  // throughout. Netlas's Host Info endpoint also accepts a domain name, but
  // this codebase has no domain/hostname indicator validator or model
  // anywhere to extend safely — the same reasoning that already keeps every
  // exposure provider here IPv4-only rather than speculatively adding one.
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

    const url = `${baseUrl.replace(/\/+$/, "")}/api/host/${encodeURIComponent(indicator)}/`;
    const composed = createComposedController(signal, timeoutMs);

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
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
  createNetlasProvider,
};
