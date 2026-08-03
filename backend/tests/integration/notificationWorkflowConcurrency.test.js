import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Real-PostgreSQL tests for the Phase 4 notification workflow.
//
// These exist because the in-memory fake used by the unit suites cannot prove:
//
//   * NotificationRevision.currentForNotificationId — the distinct-NULLs
//     current-row unique — holding under GENUINE concurrency
//   * the COMPOSITE (notificationId, revisionNumber) unique actually stopping
//     two racing edits from both becoming revision N+1
//   * the guarded notification.updateMany compare-and-swap admitting exactly
//     one of two racing reviewers
//   * onDelete: Restrict actually refusing to orphan an approval, an export or
//     a delivery claim
//   * SERIALIZABLE whole-transaction retry against a real engine
//
// EVERY RACE USES SEPARATE, PRE-CONNECTED PrismaClient INSTANCES. This is the
// trap this repository has already been bitten by twice (P2-T2b, and again in
// riskScoringConcurrency case 3): `Promise.all` over ONE shared client
// serializes the calls enough to hide the race, so such a test passes even
// against an implementation with no invariant at all. Pre-connecting matters
// too — a lazy first connect would stagger the racers by the handshake.
//
// Self-skips unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_test?schema=public" \
//     npx vitest run tests/integration/notificationWorkflowConcurrency.test.js --no-file-parallelism

const { PrismaClient } = require("@prisma/client");

const {
  createDraftFromCase,
  editCurrentRevision,
  submitForReview,
} = require("../../src/services/notification/notificationRevisionService");
const {
  approveNotification,
  rejectNotification,
} = require("../../src/services/notification/notificationReviewService");
const {
  exportNotification,
} = require("../../src/services/notification/notificationExportService");
const {
  recordDeliveryEvent,
} = require("../../src/services/notification/notificationDeliveryService");
const {
  getNotificationDetail,
} = require("../../src/services/notification/notificationReadService");
const {
  recordOrganizationResponse,
} = require("../../src/services/workflow/caseResponseService");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// RFC 5737 TEST-NET-3, third octet 5 — distinct from 203.0.113.2 (P2-T3),
// 203.0.113.4 (Phase 3 workflow) and 203.0.113.8/9 (vulnerability suites), so
// cleanup here can never collide with another suite's rows.
const MARKER = "p4-notification";
const IP_PREFIX = "203.0.113.5";

const ASOF = new Date("2026-08-03T00:00:00.000Z");
const HOUR = 3600000;
const at = (hours) => new Date(ASOF.getTime() + hours * HOUR);

let prisma;
let racers = [];
let ORG_ID;
let ANALYST_ID;
let REVIEWER_ID;

