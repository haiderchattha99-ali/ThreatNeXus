import { describe, it, expect } from "vitest";

// Proves the Phase 5 serializer exclusions against REAL row shapes rather than
// merely asserting them in a comment.
//
// The rows below are deliberately built as "everything a row could ever carry",
// including columns that exist on the model and internal values that must never
// leave the server. If a serializer ever switched from constructing a fresh
// object to spreading the row, these tests fail.

const {
  serializeMapping,
  serializeMappingGroups,
  serializeSuggestion,
  serializeRun,
  serializeDecision,
  serializeAiConfigState,
} = require("../../src/services/framework/frameworkMappingSerializers");

const FINGERPRINT = "b3a1c0de".repeat(8);

const MAPPING_ROW = Object.freeze({
  id: 5,
  caseId: 3,
  organizationId: 2,
  framework: "NIST_CSF",
  frameworkVersion: "2.0",
  referenceId: "PR.AA-05",
  referenceTitle: "Access permissions are defined and managed",
  mappingScope: "CASE",
  evidenceBasis: "CONTROL_GAP",
  rationale: "Administrative access is reachable from any network.",
  evidenceFindingId: null,
  state: "ACTIVE",
  source: "MANUAL",
  actorUserId: 9,
  effectiveAt: new Date("2026-08-04T10:00:00.000Z"),
  supersededAt: null,
  createdAt: new Date("2026-08-04T10:00:00.000Z"),
  // MUST NEVER be emitted — the internal uniqueness mechanism.
  currentMappingKey: "3:NIST_CSF:CASE:PR.AA-05",
});

const SUGGESTION_ROW = Object.freeze({
  id: 11,
  runId: 4,
  caseId: 3,
  framework: "CIS_CONTROLS",
  frameworkVersion: "v8",
  referenceId: "4.6",
  referenceTitle: "Securely Manage Enterprise Assets and Software",
  mappingScope: "CASE",
  evidenceBasis: "REMEDIATION_ALIGNMENT",
  rationale: "Remediation aligns with secure asset management.",
  evidenceFindingId: null,
  providerConfidence: 62,
  state: "PENDING",
  decidedAt: null,
  decidedByUserId: null,
  decisionReason: null,
  promotedMappingId: null,
  createdAt: new Date("2026-08-04T10:00:00.000Z"),
  // MUST NEVER be emitted — the staleness mechanism.
  inputFingerprint: FINGERPRINT,
});

const RUN_ROW = Object.freeze({
  id: 4,
  caseId: 3,
  organizationId: 2,
  status: "COMPLETED",
  providerName: "mock",
  providerModel: "mock-deterministic-v1",
  promptTemplateVersion: "framework-mapping-suggestion-v1",
  suggestionCount: 1,
  rejectedCount: 3,
  reasonCode: "SUGGESTIONS_GENERATED",
  requestContext: "focus on access control",
  actorUserId: 9,
  requestedAt: new Date("2026-08-04T10:00:00.000Z"),
  completedAt: new Date("2026-08-04T10:00:00.000Z"),
  createdAt: new Date("2026-08-04T10:00:00.000Z"),
  inputFingerprint: FINGERPRINT,
});

const ACTOR_ROW = Object.freeze({
  id: 9,
  name: "A. Analyst",
  role: "ANALYST",
  // MUST NEVER be emitted — a mapping list is readable by VIEWER.
  email: "analyst@example.test",
  password: "$2b$10$hash",
});

describe("mapping serializer", () => {
  it("never emits the current-row key", () => {
    const out = serializeMapping(MAPPING_ROW);
    expect(out).not.toHaveProperty("currentMappingKey");
    expect(JSON.stringify(out)).not.toContain("3:NIST_CSF:CASE:PR.AA-05");
  });

  // isCurrent conveys the same fact without exposing the mechanism.
  it("conveys currency as a boolean instead", () => {
    expect(serializeMapping(MAPPING_ROW).isCurrent).toBe(true);
    expect(
      serializeMapping({ ...MAPPING_ROW, supersededAt: new Date() }).isCurrent
    ).toBe(false);
  });

  // The honest answer: this phase pins no catalogue, so nothing is verified to
  // exist. Emitting the field (rather than omitting it) means a future
  // catalogue can flip it and every consumer already renders the distinction.
  it("always declares that references are unvalidated", () => {
    expect(serializeMapping(MAPPING_ROW).referenceValidated).toBe(false);
    expect(serializeSuggestion(SUGGESTION_ROW).referenceValidated).toBe(false);
  });

  it("reduces an actor to id, name and role", () => {
    const out = serializeMapping({ ...MAPPING_ROW, actor: ACTOR_ROW });
    expect(out.actor).toEqual({ id: 9, name: "A. Analyst", role: "ANALYST" });
    expect(JSON.stringify(out)).not.toContain("analyst@example.test");
    expect(JSON.stringify(out)).not.toContain("$2b$10$");
  });

  it("does not leak a column added by a future migration", () => {
    const out = serializeMapping({ ...MAPPING_ROW, secretFutureColumn: "should-not-appear" });
    expect(JSON.stringify(out)).not.toContain("should-not-appear");
  });
});

