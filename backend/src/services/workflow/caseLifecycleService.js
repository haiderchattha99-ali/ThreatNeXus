"use strict";

// Case creation, guarded lifecycle transitions and explicit manual reopen
// (Phase 3).
//
// ---------------------------------------------------------------------------
// Every transition is a compare-and-swap, never a read-then-write
// ---------------------------------------------------------------------------
// applyGuardedTransition issues ONE `updateMany` whose WHERE names both the id
// and the expected `lifecycleState`. PostgreSQL row-locks and re-evaluates, so
// exactly one of two concurrent transitions can match — the loser sees
// count === 0 and is rejected with a controlled conflict rather than silently
// overwriting the winner. This is the same guarded-updateMany mechanism the
// enrichment queue uses for claim/complete (P2-T2b), for the same reason:
// re-reading the row and then updating it would be a TOCTOU window.
//
// The immutable CaseLifecycleEvent is written in the SAME transaction as the
// state change it describes, so a case can never reach a state with no event
// explaining how it got there.
//
// ---------------------------------------------------------------------------
// Nothing here can close a case
// ---------------------------------------------------------------------------
// changeCaseState only accepts OPEN / WAITING_FOR_ORG (ANALYST_SETTABLE_STATES).
// CLOSURE_PENDING is reachable only through a closure request and CLOSED only
// through a reviewer approval, both in caseClosureService.js. If this module
// accepted an arbitrary target state, the entire review gate would be
// bypassable by posting a body.

const {
  CASE_STATES,
  ANALYST_SETTABLE_STATES,
  ANALYST_SETTABLE_FROM_STATES,
  LIFECYCLE_EVENT_TYPES,
  LIFECYCLE_REASON_CODES,
  REOPEN_TRIGGERS,
  MAX_LIFECYCLE_NOTE_LENGTH,
  MAX_REOPEN_REASON_LENGTH,
  CaseWorkflowValidationError,
  CaseWorkflowNotFoundError,
  CaseWorkflowStateError,
  assertMemberOf,
  assertPositiveInteger,
  assertValidDate,
  assertTransitionAllowed,
  formatCaseReference,
  normalizeBoundedText,
} = require("./caseWorkflowRules");

const { runSerializable, runAtomic } = require("./workflowTransaction");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const CASE_ENTITY_TYPE = "Case";

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("Case lifecycle audit failed", { name: error && error.name });
  }
}

// Allow-listed audit payload: identity and state only. The case title,
// description and any analyst note are deliberately absent — they are free
// text that can carry incident detail which does not belong in an audit row.
function lifecycleSummary(record) {
  if (!record) return null;
  return {
    id: record.id,
    caseReference: record.caseReference === undefined ? null : record.caseReference,
    organizationId: record.organizationId === undefined ? null : record.organizationId,
    lifecycleState: record.lifecycleState,
    closureReason: record.closureReason === undefined ? null : record.closureReason,
    reopenedCount: record.reopenedCount === undefined ? 0 : record.reopenedCount,
    lastReopenTrigger: record.lastReopenTrigger === undefined ? null : record.lastReopenTrigger,
  };
}

/**
 * Compare-and-swap one lifecycle transition and append its immutable event.
 *
 * MUST be called inside a transaction. Throws CaseWorkflowStateError with code
 * CONCURRENT_STATE_CHANGE when the case is no longer in `fromState` — which
 * covers both a genuine concurrent transition and a caller working from stale
 * state, and is correct in either case.
 *
 * @param {object} tx
 * @param {{caseId:number, fromState:string, toState:string, eventType:string,
 *   reasonCode:string, note?:string|null, actorUserId?:number|null,
 *   occurredAt:Date, caseData?:object}} input
 * @returns {Promise<{case:object, event:object}>}
 */
async function applyGuardedTransition(tx, input) {
  assertTransitionAllowed(input.fromState, input.toState);

  const updated = await tx.case.updateMany({
    where: { id: input.caseId, lifecycleState: input.fromState },
    data: { lifecycleState: input.toState, ...(input.caseData || {}) },
  });

  if (updated.count !== 1) {
    throw new CaseWorkflowStateError(
      "Case is no longer in the expected state",
      "CONCURRENT_STATE_CHANGE"
    );
  }

  const event = await tx.caseLifecycleEvent.create({
    data: {
      caseId: input.caseId,
      eventType: input.eventType,
      fromState: input.fromState,
      toState: input.toState,
      reasonCode: input.reasonCode,
      note: input.note === undefined ? null : input.note,
      actorUserId: Number.isInteger(input.actorUserId) ? input.actorUserId : null,
      occurredAt: input.occurredAt,
    },
  });

  const record = await tx.case.findUnique({ where: { id: input.caseId } });
  return { case: record, event };
}