// Ordered by dependency: every Phase 4 FK is Restrict, so the rows that
// reference must go before the rows referenced. The approval projection on
// Notification points at a revision, so it is nulled before revisions are
// removed.
async function cleanup() {
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
    where: { indicatorValue: { startsWith: IP_PREFIX } },
    select: { id: true },
  });
  const findingIds = findings.map((f) => f.id);

  const cases = await prisma.case.findMany({
    where: { analyst: MARKER },
    select: { id: true },
  });
  const caseIds = cases.map((c) => c.id);

  if (caseIds.length > 0) {
    await prisma.caseOrganizationResponse.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.caseFinding.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.caseLifecycleEvent.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  }
  if (findingIds.length > 0) {
    await prisma.finding.deleteMany({ where: { id: { in: findingIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${MARKER}.test` } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: MARKER } } });
  await prisma.auditLog.deleteMany({ where: { requestId: MARKER } });
}

async function seedCase(suffix) {
  const record = await prisma.case.create({
    data: {
      title: `Accessible RDP ${suffix}`,
      threatType: "Accessible RDP",
      organization: `${MARKER} org`,
      analyst: MARKER,
      organizationId: ORG_ID,
      lifecycleState: "OPEN",
      caseReference: `TNX-P4-${suffix}-${Date.now()}`,
    },
  });

  const finding = await prisma.finding.create({
    data: {
      indicatorValue: `${IP_PREFIX}.${(suffix % 200) + 10}`,
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      firstSeen: at(0),
      lastSeen: at(1),
      occurrenceCount: 2,
    },
  });

  await prisma.caseFinding.create({
    data: {
      caseId: record.id,
      findingId: finding.id,
      state: "LINKED",
      organizationId: ORG_ID,
      ownershipStatusAtLink: "RESOLVED",
      ownershipConfidenceAtLink: "HIGH",
      effectiveAt: at(1),
      currentLinkKey: `${record.id}:${finding.id}`,
    },
  });

  return record;
}

/** A DRAFT notification on its own fresh case. */
async function seedDraft(suffix) {
  const record = await seedCase(suffix);
  const created = await createDraftFromCase(record.id, {
    client: prisma,
    actorUserId: ANALYST_ID,
    createdAt: at(2),
  });
  // Tagged so cleanup can find it without touching another suite's rows.
  await prisma.notification.update({ where: { id: created.notification.id }, data: { type: MARKER } });
  return created.notification.id;
}

async function seedApproved(suffix) {
  const id = await seedDraft(suffix);
  await submitForReview(id, { client: prisma, actorUserId: ANALYST_ID, occurredAt: at(3) });
  await approveNotification(id, { client: prisma, actorUserId: REVIEWER_ID, reviewedAt: at(4) });
  return id;
}

/**
 * N separate, pre-connected clients. See the file header for why a shared
 * client would make every race below vacuous.
 */
async function connectRacers(count) {
  racers = Array.from(
    { length: count },
    () => new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } })
  );
  await Promise.all(racers.map((client) => client.$connect()));
  return racers;
}

async function disconnectRacers() {
  await Promise.all(racers.map((client) => client.$disconnect()));
  racers = [];
}

const settled = (results) => ({
  fulfilled: results.filter((r) => r.status === "fulfilled"),
  rejected: results.filter((r) => r.status === "rejected"),
});

describe.skipIf(!TEST_DATABASE_URL)("Phase 4 notification workflow — real PostgreSQL", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    const organization = await prisma.organization.create({
      data: {
        name: `${MARKER} org`,
        industry: "Finance",
        location: "Karachi",
        contactPerson: "Sec Contact",
        email: `soc@${MARKER}.test`,
        sector: "FINANCE",
      },
    });
    ORG_ID = organization.id;

    ANALYST_ID = (
      await prisma.user.create({
        data: {
          name: "Analyst",
          email: `analyst@${MARKER}.test`,
          password: "x",
          role: "ANALYST",
        },
      })
    ).id;
    REVIEWER_ID = (
      await prisma.user.create({
        data: {
          name: "Reviewer",
          email: `reviewer@${MARKER}.test`,
          password: "x",
          role: "REVIEWER",
        },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await disconnectRacers();
    await prisma.$disconnect();
  });

  it("1. keeps exactly one current revision under six concurrent edits", async () => {
    const id = await seedDraft(1);
    const clients = await connectRacers(6);

    const results = await Promise.allSettled(
      clients.map((client, index) =>
        editCurrentRevision(
          id,
          { subject: `Concurrent subject ${index}` },
          { client, actorUserId: ANALYST_ID, occurredAt: at(5 + index) }
        )
      )
    );
    await disconnectRacers();

    const { fulfilled, rejected } = settled(results);
    // Every edit either lands as its own revision or is refused; none may
    // corrupt the invariant.
    expect(fulfilled.length).toBeGreaterThan(0);
    rejected.forEach((r) => {
      expect(["NotificationStateError", "PrismaClientKnownRequestError"]).toContain(r.reason.name);
    });

    const current = await prisma.notificationRevision.findMany({
      where: { notificationId: id, currentForNotificationId: { not: null } },
    });
    expect(current).toHaveLength(1);

    // Revision numbers are contiguous and unique — the composite unique held.
    const all = await prisma.notificationRevision.findMany({
      where: { notificationId: id },
      orderBy: { revisionNumber: "asc" },
    });
    expect(all.map((r) => r.revisionNumber)).toEqual(all.map((_r, i) => i + 1));
    expect(new Set(all.map((r) => r.revisionNumber)).size).toBe(all.length);
  });

  it("2. admits exactly one of two racing reviewers", async () => {
    const id = await seedDraft(2);
    await submitForReview(id, { client: prisma, actorUserId: ANALYST_ID, occurredAt: at(3) });

    const [approver, rejecter] = await connectRacers(2);
    const results = await Promise.allSettled([
      approveNotification(id, { client: approver, actorUserId: REVIEWER_ID, reviewedAt: at(4) }),
      rejectNotification(id, {
        client: rejecter,
        actorUserId: REVIEWER_ID,
        reviewedAt: at(4),
        reason: "Concurrent rejection.",
      }),
    ]);
    await disconnectRacers();

    const { fulfilled } = settled(results);
    expect(fulfilled).toHaveLength(1);

    const record = await prisma.notification.findUnique({ where: { id } });
    expect(["APPROVED", "REJECTED"]).toContain(record.lifecycleState);

    // Exactly one decision event exists — the loser wrote nothing.
    const decisions = await prisma.notificationLifecycleEvent.findMany({
      where: { notificationId: id, eventType: { in: ["APPROVED", "REJECTED"] } },
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].eventType).toBe(record.lifecycleState);

    // The projection agrees with the state, in both directions.
    if (record.lifecycleState === "APPROVED") {
      expect(record.approvedRevisionId).not.toBeNull();
      expect(record.approvedByUserId).toBe(REVIEWER_ID);
    } else {
      expect(record.approvedRevisionId).toBeNull();
    }
  });

  it("3. never lets a concurrent edit be approved out from under the reviewer", async () => {
    const id = await seedDraft(3);
    await submitForReview(id, { client: prisma, actorUserId: ANALYST_ID, occurredAt: at(3) });
    const submittedRevision = await prisma.notificationRevision.findUnique({
      where: { currentForNotificationId: id },
    });

    const [reviewer, editor] = await connectRacers(2);
    const results = await Promise.allSettled([
      approveNotification(id, { client: reviewer, actorUserId: REVIEWER_ID, reviewedAt: at(4) }),
      editCurrentRevision(
        id,
        { subject: "Slipped in during review" },
        { client: editor, actorUserId: ANALYST_ID, occurredAt: at(4) }
      ),
    ]);
    await disconnectRacers();

    const record = await prisma.notification.findUnique({ where: { id } });

    if (record.lifecycleState === "APPROVED") {
      // The approval must name the revision that was actually reviewed.
      expect(record.approvedRevisionId).toBe(submittedRevision.id);
      const current = await prisma.notificationRevision.findUnique({
        where: { currentForNotificationId: id },
      });
      expect(current.id).toBe(submittedRevision.id);
    } else {
      // The edit won: the notification is back to DRAFT with NO approval.
      expect(record.lifecycleState).toBe("DRAFT");
      expect(record.approvedRevisionId).toBeNull();
      expect(record.approvedByUserId).toBeNull();
    }

    // Whichever won, an APPROVED-looking projection against a newer revision
    // never exists.
    expect(results.length).toBe(2);
  });

  it("4. keeps every export bound to the revision that was current when it ran", async () => {
    const id = await seedApproved(4);
    const clients = await connectRacers(4);

    const results = await Promise.allSettled(
      clients.map((client, index) =>
        exportNotification(id, {
          client,
          actorUserId: ANALYST_ID,
          exportedAt: at(6 + index),
        })
      )
    );
    await disconnectRacers();

    const { fulfilled } = settled(results);
    expect(fulfilled.length).toBeGreaterThan(0);

    const current = await prisma.notificationRevision.findUnique({
      where: { currentForNotificationId: id },
    });
    const exports = await prisma.notificationExport.findMany({ where: { notificationId: id } });

    // Repeated exports each got their own row...
    expect(exports).toHaveLength(fulfilled.length);
    // ...all of the same revision, with the same content checksum.
    exports.forEach((row) => {
      expect(row.revisionId).toBe(current.id);
      expect(row.artifactChecksum).toMatch(/^[0-9a-f]{64}$/);
    });
    // Same revision + same content => identical artifact checksums, differing
    // only if the exportedAt Date header differed.
    expect(new Set(exports.map((r) => r.revisionId)).size).toBe(1);

    // And still no delivery claim of any kind.
    const deliveries = await prisma.notificationDeliveryEvent.findMany({
      where: { notificationId: id },
    });
    expect(deliveries).toHaveLength(0);
  });

  it("5. refuses every export once a concurrent edit has invalidated the approval", async () => {
    const id = await seedApproved(5);
    const [editor, exporter] = await connectRacers(2);

    // The edit lands first, deterministically.
    await editCurrentRevision(
      id,
      { subject: "Edited after approval" },
      { client: editor, actorUserId: ANALYST_ID, occurredAt: at(6) }
    );

    await expect(
      exportNotification(id, { client: exporter, actorUserId: ANALYST_ID, exportedAt: at(7) })
    ).rejects.toMatchObject({ name: "NotificationExportRefusedError" });
    await disconnectRacers();

    expect(await prisma.notificationExport.count({ where: { notificationId: id } })).toBe(0);
  });

  it("6. appends every concurrent delivery claim without losing one", async () => {
    const id = await seedApproved(6);
    await exportNotification(id, { client: prisma, actorUserId: ANALYST_ID, exportedAt: at(6) });

    const clients = await connectRacers(5);
    const statuses = ["SENT_MANUALLY", "DELIVERED", "FAILED", "BOUNCED", "UNKNOWN"];
    const results = await Promise.allSettled(
      clients.map((client, index) =>
        recordDeliveryEvent(
          id,
          { status: statuses[index], occurredAt: at(7 + index) },
          { client, actorUserId: ANALYST_ID, recordedAt: at(8) }
        )
      )
    );
    await disconnectRacers();

    const { fulfilled } = settled(results);
    expect(fulfilled).toHaveLength(5);

    const rows = await prisma.notificationDeliveryEvent.findMany({
      where: { notificationId: id },
      orderBy: { occurredAt: "asc" },
    });
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.status)).toEqual(statuses);
    // Append-only: every row still points at the one export that existed.
    expect(new Set(rows.map((r) => r.exportId)).size).toBe(1);
  });

  it("7. refuses to orphan an approval, an export or a delivery claim (onDelete: Restrict)", async () => {
    const id = await seedApproved(7);
    await exportNotification(id, { client: prisma, actorUserId: ANALYST_ID, exportedAt: at(6) });
    await recordDeliveryEvent(
      id,
      { status: "SENT_MANUALLY", occurredAt: at(7) },
      { client: prisma, actorUserId: ANALYST_ID, recordedAt: at(7) }
    );

    const record = await prisma.notification.findUnique({ where: { id } });

    // The revision an approval and an export both point at cannot be removed.
    await expect(
      prisma.notificationRevision.delete({ where: { id: record.approvedRevisionId } })
    ).rejects.toMatchObject({ code: "P2003" });

    // The export a delivery claim points at cannot be removed.
    const exportRow = await prisma.notificationExport.findFirst({ where: { notificationId: id } });
    await expect(
      prisma.notificationExport.delete({ where: { id: exportRow.id } })
    ).rejects.toMatchObject({ code: "P2003" });

    // The notification itself cannot be removed while it has history.
    await expect(prisma.notification.delete({ where: { id } })).rejects.toMatchObject({
      code: "P2003",
    });

    // The case the notification is bound to cannot be removed.
    await expect(prisma.case.delete({ where: { id: record.caseId } })).rejects.toMatchObject({
      code: "P2003",
    });
  });

  it("8. nulls actor attribution rather than destroying history when a user is deleted", async () => {
    const id = await seedApproved(8);
    await exportNotification(id, { client: prisma, actorUserId: ANALYST_ID, exportedAt: at(6) });

    const revisionCount = await prisma.notificationRevision.count({ where: { notificationId: id } });
    await prisma.user.delete({ where: { id: REVIEWER_ID } });

    const record = await prisma.notification.findUnique({ where: { id } });
    // The approval RECORD survives; only the attribution is nulled.
    expect(record.approvedByUserId).toBeNull();
    expect(record.approvedRevisionId).not.toBeNull();
    expect(await prisma.notificationRevision.count({ where: { notificationId: id } })).toBe(
      revisionCount
    );

    const approval = await prisma.notificationLifecycleEvent.findFirst({
      where: { notificationId: id, eventType: "APPROVED" },
    });
    expect(approval).not.toBeNull();
    expect(approval.actorUserId).toBeNull();
    expect(approval.revisionId).toBe(record.approvedRevisionId);

    // ...and an approval with a null approver is no longer exportable, which
    // is the AGENTS.md rule surviving a user deletion.
    await expect(
      exportNotification(id, { client: prisma, actorUserId: ANALYST_ID, exportedAt: at(8) })
    ).rejects.toMatchObject({ code: "APPROVER_MISSING" });
  });

  it("9. writes exactly one CaseOrganizationResponse when recorded from the notification workflow", async () => {
    const id = await seedDraft(9);
    const record = await prisma.notification.findUnique({ where: { id } });

    await recordOrganizationResponse(
      record.caseId,
      {
        responseType: "ACKNOWLEDGED",
        summary: "Constituent acknowledged the notification.",
        occurredAt: at(6),
      },
      { client: prisma, actorUserId: ANALYST_ID, recordedAt: at(6) }
    );

    const rows = await prisma.caseOrganizationResponse.findMany({
      where: { caseId: record.caseId },
    });
    expect(rows).toHaveLength(1);

    // The notification view and the case timeline read the SAME row.
    const detail = await getNotificationDetail(id, { client: prisma });
    expect(detail.caseResponses).toHaveLength(1);
    expect(detail.caseResponses[0].id).toBe(rows[0].id);

    // And it changed no lifecycle state anywhere.
    expect((await prisma.case.findUnique({ where: { id: record.caseId } })).lifecycleState).toBe(
      "OPEN"
    );
    expect((await prisma.notification.findUnique({ where: { id } })).lifecycleState).toBe("DRAFT");
  });

  it("10. keeps the full history append-only across a reject/edit/resubmit/approve cycle", async () => {
    const id = await seedDraft(10);

    await submitForReview(id, { client: prisma, actorUserId: ANALYST_ID, occurredAt: at(3) });
    await rejectNotification(id, {
      client: prisma,
      actorUserId: REVIEWER_ID,
      reviewedAt: at(4),
      reason: "Wrong remediation guidance.",
    });
    await editCurrentRevision(
      id,
      { remediationGuidance: "Corrected guidance." },
      { client: prisma, actorUserId: ANALYST_ID, occurredAt: at(5) }
    );
    await submitForReview(id, { client: prisma, actorUserId: ANALYST_ID, occurredAt: at(6) });
    await approveNotification(id, { client: prisma, actorUserId: REVIEWER_ID, reviewedAt: at(7) });

    const events = await prisma.notificationLifecycleEvent.findMany({
      where: { notificationId: id },
      orderBy: { id: "asc" },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      "DRAFT_CREATED",
      "SUBMITTED_FOR_REVIEW",
      "REJECTED",
      "REVISION_CREATED",
      "SUBMITTED_FOR_REVIEW",
      "APPROVED",
    ]);

    // The rejection survives the later approval, verbatim.
    const rejection = events.find((e) => e.eventType === "REJECTED");
    expect(rejection.note).toBe("Wrong remediation guidance.");

    // Both revisions survive; exactly one is current.
    const revisions = await prisma.notificationRevision.findMany({
      where: { notificationId: id },
      orderBy: { revisionNumber: "asc" },
    });
    expect(revisions).toHaveLength(2);
    expect(revisions[0].supersededAt).not.toBeNull();
    expect(revisions[0].currentForNotificationId).toBeNull();
    expect(revisions[1].currentForNotificationId).toBe(id);

    // The approval names revision 2, not the rejected revision 1.
    const record = await prisma.notification.findUnique({ where: { id } });
    expect(record.approvedRevisionId).toBe(revisions[1].id);
  });

  it("11. produces byte-identical artifacts for the same revision and instant", async () => {
    const id = await seedApproved(11);
    const [a, b] = await connectRacers(2);

    const first = await exportNotification(id, {
      client: a,
      actorUserId: ANALYST_ID,
      exportedAt: at(6),
    });
    const second = await exportNotification(id, {
      client: b,
      actorUserId: ANALYST_ID,
      exportedAt: at(6),
    });
    await disconnectRacers();

    expect(second.artifact.checksum).toBe(first.artifact.checksum);
    expect(second.export.id).not.toBe(first.export.id);
    // Two distinct recorded acts, identical bytes.
    expect(await prisma.notificationExport.count({ where: { notificationId: id } })).toBe(2);
  });

  it("12. detects an out-of-band content mutation at export time", async () => {
    const id = await seedApproved(12);
    const current = await prisma.notificationRevision.findUnique({
      where: { currentForNotificationId: id },
    });

    // Simulates any path that bypassed the service layer.
    await prisma.notificationRevision.update({
      where: { id: current.id },
      data: { body: "Substituted after the reviewer approved it." },
    });

    await expect(
      exportNotification(id, { client: prisma, actorUserId: ANALYST_ID, exportedAt: at(6) })
    ).rejects.toMatchObject({ code: "REVISION_CHECKSUM_MISMATCH" });

    expect(await prisma.notificationExport.count({ where: { notificationId: id } })).toBe(0);
  });
});
