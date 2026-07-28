"use strict";

// Audited enrichment batch execution (P2-T2e-1).
//
// P2-T2d left the runner deliberately unreachable: pure orchestration, no
// composition root, no audit, no call site. This module closes exactly one of
// those gaps — it is the first thing in the repository that can invoke a
// provider against real configuration — and so, per AGENTS.md's cross-cutting
// rule, it brings its own AuditLog events with it rather than deferring them
// to whoever adds a route later.
//
// Boundaries this module keeps:
//   - it invokes runEnrichmentBatch AT MOST ONCE per call. No loop, no timer,
//     no daemon, no self-rescheduling.
//   - it has actor/source context but NO HTTP dependency: no req, no res, no
//     Express import. A system caller (ingestion, a future scheduled trigger)
//     passes SYSTEM_ACTOR_CONTEXT; a route caller will pass
//     auditService.buildAuditContext(req). Both are plain objects.
//   - the runner itself stays audit-agnostic. Audit lives here so the pure
//     orchestration layer never needs a database write it cannot explain.
//
// ---------------------------------------------------------------------------
// What may be audited, and what may never be
// ---------------------------------------------------------------------------
// Audit payloads carry AGGREGATES ONLY — counts, and the terminal-status
// histogram. Explicitly never: any indicator value, a claim token, a cache
// key, an activeCacheKey, an API key, a request header, a raw provider
// response, an Error message, a stack, or a database row.
//
// The indicator exclusion is the deliberate one. `summary.results[]` carries
// per-job indicators and the runner is right to return them (its caller needs
// to know which jobs moved), but writing one AuditLog row per indicator would
// both flood the trail and copy victim-adjacent data into it on every batch.
// Per-job evidence already lives in IocEnrichment itself, which is the
// correct, queryable home for it.
//
// `buildBatchAuditPayload` is an allow-list, not a redaction pass: it names
// the fields it copies. A field added to the runner's summary later cannot
// leak through it by default.

const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");
const { runEnrichmentBatch } = require("./enrichmentRunner");
const { buildEnrichmentRuntime } = require("./enrichmentRuntime");
const { MAX_PENDING_BATCH_SIZE } = require("./iocEnrichmentCacheRules");

const AUDIT_ACTIONS = Object.freeze({
  REQUESTED: "enrichment.batch.requested",
  COMPLETED: "enrichment.batch.completed",
  CANCELLED: "enrichment.batch.cancelled",
  FAILED: "enrichment.batch.failed",
});

const AUDIT_ENTITY_TYPE = "IocEnrichmentBatch";

// The actor context a non-HTTP caller (ingestion, a scheduled trigger) uses.
// actorUserId stays null: attributing system work to a real user would be a
// false attribution, and auditService already treats an absent role as null
// rather than defaulting it to VIEWER.
const SYSTEM_ACTOR_CONTEXT = Object.freeze({
  actorUserId: null,
  actorEmail: null,
  actorRole: null,
});

class EnrichmentExecutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentExecutionError";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Mirrors findingOwnershipService's `audit` helper: an audit failure must
// never propagate into the operation it describes. safeLogAuditEvent already
// swallows write failures; this second guard covers a caller-supplied context
// that makes buildAuditData itself throw.
async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...auditContext, ...event }, { client });
  } catch (error) {
    console.error("Enrichment batch audit failed", { name: error && error.name });
  }
}

/**
 * Allow-listed aggregate view of a batch summary. Named fields only — a
 * per-job entry, an indicator, or a future summary field can never reach an
 * audit row through this function.
 */
function buildBatchAuditPayload(summary, workerId) {
  return {
    workerId,
    requestedBatchSize: summary.requestedBatchSize,
    candidateCount: summary.candidateCount,
    claimedCount: summary.claimedCount,
    completedCount: summary.completedCount,
    skippedNotClaimedCount: summary.skippedNotClaimedCount,
    releasedCount: summary.releasedCount,
    staleCompletionCount: summary.staleCompletionCount,
    internalFailureCount: summary.internalFailureCount,
    unknownProviderCount: summary.unknownProviderCount,
    deadLetteredCount: summary.deadLetteredCount,
    heldUnknownStateCount: summary.heldUnknownStateCount,
    cancelled: summary.cancelled,
    // Terminal statuses are a closed provider vocabulary (SUCCESS,
    // NOT_FOUND, RATE_LIMITED, ...) — a histogram of them carries no
    // indicator and no payload.
    statusCounts: { ...summary.statusCounts },
  };
}