/**
 * Creates a case.
 *
 * `organizationId` is REQUIRED and validated to exist. The locked Phase 3
 * contract states that a case belongs to exactly one Organization, so there is
 * no path here that produces a new unbound case — an unbound case could never
 * accept evidence (the link rule compares the Finding's owner against the
 * case's), could never be notified, and would be a permanent dead end.
 *
 * Legacy rows created before Phase 3 may have a null organizationId. They stay
 * READABLE for compatibility and are refused by every Phase 3 workflow
 * operation via assertOrganizationBound. Binding such a row to an organization
 * is deliberately NOT possible through any endpoint in this milestone: doing it
 * safely needs a controlled migration that decides what the pre-existing
 * free-text `organization` string actually referred to, which is a separate
 * piece of work and is not invented here.
 *
 * The case reference is formatted AFTER insertion from the database's own
 * primary key, inside the same transaction. Generating it beforehand would
 * need either a second sequence or a guess, and two concurrent creations could
 * collide; deriving it from the assigned id cannot.
 */
async function createCase(input, options = {}) {
  if (!input || typeof input !== "object") {
    throw new CaseWorkflowValidationError("input must be an object", []);
  }
  const createdAt = assertValidDate(input.createdAt, "createdAt");
  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  if (input.organizationId === undefined || input.organizationId === null) {
    throw new CaseWorkflowValidationError("organizationId is required", ["organizationId"]);
  }
  const organizationId = assertPositiveInteger(input.organizationId, "organizationId");
  // Existence is checked before the transaction so an unknown organization is
  // a clean 400 rather than a foreign-key error surfacing as a 500.
  const organization = await client.organization.findUnique({ where: { id: organizationId } });
  if (!organization) {
    throw new CaseWorkflowValidationError("organizationId does not exist", ["organizationId"]);
  }

  let created;
  try {
    // runAtomic, not runSerializable: this transaction only INSERTs, and the
    // reference is derived from the primary key the database itself assigns, so
    // no interleaving can produce a duplicate. SERIALIZABLE here would take
    // predicate locks on the caseReference unique index and make concurrent
    // creations conflict on index-page adjacency rather than on data — see the
    // runAtomic docstring.
    created = await runAtomic(client, async (tx) => {
      const record = await tx.case.create({
        data: {
          title: input.title,
          threatType: input.threatType,
          organization: input.organization,
          priority: input.priority,
          status: input.status,
          analyst: input.analyst,
          description: input.description,
          organizationId,
          lifecycleState: CASE_STATES.OPEN,
          createdByUserId: actorUserId,
        },
      });

      const withReference = await tx.case.update({
        where: { id: record.id },
        data: { caseReference: formatCaseReference(record.id, createdAt) },
      });

      // Emitted for EVERY case, organization-bound or not, so the lifecycle
      // timeline is complete from the first instant and never starts mid-story.
      await tx.caseLifecycleEvent.create({
        data: {
          caseId: record.id,
          eventType: LIFECYCLE_EVENT_TYPES.CREATED,
          fromState: null,
          toState: CASE_STATES.OPEN,
          reasonCode: LIFECYCLE_REASON_CODES.CASE_CREATED,
          note: null,
          actorUserId,
          occurredAt: createdAt,
        },
      });

      return withReference;
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "case.created",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: CASE_ENTITY_TYPE,
      reason: "Case creation failed while persisting the record",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "case.created",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: CASE_ENTITY_TYPE,
    entityId: created.id,
    after: lifecycleSummary(created),
    reason: "Organization-bound case created",
  });

  return created;
}

// Shared loader. Throws NotFound for a missing case; the organization-bound
// check is separate because reads must still work for a legacy case.
async function loadCaseOrThrow(client, caseId) {
  const record = await client.case.findUnique({ where: { id: caseId } });
  if (!record) throw new CaseWorkflowNotFoundError("Case not found");
  return record;
}

function assertOrganizationBound(record) {
  if (!Number.isInteger(record.organizationId)) {
    throw new CaseWorkflowStateError(
      "Case is not bound to an organization",
      "CASE_NOT_ORGANIZATION_BOUND"
    );
  }
  return record;
}

// The analyst state endpoint constrains where a case may START as tightly as
// where it may end up. CLOSURE_PENDING -> OPEN is an allowed transition — it is
// how a REVIEWER rejects a closure — so a target-only restriction would let an
// analyst post {toState: "OPEN"} on a case awaiting review, silently withdraw
// the closure out from under the reviewer and orphan the PENDING request.
function assertAnalystSettableFrom(fromState) {
  if (!ANALYST_SETTABLE_FROM_STATES.includes(fromState)) {
    throw new CaseWorkflowStateError(
      "The case state can only be changed while the case is open or waiting for the organization",
      "CASE_STATE_NOT_ANALYST_SETTABLE"
    );
  }
  return fromState;
}

/**
 * Moves a case between OPEN and WAITING_FOR_ORG.
 *
 * Refuses outright while the case is CLOSURE_PENDING or CLOSED: leaving either
 * of those states is a reviewer decision or an explicit reopen, both of which
 * carry their own recorded reason.
 *
 * A request for the state the case is already in writes NOTHING and reports
 * changed: false. Recording a no-op transition would fill the lifecycle
 * timeline with events that describe nothing, which is exactly what makes a
 * timeline stop being readable as a decision record.
 */
async function changeCaseState(caseId, toState, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  assertMemberOf(toState, ANALYST_SETTABLE_STATES, "toState");
  const occurredAt = assertValidDate(options.occurredAt, "occurredAt");
  const note = normalizeBoundedText(options.note, {
    field: "note",
    maxLength: MAX_LIFECYCLE_NOTE_LENGTH,
    required: false,
  });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const existing = assertOrganizationBound(await loadCaseOrThrow(client, caseId));
  assertAnalystSettableFrom(existing.lifecycleState);

  if (existing.lifecycleState === toState) {
    return { case: existing, changed: false, event: null };
  }

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      // Re-read inside the transaction: the state observed above may be stale,
      // and both guards below must compare against what is actually committed.
      // Re-checking the source state here is what stops a closure request that
      // committed between the read above and this transaction from being
      // withdrawn by an already-in-flight state change.
      const fresh = await tx.case.findUnique({ where: { id: caseId } });
      if (!fresh) throw new CaseWorkflowNotFoundError("Case not found");
      assertAnalystSettableFrom(fresh.lifecycleState);
      if (fresh.lifecycleState === toState) return { case: fresh, changed: false, event: null };

      const result = await applyGuardedTransition(tx, {
        caseId,
        fromState: fresh.lifecycleState,
        toState,
        eventType: LIFECYCLE_EVENT_TYPES.STATE_CHANGED,
        reasonCode: LIFECYCLE_REASON_CODES.STATE_CHANGED_BY_ANALYST,
        note,
        actorUserId,
        occurredAt,
      });
      return { ...result, changed: true };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "case.state.changed",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: CASE_ENTITY_TYPE,
      entityId: caseId,
      reason: "Case state change was refused or could not be persisted",
    });
    throw error;
  }

  if (outcome.changed) {
    await audit(client, auditContext, {
      action: "case.state.changed",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: CASE_ENTITY_TYPE,
      entityId: caseId,
      before: { lifecycleState: existing.lifecycleState },
      after: lifecycleSummary(outcome.case),
      reason: "Case lifecycle state changed",
    });
  }

  return outcome;
}

