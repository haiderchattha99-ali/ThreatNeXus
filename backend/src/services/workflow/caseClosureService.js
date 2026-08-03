"use strict";

// Reviewer-approved case closure (Phase 3).
//
// ---------------------------------------------------------------------------
// Separation of duties is the whole point of this module
// ---------------------------------------------------------------------------
// Closing a case takes TWO distinct acts by TWO distinct authorities:
//   1. requestClosure   — ADMIN or ANALYST (capability manage:cases)
//   2. approveClosure   — REVIEWER or ADMIN (capability review:case-closure)
// and the requester may not be the approver unless they additionally hold the
// administrator self-approval capability. ANALYST holds neither
// review:case-closure nor that capability, so an analyst can never close a
// case — not their own request, not anybody else's.
//
// The self-approval rule is enforced HERE, in the service, from an explicit
// boolean the controller derives from a CAPABILITY (never from a role name).
// Putting it in the controller would leave the service closable by any future
// caller that forgot the check.
//
// ---------------------------------------------------------------------------
// A REMEDIATED closure must rest on a recorded REMEDIATED response
// ---------------------------------------------------------------------------
// Enforced as a precondition AND persisted as supportingResponseId, so the
// rule leaves durable evidence rather than merely having been true once. Other
// closure reasons need no organization input: FALSE_POSITIVE, ACCEPTED_RISK,
// DUPLICATE and OTHER are analyst judgements about our own data.

const {
  CASE_STATES,
  CLOSURE_REASONS,
  CLOSURE_REASON_VALUES,
  CLOSURE_REASONS_REQUIRING_REMEDIATED_RESPONSE,
  CLOSURE_REQUEST_STATES,
  LIFECYCLE_EVENT_TYPES,
  LIFECYCLE_REASON_CODES,
  MAX_CLOSURE_JUSTIFICATION_LENGTH,
  MAX_REVIEW_NOTE_LENGTH,
  CaseWorkflowNotFoundError,
  CaseWorkflowStateError,
  CaseClosureSelfApprovalError,
  assertMemberOf,
  assertPositiveInteger,
  assertValidDate,
  normalizeBoundedText,
} = require("./caseWorkflowRules");

const { runSerializable } = require("./workflowTransaction");
const {
  applyGuardedTransition,
  loadCaseOrThrow,
  assertOrganizationBound,
  lifecycleSummary,
} = require("./caseLifecycleService");
const { findLatestRemediatedResponse } = require("./caseResponseService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const CLOSURE_ENTITY_TYPE = "CaseClosureRequest";

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("Case closure audit failed", { name: error && error.name });
  }
}

// Allow-listed audit payload. Justification and review note are analyst/
// reviewer free text and are reduced to presence + length, exactly like the
// organization-response summary — the decision, the actors and the evidence
// pointer are what an auditor needs, not the prose.
function closureSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    state: row.state,
    closureReason: row.closureReason,
    requestedByUserId: row.requestedByUserId === undefined ? null : row.requestedByUserId,
    reviewedByUserId: row.reviewedByUserId === undefined ? null : row.reviewedByUserId,
    supportingResponseId:
      row.supportingResponseId === undefined ? null : row.supportingResponseId,
    justificationLength: typeof row.justification === "string" ? row.justification.length : 0,
  };
}

/**
 * Requests closure of an OPEN or WAITING_FOR_ORG case.
 *
 * Moves the case to CLOSURE_PENDING in the same transaction as the request
 * row. `activeCaseId` (unique) makes "at most one open closure request per
 * case" a database invariant rather than a checked-then-hoped-for one, so two
 * concurrent requests cannot both become pending.
 *
 * @param {number} caseId
 * @param {{closureReason:string, justification:string}} input
 * @param {{client?:object, actorUserId?:number|null, requestedAt:Date,
 *   auditContext?:object}} options
 */
