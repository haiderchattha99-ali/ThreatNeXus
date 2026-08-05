import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The AI prohibition boundaries, asserted as CODE rather than trusted to
// comments.
//
// The Phase 5 brief lists a long set of things AI must never do: alter a
// RiskScore or its contributions, select a risk band, approve its own
// suggestion, create ownership mappings, attach CVEs, close or reopen a case,
// approve a closure, create/approve/export a notification, mark a delivery,
// create an organization response, send email, run enrichment, or scan.
//
// This file proves the prohibition two ways:
//
//   1. STRUCTURALLY — the provider contract hands a provider nothing it could
//      do any of those things with. There is no client, no transaction, no
//      repository, no user, no capability, no logger, no file handle. A
//      prohibition enforced by omission cannot be forgotten by a future author
//      the way a comment can.
//
//   2. BEHAVIOURALLY — a full generation run against a deliberately hostile
//      provider is driven end to end, and every table AI must not touch is
//      counted before and after.

const { createWorkflowPrismaFake } = require("./fixtures/workflowPrismaFake");

const aiService = require("../../src/services/ai/aiSuggestionService");
const decisionService = require("../../src/services/ai/aiSuggestionDecisionService");
const { createDisabledAiMappingProvider } = require("../../src/services/ai/aiMappingProvider");
const { createMockAiMappingProvider } = require("../../src/services/ai/mockAiMappingProvider");

const T = (hour) => new Date(`2026-08-04T${String(hour).padStart(2, "0")}:00:00.000Z`);

let fake;
let client;
let state;
let errorSpy;
let ORG_ID;
let CASE_ID;
let FINDING_ID;
let ACTOR_ID;

// Every table AI is forbidden from causing a write to.
function forbiddenCounts() {
  return {
    riskScores: state.riskScores.length,
    riskFactorContributions: state.riskFactorContributions.length,
    findingOwnerships: state.findingOwnerships.length,
    findingVulnerabilities: state.findingVulnerabilities.length,
    vulnerabilities: state.vulnerabilities.length,
    cases: state.cases.length,
    caseLifecycleEvents: state.caseLifecycleEvents.length,
    caseClosureRequests: state.caseClosureRequests.length,
    caseOrganizationResponses: state.caseOrganizationResponses.length,
    caseFindings: state.caseFindings.length,
    findingTriages: state.findingTriages.length,
    notifications: state.notifications.length,
    notificationRevisions: state.notificationRevisions.length,
    notificationLifecycleEvents: state.notificationLifecycleEvents.length,
    notificationExports: state.notificationExports.length,
    notificationDeliveryEvents: state.notificationDeliveryEvents.length,
  };
}

// A case snapshot of the mutable projections AI must not change.
function caseProjection() {
  const record = state.cases.find((row) => row.id === CASE_ID);
  return {
    lifecycleState: record.lifecycleState,
    closedAt: record.closedAt,
    closureReason: record.closureReason,
    reopenedCount: record.reopenedCount,
  };
}

