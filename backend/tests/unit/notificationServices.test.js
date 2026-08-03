import { describe, it, expect, beforeEach, vi } from "vitest";

// Draft creation from real case evidence, append-only revision history, the
// UNCHANGED no-op, submission, reviewer approval/rejection with the
// self-approval prohibition, the export guard, and the append-only delivery
// timeline.
//
// Every assertion reads the fake's DURABLE ROWS rather than the service return
// value, because the properties under test are about what was WRITTEN: an
// append-only history, exactly one current revision, an approval bound to an
// exact revision, and an export that leaves no trace when it is refused. A
// test that only inspected the return could not tell an UPDATE of a prior row
// from an INSERT of a new one.

const { createWorkflowPrismaFake } = require("./fixtures/workflowPrismaFake");

const {
  createDraftFromCase,
  editCurrentRevision,
  submitForReview,
  EDIT_OUTCOMES,
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
  listNotifications,
} = require("../../src/services/notification/notificationReadService");

const {
  NOTIFICATION_STATES,
  EXPORT_REFUSAL_CODES,
  NotificationValidationError,
  NotificationNotFoundError,
  NotificationStateError,
  NotificationSelfApprovalError,
  NotificationExportRefusedError,
  computeContentChecksum,
} = require("../../src/services/notification/notificationRules");

const ANALYST = 10;
const REVIEWER = 11;
const ADMIN = 12;

const AT = (iso) => new Date(iso);
const T0 = AT("2026-08-03T08:00:00.000Z");
const T1 = AT("2026-08-03T09:00:00.000Z");
const T2 = AT("2026-08-03T10:00:00.000Z");
const T3 = AT("2026-08-03T11:00:00.000Z");
const T4 = AT("2026-08-03T12:00:00.000Z");

let fake;
let client;
let state;
let ORG_ID;
let CASE_ID;
let FINDING_ID;

async function seedCase(overrides = {}) {
  const organization = await client.organization.create({
    data: {
      name: "Acme Bank",
      sector: "FINANCE",
      contactPerson: "Sec Contact",
      email: "soc@acme.example",
      phone: "+92-000-0000",
      industry: "Banking",
      location: "Karachi",
    },
  });
  ORG_ID = organization.id;

  const finding = await client.finding.create({
    data: {
      indicatorValue: "203.0.113.10",
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      firstSeen: AT("2026-08-01T00:00:00.000Z"),
      lastSeen: AT("2026-08-02T00:00:00.000Z"),
      occurrenceCount: 2,
      recurrenceCount: 0,
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
      caseReference: "TNX-2026-000007",
      ...overrides,
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
      effectiveAt: T0,
      // Explicit, because caseFindingLinkService writes it explicitly and the
      // draft loader filters on `supersededAt: null`. In PostgreSQL an omitted
      // nullable column IS null; in the in-memory fake it is `undefined`, which
      // would not match — seeding through the raw table rather than the service
      // has to state what the service would have stated.
      supersededAt: null,
      currentLinkKey: `${CASE_ID}:${FINDING_ID}`,
    },
  });

  return record;
}

async function draft(options = {}) {
  return createDraftFromCase(CASE_ID, {
    client,
    actorUserId: ANALYST,
    createdAt: T0,
    ...options,
  });
}

/** Drives a draft all the way to APPROVED, ready for export. */
async function approvedNotification() {
  const created = await draft();
  const id = created.notification.id;
  await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T1 });
  await approveNotification(id, { client, actorUserId: REVIEWER, reviewedAt: T2 });
  return id;
}

const revisionsFor = (id) =>
  state.notificationRevisions.filter((row) => row.notificationId === id);
const eventsFor = (id) =>
  state.notificationLifecycleEvents.filter((row) => row.notificationId === id);
const auditActions = () => state.auditLogs.map((row) => row.action);

beforeEach(async () => {
  fake = createWorkflowPrismaFake();
  client = fake.client;
  state = fake.state;
  vi.spyOn(console, "error").mockImplementation(() => {});
  await seedCase();
});

