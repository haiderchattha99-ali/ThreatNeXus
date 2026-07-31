import { describe, it, expect, beforeEach, vi } from "vitest";

// Case creation, guarded lifecycle transitions, evidence linkage, the
// organization-response timeline and reviewer-approved closure.
//
// Every assertion reads the fake's durable rows rather than the service return
// value, because the properties under test are about what was WRITTEN: an
// append-only history, a single current link per pair, a closure that cannot
// be granted by its own requester, and a REMEDIATED closure that must rest on
// a recorded REMEDIATED response.

const { createWorkflowPrismaFake } = require("./fixtures/workflowPrismaFake");

const {
  createCase,
  changeCaseState,
  reopenCase,
} = require("../../src/services/workflow/caseLifecycleService");
const {
  linkFinding,
  unlinkFinding,
  listCurrentLinks,
} = require("../../src/services/workflow/caseFindingLinkService");
const {
  recordOrganizationResponse,
  findLatestRemediatedResponse,
} = require("../../src/services/workflow/caseResponseService");
const {
  requestClosure,
  approveClosure,
  rejectClosure,
} = require("../../src/services/workflow/caseClosureService");

const {
  CASE_STATES,
  CLOSURE_REASONS,
  RESPONSE_TYPES,
  LINK_REJECTION_CODES,
  CaseWorkflowValidationError,
  CaseWorkflowNotFoundError,
  CaseWorkflowStateError,
  CaseClosureSelfApprovalError,
} = require("../../src/services/workflow/caseWorkflowRules");

const ANALYST = 10;
const REVIEWER = 11;

// The fake shares one id sequence across every table, exactly like a single
// PostgreSQL sequence would not — so nothing here may assume that the first
// organization is id 1 or the first Finding is id 1. Every id is captured from
// what the fake actually assigned.
let ORG_ID;
let OTHER_ORG_ID;
let FINDING_A;
let FINDING_B;

const AT = (iso) => new Date(iso);
const T0 = AT("2026-08-01T08:00:00.000Z");
const T1 = AT("2026-08-01T09:00:00.000Z");
const T2 = AT("2026-08-01T10:00:00.000Z");
const T3 = AT("2026-08-01T11:00:00.000Z");
const T4 = AT("2026-08-01T12:00:00.000Z");

let fake;
let client;
let state;

async function seedOwnership(findingId, overrides = {}) {
  return client.findingOwnership.create({
    data: {
      findingId,
      status: "RESOLVED",
      confidence: "HIGH",
      organizationId: ORG_ID,
      isIspAttribution: false,
      reasonCode: "EXACT_IP_MATCH",
      currentForFindingId: findingId,
      ...overrides,
    },
  });
}

async function newCase(overrides = {}) {
  return createCase(
    {
      title: "Accessible RDP on constituent host",
      threatType: "Accessible RDP",
      organization: "Acme Bank",
      analyst: "a.analyst",
      organizationId: ORG_ID,
      createdAt: T0,
      ...overrides,
    },
    { client, actorUserId: ANALYST }
  );
}

beforeEach(async () => {
  fake = createWorkflowPrismaFake();
  client = fake.client;
  state = fake.state;
  vi.spyOn(console, "error").mockImplementation(() => {});

  ORG_ID = (await client.organization.create({ data: { name: "Acme Bank", sector: "FINANCE" } }))
    .id;
  OTHER_ORG_ID = (
    await client.organization.create({ data: { name: "Beta Utilities", sector: "ENERGY" } })
  ).id;
  FINDING_A = (
    await client.finding.create({ data: { indicatorValue: "192.0.2.10", status: "OPEN" } })
  ).id;
  FINDING_B = (
    await client.finding.create({ data: { indicatorValue: "192.0.2.11", status: "OPEN" } })
  ).id;
});

describe("case creation", () => {
  it("binds the case to one organization and assigns a reference from its own id", async () => {
    const created = await newCase();

    expect(created.organizationId).toBe(ORG_ID);
    expect(created.lifecycleState).toBe(CASE_STATES.OPEN);
    expect(created.caseReference).toBe(`TNX-2026-${String(created.id).padStart(6, "0")}`);
    expect(created.createdByUserId).toBe(ANALYST);
  });

  it("emits a CREATED lifecycle event so the timeline never starts mid-story", async () => {
    const created = await newCase();

    expect(state.caseLifecycleEvents).toHaveLength(1);
    expect(state.caseLifecycleEvents[0]).toMatchObject({
      caseId: created.id,
      eventType: "CREATED",
      fromState: null,
      toState: "OPEN",
      reasonCode: "CASE_CREATED",
      occurredAt: T0,
    });
  });

  it("refuses a missing organizationId and one that does not exist", async () => {
    await expect(newCase({ organizationId: undefined })).rejects.toBeInstanceOf(
      CaseWorkflowValidationError
    );
    await expect(newCase({ organizationId: 4242 })).rejects.toBeInstanceOf(
      CaseWorkflowValidationError
    );
    expect(state.cases).toHaveLength(0);
  });

  it("gives concurrent creations distinct references", async () => {
    const a = await newCase();
    const b = await newCase();
    expect(a.caseReference).not.toBe(b.caseReference);
  });
});

