"use strict";

// Notification-workflow HTTP surface (Phase 4): safe list and detail, draft
// creation from a case, revision editing, submission, reviewer approval and
// rejection, manual export download, export/delivery history, delivery
// recording, and organization responses recorded through the shared Phase 3
// service.
//
// Every workflow service writes its own audit events on both success and
// failure paths, so this controller passes auditContext through and never
// audits a second time (same division as caseWorkflowController.js).
//
// ---------------------------------------------------------------------------
// No role name appears in this file
// ---------------------------------------------------------------------------
// Authorization is entirely the routes' requireCapability middleware; a denied
// request is answered there and never reaches a service, so no service call
// below can execute without its capability already having been checked.
//
// The ONE place a caller attribute crosses into a service is the self-approval
// prohibition, and it crosses as a CAPABILITY-derived boolean
// (hasCapability(..., OVERRIDE_NOTIFICATION_SELF_APPROVAL)), never as a role
// string — see notificationReviewService.assertNotSelfApproval.

const prisma = require("../config/prisma");
const { buildAuditContext } = require("../services/auditService");
const { parseResourceId } = require("../lib/validation");
const { CAPABILITIES, hasCapability } = require("../lib/roles");

const {
  NOTIFICATION_STATE_VALUES,
  DELIVERY_STATUS_VALUES,
  EXPORT_FORMAT_VALUES,
  DEFAULT_EXPORT_FORMAT,
  CONTENT_FIELDS,
  NotificationValidationError,
  NotificationNotFoundError,
  NotificationStateError,
  NotificationSelfApprovalError,
  NotificationExportRefusedError,
} = require("../services/notification/notificationRules");

const {
  listNotifications,
  getNotificationDetail,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
} = require("../services/notification/notificationReadService");

const {
  createDraftFromCase,
  editCurrentRevision,
  submitForReview,
  EDIT_OUTCOMES,
} = require("../services/notification/notificationRevisionService");

const {
  approveNotification,
  rejectNotification,
} = require("../services/notification/notificationReviewService");

const { exportNotification } = require("../services/notification/notificationExportService");
const {
  recordDeliveryEvent,
} = require("../services/notification/notificationDeliveryService");

// Phase 3's service, reused verbatim. There is deliberately no Phase 4
// response service and no NotificationResponse table: recording a response
// from the notification screen must write the same CaseOrganizationResponse
// row, with the same validation, the same audit event and the same
// failure-isolation behaviour, as recording it from the case screen.
const {
  recordOrganizationResponse,
} = require("../services/workflow/caseResponseService");

const {
  CaseWorkflowValidationError,
  CaseWorkflowNotFoundError,
  CaseWorkflowStateError,
  RESPONSE_TYPE_VALUES,
} = require("../services/workflow/caseWorkflowRules");

const { NotificationArtifactError } = require("../services/notification/notificationArtifactBuilder");

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

const actorUserId = (req) => (req.user && Number.isInteger(req.user.id) ? req.user.id : null);

/**
 * Shared error translation for every notification mutation.
 *
 *   NotificationValidationError    -> 400 (caller sent something malformed)
 *   NotificationNotFoundError      -> 404
 *   NotificationSelfApprovalError  -> 403 (well-formed, authorized route,
 *                                    refused on separation of duties)
 *   NotificationExportRefusedError -> 409 with the closed refusal code
 *   NotificationStateError         -> 409 (the durable state refuses it)
 *
 * The Phase 3 error classes are translated identically, because the
 * organization-response route below calls straight into the Phase 3 service
 * and must not answer a different status than the case route does for the same
 * refusal.
 *
 * A code IS returned for state and export errors: those are closed vocabulary
 * values, never free text and never a database message, and telling an analyst
 * "it was edited after approval" is the entire point of having the vocabulary.
 * Any unrecognised error falls through to the fixed 500 body — no Prisma
 * message, no stack, no filesystem path ever reaches a client.
 */
