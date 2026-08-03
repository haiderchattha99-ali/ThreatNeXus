"use strict";

// Notification drafting, revision editing and submission for review (Phase 4).
//
// ---------------------------------------------------------------------------
// Revisions are immutable and exactly one is current
// ---------------------------------------------------------------------------
// A NotificationRevision row is NEVER updated after it is written, except for
// the single supersede stamp (`supersededAt` + `currentForNotificationId ->
// null`) applied in the same transaction that inserts its replacement. That is
// the identical mechanism FindingTriage and CaseFinding use, and the
// `currentForNotificationId Int? @unique` column makes "at most one current
// revision" a database constraint rather than a checked-then-hoped-for
// property (PostgreSQL treats multiple NULLs in a unique index as distinct, so
// unlimited history rows coexist while at most one is current — no raw SQL, no
// partial index).
//
// ---------------------------------------------------------------------------
// An identical edit is UNCHANGED, not a new revision
// ---------------------------------------------------------------------------
// Without that rule a UI that re-submits the whole form on every keystroke-idle
// would turn the revision history into a log of HTTP requests, and every one of
// those no-op revisions would invalidate a standing approval. The comparison is
// made on the normalized content itself (contentEquals), not merely on the
// stored checksum, so a checksum collision or a stale stored value cannot make
// two different revisions look identical.
//
// ---------------------------------------------------------------------------
// Editing destroys a standing approval, deliberately
// ---------------------------------------------------------------------------
// Creating any revision clears the entire approval projection
// (approvedRevisionId / approvedByUserId / approvedAt) and returns the
// notification to DRAFT, in the same statement as the state change. That is how
// "a prior approval must never authorize export of a later edited revision"
// becomes stored state instead of a comparison somebody might forget to write.
// The permanent record of the approval that was destroyed survives in
// NotificationLifecycleEvent, which is never rewritten.
//
// This includes an edit that only changes analystNotes. Notes are internal and
// never exported, so the ARTIFACT would be byte-identical — but they are part
// of the record the reviewer saw, and treating "the reviewer approved a record
// that has since changed" as still-approved is the wrong default for a system
// whose whole purpose is a defensible approval trail. Deliberately strict.

const {
  NOTIFICATION_STATES,
  LIFECYCLE_EVENT_TYPES,
  LIFECYCLE_REASON_CODES,
  CONTENT_FIELDS,
  NotificationNotFoundError,
  NotificationStateError,
  assertPositiveInteger,
  assertValidDate,
  assertEditable,
  assertSubmittable,
  assertWorkflowBound,
  normalizeRevisionContent,
  computeContentChecksum,
  contentEquals,
  revisionReasonCodeFor,
  formatNotificationReference,
} = require("./notificationRules");

const {
  resolveClient,
  loadNotificationOrThrow,
  loadCurrentRevision,
  applyGuardedTransition,
  appendLifecycleEvent,
  notificationSummary,
} = require("./notificationStateService");

const { buildInitialDraft } = require("./notificationTemplate");
const { runAtomic, runSerializable } = require("../workflow/workflowTransaction");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const NOTIFICATION_ENTITY_TYPE = "Notification";
const REVISION_ENTITY_TYPE = "NotificationRevision";

// Outcome vocabulary for an edit. UNCHANGED is a first-class result, not an
// error: the caller asked for content that is already current, and answering
// "nothing to do" is the correct, non-destructive response.
const EDIT_OUTCOMES = Object.freeze({ REVISED: "REVISED", UNCHANGED: "UNCHANGED" });

// The organization fields the DRAFTING path needs. contactPerson and email are
// read here — and only here — because the recipient snapshot is the whole
// point of drafting from an organization-bound case. They are written onto the
// revision and are never returned verbatim by any read API (the serializer
// masks the address; see notificationSerializers).
const DRAFT_ORGANIZATION_SELECT = Object.freeze({
  id: true,
  name: true,
  sector: true,
  contactPerson: true,
  email: true,
});

