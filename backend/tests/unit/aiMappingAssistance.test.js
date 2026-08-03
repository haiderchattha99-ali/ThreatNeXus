import { describe, it, expect } from "vitest";

// The pure AI-assistance layer: rules, the disabled provider, the deterministic
// mock, the registry and the runtime.
//
// Nothing here touches a database, a network socket or the wall clock, and
// requiring any of these modules must not need an API key — asserted directly
// below, because "the app starts with AI off" is only true if importing the AI
// layer is inert.

const rules = require("../../src/services/ai/aiSuggestionRules");
const {
  DISABLED_PROVIDER_NAME,
  isAiMappingProvider,
  createDisabledAiMappingProvider,
} = require("../../src/services/ai/aiMappingProvider");
const {
  MOCK_SCENARIOS,
  MOCK_PROVIDER_NAME,
  CLEAN_CSF_CANDIDATE,
  EXPOSURE_ONLY_ATTACK_CANDIDATE,
  UNKNOWN_FIELD_CANDIDATE,
  FOREIGN_EVIDENCE_CANDIDATE,
  createMockAiMappingProvider,
} = require("../../src/services/ai/mockAiMappingProvider");
const {
  resolveAiMappingProvider,
  listRegisteredAiProviderNames,
} = require("../../src/services/ai/aiProviderRegistry");
const { buildAiRuntime, normalizeProviderName } = require("../../src/services/ai/aiRuntime");

const {
  MAX_SUGGESTIONS_PER_RUN,
  RUN_REASON_CODES,
  ALLOWED_CANDIDATE_KEYS,
  AiSuggestionValidationError,
  normalizeSuggestionCandidate,
  partitionProviderCandidates,
  resolveRunReasonCode,
  normalizeProviderConfidence,
  normalizeDecisionReason,
} = rules;

const AS_OF = new Date("2026-08-04T10:00:00.000Z");
const LINKED = [11, 12];

describe("provider contract", () => {
  it("recognises a conforming provider and refuses a malformed one", () => {
    expect(isAiMappingProvider(createDisabledAiMappingProvider())).toBe(true);
    expect(isAiMappingProvider(null)).toBe(false);
    expect(isAiMappingProvider({ name: "x", isEnabled: false })).toBe(false);
    expect(isAiMappingProvider({ name: "", isEnabled: false, suggestMappings() {} })).toBe(false);
  });

  // A provider must never read the wall clock — every result has to be
  // reproducible from its inputs. A missing asOf is a programmer error and is
  // the ONE thing a provider is allowed to throw for.
  it("throws TypeError when asOf is missing or invalid", async () => {
    const provider = createDisabledAiMappingProvider();
    await expect(provider.suggestMappings({})).rejects.toThrow(TypeError);
    await expect(provider.suggestMappings({ asOf: "2026-08-04" })).rejects.toThrow(TypeError);
    await expect(provider.suggestMappings({ asOf: new Date("nope") })).rejects.toThrow(TypeError);
  });
});

describe("disabled provider", () => {
  it("reports DISABLED, proposes nothing and declares no model", async () => {
    const provider = createDisabledAiMappingProvider();
    const result = await provider.suggestMappings({ snapshot: { anything: true }, asOf: AS_OF });
    expect(result.status).toBe("DISABLED");
    expect(result.suggestions).toEqual([]);
    expect(result.model).toBeNull();
    expect(provider.isEnabled).toBe(false);
  });

  // The surface is the safety control: there is nothing on it to call.
  it("exposes no method beyond the contract", () => {
    const provider = createDisabledAiMappingProvider();
    expect(Object.keys(provider).sort()).toEqual(["isEnabled", "model", "name", "suggestMappings"]);
  });
});

