"use strict";

// ===========================================================================
// Phase 2 closing packet — bounded ownership re-resolution after an
// AssetMapping mutation.
//
// A mapping mutation changes what the resolver WOULD decide for some Findings.
// Before this module, nothing re-decided them: assetMappingService committed
// the mapping and stopped, so ownership silently went stale until something
// else happened to re-resolve that Finding. This closes that gap.
//
// THE FIVE RULES THIS MODULE IS BUILT AROUND
// ------------------------------------------
// 1. THE MAPPING MUTATION IS ALREADY COMMITTED. Everything here runs strictly
//    after it. Nothing in this file may throw into the mutation path — a
//    re-resolution failure must never roll back the mapping the analyst just
//    made. Callers get a summary object, never an exception.
//
// 2. BOUNDED, NEVER A DAEMON. One call processes at most one configured batch
//    and then reports `truncated` + `nextAfterId` so an ADMIN can continue
//    explicitly. There is no worker, no cron, no self-rescheduling loop.
//
// 3. ONE FINDING'S FAILURE IS ITS OWN. Each Finding is resolved in its own
//    transaction (resolveOneFinding); a failure increments failedCount and the
//    loop continues. No batch-wide rollback.
//
// 4. OWNERSHIP FIRST, RISK AFTER. Risk is recalculated only for Findings whose
//    ownership actually changed, and only once every ownership row is durably
//    committed. A risk failure cannot roll back ownership history.
//
// 5. EXPLICIT OVERRIDES ARE NOT TOUCHED. resolveOneFinding re-feeds an
//    existing OVERRIDDEN row back into the resolver as `currentOverride`, so
//    the decision comes back OVERRIDDEN and identical, which the
//    effective-fields comparison then classifies as UNCHANGED — no new row, no
//    audit, no risk churn. Automatic re-resolution can never silently discard
//    an analyst's explicit attribution.
//
// AUDIT DISCIPLINE
// ----------------
// Per-Finding ownership audit events are SUPPRESSED inside a batch (the same
// `emitAudit: false` discipline riskRecalculationService already uses for its
// own batches) and replaced by one aggregate event carrying counts only.
// Aggregate events never carry an indicator, a candidate list, a cursor value
// or an error message — an audit row must not become a way to enumerate victim
// addresses.
// ===========================================================================

const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");
const {
  selectCandidateFindingIdPage,
  mappingCanAcquireNewFindings,
} = require("./ownershipCandidateSelection");
const { OWNERSHIP_RESOLUTION_STATUS } = require("./ownershipResolver");

const RE_RESOLUTION_AUDIT_ACTIONS = Object.freeze({
  REQUESTED: "ownership.mapping.reresolution.requested",
  COMPLETED: "ownership.mapping.reresolution.completed",
  PARTIAL: "ownership.mapping.reresolution.partial",
  FAILED: "ownership.mapping.reresolution.failed",
});

const AUDIT_ENTITY_TYPE = "AssetMapping";

// Safe bounds. A caller may tune the batch size but never past MAX — an
// unbounded batch on an HTTP request path is the thing this packet exists to
// prevent.
const DEFAULT_BATCH_SIZE = 100;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 500;

// Closed failure vocabulary. A caught exception's message, Prisma code and
// stack NEVER leave this module.
const RE_RESOLUTION_FAILURE_CODE = Object.freeze({
  CANDIDATE_SELECTION_FAILED: "CANDIDATE_SELECTION_FAILED",
  RESOLUTION_FAILED: "RESOLUTION_FAILED",
  UNEXPECTED: "UNEXPECTED",
});

/**
 * Clamps a caller-supplied batch size into [MIN, MAX], falling back to the
 * default for anything non-integer. Never throws — an ADMIN typo degrades to
 * the safe default rather than failing the mutation that triggered this.
 */
function normalizeBatchSize(value) {
  if (!Number.isInteger(value)) return DEFAULT_BATCH_SIZE;
  if (value < MIN_BATCH_SIZE) return MIN_BATCH_SIZE;
  if (value > MAX_BATCH_SIZE) return MAX_BATCH_SIZE;
  return value;
}