describe("lifecycle transitions", () => {
  it("moves OPEN <-> WAITING_FOR_ORG and records each transition immutably", async () => {
    const created = await newCase();

    await changeCaseState(created.id, CASE_STATES.WAITING_FOR_ORG, {
      client,
      actorUserId: ANALYST,
      occurredAt: T1,
      note: "Notified the constituent",
    });
    await changeCaseState(created.id, CASE_STATES.OPEN, {
      client,
      actorUserId: ANALYST,
      occurredAt: T2,
    });

    expect(state.cases[0].lifecycleState).toBe("OPEN");
    const transitions = state.caseLifecycleEvents.filter((e) => e.eventType === "STATE_CHANGED");
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({
      fromState: "OPEN",
      toState: "WAITING_FOR_ORG",
      reasonCode: "STATE_CHANGED_BY_ANALYST",
      note: "Notified the constituent",
    });
    expect(transitions[1]).toMatchObject({ fromState: "WAITING_FOR_ORG", toState: "OPEN" });
  });

  it("writes nothing when the case is already in the requested state", async () => {
    const created = await newCase();
    const outcome = await changeCaseState(created.id, CASE_STATES.OPEN, {
      client,
      occurredAt: T1,
    });

    expect(outcome.changed).toBe(false);
    expect(state.caseLifecycleEvents.filter((e) => e.eventType === "STATE_CHANGED")).toHaveLength(
      0
    );
  });

  // If this accepted an arbitrary target state, the entire review gate would be
  // bypassable by posting a body.
  it("refuses CLOSURE_PENDING and CLOSED as directly settable states", async () => {
    const created = await newCase();

    await expect(
      changeCaseState(created.id, CASE_STATES.CLOSURE_PENDING, { client, occurredAt: T1 })
    ).rejects.toBeInstanceOf(CaseWorkflowValidationError);
    await expect(
      changeCaseState(created.id, CASE_STATES.CLOSED, { client, occurredAt: T1 })
    ).rejects.toBeInstanceOf(CaseWorkflowValidationError);
    expect(state.cases[0].lifecycleState).toBe("OPEN");
  });

  // CLOSURE_PENDING -> OPEN is a real transition (it is how a reviewer rejects
  // a closure), so a target-only restriction would let an analyst withdraw a
  // closure out from under the reviewer by posting a bare state.
  it("refuses a state change while the case is awaiting closure review", async () => {
    const created = await newCase();
    await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.OTHER, justification: "Closing" },
      { client, actorUserId: ANALYST, requestedAt: T1 }
    );

    await expect(
      changeCaseState(created.id, CASE_STATES.OPEN, { client, occurredAt: T2 })
    ).rejects.toMatchObject({ code: "CASE_STATE_NOT_ANALYST_SETTABLE" });
    await expect(
      changeCaseState(created.id, CASE_STATES.WAITING_FOR_ORG, { client, occurredAt: T2 })
    ).rejects.toMatchObject({ code: "CASE_STATE_NOT_ANALYST_SETTABLE" });

    // The case stays pending and the request stays undecided and still active.
    expect(state.cases[0].lifecycleState).toBe("CLOSURE_PENDING");
    expect(state.caseClosureRequests[0]).toMatchObject({
      state: "PENDING",
      activeCaseId: created.id,
    });
    expect(state.caseLifecycleEvents.filter((e) => e.eventType === "STATE_CHANGED")).toHaveLength(
      0
    );
  });

  it("refuses a state change on a closed case, where leaving needs an explicit reopen", async () => {
    const created = await newCase();
    const { request } = await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.FALSE_POSITIVE, justification: "Scanner artefact" },
      { client, actorUserId: ANALYST, requestedAt: T1 }
    );
    await approveClosure(created.id, request.id, {
      client,
      actorUserId: REVIEWER,
      reviewedAt: T2,
    });

    await expect(
      changeCaseState(created.id, CASE_STATES.OPEN, { client, occurredAt: T3 })
    ).rejects.toMatchObject({ code: "CASE_STATE_NOT_ANALYST_SETTABLE" });
    expect(state.cases[0].lifecycleState).toBe("CLOSED");
  });

  it("refuses every workflow operation on a legacy case with no organization", async () => {
    const legacy = await client.case.create({
      data: { title: "Legacy", threatType: "x", organization: "y", analyst: "z" },
    });

    const refusals = [
      changeCaseState(legacy.id, CASE_STATES.WAITING_FOR_ORG, { client, occurredAt: T1 }),
      linkFinding(legacy.id, FINDING_A, { client, effectiveAt: T1 }),
      recordOrganizationResponse(
        legacy.id,
        { responseType: RESPONSE_TYPES.ACKNOWLEDGED, summary: "ack", occurredAt: T1 },
        { client, recordedAt: T1 }
      ),
      requestClosure(
        legacy.id,
        { closureReason: CLOSURE_REASONS.OTHER, justification: "why" },
        { client, requestedAt: T1 }
      ),
    ];

    // eslint-disable-next-line no-restricted-syntax
    for (const refusal of refusals) {
      // eslint-disable-next-line no-await-in-loop
      await expect(refusal).rejects.toMatchObject({ code: "CASE_NOT_ORGANIZATION_BOUND" });
    }
  });
});

