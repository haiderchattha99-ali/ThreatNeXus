"use strict";

// Reviewer approval and rejection (Phase 4).
//
// ---------------------------------------------------------------------------
// Separation of duties is the whole point of this module
// ---------------------------------------------------------------------------
// Getting a notification out of ThreatNeXus takes TWO distinct acts by TWO
// distinct authorities:
//   1. draft / edit / submit — ADMIN or ANALYST (capability manage:notifications)
//   2. approve or reject     — ADMIN or REVIEWER (capability review:notifications)
// and the person who authored or submitted the revision may not approve it
// unless they additionally hold the administrator self-approval capability.
// ANALYST holds neither review:notifications nor that override, so an analyst
// can never approve a notification — not their own, not anybody else's.
//
// The self-approval rule is enforced HERE, in the service, from an explicit
// boolean the controller derives from a CAPABILITY (never from a role name),
// exactly as caseClosureService.assertNotSelfApproval does in Phase 3. Putting
// it in the controller would leave the service approvable by any future caller
// that forgot the check.
//
// ---------------------------------------------------------------------------
// An approval names a revision, or it is not an approval
// ---------------------------------------------------------------------------
// The approval is written against the exact NotificationRevision that was
// current when the reviewer decided, re-read INSIDE the transaction. A
// concurrent edit therefore cannot slip a different revision under a decision
// in flight: the edit moves the notification back to DRAFT, and this
// transaction's guarded PENDING_REVIEW -> APPROVED transition then finds no row
// to update and fails with CONCURRENT_STATE_CHANGE rather than approving
// content nobody read.

const {
  NOTIFICATION_STATES,
  LIFECYCLE_EVENT_TYPES,
  LIFECYCLE_REASON_CODES,
  MAX_REVIEW_NOTE_LENGTH,
  MAX_REJECTION_REASON_LENGTH,
  NotificationNotFoundError,
  NotificationStateError,
  NotificationSelfApprovalError,
  assertPositiveInteger,
  assertValidDate,
  assertReviewable,
  assertWorkflowBound,
  normalizeBoundedText,
} = require("./notificationRules");

const {
  resolveClient,
  loadNotificationOrThrow,
  applyGuardedTransition,
  notificationSummary,
} = require("./notificationStateService");

const { runSerializable } = require("../workflow/workflowTransaction");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const REVIEW_ENTITY_TYPE = "Notification";

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("Notification review audit failed", { name: error && error.name });
  }
}

/**
 * The set of user ids who may not approve this revision: its author, and
 * whoever submitted it for review.
 *
 * Both are read from durable rows rather than from a column somebody could
 * forget to maintain: the author is `NotificationRevision.createdByUserId`,
 * and the submitter is the actor on the most recent SUBMITTED_FOR_REVIEW
 * lifecycle event FOR THIS EXACT REVISION. Scoping the event lookup to the
 * revision matters — an earlier revision's submitter is not disqualified from
 * reviewing a later one they had no hand in.
 */