describe("draft creation", () => {
  it("binds the notification to one case and organization and assigns a reference from its own id", async () => {
    const { notification, revision } = await draft();

    expect(notification.caseId).toBe(CASE_ID);
    expect(notification.organizationId).toBe(ORG_ID);
    expect(notification.lifecycleState).toBe(NOTIFICATION_STATES.DRAFT);
    expect(notification.notificationReference).toBe(
      `TNX-NOT-2026-${String(notification.id).padStart(6, "0")}`
    );
    expect(revision.revisionNumber).toBe(1);
    expect(revision.currentForNotificationId).toBe(notification.id);
  });

  it("builds the draft from persisted evidence and fabricates nothing", async () => {
    const { revision } = await draft();

    // Every fact in the body traces to a row seeded above.
    expect(revision.body).toContain("203.0.113.10 port 3389/tcp");
    expect(revision.body).toContain("TNX-2026-000007");
    expect(revision.body).toContain("Acme Bank");
    expect(revision.body).toContain("2026-08-01T00:00:00.000Z");
    expect(revision.body).toContain("Times observed:   2");

    // And nothing that is not in a row: no CVE, no score, no band, no
    // remediation CLAIM, no deadline, no fabricated recurrence line.
    expect(revision.body).not.toMatch(/CVE-\d{4}-\d+/);
    expect(revision.body).not.toMatch(/CVSS|EPSS|KEV|risk score|criticality/i);
    expect(revision.body).not.toMatch(/Recurrences/);
    expect(revision.body).not.toMatch(/you have (patched|fixed|remediated)/i);
  });

  it("snapshots the recipient from the organization contact record", async () => {
    const { revision } = await draft();
    expect(revision.recipientName).toBe("Sec Contact");
    expect(revision.recipientEmail).toBe("soc@acme.example");
    // Internal notes always start empty rather than pre-filled with template text.
    expect(revision.analystNotes).toBeNull();
  });

  it("is deterministic — two drafts from the same case have the same checksum", async () => {
    const first = await draft();
    const second = await draft();
    expect(second.revision.contentChecksum).toBe(first.revision.contentChecksum);
    expect(second.notification.id).not.toBe(first.notification.id);
  });

  it("records the DRAFT_CREATED event with no prior state", async () => {
    const { notification, revision } = await draft();
    const events = eventsFor(notification.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "DRAFT_CREATED",
      fromState: null,
      toState: NOTIFICATION_STATES.DRAFT,
      revisionId: revision.id,
      reasonCode: "DRAFT_CREATED_FROM_CASE",
      actorUserId: ANALYST,
    });
  });

  it("keeps the legacy message projection free of incident content", async () => {
    const { notification, revision } = await draft();
    expect(notification.title).toBe(revision.subject);
    expect(notification.message).not.toContain("203.0.113.10");
    expect(notification.message).toContain(notification.notificationReference);
  });

  it("refuses a case that is not bound to an organization", async () => {
    const legacy = await client.case.create({
      data: { title: "Legacy", threatType: "x", organization: "y", analyst: "z" },
    });
    await expect(
      createDraftFromCase(legacy.id, { client, actorUserId: ANALYST, createdAt: T0 })
    ).rejects.toThrow(NotificationStateError);
    expect(state.notifications).toHaveLength(0);
  });

  it("refuses a closed case", async () => {
    await client.case.update({ where: { id: CASE_ID }, data: { lifecycleState: "CLOSED" } });
    let thrown;
    try {
      await draft();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NotificationStateError);
    expect(thrown.code).toBe("CASE_CLOSED");
    expect(state.notifications).toHaveLength(0);
  });

  it("refuses an unknown case and writes nothing", async () => {
    await expect(
      createDraftFromCase(999999, { client, actorUserId: ANALYST, createdAt: T0 })
    ).rejects.toThrow(NotificationNotFoundError);
    expect(state.notifications).toHaveLength(0);
  });

  it("still drafts when the case has no linked evidence, and says so plainly", async () => {
    await client.caseFinding.updateMany({
      where: { caseId: CASE_ID },
      data: { state: "UNLINKED", supersededAt: T0, currentLinkKey: null },
    });
    const { revision } = await draft();
    expect(revision.body).toContain("No evidence is currently linked");
    expect(revision.body).not.toContain("203.0.113.10");
  });
});

