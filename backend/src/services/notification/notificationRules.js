"use strict";

// Pure, dependency-free rules for the Phase 4 notification workflow.
//
// Nothing in this module touches Prisma, the wall clock, HTTP or the audit
// trail. Every service in services/notification/ validates through here BEFORE
// it opens a transaction, so an out-of-contract request is a controlled 400 at
// the boundary rather than a database enum error several layers down — the
// same convention as workflow/caseWorkflowRules.js and risk/riskConfiguration.js.
//
// ---------------------------------------------------------------------------
// Two properties in this file are load-bearing for security, not tidiness
// ---------------------------------------------------------------------------
// 1. SINGLE-LINE FIELDS REJECT CONTROL CHARACTERS.
//    subject, recipientName, recipientEmail and every bounded reference become
//    RFC 5322 header values in the exported artifact. A stored CR or LF would
//    let an analyst (or anyone who reached the edit endpoint) inject arbitrary
//    headers — a Bcc, a second To, or a premature blank line that turns the
//    rest of the "header" into body. The guard lives at WRITE time so such a
//    value can never be stored at all; the export builder re-checks anyway,
//    because a defence that exists in one place is a defence one refactor away
//    from being gone.
//
// 2. THE CONTENT CHECKSUM IS COMPUTED FROM CONTENT ALONE.
//    Canonical, field-ordered, and deliberately free of row ids, timestamps,
//    actor identity, database row order, secrets and any uncontrolled error
//    text. That is what lets the export guard re-verify at export time that
//    the bytes it is about to build still correspond to what a reviewer
//    approved, and what lets an identical edit be recognised as a no-op.

const crypto = require("crypto");

// --- Lifecycle ---------------------------------------------------------------

const NOTIFICATION_STATES = Object.freeze({
  DRAFT: "DRAFT",
  PENDING_REVIEW: "PENDING_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
});

const NOTIFICATION_STATE_VALUES = Object.freeze(Object.values(NOTIFICATION_STATES));

// The states an edit may start from.
//
// PENDING_REVIEW is deliberately EXCLUDED. Editing while a reviewer is
// deciding would change the content out from under them — the same class of
// defect Phase 3 found when an analyst could withdraw a pending closure by
// posting a bare target state (see STATUS.md D-P3-a). The recovery path is the
// reviewer's: they reject, and the analyst then edits into a new DRAFT.
// APPROVED and REJECTED ARE editable, and an edit from either returns the
// notification to DRAFT and destroys the approval projection.
const EDITABLE_STATES = Object.freeze([
  NOTIFICATION_STATES.DRAFT,
  NOTIFICATION_STATES.APPROVED,
  NOTIFICATION_STATES.REJECTED,
]);

// Only a DRAFT may be submitted. A resubmission after rejection is therefore
// impossible without an intervening edit, which is intended: sending the exact
// same revision back to the reviewer who just rejected it is not a workflow.
const SUBMITTABLE_STATES = Object.freeze([NOTIFICATION_STATES.DRAFT]);

// Only a PENDING_REVIEW notification may be approved or rejected. A reviewer
// cannot approve a DRAFT nobody submitted, and cannot re-decide a decision.
const REVIEWABLE_STATES = Object.freeze([NOTIFICATION_STATES.PENDING_REVIEW]);

const LIFECYCLE_EVENT_TYPES = Object.freeze({
  DRAFT_CREATED: "DRAFT_CREATED",
  REVISION_CREATED: "REVISION_CREATED",
  SUBMITTED_FOR_REVIEW: "SUBMITTED_FOR_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  EXPORTED: "EXPORTED",
  DELIVERY_RECORDED: "DELIVERY_RECORDED",
});