// Only the Finding identity and observation fields the template renders.
// Ownership, enrichment, reputation and risk are deliberately not selected —
// they are internal assessments and have no place in a constituent-facing
// template (see notificationTemplate's header).
const FINDING_SELECT = Object.freeze({
  id: true,
  indicatorValue: true,
  port: true,
  protocol: true,
  reportType: true,
  firstSeen: true,
  lastSeen: true,
  occurrenceCount: true,
  recurrenceCount: true,
});

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("Notification revision audit failed", { name: error && error.name });
  }
}

// The legacy `message` display projection. Deliberately carries NO incident
// content — the authoritative content lives on the revision, and duplicating a
// constituent-addressed body into an unversioned column would create a second
// copy that no checksum covers.
function legacyMessageProjection(reference, revisionNumber) {
  return `Constituent notification ${reference} — revision ${revisionNumber}. See revision history for content.`;
}

/**
 * Loads a case, its organization and its currently-linked evidence, for
 * drafting.
 *
 * The evidence set is the CURRENT links only (state LINKED, not superseded),
 * ordered deterministically by Finding id so the generated draft is
 * reproducible. Unlinked history is excluded: a notification must describe what
 * the case asserts NOW, not what it once asserted.
 */
async function loadDraftSources(client, caseId) {
  const caseRecord = await client.case.findUnique({
    where: { id: caseId },
    include: { ownerOrganization: { select: DRAFT_ORGANIZATION_SELECT } },
  });
  if (!caseRecord) throw new NotificationNotFoundError("Case not found");

  if (!Number.isInteger(caseRecord.organizationId)) {
    throw new NotificationStateError(
      "Case is not bound to an organization",
      "CASE_NOT_ORGANIZATION_BOUND"
    );
  }

  // A concluded case must not acquire new constituent correspondence: the
  // closure was approved on a stated evidence base, and notifying afterwards
  // would imply an open engagement the record says is finished. Same rule, and
  // the same reasoning, as caseResponseService refusing responses on a closed
  // case.
  if (caseRecord.lifecycleState === "CLOSED") {
    throw new NotificationStateError(
      "Notifications cannot be drafted from a closed case",
      "CASE_CLOSED"
    );
  }

  const links = await client.caseFinding.findMany({
    where: { caseId, state: "LINKED", supersededAt: null },
    orderBy: [{ findingId: "asc" }],
    select: { findingId: true },
  });

  const findingIds = links.map((row) => row.findingId);
  const findings =
    findingIds.length === 0
      ? []
      : await client.finding.findMany({
          where: { id: { in: findingIds } },
          orderBy: [{ id: "asc" }],
          select: FINDING_SELECT,
        });

  return { caseRecord, organization: caseRecord.ownerOrganization || null, findings };
}

/**
 * Creates a notification draft from an organization-bound case.
 *
 * Purely additive — every row it writes is a fresh INSERT and the notification
 * reference is derived from the primary key the database itself assigns, so no
 * interleaving can produce a duplicate. It therefore uses `runAtomic`
 * (connection-default isolation) rather than `runSerializable`, per the rule
 * recorded in workflowTransaction.js: SERIALIZABLE here would take predicate
 * locks on the unique reference index and make concurrent creations conflict on
 * index-page adjacency rather than on any real data dependency.
 *
 * @param {number} caseId
 * @param {{client?:object, actorUserId?:number|null, createdAt:Date,
 *   auditContext?:object}} options
 */
