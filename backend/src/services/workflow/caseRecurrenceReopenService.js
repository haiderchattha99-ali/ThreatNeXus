"use strict";

// Recurrence-driven case reopening (Phase 3).
//
// ---------------------------------------------------------------------------
// Runs AFTER recurrence has committed, never inside the ingestion transaction
// ---------------------------------------------------------------------------
// dedupService classifies an observation as RECURRED inside its own
// SERIALIZABLE transaction and commits. Only then does the ingestion pipeline
// call into this module, exactly like resolveOwnershipSafely /
// scheduleEnrichmentSafely / recalculateAfterIngestion before it. The isolation
// contract is identical and non-negotiable:
//
//   - every RawReport / RawReportRow / Finding / FindingOccurrence write has
//     already committed before this module is reached
//   - nothing here ever throws into ingestion (processRecurrenceReopensSafely
//     catches everything and classifies it into closed outcome codes)
//   - a total reopen failure therefore leaves a fully valid ingested report
//     with fully valid recurrence evidence and simply no reopen — never a
//     rolled-back or partially-invalidated one
//
// Reopening a case is a consequence of recurrence, not part of the evidence
// that recurrence happened. Letting it participate in the ingestion
// transaction would mean a case-table conflict could roll back the observation
// record itself.
//
// ---------------------------------------------------------------------------
// Idempotency is a database invariant, not a code convention
// ---------------------------------------------------------------------------
// Exactly one CaseRecurrenceReopen row may exist per (findingOccurrenceId,
// caseId) — a composite unique. Every evaluation writes one, INCLUDING the
// ones that decide not to reopen, so re-processing the same occurrence is a
// no-op regardless of what the first pass decided. A P2002 on that constraint
// is a concurrent duplicate and is resolved by re-running the whole
// transaction (never caught inside it — see workflowTransaction.js).
//
// ---------------------------------------------------------------------------
// Only a REMEDIATED closure reopens automatically
// ---------------------------------------------------------------------------
// FALSE_POSITIVE, ACCEPTED_RISK, DUPLICATE and OTHER closures were all decided
// in full knowledge that the finding would keep being observed. Reopening them
// on the next report would silently overturn a human decision on a schedule,
// and would train analysts to ignore reopened cases.

const {
  CASE_STATES,
  LIFECYCLE_EVENT_TYPES,
  LIFECYCLE_REASON_CODES,
  RECURRENCE_REOPEN_OUTCOMES,
  REOPEN_TRIGGERS,
  TRIAGE_SOURCES,
  assertPositiveInteger,
  assertValidDate,
  qualifiesForRecurrenceReopen,
} = require("./caseWorkflowRules");

const { runSerializable } = require("./workflowTransaction");
const { applyGuardedTransition } = require("./caseLifecycleService");
const { listCurrentLinksForFinding } = require("./caseFindingLinkService");
const { appendWorkflowEscalation } = require("./findingTriageService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const RECURRENCE_ENTITY_TYPE = "CaseRecurrenceReopen";

// Closed per-pair outcome vocabulary. ALREADY_PROCESSED is a runner-level
// outcome, not a stored one: the stored row records what the FIRST pass
// decided, and re-running must not overwrite that with "already processed".
const PAIR_OUTCOME = Object.freeze({
  REOPENED: "REOPENED",
  SKIPPED_NOT_CLOSED: "SKIPPED_NOT_CLOSED",
  SKIPPED_CLOSURE_REASON_NOT_REMEDIATED: "SKIPPED_CLOSURE_REASON_NOT_REMEDIATED",
  ALREADY_PROCESSED: "ALREADY_PROCESSED",
  FAILED: "FAILED",
});

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("Case recurrence reopen audit failed", { name: error && error.name });
  }
}

/**
 * Aggregate audit payload for a whole ingestion's worth of recurrence
 * processing.
 *
 * Counts ONLY. No indicator value, no Finding id, no occurrence id, no case
 * reference. A report can carry hundreds of recurrences, and an event that
 * enumerated their addresses would put a victim IP list into AuditLog on every
 * ingestion — the Phase 3 brief forbids exactly this. Per-case reopens are
 * separately audited as case-level events (entityId = caseId), which carry no
 * indicator either.
 *
 * Every count is derived from the results array itself rather than tracked
 * alongside it, so the summary cannot drift from what actually happened.
 */
