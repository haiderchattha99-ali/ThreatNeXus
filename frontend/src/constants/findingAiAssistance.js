// Presentation vocabulary for the Phase 8C Finding AI-assistance panel.
//
// Mirrors backend/src/services/aiAssist/aiAssistRules.js verbatim, the same
// convention constants/frameworkMapping.js follows for Phase 5. This is UX
// metadata only — the backend validates every one of these values itself.
//
// ---------------------------------------------------------------------------
// The language here is load-bearing, not decoration
// ---------------------------------------------------------------------------
// A draft is a suggestion, never a fact about the Finding. Every label below
// is worded so a screenshot of this panel cannot be read as an authoritative
// finding change — there is no "AI closed this", no fabricated confidence,
// and accepting a draft is described as recording a human decision, not as
// the system doing something on its own.

export const SUGGESTION_TYPES = { SUMMARY: 'SUMMARY', EXPLANATION: 'EXPLANATION' }

export const SUGGESTION_TYPE_LABELS = {
  SUMMARY: 'Summary draft',
  EXPLANATION: 'Explanation draft',
}

export const SUGGESTION_TYPE_HINTS = {
  SUMMARY: 'A short, plain-language summary of this finding.',
  EXPLANATION: 'A longer explanation of why this finding looks the way it does.',
}

// StatusBadge dictionary — see components/ui/StatusBadge.jsx. Every status
// carries a colour AND a word AND an icon, so it is never carried by colour
// alone.
export const FINDING_AI_SUGGESTION_STATUS = Object.freeze({
  DRAFT: { label: 'Draft — awaiting your decision', tone: 'accent', icon: 'edit' },
  ACCEPTED: { label: 'Accepted', tone: 'success', icon: 'check' },
  REJECTED: { label: 'Rejected', tone: 'neutral', icon: 'cross' },
  // Reached only when a human attempts to accept a draft whose Finding
  // evidence has changed since it was generated — never by a background job.
  EXPIRED: { label: 'Expired — finding evidence has changed', tone: 'warning', icon: 'clock' },
})

// Closed reason codes the backend returns. Rendered as sentences so an
// analyst is told what happened rather than shown an enum.
export const SUGGESTION_REASON_LABELS = {
  AI_DISABLED: 'AI assistance is disabled. No provider was contacted.',
  AI_PROVIDER_NOT_AVAILABLE:
    'AI assistance is enabled but no approved provider is configured. No provider was contacted.',
  SUGGESTION_GENERATED: 'A draft was generated for your review.',
  PROVIDER_FAILED: 'The assistant could not be reached or returned an error. Nothing was recorded.',
  PROVIDER_MALFORMED_RESULT:
    'The assistant returned output this system could not read. Nothing was recorded.',
}

export const AI_DISABLED_MESSAGE = 'AI assistance is disabled.'

export const AI_DISABLED_DETAIL =
  'ThreatNeXus ships with AI assistance switched off. This finding, its risk score, its triage ' +
  'state and every workflow around it work exactly the same without it. When it is on, it only ' +
  'ever proposes a draft for you to accept or reject; it cannot change this finding, close it, ' +
  'or decide anything on its own.'

export const AI_UNAVAILABLE_DETAIL =
  'AI assistance is enabled but no approved provider is configured, so no draft can be generated ' +
  'right now. This is a configuration state, not a broken feature.'

// Shown wherever a draft is displayed.
export const AI_ADVISORY_NOTE =
  'This is a draft, not a finding change. Nothing here is applied to this finding until you ' +
  'accept it, and accepting only records that a named analyst reviewed and endorsed the text — ' +
  'it never closes, scores or reclassifies anything.'

export const STALE_SUGGESTION_NOTE =
  'The evidence on this finding has changed since this draft was generated, so it can no longer ' +
  'be accepted. Request a fresh draft against the finding as it now stands.'

// The closed, allow-listed labels a draft may cite as the evidence it used —
// mirrors backend EVIDENCE_REFERENCE_FIELDS exactly.
export const EVIDENCE_REFERENCE_LABELS = {
  reportType: 'Report type',
  triageDecision: 'Triage decision',
  riskBand: 'Risk band',
  riskExplanation: 'Risk explanation',
  analystVerifiedCveIds: 'Analyst-verified CVEs',
  requestContext: 'What you asked the assistant to focus on',
}

export const AI_SUGGESTION_ERROR_MESSAGES = {
  SUGGESTION_STALE: STALE_SUGGESTION_NOTE,
  SUGGESTION_NOT_FOR_FINDING: 'That draft belongs to a different finding.',
}

export function describeAiAssistError(error) {
  const data = error?.response?.data
  if (!data) return 'Something went wrong. Please try again.'
  if (data.code && AI_SUGGESTION_ERROR_MESSAGES[data.code]) {
    return AI_SUGGESTION_ERROR_MESSAGES[data.code]
  }
  if (typeof data.message === 'string' && data.message.trim() !== '') return data.message
  if (Array.isArray(data.fields) && data.fields.length > 0) {
    return `Check these fields: ${data.fields.join(', ')}`
  }
  return 'Something went wrong. Please try again.'
}
