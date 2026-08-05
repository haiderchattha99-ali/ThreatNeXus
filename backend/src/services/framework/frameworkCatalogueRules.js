"use strict";

// Catalogue-backed validation of a MITRE ATT&CK reference (Phase 6.3).
//
// Pure and dependency-free, like every other module in services/framework whose
// name ends in Rules: no Prisma, no filesystem, no clock, no network. The
// catalogue is INJECTED, which is what lets the unit tests exercise a revoked
// technique, an unknown id and a missing catalogue without loading 330 kB of
// MITRE data, while production injects the real pinned one.
//
// ===========================================================================
// Fail closed: no catalogue means no ATT&CK mapping
// ===========================================================================
// If a caller reaches assertAttackCatalogueReference without a catalogue, this
// module THROWS. It does not fall back to the Phase 5 format check, and it does
// not pass the reference through with a "could not verify" flag.
//
// That is the single most important decision in this file. The alternative —
// degrade to format-only when the catalogue is missing — would mean that a
// deployment with a broken catalogue file silently returns to accepting T9999,
// while every read path, every export and the navigator all still say
// "validated against pinned catalogue v19.1". A refused write is visible and
// recoverable. A mapping recorded as verified by a validator that did not run
// is neither.
//
// A skipped check must therefore be a REJECTION, never a pass. There is no code
// path in this repository that can write a MITRE_ATTACK mapping without a
// catalogue present, because the only way to skip the check is to fail it.
//
// ===========================================================================
// No approximate matching, in either direction
// ===========================================================================
// An id is looked up EXACTLY. `T1021.1` is not corrected to `T1021.001`,
// `T1021` is not silently promoted to a sub-technique, and an unknown id is
// never resolved to the nearest-looking real one. Coercion here would mean the
// stored mapping cites a technique the analyst never chose, and the audit trail
// would faithfully record the wrong decision.
//
// The title is checked the same way and for the same reason. A request pairing
// `T1021.001` with "SQL Injection" is refused rather than quietly rewritten:
// the mismatch is evidence that the analyst meant something else, and throwing
// it away would destroy the only signal that anything went wrong. Once the
// title is confirmed to match, the CANONICAL MITRE spelling is what gets
// stored, so two analysts cannot create two differently-capitalised records of
// the same technique.

const {
  MAPPING_REJECTION_CODES,
  FrameworkMappingValidationError,
} = require("./frameworkMappingErrors");

// Enterprise technique or sub-technique. Kept as a cheap pre-filter so an
// obviously malformed id is a clear shape error rather than a confusing
// "not in catalogue" — the catalogue lookup is still the authority.
const ATTACK_REFERENCE_ID_PATTERN = /^T\d{4}(\.\d{3})?$/;

// "19.1", "v19.1", "V19.1". The leading v is a display convention, not part of
// the version, and rejecting it would be pedantry that produces no safety.
const ATTACK_VERSION_PREFIX = /^v/i;

/**
 * Whitespace-collapsed, case-folded comparison form for a technique title.
 *
 * Only whitespace and case are normalized. Punctuation is NOT stripped: the
 * colon in "Remote Services: Remote Desktop Protocol" is what distinguishes the
 * sub-technique's full display name from its bare name, and removing it would
 * make two genuinely different strings compare equal.
 */
