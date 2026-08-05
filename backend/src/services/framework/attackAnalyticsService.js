"use strict";

// The ATT&CK navigator's read model (Phase 6.3).
//
// Answers the six questions the analyst surface exists to answer:
//   - which tactics currently appear in our evidence?
//   - which techniques are mapped, and how many times?
//   - which cases and findings support each technique?
//   - which mappings need reviewer attention?
//   - which cases were explicitly determined to have no applicable mapping?
//   - where are we legacy, restricted, empty or unavailable?
//
// ===========================================================================
// There is no coverage percentage here, and there never will be
// ===========================================================================
// Every figure this module emits is a RAW COUNT of rows that exist, and each
// one travels with a `countMeaning` saying so. Nothing is divided by anything.
//
// That is not squeamishness about arithmetic — it is that no honest denominator
// exists. "Percent of ATT&CK covered" would need the number of techniques that
// SHOULD apply to a constituent's estate, which nobody knows and no dataset
// contains. Printing 697 as the denominator would be worse still: it would mean
// a CERT that had correctly mapped every technique its evidence supported would
// read as "2% covered" and look negligent, while a team that forced weak
// mappings to fill the matrix would look diligent. The build guard forbids the
// metric for exactly that reason, and CaseFrameworkNoMappingAssertion exists so
// the honest answer has somewhere to live instead.
//
// A tactic with no mappings is reported as `mappedTechniqueCount: 0` and
// rendered as EMPTY — never as a gap, a failure or a percentage.
//
// ===========================================================================
// Organization scoping is applied by the caller, not assumed here
// ===========================================================================
// Every query takes an explicit `organizationIds` filter or an explicit
// "unrestricted" marker. There is no implicit "all organizations" default: a
// missing scope would silently widen a read across constituents, which is the
// one mistake this codebase cannot afford to make quietly.

const { MAPPING_STATES, FRAMEWORK_FAMILIES } = require("./frameworkMappingRules");
const {
  getAttackCatalogue,
  isAttackCatalogueAvailable,
  catalogueProvenance,
  AttackCatalogueUnavailableError,
} = require("./attackCatalogue");

// Bounds every aggregation read. A CERT-scale mapping table is small, but an
// unbounded scan is an availability surface regardless of today's row count.
const MAX_MAPPING_ROWS = 5000;

/**
 * Builds the organization filter for a Prisma `where`.
 *
 * `organizationIds === null` means UNRESTRICTED and is only ever produced by the
 * controller for a caller whose role holds cross-organization read. An empty
 * ARRAY means "scoped to nothing" and correctly yields no rows — the two are
 * deliberately different values so an empty scope can never be mistaken for an
 * absent one.
 */
function organizationWhere(organizationIds) {
  if (organizationIds === null) return {};
  return { organizationId: { in: organizationIds } };
}

/**
 * Raw ATT&CK mapping rows in scope, currently ACTIVE.
 *
 * Only MITRE_ATTACK: the navigator is an ATT&CK surface, and folding CSF or CIS
 * rows into a technique matrix would be a category error.
 */
async function loadActiveAttackMappings(client, organizationIds) {
  return client.caseFrameworkMapping.findMany({
    where: {
      framework: FRAMEWORK_FAMILIES.MITRE_ATTACK,
      state: MAPPING_STATES.ACTIVE,
      supersededAt: null,
      ...organizationWhere(organizationIds),
    },
    orderBy: [{ referenceId: "asc" }, { id: "asc" }],
    take: MAX_MAPPING_ROWS,
    select: {
      id: true,
      caseId: true,
      organizationId: true,
      referenceId: true,
      referenceTitle: true,
      mappingScope: true,
      evidenceBasis: true,
      evidenceFindingId: true,
      evidenceQuote: true,
      evidenceQuoteSource: true,
      evidenceQuoteLocator: true,
      evidenceConfidence: true,
      mappingConfidence: true,
      catalogueVerified: true,
      catalogueVersion: true,
      source: true,
      effectiveAt: true,
      case: { select: { id: true, caseReference: true, lifecycleState: true } },
    },
  });
}