function handleNotificationError(res, label, error, extra = {}) {
  if (error instanceof NotificationNotFoundError || error instanceof CaseWorkflowNotFoundError) {
    return res.status(404).json({ success: false, message: "Not found." });
  }
  if (error instanceof NotificationSelfApprovalError) {
    return res.status(403).json({
      success: false,
      message: "The author or submitter may not approve their own revision.",
      code: "NOTIFICATION_SELF_APPROVAL_FORBIDDEN",
    });
  }
  if (error instanceof NotificationExportRefusedError) {
    return res.status(409).json({
      success: false,
      message: "The notification is not eligible for export.",
      code: error.code,
    });
  }
  if (error instanceof NotificationStateError || error instanceof CaseWorkflowStateError) {
    return res.status(409).json({
      success: false,
      message: "The notification is not in a state that allows this operation.",
      code: error.code,
    });
  }
  if (
    error instanceof NotificationValidationError ||
    error instanceof CaseWorkflowValidationError
  ) {
    return res.status(400).json({
      success: false,
      message: "Missing or invalid fields.",
      fields: error.fields,
      ...extra,
    });
  }
  // A stored value that should have been impossible (a control character in a
  // subject) reached the artifact builder. Answered as a 409 with a closed
  // code rather than a 500, because the caller CAN act on it — edit the
  // offending field — and the builder's `field` is a fixed field name, never
  // the offending value.
  if (error instanceof NotificationArtifactError) {
    return res.status(409).json({
      success: false,
      message: "The approved content cannot be rendered into an export artifact.",
      code: "ARTIFACT_FIELD_INVALID",
      fields: error.field ? [error.field] : [],
    });
  }
  return serverError(res, label, error);
}

// Rejects unknown keys rather than dropping them, so a caller can never
// discover an internal column by having it silently ignored, and can never
// reach one that a future refactor forgets to filter.
function rejectUnexpectedFields(res, body, allowed) {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    res.status(400).json({ success: false, message: "Unexpected fields.", fields: unexpected });
    return true;
  }
  return false;
}

function readBody(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}

function parseIdOr400(res, raw, label) {
  const id = parseResourceId(raw);
  if (id === null) {
    res.status(400).json({ success: false, message: `Invalid ${label}.` });
    return null;
  }
  return id;
}

// Re-reads and returns the whole notification detail after every mutation. One
// extra query buys a frontend that can never render a stale lifecycle state, a
// stale history or a stale permittedActions block after an action.
async function respondWithDetail(res, notificationId, status = 200, extra = {}) {
  const data = await getNotificationDetail(notificationId, { client: prisma });
  return res.status(status).json({ success: true, data, ...extra });
}

// --- Reads -------------------------------------------------------------------

exports.listNotifications = async (req, res) => {
  // Invalid paging or filter values are rejected with the offending field
  // named, never silently clamped: a caller who asked for limit=500 and
  // received 25 rows would reasonably conclude there were only 25.
  const rawLimit = req.query.limit;
  let limit = DEFAULT_LIST_LIMIT;
  if (rawLimit !== undefined) {
    const parsed = parseResourceId(rawLimit);
    if (parsed === null || parsed > MAX_LIST_LIMIT) {
      return res.status(400).json({
        success: false,
        message: "Missing or invalid fields.",
        fields: ["limit"],
        maxLimit: MAX_LIST_LIMIT,
      });
    }
    limit = parsed;
  }

  const rawPage = req.query.page;
  let page = 1;
  if (rawPage !== undefined) {
    const parsed = parseResourceId(rawPage);
    if (parsed === null) {
      return res
        .status(400)
        .json({ success: false, message: "Missing or invalid fields.", fields: ["page"] });
    }
    page = parsed;
  }

  let state = null;
  if (req.query.state !== undefined) {
    if (!NOTIFICATION_STATE_VALUES.includes(req.query.state)) {
      return res.status(400).json({
        success: false,
        message: "Missing or invalid fields.",
        fields: ["state"],
        allowedStates: NOTIFICATION_STATE_VALUES,
      });
    }
    state = req.query.state;
  }

  let caseId = null;
  if (req.query.caseId !== undefined) {
    caseId = parseResourceId(req.query.caseId);
    if (caseId === null) {
      return res
        .status(400)
        .json({ success: false, message: "Missing or invalid fields.", fields: ["caseId"] });
    }
  }

  try {
    const data = await listNotifications({ client: prisma, page, limit, state, caseId });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleNotificationError(res, "Failed to list notifications", error);
  }
};

