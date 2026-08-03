"use strict";

// Pure, dependency-free rules for the Phase 3 defensible analyst workflow.
//
// Nothing in this module touches Prisma, the wall clock, HTTP, or the audit
// trail. Every service in services/workflow/ validates through here BEFORE it
// opens a transaction, so an out-of-contract request is a controlled 400 at
// the boundary rather than a database enum error several layers down — the
// same convention as ownership/ipv4Cidr.js and risk/riskConfiguration.js.
//
// ---------------------------------------------------------------------------
// Triage is not exposure state
// ---------------------------------------------------------------------------
// FindingStatus (OPEN/CLOSED) is driven by observation evidence.
// FindingTriageDecision is the analyst's judgement. They are deliberately
// independent: a Finding can be OPEN and DISMISSED (we looked, we are not
// pursuing it) or CLOSED and ESCALATED (it stopped being observed while an
// investigation is live). No function here reads or writes FindingStatus.
//
// UNTRIAGED is the ABSENCE of a FindingTriage row, never a stored value — see
// the schema comment on FindingTriageDecision.

const UNTRIAGED = "UNTRIAGED";

const TRIAGE_DECISIONS = Object.freeze({
  IN_REVIEW: "IN_REVIEW",
  ESCALATED: "ESCALATED",
  DISMISSED: "DISMISSED",
});

const TRIAGE_DECISION_VALUES = Object.freeze(Object.values(TRIAGE_DECISIONS));

const TRIAGE_SOURCES = Object.freeze({
  ANALYST_DECISION: "ANALYST_DECISION",
  CASE_LINK: "CASE_LINK",
  RECURRENCE_REOPEN: "RECURRENCE_REOPEN",
});

// A dismissal with no stated reason is not defensible, so DISMISSED is the one
// decision that requires one. IN_REVIEW/ESCALATED may carry an optional note.
const TRIAGE_DECISIONS_REQUIRING_REASON = Object.freeze([TRIAGE_DECISIONS.DISMISSED]);

const CASE_STATES = Object.freeze({
  OPEN: "OPEN",
  WAITING_FOR_ORG: "WAITING_FOR_ORG",
  CLOSURE_PENDING: "CLOSURE_PENDING",
  CLOSED: "CLOSED",
});

const CASE_STATE_VALUES = Object.freeze(Object.values(CASE_STATES));

// The complete, closed transition table. Anything not listed is refused — the
// table is an allow-list, never a deny-list, so a state added in a future
// phase cannot silently acquire transitions nobody approved.
//
//   OPEN            <-> WAITING_FOR_ORG
//   OPEN            ->  CLOSURE_PENDING
//   WAITING_FOR_ORG ->  CLOSURE_PENDING
//   CLOSURE_PENDING ->  CLOSED   (reviewer approval only)
//   CLOSURE_PENDING ->  OPEN     (reviewer rejection only)
//   CLOSED          ->  OPEN     (explicit reopen, or qualifying recurrence)
const ALLOWED_TRANSITIONS = Object.freeze({
  OPEN: Object.freeze([CASE_STATES.WAITING_FOR_ORG, CASE_STATES.CLOSURE_PENDING]),
  WAITING_FOR_ORG: Object.freeze([CASE_STATES.OPEN, CASE_STATES.CLOSURE_PENDING]),
  CLOSURE_PENDING: Object.freeze([CASE_STATES.CLOSED, CASE_STATES.OPEN]),
  CLOSED: Object.freeze([CASE_STATES.OPEN]),
});

// The subset an analyst may drive directly through the state endpoint. Moving
// into CLOSURE_PENDING requires a closure REQUEST (which carries a reason and
// a justification), reaching CLOSED requires reviewer APPROVAL, and leaving
// CLOSED requires an explicit reopen — none of those may be reachable by
// posting a bare target state, or the whole review gate would be bypassable.
const ANALYST_SETTABLE_STATES = Object.freeze([CASE_STATES.OPEN, CASE_STATES.WAITING_FOR_ORG]);