describe("revision editing", () => {
  it("appends a new revision and supersedes the previous one, never rewriting it", async () => {
    const created = await draft();
    const id = created.notification.id;
    const originalSubject = created.revision.subject;

    const result = await editCurrentRevision(
      id,
      { subject: "Corrected subject" },
      { client, actorUserId: ANALYST, occurredAt: T1 }
    );

    expect(result.outcome).toBe(EDIT_OUTCOMES.REVISED);

    const rows = revisionsFor(id);
    expect(rows).toHaveLength(2);

    const first = rows.find((r) => r.revisionNumber === 1);
    const second = rows.find((r) => r.revisionNumber === 2);

    // The prior row's CONTENT is byte-identical to what it was.
    expect(first.subject).toBe(originalSubject);
    // Only the two supersede columns changed on it.
    expect(first.supersededAt).toEqual(T1);
    expect(first.currentForNotificationId).toBeNull();

    expect(second.subject).toBe("Corrected subject");
    expect(second.currentForNotificationId).toBe(id);
  });

  it("keeps exactly one current revision at every point", async () => {
    const id = (await draft()).notification.id;
    for (let n = 0; n < 4; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      await editCurrentRevision(
        id,
        { subject: `Subject ${n}` },
        { client, actorUserId: ANALYST, occurredAt: T1 }
      );
      const current = revisionsFor(id).filter((r) => r.currentForNotificationId !== null);
      expect(current).toHaveLength(1);
    }
    expect(revisionsFor(id)).toHaveLength(5);
  });

  it("merges a partial edit over the current content rather than erasing absent fields", async () => {
    const created = await draft();
    const id = created.notification.id;
    const originalBody = created.revision.body;

    await editCurrentRevision(
      id,
      { subject: "Only the subject changed" },
      { client, actorUserId: ANALYST, occurredAt: T1 }
    );

    const current = revisionsFor(id).find((r) => r.currentForNotificationId === id);
    expect(current.body).toBe(originalBody);
    expect(current.recipientEmail).toBe("soc@acme.example");
  });

  it("clears an optional field when it is explicitly sent as null", async () => {
    const id = (await draft()).notification.id;
    await editCurrentRevision(
      id,
      { remediationGuidance: null },
      { client, actorUserId: ANALYST, occurredAt: T1 }
    );
    const current = revisionsFor(id).find((r) => r.currentForNotificationId === id);
    expect(current.remediationGuidance).toBeNull();
  });

  it("returns UNCHANGED and writes NOTHING for an identical edit", async () => {
    const created = await draft();
    const id = created.notification.id;
    const revisionsBefore = revisionsFor(id).length;
    const eventsBefore = eventsFor(id).length;

    const result = await editCurrentRevision(
      id,
      {
        subject: created.revision.subject,
        body: created.revision.body,
        remediationGuidance: created.revision.remediationGuidance,
      },
      { client, actorUserId: ANALYST, occurredAt: T1 }
    );

    expect(result.outcome).toBe(EDIT_OUTCOMES.UNCHANGED);
    expect(revisionsFor(id)).toHaveLength(revisionsBefore);
    expect(eventsFor(id)).toHaveLength(eventsBefore);
    // It IS audited, so a repeated no-op is still explicable in the trail.
    expect(auditActions()).toContain("notification.revision.unchanged");
  });

  it("treats a whitespace-only difference as UNCHANGED", async () => {
    const created = await draft();
    const id = created.notification.id;
    const result = await editCurrentRevision(
      id,
      { subject: `  ${created.revision.subject}  ` },
      { client, actorUserId: ANALYST, occurredAt: T1 }
    );
    expect(result.outcome).toBe(EDIT_OUTCOMES.UNCHANGED);
    expect(revisionsFor(id)).toHaveLength(1);
  });

  it("stores a checksum that matches the stored content", async () => {
    const created = await draft();
    expect(created.revision.contentChecksum).toBe(
      computeContentChecksum({
        subject: created.revision.subject,
        body: created.revision.body,
        remediationGuidance: created.revision.remediationGuidance,
        recipientName: created.revision.recipientName,
        recipientEmail: created.revision.recipientEmail,
        analystNotes: created.revision.analystNotes,
      })
    );
  });

  it("rejects an out-of-contract value before opening a transaction", async () => {
    const id = (await draft()).notification.id;
    await expect(
      editCurrentRevision(
        id,
        { subject: "Injected\r\nBcc: attacker@evil.test" },
        { client, actorUserId: ANALYST, occurredAt: T1 }
      )
    ).rejects.toThrow(NotificationValidationError);
    expect(revisionsFor(id)).toHaveLength(1);
  });

  it("refuses an edit while a reviewer is deciding", async () => {
    const id = (await draft()).notification.id;
    await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T1 });

    let thrown;
    try {
      await editCurrentRevision(
        id,
        { subject: "Sneaky change" },
        { client, actorUserId: ANALYST, occurredAt: T2 }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NotificationStateError);
    expect(thrown.code).toBe("NOTIFICATION_UNDER_REVIEW");
    expect(revisionsFor(id)).toHaveLength(1);
  });
});