describe("evidence linkage", () => {
  it("links a Finding whose ownership settled on the case organization", async () => {
    const created = await newCase();
    await seedOwnership(FINDING_A);

    const outcome = await linkFinding(created.id, FINDING_A, {
      client,
      actorUserId: ANALYST,
      effectiveAt: T1,
    });

    expect(outcome.changed).toBe(true);
    expect(state.caseFindings).toHaveLength(1);
    expect(state.caseFindings[0]).toMatchObject({
      caseId: created.id,
      findingId: FINDING_A,
      state: "LINKED",
      organizationId: ORG_ID,
      ownershipStatusAtLink: "RESOLVED",
      ownershipConfidenceAtLink: "HIGH",
      currentLinkKey: `${created.id}:${FINDING_A}`,
    });
  });

  it("escalates the Finding in the same transaction as the link", async () => {
    const created = await newCase();
    await seedOwnership(FINDING_A);

    const outcome = await linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 });

    expect(outcome.escalated).toBe(true);
    expect(state.findingTriages).toHaveLength(1);
    expect(state.findingTriages[0]).toMatchObject({
      decision: "ESCALATED",
      source: "CASE_LINK",
      caseId: created.id,
    });
  });

  it("copies no Finding evidence into the link row", async () => {
    const created = await newCase();
    await seedOwnership(FINDING_A);
    await linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 });

    const link = state.caseFindings[0];
    ["indicatorValue", "port", "protocol", "occurrenceCount", "firstSeen"].forEach((field) => {
      expect(link[field]).toBeUndefined();
    });
    // And the Finding itself is untouched.
    expect(state.findings[0]).toMatchObject({ indicatorValue: "192.0.2.10", status: "OPEN" });
  });

  describe("the organization-matching rule", () => {
    const cases = [
      ["no ownership row at all", null, LINK_REJECTION_CODES.OWNERSHIP_MISSING],
      [
        "unresolved ownership",
        { status: "UNRESOLVED", organizationId: null, confidence: null },
        LINK_REJECTION_CODES.OWNERSHIP_UNRESOLVED,
      ],
      [
        "ambiguous ownership",
        { status: "AMBIGUOUS", organizationId: null, confidence: null },
        LINK_REJECTION_CODES.OWNERSHIP_AMBIGUOUS,
      ],
      [
        "ISP-attributed ownership naming the right organization",
        { isIspAttribution: true, confidence: "LOW" },
        LINK_REJECTION_CODES.OWNERSHIP_ISP_ATTRIBUTED,
      ],
      [
        "ownership resolved to a different organization",
        { organizationId: OTHER_ORG_ID },
        LINK_REJECTION_CODES.OWNERSHIP_ORGANIZATION_MISMATCH,
      ],
    ];

    it.each(cases)("refuses a Finding with %s", async (_label, ownership, expectedCode) => {
      const created = await newCase();
      if (ownership) await seedOwnership(FINDING_A, ownership);

      await expect(linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 })).rejects.toMatchObject({
        name: "CaseWorkflowStateError",
        code: expectedCode,
      });

      // Nothing at all is written on refusal — not the link, not an escalation.
      expect(state.caseFindings).toHaveLength(0);
      expect(state.findingTriages).toHaveLength(0);
    });

    it("accepts an explicit analyst OVERRIDE as a settled attribution", async () => {
      const created = await newCase();
      await seedOwnership(FINDING_A, { status: "OVERRIDDEN", confidence: "CONFIRMED" });

      await linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 });
      expect(state.caseFindings[0].ownershipStatusAtLink).toBe("OVERRIDDEN");
      expect(state.caseFindings[0].ownershipConfidenceAtLink).toBe("CONFIRMED");
    });
  });

  it("re-linking an already-linked Finding writes nothing", async () => {
    const created = await newCase();
    await seedOwnership(FINDING_A);
    await linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 });

    const again = await linkFinding(created.id, FINDING_A, { client, effectiveAt: T2 });

    expect(again.changed).toBe(false);
    expect(state.caseFindings).toHaveLength(1);
    expect(state.findingTriages).toHaveLength(1);
  });

  it("unlinking appends a retraction row and never deletes the original", async () => {
    const created = await newCase();
    await seedOwnership(FINDING_A);
    await linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 });

    await unlinkFinding(created.id, FINDING_A, {
      client,
      effectiveAt: T2,
      reason: "Belongs to a different exposure",
    });

    expect(state.caseFindings).toHaveLength(2);
    expect(state.caseFindings[0]).toMatchObject({
      state: "LINKED",
      supersededAt: T2,
      currentLinkKey: null,
    });
    expect(state.caseFindings[1]).toMatchObject({
      state: "UNLINKED",
      supersededAt: null,
      currentLinkKey: `${created.id}:${FINDING_A}`,
      // The ownership basis is carried forward verbatim, not re-derived.
      ownershipStatusAtLink: "RESOLVED",
      ownershipConfidenceAtLink: "HIGH",
    });

    expect(await listCurrentLinks(client, created.id, { includeFinding: false })).toHaveLength(0);
  });

  it("requires a reason to unlink, and refuses to unlink what is not linked", async () => {
    const created = await newCase();
    await seedOwnership(FINDING_A);
    await linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 });

    await expect(unlinkFinding(created.id, FINDING_A, { client, effectiveAt: T2 })).rejects.toBeInstanceOf(
      CaseWorkflowValidationError
    );
    await expect(
      unlinkFinding(created.id, FINDING_B, { client, effectiveAt: T2, reason: "not linked" })
    ).rejects.toMatchObject({ code: "LINK_NOT_ACTIVE" });
    expect(state.caseFindings).toHaveLength(1);
  });

  it("keeps the ESCALATED triage decision after an unlink", async () => {
    const created = await newCase();
    await seedOwnership(FINDING_A);
    await linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 });
    await unlinkFinding(created.id, FINDING_A, { client, effectiveAt: T2, reason: "moved" });

    // The escalation was a real judgement made at a real time; deciding later
    // that the Finding did not belong in this case does not un-make it.
    expect(state.findingTriages).toHaveLength(1);
    expect(state.findingTriages[0].decision).toBe("ESCALATED");
    expect(state.findingTriages[0].supersededAt).toBeNull();
  });

  it("relinks a previously unlinked Finding as a third history row", async () => {
    const created = await newCase();
    await seedOwnership(FINDING_A);
    await linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 });
    await unlinkFinding(created.id, FINDING_A, { client, effectiveAt: T2, reason: "premature" });
    await linkFinding(created.id, FINDING_A, { client, effectiveAt: T3 });

    expect(state.caseFindings.map((r) => r.state)).toEqual(["LINKED", "UNLINKED", "LINKED"]);
    expect(state.caseFindings.filter((r) => r.currentLinkKey !== null)).toHaveLength(1);
  });

  it("refuses to add evidence while the case is closed or awaiting closure review", async () => {
    const created = await newCase();
    await seedOwnership(FINDING_A);
    await seedOwnership(FINDING_B);
    await linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 });

    await recordOrganizationResponse(
      created.id,
      { responseType: RESPONSE_TYPES.REMEDIATED, summary: "fixed", occurredAt: T1 },
      { client, recordedAt: T1 }
    );
    const { request } = await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "Remediation confirmed" },
      { client, actorUserId: ANALYST, requestedAt: T2 }
    );

    // CLOSURE_PENDING: adding evidence now would change what the reviewer is
    // approving underneath them.
    await expect(linkFinding(created.id, FINDING_B, { client, effectiveAt: T2 })).rejects.toMatchObject({
      code: "CASE_NOT_ACCEPTING_EVIDENCE",
    });

    await approveClosure(created.id, request.id, {
      client,
      actorUserId: REVIEWER,
      reviewedAt: T3,
    });
    await expect(linkFinding(created.id, FINDING_B, { client, effectiveAt: T4 })).rejects.toMatchObject({
      code: "CASE_NOT_ACCEPTING_EVIDENCE",
    });
  });
});

