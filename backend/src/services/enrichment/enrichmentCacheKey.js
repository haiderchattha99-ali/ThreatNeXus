"use strict";

// Deterministic IOC-enrichment cache identity (P2-T2b). Pure: no Prisma, no
// filesystem, no network, no wall clock, no randomness. The same inputs always
// produce the same cacheKey, in this process and in the next one.
//
// Identity is INDICATOR-level, never Finding-level or report-level — one
// reputation lookup answers a question about an address, so ten Findings on
// the same IP share one cache row and one TTL. The key is:
//
//     provider + indicatorType + canonical indicator + normalized queryParams
//
// Query parameters are normalized through P2-T2a's own `sanitizeQueryParams`
// — reused rather than reimplemented, so the allow-list that keeps an
// accidental credential out of a provider *result* is the same one that keeps
// it out of a cache *key*. An unknown key (an API key, a provider-specific
// credential, a nonce) is dropped before hashing: it never enters the hash
// input, the hash output, or the stored `queryParams` column.
//
// ---------------------------------------------------------------------------
// The hash contract is explicit, not "whatever JSON.stringify does"
// ---------------------------------------------------------------------------
// JavaScript object insertion order is NOT used as the serialization contract.
// The canonical form is a JSON array of [key, value] pairs sorted by key
// (`[["maxAgeInDays",30]]`), so `{a, b}` and `{b, a}` hash identically by
// construction rather than by luck, and adding an allow-listed parameter later
// cannot silently reshuffle existing keys.

const crypto = require("node:crypto");

const { isValidIpv4 } = require("../ownership/ipv4Cidr");
const { INDICATOR_TYPES, sanitizeQueryParams } = require("./iocEnrichmentTypes");

// A provider identifier is a short, stable, code-owned string. Bounded so an
// absurd caller-supplied value cannot become an unbounded index key.
const MAX_PROVIDER_NAME_LENGTH = 64;

const HASH_ALGORITHM = "sha256";

// Field separator for the cacheKey. "|" cannot occur in a lowercase provider
// identifier, an indicator-type enum value, a dotted-quad IPv4, or a hex
// digest, so the concatenation is unambiguous and needs no escaping.
const CACHE_KEY_SEPARATOR = "|";

class EnrichmentCacheKeyError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "EnrichmentCacheKeyError";
  }
}

function assertValidProvider(provider) {
  if (
    typeof provider !== "string" ||
    provider.trim() === "" ||
    provider !== provider.toLowerCase() ||
    provider.length > MAX_PROVIDER_NAME_LENGTH ||
    provider.includes(CACHE_KEY_SEPARATOR)
  ) {
    throw new EnrichmentCacheKeyError(
      "enrichmentCacheKey: provider must be a stable lowercase identifier"
    );
  }
}

// Case-sensitive on purpose: the provider identifier is compared exactly, so
// "AbuseIPDB" is rejected outright rather than silently folded into
// "abuseipdb" and producing a second key for what looks like one provider.
function assertValidIndicator(indicatorType, indicator) {
  if (indicatorType !== INDICATOR_TYPES.IPV4) {
    throw new EnrichmentCacheKeyError(
      `enrichmentCacheKey: unsupported indicatorType "${String(indicatorType)}"`
    );
  }
  if (typeof indicator !== "string" || !isValidIpv4(indicator)) {
    // Reuses ipv4Cidr's strict parser — leading zeros, whitespace padding,
    // IPv6, hostnames and CIDR-suffixed forms are all rejected here, never
    // normalized into something that would collide with a real address.
    throw new EnrichmentCacheKeyError(
      "enrichmentCacheKey: indicator must be a canonical dotted-quad IPv4 address"
    );
  }
}

/**
 * Canonical, key-order-independent serialization of normalized query
 * parameters. Exported so tests can assert on the exact hash input (e.g. that
 * a supplied secret is absent from it), not only on the digest.
 *
 * @param {object|null} queryParams raw caller parameters (allow-listed here)
 * @returns {string} e.g. `[["maxAgeInDays",30]]`
 */
function serializeQueryParams(queryParams) {
  const sanitized = sanitizeQueryParams(queryParams);
  const pairs = Object.keys(sanitized)
    .sort()
    .map((key) => [key, sanitized[key]]);
  return JSON.stringify(pairs);
}

function sha256Hex(value) {
  return crypto.createHash(HASH_ALGORITHM).update(value, "utf8").digest("hex");
}

/**
 * Builds the deterministic cache identity for one IOC enrichment lookup.
 *
 * @param {{provider: string, indicatorType: string, indicator: string,
 *   queryParams?: object|null}} input
 * @returns {{provider: string, indicatorType: string, indicator: string,
 *   queryParams: object, queryParamsHash: string, cacheKey: string}}
 *   deep-frozen; `queryParams` is the sanitized object safe to persist as-is.
 */
function buildEnrichmentCacheIdentity(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EnrichmentCacheKeyError("enrichmentCacheKey: input must be an object");
  }
  const { provider, indicatorType, indicator, queryParams = null } = input;

  assertValidProvider(provider);
  assertValidIndicator(indicatorType, indicator);

  const serializedQueryParams = serializeQueryParams(queryParams);
  const queryParamsHash = sha256Hex(serializedQueryParams);

  // The hashed identity covers every component, so two different components
  // can never produce the same digest by concatenation ambiguity.
  const cacheKey = sha256Hex(
    [provider, indicatorType, indicator, queryParamsHash].join(CACHE_KEY_SEPARATOR)
  );

  return Object.freeze({
    provider,
    indicatorType,
    indicator,
    queryParams: sanitizeQueryParams(queryParams),
    queryParamsHash,
    cacheKey,
  });
}

module.exports = {
  EnrichmentCacheKeyError,
  MAX_PROVIDER_NAME_LENGTH,
  HASH_ALGORITHM,
  CACHE_KEY_SEPARATOR,
  serializeQueryParams,
  buildEnrichmentCacheIdentity,
};
