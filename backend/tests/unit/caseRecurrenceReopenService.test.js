import { describe, it, expect, beforeEach, vi } from "vitest";

// Recurrence-driven case reopening.
//
// Four properties carry the whole feature:
//   1. only a REMEDIATED closure reopens automatically
//   2. every evaluation is LEDGERED, including the ones that decline, which is
//      what makes re-processing the same occurrence a no-op
//   3. nothing here ever throws into ingestion
//   4. the aggregate audit event carries counts only — never a victim IP

const { createWorkflowPrismaFake } = require("./fixtures/workflowPrismaFake");

const {
  PAIR_OUTCOME,
  recurrenceReopenSummary,
  processRecurrenceReopensSafely,
} = require("../../src/services/workflow/caseRecurrenceReopenService");

const { createCase } = require("../../src/services/workflow/caseLifecycleService");
const { linkFinding } = require("../../src/services/workflow/caseFindingLinkService");
const {
  recordOrganizationResponse,
} = require("../../src/services/workflow/caseResponseService");
const {
  requestClosure,
  approveClosure,
} = require("../../src/services/workflow/caseClosureService");

const ANALYST = 10;
const REVIEWER = 11;
const INDICATOR = "192.0.2.10";

const AT = (iso) => new Date(iso);
const T0 = AT("2026-08-01T08:00:00.000Z");
const T1 = AT("2026-08-01T09:00:00.000Z");
const T2 = AT("2026-08-01T10:00:00.000Z");
const T3 = AT("2026-08-01T11:00:00.000Z");
const OBSERVED = AT("2026-08-02T06:00:00.000Z");
const PROCESSED = AT("2026-08-02T06:05:00.000Z");
const LATER = AT("2026-08-03T06:05:00.000Z");

let fake;
let client;
let state;
let errorSpy;
let orgId;
let findingId;
let occurrenceId;

beforeEach(async () => {
  fake = createWorkflowPrismaFake();
  client = fake.client;
  state = fake.state;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  orgId = (await client.organization.create({ data: { name: "Acme Bank" } })).id;
  findingId = (await client.finding.create({ data: { indicatorValue: INDICATOR } })).id;
  occurrenceId = (
    await client.findingOccurrence.create({
      data: { findingId, action: "RECURRED", observedAt: OBSERVED },
    })
  ).id;
  await client.findingOwnership.create({
    data: {
      findingId,
      status: "RESOLVED",
      confidence: "HIGH",
      organizationId: orgId,
      isIspAttribution: false,
      currentForFindingId: findingId,
    },
  });
});

/** Builds a case linked to the Finding, closed with the given reason. */
async function linkedCaseClosedAs(closureReason) {
  const created = await createCase(
    {
      title: "Accessible RDP",
      threatType: "Accessible RDP",
      organization: "Acme Bank",
      analyst: "a.analyst",
      organizationId: orgId,
      createdAt: T0,
    },
    { client, actorUserId: ANALYST }
  );
  await linkFinding(created.id, findingId, { client, actorUserId: ANALYST, effectiveAt: T1 });

  if (closureReason === "REMEDIATED") {
    await recordOrganizationResponse(
      created.id,
      { responseType: "REMEDIATED", summary: "Port closed", occurredAt: T1 },
      { client, actorUserId: ANALYST, recordedAt: T1 }
    );
  }
  const { request } = await requestClosure(
    created.id,
    { closureReason, justification: `Closing as ${closureReason}` },
    { client, actorUserId: ANALYST, requestedAt: T2 }
  );
  await approveClosure(created.id, request.id, {
    client,
    actorUserId: REVIEWER,
    reviewedAt: T3,
  });
  return created;
}

const recurrence = (overrides = {}) => ({
  findingId,
  findingOccurrenceId: occurrenceId,
  observedAt: OBSERVED,
  ...overrides,
});

const run = (recurrences, processedAt = PROCESSED) =>
  processRecurrenceReopensSafely(client, recurrences, { processedAt });

