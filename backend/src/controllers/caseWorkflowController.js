"use strict";

// Case-workflow HTTP surface (Phase 3): detail read, evidence linking,
// OPEN <-> WAITING_FOR_ORG transitions, organization responses, closure
// request/approve/reject, and explicit manual reopen.
//
// Every workflow service writes its own audit events on both success and
// failure paths, so this controller passes auditContext through and never
// audits a second time (same division as findingOwnershipController.js and
// findingVulnerabilityController.js).
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
// (hasCapability(..., OVERRIDE_CLOSURE_SELF_APPROVAL)), never as a role
// string — see caseClosureService.assertNotSelfApproval.

const prisma = require("../config/prisma");
const { buildAuditContext } = require("../services/auditService");
const { parseResourceId } = require("../lib/validation");
const { CAPABILITIES, hasCapability } = require("../lib/roles");

const {
  CLOSURE_REASON_VALUES,
  RESPONSE_TYPE_VALUES,
  ANALYST_SETTABLE_STATES,
  CaseWorkflowValidationError,
  CaseWorkflowNotFoundError,
  CaseWorkflowStateError,
  CaseClosureSelfApprovalError,
} = require("../services/workflow/caseWorkflowRules");

const { getCaseWorkflow } = require("../services/workflow/caseWorkflowReadService");
const { changeCaseState, reopenCase } = require("../services/workflow/caseLifecycleService");
const { linkFinding, unlinkFinding } = require("../services/workflow/caseFindingLinkService");
const { recordOrganizationResponse } = require("../services/workflow/caseResponseService");
const {
  requestClosure,
  approveClosure,
  rejectClosure,
} = require("../services/workflow/caseClosureService");

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

const actorUserId = (req) => (req.user && Number.isInteger(req.user.id) ? req.user.id : null);

/**
 * Shared error translation for every workflow mutation.
 *
 *   CaseWorkflowValidationError    -> 400 (caller sent something malformed)
 *   CaseWorkflowNotFoundError      -> 404
 *   CaseClosureSelfApprovalError   -> 403 (well-formed, authorized route,
 *                                    refused on separation of duties)
 *   CaseWorkflowStateError         -> 409 (well-formed, but the durable state
 *                                    refuses it — the caller should re-read)
 *
 * A CaseWorkflowStateError's `code` IS returned: it is a closed vocabulary
 * value (LINK_REJECTION_CODES / CASE_NOT_CLOSED / CONCURRENT_STATE_CHANGE /
 * REMEDIATED_RESPONSE_REQUIRED ...), never free text and never a database
 * message, and telling an analyst "resolve ownership first" is the entire
 * point of having the vocabulary. Any unrecognised error falls through to the
 * fixed 500 body.
 */
function handleWorkflowError(res, label, error, extra = {}) {
  if (error instanceof CaseWorkflowNotFoundError) {
    return res.status(404).json({ success: false, message: "Not found." });
  }
  if (error instanceof CaseClosureSelfApprovalError) {
    return res.status(403).json({
      success: false,
      message: "The requester may not approve their own closure request.",
      code: "CLOSURE_SELF_APPROVAL_FORBIDDEN",
    });
  }
  if (error instanceof CaseWorkflowStateError) {
    return res.status(409).json({
      success: false,
      message: "The case is not in a state that allows this operation.",
      code: error.code,
    });
  }
  if (error instanceof CaseWorkflowValidationError) {
    return res.status(400).json({
      success: false,
      message: "Missing or invalid fields.",
      fields: error.fields,
      ...extra,
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

// Route params are untrusted strings; parseResourceId accepts only a plain
// positive integer. Returns null after answering 400 so the caller returns.
function parseIdOr400(res, raw, label) {
  const id = parseResourceId(raw);
  if (id === null) {
    res.status(400).json({ success: false, message: `Invalid ${label}.` });
    return null;
  }
  return id;
}

// Re-reads and returns the whole case detail after every mutation. One extra
// query buys a frontend that can never render a stale lifecycle state, a stale
// timeline or a stale permittedActions block after an action.
async function respondWithWorkflow(res, caseId, status = 200) {
  const data = await getCaseWorkflow(caseId, { client: prisma });
  return res.status(status).json({ success: true, data });
}

exports.getWorkflow = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  try {
    return await respondWithWorkflow(res, caseId);
  } catch (error) {
    return handleWorkflowError(res, "Failed to load case workflow", error);
  }
};

const LINK_ALLOWED_FIELDS = Object.freeze(["findingId", "reason"]);

exports.linkFinding = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, LINK_ALLOWED_FIELDS)) return undefined;

  const findingId = parseResourceId(body.findingId);
  if (findingId === null) {
    return res
      .status(400)
      .json({ success: false, message: "Missing or invalid fields.", fields: ["findingId"] });
  }

  try {
    await linkFinding(caseId, findingId, {
      client: prisma,
      actorUserId: actorUserId(req),
      // Server-captured, never caller-supplied: an append-only link history
      // whose instants a client could choose is not evidence.
      effectiveAt: new Date(),
      reason: body.reason,
      auditContext: buildAuditContext(req),
    });
    return await respondWithWorkflow(res, caseId);
  } catch (error) {
    return handleWorkflowError(res, "Failed to link finding to case", error);
  }
};

