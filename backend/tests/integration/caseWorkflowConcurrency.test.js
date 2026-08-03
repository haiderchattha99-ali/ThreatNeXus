import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "node:crypto";

// Real-PostgreSQL tests for the Phase 3 defensible analyst workflow.
//
// These exist because the in-memory fake used by the unit suites (see
// tests/unit/fixtures/workflowPrismaFake.js) cannot prove:
//
//   * the three distinct-NULLs current-row uniques holding under GENUINE
//     concurrency — FindingTriage.currentForFindingId, CaseFinding
//     .currentLinkKey, CaseClosureRequest.activeCaseId
//   * CaseRecurrenceReopen's (findingOccurrenceId, caseId) composite unique
//     actually making repeated recurrence processing idempotent
//   * the guarded case.updateMany compare-and-swap admitting exactly one of two
//     racing lifecycle transitions
//   * onDelete: Restrict actually refusing to orphan workflow evidence
//   * SERIALIZABLE whole-transaction retry against a real engine
//
// Mirrors the scope split documented in ownershipConcurrency.test.js and
// riskScoringConcurrency.test.js.
//
// Self-skips unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_test?schema=public" npx vitest run tests/integration/caseWorkflowConcurrency.test.js

const { PrismaClient } = require("@prisma/client");

const { createCase, changeCaseState, reopenCase } = require("../../src/services/workflow/caseLifecycleService");
const { linkFinding, unlinkFinding } = require("../../src/services/workflow/caseFindingLinkService");
const { recordOrganizationResponse } = require("../../src/services/workflow/caseResponseService");
const {
  requestClosure,
  approveClosure,
  rejectClosure,
} = require("../../src/services/workflow/caseClosureService");
const { recordTriageDecision } = require("../../src/services/workflow/findingTriageService");
const {
  PAIR_OUTCOME,
  processRecurrenceReopensSafely,
} = require("../../src/services/workflow/caseRecurrenceReopenService");
const { getCaseWorkflow } = require("../../src/services/workflow/caseWorkflowReadService");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// RFC 5737 TEST-NET-3, third octet 4 — distinct from 203.0.113.2 (P2-T3),
// 203.0.113.8/9 (vulnerability suites), 192.0.2.x, 198.18-21.x, so cleanup
// here can never collide with another suite's rows.
const MARKER = "p3-workflow";
const IP_PREFIX = "203.0.113.4";

const ASOF = new Date("2026-08-01T00:00:00.000Z");
const HOUR = 3600000;
const at = (hours) => new Date(ASOF.getTime() + hours * HOUR);

const ANALYST_USER = null;
const REVIEWER_USER = null;

let prisma;
let racers = [];

// Ordered by dependency: every Phase 3 FK onto Case / Finding /
// FindingOccurrence / Organization is Restrict, so the workflow rows must go
// before the rows they reference. CaseClosureRequest goes before
// CaseOrganizationResponse because supportingResponseId is Restrict too.
async function cleanup() {
  const findings = await prisma.finding.findMany({
    where: { indicatorValue: { startsWith: IP_PREFIX } },
    select: { id: true },
  });
  const findingIds = findings.map((f) => f.id);

  const cases = await prisma.case.findMany({
    where: { organization: { startsWith: MARKER } },
    select: { id: true },
  });
  const caseIds = cases.map((c) => c.id);

  await prisma.caseRecurrenceReopen.deleteMany({
    where: { OR: [{ caseId: { in: caseIds } }, { findingId: { in: findingIds } }] },
  });
  await prisma.caseClosureRequest.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.caseOrganizationResponse.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.caseLifecycleEvent.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.caseFinding.deleteMany({
    where: { OR: [{ caseId: { in: caseIds } }, { findingId: { in: findingIds } }] },
  });
  await prisma.findingTriage.deleteMany({
    where: { OR: [{ caseId: { in: caseIds } }, { findingId: { in: findingIds } }] },
  });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });

  await prisma.findingOwnership.deleteMany({ where: { findingId: { in: findingIds } } });
  await prisma.findingOccurrence.deleteMany({ where: { findingId: { in: findingIds } } });
  await prisma.rawReportRow.deleteMany({
    where: { rawReport: { sourceFileName: { startsWith: MARKER } } },
  });
  await prisma.finding.deleteMany({ where: { id: { in: findingIds } } });
  await prisma.rawReport.deleteMany({ where: { sourceFileName: { startsWith: MARKER } } });
  await prisma.assetMapping.deleteMany({
    where: { organization: { name: { startsWith: MARKER } } },
  });
  await prisma.organization.deleteMany({ where: { name: { startsWith: MARKER } } });
}

