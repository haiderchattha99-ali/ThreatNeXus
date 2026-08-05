// Presentation vocabulary for the Phase 4 notification workflow.
//
// Mirrors backend/src/services/notification/notificationRules.js verbatim.
// Like constants/capabilities.js this is UX metadata only — the backend
// validates every one of these values itself and refuses anything outside its
// own closed vocabulary, whatever this file says.
//
// The colours deliberately distinguish "being written" (blue) from "awaiting a
// human decision" (violet) from "cleared to send" (green) from "sent back"
// (red), so a notification sitting in PENDING_REVIEW never reads as approved.

export const NOTIFICATION_STATES = {
  DRAFT: 'DRAFT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
}

export const NOTIFICATION_STATE_OPTIONS = ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED']

export const NOTIFICATION_STATE_LABELS = {
  DRAFT: 'Draft',
  PENDING_REVIEW: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
}

export const NOTIFICATION_STATE_COLORS = {
  DRAFT: '#5AB6D9',
  PENDING_REVIEW: '#c08cff',
  APPROVED: '#35C477',
  REJECTED: '#F2617A',
}

export const DELIVERY_STATUS_OPTIONS = [
  'SENT_MANUALLY',
  'DELIVERED',
  'FAILED',
  'BOUNCED',
  'UNKNOWN',
]

export const DELIVERY_STATUS_LABELS = {
  SENT_MANUALLY: 'Sent manually',
  DELIVERED: 'Delivered',
  FAILED: 'Failed',
  BOUNCED: 'Bounced',
  UNKNOWN: 'Unknown',
}

export const DELIVERY_STATUS_COLORS = {
  SENT_MANUALLY: '#5AB6D9',
  DELIVERED: '#35C477',
  FAILED: '#F2617A',
  BOUNCED: '#E8A33D',
  UNKNOWN: '#7C8AA0',
}

export const EXPORT_FORMAT_OPTIONS = ['EML', 'TXT']

export const EXPORT_FORMAT_LABELS = {
  EML: 'Email message (.eml)',
  TXT: 'Plain text (.txt)',
}

export const LIFECYCLE_EVENT_LABELS = {
  DRAFT_CREATED: 'Draft created',
  REVISION_CREATED: 'Revision created',
  SUBMITTED_FOR_REVIEW: 'Submitted for review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  EXPORTED: 'Exported',
  DELIVERY_RECORDED: 'Delivery recorded',
}

// The closed reason-code vocabulary written into
// NotificationLifecycleEvent.reasonCode.
export const LIFECYCLE_REASON_LABELS = {
  DRAFT_CREATED_FROM_CASE: 'Drafted from case evidence',
  REVISION_EDITED: 'Edited by analyst',
  REVISION_EDITED_AFTER_APPROVAL: 'Edited after approval — approval invalidated',
  REVISION_EDITED_AFTER_REJECTION: 'Edited after rejection',
  SUBMITTED_BY_ANALYST: 'Submitted by analyst',
  APPROVED_BY_REVIEWER: 'Approved by reviewer',
  REJECTED_BY_REVIEWER: 'Rejected by reviewer',
  EXPORTED_MANUALLY: 'Exported manually',
  DELIVERY_OBSERVED: 'Delivery observed',
}

// The closed export-refusal vocabulary the backend returns as `code` on a 409,
// and as `permittedActions.exportRefusalCode` on every read.
//
// Rendered so an analyst is told what to FIX, not merely that it failed. This
// is the whole reason the backend publishes a code rather than a message.
export const EXPORT_REFUSAL_MESSAGES = {
  NOTIFICATION_NOT_WORKFLOW_BOUND:
    'This is a legacy notification with no case. Phase 4 actions are unavailable on it.',
  NOTIFICATION_NOT_APPROVED:
    'Only an approved notification can be exported. Submit it for review and have a reviewer approve it.',
  APPROVAL_MISSING: 'This notification has no recorded approval.',
  APPROVAL_NOT_FOR_CURRENT_REVISION:
    'It was edited after it was approved, so the approval no longer covers the current revision. It must be reviewed again.',
  APPROVER_MISSING:
    'The approval has no approving user recorded, so it cannot authorize an export.',
  REVISION_CHECKSUM_MISMATCH:
    'The stored content no longer matches what was approved. It must be reviewed again.',
  CASE_BINDING_CHANGED:
    'The notification is no longer attached to the case it was approved against.',
  RECIPIENT_MISSING:
    'There is no valid recipient address on this revision. Add one and have it reviewed.',
}

// Every closed code the notification routes can return on a 4xx, rendered as
// advice. Falls back to the export vocabulary above, which shares the surface.
export const NOTIFICATION_ERROR_MESSAGES = {
  ...EXPORT_REFUSAL_MESSAGES,
  NOTIFICATION_UNDER_REVIEW:
    'This notification is being reviewed and cannot be edited. A reviewer must approve or reject it first.',
  NOTIFICATION_NOT_EDITABLE: 'This notification cannot be edited in its current state.',
  NOTIFICATION_NOT_SUBMITTABLE: 'Only a draft can be submitted for review.',
  NOTIFICATION_NOT_PENDING_REVIEW: 'This notification is not awaiting review.',
  NOTIFICATION_NO_CURRENT_REVISION: 'This notification has no current revision.',
  NOTIFICATION_NOT_EXPORTED:
    'A delivery can only be recorded after the notification has been exported.',
  NOTIFICATION_SELF_APPROVAL_FORBIDDEN:
    'The analyst who wrote or submitted this revision may not approve it. A different reviewer must decide.',
  NOTIFICATION_DELETION_NOT_SUPPORTED:
    'Notifications cannot be deleted — their approval and export history is evidence.',
  EXPORT_NOT_FOR_NOTIFICATION: 'That export belongs to a different notification.',
  CONCURRENT_STATE_CHANGE: 'Someone else changed this notification. Refresh and try again.',
  CASE_NOT_ORGANIZATION_BOUND:
    'This is a legacy case with no organization. A notification cannot be drafted from it.',
  CASE_CLOSED: 'A notification cannot be drafted from a closed case.',
  ARTIFACT_FIELD_INVALID:
    'The approved content cannot be rendered into an export artifact. Check the subject and recipient fields.',
}

/**
 * Renders a backend notification error into something an analyst can act on.
 *
 * Prefers the closed `code` vocabulary over the server's message text, and
 * falls back to a generic line rather than surfacing an unrecognised string —
 * the server never sends raw database errors, but the frontend should not be
 * the thing that starts displaying whatever arrives.
 */
export function describeNotificationError(
  error,
  fallback = 'The action could not be completed.',
) {
  const body = error?.response?.data
  if (body?.code && NOTIFICATION_ERROR_MESSAGES[body.code]) {
    return NOTIFICATION_ERROR_MESSAGES[body.code]
  }
  if (Array.isArray(body?.fields) && body.fields.length > 0) {
    return `Missing or invalid: ${body.fields.join(', ')}`
  }
  if (error?.response?.status === 403) return 'You do not have permission to do that.'
  if (error?.response?.status === 404) return 'Not found.'
  return fallback
}

/** Renders permittedActions.exportRefusalCode as a sentence, or null. */
export function describeExportRefusal(code) {
  if (!code) return null
  return EXPORT_REFUSAL_MESSAGES[code] || 'This notification cannot currently be exported.'
}

export function formatInstant(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/** A short, readable form of the 64-character content/artifact checksum. */
export function shortChecksum(value) {
  if (typeof value !== 'string' || value.length < 12) return '—'
  return `${value.slice(0, 12)}…`
}
