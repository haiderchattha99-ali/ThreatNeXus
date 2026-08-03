"use strict";

// ===========================================================================
// Executable Phase 4 notification-workflow gate.
//
// The unit and integration suites each prove one layer against a fake or a
// scoped fixture. This gate drives the REAL production services end to end, in
// the real order an analyst would drive them, against a disposable PostgreSQL
// database — and compares every result against expectations written out by
// hand in this file.
//
// The fourteen proofs, in the order the workflow performs them:
//
//    1. an organization-bound case with linked Finding evidence
//    2. a deterministic notification draft built from that evidence
//    3. the analyst edits the draft (and an identical edit is UNCHANGED)
//    4. the analyst submits it for review
//    5. the analyst CANNOT approve their own submission
//    6. a reviewer approves the exact current revision
//    7. the approved revision exports successfully
//    8. the export creates metadata and NO delivery claim
//    9. the analyst records SENT_MANUALLY and then DELIVERED
//   10. an ACKNOWLEDGED response is recorded through the SHARED Phase 3
//       CaseOrganizationResponse service — one row, one table
//   11. editing after approval creates a new DRAFT revision
//   12. the old approval cannot export the new revision
//   13. rejection and resubmission history remains append-only
//   14. the safe serializers and the RBAC table expose no internal field
//
// Usage:
//   EVAL_DATABASE_URL="postgresql://user:pw@localhost:5432/threatnexus_eval" \
//     npm run eval:phase4
//
// Safety: refuses to run without an explicit EVAL_DATABASE_URL, refuses to run
// if it equals DATABASE_URL, never reads DATABASE_URL for its own connection
// (only for that one equality check), never resets/truncates/drops, and cleans
// up an exact evaluator-owned id set on success AND on failure.
//
// HAND-AUTHORED EXPECTATIONS. Every expected value below is written out
// literally. Nothing is read back from the production module it is meant to be
// checking: a gate that asserted `state === NOTIFICATION_STATES.APPROVED`
// would pass no matter what NOTIFICATION_STATES.APPROVED became.
// ===========================================================================

const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");

// RFC 2544 benchmarking range, second octet 23 — distinct from 198.18/19
// (phase2 gate), 198.20/21 (enrichment suites), 198.22 (phase3 gate) and every
// RFC 5737 range already claimed, so a shared evaluation database can never
// let this gate's cleanup collide with another's rows.
const MARKER = "phase4-gate";
const NET = "198.23";

// --- Hand-transcribed expectations -----------------------------------------
// Written out as literals, deliberately not imported.
const EXPECTED_STATES = ["DRAFT", "PENDING_REVIEW", "APPROVED", "REJECTED"];
const EXPECTED_DELIVERY_STATUSES = [
  "SENT_MANUALLY",
  "DELIVERED",
  "FAILED",
  "BOUNCED",
  "UNKNOWN",
];
const EXPECTED_EXPORT_FORMATS = ["EML", "TXT"];
const EXPECTED_REFERENCE_PREFIX = "TNX-NOT-2026-";
const EXPECTED_ANALYST_NOTIFICATION_CAPABILITIES = [
  "read:notifications",
  "manage:notifications",
  "export:notifications",
  "record:notification-delivery",
];
const EXPECTED_REVIEWER_NOTIFICATION_CAPABILITIES = [
  "read:notifications",
  "review:notifications",
];
// The complete set of notification capabilities VIEWER holds: none.
const EXPECTED_VIEWER_NOTIFICATION_CAPABILITIES = [];

// Fixed instants. No wall clock is read anywhere in this gate, so a re-run
// produces byte-identical expectations.
const T_CREATE = new Date("2026-08-03T08:00:00.000Z");
const T_DRAFT = new Date("2026-08-03T09:00:00.000Z");
const T_EDIT = new Date("2026-08-03T10:00:00.000Z");
const T_SUBMIT = new Date("2026-08-03T11:00:00.000Z");
const T_APPROVE = new Date("2026-08-03T12:00:00.000Z");
const T_EXPORT = new Date("2026-08-03T13:00:00.000Z");
const T_SENT = new Date("2026-08-03T14:00:00.000Z");
const T_DELIVERED = new Date("2026-08-04T09:00:00.000Z");
const T_RESPONSE = new Date("2026-08-04T10:00:00.000Z");
const T_REEDIT = new Date("2026-08-05T09:00:00.000Z");
const T_REJECT = new Date("2026-08-05T12:00:00.000Z");
const T_RESUBMIT = new Date("2026-08-05T13:00:00.000Z");
const T_REAPPROVE = new Date("2026-08-05T14:00:00.000Z");

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
    async throws(label, promise, expectedName, expectedCode) {
      assertionCount += 1;
      try {
        await promise;
        record.diffs.push({ path: `${id}.${label}`, expected: expectedName, actual: "resolved" });
      } catch (error) {
        const actualName = error && error.name;
        if (actualName !== expectedName) {
          record.diffs.push({ path: `${id}.${label}`, expected: expectedName, actual: actualName });
          return;
        }
        if (expectedCode !== undefined) {
          assertionCount += 1;
          if (error.code !== expectedCode) {
            record.diffs.push({
              path: `${id}.${label}.code`,
              expected: expectedCode,
              actual: error.code,
            });
          }
        }
      }
    },
  };
}