async function makeOrganization(label) {
  return prisma.organization.create({
    data: {
      name: `${MARKER}-${label}-${crypto.randomUUID().slice(0, 8)}`,
      industry: "Test",
      location: "Test",
      contactPerson: "Test",
      email: `${MARKER}-${crypto.randomUUID()}@example.test`,
      sector: "FINANCE",
    },
  });
}

async function makeFinding(suffix) {
  return prisma.finding.create({
    data: {
      indicatorValue: `${IP_PREFIX}${suffix}`,
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      status: "OPEN",
      firstSeen: ASOF,
      lastSeen: ASOF,
      occurrenceCount: 1,
    },
  });
}

async function makeRawReport(label) {
  const content = Buffer.from(`${MARKER}-${label}-${crypto.randomUUID()}`, "utf8");
  return prisma.rawReport.create({
    data: {
      reportType: "ACCESSIBLE_RDP",
      schemaVersion: "accessible-rdp.synthetic.v1",
      sourceFileName: `${MARKER}-${label}-${crypto.randomUUID()}.csv`,
      sourceFileSha256: crypto.createHash("sha256").update(content).digest("hex"),
      fileSizeBytes: content.length,
      contentType: "text/csv",
      rawContent: content,
      observationDate: ASOF,
      status: "COMPLETED",
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
    },
  });
}

async function makeOccurrence(findingId, { action = "RECURRED", observedAt = at(24) } = {}) {
  const report = await makeRawReport(action.toLowerCase());
  return prisma.findingOccurrence.create({
    data: { findingId, rawReportId: report.id, action, observedAt },
  });
}

async function makeOwnership(findingId, organizationId, overrides = {}) {
  return prisma.findingOwnership.create({
    data: {
      findingId,
      status: "RESOLVED",
      confidence: "HIGH",
      organizationId,
      isIspAttribution: false,
      reasonCode: "EXACT_IP_MATCH",
      candidateCount: 1,
      asOf: ASOF,
      resolvedAt: ASOF,
      currentForFindingId: findingId,
      ...overrides,
    },
  });
}

async function makeCase(organizationId, label = "case") {
  return createCase(
    {
      title: `${MARKER} ${label}`,
      threatType: "Accessible RDP",
      organization: `${MARKER}-legacy-name`,
      analyst: "a.analyst",
      priority: "High",
      organizationId,
      createdAt: ASOF,
    },
    { client: prisma, actorUserId: ANALYST_USER }
  );
}

