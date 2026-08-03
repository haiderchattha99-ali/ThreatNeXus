"use strict";

// ===========================================================================
// Executable Phase 3 analyst-workflow gate.
//
// The unit and integration suites each prove one layer against a fake or a
// scoped fixture. This gate drives the REAL production services end to end,
// in the real order an analyst would drive them, against a disposable
// PostgreSQL database — and compares every result against expectations
// written out by hand in this file.
//
// The twelve proofs, in the order the workflow performs them:
//
//    1. triage a Finding
//    2. create an organization-bound case
//    3. link the Finding as evidence
//    4. record ACKNOWLEDGED and then REMEDIATED organization responses
//    5. an analyst requests closure
//    6. a reviewer approves it (and could not have been the requester)
//    7. the case closes, with its whole review history preserved
//    8. a NEWER recurrence reopens the case automatically
//    9. every append-only history is unchanged by all of the above
//   10. processing the same recurrence again is a no-op
//   11. a FALSE_POSITIVE closure is NOT auto-reopened by the same recurrence
//   12. RBAC grants and the read serializers remain safe
//
// Usage:
//   EVAL_DATABASE_URL="postgresql://user:pw@localhost:5432/threatnexus_eval" \
//     npm run eval:phase3
//
// Safety: refuses to run without an explicit EVAL_DATABASE_URL, refuses to run
// if it equals DATABASE_URL, and never reads DATABASE_URL for its own
// connection — only for that one equality check.
//
// HAND-AUTHORED EXPECTATIONS. Every expected value below is written out
// literally. Nothing is read back from the production module it is meant to be
// checking: a gate that asserted `state === CASE_STATES.CLOSED` would pass no
// matter what CASE_STATES.CLOSED became.
// ===========================================================================

const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");

// RFC 2544 benchmarking range, second octet 22 — distinct from 198.18/19
// (phase2 gate), 198.20/21 (enrichment suites), and every RFC 5737 range
// already claimed, so a shared evaluation database can never let this gate's
// cleanup collide with another's rows.
const MARKER = "phase3-gate";
const NET = "198.22";

// --- Hand-transcribed expectations -----------------------------------------
// Written out as literals, deliberately not imported.
const EXPECTED_TRIAGE_DECISIONS = ["IN_REVIEW", "ESCALATED", "DISMISSED"];
const EXPECTED_CASE_STATES = ["OPEN", "WAITING_FOR_ORG", "CLOSURE_PENDING", "CLOSED"];
const EXPECTED_CLOSURE_REASONS = [
  "REMEDIATED",
  "FALSE_POSITIVE",
  "ACCEPTED_RISK",
  "DUPLICATE",
  "OTHER",
];
const EXPECTED_RESPONSE_TYPES = [
  "ACKNOWLEDGED",
  "INVESTIGATING",
  "REMEDIATED",
  "DISPUTED",
  "NO_RESPONSE",
  "OTHER",
];
const EXPECTED_REFERENCE_YEAR = 2026;

// Fixed instants. No wall clock is read anywhere in this gate, so a re-run
// produces byte-identical expectations.
const T_CREATE = new Date("2026-08-01T08:00:00.000Z");
const T_TRIAGE = new Date("2026-08-01T09:00:00.000Z");
const T_LINK = new Date("2026-08-01T10:00:00.000Z");
const T_ACK = new Date("2026-08-02T09:00:00.000Z");
const T_REMEDIATED = new Date("2026-08-03T09:00:00.000Z");
const T_REQUEST = new Date("2026-08-03T12:00:00.000Z");
const T_APPROVE = new Date("2026-08-03T14:00:00.000Z");
const T_RECUR = new Date("2026-08-10T06:00:00.000Z");
const T_PROCESS = new Date("2026-08-10T06:05:00.000Z");
const T_REPROCESS = new Date("2026-08-11T06:05:00.000Z");

class GateSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "GateSafetyError";
  }
}

function assertSafeEvalDatabaseUrl(env) {
  const evalDatabaseUrl = env.EVAL_DATABASE_URL;
  const originalDatabaseUrl = env.DATABASE_URL;

  if (!evalDatabaseUrl || evalDatabaseUrl.trim() === "") {
    throw new GateSafetyError(
      "EVAL_DATABASE_URL is required. Refusing to run without an explicit, dedicated evaluation database."
    );
  }
  if (originalDatabaseUrl && evalDatabaseUrl.trim() === originalDatabaseUrl.trim()) {
    throw new GateSafetyError(
      "EVAL_DATABASE_URL must not equal DATABASE_URL. Refusing to run against the development database."
    );
  }
  return evalDatabaseUrl;
}

// config/env validates its variables at require time even though this gate
// always passes an explicit {client}. Placeholders are staged only for
// variables not already set, and only AFTER the safety check above.
function stageEnvPlaceholdersForConfigLoad(env) {
  env.NODE_ENV = env.NODE_ENV || "test";
  env.DATABASE_URL = env.DATABASE_URL || "postgresql://unused:unused@localhost:5432/unused";
  env.JWT_SECRET = env.JWT_SECRET || "a-reasonably-strong-32-char-plus-secret-value";
  env.CORS_ORIGIN = env.CORS_ORIGIN || "http://localhost:5173";
}

