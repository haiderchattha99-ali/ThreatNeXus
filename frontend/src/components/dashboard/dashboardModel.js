import {
  FiActivity,
  FiBarChart2,
  FiBriefcase,
  FiClock,
  FiFileText,
  FiShield,
  FiUploadCloud,
  FiUsers,
} from 'react-icons/fi'

export const ROLE_COPY = Object.freeze({
  ADMIN: {
    eyebrow: 'Administration / operational assurance',
    title: 'Operations control room',
    description: 'Unresolved risk, workflow pressure and stored provider evidence across the loaded dataset.',
  },
  ANALYST: {
    eyebrow: 'Analyst workspace / daily operations',
    title: 'Analyst operations',
    description: 'Start with the work that needs a decision, then move investigations and constituent follow-up forward.',
  },
  REVIEWER: {
    eyebrow: 'Reviewer workspace / independent decisions',
    title: 'Review operations',
    description: 'Resolve the oldest independent decisions first, with direct access to their case evidence.',
  },
  VIEWER: {
    eyebrow: 'Read-only oversight / operational picture',
    title: 'Operational picture',
    description: 'A factual, read-only view of evidence persisted in this ThreatNeXus instance.',
  },
})

export function metricFromQueue(queue) {
  return {
    value: queue?.total,
    availability: queue?.availability || 'UNAVAILABLE',
    source: queue?.source,
    asOf: queue?.asOf,
    reason: queue?.reason,
  }
}

export function roleMetrics(role, sections) {
  const findings = sections.findings
  const cases = sections.cases
  const findingQueues = sections.findingQueues
  const caseQueues = sections.caseQueues
  const notificationQueue = sections.notificationQueue
  const common = {
    open: { label: 'Open findings', metric: findings?.metrics?.open, hint: 'Unresolved', icon: FiShield, to: '/findings?status=OPEN' },
    persistent: { label: 'Persistent', metric: findings?.metrics?.persistent, hint: 'Seen repeatedly', icon: FiActivity, to: '/findings' },
    reports: { label: 'Reports recorded', metric: findings?.metrics?.reportsProcessed, hint: 'All ingestion outcomes', icon: FiUploadCloud, to: '/upload' },
  }

  if (role === 'REVIEWER') return [
    { label: 'Closure decisions', metric: metricFromQueue(caseQueues?.closureReview), hint: 'Oldest first', icon: FiBriefcase, to: '/cases' },
    { label: 'Notification reviews', metric: metricFromQueue(notificationQueue?.awaitingReview), hint: 'Awaiting review', icon: FiFileText, to: '/notifications' },
    { label: 'Waiting on orgs', metric: cases?.metrics?.waitingForOrganization, hint: 'Constituent input', icon: FiClock, to: '/cases' },
    common.open,
  ]

  if (role === 'ADMIN') return [
    common.open,
    { label: 'Not yet scored', metric: findings?.metrics?.unscored, hint: 'No current Risk v1', icon: FiActivity, to: '/findings' },
    { label: 'Awaiting triage', metric: metricFromQueue(findingQueues?.awaitingTriage), hint: 'Decision required', icon: FiClock, to: '/findings' },
    { label: 'Closure reviews', metric: metricFromQueue(caseQueues?.closureReview), hint: 'Independent review', icon: FiBriefcase, to: '/cases' },
  ]

  if (role === 'VIEWER') return [
    common.open,
    common.persistent,
    { ...common.reports, to: '/analytics' },
    { label: 'Open cases', metric: cases?.metrics?.open, hint: 'Active investigations', icon: FiBriefcase, to: '/cases' },
  ]

  return [
    common.open,
    { label: 'Awaiting triage', metric: metricFromQueue(findingQueues?.awaitingTriage), hint: 'Decision required', icon: FiClock, to: '/findings' },
    common.persistent,
    common.reports,
  ]
}

export function roleActions(role, sections) {
  const triageTotal = sections.findingQueues?.awaitingTriage?.total
  const closureTotal = sections.caseQueues?.closureReview?.total
  const notificationTotal = sections.notificationQueue?.awaitingReview?.total

  if (role === 'REVIEWER') return [
    { to: '/cases', label: 'Review closures', detail: `${closureTotal ?? 'Unavailable'} pending`, icon: FiBriefcase, primary: true },
    { to: '/notifications', label: 'Review notifications', detail: `${notificationTotal ?? 'Unavailable'} pending`, icon: FiFileText },
  ]
  if (role === 'ADMIN') return [
    { to: '/organizations', label: 'Organizations', detail: 'Constituent records', icon: FiUsers, primary: true },
    { to: '/analytics', label: 'Analytics', detail: 'Persisted distributions', icon: FiBarChart2 },
  ]
  if (role === 'VIEWER') return [
    { to: '/findings', label: 'Browse findings', detail: 'Read-only evidence', icon: FiShield, primary: true },
    { to: '/analytics', label: 'Analytics', detail: 'Persisted distributions', icon: FiBarChart2 },
  ]
  return [
    { to: '/findings', label: 'Triage findings', detail: `${triageTotal ?? 'Unavailable'} awaiting`, icon: FiShield, primary: true },
    { to: '/upload', label: 'Ingest report', detail: 'Add evidence', icon: FiUploadCloud },
  ]
}