exports.getNotification = async (req, res) => {
  const notificationId = parseIdOr400(res, req.params.id, "notification id");
  if (notificationId === null) return undefined;

  try {
    return await respondWithDetail(res, notificationId);
  } catch (error) {
    return handleNotificationError(res, "Failed to load notification", error);
  }
};

exports.getHistory = async (req, res) => {
  const notificationId = parseIdOr400(res, req.params.id, "notification id");
  if (notificationId === null) return undefined;

  try {
    const detail = await getNotificationDetail(notificationId, { client: prisma });
    return res.status(200).json({
      success: true,
      data: {
        notification: detail.notification,
        exports: detail.exports,
        deliveryEvents: detail.deliveryEvents,
        lifecycleEvents: detail.lifecycleEvents,
        permittedActions: detail.permittedActions,
      },
    });
  } catch (error) {
    return handleNotificationError(res, "Failed to load notification history", error);
  }
};

// --- Drafting and editing -----------------------------------------------------

const CREATE_ALLOWED_FIELDS = Object.freeze(["caseId"]);

exports.createDraft = async (req, res) => {
  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, CREATE_ALLOWED_FIELDS)) return undefined;

  const caseId = parseResourceId(body.caseId);
  if (caseId === null) {
    return res
      .status(400)
      .json({ success: false, message: "Missing or invalid fields.", fields: ["caseId"] });
  }

  try {
    const outcome = await createDraftFromCase(caseId, {
      client: prisma,
      actorUserId: actorUserId(req),
      // Server-captured, never caller-supplied: an append-only revision
      // history whose instants a client could choose is not evidence.
      createdAt: new Date(),
      auditContext: buildAuditContext(req),
    });
    return await respondWithDetail(res, outcome.notification.id, 201);
  } catch (error) {
    return handleNotificationError(res, "Failed to create notification draft", error);
  }
};

// The six content fields, and nothing else. lifecycleState, approvedByUserId,
// contentChecksum, revisionNumber, notificationReference, caseId and
// organizationId are all deliberately absent — a caller that submits one gets
// a 400 naming it rather than having it silently ignored.
const EDIT_ALLOWED_FIELDS = Object.freeze([...CONTENT_FIELDS]);

exports.editRevision = async (req, res) => {
  const notificationId = parseIdOr400(res, req.params.id, "notification id");
  if (notificationId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, EDIT_ALLOWED_FIELDS)) return undefined;

  if (Object.keys(body).length === 0) {
    return res.status(400).json({
      success: false,
      message: "Missing or invalid fields.",
      fields: ["content"],
      allowedFields: EDIT_ALLOWED_FIELDS,
    });
  }

  try {
    const outcome = await editCurrentRevision(notificationId, body, {
      client: prisma,
      actorUserId: actorUserId(req),
      occurredAt: new Date(),
      auditContext: buildAuditContext(req),
    });
    // UNCHANGED is a first-class success, reported explicitly so a client can
    // tell "your edit was saved as revision 4" from "your edit changed
    // nothing" — and so a UI need not diff the history to find out.
    return await respondWithDetail(res, notificationId, 200, { outcome: outcome.outcome });
  } catch (error) {
    return handleNotificationError(res, "Failed to edit notification revision", error);
  }
};

exports.submitForReview = async (req, res) => {
  const notificationId = parseIdOr400(res, req.params.id, "notification id");
  if (notificationId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, [])) return undefined;

  try {
    await submitForReview(notificationId, {
      client: prisma,
      actorUserId: actorUserId(req),
      occurredAt: new Date(),
      auditContext: buildAuditContext(req),
    });
    return await respondWithDetail(res, notificationId);
  } catch (error) {
    return handleNotificationError(res, "Failed to submit notification for review", error);
  }
};

// --- Reviewer decisions --------------------------------------------------------

const APPROVE_ALLOWED_FIELDS = Object.freeze(["reviewNote"]);