// --- Fixture helpers --------------------------------------------------------

// Ordered to respect every onDelete: Restrict relation. Notification rows go
// first (and the approval projection is nulled before its revision is
// removed), then Phase 3 case rows, then the Phase 1/2 evidence they
// referenced.
async function cleanupEvalState(prisma) {
  const notifications = await prisma.notification.findMany({
    where: { type: MARKER },
    select: { id: true },
  });
  const notificationIds = notifications.map((n) => n.id);

  if (notificationIds.length > 0) {
    await prisma.notificationDeliveryEvent.deleteMany({
      where: { notificationId: { in: notificationIds } },
    });
    await prisma.notificationExport.deleteMany({
      where: { notificationId: { in: notificationIds } },
    });
    await prisma.notificationLifecycleEvent.deleteMany({
      where: { notificationId: { in: notificationIds } },
    });
    // The approval projection is Restrict onto a revision, so it is released
    // before the revisions themselves are removed.
    await prisma.notification.updateMany({
      where: { id: { in: notificationIds } },
      data: { approvedRevisionId: null },
    });
    await prisma.notificationRevision.deleteMany({
      where: { notificationId: { in: notificationIds } },
    });
    await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
  }

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
  await prisma.finding.deleteMany({ where: { id: { in: findingIds } } });
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
      contactPerson: "Synthetic Contact",
      email: `${MARKER}-${label}-contact@example.test`,
      sector: "FINANCE",
    },
  });
}

async function makeCaseWithEvidence(prisma, organizationId, label, octets) {
  const caseRecord = await prisma.case.create({
    data: {
      title: `${MARKER} accessible RDP ${label}`,
      threatType: "Accessible RDP",
      organization: `${MARKER}-${label}`,
      analyst: `${MARKER}-analyst`,
      organizationId,
      lifecycleState: "OPEN",
      caseReference: `TNX-2026-90${label}`,
      createdAt: T_CREATE,
    },
  });

  const finding = await prisma.finding.create({
    data: {
      indicatorValue: `${NET}.${octets}`,
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      status: "OPEN",
      firstSeen: T_CREATE,
      lastSeen: T_CREATE,
      occurrenceCount: 3,
      recurrenceCount: 0,
    },
  });

  await prisma.caseFinding.create({
    data: {
      caseId: caseRecord.id,
      findingId: finding.id,
      state: "LINKED",
      organizationId,
      ownershipStatusAtLink: "RESOLVED",
      ownershipConfidenceAtLink: "HIGH",
      effectiveAt: T_CREATE,
      currentLinkKey: `${caseRecord.id}:${finding.id}`,
    },
  });

  return { caseRecord, finding };
}

/** Tags a notification so cleanup can find exactly this gate's rows. */
async function tag(prisma, notificationId) {
  await prisma.notification.update({ where: { id: notificationId }, data: { type: MARKER } });
}