// The state endpoint constrains the SOURCE as tightly as the target, and this
// is not redundant with the list above.
//
// CLOSURE_PENDING -> OPEN is a genuinely allowed transition — it is how a
// reviewer REJECTS a closure. But the target of that transition (OPEN) is also
// analyst-settable, so restricting only the target would let an analyst post
// {toState: "OPEN"} on a case awaiting review and silently withdraw the
// closure request out from under the reviewer, leaving an orphaned PENDING
// CaseClosureRequest behind. Rejection is a REVIEWER decision with a mandatory
// recorded note; it is not reachable from the analyst state endpoint.
//
// Identical to ANALYST_SETTABLE_STATES today, and deliberately a separate
// constant: the two answer different questions ("where may this end up" versus
// "where may this start"), and a future state that is settable but not
// leavable would need them to diverge.
const ANALYST_SETTABLE_FROM_STATES = Object.freeze([
  CASE_STATES.OPEN,
  CASE_STATES.WAITING_FOR_ORG,
]);

const LIFECYCLE_EVENT_TYPES = Object.freeze({
  CREATED: "CREATED",
  STATE_CHANGED: "STATE_CHANGED",
  CLOSURE_REQUESTED: "CLOSURE_REQUESTED",
  CLOSURE_APPROVED: "CLOSURE_APPROVED",
  CLOSURE_REJECTED: "CLOSURE_REJECTED",
  REOPENED: "REOPENED",
});

// Closed machine-readable vocabulary written into
// CaseLifecycleEvent.reasonCode. Never free text, never an exception message.
const LIFECYCLE_REASON_CODES = Object.freeze({
  CASE_CREATED: "CASE_CREATED",
  STATE_CHANGED_BY_ANALYST: "STATE_CHANGED_BY_ANALYST",
  CLOSURE_REQUESTED_BY_ANALYST: "CLOSURE_REQUESTED_BY_ANALYST",
  CLOSURE_APPROVED_BY_REVIEWER: "CLOSURE_APPROVED_BY_REVIEWER",
  CLOSURE_REJECTED_BY_REVIEWER: "CLOSURE_REJECTED_BY_REVIEWER",
  REOPENED_MANUALLY: "REOPENED_MANUALLY",
  REOPENED_BY_RECURRENCE: "REOPENED_BY_RECURRENCE",
});

const LINK_STATES = Object.freeze({ LINKED: "LINKED", UNLINKED: "UNLINKED" });

const RESPONSE_TYPES = Object.freeze({
  ACKNOWLEDGED: "ACKNOWLEDGED",
  INVESTIGATING: "INVESTIGATING",
  REMEDIATED: "REMEDIATED",
  DISPUTED: "DISPUTED",
  NO_RESPONSE: "NO_RESPONSE",
  OTHER: "OTHER",
});

const RESPONSE_TYPE_VALUES = Object.freeze(Object.values(RESPONSE_TYPES));

const CLOSURE_REASONS = Object.freeze({
  REMEDIATED: "REMEDIATED",
  FALSE_POSITIVE: "FALSE_POSITIVE",
  ACCEPTED_RISK: "ACCEPTED_RISK",
  DUPLICATE: "DUPLICATE",
  OTHER: "OTHER",
});

const CLOSURE_REASON_VALUES = Object.freeze(Object.values(CLOSURE_REASONS));

// A REMEDIATED closure asserts the exposure was actually fixed, so it must
// rest on a recorded REMEDIATED organization response. Every other reason is
// an analyst judgement that needs no organization input at all.
const CLOSURE_REASONS_REQUIRING_REMEDIATED_RESPONSE = Object.freeze([CLOSURE_REASONS.REMEDIATED]);

// ONLY a REMEDIATED closure may be reopened automatically by a recurrence.
// FALSE_POSITIVE / ACCEPTED_RISK / DUPLICATE / OTHER were all decided in full
// knowledge that the finding would keep being observed; re-opening them on the
// next report would silently overturn a human decision on a schedule.
const AUTO_REOPENABLE_CLOSURE_REASONS = Object.freeze([CLOSURE_REASONS.REMEDIATED]);

