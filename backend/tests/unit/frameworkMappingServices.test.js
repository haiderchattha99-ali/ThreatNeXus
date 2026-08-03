import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The Phase 5 services, driven against the shared in-memory Prisma fake.
//
// The fake honours the two PostgreSQL behaviours this phase depends on —
// CaseFrameworkMapping.currentMappingKey and
// AiFrameworkMappingSuggestion.promotedMappingId as distinct-NULLs uniques, and
// transaction rollback — so an append-only or no-duplicate assertion here
// cannot pass against an implementation with no invariant at all. Genuine
// concurrency is proven separately against a real engine in
// tests/integration/frameworkMappingConcurrency.test.js.

const { createWorkflowPrismaFake } = require("./fixtures/workflowPrismaFake");

const mappingService = require("../../src/services/framework/frameworkMappingService");
const readService = require("../../src/services/framework/frameworkReadService");
const aiService = require("../../src/services/ai/aiSuggestionService");
const decisionService = require("../../src/services/ai/aiSuggestionDecisionService");
const { buildAiRuntime } = require("../../src/services/ai/aiRuntime");
const { MOCK_SCENARIOS } = require("../../src/services/ai/mockAiMappingProvider");
const { buildCaseEvidenceSnapshot } = require("../../src/services/ai/caseEvidenceSnapshot");

const {
  MAPPING_REJECTION_CODES,
  FrameworkMappingValidationError,
  FrameworkMappingStateError,
} = require("../../src/services/framework/frameworkMappingRules");
const {
  DECISION_OUTCOME_CODES,
  DECISION_REFUSAL_CODES,
  AiSuggestionStateError,
} = require("../../src/services/ai/aiSuggestionRules");

const T = (hour) => new Date(`2026-08-04T${String(hour).padStart(2, "0")}:00:00.000Z`);

const OBSERVED_BEHAVIOUR_RATIONALE =
  "The constituent supplied Windows security event logs showing repeated failed interactive logon " +
  "attempts from one external source, followed by a successful authentication and an established " +
  "remote session outside business hours that the account owner did not perform.";

const NIST = {
  framework: "NIST_CSF",
  frameworkVersion: "2.0",
  referenceId: "PR.AA-01",
  referenceTitle: "Identities and credentials are managed",
  mappingScope: "CASE",
  evidenceBasis: "CONTROL_GAP",
  rationale:
    "Administrative remote access is reachable from any network, indicating access permissions " +
    "are not constrained to authorised sources.",
};

const CIS = {
  framework: "CIS_CONTROLS",
  frameworkVersion: "v8",
  referenceId: "4.6",
  referenceTitle: "Securely Manage Enterprise Assets and Software",
  mappingScope: "CASE",
  evidenceBasis: "REMEDIATION_ALIGNMENT",
  rationale:
    "The recommended remediation places remote management behind a VPN, which aligns with " +
    "securely managing enterprise assets.",
};

let fake;
let client;
let state;
let errorSpy;
let ORG_ID;
let CASE_ID;
let FINDING_ID;
let ACTOR_ID;

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
      caseReference: "TNX-2026-000031",
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
}

const base = () => ({ client, actorUserId: ACTOR_ID });

const mockRuntime = (scenario) =>
  buildAiRuntime({
    env: { AI_ENABLED: true, AI_PROVIDER: "mock" },
    allowMockProvider: true,
    providerConfig: { scenario },
  });

const disabledRuntime = () => buildAiRuntime({ env: { AI_ENABLED: false, AI_PROVIDER: "null" } });

// Providers are deliberately Object.freeze'd, so vi.spyOn cannot patch one —
// which is itself a property worth having (a frozen provider cannot be
// monkeypatched at runtime by anything else either). Tests that need to observe
// or force a provider's behaviour therefore supply their own, through a
// runtime-shaped double carrying exactly the five fields the service reads.
function runtimeWithProvider(provider, overrides = {}) {
  return Object.freeze({
    aiEnabled: true,
    assistanceAvailable: true,
    provider,
    providerName: provider.name,
    providerModel: provider.model || null,
    reasonCode: null,
    ...overrides,
  });
}

