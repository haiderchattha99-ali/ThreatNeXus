import { describe, it, expect } from "vitest";

// Pure Phase 3 rule tests. No Prisma, no clock, no HTTP.
//
// These cover the decisions the whole milestone rests on: which lifecycle
// transitions exist at all, when a Finding may become case evidence, when an
// escalation is worth recording, and which closures a recurrence is allowed to
// overturn on its own.

const {
  UNTRIAGED,
  TRIAGE_DECISIONS,
  TRIAGE_DECISION_VALUES,
  TRIAGE_DECISIONS_REQUIRING_REASON,
  CASE_STATES,
  CASE_STATE_VALUES,
  ALLOWED_TRANSITIONS,
  ANALYST_SETTABLE_STATES,
  CLOSURE_REASONS,
  CLOSURE_REASON_VALUES,
  AUTO_REOPENABLE_CLOSURE_REASONS,
  CLOSURE_REASONS_REQUIRING_REMEDIATED_RESPONSE,
  RESPONSE_TYPE_VALUES,
  LINK_REJECTION_CODES,
  MAX_TRIAGE_REASON_LENGTH,
  CaseWorkflowValidationError,
  CaseWorkflowStateError,
  normalizeBoundedText,
  assertMemberOf,
  assertPositiveInteger,
  assertValidDate,
  isTransitionAllowed,
  analystAvailableStates,
  assertTransitionAllowed,
  evaluateLinkEligibility,
  isEscalationMeaningful,
  qualifiesForRecurrenceReopen,
  formatCaseReference,
} = require("../../src/services/workflow/caseWorkflowRules");

describe("closed vocabularies", () => {
  it("triage is exactly the three locked decisions, and UNTRIAGED is not one of them", () => {
    expect(TRIAGE_DECISION_VALUES).toEqual(["IN_REVIEW", "ESCALATED", "DISMISSED"]);
    // UNTRIAGED is the ABSENCE of a row. Making it a decision value would mean
    // every Finding ever ingested acquires triage history it never received.
    expect(TRIAGE_DECISION_VALUES).not.toContain(UNTRIAGED);
    expect(UNTRIAGED).toBe("UNTRIAGED");
  });

  it("only DISMISSED requires a reason", () => {
    expect(TRIAGE_DECISIONS_REQUIRING_REASON).toEqual([TRIAGE_DECISIONS.DISMISSED]);
  });

  it("case states, response types and closure reasons match the locked contract", () => {
    expect(CASE_STATE_VALUES).toEqual([
      "OPEN",
      "WAITING_FOR_ORG",
      "CLOSURE_PENDING",
      "CLOSED",
    ]);
    expect(RESPONSE_TYPE_VALUES).toEqual([
      "ACKNOWLEDGED",
      "INVESTIGATING",
      "REMEDIATED",
      "DISPUTED",
      "NO_RESPONSE",
      "OTHER",
    ]);
    expect(CLOSURE_REASON_VALUES).toEqual([
      "REMEDIATED",
      "FALSE_POSITIVE",
      "ACCEPTED_RISK",
      "DUPLICATE",
      "OTHER",
    ]);
  });
});