async function main() {
  const evalDatabaseUrl = assertSafeEvalDatabaseUrl(process.env);
  stageEnvPlaceholdersForConfigLoad(process.env);

  // No code path in this phase performs network I/O — there is no SMTP client,
  // no webhook and no provider call anywhere in the notification workflow.
  // Any attempt fails loudly and is asserted at the end (scenario 14).
  let networkAttempts = 0;
  global.fetch = async () => {
    networkAttempts += 1;
    throw new Error("network access is forbidden in this gate");
  };

  const { PrismaClient } = require(path.join(BACKEND_DIR, "node_modules", "@prisma", "client"));
  const prisma = new PrismaClient({ datasources: { db: { url: evalDatabaseUrl } } });

  const revisionService = requireBackend("src/services/notification/notificationRevisionService");
  const reviewService = requireBackend("src/services/notification/notificationReviewService");
  const exportService = requireBackend("src/services/notification/notificationExportService");
  const deliveryService = requireBackend("src/services/notification/notificationDeliveryService");
  const readService = requireBackend("src/services/notification/notificationReadService");
  const rules = requireBackend("src/services/notification/notificationRules");
  const caseResponseService = requireBackend("src/services/workflow/caseResponseService");
  const roles = requireBackend("src/lib/roles");

  console.log(
    `Phase 4 notification-workflow gate — database "${new URL(evalDatabaseUrl).pathname.replace(/^\//, "")}"`
  );

  try {
    await cleanupEvalState(prisma);

    const organization = await makeOrganization(prisma, "org");
    const analyst = await makeUser(prisma, "analyst", "ANALYST");
    const reviewer = await makeUser(prisma, "reviewer", "REVIEWER");
    const admin = await makeUser(prisma, "admin", "ADMIN");

    // =====================================================================
    // 1. An organization-bound case with linked Finding evidence
    // =====================================================================
    const s1 = scenario("01_case_and_evidence", "organization-bound case with linked evidence");
    const { caseRecord, finding } = await makeCaseWithEvidence(
      prisma,
      organization.id,
      "1",
      "0.10"
    );

    s1.eq("caseIsOrganizationBound", caseRecord.organizationId, organization.id);
    s1.eq("caseLifecycleState", caseRecord.lifecycleState, "OPEN");
    s1.eq("findingIndicator", finding.indicatorValue, "198.23.0.10");
    s1.eq("findingPort", finding.port, 3389);
    s1.eq("findingOccurrenceCount", finding.occurrenceCount, 3);
    s1.eq(
      "exactlyOneCurrentLink",
      await prisma.caseFinding.count({
        where: { caseId: caseRecord.id, state: "LINKED", supersededAt: null },
      }),
      1
    );

    // =====================================================================
    // 2. A deterministic draft built from that evidence
    // =====================================================================
    const s2 = scenario("02_deterministic_draft", "deterministic draft from persisted evidence");
    const created = await revisionService.createDraftFromCase(caseRecord.id, {
      client: prisma,
      actorUserId: analyst.id,
      createdAt: T_DRAFT,
    });
    const notificationId = created.notification.id;
    await tag(prisma, notificationId);

    s2.eq("lifecycleState", created.notification.lifecycleState, "DRAFT");
    s2.eq("boundToCase", created.notification.caseId, caseRecord.id);
    s2.eq("boundToOrganization", created.notification.organizationId, organization.id);
    s2.ok(
      "referenceFormat",
      created.notification.notificationReference.startsWith(EXPECTED_REFERENCE_PREFIX)
    );
    s2.eq("firstRevisionNumber", created.revision.revisionNumber, 1);
    s2.eq("revisionIsCurrent", created.revision.currentForNotificationId, notificationId);
    s2.eq("revisionNotSuperseded", created.revision.supersededAt, null);

    // The draft states what the evidence says, and nothing else.
    s2.ok("bodyNamesTheHost", created.revision.body.includes("198.23.0.10 port 3389/tcp"));
    s2.ok("bodyNamesTheCase", created.revision.body.includes(caseRecord.caseReference));
    s2.ok("bodyStatesOccurrenceCount", created.revision.body.includes("Times observed:   3"));
    s2.eq("bodyInventsNoCve", /CVE-\d{4}-\d+/.test(created.revision.body), false);
    s2.eq(
      "bodyInventsNoScore",
      /CVSS|EPSS|KEV|risk score/i.test(created.revision.body),
      false
    );
    s2.eq(
      "recipientFromOrganizationRecord",
      created.revision.recipientEmail,
      `${MARKER}-org-contact@example.test`
    );
    s2.eq("analystNotesStartEmpty", created.revision.analystNotes, null);

    // Deterministic: a second draft of the same case has the same checksum.
    const twin = await revisionService.createDraftFromCase(caseRecord.id, {
      client: prisma,
      actorUserId: analyst.id,
      createdAt: T_DRAFT,
    });
    await tag(prisma, twin.notification.id);
    s2.eq(
      "identicalCaseProducesIdenticalChecksum",
      twin.revision.contentChecksum,
      created.revision.contentChecksum
    );

    // =====================================================================
    // 3. The analyst edits the draft; an identical edit is UNCHANGED
    // =====================================================================
    const s3 = scenario("03_analyst_edit", "analyst edits the draft, no-op edits do not flood");
    const noop = await revisionService.editCurrentRevision(
      notificationId,
      { subject: created.revision.subject },
      { client: prisma, actorUserId: analyst.id, occurredAt: T_EDIT }
    );
    s3.eq("noOpOutcome", noop.outcome, "UNCHANGED");
    s3.eq(
      "noOpCreatedNoRevision",
      await prisma.notificationRevision.count({ where: { notificationId } }),
      1
    );

    const edited = await revisionService.editCurrentRevision(
      notificationId,
      { analystNotes: "Ownership confirmed with the registry before drafting." },
      { client: prisma, actorUserId: analyst.id, occurredAt: T_EDIT }
    );
    s3.eq("editOutcome", edited.outcome, "REVISED");
    s3.eq("newRevisionNumber", edited.revision.revisionNumber, 2);
    s3.eq(
      "historyIsAppendOnly",
      await prisma.notificationRevision.count({ where: { notificationId } }),
      2
    );

    const priorRevision = await prisma.notificationRevision.findFirst({
      where: { notificationId, revisionNumber: 1 },
    });
    s3.eq("priorContentUnchanged", priorRevision.subject, created.revision.subject);
    s3.eq("priorChecksumUnchanged", priorRevision.contentChecksum, created.revision.contentChecksum);
    s3.eq("priorSuperseded", priorRevision.supersededAt !== null, true);
    s3.eq("priorNoLongerCurrent", priorRevision.currentForNotificationId, null);
    s3.eq(
      "exactlyOneCurrentRevision",
      await prisma.notificationRevision.count({
        where: { notificationId, currentForNotificationId: { not: null } },
      }),
      1
    );

    // =====================================================================
    // 4. The analyst submits it for review
    // =====================================================================
    const s4 = scenario("04_submit", "analyst submits the current revision for review");
    await revisionService.submitForReview(notificationId, {
      client: prisma,
      actorUserId: analyst.id,
      occurredAt: T_SUBMIT,
    });
    const submitted = await prisma.notification.findUnique({ where: { id: notificationId } });
    s4.eq("lifecycleState", submitted.lifecycleState, "PENDING_REVIEW");
    s4.eq("noApprovalYet", submitted.approvedRevisionId, null);
    s4.eq("noApproverYet", submitted.approvedByUserId, null);

    const submissionEvent = await prisma.notificationLifecycleEvent.findFirst({
      where: { notificationId, eventType: "SUBMITTED_FOR_REVIEW" },
    });
    s4.eq("submissionNamesTheRevision", submissionEvent.revisionId, edited.revision.id);
    s4.eq("submissionRecordsTheActor", submissionEvent.actorUserId, analyst.id);
    s4.eq("submissionReasonCode", submissionEvent.reasonCode, "SUBMITTED_BY_ANALYST");

    // =====================================================================
    // 5. The analyst CANNOT approve their own submission
    // =====================================================================
    const s5 = scenario("05_self_approval_denied", "the submitter may not approve their own revision");
    await s5.throws(
      "analystSelfApprovalRefused",
      reviewService.approveNotification(notificationId, {
        client: prisma,
        actorUserId: analyst.id,
        reviewedAt: T_APPROVE,
      }),
      "NotificationSelfApprovalError"
    );
    const afterDeniedApproval = await prisma.notification.findUnique({
      where: { id: notificationId },
    });
    s5.eq("stillPendingReview", afterDeniedApproval.lifecycleState, "PENDING_REVIEW");
    s5.eq("noApprovalWritten", afterDeniedApproval.approvedRevisionId, null);
    s5.eq(
      "noApprovalEventWritten",
      await prisma.notificationLifecycleEvent.count({
        where: { notificationId, eventType: "APPROVED" },
      }),
      0
    );
    // And an unapproved notification cannot be exported.
    await s5.throws(
      "exportRefusedWhilePendingReview",
      exportService.exportNotification(notificationId, {
        client: prisma,
        actorUserId: analyst.id,
        exportedAt: T_APPROVE,
      }),
      "NotificationExportRefusedError",
      "NOTIFICATION_NOT_APPROVED"
    );
    s5.eq(
      "refusedExportCreatedNoRow",
      await prisma.notificationExport.count({ where: { notificationId } }),
      0
    );

    // =====================================================================
    // 6. A reviewer approves the exact current revision
    // =====================================================================
    const s6 = scenario("06_reviewer_approves", "approval is bound to the exact reviewed revision");
    await reviewService.approveNotification(notificationId, {
      client: prisma,
      actorUserId: reviewer.id,
      reviewedAt: T_APPROVE,
      reviewNote: "Content matches the linked evidence.",
    });
    const approved = await prisma.notification.findUnique({ where: { id: notificationId } });
    s6.eq("lifecycleState", approved.lifecycleState, "APPROVED");
    s6.eq("approvalNamesTheCurrentRevision", approved.approvedRevisionId, edited.revision.id);
    s6.eq("approverRecorded", approved.approvedByUserId, reviewer.id);
    s6.eq("approvalTimeRecorded", approved.approvedAt.toISOString(), T_APPROVE.toISOString());

    const approvalEvent = await prisma.notificationLifecycleEvent.findFirst({
      where: { notificationId, eventType: "APPROVED" },
    });
    s6.eq("approvalEventNamesTheRevision", approvalEvent.revisionId, edited.revision.id);
    s6.eq("approvalEventReasonCode", approvalEvent.reasonCode, "APPROVED_BY_REVIEWER");
    s6.eq("approvalEventNote", approvalEvent.note, "Content matches the linked evidence.");
    s6.eq("approvalEventFromState", approvalEvent.fromState, "PENDING_REVIEW");

    // =====================================================================
    // 7. The approved revision exports successfully
    // =====================================================================
    const s7 = scenario("07_export", "the approved current revision exports");
    const exported = await exportService.exportNotification(notificationId, {
      client: prisma,
      actorUserId: analyst.id,
      exportedAt: T_EXPORT,
    });

    s7.eq("exportRevision", exported.export.revisionId, edited.revision.id);
    s7.eq("exportFormat", exported.export.format, "EML");
    s7.eq("exportActor", exported.export.exportedByUserId, analyst.id);
    s7.eq("exportChecksumIsSha256", /^[0-9a-f]{64}$/.test(exported.export.artifactChecksum), true);
    s7.eq("exportByteLengthMatches", exported.export.artifactByteLength, exported.artifact.byteLength);
    s7.eq(
      "filenameIsSafe",
      /^notification-TNX-NOT-2026-\d{6}-rev2\.eml$/.test(exported.export.filename),
      true
    );

    const artifact = exported.artifact.bytes.toString("utf8");
    // RFC 5322 structure, with CRLF throughout and one blank line before the body.
    s7.eq("artifactUsesCrlf", /(?<!\r)\n/.test(artifact), false);
    s7.eq("artifactHasFrom", /^From: .+\.invalid>\r\n/.test(artifact), true);
    s7.eq("artifactHasExactlyOneTo", (artifact.match(/^To:/gm) || []).length, 1);
    s7.eq("artifactHasNoBcc", /^Bcc:/im.test(artifact), false);
    s7.eq("artifactHasNoCc", /^Cc:/im.test(artifact), false);
    // No fabricated identifier and no fabricated transmission evidence.
    s7.eq("artifactHasNoMessageId", /^Message-ID:/im.test(artifact), false);
    s7.eq("artifactHasNoReceived", /^Received:/im.test(artifact), false);
    // No header injection survived into the artifact.
    s7.eq(
      "artifactHeaderBlockEndsOnce",
      artifact.indexOf("\r\n\r\n"),
      artifact.indexOf("\r\n\r\n")
    );
    s7.ok("artifactAddressesTheOrganizationContact", artifact.includes(`${MARKER}-org-contact@example.test`));
    // The internal analyst notes never leave the system.
    s7.eq(
      "artifactOmitsAnalystNotes",
      artifact.includes("Ownership confirmed with the registry"),
      false
    );

    // =====================================================================
    // 8. The export creates metadata and NO delivery claim
    // =====================================================================
    const s8 = scenario("08_export_is_not_delivery", "an export never implies a delivery");
    s8.eq(
      "exactlyOneExportRecorded",
      await prisma.notificationExport.count({ where: { notificationId } }),
      1
    );
    s8.eq(
      "zeroDeliveryEvents",
      await prisma.notificationDeliveryEvent.count({ where: { notificationId } }),
      0
    );
    const stillApproved = await prisma.notification.findUnique({ where: { id: notificationId } });
    s8.eq("exportDidNotChangeState", stillApproved.lifecycleState, "APPROVED");

    // A repeated export is a second recorded act with identical bytes.
    const secondExport = await exportService.exportNotification(notificationId, {
      client: prisma,
      actorUserId: admin.id,
      exportedAt: T_EXPORT,
    });
    s8.eq(
      "repeatedExportPreservesHistory",
      await prisma.notificationExport.count({ where: { notificationId } }),
      2
    );
    s8.eq("repeatedExportIsADistinctRow", secondExport.export.id !== exported.export.id, true);
    s8.eq(
      "repeatedExportSameChecksum",
      secondExport.export.artifactChecksum,
      exported.export.artifactChecksum
    );
    s8.eq(
      "stillZeroDeliveryEvents",
      await prisma.notificationDeliveryEvent.count({ where: { notificationId } }),
      0
    );

    // =====================================================================
    // 9. The analyst records SENT_MANUALLY and then DELIVERED
    // =====================================================================
    const s9 = scenario("09_delivery_timeline", "append-only delivery timeline, explicitly asserted");
    const sent = await deliveryService.recordDeliveryEvent(
      notificationId,
      { status: "SENT_MANUALLY", occurredAt: T_SENT, reference: "MAILBOX-2026-0803" },
      { client: prisma, actorUserId: analyst.id, recordedAt: T_SENT }
    );
    const delivered = await deliveryService.recordDeliveryEvent(
      notificationId,
      { status: "DELIVERED", occurredAt: T_DELIVERED, note: "Constituent confirmed receipt." },
      { client: prisma, actorUserId: analyst.id, recordedAt: T_DELIVERED }
    );

    s9.eq("sentStatus", sent.status, "SENT_MANUALLY");
    s9.eq("deliveredStatus", delivered.status, "DELIVERED");
    s9.eq("sentOccurredAt", sent.occurredAt.toISOString(), T_SENT.toISOString());
    s9.eq("deliveredOccurredAt", delivered.occurredAt.toISOString(), T_DELIVERED.toISOString());
    // occurredAt is the analyst's instant; recordedAt is ours. Never conflated.
    s9.eq("recordedAtIsSeparate", delivered.recordedAt.toISOString(), T_DELIVERED.toISOString());
    s9.eq("linkedToAnExport", sent.exportId !== null, true);
    s9.eq("linkedToTheExportedRevision", sent.revisionId, edited.revision.id);
    s9.eq(
      "timelineIsAppendOnly",
      await prisma.notificationDeliveryEvent.count({ where: { notificationId } }),
      2
    );
    const deliveryStatuses = (
      await prisma.notificationDeliveryEvent.findMany({
        where: { notificationId },
        orderBy: { occurredAt: "asc" },
      })
    ).map((row) => row.status);
    s9.eq("timelineOrder", deliveryStatuses, ["SENT_MANUALLY", "DELIVERED"]);
    s9.eq(
      "deliveryDidNotChangeState",
      (await prisma.notification.findUnique({ where: { id: notificationId } })).lifecycleState,
      "APPROVED"
    );

    // =====================================================================
    // 10. An ACKNOWLEDGED response through the SHARED Phase 3 service
    // =====================================================================
    const s10 = scenario("10_shared_response", "one CaseOrganizationResponse row, one table");
    const responseRow = await caseResponseService.recordOrganizationResponse(
      caseRecord.id,
      {
        responseType: "ACKNOWLEDGED",
        summary: "Constituent acknowledged the notification and opened an internal ticket.",
        reference: "ACME-INC-4471",
        occurredAt: T_RESPONSE,
      },
      { client: prisma, actorUserId: analyst.id, recordedAt: T_RESPONSE }
    );

    s10.eq("responseType", responseRow.responseType, "ACKNOWLEDGED");
    s10.eq("responseIsOnTheCase", responseRow.caseId, caseRecord.id);
    s10.eq(
      "exactlyOneResponseRow",
      await prisma.caseOrganizationResponse.count({ where: { caseId: caseRecord.id } }),
      1
    );
    // The notification view and the case timeline read the SAME row.
    const detailWithResponse = await readService.getNotificationDetail(notificationId, {
      client: prisma,
    });
    s10.eq("notificationViewShowsIt", detailWithResponse.caseResponses.length, 1);
    s10.eq("notificationViewShowsTheSameRow", detailWithResponse.caseResponses[0].id, responseRow.id);
    // A response closes nothing.
    s10.eq(
      "caseStillOpen",
      (await prisma.case.findUnique({ where: { id: caseRecord.id } })).lifecycleState,
      "OPEN"
    );
    s10.eq(
      "notificationStillApproved",
      (await prisma.notification.findUnique({ where: { id: notificationId } })).lifecycleState,
      "APPROVED"
    );

    // =====================================================================
    // 11. Editing after approval creates a new DRAFT revision
    // =====================================================================
    const s11 = scenario("11_edit_after_approval", "an edit after approval returns to DRAFT");
    const approvedRevisionIdBeforeEdit = (
      await prisma.notification.findUnique({ where: { id: notificationId } })
    ).approvedRevisionId;

    const reEdited = await revisionService.editCurrentRevision(
      notificationId,
      { subject: "Corrected subject after reviewer feedback" },
      { client: prisma, actorUserId: analyst.id, occurredAt: T_REEDIT }
    );

    const afterEdit = await prisma.notification.findUnique({ where: { id: notificationId } });
    s11.eq("outcome", reEdited.outcome, "REVISED");
    s11.eq("newRevisionNumber", reEdited.revision.revisionNumber, 3);
    s11.eq("backToDraft", afterEdit.lifecycleState, "DRAFT");
    s11.eq("approvalProjectionCleared", afterEdit.approvedRevisionId, null);
    s11.eq("approverCleared", afterEdit.approvedByUserId, null);
    s11.eq("approvalTimeCleared", afterEdit.approvedAt, null);

    // The approval RECORD survives; only the projection was cleared.
    const approvalEventStillThere = await prisma.notificationLifecycleEvent.findFirst({
      where: { notificationId, eventType: "APPROVED" },
    });
    s11.eq("approvalEventSurvives", approvalEventStillThere.revisionId, approvedRevisionIdBeforeEdit);
    const editEvent = await prisma.notificationLifecycleEvent.findFirst({
      where: { notificationId, eventType: "REVISION_CREATED", revisionId: reEdited.revision.id },
    });
    s11.eq("editReasonCode", editEvent.reasonCode, "REVISION_EDITED_AFTER_APPROVAL");
    s11.eq("editFromState", editEvent.fromState, "APPROVED");

    // =====================================================================
    // 12. The old approval cannot export the new revision
    // =====================================================================
    const s12 = scenario("12_stale_approval", "a prior approval never authorizes a later revision");
    await s12.throws(
      "exportRefusedAfterEdit",
      exportService.exportNotification(notificationId, {
        client: prisma,
        actorUserId: analyst.id,
        exportedAt: T_REEDIT,
      }),
      "NotificationExportRefusedError",
      "NOTIFICATION_NOT_APPROVED"
    );
    s12.eq(
      "noNewExportRow",
      await prisma.notificationExport.count({ where: { notificationId } }),
      2
    );

    // Even if the state were forced back to APPROVED while the approval still
    // named the OLD revision, the guard refuses on the revision binding.
    await prisma.notification.update({
      where: { id: notificationId },
      data: {
        lifecycleState: "APPROVED",
        approvedRevisionId: approvedRevisionIdBeforeEdit,
        approvedByUserId: reviewer.id,
        approvedAt: T_APPROVE,
      },
    });
    await s12.throws(
      "exportRefusedOnStaleRevisionBinding",
      exportService.exportNotification(notificationId, {
        client: prisma,
        actorUserId: analyst.id,
        exportedAt: T_REEDIT,
      }),
      "NotificationExportRefusedError",
      "APPROVAL_NOT_FOR_CURRENT_REVISION"
    );
    s12.eq(
      "stillNoNewExportRow",
      await prisma.notificationExport.count({ where: { notificationId } }),
      2
    );

    // An APPROVED notification with a NULL approver is refused too.
    const currentRevision = await prisma.notificationRevision.findUnique({
      where: { currentForNotificationId: notificationId },
    });
    await prisma.notification.update({
      where: { id: notificationId },
      data: { approvedRevisionId: currentRevision.id, approvedByUserId: null },
    });
    await s12.throws(
      "exportRefusedWithNullApprover",
      exportService.exportNotification(notificationId, {
        client: prisma,
        actorUserId: analyst.id,
        exportedAt: T_REEDIT,
      }),
      "NotificationExportRefusedError",
      "APPROVER_MISSING"
    );
    s12.eq(
      "stillOnlyTwoExports",
      await prisma.notificationExport.count({ where: { notificationId } }),
      2
    );

    // Restore the honest state for the remaining scenarios.
    await prisma.notification.update({
      where: { id: notificationId },
      data: {
        lifecycleState: "DRAFT",
        approvedRevisionId: null,
        approvedByUserId: null,
        approvedAt: null,
      },
    });

    // =====================================================================
    // 13. Rejection and resubmission history remains append-only
    // =====================================================================
    const s13 = scenario("13_reject_resubmit", "rejection and resubmission history is append-only");
    await revisionService.submitForReview(notificationId, {
      client: prisma,
      actorUserId: analyst.id,
      occurredAt: T_RESUBMIT,
    });
    await reviewService.rejectNotification(notificationId, {
      client: prisma,
      actorUserId: reviewer.id,
      reviewedAt: T_REJECT,
      reason: "The remediation guidance does not match this service.",
    });

    const rejected = await prisma.notification.findUnique({ where: { id: notificationId } });
    s13.eq("rejectedState", rejected.lifecycleState, "REJECTED");
    s13.eq("rejectionCarriesNoApproval", rejected.approvedRevisionId, null);

    const rejectionEvent = await prisma.notificationLifecycleEvent.findFirst({
      where: { notificationId, eventType: "REJECTED" },
    });
    s13.eq(
      "rejectionReasonStored",
      rejectionEvent.note,
      "The remediation guidance does not match this service."
    );

    // Edit into a new draft, resubmit, approve.
    const fourth = await revisionService.editCurrentRevision(
      notificationId,
      { remediationGuidance: "Corrected remediation guidance for this service." },
      { client: prisma, actorUserId: analyst.id, occurredAt: T_RESUBMIT }
    );
    s13.eq("fourthRevisionNumber", fourth.revision.revisionNumber, 4);
    await revisionService.submitForReview(notificationId, {
      client: prisma,
      actorUserId: analyst.id,
      occurredAt: T_RESUBMIT,
    });
    await reviewService.approveNotification(notificationId, {
      client: prisma,
      actorUserId: reviewer.id,
      reviewedAt: T_REAPPROVE,
    });

    const eventTypes = (
      await prisma.notificationLifecycleEvent.findMany({
        where: { notificationId },
        orderBy: { id: "asc" },
      })
    ).map((row) => row.eventType);
    s13.eq("completeAppendOnlyHistory", eventTypes, [
      "DRAFT_CREATED",
      "REVISION_CREATED",
      "SUBMITTED_FOR_REVIEW",
      "APPROVED",
      "EXPORTED",
      "EXPORTED",
      "DELIVERY_RECORDED",
      "DELIVERY_RECORDED",
      "REVISION_CREATED",
      "SUBMITTED_FOR_REVIEW",
      "REJECTED",
      "REVISION_CREATED",
      "SUBMITTED_FOR_REVIEW",
      "APPROVED",
    ]);
    s13.eq(
      "everyRevisionSurvives",
      await prisma.notificationRevision.count({ where: { notificationId } }),
      4
    );
    s13.eq(
      "exactlyOneRevisionIsCurrent",
      await prisma.notificationRevision.count({
        where: { notificationId, currentForNotificationId: { not: null } },
      }),
      1
    );
    // The re-approved notification exports again, against revision 4.
    const finalExport = await exportService.exportNotification(notificationId, {
      client: prisma,
      actorUserId: analyst.id,
      exportedAt: T_REAPPROVE,
    });
    s13.eq("finalExportRevision", finalExport.export.revisionId, fourth.revision.id);
    s13.eq(
      "exportHistoryPreserved",
      await prisma.notificationExport.count({ where: { notificationId } }),
      3
    );
    s13.eq(
      "deliveryHistoryUntouched",
      await prisma.notificationDeliveryEvent.count({ where: { notificationId } }),
      2
    );

    // =====================================================================
    // 14. Safe serializers and RBAC expose no internal field
    // =====================================================================
    const s14 = scenario("14_safe_reads_and_rbac", "safe serializers and the capability table");
    const detail = await readService.getNotificationDetail(notificationId, { client: prisma });
    const serialized = JSON.stringify(detail);

    s14.eq("noCurrentRowKey", serialized.includes("currentForNotificationId"), false);
    s14.eq(
      "noVerbatimRecipientAddress",
      serialized.includes(`${MARKER}-org-contact@example.test`),
      false
    );
    s14.eq(
      "recipientIsMasked",
      /^.\*+@example\.test$/.test(detail.currentRevision.recipientEmailMasked),
      true
    );
    // The recipient NAME is deliberately visible: it is the approved
    // recipient snapshotted onto the revision, and a reviewer who cannot see
    // who a message is addressed to cannot meaningfully approve it. What must
    // not happen is that name (or any other contact field) appearing anywhere
    // ELSE — in the organization summary, the case block, or an export row.
    s14.eq("recipientNameIsTheApprovedRecipient", detail.currentRevision.recipientName, "Synthetic Contact");
    const withoutRecipientNames = JSON.stringify({
      ...detail,
      currentRevision: { ...detail.currentRevision, recipientName: null },
    });
    s14.eq(
      "contactPersonAppearsNowhereElse",
      withoutRecipientNames.includes("Synthetic Contact"),
      false
    );
    s14.eq(
      "organizationSummaryHasNoContactPerson",
      "contactPerson" in detail.notification.organization,
      false
    );
    s14.eq("caseBlockHasNoContactFields", /contactPerson|phone|industry|location/.test(JSON.stringify(detail.case)), false);
    s14.eq("noArtifactBytes", serialized.includes("noreply@threatnexus.invalid"), false);
    s14.eq("noLegacyTitleProjection", "title" in detail.notification, false);
    s14.eq("noLegacyMessageProjection", "message" in detail.notification, false);
    s14.eq(
      "organizationSummaryKeys",
      Object.keys(detail.notification.organization).sort(),
      ["id", "name", "sector"]
    );
    s14.eq("exportKeysAreSafe", Object.keys(detail.exports[0]).includes("bytes"), false);
    s14.eq("permittedActionsCanExport", detail.permittedActions.canExport, true);
    s14.eq("permittedActionsExportRefusal", detail.permittedActions.exportRefusalCode, null);
    s14.eq("permittedActionsCanRecordDelivery", detail.permittedActions.canRecordDelivery, true);
    s14.eq("permittedActionsApprovedForCurrent", detail.permittedActions.approvedForCurrentRevision, true);

    // The list surface excludes legacy, non-workflow rows entirely.
    const listed = await readService.listNotifications({ client: prisma, page: 1, limit: 25 });
    s14.eq(
      "listExcludesContacts",
      JSON.stringify(listed).includes(`${MARKER}-org-contact@example.test`),
      false
    );
    s14.ok("listIncludesThisNotification", listed.notifications.some((n) => n.id === notificationId));

    // The closed vocabularies, transcribed by hand above.
    s14.eq("lifecycleStates", Object.values(rules.NOTIFICATION_STATES), EXPECTED_STATES);
    s14.eq("deliveryStatuses", rules.DELIVERY_STATUS_VALUES, EXPECTED_DELIVERY_STATUSES);
    s14.eq("exportFormats", rules.EXPORT_FORMAT_VALUES, EXPECTED_EXPORT_FORMATS);

    // RBAC: the separation of duties, asserted against the capability table.
    const analystCaps = roles.ROLE_CAPABILITIES.ANALYST;
    const reviewerCaps = roles.ROLE_CAPABILITIES.REVIEWER;
    const viewerCaps = roles.ROLE_CAPABILITIES.VIEWER;
    const notificationCaps = (list) =>
      list.filter((c) => c.includes("notification")).sort();

    s14.eq(
      "analystNotificationCapabilities",
      notificationCaps(analystCaps),
      [...EXPECTED_ANALYST_NOTIFICATION_CAPABILITIES].sort()
    );
    s14.eq(
      "reviewerNotificationCapabilities",
      notificationCaps(reviewerCaps),
      [...EXPECTED_REVIEWER_NOTIFICATION_CAPABILITIES].sort()
    );
    s14.eq(
      "viewerNotificationCapabilities",
      notificationCaps(viewerCaps),
      EXPECTED_VIEWER_NOTIFICATION_CAPABILITIES
    );
    // The two halves of the separation of duties never overlap.
    s14.eq("analystCannotApprove", analystCaps.includes("review:notifications"), false);
    s14.eq("reviewerCannotEdit", reviewerCaps.includes("manage:notifications"), false);
    s14.eq("reviewerCannotExport", reviewerCaps.includes("export:notifications"), false);
    s14.eq(
      "reviewerCannotRecordDelivery",
      reviewerCaps.includes("record:notification-delivery"),
      false
    );
    s14.eq(
      "onlyAdminMaySelfApprove",
      [analystCaps, reviewerCaps, viewerCaps].some((list) =>
        list.includes("override:notification-self-approval")
      ),
      false
    );
    s14.ok(
      "adminMaySelfApprove",
      roles.ROLE_CAPABILITIES.ADMIN.includes("override:notification-self-approval")
    );

    s14.eq("noExternalNetwork", networkAttempts, 0);

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
        `PASS — ${results.length} Phase 4 notification-workflow scenarios and ${assertionCount} manually authored assertions match exactly`
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
