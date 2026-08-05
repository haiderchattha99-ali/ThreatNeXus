"use strict";

// Human review of AI mapping suggestions, and promotion of an approved one
// into an ACTIVE framework mapping (Phase 5).
//
// ===========================================================================
// AI never writes an active mapping. This module is why.
// ===========================================================================
// There is no code path anywhere in this repository by which a provider result
// becomes a CaseFrameworkMapping. Generation writes PENDING suggestions and
// stops. The ONLY transition from "a model proposed this" to "this case is
// mapped to that control" runs through approveSuggestion below, which:
//
//   1. requires an authenticated human holding decide:ai-mapping-suggestions
//   2. reloads the case and rebuilds the bounded evidence snapshot FROM SCRATCH
//   3. recomputes the fingerprint and REFUSES if it differs from the one the
//      suggestion was generated against (the staleness guard)
//   4. re-validates the suggestion content through the same rules a hand-typed
//      mapping clears, including the ATT&CK evidence rule
//   5. writes the mapping by calling frameworkMappingService's OWN writer —
//      not a copy of it, not a similar one, the same function
//   6. records the human as the mapping's actor, and the source as
//      AI_SUGGESTION_PROMOTED
//   7. links the resulting mapping to the suggestion, in the SAME transaction
//
// Steps 5 and 7 sharing one transaction is what makes a repeated approval
// unable to create a second mapping: the suggestion's promotedMappingId is
// @unique and its state guard is re-read inside that transaction.
//
// ===========================================================================
// Staleness is a refusal, never a silent re-derivation
// ===========================================================================
// If the case gained a Finding, lost one, was retriaged, rescored, had a CVE
// asserted, or had another mapping added since the suggestion was produced,
// the fingerprint changes and approval is REFUSED with SUGGESTION_STALE. The
// system does not quietly regenerate, does not approve "close enough", and does
// not update the suggestion in place — it tells the analyst to request fresh
// suggestions against the case as it now stands. Approving a proposal derived
// from evidence that no longer exists is precisely the automation-bias failure
// this phase is meant to prevent.
//
// ===========================================================================
// Repeated decisions are safe and recorded
// ===========================================================================
// Deciding an already-decided suggestion returns ALREADY_DECIDED_UNCHANGED,
// writes no mapping, does not overwrite the original decision, and still
// appends an AiSuggestionDecision row — so "somebody clicked approve four
// times" stays visible without four mappings existing.

const {
  DECISION_OUTCOME_CODES,
  DECISION_REFUSAL_CODES,
  AiSuggestionNotFoundError,
  AiSuggestionStateError,
  AiSuggestionValidationError,
  normalizeDecisionReason,
} = require("./aiSuggestionRules");

const { buildCaseEvidenceSnapshot } = require("./caseEvidenceSnapshot");
const { runSerializable } = require("../workflow/workflowTransaction");
const { loadCaseOrThrow, assertOrganizationBound } = require("../workflow/caseLifecycleService");
const {
  MAPPING_SOURCES,
  FrameworkMappingValidationError,
  assertPositiveInteger,
  assertValidDate,
} = require("../framework/frameworkMappingRules");
const {
  MAPPING_OUTCOMES,
  appendMappingWithinTransaction,
  mappingSummary,
} = require("../framework/frameworkMappingService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const SUGGESTION_ENTITY_TYPE = "AiFrameworkMappingSuggestion";

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("AI suggestion decision audit failed", { name: error && error.name });
  }
}

// Allow-listed audit payload. Ids, framework identifiers, closed codes and
// LENGTHS. Deliberately no rationale text and no rejection-reason text: the
// complete reason lives on the row an authorized reader can fetch, not in a
// table read far more widely.
function suggestionSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.runId,
    caseId: row.caseId,
    framework: row.framework,
    frameworkVersion: row.frameworkVersion,
    referenceId: row.referenceId,
    mappingScope: row.mappingScope,
    evidenceBasis: row.evidenceBasis,
    state: row.state,
    evidenceFindingId: row.evidenceFindingId === undefined ? null : row.evidenceFindingId,
    promotedMappingId: row.promotedMappingId === undefined ? null : row.promotedMappingId,
    rationaleLength: typeof row.rationale === "string" ? row.rationale.length : 0,
    decisionReasonLength:
      typeof row.decisionReason === "string" ? row.decisionReason.length : 0,
  };
}