describe("lifecycle transition table", () => {
  it("permits exactly the locked transitions", () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      OPEN: ["WAITING_FOR_ORG", "CLOSURE_PENDING"],
      WAITING_FOR_ORG: ["OPEN", "CLOSURE_PENDING"],
      CLOSURE_PENDING: ["CLOSED", "OPEN"],
      CLOSED: ["OPEN"],
    });
  });

  it("refuses every transition not in the table, including self-transitions", () => {
    const forbidden = [
      ["OPEN", "CLOSED"],
      ["OPEN", "OPEN"],
      ["WAITING_FOR_ORG", "CLOSED"],
      ["CLOSED", "CLOSURE_PENDING"],
      ["CLOSED", "WAITING_FOR_ORG"],
      ["CLOSED", "CLOSED"],
      ["CLOSURE_PENDING", "WAITING_FOR_ORG"],
      ["CLOSURE_PENDING", "CLOSURE_PENDING"],
    ];
    forbidden.forEach(([from, to]) => {
      expect(isTransitionAllowed(from, to)).toBe(false);
      expect(() => assertTransitionAllowed(from, to)).toThrow(CaseWorkflowStateError);
    });
  });

  it("treats an unknown state as unreachable rather than defaulting", () => {
    expect(isTransitionAllowed("ARCHIVED", "OPEN")).toBe(false);
    expect(isTransitionAllowed("OPEN", "ARCHIVED")).toBe(false);
  });

  // The single most security-relevant fact in this file: an analyst posting a
  // bare target state can only reach OPEN or WAITING_FOR_ORG. CLOSURE_PENDING
  // needs a closure request, CLOSED needs a reviewer approval. If either were
  // settable here the entire review gate would be bypassable by a request body.
  it("never lets an analyst set CLOSURE_PENDING or CLOSED directly", () => {
    expect(ANALYST_SETTABLE_STATES).toEqual([CASE_STATES.OPEN, CASE_STATES.WAITING_FOR_ORG]);
    expect(ANALYST_SETTABLE_STATES).not.toContain(CASE_STATES.CLOSURE_PENDING);
    expect(ANALYST_SETTABLE_STATES).not.toContain(CASE_STATES.CLOSED);
  });
});

describe("analystAvailableStates", () => {
  it("offers the opposite of the two open states", () => {
    expect(analystAvailableStates(CASE_STATES.OPEN)).toEqual([CASE_STATES.WAITING_FOR_ORG]);
    expect(analystAvailableStates(CASE_STATES.WAITING_FOR_ORG)).toEqual([CASE_STATES.OPEN]);
  });

  // CLOSURE_PENDING -> OPEN IS in the transition table, because that is how a
  // REVIEWER rejects a closure. Restricting only the target would therefore let
  // an analyst post {toState: "OPEN"} on a case awaiting review and silently
  // withdraw the closure out from under the reviewer, orphaning the PENDING
  // request. The source is constrained as tightly as the target.
  it("offers nothing while the case is awaiting closure review", () => {
    expect(isTransitionAllowed(CASE_STATES.CLOSURE_PENDING, CASE_STATES.OPEN)).toBe(true);
    expect(analystAvailableStates(CASE_STATES.CLOSURE_PENDING)).toEqual([]);
  });

  it("offers nothing on a closed case, where leaving requires an explicit reopen", () => {
    expect(isTransitionAllowed(CASE_STATES.CLOSED, CASE_STATES.OPEN)).toBe(true);
    expect(analystAvailableStates(CASE_STATES.CLOSED)).toEqual([]);
  });

  it("offers nothing for an unknown state", () => {
    expect(analystAvailableStates("ARCHIVED")).toEqual([]);
    expect(analystAvailableStates(null)).toEqual([]);
  });
});

