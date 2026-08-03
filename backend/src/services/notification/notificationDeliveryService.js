"use strict";

// Delivery tracking (Phase 4).
//
// ---------------------------------------------------------------------------
// Export is not delivery, and this module is the reason that stays true
// ---------------------------------------------------------------------------
// ThreatNeXus does not send the message, so it cannot know what happened to
// it. Every row here is an explicit human assertion about something a person
// observed outside this system. Consequently:
//
//   - Nothing in this codebase writes a delivery row on its own. There is no
//     call to this service from the export path, from ingestion, from a
//     scheduler or from any runner. It is reachable only from the HTTP route
//     an analyst posts to.
//   - DELIVERED is never inferred. Not from an export, not from a successful
//     download, not from elapsed time, not from the absence of a bounce. A
//     notification that was exported a year ago and never followed up has
//     exactly zero delivery rows, and that is the correct record.
//   - `occurredAt` is REQUIRED and always caller-supplied. Defaulting it to
//     `now` would fabricate an observation timestamp — the one thing a
//     delivery timeline exists to record accurately. `recordedAt` (when we
//     wrote it down) is server-captured, and the two are never conflated.
//   - No provider receipt, delivery-status notification or message identifier
//     is ever synthesized. `reference` is whatever opaque string the analyst
//     chose to record, and nothing in this system dereferences it.
//
// Rows are never updated or deleted. Correcting a mistaken claim means
// recording a further event, so the original claim and the correction both
// stay visible — the same rule as CaseOrganizationResponse.

const {
  LIFECYCLE_EVENT_TYPES,
  LIFECYCLE_REASON_CODES,
  DELIVERY_STATUSES,
  DELIVERY_STATUS_VALUES,
  MAX_DELIVERY_REFERENCE_LENGTH,
  MAX_DELIVERY_NOTE_LENGTH,
  NotificationStateError,
  assertMemberOf,
  assertPositiveInteger,
  assertValidDate,
  assertWorkflowBound,
  normalizeBoundedText,
} = require("./notificationRules");

const {
  resolveClient,
  loadNotificationOrThrow,
  loadCurrentRevision,
  appendLifecycleEvent,
} = require("./notificationStateService");

const { runAtomic } = require("../workflow/workflowTransaction");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const DELIVERY_ENTITY_TYPE = "NotificationDeliveryEvent";

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("Notification delivery audit failed", { name: error && error.name });
  }
}

// Allow-listed audit payload. The analyst's note and reference are reduced to
// a boolean and a length for the same reason the organization-response summary
// is: they describe third-party correspondence, and copying them into AuditLog
// would put that correspondence into a second table with a different retention
// story.
function deliverySummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    notificationId: row.notificationId,
    exportId: row.exportId === undefined ? null : row.exportId,
    revisionId: row.revisionId === undefined ? null : row.revisionId,
    status: row.status,
    occurredAt: row.occurredAt,
    hasReference: typeof row.reference === "string" && row.reference.length > 0,
    noteLength: typeof row.note === "string" ? row.note.length : 0,
  };
}

/**
 * Records one delivery observation.
 *
 * Refused unless the notification has actually been exported at least once.
 * That is not bureaucracy: this system's only outbound act is the export, so a
 * delivery claim about a notification that was never exported describes
 * something that cannot have happened through ThreatNeXus, and accepting it
 * would put an unexplainable event on the timeline.
 *
 * @param {number} notificationId
 * @param {{status:string, occurredAt:Date, exportId?:number|null,
 *   reference?:string|null, note?:string|null}} input
 * @param {{client?:object, actorUserId?:number|null, recordedAt:Date,
 *   auditContext?:object}} options
 */
