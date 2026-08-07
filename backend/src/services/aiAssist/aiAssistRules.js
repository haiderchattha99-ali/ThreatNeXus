"use strict";

// Pure, dependency-free rules for Phase 8C Finding-level AI assistance
// (summary / explanation drafts).
//
// No Prisma, no wall clock, no HTTP, no network, no provider. Importing this
// module cannot make a request, cannot read a key, and cannot start anything.
// Mirrors services/ai/aiSuggestionRules.js exactly in spirit: AI output is
// untrusted input, validated the same way a request body from an anonymous
// client would be.

const PROMPT_TEMPLATE_VERSION = "finding-ai-suggestion-v1";

// Bounds on analyst-supplied and provider-supplied text.
const MAX_REQUEST_CONTEXT_LENGTH = 1000;
const MAX_DECISION_REASON_LENGTH = 1000;
const MAX_PROPOSED_TEXT_LENGTH = 4000;
const MAX_PROVIDER_NAME_LENGTH = 64;
const MAX_PROVIDER_MODEL_LENGTH = 128;

// The two suggestion types this MVP supports. A third type goes through a
// migration and a code change, never a caller-supplied string.
const SUGGESTION_TYPES = Object.freeze({
  SUMMARY: "SUMMARY",
  EXPLANATION: "EXPLANATION",
});
const SUGGESTION_TYPE_VALUES = Object.freeze(Object.values(SUGGESTION_TYPES));

const SUGGESTION_STATUSES = Object.freeze({
  DRAFT: "DRAFT",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
});

// The closed set of snapshot fields a provider may cite as the evidence it
// used. Not a free-text citation a provider could fabricate — a candidate
// naming anything outside this list is discarded, exactly like an unknown
// field on a Phase 5 mapping candidate.
const EVIDENCE_REFERENCE_FIELDS = Object.freeze([
  "reportType",
  "triageDecision",
  "riskBand",
  "riskExplanation",
  "analystVerifiedCveIds",
  "requestContext",
]);

const MAX_EVIDENCE_REFERENCES = EVIDENCE_REFERENCE_FIELDS.length;

// Provider result statuses. A closed set — a provider returning anything else
// is treated as a failure, never guessed at.
const PROVIDER_RESULT_STATUSES = Object.freeze({
  DISABLED: "DISABLED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
});

// Closed machine-readable vocabulary written into FindingAiSuggestion.reasonCode.
// Never free text, never an exception message, never a provider error string.
const SUGGESTION_REASON_CODES = Object.freeze({
  AI_DISABLED: "AI_DISABLED",
  AI_PROVIDER_NOT_AVAILABLE: "AI_PROVIDER_NOT_AVAILABLE",
  SUGGESTION_GENERATED: "SUGGESTION_GENERATED",
  PROVIDER_FAILED: "PROVIDER_FAILED",
  PROVIDER_MALFORMED_RESULT: "PROVIDER_MALFORMED_RESULT",
});

// Closed vocabulary written into FindingAiSuggestion decision outcomes
// (returned by the API, never persisted as free text).
const DECISION_OUTCOME_CODES = Object.freeze({
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  ALREADY_DECIDED_UNCHANGED: "ALREADY_DECIDED_UNCHANGED",
  EXPIRED_ON_ACCEPT: "EXPIRED_ON_ACCEPT",
});

// Closed refusal vocabulary for decision attempts that could not proceed.
const DECISION_REFUSAL_CODES = Object.freeze({
  SUGGESTION_STALE: "SUGGESTION_STALE",
  SUGGESTION_NOT_FOR_FINDING: "SUGGESTION_NOT_FOR_FINDING",
});

class AiAssistValidationError extends Error {
  constructor(message, fields, code) {
    super(message);
    this.name = "AiAssistValidationError";
    this.fields = Array.isArray(fields) ? fields : [];
    this.code = typeof code === "string" ? code : null;
  }
}

class AiAssistNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiAssistNotFoundError";
  }
}

