"use strict";

// Pure, dependency-free rules for Phase 5 AI mapping assistance.
//
// No Prisma, no wall clock, no HTTP, no network, no provider. Importing this
// module cannot make a request, cannot read a key, and cannot start anything.
//
// ===========================================================================
// AI output is untrusted input
// ===========================================================================
// A provider response is treated exactly as a request body from an anonymous
// client would be: unknown keys are REJECTED (not dropped), every value is
// type-and-bound checked, and the content must clear the SAME framework rules a
// hand-written mapping clears — including the MITRE ATT&CK evidence rule. A
// candidate that fails is DISCARDED and counted. It is never repaired, never
// coerced, never partially persisted, and never shown to an analyst.
//
// This is the honest reading of the "four gates" in the build plan. Two of them
// (schema conformance, cap) are cheap and near-certain to pass when a provider
// is well behaved. The load-bearing ones here are the ThreatNeXus-side checks:
// reference-id shape per family, the ATT&CK behaviour rule, and evidence
// belonging to THIS case. A model that invents T9999 or cites a Finding from
// somebody else's case is stopped before an analyst ever sees the suggestion.
//
// What this phase deliberately does NOT claim: catalogue validation. No pinned
// ATT&CK/CSF/CIS catalogue exists in this repository, so a syntactically valid
// but non-existent technique id passes shape validation and reaches review.
// Claiming otherwise would be worse than the gap.
//
// ===========================================================================
// What AI is structurally unable to do here
// ===========================================================================
// The provider contract has exactly ONE method and it returns DATA. A provider
// receives no Prisma client, no transaction, no repository, no HTTP handle and
// no capability token, so there is no object on which it could score, approve,
// close, reopen, export, notify, enrich, scan, attach a CVE, resolve ownership
// or write anything at all. The prohibition is enforced by what the interface
// omits, not by a rule somebody remembered to write — and
// tests/unit/aiSafetyBoundaries.test.js proves the omission.

const {
  FRAMEWORK_FAMILY_VALUES,
  MAPPING_SCOPE_VALUES,
  EVIDENCE_BASIS_VALUES,
  normalizeMappingContent,
  FrameworkMappingValidationError,
} = require("../framework/frameworkMappingRules");

// Version-stamped contract identity, stored on every run and every suggestion
// so an old suggestion stays interpretable after this file changes.
const PROMPT_TEMPLATE_VERSION = "framework-mapping-suggestion-v1";

// Hard cap on how many suggestions ONE run may produce. A provider returning
// forty candidates does not get to bury a reviewer — the surplus is discarded
// and counted, never silently truncated without a record.
const MAX_SUGGESTIONS_PER_RUN = 5;

// Bounds on analyst-supplied and provider-supplied text.
const MAX_REQUEST_CONTEXT_LENGTH = 1000;
const MAX_DECISION_REASON_LENGTH = 1000;
const MAX_PROVIDER_NAME_LENGTH = 64;
const MAX_PROVIDER_MODEL_LENGTH = 128;

// The complete set of keys a provider candidate may carry. Anything else is a
// rejection, not a silent drop: a caller (or a model) must never be able to
// discover an internal column by having it quietly ignored, and must never
// reach one a future refactor forgets to filter.
const ALLOWED_CANDIDATE_KEYS = Object.freeze([
  "framework",
  "frameworkVersion",
  "referenceId",
  "referenceTitle",
  "mappingScope",
  "evidenceBasis",
  "rationale",
  "evidenceFindingId",
  "confidence",
]);

// Provider result statuses. A closed set — a provider returning anything else
// is treated as a failure, never guessed at.
const PROVIDER_RESULT_STATUSES = Object.freeze({
  DISABLED: "DISABLED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
});

const PROVIDER_RESULT_STATUS_VALUES = Object.freeze(Object.values(PROVIDER_RESULT_STATUSES));

// Closed machine-readable vocabulary written into AiSuggestionRun.reasonCode.
// Never free text, never an exception message, never a provider error string.
const RUN_REASON_CODES = Object.freeze({
  // AI_ENABLED is false. The shipped default, and a legitimate answer.
  AI_DISABLED: "AI_DISABLED",
  // AI_ENABLED is true but no approved provider is registered under the
  // configured name. Deliberately NOT a silent fall back to the mock provider.
  AI_PROVIDER_NOT_AVAILABLE: "AI_PROVIDER_NOT_AVAILABLE",
  // The run completed and produced at least one accepted suggestion.
  SUGGESTIONS_GENERATED: "SUGGESTIONS_GENERATED",
  // The run completed and the provider proposed nothing.
  NO_SUGGESTIONS_RETURNED: "NO_SUGGESTIONS_RETURNED",
  // The run completed and EVERY candidate failed validation. Distinct from
  // NO_SUGGESTIONS_RETURNED: "the model produced only rejects" is a finding
  // about the model, and collapsing the two would hide it.
  ALL_CANDIDATES_REJECTED: "ALL_CANDIDATES_REJECTED",
  // The provider reported a failure, or threw. No suggestion is fabricated.
  PROVIDER_FAILED: "PROVIDER_FAILED",
  // The provider returned something structurally unusable (not an object, no
  // suggestions array, an unrecognised status).
  PROVIDER_MALFORMED_RESULT: "PROVIDER_MALFORMED_RESULT",
});