async function loadStandingNoMappingAssertions(client, organizationIds) {
  return client.caseFrameworkNoMappingAssertion.findMany({
    where: {
      framework: FRAMEWORK_FAMILIES.MITRE_ATTACK,
      state: "ASSERTED",
      supersededAt: null,
      ...organizationWhere(organizationIds),
    },
    orderBy: [{ caseId: "asc" }, { id: "asc" }],
    take: MAX_MAPPING_ROWS,
    select: {
      id: true,
      caseId: true,
      organizationId: true,
      rationale: true,
      effectiveAt: true,
      case: { select: { id: true, caseReference: true, lifecycleState: true } },
    },
  });
}

/**
 * A mapping "needs review" when something about it is weaker than the record it
 * sits in claims.
 *
 * Three reasons, each independently checkable and each rendered distinctly:
 *   - LEGACY_UNVERIFIED   written before catalogue and evidence obligations
 *   - LOW_MAPPING_CONFIDENCE   the analyst said so themselves
 *   - STALE_CATALOGUE_VERSION  verified against a catalogue release this system
 *                              no longer pins, so the check that passed is not
 *                              the check that would run today
 *
 * These are FLAGS FOR A HUMAN, never automatic actions. Nothing here withdraws,
 * downgrades, hides or re-scores a mapping — a LOW confidence honestly declared
 * is a good record, and a system that penalised it would teach analysts to stop
 * declaring it.
 */
function reviewReasonsFor(mapping, pinnedVersion) {
  const reasons = [];
  if (mapping.catalogueVerified !== true || !mapping.evidenceQuote) {
    reasons.push("LEGACY_UNVERIFIED");
  }
  if (mapping.mappingConfidence === "LOW") {
    reasons.push("LOW_MAPPING_CONFIDENCE");
  }
  if (
    mapping.catalogueVerified === true &&
    typeof mapping.catalogueVersion === "string" &&
    typeof pinnedVersion === "string" &&
    mapping.catalogueVersion !== pinnedVersion
  ) {
    reasons.push("STALE_CATALOGUE_VERSION");
  }
  return reasons;
}

function serializeAnalyticsMapping(mapping, pinnedVersion) {
  const reviewReasons = reviewReasonsFor(mapping, pinnedVersion);
  return {
    id: mapping.id,
    caseId: mapping.caseId,
    caseReference: mapping.case ? mapping.case.caseReference : null,
    caseLifecycleState: mapping.case ? mapping.case.lifecycleState : null,
    organizationId: mapping.organizationId,
    referenceId: mapping.referenceId,
    referenceTitle: mapping.referenceTitle,
    mappingScope: mapping.mappingScope,
    evidenceBasis: mapping.evidenceBasis,
    evidenceFindingId: mapping.evidenceFindingId,
    evidenceQuote: mapping.evidenceQuote || null,
    evidenceQuoteSource: mapping.evidenceQuoteSource || null,
    evidenceQuoteLocator: mapping.evidenceQuoteLocator || null,
    evidenceConfidence: mapping.evidenceConfidence || null,
    mappingConfidence: mapping.mappingConfidence || null,
    confidenceMeaning: "EVIDENCE_AND_MAPPING_CONFIDENCE_ARE_SEPARATE_NEVER_COMBINED",
    referenceValidated: mapping.catalogueVerified === true,
    catalogueVersion: mapping.catalogueVersion || null,
    source: mapping.source,
    effectiveAt: mapping.effectiveAt,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
  };
}

/**
 * The full navigator read model.
 *
 * Returns the pinned matrix (every tactic, every mappable technique) joined with
 * the raw counts of what is actually mapped in scope. The matrix is emitted in
 * FULL rather than only for mapped techniques, because "this technique exists
 * and nothing is mapped to it" is exactly the state an analyst is scanning for,
 * and a matrix built only from mapped rows could never show it.
 *
 * @param {object} params
 * @param {object} params.client
 * @param {number[]|null} params.organizationIds  null = unrestricted (caller decided)
 * @param {Date} params.asOf                      the read's own timestamp, for provenance
 */