async function loadSelfApprovalActorIds(tx, notificationId, revisionId) {
  const submission = await tx.notificationLifecycleEvent.findFirst({
    where: {
      notificationId,
      revisionId,
      eventType: LIFECYCLE_EVENT_TYPES.SUBMITTED_FOR_REVIEW,
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });

  const ids = new Set();
  const revision = await tx.notificationRevision.findUnique({ where: { id: revisionId } });
  if (revision && Number.isInteger(revision.createdByUserId)) ids.add(revision.createdByUserId);
  if (submission && Number.isInteger(submission.actorUserId)) ids.add(submission.actorUserId);
  return ids;
}

/**
 * The self-approval prohibition.
 *
 * `reviewerCanSelfApprove` is a CAPABILITY-derived boolean supplied by the
 * controller (CAPABILITIES.OVERRIDE_NOTIFICATION_SELF_APPROVAL), never a role
 * string, so this service holds no role knowledge at all.
 *
 * An unattributed revision or submission (actor null, e.g. after the user was
 * deleted) is NOT self-approval: null === null must not lock the review out, so
 * the check requires a real integer on both sides — the same reasoning as
 * caseClosureService.assertNotSelfApproval.
 */
function assertNotSelfApproval(disqualifiedIds, reviewerUserId, reviewerCanSelfApprove) {
  if (reviewerCanSelfApprove) return;
  if (!Number.isInteger(reviewerUserId)) return;
  if (disqualifiedIds.has(reviewerUserId)) {
    throw new NotificationSelfApprovalError(
      "The author or submitter may not approve their own revision"
    );
  }
}

/**
 * Approves the current revision of a PENDING_REVIEW notification.
 *
 * This is the only path in the entire system that sets lifecycleState APPROVED
 * and populates the approval projection the export guard reads.
 *
 * @param {number} notificationId
 * @param {{client?:object, actorUserId?:number|null, reviewedAt:Date,
 *   reviewNote?:string|null, reviewerCanSelfApprove?:boolean,
 *   auditContext?:object}} options
 */
async function approveNotification(notificationId, options = {}) {
  assertPositiveInteger(notificationId, "notificationId");
  const reviewedAt = assertValidDate(options.reviewedAt, "reviewedAt");
  const reviewNote = normalizeBoundedText(options.reviewNote, {
    field: "reviewNote",
    maxLength: MAX_REVIEW_NOTE_LENGTH,
    required: false,
    multiline: true,
  });

  const client = resolveClient(options.client);
  const reviewerUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const reviewerCanSelfApprove = options.reviewerCanSelfApprove === true;
  const auditContext = options.auditContext;

  const record = assertWorkflowBound(await loadNotificationOrThrow(client, notificationId));
  assertReviewable(record);

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      const fresh = await tx.notification.findUnique({ where: { id: notificationId } });
      if (!fresh) throw new NotificationNotFoundError("Notification not found");
      assertReviewable(fresh);

      const current = await tx.notificationRevision.findUnique({
        where: { currentForNotificationId: notificationId },
      });
      if (!current) {
        throw new NotificationStateError(
          "Notification has no current revision",
          "NOTIFICATION_NO_CURRENT_REVISION"
        );
      }

      const disqualified = await loadSelfApprovalActorIds(tx, notificationId, current.id);
      assertNotSelfApproval(disqualified, reviewerUserId, reviewerCanSelfApprove);

      const transition = await applyGuardedTransition(tx, {
        notificationId,
        fromState: NOTIFICATION_STATES.PENDING_REVIEW,
        toState: NOTIFICATION_STATES.APPROVED,
        eventType: LIFECYCLE_EVENT_TYPES.APPROVED,
        reasonCode: LIFECYCLE_REASON_CODES.APPROVED_BY_REVIEWER,
        revisionId: current.id,
        note: reviewNote,
        actorUserId: reviewerUserId,
        occurredAt: reviewedAt,
        extraData: {
          // THE approval projection. Written in the same statement as the
          // state change, naming the EXACT revision that was reviewed.
          approvedRevisionId: current.id,
          approvedByUserId: reviewerUserId,
          approvedAt: reviewedAt,
        },
      });

      return { notification: transition.notification, revision: current };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "notification.approved",
      outcome:
        error instanceof NotificationSelfApprovalError
          ? AUDIT_OUTCOMES.DENIED
          : AUDIT_OUTCOMES.FAILURE,
      entityType: REVIEW_ENTITY_TYPE,
      entityId: notificationId,
      reason:
        error instanceof NotificationSelfApprovalError
          ? "Approval denied: author or submitter may not approve their own revision"
          : error instanceof NotificationStateError && error.code
            ? `Approval refused (${error.code})`
            : "Approval could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "notification.approved",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: REVIEW_ENTITY_TYPE,
    entityId: notificationId,
    before: { lifecycleState: NOTIFICATION_STATES.PENDING_REVIEW },
    after: {
      ...notificationSummary(outcome.notification, outcome.revision),
      // Presence and length only. The reviewer's note is stored in full on the
      // immutable lifecycle event, which is the defensible record; copying it
      // into AuditLog would put reviewer prose into a second table.
      reviewNoteLength: reviewNote === null ? 0 : reviewNote.length,
    },
    reason: "Notification approved by reviewer for the exact reviewed revision",
  });

  return outcome;
}

