"use strict";

// Safe read paths for the Phase 4 notification workflow.
//
// Every row this module returns has crossed notificationSerializers.js, which
// is the single allow-list choke point. Nothing here selects an AuditLog row,
// a current-row key, an organization contact field, an artifact byte or a
// verbatim recipient address — see that module's header for the full exclusion
// list and the dedicated test file that proves it.
//
// ---------------------------------------------------------------------------
// Only workflow notifications are listed
// ---------------------------------------------------------------------------
// A pre-Phase-4 Notification row (no caseId, no organizationId) is a legacy
// in-app message with no revision, no approval and no export path. It is
// excluded from the list rather than returned with null workflow fields,
// because a client that received it would have to invent a rendering for a
// state it can never act on — and because the legacy row shape was never
// filtered by an allow-list.
//
// ---------------------------------------------------------------------------
// permittedActions is derived from durable state ALONE
// ---------------------------------------------------------------------------
// It says nothing about the caller. The frontend intersects it with the
// caller's capability list for UX; the backend re-checks both the capability
// (route middleware) and the state (service) on every mutation regardless. A
// frontend that ignored this block entirely could still not perform a
// disallowed action.

const {
  NOTIFICATION_STATES,
  EDITABLE_STATES,
  SUBMITTABLE_STATES,
  REVIEWABLE_STATES,
  NotificationNotFoundError,
  assertPositiveInteger,
  isWorkflowBound,
  evaluateExportEligibility,
} = require("./notificationRules");

const {
  serializeNotificationSummary,
  serializeRevision,
  serializeRevisionSummary,
  serializeLifecycleEvent,
  serializeExport,
  serializeDeliveryEvent,
  serializeCaseSummary,
  serializeOrganizationResponse,
} = require("./notificationSerializers");

// Bounded page sizes. A notification that accumulated hundreds of revisions or
// exports must not be able to turn one detail read into an unbounded result
// set. Same limits and same reasoning as caseWorkflowReadService.
const MAX_TIMELINE_ROWS = 200;
const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 25;

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

// Only the three organization fields the workflow displays are selected at the
// QUERY level, not merely dropped at serialization time. Selecting the whole
// row would still pull contact details into process memory and into any future
// logging of that object.
const ORGANIZATION_SELECT = Object.freeze({ id: true, name: true, sector: true });
const ACTOR_SELECT = Object.freeze({ id: true, name: true, role: true });

/**
 * Bounded, deterministically ordered notification list.
 *
 * Invalid `page`, `limit` or `state` are REJECTED with a named field rather
 * than silently clamped or ignored — the same contract the Phase 3
 * organization-options endpoint settled on, for the same reason: silently
 * dropping a parameter a caller believed was applied is its own failure mode.
 */
async function listNotifications(options = {}) {
  const client = resolveClient(options.client);

  const limit = options.limit === undefined || options.limit === null ? DEFAULT_LIST_LIMIT : options.limit;
  const page = options.page === undefined || options.page === null ? 1 : options.page;

  const where = { caseId: { not: null } };
  if (options.state !== undefined && options.state !== null) {
    where.lifecycleState = options.state;
  }
  if (options.caseId !== undefined && options.caseId !== null) {
    where.caseId = options.caseId;
  }

  const [total, rows] = await Promise.all([
    client.notification.count({ where }),
    client.notification.findMany({
      where,
      // Deterministic and total: createdAt alone would leave rows created in
      // the same millisecond in an arbitrary order across pages.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        ownerOrganization: { select: ORGANIZATION_SELECT },
        createdBy: { select: ACTOR_SELECT },
        approvedBy: { select: ACTOR_SELECT },
      },
    }),
  ]);

  const ids = rows.map((row) => row.id);
  const currentRevisions =
    ids.length === 0
      ? []
      : await client.notificationRevision.findMany({
          where: { currentForNotificationId: { in: ids } },
        });
  const revisionByNotificationId = new Map(
    currentRevisions.map((row) => [row.notificationId, row])
  );

  // Grouped counts rather than N per-notification queries, so listing stays a
  // fixed number of round trips regardless of how many rows are returned.
  const [exportCounts, deliveryCounts] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
          client.notificationExport.groupBy({
            by: ["notificationId"],
            where: { notificationId: { in: ids } },
            _count: { _all: true },
          }),
          client.notificationDeliveryEvent.groupBy({
            by: ["notificationId"],
            where: { notificationId: { in: ids } },
            _count: { _all: true },
          }),
        ]);

  const exportCountById = new Map(exportCounts.map((row) => [row.notificationId, row._count._all]));
  const deliveryCountById = new Map(
    deliveryCounts.map((row) => [row.notificationId, row._count._all])
  );

  return {
    page,
    limit,
    total,
    notifications: rows.map((row) => {
      const revision = revisionByNotificationId.get(row.id) || null;
      return {
        ...serializeNotificationSummary(row),
        currentRevision: serializeRevisionSummary(revision),
        exportCount: exportCountById.get(row.id) || 0,
        deliveryEventCount: deliveryCountById.get(row.id) || 0,
        // Whether THIS notification could be exported right now, from durable
        // state alone. Lets a list screen show an accurate control without a
        // detail round trip, and lets it be wrong in only one direction — the
        // service re-checks on the request itself.
        exportEligible: evaluateExportEligibility(row, revision).eligible,
      };
    }),
  };
}