// Closed machine-readable vocabulary written into
// NotificationLifecycleEvent.reasonCode. Never free text, never an exception
// message.
const LIFECYCLE_REASON_CODES = Object.freeze({
  DRAFT_CREATED_FROM_CASE: "DRAFT_CREATED_FROM_CASE",
  REVISION_EDITED: "REVISION_EDITED",
  REVISION_EDITED_AFTER_APPROVAL: "REVISION_EDITED_AFTER_APPROVAL",
  REVISION_EDITED_AFTER_REJECTION: "REVISION_EDITED_AFTER_REJECTION",
  SUBMITTED_BY_ANALYST: "SUBMITTED_BY_ANALYST",
  APPROVED_BY_REVIEWER: "APPROVED_BY_REVIEWER",
  REJECTED_BY_REVIEWER: "REJECTED_BY_REVIEWER",
  EXPORTED_MANUALLY: "EXPORTED_MANUALLY",
  DELIVERY_OBSERVED: "DELIVERY_OBSERVED",
});

// --- Export / delivery vocabularies -----------------------------------------

const EXPORT_FORMATS = Object.freeze({ EML: "EML", TXT: "TXT" });
const EXPORT_FORMAT_VALUES = Object.freeze(Object.values(EXPORT_FORMATS));
const DEFAULT_EXPORT_FORMAT = EXPORT_FORMATS.EML;

const DELIVERY_STATUSES = Object.freeze({
  SENT_MANUALLY: "SENT_MANUALLY",
  DELIVERED: "DELIVERED",
  FAILED: "FAILED",
  BOUNCED: "BOUNCED",
  UNKNOWN: "UNKNOWN",
});

const DELIVERY_STATUS_VALUES = Object.freeze(Object.values(DELIVERY_STATUSES));

// Closed vocabulary for why an export was refused. Returned to the caller so
// an analyst is told what to fix ("submit it for review first", "it was edited
// after approval"), without any of it being free text a database error could
// leak into. Every one of these creates NO export row.
const EXPORT_REFUSAL_CODES = Object.freeze({
  NOTIFICATION_NOT_WORKFLOW_BOUND: "NOTIFICATION_NOT_WORKFLOW_BOUND",
  NOTIFICATION_NOT_APPROVED: "NOTIFICATION_NOT_APPROVED",
  APPROVAL_MISSING: "APPROVAL_MISSING",
  APPROVAL_NOT_FOR_CURRENT_REVISION: "APPROVAL_NOT_FOR_CURRENT_REVISION",
  APPROVER_MISSING: "APPROVER_MISSING",
  REVISION_CHECKSUM_MISMATCH: "REVISION_CHECKSUM_MISMATCH",
  CASE_BINDING_CHANGED: "CASE_BINDING_CHANGED",
  RECIPIENT_MISSING: "RECIPIENT_MISSING",
});

// --- Bounded text limits -----------------------------------------------------
//
// Every analyst-authored string in this phase is trimmed and length-capped
// here before it can reach the database, an API response, an exported artifact
// or (as a length only) an audit reason.

const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 20000;
const MAX_REMEDIATION_GUIDANCE_LENGTH = 5000;
const MAX_RECIPIENT_NAME_LENGTH = 200;
const MAX_RECIPIENT_EMAIL_LENGTH = 254;
const MAX_ANALYST_NOTES_LENGTH = 2000;
const MAX_REVIEW_NOTE_LENGTH = 1000;
const MAX_REJECTION_REASON_LENGTH = 1000;
const MAX_DELIVERY_REFERENCE_LENGTH = 256;
const MAX_DELIVERY_NOTE_LENGTH = 1000;

// --- Errors ------------------------------------------------------------------

class NotificationValidationError extends Error {
  constructor(message, fields) {
    super(message);
    this.name = "NotificationValidationError";
    this.fields = Array.isArray(fields) ? fields : [];
  }
}

class NotificationNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotificationNotFoundError";
  }
}

// A legitimate request that the current durable state refuses (wrong lifecycle
// state, nothing to approve, an export that is not eligible). Distinct from a
// validation error because the caller's input was well formed — controllers
// map it to 409, never 400.
class NotificationStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "NotificationStateError";
    this.code = typeof code === "string" ? code : null;
  }
}

// The submitter/author may not approve their own revision unless they hold the
// administrator self-approval capability. A dedicated error class so the
// controller can answer 403 without inspecting any message text.
class NotificationSelfApprovalError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotificationSelfApprovalError";
  }
}