async function getAttackNavigator({ client, organizationIds, asOf }) {
  // The catalogue is what the matrix IS. Without it there is no matrix to draw,
  // and the honest answer is an explicit UNAVAILABLE state that the UI renders
  // as such — never an empty grid, which reads as "nothing is mapped".
  if (!isAttackCatalogueAvailable()) {
    return {
      availability: "UNAVAILABLE",
      availabilityReason: "ATTACK_CATALOGUE_UNAVAILABLE",
      asOf,
      catalogue: null,
      tactics: [],
      techniques: [],
      mappings: [],
      noApplicableAssertions: [],
      totals: null,
      countMeaning: "MAPPING_COUNT_NOT_COVERAGE",
      coveragePercentage: null,
      coveragePercentageMeaning: "NOT_COMPUTED_NO_HONEST_DENOMINATOR_EXISTS",
    };
  }

  const catalogue = getAttackCatalogue();
  const [mappings, assertions] = await Promise.all([
    loadActiveAttackMappings(client, organizationIds),
    loadStandingNoMappingAssertions(client, organizationIds),
  ]);

  const serializedMappings = mappings.map((mapping) =>
    serializeAnalyticsMapping(mapping, catalogue.attackVersion)
  );

  // Aggregate per technique. Distinct case and organization counts are computed
  // from Sets rather than from row counts: three mappings of T1021.001 across
  // one case is one case, and reporting three would overstate the spread.
  const byTechnique = new Map();
  serializedMappings.forEach((mapping) => {
    if (!byTechnique.has(mapping.referenceId)) {
      byTechnique.set(mapping.referenceId, {
        mappingCount: 0,
        caseIds: new Set(),
        organizationIds: new Set(),
        findingIds: new Set(),
        needsReviewCount: 0,
        verifiedCount: 0,
        legacyCount: 0,
      });
    }
    const bucket = byTechnique.get(mapping.referenceId);
    bucket.mappingCount += 1;
    bucket.caseIds.add(mapping.caseId);
    bucket.organizationIds.add(mapping.organizationId);
    if (mapping.evidenceFindingId !== null) bucket.findingIds.add(mapping.evidenceFindingId);
    if (mapping.needsReview) bucket.needsReviewCount += 1;
    if (mapping.referenceValidated) bucket.verifiedCount += 1;
    else bucket.legacyCount += 1;
  });

  // Only mappable techniques enter the matrix. A deprecated or revoked
  // technique cannot be newly mapped, so listing it as an unmapped cell would
  // invite an analyst to try — and be refused.
  //
  // A mapping that cites a technique which has SINCE been revoked is still
  // reported (see orphanedMappings below); it is simply not a cell.
  const techniques = catalogue.techniques
    .filter((technique) => !technique.deprecated && !technique.revoked)
    .map((technique) => {
      const bucket = byTechnique.get(technique.id);
      return {
        id: technique.id,
        name: technique.name,
        displayName: technique.displayName,
        isSubTechnique: technique.isSubTechnique,
        parentId: technique.parentId,
        tactics: technique.tactics,
        url: technique.url,
        mappingCount: bucket ? bucket.mappingCount : 0,
        caseCount: bucket ? bucket.caseIds.size : 0,
        organizationCount: bucket ? bucket.organizationIds.size : 0,
        findingCount: bucket ? bucket.findingIds.size : 0,
        needsReviewCount: bucket ? bucket.needsReviewCount : 0,
        verifiedCount: bucket ? bucket.verifiedCount : 0,
        legacyCount: bucket ? bucket.legacyCount : 0,
        status: bucket && bucket.mappingCount > 0 ? "MAPPED" : "UNMAPPED",
      };
    });

  const techniqueById = new Map(techniques.map((technique) => [technique.id, technique]));

  // A mapping whose technique is no longer in the mappable matrix — because
  // MITRE revoked or deprecated it after the mapping was written. Reported
  // explicitly rather than dropped: silently omitting it would make the sum of
  // the cells disagree with the mapping count, and an analyst would have no way
  // to find the row that needs revisiting.
  const orphanedMappings = serializedMappings.filter(
    (mapping) => !techniqueById.has(mapping.referenceId)
  );

  const tactics = catalogue.tactics.map((tactic) => {
    const inTactic = techniques.filter((technique) => technique.tactics.includes(tactic.shortName));
    const mapped = inTactic.filter((technique) => technique.mappingCount > 0);
    return {
      id: tactic.id,
      shortName: tactic.shortName,
      name: tactic.name,
      order: tactic.order,
      url: tactic.url,
      // Counts of techniques and mappings, never a ratio of either to anything.
      techniqueCount: inTactic.length,
      mappedTechniqueCount: mapped.length,
      mappingCount: mapped.reduce((total, technique) => total + technique.mappingCount, 0),
      needsReviewCount: mapped.reduce((total, technique) => total + technique.needsReviewCount, 0),
      status: mapped.length > 0 ? "PRESENT_IN_EVIDENCE" : "EMPTY",
    };
  });

  const needsReview = serializedMappings.filter((mapping) => mapping.needsReview);

  return {
    availability: "AVAILABLE",
    availabilityReason: null,
    asOf,
    catalogue: catalogueProvenance(),
    tactics,
    techniques,
    mappings: serializedMappings,
    orphanedMappings,
    noApplicableAssertions: assertions.map((assertion) => ({
      id: assertion.id,
      caseId: assertion.caseId,
      caseReference: assertion.case ? assertion.case.caseReference : null,
      organizationId: assertion.organizationId,
      rationale: assertion.rationale,
      effectiveAt: assertion.effectiveAt,
    })),
    needsReview,
    totals: {
      // Every one of these is a count of rows that exist.
      activeMappings: serializedMappings.length,
      mappedTechniques: techniques.filter((technique) => technique.mappingCount > 0).length,
      catalogueTechniques: techniques.length,
      casesWithMappings: new Set(serializedMappings.map((mapping) => mapping.caseId)).size,
      casesWithNoApplicableDetermination: new Set(
        assertions.map((assertion) => assertion.caseId)
      ).size,
      needsReview: needsReview.length,
      legacyUnverified: serializedMappings.filter((mapping) => !mapping.referenceValidated).length,
      orphanedMappings: orphanedMappings.length,
      // Set when the row cap was reached, so a truncated read can never be
      // mistaken for a complete one. Silently capping would make every count
      // above a lower bound presented as a total.
      truncated: serializedMappings.length >= MAX_MAPPING_ROWS,
    },
    countMeaning: "MAPPING_COUNT_NOT_COVERAGE",
    // Emitted as an explicit null with a stated reason rather than omitted. A
    // missing field invites a consumer to compute its own; a present null that
    // says why does not.
    coveragePercentage: null,
    coveragePercentageMeaning: "NOT_COMPUTED_NO_HONEST_DENOMINATOR_EXISTS",
  };
}