describe("a REMEDIATED closure", () => {
  it("is reopened, ledgered, escalated and audited", async () => {
    const created = await linkedCaseClosedAs("REMEDIATED");

    const { summary, results } = await run([recurrence()]);

    expect(results).toEqual([
      { outcome: PAIR_OUTCOME.REOPENED, caseId: created.id, escalated: false },
    ]);
    expect(summary.reopenedCaseCount).toBe(1);

    expect(state.cases[0]).toMatchObject({
      lifecycleState: "OPEN",
      closedAt: null,
      closureReason: null,
      closedByUserId: null,
      lastReopenedAt: PROCESSED,
      lastReopenTrigger: "RECURRENCE",
      reopenedCount: 1,
    });

    expect(state.caseRecurrenceReopens).toHaveLength(1);
    expect(state.caseRecurrenceReopens[0]).toMatchObject({
      caseId: created.id,
      findingId,
      findingOccurrenceId: occurrenceId,
      outcome: "REOPENED",
      observedAt: OBSERVED,
      processedAt: PROCESSED,
    });

    const [event] = state.caseLifecycleEvents.filter((e) => e.eventType === "REOPENED");
    expect(event).toMatchObject({
      fromState: "CLOSED",
      toState: "OPEN",
      reasonCode: "REOPENED_BY_RECURRENCE",
      // No actor: this is a consequence of new evidence, not a person's
      // decision. Attributing it to the uploading analyst would misrepresent
      // who decided to reopen.
      actorUserId: null,
    });
  });

  // The Finding is already ESCALATED from the original link, so appending
  // another identical row would record no decision.
  it("does not append a redundant escalation when the Finding is already escalated", async () => {
    await linkedCaseClosedAs("REMEDIATED");
    const before = state.findingTriages.length;

    const { summary } = await run([recurrence()]);

    expect(state.findingTriages).toHaveLength(before);
    expect(summary.escalatedTriageCount).toBe(0);
  });

  it("re-escalates a Finding that was dismissed after the closure", async () => {
    const created = await linkedCaseClosedAs("REMEDIATED");
    // Supersede the CASE_LINK escalation with a later dismissal.
    await client.findingTriage.updateMany({
      where: { currentForFindingId: findingId },
      data: { supersededAt: T3, currentForFindingId: null },
    });
    await client.findingTriage.create({
      data: {
        findingId,
        decision: "DISMISSED",
        source: "ANALYST_DECISION",
        reason: "Thought it was decommissioned",
        decidedAt: T3,
        supersededAt: null,
        currentForFindingId: findingId,
      },
    });

    const { summary } = await run([recurrence()]);

    expect(summary.escalatedTriageCount).toBe(1);
    const current = state.findingTriages.find((row) => row.currentForFindingId === findingId);
    expect(current).toMatchObject({
      decision: "ESCALATED",
      source: "RECURRENCE_REOPEN",
      caseId: created.id,
    });
  });
});

describe("closures that must never auto-reopen", () => {
  it.each(["FALSE_POSITIVE", "ACCEPTED_RISK", "DUPLICATE", "OTHER"])(
    "leaves a %s closure closed and records why it declined",
    async (closureReason) => {
      const created = await linkedCaseClosedAs(closureReason);

      const { summary, results } = await run([recurrence()]);

      expect(results[0].outcome).toBe(PAIR_OUTCOME.SKIPPED_CLOSURE_REASON_NOT_REMEDIATED);
      expect(summary.reopenedCaseCount).toBe(0);
      expect(state.cases[0]).toMatchObject({
        lifecycleState: "CLOSED",
        closureReason,
        reopenedCount: 0,
      });

      // Declining is still ledgered, which is what makes the rule provably
      // applied rather than silently skipped.
      expect(state.caseRecurrenceReopens[0]).toMatchObject({
        caseId: created.id,
        outcome: "SKIPPED_CLOSURE_REASON_NOT_REMEDIATED",
      });
      expect(state.caseLifecycleEvents.some((e) => e.eventType === "REOPENED")).toBe(false);
    }
  );

  it("declines an open case with a distinguishable outcome", async () => {
    const created = await createCase(
      {
        title: "Accessible RDP",
        threatType: "Accessible RDP",
        organization: "Acme Bank",
        analyst: "a.analyst",
        organizationId: orgId,
        createdAt: T0,
      },
      { client, actorUserId: ANALYST }
    );
    await linkFinding(created.id, findingId, { client, effectiveAt: T1 });

    const { results } = await run([recurrence()]);

    expect(results[0].outcome).toBe(PAIR_OUTCOME.SKIPPED_NOT_CLOSED);
    expect(state.caseRecurrenceReopens[0].outcome).toBe("SKIPPED_NOT_CLOSED");
    expect(state.cases[0].lifecycleState).toBe("OPEN");
  });
});