describe("evaluateLinkEligibility", () => {
  const caseRecord = { organizationId: 7 };
  const ownership = (overrides) => ({
    status: "RESOLVED",
    confidence: "HIGH",
    organizationId: 7,
    isIspAttribution: false,
    ...overrides,
  });

  it("accepts RESOLVED and OVERRIDDEN ownership on the case's own organization", () => {
    ["RESOLVED", "OVERRIDDEN"].forEach((status) => {
      const verdict = evaluateLinkEligibility(caseRecord, ownership({ status }));
      expect(verdict).toEqual({
        allowed: true,
        code: null,
        ownershipStatus: status,
        ownershipConfidence: "HIGH",
      });
    });
  });

  it("rejects a Finding with no ownership row at all", () => {
    expect(evaluateLinkEligibility(caseRecord, null)).toEqual({
      allowed: false,
      code: LINK_REJECTION_CODES.OWNERSHIP_MISSING,
      ownershipStatus: null,
      ownershipConfidence: null,
    });
  });

  it("rejects unresolved and ambiguous ownership with distinguishable codes", () => {
    expect(evaluateLinkEligibility(caseRecord, ownership({ status: "UNRESOLVED" })).code).toBe(
      LINK_REJECTION_CODES.OWNERSHIP_UNRESOLVED
    );
    expect(evaluateLinkEligibility(caseRecord, ownership({ status: "AMBIGUOUS" })).code).toBe(
      LINK_REJECTION_CODES.OWNERSHIP_AMBIGUOUS
    );
  });

  it("rejects a mismatched organization", () => {
    const verdict = evaluateLinkEligibility(caseRecord, ownership({ organizationId: 8 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe(LINK_REJECTION_CODES.OWNERSHIP_ORGANIZATION_MISMATCH);
  });

  // Ordering matters and is deliberate: an ISP-attributed row can name the
  // right organization id and still be the wrong answer, because it identifies
  // the upstream provider rather than the constituent. Reporting "mismatch"
  // there would send the analyst to fix the wrong thing.
  it("reports ISP attribution ahead of the organization comparison", () => {
    const matchingIsp = ownership({ isIspAttribution: true, organizationId: 7 });
    expect(evaluateLinkEligibility(caseRecord, matchingIsp).code).toBe(
      LINK_REJECTION_CODES.OWNERSHIP_ISP_ATTRIBUTED
    );

    const mismatchedIsp = ownership({ isIspAttribution: true, organizationId: 8 });
    expect(evaluateLinkEligibility(caseRecord, mismatchedIsp).code).toBe(
      LINK_REJECTION_CODES.OWNERSHIP_ISP_ATTRIBUTED
    );
  });

  it("fails closed for an ownership status a future migration might add", () => {
    const verdict = evaluateLinkEligibility(caseRecord, ownership({ status: "PROVISIONAL" }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe(LINK_REJECTION_CODES.OWNERSHIP_UNRESOLVED);
  });

  it("rejects a null organizationId on either side rather than matching null to null", () => {
    expect(evaluateLinkEligibility({ organizationId: null }, ownership()).allowed).toBe(false);
    expect(
      evaluateLinkEligibility(caseRecord, ownership({ organizationId: null })).allowed
    ).toBe(false);
    expect(
      evaluateLinkEligibility({ organizationId: null }, ownership({ organizationId: null })).allowed
    ).toBe(false);
  });
});

describe("isEscalationMeaningful", () => {
  it("is true for untriaged, in-review and dismissed Findings", () => {
    [UNTRIAGED, TRIAGE_DECISIONS.IN_REVIEW, TRIAGE_DECISIONS.DISMISSED].forEach((decision) => {
      expect(isEscalationMeaningful(decision)).toBe(true);
    });
  });

  // Without this guard every re-link and every recurrence would append an
  // identical row, and triage history would stop being a record of decisions.
  it("is false when the Finding is already escalated", () => {
    expect(isEscalationMeaningful(TRIAGE_DECISIONS.ESCALATED)).toBe(false);
  });
});

describe("qualifiesForRecurrenceReopen", () => {
  it("requires BOTH a CLOSED case and a REMEDIATED closure reason", () => {
    expect(
      qualifiesForRecurrenceReopen({ lifecycleState: "CLOSED", closureReason: "REMEDIATED" })
    ).toBe(true);
    expect(
      qualifiesForRecurrenceReopen({ lifecycleState: "OPEN", closureReason: "REMEDIATED" })
    ).toBe(false);
    expect(
      qualifiesForRecurrenceReopen({ lifecycleState: "CLOSED", closureReason: null })
    ).toBe(false);
    expect(qualifiesForRecurrenceReopen(null)).toBe(false);
  });

  // Every other closure was decided in full knowledge that the finding would
  // keep being observed. Reopening them on the next report would silently
  // overturn a human decision on a schedule.
  it("never auto-reopens a FALSE_POSITIVE, ACCEPTED_RISK, DUPLICATE or OTHER closure", () => {
    ["FALSE_POSITIVE", "ACCEPTED_RISK", "DUPLICATE", "OTHER"].forEach((closureReason) => {
      expect(qualifiesForRecurrenceReopen({ lifecycleState: "CLOSED", closureReason })).toBe(
        false
      );
    });
    expect(AUTO_REOPENABLE_CLOSURE_REASONS).toEqual([CLOSURE_REASONS.REMEDIATED]);
  });

  it("ties the REMEDIATED-response precondition to the REMEDIATED reason only", () => {
    expect(CLOSURE_REASONS_REQUIRING_REMEDIATED_RESPONSE).toEqual([CLOSURE_REASONS.REMEDIATED]);
  });
});

describe("normalizeBoundedText", () => {
  const field = "reason";
  const opts = (required) => ({ field, maxLength: MAX_TRIAGE_REASON_LENGTH, required });

  it("trims and returns well-formed text", () => {
    expect(normalizeBoundedText("  looks exploitable  ", opts(false))).toBe("looks exploitable");
  });

  it("treats null, undefined and whitespace-only as absent", () => {
    [null, undefined, "   ", "\n\t"].forEach((value) => {
      expect(normalizeBoundedText(value, opts(false))).toBeNull();
      expect(() => normalizeBoundedText(value, opts(true))).toThrow(CaseWorkflowValidationError);
    });
  });

  it("rejects a non-string rather than coercing it", () => {
    [42, {}, [], true].forEach((value) => {
      expect(() => normalizeBoundedText(value, opts(false))).toThrow(CaseWorkflowValidationError);
    });
  });

  // Rejecting rather than truncating is deliberate: an analyst whose
  // justification was quietly cut in half would believe they recorded
  // something they did not.
  it("rejects over-length text instead of silently truncating it", () => {
    const tooLong = "x".repeat(MAX_TRIAGE_REASON_LENGTH + 1);
    expect(() => normalizeBoundedText(tooLong, opts(false))).toThrow(CaseWorkflowValidationError);
    expect(normalizeBoundedText("x".repeat(MAX_TRIAGE_REASON_LENGTH), opts(false))).toHaveLength(
      MAX_TRIAGE_REASON_LENGTH
    );
  });

  it("names the offending field on the error", () => {
    try {
      normalizeBoundedText(undefined, opts(true));
      throw new Error("expected a validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(CaseWorkflowValidationError);
      expect(error.fields).toEqual([field]);
    }
  });
});

describe("primitive guards", () => {
  it("assertMemberOf refuses a value outside the closed vocabulary", () => {
    expect(assertMemberOf("ESCALATED", TRIAGE_DECISION_VALUES, "decision")).toBe("ESCALATED");
    expect(() => assertMemberOf("escalated", TRIAGE_DECISION_VALUES, "decision")).toThrow(
      CaseWorkflowValidationError
    );
    expect(() => assertMemberOf(undefined, TRIAGE_DECISION_VALUES, "decision")).toThrow(
      CaseWorkflowValidationError
    );
  });

  it("assertPositiveInteger refuses zero, negatives, floats and numeric strings", () => {
    expect(assertPositiveInteger(1, "id")).toBe(1);
    [0, -1, 1.5, "1", null, undefined, NaN].forEach((value) => {
      expect(() => assertPositiveInteger(value, "id")).toThrow(CaseWorkflowValidationError);
    });
  });

  it("assertValidDate refuses a non-Date and an Invalid Date", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    expect(assertValidDate(now, "decidedAt")).toBe(now);
    [new Date("nonsense"), "2026-08-01", 1754006400000, null].forEach((value) => {
      expect(() => assertValidDate(value, "decidedAt")).toThrow(CaseWorkflowValidationError);
    });
  });
});

describe("formatCaseReference", () => {
  // Derived from the database's own assigned primary key rather than guessed
  // beforehand, so two concurrent creations cannot collide.
  it("embeds the UTC year and the zero-padded case id", () => {
    expect(formatCaseReference(42, new Date("2026-08-01T00:00:00.000Z"))).toBe("TNX-2026-000042");
    expect(formatCaseReference(1234567, new Date("2027-01-01T00:00:00.000Z"))).toBe(
      "TNX-2027-1234567"
    );
  });

  it("uses UTC, not local time, at a year boundary", () => {
    expect(formatCaseReference(1, new Date("2027-01-01T00:30:00.000Z"))).toBe("TNX-2027-000001");
    expect(formatCaseReference(1, new Date("2026-12-31T23:30:00.000Z"))).toBe("TNX-2026-000001");
  });

  it("refuses an unusable id or timestamp", () => {
    expect(() => formatCaseReference(0, new Date())).toThrow(CaseWorkflowValidationError);
    expect(() => formatCaseReference(1, new Date("nonsense"))).toThrow(CaseWorkflowValidationError);
  });
});