/**
 * Rejects the current revision of a PENDING_REVIEW notification.
 *
 * The reason is REQUIRED here (unlike the note on approval): sending a
 * notification back without saying why leaves the analyst nothing to act on,
 * and leaves the record unable to show that the rejection was reasoned — the
 * same rule caseClosureService.rejectClosure applies.
 */
async function rejectNotification(notificationId, options = {}) {
  assertPositiveInteger(notificationId, "notificationId");
  const reviewedAt = assertValidDate(options.reviewedAt, "reviewedAt");
  const reason = normalizeBoundedText(options.reason, {
    field: "reason",
    maxLength: MAX_REJECTION_REASON_LENGTH,
    required: true,
    multiline: true,
  });

  const client = resolveClient(options.client);
  const reviewerUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const record = assertWorkflowBound(await loadNotificationOrThrow(client, notificationId));
  assertReviewable(record);

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      const fresh = await tx.notification.findUnique({ where: { id: notificationId } });
      if (!fresh) throw new NotificationNotFoundError("Notification not found");
      assertReviewable(fresh);

      const current = await tx.notificationRevision.findUnique({
        where: { currentForNotificationId: notificationId },
      });
      if (!current) {
        throw new NotificationStateError(
          "Notification has no current revision",
          "NOTIFICATION_NO_CURRENT_REVISION"
        );
      }

      const transition = await applyGuardedTransition(tx, {
        notificationId,
        fromState: NOTIFICATION_STATES.PENDING_REVIEW,
        toState: NOTIFICATION_STATES.REJECTED,
        eventType: LIFECYCLE_EVENT_TYPES.REJECTED,
        reasonCode: LIFECYCLE_REASON_CODES.REJECTED_BY_REVIEWER,
        revisionId: current.id,
        note: reason,
        actorUserId: reviewerUserId,
        occurredAt: reviewedAt,
        extraData: {
          // Belt and braces: a REJECTED notification must carry no approval
          // projection even if one somehow survived an earlier cycle.
          approvedRevisionId: null,
          approvedByUserId: null,
          approvedAt: null,
        },
      });

      return { notification: transition.notification, revision: current };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "notification.rejected",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: REVIEW_ENTITY_TYPE,
      entityId: notificationId,
      reason:
        error instanceof NotificationStateError && error.code
          ? `Rejection refused (${error.code})`
          : "Rejection could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "notification.rejected",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: REVIEW_ENTITY_TYPE,
    entityId: notificationId,
    before: { lifecycleState: NOTIFICATION_STATES.PENDING_REVIEW },
    after: {
      ...notificationSummary(outcome.notification, outcome.revision),
      // Length only. The full rejection reason is analyst-facing free text and
      // is explicitly on the "never audit" list for this phase.
      reasonLength: reason.length,
    },
    reason: "Notification rejected by reviewer, returned to the analyst",
  });

  return outcome;
}

/**
 * Newest-first lifecycle/review history for one notification, bounded by the
 * caller.
 */
async function listLifecycleEvents(client, notificationId, take) {
  return client.notificationLifecycleEvent.findMany({
    where: { notificationId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take,
  });
}

module.exports = {
  REVIEW_ENTITY_TYPE,
  loadSelfApprovalActorIds,
  assertNotSelfApproval,
  approveNotification,
  rejectNotification,
  listLifecycleEvents,
};