async function seed() {
  const organization = await client.organization.create({
    data: { name: "Acme Bank", sector: "FINANCE", contactPerson: "SOC", email: "soc@acme.example" },
  });
  ORG_ID = organization.id;

  const actor = await client.user.create({
    data: { name: "A. Analyst", email: "analyst@example.test", role: "ANALYST" },
  });
  ACTOR_ID = actor.id;

  const finding = await client.finding.create({
    data: {
      indicatorValue: "203.0.113.10",
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      firstSeen: T(1),
      lastSeen: T(1),
      occurrenceCount: 2,
    },
  });
  FINDING_ID = finding.id;

  const record = await client.case.create({
    data: {
      title: "Accessible RDP",
      threatType: "Accessible RDP",
      organization: "Acme Bank",
      analyst: "a.analyst",
      organizationId: ORG_ID,
      lifecycleState: "OPEN",
      caseReference: "TNX-2026-000041",
    },
  });
  CASE_ID = record.id;

  await client.caseFinding.create({
    data: {
      caseId: CASE_ID,
      findingId: FINDING_ID,
      state: "LINKED",
      organizationId: ORG_ID,
      ownershipStatusAtLink: "RESOLVED",
      ownershipConfidenceAtLink: "HIGH",
      effectiveAt: T(1),
      supersededAt: null,
      currentLinkKey: `${CASE_ID}:${FINDING_ID}`,
    },
  });

  // Phase 6.3. A recorded organization response, so the CASE_RESPONSE-sourced
  // evidence quotes in this suite's candidates have a real record to be
  // verified against. Seeded rather than the check being relaxed: a suite that
  // could promote a suggestion whose quote matched nothing would prove the
  // opposite of what it claims.
  await client.caseOrganizationResponse.create({
    data: {
      caseId: CASE_ID,
      responseType: "ACKNOWLEDGED",
      summary:
        "The constituent confirmed an interactive administrative session was established " +
        "outside their change window and has since disabled the account.",
      occurredAt: T(1),
      recordedByUserId: ACTOR_ID,
    },
  });

  // A deterministic Risk v1 snapshot AI must never alter.
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
      supersededAt: null,
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
    [createDisabledAiMappingProvider(), createMockAiMappingProvider()].forEach((provider) => {
      const methods = Object.keys(provider).filter((key) => typeof provider[key] === "function");
      // The mock adds getCallCount for tests; the contract method is the only
      // one either provider uses to do work.
      expect(methods).toContain("suggestMappings");
      expect(methods.filter((name) => name !== "getCallCount")).toEqual(["suggestMappings"]);
    });
  });

  it("is frozen, so nothing can graft a capability onto it at runtime", () => {
    const provider = createDisabledAiMappingProvider();
    expect(Object.isFrozen(provider)).toBe(true);
    expect(() => {
      "use strict";
      provider.writeMapping = () => {};
    }).toThrow();
  });

  // THE structural claim. A provider receives one bounded snapshot, a Date and
  // an optional AbortSignal — and nothing else exists for it to act through.
  it("receives no client, transaction, repository, user, capability or logger", async () => {
    let received;
    const provider = Object.freeze({
      name: "introspecting",
      model: null,
      isEnabled: true,
      async suggestMappings(args) {
        received = args;
        return { status: "COMPLETED", suggestions: [] };
      },
    });

    await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });

    expect(Object.keys(received).sort()).toEqual(["asOf", "signal", "snapshot"]);
    [
      "client",
      "prisma",
      "tx",
      "transaction",
      "repository",
      "user",
      "actor",
      "capabilities",
      "auditLogger",
      "logger",
      "req",
      "res",
      "fs",
      "fetch",
    ].forEach((forbidden) => {
      expect(received).not.toHaveProperty(forbidden);
    });

    // The snapshot itself is plain data, not a live handle onto anything.
    expect(typeof received.snapshot).toBe("object");
    Object.values(received.snapshot).forEach((value) => {
      expect(typeof value).not.toBe("function");
    });
  });
});

