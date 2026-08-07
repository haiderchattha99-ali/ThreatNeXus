import { describe, it, expect } from "vitest";

const {
  SUGGESTION_TYPES,
  MAX_PROPOSED_TEXT_LENGTH,
  MAX_REQUEST_CONTEXT_LENGTH,
  EVIDENCE_REFERENCE_FIELDS,
  AiAssistValidationError,
  assertValidSuggestionType,
  normalizeSuggestionContent,
  normalizeRequestContext,
  normalizeDecisionReason,
} = require("../../src/services/aiAssist/aiAssistRules");

describe("assertValidSuggestionType", () => {
  it("accepts SUMMARY and EXPLANATION", () => {
    expect(() => assertValidSuggestionType(SUGGESTION_TYPES.SUMMARY)).not.toThrow();
    expect(() => assertValidSuggestionType(SUGGESTION_TYPES.EXPLANATION)).not.toThrow();
  });

  it("rejects anything else, including a plausible-looking third type", () => {
    expect(() => assertValidSuggestionType("MAPPING")).toThrow(AiAssistValidationError);
    expect(() => assertValidSuggestionType("")).toThrow(AiAssistValidationError);
    expect(() => assertValidSuggestionType(null)).toThrow(AiAssistValidationError);
  });
});

describe("normalizeSuggestionContent — provider output is untrusted input", () => {
  it("accepts a clean result citing real snapshot fields", () => {
    const result = normalizeSuggestionContent({
      text: "A clean draft.",
      evidenceReferences: ["reportType", "riskBand"],
    });
    expect(result.proposedText).toBe("A clean draft.");
    expect(result.evidenceReferences).toEqual(["reportType", "riskBand"]);
  });

  it("deduplicates and deterministically orders evidence references, never trusting provider order", () => {
    const result = normalizeSuggestionContent({
      text: "Draft.",
      evidenceReferences: ["riskBand", "reportType", "riskBand"],
    });
    expect(result.evidenceReferences).toEqual(["reportType", "riskBand"]);
  });

  it("rejects an unexpected top-level field, never dropping it silently", () => {
    expect(() =>
      normalizeSuggestionContent({ text: "Draft.", evidenceReferences: [], autoApprove: true })
    ).toThrow(AiAssistValidationError);
  });

  it("rejects an evidence reference naming a field outside the snapshot's allow-list", () => {
    expect(() =>
      normalizeSuggestionContent({ text: "Draft.", evidenceReferences: ["indicatorValue"] })
    ).toThrow(AiAssistValidationError);
  });

  it("rejects text over the bound rather than truncating it silently", () => {
    expect(() =>
      normalizeSuggestionContent({ text: "x".repeat(MAX_PROPOSED_TEXT_LENGTH + 1), evidenceReferences: [] })
    ).toThrow(AiAssistValidationError);
  });

  it("rejects empty or missing text", () => {
    expect(() => normalizeSuggestionContent({ text: "", evidenceReferences: [] })).toThrow(AiAssistValidationError);
    expect(() => normalizeSuggestionContent({ evidenceReferences: [] })).toThrow(AiAssistValidationError);
  });

  it("rejects a non-array evidenceReferences", () => {
    expect(() => normalizeSuggestionContent({ text: "Draft.", evidenceReferences: "reportType" })).toThrow(
      AiAssistValidationError
    );
  });

  it("rejects a non-object result outright", () => {
    expect(() => normalizeSuggestionContent("not an object")).toThrow(AiAssistValidationError);
    expect(() => normalizeSuggestionContent(null)).toThrow(AiAssistValidationError);
    expect(() => normalizeSuggestionContent(["array"])).toThrow(AiAssistValidationError);
  });

  it("every EVIDENCE_REFERENCE_FIELDS entry is independently acceptable", () => {
    EVIDENCE_REFERENCE_FIELDS.forEach((field) => {
      expect(() => normalizeSuggestionContent({ text: "Draft.", evidenceReferences: [field] })).not.toThrow();
    });
  });
});

describe("normalizeRequestContext / normalizeDecisionReason — bounded, never silently truncated", () => {
  it("accepts null/undefined as absent", () => {
    expect(normalizeRequestContext(undefined)).toBeNull();
    expect(normalizeRequestContext(null)).toBeNull();
  });

  it("rejects text over the bound", () => {
    expect(() => normalizeRequestContext("x".repeat(MAX_REQUEST_CONTEXT_LENGTH + 1))).toThrow(
      AiAssistValidationError
    );
  });

  it("requires a reason when required:true, e.g. rejection", () => {
    expect(() => normalizeDecisionReason(undefined, { required: true })).toThrow(AiAssistValidationError);
    expect(() => normalizeDecisionReason("   ", { required: true })).toThrow(AiAssistValidationError);
    expect(normalizeDecisionReason("Not sufficiently specific.", { required: true })).toBe(
      "Not sufficiently specific."
    );
  });

  it("allows an absent reason when required:false, e.g. acceptance", () => {
    expect(normalizeDecisionReason(undefined, { required: false })).toBeNull();
  });
});