// A well-formed request the durable state refuses (a stale suggestion, one
// belonging to another Finding). Controllers map it to 409.
class AiAssistStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AiAssistStateError";
    this.code = typeof code === "string" ? code : null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBoundedText(value, { field, maxLength, required }) {
  if (value === undefined || value === null) {
    if (required) throw new AiAssistValidationError(`${field} is required`, [field]);
    return null;
  }
  if (typeof value !== "string") {
    throw new AiAssistValidationError(`${field} must be a string`, [field]);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    if (required) throw new AiAssistValidationError(`${field} is required`, [field]);
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new AiAssistValidationError(`${field} must be at most ${maxLength} characters`, [field]);
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
  return normalizeBoundedText(value, { field: "reason", maxLength: MAX_DECISION_REASON_LENGTH, required });
}

function isValidSuggestionType(value) {
  return typeof value === "string" && SUGGESTION_TYPE_VALUES.includes(value);
}

function assertValidSuggestionType(value) {
  if (!isValidSuggestionType(value)) {
    throw new AiAssistValidationError(
      `suggestionType must be one of ${SUGGESTION_TYPE_VALUES.join(", ")}`,
      ["suggestionType"]
    );
  }
  return value;
}

/**
 * Validates ONE provider candidate result and returns storable content, or
 * throws. Provider output is untrusted input: unknown keys are rejected, not
 * dropped, and every value is type-and-bound checked — no relaxation just
 * because the source is a model rather than an HTTP caller.
 *
 * @param {unknown} raw   the provider's proposed result
 * @returns {{proposedText:string, evidenceReferences:string[]}}
 */
function normalizeSuggestionContent(raw) {
  if (!isPlainObject(raw)) {
    throw new AiAssistValidationError("provider result must be an object", []);
  }

  const allowedKeys = ["text", "evidenceReferences"];
  const unexpected = Object.keys(raw).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    throw new AiAssistValidationError("provider result carries unexpected fields", unexpected);
  }

  const proposedText = normalizeBoundedText(raw.text, {
    field: "text",
    maxLength: MAX_PROPOSED_TEXT_LENGTH,
    required: true,
  });

  if (!Array.isArray(raw.evidenceReferences)) {
    throw new AiAssistValidationError("evidenceReferences must be an array", ["evidenceReferences"]);
  }
  if (raw.evidenceReferences.length > MAX_EVIDENCE_REFERENCES) {
    throw new AiAssistValidationError(
      `evidenceReferences must have at most ${MAX_EVIDENCE_REFERENCES} entries`,
      ["evidenceReferences"]
    );
  }
  const invalidRef = raw.evidenceReferences.find(
    (entry) => typeof entry !== "string" || !EVIDENCE_REFERENCE_FIELDS.includes(entry)
  );
  if (invalidRef !== undefined) {
    throw new AiAssistValidationError(
      "evidenceReferences must only name fields present in the Finding snapshot",
      ["evidenceReferences"]
    );
  }
  // Deduplicated, deterministically ordered — never trusts provider ordering.
  const evidenceReferences = EVIDENCE_REFERENCE_FIELDS.filter((field) =>
    raw.evidenceReferences.includes(field)
  );

  return { proposedText, evidenceReferences };
}

function boundedModelName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, MAX_PROVIDER_MODEL_LENGTH);
}

module.exports = {
  PROMPT_TEMPLATE_VERSION,
  MAX_REQUEST_CONTEXT_LENGTH,
  MAX_DECISION_REASON_LENGTH,
  MAX_PROPOSED_TEXT_LENGTH,
  MAX_PROVIDER_NAME_LENGTH,
  MAX_PROVIDER_MODEL_LENGTH,
  MAX_EVIDENCE_REFERENCES,
  SUGGESTION_TYPES,
  SUGGESTION_TYPE_VALUES,
  SUGGESTION_STATUSES,
  EVIDENCE_REFERENCE_FIELDS,
  PROVIDER_RESULT_STATUSES,
  SUGGESTION_REASON_CODES,
  DECISION_OUTCOME_CODES,
  DECISION_REFUSAL_CODES,
  AiAssistValidationError,
  AiAssistNotFoundError,
  AiAssistStateError,
  isPlainObject,
  normalizeBoundedText,
  normalizeRequestContext,
  normalizeDecisionReason,
  isValidSuggestionType,
  assertValidSuggestionType,
  normalizeSuggestionContent,
  boundedModelName,
};
