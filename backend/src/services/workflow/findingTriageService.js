"use strict";

// Append-only Finding triage (Phase 3).
//
// Every decision INSERTS a new FindingTriage row. Existing rows are never
// updated or deleted; the only mutation ever applied to a prior row is the
// supersession transition (supersededAt set, currentForFindingId nulled), in
// the same transaction that inserts its replacement. That is what makes "who
// decided what, when, and why" answerable after the fact — the whole point of
// triage being evidence rather than a status column on Finding.
//
// Triage is deliberately independent of FindingStatus (OPEN/CLOSED). Nothing
// in this module reads or writes Finding.status; see caseWorkflowRules.js.

const {
  TRIAGE_DECISIONS,
  TRIAGE_DECISION_VALUES,
  TRIAGE_SOURCES,
  TRIAGE_DECISIONS_REQUIRING_REASON,
  MAX_TRIAGE_REASON_LENGTH,
  UNTRIAGED,
  CaseWorkflowValidationError,
  CaseWorkflowNotFoundError,
  assertMemberOf,
  assertPositiveInteger,
  assertValidDate,
  isEscalationMeaningful,
  normalizeBoundedText,
} = require("./caseWorkflowRules");

const { runSerializable } = require("./workflowTransaction");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const TRIAGE_ENTITY_TYPE = "FindingTriage";

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

// Audit writes must never roll back or alter a committed triage decision.
// safeLogAuditEvent already swallows its own failures; the extra guard covers
// anything thrown before it is reached (a broken injected logger).
async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    // Name only — never error.message, which could carry database or request
    // text into the operator log.
    console.error("Finding triage audit failed", { name: error && error.name });
  }
}

// Allow-listed audit payload. Deliberately excludes the analyst's reason text
// (unbounded incident detail does not belong in an audit summary) and every
// current-row key.
function triageSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    findingId: row.findingId,
    decision: row.decision,
    source: row.source,
    caseId: row.caseId === undefined ? null : row.caseId,
    hasReason: typeof row.reason === "string" && row.reason.length > 0,
  };
}

async function loadCurrentTriage(tx, findingId) {
  return tx.findingTriage.findUnique({ where: { currentForFindingId: findingId } });
}

/**
 * Reads the current triage decision for a Finding, or UNTRIAGED.
 *
 * Returns the string sentinel rather than null so callers cannot accidentally
 * treat "no decision yet" as falsy-equivalent to a real decision value.
 */
async function getCurrentDecision(client, findingId) {
  const row = await client.findingTriage.findUnique({ where: { currentForFindingId: findingId } });
  return row ? row.decision : UNTRIAGED;
}

/**
 * Loads the current decision plus the complete append-only history, newest
 * first.
 */
async function getFindingTriage(findingId, options = {}) {
  assertPositiveInteger(findingId, "findingId");
  const client = resolveClient(options.client);

  const finding = await client.finding.findUnique({ where: { id: findingId } });
  if (!finding) throw new CaseWorkflowNotFoundError("Finding not found");

  const history = await client.findingTriage.findMany({
    where: { findingId },
    orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
  });
  const current = history.find((row) => row.supersededAt === null) || null;

  return { current, history, decision: current ? current.decision : UNTRIAGED };
}

// The supersede-then-insert core, run inside a caller-supplied transaction so
// it can be composed with a case link or a recurrence reopen atomically.
//
// Returns null (writing nothing) when `onlyIfMeaningful` is set and the
// requested decision is already in force — that is what stops re-linking or a
// repeated recurrence from flooding history with identical rows.
async function appendTriageInTransaction(tx, input) {
  const current = await loadCurrentTriage(tx, input.findingId);
  const currentDecision = current ? current.decision : UNTRIAGED;

  if (input.onlyIfMeaningful && !isEscalationMeaningful(currentDecision)) {
    return { row: null, previousDecision: currentDecision, changed: false };
  }

  if (current) {
    // The ONLY mutation ever applied to an existing triage row.
    await tx.findingTriage.update({
      where: { id: current.id },
      data: { supersededAt: input.decidedAt, currentForFindingId: null },
    });
  }

  const row = await tx.findingTriage.create({
    data: {
      findingId: input.findingId,
      decision: input.decision,
      source: input.source,
      reason: input.reason,
      caseId: input.caseId,
      actorUserId: input.actorUserId,
      decidedAt: input.decidedAt,
      supersededAt: null,
      currentForFindingId: input.findingId,
    },
  });

  return { row, previousDecision: currentDecision, changed: true };
}

