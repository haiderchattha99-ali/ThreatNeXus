"use strict";

// Shared loaders, the guarded state transition and the immutable lifecycle
// event writer for the Phase 4 notification workflow.
//
// Every Phase 4 service goes through `applyGuardedTransition` to change
// Notification.lifecycleState, and no service anywhere writes that column
// directly. That is what makes it impossible for a notification to reach a
// state with no NotificationLifecycleEvent explaining how it got there — the
// transition and its event are one statement pair inside one transaction, and
// the transition is refused unless the row is still in the state the caller
// read (an optimistic guard, so a concurrent transition cannot be overwritten).
//
// Same division of labour as workflow/caseLifecycleService.js in Phase 3.

const {
  NOTIFICATION_STATES,
  NotificationNotFoundError,
  NotificationStateError,
  assertPositiveInteger,
  assertWorkflowBound,
} = require("./notificationRules");

// Only the organization fields the workflow displays are selected at the QUERY
// level, not merely dropped at serialization time — selecting the whole row
// would still pull contact details into process memory and into any future
// logging of that object. Same rule as caseWorkflowReadService.ORGANIZATION_SELECT.
//
// NOTE: the DRAFTING path deliberately reads MORE than this (it needs
// contactPerson/email to populate the recipient snapshot) and does so through
// its own explicit select — see notificationRevisionService.
const ORGANIZATION_SELECT = Object.freeze({ id: true, name: true, sector: true });

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

/**
 * Loads a Notification or throws NotificationNotFoundError.
 *
 * Deliberately does NOT include revisions: callers that need the current
 * revision ask for it explicitly (see loadCurrentRevision), because an
 * unbounded include of an append-only history table on every load is how a
 * read path quietly becomes unbounded.
 */
async function loadNotificationOrThrow(client, notificationId) {
  assertPositiveInteger(notificationId, "notificationId");
  const record = await client.notification.findUnique({ where: { id: notificationId } });
  if (!record) throw new NotificationNotFoundError("Notification not found");
  return record;
}

/**
 * The current (non-superseded) revision, read through the unique
 * currentForNotificationId index rather than by ordering the history — so it
 * cannot return a stale row if two revisions ever momentarily disagree, and so
 * a second current row is a database error rather than a silent ambiguity.
 */
async function loadCurrentRevision(client, notificationId) {
  return client.notificationRevision.findUnique({
    where: { currentForNotificationId: notificationId },
  });
}

async function loadWorkflowNotificationOrThrow(client, notificationId) {
  return assertWorkflowBound(await loadNotificationOrThrow(client, notificationId));
}

/**
 * Appends one immutable lifecycle/review event.
 *
 * `revisionId` is REQUIRED for every event type in this phase: an approval, a
 * rejection, an export or a delivery observation that did not name the exact
 * revision it concerned would be precisely the defect Phase 4 exists to
 * prevent. `reasonCode` comes from the closed LIFECYCLE_REASON_CODES
 * vocabulary and is never free text or an exception message.
 */
async function appendLifecycleEvent(tx, event) {
  return tx.notificationLifecycleEvent.create({
    data: {
      notificationId: assertPositiveInteger(event.notificationId, "notificationId"),
      eventType: event.eventType,
      fromState: event.fromState === undefined ? null : event.fromState,
      toState: event.toState,
      revisionId: assertPositiveInteger(event.revisionId, "revisionId"),
      reasonCode: event.reasonCode,
      note: event.note === undefined ? null : event.note,
      actorUserId: Number.isInteger(event.actorUserId) ? event.actorUserId : null,
      occurredAt: event.occurredAt,
    },
  });
}

/**
 * Applies one state change to a Notification and appends its event, in the
 * caller's transaction.
 *
 * The `updateMany` + count check is an OPTIMISTIC GUARD, not a formality: it
 * updates only if the row is STILL in `fromState`. Under SERIALIZABLE the
 * loser of a concurrent transition is rejected by PostgreSQL anyway, but this
 * makes the failure a controlled CONCURRENT_STATE_CHANGE the caller can
 * explain rather than a silent last-writer-wins overwrite if this code is ever
 * called at a weaker isolation level.
 *
 * `extraData` carries the approval projection (set on approve, cleared on a
 * new revision) and the legacy title/message display projection. It is applied
 * in the SAME statement as the state change, so the projection can never be
 * observed disagreeing with the state.
 */
async function applyGuardedTransition(tx, params) {
  const {
    notificationId,
    fromState,
    toState,
    eventType,
    reasonCode,
    revisionId,
    note = null,
    actorUserId = null,
    occurredAt,
    extraData = {},
  } = params;

  const updated = await tx.notification.updateMany({
    where: { id: notificationId, lifecycleState: fromState },
    data: { lifecycleState: toState, ...extraData },
  });

  if (updated.count !== 1) {
    throw new NotificationStateError(
      "Notification state changed concurrently",
      "CONCURRENT_STATE_CHANGE"
    );
  }

  const event = await appendLifecycleEvent(tx, {
    notificationId,
    eventType,
    fromState,
    toState,
    revisionId,
    reasonCode,
    note,
    actorUserId,
    occurredAt,
  });

  const record = await tx.notification.findUnique({ where: { id: notificationId } });
  return { notification: record, event };
}

// Allow-listed audit payload for a notification. The SUBJECT and BODY are
// deliberately absent and are reduced to lengths: the body is constituent-
// addressed incident text, and copying it into AuditLog would put that text
// into a second table with a different retention story. "This notification, in
// this state, on this revision, was acted on by this actor at this time" is
// what an auditor needs.
function notificationSummary(record, revision) {
  if (!record) return null;
  return {
    id: record.id,
    notificationReference: record.notificationReference || null,
    caseId: record.caseId === undefined ? null : record.caseId,
    organizationId: record.organizationId === undefined ? null : record.organizationId,
    lifecycleState: record.lifecycleState,
    approvedRevisionId:
      record.approvedRevisionId === undefined ? null : record.approvedRevisionId,
    approvedByUserId: record.approvedByUserId === undefined ? null : record.approvedByUserId,
    revisionId: revision ? revision.id : null,
    revisionNumber: revision ? revision.revisionNumber : null,
    // The checksum is an integrity fingerprint over content, not a secret and
    // not a key, so recording it is what lets an audit trail demonstrate that
    // the thing approved and the thing exported were the same content.
    contentChecksum: revision ? revision.contentChecksum : null,
  };
}

module.exports = {
  NOTIFICATION_STATES,
  ORGANIZATION_SELECT,
  resolveClient,
  loadNotificationOrThrow,
  loadCurrentRevision,
  loadWorkflowNotificationOrThrow,
  appendLifecycleEvent,
  applyGuardedTransition,
  notificationSummary,
};