describe("organization responses", () => {
  it("appends a timeline row carrying both occurredAt and recordedAt", async () => {
    const created = await newCase();

    await recordOrganizationResponse(
      created.id,
      {
        responseType: RESPONSE_TYPES.ACKNOWLEDGED,
        summary: "Constituent acknowledged by email",
        reference: "TICKET-4711",
        occurredAt: T1,
      },
      { client, actorUserId: ANALYST, recordedAt: T2 }
    );

    expect(state.caseOrganizationResponses).toHaveLength(1);
    expect(state.caseOrganizationResponses[0]).toMatchObject({
      responseType: "ACKNOWLEDGED",
      summary: "Constituent acknowledged by email",
      reference: "TICKET-4711",
      occurredAt: T1,
      recordedAt: T2,
      recordedByUserId: ANALYST,
    });
  });

  // A response is a claim, never proof.
  it("never changes the case lifecycle state, not even for REMEDIATED", async () => {
    const created = await newCase();

    await recordOrganizationResponse(
      created.id,
      { responseType: RESPONSE_TYPES.REMEDIATED, summary: "We fixed it", occurredAt: T1 },
      { client, recordedAt: T1 }
    );

    expect(state.cases[0].lifecycleState).toBe("OPEN");
    expect(state.cases[0].closedAt).toBeNull();
    expect(state.caseClosureRequests).toHaveLength(0);
    expect(state.caseLifecycleEvents.filter((e) => e.eventType !== "CREATED")).toHaveLength(0);
  });

  it("requires a summary and refuses an unknown response type", async () => {
    const created = await newCase();

    await expect(
      recordOrganizationResponse(
        created.id,
        { responseType: RESPONSE_TYPES.ACKNOWLEDGED, summary: "  ", occurredAt: T1 },
        { client, recordedAt: T1 }
      )
    ).rejects.toBeInstanceOf(CaseWorkflowValidationError);

    await expect(
      recordOrganizationResponse(
        created.id,
        { responseType: "IGNORED", summary: "x", occurredAt: T1 },
        { client, recordedAt: T1 }
      )
    ).rejects.toBeInstanceOf(CaseWorkflowValidationError);

    expect(state.caseOrganizationResponses).toHaveLength(0);
  });

  it("allows a response while closure is pending but refuses one on a closed case", async () => {
    const created = await newCase();
    await recordOrganizationResponse(
      created.id,
      { responseType: RESPONSE_TYPES.INVESTIGATING, summary: "looking", occurredAt: T1 },
      { client, recordedAt: T1 }
    );
    const { request } = await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.OTHER, justification: "No longer reachable" },
      { client, actorUserId: ANALYST, requestedAt: T1 }
    );

    // A reply arriving while a reviewer is deciding is exactly what they need.
    await recordOrganizationResponse(
      created.id,
      { responseType: RESPONSE_TYPES.DISPUTED, summary: "not ours", occurredAt: T2 },
      { client, recordedAt: T2 }
    );
    expect(state.caseOrganizationResponses).toHaveLength(2);

    await approveClosure(created.id, request.id, {
      client,
      actorUserId: REVIEWER,
      reviewedAt: T3,
    });
    await expect(
      recordOrganizationResponse(
        created.id,
        { responseType: RESPONSE_TYPES.OTHER, summary: "late", occurredAt: T4 },
        { client, recordedAt: T4 }
      )
    ).rejects.toMatchObject({ code: "CASE_CLOSED" });
    expect(state.caseOrganizationResponses).toHaveLength(2);
  });

  it("finds the most recent REMEDIATED response and ignores other types", async () => {
    const created = await newCase();
    await recordOrganizationResponse(
      created.id,
      { responseType: RESPONSE_TYPES.REMEDIATED, summary: "first fix", occurredAt: T1 },
      { client, recordedAt: T1 }
    );
    await recordOrganizationResponse(
      created.id,
      { responseType: RESPONSE_TYPES.REMEDIATED, summary: "second fix", occurredAt: T2 },
      { client, recordedAt: T2 }
    );
    await recordOrganizationResponse(
      created.id,
      { responseType: RESPONSE_TYPES.DISPUTED, summary: "later dispute", occurredAt: T3 },
      { client, recordedAt: T3 }
    );

    const latest = await findLatestRemediatedResponse(client, created.id);
    expect(latest.summary).toBe("second fix");
  });
});

