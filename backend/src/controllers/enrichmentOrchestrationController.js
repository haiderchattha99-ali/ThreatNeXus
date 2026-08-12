"use strict";

// Phase 10A-1 — HTTP surface for enrichment orchestration. Mirrors
// findingEnrichmentController.js's shape exactly: parse and bound request
// input, delegate every decision to a service, map service errors onto a safe
// response. No orchestration logic lives here.
//
// The binding contract is docs/ai/PHASE-10A1-API-CONTRACT.md. If this file and
// that document disagree, this file is wrong.
//
// ---------------------------------------------------------------------------
// Status codes follow the OUTCOME, not the verb
// ---------------------------------------------------------------------------
//   202 Accepted + CREATED          a new run was recorded AND it has eligible
//                                   work. 202, not 200: recorded, not executed.
//   200 OK       + ALREADY_RUNNING  an idempotent replay, or the loser of a
//                                   concurrent race. The EXISTING run is
//                                   returned; nothing new was accepted.
//   200 OK       + SKIPPED          a new run was recorded and every target was
//                                   refused by policy. There is no work to
//                                   accept, so 202 would overstate it.
//
// The outcome is decided by the service (RUN_REQUEST_OUTCOMES) and only mapped
// to a status here, so the HTTP contract and the durable record can never
// disagree about what happened.
//
// ---------------------------------------------------------------------------
// The body names its parts
// ---------------------------------------------------------------------------
// `outcome`, `executionState`, `run` and `items` are four distinct top-level
// fields. The run is NOT flattened into a generic `data` envelope: a caller
// that has to dig a run's state out of an opaque payload will end up branching
// on `success` instead, which carries no information at all.
//
// `success: true` is kept only because every other endpoint in this repository
// emits it. It never substitutes for a binding field.
//
// ---------------------------------------------------------------------------
// Idempotency-Key handling
// ---------------------------------------------------------------------------
// The raw header is validated and hashed inside enrichmentIdentity.js and the
// raw value never leaves it. This controller passes the header straight in and
// receives only a digest back, so the raw value is never held in a variable
// that could reach a log line, an audit payload or a response body. A rejected
// key produces a 400 whose message names the RULE, never the value.

const prisma = require("../config/prisma");
const { buildAuditContext } = require("../services/auditService");
const { parseResourceId } = require("../lib/validation");
const {
  EnrichmentIdentityError,
  hashIdempotencyKeyHeader,
} = require("../services/enrichmentOrchestration/enrichmentIdentity");
const { EnrichmentSubjectError } = require("../services/enrichmentOrchestration/enrichmentSubject");
const {
  RUN_TRIGGERS,
  RUN_REQUEST_OUTCOMES,
} = require("../services/enrichmentOrchestration/enrichmentDecisionCodes");
const {
  EnrichmentRunValidationError,
  EnrichmentRunNotFoundError,
  createEnrichmentRun,
} = require("../services/enrichmentOrchestration/enrichmentRunService");
const {
  serializeRun,
  resolveExecutionState,
} = require("../services/enrichmentOrchestration/enrichmentRunReadService");
const {
  EnrichmentSummaryNotFoundError,
  EnrichmentSummaryValidationError,
  getFindingEnrichmentSummary,
} = require("../services/enrichmentOrchestration/enrichmentSummaryReadService");
const repository = require("../services/enrichmentOrchestration/enrichmentOrchestrationRepository");
const { getProviderUsage } = require("../services/enrichmentOrchestration/enrichmentUsageService");

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

const actorUserId = (req) => (req.user && Number.isInteger(req.user.id) ? req.user.id : null);

const runLocation = (findingId, runId) => `/api/findings/${findingId}/enrichment/runs/${runId}`;

