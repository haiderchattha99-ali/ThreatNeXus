import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The Phase 8C AI-assist prohibition boundaries, asserted as CODE rather than
// trusted to comments. Mirrors tests/unit/aiSafetyBoundaries.test.js exactly
// in spirit, for the Finding-narrative-suggestion contract instead of the
// mapping-suggestion one.
//
// Proves the prohibition two ways:
//   1. STRUCTURALLY — the provider contract hands a provider nothing it could
//      mutate anything with: no client, no transaction, no user, no logger.
//   2. BEHAVIOURALLY — a hostile provider result is driven end to end, and
//      every table AI must not touch is counted before and after; the
//      suggestion it produces is proven to stay DRAFT even when the hostile
//      output tries to claim ACCEPTED for itself.

const { createWorkflowPrismaFake } = require("./fixtures/workflowPrismaFake");

const service = require("../../src/services/aiAssist/findingAiSuggestionService");
const decisionService = require("../../src/services/aiAssist/findingAiSuggestionDecisionService");
const { createDisabledAiAssistProvider } = require("../../src/services/aiAssist/aiAssistProvider");
const { createMockAiAssistProvider } = require("../../src/services/aiAssist/mockAiAssistProvider");
const { SUGGESTION_TYPES, SUGGESTION_STATUSES } = require("../../src/services/aiAssist/aiAssistRules");

const T = (hour) => new Date(`2026-08-07T${String(hour).padStart(2, "0")}:00:00.000Z`);

let fake;
let client;
let state;
let errorSpy;
let FINDING_ID;
let ACTOR_ID;

function forbiddenCounts() {
  return {
    riskScores: state.riskScores.length,
    riskFactorContributions: state.riskFactorContributions.length,
    findingVulnerabilities: state.findingVulnerabilities.length,
    vulnerabilities: state.vulnerabilities.length,
    findingTriages: state.findingTriages.length,
    cases: state.cases.length,
    notifications: state.notifications.length,
  };
}

async function seed() {
  const actor = await client.user.create({
    data: { name: "A. Analyst", email: "analyst@example.test", role: "ANALYST" },
  });
  ACTOR_ID = actor.id;

  const finding = await client.finding.create({
    data: {
      indicatorValue: "203.0.113.20",
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      firstSeen: T(1),
      lastSeen: T(1),
      occurrenceCount: 2,
      status: "OPEN",
    },
  });
  FINDING_ID = finding.id;

  await client.findingTriage.create({
    data: { findingId: FINDING_ID, decision: "ESCALATED", currentForFindingId: FINDING_ID },
  });

  const score = await client.riskScore.create({
    data: {
      findingId: FINDING_ID,
      algorithmVersion: "risk-additive-bucketed-v1",
      configurationVersion: "v1.0.0",
      configurationFingerprint: "cfg-fingerprint",
      inputFingerprint: "risk-input-fingerprint",
      scoreBasisPoints: 6100,
      riskBand: "HIGH",
      asOf: T(1),
      calculatedAt: T(1),
      trigger: "INGESTION",
      currentForFindingId: FINDING_ID,
    },
  });
  await client.riskFactorContribution.create({
    data: {
      riskScoreId: score.id,
      factorKey: "exposureCriticality",
      applicability: "APPLIED",
      contributionBasisPoints: 1500,
      maximumContributionBasisPoints: 1500,
      explanationCode: "EXPOSURE_CRITICALITY_REMOTE_ACCESS_RDP",
      displayOrder: 2,
    },
  });
}

const base = () => ({ client, actorUserId: ACTOR_ID });

function runtimeFor(provider) {
  return Object.freeze({
    aiEnabled: true,
    assistanceAvailable: true,
    provider,
    providerName: provider.name,
    providerModel: provider.model || null,
    reasonCode: null,
  });
}

beforeEach(async () => {
  fake = createWorkflowPrismaFake();
  client = fake.client;
  state = fake.state;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  await seed();
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
});

describe("structural boundary: what a provider is handed", () => {
  it("exposes exactly four members and one method", () => {
    [createDisabledAiAssistProvider(), createMockAiAssistProvider()].forEach((provider) => {
      const methods = Object.keys(provider).filter((key) => typeof provider[key] === "function");
      expect(methods).toContain("generateSuggestion");
      expect(methods.filter((name) => name !== "getCallCount")).toEqual(["generateSuggestion"]);
    });
  });

  it("is frozen, so nothing can graft a capability onto it at runtime", () => {
    const provider = createDisabledAiAssistProvider();
    expect(Object.isFrozen(provider)).toBe(true);
    expect(() => {
      "use strict";
      provider.writeFinding = () => {};
    }).toThrow();
  });

  it("receives no client, transaction, repository, user, capability or logger", async () => {
    let received;
    const provider = Object.freeze({
      name: "introspecting",
      model: null,
      isEnabled: true,
      async generateSuggestion(args) {
        received = args;
        return { status: "COMPLETED", text: "safe draft", evidenceReferences: ["reportType"] };
      },
    });

    await service.requestFindingAiSuggestion(FINDING_ID, SUGGESTION_TYPES.SUMMARY, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });

    expect(Object.keys(received).sort()).toEqual(["asOf", "signal", "snapshot", "suggestionType"]);
    ["client", "prisma", "tx", "transaction", "repository", "user", "actor", "capabilities", "auditLogger", "logger", "req", "res", "fs", "fetch"].forEach(
      (forbidden) => expect(received).not.toHaveProperty(forbidden)
    );
    Object.values(received.snapshot).forEach((value) => {
      expect(typeof value).not.toBe("function");
    });
    // The Finding's own address is never handed to the provider.
    expect(received.snapshot).not.toHaveProperty("indicatorValue");
    expect(received.snapshot).not.toHaveProperty("port");
  });
});

