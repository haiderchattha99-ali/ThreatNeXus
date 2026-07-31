"use strict";

// THE allow-list every Phase 3 row crosses on its way to an API response.
//
// Same design as enrichment/findingEnrichmentReadService.js's
// serializeEnrichmentRecord: these functions construct a fresh object from
// named fields rather than deleting keys from a database row, because a
// construct-only serializer stays safe when a future migration adds a column,
// whereas a delete-based one silently starts leaking it.
//
// Deliberately never emitted, in every serializer below:
//   - current-row keys        currentForFindingId, currentLinkKey, activeCaseId
//   - internal recurrence key findingOccurrenceId (CaseRecurrenceReopen)
//   - organization contacts   email, phone, contactPerson, industry, location
//   - anything Phase 1/2      no indicator, port, cacheKey, claimToken,
//                             queryParamsHash, inputFingerprint,
//                             configurationFingerprint
//   - audit rows              AuditLog is never read by, or returned from,
//                             any Phase 3 read path
//   - raw database errors     controllers answer a fixed string; see
//                             caseWorkflowController.js serverError
//
// A dedicated test file (caseWorkflowSerializerSafety.test.js) proves these
// exclusions against real row shapes rather than merely asserting them here.

// Only the three organization fields the workflow genuinely needs to display.
// contactPerson / email / phone are the "unrestricted organization contacts"
// the Phase 3 brief forbids exposing: a VIEWER reading a case must not thereby
// obtain a notification recipient list. securityScore / activeThreats are
// omitted too — they are dashboard projections, not case context.
function serializeOrganizationSummary(organization) {
  if (!organization) return null;
  return {
    id: organization.id,
    name: organization.name,
    sector: organization.sector,
  };
}

// Actor identity is reduced to id + name + role. Email is omitted for the same
// reason as organization contacts: a case timeline is readable by VIEWER.
function serializeActor(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, role: user.role };
}

function serializeTriageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    findingId: row.findingId,
    decision: row.decision,
    source: row.source,
    reason: row.reason === undefined ? null : row.reason,
    caseId: row.caseId === undefined ? null : row.caseId,
    actorUserId: row.actorUserId === undefined ? null : row.actorUserId,
    actor: row.actor ? serializeActor(row.actor) : undefined,
    decidedAt: row.decidedAt,
    supersededAt: row.supersededAt === undefined ? null : row.supersededAt,
    createdAt: row.createdAt,
    // currentForFindingId is NOT emitted. `isCurrent` conveys the same fact
    // without exposing the internal uniqueness mechanism.
    isCurrent: row.supersededAt === null || row.supersededAt === undefined,
  };
}