// Export refused by the guard. Carries a closed EXPORT_REFUSAL_CODES value.
// Separate from NotificationStateError so the controller can answer a distinct
// status and so no caller can conflate "not exportable" with "bad request".
class NotificationExportRefusedError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "NotificationExportRefusedError";
    this.code = typeof code === "string" ? code : null;
  }
}

// --- Validation helpers ------------------------------------------------------

// Anything that can terminate or split an RFC 5322 header field, plus the rest
// of the C0/C1 control range and DEL. TAB is included: a leading TAB is how
// header folding continues a previous field, so a stored value starting with
// one could still splice into the header block.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;

// Body text legitimately contains newlines. Everything else in the C0/C1 range
// (including the lone CR that would produce a bare CR in an artifact) does not.
// eslint-disable-next-line no-control-regex
const BODY_FORBIDDEN_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function containsControlCharacters(value) {
  return typeof value === "string" && CONTROL_CHARACTER_PATTERN.test(value);
}

/**
 * Trims, rejects blank, rejects over-length, and (for single-line fields)
 * rejects control characters.
 *
 * Rejecting rather than silently truncating or stripping is deliberate and
 * matches caseWorkflowRules.normalizeBoundedText: an analyst whose subject was
 * quietly cut in half, or whose injected header was quietly removed, would
 * believe they recorded something they did not.
 */
function normalizeBoundedText(value, { field, maxLength, required, multiline = false }) {
  if (value === undefined || value === null) {
    if (required) throw new NotificationValidationError(`${field} is required`, [field]);
    return null;
  }
  if (typeof value !== "string") {
    throw new NotificationValidationError(`${field} must be a string`, [field]);
  }

  // Normalize CRLF/CR to LF for multiline fields BEFORE measuring, so the
  // stored form is canonical and a checksum cannot depend on which line ending
  // the analyst's browser happened to send. The export builder re-expands to
  // CRLF where the format requires it.
  const candidate = multiline ? value.replace(/\r\n?/g, "\n") : value;
  const trimmed = candidate.trim();

  if (trimmed === "") {
    if (required) throw new NotificationValidationError(`${field} is required`, [field]);
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new NotificationValidationError(
      `${field} must be at most ${maxLength} characters`,
      [field]
    );
  }

  const forbidden = multiline ? BODY_FORBIDDEN_PATTERN : CONTROL_CHARACTER_PATTERN;
  if (forbidden.test(trimmed)) {
    throw new NotificationValidationError(
      `${field} must not contain control characters`,
      [field]
    );
  }

  return trimmed;
}

function assertMemberOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new NotificationValidationError(
      `${field} must be one of ${allowed.join(", ")}`,
      [field]
    );
  }
  return value;
}

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new NotificationValidationError(`${field} must be a positive integer`, [field]);
  }
  return value;
}

function assertValidDate(value, field) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new NotificationValidationError(`${field} must be a valid date`, [field]);
  }
  return value;
}

// Deliberately conservative rather than RFC-complete, and stricter than
// lib/validation.js's EMAIL_PATTERN in one respect that matters here: it also
// rejects the RFC 5322 special characters that would need quoting in a header
// (comma, semicolon, angle brackets, colon, quotes, backslash, parentheses).
// An address containing any of them is refused rather than emitted into a To:
// header where it would change the header's meaning.
const RECIPIENT_EMAIL_PATTERN = /^[^\s@,;:<>"'\\()[\]]+@[^\s@,;:<>"'\\()[\]]+\.[^\s@,;:<>"'\\()[\]]+$/;

function isValidRecipientEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_RECIPIENT_EMAIL_LENGTH &&
    RECIPIENT_EMAIL_PATTERN.test(value)
  );
}

function normalizeRecipientEmail(value, { required = false } = {}) {
  const trimmed = normalizeBoundedText(value, {
    field: "recipientEmail",
    maxLength: MAX_RECIPIENT_EMAIL_LENGTH,
    required,
  });
  if (trimmed === null) return null;
  if (!isValidRecipientEmail(trimmed)) {
    throw new NotificationValidationError(
      "recipientEmail must be a valid address with no header-special characters",
      ["recipientEmail"]
    );
  }
  return trimmed;
}