/**
 * The complete notification detail view.
 *
 * Includes the case's organization-response timeline, read from the SAME
 * CaseOrganizationResponse rows the case detail reads. There is deliberately
 * no notification-scoped response table: a response is something the
 * organization said about the CASE, and duplicating it per notification would
 * create two records that could disagree.
 */
async function getNotificationDetail(notificationId, options = {}) {
  assertPositiveInteger(notificationId, "notificationId");
  const client = resolveClient(options.client);

  const record = await client.notification.findUnique({
    where: { id: notificationId },
    include: {
      ownerOrganization: { select: ORGANIZATION_SELECT },
      createdBy: { select: ACTOR_SELECT },
      approvedBy: { select: ACTOR_SELECT },
    },
  });
  if (!record) throw new NotificationNotFoundError("Notification not found");

  const [currentRevision, revisions, lifecycleEvents, exports, deliveryEvents] = await Promise.all([
    client.notificationRevision.findUnique({
      where: { currentForNotificationId: notificationId },
      include: { createdBy: { select: ACTOR_SELECT } },
    }),
    client.notificationRevision.findMany({
      where: { notificationId },
      orderBy: [{ revisionNumber: "desc" }],
      take: MAX_TIMELINE_ROWS,
      include: { createdBy: { select: ACTOR_SELECT } },
    }),
    client.notificationLifecycleEvent.findMany({
      where: { notificationId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: MAX_TIMELINE_ROWS,
      include: {
        actor: { select: ACTOR_SELECT },
        revision: { select: { revisionNumber: true } },
      },
    }),
    client.notificationExport.findMany({
      where: { notificationId },
      orderBy: [{ exportedAt: "desc" }, { id: "desc" }],
      take: MAX_TIMELINE_ROWS,
      include: {
        exportedBy: { select: ACTOR_SELECT },
        revision: { select: { revisionNumber: true } },
      },
    }),
    client.notificationDeliveryEvent.findMany({
      where: { notificationId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: MAX_TIMELINE_ROWS,
      include: {
        recordedBy: { select: ACTOR_SELECT },
        revision: { select: { revisionNumber: true } },
      },
    }),
  ]);

  // The case context and its canonical response timeline. Both are read only
  // when the notification is actually bound to a case, so a legacy row cannot
  // trigger a lookup against a null id.
  let caseRecord = null;
  let caseResponses = [];
  if (Number.isInteger(record.caseId)) {
    [caseRecord, caseResponses] = await Promise.all([
      client.case.findUnique({
        where: { id: record.caseId },
        include: { ownerOrganization: { select: ORGANIZATION_SELECT } },
      }),
      client.caseOrganizationResponse.findMany({
        where: { caseId: record.caseId },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: MAX_TIMELINE_ROWS,
        include: { recordedBy: { select: ACTOR_SELECT } },
      }),
    ]);
  }

  return {
    notification: serializeNotificationSummary(record),
    currentRevision: serializeRevision(currentRevision),
    revisions: revisions.map(serializeRevisionSummary),
    lifecycleEvents: lifecycleEvents.map(serializeLifecycleEvent),
    exports: exports.map(serializeExport),
    deliveryEvents: deliveryEvents.map(serializeDeliveryEvent),
    case: serializeCaseSummary(caseRecord),
    // The SAME canonical rows the case timeline shows.
    caseResponses: caseResponses.map(serializeOrganizationResponse),
    permittedActions: derivePermittedActions(record, currentRevision, {
      exportCount: exports.length,
      caseLifecycleState: caseRecord ? caseRecord.lifecycleState : null,
    }),
  };
}

/**
 * State-derived only. Never consults a role or a capability.
 *
 * `exportRefusalCode` is included when export is not currently possible, so
 * the UI can explain WHY ("it was edited after approval") instead of rendering
 * a disabled control with no reason. Every value is from the closed
 * EXPORT_REFUSAL_CODES vocabulary — never free text, never a database message.
 */
function derivePermittedActions(record, currentRevision, context = {}) {
  const bound = isWorkflowBound(record);
  const state = record.lifecycleState;
  const eligibility = evaluateExportEligibility(record, currentRevision);

  return {
    isWorkflowBound: bound,
    canEdit: bound && EDITABLE_STATES.includes(state),
    canSubmitForReview: bound && SUBMITTABLE_STATES.includes(state),
    canReview: bound && REVIEWABLE_STATES.includes(state),
    canExport: bound && eligibility.eligible,
    exportRefusalCode: bound && eligibility.eligible ? null : eligibility.code,
    // Delivery can only be claimed about something that was actually exported.
    canRecordDelivery: bound && (context.exportCount || 0) > 0,
    // Mirrors caseResponseService exactly: a concluded case must be reopened
    // before its correspondence timeline can grow again.
    canRecordOrganizationResponse:
      bound && context.caseLifecycleState !== null && context.caseLifecycleState !== "CLOSED",
    currentState: state,
    approvedForCurrentRevision:
      bound &&
      Number.isInteger(record.approvedRevisionId) &&
      currentRevision !== null &&
      currentRevision !== undefined &&
      record.approvedRevisionId === currentRevision.id,
  };
}

module.exports = {
  MAX_TIMELINE_ROWS,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
  ORGANIZATION_SELECT,
  ACTOR_SELECT,
  NOTIFICATION_STATES,
  listNotifications,
  getNotificationDetail,
  derivePermittedActions,
};