describe("submission and review", () => {
  it("moves a draft to PENDING_REVIEW and records which revision was submitted", async () => {
    const created = await draft();
    const id = created.notification.id;
    await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T1 });

    const row = state.notifications.find((n) => n.id === id);
    expect(row.lifecycleState).toBe(NOTIFICATION_STATES.PENDING_REVIEW);

    const submitted = eventsFor(id).find((e) => e.eventType === "SUBMITTED_FOR_REVIEW");
    expect(submitted.revisionId).toBe(created.revision.id);
    expect(submitted.actorUserId).toBe(ANALYST);
  });

  it("binds the approval to the exact revision reviewed", async () => {
    const created = await draft();
    const id = created.notification.id;
    await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T1 });
    await approveNotification(id, {
      client,
      actorUserId: REVIEWER,
      reviewedAt: T2,
      reviewNote: "Accurate.",
    });

    const row = state.notifications.find((n) => n.id === id);
    expect(row.lifecycleState).toBe(NOTIFICATION_STATES.APPROVED);
    expect(row.approvedRevisionId).toBe(created.revision.id);
    expect(row.approvedByUserId).toBe(REVIEWER);
    expect(row.approvedAt).toEqual(T2);

    const approval = eventsFor(id).find((e) => e.eventType === "APPROVED");
    expect(approval.revisionId).toBe(created.revision.id);
    expect(approval.note).toBe("Accurate.");
  });

  it("refuses approval by the analyst who submitted the revision", async () => {
    const id = (await draft()).notification.id;
    await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T1 });

    await expect(
      approveNotification(id, { client, actorUserId: ANALYST, reviewedAt: T2 })
    ).rejects.toThrow(NotificationSelfApprovalError);

    const row = state.notifications.find((n) => n.id === id);
    expect(row.lifecycleState).toBe(NOTIFICATION_STATES.PENDING_REVIEW);
    expect(row.approvedRevisionId).toBeNull();
  });

  it("refuses approval by the author even when somebody else submitted it", async () => {
    const id = (await draft({ actorUserId: ANALYST })).notification.id;
    await submitForReview(id, { client, actorUserId: ADMIN, occurredAt: T1 });

    await expect(
      approveNotification(id, { client, actorUserId: ANALYST, reviewedAt: T2 })
    ).rejects.toThrow(NotificationSelfApprovalError);
  });

  it("permits self-approval ONLY with the explicit administrator override", async () => {
    const id = (await draft({ actorUserId: ADMIN })).notification.id;
    await submitForReview(id, { client, actorUserId: ADMIN, occurredAt: T1 });

    await approveNotification(id, {
      client,
      actorUserId: ADMIN,
      reviewedAt: T2,
      reviewerCanSelfApprove: true,
    });

    expect(state.notifications.find((n) => n.id === id).lifecycleState).toBe(
      NOTIFICATION_STATES.APPROVED
    );
  });

  it("does not treat an unattributed revision as self-approval", async () => {
    // Deleting the authoring user must not lock the review out: null === null
    // is not the same person.
    const id = (await draft({ actorUserId: null })).notification.id;
    await submitForReview(id, { client, actorUserId: null, occurredAt: T1 });
    await approveNotification(id, { client, actorUserId: REVIEWER, reviewedAt: T2 });
    expect(state.notifications.find((n) => n.id === id).lifecycleState).toBe(
      NOTIFICATION_STATES.APPROVED
    );
  });

  it("does not disqualify the submitter of an EARLIER revision from reviewing a later one", async () => {
    const id = (await draft({ actorUserId: ADMIN })).notification.id;
    await submitForReview(id, { client, actorUserId: ADMIN, occurredAt: T1 });
    await rejectNotification(id, {
      client,
      actorUserId: REVIEWER,
      reviewedAt: T2,
      reason: "Wrong contact.",
    });
    // A different analyst rewrites and resubmits.
    await editCurrentRevision(
      id,
      { subject: "Second attempt" },
      { client, actorUserId: ANALYST, occurredAt: T3 }
    );
    await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T3 });

    // ADMIN had no hand in revision 2, so they may review it.
    await approveNotification(id, { client, actorUserId: ADMIN, reviewedAt: T4 });
    expect(state.notifications.find((n) => n.id === id).lifecycleState).toBe(
      NOTIFICATION_STATES.APPROVED
    );
  });

  it("requires a reason to reject, and records it on the immutable event", async () => {
    const id = (await draft()).notification.id;
    await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T1 });

    await expect(
      rejectNotification(id, { client, actorUserId: REVIEWER, reviewedAt: T2 })
    ).rejects.toThrow(NotificationValidationError);

    await rejectNotification(id, {
      client,
      actorUserId: REVIEWER,
      reviewedAt: T2,
      reason: "The remediation guidance is wrong for this service.",
    });

    const row = state.notifications.find((n) => n.id === id);
    expect(row.lifecycleState).toBe(NOTIFICATION_STATES.REJECTED);
    expect(row.approvedRevisionId).toBeNull();

    const rejection = eventsFor(id).find((e) => e.eventType === "REJECTED");
    expect(rejection.note).toBe("The remediation guidance is wrong for this service.");
  });

  it("refuses to decide a notification that is not pending review", async () => {
    const id = (await draft()).notification.id;
    await expect(
      approveNotification(id, { client, actorUserId: REVIEWER, reviewedAt: T2 })
    ).rejects.toThrow(NotificationStateError);
    await expect(
      rejectNotification(id, { client, actorUserId: REVIEWER, reviewedAt: T2, reason: "no" })
    ).rejects.toThrow(NotificationStateError);
  });

  it("keeps rejection and resubmission history append-only", async () => {
    const id = (await draft()).notification.id;
    await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T1 });
    await rejectNotification(id, {
      client,
      actorUserId: REVIEWER,
      reviewedAt: T2,
      reason: "Fix the contact.",
    });
    await editCurrentRevision(
      id,
      { recipientEmail: "ciso@acme.example" },
      { client, actorUserId: ANALYST, occurredAt: T3 }
    );
    await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T3 });
    await approveNotification(id, { client, actorUserId: REVIEWER, reviewedAt: T4 });

    const types = eventsFor(id).map((e) => e.eventType);
    expect(types).toEqual([
      "DRAFT_CREATED",
      "SUBMITTED_FOR_REVIEW",
      "REJECTED",
      "REVISION_CREATED",
      "SUBMITTED_FOR_REVIEW",
      "APPROVED",
    ]);
    // The rejection event survives the later approval verbatim.
    expect(eventsFor(id).find((e) => e.eventType === "REJECTED").note).toBe("Fix the contact.");
  });
});