export function mainQueueForRole(role, sections) {
  if (role === 'REVIEWER') return {
    title: 'Oldest closure requests', description: 'Independent decisions ordered oldest first.', queue: sections.caseQueues?.closureReview,
    kind: 'closure', shownLabel: 'closure requests', emptyLabel: 'No closure requests are waiting.', to: '/cases',
  }
  if (role === 'ANALYST') return {
    title: 'Findings awaiting triage', description: 'Repeated observations first, with the current stored Risk v1 shown when available.',
    queue: sections.findingQueues?.awaitingTriage, kind: 'finding', shownLabel: 'triage records', emptyLabel: 'No findings are awaiting triage.', to: '/findings',
  }
  return {
    title: role === 'ADMIN' ? 'Unresolved risk requiring attention' : 'Highest current Risk v1',
    description: role === 'ADMIN' ? 'Open findings ordered by current stored Risk v1 score.' : 'Read-only prioritization of open findings by current stored Risk v1 score.',
    queue: sections.findingQueues?.priority, kind: 'finding', shownLabel: 'scored rows', emptyLabel: 'No scored open findings are available.', to: '/findings',
  }
}

export const RISK_LABEL = Object.freeze({ CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', INFORMATIONAL: 'Informational' })
export const AGE_LABEL = Object.freeze({ LAST_24H: 'Last 24 hours', '1_7_DAYS': '1 to 7 days', '8_30_DAYS': '8 to 30 days', OVER_30_DAYS: 'Over 30 days' })
export const CASE_STATE = Object.freeze({
  OPEN: { label: 'Open', tone: 'info', icon: 'dot' },
  WAITING_FOR_ORG: { label: 'Waiting for organization', tone: 'warning', icon: 'clock' },
  CLOSURE_PENDING: { label: 'Closure pending review', tone: 'accent', icon: 'gavel' },
  CLOSED: { label: 'Closed', tone: 'neutral', icon: 'check' },
})
export const NOTIFICATION_STATE = Object.freeze({
  DRAFT: { label: 'Draft', tone: 'neutral', icon: 'edit' },
  PENDING_REVIEW: { label: 'Pending review', tone: 'warning', icon: 'clock' },
  APPROVED: { label: 'Approved', tone: 'success', icon: 'check' },
  REJECTED: { label: 'Rejected', tone: 'danger', icon: 'cross' },
})
// Risk v1 factor names now live in constants/riskFactors.js, beside the
// explanation-code sentences, because the Finding detail screen needs the same
// dictionary and two copies would drift. Re-exported here so every existing
// dashboard import keeps working.
export { RISK_FACTOR_LABEL } from '../../constants/riskFactors'

// How a factor's zero contribution should be read. The whole reason this
// panel exists is that these three are NOT the same thing, and a bar chart
// alone would render all three as an identical empty bar.
export const FACTOR_EVIDENCE_STATE = Object.freeze({
  CONTRIBUTING: { label: 'Contributing', tone: 'accent', icon: 'dot' },
  MEASURED_ZERO: { label: 'Measured, no weight', tone: 'neutral', icon: 'minus' },
  NO_EVIDENCE: { label: 'No evidence read', tone: 'warning', icon: 'warning' },
  NOT_APPLICABLE: { label: 'Cannot apply', tone: 'neutral', icon: 'minus' },
})

/**
 * Classifies one factor row into the four states above.
 *
 * Order matters: a factor that contributed basis points is CONTRIBUTING even if
 * some findings could not supply it, because the contribution is real.
 */
export function factorEvidenceState(factor) {
  if (!factor) return 'NOT_APPLICABLE'
  if (factor.contributionBasisPoints > 0) return 'CONTRIBUTING'
  if (factor.applied > 0) return 'MEASURED_ZERO'
  if (factor.notAvailable > 0) return 'NO_EVIDENCE'
  return 'NOT_APPLICABLE'
}

export const PROVIDER_STATE = Object.freeze({
  FRESH: { label: 'Fresh stored result', tone: 'success', icon: 'check' },
  STALE: { label: 'Stored result stale', tone: 'warning', icon: 'clock' },
  NO_SUCCESSFUL_LOOKUP_RECORDED: { label: 'No stored success', tone: 'neutral', icon: 'minus' },
})
