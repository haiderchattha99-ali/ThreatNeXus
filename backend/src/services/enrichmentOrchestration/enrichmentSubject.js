"use strict";

// Phase 10A-1 — what an enrichment lookup is ABOUT, and which provider is
// allowed to be asked about it. Pure: no Prisma, no network, no wall clock, no
// randomness, no provider factory.
//
// ---------------------------------------------------------------------------
// Why "subject" and not "indicator"
// ---------------------------------------------------------------------------
// IocIndicatorType means what it has always meant and is untouched. NVD's
// subject is a CVE identifier, which is not an indicator of compromise — using
// the IOC vocabulary for it would have made the ADMIN vulnerability batch and
// the IOC reputation path look like one pipeline, which they are not.
//
// ---------------------------------------------------------------------------
// Canonicalization happens BEFORE any hash or uniqueness decision
// ---------------------------------------------------------------------------
// " 8.8.8.8 " and "8.8.8.8" are one subject; "cve-2024-3094" and
// "CVE-2024-3094" are one subject. If canonicalization ran after hashing, the
// activeLookupKey uniqueness that is the entire cross-Finding dedup guarantee
// would silently fragment into one job per spelling. Both canonicalizers are
// REUSED from the modules that already own those formats (ipv4Cidr.js's strict
// dotted-quad parser, cveIdentifier.js's normalizeCveId) rather than
// reimplemented here — a second parser is a second set of edge cases.

const { isValidIpv4 } = require("../ownership/ipv4Cidr");
const { normalizeCveId, isValidCveId } = require("../vulnerability/cveIdentifier");

// Mirrors the EnrichmentSubjectType enum in schema.prisma. Kept as a frozen
// plain object rather than imported from @prisma/client so every pure test can
// use it without a generated client.
const SUBJECT_TYPES = Object.freeze({
  IPV4: "IPV4",
  CVE: "CVE",
});

const SUBJECT_TYPE_VALUES = Object.freeze(Object.values(SUBJECT_TYPES));

// The five IPv4 reputation/exposure providers and the one CVE provider.
// Lowercase identifiers, matching IocEnrichment.provider's existing convention
// (D-007: provider is a String so adding one needs no migration).
//
// This map is the single source of truth for provider/subject compatibility in
// application code. The same pairing is independently enforced by two CHECK
// constraints in the migration, so a service bug cannot write a row this map
// would have refused.
const PROVIDER_SUBJECT_TYPES = Object.freeze({
  abuseipdb: SUBJECT_TYPES.IPV4,
  greynoise: SUBJECT_TYPES.IPV4,
  censys: SUBJECT_TYPES.IPV4,
  shodan: SUBJECT_TYPES.IPV4,
  netlas: SUBJECT_TYPES.IPV4,
  nvd: SUBJECT_TYPES.CVE,
});

const KNOWN_PROVIDERS = Object.freeze(Object.keys(PROVIDER_SUBJECT_TYPES).sort());

class EnrichmentSubjectError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "EnrichmentSubjectError";
  }
}

/**
 * Whether a provider identifier is one Phase 10 orchestration knows about.
 *
 * @param {unknown} provider
 * @returns {boolean}
 */
function isKnownProvider(provider) {
  return (
    typeof provider === "string" &&
    Object.prototype.hasOwnProperty.call(PROVIDER_SUBJECT_TYPES, provider)
  );
}

/**
 * The one subject type a provider accepts.
 *
 * @param {string} provider
 * @returns {string|null} null for an unknown provider — callers decide whether
 *   that is a validation error (a caller-supplied provider) or a routing skip.
 */
function subjectTypeForProvider(provider) {
  return isKnownProvider(provider) ? PROVIDER_SUBJECT_TYPES[provider] : null;
}

/**
 * Whether this provider accepts this subject type. Never throws — the
 * applicability router calls it to DECIDE, and a false answer there is a
 * routed SKIPPED_UNSUPPORTED_SUBJECT, not an exception.
 *
 * @param {unknown} provider
 * @param {unknown} subjectType
 * @returns {boolean}
 */
function isProviderSubjectCompatible(provider, subjectType) {
  return isKnownProvider(provider) && PROVIDER_SUBJECT_TYPES[provider] === subjectType;
}

/**
 * Canonicalizes one subject value for its type.
 *
 * IPV4: strict dotted-quad only. Leading zeros, whitespace padding, IPv6,
 * hostnames and CIDR-suffixed forms are REJECTED, never coerced into something
 * that would collide with a real address.
 *
 * CVE: canonical uppercase CVE-YYYY-NNNN.., through cveIdentifier's own
 * validator (year floor and length bound included).
 *
 * Surrounding whitespace is trimmed before validation because it is a
 * transport artefact, not part of either value. Nothing else is coerced.
 *
 * @param {string} subjectType
 * @param {unknown} value
 * @returns {string} the canonical value
 * @throws {EnrichmentSubjectError} on an unknown type or an invalid value
 */
function canonicalizeSubjectValue(subjectType, value) {
  if (typeof value !== "string") {
    throw new EnrichmentSubjectError("enrichmentSubject: subject value must be a string");
  }
  const trimmed = value.trim();

  if (subjectType === SUBJECT_TYPES.IPV4) {
    if (!isValidIpv4(trimmed)) {
      throw new EnrichmentSubjectError(
        "enrichmentSubject: IPV4 subject must be a canonical dotted-quad IPv4 address"
      );
    }
    return trimmed;
  }

  if (subjectType === SUBJECT_TYPES.CVE) {
    if (!isValidCveId(trimmed)) {
      throw new EnrichmentSubjectError(
        "enrichmentSubject: CVE subject must be a valid CVE identifier"
      );
    }
    // normalizeCveId owns the uppercase canonical form.
    return normalizeCveId(trimmed);
  }

  throw new EnrichmentSubjectError(
    `enrichmentSubject: unsupported subjectType "${String(subjectType)}"`
  );
}

/**
 * Builds a validated, canonical, frozen subject.
 *
 * @param {{subjectType: string, subjectValue: unknown}} input
 * @returns {{subjectType: string, subjectValue: string}} frozen
 */
function buildSubject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EnrichmentSubjectError("enrichmentSubject: input must be an object");
  }
  const { subjectType, subjectValue } = input;
  return Object.freeze({
    subjectType,
    subjectValue: canonicalizeSubjectValue(subjectType, subjectValue),
  });
}

/**
 * Deterministic ordering for a set of subjects, so requestScopeHash's input is
 * stable regardless of the order the caller assembled them in.
 *
 * Sorts by (provider, subjectType, subjectValue) as plain strings. Applied to
 * canonical values only — sorting before canonicalization would order by
 * spelling rather than by identity.
 *
 * @param {Array<{provider: string, subjectType: string, subjectValue: string}>} targets
 * @returns {Array} a new sorted array
 */
function sortTargets(targets) {
  return [...targets].sort((left, right) => {
    if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
    if (left.subjectType !== right.subjectType) {
      return left.subjectType < right.subjectType ? -1 : 1;
    }
    if (left.subjectValue === right.subjectValue) return 0;
    return left.subjectValue < right.subjectValue ? -1 : 1;
  });
}

module.exports = {
  EnrichmentSubjectError,
  SUBJECT_TYPES,
  SUBJECT_TYPE_VALUES,
  PROVIDER_SUBJECT_TYPES,
  KNOWN_PROVIDERS,
  isKnownProvider,
  subjectTypeForProvider,
  isProviderSubjectCompatible,
  canonicalizeSubjectValue,
  buildSubject,
  sortTargets,
};
