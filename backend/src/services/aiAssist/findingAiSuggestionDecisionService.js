"use strict";

// Human review of Finding AI suggestion drafts (Phase 8C).
//
// ===========================================================================
// Accepting a draft never mutates the Finding
// ===========================================================================
// Unlike Phase 5's AI mapping suggestions, a summary/explanation draft has no
// downstream authoritative record to promote into — there is no
// "CaseFrameworkMapping" equivalent for free text. Accepting one therefore
// does exactly one thing: flips the suggestion's OWN state to ACCEPTED and
// records who decided and when. It never writes to Finding, Case, RiskScore,
// or anywhere else. This keeps the safe-acceptance surface deliberately
// small, per this ticket's explicit "smallest safe MVP" instruction.
//
// ===========================================================================
// Staleness on ACCEPT only, never on REJECT
// ===========================================================================
// If the Finding's evidence (triage decision, risk band, verified CVEs) has
// changed since the draft was generated, the fingerprint no longer matches
// and an accept attempt transitions the DRAFT to EXPIRED and is refused —
// never silently re-derived or approved against evidence that has moved on.
// Rejecting is safe regardless of how the Finding has changed (same reasoning
// services/ai/aiSuggestionDecisionService.js documents for mapping
// suggestions): a rejection asserts nothing about current evidence, so no
// guard is needed and a stale draft is never stuck unrejectable.

const {
  SUGGESTION_STATUSES,
  DECISION_OUTCOME_CODES,
  DECISION_REFUSAL_CODES,
  AiAssistNotFoundError,
  AiAssistStateError,
  normalizeDecisionReason,
} = require("./aiAssistRules");

const { buildFindingEvidenceSnapshot } = require("./findingEvidenceSnapshot");
const { runAtomic, runSerializable } = require("../workflow/workflowTransaction");
const { assertPositiveInteger, assertValidDate } = require("../framework/frameworkMappingRules");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");
const { suggestionSummary, loadFindingOrThrow } = require("./findingAiSuggestionService");

const SUGGESTION_ENTITY_TYPE = "FindingAiSuggestion";

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("AI finding suggestion decision audit failed", { name: error && error.name });
  }
}

async function loadSuggestionForFinding(client, findingId, suggestionId) {
  const suggestion = await client.findingAiSuggestion.findUnique({ where: { id: suggestionId } });
  if (!suggestion) throw new AiAssistNotFoundError("AI suggestion not found");
  if (suggestion.findingId !== findingId) {
    throw new AiAssistStateError(
      "AI suggestion does not belong to this Finding",
      DECISION_REFUSAL_CODES.SUGGESTION_NOT_FOR_FINDING
    );
  }
  return suggestion;
}

async function recordUnchangedDecision(client, suggestion, outcome) {
  return { suggestion, outcome: DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED, changed: false };
}

/**
 * Accepts one DRAFT suggestion. Writes only to the suggestion's own row.
 *
 * @param {number} findingId
 * @param {number} suggestionId
 * @param {object} options
 * @param {Date}   options.decidedAt      explicit; never a wall-clock read
 * @param {number|null} options.actorUserId  the HUMAN accepting
 */