const CLOSURE_REQUEST_STATES = Object.freeze({
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

const REOPEN_TRIGGERS = Object.freeze({ MANUAL: "MANUAL", RECURRENCE: "RECURRENCE" });

const RECURRENCE_REOPEN_OUTCOMES = Object.freeze({
  REOPENED: "REOPENED",
  SKIPPED_NOT_CLOSED: "SKIPPED_NOT_CLOSED",
  SKIPPED_CLOSURE_REASON_NOT_REMEDIATED: "SKIPPED_CLOSURE_REASON_NOT_REMEDIATED",
});

// Closed vocabulary for why a Finding may not be linked to a case. Returned to
// the caller so an analyst is told what to fix (resolve ownership first),
// without any of it being free text a database error could leak into.
const LINK_REJECTION_CODES = Object.freeze({
  OWNERSHIP_MISSING: "OWNERSHIP_MISSING",
  OWNERSHIP_UNRESOLVED: "OWNERSHIP_UNRESOLVED",
  OWNERSHIP_AMBIGUOUS: "OWNERSHIP_AMBIGUOUS",
  OWNERSHIP_ISP_ATTRIBUTED: "OWNERSHIP_ISP_ATTRIBUTED",
  OWNERSHIP_ORGANIZATION_MISMATCH: "OWNERSHIP_ORGANIZATION_MISMATCH",
});

// Bounded text limits. Every analyst-authored string in this phase is trimmed
// and length-capped here before it can reach the database, an API response or
// (in truncated preview form only) an audit reason.
const MAX_TRIAGE_REASON_LENGTH = 1000;
const MAX_LIFECYCLE_NOTE_LENGTH = 1000;
const MAX_LINK_REASON_LENGTH = 1000;
const MAX_RESPONSE_SUMMARY_LENGTH = 2000;
const MAX_RESPONSE_REFERENCE_LENGTH = 256;
const MAX_CLOSURE_JUSTIFICATION_LENGTH = 2000;
const MAX_REVIEW_NOTE_LENGTH = 1000;
const MAX_REOPEN_REASON_LENGTH = 1000;

class CaseWorkflowValidationError extends Error {
  constructor(message, fields) {
    super(message);
    this.name = "CaseWorkflowValidationError";
    this.fields = Array.isArray(fields) ? fields : [];
  }
}

class CaseWorkflowNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaseWorkflowNotFoundError";
  }
}

// A legitimate request that the current durable state refuses (wrong lifecycle
// state, no pending closure request, a Finding whose ownership does not match).
// Distinct from a validation error because the caller's input was well formed —
// controllers map it to 409, never 400.
class CaseWorkflowStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CaseWorkflowStateError";
    this.code = typeof code === "string" ? code : null;
  }
}

// The requester may not approve their own closure request unless they hold the
// administrator self-approval capability. A dedicated error class so the
// controller can answer 403 without inspecting any message text.
class CaseClosureSelfApprovalError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaseClosureSelfApprovalError";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Trims, rejects blank, and rejects anything over the cap rather than silently
// truncating: an analyst whose justification was quietly cut in half would
// believe they recorded something they did not.
function normalizeBoundedText(value, { field, maxLength, required }) {
  if (value === undefined || value === null) {
    if (required) throw new CaseWorkflowValidationError(`${field} is required`, [field]);
    return null;
  }
  if (typeof value !== "string") {
    throw new CaseWorkflowValidationError(`${field} must be a string`, [field]);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    if (required) throw new CaseWorkflowValidationError(`${field} is required`, [field]);
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new CaseWorkflowValidationError(
      `${field} must be at most ${maxLength} characters`,
      [field]
    );
  }
  return trimmed;
}

function assertMemberOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new CaseWorkflowValidationError(`${field} must be one of ${allowed.join(", ")}`, [field]);
  }
  return value;
}

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new CaseWorkflowValidationError(`${field} must be a positive integer`, [field]);
  }
  return value;
}

function assertValidDate(value, field) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new CaseWorkflowValidationError(`${field} must be a valid date`, [field]);
  }
  return value;
}

function isTransitionAllowed(fromState, toState) {
  if (!CASE_STATE_VALUES.includes(fromState) || !CASE_STATE_VALUES.includes(toState)) return false;
  return ALLOWED_TRANSITIONS[fromState].includes(toState);
}

/**
 * The states an ANALYST may move this case to right now, through the state
 * endpoint alone.
 *
 * The single source of truth for both the guard in caseLifecycleService and the
 * `permittedActions.availableStates` block the frontend renders from, so the UI
 * can never offer a transition the service would refuse — and, more
 * importantly, can never hide one it would accept.
 */
function analystAvailableStates(fromState) {
  if (!ANALYST_SETTABLE_FROM_STATES.includes(fromState)) return [];
  return ANALYST_SETTABLE_STATES.filter((target) => isTransitionAllowed(fromState, target));
}

// Throws CaseWorkflowStateError (not a validation error): the caller asked for
// a real state, it is simply not reachable from where the case is now.
function assertTransitionAllowed(fromState, toState) {
  if (!isTransitionAllowed(fromState, toState)) {
    throw new CaseWorkflowStateError(
      `Transition ${fromState} -> ${toState} is not allowed`,
      "TRANSITION_NOT_ALLOWED"
    );
  }
  return toState;
}

/**
 * Decides whether a Finding may be linked to a case, from the case's
 * organization and the Finding's CURRENT ownership row.
 *
 * Pure and side-effect free — it neither reads nor writes ownership. The
 * caller supplies the already-loaded current FindingOwnership row (or null).
 *
 * A link is accepted only when ownership settled on exactly the case's
 * organization by a mechanism that actually identifies the constituent:
 *   - OVERRIDDEN  — an analyst asserted it explicitly, or
 *   - RESOLVED    — automatic resolution reached a single organization
 * and in both cases isIspAttribution must be false. Everything else is
 * rejected with a closed reason code telling the analyst to resolve ownership
 * first, because attaching a Finding to the wrong organization is how a
 * notification reaches the wrong party.
 *
 * @param {{organizationId:number}} caseRecord
 * @param {object|null} currentOwnership
 * @returns {{allowed:boolean, code:string|null,
 *   ownershipStatus:string|null, ownershipConfidence:string|null}}
 */
function evaluateLinkEligibility(caseRecord, currentOwnership) {
  const caseOrganizationId = caseRecord && caseRecord.organizationId;

  if (!currentOwnership) {
    return {
      allowed: false,
      code: LINK_REJECTION_CODES.OWNERSHIP_MISSING,
      ownershipStatus: null,
      ownershipConfidence: null,
    };
  }

  const status = currentOwnership.status;
  const confidence = currentOwnership.confidence || null;
  const reject = (code) => ({
    allowed: false,
    code,
    ownershipStatus: status,
    ownershipConfidence: confidence,
  });

  if (status === "UNRESOLVED") return reject(LINK_REJECTION_CODES.OWNERSHIP_UNRESOLVED);
  if (status === "AMBIGUOUS") return reject(LINK_REJECTION_CODES.OWNERSHIP_AMBIGUOUS);
  if (status !== "RESOLVED" && status !== "OVERRIDDEN") {
    // Fails closed for any status a future migration adds: an unrecognised
    // ownership status must never be readable as a settled attribution.
    return reject(LINK_REJECTION_CODES.OWNERSHIP_UNRESOLVED);
  }

  // Checked BEFORE the organization comparison, deliberately: an ISP-attributed
  // row can name the right organization id and still be the wrong answer,
  // because it identifies the upstream provider, not the constituent. Telling
  // the analyst "mismatch" there would send them to fix the wrong thing.
  if (currentOwnership.isIspAttribution === true) {
    return reject(LINK_REJECTION_CODES.OWNERSHIP_ISP_ATTRIBUTED);
  }

  if (
    !Number.isInteger(currentOwnership.organizationId) ||
    currentOwnership.organizationId !== caseOrganizationId
  ) {
    return reject(LINK_REJECTION_CODES.OWNERSHIP_ORGANIZATION_MISMATCH);
  }

  return { allowed: true, code: null, ownershipStatus: status, ownershipConfidence: confidence };
}

