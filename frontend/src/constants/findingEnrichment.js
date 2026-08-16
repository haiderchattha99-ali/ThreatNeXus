// Phase 10B — the analyst-facing labels for the Phase 10 enrichment
// orchestration read model (`docs/ai/PHASE-10A1-API-CONTRACT.md`).
//
// This file exists so FindingEnrichmentPanel.jsx never invents a label from a
// raw backend code. Every vocabulary here mirrors a CLOSED enum the backend
// serializes (`backend/src/services/enrichmentOrchestration/
// enrichmentDecisionCodes.js`, `enrichmentSubject.js`) — an unmapped value
// falls back to StatusBadge's own raw-value fallback, which is deliberately
// ugly rather than silently hidden (see StatusBadge.jsx).
//
// The one rule every dictionary here obeys: no state is ever rendered as a
// clean "nothing to see" result unless the backend actually said COMPLETED
// with fresh evidence. NOT_REQUESTED, PENDING, SKIPPED and UNAVAILABLE each
// get their own distinct label and tone — collapsing any of them into the
// same look is the exact failure this panel exists to prevent.

// GET /api/findings/:id/enrichment/summary → providers[].status
export const ENRICHMENT_SUMMARY_STATUS = Object.freeze({
  NO_SUBJECT: { label: 'No subject on this finding', tone: 'neutral', icon: 'minus' },
  NOT_REQUESTED: { label: 'Not requested', tone: 'neutral', icon: 'dot' },
  PENDING: { label: 'Pending', tone: 'info', icon: 'clock' },
  // A real, positive answer with retrievable evidence.
  COMPLETED: { label: 'Lookup completed', tone: 'success', icon: 'check' },
  // The provider was queried and had nothing on file — a real terminal
  // answer, but never rendered with the same look as COMPLETED, which would
  // overclaim that evidence exists.
  NO_RECORD: { label: 'Nothing on file', tone: 'neutral', icon: 'dot' },
  // A recognized provider rate limit — distinct from a generic failure
  // because the right analyst action (wait, then retry) differs.
  RATE_LIMITED: { label: 'Rate limited', tone: 'warning', icon: 'clock' },
  // The request was sent and no durable answer followed. May have been
  // charged; never auto-retried; requires manual review.
  AMBIGUOUS: { label: 'Ambiguous — needs manual review', tone: 'warning', icon: 'warning' },
  UNAVAILABLE: { label: 'Unavailable', tone: 'danger', icon: 'cross' },
  SKIPPED: { label: 'Skipped', tone: 'warning', icon: 'minus' },
})

// Run-item `decision` — the coarse routing outcome of one (provider, subject)
// pair on a specific request. Distinct from `status` above: a decision is
// recorded once, at request time, and never changes; a summary status can
// move forward as the shared job progresses.
export const ENRICHMENT_ITEM_DECISION = Object.freeze({
  ELIGIBLE: { label: 'Recorded', tone: 'info', icon: 'dot' },
  SKIPPED_CACHED: { label: 'Skipped', tone: 'neutral', icon: 'minus' },
  SKIPPED_DISABLED: { label: 'Skipped', tone: 'neutral', icon: 'power' },
  SKIPPED_NOT_CONFIGURED: { label: 'Skipped', tone: 'neutral', icon: 'minus' },
  SKIPPED_NOT_APPLICABLE: { label: 'Skipped', tone: 'neutral', icon: 'minus' },
  SKIPPED_UNSUPPORTED_SUBJECT: { label: 'Skipped', tone: 'neutral', icon: 'minus' },
  SKIPPED_BUDGET: { label: 'Skipped', tone: 'warning', icon: 'clock' },
  SKIPPED_EXECUTION_UNAVAILABLE: { label: 'Skipped', tone: 'warning', icon: 'warning' },
})