function normalizeTitleForComparison(value) {
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * True when `supplied` names `technique`.
 *
 * Both accepted spellings of a sub-technique are allowed, because both are
 * MITRE's own and an analyst copying from either the ATT&CK site or a report
 * should not be punished for which one they had in front of them:
 *   - the bare name        "Remote Desktop Protocol"
 *   - the full display name "Remote Services: Remote Desktop Protocol"
 */
function titleMatchesTechnique(supplied, technique) {
  const candidate = normalizeTitleForComparison(supplied);
  return (
    candidate === normalizeTitleForComparison(technique.name) ||
    candidate === normalizeTitleForComparison(technique.displayName)
  );
}

/**
 * Normalizes an ATT&CK framework version and holds it to the pinned catalogue.
 *
 * A mapping states which framework version it was made against. Once a
 * catalogue is pinned, accepting "v17.1" while validating against v19.1 would
 * write a self-contradictory row: the stored version would name a release this
 * system does not hold and did not check. Rejected instead, with both versions
 * named so the analyst knows exactly what to change.
 */
function assertAttackFrameworkVersion(frameworkVersion, catalogue) {
  const supplied = String(frameworkVersion).trim().replace(ATTACK_VERSION_PREFIX, "");
  const pinned = String(catalogue.attackVersion).trim().replace(ATTACK_VERSION_PREFIX, "");
  if (supplied !== pinned) {
    throw new FrameworkMappingValidationError(
      `A MITRE ATT&CK mapping must be made against the pinned catalogue version ${pinned}; received ${frameworkVersion}`,
      ["frameworkVersion"],
      MAPPING_REJECTION_CODES.ATTACK_VERSION_NOT_PINNED_CATALOGUE
    );
  }
  return pinned;
}

/**
 * Validates one ATT&CK reference against the pinned catalogue.
 *
 * @param {object} params
 * @param {string} params.referenceId     already trimmed and upper-cased
 * @param {string} params.referenceTitle  as supplied by the caller
 * @param {string} params.frameworkVersion
 * @param {object|null|undefined} catalogue  an object exposing
 *        `attackVersion` and `findTechnique(id) -> entry|null`
 *
 * @returns {{referenceId, referenceTitle, frameworkVersion, isSubTechnique,
 *            parentTechniqueId, tactics, catalogueVersion, catalogueChecksum, url}}
 * @throws  {FrameworkMappingValidationError} with a closed rejection code
 */
function assertAttackCatalogueReference({ referenceId, referenceTitle, frameworkVersion }, catalogue) {
  // The fail-closed branch. See this module's header — a caller that reaches
  // here without a catalogue gets a rejection, never a pass.
  if (!catalogue || typeof catalogue.findTechnique !== "function") {
    throw new FrameworkMappingValidationError(
      "The pinned MITRE ATT&CK catalogue is unavailable, so no ATT&CK mapping can be validated or created",
      ["referenceId"],
      MAPPING_REJECTION_CODES.ATTACK_CATALOGUE_REQUIRED
    );
  }

  if (!ATTACK_REFERENCE_ID_PATTERN.test(referenceId)) {
    throw new FrameworkMappingValidationError(
      "Expected an ATT&CK technique id such as T1021 or T1021.001",
      ["referenceId"],
      MAPPING_REJECTION_CODES.ATTACK_TECHNIQUE_NOT_IN_CATALOGUE
    );
  }

  const catalogueVersion = assertAttackFrameworkVersion(frameworkVersion, catalogue);

  const technique = catalogue.findTechnique(referenceId);
  if (!technique) {
    throw new FrameworkMappingValidationError(
      `${referenceId} is not a technique in the pinned MITRE ATT&CK Enterprise v${catalogueVersion} catalogue`,
      ["referenceId"],
      MAPPING_REJECTION_CODES.ATTACK_TECHNIQUE_NOT_IN_CATALOGUE
    );
  }

  // Revoked and deprecated are refused for NEW mappings and reported
  // separately, because they mean different things and the analyst's next
  // action differs. Existing rows citing them are NOT touched — see
  // frameworkMappingService.removeMapping, which withdraws a mapping without
  // re-validating its content precisely so a technique MITRE retired later can
  // still be withdrawn.
  if (technique.revoked === true) {
    const replacement = technique.revokedBy
      ? ` MITRE revoked it in favour of ${technique.revokedBy}.`
      : " MITRE revoked it.";
    throw new FrameworkMappingValidationError(
      `${referenceId} is revoked in MITRE ATT&CK Enterprise v${catalogueVersion}.${replacement}`,
      ["referenceId"],
      MAPPING_REJECTION_CODES.ATTACK_TECHNIQUE_REVOKED
    );
  }

  if (technique.deprecated === true) {
    throw new FrameworkMappingValidationError(
      `${referenceId} is deprecated in MITRE ATT&CK Enterprise v${catalogueVersion} and may not be used for a new mapping`,
      ["referenceId"],
      MAPPING_REJECTION_CODES.ATTACK_TECHNIQUE_DEPRECATED
    );
  }

  if (!titleMatchesTechnique(referenceTitle, technique)) {
    throw new FrameworkMappingValidationError(
      `${referenceId} is "${technique.displayName}" in the pinned catalogue; the supplied title does not name it`,
      ["referenceTitle"],
      MAPPING_REJECTION_CODES.ATTACK_TITLE_MISMATCH
    );
  }

  return Object.freeze({
    referenceId: technique.id,
    // Canonical MITRE spelling, stored only AFTER the supplied title was
    // confirmed to name this technique.
    referenceTitle: technique.displayName,
    frameworkVersion: catalogueVersion,
    isSubTechnique: technique.isSubTechnique === true,
    parentTechniqueId: technique.isSubTechnique === true ? technique.parentId : null,
    tactics: Array.isArray(technique.tactics) ? [...technique.tactics] : [],
    catalogueVersion,
    catalogueChecksum:
      typeof catalogue.checksum === "string" && catalogue.checksum.length > 0
        ? catalogue.checksum
        : null,
    url: typeof technique.url === "string" ? technique.url : null,
  });
}

module.exports = {
  ATTACK_REFERENCE_ID_PATTERN,
  normalizeTitleForComparison,
  titleMatchesTechnique,
  assertAttackFrameworkVersion,
  assertAttackCatalogueReference,
};
