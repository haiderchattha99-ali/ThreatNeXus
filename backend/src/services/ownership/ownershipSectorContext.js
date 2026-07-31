"use strict";

// ===========================================================================
// Safe organization/sector context for the ownership read API.
//
// WHAT THIS IS FOR
// ----------------
// An analyst looking at a Finding needs to know who owns it and whether that
// attribution is strong enough for sector criticality to count toward the
// score. Before this, the ownership API returned the raw ownership row and
// nothing about the organization at all, so the sector question could only be
// answered by reading the risk explanation.
//
// THE RULE THAT MAKES THIS SAFE
// -----------------------------
// Sector applicability is NOT recomputed here. It comes from
// riskInputSnapshot.loadOwnershipContext — the same function the risk engine
// scores with. A serializer that re-derived "is the sector attributable"
// would be a second copy of a locked rule, free to drift from the one that
// actually decides points. This module only RENAMES that result into a closed
// API vocabulary.
//
// Likewise, no basis points are calculated here. Whether sector criticality is
// APPLICABLE is ownership context; what it is WORTH belongs to the Risk v1
// contribution/explanation surface and stays there.
//
// WHAT IS DELIBERATELY NOT EXPOSED
// --------------------------------
// Organization contact fields (contactPerson/email/phone), securityScore and
// activeThreats; AssetMapping address internals (ipStart/ipEnd BigInts,
// provenanceNote); FindingOwnership.currentForFindingId; audit history. Only
// the identity, the sector, and closed status/derivation codes leave here.
// ===========================================================================

const { OWNERSHIP_RESOLUTION_STATUS, REASON_CODES } = require("./ownershipResolver");

// Closed API vocabulary for "can sector criticality count for this Finding?".
// One APPLICABLE value and one distinct reason per way it can fail — the
// packet requires the API to distinguish these, never to collapse them into a
// single false.
const SECTOR_APPLICABILITY = Object.freeze({
  APPLICABLE: "APPLICABLE",
  NOT_APPLICABLE_NO_OWNERSHIP: "NOT_APPLICABLE_NO_OWNERSHIP",
  NOT_APPLICABLE_AMBIGUOUS: "NOT_APPLICABLE_AMBIGUOUS",
  NOT_APPLICABLE_UNRESOLVED: "NOT_APPLICABLE_UNRESOLVED",
  NOT_APPLICABLE_NO_ORGANIZATION: "NOT_APPLICABLE_NO_ORGANIZATION",
  NOT_APPLICABLE_ISP_ATTRIBUTION: "NOT_APPLICABLE_ISP_ATTRIBUTION",
  NOT_APPLICABLE_LOW_CONFIDENCE: "NOT_APPLICABLE_LOW_CONFIDENCE",
  NOT_APPLICABLE_UNKNOWN_SECTOR: "NOT_APPLICABLE_UNKNOWN_SECTOR",
});

// loadOwnershipContext's internal reason vocabulary -> the API's.
const APPLICABILITY_BY_REASON = Object.freeze({
  NO_OWNERSHIP: SECTOR_APPLICABILITY.NOT_APPLICABLE_NO_OWNERSHIP,
  AMBIGUOUS: SECTOR_APPLICABILITY.NOT_APPLICABLE_AMBIGUOUS,
  UNRESOLVED: SECTOR_APPLICABILITY.NOT_APPLICABLE_UNRESOLVED,
  NO_ORGANIZATION: SECTOR_APPLICABILITY.NOT_APPLICABLE_NO_ORGANIZATION,
  ISP_ATTRIBUTION: SECTOR_APPLICABILITY.NOT_APPLICABLE_ISP_ATTRIBUTION,
  LOW_CONFIDENCE: SECTOR_APPLICABILITY.NOT_APPLICABLE_LOW_CONFIDENCE,
  UNKNOWN_SECTOR: SECTOR_APPLICABILITY.NOT_APPLICABLE_UNKNOWN_SECTOR,
});