describe("behavioural boundary: a hostile provider changes nothing", () => {
  // A provider that returns every forbidden instruction it can think of. None
  // of it is a field the contract defines, so all of it is rejected — but the
  // point of the test is what the DATABASE looks like afterwards.
  const HOSTILE_CANDIDATES = [
    {
      framework: "MITRE_ATTACK",
      frameworkVersion: "v17.1",
      referenceId: "T1021.001",
      referenceTitle: "Remote Services: RDP",
      mappingScope: "CASE",
      evidenceBasis: "OBSERVED_BEHAVIOR",
      rationale: "Port 3389 is exposed and CVE-2019-0708 applies with a high reputation score.",
      confidence: 100,
    },
    {
      framework: "NIST_CSF",
      frameworkVersion: "2.0",
      referenceId: "PR.AA-05",
      referenceTitle: "Access permissions",
      mappingScope: "CASE",
      evidenceBasis: "CONTROL_GAP",
      rationale: "Access permissions are not constrained to authorised networks at all.",
      // Every one of these is outside ALLOWED_CANDIDATE_KEYS.
      riskBand: "CRITICAL",
      scoreBasisPoints: 10000,
      closeCase: true,
      approveClosure: true,
      reopenCase: true,
      createNotification: true,
      approveNotification: true,
      exportNotification: true,
      markDelivered: true,
      attachCve: "CVE-2019-0708",
      createOwnershipMapping: { organizationId: 99 },
      recordOrganizationResponse: "REMEDIATED",
      runEnrichment: true,
      startScan: true,
      autoApprove: true,
      state: "APPROVED",
      source: "MANUAL",
    },
  ];

  it("cannot alter a RiskScore, its contributions, or the risk band", async () => {
    const before = forbiddenCounts();
    const scoreBefore = { ...state.riskScores[0] };
    const contributionBefore = { ...state.riskFactorContributions[0] };

    const provider = Object.freeze({
      name: "hostile",
      model: null,
      isEnabled: true,
      async suggestMappings() {
        return { status: "COMPLETED", suggestions: HOSTILE_CANDIDATES };
      },
    });

    await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });

    expect(state.riskScores[0]).toEqual(scoreBefore);
    expect(state.riskFactorContributions[0]).toEqual(contributionBefore);
    expect(state.riskScores[0].riskBand).toBe("HIGH");
    expect(state.riskScores[0].scoreBasisPoints).toBe(6100);
    expect(forbiddenCounts()).toEqual(before);
  });

  it("cannot close, reopen or resolve a case, or approve a closure", async () => {
    const projectionBefore = caseProjection();
    const provider = Object.freeze({
      name: "hostile",
      model: null,
      isEnabled: true,
      async suggestMappings() {
        return { status: "COMPLETED", suggestions: HOSTILE_CANDIDATES };
      },
    });

    await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });

    expect(caseProjection()).toEqual(projectionBefore);
    expect(state.caseClosureRequests).toHaveLength(0);
    expect(state.caseLifecycleEvents).toHaveLength(0);
  });

  it("cannot create, approve, export or deliver a notification, or send anything", async () => {
    const provider = Object.freeze({
      name: "hostile",
      model: null,
      isEnabled: true,
      async suggestMappings() {
        return { status: "COMPLETED", suggestions: HOSTILE_CANDIDATES };
      },
    });

    // Captured BEFORE the run. Phase 6.3 seeds one organization response so
    // evidence quotes have a record to verify against, so "the provider created
    // no response" is now an UNCHANGED assertion rather than a zero one. The
    // claim under test is unaffected — what matters is that the hostile
    // provider added nothing — and asserting zero would have quietly become an
    // assertion about the fixture instead of about the provider.
    const responsesBefore = state.caseOrganizationResponses.length;

    await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });

    expect(state.notifications).toHaveLength(0);
    expect(state.notificationRevisions).toHaveLength(0);
    expect(state.notificationExports).toHaveLength(0);
    expect(state.notificationDeliveryEvents).toHaveLength(0);
    expect(state.caseOrganizationResponses).toHaveLength(responsesBefore);
  });

  it("cannot attach a CVE, create ownership, retriage, or link evidence", async () => {
    const before = forbiddenCounts();
    const provider = Object.freeze({
      name: "hostile",
      model: null,
      isEnabled: true,
      async suggestMappings() {
        return { status: "COMPLETED", suggestions: HOSTILE_CANDIDATES };
      },
    });

    await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });

    const after = forbiddenCounts();
    expect(after.findingVulnerabilities).toBe(before.findingVulnerabilities);
    expect(after.vulnerabilities).toBe(before.vulnerabilities);
    expect(after.findingOwnerships).toBe(before.findingOwnerships);
    expect(after.findingTriages).toBe(before.findingTriages);
    expect(after.caseFindings).toBe(before.caseFindings);
  });

  // A provider cannot make its own output ACTIVE, and cannot pre-approve it.
  it("cannot create an active mapping or approve its own suggestion", async () => {
    const provider = Object.freeze({
      name: "hostile",
      model: null,
      isEnabled: true,
      async suggestMappings() {
        return { status: "COMPLETED", suggestions: HOSTILE_CANDIDATES };
      },
    });

    const { run, suggestions } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });

    // Both hostile candidates are refused: the first by the ATT&CK rule, the
    // second by the unknown-field rule.
    expect(run.rejectedCount).toBe(2);
    expect(suggestions).toHaveLength(0);
    expect(state.caseFrameworkMappings).toHaveLength(0);
    // No decision row exists, because no human decided anything.
    expect(state.aiSuggestionDecisions).toHaveLength(0);
  });

  it("cannot mint an APPROVED suggestion even when it asks to", async () => {
    // A candidate carrying no forbidden extras EXCEPT the state field, so it
    // would otherwise be perfectly valid.
    const provider = Object.freeze({
      name: "hostile",
      model: null,
      isEnabled: true,
      async suggestMappings() {
        return {
          status: "COMPLETED",
          suggestions: [
            {
              framework: "NIST_CSF",
              frameworkVersion: "2.0",
              referenceId: "PR.AA-05",
              referenceTitle: "Access permissions",
              mappingScope: "CASE",
              evidenceBasis: "CONTROL_GAP",
              rationale: "Access permissions are not constrained to authorised networks at all.",
              // Phase 6.3 evidence obligations, so this candidate fails (or passes)
              // for the reason the test is actually about.
              evidenceQuote: "interactive administrative session was established",
              evidenceQuoteSource: "CASE_RESPONSE",
              evidenceConfidence: "MEDIUM",
              mappingConfidence: "MEDIUM",
              state: "APPROVED",
            },
          ],
        };
      },
    });

    const { run } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });

    expect(run.suggestionCount).toBe(0);
    expect(run.rejectedCount).toBe(1);
    expect(state.aiFrameworkMappingSuggestions).toHaveLength(0);
  });

  // The same candidate WITHOUT the forbidden key is accepted and lands PENDING,
  // proving the rejection above was caused by the forbidden key rather than by
  // some unrelated defect making everything fail.
  it("accepts the same content once the forbidden field is removed, still PENDING", async () => {
    const provider = Object.freeze({
      name: "clean",
      model: null,
      isEnabled: true,
      async suggestMappings() {
        return {
          status: "COMPLETED",
          suggestions: [
            {
              framework: "NIST_CSF",
              frameworkVersion: "2.0",
              referenceId: "PR.AA-05",
              referenceTitle: "Access permissions",
              mappingScope: "CASE",
              evidenceBasis: "CONTROL_GAP",
              rationale: "Access permissions are not constrained to authorised networks at all.",
              // Phase 6.3 evidence obligations, so this candidate fails (or passes)
              // for the reason the test is actually about.
              evidenceQuote: "interactive administrative session was established",
              evidenceQuoteSource: "CASE_RESPONSE",
              evidenceConfidence: "MEDIUM",
              mappingConfidence: "MEDIUM",
            },
          ],
        };
      },
    });

    const { run, suggestions } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });

    expect(run.suggestionCount).toBe(1);
    expect(suggestions[0].state).toBe("PENDING");
    expect(state.caseFrameworkMappings).toHaveLength(0);

    // And only a HUMAN calling the decision service changes that.
    await decisionService.approveSuggestion(CASE_ID, suggestions[0].id, {
      ...base(),
      decidedAt: T(6),
    });
    expect(state.caseFrameworkMappings).toHaveLength(1);
    expect(state.caseFrameworkMappings[0].actorUserId).toBe(ACTOR_ID);
    expect(state.caseFrameworkMappings[0].source).toBe("AI_SUGGESTION_PROMOTED");
  });

  it("leaves Risk v1 untouched even across a full generate-and-approve cycle", async () => {
    const scoreBefore = { ...state.riskScores[0] };
    const contributionsBefore = state.riskFactorContributions.map((row) => ({ ...row }));

    const provider = Object.freeze({
      name: "clean",
      model: null,
      isEnabled: true,
      async suggestMappings() {
        return {
          status: "COMPLETED",
          suggestions: [
            {
              framework: "CIS_CONTROLS",
              frameworkVersion: "v8",
              referenceId: "4.6",
              referenceTitle: "Securely Manage Enterprise Assets and Software",
              mappingScope: "CASE",
              evidenceBasis: "REMEDIATION_ALIGNMENT",
              rationale: "Remediation places remote management behind a VPN, aligning with 4.6.",
              // Phase 6.3 evidence obligations. This candidate has to be
              // genuinely acceptable, because the test needs a real
              // generate-and-approve cycle to complete before it can claim that
              // cycle left Risk v1 untouched.
              evidenceQuote: "interactive administrative session was established",
              evidenceQuoteSource: "CASE_RESPONSE",
              evidenceConfidence: "MEDIUM",
              mappingConfidence: "MEDIUM",
            },
          ],
        };
      },
    });

    const { suggestions } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: runtimeFor(provider),
      requestedAt: T(5),
    });
    await decisionService.approveSuggestion(CASE_ID, suggestions[0].id, {
      ...base(),
      decidedAt: T(6),
    });

    expect(state.riskScores).toHaveLength(1);
    expect(state.riskScores[0]).toEqual(scoreBefore);
    expect(state.riskFactorContributions).toEqual(contributionsBefore);
  });
});

describe("no autonomous execution", () => {
  // Phase 5 adds no worker, no timer and no scheduled job. If any module ever
  // started one on import, this would leave a handle behind.
  it("starts no timer or interval when the AI modules are imported", () => {
    vi.useFakeTimers();
    try {
      const timersBefore = vi.getTimerCount();
      // Re-import through a fresh require cache entry.
      delete require.cache[require.resolve("../../src/services/ai/aiRuntime")];
      delete require.cache[require.resolve("../../src/services/ai/aiSuggestionService")];
      require("../../src/services/ai/aiRuntime");
      require("../../src/services/ai/aiSuggestionService");
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
      await aiService.requestMappingSuggestions(CASE_ID, {
        ...base(),
        runtime: Object.freeze({
          aiEnabled: false,
          assistanceAvailable: false,
          provider: createDisabledAiMappingProvider(),
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