async function requestClosure(caseId, input, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  const closureReason = assertMemberOf(
    input && input.closureReason,
    CLOSURE_REASON_VALUES,
    "closureReason"
  );
  const requestedAt = assertValidDate(options.requestedAt, "requestedAt");
  const justification = normalizeBoundedText(input && input.justification, {
    field: "justification",
    maxLength: MAX_CLOSURE_JUSTIFICATION_LENGTH,
    required: true,
  });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const caseRecord = assertOrganizationBound(await loadCaseOrThrow(client, caseId));
  if (
    caseRecord.lifecycleState !== CASE_STATES.OPEN &&
    caseRecord.lifecycleState !== CASE_STATES.WAITING_FOR_ORG
  ) {
    throw new CaseWorkflowStateError(
      "Closure can only be requested for an open case",
      "CASE_NOT_OPEN_FOR_CLOSURE"
    );
  }

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      const fresh = await tx.case.findUnique({ where: { id: caseId } });
      if (!fresh) throw new CaseWorkflowNotFoundError("Case not found");
      if (
        fresh.lifecycleState !== CASE_STATES.OPEN &&
        fresh.lifecycleState !== CASE_STATES.WAITING_FOR_ORG
      ) {
        throw new CaseWorkflowStateError(
          "Closure can only be requested for an open case",
          "CASE_NOT_OPEN_FOR_CLOSURE"
        );
      }

      // Re-checked inside the transaction against committed responses, so a
      // concurrently-recorded (or concurrently-absent) REMEDIATED response
      // cannot be raced past.
      let supportingResponseId = null;
      if (CLOSURE_REASONS_REQUIRING_REMEDIATED_RESPONSE.includes(closureReason)) {
        const supporting = await findLatestRemediatedResponse(tx, caseId);
        if (!supporting) {
          throw new CaseWorkflowStateError(
            "A REMEDIATED closure requires a recorded REMEDIATED organization response",
            "REMEDIATED_RESPONSE_REQUIRED"
          );
        }
        supportingResponseId = supporting.id;
      }

      const request = await tx.caseClosureRequest.create({
        data: {
          caseId,
          state: CLOSURE_REQUEST_STATES.PENDING,
          closureReason,
          justification,
          requestedByUserId: actorUserId,
          requestedAt,
          supportingResponseId,
          activeCaseId: caseId,
        },
      });

      const transition = await applyGuardedTransition(tx, {
        caseId,
        fromState: fresh.lifecycleState,
        toState: CASE_STATES.CLOSURE_PENDING,
        eventType: LIFECYCLE_EVENT_TYPES.CLOSURE_REQUESTED,
        reasonCode: LIFECYCLE_REASON_CODES.CLOSURE_REQUESTED_BY_ANALYST,
        note: null,
        actorUserId,
        occurredAt: requestedAt,
      });

      return { request, case: transition.case };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "case.closure.requested",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: CLOSURE_ENTITY_TYPE,
      entityId: caseId,
      reason:
        error instanceof CaseWorkflowStateError && error.code
          ? `Closure request refused (${error.code})`
          : "Closure request could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "case.closure.requested",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: CLOSURE_ENTITY_TYPE,
    entityId: outcome.request.id,
    before: { caseId, lifecycleState: caseRecord.lifecycleState },
    after: closureSummary(outcome.request),
    reason: "Case closure requested, awaiting reviewer decision",
  });

  return outcome;
}

// Shared loader for the two review paths. Confirms the request exists, belongs
// to this case, and is still PENDING — a request already decided must never be
// decided a second time.
async function loadPendingRequest(tx, caseId, requestId) {
  const request = await tx.caseClosureRequest.findUnique({ where: { id: requestId } });
  if (!request || request.caseId !== caseId) {
    throw new CaseWorkflowNotFoundError("Closure request not found for this case");
  }
  if (request.state !== CLOSURE_REQUEST_STATES.PENDING) {
    throw new CaseWorkflowStateError(
      "Closure request has already been decided",
      "CLOSURE_REQUEST_NOT_PENDING"
    );
  }
  return request;
}

// The self-approval prohibition. `reviewerCanSelfApprove` is a CAPABILITY-
// derived boolean supplied by the controller (see caseWorkflowController:
// CAPABILITIES.OVERRIDE_CLOSURE_SELF_APPROVAL), never a role string, so this
// service holds no role knowledge at all.
//
// An unattributed request (requestedByUserId null, e.g. after the requesting
// user was deleted) is NOT self-approval: null === null must not lock the
// review out, so the check requires a real integer on both sides.
function assertNotSelfApproval(request, reviewerUserId, reviewerCanSelfApprove) {
  if (reviewerCanSelfApprove) return;
  if (
    Number.isInteger(request.requestedByUserId) &&
    Number.isInteger(reviewerUserId) &&
    request.requestedByUserId === reviewerUserId
  ) {
    throw new CaseClosureSelfApprovalError(
      "The requester may not approve their own closure request"
    );
  }
}

/**
 * Approves a pending closure request and CLOSES the case.
 *
 * This is the only path in the entire system that sets lifecycleState CLOSED.
 */