// How this Finding came to be attributed — a closed derivation code, so a
// client never has to parse a reason string or infer ISP-ness from a boolean
// plus a status.
const ATTRIBUTION_TYPE = Object.freeze({
  NONE: "NONE",
  ANALYST_OVERRIDE: "ANALYST_OVERRIDE",
  EXACT_IP: "EXACT_IP",
  CIDR: "CIDR",
  ISP_ASN: "ISP_ASN",
  AMBIGUOUS: "AMBIGUOUS",
});

function deriveAttributionType(row) {
  if (!row) return ATTRIBUTION_TYPE.NONE;
  if (row.status === OWNERSHIP_RESOLUTION_STATUS.OVERRIDDEN) {
    return ATTRIBUTION_TYPE.ANALYST_OVERRIDE;
  }
  if (row.status === OWNERSHIP_RESOLUTION_STATUS.AMBIGUOUS) return ATTRIBUTION_TYPE.AMBIGUOUS;
  if (row.isIspAttribution === true) return ATTRIBUTION_TYPE.ISP_ASN;
  if (row.reasonCode === REASON_CODES.EXACT_IP_MATCH) return ATTRIBUTION_TYPE.EXACT_IP;
  if (row.reasonCode === REASON_CODES.CIDR_MATCH) return ATTRIBUTION_TYPE.CIDR;
  return ATTRIBUTION_TYPE.NONE;
}

/**
 * Builds the safe organization/sector context for one Finding's CURRENT
 * ownership row.
 *
 * @param {object} client Prisma client
 * @param {number} findingId
 * @param {object|null} currentRow the already-loaded current ownership row, if
 *   the caller has it (avoids a second read); loaded via loadOwnershipContext
 *   regardless, which is the authority on applicability.
 */
async function buildSectorContext(client, findingId, currentRow = null) {
  // eslint-disable-next-line global-require
  const { loadOwnershipContext } = require("../risk/riskInputSnapshot");
  const context = await loadOwnershipContext(client, findingId);

  const applicability = context.sectorAttributable
    ? SECTOR_APPLICABILITY.APPLICABLE
    : APPLICABILITY_BY_REASON[context.nonAttributableReason] ||
      SECTOR_APPLICABILITY.NOT_APPLICABLE_NO_OWNERSHIP;

  // Name only — never contactPerson/email/phone/securityScore/activeThreats.
  let organizationName = null;
  if (Number.isInteger(context.organizationId)) {
    const organization = await client.organization.findUnique({
      where: { id: context.organizationId },
      select: { name: true },
    });
    organizationName = organization ? organization.name : null;
  }

  // Mapping TYPE and SOURCE only — the provenance of the claim. Never the
  // address internals (ipStart/ipEnd/exactIp/cidr) or the analyst free-text
  // provenanceNote.
  let matchedMapping = null;
  if (currentRow && Number.isInteger(currentRow.matchedMappingId)) {
    const mapping = await client.assetMapping.findUnique({
      where: { id: currentRow.matchedMappingId },
      select: { id: true, mappingType: true, source: true, mappingConfirmed: true },
    });
    if (mapping) {
      matchedMapping = {
        id: mapping.id,
        mappingType: mapping.mappingType,
        source: mapping.source,
        mappingConfirmed: mapping.mappingConfirmed,
      };
    }
  }

  return {
    organizationId: context.organizationId,
    organizationName,
    sector: context.sector,
    ownershipStatus: context.status,
    ownershipConfidence: context.confidence,
    attributionType: deriveAttributionType(currentRow),
    isIspAttribution: context.isIspAttribution === true,
    matchedMapping,
    resolvedAt: currentRow ? currentRow.resolvedAt : null,
    effectiveAt: currentRow ? currentRow.asOf : null,
    // Whether sector criticality can contribute under Risk v1 — the gate, not
    // the points. The number lives in the risk explanation.
    sectorCriticalityApplicability: applicability,
    sectorCriticalityApplicable: applicability === SECTOR_APPLICABILITY.APPLICABLE,
  };
}

module.exports = {
  SECTOR_APPLICABILITY,
  ATTRIBUTION_TYPE,
  deriveAttributionType,
  buildSectorContext,
};