// --- Revision content and its checksum ---------------------------------------

// THE canonical field order. Fixed here, in one place, because the checksum is
// only reproducible if every producer agrees on it. Adding a content field in
// a later phase changes every checksum, which is correct — it is a different
// content contract — but it must be a deliberate act, so the version tag below
// is part of the hashed input.
const CONTENT_FIELDS = Object.freeze([
  "subject",
  "body",
  "remediationGuidance",
  "recipientName",
  "recipientEmail",
  "analystNotes",
]);

const CONTENT_CHECKSUM_VERSION = "notification-content-v1";
const CONTENT_CHECKSUM_ALGORITHM = "sha256";

/**
 * Normalizes an arbitrary content object into exactly the six canonical
 * fields, validated and bounded. Throws NotificationValidationError on any
 * out-of-contract value.
 *
 * `subject` and `body` are required; everything else is optional and
 * normalizes to null when absent or blank, so "absent" and "empty string" can
 * never produce two different checksums for the same content.
 */
function normalizeRevisionContent(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};

  return {
    subject: normalizeBoundedText(source.subject, {
      field: "subject",
      maxLength: MAX_SUBJECT_LENGTH,
      required: true,
    }),
    body: normalizeBoundedText(source.body, {
      field: "body",
      maxLength: MAX_BODY_LENGTH,
      required: true,
      multiline: true,
    }),
    remediationGuidance: normalizeBoundedText(source.remediationGuidance, {
      field: "remediationGuidance",
      maxLength: MAX_REMEDIATION_GUIDANCE_LENGTH,
      required: false,
      multiline: true,
    }),
    recipientName: normalizeBoundedText(source.recipientName, {
      field: "recipientName",
      maxLength: MAX_RECIPIENT_NAME_LENGTH,
      required: false,
    }),
    recipientEmail: normalizeRecipientEmail(source.recipientEmail),
    analystNotes: normalizeBoundedText(source.analystNotes, {
      field: "analystNotes",
      maxLength: MAX_ANALYST_NOTES_LENGTH,
      required: false,
      multiline: true,
    }),
  };
}

/**
 * Deterministic SHA-256 fingerprint of normalized revision content.
 *
 * The hashed input is a version tag followed by explicit `field=value` records
 * with an explicit length prefix on each value. The length prefix is what
 * makes the encoding unambiguous: without it, moving text from the end of one
 * field to the start of the next could produce the same byte stream and
 * therefore the same checksum for two genuinely different revisions.
 *
 * Deliberately NOT part of the input: row ids, revision numbers, timestamps,
 * actor identity, database row order, environment values, secrets, and any
 * error text. Two analysts typing the same content on different days at
 * different organizations produce the same checksum, which is exactly what
 * makes it usable both as a no-op detector and as an integrity re-check.
 */
function computeContentChecksum(content) {
  const normalized = content && typeof content === "object" ? content : {};
  const parts = [CONTENT_CHECKSUM_VERSION];

  CONTENT_FIELDS.forEach((field) => {
    const raw = normalized[field];
    const value = typeof raw === "string" ? raw : "";
    parts.push(`${field}:${value.length}:${value}`);
  });

  return crypto
    .createHash(CONTENT_CHECKSUM_ALGORITHM)
    .update(parts.join("\u001e"), "utf8")
    .digest("hex");
}

/**
 * True when two normalized content objects are byte-identical in every
 * canonical field. Used to answer UNCHANGED without a database round trip and
 * without trusting the stored checksum alone.
 */
function contentEquals(a, b) {
  if (!a || !b) return false;
  return CONTENT_FIELDS.every((field) => (a[field] || null) === (b[field] || null));
}

// --- State guards -------------------------------------------------------------

/**
 * A notification participates in the Phase 4 workflow only when it is bound to
 * a case AND an organization. A legacy Phase 0 row has neither; it stays
 * readable and every workflow operation refuses it, exactly as a legacy
 * non-organization-bound Case does in Phase 3.
 */
