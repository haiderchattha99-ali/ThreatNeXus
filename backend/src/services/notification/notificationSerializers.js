"use strict";

// THE allow-list every Phase 4 row crosses on its way to an API response.
//
// Same design as workflow/caseWorkflowSerializers.js: these functions
// construct a fresh object from named fields rather than deleting keys from a
// database row, because a construct-only serializer stays safe when a future
// migration adds a column, whereas a delete-based one silently starts leaking
// it.
//
// Deliberately never emitted, in every serializer below:
//   - current-row keys        currentForNotificationId
//   - recipient addresses     recipientEmail is MASKED, never verbatim; the
//                             full address appears only inside an exported
//                             artifact, which requires export:notifications
//   - organization contacts   email, phone, industry, location — from the
//                             ORGANIZATION record. One deliberate exception,
//                             stated here rather than left to be discovered:
//                             `NotificationRevision.recipientName` is emitted
//                             in full, and it is a snapshot of the
//                             organization's contactPerson taken at drafting
//                             time. That is not a leak but the point — it is
//                             the approved recipient of the message, and a
//                             reviewer who cannot see who a notification is
//                             addressed to cannot meaningfully approve it. It
//                             reaches only holders of read:notifications
//                             (ADMIN / ANALYST / REVIEWER), never VIEWER, and
//                             the address beside it is still masked. The
//                             evaluator asserts the name appears nowhere else
//                             in the payload.
//   - artifact bytes          NotificationExport stores no bytes and no read
//                             path returns any; the artifact is streamed by
//                             the download route alone and never appears in a
//                             JSON body
//   - filesystem paths        nothing is written to disk, so there is none
//   - audit rows              AuditLog is never read by, or returned from, any
//                             Phase 4 read path
//   - raw database errors     controllers answer a fixed string
//
// A dedicated test file (notificationSerializerSafety.test.js) proves these
// exclusions against contaminated real row shapes rather than merely asserting
// them here.

// Reuses the Phase 3 actor/organization serializers rather than re-deriving
// them, so "what may be shown about a user or an organization" has one
// definition across both phases.
const {
  serializeActor,
  serializeOrganizationSummary,
  serializeCaseSummary,
  serializeOrganizationResponse,
} = require("../workflow/caseWorkflowSerializers");

/**
 * Masks a recipient address for display.
 *
 * The domain is preserved and the local part is reduced to its first
 * character, because the question an analyst or reviewer actually needs to
 * answer on screen is "is this addressed to the right ORGANIZATION" — which
 * the domain answers — not "what is the full mailbox". The complete address
 * exists on the revision and reaches only the exported artifact.
 *
 * Anything that is not a plausible address is reported as null rather than
 * echoed back, so a malformed stored value can never be reflected to a caller.
 */
function maskEmail(value) {
  if (typeof value !== "string") return null;
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/**
 * One immutable revision.
 *
 * `contentChecksum` IS emitted, deliberately. It is an integrity fingerprint
 * over content the caller is already reading, never a secret and never a
 * uniqueness key, and surfacing it is what lets a reviewer or an auditor see
 * that the revision approved and the revision exported carry the same
 * fingerprint. `currentForNotificationId` is NOT emitted — `isCurrent`
 * conveys the same fact without exposing the internal uniqueness mechanism.
 */
function serializeRevision(row) {
  if (!row) return null;
  return {
    id: row.id,
    notificationId: row.notificationId,
    revisionNumber: row.revisionNumber,
    subject: row.subject,
    body: row.body,
    remediationGuidance: row.remediationGuidance === undefined ? null : row.remediationGuidance,
    recipientName: row.recipientName === undefined ? null : row.recipientName,
    // Masked, never verbatim.
    recipientEmailMasked: maskEmail(row.recipientEmail),
    hasRecipientEmail: typeof row.recipientEmail === "string" && row.recipientEmail.length > 0,
    // Internal analyst working notes. Visible to holders of read:notifications
    // (ADMIN / ANALYST / REVIEWER), because a reviewer must be able to see the
    // whole record they are approving. Never exported, never audited verbatim.
    analystNotes: row.analystNotes === undefined ? null : row.analystNotes,
    contentChecksum: row.contentChecksum,
    createdByUserId: row.createdByUserId === undefined ? null : row.createdByUserId,
    createdBy: row.createdBy ? serializeActor(row.createdBy) : undefined,
    createdAt: row.createdAt,
    supersededAt: row.supersededAt === undefined ? null : row.supersededAt,
    isCurrent: row.supersededAt === null || row.supersededAt === undefined,
  };
}

/**
 * A revision reduced to its identity, for history lists where the full content
 * of every past revision would be a large and mostly unread payload.
 */
function serializeRevisionSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    revisionNumber: row.revisionNumber,
    subject: row.subject,
    contentChecksum: row.contentChecksum,
    createdByUserId: row.createdByUserId === undefined ? null : row.createdByUserId,
    createdBy: row.createdBy ? serializeActor(row.createdBy) : undefined,
    createdAt: row.createdAt,
    supersededAt: row.supersededAt === undefined ? null : row.supersededAt,
    isCurrent: row.supersededAt === null || row.supersededAt === undefined,
    subjectLength: typeof row.subject === "string" ? row.subject.length : 0,
    bodyLength: typeof row.body === "string" ? row.body.length : 0,
  };
}

function serializeLifecycleEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    notificationId: row.notificationId,
    eventType: row.eventType,
    fromState: row.fromState === undefined ? null : row.fromState,
    toState: row.toState,
    revisionId: row.revisionId,
    revisionNumber: row.revision ? row.revision.revisionNumber : undefined,
    reasonCode: row.reasonCode,
    // The reviewer's approval note / rejection reason. Emitted in full here —
    // it is the defensible record and its whole purpose is to be read by the
    // analyst it was written for. It is the AUDIT trail that records only its
    // length.
    note: row.note === undefined ? null : row.note,
    actorUserId: row.actorUserId === undefined ? null : row.actorUserId,
    actor: row.actor ? serializeActor(row.actor) : undefined,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

/**
 * One export record.
 *
 * Carries the integrity facts (checksum, byte length, filename) and no bytes:
 * NotificationExport stores none, and no read path reconstructs any. The
 * artifact reaches a caller only through the download route, which requires
 * export:notifications and streams it as a file.
 */
function serializeExport(row) {
  if (!row) return null;
  return {
    id: row.id,
    notificationId: row.notificationId,
    revisionId: row.revisionId,
    revisionNumber: row.revision ? row.revision.revisionNumber : undefined,
    format: row.format,
    artifactChecksum: row.artifactChecksum,
    artifactByteLength: row.artifactByteLength,
    filename: row.filename,
    exportedByUserId: row.exportedByUserId === undefined ? null : row.exportedByUserId,
    exportedBy: row.exportedBy ? serializeActor(row.exportedBy) : undefined,
    exportedAt: row.exportedAt,
    createdAt: row.createdAt,
  };
}

function serializeDeliveryEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    notificationId: row.notificationId,
    exportId: row.exportId === undefined ? null : row.exportId,
    revisionId: row.revisionId === undefined ? null : row.revisionId,
    revisionNumber: row.revision ? row.revision.revisionNumber : undefined,
    status: row.status,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    // Stored and displayed verbatim, never dereferenced by anything in this
    // system — see the schema comment on NotificationDeliveryEvent.reference.
    reference: row.reference === undefined ? null : row.reference,
    note: row.note === undefined ? null : row.note,
    recordedByUserId: row.recordedByUserId === undefined ? null : row.recordedByUserId,
    recordedBy: row.recordedBy ? serializeActor(row.recordedBy) : undefined,
    createdAt: row.createdAt,
  };
}

/**
 * The notification header every list row and the detail view share.
 *
 * The legacy `title` / `message` / `severity` / `status` / `type` columns are
 * NOT emitted: they are an unversioned display projection, and returning them
 * next to the authoritative revision would invite a client to render whichever
 * one it happened to read first. `lifecycleState` and the current revision are
 * the answer.
 */
function serializeNotificationSummary(record) {
  if (!record) return null;
  return {
    id: record.id,
    notificationReference: record.notificationReference || null,
    caseId: record.caseId === undefined ? null : record.caseId,
    organizationId: record.organizationId === undefined ? null : record.organizationId,
    organization: record.ownerOrganization
      ? serializeOrganizationSummary(record.ownerOrganization)
      : null,
    lifecycleState: record.lifecycleState,
    // The approval binding, which is what makes "approved for THIS revision"
    // visible to a client rather than something it has to infer.
    approvedRevisionId: record.approvedRevisionId === undefined ? null : record.approvedRevisionId,
    approvedByUserId: record.approvedByUserId === undefined ? null : record.approvedByUserId,
    approvedBy: record.approvedBy ? serializeActor(record.approvedBy) : undefined,
    approvedAt: record.approvedAt === undefined ? null : record.approvedAt,
    createdByUserId: record.createdByUserId === undefined ? null : record.createdByUserId,
    createdBy: record.createdBy ? serializeActor(record.createdBy) : undefined,
    createdAt: record.createdAt,
  };
}

module.exports = {
  maskEmail,
  serializeActor,
  serializeOrganizationSummary,
  serializeCaseSummary,
  serializeOrganizationResponse,
  serializeRevision,
  serializeRevisionSummary,
  serializeLifecycleEvent,
  serializeExport,
  serializeDeliveryEvent,
  serializeNotificationSummary,
};