function emptySummary(mapping, batchSize) {
  return {
    mappingId: mapping ? mapping.id : null,
    mappingType: mapping ? mapping.mappingType : null,
    batchSize,
    candidateCount: 0,
    processedCount: 0,
    changedCount: 0,
    unchangedCount: 0,
    ambiguousCount: 0,
    unresolvedCount: 0,
    overriddenPreservedCount: 0,
    failedCount: 0,
    riskChangedCount: 0,
    riskUnchangedCount: 0,
    riskFailedCount: 0,
    truncated: false,
    nextAfterId: null,
    // True when this mapping type can only RELEASE Findings it previously
    // attributed, never acquire new ones (ASN — Finding stores no ASN).
    acquisitionLimited: false,
    failureCode: null,
  };
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...auditContext, ...event }, { client });
  } catch (error) {
    // Rule: audit failure must not roll back mapping, ownership or risk state.
    console.error("Ownership re-resolution audit failed", { name: error && error.name });
  }
}

/**
 * Re-resolves ownership for one bounded batch of Findings affected by a
 * mapping mutation.
 *
 * @param {object} mapping  The COMMITTED AssetMapping row (post-mutation).
 * @param {object} options
 *   client       Prisma client (or transaction-free client). Required in tests.
 *   asOf         Captured ONCE by the caller and used for every Finding in the
 *                batch, so one batch is one consistent point in time.
 *   batchSize    Bounded by normalizeBatchSize.
 *   afterId      Keyset cursor — continue after this Finding id.
 *   auditContext Existing audit actor context.
 *   emitAudit    False to suppress the aggregate event (the mapping mutation
 *                path emits its own combined event instead).
 * @returns {Promise<object>} summary — never throws.
 */
async function reResolveForMapping(mapping, options = {}) {
  const batchSize = normalizeBatchSize(options.batchSize);
  const summary = emptySummary(mapping, batchSize);

  if (!mapping || !Number.isInteger(mapping.id)) {
    summary.failureCode = RE_RESOLUTION_FAILURE_CODE.UNEXPECTED;
    return summary;
  }

  const client = options.client;
  const auditContext = options.auditContext || {};
  const emitAudit = options.emitAudit !== false;
  // asOf is captured by the caller, once, for the whole batch. This module
  // never reads the wall clock itself.
  const asOf = options.asOf instanceof Date ? options.asOf : new Date();
  const afterId = Number.isInteger(options.afterId) && options.afterId > 0 ? options.afterId : 0;

  summary.acquisitionLimited = !mappingCanAcquireNewFindings(mapping);

  if (emitAudit) {
    await audit(client, auditContext, {
      action: RE_RESOLUTION_AUDIT_ACTIONS.REQUESTED,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: AUDIT_ENTITY_TYPE,
      entityId: mapping.id,
      after: { mappingType: mapping.mappingType, batchSize },
      reason: "Bounded ownership re-resolution requested after a mapping mutation",
    });
  }

  let page;
  try {
    page = await selectCandidateFindingIdPage(client, mapping, { afterId, take: batchSize });
  } catch (error) {
    summary.failureCode = RE_RESOLUTION_FAILURE_CODE.CANDIDATE_SELECTION_FAILED;
    console.error("Ownership re-resolution candidate selection failed", {
      name: error && error.name,
    });
    if (emitAudit) {
      await audit(client, auditContext, {
        action: RE_RESOLUTION_AUDIT_ACTIONS.FAILED,
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: mapping.id,
        after: { mappingType: mapping.mappingType, failureCode: summary.failureCode },
        reason: "Ownership re-resolution could not select candidates",
      });
    }
    return summary;
  }

  summary.candidateCount = page.findingIds.length;
  summary.truncated = page.hasMore === true;
  summary.nextAfterId = page.hasMore === true ? page.nextAfterId : null;

  // Lazily required: findingOwnershipService requires this module's siblings,
  // and the mapping mutation path requires both. Requiring at call time keeps
  // the dependency one-directional at load time.
  // eslint-disable-next-line global-require
  const { resolveOneFinding } = require("./findingOwnershipService");

  const changedFindingIds = [];

  // Sequential by design, exactly as reResolveFindingsForMapping was: these
  // Findings share one mapping, and resolving them concurrently against each
  // other only multiplies SERIALIZABLE transaction conflicts for no gain.
  for (const findingId of page.findingIds) {
    try {
      // emitAudit:false — the aggregate event below is the record for this
      // operation. Per-Finding events here would be an audit flood.
      // eslint-disable-next-line no-await-in-loop
      const outcome = await resolveOneFinding(findingId, {
        client,
        asOf,
        auditContext,
        emitAudit: false,
      });
      summary.processedCount += 1;

      const status = outcome.current ? outcome.current.status : null;
      if (status === OWNERSHIP_RESOLUTION_STATUS.AMBIGUOUS) summary.ambiguousCount += 1;
      if (status === OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED) summary.unresolvedCount += 1;
      if (status === OWNERSHIP_RESOLUTION_STATUS.OVERRIDDEN) summary.overriddenPreservedCount += 1;

      if (outcome.changed) {
        summary.changedCount += 1;
        changedFindingIds.push(findingId);
      } else {
        summary.unchangedCount += 1;
      }
    } catch (error) {
      // Rule 3: one Finding's failure is its own.
      summary.processedCount += 1;
      summary.failedCount += 1;
      console.error("Ownership re-resolution failed for one finding", {
        name: error && error.name,
      });
    }
  }

  // Rule 4: risk runs only after every ownership row above has committed, and
  // only for Findings whose ownership actually changed. recalculateFindingRiskBatch
  // emits its own single aggregate risk audit event — this module deliberately
  // does not duplicate it.
  if (changedFindingIds.length > 0) {
    try {
      // eslint-disable-next-line global-require
      const {
        recalculateFindingRiskBatch,
        AUDIT_ACTIONS: RISK_AUDIT_ACTIONS,
      } = require("../risk/riskRecalculationService");
      // eslint-disable-next-line global-require
      const { RISK_TRIGGERS } = require("../risk/riskScoringService");

      const riskSummary = await recalculateFindingRiskBatch({
        findingIds: changedFindingIds,
        asOf,
        trigger: RISK_TRIGGERS.OWNERSHIP_CHANGED,
        client,
        auditContext,
        completedAction: RISK_AUDIT_ACTIONS.OWNERSHIP_COMPLETED,
        failedAction: RISK_AUDIT_ACTIONS.OWNERSHIP_FAILED,
        entityId: mapping.id,
        maxFindings: batchSize,
      });

      summary.riskChangedCount = riskSummary.createdCount;
      summary.riskUnchangedCount = riskSummary.unchangedCount;
      summary.riskFailedCount = riskSummary.failedCount;
    } catch (error) {
      // Rule 4: a risk failure must not roll back ownership history, and must
      // not fail the mapping mutation either.
      summary.riskFailedCount = changedFindingIds.length;
      console.error("Ownership re-resolution risk recalculation failed", {
        name: error && error.name,
      });
    }
  }

  if (emitAudit) {
    const partial = summary.truncated || summary.failedCount > 0;
    await audit(client, auditContext, {
      action: partial
        ? RE_RESOLUTION_AUDIT_ACTIONS.PARTIAL
        : RE_RESOLUTION_AUDIT_ACTIONS.COMPLETED,
      outcome: summary.failedCount > 0 ? AUDIT_OUTCOMES.FAILURE : AUDIT_OUTCOMES.SUCCESS,
      entityType: AUDIT_ENTITY_TYPE,
      entityId: mapping.id,
      after: reResolutionAuditSummary(summary),
      reason: partial
        ? "Bounded ownership re-resolution completed one batch; more candidates remain or some failed"
        : "Bounded ownership re-resolution completed",
    });
  }

  return summary;
}

