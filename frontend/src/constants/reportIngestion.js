// Presentation vocabulary for the canonical report-ingestion contract
// (POST /api/reports/upload).
//
// Mirrors backend/src/controllers/reportIngestionController.js's
// OUTCOME_RESPONSE map and backend/src/services/ingestion/
// reportIngestionService.js's INGESTION_OUTCOMES, the same convention
// constants/findingAiAssistance.js and constants/caseWorkflow.js already
// follow for their own backends. This is UX metadata only — the backend
// decides every outcome and re-validates everything itself.
//
// ---------------------------------------------------------------------------
// Why the HTTP status is read as the outcome, and why that is not "2xx == win"
// ---------------------------------------------------------------------------
// The controller does not place `outcome` in the response body, but it does
// map each member of the closed INGESTION_OUTCOMES set to exactly one
// distinct status. Reading the status is therefore reading the outcome, not
// guessing at it — and it is the opposite of inferring success from any 2xx:
// a 200 here means DUPLICATE_COMPLETED, i.e. these exact bytes were already
// ingested and NOTHING was recorded again. That is a materially different
// result from a 201 PROCESSED and must never be rendered as one.
//
// ---------------------------------------------------------------------------
// What is a backend ingestion outcome and what is not
// ---------------------------------------------------------------------------
// PROCESSED / DUPLICATE_COMPLETED / DUPLICATE_IN_PROGRESS / REJECTED /
// UNPROCESSABLE_NO_VALID_ROWS / FAILED are the backend's own vocabulary,
// spelled exactly as the service spells them. TOO_LARGE, RATE_LIMITED,
// DENIED and UNAVAILABLE are this screen's classification of refusals that
// happen BEFORE the ingestion pipeline is entered (multer's size limit, the
// upload rate-limit bucket, a capability refusal, an unreachable backend) —
// they are named separately rather than folded into REJECTED, because no
// report was ever evaluated in those cases and saying otherwise would be a
// fabricated ingestion result.

export const INGESTION_RESULTS = Object.freeze({
  PROCESSED: 'PROCESSED',
  DUPLICATE_COMPLETED: 'DUPLICATE_COMPLETED',
  DUPLICATE_IN_PROGRESS: 'DUPLICATE_IN_PROGRESS',
  REJECTED: 'REJECTED',
  UNPROCESSABLE_NO_VALID_ROWS: 'UNPROCESSABLE_NO_VALID_ROWS',
  FAILED: 'FAILED',
  TOO_LARGE: 'TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  DENIED: 'DENIED',
  UNAVAILABLE: 'UNAVAILABLE',
})

// One status per outcome, taken from the controller's own OUTCOME_RESPONSE
// table plus the three refusals errorHandler.js / rateLimit.js can return on
// this route. 401 is deliberately absent: the shared axios interceptor treats
// it as session expiry and returns to sign-in, so this screen never renders a
// state for it.
const STATUS_TO_RESULT = Object.freeze({
  201: INGESTION_RESULTS.PROCESSED,
  200: INGESTION_RESULTS.DUPLICATE_COMPLETED,
  409: INGESTION_RESULTS.DUPLICATE_IN_PROGRESS,
  400: INGESTION_RESULTS.REJECTED,
  422: INGESTION_RESULTS.UNPROCESSABLE_NO_VALID_ROWS,
  500: INGESTION_RESULTS.FAILED,
  413: INGESTION_RESULTS.TOO_LARGE,
  429: INGESTION_RESULTS.RATE_LIMITED,
  403: INGESTION_RESULTS.DENIED,
})

// The two outcomes under which the file's evidence is on record. Only these
// render persisted facts; every other result renders none, because there are
// none to render.
export const EVIDENCE_ON_RECORD = Object.freeze([
  INGESTION_RESULTS.PROCESSED,
  INGESTION_RESULTS.DUPLICATE_COMPLETED,
])

// StatusBadge dictionary — see components/ui/StatusBadge.jsx. Every result
// carries a colour AND a word AND an icon, so an outcome is never
// communicated by colour alone.
export const INGESTION_RESULT_STATUS = Object.freeze({
  PROCESSED: { label: 'Processed', tone: 'success', icon: 'check' },
  DUPLICATE_COMPLETED: { label: 'Already ingested', tone: 'neutral', icon: 'repeat' },
  DUPLICATE_IN_PROGRESS: { label: 'Already being processed', tone: 'warning', icon: 'clock' },
  REJECTED: { label: 'Rejected', tone: 'danger', icon: 'cross' },
  UNPROCESSABLE_NO_VALID_ROWS: { label: 'No valid rows', tone: 'warning', icon: 'minus' },
  FAILED: { label: 'Processing failed', tone: 'danger', icon: 'warning' },
  TOO_LARGE: { label: 'File too large', tone: 'warning', icon: 'minus' },
  RATE_LIMITED: { label: 'Too many uploads', tone: 'warning', icon: 'clock' },
  DENIED: { label: 'Access refused', tone: 'neutral', icon: 'lock' },
  UNAVAILABLE: { label: 'Could not reach the backend', tone: 'neutral', icon: 'question' },
})