/**
 * True when appending an ESCALATED triage row would actually record a change.
 *
 * Linking evidence into a case, and a recurrence reopening one, both escalate
 * the Finding — but only if it is not already escalated. Without this guard
 * every re-link and every recurrence would append an identical row, and the
 * triage history would stop being a record of decisions and become a log of
 * system activity.
 */
function isEscalationMeaningful(currentDecision) {
  return currentDecision !== TRIAGE_DECISIONS.ESCALATED;
}

/**
 * True when a case that is currently CLOSED may be reopened automatically by a
 * recurrence. Both conditions are required and neither is inferred.
 */
function qualifiesForRecurrenceReopen(caseRecord) {
  if (!caseRecord) return false;
  if (caseRecord.lifecycleState !== CASE_STATES.CLOSED) return false;
  return AUTO_REOPENABLE_CLOSURE_REASONS.includes(caseRecord.closureReason);
}

// Deterministic, human-readable, and unique because it embeds the database's
// own primary key. Formatted AFTER insertion (see caseLifecycleService) rather
// than guessed beforehand, so two concurrent creations can never collide.
function formatCaseReference(caseId, createdAt) {
  assertPositiveInteger(caseId, "caseId");
  assertValidDate(createdAt, "createdAt");
  return `TNX-${createdAt.getUTCFullYear()}-${String(caseId).padStart(6, "0")}`;
}

module.exports = {
  UNTRIAGED,
  TRIAGE_DECISIONS,
  TRIAGE_DECISION_VALUES,
  TRIAGE_SOURCES,
  TRIAGE_DECISIONS_REQUIRING_REASON,
  CASE_STATES,
  CASE_STATE_VALUES,
  ALLOWED_TRANSITIONS,
  ANALYST_SETTABLE_STATES,
  ANALYST_SETTABLE_FROM_STATES,
  LIFECYCLE_EVENT_TYPES,
  LIFECYCLE_REASON_CODES,
  LINK_STATES,
  RESPONSE_TYPES,
  RESPONSE_TYPE_VALUES,
  CLOSURE_REASONS,
  CLOSURE_REASON_VALUES,
  CLOSURE_REASONS_REQUIRING_REMEDIATED_RESPONSE,
  AUTO_REOPENABLE_CLOSURE_REASONS,
  CLOSURE_REQUEST_STATES,
  REOPEN_TRIGGERS,
  RECURRENCE_REOPEN_OUTCOMES,
  LINK_REJECTION_CODES,
  MAX_TRIAGE_REASON_LENGTH,
  MAX_LIFECYCLE_NOTE_LENGTH,
  MAX_LINK_REASON_LENGTH,
  MAX_RESPONSE_SUMMARY_LENGTH,
  MAX_RESPONSE_REFERENCE_LENGTH,
  MAX_CLOSURE_JUSTIFICATION_LENGTH,
  MAX_REVIEW_NOTE_LENGTH,
  MAX_REOPEN_REASON_LENGTH,
  CaseWorkflowValidationError,
  CaseWorkflowNotFoundError,
  CaseWorkflowStateError,
  CaseClosureSelfApprovalError,
  isPlainObject,
  normalizeBoundedText,
  assertMemberOf,
  assertPositiveInteger,
  assertValidDate,
  isTransitionAllowed,
  analystAvailableStates,
  assertTransitionAllowed,
  evaluateLinkEligibility,
  isEscalationMeaningful,
  qualifiesForRecurrenceReopen,
  formatCaseReference,
};
