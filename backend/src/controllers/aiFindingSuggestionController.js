"use strict";

// Finding-scoped AI assist HTTP surface (Phase 8C): request/list a draft, and
// accept/reject one. Mirrors frameworkMappingController.js's AI-assistance
// handlers and censysEnrichmentController.js's shape — parse/bound request
// input, delegate every decision to the service, map service errors to a
// safe HTTP response.
//
// No role name appears in this file: authorization is entirely the routes'
// requireCapability middleware, and every service writes its own audit
// events, so this controller never audits a second time.

const prisma = require("../config/prisma");
const { buildAuditContext } = require("../services/auditService");
const { parseResourceId } = require("../lib/validation");

const {
  SUGGESTION_TYPE_VALUES,
  AiAssistValidationError,
  AiAssistNotFoundError,
  AiAssistStateError,
} = require("../services/aiAssist/aiAssistRules");

const {
  requestFindingAiSuggestion,
  listFindingAiSuggestions,
} = require("../services/aiAssist/findingAiSuggestionService");
const {
  acceptFindingAiSuggestion,
  rejectFindingAiSuggestion,
} = require("../services/aiAssist/findingAiSuggestionDecisionService");
const { serializeFindingAiSuggestion } = require("../services/aiAssist/aiAssistSerializers");

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

const actorUserId = (req) => (req.user && Number.isInteger(req.user.id) ? req.user.id : null);

function parseIdOr400(res, raw, label) {
  const id = parseResourceId(raw);
  if (id === null) {
    res.status(400).json({ success: false, message: `Invalid ${label}.` });
    return null;
  }
  return id;
}

function readBody(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function rejectUnexpectedFields(res, body, allowed) {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    res.status(400).json({
      success: false,
      message: "Request body contains unexpected fields.",
      fields: unexpected,
    });
    return true;
  }
  return false;
}

function handleError(res, label, error) {
  if (error instanceof AiAssistNotFoundError) {
    return res.status(404).json({ success: false, message: "Not found." });
  }
  if (error instanceof AiAssistStateError) {
    return res.status(409).json({
      success: false,
      message: "The AI suggestion is not in a state that allows this operation.",
      code: error.code,
    });
  }
  if (error instanceof AiAssistValidationError) {
    return res.status(400).json({ success: false, message: error.message, fields: error.fields, code: error.code });
  }
  return serverError(res, label, error);
}

exports.listSuggestions = async (req, res) => {
  const findingId = parseIdOr400(res, req.params.id, "finding id");
  if (findingId === null) return undefined;

  try {
    const rows = await listFindingAiSuggestions(findingId, { client: prisma });
    return res.status(200).json({
      success: true,
      data: { findingId, suggestions: rows.map(serializeFindingAiSuggestion) },
    });
  } catch (error) {
    return handleError(res, "Failed to read AI finding suggestions", error);
  }
};

const REQUEST_ALLOWED_FIELDS = Object.freeze(["suggestionType", "requestContext"]);

exports.requestSuggestion = async (req, res) => {
  const findingId = parseIdOr400(res, req.params.id, "finding id");
  if (findingId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, REQUEST_ALLOWED_FIELDS)) return undefined;

  if (typeof body.suggestionType !== "string" || !SUGGESTION_TYPE_VALUES.includes(body.suggestionType)) {
    return res.status(400).json({
      success: false,
      message: `suggestionType must be one of ${SUGGESTION_TYPE_VALUES.join(", ")}`,
      fields: ["suggestionType"],
    });
  }

  try {
    const { suggestion } = await requestFindingAiSuggestion(findingId, body.suggestionType, {
      client: prisma,
      actorUserId: actorUserId(req),
      auditContext: buildAuditContext(req),
      requestContext: body.requestContext,
      requestedAt: new Date(),
    });

    // 200 even for a DISABLED or FAILED outcome: the request was well formed
    // and was answered. A 503 would tell an analyst something is broken when
    // the shipped default is simply "off".
    return res.status(200).json({ success: true, data: serializeFindingAiSuggestion(suggestion) });
  } catch (error) {
    return handleError(res, "Failed to request AI finding suggestion", error);
  }
};

const DECIDE_ALLOWED_FIELDS = Object.freeze(["reason"]);

exports.acceptSuggestion = async (req, res) => {
  const findingId = parseIdOr400(res, req.params.id, "finding id");
  if (findingId === null) return undefined;
  const suggestionId = parseIdOr400(res, req.params.suggestionId, "suggestion id");
  if (suggestionId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, DECIDE_ALLOWED_FIELDS)) return undefined;

  try {
    const outcome = await acceptFindingAiSuggestion(findingId, suggestionId, {
      client: prisma,
      actorUserId: actorUserId(req),
      auditContext: buildAuditContext(req),
      reason: body.reason,
      decidedAt: new Date(),
    });
    return res.status(200).json({
      success: true,
      data: { outcome: outcome.outcome, changed: outcome.changed, suggestion: serializeFindingAiSuggestion(outcome.suggestion) },
    });
  } catch (error) {
    return handleError(res, "Failed to accept AI finding suggestion", error);
  }
};

exports.rejectSuggestion = async (req, res) => {
  const findingId = parseIdOr400(res, req.params.id, "finding id");
  if (findingId === null) return undefined;
  const suggestionId = parseIdOr400(res, req.params.suggestionId, "suggestion id");
  if (suggestionId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, DECIDE_ALLOWED_FIELDS)) return undefined;

  try {
    const outcome = await rejectFindingAiSuggestion(findingId, suggestionId, {
      client: prisma,
      actorUserId: actorUserId(req),
      auditContext: buildAuditContext(req),
      reason: body.reason,
      decidedAt: new Date(),
    });
    return res.status(200).json({
      success: true,
      data: { outcome: outcome.outcome, changed: outcome.changed, suggestion: serializeFindingAiSuggestion(outcome.suggestion) },
    });
  } catch (error) {
    return handleError(res, "Failed to reject AI finding suggestion", error);
  }
};