function requireBackend(relativePath) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(BACKEND_DIR, relativePath));
}

// --- Assertion harness ------------------------------------------------------
const results = [];
let assertionCount = 0;

function scenario(id, title) {
  const record = { id, title, diffs: [] };
  results.push(record);
  return {
    eq(label, actual, expected) {
      assertionCount += 1;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        record.diffs.push({ path: `${id}.${label}`, expected, actual });
      }
    },
    ok(label, actual) {
      assertionCount += 1;
      if (actual !== true) record.diffs.push({ path: `${id}.${label}`, expected: true, actual });
    },
    async throws(label, promise, expectedName) {
      assertionCount += 1;
      try {
        await promise;
        record.diffs.push({ path: `${id}.${label}`, expected: expectedName, actual: "resolved" });
      } catch (error) {
        const actualName = error && error.name;
        if (actualName !== expectedName) {
          record.diffs.push({ path: `${id}.${label}`, expected: expectedName, actual: actualName });
        }
      }
    },
  };
}

// --- Fixture helpers --------------------------------------------------------

// Ordered to respect every onDelete: Restrict relation. Phase 3 rows go first,
// then Case, then the Phase 1/2 evidence they referenced.
async function cleanupEvalState(prisma) {
  const findings = await prisma.finding.findMany({
    where: { indicatorValue: { startsWith: `${NET}.` } },
    select: { id: true },
  });
  const findingIds = findings.map((f) => f.id);

  const cases = await prisma.case.findMany({
    where: { organization: { startsWith: MARKER } },
    select: { id: true },
  });
  const caseIds = cases.map((c) => c.id);

  const reports = await prisma.rawReport.findMany({
    where: { sourceFileName: { startsWith: MARKER } },
    select: { id: true },
  });
  const reportIds = reports.map((r) => r.id);

  await prisma.caseRecurrenceReopen.deleteMany({
    where: { OR: [{ caseId: { in: caseIds } }, { findingId: { in: findingIds } }] },
  });
  // Before the responses, because supportingResponseId is Restrict.
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
  await prisma.findingOccurrence.deleteMany({ where: { rawReportId: { in: reportIds } } });
  await prisma.rawReportRow.deleteMany({ where: { rawReportId: { in: reportIds } } });
  await prisma.finding.deleteMany({ where: { id: { in: findingIds } } });
  await prisma.rawReport.deleteMany({ where: { id: { in: reportIds } } });
  await prisma.assetMapping.deleteMany({
    where: { organization: { name: { startsWith: MARKER } } },
  });
  await prisma.organization.deleteMany({ where: { name: { startsWith: MARKER } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: MARKER } } });
}

async function makeUser(prisma, label, role) {
  return prisma.user.create({
    data: {
      name: `${MARKER}-${label}`,
      email: `${MARKER}-${label}@example.test`,
      // A syntactically valid bcrypt-shaped placeholder. This gate never
      // authenticates; no login path is exercised and no real secret exists.
      password: "$2b$10$synthetic.eval.placeholder.hash.not.a.real.secret.value",
      role,
    },
  });
}

async function makeOrganization(prisma, label) {
  return prisma.organization.create({
    data: {
      name: `${MARKER}-${label}`,
      industry: "synthetic",
      location: "synthetic",
      contactPerson: "synthetic",
      email: `${MARKER}-${label}-contact@example.test`,
      sector: "FINANCE",
    },
  });
}

async function makeFinding(prisma, octets) {
  return prisma.finding.create({
    data: {
      indicatorValue: `${NET}.${octets}`,
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      status: "OPEN",
      firstSeen: T_CREATE,
      lastSeen: T_CREATE,
      occurrenceCount: 1,
      recurrenceCount: 0,
    },
  });
}

async function makeOwnership(prisma, findingId, organizationId, overrides = {}) {
  return prisma.findingOwnership.create({
    data: {
      findingId,
      status: "RESOLVED",
      confidence: "HIGH",
      organizationId,
      isIspAttribution: false,
      reasonCode: "OWNERSHIP_EXACT_IP_MATCH",
      candidateCount: 1,
      asOf: T_CREATE,
      resolvedAt: T_CREATE,
      currentForFindingId: findingId,
      ...overrides,
    },
  });
}

async function makeRecurrenceOccurrence(prisma, findingId, label) {
  const content = Buffer.from(`${MARKER}-${label}`, "utf8");
  const crypto = require("node:crypto");
  const report = await prisma.rawReport.create({
    data: {
      reportType: "ACCESSIBLE_RDP",
      schemaVersion: "accessible-rdp.synthetic.v1",
      sourceFileName: `${MARKER}-${label}.csv`,
      sourceFileSha256: crypto.createHash("sha256").update(content).digest("hex"),
      fileSizeBytes: content.length,
      contentType: "text/csv",
      rawContent: content,
      observationDate: T_RECUR,
      status: "COMPLETED",
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
    },
  });
  return prisma.findingOccurrence.create({
    data: { findingId, rawReportId: report.id, action: "RECURRED", observedAt: T_RECUR },
  });
}