describe("editing after a decision", () => {
  it("returns an APPROVED notification to DRAFT and destroys the approval projection", async () => {
    const id = await approvedNotification();
    const approvedRevisionId = state.notifications.find((n) => n.id === id).approvedRevisionId;

    await editCurrentRevision(
      id,
      { subject: "Changed after approval" },
      { client, actorUserId: ANALYST, occurredAt: T3 }
    );

    const row = state.notifications.find((n) => n.id === id);
    expect(row.lifecycleState).toBe(NOTIFICATION_STATES.DRAFT);
    expect(row.approvedRevisionId).toBeNull();
    expect(row.approvedByUserId).toBeNull();
    expect(row.approvedAt).toBeNull();

    // The approval EVENT survives — the projection is cleared, the record is not.
    const approval = eventsFor(id).find((e) => e.eventType === "APPROVED");
    expect(approval.revisionId).toBe(approvedRevisionId);

    const edit = eventsFor(id).find((e) => e.eventType === "REVISION_CREATED");
    expect(edit.reasonCode).toBe("REVISION_EDITED_AFTER_APPROVAL");
    expect(edit.fromState).toBe(NOTIFICATION_STATES.APPROVED);
  });

  it("treats an internal-notes-only edit as a real edit that invalidates approval", async () => {
    // Deliberately strict: the exported artifact would be byte-identical, but
    // the reviewer approved a record that has since changed.
    const id = await approvedNotification();
    const result = await editCurrentRevision(
      id,
      { analystNotes: "Called the contact to confirm." },
      { client, actorUserId: ANALYST, occurredAt: T3 }
    );
    expect(result.outcome).toBe(EDIT_OUTCOMES.REVISED);
    expect(state.notifications.find((n) => n.id === id).lifecycleState).toBe(
      NOTIFICATION_STATES.DRAFT
    );
  });
});

