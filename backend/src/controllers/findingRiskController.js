"use strict";

// Finding-scoped deterministic risk HTTP surface (P2-T3): a safe read
// (GET .../risk) and an analyst-triggered recalculation
// (POST .../risk/recalculate). Mirrors findingEnrichmentController.js's shape:
// this controller only parses/bounds request input and maps service errors to
// a safe response — every decision belongs to the service.
//
// The request can influence WHEN a score is calculated and WHY (justification)
// and nothing else. There is deliberately no way to supply a weight, a score,
// a band, a configuration version or an asOf: the controller captures `now`
// itself, exactly once, and the weights are frozen code constants.

const prisma = require("../config/prisma");
const { buildAuditContext } = require("../services/auditService");
const { parseResourceId } = require("../lib/validation");
const {
  FindingRiskNotFoundError,
  FindingRiskValidationError,
  getFindingRisk,
} = require("../services/risk/findingRiskReadService");
const {
  RiskScoringValidationError,
  RiskFindingNotFoundError,
  MAX_JUSTIFICATION_LENGTH,
} = require("../services/risk/riskScoringService");
const {
  AUDIT_ACTIONS,
  recalculateFindingRisk,
} = require("../services/risk/riskRecalculationService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../services/auditService");

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

const actorUserId = (req) => (req.user && Number.isInteger(req.user.id) ? req.user.id : null);

function parseBoundedInt(raw, { min, max }) {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  if (!/^-?\d+$/.test(raw.trim())) return null;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function parseBoundedBoolean(raw, defaultValue) {
  if (raw === undefined) return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

exports.getFindingRisk = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  const page = parseBoundedInt(req.query.page, { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (page === null) {
    return res.status(400).json({ success: false, message: "Invalid page." });
  }
  const pageSize = parseBoundedInt(req.query.pageSize, { min: 1, max: 100 });
  if (pageSize === null) {
    return res.status(400).json({ success: false, message: "Invalid pageSize." });
  }
  const includeHistory = parseBoundedBoolean(req.query.includeHistory, true);
  if (includeHistory === null) {
    return res.status(400).json({ success: false, message: "Invalid includeHistory." });
  }

  try {
    const context = await getFindingRisk(id, {
      client: prisma,
      includeHistory,
      page,
      pageSize,
    });
    return res.status(200).json({ success: true, data: context });
  } catch (error) {
    if (error instanceof FindingRiskNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    if (error instanceof FindingRiskValidationError) {
      return res.status(400).json({ success: false, message: "Invalid request." });
    }
    return serverError(res, "Failed to load finding risk", error);
  }
};

exports.recalculateFindingRisk = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};

  // Justification is required for a manual recalculation: it is an analyst
  // action that appends to permanent scoring history, so it carries a reason.
  const justificationRaw = body.justification;
  if (typeof justificationRaw !== "string" || justificationRaw.trim() === "") {
    return res.status(400).json({ success: false, message: "justification is required." });
  }
  const justification = justificationRaw.trim();
  if (justification.length > MAX_JUSTIFICATION_LENGTH) {
    return res.status(400).json({
      success: false,
      message: `justification must be at most ${MAX_JUSTIFICATION_LENGTH} characters.`,
    });
  }

  // Captured exactly once, here. The service and engine never read a clock,
  // and the caller cannot supply one.
  const now = new Date();
  const auditContext = buildAuditContext(req);
  const actor = actorUserId(req);

  // Requested/completed are a bounded pair: one "an analyst asked for this"
  // record, then one outcome record from the service.
  await safeLogAuditEvent(
    {
      ...auditContext,
      action: AUDIT_ACTIONS.MANUAL_REQUESTED,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: "Finding",
      entityId: id,
      reason: justification,
      after: { trigger: "MANUAL" },
    },
    { client: prisma }
  );

  try {
    const result = await recalculateFindingRisk({
      findingId: id,
      asOf: now,
      trigger: "MANUAL",
      client: prisma,
      actorUserId: actor,
      justification,
      auditContext,
      auditActions: {
        completed: AUDIT_ACTIONS.MANUAL_COMPLETED,
        unchanged: AUDIT_ACTIONS.MANUAL_COMPLETED,
        failed: AUDIT_ACTIONS.MANUAL_FAILED,
      },
    });

    if (!result.ok) {
      if (result.failureCode === "FINDING_NOT_FOUND") {
        return res.status(404).json({ success: false, message: "Finding not found." });
      }
      if (result.failureCode === "VALIDATION_ERROR") {
        return res.status(400).json({ success: false, message: "Invalid request." });
      }
      // Closed failure code only — no exception text ever reaches the client.
      return res.status(500).json({ success: false, message: "Server Error" });
    }

    // Re-read through the read service so the response shape is identical to
    // GET .../risk, including the explanation rendered from stored rows.
    const context = await getFindingRisk(id, { client: prisma, includeHistory: false });

    return res.status(200).json({
      success: true,
      data: { outcome: result.outcome, findingId: id, current: context.current },
    });
  } catch (error) {
    if (error instanceof RiskFindingNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    if (error instanceof RiskScoringValidationError) {
      return res.status(400).json({ success: false, message: "Invalid request." });
    }
    return serverError(res, "Failed to recalculate finding risk", error);
  }
};