function recurrenceReopenSummary(results) {
  const tally = (outcome) => results.filter((r) => r.outcome === outcome).length;
  return {
    evaluatedPairCount: results.length,
    reopenedCaseCount: tally(PAIR_OUTCOME.REOPENED),
    skippedNotClosedCount: tally(PAIR_OUTCOME.SKIPPED_NOT_CLOSED),
    skippedClosureReasonCount: tally(PAIR_OUTCOME.SKIPPED_CLOSURE_REASON_NOT_REMEDIATED),
    alreadyProcessedCount: tally(PAIR_OUTCOME.ALREADY_PROCESSED),
    failedCount: tally(PAIR_OUTCOME.FAILED),
    escalatedTriageCount: results.filter((r) => r.escalated === true).length,
  };
}

/**
 * Evaluates ONE (recurrence occurrence, case) pair and, when it qualifies,
 * reopens the case.
 *
 * The ledger row, the case transition, the lifecycle event and the ESCALATED
 * triage append all happen in ONE transaction: a case shown as reopened with
 * no ledger row would be re-processed forever, and a ledger row with no reopen
 * would permanently suppress a legitimate one.
 *
 * @returns {Promise<{outcome:string, caseId:number, escalated:boolean}>}
 */
async function processPair(client, input) {
  const { caseId, findingId, findingOccurrenceId, observedAt, processedAt, auditContext } = input;

  const result = await runSerializable(client, async (tx) => {
    // Idempotency probe inside the transaction. A concurrent duplicate that
    // slips past this read still cannot insert: the composite unique rejects
    // it with P2002, which escapes to runSerializable and re-runs the whole
    // transaction, at which point this read sees the committed row.
    const existing = await tx.caseRecurrenceReopen.findUnique({
      where: { findingOccurrenceId_caseId: { findingOccurrenceId, caseId } },
    });
    if (existing) {
      return { outcome: PAIR_OUTCOME.ALREADY_PROCESSED, caseId, escalated: false };
    }

    const caseRecord = await tx.case.findUnique({ where: { id: caseId } });
    if (!caseRecord) {
      // A link pointing at a nonexistent case cannot happen (Restrict FK), so
      // this is a defensive branch rather than a real path. Recording nothing
      // is correct: there is no case to reopen and no decision to remember.
      return { outcome: PAIR_OUTCOME.SKIPPED_NOT_CLOSED, caseId, escalated: false };
    }

    // Two independent reasons to decline, kept distinct so the ledger says
    // WHICH rule applied rather than a single collapsed "skipped".
    if (caseRecord.lifecycleState !== CASE_STATES.CLOSED) {
      await tx.caseRecurrenceReopen.create({
        data: {
          caseId,
          findingId,
          findingOccurrenceId,
          outcome: RECURRENCE_REOPEN_OUTCOMES.SKIPPED_NOT_CLOSED,
          observedAt,
          processedAt,
        },
      });
      return { outcome: PAIR_OUTCOME.SKIPPED_NOT_CLOSED, caseId, escalated: false };
    }

    if (!qualifiesForRecurrenceReopen(caseRecord)) {
      await tx.caseRecurrenceReopen.create({
        data: {
          caseId,
          findingId,
          findingOccurrenceId,
          outcome: RECURRENCE_REOPEN_OUTCOMES.SKIPPED_CLOSURE_REASON_NOT_REMEDIATED,
          observedAt,
          processedAt,
        },
      });
      return {
        outcome: PAIR_OUTCOME.SKIPPED_CLOSURE_REASON_NOT_REMEDIATED,
        caseId,
        escalated: false,
      };
    }

    await applyGuardedTransition(tx, {
      caseId,
      fromState: CASE_STATES.CLOSED,
      toState: CASE_STATES.OPEN,
      eventType: LIFECYCLE_EVENT_TYPES.REOPENED,
      reasonCode: LIFECYCLE_REASON_CODES.REOPENED_BY_RECURRENCE,
      note: null,
      // No actor: this is a system consequence of new evidence, not a person's
      // decision. Attributing it to the uploading analyst would misrepresent
      // who decided to reopen.
      actorUserId: null,
      occurredAt: processedAt,
      caseData: {
        closedAt: null,
        closureReason: null,
        closedByUserId: null,
        lastReopenedAt: processedAt,
        lastReopenTrigger: REOPEN_TRIGGERS.RECURRENCE,
        reopenedCount: { increment: 1 },
      },
    });

    const escalation = await appendWorkflowEscalation(tx, {
      findingId,
      source: TRIAGE_SOURCES.RECURRENCE_REOPEN,
      caseId,
      actorUserId: null,
      decidedAt: processedAt,
    });

    await tx.caseRecurrenceReopen.create({
      data: {
        caseId,
        findingId,
        findingOccurrenceId,
        outcome: RECURRENCE_REOPEN_OUTCOMES.REOPENED,
        observedAt,
        processedAt,
      },
    });

    return { outcome: PAIR_OUTCOME.REOPENED, caseId, escalated: escalation.changed };
  });

  if (result.outcome === PAIR_OUTCOME.REOPENED) {
    // Case-level event, no indicator value. Emitted per reopened case (a
    // genuinely analyst-visible lifecycle change) rather than per evaluated
    // pair, matching the ingestion pipeline's own finding.reopened convention.
    await audit(client, auditContext, {
      action: "case.reopened",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: "Case",
      entityId: caseId,
      before: { lifecycleState: CASE_STATES.CLOSED, closureReason: "REMEDIATED" },
      after: {
        lifecycleState: CASE_STATES.OPEN,
        lastReopenTrigger: REOPEN_TRIGGERS.RECURRENCE,
        escalatedTriage: result.escalated,
      },
      reason: "Case reopened automatically by a recurrence of remediated evidence",
    });
  }

  return result;
}