const UNLINK_ALLOWED_FIELDS = Object.freeze(["reason"]);

exports.unlinkFinding = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;
  const findingId = parseIdOr400(res, req.params.findingId, "finding id");
  if (findingId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, UNLINK_ALLOWED_FIELDS)) return undefined;

  try {
    await unlinkFinding(caseId, findingId, {
      client: prisma,
      actorUserId: actorUserId(req),
      effectiveAt: new Date(),
      reason: body.reason,
      auditContext: buildAuditContext(req),
    });
    return await respondWithWorkflow(res, caseId);
  } catch (error) {
    return handleWorkflowError(res, "Failed to unlink finding from case", error);
  }
};

const STATE_ALLOWED_FIELDS = Object.freeze(["toState", "note"]);

exports.changeState = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, STATE_ALLOWED_FIELDS)) return undefined;

  try {
    await changeCaseState(caseId, body.toState, {
      client: prisma,
      actorUserId: actorUserId(req),
      occurredAt: new Date(),
      note: body.note,
      auditContext: buildAuditContext(req),
    });
    return await respondWithWorkflow(res, caseId);
  } catch (error) {
    // The settable states are part of the published contract, so listing them
    // on a validation failure discloses nothing stored.
    return handleWorkflowError(res, "Failed to change case state", error, {
      allowedStates: ANALYST_SETTABLE_STATES,
    });
  }
};

const RESPONSE_ALLOWED_FIELDS = Object.freeze([
  "responseType",
  "summary",
  "reference",
  "occurredAt",
]);

exports.recordResponse = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, RESPONSE_ALLOWED_FIELDS)) return undefined;

  // occurredAt IS caller-supplied here, unlike everywhere else in this phase,
  // and deliberately so: it records when the ORGANIZATION responded, which is
  // a real-world instant the analyst knows and the server does not. It is
  // parsed strictly and rejected if unparseable — never silently defaulted to
  // now, which would fabricate a correspondence timestamp. recordedAt (when we
  // wrote it down) stays server-captured, so both are always available and
  // never conflated.
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
    await recordOrganizationResponse(
      caseId,
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
    return await respondWithWorkflow(res, caseId);
  } catch (error) {
    return handleWorkflowError(res, "Failed to record organization response", error, {
      allowedResponseTypes: RESPONSE_TYPE_VALUES,
    });
  }
};

const CLOSURE_REQUEST_ALLOWED_FIELDS = Object.freeze(["closureReason", "justification"]);

exports.requestClosure = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, CLOSURE_REQUEST_ALLOWED_FIELDS)) return undefined;

  try {
    await requestClosure(
      caseId,
      { closureReason: body.closureReason, justification: body.justification },
      {
        client: prisma,
        actorUserId: actorUserId(req),
        requestedAt: new Date(),
        auditContext: buildAuditContext(req),
      }
    );
    return await respondWithWorkflow(res, caseId, 201);
  } catch (error) {
    return handleWorkflowError(res, "Failed to request case closure", error, {
      allowedClosureReasons: CLOSURE_REASON_VALUES,
    });
  }
};

const REVIEW_ALLOWED_FIELDS = Object.freeze(["reviewNote"]);

exports.approveClosure = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;
  const requestId = parseIdOr400(res, req.params.requestId, "closure request id");
  if (requestId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, REVIEW_ALLOWED_FIELDS)) return undefined;

  try {
    await approveClosure(caseId, requestId, {
      client: prisma,
      actorUserId: actorUserId(req),
      reviewedAt: new Date(),
      reviewNote: body.reviewNote,
      // The self-approval prohibition, expressed as a capability rather than
      // a role comparison. req.user.role comes from a verified JWT, and
      // hasCapability resolves an unrecognised role to NO capabilities, so an
      // unknown or tampered role fails closed to "cannot self-approve".
      reviewerCanSelfApprove: hasCapability(
        req.user && req.user.role,
        CAPABILITIES.OVERRIDE_CLOSURE_SELF_APPROVAL
      ),
      auditContext: buildAuditContext(req),
    });
    return await respondWithWorkflow(res, caseId);
  } catch (error) {
    return handleWorkflowError(res, "Failed to approve case closure", error);
  }
};

exports.rejectClosure = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;
  const requestId = parseIdOr400(res, req.params.requestId, "closure request id");
  if (requestId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, REVIEW_ALLOWED_FIELDS)) return undefined;

  try {
    await rejectClosure(caseId, requestId, {
      client: prisma,
      actorUserId: actorUserId(req),
      reviewedAt: new Date(),
      reviewNote: body.reviewNote,
      auditContext: buildAuditContext(req),
    });
    return await respondWithWorkflow(res, caseId);
  } catch (error) {
    return handleWorkflowError(res, "Failed to reject case closure", error);
  }
};

const REOPEN_ALLOWED_FIELDS = Object.freeze(["reason"]);

exports.reopenCase = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, REOPEN_ALLOWED_FIELDS)) return undefined;

  try {
    await reopenCase(caseId, {
      client: prisma,
      actorUserId: actorUserId(req),
      occurredAt: new Date(),
      reason: body.reason,
      auditContext: buildAuditContext(req),
    });
    return await respondWithWorkflow(res, caseId);
  } catch (error) {
    return handleWorkflowError(res, "Failed to reopen case", error);
  }
};