function countingProvider(inner) {
  let calls = 0;
  return {
    provider: Object.freeze({
      name: "counting",
      model: null,
      isEnabled: true,
      async suggestMappings(args) {
        calls += 1;
        return inner(args);
      },
    }),
    calls: () => calls,
  };
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

describe("manual framework mapping", () => {
  it("creates an ACTIVE mapping directly, because it is an explicit human act", async () => {
    const outcome = await mappingService.createManualMapping(CASE_ID, NIST, {
      ...base(),
      effectiveAt: T(2),
    });
    expect(outcome.outcome).toBe("CREATED");
    expect(outcome.mapping.state).toBe("ACTIVE");
    expect(outcome.mapping.source).toBe("MANUAL");
    expect(outcome.mapping.actorUserId).toBe(ACTOR_ID);
    // The organization is stored explicitly, not merely joined through the case.
    expect(outcome.mapping.organizationId).toBe(ORG_ID);
  });

  it("refuses a case that is not organization-bound", async () => {
    const legacy = await client.case.create({
      data: {
        title: "Legacy",
        threatType: "x",
        organization: "x",
        analyst: "x",
        organizationId: null,
      },
    });
    await expect(
      mappingService.createManualMapping(legacy.id, NIST, { ...base(), effectiveAt: T(2) })
    ).rejects.toThrow();
    expect(state.caseFrameworkMappings).toHaveLength(0);
  });

  it("is append-only: removing appends a row and rewrites no prior content", async () => {
    const created = await mappingService.createManualMapping(CASE_ID, NIST, {
      ...base(),
      effectiveAt: T(2),
    });
    const originalRationale = state.caseFrameworkMappings[0].rationale;

    const removed = await mappingService.removeMapping(CASE_ID, created.mapping.id, {
      ...base(),
      effectiveAt: T(3),
      reason: "Superseded by a revised control assessment.",
    });

    expect(removed.outcome).toBe("REMOVED");
    expect(state.caseFrameworkMappings).toHaveLength(2);

    const prior = state.caseFrameworkMappings.find((row) => row.id === created.mapping.id);
    // Only the supersession columns changed on the prior row.
    expect(prior.state).toBe("ACTIVE");
    expect(prior.rationale).toBe(originalRationale);
    expect(prior.supersededAt).toEqual(T(3));
    expect(prior.currentMappingKey).toBeNull();
  });

  it("holds exactly one current row per (case, framework, scope, reference)", async () => {
    await mappingService.createManualMapping(CASE_ID, NIST, { ...base(), effectiveAt: T(2) });
    const created = state.caseFrameworkMappings[0];
    await mappingService.removeMapping(CASE_ID, created.id, {
      ...base(),
      effectiveAt: T(3),
      reason: "withdrawn for review",
    });
    await mappingService.createManualMapping(CASE_ID, NIST, { ...base(), effectiveAt: T(4) });

    const current = state.caseFrameworkMappings.filter((row) => row.currentMappingKey !== null);
    expect(current).toHaveLength(1);
    expect(current[0].state).toBe("ACTIVE");
  });

  // Without this guard a double-clicked button becomes a history entry.
  it("does not flood history when nothing would change", async () => {
    await mappingService.createManualMapping(CASE_ID, NIST, { ...base(), effectiveAt: T(2) });
    const again = await mappingService.createManualMapping(CASE_ID, NIST, {
      ...base(),
      effectiveAt: T(3),
    });
    expect(again.outcome).toBe("UNCHANGED");
    expect(again.changed).toBe(false);
    expect(state.caseFrameworkMappings).toHaveLength(1);
  });

  it("reports a repeated removal as UNCHANGED and writes nothing", async () => {
    const created = await mappingService.createManualMapping(CASE_ID, NIST, {
      ...base(),
      effectiveAt: T(2),
    });
    const removed = await mappingService.removeMapping(CASE_ID, created.mapping.id, {
      ...base(),
      effectiveAt: T(3),
      reason: "withdrawn",
    });
    const again = await mappingService.removeMapping(CASE_ID, removed.mapping.id, {
      ...base(),
      effectiveAt: T(4),
      reason: "withdrawn again",
    });
    expect(again.outcome).toBe("UNCHANGED");
    expect(state.caseFrameworkMappings).toHaveLength(2);
  });

  it("reports reactivation distinctly from creation and preserves the whole trail", async () => {
    const created = await mappingService.createManualMapping(CASE_ID, CIS, {
      ...base(),
      effectiveAt: T(2),
    });
    await mappingService.removeMapping(CASE_ID, created.mapping.id, {
      ...base(),
      effectiveAt: T(3),
      reason: "remediation plan changed",
    });
    const reactivated = await mappingService.createManualMapping(CASE_ID, CIS, {
      ...base(),
      effectiveAt: T(4),
    });

    expect(reactivated.outcome).toBe("REACTIVATED");
    expect(reactivated.mapping.state).toBe("ACTIVE");
    expect(state.caseFrameworkMappings).toHaveLength(3);
    expect(state.caseFrameworkMappings.map((row) => row.state)).toEqual([
      "ACTIVE",
      "REMOVED",
      "ACTIVE",
    ]);
  });

  it("requires a reason to withdraw a mapping", async () => {
    const created = await mappingService.createManualMapping(CASE_ID, NIST, {
      ...base(),
      effectiveAt: T(2),
    });
    await expect(
      mappingService.removeMapping(CASE_ID, created.mapping.id, { ...base(), effectiveAt: T(3) })
    ).rejects.toThrow(FrameworkMappingValidationError);
    expect(state.caseFrameworkMappings).toHaveLength(1);
  });

  it("refuses to withdraw a superseded row", async () => {
    const created = await mappingService.createManualMapping(CASE_ID, NIST, {
      ...base(),
      effectiveAt: T(2),
    });
    await mappingService.removeMapping(CASE_ID, created.mapping.id, {
      ...base(),
      effectiveAt: T(3),
      reason: "withdrawn",
    });
    // The original row is now superseded; a stale page must not be able to act
    // on it.
    let thrown;
    try {
      await mappingService.removeMapping(CASE_ID, created.mapping.id, {
        ...base(),
        effectiveAt: T(4),
        reason: "stale page",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrameworkMappingStateError);
    expect(thrown.code).toBe(MAPPING_REJECTION_CODES.MAPPING_NOT_CURRENT);
  });
});

describe("evidence linkage", () => {
  it("accepts a Finding currently linked to this case", async () => {
    const outcome = await mappingService.createManualMapping(
      CASE_ID,
      { ...CIS, mappingScope: "FINDING", evidenceFindingId: FINDING_ID },
      { ...base(), effectiveAt: T(2) }
    );
    expect(outcome.mapping.evidenceFindingId).toBe(FINDING_ID);
  });

  it("refuses a Finding that is not linked to this case", async () => {
    const other = await client.finding.create({
      data: {
        indicatorValue: "203.0.113.99",
        port: 3389,
        protocol: "TCP",
        reportType: "ACCESSIBLE_RDP",
        firstSeen: T(1),
        lastSeen: T(1),
        occurrenceCount: 1,
      },
    });

    let thrown;
    try {
      await mappingService.createManualMapping(
        CASE_ID,
        { ...CIS, mappingScope: "FINDING", evidenceFindingId: other.id },
        { ...base(), effectiveAt: T(2) }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrameworkMappingStateError);
    expect(thrown.code).toBe(MAPPING_REJECTION_CODES.EVIDENCE_FINDING_NOT_LINKED);
    expect(state.caseFrameworkMappings).toHaveLength(0);
  });

  it("refuses a Finding whose link has been withdrawn", async () => {
    await client.caseFinding.updateMany({
      where: { caseId: CASE_ID, findingId: FINDING_ID },
      data: { state: "UNLINKED", currentLinkKey: null, supersededAt: T(2) },
    });

    await expect(
      mappingService.createManualMapping(
        CASE_ID,
        { ...CIS, mappingScope: "FINDING", evidenceFindingId: FINDING_ID },
        { ...base(), effectiveAt: T(3) }
      )
    ).rejects.toThrow(FrameworkMappingStateError);
  });

  // An ATT&CK technique asserted against a case holding no evidence at all is
  // an assertion about nothing.
  it("requires an ATT&CK mapping to be tied to evidence", async () => {
    const empty = await client.case.create({
      data: {
        title: "No evidence",
        threatType: "x",
        organization: "Acme Bank",
        analyst: "a",
        organizationId: ORG_ID,
        lifecycleState: "OPEN",
        caseReference: "TNX-2026-000032",
      },
    });

    let thrown;
    try {
      await mappingService.createManualMapping(
        empty.id,
        {
          framework: "MITRE_ATTACK",
          frameworkVersion: "v17.1",
          referenceId: "T1110.001",
          referenceTitle: "Brute Force: Password Guessing",
          mappingScope: "CASE",
          evidenceBasis: "OBSERVED_BEHAVIOR",
          rationale: OBSERVED_BEHAVIOUR_RATIONALE,
        },
        { ...base(), effectiveAt: T(2) }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrameworkMappingStateError);
    expect(thrown.code).toBe(MAPPING_REJECTION_CODES.ATTACK_EVIDENCE_NOT_LINKED);
  });
});

describe("AI disabled", () => {
  it("makes no provider call, fabricates no suggestion, and records the request", async () => {
    // The disabled provider is not merely inert — the service returns BEFORE
    // reaching it. A counting provider proves the branch, not just the outcome:
    // if the service ever handed a snapshot to a provider while AI was off,
    // this call count would be 1 even though the result still looked right.
    const counting = countingProvider(async () => ({ status: "COMPLETED", suggestions: [] }));
    const runtime = runtimeWithProvider(counting.provider, {
      aiEnabled: false,
      assistanceAvailable: false,
      providerName: "disabled",
      reasonCode: "AI_DISABLED",
    });

    const { run, suggestions } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime,
      requestedAt: T(5),
    });

    expect(counting.calls()).toBe(0);
    expect(run.status).toBe("DISABLED");
    expect(run.reasonCode).toBe("AI_DISABLED");
    expect(run.providerName).toBe("disabled");
    expect(suggestions).toHaveLength(0);
    expect(state.aiFrameworkMappingSuggestions).toHaveLength(0);
    // The run itself IS recorded: "we asked and it was off" must stay
    // distinguishable from "nobody ever asked".
    expect(state.aiSuggestionRuns).toHaveLength(1);
  });

  it("leaves the case's active mappings completely untouched", async () => {
    await mappingService.createManualMapping(CASE_ID, NIST, { ...base(), effectiveAt: T(2) });
    await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: disabledRuntime(),
      requestedAt: T(5),
    });
    const view = await readService.getCaseFrameworkMappings(CASE_ID, { client });
    expect(view.activeCount).toBe(1);
    expect(view.groups[0].mappings[0].source).toBe("MANUAL");
  });
});

describe("AI suggestion generation", () => {
  it("stores only validated candidates and counts the discarded ones", async () => {
    const { run, suggestions } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: mockRuntime(MOCK_SCENARIOS.MIXED_VALID_AND_INVALID),
      requestedAt: T(5),
    });

    expect(run.status).toBe("COMPLETED");
    expect(run.suggestionCount).toBe(1);
    expect(run.rejectedCount).toBe(4);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].state).toBe("PENDING");
    // No "invalid suggestion" row exists to filter out later.
    expect(state.aiFrameworkMappingSuggestions).toHaveLength(1);
  });

  it("records ALL_CANDIDATES_REJECTED distinctly from nothing being returned", async () => {
    const rejected = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: mockRuntime(MOCK_SCENARIOS.ALL_INVALID),
      requestedAt: T(5),
    });
    expect(rejected.run.reasonCode).toBe("ALL_CANDIDATES_REJECTED");

    const empty = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: mockRuntime(MOCK_SCENARIOS.EMPTY),
      requestedAt: T(6),
    });
    expect(empty.run.reasonCode).toBe("NO_SUGGESTIONS_RETURNED");
  });

  it("survives a failing provider without breaking the workflow", async () => {
    const { run, suggestions } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: mockRuntime(MOCK_SCENARIOS.FAILED),
      requestedAt: T(5),
    });
    expect(run.status).toBe("FAILED");
    expect(run.reasonCode).toBe("PROVIDER_FAILED");
    expect(suggestions).toHaveLength(0);
  });

  it("survives a structurally malformed provider result", async () => {
    const { run } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: mockRuntime(MOCK_SCENARIOS.MALFORMED_RESULT),
      requestedAt: T(5),
    });
    expect(run.status).toBe("FAILED");
    expect(run.reasonCode).toBe("PROVIDER_MALFORMED_RESULT");
  });

  it("survives a provider that throws, without leaking any error text", async () => {
    const throwing = countingProvider(async () => {
      throw new Error("SECRET-KEY-abc123 leaked from provider internals");
    });
    const runtime = runtimeWithProvider(throwing.provider);

    const { run } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime,
      requestedAt: T(5),
    });

    expect(run.status).toBe("FAILED");
    expect(run.reasonCode).toBe("PROVIDER_FAILED");
    const persisted = JSON.stringify(state.aiSuggestionRuns) + JSON.stringify(state.auditLogs);
    expect(persisted).not.toContain("SECRET-KEY-abc123");
    expect(persisted).not.toContain("provider internals");
  });

  it("caps stored suggestions at the per-run maximum", async () => {
    const { run } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: mockRuntime(MOCK_SCENARIOS.OVER_CAP),
      requestedAt: T(5),
    });
    expect(run.suggestionCount).toBeLessThanOrEqual(5);
    expect(state.aiFrameworkMappingSuggestions.length).toBe(run.suggestionCount);
  });

  // THE central safety property of generation.
  it("creates no mapping of any kind", async () => {
    await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: mockRuntime(MOCK_SCENARIOS.VALID_CONTROL_MAPPINGS),
      requestedAt: T(5),
    });
    expect(state.caseFrameworkMappings).toHaveLength(0);
  });
});