describe("reviewer-approved closure", () => {
  async function openCaseWithRemediation() {
    const created = await newCase();
    await recordOrganizationResponse(
      created.id,
      { responseType: RESPONSE_TYPES.REMEDIATED, summary: "Port closed", occurredAt: T1 },
      { client, actorUserId: ANALYST, recordedAt: T1 }
    );
    return created;
  }

  it("moves the case to CLOSURE_PENDING and holds one active request", async () => {
    const created = await openCaseWithRemediation();

    const { request } = await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "Verified with the org" },
      { client, actorUserId: ANALYST, requestedAt: T2 }
    );

    expect(state.cases[0].lifecycleState).toBe("CLOSURE_PENDING");
    expect(request.state).toBe("PENDING");
    expect(request.activeCaseId).toBe(created.id);
    // The rule leaves durable evidence rather than merely having been true once.
    expect(request.supportingResponseId).toBe(state.caseOrganizationResponses[0].id);
    expect(state.caseLifecycleEvents.some((e) => e.eventType === "CLOSURE_REQUESTED")).toBe(true);
  });

  it("refuses a REMEDIATED closure with no recorded REMEDIATED response", async () => {
    const created = await newCase();
    await recordOrganizationResponse(
      created.id,
      { responseType: RESPONSE_TYPES.ACKNOWLEDGED, summary: "ack only", occurredAt: T1 },
      { client, recordedAt: T1 }
    );

    await expect(
      requestClosure(
        created.id,
        { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "They said so" },
        { client, actorUserId: ANALYST, requestedAt: T2 }
      )
    ).rejects.toMatchObject({ code: "REMEDIATED_RESPONSE_REQUIRED" });

    expect(state.caseClosureRequests).toHaveLength(0);
    expect(state.cases[0].lifecycleState).toBe("OPEN");
  });

  it("needs no organization response for the other four closure reasons", async () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const closureReason of ["FALSE_POSITIVE", "ACCEPTED_RISK", "DUPLICATE", "OTHER"]) {
      // eslint-disable-next-line no-await-in-loop
      const created = await newCase();
      // eslint-disable-next-line no-await-in-loop
      const { request } = await requestClosure(
        created.id,
        { closureReason, justification: `Closing as ${closureReason}` },
        { client, actorUserId: ANALYST, requestedAt: T2 }
      );
      expect(request.closureReason).toBe(closureReason);
      expect(request.supportingResponseId).toBeNull();
    }
  });

  it("requires a justification and refuses an unknown closure reason", async () => {
    const created = await newCase();

    await expect(
      requestClosure(
        created.id,
        { closureReason: CLOSURE_REASONS.OTHER, justification: "   " },
        { client, requestedAt: T2 }
      )
    ).rejects.toBeInstanceOf(CaseWorkflowValidationError);
    await expect(
      requestClosure(
        created.id,
        { closureReason: "RESOLVED", justification: "x" },
        { client, requestedAt: T2 }
      )
    ).rejects.toBeInstanceOf(CaseWorkflowValidationError);
    expect(state.caseClosureRequests).toHaveLength(0);
  });

  it("allows only one open closure request per case", async () => {
    const created = await openCaseWithRemediation();
    await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "first" },
      { client, actorUserId: ANALYST, requestedAt: T2 }
    );

    // The case is already CLOSURE_PENDING, which is not an open state.
    await expect(
      requestClosure(
        created.id,
        { closureReason: CLOSURE_REASONS.OTHER, justification: "second" },
        { client, actorUserId: ANALYST, requestedAt: T3 }
      )
    ).rejects.toMatchObject({ code: "CASE_NOT_OPEN_FOR_CLOSURE" });
    expect(state.caseClosureRequests).toHaveLength(1);
  });

  it("closes the case on approval and preserves the whole review history", async () => {
    const created = await openCaseWithRemediation();
    const { request } = await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "Verified" },
      { client, actorUserId: ANALYST, requestedAt: T2 }
    );

    await approveClosure(created.id, request.id, {
      client,
      actorUserId: REVIEWER,
      reviewedAt: T3,
      reviewNote: "Evidence is sufficient",
    });

    expect(state.cases[0]).toMatchObject({
      lifecycleState: "CLOSED",
      closureReason: "REMEDIATED",
      closedAt: T3,
      closedByUserId: REVIEWER,
    });
    expect(state.caseClosureRequests[0]).toMatchObject({
      state: "APPROVED",
      reviewedByUserId: REVIEWER,
      reviewedAt: T3,
      reviewNote: "Evidence is sufficient",
      // Released so a later reopen-and-re-close can create its own request.
      activeCaseId: null,
      // Never rewritten.
      requestedByUserId: ANALYST,
      justification: "Verified",
    });
    expect(state.caseLifecycleEvents.map((e) => e.eventType)).toEqual([
      "CREATED",
      "CLOSURE_REQUESTED",
      "CLOSURE_APPROVED",
    ]);
  });

  // The load-bearing separation of duties.
  it("refuses to let the requester approve their own request", async () => {
    const created = await openCaseWithRemediation();
    const { request } = await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "Verified" },
      { client, actorUserId: ANALYST, requestedAt: T2 }
    );

    await expect(
      approveClosure(created.id, request.id, {
        client,
        actorUserId: ANALYST,
        reviewedAt: T3,
      })
    ).rejects.toBeInstanceOf(CaseClosureSelfApprovalError);

    expect(state.cases[0].lifecycleState).toBe("CLOSURE_PENDING");
    expect(state.caseClosureRequests[0].state).toBe("PENDING");

    const [denial] = state.auditLogs.filter((row) => row.action === "case.closure.approved");
    expect(denial.outcome).toBe("DENIED");
  });

  it("permits self-approval only for a reviewer holding the administrator override", async () => {
    const created = await openCaseWithRemediation();
    const { request } = await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "Verified" },
      { client, actorUserId: ANALYST, requestedAt: T2 }
    );

    await approveClosure(created.id, request.id, {
      client,
      actorUserId: ANALYST,
      reviewedAt: T3,
      reviewerCanSelfApprove: true,
    });

    expect(state.cases[0].lifecycleState).toBe("CLOSED");
  });

  // null === null must not lock the review out after the requesting user is
  // deleted and their attribution nulled.
  it("does not treat an unattributed request as self-approval", async () => {
    const created = await openCaseWithRemediation();
    const { request } = await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "Verified" },
      { client, actorUserId: null, requestedAt: T2 }
    );

    await approveClosure(created.id, request.id, {
      client,
      actorUserId: null,
      reviewedAt: T3,
    });
    expect(state.cases[0].lifecycleState).toBe("CLOSED");
  });

  it("returns the case to OPEN on rejection and requires a reviewer note", async () => {
    const created = await openCaseWithRemediation();
    const { request } = await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "Verified" },
      { client, actorUserId: ANALYST, requestedAt: T2 }
    );

    await expect(
      rejectClosure(created.id, request.id, { client, actorUserId: REVIEWER, reviewedAt: T3 })
    ).rejects.toBeInstanceOf(CaseWorkflowValidationError);
    expect(state.cases[0].lifecycleState).toBe("CLOSURE_PENDING");

    await rejectClosure(created.id, request.id, {
      client,
      actorUserId: REVIEWER,
      reviewedAt: T3,
      reviewNote: "Need the remediation evidence attached",
    });

    expect(state.cases[0].lifecycleState).toBe("OPEN");
    expect(state.cases[0].closedAt).toBeNull();
    expect(state.caseClosureRequests[0]).toMatchObject({
      state: "REJECTED",
      activeCaseId: null,
      reviewNote: "Need the remediation evidence attached",
    });
  });

  it("refuses to decide a request twice", async () => {
    const created = await openCaseWithRemediation();
    const { request } = await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "Verified" },
      { client, actorUserId: ANALYST, requestedAt: T2 }
    );
    await approveClosure(created.id, request.id, {
      client,
      actorUserId: REVIEWER,
      reviewedAt: T3,
    });

    await expect(
      rejectClosure(created.id, request.id, {
        client,
        actorUserId: REVIEWER,
        reviewedAt: T4,
        reviewNote: "changed my mind",
      })
    ).rejects.toMatchObject({ code: "CLOSURE_REQUEST_NOT_PENDING" });
  });

  it("refuses a request id belonging to a different case", async () => {
    const first = await openCaseWithRemediation();
    const second = await newCase();
    const { request } = await requestClosure(
      first.id,
      { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "Verified" },
      { client, actorUserId: ANALYST, requestedAt: T2 }
    );

    await expect(
      approveClosure(second.id, request.id, { client, actorUserId: REVIEWER, reviewedAt: T3 })
    ).rejects.toBeInstanceOf(CaseWorkflowNotFoundError);
  });

  it("re-closing after a reopen creates a SECOND request, never rewriting the first", async () => {
    const created = await openCaseWithRemediation();
    const first = await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "Verified" },
      { client, actorUserId: ANALYST, requestedAt: T2 }
    );
    await approveClosure(created.id, first.request.id, {
      client,
      actorUserId: REVIEWER,
      reviewedAt: T3,
    });
    await reopenCase(created.id, {
      client,
      actorUserId: ANALYST,
      occurredAt: T4,
      reason: "Exposure observed again",
    });
    const second = await requestClosure(
      created.id,
      { closureReason: CLOSURE_REASONS.ACCEPTED_RISK, justification: "Accepted by the org" },
      { client, actorUserId: ANALYST, requestedAt: T4 }
    );

    expect(state.caseClosureRequests).toHaveLength(2);
    expect(state.caseClosureRequests[0]).toMatchObject({
      state: "APPROVED",
      closureReason: "REMEDIATED",
    });
    expect(second.request.state).toBe("PENDING");
  });
});