exports.createFindingEnrichmentRun = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};

  // Validated before anything else touches the database, so a malformed key
  // never produces an orchestration record or an audit row.
  let idempotencyKeyHash;
  try {
    idempotencyKeyHash = hashIdempotencyKeyHeader(req.get("Idempotency-Key"));
  } catch (error) {
    if (error instanceof EnrichmentIdentityError) {
      // error.message names the rule only — hashIdempotencyKeyHeader never
      // interpolates the supplied value into it.
      return res.status(400).json({ success: false, message: error.message });
    }
    return serverError(res, "Failed to validate Idempotency-Key", error);
  }

  if (body.force !== undefined && typeof body.force !== "boolean") {
    return res.status(400).json({ success: false, message: "force must be a boolean." });
  }

  try {
    const outcome = await createEnrichmentRun(id, {
      client: prisma,
      trigger: RUN_TRIGGERS.MANUAL,
      providers: body.providers,
      force: body.force === true,
      // Normalized, bounded and (when force=true) REQUIRED by the service, so
      // the rule has one definition rather than one per caller.
      justification: body.justification,
      actorUserId: actorUserId(req),
      idempotencyKeyHash,
      now: new Date(),
      auditContext: buildAuditContext(req),
    });

    const status = outcome.outcome === RUN_REQUEST_OUTCOMES.CREATED ? 202 : 200;
    // Set on every outcome, including ALREADY_RUNNING: the caller asked about a
    // run and there is one to point at, whether or not this request made it.
    res.set("Location", runLocation(id, outcome.run.id));

    return res.status(status).json({
      success: true,
      outcome: outcome.outcome,
      executionState: resolveExecutionState(process.env),
      ...serializeRun(outcome.run, outcome.items),
    });
  } catch (error) {
    if (error instanceof EnrichmentRunNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    if (
      error instanceof EnrichmentRunValidationError ||
      error instanceof EnrichmentIdentityError ||
      error instanceof EnrichmentSubjectError
    ) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return serverError(res, "Failed to create enrichment orchestration run", error);
  }
};

exports.getFindingEnrichmentRun = async (req, res) => {
  const findingId = parseResourceId(req.params.id);
  const runId = parseResourceId(req.params.runId);
  if (findingId === null || runId === null) {
    return res.status(400).json({ success: false, message: "Invalid identifier." });
  }

  try {
    const run = await repository.findRunById(prisma, runId);
    // A run that belongs to a DIFFERENT Finding is reported as not found, not
    // as forbidden: confirming it exists would itself leak that another
    // Finding has a run with this id.
    if (!run || run.findingId !== findingId) {
      return res.status(404).json({ success: false, message: "Enrichment run not found." });
    }
    const items = await repository.listRunItemsWithJobs(prisma, run.id);
    return res.status(200).json({
      success: true,
      executionState: resolveExecutionState(process.env),
      ...serializeRun(run, items),
    });
  } catch (error) {
    return serverError(res, "Failed to load enrichment orchestration run", error);
  }
};

// GET /api/findings/:id/enrichment/summary
//
// A pure read: no provider is contacted, no run/item/job/attempt/usage row is
// created, no quota is reserved and no worker is started. It answers "what is
// known about this Finding, per provider" from stored state alone.
exports.getFindingEnrichmentSummary = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid finding id." });
  }

  try {
    const summary = await getFindingEnrichmentSummary(id, {
      client: prisma,
      // Obtained ONCE here and passed down, so every row in one response is
      // timestamped against the same instant.
      asOf: new Date(),
    });
    return res.status(200).json({ success: true, data: summary });
  } catch (error) {
    if (error instanceof EnrichmentSummaryNotFoundError) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }
    if (error instanceof EnrichmentSummaryValidationError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    return serverError(res, "Failed to load the finding enrichment summary", error);
  }
};

exports.getEnrichmentUsage = async (req, res) => {
  try {
    const usage = await getProviderUsage({ client: prisma });
    return res.status(200).json({ success: true, data: usage });
  } catch (error) {
    return serverError(res, "Failed to load enrichment provider usage", error);
  }
};