/**
 * Explicit analyst reopen of a CLOSED case.
 *
 * Unlike the recurrence path this accepts ANY closure reason: a human
 * deliberately overturning a FALSE_POSITIVE or ACCEPTED_RISK decision, with a
 * recorded reason, is exactly the case the automatic path must never take on
 * its own. The reason is required for that same reason.
 */
async function reopenCase(caseId, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  const occurredAt = assertValidDate(options.occurredAt, "occurredAt");
  const reason = normalizeBoundedText(options.reason, {
    field: "reason",
    maxLength: MAX_REOPEN_REASON_LENGTH,
    required: true,
  });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const existing = assertOrganizationBound(await loadCaseOrThrow(client, caseId));
  if (existing.lifecycleState !== CASE_STATES.CLOSED) {
    throw new CaseWorkflowStateError("Only a closed case can be reopened", "CASE_NOT_CLOSED");
  }

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      const fresh = await tx.case.findUnique({ where: { id: caseId } });
      if (!fresh) throw new CaseWorkflowNotFoundError("Case not found");
      if (fresh.lifecycleState !== CASE_STATES.CLOSED) {
        throw new CaseWorkflowStateError("Only a closed case can be reopened", "CASE_NOT_CLOSED");
      }

      return applyGuardedTransition(tx, {
        caseId,
        fromState: CASE_STATES.CLOSED,
        toState: CASE_STATES.OPEN,
        eventType: LIFECYCLE_EVENT_TYPES.REOPENED,
        reasonCode: LIFECYCLE_REASON_CODES.REOPENED_MANUALLY,
        note: reason,
        actorUserId,
        occurredAt,
        caseData: {
          // Current-closure projection cleared; the permanent record stays in
          // CaseLifecycleEvent and the APPROVED CaseClosureRequest.
          closedAt: null,
          closureReason: null,
          closedByUserId: null,
          lastReopenedAt: occurredAt,
          lastReopenTrigger: REOPEN_TRIGGERS.MANUAL,
          reopenedCount: { increment: 1 },
        },
      });
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "case.reopened",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: CASE_ENTITY_TYPE,
      entityId: caseId,
      reason: "Manual case reopen was refused or could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "case.reopened",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: CASE_ENTITY_TYPE,
    entityId: caseId,
    before: { lifecycleState: CASE_STATES.CLOSED, closureReason: existing.closureReason },
    after: lifecycleSummary(outcome.case),
    reason: "Case reopened manually by an analyst",
  });

  return outcome;
}

module.exports = {
  CASE_ENTITY_TYPE,
  lifecycleSummary,
  applyGuardedTransition,
  loadCaseOrThrow,
  assertOrganizationBound,
  assertAnalystSettableFrom,
  createCase,
  changeCaseState,
  reopenCase,
};
