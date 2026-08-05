"use strict";

// Error types and the closed rejection vocabulary for framework mapping.
//
// Extracted from frameworkMappingRules.js in Phase 6.3 so the new pure rule
// modules (catalogue validation, evidence integrity) can throw the SAME error
// types without importing the module that imports them. The alternative — each
// new module defining its own error class — would have meant a controller
// needing three `instanceof` checks to decide one status code, and a rejection
// code that a caller could not rely on being present.
//
// frameworkMappingRules.js re-exports everything here, so every existing import
// site keeps working unchanged.
//
// The rejection codes are a CLOSED vocabulary. They are returned to analysts
// (who need to be told what to fix) and written into audit reasons, so every
// value must be a literal from this table — never free text, never a database
// message, never an interpolated caller value.

const MAPPING_REJECTION_CODES = Object.freeze({
  // --- Phase 5: the ATT&CK behaviour gates -------------------------------
  ATTACK_REQUIRES_OBSERVED_BEHAVIOR: "ATTACK_REQUIRES_OBSERVED_BEHAVIOR",
  ATTACK_RATIONALE_TOO_SHORT: "ATTACK_RATIONALE_TOO_SHORT",
  ATTACK_RATIONALE_NOT_BEHAVIOURAL: "ATTACK_RATIONALE_NOT_BEHAVIOURAL",
  ATTACK_EXPOSURE_ONLY_RATIONALE: "ATTACK_EXPOSURE_ONLY_RATIONALE",
  ATTACK_EVIDENCE_NOT_LINKED: "ATTACK_EVIDENCE_NOT_LINKED",
  EVIDENCE_FINDING_NOT_LINKED: "EVIDENCE_FINDING_NOT_LINKED",
  EVIDENCE_FINDING_REQUIRED_FOR_SCOPE: "EVIDENCE_FINDING_REQUIRED_FOR_SCOPE",
  CASE_NOT_ORGANIZATION_BOUND: "CASE_NOT_ORGANIZATION_BOUND",
  MAPPING_NOT_CURRENT: "MAPPING_NOT_CURRENT",
  MAPPING_NOT_FOR_CASE: "MAPPING_NOT_FOR_CASE",

  // --- Phase 6.3: catalogue validation ------------------------------------
  // The caller asked for an ATT&CK mapping and no catalogue was supplied to
  // validate it against. Fails CLOSED — see frameworkCatalogueRules.
  ATTACK_CATALOGUE_REQUIRED: "ATTACK_CATALOGUE_REQUIRED",
  // A syntactically valid id that names nothing. This is the gap Phase 5
  // documented and Phase 6.3 closes.
  ATTACK_TECHNIQUE_NOT_IN_CATALOGUE: "ATTACK_TECHNIQUE_NOT_IN_CATALOGUE",
  // Known to the catalogue, but MITRE revoked it. Distinct from "unknown"
  // because the analyst can be told what replaced it.
  ATTACK_TECHNIQUE_REVOKED: "ATTACK_TECHNIQUE_REVOKED",
  // Known to the catalogue, but MITRE deprecated it.
  ATTACK_TECHNIQUE_DEPRECATED: "ATTACK_TECHNIQUE_DEPRECATED",
  // The title supplied alongside the id is not that technique's name. Refused
  // rather than overwritten: silently replacing it would hide that the analyst
  // was describing a different technique from the one they typed.
  ATTACK_TITLE_MISMATCH: "ATTACK_TITLE_MISMATCH",
  // frameworkVersion names a release other than the pinned catalogue's. A
  // mapping cannot claim to be validated against a version nothing here holds.
  ATTACK_VERSION_NOT_PINNED_CATALOGUE: "ATTACK_VERSION_NOT_PINNED_CATALOGUE",

  // --- Phase 6.3: evidence integrity --------------------------------------
  EVIDENCE_QUOTE_REQUIRED: "EVIDENCE_QUOTE_REQUIRED",
  EVIDENCE_QUOTE_TOO_SHORT: "EVIDENCE_QUOTE_TOO_SHORT",
  // The quote does not occur, character for character, in the record it cites.
  EVIDENCE_QUOTE_NOT_VERBATIM: "EVIDENCE_QUOTE_NOT_VERBATIM",
  // The chosen quote source needs a Finding and none was supplied.
  EVIDENCE_SOURCE_REQUIRES_FINDING: "EVIDENCE_SOURCE_REQUIRES_FINDING",
  // The cited source record does not exist, or holds nothing quotable.
  EVIDENCE_SOURCE_RECORD_UNAVAILABLE: "EVIDENCE_SOURCE_RECORD_UNAVAILABLE",
  EVIDENCE_CONFIDENCE_REQUIRED: "EVIDENCE_CONFIDENCE_REQUIRED",
  MAPPING_CONFIDENCE_REQUIRED: "MAPPING_CONFIDENCE_REQUIRED",

  // --- Phase 6.3: the explicit "no applicable mapping" determination -------
  NO_APPLICABLE_ASSERTION_NOT_CURRENT: "NO_APPLICABLE_ASSERTION_NOT_CURRENT",
  NO_APPLICABLE_ASSERTION_NOT_FOR_CASE: "NO_APPLICABLE_ASSERTION_NOT_FOR_CASE",
  // A framework cannot simultaneously have active mappings and a standing
  // assertion that nothing in it applies. Both directions are refused.
  NO_APPLICABLE_CONFLICTS_WITH_ACTIVE_MAPPING: "NO_APPLICABLE_CONFLICTS_WITH_ACTIVE_MAPPING",
  MAPPING_CONFLICTS_WITH_NO_APPLICABLE_ASSERTION: "MAPPING_CONFLICTS_WITH_NO_APPLICABLE_ASSERTION",
});

/**
 * The caller's input is wrong. Controllers map this to 400.
 */
class FrameworkMappingValidationError extends Error {
  constructor(message, fields, code) {
    super(message);
    this.name = "FrameworkMappingValidationError";
    this.fields = Array.isArray(fields) ? fields : [];
    this.code = typeof code === "string" ? code : null;
  }
}

class FrameworkMappingNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "FrameworkMappingNotFoundError";
  }
}

/**
 * A well-formed request the durable state refuses (case not organization-bound,
 * evidence not linked, mapping row not current, quote not verbatim in the cited
 * record). Controllers map it to 409, never 400 — the caller's input was fine,
 * the world is not.
 */
class FrameworkMappingStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FrameworkMappingStateError";
    this.code = typeof code === "string" ? code : null;
  }
}

module.exports = {
  MAPPING_REJECTION_CODES,
  FrameworkMappingValidationError,
  FrameworkMappingNotFoundError,
  FrameworkMappingStateError,
};
