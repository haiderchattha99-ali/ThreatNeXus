"use strict";

// Finding-scoped Shodan exposure enrichment HTTP surface (Phase 8E): a safe
// read (GET .../enrichment/shodan) and a manual synchronous trigger
// (POST .../enrichment/shodan). Mirrors censysEnrichmentController.js's
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
  executeShodanLookup,
} = require("../services/exposure/shodanExecutionService");

const MAX_HISTORY_ROWS = 20;

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

exports.getShodanEnrichments = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  try {
    const { indicator } = await loadFindingIndicator(prisma, id);
    const rows = await prisma.shodanEnrichment.findMany({
      where: { indicator },
      orderBy: { queriedAt: "desc" },
      take: MAX_HISTORY_ROWS,
    });
    return res.status(200).json({
      success: true,
      data: { findingId: id, indicator, provider: "shodan", records: rows.map(serializeRecord) },
    });
  } catch (error) {
    if (error instanceof FindingEnrichmentNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    return serverError(res, "Failed to load Shodan enrichment history", error);
  }
};

exports.triggerShodanEnrichment = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  try {
    const outcome = await executeShodanLookup(id, {
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
    return serverError(res, "Failed to execute Shodan enrichment lookup", error);
  }
};