exports.approve = async (req, res) => {
  const notificationId = parseIdOr400(res, req.params.id, "notification id");
  if (notificationId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, APPROVE_ALLOWED_FIELDS)) return undefined;

  try {
    await approveNotification(notificationId, {
      client: prisma,
      actorUserId: actorUserId(req),
      reviewedAt: new Date(),
      reviewNote: body.reviewNote,
      // The self-approval prohibition, expressed as a capability rather than a
      // role comparison. req.user.role comes from a verified JWT, and
      // hasCapability resolves an unrecognised role to NO capabilities, so an
      // unknown or tampered role fails closed to "cannot self-approve".
      reviewerCanSelfApprove: hasCapability(
        req.user && req.user.role,
        CAPABILITIES.OVERRIDE_NOTIFICATION_SELF_APPROVAL
      ),
      auditContext: buildAuditContext(req),
    });
    return await respondWithDetail(res, notificationId);
  } catch (error) {
    return handleNotificationError(res, "Failed to approve notification", error);
  }
};

const REJECT_ALLOWED_FIELDS = Object.freeze(["reason"]);

exports.reject = async (req, res) => {
  const notificationId = parseIdOr400(res, req.params.id, "notification id");
  if (notificationId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, REJECT_ALLOWED_FIELDS)) return undefined;

  try {
    await rejectNotification(notificationId, {
      client: prisma,
      actorUserId: actorUserId(req),
      reviewedAt: new Date(),
      reason: body.reason,
      auditContext: buildAuditContext(req),
    });
    return await respondWithDetail(res, notificationId);
  } catch (error) {
    return handleNotificationError(res, "Failed to reject notification", error);
  }
};

// --- Manual export --------------------------------------------------------------

exports.exportNotification = async (req, res) => {
  const notificationId = parseIdOr400(res, req.params.id, "notification id");
  if (notificationId === null) return undefined;

  let format = DEFAULT_EXPORT_FORMAT;
  if (req.query.format !== undefined) {
    if (!EXPORT_FORMAT_VALUES.includes(req.query.format)) {
      return res.status(400).json({
        success: false,
        message: "Missing or invalid fields.",
        fields: ["format"],
        allowedFormats: EXPORT_FORMAT_VALUES,
      });
    }
    format = req.query.format;
  }

  try {
    const outcome = await exportNotification(notificationId, {
      client: prisma,
      actorUserId: actorUserId(req),
      exportedAt: new Date(),
      format,
      auditContext: buildAuditContext(req),
    });

    // The artifact is streamed as a file and NEVER embedded in a JSON body.
    // The filename was sanitized to [A-Za-z0-9._-] before it was stored, so it
    // cannot break out of the quoted Content-Disposition value or inject a
    // second header — and the stored value is used here, so the header and the
    // export record can never disagree.
    res.setHeader("Content-Type", outcome.artifact.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${outcome.export.filename}"`
    );
    res.setHeader("Content-Length", String(outcome.artifact.byteLength));
    // Integrity facts as response headers so a client can verify the download
    // against the recorded export without a second request. Neither is secret.
    res.setHeader("X-ThreatNeXus-Artifact-Checksum", outcome.export.artifactChecksum);
    res.setHeader("X-ThreatNeXus-Revision", String(outcome.revision.revisionNumber));
    // Never cached: an export is an audited act, and a cached copy served
    // without reaching the server would be an unrecorded one.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(outcome.artifact.bytes);
  } catch (error) {
    return handleNotificationError(res, "Failed to export notification", error);
  }
};

// --- Delivery tracking -----------------------------------------------------------

const DELIVERY_ALLOWED_FIELDS = Object.freeze([
  "status",
  "occurredAt",
  "exportId",
  "reference",
  "note",
]);

exports.recordDelivery = async (req, res) => {
  const notificationId = parseIdOr400(res, req.params.id, "notification id");
  if (notificationId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, DELIVERY_ALLOWED_FIELDS)) return undefined;

  // occurredAt is REQUIRED and caller-supplied here, and is deliberately NOT
  // defaulted to now: it records when a human observed something, which is a
  // real-world instant the analyst knows and the server does not. Defaulting it
  // would fabricate the one timestamp a delivery timeline exists to record
  // accurately. recordedAt (when we wrote it down) stays server-captured.
  if (body.occurredAt === undefined || body.occurredAt === null) {
    return res
      .status(400)
      .json({ success: false, message: "Missing or invalid fields.", fields: ["occurredAt"] });
  }
  if (typeof body.occurredAt !== "string" && typeof body.occurredAt !== "number") {
    return res
      .status(400)
      .json({ success: false, message: "Missing or invalid fields.", fields: ["occurredAt"] });
  }
  const occurredAt = new Date(body.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    return res
      .status(400)
      .json({ success: false, message: "Missing or invalid fields.", fields: ["occurredAt"] });
  }

  let exportId = null;
  if (body.exportId !== undefined && body.exportId !== null) {
    exportId = parseResourceId(body.exportId);
    if (exportId === null) {
      return res
        .status(400)
        .json({ success: false, message: "Missing or invalid fields.", fields: ["exportId"] });
    }
  }

  try {
    await recordDeliveryEvent(
      notificationId,
      {
        status: body.status,
        occurredAt,
        exportId,
        reference: body.reference,
        note: body.note,
      },
      {
        client: prisma,
        actorUserId: actorUserId(req),
        recordedAt: new Date(),
        auditContext: buildAuditContext(req),
      }
    );
    return await respondWithDetail(res, notificationId, 201);
  } catch (error) {
    return handleNotificationError(res, "Failed to record delivery event", error, {
      allowedStatuses: DELIVERY_STATUS_VALUES,
    });
  }
};