describe("manual export", () => {
  it("exports an approved current revision and records immutable metadata", async () => {
    const id = await approvedNotification();
    const outcome = await exportNotification(id, {
      client,
      actorUserId: ANALYST,
      exportedAt: T3,
    });

    const current = revisionsFor(id).find((r) => r.currentForNotificationId === id);
    expect(state.notificationExports).toHaveLength(1);
    expect(state.notificationExports[0]).toMatchObject({
      notificationId: id,
      revisionId: current.id,
      format: "EML",
      exportedByUserId: ANALYST,
      exportedAt: T3,
      artifactChecksum: outcome.artifact.checksum,
      artifactByteLength: outcome.artifact.byteLength,
      filename: outcome.artifact.filename,
    });

    // The bytes themselves are never persisted.
    expect(state.notificationExports[0].bytes).toBeUndefined();
    expect(state.notificationExports[0].artifact).toBeUndefined();
    expect(state.notificationExports[0].body).toBeUndefined();
  });

  it("does not change the lifecycle state, so an approved notification stays exportable", async () => {
    const id = await approvedNotification();
    await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });
    expect(state.notifications.find((n) => n.id === id).lifecycleState).toBe(
      NOTIFICATION_STATES.APPROVED
    );
  });

  it("allows repeated exports and keeps a distinct record of each", async () => {
    const id = await approvedNotification();
    const first = await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });
    const second = await exportNotification(id, { client, actorUserId: ADMIN, exportedAt: T4 });

    expect(state.notificationExports).toHaveLength(2);
    expect(first.export.id).not.toBe(second.export.id);
    // Same revision, same content, therefore the same checksum — but two acts.
    expect(second.export.revisionId).toBe(first.export.revisionId);
    expect(eventsFor(id).filter((e) => e.eventType === "EXPORTED")).toHaveLength(2);
  });

  it.each([
    ["a DRAFT", async () => (await draft()).notification.id, "NOTIFICATION_NOT_APPROVED"],
    [
      "a PENDING_REVIEW notification",
      async () => {
        const id = (await draft()).notification.id;
        await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T1 });
        return id;
      },
      "NOTIFICATION_NOT_APPROVED",
    ],
    [
      "a REJECTED notification",
      async () => {
        const id = (await draft()).notification.id;
        await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T1 });
        await rejectNotification(id, {
          client,
          actorUserId: REVIEWER,
          reviewedAt: T2,
          reason: "no",
        });
        return id;
      },
      "NOTIFICATION_NOT_APPROVED",
    ],
  ])("refuses to export %s and creates no export row", async (_label, setup, code) => {
    const id = await setup();
    let thrown;
    try {
      await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NotificationExportRefusedError);
    expect(thrown.code).toBe(code);
    expect(state.notificationExports).toHaveLength(0);
    expect(eventsFor(id).filter((e) => e.eventType === "EXPORTED")).toHaveLength(0);
  });

  it("refuses an APPROVED notification whose approver is null", async () => {
    const id = await approvedNotification();
    // Simulates the approving user having been deleted (SetNull).
    await client.notification.update({
      where: { id },
      data: { approvedByUserId: null },
    });

    let thrown;
    try {
      await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown.code).toBe(EXPORT_REFUSAL_CODES.APPROVER_MISSING);
    expect(state.notificationExports).toHaveLength(0);
  });

  it("refuses a stale approval that names an older revision", async () => {
    const id = await approvedNotification();
    const staleApprovalId = state.notifications.find((n) => n.id === id).approvedRevisionId;

    await editCurrentRevision(
      id,
      { subject: "Edited after approval" },
      { client, actorUserId: ANALYST, occurredAt: T3 }
    );
    // Force the notification back to APPROVED while leaving the approval
    // pointing at the OLD revision — the exact state the guard exists to catch
    // even if a future code path forgot to clear the projection.
    await client.notification.update({
      where: { id },
      data: {
        lifecycleState: NOTIFICATION_STATES.APPROVED,
        approvedRevisionId: staleApprovalId,
        approvedByUserId: REVIEWER,
        approvedAt: T2,
      },
    });

    let thrown;
    try {
      await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T4 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown.code).toBe(EXPORT_REFUSAL_CODES.APPROVAL_NOT_FOR_CURRENT_REVISION);
    expect(state.notificationExports).toHaveLength(0);
  });

  it("refuses when the stored content no longer matches its checksum", async () => {
    const id = await approvedNotification();
    const current = revisionsFor(id).find((r) => r.currentForNotificationId === id);
    await client.notificationRevision.update({
      where: { id: current.id },
      data: { body: "Substituted after the reviewer approved it." },
    });

    let thrown;
    try {
      await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown.code).toBe(EXPORT_REFUSAL_CODES.REVISION_CHECKSUM_MISMATCH);
    expect(state.notificationExports).toHaveLength(0);
  });

  it("refuses when there is no recipient to address", async () => {
    const created = await draft();
    const id = created.notification.id;
    await editCurrentRevision(
      id,
      { recipientEmail: null },
      { client, actorUserId: ANALYST, occurredAt: T1 }
    );
    await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T1 });
    await approveNotification(id, { client, actorUserId: REVIEWER, reviewedAt: T2 });

    let thrown;
    try {
      await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown.code).toBe(EXPORT_REFUSAL_CODES.RECIPIENT_MISSING);
    expect(state.notificationExports).toHaveLength(0);
  });

  it("audits a refusal as DENIED with the closed refusal code", async () => {
    const id = (await draft()).notification.id;
    await expect(
      exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 })
    ).rejects.toThrow();

    const refusal = state.auditLogs.find((row) => row.action === "notification.export.refused");
    expect(refusal.outcome).toBe("DENIED");
    expect(refusal.after.refusalCode).toBe("NOTIFICATION_NOT_APPROVED");
    // No message text, no recipient, no artifact.
    expect(JSON.stringify(refusal)).not.toContain("203.0.113.10");
    expect(JSON.stringify(refusal)).not.toContain("soc@acme.example");
  });
});