describe("mapping groups", () => {
  it("labels the count as a mapping count and never as coverage", () => {
    const groups = serializeMappingGroups([
      MAPPING_ROW,
      { ...MAPPING_ROW, id: 6, referenceId: "PR.AA-06" },
      { ...MAPPING_ROW, id: 7, framework: "CIS_CONTROLS", referenceId: "4.6" },
    ]);

    const csf = groups.find((group) => group.framework === "NIST_CSF");
    expect(csf.count).toBe(2);
    expect(csf.countMeaning).toBe("MAPPING_COUNT_NOT_COVERAGE");
  });

  // There is no denominator anywhere in this phase, so there can be no
  // percentage. A "62% mapped" figure would require knowing how many references
  // SHOULD apply, which nobody knows.
  it("emits no percentage, ratio or coverage figure of any kind", () => {
    const groups = serializeMappingGroups([MAPPING_ROW]);

    // Asserted on the KEY NAMES, not on a substring search of the payload: the
    // analyst-authored `rationale` legitimately contains the letters "ratio",
    // and a naive substring check would fail on correct behaviour. (It did,
    // which is how this comment came to exist.)
    const groupKeys = Object.keys(groups[0]);
    expect(groupKeys.sort()).toEqual(["count", "countMeaning", "framework", "mappings"]);

    [
      "percentage",
      "percent",
      "coveragePercent",
      "mappedPercent",
      "ratioMapped",
      "totalPossible",
      "denominator",
      "score",
      "maturity",
    ].forEach((forbiddenKey) => {
      expect(groupKeys).not.toContain(forbiddenKey);
    });

    // The ONLY number a group carries is a count of rows, and it travels with
    // a label saying so.
    expect(typeof groups[0].count).toBe("number");
    expect(groups[0].countMeaning).toBe("MAPPING_COUNT_NOT_COVERAGE");
  });
});

describe("suggestion serializer", () => {
  it("never emits the input fingerprint", () => {
    const out = serializeSuggestion(SUGGESTION_ROW);
    expect(out).not.toHaveProperty("inputFingerprint");
    expect(JSON.stringify(out)).not.toContain(FINGERPRINT);
  });

  // Provider self-report travels with a label so a UI cannot render it as a
  // system assessment.
  it("labels provider confidence as provider self-report", () => {
    const out = serializeSuggestion(SUGGESTION_ROW);
    expect(out.providerConfidence).toBe(62);
    expect(out.providerConfidenceMeaning).toBe("PROVIDER_SELF_REPORTED_NOT_SYSTEM_ASSESSED");
  });

  it("does not leak a column added by a future migration", () => {
    const out = serializeSuggestion({ ...SUGGESTION_ROW, rawModelResponse: "should-not-appear" });
    expect(JSON.stringify(out)).not.toContain("should-not-appear");
  });
});

describe("run serializer", () => {
  it("emits provenance but never the fingerprint", () => {
    const out = serializeRun(RUN_ROW);
    expect(out.promptTemplateVersion).toBe("framework-mapping-suggestion-v1");
    expect(out.providerName).toBe("mock");
    expect(out).not.toHaveProperty("inputFingerprint");
    expect(JSON.stringify(out)).not.toContain(FINGERPRINT);
  });

  // There is no prompt text, no snapshot and no raw response persisted anywhere
  // to emit — this asserts the serializer does not invent one either.
  it("emits no prompt, snapshot or raw response field", () => {
    const out = serializeRun(RUN_ROW);
    ["prompt", "snapshot", "rawResponse", "messages", "systemPrompt", "input"].forEach((key) => {
      expect(out).not.toHaveProperty(key);
    });
  });
});

describe("decision serializer", () => {
  it("emits the closed outcome code and the actor, nothing internal", () => {
    const out = serializeDecision({
      id: 2,
      suggestionId: 11,
      decision: "REJECT",
      outcomeCode: "REJECTED",
      reason: "not applicable to this case",
      actorUserId: 9,
      actor: ACTOR_ROW,
      decidedAt: new Date("2026-08-04T11:00:00.000Z"),
      createdAt: new Date("2026-08-04T11:00:00.000Z"),
      internalNote: "should-not-appear",
    });
    expect(out.outcomeCode).toBe("REJECTED");
    expect(out.actor).toEqual({ id: 9, name: "A. Analyst", role: "ANALYST" });
    expect(JSON.stringify(out)).not.toContain("should-not-appear");
    expect(JSON.stringify(out)).not.toContain("analyst@example.test");
  });
});

describe("AI configuration serializer", () => {
  it("emits booleans, a provider name and a template version only", () => {
    const out = serializeAiConfigState({
      aiEnabled: false,
      assistanceAvailable: false,
      providerName: "disabled",
      promptTemplateVersion: "framework-mapping-suggestion-v1",
      reasonCode: "AI_DISABLED",
      maxSuggestionsPerRun: 5,
      disclaimer: "Framework mappings record analyst-associated context only.",
      // Everything below must be dropped: none of it is stored in a form the
      // route could reach, and the serializer must not become the place that
      // starts forwarding it.
      apiKey: "sk-should-not-appear",
      baseUrl: "https://api.example.invalid",
      timeoutMs: 8000,
      temperature: 0.7,
    });

    expect(out).toEqual({
      aiEnabled: false,
      assistanceAvailable: false,
      providerName: "disabled",
      promptTemplateVersion: "framework-mapping-suggestion-v1",
      reasonCode: "AI_DISABLED",
      maxSuggestionsPerRun: 5,
      disclaimer: "Framework mappings record analyst-associated context only.",
    });
    const blob = JSON.stringify(out);
    expect(blob).not.toContain("sk-should-not-appear");
    expect(blob).not.toContain("api.example.invalid");
    expect(blob).not.toContain("temperature");
  });

  // Reporting only one of these would show an operator a green light over a
  // provider that does not exist.
  it("keeps 'operator asked for it' separate from 'the system can do it'", () => {
    const out = serializeAiConfigState({
      aiEnabled: true,
      assistanceAvailable: false,
      providerName: "disabled",
      promptTemplateVersion: "v1",
      reasonCode: "AI_PROVIDER_NOT_AVAILABLE",
      maxSuggestionsPerRun: 5,
      disclaimer: "x",
    });
    expect(out.aiEnabled).toBe(true);
    expect(out.assistanceAvailable).toBe(false);
  });
});
