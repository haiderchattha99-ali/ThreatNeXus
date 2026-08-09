"use strict";

// Finding-scoped Netlas exposure enrichment HTTP surface (Phase 8F): a safe
// read (GET .../enrichment/netlas) and a manual synchronous trigger
// (POST .../enrichment/netlas). Mirrors shodanEnrichmentController.js's
// shape — parse/bound request input, delegate every decision to the
// service, map service errors to a safe HTTP response — the POST here
// executes immediately rather than scheduling queued work, per this
// phase's explicit "no queues/schedulers" scope.

const prisma = require("../config/prisma");
const { buildAuditContext } = require("../services/auditService");
const { parseResourceId } = require("../lib/validation");
const { loadFindingIndicator, FindingEnrichmentNotFoundError } = require("../services/enrichment/findingEnrichmentReadService");
const {
  FindingEnrichmentValidationError,
  serializeRecord,
  executeNetlasLookup,
} = require("../services/exposure/netlasExecutionService");

const MAX_HISTORY_ROWS = 20;

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

exports.getNetlasEnrichments = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  try {
    const { indicator } = await loadFindingIndicator(prisma, id);
    const rows = await prisma.netlasEnrichment.findMany({
      where: { indicator },
      orderBy: { queriedAt: "desc" },
      take: MAX_HISTORY_ROWS,
    });
    return res.status(200).json({
      success: true,
      data: { findingId: id, indicator, provider: "netlas", records: rows.map(serializeRecord) },
    });
  } catch (error) {
    if (error instanceof FindingEnrichmentNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    return serverError(res, "Failed to load Netlas enrichment history", error);
  }
};

exports.triggerNetlasEnrichment = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  try {
    const outcome = await executeNetlasLookup(id, {
      client: prisma,
      now: new Date(),
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
    return serverError(res, "Failed to execute Netlas enrichment lookup", error);
  }
};