// Rebuilds the suggestion's stored content in the shape the mapping rules
// expect. Reading it off the row (rather than trusting anything the caller
// sent) is what makes approval a decision about THE stored suggestion and not
// about whatever the client posted alongside the id.
function contentOf(suggestion) {
  return {
    framework: suggestion.framework,
    frameworkVersion: suggestion.frameworkVersion,
    referenceId: suggestion.referenceId,
    referenceTitle: suggestion.referenceTitle,
    mappingScope: suggestion.mappingScope,
    evidenceBasis: suggestion.evidenceBasis,
    rationale: suggestion.rationale,
    evidenceFindingId: suggestion.evidenceFindingId,
    // Phase 6.3. Carried through so promotion re-validates the SAME evidence
    // the reviewer approved, against the live record, inside the promotion
    // transaction.
    //
    // Deliberately NOT re-derived and NOT defaulted. A suggestion row written
    // before Phase 6.3 has nulls here, and appendMappingWithinTransaction will
    // refuse to promote it rather than inventing a quote nobody ever wrote —
    // the reviewer is told to request a fresh suggestion instead. Supplying a
    // placeholder to make old suggestions promotable would fabricate exactly
    // the evidence this phase exists to require.
    evidenceQuote: suggestion.evidenceQuote,
    evidenceQuoteSource: suggestion.evidenceQuoteSource,
    evidenceConfidence: suggestion.evidenceConfidence,
    mappingConfidence: suggestion.mappingConfidence,
  };
}

async function loadSuggestionForCase(client, caseId, suggestionId) {
  const suggestion = await client.aiFrameworkMappingSuggestion.findUnique({
    where: { id: suggestionId },
  });
  if (!suggestion) throw new AiSuggestionNotFoundError("AI suggestion not found");
  if (suggestion.caseId !== caseId) {
    throw new AiSuggestionStateError(
      "AI suggestion does not belong to this case",
      DECISION_REFUSAL_CODES.SUGGESTION_NOT_FOR_CASE
    );
  }
  return suggestion;
}

// Appends the decision ledger row. Always called, including for the
// no-op ALREADY_DECIDED_UNCHANGED path.
async function appendDecision(tx, input) {
  return tx.aiSuggestionDecision.create({
    data: {
      suggestionId: input.suggestionId,
      decision: input.decision,
      outcomeCode: input.outcomeCode,
      reason: input.reason,
      actorUserId: input.actorUserId,
      decidedAt: input.decidedAt,
    },
  });
}

/**
 * Approves one PENDING suggestion and promotes it into an ACTIVE mapping.
 *
 * @param {number} caseId
 * @param {number} suggestionId
 * @param {object} options
 * @param {Date}   options.decidedAt      explicit; never a wall-clock read
 * @param {number|null} options.actorUserId  the HUMAN approving
 * @returns {Promise<{suggestion:object, mapping:object|null, outcome:string,
 *   mappingOutcome:string|null, changed:boolean}>}
 */
