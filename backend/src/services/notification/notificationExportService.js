"use strict";

// Manual export (Phase 4).
//
// ---------------------------------------------------------------------------
// Nothing is sent. Ever.
// ---------------------------------------------------------------------------
// This service produces bytes and a durable record that it produced them. It
// opens no socket, performs no `fetch`, launches no mail client and reads no
// SMTP configuration, because none exists — automatic notification sending is
// explicitly out of scope for this system (AGENTS.md), not merely disabled.
// The artifact is streamed to the analyst by the controller and is never
// written to the repository, the source tree, an upload directory or any other
// server path.
//
// ---------------------------------------------------------------------------
// The guard runs INSIDE the transaction, and a refusal writes nothing
// ---------------------------------------------------------------------------
// Every condition is re-evaluated against rows re-read inside the transaction,
// so an edit that lands between the caller's read and the write cannot be
// raced past. A refusal throws before any row is created — proven directly by
// counting NotificationExport rows across the whole refusal matrix — so a
// refused export leaves no export history, no lifecycle event and no artifact.
//
// The artifact is built inside the same transaction, from the same revision
// object the guard verified, so the recorded checksum is provably a checksum
// of the content that passed the guard rather than of a re-read that might
// have changed.

const {
  NOTIFICATION_STATES,
  LIFECYCLE_EVENT_TYPES,
  LIFECYCLE_REASON_CODES,
  EXPORT_FORMATS,
  EXPORT_FORMAT_VALUES,
  DEFAULT_EXPORT_FORMAT,
  EXPORT_REFUSAL_CODES,
  NotificationNotFoundError,
  NotificationExportRefusedError,
  assertMemberOf,
  assertPositiveInteger,
  assertValidDate,
  evaluateExportEligibility,
} = require("./notificationRules");

const {
  resolveClient,
  loadNotificationOrThrow,
  appendLifecycleEvent,
  notificationSummary,
} = require("./notificationStateService");

const { buildArtifact } = require("./notificationArtifactBuilder");
const { runSerializable } = require("../workflow/workflowTransaction");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const EXPORT_ENTITY_TYPE = "NotificationExport";

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("Notification export audit failed", { name: error && error.name });
  }
}

// Allow-listed audit payload. Carries the identity and integrity facts and
// nothing else: never the artifact bytes, never the message text, never the
// recipient address, never a filesystem path (the artifact is never written to
// disk, so there is no path to record).
function exportSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    notificationId: row.notificationId,
    revisionId: row.revisionId,
    format: row.format,
    artifactChecksum: row.artifactChecksum,
    artifactByteLength: row.artifactByteLength,
    filename: row.filename,
    exportedByUserId: row.exportedByUserId === undefined ? null : row.exportedByUserId,
    exportedAt: row.exportedAt,
  };
}

/**
 * Exports the approved current revision of a notification.
 *
 * Repeated exports are permitted and each creates its own immutable
 * NotificationExport row plus its own EXPORTED lifecycle event — an analyst
 * who downloads the same approved notification twice has done two things, and
 * a history that collapsed them would be unable to answer when a particular
 * copy was produced.
 *
 * @param {number} notificationId
 * @param {{client?:object, actorUserId?:number|null, exportedAt:Date,
 *   format?:string, auditContext?:object}} options
 * @returns {Promise<{export:object, artifact:object, revision:object,
 *   notification:object}>}
 */