/**
 * Processes every recurrence in one ingestion.
 *
 * NEVER throws. Every failure — a single pair's transaction, the audit write,
 * or an unexpected error in the loop itself — is caught, classified into the
 * closed PAIR_OUTCOME vocabulary and reported in the aggregate. Ingestion and
 * the recurrence evidence it already committed are unaffected in every case.
 *
 * @param {object} client
 * @param {Array<{findingId:number, findingOccurrenceId:number, observedAt:Date}>} recurrences
 * @param {{processedAt:Date, auditContext?:object}} options
 * @returns {Promise<{summary:object, results:Array}>}
 */
async function processRecurrenceReopensSafely(client, recurrences, options = {}) {
  const results = [];
  const processedAt = options.processedAt;
  const auditContext = options.auditContext;

  try {
    assertValidDate(processedAt, "processedAt");

    // eslint-disable-next-line no-restricted-syntax
    for (const recurrence of Array.isArray(recurrences) ? recurrences : []) {
      let links = [];
      try {
        assertPositiveInteger(recurrence.findingId, "findingId");
        assertPositiveInteger(recurrence.findingOccurrenceId, "findingOccurrenceId");
        assertValidDate(recurrence.observedAt, "observedAt");
        // eslint-disable-next-line no-await-in-loop
        links = await listCurrentLinksForFinding(client, recurrence.findingId);
      } catch (error) {
        console.error("Recurrence reopen candidate listing failed", {
          name: error && error.name,
        });
        results.push({ outcome: PAIR_OUTCOME.FAILED, caseId: null, escalated: false });
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const link of links) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const pairResult = await processPair(client, {
            caseId: link.caseId,
            findingId: recurrence.findingId,
            findingOccurrenceId: recurrence.findingOccurrenceId,
            observedAt: recurrence.observedAt,
            processedAt,
            auditContext,
          });
          results.push(pairResult);
        } catch (error) {
          // Name only. err.message / stack are never copied into a result, a
          // log payload, or the audit trail.
          console.error("Recurrence reopen failed for one case", { name: error && error.name });
          results.push({ outcome: PAIR_OUTCOME.FAILED, caseId: link.caseId, escalated: false });
        }
      }
    }
  } catch (error) {
    console.error("Recurrence reopen processing failed", { name: error && error.name });
    const summary = recurrenceReopenSummary(results);
    await audit(client, auditContext, {
      action: "case.recurrence.reopen.failed",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: RECURRENCE_ENTITY_TYPE,
      after: summary,
      reason: "Recurrence-driven case reopening could not be completed",
    });
    return { summary, results };
  }

  const summary = recurrenceReopenSummary(results);

  if (summary.failedCount > 0) {
    await audit(client, auditContext, {
      action: "case.recurrence.reopen.failed",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: RECURRENCE_ENTITY_TYPE,
      after: summary,
      reason: "One or more recurrence-driven case reopens failed",
    });
  }

  await audit(client, auditContext, {
    action: "case.recurrence.reopen.completed",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: RECURRENCE_ENTITY_TYPE,
    after: summary,
    reason: "Recurrence-driven case reopening evaluated for report findings",
  });

  return { summary, results };
}

module.exports = {
  RECURRENCE_ENTITY_TYPE,
  PAIR_OUTCOME,
  recurrenceReopenSummary,
  processPair,
  processRecurrenceReopensSafely,
};