// --- Organization responses through the notification workflow ---------------------

const RESPONSE_ALLOWED_FIELDS = Object.freeze([
  "responseType",
  "summary",
  "reference",
  "occurredAt",
]);

/**
 * Records an organization response FROM the notification screen.
 *
 * Calls the Phase 3 caseResponseService directly against the notification's
 * bound case, so exactly one CaseOrganizationResponse row is written, carrying
 * the same validation, the same `case.response.recorded` audit event and the
 * same failure-isolation behaviour as the case route. The case timeline and
 * the notification view then render the same canonical row because there IS
 * only one row.
 */
exports.recordOrganizationResponse = async (req, res) => {
  const notificationId = parseIdOr400(res, req.params.id, "notification id");
  if (notificationId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, RESPONSE_ALLOWED_FIELDS)) return undefined;

  // Same strict parse as the case route: rejected if unparseable, never
  // silently defaulted, because it records when the ORGANIZATION responded.
  let occurredAt = new Date();
  if (body.occurredAt !== undefined && body.occurredAt !== null) {
    if (typeof body.occurredAt !== "string" && typeof body.occurredAt !== "number") {
      return res
        .status(400)
        .json({ success: false, message: "Missing or invalid fields.", fields: ["occurredAt"] });
    }
    const parsed = new Date(body.occurredAt);
    if (Number.isNaN(parsed.getTime())) {
      return res
        .status(400)
        .json({ success: false, message: "Missing or invalid fields.", fields: ["occurredAt"] });
    }
    occurredAt = parsed;
  }

  try {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
      select: { id: true, caseId: true },
    });
    if (!notification) {
      return res.status(404).json({ success: false, message: "Not found." });
    }
    if (!Number.isInteger(notification.caseId)) {
      return res.status(409).json({
        success: false,
        message: "The notification is not in a state that allows this operation.",
        code: "NOTIFICATION_NOT_WORKFLOW_BOUND",
      });
    }

    await recordOrganizationResponse(
      notification.caseId,
      {
        responseType: body.responseType,
        summary: body.summary,
        reference: body.reference,
        occurredAt,
      },
      {
        client: prisma,
        actorUserId: actorUserId(req),
        recordedAt: new Date(),
        auditContext: buildAuditContext(req),
      }
    );

    return await respondWithDetail(res, notificationId, 201);
  } catch (error) {
    return handleNotificationError(res, "Failed to record organization response", error, {
      allowedResponseTypes: RESPONSE_TYPE_VALUES,
    });
  }
};

// --- Compatibility tombstone -------------------------------------------------------

/**
 * DELETE is a compatibility tombstone, exactly like DELETE /api/cases/:id.
 *
 * It always answers 409, deletes nothing, and deliberately does NOT look the
 * notification up first: answering 404 for an unknown id and 409 for a known
 * one would turn the endpoint into an existence oracle for any holder of the
 * capability. A notification carries an approval trail, an export history and
 * delivery claims; removing the row would destroy the evidence that a
 * constituent was contacted.
 */
exports.deleteNotification = async (req, res) =>
  res.status(409).json({
    success: false,
    message: "Notifications cannot be deleted; their approval and export history is evidence.",
    code: "NOTIFICATION_DELETION_NOT_SUPPORTED",
  });

exports.EDIT_OUTCOMES = EDIT_OUTCOMES;