async function recordDeliveryEvent(notificationId, input, options = {}) {
  assertPositiveInteger(notificationId, "notificationId");
  const status = assertMemberOf(input && input.status, DELIVERY_STATUS_VALUES, "status");
  const occurredAt = assertValidDate(input && input.occurredAt, "occurredAt");
  const recordedAt = assertValidDate(options.recordedAt, "recordedAt");
  const reference = normalizeBoundedText(input && input.reference, {
    field: "reference",
    maxLength: MAX_DELIVERY_REFERENCE_LENGTH,
    required: false,
  });
  const note = normalizeBoundedText(input && input.note, {
    field: "note",
    maxLength: MAX_DELIVERY_NOTE_LENGTH,
    required: false,
    multiline: true,
  });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const record = assertWorkflowBound(await loadNotificationOrThrow(client, notificationId));

  // The export this observation is about. When the caller names one it must
  // belong to this notification — an observation attached to somebody else's
  // export would corrupt both timelines. When they do not, the most recent
  // export is used, which is the only defensible default: it is the copy that
  // was most plausibly the one sent, and the link is recorded explicitly so a
  // reader can see which export was assumed rather than guessing.
  const requestedExportId =
    input && input.exportId !== undefined && input.exportId !== null
      ? assertPositiveInteger(input.exportId, "exportId")
      : null;

  let exportRow;
  if (requestedExportId === null) {
    exportRow = await client.notificationExport.findFirst({
      where: { notificationId },
      orderBy: [{ exportedAt: "desc" }, { id: "desc" }],
    });
  } else {
    exportRow = await client.notificationExport.findUnique({ where: { id: requestedExportId } });
    if (!exportRow || exportRow.notificationId !== notificationId) {
      throw new NotificationStateError(
        "Export does not belong to this notification",
        "EXPORT_NOT_FOR_NOTIFICATION"
      );
    }
  }

  if (!exportRow) {
    throw new NotificationStateError(
      "Delivery can only be recorded after the notification has been exported",
      "NOTIFICATION_NOT_EXPORTED"
    );
  }

  // The revision that export carried — not the notification's CURRENT
  // revision. A delivery observation is about the copy that was actually
  // produced, and after a later edit those two are different things.
  const revisionId = exportRow.revisionId;

  let row;
  try {
    // Purely additive: one INSERT plus one immutable event, with no decision
    // taken from a value this transaction also writes. `runAtomic` per the
    // rule in workflowTransaction.js.
    row = await runAtomic(client, async (tx) => {
      const created = await tx.notificationDeliveryEvent.create({
        data: {
          notificationId,
          exportId: exportRow.id,
          revisionId,
          status,
          occurredAt,
          recordedAt,
          reference,
          note,
          recordedByUserId: actorUserId,
        },
      });

      // The lifecycle state is deliberately UNCHANGED. Recording that a
      // message bounced does not un-approve it, and recording that it was
      // delivered does not close anything — a delivery is an observation, not
      // a decision.
      await appendLifecycleEvent(tx, {
        notificationId,
        eventType: LIFECYCLE_EVENT_TYPES.DELIVERY_RECORDED,
        fromState: record.lifecycleState,
        toState: record.lifecycleState,
        revisionId,
        reasonCode: LIFECYCLE_REASON_CODES.DELIVERY_OBSERVED,
        note: null,
        actorUserId,
        occurredAt,
      });

      return created;
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "notification.delivery.recorded",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: DELIVERY_ENTITY_TYPE,
      entityId: notificationId,
      after: { status },
      reason: "Delivery event could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "notification.delivery.recorded",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: DELIVERY_ENTITY_TYPE,
    entityId: row.id,
    after: deliverySummary(row),
    // Stated explicitly in the audit trail so nobody reading it later can
    // mistake an analyst's claim for a provider-confirmed delivery receipt.
    reason:
      status === DELIVERY_STATUSES.DELIVERED
        ? "Analyst asserted delivery (claim recorded, not verified by this system)"
        : "Delivery observation recorded",
  });

  return row;
}

/**
 * Newest-first delivery timeline for one notification, bounded by the caller.
 */
async function listDeliveryEvents(client, notificationId, take) {
  return client.notificationDeliveryEvent.findMany({
    where: { notificationId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take,
  });
}

/**
 * The current revision, exposed for callers that need to relate a delivery to
 * what is on screen. Re-exported rather than re-implemented so there is one
 * definition of "current".
 */
async function currentRevisionOf(client, notificationId) {
  return loadCurrentRevision(client, notificationId);
}

module.exports = {
  DELIVERY_ENTITY_TYPE,
  DELIVERY_STATUSES,
  deliverySummary,
  recordDeliveryEvent,
  listDeliveryEvents,
  currentRevisionOf,
};
