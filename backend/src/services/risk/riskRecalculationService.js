"use strict";

// ===========================================================================
// P2-T3 — Safe automatic rescoring at state-change boundaries.
//
// Every automatic caller (ingestion, enrichment completion, ownership change)
// goes through this module rather than calling riskScoringService directly.
// It provides the two guarantees those callers need:
//
//   1. FAILURE ISOLATION. A risk failure must never roll back or alter the
//      evidence that triggered it — report rows, enrichment results and
//      ownership history are all already durably committed by the time we run.
//      Nothing here throws into the caller; failures come back as a result
//      object with a closed outcome code.
//
//   2. BOUNDED AUDIT. One aggregate event per operation, never one per factor
//      and never one per finding in a batch. Payloads carry counts and closed
//      codes only.
//
// This mirrors the ownership pipeline's resolveOwnershipSafely discipline and
// the enrichment execution service's aggregate-audit discipline exactly.
//
// No daemon, no cron, no infinite retry, no unbounded organization-wide sweep.
// ===========================================================================

const {
  RISK_CALCULATION_OUTCOME,
  RISK_TRIGGERS,
  calculateAndPersistRisk,
} = require("./riskScoringService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const AUDIT_ENTITY_TYPE = "Finding";
const AUDIT_BATCH_ENTITY_TYPE = "RiskCalculationBatch";

const AUDIT_ACTIONS = Object.freeze({
  COMPLETED: "risk.calculation.completed",
  UNCHANGED: "risk.calculation.unchanged",
  FAILED: "risk.calculation.failed",

  MANUAL_REQUESTED: "risk.manual.recalculation.requested",
  MANUAL_COMPLETED: "risk.manual.recalculation.completed",
  MANUAL_FAILED: "risk.manual.recalculation.failed",

  INGESTION_COMPLETED: "risk.ingestion.calculation.completed",
  INGESTION_FAILED: "risk.ingestion.calculation.failed",

  ENRICHMENT_COMPLETED: "risk.enrichment.recalculation.completed",
  ENRICHMENT_FAILED: "risk.enrichment.recalculation.failed",

  OWNERSHIP_COMPLETED: "risk.ownership.recalculation.completed",
  OWNERSHIP_FAILED: "risk.ownership.recalculation.failed",
});

// Closed failure vocabulary. A caught exception's message NEVER leaves this
// module — only one of these codes does.
const RISK_FAILURE_CODE = Object.freeze({
  FINDING_NOT_FOUND: "FINDING_NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  PERSISTENCE_ERROR: "PERSISTENCE_ERROR",
});

// Hard ceiling on how many findings one automatic trigger may rescore. A
// trigger that would exceed it processes the bound and reports the remainder
// as skipped rather than silently truncating.
const MAX_FINDINGS_PER_TRIGGER = 100;

function classifyFailure(error) {
  if (!error || typeof error !== "object") return RISK_FAILURE_CODE.PERSISTENCE_ERROR;
  if (error.name === "RiskFindingNotFoundError") return RISK_FAILURE_CODE.FINDING_NOT_FOUND;
  if (error.name === "RiskScoringValidationError" || error.name === "RiskInputValidationError") {
    return RISK_FAILURE_CODE.VALIDATION_ERROR;
  }
  return RISK_FAILURE_CODE.PERSISTENCE_ERROR;
}

// Never throws, even if the audit write itself fails: audit is observability,
// and losing it must not corrupt or roll back durable scoring.
async function audit(event, options) {
  try {
    await safeLogAuditEvent(event, options);
  } catch (_error) {
    // safeLogAuditEvent already swallows and logs; this is belt-and-braces so
    // no audit path can ever propagate into a scoring caller.
  }
}

/**
 * Rescore exactly one Finding, safely.
 *
 * Returns a closed result object; never throws. Emits exactly one audit event.
 */
async function recalculateFindingRisk(params = {}) {
  const {
    findingId,
    asOf,
    trigger,
    client,
    actorUserId = null,
    justification = null,
    auditContext = {},
    auditActions = null,
    emitAudit = true,
  } = params;

  const actions = auditActions || {
    completed: AUDIT_ACTIONS.COMPLETED,
    unchanged: AUDIT_ACTIONS.UNCHANGED,
    failed: AUDIT_ACTIONS.FAILED,
  };

  try {
    const result = await calculateAndPersistRisk({
      findingId,
      asOf,
      trigger,
      actorUserId,
      justification,
      client,
    });

    if (emitAudit) {
      const unchanged = result.outcome === RISK_CALCULATION_OUTCOME.UNCHANGED;
      await audit(
        {
          ...auditContext,
          action: unchanged ? actions.unchanged : actions.completed,
          outcome: AUDIT_OUTCOMES.SUCCESS,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: findingId,
          after: {
            trigger,
            outcome: result.outcome,
            scoreBasisPoints: result.riskScore ? result.riskScore.scoreBasisPoints : null,
            riskBand: result.riskScore ? result.riskScore.riskBand : null,
            algorithmVersion: result.calculation.algorithmVersion,
            configurationVersion: result.calculation.configurationVersion,
          },
        },
        { client }
      );
    }

    return {
      ok: true,
      findingId,
      outcome: result.outcome,
      riskScore: result.riskScore,
      contributions: result.contributions,
    };
  } catch (error) {
    const failureCode = classifyFailure(error);

    if (emitAudit) {
      await audit(
        {
          ...auditContext,
          action: actions.failed,
          outcome: AUDIT_OUTCOMES.FAILURE,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: findingId,
          // failureCode only — never error.message, never a stack.
          after: { trigger, failureCode },
        },
        { client }
      );
    }

    return { ok: false, findingId, outcome: null, failureCode, riskScore: null, contributions: [] };
  }
}

/**
 * Rescore a bounded set of Findings sequentially, emitting ONE aggregate audit
 * event for the whole operation rather than one per finding.
 *
 * Sequential by design: this runs on a request or ingestion path, and parallel
 * scoring would multiply transaction conflicts on the same rows for no gain.
 */
async function recalculateFindingRiskBatch(params = {}) {
  const {
    findingIds,
    asOf,
    trigger,
    client,
    auditContext = {},
    completedAction,
    failedAction,
    entityType = AUDIT_BATCH_ENTITY_TYPE,
    entityId = null,
    maxFindings = MAX_FINDINGS_PER_TRIGGER,
  } = params;

  const unique = Array.isArray(findingIds)
    ? [...new Set(findingIds.filter((id) => Number.isInteger(id) && id > 0))]
    : [];
  unique.sort((a, b) => a - b);

  const selected = unique.slice(0, maxFindings);
  const skippedCount = unique.length - selected.length;

  const summary = {
    requestedCount: unique.length,
    processedCount: 0,
    createdCount: 0,
    unchangedCount: 0,
    failedCount: 0,
    skippedCount,
  };

  for (const findingId of selected) {
    // eslint-disable-next-line no-await-in-loop
    const result = await recalculateFindingRisk({
      findingId,
      asOf,
      trigger,
      client,
      // Per-finding audit is suppressed: the aggregate event below is the one
      // record for this operation, which is what stops an audit flood.
      emitAudit: false,
    });
    summary.processedCount += 1;
    if (!result.ok) summary.failedCount += 1;
    else if (result.outcome === RISK_CALCULATION_OUTCOME.UNCHANGED) summary.unchangedCount += 1;
    else summary.createdCount += 1;
  }

  const anyFailure = summary.failedCount > 0;
  await audit(
    {
      ...auditContext,
      action: anyFailure
        ? failedAction || AUDIT_ACTIONS.FAILED
        : completedAction || AUDIT_ACTIONS.COMPLETED,
      outcome: anyFailure ? AUDIT_OUTCOMES.FAILURE : AUDIT_OUTCOMES.SUCCESS,
      entityType,
      entityId,
      // Counts and the trigger only. Deliberately no indicator, no finding id
      // list, no score detail — an aggregate event must not become a way to
      // enumerate victim addresses.
      after: { trigger, ...summary },
    },
    { client }
  );

  return summary;
}

/**
 * Ingestion boundary. Called after the Phase 1 evidence transaction has
 * committed and after ownership/enrichment scheduling, never inside them.
 */
async function recalculateAfterIngestion(params = {}) {
  return recalculateFindingRiskBatch({
    ...params,
    trigger: RISK_TRIGGERS.INGESTION,
    completedAction: AUDIT_ACTIONS.INGESTION_COMPLETED,
    failedAction: AUDIT_ACTIONS.INGESTION_FAILED,
    entityType: "RawReport",
    entityId: params.rawReportId || null,
  });
}

/**
 * Enrichment boundary. Called after terminal enrichment results are durably
 * committed, never inside the provider call or the completion transaction.
 */
async function recalculateAfterEnrichment(params = {}) {
  return recalculateFindingRiskBatch({
    ...params,
    trigger: RISK_TRIGGERS.ENRICHMENT_COMPLETED,
    completedAction: AUDIT_ACTIONS.ENRICHMENT_COMPLETED,
    failedAction: AUDIT_ACTIONS.ENRICHMENT_FAILED,
    entityType: AUDIT_BATCH_ENTITY_TYPE,
  });
}

/**
 * Ownership boundary. Called after an override apply/clear has committed.
 * Ownership contributes no basis points, but it can change whether
 * sectorCriticality is applicable at all, so a rescore is genuinely warranted.
 */
async function recalculateAfterOwnershipChange(params = {}) {
  return recalculateFindingRisk({
    ...params,
    trigger: RISK_TRIGGERS.OWNERSHIP_CHANGED,
    auditActions: {
      completed: AUDIT_ACTIONS.OWNERSHIP_COMPLETED,
      unchanged: AUDIT_ACTIONS.OWNERSHIP_COMPLETED,
      failed: AUDIT_ACTIONS.OWNERSHIP_FAILED,
    },
  });
}

module.exports = {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPE,
  AUDIT_BATCH_ENTITY_TYPE,
  RISK_FAILURE_CODE,
  MAX_FINDINGS_PER_TRIGGER,
  classifyFailure,
  recalculateFindingRisk,
  recalculateFindingRiskBatch,
  recalculateAfterIngestion,
  recalculateAfterEnrichment,
  recalculateAfterOwnershipChange,
};