describe("human decision and promotion", () => {
  async function generate(scenario = MOCK_SCENARIOS.VALID_CONTROL_MAPPINGS) {
    const { suggestions } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: mockRuntime(scenario),
      requestedAt: T(5),
    });
    return suggestions;
  }

  it("promotes an approved suggestion through the manual mapping writer", async () => {
    const [suggestion] = await generate();
    const outcome = await decisionService.approveSuggestion(CASE_ID, suggestion.id, {
      ...base(),
      decidedAt: T(6),
    });

    expect(outcome.outcome).toBe(DECISION_OUTCOME_CODES.APPROVED_AND_PROMOTED);
    expect(outcome.mapping.state).toBe("ACTIVE");
    expect(outcome.mapping.source).toBe("AI_SUGGESTION_PROMOTED");
    // The HUMAN is the actor, never the provider.
    expect(outcome.mapping.actorUserId).toBe(ACTOR_ID);
    expect(outcome.suggestion.state).toBe("APPROVED");
    expect(outcome.suggestion.decidedByUserId).toBe(ACTOR_ID);
    expect(outcome.suggestion.promotedMappingId).toBe(outcome.mapping.id);
    // The promoted content is byte-identical to what was reviewed.
    expect(outcome.mapping.rationale).toBe(suggestion.rationale);
    expect(outcome.mapping.referenceId).toBe(suggestion.referenceId);
  });

  it("does not duplicate the mapping on a repeated approval", async () => {
    const [suggestion] = await generate();
    await decisionService.approveSuggestion(CASE_ID, suggestion.id, { ...base(), decidedAt: T(6) });
    const again = await decisionService.approveSuggestion(CASE_ID, suggestion.id, {
      ...base(),
      decidedAt: T(7),
    });

    expect(again.outcome).toBe(DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED);
    expect(again.changed).toBe(false);
    expect(again.mapping).toBeNull();
    expect(
      state.caseFrameworkMappings.filter((row) => row.source === "AI_SUGGESTION_PROMOTED")
    ).toHaveLength(1);
    // The repeated attempt is still recorded.
    expect(state.aiSuggestionDecisions).toHaveLength(2);
  });

  it("refuses approval once the case evidence has changed", async () => {
    const [suggestion] = await generate();

    // Any real change to the bounded evidence moves the fingerprint. Adding an
    // unrelated mapping is the cheapest one to make here.
    await mappingService.createManualMapping(CASE_ID, NIST, { ...base(), effectiveAt: T(6) });

    let thrown;
    try {
      await decisionService.approveSuggestion(CASE_ID, suggestion.id, {
        ...base(),
        decidedAt: T(7),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AiSuggestionStateError);
    expect(thrown.code).toBe(DECISION_REFUSAL_CODES.SUGGESTION_STALE);

    // Refused, not silently re-derived: nothing was promoted and the suggestion
    // is untouched.
    expect(
      state.caseFrameworkMappings.filter((row) => row.source === "AI_SUGGESTION_PROMOTED")
    ).toHaveLength(0);
    const stored = state.aiFrameworkMappingSuggestions.find((row) => row.id === suggestion.id);
    expect(stored.state).toBe("PENDING");
  });

  it("refuses a suggestion belonging to a different case", async () => {
    const [suggestion] = await generate();
    const other = await client.case.create({
      data: {
        title: "Other",
        threatType: "x",
        organization: "Acme Bank",
        analyst: "a",
        organizationId: ORG_ID,
        lifecycleState: "OPEN",
        caseReference: "TNX-2026-000033",
      },
    });

    let thrown;
    try {
      await decisionService.approveSuggestion(other.id, suggestion.id, {
        ...base(),
        decidedAt: T(6),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown.code).toBe(DECISION_REFUSAL_CODES.SUGGESTION_NOT_FOR_CASE);
  });

  it("creates no mapping when a suggestion is rejected, and retains it", async () => {
    const [suggestion] = await generate();
    const outcome = await decisionService.rejectSuggestion(CASE_ID, suggestion.id, {
      ...base(),
      decidedAt: T(6),
      reason: "Control is already implemented; not a gap on this case.",
    });

    expect(outcome.outcome).toBe(DECISION_OUTCOME_CODES.REJECTED);
    expect(outcome.mapping).toBeNull();
    expect(state.caseFrameworkMappings).toHaveLength(0);

    // Retained, never deleted: the rejection rate is the only real evidence of
    // whether the gates and the assistant are any good.
    const stored = state.aiFrameworkMappingSuggestions.find((row) => row.id === suggestion.id);
    expect(stored.state).toBe("REJECTED");
    expect(stored.promotedMappingId).toBeNull();
    expect(stored.decisionReason).toMatch(/already implemented/);
  });

  it("requires a reason to reject", async () => {
    const [suggestion] = await generate();
    await expect(
      decisionService.rejectSuggestion(CASE_ID, suggestion.id, { ...base(), decidedAt: T(6) })
    ).rejects.toThrow();
    const stored = state.aiFrameworkMappingSuggestions.find((row) => row.id === suggestion.id);
    expect(stored.state).toBe("PENDING");
  });

  it("cannot approve a suggestion that was already rejected", async () => {
    const [suggestion] = await generate();
    await decisionService.rejectSuggestion(CASE_ID, suggestion.id, {
      ...base(),
      decidedAt: T(6),
      reason: "not applicable",
    });
    const outcome = await decisionService.approveSuggestion(CASE_ID, suggestion.id, {
      ...base(),
      decidedAt: T(7),
    });
    expect(outcome.outcome).toBe(DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED);
    expect(state.caseFrameworkMappings).toHaveLength(0);
  });

  it("re-applies the ATT&CK evidence rule at approval time", async () => {
    const [suggestion] = await generate(MOCK_SCENARIOS.VALID_ATTACK_MAPPING);
    expect(suggestion.framework).toBe("MITRE_ATTACK");
    expect(suggestion.evidenceBasis).toBe("OBSERVED_BEHAVIOR");

    // Tamper with the stored content the way a compromised row would look, and
    // prove the promotion path re-validates rather than trusting the row.
    await client.aiFrameworkMappingSuggestion.update({
      where: { id: suggestion.id },
      data: { evidenceBasis: "CONTROL_GAP" },
    });

    await expect(
      decisionService.approveSuggestion(CASE_ID, suggestion.id, { ...base(), decidedAt: T(6) })
    ).rejects.toThrow();
    expect(state.caseFrameworkMappings).toHaveLength(0);
  });
});

describe("bounded evidence snapshot", () => {
  it("excludes indicator values, ports and organization identity by construction", async () => {
    const caseRecord = await client.case.findUnique({ where: { id: CASE_ID } });
    const { snapshot } = await buildCaseEvidenceSnapshot(client, caseRecord, {});
    const blob = JSON.stringify(snapshot);

    ["203.0.113.10", "3389", "Acme Bank", "soc@acme.example", "SOC"].forEach((needle) => {
      expect(blob).not.toContain(needle);
    });
    // The coarse sector DOES go — it is the one organization attribute the
    // assistant legitimately needs.
    expect(snapshot.organizationSector).toBe("FINANCE");
    expect(snapshot.findings[0].reportType).toBe("ACCESSIBLE_RDP");
  });

  it("changes its fingerprint when evidence changes", async () => {
    const caseRecord = await client.case.findUnique({ where: { id: CASE_ID } });
    const before = await buildCaseEvidenceSnapshot(client, caseRecord, {});
    await mappingService.createManualMapping(CASE_ID, NIST, { ...base(), effectiveAt: T(2) });
    const after = await buildCaseEvidenceSnapshot(client, caseRecord, {});
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  // requestContext describes the question, not the case — so changing it must
  // not retroactively invalidate a suggestion about unchanged evidence.
  it("excludes the analyst's request context from the fingerprint", async () => {
    const caseRecord = await client.case.findUnique({ where: { id: CASE_ID } });
    const a = await buildCaseEvidenceSnapshot(client, caseRecord, { requestContext: "focus on CSF" });
    const b = await buildCaseEvidenceSnapshot(client, caseRecord, { requestContext: "focus on CIS" });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.snapshot.requestContext).not.toBe(b.snapshot.requestContext);
  });

  it("is stable across repeated builds of unchanged evidence", async () => {
    const caseRecord = await client.case.findUnique({ where: { id: CASE_ID } });
    const a = await buildCaseEvidenceSnapshot(client, caseRecord, {});
    const b = await buildCaseEvidenceSnapshot(client, caseRecord, {});
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe("audit payloads", () => {
  it("records mapping events without copying analyst prose into AuditLog", async () => {
    await mappingService.createManualMapping(CASE_ID, NIST, { ...base(), effectiveAt: T(2) });
    const actions = state.auditLogs.map((row) => row.action);
    expect(actions).toContain("framework.mapping.requested");
    expect(actions).toContain("framework.mapping.created");

    const blob = JSON.stringify(state.auditLogs);
    expect(blob).not.toContain(NIST.rationale);
    // Lengths are recorded instead, so "was anything written?" stays answerable.
    expect(blob).toContain("rationaleLength");
    // The framework's own published identifiers ARE recorded — they carry
    // nothing about the constituent.
    expect(blob).toContain("PR.AA-01");
  });

  it("records a rejection without copying the rejection reason", async () => {
    const { suggestions } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: mockRuntime(MOCK_SCENARIOS.VALID_CONTROL_MAPPINGS),
      requestedAt: T(5),
    });
    const reason = "Rejected because the constituent disputed the underlying observation entirely.";
    await decisionService.rejectSuggestion(CASE_ID, suggestions[0].id, {
      ...base(),
      decidedAt: T(6),
      reason,
    });
    expect(JSON.stringify(state.auditLogs)).not.toContain(reason);
  });

  it("never writes an input fingerprint to the audit trail", async () => {
    const { run } = await aiService.requestMappingSuggestions(CASE_ID, {
      ...base(),
      runtime: mockRuntime(MOCK_SCENARIOS.VALID_CONTROL_MAPPINGS),
      requestedAt: T(5),
    });
    expect(run.inputFingerprint).toEqual(expect.any(String));
    expect(JSON.stringify(state.auditLogs)).not.toContain(run.inputFingerprint);
  });

  // An audit failure must never roll back or alter the thing being audited.
  it("completes a mapping even when the audit write throws", async () => {
    const original = client.auditLog.create;
    client.auditLog.create = async () => {
      throw new Error("audit sink unavailable");
    };
    try {
      const outcome = await mappingService.createManualMapping(CASE_ID, NIST, {
        ...base(),
        effectiveAt: T(2),
      });
      expect(outcome.changed).toBe(true);
      expect(state.caseFrameworkMappings).toHaveLength(1);
    } finally {
      client.auditLog.create = original;
    }
  });
});