describe("idempotency", () => {
  it("reopens once, however many times the same occurrence is processed", async () => {
    await linkedCaseClosedAs("REMEDIATED");

    const first = await run([recurrence()]);
    const second = await run([recurrence()], LATER);
    const third = await run([recurrence()], LATER);

    expect(first.summary.reopenedCaseCount).toBe(1);
    expect(second.results[0].outcome).toBe(PAIR_OUTCOME.ALREADY_PROCESSED);
    expect(third.results[0].outcome).toBe(PAIR_OUTCOME.ALREADY_PROCESSED);

    expect(state.cases[0].reopenedCount).toBe(1);
    expect(state.caseRecurrenceReopens).toHaveLength(1);
    expect(state.caseLifecycleEvents.filter((e) => e.eventType === "REOPENED")).toHaveLength(1);
  });

  // The stored row records what the FIRST pass decided; re-running must not
  // overwrite that with "already processed".
  it("keeps the original decision when a declined pair is re-processed", async () => {
    await linkedCaseClosedAs("FALSE_POSITIVE");

    await run([recurrence()]);
    const second = await run([recurrence()], LATER);

    expect(second.results[0].outcome).toBe(PAIR_OUTCOME.ALREADY_PROCESSED);
    expect(state.caseRecurrenceReopens).toHaveLength(1);
    expect(state.caseRecurrenceReopens[0]).toMatchObject({
      outcome: "SKIPPED_CLOSURE_REASON_NOT_REMEDIATED",
      processedAt: PROCESSED,
    });
  });

  it("treats a NEWER occurrence as a fresh recurrence and reopens again", async () => {
    await linkedCaseClosedAs("REMEDIATED");
    await run([recurrence()]);

    // The case must be closed again before a second recurrence can reopen it.
    await client.case.updateMany({
      where: { id: state.cases[0].id },
      data: { lifecycleState: "CLOSED", closureReason: "REMEDIATED", closedAt: LATER },
    });
    const laterOccurrenceId = (
      await client.findingOccurrence.create({
        data: { findingId, action: "RECURRED", observedAt: LATER },
      })
    ).id;

    const { summary } = await run(
      [recurrence({ findingOccurrenceId: laterOccurrenceId, observedAt: LATER })],
      LATER
    );

    expect(summary.reopenedCaseCount).toBe(1);
    expect(state.caseRecurrenceReopens).toHaveLength(2);
    expect(state.cases[0].reopenedCount).toBe(2);
  });
});

describe("link scope", () => {
  it("ignores a case the Finding was unlinked from", async () => {
    const created = await linkedCaseClosedAs("REMEDIATED");
    // Retract the link directly: unlinkFinding refuses on a closed case, and
    // what is under test is that the reopen path reads CURRENT links only.
    await client.caseFinding.updateMany({
      where: { currentLinkKey: `${created.id}:${findingId}` },
      data: { state: "UNLINKED", currentLinkKey: null, supersededAt: T3 },
    });

    const { summary, results } = await run([recurrence()]);

    expect(results).toEqual([]);
    expect(summary.evaluatedPairCount).toBe(0);
    expect(state.cases[0].lifecycleState).toBe("CLOSED");
  });

  it("fans one recurrence out to every case the Finding is evidence in", async () => {
    const remediated = await linkedCaseClosedAs("REMEDIATED");
    const falsePositive = await linkedCaseClosedAs("FALSE_POSITIVE");

    const { summary, results } = await run([recurrence()]);

    expect(summary.evaluatedPairCount).toBe(2);
    expect(summary.reopenedCaseCount).toBe(1);
    expect(results.find((r) => r.caseId === remediated.id).outcome).toBe(PAIR_OUTCOME.REOPENED);
    expect(results.find((r) => r.caseId === falsePositive.id).outcome).toBe(
      PAIR_OUTCOME.SKIPPED_CLOSURE_REASON_NOT_REMEDIATED
    );
    // Each pair gets its OWN ledger row — the composite key is per pair, not
    // per occurrence.
    expect(state.caseRecurrenceReopens).toHaveLength(2);
  });
});

