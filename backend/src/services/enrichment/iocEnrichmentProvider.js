"use strict";

// IocEnrichmentProvider contract (P2-T2a) — the interface every IOC
// reputation provider (MockProvider now, the future AbuseIPDBProvider) must
// implement. JavaScript has no interface keyword, so this module documents
// the contract, provides the one indicator-support check every provider
// should reuse (never a second, weaker IPv4 parser), and a small runtime
// shape check the registry uses before trusting a provider.
//
// Contract every provider object must satisfy:
//
//   provider.name
//     A stable, lowercase, provider identifier (e.g. "mock", "abuseipdb").
//
//   provider.supports({ indicatorType, indicator }) -> boolean
//     Synchronous, side-effect-free. True only when this provider can look
//     this exact indicator up at all — never a promise, never an I/O call.
//
//   provider.lookup({ indicatorType, indicator, asOf, queryParams, signal })
//     -> Promise<NormalizedResult>
//     Asynchronous. Must:
//       - never read the wall clock — `asOf` (an explicit, caller-supplied
//         Date) is the only source of the result's `queriedAt`
//       - never mutate its input (indicatorType/indicator/queryParams)
//       - return a normalized result (see iocEnrichmentTypes.js's
//         createEnrichmentResult) for every EXPECTED outcome — not found,
//         rate limited, invalid key, timed out, unavailable, unreachable,
//         a malformed response, an unsupported indicator, or a disabled
//         provider — NEVER throw for any of these
//       - only throw (a TypeError) for a genuine programmer/contract
//         violation, e.g. a missing or invalid `asOf`
//
// No Prisma access, no filesystem access, no audit logging inside a
// provider — those belong to the caller (P2-T2b's enrichment orchestrator),
// which has the request/actor context a provider does not.

const { isValidIpv4 } = require("../ownership/ipv4Cidr");
const { INDICATOR_TYPES } = require("./iocEnrichmentTypes");

// The one indicator-support check every provider should call from its own
// `supports()` — reuses the existing strict, canonical IPv4 parser
// (ipv4Cidr.js) rather than a second, weaker implementation. Only IPv4 is
// supported in this MVP; IPv6, hostnames, URLs, and malformed/leading-zero/
// whitespace-padded IPv4 strings are all correctly "not supported" here.
function isSupportedIocIndicator({ indicatorType, indicator } = {}) {
  if (indicatorType !== INDICATOR_TYPES.IPV4) return false;
  return typeof indicator === "string" && isValidIpv4(indicator);
}

// Contract-level validation for a lookup() call — a violation here is a
// programmer error (missing/invalid asOf, wrong-typed indicator), never an
// expected provider outcome, so it throws rather than returning a result.
function assertValidLookupRequest({ indicatorType, indicator, asOf } = {}) {
  if (typeof indicatorType !== "string" || indicatorType.trim() === "") {
    throw new TypeError("IocEnrichmentProvider.lookup: indicatorType must be a non-empty string");
  }
  if (typeof indicator !== "string" || indicator.trim() === "") {
    throw new TypeError("IocEnrichmentProvider.lookup: indicator must be a non-empty string");
  }
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new TypeError("IocEnrichmentProvider.lookup: asOf must be an explicit, valid Date");
  }
}

// Minimal runtime shape check — proves a candidate at least has the right
// method surface before the registry (or a future AbuseIPDBProvider
// registration) trusts it as a provider. Not a substitute for behavioral
// tests against the candidate.
function assertImplementsIocEnrichmentProvider(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("IocEnrichmentProvider: provider must be an object");
  }
  if (
    typeof candidate.name !== "string" ||
    candidate.name.trim() === "" ||
    candidate.name !== candidate.name.toLowerCase()
  ) {
    throw new TypeError("IocEnrichmentProvider: provider.name must be a stable lowercase identifier");
  }
  if (typeof candidate.supports !== "function") {
    throw new TypeError("IocEnrichmentProvider: provider.supports must be a function");
  }
  if (typeof candidate.lookup !== "function") {
    throw new TypeError("IocEnrichmentProvider: provider.lookup must be a function");
  }
}

module.exports = {
  isSupportedIocIndicator,
  assertValidLookupRequest,
  assertImplementsIocEnrichmentProvider,
};
