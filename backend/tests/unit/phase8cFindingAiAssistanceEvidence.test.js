import { describe, it, expect } from "vitest";

// Phase 8C evidence collection, mirroring the shape of
// tests/unit/phase8bCensysProviderEvidence.test.js: the explicit, named
// assertions for this ticket's safety claims, gathered in one place.
//
// There is no live AI provider anywhere in this repository (same as Phase 5)
// — that is a deliberate, documented boundary, not a gap this ticket closes.
// Consequently there is no live smoke script for this phase either: an
// opt-in smoke script would have nothing real to call.

const {
  buildAiAssistRuntime,
  normalizeProviderName,
} = require("../../src/services/aiAssist/aiAssistRuntime");
const {
  resolveAiAssistProvider,
  listRegisteredAiAssistProviderNames,
} = require("../../src/services/aiAssist/aiAssistProviderRegistry");
const { SUGGESTION_REASON_CODES, PROVIDER_RESULT_STATUSES } = require("../../src/services/aiAssist/aiAssistRules");

describe("startup safety — no key required, disabled by default", () => {
  it("AI_ENABLED=false resolves the disabled provider regardless of AI_PROVIDER", () => {
    const runtime = buildAiAssistRuntime({
      env: { AI_ENABLED: false, AI_PROVIDER: "mock" },
    });
    expect(runtime.aiEnabled).toBe(false);
    expect(runtime.assistanceAvailable).toBe(false);
    expect(runtime.providerName).toBe("disabled");
    expect(runtime.reasonCode).toBe("AI_DISABLED");
  });

  it("importing every aiAssist module requires no environment variable and makes no call", () => {
    expect(() => {
      require("../../src/services/aiAssist/aiAssistRules");
      require("../../src/services/aiAssist/aiAssistProvider");
      require("../../src/services/aiAssist/mockAiAssistProvider");
      require("../../src/services/aiAssist/aiAssistProviderRegistry");
      require("../../src/services/aiAssist/aiAssistRuntime");
      require("../../src/services/aiAssist/findingEvidenceSnapshot");
      require("../../src/services/aiAssist/findingAiSuggestionService");
      require("../../src/services/aiAssist/findingAiSuggestionDecisionService");
    }).not.toThrow();
  });
});

describe("registry isolation — no silent fallback from production to mock", () => {
  it("AI_ENABLED=true with an unregistered provider name never falls back to mock", () => {
    const runtime = buildAiAssistRuntime({
      env: { AI_ENABLED: true, AI_PROVIDER: "some-future-live-provider" },
    });
    expect(runtime.assistanceAvailable).toBe(false);
    expect(runtime.providerName).toBe("disabled");
    expect(runtime.reasonCode).toBe("AI_PROVIDER_NOT_AVAILABLE");
  });

  it("AI_ENABLED=true with AI_PROVIDER=mock still resolves to disabled WITHOUT the test-only opt-in", () => {
    // This is the exact production composition path: no caller anywhere in
    // src/ ever passes allowMockProvider: true.
    const runtime = buildAiAssistRuntime({ env: { AI_ENABLED: true, AI_PROVIDER: "mock" } });
    expect(runtime.assistanceAvailable).toBe(false);
    expect(runtime.providerName).toBe("disabled");
  });

  it("the mock provider IS resolvable only with the explicit test-only opt-in", () => {
    const runtime = buildAiAssistRuntime({
      env: { AI_ENABLED: true, AI_PROVIDER: "mock" },
      allowMockProvider: true,
    });
    expect(runtime.assistanceAvailable).toBe(true);
    expect(runtime.providerName).toBe("mock");
  });

  it("no provider name resolves to a live network-calling implementation", () => {
    // The registry's factory map is never exported; the only way to prove its
    // contents is to attempt resolution. Every name other than the two
    // registered ones resolves to null — there is nothing to fall back to.
    ["openai", "anthropic", "gpt-4", "", "constructor", "toString"].forEach((name) => {
      expect(resolveAiAssistProvider(name, { allowMockProvider: true })).toBeNull();
    });
    expect(listRegisteredAiAssistProviderNames({ allowMockProvider: true }).sort()).toEqual([
      "disabled",
      "mock",
    ]);
    // Production callers (aiAssistRuntime) never pass allowMockProvider, so in
    // production only "disabled" is ever actually reachable.
    expect(listRegisteredAiAssistProviderNames({})).toEqual(["disabled"]);
  });
});

describe("provider name normalization", () => {
  it("treats null/none/off/empty/disabled as the same disabled alias", () => {
    ["null", "none", "off", "", "disabled", undefined, 42].forEach((raw) => {
      expect(normalizeProviderName(raw)).toBe("disabled");
    });
  });
});

describe("error contract closure", () => {
  it("SUGGESTION_REASON_CODES is a closed, small, machine-readable set", () => {
    expect(Object.values(SUGGESTION_REASON_CODES).sort()).toEqual(
      [
        "AI_DISABLED",
        "AI_PROVIDER_NOT_AVAILABLE",
        "PROVIDER_FAILED",
        "PROVIDER_MALFORMED_RESULT",
        "SUGGESTION_GENERATED",
      ].sort()
    );
  });

  it("PROVIDER_RESULT_STATUSES is a closed set — an unrecognised status is never guessed at", () => {
    expect(Object.values(PROVIDER_RESULT_STATUSES).sort()).toEqual(["COMPLETED", "DISABLED", "FAILED"].sort());
  });
});
