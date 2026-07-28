"use strict";

// Finding-scoped IOC enrichment HTTP surface (P2-T2e-2): a safe read
// (GET .../enrichments) and manual normal/forced scheduling
// (POST .../enrichment). Both delegate every decision to their service —
// this controller only parses/bounds request input and maps service errors
// to a safe HTTP response, mirroring findingOwnershipController.js's shape.

const prisma = require("../config/prisma");
const { buildAuditContext } = require("../services/auditService");
const { parseResourceId } = require("../lib/validation");
const {
  FindingEnrichmentNotFoundError,
  FindingEnrichmentValidationError,
  getFindingEnrichmentContext,
} = require("../services/enrichment/findingEnrichmentReadService");
const {
  scheduleFindingEnrichment,
} = require("../services/enrichment/findingEnrichmentScheduleService");

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

const actorUserId = (req) => (req.user && Number.isInteger(req.user.id) ? req.user.id : null);

// Route params/query are untrusted strings. Returns `undefined` for "not
// supplied" (caller should apply its own default) and `null` for "supplied
// but invalid" (caller should respond 400) — never coerces silently.
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

exports.getFindingEnrichments = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  const providerRaw = req.query.provider;
  if (providerRaw !== undefined && typeof providerRaw !== "string") {
    return res.status(400).json({ success: false, message: "Invalid provider." });
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
    const context = await getFindingEnrichmentContext(id, {
      client: prisma,
      provider: providerRaw,
      asOf: new Date(),
      page,
      pageSize,
      includeHistory,
    });
    return res.status(200).json({ success: true, data: context });
  } catch (error) {
    if (error instanceof FindingEnrichmentNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    if (error instanceof FindingEnrichmentValidationError) {
      return res.status(400).json({ success: false, message: "Invalid request." });
    }
    return serverError(res, "Failed to load finding enrichment context", error);
  }
};

exports.scheduleFindingEnrichment = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};

  try {
    const outcome = await scheduleFindingEnrichment(id, {
      client: prisma,
      provider: body.provider,
      maxAgeInDays: body.maxAgeInDays,
      force: body.force,
      justification: body.justification,
      now: new Date(),
      actorUserId: actorUserId(req),
      auditContext: buildAuditContext(req),
    });

    return res.status(200).json({ success: true, data: outcome });
  } catch (error) {
    if (error instanceof FindingEnrichmentNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    if (error instanceof FindingEnrichmentValidationError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return serverError(res, "Failed to schedule finding enrichment", error);
  }
};