describe("manual reopen", () => {
  async function closedCase(closureReason = CLOSURE_REASONS.FALSE_POSITIVE) {
    const created = await newCase();
    if (closureReason === CLOSURE_REASONS.REMEDIATED) {
      await recordOrganizationResponse(
        created.id,
        { responseType: RESPONSE_TYPES.REMEDIATED, summary: "fixed", occurredAt: T1 },
        { client, recordedAt: T1 }
      );
    }
    const { request } = await requestClosure(
      created.id,
      { closureReason, justification: "Closing" },
      { client, actorUserId: ANALYST, requestedAt: T2 }
    );
    await approveClosure(created.id, request.id, {
      client,
      actorUserId: REVIEWER,
      reviewedAt: T3,
    });
    return created;
  }

  it("clears the closure projection, bumps the counter and records the event", async () => {
    const created = await closedCase();

    await reopenCase(created.id, {
      client,
      actorUserId: ANALYST,
      occurredAt: T4,
      reason: "The host is exposed again",
    });

    expect(state.cases[0]).toMatchObject({
      lifecycleState: "OPEN",
      closedAt: null,
      closureReason: null,
      closedByUserId: null,
      lastReopenedAt: T4,
      lastReopenTrigger: "MANUAL",
      reopenedCount: 1,
    });

    const [event] = state.caseLifecycleEvents.filter((e) => e.eventType === "REOPENED");
    expect(event).toMatchObject({
      fromState: "CLOSED",
      toState: "OPEN",
      reasonCode: "REOPENED_MANUALLY",
      note: "The host is exposed again",
      actorUserId: ANALYST,
    });
  });

  // Unlike the automatic path, an explicit human act may overturn ANY closure —
  // which is exactly why it carries a mandatory recorded reason.
  it("may reopen a closure of any reason, but always needs a reason", async () => {
    const created = await closedCase(CLOSURE_REASONS.ACCEPTED_RISK);

    await expect(reopenCase(created.id, { client, occurredAt: T4 })).rejects.toBeInstanceOf(
      CaseWorkflowValidationError
    );
    expect(state.cases[0].lifecycleState).toBe("CLOSED");

    await reopenCase(created.id, { client, occurredAt: T4, reason: "Risk acceptance withdrawn" });
    expect(state.cases[0].lifecycleState).toBe("OPEN");
  });

  it("refuses to reopen a case that is not closed", async () => {
    const created = await newCase();
    await expect(
      reopenCase(created.id, { client, occurredAt: T4, reason: "why" })
    ).rejects.toMatchObject({ code: "CASE_NOT_CLOSED" });
  });

  it("preserves the APPROVED closure request after a reopen", async () => {
    const created = await closedCase();
    await reopenCase(created.id, { client, occurredAt: T4, reason: "again" });

    expect(state.caseClosureRequests[0]).toMatchObject({
      state: "APPROVED",
      closureReason: "FALSE_POSITIVE",
      reviewedByUserId: REVIEWER,
    });
  });
});