describe("mock provider", () => {
  it("is deterministic across calls", async () => {
    const provider = createMockAiMappingProvider({ scenario: MOCK_SCENARIOS.VALID_CONTROL_MAPPINGS });
    const first = await provider.suggestMappings({ snapshot: {}, asOf: AS_OF });
    const second = await provider.suggestMappings({ snapshot: {}, asOf: AS_OF });
    expect(first.suggestions).toEqual(second.suggestions);
    expect(provider.getCallCount()).toBe(2);
  });

  it("cannot be steered by mutating the config object after construction", async () => {
    const config = { scenario: MOCK_SCENARIOS.VALID_CONTROL_MAPPINGS };
    const provider = createMockAiMappingProvider(config);
    config.scenario = MOCK_SCENARIOS.ALL_INVALID;
    const result = await provider.suggestMappings({ snapshot: {}, asOf: AS_OF });
    expect(result.suggestions[0].referenceId).toBe(CLEAN_CSF_CANDIDATE.referenceId);
  });

  it("cannot be steered by mutating a returned candidate", async () => {
    const provider = createMockAiMappingProvider({ scenario: MOCK_SCENARIOS.VALID_CONTROL_MAPPINGS });
    const first = await provider.suggestMappings({ snapshot: {}, asOf: AS_OF });
    first.suggestions[0].referenceId = "TAMPERED";
    const second = await provider.suggestMappings({ snapshot: {}, asOf: AS_OF });
    expect(second.suggestions[0].referenceId).toBe(CLEAN_CSF_CANDIDATE.referenceId);
  });

  // A mock that only ever returned clean output would make every gate test
  // pass whether or not the gates existed.
  it("deliberately emits invalid candidates", async () => {
    const provider = createMockAiMappingProvider({ scenario: MOCK_SCENARIOS.ALL_INVALID });
    const result = await provider.suggestMappings({ snapshot: {}, asOf: AS_OF });
    const partition = partitionProviderCandidates(result.suggestions, LINKED);
    expect(partition.accepted).toHaveLength(0);
    expect(partition.rejectedCount).toBe(result.suggestions.length);
  });
});

describe("provider registry", () => {
  it("always resolves the disabled provider", () => {
    expect(resolveAiMappingProvider(DISABLED_PROVIDER_NAME, {}).name).toBe(DISABLED_PROVIDER_NAME);
  });

  // The single most important registry assertion in this phase.
  it("NEVER resolves the mock provider without an explicit opt-in", () => {
    expect(resolveAiMappingProvider(MOCK_PROVIDER_NAME, {})).toBeNull();
    expect(resolveAiMappingProvider(MOCK_PROVIDER_NAME)).toBeNull();
    expect(resolveAiMappingProvider(MOCK_PROVIDER_NAME, { allowMockProvider: false })).toBeNull();
    expect(
      resolveAiMappingProvider(MOCK_PROVIDER_NAME, { allowMockProvider: true }).name
    ).toBe(MOCK_PROVIDER_NAME);
  });

  it("returns null for unknown names rather than substituting anything", () => {
    ["", "MOCK", "gpt-5", "anthropic", "ollama", null, undefined, 7].forEach((name) => {
      expect(resolveAiMappingProvider(name, { allowMockProvider: true })).toBeNull();
    });
  });

  // Without the hasOwnProperty guard these would resolve to inherited Object
  // functions.
  it("refuses prototype-chain lookups", () => {
    ["constructor", "toString", "hasOwnProperty", "__proto__"].forEach((name) => {
      expect(resolveAiMappingProvider(name, { allowMockProvider: true })).toBeNull();
    });
  });

  it("lists only what the caller could actually resolve", () => {
    expect(listRegisteredAiProviderNames()).toEqual([DISABLED_PROVIDER_NAME]);
    expect(listRegisteredAiProviderNames({ allowMockProvider: true })).toEqual([
      DISABLED_PROVIDER_NAME,
      MOCK_PROVIDER_NAME,
    ]);
  });

  it("hands out a fresh instance per resolution", async () => {
    const a = resolveAiMappingProvider(MOCK_PROVIDER_NAME, { allowMockProvider: true });
    const b = resolveAiMappingProvider(MOCK_PROVIDER_NAME, { allowMockProvider: true });
    await a.suggestMappings({ snapshot: {}, asOf: AS_OF });
    expect(a.getCallCount()).toBe(1);
    expect(b.getCallCount()).toBe(0);
  });
});