async function createDraftFromCase(caseId, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  const createdAt = assertValidDate(options.createdAt, "createdAt");

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  let sources;
  try {
    sources = await loadDraftSources(client, caseId);
  } catch (error) {
    await audit(client, auditContext, {
      action: "notification.draft.created",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: NOTIFICATION_ENTITY_TYPE,
      entityId: caseId,
      reason:
        error instanceof NotificationStateError && error.code
          ? `Notification draft refused (${error.code})`
          : "Notification draft could not be created from this case",
    });
    throw error;
  }

  // Built from persisted rows only, then validated through the same bounded
  // normalizer every analyst edit crosses. If the template ever produced an
  // out-of-contract value (an over-length subject from a long case reference,
  // a control character from a stored organization name) it is rejected here
  // rather than stored.
  const content = normalizeRevisionContent(
    buildInitialDraft({
      caseRecord: sources.caseRecord,
      organization: sources.organization,
      findings: sources.findings,
    })
  );
  const contentChecksum = computeContentChecksum(content);

  let outcome;
  try {
    outcome = await runAtomic(client, async (tx) => {
      const created = await tx.notification.create({
        data: {
          // Legacy display projection. `title` mirrors the subject; `message`
          // is filled in below once the reference exists.
          title: content.subject,
          message: "Constituent notification draft.",
          severity: "Medium",
          status: "Unread",
          type: "Constituent",

          caseId,
          organizationId: sources.caseRecord.organizationId,
          lifecycleState: NOTIFICATION_STATES.DRAFT,
          createdByUserId: actorUserId,
          createdAt,
        },
      });

      const reference = formatNotificationReference(created.id, createdAt);

      const revision = await tx.notificationRevision.create({
        data: {
          notificationId: created.id,
          revisionNumber: 1,
          subject: content.subject,
          body: content.body,
          remediationGuidance: content.remediationGuidance,
          recipientName: content.recipientName,
          recipientEmail: content.recipientEmail,
          analystNotes: content.analystNotes,
          contentChecksum,
          createdByUserId: actorUserId,
          createdAt,
          currentForNotificationId: created.id,
        },
      });

      const notification = await tx.notification.update({
        where: { id: created.id },
        data: {
          notificationReference: reference,
          message: legacyMessageProjection(reference, revision.revisionNumber),
        },
      });

      await appendLifecycleEvent(tx, {
        notificationId: created.id,
        eventType: LIFECYCLE_EVENT_TYPES.DRAFT_CREATED,
        // Null: there is no prior state, and inventing one would make the
        // timeline read as though the notification existed before it did.
        fromState: null,
        toState: NOTIFICATION_STATES.DRAFT,
        revisionId: revision.id,
        reasonCode: LIFECYCLE_REASON_CODES.DRAFT_CREATED_FROM_CASE,
        note: null,
        actorUserId,
        occurredAt: createdAt,
      });

      return { notification, revision };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "notification.draft.created",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: NOTIFICATION_ENTITY_TYPE,
      entityId: caseId,
      reason: "Notification draft could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "notification.draft.created",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: NOTIFICATION_ENTITY_TYPE,
    entityId: outcome.notification.id,
    after: {
      ...notificationSummary(outcome.notification, outcome.revision),
      // Counts and lengths only — never the drafted text itself.
      linkedFindingCount: sources.findings.length,
      subjectLength: outcome.revision.subject.length,
      bodyLength: outcome.revision.body.length,
      hasRecipient: outcome.revision.recipientEmail !== null,
    },
    reason: "Notification draft created from case evidence",
  });

  return outcome;
}

/**
 * Merges a partial edit over the current revision's content.
 *
 * A key the caller did not send keeps its current value; a key sent as null
 * explicitly clears an optional field. That distinction matters: without it,
 * an editor that only sends the subject would silently erase the body.
 */
function mergeContent(currentRevision, patch) {
  const source = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const merged = {};

  CONTENT_FIELDS.forEach((field) => {
    merged[field] = Object.prototype.hasOwnProperty.call(source, field)
      ? source[field]
      : currentRevision[field];
  });

  return merged;
}

/**
 * Edits the current revision, creating a new immutable revision unless the
 * resulting content is identical.
 *
 * Uses `runSerializable`: the callback re-reads the current revision and the
 * notification state and then writes based on both, which is exactly the
 * read-modify-write the isolation level exists to protect.
 *
 * @param {number} notificationId
 * @param {object} patch - partial content
 * @param {{client?:object, actorUserId?:number|null, occurredAt:Date,
 *   auditContext?:object}} options
 * @returns {Promise<{outcome:string, notification:object, revision:object}>}
 */
async function editCurrentRevision(notificationId, patch, options = {}) {
  assertPositiveInteger(notificationId, "notificationId");
  const occurredAt = assertValidDate(options.occurredAt, "occurredAt");

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const record = assertWorkflowBound(await loadNotificationOrThrow(client, notificationId));
  assertEditable(record);

  const existing = await loadCurrentRevision(client, notificationId);
  if (!existing) {
    throw new NotificationStateError(
      "Notification has no current revision",
      "NOTIFICATION_NO_CURRENT_REVISION"
    );
  }

  // Validation happens BEFORE the transaction opens, so an out-of-contract
  // subject is a controlled 400 that never touched the database.
  const content = normalizeRevisionContent(mergeContent(existing, patch));

  // The no-op check compares the normalized CONTENT, not the stored checksum:
  // comparing checksums alone would treat a stale or corrupted stored value as
  // a difference (harmless) or, far worse, a collision as an identity.
  if (contentEquals(content, existing)) {
    await audit(client, auditContext, {
      action: "notification.revision.unchanged",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: REVISION_ENTITY_TYPE,
      entityId: existing.id,
      after: notificationSummary(record, existing),
      reason: "Notification edit made no change; no revision created",
    });
    return { outcome: EDIT_OUTCOMES.UNCHANGED, notification: record, revision: existing };
  }

  const contentChecksum = computeContentChecksum(content);

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      const fresh = await tx.notification.findUnique({ where: { id: notificationId } });
      if (!fresh) throw new NotificationNotFoundError("Notification not found");
      assertEditable(fresh);

      const current = await tx.notificationRevision.findUnique({
        where: { currentForNotificationId: notificationId },
      });
      if (!current) {
        throw new NotificationStateError(
          "Notification has no current revision",
          "NOTIFICATION_NO_CURRENT_REVISION"
        );
      }

      // Supersede-then-insert, both inside this transaction. The prior row is
      // touched ONLY here and ONLY on these two columns; its content is never
      // rewritten.
      await tx.notificationRevision.update({
        where: { id: current.id },
        data: { supersededAt: occurredAt, currentForNotificationId: null },
      });

      const revision = await tx.notificationRevision.create({
        data: {
          notificationId,
          revisionNumber: current.revisionNumber + 1,
          subject: content.subject,
          body: content.body,
          remediationGuidance: content.remediationGuidance,
          recipientName: content.recipientName,
          recipientEmail: content.recipientEmail,
          analystNotes: content.analystNotes,
          contentChecksum,
          createdByUserId: actorUserId,
          createdAt: occurredAt,
          currentForNotificationId: notificationId,
        },
      });

      const transition = await applyGuardedTransition(tx, {
        notificationId,
        fromState: fresh.lifecycleState,
        // Every edit returns the notification to DRAFT, including an edit that
        // started from DRAFT (a no-op transition that still records an event).
        toState: NOTIFICATION_STATES.DRAFT,
        eventType: LIFECYCLE_EVENT_TYPES.REVISION_CREATED,
        reasonCode: revisionReasonCodeFor(fresh.lifecycleState),
        revisionId: revision.id,
        note: null,
        actorUserId,
        occurredAt,
        extraData: {
          // THE approval invalidation. Cleared in the same statement as the
          // state change so no reader can observe an APPROVED-looking
          // projection against a newer revision.
          approvedRevisionId: null,
          approvedByUserId: null,
          approvedAt: null,
          title: content.subject,
          message: legacyMessageProjection(
            fresh.notificationReference || `notification ${notificationId}`,
            revision.revisionNumber
          ),
        },
      });

      return { notification: transition.notification, revision, previous: current };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "notification.revision.created",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: REVISION_ENTITY_TYPE,
      entityId: notificationId,
      reason:
        error instanceof NotificationStateError && error.code
          ? `Notification edit refused (${error.code})`
          : "Notification revision could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "notification.revision.created",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: REVISION_ENTITY_TYPE,
    entityId: outcome.revision.id,
    before: notificationSummary(record, outcome.previous),
    after: {
      ...notificationSummary(outcome.notification, outcome.revision),
      subjectLength: outcome.revision.subject.length,
      bodyLength: outcome.revision.body.length,
      // Recorded explicitly so an auditor can see that this edit destroyed a
      // standing approval, without the audit row carrying the content.
      invalidatedApproval: record.lifecycleState === NOTIFICATION_STATES.APPROVED,
    },
    reason:
      record.lifecycleState === NOTIFICATION_STATES.APPROVED
        ? "Notification edited after approval; new draft revision created and approval invalidated"
        : "Notification revision created",
  });

  return { outcome: EDIT_OUTCOMES.REVISED, ...outcome };
}