/** A stable, order-independent snapshot of every append-only history row. */
async function snapshotHistories(prisma, { caseIds, findingIds }) {
  const [triage, links, events, responses, closures, reopens] = await Promise.all([
    prisma.findingTriage.findMany({ where: { findingId: { in: findingIds } }, orderBy: { id: "asc" } }),
    prisma.caseFinding.findMany({ where: { caseId: { in: caseIds } }, orderBy: { id: "asc" } }),
    prisma.caseLifecycleEvent.findMany({ where: { caseId: { in: caseIds } }, orderBy: { id: "asc" } }),
    prisma.caseOrganizationResponse.findMany({ where: { caseId: { in: caseIds } }, orderBy: { id: "asc" } }),
    prisma.caseClosureRequest.findMany({ where: { caseId: { in: caseIds } }, orderBy: { id: "asc" } }),
    prisma.caseRecurrenceReopen.findMany({ where: { caseId: { in: caseIds } }, orderBy: { id: "asc" } }),
  ]);
  return JSON.stringify({ triage, links, events, responses, closures, reopens });
}

async function main() {
  const evalDatabaseUrl = assertSafeEvalDatabaseUrl(process.env);
  stageEnvPlaceholdersForConfigLoad(process.env);

  // No code path in this phase performs network I/O. Any attempt fails loudly
  // and is asserted at the end (scenario 12).
  let networkAttempts = 0;
  global.fetch = async () => {
    networkAttempts += 1;
    throw new Error("network access is forbidden in this gate");
  };

  const { PrismaClient } = require(path.join(BACKEND_DIR, "node_modules", "@prisma", "client"));
  const prisma = new PrismaClient({ datasources: { db: { url: evalDatabaseUrl } } });

  const triageService = requireBackend("src/services/workflow/findingTriageService");
  const lifecycleService = requireBackend("src/services/workflow/caseLifecycleService");
  const linkService = requireBackend("src/services/workflow/caseFindingLinkService");
  const responseService = requireBackend("src/services/workflow/caseResponseService");
  const closureService = requireBackend("src/services/workflow/caseClosureService");
  const recurrenceService = requireBackend("src/services/workflow/caseRecurrenceReopenService");
  const readService = requireBackend("src/services/workflow/caseWorkflowReadService");
  const rules = requireBackend("src/services/workflow/caseWorkflowRules");
  const roles = requireBackend("src/lib/roles");

  try {
    await cleanupEvalState(prisma);

    const analyst = await makeUser(prisma, "analyst", "ANALYST");
    const reviewer = await makeUser(prisma, "reviewer", "REVIEWER");
    const organization = await makeOrganization(prisma, "constituent");
    const otherOrganization = await makeOrganization(prisma, "other");

    const finding = await makeFinding(prisma, "0.10");
    await makeOwnership(prisma, finding.id, organization.id);

    // ------------------------------------------------------------------
    // 1. Triage a Finding.
    // ------------------------------------------------------------------
    const s1 = scenario("01_triage_finding", "an untriaged Finding receives an explicit decision");

    const beforeTriage = await triageService.getFindingTriage(finding.id, { client: prisma });
    s1.eq("startsUntriaged", beforeTriage.decision, "UNTRIAGED");
    s1.eq("noHistoryYet", beforeTriage.history.length, 0);

    await triageService.recordTriageDecision(
      { findingId: finding.id, decision: "IN_REVIEW", reason: "Confirming exposure", decidedAt: T_TRIAGE },
      { client: prisma, actorUserId: analyst.id }
    );

    const afterTriage = await triageService.getFindingTriage(finding.id, { client: prisma });
    s1.eq("currentDecision", afterTriage.decision, "IN_REVIEW");
    s1.eq("historyLength", afterTriage.history.length, 1);
    s1.eq("actorRecorded", afterTriage.current.actorUserId, analyst.id);
    s1.eq("source", afterTriage.current.source, "ANALYST_DECISION");
    s1.eq("notSuperseded", afterTriage.current.supersededAt, null);
    // A dismissal with no stated reason is not defensible and must be refused.
    await s1.throws(
      "dismissalNeedsReason",
      triageService.recordTriageDecision(
        { findingId: finding.id, decision: "DISMISSED", decidedAt: T_TRIAGE },
        { client: prisma, actorUserId: analyst.id }
      ),
      "CaseWorkflowValidationError"
    );

    // ------------------------------------------------------------------
    // 2. Create an organization-bound case.
    // ------------------------------------------------------------------
    const s2 = scenario("02_create_case", "a case belongs to exactly one organization");

    const caseRecord = await lifecycleService.createCase(
      {
        title: "Accessible RDP on a constituent host",
        threatType: "Accessible RDP",
        organization: `${MARKER}-legacy-name`,
        analyst: `${MARKER}-analyst`,
        priority: "High",
        organizationId: organization.id,
        createdAt: T_CREATE,
      },
      { client: prisma, actorUserId: analyst.id }
    );

    s2.eq("boundToOrganization", caseRecord.organizationId, organization.id);
    s2.eq("startsOpen", caseRecord.lifecycleState, "OPEN");
    s2.eq("notClosed", caseRecord.closedAt, null);
    s2.eq("neverReopened", caseRecord.reopenedCount, 0);
    // Server-generated, human-readable, and derived from the row's own primary
    // key, so two concurrent creations cannot collide.
    s2.eq(
      "caseReference",
      caseRecord.caseReference,
      `TNX-${EXPECTED_REFERENCE_YEAR}-${String(caseRecord.id).padStart(6, "0")}`
    );

    const createdEvents = await prisma.caseLifecycleEvent.findMany({
      where: { caseId: caseRecord.id },
    });
    s2.eq("oneCreatedEvent", createdEvents.length, 1);
    s2.eq("createdEventType", createdEvents[0].eventType, "CREATED");
    s2.eq("createdFromState", createdEvents[0].fromState, null);
    s2.eq("createdToState", createdEvents[0].toState, "OPEN");
    s2.eq("createdReasonCode", createdEvents[0].reasonCode, "CASE_CREATED");

    // A case with no organization could never accept evidence, so there is no
    // path that produces one.
    await s2.throws(
      "organizationRequired",
      lifecycleService.createCase(
        {
          title: "Unbound",
          threatType: "Accessible RDP",
          organization: `${MARKER}-legacy-name`,
          analyst: `${MARKER}-analyst`,
          createdAt: T_CREATE,
        },
        { client: prisma }
      ),
      "CaseWorkflowValidationError"
    );

    // ------------------------------------------------------------------
    // 3. Link the Finding as evidence.
    // ------------------------------------------------------------------
    const s3 = scenario("03_link_finding", "evidence links only on matching ownership");

    const linkOutcome = await linkService.linkFinding(caseRecord.id, finding.id, {
      client: prisma,
      actorUserId: analyst.id,
      effectiveAt: T_LINK,
      reason: "Same host, same exposure",
    });

    s3.eq("linked", linkOutcome.changed, true);
    s3.eq("linkState", linkOutcome.link.state, "LINKED");
    s3.eq("linkOrganization", linkOutcome.link.organizationId, organization.id);
    s3.eq("ownershipBasis", linkOutcome.link.ownershipStatusAtLink, "RESOLVED");
    s3.eq("ownershipConfidence", linkOutcome.link.ownershipConfidenceAtLink, "HIGH");
    // Linking escalates the Finding, in the same transaction.
    s3.eq("escalated", linkOutcome.escalated, true);
    const escalatedTriage = await triageService.getFindingTriage(finding.id, { client: prisma });
    s3.eq("triageNowEscalated", escalatedTriage.decision, "ESCALATED");
    s3.eq("escalationSource", escalatedTriage.current.source, "CASE_LINK");
    s3.eq("escalationNamesCase", escalatedTriage.current.caseId, caseRecord.id);
    // Linking copies nothing: the Finding's own evidence is untouched.
    const findingAfterLink = await prisma.finding.findUnique({ where: { id: finding.id } });
    s3.eq("findingUnchanged", findingAfterLink.status, "OPEN");
    s3.eq("occurrenceCountUnchanged", findingAfterLink.occurrenceCount, 1);

    // A Finding owned by a DIFFERENT organization is refused, with a code that
    // tells the analyst to resolve ownership first.
    const mismatched = await makeFinding(prisma, "0.11");
    await makeOwnership(prisma, mismatched.id, otherOrganization.id);
    let mismatchCode = null;
    try {
      await linkService.linkFinding(caseRecord.id, mismatched.id, {
        client: prisma,
        actorUserId: analyst.id,
        effectiveAt: T_LINK,
      });
    } catch (error) {
      mismatchCode = error.code;
    }
    s3.eq("organizationMismatchRefused", mismatchCode, "OWNERSHIP_ORGANIZATION_MISMATCH");
    s3.eq(
      "mismatchWroteNothing",
      await prisma.caseFinding.count({ where: { findingId: mismatched.id } }),
      0
    );

    // ------------------------------------------------------------------
    // 4. Record ACKNOWLEDGED, then REMEDIATED.
    // ------------------------------------------------------------------
    const s4 = scenario("04_organization_responses", "an append-only correspondence timeline");

    const acknowledged = await responseService.recordOrganizationResponse(
      caseRecord.id,
      {
        responseType: "ACKNOWLEDGED",
        summary: "Constituent acknowledged receipt and opened an internal ticket",
        reference: "TICKET-4711",
        occurredAt: T_ACK,
      },
      { client: prisma, actorUserId: analyst.id, recordedAt: T_ACK }
    );
    const remediated = await responseService.recordOrganizationResponse(
      caseRecord.id,
      {
        responseType: "REMEDIATED",
        summary: "Constituent reported port 3389 closed at the perimeter",
        occurredAt: T_REMEDIATED,
      },
      { client: prisma, actorUserId: analyst.id, recordedAt: T_REMEDIATED }
    );

    s4.eq("acknowledgedType", acknowledged.responseType, "ACKNOWLEDGED");
    s4.eq("acknowledgedReference", acknowledged.reference, "TICKET-4711");
    s4.eq("remediatedType", remediated.responseType, "REMEDIATED");
    const responses = await responseService.listResponses(prisma, caseRecord.id);
    s4.eq("timelineLength", responses.length, 2);
    s4.eq("newestFirst", responses.map((r) => r.responseType), ["REMEDIATED", "ACKNOWLEDGED"]);
    // A REMEDIATED response is a CLAIM. It closes nothing on its own.
    const caseAfterResponses = await prisma.case.findUnique({ where: { id: caseRecord.id } });
    s4.eq("stillOpen", caseAfterResponses.lifecycleState, "OPEN");
    s4.eq("noClosureRequestYet", await prisma.caseClosureRequest.count({ where: { caseId: caseRecord.id } }), 0);

    // ------------------------------------------------------------------
    // 5. The analyst requests closure.
    // ------------------------------------------------------------------
    const s5 = scenario("05_request_closure", "closure is requested, never taken");

    const requested = await closureService.requestClosure(
      caseRecord.id,
      { closureReason: "REMEDIATED", justification: "Remediation confirmed with the constituent" },
      { client: prisma, actorUserId: analyst.id, requestedAt: T_REQUEST }
    );

    s5.eq("caseAwaitingReview", requested.case.lifecycleState, "CLOSURE_PENDING");
    s5.eq("requestPending", requested.request.state, "PENDING");
    s5.eq("requester", requested.request.requestedByUserId, analyst.id);
    // The rule leaves durable evidence, not merely a check that once passed.
    s5.eq("supportingResponse", requested.request.supportingResponseId, remediated.id);
    s5.eq("activeRequestKey", requested.request.activeCaseId, caseRecord.id);

    const requestedEvent = await prisma.caseLifecycleEvent.findFirst({
      where: { caseId: caseRecord.id, eventType: "CLOSURE_REQUESTED" },
    });
    s5.eq("requestedFromState", requestedEvent.fromState, "OPEN");
    s5.eq("requestedToState", requestedEvent.toState, "CLOSURE_PENDING");
    s5.eq("requestedReasonCode", requestedEvent.reasonCode, "CLOSURE_REQUESTED_BY_ANALYST");

    // While a reviewer is deciding, evidence cannot change underneath them...
    let evidenceCode = null;
    try {
      await linkService.linkFinding(caseRecord.id, finding.id, {
        client: prisma,
        effectiveAt: T_REQUEST,
      });
    } catch (error) {
      evidenceCode = error.code;
    }
    s5.eq("evidenceFrozenDuringReview", evidenceCode, "CASE_NOT_ACCEPTING_EVIDENCE");
    // ...and the analyst cannot withdraw the request by posting a bare state.
    let stateCode = null;
    try {
      await lifecycleService.changeCaseState(caseRecord.id, "OPEN", {
        client: prisma,
        occurredAt: T_REQUEST,
      });
    } catch (error) {
      stateCode = error.code;
    }
    s5.eq("cannotWithdrawByStateChange", stateCode, "CASE_STATE_NOT_ANALYST_SETTABLE");

    // ------------------------------------------------------------------
    // 6. The reviewer approves — and the requester could not have.
    // ------------------------------------------------------------------
    const s6 = scenario("06_reviewer_approves", "separation of duties is enforced in the service");

    // The requester approving their own request is refused, unless they hold
    // the administrator self-approval capability.
    await s6.throws(
      "selfApprovalRefused",
      closureService.approveClosure(caseRecord.id, requested.request.id, {
        client: prisma,
        actorUserId: analyst.id,
        reviewedAt: T_APPROVE,
      }),
      "CaseClosureSelfApprovalError"
    );
    const stillPending = await prisma.caseClosureRequest.findUnique({
      where: { id: requested.request.id },
    });
    s6.eq("stillPendingAfterRefusal", stillPending.state, "PENDING");
    s6.eq(
      "caseStillPendingAfterRefusal",
      (await prisma.case.findUnique({ where: { id: caseRecord.id } })).lifecycleState,
      "CLOSURE_PENDING"
    );

    const approved = await closureService.approveClosure(caseRecord.id, requested.request.id, {
      client: prisma,
      actorUserId: reviewer.id,
      reviewedAt: T_APPROVE,
      reviewNote: "Evidence is sufficient",
    });
    s6.eq("requestApproved", approved.request.state, "APPROVED");
    s6.eq("reviewer", approved.request.reviewedByUserId, reviewer.id);
    s6.eq("activeKeyReleased", approved.request.activeCaseId, null);
    // The request itself is never rewritten.
    s6.eq("requesterPreserved", approved.request.requestedByUserId, analyst.id);
    s6.eq("justificationPreserved", approved.request.justification, "Remediation confirmed with the constituent");
    s6.eq("supportingResponsePreserved", approved.request.supportingResponseId, remediated.id);

    // ------------------------------------------------------------------
    // 7. The case closes, with its whole history intact.
    // ------------------------------------------------------------------
    const s7 = scenario("07_case_closes", "closure is recorded, explicable and complete");

    const closed = await prisma.case.findUnique({ where: { id: caseRecord.id } });
    s7.eq("closedState", closed.lifecycleState, "CLOSED");
    s7.eq("closureReason", closed.closureReason, "REMEDIATED");
    s7.eq("closedBy", closed.closedByUserId, reviewer.id);
    s7.eq("closedAt", closed.closedAt.toISOString(), T_APPROVE.toISOString());
    s7.eq("stillNeverReopened", closed.reopenedCount, 0);

    const timeline = await prisma.caseLifecycleEvent.findMany({
      where: { caseId: caseRecord.id },
      orderBy: { id: "asc" },
    });
    s7.eq(
      "completeTimeline",
      timeline.map((e) => e.eventType),
      ["CREATED", "CLOSURE_REQUESTED", "CLOSURE_APPROVED"]
    );
    s7.eq("approvalReasonCode", timeline[2].reasonCode, "CLOSURE_APPROVED_BY_REVIEWER");
    s7.eq("approvalActor", timeline[2].actorUserId, reviewer.id);

    // A closed case accepts neither new evidence nor new correspondence.
    let closedResponseCode = null;
    try {
      await responseService.recordOrganizationResponse(
        caseRecord.id,
        { responseType: "OTHER", summary: "late reply", occurredAt: T_APPROVE },
        { client: prisma, recordedAt: T_APPROVE }
      );
    } catch (error) {
      closedResponseCode = error.code;
    }
    s7.eq("closedCaseRefusesResponses", closedResponseCode, "CASE_CLOSED");

    // ------------------------------------------------------------------
    // 8/11. A newer recurrence reopens the REMEDIATED case — and only it.
    // ------------------------------------------------------------------
    const s8 = scenario("08_recurrence_reopens", "a newer recurrence reopens a remediated closure");
    const s11 = scenario("11_false_positive_not_reopened", "a false-positive closure is never auto-reopened");

    // A second case on the SAME Finding, closed as FALSE_POSITIVE. One
    // recurrence therefore fans out to two cases with two different answers.
    const falsePositiveCase = await lifecycleService.createCase(
      {
        title: "Accessible RDP — scanner artefact",
        threatType: "Accessible RDP",
        organization: `${MARKER}-legacy-name`,
        analyst: `${MARKER}-analyst`,
        organizationId: organization.id,
        createdAt: T_CREATE,
      },
      { client: prisma, actorUserId: analyst.id }
    );
    await linkService.linkFinding(falsePositiveCase.id, finding.id, {
      client: prisma,
      actorUserId: analyst.id,
      effectiveAt: T_LINK,
    });
    const fpRequest = await closureService.requestClosure(
      falsePositiveCase.id,
      { closureReason: "FALSE_POSITIVE", justification: "Scanner artefact, host is not exposed" },
      { client: prisma, actorUserId: analyst.id, requestedAt: T_REQUEST }
    );
    await closureService.approveClosure(falsePositiveCase.id, fpRequest.request.id, {
      client: prisma,
      actorUserId: reviewer.id,
      reviewedAt: T_APPROVE,
    });

    const occurrence = await makeRecurrenceOccurrence(prisma, finding.id, "recurrence");
    const firstPass = await recurrenceService.processRecurrenceReopensSafely(
      prisma,
      [{ findingId: finding.id, findingOccurrenceId: occurrence.id, observedAt: T_RECUR }],
      { processedAt: T_PROCESS }
    );

    s8.eq("evaluatedBothCases", firstPass.summary.evaluatedPairCount, 2);
    s8.eq("reopenedExactlyOne", firstPass.summary.reopenedCaseCount, 1);
    s8.eq("noFailures", firstPass.summary.failedCount, 0);

    const reopened = await prisma.case.findUnique({ where: { id: caseRecord.id } });
    s8.eq("reopenedState", reopened.lifecycleState, "OPEN");
    s8.eq("closureCleared", reopened.closureReason, null);
    s8.eq("closedAtCleared", reopened.closedAt, null);
    s8.eq("closedByCleared", reopened.closedByUserId, null);
    s8.eq("reopenTrigger", reopened.lastReopenTrigger, "RECURRENCE");
    s8.eq("reopenCount", reopened.reopenedCount, 1);

    const reopenEvent = await prisma.caseLifecycleEvent.findFirst({
      where: { caseId: caseRecord.id, eventType: "REOPENED" },
    });
    s8.eq("reopenFromState", reopenEvent.fromState, "CLOSED");
    s8.eq("reopenToState", reopenEvent.toState, "OPEN");
    s8.eq("reopenReasonCode", reopenEvent.reasonCode, "REOPENED_BY_RECURRENCE");
    // No actor: this is a system consequence of new evidence, not a decision.
    s8.eq("reopenHasNoActor", reopenEvent.actorUserId, null);

    const reopenLedger = await prisma.caseRecurrenceReopen.findFirst({
      where: { caseId: caseRecord.id, findingOccurrenceId: occurrence.id },
    });
    s8.eq("ledgerOutcome", reopenLedger.outcome, "REOPENED");
    s8.eq("ledgerObservedAt", reopenLedger.observedAt.toISOString(), T_RECUR.toISOString());

    // 11 — the false-positive closure is untouched, and the refusal is recorded.
    const untouched = await prisma.case.findUnique({ where: { id: falsePositiveCase.id } });
    s11.eq("stillClosed", untouched.lifecycleState, "CLOSED");
    s11.eq("closureReasonIntact", untouched.closureReason, "FALSE_POSITIVE");
    s11.eq("neverReopened", untouched.reopenedCount, 0);
    s11.eq("closedByIntact", untouched.closedByUserId, reviewer.id);
    const skippedLedger = await prisma.caseRecurrenceReopen.findFirst({
      where: { caseId: falsePositiveCase.id, findingOccurrenceId: occurrence.id },
    });
    // Declining is LEDGERED too — that is what makes the rule provably applied
    // rather than silently skipped.
    s11.eq("refusalLedgered", skippedLedger.outcome, "SKIPPED_CLOSURE_REASON_NOT_REMEDIATED");
    s11.eq(
      "noReopenEvent",
      await prisma.caseLifecycleEvent.count({
        where: { caseId: falsePositiveCase.id, eventType: "REOPENED" },
      }),
      0
    );

    // ------------------------------------------------------------------
    // 9/10. Histories are unchanged, and reprocessing is a no-op.
    // ------------------------------------------------------------------
    const s9 = scenario("09_histories_unchanged", "append-only histories are never rewritten");
    const s10 = scenario("10_recurrence_idempotent", "reprocessing the same occurrence writes nothing");

    const caseIds = [caseRecord.id, falsePositiveCase.id];
    const findingIds = [finding.id, mismatched.id];
    const before = await snapshotHistories(prisma, { caseIds, findingIds });

    const secondPass = await recurrenceService.processRecurrenceReopensSafely(
      prisma,
      [{ findingId: finding.id, findingOccurrenceId: occurrence.id, observedAt: T_RECUR }],
      { processedAt: T_REPROCESS }
    );
    const thirdPass = await recurrenceService.processRecurrenceReopensSafely(
      prisma,
      [{ findingId: finding.id, findingOccurrenceId: occurrence.id, observedAt: T_RECUR }],
      { processedAt: T_REPROCESS }
    );

    s10.eq("secondPassReopensNothing", secondPass.summary.reopenedCaseCount, 0);
    s10.eq("secondPassAllAlreadyProcessed", secondPass.summary.alreadyProcessedCount, 2);
    s10.eq("thirdPassReopensNothing", thirdPass.summary.reopenedCaseCount, 0);
    s10.eq("thirdPassAllAlreadyProcessed", thirdPass.summary.alreadyProcessedCount, 2);
    s10.eq("noFailures", secondPass.summary.failedCount + thirdPass.summary.failedCount, 0);
    s10.eq(
      "ledgerStillTwoRows",
      await prisma.caseRecurrenceReopen.count({ where: { findingOccurrenceId: occurrence.id } }),
      2
    );
    s10.eq(
      "reopenCountUnchanged",
      (await prisma.case.findUnique({ where: { id: caseRecord.id } })).reopenedCount,
      1
    );

    // 9 — byte-identical histories, so nothing was updated, deleted or added.
    const after = await snapshotHistories(prisma, { caseIds, findingIds });
    s9.ok("historiesByteIdentical", before === after);

    // Every history is append-only with at most one current row.
    const triageRows = await prisma.findingTriage.findMany({ where: { findingId: finding.id } });
    s9.eq("triageHistoryLength", triageRows.length, 2);
    s9.eq("oneCurrentTriage", triageRows.filter((r) => r.currentForFindingId !== null).length, 1);
    s9.eq("triageDecisionsInOrder", triageRows.map((r) => r.decision), ["IN_REVIEW", "ESCALATED"]);

    const linkRows = await prisma.caseFinding.findMany({ where: { caseId: caseRecord.id } });
    s9.eq("linkHistoryLength", linkRows.length, 1);
    s9.eq("oneCurrentLink", linkRows.filter((r) => r.currentLinkKey !== null).length, 1);

    const closureRows = await prisma.caseClosureRequest.findMany({ where: { caseId: caseRecord.id } });
    s9.eq("closureHistoryLength", closureRows.length, 1);
    s9.eq("noActiveClosureRequest", closureRows.filter((r) => r.activeCaseId !== null).length, 0);
    s9.eq("approvalNotRewritten", closureRows[0].state, "APPROVED");

    const responseRows = await prisma.caseOrganizationResponse.findMany({
      where: { caseId: caseRecord.id },
    });
    s9.eq("responsesPreserved", responseRows.length, 2);

    // ------------------------------------------------------------------
    // 12. RBAC grants and read serializers remain safe.
    // ------------------------------------------------------------------
    const s12 = scenario("12_rbac_and_serializers", "capabilities and safe reads are unchanged");

    // The separation of duties, asserted against literal capability strings.
    s12.eq("adminReviewsClosure", roles.ROLE_CAPABILITIES.ADMIN.includes("review:case-closure"), true);
    s12.eq("reviewerReviewsClosure", roles.ROLE_CAPABILITIES.REVIEWER.includes("review:case-closure"), true);
    s12.eq("analystCannotReviewClosure", roles.ROLE_CAPABILITIES.ANALYST.includes("review:case-closure"), false);
    s12.eq("viewerCannotReviewClosure", roles.ROLE_CAPABILITIES.VIEWER.includes("review:case-closure"), false);
    s12.eq("analystManagesCases", roles.ROLE_CAPABILITIES.ANALYST.includes("manage:cases"), true);
    s12.eq("reviewerCannotManageCases", roles.ROLE_CAPABILITIES.REVIEWER.includes("manage:cases"), false);
    s12.eq("viewerCannotManageCases", roles.ROLE_CAPABILITIES.VIEWER.includes("manage:cases"), false);
    s12.eq("analystTriages", roles.ROLE_CAPABILITIES.ANALYST.includes("triage:findings"), true);
    s12.eq("reviewerCannotTriage", roles.ROLE_CAPABILITIES.REVIEWER.includes("triage:findings"), false);
    // Every role may READ a case; only ADMIN may self-approve a closure.
    ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"].forEach((role) => {
      s12.eq(`${role}ReadsCases`, roles.ROLE_CAPABILITIES[role].includes("read:cases"), true);
    });
    s12.eq("adminMaySelfApprove", roles.ROLE_CAPABILITIES.ADMIN.includes("override:closure-self-approval"), true);
    ["ANALYST", "REVIEWER", "VIEWER"].forEach((role) => {
      s12.eq(
        `${role}MayNotSelfApprove`,
        roles.ROLE_CAPABILITIES[role].includes("override:closure-self-approval"),
        false
      );
    });
    s12.eq("unknownRoleHasNoCapabilities", roles.ROLE_CAPABILITIES.superuser === undefined, true);

    // The closed vocabularies are exactly the locked contract.
    s12.eq("triageDecisions", rules.TRIAGE_DECISION_VALUES, EXPECTED_TRIAGE_DECISIONS);
    s12.eq("caseStates", rules.CASE_STATE_VALUES, EXPECTED_CASE_STATES);
    s12.eq("closureReasons", rules.CLOSURE_REASON_VALUES, EXPECTED_CLOSURE_REASONS);
    s12.eq("responseTypes", rules.RESPONSE_TYPE_VALUES, EXPECTED_RESPONSE_TYPES);
    s12.eq("onlyRemediatedAutoReopens", rules.AUTO_REOPENABLE_CLOSURE_REASONS, ["REMEDIATED"]);

    // The read path emits no internal key, no organization contact and no
    // audit row — proven against a fully populated real case.
    const workflowView = await readService.getCaseWorkflow(caseRecord.id, { client: prisma });
    const serialized = JSON.stringify(workflowView);
    [
      "currentForFindingId",
      "currentLinkKey",
      "activeCaseId",
      "findingOccurrenceId",
      "contactPerson",
      "phone",
      "auditLog",
      "password",
    ].forEach((forbidden) => {
      s12.eq(`excludes.${forbidden}`, serialized.includes(forbidden), false);
    });
    s12.eq("excludesOrganizationEmail", serialized.includes("-contact@example.test"), false);
    s12.eq("organizationSummaryKeys", Object.keys(workflowView.case.ownerOrganization).sort(), [
      "id",
      "name",
      "sector",
    ]);
    s12.eq("recurrenceBadge", workflowView.case.reopenedByRecurrence, true);
    s12.eq("linkedFindingCount", workflowView.linkedFindings.length, 1);
    s12.eq("indicatorIsVisibleToTheAnalyst", workflowView.linkedFindings[0].finding.indicatorValue, `${NET}.0.10`);
    s12.eq("recurrenceLedgerVisible", workflowView.recurrenceReopens.length, 1);
    s12.eq("recurrenceLedgerOutcome", workflowView.recurrenceReopens[0].outcome, "REOPENED");
    s12.eq("noPendingClosure", workflowView.pendingClosureRequest, null);
    s12.eq("permittedAvailableStates", workflowView.permittedActions.availableStates, ["WAITING_FOR_ORG"]);
    s12.eq("permittedCanReopen", workflowView.permittedActions.canReopen, false);
    s12.eq("permittedCanReviewClosure", workflowView.permittedActions.canReviewClosure, false);

    const listed = await readService.listCases({ client: prisma });
    const listedCase = listed.find((row) => row.id === caseRecord.id);
    s12.eq("listLinkedFindingCount", listedCase.linkedFindingCount, 1);
    s12.eq("listLifecycleState", listedCase.lifecycleState, "OPEN");
    s12.eq("listExcludesContacts", JSON.stringify(listed).includes("-contact@example.test"), false);

    s12.eq("noExternalNetwork", networkAttempts, 0);

    // --- Report -------------------------------------------------------------
    let failed = 0;
    results.forEach((record) => {
      if (record.diffs.length === 0) {
        console.log(`PASS  ${record.id}`);
      } else {
        failed += 1;
        console.log(`FAIL  ${record.id} — ${record.title}`);
        record.diffs.forEach((d) => {
          console.log(
            `        ${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`
          );
        });
      }
    });

    console.log("\nFinal:");
    if (failed === 0) {
      console.log(
        `PASS — ${results.length} Phase 3 analyst-workflow scenarios and ${assertionCount} manually authored assertions match exactly`
      );
    } else {
      console.log(`FAIL — ${failed} of ${results.length} scenarios did not match`);
      process.exitCode = 1;
    }
  } finally {
    await cleanupEvalState(prisma).catch((error) => {
      console.error("Cleanup failed", { name: error && error.name });
    });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