describe("behavioural boundary: a hostile provider changes nothing", () => {
  it("cannot alter a RiskScore, its contributions, or triage", async () => {
    const before = forbiddenCounts();
    const scoreBefore = { ...state.riskScores[0] };

    const provider = Object.freeze({
      name: "hostile",
      model: null,
      isEnabled: true,
      async generateSuggestion() {
        return {
          status: "COMPLETED",
          text: "Hostile draft claiming things.",
          evidenceReferences: ["reportType"],
          // Every one of these is outside the provider result contract.
          riskBand: "CRITICAL",
          closeFinding: true,
          approveSuggestion: true,
        };
      },
    });

    const { suggestion } = await service.requestFindingAiSuggestion(FINDING_ID, SUGGESTION_TYPES.SUMMARY, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });

    expect(state.riskScores[0]).toEqual(scoreBefore);
    expect(forbiddenCounts()).toEqual(before);
    // The hostile extras are discarded BY CONSTRUCTION: the service only ever
    // reads `.text` and `.evidenceReferences` off a provider result, so
    // riskBand/closeFinding/approveSuggestion are never even passed to
    // validation, let alone acted on. The clean text is still generated.
    expect(suggestion.reasonCode).toBe("SUGGESTION_GENERATED");
    expect(suggestion.status).toBe(SUGGESTION_STATUSES.DRAFT);
    expect(suggestion.proposedText).toBe("Hostile draft claiming things.");
    expect(JSON.stringify(suggestion)).not.toMatch(/CRITICAL|closeFinding|approveSuggestion/);
  });

  it("cannot mint an ACCEPTED suggestion even when it asks to", async () => {
    const provider = Object.freeze({
      name: "hostile",
      model: null,
      isEnabled: true,
      async generateSuggestion() {
        return {
          status: "COMPLETED",
          text: "Perfectly reasonable draft text.",
          evidenceReferences: ["reportType"],
          state: "ACCEPTED",
        };
      },
    });

    const { suggestion } = await service.requestFindingAiSuggestion(FINDING_ID, SUGGESTION_TYPES.SUMMARY, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });

    // Rejected wholesale for the unexpected `state` field — nothing is
    // partially trusted, and the persisted row is DRAFT regardless.
    expect(suggestion.status).toBe(SUGGESTION_STATUSES.DRAFT);
  });

  it("accepts the same content once the forbidden field is removed, and only a HUMAN can accept it", async () => {
    const provider = Object.freeze({
      name: "clean",
      model: null,
      isEnabled: true,
      async generateSuggestion() {
        return {
          status: "COMPLETED",
          text: "A clean, defensible draft.",
          evidenceReferences: ["reportType", "riskBand"],
        };
      },
    });

    const { suggestion } = await service.requestFindingAiSuggestion(FINDING_ID, SUGGESTION_TYPES.SUMMARY, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });

    expect(suggestion.status).toBe(SUGGESTION_STATUSES.DRAFT);
    expect(suggestion.reasonCode).toBe("SUGGESTION_GENERATED");

    const outcome = await decisionService.acceptFindingAiSuggestion(FINDING_ID, suggestion.id, {
      ...base(),
      decidedAt: T(6),
    });
    expect(outcome.suggestion.status).toBe(SUGGESTION_STATUSES.ACCEPTED);
    expect(outcome.suggestion.decidedByUserId).toBe(ACTOR_ID);
    // Still nothing outside the suggestion's own row changed.
    expect(forbiddenCounts()).toEqual({
      riskScores: 1,
      riskFactorContributions: 1,
      findingVulnerabilities: 0,
      vulnerabilities: 0,
      findingTriages: 1,
      cases: 0,
      notifications: 0,
    });
  });
});

describe("no autonomous execution", () => {
  it("starts no timer or interval when the AI-assist modules are imported", () => {
    vi.useFakeTimers();
    try {
      const timersBefore = vi.getTimerCount();
      delete require.cache[require.resolve("../../src/services/aiAssist/aiAssistRuntime")];
      delete require.cache[require.resolve("../../src/services/aiAssist/findingAiSuggestionService")];
      require("../../src/services/aiAssist/aiAssistRuntime");
      require("../../src/services/aiAssist/findingAiSuggestionService");
      expect(vi.getTimerCount()).toBe(timersBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes no fetch call anywhere in a disabled generation run", async () => {
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error("no network access is permitted in this suite");
    };
    try {
      await service.requestFindingAiSuggestion(FINDING_ID, SUGGESTION_TYPES.SUMMARY, {
        ...base(),
        runtime: Object.freeze({
          aiEnabled: false,
          assistanceAvailable: false,
          provider: createDisabledAiAssistProvider(),
          providerName: "disabled",
          providerModel: null,
          reasonCode: "AI_DISABLED",
        }),
        requestedAt: T(5),
      });
      expect(fetchCalls).toBe(0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