function isWorkflowBound(record) {
  return Boolean(
    record && Number.isInteger(record.caseId) && Number.isInteger(record.organizationId)
  );
}

function assertWorkflowBound(record) {
  if (!isWorkflowBound(record)) {
    throw new NotificationStateError(
      "Notification is not bound to a case and organization",
      "NOTIFICATION_NOT_WORKFLOW_BOUND"
    );
  }
  return record;
}

function assertEditable(record) {
  if (!EDITABLE_STATES.includes(record.lifecycleState)) {
    throw new NotificationStateError(
      "Notification cannot be edited in its current state",
      record.lifecycleState === NOTIFICATION_STATES.PENDING_REVIEW
        ? "NOTIFICATION_UNDER_REVIEW"
        : "NOTIFICATION_NOT_EDITABLE"
    );
  }
  return record;
}

function assertSubmittable(record) {
  if (!SUBMITTABLE_STATES.includes(record.lifecycleState)) {
    throw new NotificationStateError(
      "Only a draft notification can be submitted for review",
      "NOTIFICATION_NOT_SUBMITTABLE"
    );
  }
  return record;
}

function assertReviewable(record) {
  if (!REVIEWABLE_STATES.includes(record.lifecycleState)) {
    throw new NotificationStateError(
      "Notification is not awaiting review",
      "NOTIFICATION_NOT_PENDING_REVIEW"
    );
  }
  return record;
}

/**
 * The reason code for the REVISION_CREATED event, chosen from the state the
 * edit started in. Kept here rather than inline in the service so the
 * vocabulary and the mapping onto it live together.
 */
function revisionReasonCodeFor(fromState) {
  if (fromState === NOTIFICATION_STATES.APPROVED) {
    return LIFECYCLE_REASON_CODES.REVISION_EDITED_AFTER_APPROVAL;
  }
  if (fromState === NOTIFICATION_STATES.REJECTED) {
    return LIFECYCLE_REASON_CODES.REVISION_EDITED_AFTER_REJECTION;
  }
  return LIFECYCLE_REASON_CODES.REVISION_EDITED;
}

// --- The export eligibility guard ---------------------------------------------

/**
 * THE export guard, expressed as a pure function of already-loaded durable
 * rows. Every condition from the Phase 4 contract is checked here, and every
 * failure returns a closed refusal code.
 *
 * Pure and side-effect free by design: the service calls it INSIDE the same
 * read that produced the rows, and the unit tests can exercise every refusal
 * branch without a database. A caller that skipped it could not accidentally
 * export, because the service treats a non-eligible result as fatal before any
 * artifact is built and before any row is written.
 *
 * @param {object} notification - the Notification row
 * @param {object|null} currentRevision - its current (non-superseded) revision
 * @returns {{eligible:boolean, code:string|null}}
 */