async function exportNotification(notificationId, options = {}) {
  assertPositiveInteger(notificationId, "notificationId");
  const exportedAt = assertValidDate(options.exportedAt, "exportedAt");
  const format = assertMemberOf(
    options.format === undefined || options.format === null
      ? DEFAULT_EXPORT_FORMAT
      : options.format,
    EXPORT_FORMAT_VALUES,
    "format"
  );

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  // Recorded before the guard runs, so an attempt is visible in the audit
  // trail whether it succeeded, was refused, or failed while persisting.
  await audit(client, auditContext, {
    action: "notification.export.requested",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: EXPORT_ENTITY_TYPE,
    entityId: notificationId,
    after: { format },
    reason: "Manual notification export requested",
  });

  // Loaded (and thrown on) outside the transaction so an unknown id is a clean
  // 404 rather than a rolled-back transaction.
  const record = await loadNotificationOrThrow(client, notificationId);

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      const fresh = await tx.notification.findUnique({ where: { id: notificationId } });
      if (!fresh) throw new NotificationNotFoundError("Notification not found");

      const current = await tx.notificationRevision.findUnique({
        where: { currentForNotificationId: notificationId },
      });

      // THE guard. Every condition of the Phase 4 export contract, evaluated
      // against rows read inside this transaction.
      const eligibility = evaluateExportEligibility(fresh, current);
      if (!eligibility.eligible) {
        throw new NotificationExportRefusedError(
          "Notification is not eligible for export",
          eligibility.code
        );
      }

      // A last structural check the pure guard cannot make: the notification
      // must still be attached to the same case and organization it was
      // drafted against. Compared against the row loaded BEFORE the
      // transaction, so a rebinding concurrent with this export is caught
      // rather than silently exported under the new owner.
      if (fresh.caseId !== record.caseId || fresh.organizationId !== record.organizationId) {
        throw new NotificationExportRefusedError(
          "Notification case or organization binding changed",
          EXPORT_REFUSAL_CODES.CASE_BINDING_CHANGED
        );
      }

      const artifact = buildArtifact({
        revision: current,
        notificationReference: fresh.notificationReference,
        exportedAt,
        format,
      });

      const exportRow = await tx.notificationExport.create({
        data: {
          notificationId,
          revisionId: current.id,
          format,
          artifactChecksum: artifact.checksum,
          artifactByteLength: artifact.byteLength,
          filename: artifact.filename,
          exportedByUserId: actorUserId,
          exportedAt,
        },
      });

      // The lifecycle state is deliberately UNCHANGED by an export: exporting
      // is not a state transition, it is a recorded act performed on an
      // APPROVED notification, and a notification stays APPROVED afterwards so
      // it can be exported again.
      await appendLifecycleEvent(tx, {
        notificationId,
        eventType: LIFECYCLE_EVENT_TYPES.EXPORTED,
        fromState: fresh.lifecycleState,
        toState: fresh.lifecycleState,
        revisionId: current.id,
        reasonCode: LIFECYCLE_REASON_CODES.EXPORTED_MANUALLY,
        note: null,
        actorUserId,
        occurredAt: exportedAt,
      });

      return { export: exportRow, artifact, revision: current, notification: fresh };
    });
  } catch (error) {
    const refused = error instanceof NotificationExportRefusedError;
    await audit(client, auditContext, {
      action: refused ? "notification.export.refused" : "notification.export.failed",
      outcome: refused ? AUDIT_OUTCOMES.DENIED : AUDIT_OUTCOMES.FAILURE,
      entityType: EXPORT_ENTITY_TYPE,
      entityId: notificationId,
      after: refused ? { format, refusalCode: error.code } : { format },
      reason: refused
        ? `Manual export refused (${error.code})`
        : "Manual export failed while building or persisting the record",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "notification.export.completed",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: EXPORT_ENTITY_TYPE,
    entityId: outcome.export.id,
    after: {
      ...exportSummary(outcome.export),
      ...notificationSummary(outcome.notification, outcome.revision),
      // Stated explicitly so nobody reading the audit trail can mistake an
      // export for evidence that anything was sent or received.
      delivered: false,
    },
    reason: "Manual notification export produced; no message was transmitted",
  });

  return outcome;
}

/**
 * Newest-first export history for one notification, bounded by the caller.
 */
async function listExports(client, notificationId, take) {
  return client.notificationExport.findMany({
    where: { notificationId },
    orderBy: [{ exportedAt: "desc" }, { id: "desc" }],
    take,
  });
}

module.exports = {
  EXPORT_ENTITY_TYPE,
  EXPORT_FORMATS,
  NOTIFICATION_STATES,
  exportSummary,
  exportNotification,
  listExports,
};