async function acceptFindingAiSuggestion(findingId, suggestionId, options = {}) {
  assertPositiveInteger(findingId, "findingId");
  assertPositiveInteger(suggestionId, "suggestionId");
  const decidedAt = assertValidDate(options.decidedAt, "decidedAt");
  const reason = normalizeDecisionReason(options.reason, { required: false });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const finding = await loadFindingOrThrow(client, findingId);
  const existing = await loadSuggestionForFinding(client, findingId, suggestionId);

  if (existing.status !== SUGGESTION_STATUSES.DRAFT) {
    const outcome = await recordUnchangedDecision(client, existing);
    await audit(client, auditContext, {
      action: "ai.suggestion.accepted",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: SUGGESTION_ENTITY_TYPE,
      entityId: existing.id,
      after: { ...suggestionSummary(existing), outcome: outcome.outcome },
      reason: "AI suggestion was already decided; nothing changed",
    });
    return outcome;
  }

  // Staleness guard, rebuilt from the Finding as it is NOW.
  const { fingerprint } = await buildFindingEvidenceSnapshot(client, finding, {});
  if (fingerprint !== existing.inputFingerprint) {
    const expired = await runAtomic(client, async (tx) => {
      const current = await tx.findingAiSuggestion.findUnique({ where: { id: suggestionId } });
      if (!current || current.status !== SUGGESTION_STATUSES.DRAFT) return current;
      return tx.findingAiSuggestion.update({
        where: { id: suggestionId },
        data: { status: SUGGESTION_STATUSES.EXPIRED },
      });
    });

    await audit(client, auditContext, {
      action: "ai.suggestion.failed",
      outcome: AUDIT_OUTCOMES.DENIED,
      entityType: SUGGESTION_ENTITY_TYPE,
      entityId: suggestionId,
      after: suggestionSummary(expired || existing),
      reason: `AI suggestion acceptance refused (${DECISION_REFUSAL_CODES.SUGGESTION_STALE})`,
    });

    throw new AiAssistStateError(
      "The Finding evidence has changed since this suggestion was generated",
      DECISION_REFUSAL_CODES.SUGGESTION_STALE
    );
  }

  const result = await runSerializable(client, async (tx) => {
    const current = await tx.findingAiSuggestion.findUnique({ where: { id: suggestionId } });
    if (!current) throw new AiAssistNotFoundError("AI suggestion not found");

    if (current.status !== SUGGESTION_STATUSES.DRAFT) {
      return { suggestion: current, outcome: DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED, changed: false };
    }

    const suggestion = await tx.findingAiSuggestion.update({
      where: { id: current.id },
      data: {
        status: SUGGESTION_STATUSES.ACCEPTED,
        decidedAt,
        decidedByUserId: actorUserId,
        decisionReason: reason,
      },
    });

    return { suggestion, outcome: DECISION_OUTCOME_CODES.ACCEPTED, changed: true };
  });

  await audit(client, auditContext, {
    action: "ai.suggestion.accepted",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: SUGGESTION_ENTITY_TYPE,
    entityId: result.suggestion.id,
    after: { ...suggestionSummary(result.suggestion), outcome: result.outcome },
    reason: "AI suggestion accepted by a human reviewer",
  });

  return result;
}

/**
 * Rejects one DRAFT suggestion. No staleness guard — see module header.
 * A reason is required.
 */
async function rejectFindingAiSuggestion(findingId, suggestionId, options = {}) {
  assertPositiveInteger(findingId, "findingId");
  assertPositiveInteger(suggestionId, "suggestionId");
  const decidedAt = assertValidDate(options.decidedAt, "decidedAt");
  const reason = normalizeDecisionReason(options.reason, { required: true });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  await loadFindingOrThrow(client, findingId);
  const existing = await loadSuggestionForFinding(client, findingId, suggestionId);

  if (existing.status !== SUGGESTION_STATUSES.DRAFT) {
    const outcome = await recordUnchangedDecision(client, existing);
    await audit(client, auditContext, {
      action: "ai.suggestion.rejected",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: SUGGESTION_ENTITY_TYPE,
      entityId: existing.id,
      after: { ...suggestionSummary(existing), outcome: outcome.outcome },
      reason: "AI suggestion was already decided; nothing changed",
    });
    return outcome;
  }

  const result = await runSerializable(client, async (tx) => {
    const current = await tx.findingAiSuggestion.findUnique({ where: { id: suggestionId } });
    if (!current) throw new AiAssistNotFoundError("AI suggestion not found");

    if (current.status !== SUGGESTION_STATUSES.DRAFT) {
      return { suggestion: current, outcome: DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED, changed: false };
    }

    const suggestion = await tx.findingAiSuggestion.update({
      where: { id: current.id },
      data: {
        status: SUGGESTION_STATUSES.REJECTED,
        decidedAt,
        decidedByUserId: actorUserId,
        decisionReason: reason,
      },
    });

    return { suggestion, outcome: DECISION_OUTCOME_CODES.REJECTED, changed: true };
  });

  await audit(client, auditContext, {
    action: "ai.suggestion.rejected",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: SUGGESTION_ENTITY_TYPE,
    entityId: result.suggestion.id,
    after: { ...suggestionSummary(result.suggestion), outcome: result.outcome },
    reason: "AI suggestion rejected by a human reviewer",
  });

  return result;
}

module.exports = {
  SUGGESTION_ENTITY_TYPE,
  loadSuggestionForFinding,
  acceptFindingAiSuggestion,
  rejectFindingAiSuggestion,
};