describe("delivery tracking", () => {
  it("records NO delivery event as a consequence of exporting", async () => {
    const id = await approvedNotification();
    await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });
    expect(state.notificationDeliveryEvents).toHaveLength(0);

    const detail = await getNotificationDetail(id, { client });
    expect(detail.deliveryEvents).toEqual([]);
    expect(detail.exports).toHaveLength(1);
  });

  it("refuses a delivery claim about a notification that was never exported", async () => {
    const id = await approvedNotification();
    let thrown;
    try {
      await recordDeliveryEvent(
        id,
        { status: "DELIVERED", occurredAt: T4 },
        { client, actorUserId: ANALYST, recordedAt: T4 }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NotificationStateError);
    expect(thrown.code).toBe("NOTIFICATION_NOT_EXPORTED");
    expect(state.notificationDeliveryEvents).toHaveLength(0);
  });

  it("links the event to the export and the revision that export carried", async () => {
    const id = await approvedNotification();
    const exported = await exportNotification(id, {
      client,
      actorUserId: ANALYST,
      exportedAt: T3,
    });

    await recordDeliveryEvent(
      id,
      { status: "SENT_MANUALLY", occurredAt: T4, reference: "TICKET-99", note: "Sent by hand." },
      { client, actorUserId: ANALYST, recordedAt: T4 }
    );

    expect(state.notificationDeliveryEvents).toHaveLength(1);
    expect(state.notificationDeliveryEvents[0]).toMatchObject({
      notificationId: id,
      exportId: exported.export.id,
      revisionId: exported.export.revisionId,
      status: "SENT_MANUALLY",
      occurredAt: T4,
      reference: "TICKET-99",
      recordedByUserId: ANALYST,
    });
  });

  it("requires an explicitly supplied occurredAt", async () => {
    const id = await approvedNotification();
    await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });

    await expect(
      recordDeliveryEvent(
        id,
        { status: "DELIVERED" },
        { client, actorUserId: ANALYST, recordedAt: T4 }
      )
    ).rejects.toThrow(NotificationValidationError);
  });

  it("keeps the delivery timeline append-only across contradictory claims", async () => {
    const id = await approvedNotification();
    await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });

    await recordDeliveryEvent(
      id,
      { status: "SENT_MANUALLY", occurredAt: AT("2026-08-03T12:00:00.000Z") },
      { client, actorUserId: ANALYST, recordedAt: T4 }
    );
    await recordDeliveryEvent(
      id,
      { status: "BOUNCED", occurredAt: AT("2026-08-03T13:00:00.000Z") },
      { client, actorUserId: ANALYST, recordedAt: T4 }
    );
    // A correction is a further event, never an update of the previous one.
    await recordDeliveryEvent(
      id,
      { status: "DELIVERED", occurredAt: AT("2026-08-03T14:00:00.000Z"), note: "Resent." },
      { client, actorUserId: ANALYST, recordedAt: T4 }
    );

    expect(state.notificationDeliveryEvents.map((row) => row.status)).toEqual([
      "SENT_MANUALLY",
      "BOUNCED",
      "DELIVERED",
    ]);
  });

  it("refuses an export id belonging to another notification", async () => {
    const first = await approvedNotification();
    const second = await approvedNotification();
    const foreign = await exportNotification(second, {
      client,
      actorUserId: ANALYST,
      exportedAt: T3,
    });
    await exportNotification(first, { client, actorUserId: ANALYST, exportedAt: T3 });

    let thrown;
    try {
      await recordDeliveryEvent(
        first,
        { status: "DELIVERED", occurredAt: T4, exportId: foreign.export.id },
        { client, actorUserId: ANALYST, recordedAt: T4 }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown.code).toBe("EXPORT_NOT_FOR_NOTIFICATION");
  });

  it("does not change the lifecycle state when a delivery is recorded", async () => {
    const id = await approvedNotification();
    await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });
    await recordDeliveryEvent(
      id,
      { status: "BOUNCED", occurredAt: T4 },
      { client, actorUserId: ANALYST, recordedAt: T4 }
    );
    // A bounce does not un-approve anything.
    expect(state.notifications.find((n) => n.id === id).lifecycleState).toBe(
      NOTIFICATION_STATES.APPROVED
    );
  });
});

describe("audit isolation", () => {
  // The Phase 2 lesson: a proxy that does not intercept $transaction is
  // silently bypassed for anything running inside one, so the failure must be
  // injected on the client the service actually writes audits with.
  function failingAuditClient(base) {
    return new Proxy(base, {
      get(target, property) {
        if (property === "auditLog") {
          return {
            create: async () => {
              throw new Error("audit backend unavailable");
            },
          };
        }
        return target[property];
      },
    });
  }

  it("does not roll back a revision when the audit write fails", async () => {
    const id = (await draft()).notification.id;
    const broken = failingAuditClient(client);

    await editCurrentRevision(
      id,
      { subject: "Recorded despite audit failure" },
      { client: broken, actorUserId: ANALYST, occurredAt: T1 }
    );

    expect(revisionsFor(id)).toHaveLength(2);
    expect(revisionsFor(id).find((r) => r.currentForNotificationId === id).subject).toBe(
      "Recorded despite audit failure"
    );
  });

  it("does not roll back an approval when the audit write fails", async () => {
    const id = (await draft()).notification.id;
    await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T1 });

    await approveNotification(id, {
      client: failingAuditClient(client),
      actorUserId: REVIEWER,
      reviewedAt: T2,
    });

    expect(state.notifications.find((n) => n.id === id).lifecycleState).toBe(
      NOTIFICATION_STATES.APPROVED
    );
  });

  it("does not roll back export metadata or a delivery record when the audit write fails", async () => {
    const id = await approvedNotification();
    const broken = failingAuditClient(client);

    await exportNotification(id, { client: broken, actorUserId: ANALYST, exportedAt: T3 });
    expect(state.notificationExports).toHaveLength(1);

    await recordDeliveryEvent(
      id,
      { status: "SENT_MANUALLY", occurredAt: T4 },
      { client: broken, actorUserId: ANALYST, recordedAt: T4 }
    );
    expect(state.notificationDeliveryEvents).toHaveLength(1);
  });
});