/**
 * Safe aggregate audit payload: counts, the mapping id and closed flags only.
 *
 * Deliberately EXCLUDES nextAfterId — a cursor is an internal pagination value
 * and, being a Finding id, is exactly the kind of row pointer the packet says
 * aggregate events must not carry. Also excludes every candidate indicator.
 */
function reResolutionAuditSummary(summary) {
  return {
    mappingId: summary.mappingId,
    mappingType: summary.mappingType,
    candidateCount: summary.candidateCount,
    processedCount: summary.processedCount,
    changedCount: summary.changedCount,
    unchangedCount: summary.unchangedCount,
    ambiguousCount: summary.ambiguousCount,
    unresolvedCount: summary.unresolvedCount,
    overriddenPreservedCount: summary.overriddenPreservedCount,
    failedCount: summary.failedCount,
    riskChangedCount: summary.riskChangedCount,
    riskUnchangedCount: summary.riskUnchangedCount,
    riskFailedCount: summary.riskFailedCount,
    truncated: summary.truncated,
    acquisitionLimited: summary.acquisitionLimited,
    failureCode: summary.failureCode,
  };
}

module.exports = {
  RE_RESOLUTION_AUDIT_ACTIONS,
  RE_RESOLUTION_FAILURE_CODE,
  DEFAULT_BATCH_SIZE,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  normalizeBatchSize,
  reResolveForMapping,
  reResolutionAuditSummary,
};