/**
 * Submits the current DRAFT revision for review.
 *
 * Records WHICH revision was submitted, which is what the self-approval check
 * later reads: the reviewer must not be the person who submitted this exact
 * revision (see notificationReviewService).
 */
async function submitForReview(notificationId, options = {}) {
  assertPositiveInteger(notificationId, "notificationId");
  const occurredAt = assertValidDate(options.occurredAt, "occurredAt");

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const record = assertWorkflowBound(await loadNotificationOrThrow(client, notificationId));
  assertSubmittable(record);

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      const fresh = await tx.notification.findUnique({ where: { id: notificationId } });
      if (!fresh) throw new NotificationNotFoundError("Notification not found");
      assertSubmittable(fresh);

      const current = await tx.notificationRevision.findUnique({
        where: { currentForNotificationId: notificationId },
      });
      if (!current) {
        throw new NotificationStateError(
          "Notification has no current revision",
          "NOTIFICATION_NO_CURRENT_REVISION"
        );
      }

      const transition = await applyGuardedTransition(tx, {
        notificationId,
        fromState: NOTIFICATION_STATES.DRAFT,
        toState: NOTIFICATION_STATES.PENDING_REVIEW,
        eventType: LIFECYCLE_EVENT_TYPES.SUBMITTED_FOR_REVIEW,
        reasonCode: LIFECYCLE_REASON_CODES.SUBMITTED_BY_ANALYST,
        revisionId: current.id,
        note: null,
        actorUserId,
        occurredAt,
      });

      return { notification: transition.notification, revision: current };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "notification.review.submitted",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: NOTIFICATION_ENTITY_TYPE,
      entityId: notificationId,
      reason:
        error instanceof NotificationStateError && error.code
          ? `Notification submission refused (${error.code})`
          : "Notification submission could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "notification.review.submitted",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: NOTIFICATION_ENTITY_TYPE,
    entityId: notificationId,
    before: { lifecycleState: NOTIFICATION_STATES.DRAFT },
    after: notificationSummary(outcome.notification, outcome.revision),
    reason: "Notification submitted for reviewer decision",
  });

  return outcome;
}

/**
 * Newest-first revision history for one notification, bounded by the caller.
 */
async function listRevisions(client, notificationId, take) {
  return client.notificationRevision.findMany({
    where: { notificationId },
    orderBy: [{ revisionNumber: "desc" }],
    take,
  });
}

module.exports = {
  EDIT_OUTCOMES,
  NOTIFICATION_ENTITY_TYPE,
  REVISION_ENTITY_TYPE,
  DRAFT_ORGANIZATION_SELECT,
  FINDING_SELECT,
  legacyMessageProjection,
  loadDraftSources,
  mergeContent,
  createDraftFromCase,
  editCurrentRevision,
  submitForReview,
  listRevisions,
};