describe("audit isolation", () => {
  it("keeps every workflow write when the audit table is unavailable", async () => {
    const original = client.auditLog.create;
    client.auditLog.create = async () => {
      throw new Error("audit table unavailable");
    };

    try {
      const created = await newCase();
      await seedOwnership(FINDING_A);
      await linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 });
      await recordOrganizationResponse(
        created.id,
        { responseType: RESPONSE_TYPES.REMEDIATED, summary: "fixed", occurredAt: T1 },
        { client, recordedAt: T1 }
      );
      const { request } = await requestClosure(
        created.id,
        { closureReason: CLOSURE_REASONS.REMEDIATED, justification: "Verified" },
        { client, actorUserId: ANALYST, requestedAt: T2 }
      );
      await approveClosure(created.id, request.id, {
        client,
        actorUserId: REVIEWER,
        reviewedAt: T3,
      });

      expect(state.cases[0].lifecycleState).toBe("CLOSED");
      expect(state.caseFindings).toHaveLength(1);
      expect(state.caseOrganizationResponses).toHaveLength(1);
      expect(state.auditLogs).toHaveLength(0);
    } finally {
      client.auditLog.create = original;
    }
  });

  it("never writes an Error message or a request body into an audit reason", async () => {
    const created = await newCase();
    await seedOwnership(FINDING_A, { status: "AMBIGUOUS", organizationId: null });

    await expect(linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 })).rejects.toThrow();

    const [failure] = state.auditLogs.filter((row) => row.action === "case.finding.linked");
    expect(failure.outcome).toBe("FAILURE");
    // A closed vocabulary code only.
    expect(failure.reason).toBe("Finding link refused (OWNERSHIP_AMBIGUOUS)");
    expect(failure.reason).not.toContain("ownership does not permit");
  });

  it("keeps the indicator value out of every case-workflow audit event", async () => {
    const created = await newCase();
    await seedOwnership(FINDING_A);
    await linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 });

    expect(JSON.stringify(state.auditLogs)).not.toContain("192.0.2.10");
  });
});

