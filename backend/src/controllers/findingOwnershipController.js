"use strict";

// Finding-ownership HTTP surface (P2-T1): current/history read, coverage
// metrics, and analyst override apply/clear. findingOwnershipService already
// writes its own "ownership.override.applied" / "ownership.override.cleared"
// / "ownership.resolution.*" audit events (it needs auditContext for both
// success and failure paths), so this controller passes auditContext through
// rather than auditing a second time.

const prisma = require("../config/prisma");
const { buildAuditContext } = require("../services/auditService");
const { parseResourceId } = require("../lib/validation");
const {
  FindingOwnershipNotFoundError,
  FindingOwnershipValidationError,
  FindingOwnershipOverrideStateError,
  getFindingOwnership,
  calculateCoverage,
  applyOverride,
  clearOverride,
} = require("../services/ownership/findingOwnershipService");
const { buildSectorContext } = require("../services/ownership/ownershipSectorContext");
const {
  runAuditedConsistencyCheck,
  MIN_BATCH_SIZE: CONSISTENCY_MIN_BATCH_SIZE,
  MAX_BATCH_SIZE: CONSISTENCY_MAX_BATCH_SIZE,
} = require("../services/ownership/ownershipConsistencyService");

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

const actorUserId = (req) => (req.user && Number.isInteger(req.user.id) ? req.user.id : null);

function serializeOwnershipRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    findingId: row.findingId,
    organizationId: row.organizationId,
    status: row.status,
    confidence: row.confidence,
    matchedMappingId: row.matchedMappingId,
    matchedPrefixLength: row.matchedPrefixLength,
    candidateCount: row.candidateCount,
    isIspAttribution: row.isIspAttribution,
    reasonCode: row.reasonCode,
    resolvedAt: row.resolvedAt,
    asOf: row.asOf,
    supersededAt: row.supersededAt,
    overrideActorUserId: row.overrideActorUserId,
    overrideJustification: row.overrideJustification,
    createdAt: row.createdAt,
  };
}

// Coerces a body value that must be an integer id: accepts a number or a
// numeric string, rejects everything else (including floats) by returning
// NaN, which the service layer's Number.isInteger check then rejects safely.
function coerceInteger(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return Number.NaN;
}

// Strict allow-list for the ADMIN consistency diagnostic. `afterId`, `asOf`,
// `actorUserId`, a worker id, or any resolver/risk/ownership value are all
// rejected rather than ignored — this endpoint reports on state, it must never
// be steerable into reporting on a caller-chosen slice of it.
const CONSISTENCY_ALLOWED_FIELDS = Object.freeze(["batchSize"]);

/**
 * ADMIN-only bounded ownership consistency diagnostic.
 *
 * Reports; never repairs. Returns aggregate counts plus bounded exact Finding
 * ids per issue code so an ADMIN can actually investigate, while the audit
 * event it writes carries counts only.
 */
exports.getConsistencyReport = async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const unexpected = Object.keys(body).filter((key) => !CONSISTENCY_ALLOWED_FIELDS.includes(key));
  if (unexpected.length > 0) {
    return res.status(400).json({ success: false, message: "Unexpected fields.", fields: unexpected });
  }
  if (
    Object.prototype.hasOwnProperty.call(body, "batchSize") &&
    (!Number.isInteger(body.batchSize) ||
      body.batchSize < CONSISTENCY_MIN_BATCH_SIZE ||
      body.batchSize > CONSISTENCY_MAX_BATCH_SIZE)
  ) {
    return res.status(400).json({
      success: false,
      message: `batchSize must be an integer between ${CONSISTENCY_MIN_BATCH_SIZE} and ${CONSISTENCY_MAX_BATCH_SIZE}.`,
      fields: ["batchSize"],
    });
  }

  try {
    const report = await runAuditedConsistencyCheck(prisma, {
      batchSize: body.batchSize,
      asOf: new Date(),
      auditContext: buildAuditContext(req),
    });
    return res.status(200).json({ success: true, data: report });
  } catch (error) {
    return serverError(res, "Failed to run ownership consistency check", error);
  }
};

exports.getCoverage = async (req, res) => {
  try {
    const coverage = await calculateCoverage({ client: prisma });
    return res.status(200).json({ success: true, data: coverage });
  } catch (error) {
    return serverError(res, "Failed to calculate ownership coverage", error);
  }
};

exports.getFindingOwnership = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  try {
    const { current, history } = await getFindingOwnership(id, { client: prisma });
    // Safe organization/sector context. Sector APPLICABILITY comes from the
    // same gate the risk engine scores with (riskInputSnapshot); the number it
    // is worth stays in the risk explanation and is never computed here.
    const sectorContext = await buildSectorContext(prisma, id, current);
    return res.status(200).json({
      success: true,
      data: {
        current: serializeOwnershipRow(current),
        history: history.map(serializeOwnershipRow),
        sectorContext,
      },
    });
  } catch (error) {
    if (error instanceof FindingOwnershipNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    return serverError(res, "Failed to load finding ownership", error);
  }
};

exports.applyOverride = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const organizationId = coerceInteger(body.organizationId);
  const justification = body.justification;

  try {
    const outcome = await applyOverride(id, organizationId, justification, {
      client: prisma,
      actorUserId: actorUserId(req),
      auditContext: buildAuditContext(req),
    });

    return res.status(200).json({ success: true, data: serializeOwnershipRow(outcome.current) });
  } catch (error) {
    if (error instanceof FindingOwnershipNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    if (error instanceof FindingOwnershipValidationError) {
      return res.status(400).json({
        success: false,
        message: "Missing or invalid fields.",
        fields: error.fields,
      });
    }
    return serverError(res, "Failed to apply ownership override", error);
  }
};

exports.clearOverride = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};

  try {
    const outcome = await clearOverride(id, {
      client: prisma,
      actorUserId: actorUserId(req),
      justification: body.justification,
      auditContext: buildAuditContext(req),
    });

    return res.status(200).json({ success: true, data: serializeOwnershipRow(outcome.current) });
  } catch (error) {
    if (error instanceof FindingOwnershipNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    if (error instanceof FindingOwnershipOverrideStateError) {
      return res.status(409).json({ success: false, message: "This finding has no active analyst override to clear." });
    }
    if (error instanceof FindingOwnershipValidationError) {
      return res.status(400).json({
        success: false,
        message: "Missing or invalid fields.",
        fields: error.fields,
      });
    }
    return serverError(res, "Failed to clear ownership override", error);
  }
};