/**
 * Records an explicit analyst triage decision.
 *
 * @param {{findingId:number, decision:string, reason?:string|null,
 *   decidedAt:Date}} input
 * @param {{client?:object, actorUserId?:number|null, auditContext?:object}} options
 * @returns {Promise<{current:object, previousDecision:string, changed:boolean}>}
 */
async function recordTriageDecision(input, options = {}) {
  if (!input || typeof input !== "object") {
    throw new CaseWorkflowValidationError("input must be an object", []);
  }
  const findingId = assertPositiveInteger(input.findingId, "findingId");
  const decision = assertMemberOf(input.decision, TRIAGE_DECISION_VALUES, "decision");
  const decidedAt = assertValidDate(input.decidedAt, "decidedAt");
  const reason = normalizeBoundedText(input.reason, {
    field: "reason",
    maxLength: MAX_TRIAGE_REASON_LENGTH,
    required: TRIAGE_DECISIONS_REQUIRING_REASON.includes(decision),
  });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const finding = await client.finding.findUnique({ where: { id: findingId } });
  if (!finding) {
    await audit(client, auditContext, {
      action: "finding.triage.recorded",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: TRIAGE_ENTITY_TYPE,
      reason: "Triage rejected: finding not found",
    });
    throw new CaseWorkflowNotFoundError("Finding not found");
  }

  let outcome;
  try {
    outcome = await runSerializable(client, (tx) =>
      appendTriageInTransaction(tx, {
        findingId,
        decision,
        source: TRIAGE_SOURCES.ANALYST_DECISION,
        reason,
        caseId: null,
        actorUserId,
        decidedAt,
        onlyIfMeaningful: false,
      })
    );
  } catch (error) {
    // The closed audit reason never interpolates error.message: one added
    // error class away, that would carry raw database text into AuditLog.
    await audit(client, auditContext, {
      action: "finding.triage.recorded",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: TRIAGE_ENTITY_TYPE,
      entityId: findingId,
      reason: "Triage decision could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "finding.triage.recorded",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: TRIAGE_ENTITY_TYPE,
    entityId: outcome.row.id,
    before: { findingId, decision: outcome.previousDecision },
    after: triageSummary(outcome.row),
    reason: "Finding triage decision recorded",
  });

  return { current: outcome.row, previousDecision: outcome.previousDecision, changed: true };
}

/**
 * Appends an ESCALATED row driven by a workflow event (a case link, or a
 * recurrence reopening a case) rather than by a direct analyst decision —
 * but ONLY when that would record a real change.
 *
 * Must be called with an active transaction (`tx`) so escalation commits
 * atomically with the link or reopen that caused it: a case that shows a
 * Finding as evidence while the Finding shows no escalation would be an
 * inconsistency nothing later could explain.
 */
async function appendWorkflowEscalation(tx, input) {
  return appendTriageInTransaction(tx, {
    findingId: assertPositiveInteger(input.findingId, "findingId"),
    decision: TRIAGE_DECISIONS.ESCALATED,
    source: assertMemberOf(
      input.source,
      [TRIAGE_SOURCES.CASE_LINK, TRIAGE_SOURCES.RECURRENCE_REOPEN],
      "source"
    ),
    reason: null,
    caseId: input.caseId === null || input.caseId === undefined ? null : input.caseId,
    actorUserId: Number.isInteger(input.actorUserId) ? input.actorUserId : null,
    decidedAt: assertValidDate(input.decidedAt, "decidedAt"),
    onlyIfMeaningful: true,
  });
}

module.exports = {
  TRIAGE_ENTITY_TYPE,
  triageSummary,
  getCurrentDecision,
  getFindingTriage,
  recordTriageDecision,
  appendTriageInTransaction,
  appendWorkflowEscalation,
};