function evaluateExportEligibility(notification, currentRevision) {
  const refuse = (code) => ({ eligible: false, code });

  if (!isWorkflowBound(notification)) {
    return refuse(EXPORT_REFUSAL_CODES.NOTIFICATION_NOT_WORKFLOW_BOUND);
  }

  // 1. Current state is APPROVED. DRAFT, PENDING_REVIEW and REJECTED all
  //    refuse here — an unapproved message must never leave the system.
  if (notification.lifecycleState !== NOTIFICATION_STATES.APPROVED) {
    return refuse(EXPORT_REFUSAL_CODES.NOTIFICATION_NOT_APPROVED);
  }

  // 2. There is a current revision at all.
  if (!currentRevision || !Number.isInteger(currentRevision.id)) {
    return refuse(EXPORT_REFUSAL_CODES.APPROVAL_MISSING);
  }

  // 3. An approval exists...
  if (!Number.isInteger(notification.approvedRevisionId)) {
    return refuse(EXPORT_REFUSAL_CODES.APPROVAL_MISSING);
  }

  // 4. ...and it belongs to the EXACT current revision. This is the condition
  //    that makes "editing after approval invalidates export eligibility" true
  //    even if some future code path forgets to clear the projection.
  if (notification.approvedRevisionId !== currentRevision.id) {
    return refuse(EXPORT_REFUSAL_CODES.APPROVAL_NOT_FOR_CURRENT_REVISION);
  }

  // 5. approvedByUserId is non-null. An approval with no approver is not an
  //    approval — this is the AGENTS.md rule ("refuse any notification whose
  //    approved_by is null") enforced literally.
  if (!Number.isInteger(notification.approvedByUserId)) {
    return refuse(EXPORT_REFUSAL_CODES.APPROVER_MISSING);
  }

  // 6. The stored checksum still matches the stored content. Catches any
  //    out-of-band mutation of a revision row between approval and export.
  const recomputed = computeContentChecksum({
    subject: currentRevision.subject,
    body: currentRevision.body,
    remediationGuidance: currentRevision.remediationGuidance,
    recipientName: currentRevision.recipientName,
    recipientEmail: currentRevision.recipientEmail,
    analystNotes: currentRevision.analystNotes,
  });
  if (recomputed !== currentRevision.contentChecksum) {
    return refuse(EXPORT_REFUSAL_CODES.REVISION_CHECKSUM_MISMATCH);
  }

  // 7. The revision still belongs to this notification.
  if (currentRevision.notificationId !== notification.id) {
    return refuse(EXPORT_REFUSAL_CODES.CASE_BINDING_CHANGED);
  }

  // 8. There is somewhere to address it. Exporting a message with no
  //    recipient would produce an artifact that cannot be sent, and a To:
  //    header this system had to invent.
  if (!isValidRecipientEmail(currentRevision.recipientEmail)) {
    return refuse(EXPORT_REFUSAL_CODES.RECIPIENT_MISSING);
  }

  return { eligible: true, code: null };
}

// Deterministic, human-readable, and unique because it embeds the database's
// own primary key. Formatted AFTER insertion (see notificationDraftService)
// rather than guessed beforehand, so two concurrent creations can never
// collide. Same construction as caseWorkflowRules.formatCaseReference.
function formatNotificationReference(notificationId, createdAt) {
  assertPositiveInteger(notificationId, "notificationId");
  assertValidDate(createdAt, "createdAt");
  return `TNX-NOT-${createdAt.getUTCFullYear()}-${String(notificationId).padStart(6, "0")}`;
}

module.exports = {
  NOTIFICATION_STATES,
  NOTIFICATION_STATE_VALUES,
  EDITABLE_STATES,
  SUBMITTABLE_STATES,
  REVIEWABLE_STATES,
  LIFECYCLE_EVENT_TYPES,
  LIFECYCLE_REASON_CODES,
  EXPORT_FORMATS,
  EXPORT_FORMAT_VALUES,
  DEFAULT_EXPORT_FORMAT,
  DELIVERY_STATUSES,
  DELIVERY_STATUS_VALUES,
  EXPORT_REFUSAL_CODES,
  CONTENT_FIELDS,
  CONTENT_CHECKSUM_VERSION,
  MAX_SUBJECT_LENGTH,
  MAX_BODY_LENGTH,
  MAX_REMEDIATION_GUIDANCE_LENGTH,
  MAX_RECIPIENT_NAME_LENGTH,
  MAX_RECIPIENT_EMAIL_LENGTH,
  MAX_ANALYST_NOTES_LENGTH,
  MAX_REVIEW_NOTE_LENGTH,
  MAX_REJECTION_REASON_LENGTH,
  MAX_DELIVERY_REFERENCE_LENGTH,
  MAX_DELIVERY_NOTE_LENGTH,
  NotificationValidationError,
  NotificationNotFoundError,
  NotificationStateError,
  NotificationSelfApprovalError,
  NotificationExportRefusedError,
  containsControlCharacters,
  normalizeBoundedText,
  assertMemberOf,
  assertPositiveInteger,
  assertValidDate,
  isValidRecipientEmail,
  normalizeRecipientEmail,
  normalizeRevisionContent,
  computeContentChecksum,
  contentEquals,
  isWorkflowBound,
  assertWorkflowBound,
  assertEditable,
  assertSubmittable,
  assertReviewable,
  revisionReasonCodeFor,
  evaluateExportEligibility,
  formatNotificationReference,
};
