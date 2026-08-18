// Presentation vocabulary for the Phase 3 analyst workflow.
//
// Mirrors backend/src/services/workflow/caseWorkflowRules.js verbatim. Like
// constants/capabilities.js this is UX metadata only — the backend validates
// every one of these values itself and refuses anything outside its own closed
// vocabulary, whatever this file says.
//
// The colours deliberately distinguish "still being worked" (blue/amber) from
// "awaiting a human decision" (violet) from "concluded" (grey), so a case
// sitting in CLOSURE_PENDING never reads as finished.

export const CASE_LIFECYCLE_STATES = {
  OPEN: 'OPEN',
  WAITING_FOR_ORG: 'WAITING_FOR_ORG',
  CLOSURE_PENDING: 'CLOSURE_PENDING',
  CLOSED: 'CLOSED',
}

export const CASE_STATE_LABELS = {
  OPEN: 'Open',
  WAITING_FOR_ORG: 'Waiting for organization',
  CLOSURE_PENDING: 'Closure pending review',
  CLOSED: 'Closed',
}

export const CASE_STATE_COLORS = {
  OPEN: '#5AB6D9',
  WAITING_FOR_ORG: '#E8A33D',
  CLOSURE_PENDING: '#c08cff',
  CLOSED: '#7C8AA0',
}

export const TRIAGE_DECISIONS = {
  UNTRIAGED: 'UNTRIAGED',
  IN_REVIEW: 'IN_REVIEW',
  ESCALATED: 'ESCALATED',
  DISMISSED: 'DISMISSED',
}

// UNTRIAGED is the ABSENCE of a decision, never one the analyst can choose —
// so it is not in this list.
export const TRIAGE_DECISION_OPTIONS = ['IN_REVIEW', 'ESCALATED', 'DISMISSED']

export const TRIAGE_LABELS = {
  UNTRIAGED: 'Untriaged',
  IN_REVIEW: 'In review',
  ESCALATED: 'Escalated',
  DISMISSED: 'Dismissed',
}

export const TRIAGE_COLORS = {
  UNTRIAGED: '#7C8AA0',
  IN_REVIEW: '#5AB6D9',
  ESCALATED: '#F2617A',
  DISMISSED: '#35C477',
}

// A dismissal with no stated reason is not defensible, so the form requires one.
export const TRIAGE_DECISIONS_REQUIRING_REASON = ['DISMISSED']

// WHAT recorded a triage decision (the backend's closed TRIAGE_SOURCES set).
// The history line used to print the raw enum, which matters more than it looks:
// `RECURRENCE_REOPEN` is the system reacting to evidence, not a person deciding,
// and the two must not read alike in an audit trail.
export const TRIAGE_SOURCE_LABELS = {
  ANALYST_DECISION: 'recorded by an analyst',
  CASE_LINK: 'set when the finding joined a case',
  RECURRENCE_REOPEN: 'set automatically when the finding recurred',
}

export const ORGANIZATION_RESPONSE_TYPES = [
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'REMEDIATED',
  'DISPUTED',
  'NO_RESPONSE',
  'OTHER',
]

export const RESPONSE_LABELS = {
  ACKNOWLEDGED: 'Acknowledged',
  INVESTIGATING: 'Investigating',
  REMEDIATED: 'Reported remediated',
  DISPUTED: 'Disputed',
  NO_RESPONSE: 'No response',
  OTHER: 'Other',
}

export const RESPONSE_COLORS = {
  ACKNOWLEDGED: '#5AB6D9',
  INVESTIGATING: '#E8A33D',
  REMEDIATED: '#35C477',
  DISPUTED: '#F2617A',
  NO_RESPONSE: '#7C8AA0',
  OTHER: '#9DAFC2',
}

export const CLOSURE_REASONS = [
  'REMEDIATED',
  'FALSE_POSITIVE',
  'ACCEPTED_RISK',
  'DUPLICATE',
  'OTHER',
]

export const CLOSURE_REASON_LABELS = {
  REMEDIATED: 'Remediated',
  FALSE_POSITIVE: 'False positive',
  ACCEPTED_RISK: 'Accepted risk',
  DUPLICATE: 'Duplicate',
  OTHER: 'Other',
}

// Shown next to the REMEDIATED option so an analyst is told the precondition
// before they submit, rather than by a 409 afterwards.
export const REMEDIATED_CLOSURE_REQUIREMENT =
  'Requires a recorded REMEDIATED organization response on this case.'