/**
 * The pinned catalogue itself, for the technique picker and the matrix legend.
 *
 * Emits only mappable techniques by default — the picker should not offer a
 * technique the validator will refuse — with the deprecated/revoked counts
 * reported separately so the omission is visible rather than silent.
 */
function getCatalogueReadModel({ includeRetired = false } = {}) {
  if (!isAttackCatalogueAvailable()) {
    const error = new AttackCatalogueUnavailableError(
      "The pinned MITRE ATT&CK catalogue is not available",
      "ATTACK_CATALOGUE_UNAVAILABLE"
    );
    throw error;
  }

  const catalogue = getAttackCatalogue();
  const techniques = catalogue.techniques.filter(
    (technique) => includeRetired || (!technique.deprecated && !technique.revoked)
  );

  return {
    catalogue: catalogueProvenance(),
    tactics: catalogue.tactics,
    techniques: techniques.map((technique) => ({
      id: technique.id,
      name: technique.name,
      displayName: technique.displayName,
      isSubTechnique: technique.isSubTechnique,
      parentId: technique.parentId,
      tactics: technique.tactics,
      deprecated: technique.deprecated,
      revoked: technique.revoked,
      revokedBy: technique.revokedBy,
      url: technique.url,
    })),
    retiredExcluded: includeRetired
      ? 0
      : catalogue.counts.deprecated + catalogue.counts.revoked,
  };
}

module.exports = {
  MAX_MAPPING_ROWS,
  organizationWhere,
  reviewReasonsFor,
  serializeAnalyticsMapping,
  loadActiveAttackMappings,
  loadStandingNoMappingAssertions,
  getAttackNavigator,
  getCatalogueReadModel,
};