describe("runtime", () => {
  const offEnv = { AI_ENABLED: false, AI_PROVIDER: "null" };

  it("is disabled by default and resolves the disabled provider", () => {
    const runtime = buildAiRuntime({ env: offEnv });
    expect(runtime.aiEnabled).toBe(false);
    expect(runtime.assistanceAvailable).toBe(false);
    expect(runtime.providerName).toBe(DISABLED_PROVIDER_NAME);
    expect(runtime.reasonCode).toBe(RUN_REASON_CODES.AI_DISABLED);
  });

  // A stale provider name left in the environment must not cause a call once
  // the kill switch is off.
  it("ignores AI_PROVIDER entirely when AI is off", () => {
    const runtime = buildAiRuntime({
      env: { AI_ENABLED: false, AI_PROVIDER: "mock" },
      allowMockProvider: true,
    });
    expect(runtime.providerName).toBe(DISABLED_PROVIDER_NAME);
    expect(runtime.reasonCode).toBe(RUN_REASON_CODES.AI_DISABLED);
  });

  // The whole "no silent fallback" requirement, at the runtime level.
  it("reports AI_PROVIDER_NOT_AVAILABLE rather than falling back to mock", () => {
    const runtime = buildAiRuntime({ env: { AI_ENABLED: true, AI_PROVIDER: "mock" } });
    expect(runtime.aiEnabled).toBe(true);
    expect(runtime.assistanceAvailable).toBe(false);
    expect(runtime.providerName).toBe(DISABLED_PROVIDER_NAME);
    expect(runtime.reasonCode).toBe(RUN_REASON_CODES.AI_PROVIDER_NOT_AVAILABLE);
  });

  it("distinguishes 'operator asked for it' from 'the system can do it'", () => {
    const runtime = buildAiRuntime({ env: { AI_ENABLED: true, AI_PROVIDER: "some-future-model" } });
    expect(runtime.aiEnabled).toBe(true);
    expect(runtime.assistanceAvailable).toBe(false);
  });

  it("treats null/none/off as explicitly disabled, not as unknown names", () => {
    ["null", "none", "off", "DISABLED", "  Null  ", ""].forEach((value) => {
      expect(normalizeProviderName(value)).toBe(DISABLED_PROVIDER_NAME);
    });
    expect(normalizeProviderName("mock")).toBe("mock");
  });

  it("becomes available only with an explicit test opt-in", () => {
    const runtime = buildAiRuntime({
      env: { AI_ENABLED: true, AI_PROVIDER: "mock" },
      allowMockProvider: true,
    });
    expect(runtime.assistanceAvailable).toBe(true);
    expect(runtime.providerName).toBe(MOCK_PROVIDER_NAME);
    expect(runtime.reasonCode).toBeNull();
  });

  // describe() is what the /api/ai/config route returns.
  it("describes configuration without exposing any credential-shaped value", () => {
    const described = buildAiRuntime({ env: offEnv }).describe();
    expect(described).toHaveProperty("aiEnabled");
    expect(described).toHaveProperty("providerName");
    expect(described).toHaveProperty("promptTemplateVersion");
    const blob = JSON.stringify(described).toLowerCase();
    ["key", "token", "secret", "password", "authorization", "http://", "https://"].forEach(
      (needle) => {
        expect(blob).not.toContain(needle);
      }
    );
  });
});