describe("failure isolation", () => {
  it("never throws, whatever the caller passes", async () => {
    await expect(run(null)).resolves.toMatchObject({ results: [] });
    await expect(run(undefined)).resolves.toMatchObject({ results: [] });
    await expect(
      processRecurrenceReopensSafely(client, [recurrence()], { processedAt: "not-a-date" })
    ).resolves.toMatchObject({ results: [] });
  });

  it("classifies a malformed recurrence entry as FAILED rather than throwing", async () => {
    await linkedCaseClosedAs("REMEDIATED");

    const { summary, results } = await run([recurrence({ findingOccurrenceId: 0 })]);

    expect(results[0].outcome).toBe(PAIR_OUTCOME.FAILED);
    expect(summary.failedCount).toBe(1);
    expect(state.cases[0].lifecycleState).toBe("CLOSED");
  });

  it("isolates a failing pair and still processes the rest", async () => {
    const remediated = await linkedCaseClosedAs("REMEDIATED");
    const second = await linkedCaseClosedAs("REMEDIATED");

    const original = client.caseRecurrenceReopen.create;
    client.caseRecurrenceReopen.create = async (args) => {
      if (args.data.caseId === remediated.id) throw new Error("ledger insert failed");
      return original(args);
    };

    try {
      const { summary } = await run([recurrence()]);

      expect(summary.failedCount).toBe(1);
      expect(summary.reopenedCaseCount).toBe(1);
      // The failing pair rolled back entirely — its case stays closed.
      const failed = state.cases.find((c) => c.id === remediated.id);
      const succeeded = state.cases.find((c) => c.id === second.id);
      expect(failed.lifecycleState).toBe("CLOSED");
      expect(succeeded.lifecycleState).toBe("OPEN");
    } finally {
      client.caseRecurrenceReopen.create = original;
    }
  });

  it("audits an aggregate failure and never copies the error text anywhere", async () => {
    await linkedCaseClosedAs("REMEDIATED");
    const leak = "relation \"CaseRecurrenceReopen\" does not exist";

    const original = client.caseRecurrenceReopen.create;
    client.caseRecurrenceReopen.create = async () => {
      throw new Error(leak);
    };

    try {
      const { summary } = await run([recurrence()]);
      expect(summary.failedCount).toBe(1);

      const [failure] = state.auditLogs.filter(
        (row) => row.action === "case.recurrence.reopen.failed"
      );
      expect(failure.outcome).toBe("FAILURE");
      expect(JSON.stringify(state.auditLogs)).not.toContain(leak);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(leak);
    } finally {
      client.caseRecurrenceReopen.create = original;
    }
  });
});

describe("aggregate auditing", () => {
  it("emits counts only — no indicator, Finding id, occurrence id or case reference", async () => {
    await linkedCaseClosedAs("REMEDIATED");

    await run([recurrence()]);

    const [completed] = state.auditLogs.filter(
      (row) => row.action === "case.recurrence.reopen.completed"
    );
    expect(completed.outcome).toBe("SUCCESS");
    expect(Object.keys(completed.after).sort()).toEqual(
      [
        "alreadyProcessedCount",
        "escalatedTriageCount",
        "evaluatedPairCount",
        "failedCount",
        "reopenedCaseCount",
        "skippedClosureReasonCount",
        "skippedNotClosedCount",
      ].sort()
    );

    const aggregateOnly = JSON.stringify(completed);
    expect(aggregateOnly).not.toContain(INDICATOR);
    expect(aggregateOnly).not.toContain("TNX-");
  });

  it("keeps the indicator out of the per-case reopen event too", async () => {
    await linkedCaseClosedAs("REMEDIATED");
    await run([recurrence()]);

    const [reopened] = state.auditLogs.filter(
      (row) => row.action === "case.reopened" && row.entityType === "Case"
    );
    expect(reopened.reason).toBe(
      "Case reopened automatically by a recurrence of remediated evidence"
    );
    expect(JSON.stringify(reopened)).not.toContain(INDICATOR);
  });

  it("derives the summary from the results array itself", () => {
    const summary = recurrenceReopenSummary([
      { outcome: PAIR_OUTCOME.REOPENED, escalated: true },
      { outcome: PAIR_OUTCOME.REOPENED, escalated: false },
      { outcome: PAIR_OUTCOME.SKIPPED_NOT_CLOSED, escalated: false },
      { outcome: PAIR_OUTCOME.SKIPPED_CLOSURE_REASON_NOT_REMEDIATED, escalated: false },
      { outcome: PAIR_OUTCOME.ALREADY_PROCESSED, escalated: false },
      { outcome: PAIR_OUTCOME.FAILED, escalated: false },
    ]);

    expect(summary).toEqual({
      evaluatedPairCount: 6,
      reopenedCaseCount: 2,
      skippedNotClosedCount: 1,
      skippedClosureReasonCount: 1,
      alreadyProcessedCount: 1,
      failedCount: 1,
      escalatedTriageCount: 1,
    });
  });
});