// Closed vocabulary written into AiSuggestionDecision.outcomeCode.
const DECISION_OUTCOME_CODES = Object.freeze({
  APPROVED_AND_PROMOTED: "APPROVED_AND_PROMOTED",
  // The suggestion's content was already active as a mapping (an analyst had
  // written the same one by hand first). The approval still stands and is still
  // recorded; no second mapping row is created.
  APPROVED_MAPPING_UNCHANGED: "APPROVED_MAPPING_UNCHANGED",
  REJECTED: "REJECTED",
  ALREADY_DECIDED_UNCHANGED: "ALREADY_DECIDED_UNCHANGED",
});

// Closed refusal vocabulary for decision attempts that could not proceed.
const DECISION_REFUSAL_CODES = Object.freeze({
  SUGGESTION_STALE: "SUGGESTION_STALE",
  SUGGESTION_NOT_FOR_CASE: "SUGGESTION_NOT_FOR_CASE",
  SUGGESTION_CONTENT_INVALID: "SUGGESTION_CONTENT_INVALID",
  CASE_NOT_ORGANIZATION_BOUND: "CASE_NOT_ORGANIZATION_BOUND",
});

class AiSuggestionValidationError extends Error {
  constructor(message, fields, code) {
    super(message);
    this.name = "AiSuggestionValidationError";
    this.fields = Array.isArray(fields) ? fields : [];
    this.code = typeof code === "string" ? code : null;
  }
}

class AiSuggestionNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiSuggestionNotFoundError";
  }
}

// A well-formed request the durable state refuses (a stale suggestion, a
// suggestion belonging to another case). Controllers map it to 409.
class AiSuggestionStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AiSuggestionStateError";
    this.code = typeof code === "string" ? code : null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBoundedText(value, { field, maxLength, required }) {
  if (value === undefined || value === null) {
    if (required) throw new AiSuggestionValidationError(`${field} is required`, [field]);
    return null;
  }
  if (typeof value !== "string") {
    throw new AiSuggestionValidationError(`${field} must be a string`, [field]);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    if (required) throw new AiSuggestionValidationError(`${field} is required`, [field]);
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new AiSuggestionValidationError(
      `${field} must be at most ${maxLength} characters`,
      [field]
    );
  }
  return trimmed;
}

function normalizeRequestContext(value) {
  return normalizeBoundedText(value, {
    field: "requestContext",
    maxLength: MAX_REQUEST_CONTEXT_LENGTH,
    required: false,
  });
}

function normalizeDecisionReason(value, { required }) {
  return normalizeBoundedText(value, {
    field: "reason",
    maxLength: MAX_DECISION_REASON_LENGTH,
    required,
  });
}

/**
 * Provider self-reported confidence, 0-100 integer or null.
 *
 * DISPLAY CONTEXT ONLY. Nothing in this repository compares it to a threshold,
 * orders by it, or lets it influence approval, risk or anything else. It is
 * validated purely so a malformed value cannot reach the database.
 */
function normalizeProviderConfidence(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new AiSuggestionValidationError(
      "confidence must be an integer between 0 and 100",
      ["confidence"]
    );
  }
  return value;
}

/**
 * Validates ONE provider candidate and returns storable content, or throws.
 *
 * The framework content is validated by the SAME
 * frameworkMappingRules.normalizeMappingContent an analyst's form input goes
 * through. There is no AI-specific relaxation anywhere: a suggestion that could
 * not have been typed by hand cannot be stored.
 *
 * @param {unknown} raw                    the provider's candidate
 * @param {number[]} allowedFindingIds      Findings CURRENTLY linked to the case
 * @returns {{content:object, providerConfidence:number|null}}
 */