// The result headline, rendered as the panel's own heading. "Report
// processed" now appears for a 201 PROCESSED and for nothing else — under the
// legacy contract it was shown for every 2xx, including replays that recorded
// nothing.
export const INGESTION_RESULT_HEADLINES = Object.freeze({
  PROCESSED: 'Report processed',
  DUPLICATE_COMPLETED: 'Already ingested',
  DUPLICATE_IN_PROGRESS: 'Already being processed',
  REJECTED: 'Report rejected',
  UNPROCESSABLE_NO_VALID_ROWS: 'No valid rows to record',
  FAILED: 'Processing failed',
  TOO_LARGE: 'File too large',
  RATE_LIMITED: 'Too many uploads',
  DENIED: 'Access refused',
  UNAVAILABLE: 'Backend unavailable',
})

// This screen's own prose for every result, written here rather than taken
// from the response. The controller's messages are fixed safe constants
// today, but a proxy, a load balancer or a future handler is not bound by
// that — rendering our own copy means no server-supplied free text can reach
// the DOM through this page at all. The bounded `reason` CODE below is the
// one server-supplied value that is shown, and it is shape-checked first.
export const INGESTION_RESULT_NOTES = Object.freeze({
  PROCESSED:
    'The file was parsed, its rows validated, and its evidence recorded. The finding lifecycle results below are what the backend actually persisted.',
  DUPLICATE_COMPLETED:
    'These exact bytes were already ingested. Nothing was recorded a second time and no finding changed — the report below is the one already on file.',
  DUPLICATE_IN_PROGRESS:
    'These exact bytes are being processed right now by another attempt. Nothing was recorded twice. Check the findings shortly rather than uploading again.',
  REJECTED:
    'The backend refused the file before recording anything. No report, no evidence rows and no finding were created.',
  UNPROCESSABLE_NO_VALID_ROWS:
    'The file parsed, but no row produced a valid observation. Nothing was recorded — a report needs at least one valid row to become evidence.',
  FAILED:
    'Processing failed partway through. Any evidence already committed is kept as-is; re-uploading the same file resumes the attempt rather than duplicating it.',
  TOO_LARGE: 'The file exceeds the size the server accepts. Nothing was uploaded.',
  RATE_LIMITED:
    'This account has uploaded too many reports in the current window. Nothing was recorded. Wait for the window to reset and try again.',
  DENIED:
    'Your role does not hold the capability to ingest reports. The server refused the request; you are still signed in and nothing was recorded.',
  UNAVAILABLE:
    'The upload did not reach a backend that could answer. Nothing was recorded. Check the connection and try again.',
})

/**
 * Classifies an ingestion response or an axios failure into exactly one
 * closed result key. An unrecognised or absent status becomes UNAVAILABLE
 * rather than an optimistic success.
 *
 * @param {number|undefined|null} status
 * @returns {string} a member of INGESTION_RESULTS
 */
export function classifyIngestionStatus(status) {
  return STATUS_TO_RESULT[status] || INGESTION_RESULTS.UNAVAILABLE
}

// The backend surfaces structural rejection reasons as a bounded, closed
// code (`reason`) precisely so a caller can show WHY without echoing parser
// or validator text. Anything not of that shape is dropped rather than
// rendered, so no raw upstream body, stack trace, filesystem path, uploaded
// row content or provider text can reach the DOM through this path.
const SAFE_REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/

export function safeReasonCode(data) {
  const reason = data && data.reason
  return typeof reason === 'string' && SAFE_REASON_CODE.test(reason) ? reason : null
}

/**
 * The persisted report facts worth showing, read only from the fields
 * reportIngestionService.js's own reportSummary() returns. Never computed,
 * never defaulted to zero: a field the backend did not send is omitted, not
 * invented.
 *
 * sourceFileSha256 is the normalized file identity the idempotency decision
 * is made on — shown truncated, as the visible proof that re-uploading the
 * same bytes is recognised as the same report rather than a new one.
 */
export function reportFacts(report) {
  if (!report || typeof report !== 'object') return []

  const facts = [
    ['Report reference', report.id],
    ['Report status', report.status],
    ['File identity (sha256)', typeof report.sourceFileSha256 === 'string' ? `${report.sourceFileSha256.slice(0, 12)}…` : null],
    ['Rows read', report.totalRows],
    ['Rows accepted', report.validRows],
    ['Rows rejected', report.invalidRows],
    ['Processing attempts', report.processingAttempts],
  ]

  return facts.filter(([, value]) => value !== null && value !== undefined && value !== '')
}

// Lifecycle actions dedupService.js can return, in the order an analyst reads
// them. Used to label findingCounts without reformatting the backend's keys
// into something it never said.
export const FINDING_LIFECYCLE_LABELS = Object.freeze({
  CREATED: 'New findings created',
  PERSISTED: 'Existing findings still exposed',
  RECURRED: 'Findings that recurred after closure',
  HISTORICAL: 'Older observations recorded',
})