async function approveSuggestion(caseId, suggestionId, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  assertPositiveInteger(suggestionId, "suggestionId");
  const decidedAt = assertValidDate(options.decidedAt, "decidedAt");
  // Optional on approval: approving is agreeing with what is already written,
  // and forcing a restatement of it adds nothing. Rejection is different.
  const reason = normalizeDecisionReason(options.reason, { required: false });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const caseRecord = assertOrganizationBound(await loadCaseOrThrow(client, caseId));
  const existing = await loadSuggestionForCase(client, caseRecord.id, suggestionId);

  // Fast path for an already-decided suggestion: recorded, idempotent, and it
  // never touches the mapping table. The authoritative re-check happens again
  // inside the transaction below for the concurrent case.
  if (existing.state !== "PENDING") {
    const outcome = await recordUnchangedDecision(client, {
      suggestion: existing,
      decision: "APPROVE",
      reason,
      actorUserId,
      decidedAt,
    });
    await audit(client, auditContext, {
      action: "ai.mapping.suggestion.approved",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: SUGGESTION_ENTITY_TYPE,
      entityId: existing.id,
      after: { ...suggestionSummary(existing), outcome: outcome.outcome },
      reason: "AI suggestion was already decided; no mapping was created",
    });
    return outcome;
  }

  // ---------------------------------------------------------------------
  // Staleness guard. Rebuilt from the case as it is NOW, not from anything
  // stored with the suggestion.
  // ---------------------------------------------------------------------
  const { fingerprint } = await buildCaseEvidenceSnapshot(client, caseRecord, {});
  if (fingerprint !== existing.inputFingerprint) {
    await audit(client, auditContext, {
      action: "ai.mapping.suggestion.stale",
      outcome: AUDIT_OUTCOMES.DENIED,
      entityType: SUGGESTION_ENTITY_TYPE,
      entityId: existing.id,
      // The fingerprints themselves are NOT audited — they are internal values,
      // and publishing them would let a reader reconstruct which evidence
      // changed without holding read access to the case.
      after: suggestionSummary(existing),
      reason: `AI suggestion approval refused (${DECISION_REFUSAL_CODES.SUGGESTION_STALE})`,
    });
    throw new AiSuggestionStateError(
      "The case evidence has changed since this suggestion was generated",
      DECISION_REFUSAL_CODES.SUGGESTION_STALE
    );
  }

  let result;
  try {
    result = await runSerializable(client, async (tx) => {
      // Re-read under the transaction: two concurrent approvals must not both
      // see PENDING. Under SERIALIZABLE the loser is rejected with P2034 and
      // the whole transaction re-runs, at which point it sees APPROVED and
      // takes the unchanged path.
      const current = await tx.aiFrameworkMappingSuggestion.findUnique({
        where: { id: suggestionId },
      });
      if (!current) throw new AiSuggestionNotFoundError("AI suggestion not found");

      if (current.state !== "PENDING") {
        const decision = await appendDecision(tx, {
          suggestionId: current.id,
          decision: "APPROVE",
          outcomeCode: DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED,
          reason,
          actorUserId,
          decidedAt,
        });
        return {
          suggestion: current,
          mapping: null,
          decision,
          outcome: DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED,
          mappingOutcome: null,
          changed: false,
        };
      }

      // THE shared writer. Re-validates content and re-checks every
      // database-backed evidence obligation against this transaction.
      const promotion = await appendMappingWithinTransaction(tx, {
        caseRecord,
        content: contentOf(current),
        source: MAPPING_SOURCES.AI_SUGGESTION_PROMOTED,
        // The HUMAN. Never a provider, never a system id.
        actorUserId,
        effectiveAt: decidedAt,
      });

      const outcomeCode =
        promotion.outcome === MAPPING_OUTCOMES.UNCHANGED
          ? DECISION_OUTCOME_CODES.APPROVED_MAPPING_UNCHANGED
          : DECISION_OUTCOME_CODES.APPROVED_AND_PROMOTED;

      const suggestion = await tx.aiFrameworkMappingSuggestion.update({
        where: { id: current.id },
        data: {
          state: "APPROVED",
          decidedAt,
          decidedByUserId: actorUserId,
          decisionReason: reason,
          // promotedMappingId is @unique. When the identical mapping was
          // already active (an analyst typed it first), the existing row is
          // linked instead of a new one being forced into existence — unless
          // that row is already claimed by another suggestion, in which case
          // the unique constraint refuses and the whole transaction retries
          // and then fails loudly rather than inventing a second mapping.
          promotedMappingId: promotion.mapping ? promotion.mapping.id : null,
        },
      });

      const decision = await appendDecision(tx, {
        suggestionId: current.id,
        decision: "APPROVE",
        outcomeCode,
        reason,
        actorUserId,
        decidedAt,
      });

      return {
        suggestion,
        mapping: promotion.mapping,
        decision,
        outcome: outcomeCode,
        mappingOutcome: promotion.outcome,
        changed: promotion.changed,
      };
    });
  } catch (error) {
    const code =
      error instanceof AiSuggestionStateError ||
      error instanceof FrameworkMappingValidationError ||
      error instanceof AiSuggestionValidationError
        ? error.code || DECISION_REFUSAL_CODES.SUGGESTION_CONTENT_INVALID
        : null;

    await audit(client, auditContext, {
      action: "ai.mapping.promotion.failed",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: SUGGESTION_ENTITY_TYPE,
      entityId: suggestionId,
      reason: code
        ? `AI suggestion promotion refused (${code})`
        : "AI suggestion promotion could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "ai.mapping.suggestion.approved",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: SUGGESTION_ENTITY_TYPE,
    entityId: result.suggestion.id,
    after: { ...suggestionSummary(result.suggestion), outcome: result.outcome },
    reason: "AI suggestion approved by a human reviewer",
  });

  if (result.changed) {
    await audit(client, auditContext, {
      action: "ai.mapping.promotion.completed",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: "CaseFrameworkMapping",
      entityId: result.mapping.id,
      after: {
        ...mappingSummary(result.mapping),
        promotedFromSuggestionId: result.suggestion.id,
        mappingOutcome: result.mappingOutcome,
      },
      reason: "Approved AI suggestion promoted to an active framework mapping",
    });
  }

  return {
    suggestion: result.suggestion,
    mapping: result.mapping,
    outcome: result.outcome,
    mappingOutcome: result.mappingOutcome,
    changed: result.changed,
  };
}

/**
 * Rejects one PENDING suggestion. Creates NO mapping, ever.
 *
 * A reason is required. Rejected suggestions are RETAINED (never deleted),
 * because the rejection rate and the reasons for it are the only real evidence
 * of whether the gates and the assistant are any good — and because a system
 * that quietly discarded what it refused could not be evaluated at all.
 */
async function rejectSuggestion(caseId, suggestionId, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  assertPositiveInteger(suggestionId, "suggestionId");
  const decidedAt = assertValidDate(options.decidedAt, "decidedAt");
  const reason = normalizeDecisionReason(options.reason, { required: true });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const caseRecord = assertOrganizationBound(await loadCaseOrThrow(client, caseId));
  const existing = await loadSuggestionForCase(client, caseRecord.id, suggestionId);

  if (existing.state !== "PENDING") {
    const outcome = await recordUnchangedDecision(client, {
      suggestion: existing,
      decision: "REJECT",
      reason,
      actorUserId,
      decidedAt,
    });
    await audit(client, auditContext, {
      action: "ai.mapping.suggestion.rejected",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: SUGGESTION_ENTITY_TYPE,
      entityId: existing.id,
      after: { ...suggestionSummary(existing), outcome: outcome.outcome },
      reason: "AI suggestion was already decided; nothing changed",
    });
    return outcome;
  }

  // No staleness guard here, deliberately. Refusing a suggestion is safe
  // regardless of how the case has changed — and blocking a rejection because
  // evidence moved on would leave stale proposals sitting PENDING forever with
  // no way to clear them.
  const result = await runSerializable(client, async (tx) => {
    const current = await tx.aiFrameworkMappingSuggestion.findUnique({
      where: { id: suggestionId },
    });
    if (!current) throw new AiSuggestionNotFoundError("AI suggestion not found");

    if (current.state !== "PENDING") {
      const decision = await appendDecision(tx, {
        suggestionId: current.id,
        decision: "REJECT",
        outcomeCode: DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED,
        reason,
        actorUserId,
        decidedAt,
      });
      return {
        suggestion: current,
        decision,
        outcome: DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED,
        changed: false,
      };
    }

    const suggestion = await tx.aiFrameworkMappingSuggestion.update({
      where: { id: current.id },
      data: {
        state: "REJECTED",
        decidedAt,
        decidedByUserId: actorUserId,
        decisionReason: reason,
        // Explicitly left null. A rejection can never carry a mapping link.
        promotedMappingId: null,
      },
    });

    const decision = await appendDecision(tx, {
      suggestionId: current.id,
      decision: "REJECT",
      outcomeCode: DECISION_OUTCOME_CODES.REJECTED,
      reason,
      actorUserId,
      decidedAt,
    });

    return {
      suggestion,
      decision,
      outcome: DECISION_OUTCOME_CODES.REJECTED,
      changed: true,
    };
  });

  await audit(client, auditContext, {
    action: "ai.mapping.suggestion.rejected",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: SUGGESTION_ENTITY_TYPE,
    entityId: result.suggestion.id,
    after: { ...suggestionSummary(result.suggestion), outcome: result.outcome },
    reason: "AI suggestion rejected by a human reviewer",
  });

  return { suggestion: result.suggestion, mapping: null, outcome: result.outcome, changed: false };
}

// Shared no-op path: append the ledger row, change nothing else.
async function recordUnchangedDecision(client, input) {
  const decision = await runSerializable(client, async (tx) =>
    appendDecision(tx, {
      suggestionId: input.suggestion.id,
      decision: input.decision,
      outcomeCode: DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED,
      reason: input.reason,
      actorUserId: input.actorUserId,
      decidedAt: input.decidedAt,
    })
  );

  return {
    suggestion: input.suggestion,
    mapping: null,
    decision,
    outcome: DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED,
    mappingOutcome: null,
    changed: false,
  };
}

module.exports = {
  SUGGESTION_ENTITY_TYPE,
  suggestionSummary,
  contentOf,
  loadSuggestionForCase,
  appendDecision,
  approveSuggestion,
  rejectSuggestion,
  recordUnchangedDecision,
};