function normalizeSuggestionCandidate(raw, allowedFindingIds) {
  if (!isPlainObject(raw)) {
    throw new AiSuggestionValidationError("suggestion must be an object", []);
  }

  const unexpected = Object.keys(raw).filter((key) => !ALLOWED_CANDIDATE_KEYS.includes(key));
  if (unexpected.length > 0) {
    throw new AiSuggestionValidationError("suggestion carries unexpected fields", unexpected);
  }

  const providerConfidence = normalizeProviderConfidence(raw.confidence);

  let content;
  try {
    content = normalizeMappingContent({
      framework: raw.framework,
      frameworkVersion: raw.frameworkVersion,
      referenceId: raw.referenceId,
      referenceTitle: raw.referenceTitle,
      mappingScope: raw.mappingScope,
      evidenceBasis: raw.evidenceBasis,
      rationale: raw.rationale,
      evidenceFindingId: raw.evidenceFindingId,
    });
  } catch (error) {
    if (error instanceof FrameworkMappingValidationError) {
      // Re-typed, not re-worded: the framework rule's own message and closed
      // code are preserved so a rejection stays explicable, and no provider
      // text is ever interpolated into it.
      throw new AiSuggestionValidationError(error.message, error.fields, error.code);
    }
    throw error;
  }

  // A suggestion citing evidence outside this case is the single most dangerous
  // malformed output a model can produce, because it would silently attach one
  // organization's Finding to another organization's case. Checked here, and
  // checked AGAIN inside the promotion transaction by the mapping service.
  if (
    content.evidenceFindingId !== null &&
    !allowedFindingIds.includes(content.evidenceFindingId)
  ) {
    throw new AiSuggestionValidationError(
      "evidenceFindingId is not a Finding currently linked to this case",
      ["evidenceFindingId"],
      "EVIDENCE_FINDING_NOT_LINKED"
    );
  }

  return { content, providerConfidence };
}

/**
 * Validates a whole provider result and splits it into accepted and rejected.
 *
 * Never throws for a bad candidate — a bad candidate is a RESULT, not an
 * exception, and the count of them is data worth keeping. Throws only when the
 * provider result itself is structurally unusable.
 *
 * @returns {{accepted:Array, rejectedCount:number, truncatedCount:number}}
 */
function partitionProviderCandidates(candidates, allowedFindingIds) {
  if (!Array.isArray(candidates)) {
    throw new AiSuggestionValidationError("provider result suggestions must be an array", []);
  }

  const accepted = [];
  let rejectedCount = 0;

  candidates.forEach((candidate) => {
    if (accepted.length >= MAX_SUGGESTIONS_PER_RUN) return;
    try {
      accepted.push(normalizeSuggestionCandidate(candidate, allowedFindingIds));
    } catch (error) {
      if (error instanceof AiSuggestionValidationError) {
        rejectedCount += 1;
        return;
      }
      throw error;
    }
  });

  const truncatedCount = Math.max(candidates.length - accepted.length - rejectedCount, 0);
  return { accepted, rejectedCount, truncatedCount };
}

/**
 * Decides the run reason code from what actually happened. Derived, never
 * tracked separately, so it cannot drift from the counts beside it.
 */
function resolveRunReasonCode({ acceptedCount, rejectedCount }) {
  if (acceptedCount > 0) return RUN_REASON_CODES.SUGGESTIONS_GENERATED;
  if (rejectedCount > 0) return RUN_REASON_CODES.ALL_CANDIDATES_REJECTED;
  return RUN_REASON_CODES.NO_SUGGESTIONS_RETURNED;
}

module.exports = {
  PROMPT_TEMPLATE_VERSION,
  MAX_SUGGESTIONS_PER_RUN,
  MAX_REQUEST_CONTEXT_LENGTH,
  MAX_DECISION_REASON_LENGTH,
  MAX_PROVIDER_NAME_LENGTH,
  MAX_PROVIDER_MODEL_LENGTH,
  ALLOWED_CANDIDATE_KEYS,
  PROVIDER_RESULT_STATUSES,
  PROVIDER_RESULT_STATUS_VALUES,
  RUN_REASON_CODES,
  DECISION_OUTCOME_CODES,
  DECISION_REFUSAL_CODES,
  AiSuggestionValidationError,
  AiSuggestionNotFoundError,
  AiSuggestionStateError,
  isPlainObject,
  normalizeBoundedText,
  normalizeRequestContext,
  normalizeDecisionReason,
  normalizeProviderConfidence,
  normalizeSuggestionCandidate,
  partitionProviderCandidates,
  resolveRunReasonCode,
  // Re-exported so consumers never need both rule modules for the enum values
  // they validate against.
  FRAMEWORK_FAMILY_VALUES,
  MAPPING_SCOPE_VALUES,
  EVIDENCE_BASIS_VALUES,
};
