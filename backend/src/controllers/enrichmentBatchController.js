"use strict";

// Administrator bounded IOC enrichment batch execution (P2-T2e-2). Thin by
// design: the entire decision — claim, look up, apply TTL/retry policy,
// complete, audit — already lives in enrichmentExecutionService.js /
// enrichmentRunner.js. This controller only bounds/derives request-time
// inputs the runner must never take from the caller (workerId, `now`) and
// serializes the result through an explicit allow-list.

const crypto = require("node:crypto");

const prisma = require("../config/prisma");
const { buildAuditContext } = require("../services/auditService");
const {
  EnrichmentExecutionError,
  executeEnrichmentBatch,
} = require("../services/enrichment/enrichmentExecutionService");
const { MAX_PENDING_BATCH_SIZE } = require("../services/enrichment/iocEnrichmentCacheRules");

const WORKER_ID_PREFIX = "http-batch";

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

// Never accepts a caller-supplied workerId, claim token, cache key or
// provider credential — the request body is never read for any of those.
// crypto.randomUUID() is unpredictable and unique per call, which is all a
// worker identifier needs to be here (there is no daemon/pool coordinating
// multiple concurrent workers to name apart).
function buildSafeWorkerId() {
  return `${WORKER_ID_PREFIX}-${crypto.randomUUID()}`;
}

function parseBatchSize(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_PENDING_BATCH_SIZE) {
    return { ok: false, value: null };
  }
  return { ok: true, value: raw };
}

// Allow-listed per-job view. Deliberately excludes indicator/indicatorType,
// claim token, cache key, activeCacheKey, workerId, headers and any provider
// payload — none of those fields are read off `job` here.
function serializeBatchJob(job) {
  return {
    enrichmentId: job.enrichmentId,
    provider: job.provider,
    outcome: job.outcome,
    terminalStatus: job.terminalStatus,
    queriedAt: job.queriedAt,
    expiresAt: job.expiresAt,
    failureClass: job.failureClass,
    terminalReasonCode: job.terminalReasonCode,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
  };
}

// Allow-listed aggregate view, mirroring
// enrichmentExecutionService.buildBatchAuditPayload's own allow-list —
// aggregates and a bounded per-job list only, never a workerId, claim token
// or cache key.
function serializeBatchSummary(summary) {
  return {
    requestedBatchSize: summary.requestedBatchSize,
    candidateCount: summary.candidateCount,
    claimedCount: summary.claimedCount,
    completedCount: summary.completedCount,
    releasedCount: summary.releasedCount,
    deadLetteredCount: summary.deadLetteredCount,
    heldUnknownStateCount: summary.heldUnknownStateCount,
    internalFailureCount: summary.internalFailureCount,
    staleCompletionCount: summary.staleCompletionCount,
    unknownProviderCount: summary.unknownProviderCount,
    skippedNotClaimedCount: summary.skippedNotClaimedCount,
    cancelled: summary.cancelled,
    statusCounts: { ...summary.statusCounts },
    results: summary.results.map(serializeBatchJob),
  };
}

exports.runEnrichmentBatch = async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};

  const rawBatchSize = body.batchSize;
  if (rawBatchSize !== undefined && typeof rawBatchSize !== "number") {
    return res.status(400).json({ success: false, message: "Invalid batchSize." });
  }
  const { ok, value: batchSize } = parseBatchSize(rawBatchSize);
  if (!ok) {
    return res.status(400).json({
      success: false,
      message: `batchSize must be an integer between 1 and ${MAX_PENDING_BATCH_SIZE}.`,
    });
  }

  const now = new Date();
  const workerId = buildSafeWorkerId();

  try {
    const summary = await executeEnrichmentBatch({
      prisma,
      actorContext: buildAuditContext(req),
      now,
      batchSize,
      workerId,
    });

    return res.status(200).json({ success: true, data: serializeBatchSummary(summary) });
  } catch (error) {
    if (error instanceof EnrichmentExecutionError) {
      return res.status(400).json({ success: false, message: "Invalid batch execution request." });
    }
    return serverError(res, "Enrichment batch execution failed", error);
  }
};