describe("audit payloads", () => {
  it("never copies the notification body, recipient or artifact into the audit trail", async () => {
    const id = await approvedNotification();
    await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });
    await recordDeliveryEvent(
      id,
      { status: "SENT_MANUALLY", occurredAt: T4, note: "Sent from my mailbox." },
      { client, actorUserId: ANALYST, recordedAt: T4 }
    );

    const serialized = JSON.stringify(state.auditLogs);
    expect(serialized).not.toContain("203.0.113.10");
    expect(serialized).not.toContain("soc@acme.example");
    expect(serialized).not.toContain("Dear ");
    expect(serialized).not.toContain("Sent from my mailbox.");
    expect(serialized).not.toContain("noreply@threatnexus.invalid");
  });

  it("emits the expected bounded action vocabulary", async () => {
    const id = await approvedNotification();
    await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });
    await recordDeliveryEvent(
      id,
      { status: "DELIVERED", occurredAt: T4 },
      { client, actorUserId: ANALYST, recordedAt: T4 }
    );

    expect(new Set(auditActions())).toEqual(
      new Set([
        "notification.draft.created",
        "notification.review.submitted",
        "notification.approved",
        "notification.export.requested",
        "notification.export.completed",
        "notification.delivery.recorded",
      ])
    );
  });

  it("records a DELIVERED claim as an unverified assertion", async () => {
    const id = await approvedNotification();
    await exportNotification(id, { client, actorUserId: ANALYST, exportedAt: T3 });
    await recordDeliveryEvent(
      id,
      { status: "DELIVERED", occurredAt: T4 },
      { client, actorUserId: ANALYST, recordedAt: T4 }
    );

    const row = state.auditLogs.find((r) => r.action === "notification.delivery.recorded");
    expect(row.reason).toMatch(/claim recorded, not verified/i);
  });
});

describe("safe reads", () => {
  it("lists only workflow notifications, never legacy rows", async () => {
    await client.notification.create({
      data: { title: "Legacy alert", message: "System message", severity: "Low" },
    });
    await draft();

    const result = await listNotifications({ client, page: 1, limit: 25 });
    expect(result.total).toBe(1);
    expect(result.notifications[0].notificationReference).toMatch(/^TNX-NOT-/);
  });

  it("reports export eligibility and its refusal reason from durable state alone", async () => {
    const id = (await draft()).notification.id;
    const before = await getNotificationDetail(id, { client });
    expect(before.permittedActions.canExport).toBe(false);
    expect(before.permittedActions.exportRefusalCode).toBe("NOTIFICATION_NOT_APPROVED");
    expect(before.permittedActions.canEdit).toBe(true);
    expect(before.permittedActions.canRecordDelivery).toBe(false);

    await submitForReview(id, { client, actorUserId: ANALYST, occurredAt: T1 });
    await approveNotification(id, { client, actorUserId: REVIEWER, reviewedAt: T2 });

    const after = await getNotificationDetail(id, { client });
    expect(after.permittedActions.canExport).toBe(true);
    expect(after.permittedActions.exportRefusalCode).toBeNull();
    expect(after.permittedActions.approvedForCurrentRevision).toBe(true);
    // A notification awaiting nothing is not editable-by-reviewer; state alone
    // says an APPROVED notification may still be edited back into a draft.
    expect(after.permittedActions.canEdit).toBe(true);
  });

  it("surfaces the case's canonical organization responses on the notification", async () => {
    const id = (await draft()).notification.id;
    await client.caseOrganizationResponse.create({
      data: {
        caseId: CASE_ID,
        responseType: "ACKNOWLEDGED",
        summary: "Constituent acknowledged the notification.",
        occurredAt: T3,
        recordedAt: T3,
        recordedByUserId: ANALYST,
      },
    });

    const detail = await getNotificationDetail(id, { client });
    expect(detail.caseResponses).toHaveLength(1);
    expect(detail.caseResponses[0].responseType).toBe("ACKNOWLEDGED");
    // Exactly one row exists — there is no notification-scoped response table.
    expect(state.caseOrganizationResponses).toHaveLength(1);
  });
});