export const LIFECYCLE_EVENT_LABELS = {
  CREATED: 'Case created',
  STATE_CHANGED: 'State changed',
  CLOSURE_REQUESTED: 'Closure requested',
  CLOSURE_APPROVED: 'Closure approved',
  CLOSURE_REJECTED: 'Closure rejected',
  REOPENED: 'Case reopened',
}

// The closed reason-code vocabulary written into CaseLifecycleEvent.reasonCode.
export const LIFECYCLE_REASON_LABELS = {
  CASE_CREATED: 'Created by analyst',
  STATE_CHANGED_BY_ANALYST: 'Changed by analyst',
  CLOSURE_REQUESTED_BY_ANALYST: 'Requested by analyst',
  CLOSURE_APPROVED_BY_REVIEWER: 'Approved by reviewer',
  CLOSURE_REJECTED_BY_REVIEWER: 'Rejected by reviewer',
  REOPENED_MANUALLY: 'Reopened manually',
  REOPENED_BY_RECURRENCE: 'Reopened by recurrence',
}

export const RECURRENCE_OUTCOME_LABELS = {
  REOPENED: 'Reopened',
  SKIPPED_NOT_CLOSED: 'Skipped — case was not closed',
  SKIPPED_CLOSURE_REASON_NOT_REMEDIATED: 'Skipped — closure was not a remediation',
}

// The closed link-rejection vocabulary the backend returns as `code` on a 409.
// Rendered so an analyst is told what to FIX, not merely that it failed.
export const LINK_REJECTION_MESSAGES = {
  OWNERSHIP_MISSING: 'This finding has no ownership decision yet. Resolve its ownership first.',
  OWNERSHIP_UNRESOLVED:
    'This finding’s ownership is unresolved. Resolve or override its ownership first.',
  OWNERSHIP_AMBIGUOUS:
    'This finding’s ownership is ambiguous — more than one organization matched. Resolve it first.',
  OWNERSHIP_ISP_ATTRIBUTED:
    'This finding is attributed to an upstream provider, not a constituent. Override its ownership first.',
  OWNERSHIP_ORGANIZATION_MISMATCH:
    'This finding belongs to a different organization than this case.',
  CASE_NOT_ACCEPTING_EVIDENCE:
    'Evidence cannot be changed while the case is closed or awaiting closure review.',
  CASE_NOT_ORGANIZATION_BOUND:
    'This is a legacy case with no organization. Phase 3 workflow actions are unavailable on it.',
  CASE_NOT_OPEN_FOR_CLOSURE: 'Closure can only be requested for an open case.',
  CASE_NOT_CLOSURE_PENDING: 'This case is no longer awaiting closure review.',
  CASE_NOT_CLOSED: 'Only a closed case can be reopened.',
  CASE_CLOSED: 'Responses cannot be recorded on a closed case.',
  CASE_STATE_NOT_ANALYST_SETTABLE:
    'The case state cannot be changed while it is awaiting closure review or closed.',
  CLOSURE_REQUEST_NOT_PENDING: 'This closure request has already been decided.',
  CLOSURE_SELF_APPROVAL_FORBIDDEN:
    'The analyst who requested this closure may not approve it. A reviewer must decide.',
  CONCURRENT_STATE_CHANGE: 'Someone else changed this case. Refresh and try again.',
  LINK_NOT_ACTIVE: 'This finding is not currently linked to the case.',
  REMEDIATED_RESPONSE_REQUIRED:
    'A remediation closure requires a recorded REMEDIATED organization response first.',
}

/**
 * Renders a backend workflow error into something an analyst can act on.
 *
 * Prefers the closed `code` vocabulary over the server's message text, and
 * falls back to a generic line rather than surfacing an unrecognised string —
 * the server never sends raw database errors, but the frontend should not be
 * the thing that starts displaying whatever arrives.
 */
export function describeWorkflowError(error, fallback = 'The action could not be completed.') {
  const body = error?.response?.data
  if (body?.code && LINK_REJECTION_MESSAGES[body.code]) return LINK_REJECTION_MESSAGES[body.code]
  if (Array.isArray(body?.fields) && body.fields.length > 0) {
    return `Missing or invalid: ${body.fields.join(', ')}`
  }
  if (error?.response?.status === 403) return 'You do not have permission to do that.'
  if (error?.response?.status === 404) return 'Not found.'
  return fallback
}

export function formatInstant(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}