describe("untrusted output validation", () => {
  it("accepts a well-formed candidate", () => {
    const { content, providerConfidence } = normalizeSuggestionCandidate(
      CLEAN_CSF_CANDIDATE,
      LINKED
    );
    expect(content.framework).toBe("NIST_CSF");
    expect(providerConfidence).toBe(CLEAN_CSF_CANDIDATE.confidence);
  });

  // Rejected, never dropped: a silently ignored field is how a model discovers
  // an internal column, and how a future refactor leaks one.
  it("rejects unknown fields rather than dropping them", () => {
    let thrown;
    try {
      normalizeSuggestionCandidate(UNKNOWN_FIELD_CANDIDATE, LINKED);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AiSuggestionValidationError);
    expect(thrown.fields).toContain("autoApprove");
    expect(ALLOWED_CANDIDATE_KEYS).not.toContain("autoApprove");
  });

  it("refuses provenance and state fields a provider must never set", () => {
    ["state", "source", "actorUserId", "promotedMappingId", "inputFingerprint", "caseId"].forEach(
      (key) => {
        expect(() =>
          normalizeSuggestionCandidate({ ...CLEAN_CSF_CANDIDATE, [key]: 1 }, LINKED)
        ).toThrow(AiSuggestionValidationError);
      }
    );
  });

  // Held to exactly the same standard as a hand-typed mapping.
  it("applies the MITRE ATT&CK evidence rule to provider output", () => {
    expect(() => normalizeSuggestionCandidate(EXPOSURE_ONLY_ATTACK_CANDIDATE, LINKED)).toThrow(
      AiSuggestionValidationError
    );
  });

  // The most dangerous malformed output a model can produce.
  it("refuses a candidate citing a Finding outside this case", () => {
    let thrown;
    try {
      normalizeSuggestionCandidate(FOREIGN_EVIDENCE_CANDIDATE, LINKED);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AiSuggestionValidationError);
    expect(thrown.code).toBe("EVIDENCE_FINDING_NOT_LINKED");
  });

  it("validates provider confidence without ever letting it decide anything", () => {
    expect(normalizeProviderConfidence(undefined)).toBeNull();
    expect(normalizeProviderConfidence(0)).toBe(0);
    expect(normalizeProviderConfidence(100)).toBe(100);
    [-1, 101, 1.5, "80", true].forEach((value) => {
      expect(() => normalizeProviderConfidence(value)).toThrow(AiSuggestionValidationError);
    });
  });

  it("never repairs a bad candidate — it discards and counts it", () => {
    const partition = partitionProviderCandidates(
      [CLEAN_CSF_CANDIDATE, EXPOSURE_ONLY_ATTACK_CANDIDATE, UNKNOWN_FIELD_CANDIDATE],
      LINKED
    );
    expect(partition.accepted).toHaveLength(1);
    expect(partition.rejectedCount).toBe(2);
    expect(partition.accepted[0].content.referenceId).toBe(CLEAN_CSF_CANDIDATE.referenceId);
  });

  it("caps the number of accepted suggestions per run", () => {
    const many = Array.from({ length: MAX_SUGGESTIONS_PER_RUN + 4 }, (_unused, index) => ({
      ...CLEAN_CSF_CANDIDATE,
      referenceId: `PR.AA-0${(index % 9) + 1}`,
    }));
    const partition = partitionProviderCandidates(many, LINKED);
    expect(partition.accepted).toHaveLength(MAX_SUGGESTIONS_PER_RUN);
    expect(partition.truncatedCount).toBe(4);
  });

  it("treats a non-array suggestions field as structurally unusable", () => {
    expect(() => partitionProviderCandidates("not-an-array", LINKED)).toThrow(
      AiSuggestionValidationError
    );
    expect(() => partitionProviderCandidates(null, LINKED)).toThrow(AiSuggestionValidationError);
  });

  // "The model produced only rejects" is a finding about the model. Collapsing
  // it into "nothing was returned" would hide it.
  it("distinguishes nothing-returned from everything-rejected", () => {
    expect(resolveRunReasonCode({ acceptedCount: 2, rejectedCount: 1 })).toBe(
      RUN_REASON_CODES.SUGGESTIONS_GENERATED
    );
    expect(resolveRunReasonCode({ acceptedCount: 0, rejectedCount: 3 })).toBe(
      RUN_REASON_CODES.ALL_CANDIDATES_REJECTED
    );
    expect(resolveRunReasonCode({ acceptedCount: 0, rejectedCount: 0 })).toBe(
      RUN_REASON_CODES.NO_SUGGESTIONS_RETURNED
    );
  });
});

describe("decision reason bounds", () => {
  it("requires a reason when the caller says one is required", () => {
    expect(() => normalizeDecisionReason(undefined, { required: true })).toThrow(
      AiSuggestionValidationError
    );
    expect(() => normalizeDecisionReason("   ", { required: true })).toThrow(
      AiSuggestionValidationError
    );
    expect(normalizeDecisionReason(undefined, { required: false })).toBeNull();
  });

  it("refuses an over-length reason rather than truncating it", () => {
    expect(() => normalizeDecisionReason("x".repeat(1001), { required: true })).toThrow(
      AiSuggestionValidationError
    );
    expect(normalizeDecisionReason(" fine ", { required: true })).toBe("fine");
  });
});