// Drives a case all the way to CLOSED with the given reason.
//
// `recordRemediation: false` is for callers that already recorded their own
// REMEDIATED response and need the closure to rest on THAT one — recording a
// second would make which response supports the closure ambiguous.
async function closeCase(caseRecord, closureReason, { recordRemediation = true } = {}) {
  if (closureReason === "REMEDIATED" && recordRemediation) {
    await recordOrganizationResponse(
      caseRecord.id,
      { responseType: "REMEDIATED", summary: "Port closed", occurredAt: at(2) },
      { client: prisma, actorUserId: ANALYST_USER, recordedAt: at(2) }
    );
  }
  const { request } = await requestClosure(
    caseRecord.id,
    { closureReason, justification: `Closing as ${closureReason}` },
    { client: prisma, actorUserId: ANALYST_USER, requestedAt: at(3) }
  );
  await approveClosure(caseRecord.id, request.id, {
    client: prisma,
    actorUserId: REVIEWER_USER,
    reviewedAt: at(4),
  });
  return request;
}

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb("Phase 3 analyst workflow — real PostgreSQL", () => {
  beforeAll(async () => {
    const datasources = { db: { url: TEST_DATABASE_URL } };
    prisma = new PrismaClient({ datasources });
    // SEPARATE, PRE-CONNECTED clients. Promise.all over ONE shared
    // PrismaClient does not prove a database concurrency invariant: that
    // client's pool serializes the calls enough to hide the race, so such a
    // test passes even against an implementation with no invariant at all
    // (measured directly during P2-T2b).
    racers = Array.from({ length: 6 }, () => new PrismaClient({ datasources }));
    await Promise.all([prisma.$connect(), ...racers.map((c) => c.$connect())]);
  }, 60000);

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
    await Promise.all(racers.map((c) => c.$disconnect()));
    racers = [];
  });

  // -------------------------------------------------------------------------
  // 1-3. Append-only histories with exactly one current row
  // -------------------------------------------------------------------------

  it("1. keeps one current triage row across a real supersede chain", async () => {
    const finding = await makeFinding("1");

    await recordTriageDecision(
      { findingId: finding.id, decision: "IN_REVIEW", decidedAt: at(1) },
      { client: prisma }
    );
    await recordTriageDecision(
      { findingId: finding.id, decision: "ESCALATED", decidedAt: at(2) },
      { client: prisma }
    );
    await recordTriageDecision(
      {
        findingId: finding.id,
        decision: "DISMISSED",
        reason: "Host decommissioned",
        decidedAt: at(3),
      },
      { client: prisma }
    );

    const rows = await prisma.findingTriage.findMany({
      where: { findingId: finding.id },
      orderBy: { id: "asc" },
    });
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.currentForFindingId !== null)).toHaveLength(1);
    expect(rows.map((r) => r.decision)).toEqual(["IN_REVIEW", "ESCALATED", "DISMISSED"]);
    // Prior rows keep their own decision; only the supersession pointer moved.
    expect(rows[0].supersededAt).toEqual(at(2));
    expect(rows[1].supersededAt).toEqual(at(3));
    expect(rows[2].supersededAt).toBeNull();
  });

  it("1b. admits exactly one of six concurrent triage decisions per attempt", async () => {
    const finding = await makeFinding("2");

    const results = await Promise.allSettled(
      racers.map((client, index) =>
        recordTriageDecision(
          {
            findingId: finding.id,
            decision: index % 2 === 0 ? "IN_REVIEW" : "ESCALATED",
            decidedAt: at(1 + index),
          },
          { client }
        )
      )
    );

    // Bounded SERIALIZABLE retry means most or all succeed; what must hold
    // unconditionally is that the database never ends up with two current rows.
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThan(0);
    const current = await prisma.findingTriage.findMany({
      where: { findingId: finding.id, currentForFindingId: { not: null } },
    });
    expect(current).toHaveLength(1);

    const all = await prisma.findingTriage.findMany({ where: { findingId: finding.id } });
    expect(all.length).toBe(results.filter((r) => r.status === "fulfilled").length);
  });

  it("2. keeps one current CaseFinding link per pair across link/unlink/relink", async () => {
    const organization = await makeOrganization("link");
    const finding = await makeFinding("3");
    await makeOwnership(finding.id, organization.id);
    const caseRecord = await makeCase(organization.id);

    await linkFinding(caseRecord.id, finding.id, { client: prisma, effectiveAt: at(1) });
    await unlinkFinding(caseRecord.id, finding.id, {
      client: prisma,
      effectiveAt: at(2),
      reason: "Premature",
    });
    await linkFinding(caseRecord.id, finding.id, { client: prisma, effectiveAt: at(3) });

    const rows = await prisma.caseFinding.findMany({
      where: { caseId: caseRecord.id, findingId: finding.id },
      orderBy: { id: "asc" },
    });
    expect(rows.map((r) => r.state)).toEqual(["LINKED", "UNLINKED", "LINKED"]);
    expect(rows.filter((r) => r.currentLinkKey !== null)).toHaveLength(1);
    expect(rows[2].currentLinkKey).toBe(`${caseRecord.id}:${finding.id}`);
  });

  it("2b. admits exactly one link row when six clients link the same pair at once", async () => {
    const organization = await makeOrganization("link-race");
    const finding = await makeFinding("4");
    await makeOwnership(finding.id, organization.id);
    const caseRecord = await makeCase(organization.id);

    const results = await Promise.allSettled(
      racers.map((client) =>
        linkFinding(caseRecord.id, finding.id, { client, effectiveAt: at(1) })
      )
    );

    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThan(0);

    const rows = await prisma.caseFinding.findMany({
      where: { caseId: caseRecord.id, findingId: finding.id },
    });
    // Re-linking an already-linked pair writes nothing, so however the race
    // resolves there is exactly one LINKED row and one current link.
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("LINKED");

    // The escalation committed with it, exactly once.
    const triage = await prisma.findingTriage.findMany({ where: { findingId: finding.id } });
    expect(triage).toHaveLength(1);
    expect(triage[0]).toMatchObject({ decision: "ESCALATED", source: "CASE_LINK" });
  });

  it("2c. keeps distinct pairs independent under the same current-link mechanism", async () => {
    const organization = await makeOrganization("pairs");
    const findingA = await makeFinding("5");
    const findingB = await makeFinding("6");
    await makeOwnership(findingA.id, organization.id);
    await makeOwnership(findingB.id, organization.id);
    const caseOne = await makeCase(organization.id, "one");
    const caseTwo = await makeCase(organization.id, "two");

    await Promise.all([
      linkFinding(caseOne.id, findingA.id, { client: racers[0], effectiveAt: at(1) }),
      linkFinding(caseOne.id, findingB.id, { client: racers[1], effectiveAt: at(1) }),
      linkFinding(caseTwo.id, findingA.id, { client: racers[2], effectiveAt: at(1) }),
    ]);

    const rows = await prisma.caseFinding.findMany({
      where: { caseId: { in: [caseOne.id, caseTwo.id] }, currentLinkKey: { not: null } },
    });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.currentLinkKey)).size).toBe(3);
  });

  it("3. allows at most one PENDING closure request per case", async () => {
    const organization = await makeOrganization("closure");
    const caseRecord = await makeCase(organization.id);

    const results = await Promise.allSettled(
      racers.map((client, index) =>
        requestClosure(
          caseRecord.id,
          { closureReason: "OTHER", justification: `Attempt ${index}` },
          { client, requestedAt: at(3) }
        )
      )
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    // Only one can move the case OPEN -> CLOSURE_PENDING; the rest lose either
    // the guarded transition or the activeCaseId unique.
    expect(fulfilled).toHaveLength(1);

    const requests = await prisma.caseClosureRequest.findMany({
      where: { caseId: caseRecord.id },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].activeCaseId).toBe(caseRecord.id);

    const reloaded = await prisma.case.findUnique({ where: { id: caseRecord.id } });
    expect(reloaded.lifecycleState).toBe("CLOSURE_PENDING");
  });

  it("3b. releases activeCaseId on decision so a reopened case can be re-closed", async () => {
    const organization = await makeOrganization("reclose");
    const caseRecord = await makeCase(organization.id);

    await closeCase(caseRecord, "FALSE_POSITIVE");
    await reopenCase(caseRecord.id, {
      client: prisma,
      occurredAt: at(5),
      reason: "Observed again",
    });
    await requestClosure(
      caseRecord.id,
      { closureReason: "ACCEPTED_RISK", justification: "Accepted by the org" },
      { client: prisma, requestedAt: at(6) }
    );

    const requests = await prisma.caseClosureRequest.findMany({
      where: { caseId: caseRecord.id },
      orderBy: { id: "asc" },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ state: "APPROVED", activeCaseId: null });
    expect(requests[1]).toMatchObject({ state: "PENDING", activeCaseId: caseRecord.id });
  });

  // -------------------------------------------------------------------------
  // 4-5. Concurrent lifecycle transitions
  // -------------------------------------------------------------------------

  it("4. admits exactly one of two opposing concurrent state changes", async () => {
    const organization = await makeOrganization("state-race");
    const caseRecord = await makeCase(organization.id);

    const results = await Promise.allSettled([
      changeCaseState(caseRecord.id, "WAITING_FOR_ORG", { client: racers[0], occurredAt: at(1) }),
      changeCaseState(caseRecord.id, "WAITING_FOR_ORG", { client: racers[1], occurredAt: at(1) }),
      changeCaseState(caseRecord.id, "WAITING_FOR_ORG", { client: racers[2], occurredAt: at(1) }),
    ]);

    const changed = results.filter((r) => r.status === "fulfilled" && r.value.changed);
    expect(changed).toHaveLength(1);

    const events = await prisma.caseLifecycleEvent.findMany({
      where: { caseId: caseRecord.id, eventType: "STATE_CHANGED" },
    });
    // One accepted transition, one event. A case can never reach a state with
    // no event explaining how it got there, nor collect duplicates.
    expect(events).toHaveLength(1);
  });

  it("5. lets only one reviewer decision land on a pending closure", async () => {
    const organization = await makeOrganization("review-race");
    const caseRecord = await makeCase(organization.id);
    const { request } = await requestClosure(
      caseRecord.id,
      { closureReason: "DUPLICATE", justification: "Duplicate" },
      { client: prisma, requestedAt: at(3) }
    );

    const results = await Promise.allSettled([
      approveClosure(caseRecord.id, request.id, { client: racers[0], reviewedAt: at(4) }),
      rejectClosure(caseRecord.id, request.id, {
        client: racers[1],
        reviewedAt: at(4),
        reviewNote: "Not convinced",
      }),
      approveClosure(caseRecord.id, request.id, { client: racers[2], reviewedAt: at(4) }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const decided = await prisma.caseClosureRequest.findUnique({ where: { id: request.id } });
    expect(["APPROVED", "REJECTED"]).toContain(decided.state);
    expect(decided.activeCaseId).toBeNull();

    const decisions = await prisma.caseLifecycleEvent.findMany({
      where: {
        caseId: caseRecord.id,
        eventType: { in: ["CLOSURE_APPROVED", "CLOSURE_REJECTED"] },
      },
    });
    expect(decisions).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 6-8. Recurrence-driven reopening
  // -------------------------------------------------------------------------

  it("6. reopens a REMEDIATED closure exactly once, however often it is processed", async () => {
    const organization = await makeOrganization("recurrence");
    const finding = await makeFinding("7");
    await makeOwnership(finding.id, organization.id);
    const caseRecord = await makeCase(organization.id);
    await linkFinding(caseRecord.id, finding.id, { client: prisma, effectiveAt: at(1) });
    await closeCase(caseRecord, "REMEDIATED");

    const occurrence = await makeOccurrence(finding.id);
    const recurrence = [
      { findingId: finding.id, findingOccurrenceId: occurrence.id, observedAt: at(24) },
    ];

    const first = await processRecurrenceReopensSafely(prisma, recurrence, {
      processedAt: at(25),
    });
    const second = await processRecurrenceReopensSafely(prisma, recurrence, {
      processedAt: at(26),
    });

    expect(first.summary.reopenedCaseCount).toBe(1);
    expect(second.results[0].outcome).toBe(PAIR_OUTCOME.ALREADY_PROCESSED);

    const reloaded = await prisma.case.findUnique({ where: { id: caseRecord.id } });
    expect(reloaded).toMatchObject({
      lifecycleState: "OPEN",
      closureReason: null,
      closedAt: null,
      lastReopenTrigger: "RECURRENCE",
      reopenedCount: 1,
    });

    const ledger = await prisma.caseRecurrenceReopen.findMany({
      where: { caseId: caseRecord.id },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe("REOPENED");

    const reopens = await prisma.caseLifecycleEvent.findMany({
      where: { caseId: caseRecord.id, eventType: "REOPENED" },
    });
    expect(reopens).toHaveLength(1);
    expect(reopens[0].reasonCode).toBe("REOPENED_BY_RECURRENCE");
  });

  it("6b. stays idempotent when six clients process the same recurrence at once", async () => {
    const organization = await makeOrganization("recurrence-race");
    const finding = await makeFinding("8");
    await makeOwnership(finding.id, organization.id);
    const caseRecord = await makeCase(organization.id);
    await linkFinding(caseRecord.id, finding.id, { client: prisma, effectiveAt: at(1) });
    await closeCase(caseRecord, "REMEDIATED");

    const occurrence = await makeOccurrence(finding.id);
    const recurrence = [
      { findingId: finding.id, findingOccurrenceId: occurrence.id, observedAt: at(24) },
    ];

    const runs = await Promise.all(
      racers.map((client) =>
        processRecurrenceReopensSafely(client, recurrence, { processedAt: at(25) })
      )
    );

    // The composite (findingOccurrenceId, caseId) unique is what enforces this:
    // a duplicate raises P2002, which re-runs the whole transaction and then
    // sees the committed ledger row.
    const reopened = runs.reduce((sum, r) => sum + r.summary.reopenedCaseCount, 0);
    expect(reopened).toBe(1);

    const ledger = await prisma.caseRecurrenceReopen.findMany({
      where: { caseId: caseRecord.id },
    });
    expect(ledger).toHaveLength(1);

    const reloaded = await prisma.case.findUnique({ where: { id: caseRecord.id } });
    expect(reloaded.reopenedCount).toBe(1);
  });

  it("7. never auto-reopens a non-REMEDIATED closure, and ledgers the refusal", async () => {
    const organization = await makeOrganization("no-reopen");
    const finding = await makeFinding("9");
    await makeOwnership(finding.id, organization.id);

    const cases = {};
    // eslint-disable-next-line no-restricted-syntax
    for (const reason of ["FALSE_POSITIVE", "ACCEPTED_RISK", "DUPLICATE", "OTHER"]) {
      // eslint-disable-next-line no-await-in-loop
      const record = await makeCase(organization.id, reason);
      // eslint-disable-next-line no-await-in-loop
      await linkFinding(record.id, finding.id, { client: prisma, effectiveAt: at(1) });
      // eslint-disable-next-line no-await-in-loop
      await closeCase(record, reason);
      cases[reason] = record;
    }
    const remediated = await makeCase(organization.id, "remediated");
    await linkFinding(remediated.id, finding.id, { client: prisma, effectiveAt: at(1) });
    await closeCase(remediated, "REMEDIATED");

    const occurrence = await makeOccurrence(finding.id);
    const { summary } = await processRecurrenceReopensSafely(
      prisma,
      [{ findingId: finding.id, findingOccurrenceId: occurrence.id, observedAt: at(24) }],
      { processedAt: at(25) }
    );

    // One recurrence, five linked cases, exactly one reopened.
    expect(summary.evaluatedPairCount).toBe(5);
    expect(summary.reopenedCaseCount).toBe(1);
    expect(summary.skippedClosureReasonCount).toBe(4);

    // eslint-disable-next-line no-restricted-syntax
    for (const [reason, record] of Object.entries(cases)) {
      // eslint-disable-next-line no-await-in-loop
      const reloaded = await prisma.case.findUnique({ where: { id: record.id } });
      expect(reloaded.lifecycleState, reason).toBe("CLOSED");
      expect(reloaded.closureReason, reason).toBe(reason);
      expect(reloaded.reopenedCount, reason).toBe(0);
      // eslint-disable-next-line no-await-in-loop
      const ledger = await prisma.caseRecurrenceReopen.findMany({ where: { caseId: record.id } });
      expect(ledger[0].outcome, reason).toBe("SKIPPED_CLOSURE_REASON_NOT_REMEDIATED");
    }

    const reopenedCase = await prisma.case.findUnique({ where: { id: remediated.id } });
    expect(reopenedCase.lifecycleState).toBe("OPEN");
  });

  it("8. ignores an unlinked Finding and never reopens the case it left", async () => {
    const organization = await makeOrganization("unlinked");
    const finding = await makeFinding("11");
    await makeOwnership(finding.id, organization.id);
    const caseRecord = await makeCase(organization.id);
    await linkFinding(caseRecord.id, finding.id, { client: prisma, effectiveAt: at(1) });
    await unlinkFinding(caseRecord.id, finding.id, {
      client: prisma,
      effectiveAt: at(2),
      reason: "Wrong case",
    });
    await closeCase(caseRecord, "REMEDIATED");

    const occurrence = await makeOccurrence(finding.id);
    const { summary } = await processRecurrenceReopensSafely(
      prisma,
      [{ findingId: finding.id, findingOccurrenceId: occurrence.id, observedAt: at(24) }],
      { processedAt: at(25) }
    );

    expect(summary.evaluatedPairCount).toBe(0);
    const reloaded = await prisma.case.findUnique({ where: { id: caseRecord.id } });
    expect(reloaded.lifecycleState).toBe("CLOSED");
  });

  // -------------------------------------------------------------------------
  // 9-11. Ownership, referential integrity and read safety
  // -------------------------------------------------------------------------

  it("9. enforces the organization-matching rule against real ownership rows", async () => {
    const organization = await makeOrganization("owner");
    const otherOrganization = await makeOrganization("other-owner");
    const caseRecord = await makeCase(organization.id);

    const mismatched = await makeFinding("12");
    await makeOwnership(mismatched.id, otherOrganization.id);
    await expect(
      linkFinding(caseRecord.id, mismatched.id, { client: prisma, effectiveAt: at(1) })
    ).rejects.toMatchObject({ code: "OWNERSHIP_ORGANIZATION_MISMATCH" });

    const isp = await makeFinding("13");
    await makeOwnership(isp.id, organization.id, {
      isIspAttribution: true,
      confidence: "LOW",
      reasonCode: "ASN_MATCH",
    });
    await expect(
      linkFinding(caseRecord.id, isp.id, { client: prisma, effectiveAt: at(1) })
    ).rejects.toMatchObject({ code: "OWNERSHIP_ISP_ATTRIBUTED" });

    const unowned = await makeFinding("14");
    await expect(
      linkFinding(caseRecord.id, unowned.id, { client: prisma, effectiveAt: at(1) })
    ).rejects.toMatchObject({ code: "OWNERSHIP_MISSING" });

    // Not one row was written by any of the three refusals.
    expect(await prisma.caseFinding.count({ where: { caseId: caseRecord.id } })).toBe(0);
    expect(
      await prisma.findingTriage.count({
        where: { findingId: { in: [mismatched.id, isp.id, unowned.id] } },
      })
    ).toBe(0);

    // An explicit analyst OVERRIDE onto the case's organization IS accepted.
    const overridden = await makeFinding("15");
    await makeOwnership(overridden.id, organization.id, {
      status: "OVERRIDDEN",
      confidence: "CONFIRMED",
      reasonCode: "ANALYST_OVERRIDE",
    });
    const linked = await linkFinding(caseRecord.id, overridden.id, {
      client: prisma,
      effectiveAt: at(1),
    });
    expect(linked.link.ownershipStatusAtLink).toBe("OVERRIDDEN");
    expect(linked.link.ownershipConfidenceAtLink).toBe("CONFIRMED");
  });

  it("10. refuses to orphan workflow evidence — every FK onto it is Restrict", async () => {
    const organization = await makeOrganization("restrict");
    const finding = await makeFinding("16");
    await makeOwnership(finding.id, organization.id);
    const caseRecord = await makeCase(organization.id);
    await linkFinding(caseRecord.id, finding.id, { client: prisma, effectiveAt: at(1) });
    await recordOrganizationResponse(
      caseRecord.id,
      { responseType: "REMEDIATED", summary: "Port closed", occurredAt: at(2) },
      { client: prisma, recordedAt: at(2) }
    );
    await closeCase(caseRecord, "REMEDIATED");
    const occurrence = await makeOccurrence(finding.id);
    await processRecurrenceReopensSafely(
      prisma,
      [{ findingId: finding.id, findingOccurrenceId: occurrence.id, observedAt: at(24) }],
      { processedAt: at(25) }
    );

    // A case carrying any workflow history simply cannot be removed.
    await expect(prisma.case.delete({ where: { id: caseRecord.id } })).rejects.toBeDefined();
    // Nor can the Finding it rests on...
    await expect(prisma.finding.delete({ where: { id: finding.id } })).rejects.toBeDefined();
    // ...nor the occurrence that justified the reopen...
    await expect(
      prisma.findingOccurrence.delete({ where: { id: occurrence.id } })
    ).rejects.toBeDefined();
    // ...nor the organization the case belongs to.
    await expect(
      prisma.organization.delete({ where: { id: organization.id } })
    ).rejects.toBeDefined();

    // The specific response a closure was approved on must not vanish either —
    // CaseClosureRequest.supportingResponseId is Restrict for exactly this.
    const approved = await prisma.caseClosureRequest.findFirst({
      where: { caseId: caseRecord.id, state: "APPROVED" },
    });
    expect(approved.supportingResponseId).not.toBeNull();
    await expect(
      prisma.caseOrganizationResponse.delete({ where: { id: approved.supportingResponseId } })
    ).rejects.toBeDefined();
  });

  it("11. assembles the whole workflow view without exposing an internal key", async () => {
    const organization = await makeOrganization("read");
    const finding = await makeFinding("17");
    await makeOwnership(finding.id, organization.id);
    const caseRecord = await makeCase(organization.id);
    await linkFinding(caseRecord.id, finding.id, { client: prisma, effectiveAt: at(1) });
    await changeCaseState(caseRecord.id, "WAITING_FOR_ORG", {
      client: prisma,
      occurredAt: at(2),
    });
    await recordOrganizationResponse(
      caseRecord.id,
      {
        responseType: "REMEDIATED",
        summary: "Port closed",
        reference: "TICKET-4711",
        occurredAt: at(2),
      },
      { client: prisma, recordedAt: at(2) }
    );
    await closeCase(caseRecord, "REMEDIATED", { recordRemediation: false });
    const occurrence = await makeOccurrence(finding.id);
    await processRecurrenceReopensSafely(
      prisma,
      [{ findingId: finding.id, findingOccurrenceId: occurrence.id, observedAt: at(24) }],
      { processedAt: at(25) }
    );

    const view = await getCaseWorkflow(caseRecord.id, { client: prisma });

    expect(view.case).toMatchObject({
      lifecycleState: "OPEN",
      reopenedByRecurrence: true,
      reopenedCount: 1,
    });
    expect(view.case.ownerOrganization).toEqual({
      id: organization.id,
      name: expect.stringContaining(MARKER),
      sector: "FINANCE",
    });
    expect(view.linkedFindings).toHaveLength(1);
    expect(view.linkedFindings[0].finding.indicatorValue).toBe(`${IP_PREFIX}17`);
    expect(view.organizationResponses[0].reference).toBe("TICKET-4711");
    expect(view.closureRequests[0].state).toBe("APPROVED");
    expect(view.pendingClosureRequest).toBeNull();
    expect(view.recurrenceReopens[0].outcome).toBe("REOPENED");
    expect(view.permittedActions).toMatchObject({
      isOrganizationBound: true,
      canLinkFindings: true,
      canReopen: false,
      availableStates: ["WAITING_FOR_ORG"],
    });

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("currentLinkKey");
    expect(serialized).not.toContain("currentForFindingId");
    expect(serialized).not.toContain("activeCaseId");
    expect(serialized).not.toContain("findingOccurrenceId");
    expect(serialized).not.toContain("@example.test");
  });

  it("12. writes a unique, human-readable reference for every concurrently created case", async () => {
    const organization = await makeOrganization("reference");

    const created = await Promise.all(
      racers.map((client, index) =>
        createCase(
          {
            title: `${MARKER} concurrent ${index}`,
            threatType: "Accessible RDP",
            organization: `${MARKER}-legacy-name`,
            analyst: "a.analyst",
            organizationId: organization.id,
            createdAt: ASOF,
          },
          { client }
        )
      )
    );

    const references = created.map((c) => c.caseReference);
    expect(new Set(references).size).toBe(racers.length);
    references.forEach((reference) => expect(reference).toMatch(/^TNX-2026-\d{6,}$/));

    // Every case starts its timeline with its own CREATED event.
    const events = await prisma.caseLifecycleEvent.findMany({
      where: { caseId: { in: created.map((c) => c.id) }, eventType: "CREATED" },
    });
    expect(events).toHaveLength(racers.length);
  });
});
