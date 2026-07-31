"use strict";

// Pure ownership-resolution decision function for Phase 2 (P2-T1). No Prisma
// access, no I/O, no wall-clock reads (asOf is always supplied by the
// caller) — every input this function needs is passed in explicitly, so the
// same call always produces the same result regardless of database row
// order or when it runs. findingOwnershipService.js is the only caller that
// is allowed to touch Prisma; it loads mappings/override state, calls this,
// and persists the result.

const { isValidIpv4, ipv4ToInt, rangeContains } = require("./ipv4Cidr");

const OWNERSHIP_RESOLUTION_STATUS = Object.freeze({
  RESOLVED: "RESOLVED",
  AMBIGUOUS: "AMBIGUOUS",
  UNRESOLVED: "UNRESOLVED",
  OVERRIDDEN: "OVERRIDDEN",
});

const OWNERSHIP_CONFIDENCE = Object.freeze({
  CONFIRMED: "CONFIRMED",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
});

const ASSET_MAPPING_TYPE = Object.freeze({
  EXACT_IP: "EXACT_IP",
  CIDR: "CIDR",
  ASN: "ASN",
});

// Stable, machine-readable reason codes — never free text. Every branch of
// the algorithm below sets exactly one of these.
const REASON_CODES = Object.freeze({
  UNSUPPORTED_INDICATOR: "OWNERSHIP_UNSUPPORTED_INDICATOR",
  ANALYST_OVERRIDE: "OWNERSHIP_ANALYST_OVERRIDE",
  EXACT_IP_MATCH: "OWNERSHIP_EXACT_IP_MATCH",
  AMBIGUOUS_EXACT_IP: "OWNERSHIP_AMBIGUOUS_EXACT_IP",
  CIDR_MATCH: "OWNERSHIP_CIDR_MATCH",
  AMBIGUOUS_CIDR: "OWNERSHIP_AMBIGUOUS_CIDR",
  ASN_MATCH: "OWNERSHIP_ASN_MATCH",
  AMBIGUOUS_ASN: "OWNERSHIP_AMBIGUOUS_ASN",
  NO_MATCH: "OWNERSHIP_NO_MATCH",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A mapping participates in resolution only when enabled and, if it has a
// validity window, `asOf` falls inside it. validFrom is inclusive,
// validUntil is exclusive (a mapping is no longer active AT validUntil).
function isActiveMapping(mapping, asOf) {
  if (!mapping || mapping.enabled !== true) return false;
  if (mapping.validFrom instanceof Date && mapping.validFrom > asOf) return false;
  if (mapping.validUntil instanceof Date && mapping.validUntil <= asOf) return false;
  return true;
}

function confidenceForPrefixLength(prefixLength) {
  if (prefixLength >= 24) return OWNERSHIP_CONFIDENCE.HIGH;
  if (prefixLength >= 16) return OWNERSHIP_CONFIDENCE.MEDIUM;
  return OWNERSHIP_CONFIDENCE.LOW;
}

// Deterministic representative pick among mappings tied for the same
// (winning) organization/tier — the lowest mapping id, independent of the
// order mappings were supplied in.
function lowestId(mappings) {
  return mappings.reduce((lowest, m) => (lowest === null || m.id < lowest.id ? m : lowest), null);
}

function distinctOrganizationIds(mappings) {
  return [...new Set(mappings.map((m) => m.organizationId))];
}

// Builds the RESOLVED/AMBIGUOUS outcome for a set of mappings that already
// share the winning tier (exact-IP set, the max-prefix CIDR tier, or the ASN
// set). `extra` carries tier-specific fields (confidence, matchedPrefixLength,
// isIspAttribution).
function decideAtTier(tierMappings, matchReason, ambiguousReason, extra) {
  const orgIds = distinctOrganizationIds(tierMappings);

  if (orgIds.length === 1) {
    const winner = lowestId(tierMappings.filter((m) => m.organizationId === orgIds[0]));
    return {
      status: OWNERSHIP_RESOLUTION_STATUS.RESOLVED,
      organizationId: orgIds[0],
      confidence: extra.confidence,
      matchedMappingId: winner.id,
      matchedPrefixLength: extra.matchedPrefixLength,
      candidateCount: 1,
      isIspAttribution: extra.isIspAttribution,
      reasonCode: matchReason,
    };
  }

  return {
    status: OWNERSHIP_RESOLUTION_STATUS.AMBIGUOUS,
    organizationId: null,
    confidence: null,
    matchedMappingId: null,
    matchedPrefixLength: extra.matchedPrefixLength,
    candidateCount: orgIds.length,
    isIspAttribution: extra.isIspAttribution,
    reasonCode: ambiguousReason,
  };
}

/**
 * Resolves ownership for one indicator against a snapshot of active mapping
 * candidates and any current analyst override.
 *
 * @param {{indicatorValue: string, asn?: number|null, asOf: Date}} observation
 * @param {{mappings: Array<object>, currentOverride?: {organizationId: number}|null}} context
 *   `mappings` is the full raw AssetMapping candidate set (not pre-filtered —
 *   this function applies enabled/validFrom/validUntil itself using asOf).
 *   Each mapping needs: id, organizationId, mappingType, ipStart, ipEnd,
 *   prefixLength, asn, enabled, validFrom, validUntil.
 * @returns {{status: string, organizationId: number|null, confidence: string|null,
 *   matchedMappingId: number|null, matchedPrefixLength: number|null,
 *   candidateCount: number, isIspAttribution: boolean, reasonCode: string}}
 */
function resolveOwnership(observation, context) {
  if (!isPlainObject(observation) || !(observation.asOf instanceof Date)) {
    throw new TypeError("resolveOwnership: observation.asOf must be a Date");
  }
  if (!isPlainObject(context) || !Array.isArray(context.mappings)) {
    throw new TypeError("resolveOwnership: context.mappings must be an array");
  }

  const { indicatorValue, asn = null } = observation;
  const { asOf } = observation;
  const currentOverride = context.currentOverride || null;

  // 0. Invalid/unsupported indicator short-circuits everything, including an
  // active override — an override still names an organization for a real
  // indicator, and a Finding's indicatorValue is only ever a strict IPv4
  // string, but this function defends its own contract regardless of caller.
  if (!isValidIpv4(indicatorValue)) {
    return {
      status: OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED,
      organizationId: null,
      confidence: null,
      matchedMappingId: null,
      matchedPrefixLength: null,
      candidateCount: 0,
      isIspAttribution: false,
      reasonCode: REASON_CODES.UNSUPPORTED_INDICATOR,
    };
  }

  // 1. An active analyst override wins outright.
  if (currentOverride && Number.isInteger(currentOverride.organizationId)) {
    return {
      status: OWNERSHIP_RESOLUTION_STATUS.OVERRIDDEN,
      organizationId: currentOverride.organizationId,
      confidence: OWNERSHIP_CONFIDENCE.CONFIRMED,
      matchedMappingId: null,
      matchedPrefixLength: null,
      candidateCount: 1,
      isIspAttribution: false,
      reasonCode: REASON_CODES.ANALYST_OVERRIDE,
    };
  }

  const indicatorInt = ipv4ToInt(indicatorValue);
  const activeMappings = context.mappings.filter((m) => isActiveMapping(m, asOf));

  // 2. Exact-IP tier.
  const exactMatches = activeMappings.filter(
    (m) =>
      m.mappingType === ASSET_MAPPING_TYPE.EXACT_IP &&
      rangeContains(indicatorInt, { ipStart: m.ipStart, ipEnd: m.ipEnd })
  );
  if (exactMatches.length > 0) {
    return decideAtTier(exactMatches, REASON_CODES.EXACT_IP_MATCH, REASON_CODES.AMBIGUOUS_EXACT_IP, {
      confidence: OWNERSHIP_CONFIDENCE.HIGH,
      matchedPrefixLength: null,
      isIspAttribution: false,
    });
  }

  // 3. CIDR tier — longest prefix only; shorter prefixes never break a tie.
  const cidrMatches = activeMappings.filter(
    (m) =>
      m.mappingType === ASSET_MAPPING_TYPE.CIDR &&
      rangeContains(indicatorInt, { ipStart: m.ipStart, ipEnd: m.ipEnd })
  );
  if (cidrMatches.length > 0) {
    const maxPrefixLength = Math.max(...cidrMatches.map((m) => m.prefixLength));
    const tierMatches = cidrMatches.filter((m) => m.prefixLength === maxPrefixLength);
    return decideAtTier(tierMatches, REASON_CODES.CIDR_MATCH, REASON_CODES.AMBIGUOUS_CIDR, {
      confidence: confidenceForPrefixLength(maxPrefixLength),
      matchedPrefixLength: maxPrefixLength,
      isIspAttribution: false,
    });
  }

  // 4. ASN tier — only consulted when neither exact-IP nor CIDR produced any
  // match at all (not even an ambiguous one).
  if (asn !== null && asn !== undefined) {
    const asnMatches = activeMappings.filter(
      (m) => m.mappingType === ASSET_MAPPING_TYPE.ASN && m.asn === asn
    );
    if (asnMatches.length > 0) {
      return decideAtTier(asnMatches, REASON_CODES.ASN_MATCH, REASON_CODES.AMBIGUOUS_ASN, {
        confidence: OWNERSHIP_CONFIDENCE.LOW,
        matchedPrefixLength: null,
        isIspAttribution: true,
      });
    }
  }

  // 5. Nothing matched at any tier.
  return {
    status: OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED,
    organizationId: null,
    confidence: null,
    matchedMappingId: null,
    matchedPrefixLength: null,
    candidateCount: 0,
    isIspAttribution: false,
    reasonCode: REASON_CODES.NO_MATCH,
  };
}

module.exports = {
  OWNERSHIP_RESOLUTION_STATUS,
  OWNERSHIP_CONFIDENCE,
  ASSET_MAPPING_TYPE,
  REASON_CODES,
  isActiveMapping,
  confidenceForPrefixLength,
  resolveOwnership,
};
