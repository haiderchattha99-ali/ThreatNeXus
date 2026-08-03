"use strict";

// Finding-triage HTTP surface (Phase 3).
//
// findingTriageService writes its own audit events on both the success and
// failure paths (it needs auditContext for both), so this controller passes
// auditContext through rather than auditing a second time — the same division
// findingOwnershipController.js already uses.
//
// No role name appears anywhere in this file. Authorization is entirely the
// route's requireCapability middleware; a denied request is answered by that
// middleware and never reaches a service.

const prisma = require("../config/prisma");
const { buildAuditContext } = require("../services/auditService");
const { parseResourceId } = require("../lib/validation");

const {
  TRIAGE_DECISION_VALUES,
  CaseWorkflowValidationError,
  CaseWorkflowNotFoundError,
} = require("../services/workflow/caseWorkflowRules");

const { recordTriageDecision } = require("../services/workflow/findingTriageService");
const { getFindingTriageContext } = require("../services/workflow/caseWorkflowReadService");

// Errors are logged by NAME only and answered with a fixed message. A Prisma
// error message can carry column names, constraint text and fragments of the
// submitted values — none of which may reach a client or an operator log here.
const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

const actorUserId = (req) => (req.user && Number.isInteger(req.user.id) ? req.user.id : null);

// Strict allow-list. An unexpected key is REJECTED rather than ignored, so a
// caller cannot discover that `source`, `caseId`, `decidedAt` or
// `currentForFindingId` exist by having them silently dropped — and cannot
// ever set them: source is fixed to ANALYST_DECISION by the service, and the
// decision instant is server-captured.
const TRIAGE_ALLOWED_FIELDS = Object.freeze(["decision", "reason"]);

exports.getTriage = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  try {
    const context = await getFindingTriageContext(id, { client: prisma });
    return res.status(200).json({ success: true, data: context });
  } catch (error) {
    if (error instanceof CaseWorkflowNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    return serverError(res, "Failed to load finding triage", error);
  }
};

exports.updateTriage = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const unexpected = Object.keys(body).filter((key) => !TRIAGE_ALLOWED_FIELDS.includes(key));
  if (unexpected.length > 0) {
    return res
      .status(400)
      .json({ success: false, message: "Unexpected fields.", fields: unexpected });
  }

  try {
    const outcome = await recordTriageDecision(
      {
        findingId: id,
        decision: body.decision,
        reason: body.reason,
        // Server-captured. A caller-supplied decision time would let the
        // append-only history be back- or forward-dated.
        decidedAt: new Date(),
      },
      {
        client: prisma,
        actorUserId: actorUserId(req),
        auditContext: buildAuditContext(req),
      }
    );

    const context = await getFindingTriageContext(id, { client: prisma });
    return res.status(200).json({
      success: true,
      data: { ...context, previousDecision: outcome.previousDecision },
    });
  } catch (error) {
    if (error instanceof CaseWorkflowNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    if (error instanceof CaseWorkflowValidationError) {
      return res.status(400).json({
        success: false,
        message: "Missing or invalid fields.",
        fields: error.fields,
        // The closed decision vocabulary is safe to disclose: it is a fixed
        // part of the published contract, not stored data.
        allowedDecisions: TRIAGE_DECISION_VALUES,
      });
    }
    return serverError(res, "Failed to record finding triage", error);
  }
};