function serializeCaseSummary(record) {
  if (!record) return null;
  return {
    id: record.id,
    caseReference: record.caseReference === undefined ? null : record.caseReference,
    title: record.title,
    threatType: record.threatType,
    priority: record.priority,
    // Both status concepts, explicitly labelled. `status` is the legacy
    // free-text column the Phase 0 UI still writes; `lifecycleState` is the
    // authoritative Phase 3 enum. Returning only one of them would either
    // break the legacy screen or hide the real state.
    status: record.status,
    lifecycleState: record.lifecycleState,
    analyst: record.analyst,
    organization: record.organization,
    organizationId: record.organizationId === undefined ? null : record.organizationId,
    ownerOrganization: record.ownerOrganization
      ? serializeOrganizationSummary(record.ownerOrganization)
      : null,
    closedAt: record.closedAt === undefined ? null : record.closedAt,
    closureReason: record.closureReason === undefined ? null : record.closureReason,
    closedByUserId: record.closedByUserId === undefined ? null : record.closedByUserId,
    lastReopenedAt: record.lastReopenedAt === undefined ? null : record.lastReopenedAt,
    lastReopenTrigger: record.lastReopenTrigger === undefined ? null : record.lastReopenTrigger,
    reopenedCount: record.reopenedCount === undefined ? 0 : record.reopenedCount,
    // Derived badge for the list/detail views: this case was last reopened by
    // a recurrence rather than by a person.
    reopenedByRecurrence: record.lastReopenTrigger === "RECURRENCE",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// The linked-Finding view. Carries the Finding's identity fields because an
// analyst working a case genuinely needs to see which host it is — this is the
// same information /api/findings already returns to any holder of
// read:findings, which every role holds, so it is not a widening.
function serializeLinkRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    findingId: row.findingId,
    state: row.state,
    organizationId: row.organizationId,
    ownershipStatusAtLink: row.ownershipStatusAtLink,
    ownershipConfidenceAtLink:
      row.ownershipConfidenceAtLink === undefined ? null : row.ownershipConfidenceAtLink,
    reason: row.reason === undefined ? null : row.reason,
    actorUserId: row.actorUserId === undefined ? null : row.actorUserId,
    effectiveAt: row.effectiveAt,
    supersededAt: row.supersededAt === undefined ? null : row.supersededAt,
    createdAt: row.createdAt,
    // currentLinkKey is NOT emitted.
    isCurrent: row.supersededAt === null || row.supersededAt === undefined,
    finding: row.finding
      ? {
          id: row.finding.id,
          indicatorValue: row.finding.indicatorValue,
          port: row.finding.port,
          protocol: row.finding.protocol,
          reportType: row.finding.reportType,
          status: row.finding.status,
          firstSeen: row.finding.firstSeen,
          lastSeen: row.finding.lastSeen,
          occurrenceCount: row.finding.occurrenceCount,
          recurrenceCount: row.finding.recurrenceCount,
        }
      : undefined,
  };
}

function serializeLifecycleEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    eventType: row.eventType,
    fromState: row.fromState === undefined ? null : row.fromState,
    toState: row.toState,
    reasonCode: row.reasonCode,
    note: row.note === undefined ? null : row.note,
    actorUserId: row.actorUserId === undefined ? null : row.actorUserId,
    actor: row.actor ? serializeActor(row.actor) : undefined,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

function serializeOrganizationResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    responseType: row.responseType,
    summary: row.summary,
    // Stored and displayed verbatim, never dereferenced by anything in this
    // system — see the schema comment on CaseOrganizationResponse.reference.
    reference: row.reference === undefined ? null : row.reference,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    recordedByUserId: row.recordedByUserId === undefined ? null : row.recordedByUserId,
    recordedBy: row.recordedBy ? serializeActor(row.recordedBy) : undefined,
    createdAt: row.createdAt,
  };
}

function serializeClosureRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    state: row.state,
    closureReason: row.closureReason,
    justification: row.justification,
    requestedByUserId: row.requestedByUserId === undefined ? null : row.requestedByUserId,
    requestedBy: row.requestedBy ? serializeActor(row.requestedBy) : undefined,
    requestedAt: row.requestedAt,
    reviewedByUserId: row.reviewedByUserId === undefined ? null : row.reviewedByUserId,
    reviewedBy: row.reviewedBy ? serializeActor(row.reviewedBy) : undefined,
    reviewedAt: row.reviewedAt === undefined ? null : row.reviewedAt,
    reviewNote: row.reviewNote === undefined ? null : row.reviewNote,
    supportingResponseId:
      row.supportingResponseId === undefined ? null : row.supportingResponseId,
    createdAt: row.createdAt,
    // activeCaseId is NOT emitted; `isPending` conveys the same fact.
    isPending: row.state === "PENDING",
  };
}

// The recurrence ledger, minus its idempotency key. findingOccurrenceId is the
// "internal recurrence key" the brief forbids exposing: publishing it would
// let a caller enumerate or replay reopen processing for a specific occurrence.
function serializeRecurrenceReopen(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    findingId: row.findingId,
    outcome: row.outcome,
    observedAt: row.observedAt,
    processedAt: row.processedAt,
    createdAt: row.createdAt,
  };
}

module.exports = {
  serializeOrganizationSummary,
  serializeActor,
  serializeTriageRow,
  serializeCaseSummary,
  serializeLinkRow,
  serializeLifecycleEvent,
  serializeOrganizationResponse,
  serializeClosureRequest,
  serializeRecurrenceReopen,
};