async function approveClosure(caseId, requestId, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  assertPositiveInteger(requestId, "requestId");
  const reviewedAt = assertValidDate(options.reviewedAt, "reviewedAt");
  const reviewNote = normalizeBoundedText(options.reviewNote, {
    field: "reviewNote",
    maxLength: MAX_REVIEW_NOTE_LENGTH,
    required: false,
  });

  const client = resolveClient(options.client);
  const reviewerUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const reviewerCanSelfApprove = options.reviewerCanSelfApprove === true;
  const auditContext = options.auditContext;

  assertOrganizationBound(await loadCaseOrThrow(client, caseId));

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      const request = await loadPendingRequest(tx, caseId, requestId);
      assertNotSelfApproval(request, reviewerUserId, reviewerCanSelfApprove);

      const fresh = await tx.case.findUnique({ where: { id: caseId } });
      if (!fresh) throw new CaseWorkflowNotFoundError("Case not found");
      if (fresh.lifecycleState !== CASE_STATES.CLOSURE_PENDING) {
        throw new CaseWorkflowStateError(
          "Case is not awaiting closure review",
          "CASE_NOT_CLOSURE_PENDING"
        );
      }

      const decided = await tx.caseClosureRequest.update({
        where: { id: request.id },
        data: {
          state: CLOSURE_REQUEST_STATES.APPROVED,
          reviewedByUserId: reviewerUserId,
          reviewedAt,
          reviewNote,
          // Released so a future reopen-and-re-close cycle can create its own
          // pending request; the APPROVED row itself is never rewritten again.
          activeCaseId: null,
        },
      });

      const transition = await applyGuardedTransition(tx, {
        caseId,
        fromState: CASE_STATES.CLOSURE_PENDING,
        toState: CASE_STATES.CLOSED,
        eventType: LIFECYCLE_EVENT_TYPES.CLOSURE_APPROVED,
        reasonCode: LIFECYCLE_REASON_CODES.CLOSURE_APPROVED_BY_REVIEWER,
        note: reviewNote,
        actorUserId: reviewerUserId,
        occurredAt: reviewedAt,
        caseData: {
          closedAt: reviewedAt,
          closureReason: request.closureReason,
          closedByUserId: reviewerUserId,
        },
      });

      return { request: decided, case: transition.case };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "case.closure.approved",
      outcome:
        error instanceof CaseClosureSelfApprovalError
          ? AUDIT_OUTCOMES.DENIED
          : AUDIT_OUTCOMES.FAILURE,
      entityType: CLOSURE_ENTITY_TYPE,
      entityId: requestId,
      reason:
        error instanceof CaseClosureSelfApprovalError
          ? "Closure approval denied: requester may not approve their own request"
          : error instanceof CaseWorkflowStateError && error.code
            ? `Closure approval refused (${error.code})`
            : "Closure approval could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "case.closure.approved",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: CLOSURE_ENTITY_TYPE,
    entityId: outcome.request.id,
    before: { caseId, lifecycleState: CASE_STATES.CLOSURE_PENDING },
    after: { ...closureSummary(outcome.request), case: lifecycleSummary(outcome.case) },
    reason: "Case closure approved by reviewer, case closed",
  });

  return outcome;
}

/**
 * Rejects a pending closure request and returns the case to OPEN.
 *
 * The reviewer's note is REQUIRED here (unlike on approval): sending a case
 * back without saying why leaves the analyst nothing to act on, and leaves the
 * record unable to show that the rejection was reasoned.
 */
async function rejectClosure(caseId, requestId, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  assertPositiveInteger(requestId, "requestId");
  const reviewedAt = assertValidDate(options.reviewedAt, "reviewedAt");
  const reviewNote = normalizeBoundedText(options.reviewNote, {
    field: "reviewNote",
    maxLength: MAX_REVIEW_NOTE_LENGTH,
    required: true,
  });

  const client = resolveClient(options.client);
  const reviewerUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  assertOrganizationBound(await loadCaseOrThrow(client, caseId));

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      const request = await loadPendingRequest(tx, caseId, requestId);

      const fresh = await tx.case.findUnique({ where: { id: caseId } });
      if (!fresh) throw new CaseWorkflowNotFoundError("Case not found");
      if (fresh.lifecycleState !== CASE_STATES.CLOSURE_PENDING) {
        throw new CaseWorkflowStateError(
          "Case is not awaiting closure review",
          "CASE_NOT_CLOSURE_PENDING"
        );
      }

      const decided = await tx.caseClosureRequest.update({
        where: { id: request.id },
        data: {
          state: CLOSURE_REQUEST_STATES.REJECTED,
          reviewedByUserId: reviewerUserId,
          reviewedAt,
          reviewNote,
          activeCaseId: null,
        },
      });

      const transition = await applyGuardedTransition(tx, {
        caseId,
        fromState: CASE_STATES.CLOSURE_PENDING,
        toState: CASE_STATES.OPEN,
        eventType: LIFECYCLE_EVENT_TYPES.CLOSURE_REJECTED,
        reasonCode: LIFECYCLE_REASON_CODES.CLOSURE_REJECTED_BY_REVIEWER,
        note: reviewNote,
        actorUserId: reviewerUserId,
        occurredAt: reviewedAt,
      });

      return { request: decided, case: transition.case };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "case.closure.rejected",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: CLOSURE_ENTITY_TYPE,
      entityId: requestId,
      reason:
        error instanceof CaseWorkflowStateError && error.code
          ? `Closure rejection refused (${error.code})`
          : "Closure rejection could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "case.closure.rejected",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: CLOSURE_ENTITY_TYPE,
    entityId: outcome.request.id,
    before: { caseId, lifecycleState: CASE_STATES.CLOSURE_PENDING },
    after: { ...closureSummary(outcome.request), case: lifecycleSummary(outcome.case) },
    reason: "Case closure rejected by reviewer, case returned to open",
  });

  return outcome;
}

/**
 * Newest-first closure request history for one case.
 */
async function listClosureRequests(client, caseId) {
  return client.caseClosureRequest.findMany({
    where: { caseId },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
  });
}

module.exports = {
  CLOSURE_ENTITY_TYPE,
  CLOSURE_REASONS,
  closureSummary,
  assertNotSelfApproval,
  requestClosure,
  approveClosure,
  rejectClosure,
  listClosureRequests,
};