// skipReason — the closed, detailed refusal code. Appears on a summary row
// (SKIPPED status) and on a run item (non-ELIGIBLE decision). One label per
// REASON, never per provider — the provider is already shown separately.
export const SKIP_REASON_LABELS = Object.freeze({
  PROVIDER_DISABLED: 'Provider disabled by configuration',
  PROVIDER_NOT_CONFIGURED: 'No credential configured for this provider',
  FRESH_RESULT_EXISTS: 'A fresh result already exists',
  PROVIDER_SUBJECT_MISMATCH: 'This provider does not accept this subject type',
  NO_SUBJECT_FOR_PROVIDER: 'No qualifying subject on this finding',
  // "Set to zero" — a configuration value, never attempted. "Exhausted" is
  // reserved for EXECUTION_BUDGET_EXHAUSTED below, which means an
  // already-created job's own reservation was refused at execution time.
  AUTOMATIC_BUDGET_ZERO: 'Automatic daily budget is set to zero',
  MANUAL_BUDGET_ZERO: 'Manual daily budget is set to zero',
  EXECUTION_NOT_IMPLEMENTED: 'Execution is not available in this deployment',
  DELEGATE_BATCH_REQUIRED: 'Requires the administrator vulnerability batch',
  DELEGATE_UNAVAILABLE: 'Could not be scheduled',
  // Execution-time skips: the item was recorded ELIGIBLE, and the refusal
  // happened once its job (or IOC delegate) actually reached execution —
  // distinct from the routing-time codes above, which mean the item was
  // never recorded ELIGIBLE at all.
  EXECUTION_DISABLED: 'Provider was disabled by the time this job ran',
  EXECUTION_NOT_CONFIGURED: 'No credential was configured by the time this job ran',
  EXECUTION_UNSUPPORTED_SUBJECT: 'This subject was unsupported once execution reached it',
  EXECUTION_BUDGET_EXHAUSTED: "This job's budget reservation was refused at execution time",
})

// source — WHICH stored record answered a summary row. Shown as a short
// provenance caption so an analyst can tell canonical IOC/vulnerability
// evidence apart from a Phase-10 orchestration job that has not resolved yet.
export const SUMMARY_SOURCE_LABELS = Object.freeze({
  NONE: null,
  ORCHESTRATION_JOB: 'orchestration job',
  IOC_ENRICHMENT: 'IOC reputation cache',
  VULNERABILITY_ENRICHMENT: 'vulnerability batch',
})

// purpose — what a provider is asked for. IOC_REPUTATION and VULNERABILITY
// are deliberately separate paths in this system; EXPOSURE is what a scan
// observed, never proof an attacker used it.
export const PROVIDER_PURPOSE_LABELS = Object.freeze({
  IOC_REPUTATION: 'IP reputation',
  EXPOSURE: 'Exposure / scan data',
  VULNERABILITY: 'Vulnerability',
})

export const PROVIDER_LABELS = Object.freeze({
  abuseipdb: 'AbuseIPDB',
  censys: 'Censys',
  greynoise: 'GreyNoise',
  netlas: 'Netlas',
  nvd: 'NVD',
  shodan: 'Shodan',
})

// executionState — a deployment-level fact about whether a worker exists to
// pick recorded work up at all. Never implied by `outcome`: "recorded" is not
// "executed".
export const EXECUTION_STATE_COPY = Object.freeze({
  PAUSED_WORKER_DISABLED: {
    label: 'Execution paused',
    detail: 'The enrichment worker is disabled on this deployment. Requests are recorded but nothing will be looked up until an administrator enables it.',
  },
  ACTIVE: {
    label: 'Execution active',
    detail: 'The enrichment worker will pick up eligible, recorded work.',
  },
})

// outcome — the closed result of one POST /enrichment/runs request.
export const RUN_OUTCOME_COPY = Object.freeze({
  CREATED: 'A new enrichment request was recorded.',
  ALREADY_RUNNING: 'This finding already has an open request — showing it below.',
  SKIPPED: 'A request was recorded, but every provider was refused by policy — see the reasons below.',
})

// A JOB_STATES value is already a readable word once its underscores become
// spaces; the vocabulary is closed on the backend (enrichmentDecisionCodes.js
// JOB_STATES) and any future addition should still read sensibly here without
// this file needing a matching edit.
export function formatJobState(state) {
  if (!state) return 'Not yet queued'
  return state
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function describeEnrichmentError(error) {
  const data = error?.response?.data
  if (!data) return 'Something went wrong. Please try again.'
  if (typeof data.message === 'string' && data.message.trim() !== '') return data.message
  return 'Something went wrong. Please try again.'
}