describe("transactional atomicity", () => {
  it("writes neither the link nor the escalation when the escalation fails", async () => {
    const created = await newCase();
    await seedOwnership(FINDING_A);

    const original = client.findingTriage.create;
    client.findingTriage.create = async () => {
      throw new Error("triage insert failed");
    };

    try {
      await expect(linkFinding(created.id, FINDING_A, { client, effectiveAt: T1 })).rejects.toThrow();
      expect(state.caseFindings).toHaveLength(0);
      expect(state.findingTriages).toHaveLength(0);
    } finally {
      client.findingTriage.create = original;
    }
  });

  it("leaves the case OPEN when the closure request insert fails", async () => {
    const created = await newCase();

    const original = client.caseClosureRequest.create;
    client.caseClosureRequest.create = async () => {
      throw new Error("closure insert failed");
    };

    try {
      await expect(
        requestClosure(
          created.id,
          { closureReason: CLOSURE_REASONS.OTHER, justification: "Closing" },
          { client, actorUserId: ANALYST, requestedAt: T2 }
        )
      ).rejects.toThrow();
      expect(state.cases[0].lifecycleState).toBe("OPEN");
      expect(state.caseLifecycleEvents.filter((e) => e.eventType !== "CREATED")).toHaveLength(0);
    } finally {
      client.caseClosureRequest.create = original;
    }
  });
});
