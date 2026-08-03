import { describe, it, expect, beforeEach, vi } from "vitest";

// Append-only Finding triage.
//
// The load-bearing property here is that a decision INSERTS a row and never
// rewrites one. A test that only inspected the service's return value could
// not tell an UPDATE from an INSERT, so every assertion below reads the fake's
// durable rows directly.

const { createWorkflowPrismaFake } = require("./fixtures/workflowPrismaFake");

const {
  getCurrentDecision,
  getFindingTriage,
  recordTriageDecision,
  appendWorkflowEscalation,
  triageSummary,
} = require("../../src/services/workflow/findingTriageService");

const {
  UNTRIAGED,
  TRIAGE_DECISIONS,
  TRIAGE_SOURCES,
  MAX_TRIAGE_REASON_LENGTH,
  CaseWorkflowValidationError,
  CaseWorkflowNotFoundError,
} = require("../../src/services/workflow/caseWorkflowRules");

const AT = (iso) => new Date(iso);
const T1 = AT("2026-08-01T09:00:00.000Z");
const T2 = AT("2026-08-01T10:00:00.000Z");
const T3 = AT("2026-08-01T11:00:00.000Z");

let fake;
let client;
let state;
let errorSpy;

beforeEach(async () => {
  fake = createWorkflowPrismaFake();
  client = fake.client;
  state = fake.state;
  await client.finding.create({ data: { indicatorValue: "192.0.2.10", status: "OPEN" } });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

const record = (overrides = {}) =>
  recordTriageDecision(
    {
      findingId: 1,
      decision: TRIAGE_DECISIONS.IN_REVIEW,
      decidedAt: T1,
      ...overrides,
    },
    { client, actorUserId: 5 }
  );

describe("an untriaged Finding", () => {
  it("has no triage row at all, and reports UNTRIAGED", async () => {
    expect(state.findingTriages).toHaveLength(0);
    expect(await getCurrentDecision(client, 1)).toBe(UNTRIAGED);

    const view = await getFindingTriage(1, { client });
    expect(view).toEqual({ current: null, history: [], decision: UNTRIAGED });
  });

  it("refuses triage of a Finding that does not exist", async () => {
    await expect(record({ findingId: 999 })).rejects.toBeInstanceOf(CaseWorkflowNotFoundError);
    expect(state.findingTriages).toHaveLength(0);
  });
});

describe("recording a decision", () => {
  it("inserts a current row carrying the actor and the server-supplied instant", async () => {
    const outcome = await record({ decision: TRIAGE_DECISIONS.IN_REVIEW });

    expect(state.findingTriages).toHaveLength(1);
    expect(state.findingTriages[0]).toMatchObject({
      findingId: 1,
      decision: "IN_REVIEW",
      source: TRIAGE_SOURCES.ANALYST_DECISION,
      actorUserId: 5,
      decidedAt: T1,
      supersededAt: null,
      currentForFindingId: 1,
      caseId: null,
    });
    expect(outcome.previousDecision).toBe(UNTRIAGED);
    expect(outcome.changed).toBe(true);
  });

  // The single most important invariant in the module.
  it("supersedes rather than overwrites, keeping the whole history", async () => {
    await record({ decision: TRIAGE_DECISIONS.IN_REVIEW, decidedAt: T1 });
    await record({ decision: TRIAGE_DECISIONS.ESCALATED, decidedAt: T2 });
    await record({
      decision: TRIAGE_DECISIONS.DISMISSED,
      reason: "Host decommissioned",
      decidedAt: T3,
    });

    expect(state.findingTriages).toHaveLength(3);

    const [first, second, third] = state.findingTriages;
    // Prior rows keep their own decision, reason and actor verbatim. The ONLY
    // mutation ever applied is the supersession pointer pair.
    expect(first.decision).toBe("IN_REVIEW");
    expect(first.supersededAt).toEqual(T2);
    expect(first.currentForFindingId).toBeNull();
    expect(second.decision).toBe("ESCALATED");
    expect(second.supersededAt).toEqual(T3);
    expect(second.currentForFindingId).toBeNull();
    expect(third.decision).toBe("DISMISSED");
    expect(third.supersededAt).toBeNull();
    expect(third.currentForFindingId).toBe(1);
  });

  it("leaves exactly one current row after every decision", async () => {
    await record({ decision: TRIAGE_DECISIONS.IN_REVIEW, decidedAt: T1 });
    await record({ decision: TRIAGE_DECISIONS.ESCALATED, decidedAt: T2 });

    const current = state.findingTriages.filter((row) => row.currentForFindingId !== null);
    expect(current).toHaveLength(1);
    expect(await getCurrentDecision(client, 1)).toBe("ESCALATED");
  });

  it("records a repeat of the same decision as a new row, not a no-op", async () => {
    // Unlike the workflow-driven escalation path, an explicit analyst decision
    // is a real act each time it is taken and is always recorded.
    await record({ decision: TRIAGE_DECISIONS.IN_REVIEW, decidedAt: T1 });
    const second = await record({ decision: TRIAGE_DECISIONS.IN_REVIEW, decidedAt: T2 });

    expect(state.findingTriages).toHaveLength(2);
    expect(second.previousDecision).toBe("IN_REVIEW");
  });

  it("returns the full history newest-first", async () => {
    await record({ decision: TRIAGE_DECISIONS.IN_REVIEW, decidedAt: T1 });
    await record({ decision: TRIAGE_DECISIONS.ESCALATED, decidedAt: T2 });

    const view = await getFindingTriage(1, { client });
    expect(view.decision).toBe("ESCALATED");
    expect(view.history.map((row) => row.decision)).toEqual(["ESCALATED", "IN_REVIEW"]);
    expect(view.current.id).toBe(view.history[0].id);
  });
});

describe("input validation", () => {
  it("requires a reason for DISMISSED and writes nothing without one", async () => {
    await expect(record({ decision: TRIAGE_DECISIONS.DISMISSED })).rejects.toBeInstanceOf(
      CaseWorkflowValidationError
    );
    await expect(
      record({ decision: TRIAGE_DECISIONS.DISMISSED, reason: "   " })
    ).rejects.toBeInstanceOf(CaseWorkflowValidationError);
    expect(state.findingTriages).toHaveLength(0);
  });

  it("accepts an optional reason for IN_REVIEW and ESCALATED", async () => {
    await record({ decision: TRIAGE_DECISIONS.ESCALATED, reason: "Confirmed exposure" });
    expect(state.findingTriages[0].reason).toBe("Confirmed exposure");
  });

  it("rejects an over-length reason rather than truncating it", async () => {
    await expect(
      record({
        decision: TRIAGE_DECISIONS.DISMISSED,
        reason: "x".repeat(MAX_TRIAGE_REASON_LENGTH + 1),
      })
    ).rejects.toBeInstanceOf(CaseWorkflowValidationError);
    expect(state.findingTriages).toHaveLength(0);
  });

  it("rejects a decision outside the closed vocabulary", async () => {
    await expect(record({ decision: "CLOSED" })).rejects.toBeInstanceOf(
      CaseWorkflowValidationError
    );
    expect(state.findingTriages).toHaveLength(0);
  });
});

describe("workflow-driven escalation", () => {
  it("appends ESCALATED for an untriaged Finding and marks it changed", async () => {
    const outcome = await client.$transaction((tx) =>
      appendWorkflowEscalation(tx, {
        findingId: 1,
        source: TRIAGE_SOURCES.CASE_LINK,
        caseId: 3,
        actorUserId: 5,
        decidedAt: T1,
      })
    );

    expect(outcome.changed).toBe(true);
    expect(state.findingTriages).toHaveLength(1);
    expect(state.findingTriages[0]).toMatchObject({
      decision: "ESCALATED",
      source: "CASE_LINK",
      caseId: 3,
      reason: null,
    });
  });

  it("supersedes a DISMISSED decision, because escalating one is a real change", async () => {
    await record({ decision: TRIAGE_DECISIONS.DISMISSED, reason: "Thought benign", decidedAt: T1 });

    const outcome = await client.$transaction((tx) =>
      appendWorkflowEscalation(tx, {
        findingId: 1,
        source: TRIAGE_SOURCES.RECURRENCE_REOPEN,
        caseId: 3,
        decidedAt: T2,
      })
    );

    expect(outcome.changed).toBe(true);
    expect(state.findingTriages).toHaveLength(2);
    expect(state.findingTriages[0].decision).toBe("DISMISSED");
    expect(state.findingTriages[0].supersededAt).toEqual(T2);
  });

  // Without this, every re-link and every repeated recurrence would append an
  // identical row and the history would become a log of system activity.
  it("writes nothing when the Finding is already ESCALATED", async () => {
    await record({ decision: TRIAGE_DECISIONS.ESCALATED, decidedAt: T1 });

    const outcome = await client.$transaction((tx) =>
      appendWorkflowEscalation(tx, {
        findingId: 1,
        source: TRIAGE_SOURCES.CASE_LINK,
        caseId: 3,
        decidedAt: T2,
      })
    );

    expect(outcome.changed).toBe(false);
    expect(outcome.row).toBeNull();
    expect(state.findingTriages).toHaveLength(1);
    expect(state.findingTriages[0].supersededAt).toBeNull();
  });

  it("refuses a source that is not a workflow source", async () => {
    await expect(
      client.$transaction((tx) =>
        appendWorkflowEscalation(tx, {
          findingId: 1,
          source: TRIAGE_SOURCES.ANALYST_DECISION,
          decidedAt: T1,
        })
      )
    ).rejects.toBeInstanceOf(CaseWorkflowValidationError);
  });
});

describe("auditing", () => {
  it("records a bounded success event that never carries the analyst's reason text", async () => {
    const secret = "attacker pivoted through the finance VLAN";
    await record({ decision: TRIAGE_DECISIONS.DISMISSED, reason: secret });

    const [entry] = state.auditLogs.filter((row) => row.action === "finding.triage.recorded");
    expect(entry.outcome).toBe("SUCCESS");
    expect(entry.entityType).toBe("FindingTriage");
    expect(entry.before).toEqual({ findingId: 1, decision: UNTRIAGED });
    expect(entry.after).toMatchObject({ decision: "DISMISSED", hasReason: true });
    expect(JSON.stringify(state.auditLogs)).not.toContain(secret);
  });

  it("records a FAILURE event for an unknown Finding without naming it in free text", async () => {
    await expect(record({ findingId: 999 })).rejects.toBeInstanceOf(CaseWorkflowNotFoundError);

    const [entry] = state.auditLogs.filter((row) => row.action === "finding.triage.recorded");
    expect(entry.outcome).toBe("FAILURE");
    expect(entry.reason).toBe("Triage rejected: finding not found");
  });

  // An audit write must never roll back or alter a committed decision.
  it("keeps the decision when the audit write fails", async () => {
    const original = client.auditLog.create;
    client.auditLog.create = async () => {
      throw new Error("audit table unavailable");
    };

    try {
      const outcome = await record({ decision: TRIAGE_DECISIONS.ESCALATED });
      expect(outcome.changed).toBe(true);
      expect(state.findingTriages).toHaveLength(1);
    } finally {
      client.auditLog.create = original;
    }
  });

  it("never copies a raw error message into the operator log", async () => {
    const original = client.auditLog.create;
    const leak = "column \"decision\" of relation \"FindingTriage\" does not exist";
    client.auditLog.create = async () => {
      throw new Error(leak);
    };

    try {
      await record({ decision: TRIAGE_DECISIONS.ESCALATED });
      const logged = JSON.stringify(errorSpy.mock.calls);
      expect(logged).not.toContain(leak);
    } finally {
      client.auditLog.create = original;
    }
  });
});

describe("triageSummary", () => {
  it("reduces the reason to a boolean and omits the current-row key", () => {
    const summary = triageSummary({
      id: 4,
      findingId: 1,
      decision: "DISMISSED",
      source: "ANALYST_DECISION",
      caseId: null,
      reason: "long private narrative",
      currentForFindingId: 1,
      actorUserId: 5,
    });

    expect(summary).toEqual({
      id: 4,
      findingId: 1,
      decision: "DISMISSED",
      source: "ANALYST_DECISION",
      caseId: null,
      hasReason: true,
    });
    expect(Object.keys(summary)).not.toContain("currentForFindingId");
    expect(Object.keys(summary)).not.toContain("reason");
  });
});