function assertValidWorkerIdShape(workerId) {
  if (typeof workerId !== "string" || workerId.trim() === "") {
    throw new EnrichmentExecutionError("executeEnrichmentBatch: workerId must be a non-empty string");
  }
  return workerId;
}

/**
 * Executes ONE bounded enrichment batch against real (or injected)
 * dependencies, auditing the attempt and its aggregate outcome.
 *
 * Audit events, one pair per call:
 *   enrichment.batch.requested  — always, before any work
 *   enrichment.batch.completed  — a batch that ran to its own end
 *   enrichment.batch.cancelled  — a batch the caller's signal stopped
 *   enrichment.batch.failed     — a failure BEFORE/AROUND processing (invalid
 *                                 configuration, a listing query that threw).
 *                                 Per-job failures are not batch failures:
 *                                 they are counted inside a completed batch.
 *
 * Never more than three audit rows per call, whatever the batch size — there
 * is no per-job audit event by design.
 *
 * @param {{prisma: object, actorContext?: object, now?: Date,
 *   batchSize?: number, workerId: string, signal?: AbortSignal,
 *   runtimeOverrides?: object}} input
 * @returns {Promise<object>} the runner's frozen, safe batch summary
 */
async function executeEnrichmentBatch(input = {}) {
  if (!isPlainObject(input)) {
    throw new EnrichmentExecutionError("executeEnrichmentBatch: input must be an object");
  }
  const {
    prisma,
    actorContext = SYSTEM_ACTOR_CONTEXT,
    now = new Date(),
    batchSize = null,
    workerId,
    signal = null,
    runtimeOverrides = {},
  } = input;

  if (!prisma || typeof prisma !== "object") {
    throw new EnrichmentExecutionError("executeEnrichmentBatch: prisma client is required");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new EnrichmentExecutionError("executeEnrichmentBatch: now must be a valid Date");
  }
  assertValidWorkerIdShape(workerId);
  if (batchSize !== null && (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_PENDING_BATCH_SIZE)) {
    throw new EnrichmentExecutionError(
      `executeEnrichmentBatch: batchSize must be an integer between 1 and ${MAX_PENDING_BATCH_SIZE}`
    );
  }

  const auditContext = isPlainObject(actorContext) ? actorContext : SYSTEM_ACTOR_CONTEXT;

  // Building the runtime can throw (bad configuration). That is a
  // before-processing failure and is audited as one — but only after the
  // "requested" event, so an operator can always see that something tried.
  await audit(prisma, auditContext, {
    action: AUDIT_ACTIONS.REQUESTED,
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: AUDIT_ENTITY_TYPE,
    after: { workerId, requestedBatchSize: batchSize },
    reason: "Bounded IOC enrichment batch requested",
  });

  let runtime;
  let summary;
  try {
    runtime = buildEnrichmentRuntime(runtimeOverrides);
    summary = await runEnrichmentBatch({
      prisma,
      providerRegistry: runtime.providerRegistry,
      now,
      batchSize: batchSize ?? runtime.defaultBatchSize,
      leaseDurationSeconds: runtime.leaseDurationSeconds,
      ttlPolicy: runtime.ttlPolicy,
      retryPolicy: runtime.retryPolicy,
      workerId,
      signal,
    });
  } catch (error) {
    // runEnrichmentBatch does not throw for any per-job outcome, so reaching
    // here means configuration or the listing query itself failed — nothing
    // was processed. The error's own text is never audited.
    await audit(prisma, auditContext, {
      action: AUDIT_ACTIONS.FAILED,
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: AUDIT_ENTITY_TYPE,
      after: { workerId, requestedBatchSize: batchSize },
      reason: "Enrichment batch failed before processing any candidate",
    });
    throw error;
  }

  // The batch itself succeeded even if individual jobs did not: per-job
  // failures are visible as counts, not as a failed batch.
  await audit(prisma, auditContext, {
    action: summary.cancelled ? AUDIT_ACTIONS.CANCELLED : AUDIT_ACTIONS.COMPLETED,
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: AUDIT_ENTITY_TYPE,
    after: buildBatchAuditPayload(summary, workerId),
    reason: summary.cancelled
      ? "Bounded IOC enrichment batch cancelled by caller"
      : "Bounded IOC enrichment batch completed",
  });

  return summary;
}

module.exports = {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPE,
  SYSTEM_ACTOR_CONTEXT,
  EnrichmentExecutionError,
  buildBatchAuditPayload,
  executeEnrichmentBatch,
};
