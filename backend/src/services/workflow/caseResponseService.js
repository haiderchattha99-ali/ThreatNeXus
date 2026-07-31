"use strict";

// Append-only organization-response timeline (Phase 3).
//
// ---------------------------------------------------------------------------
// A response is a claim, never proof, and never closes anything
// ---------------------------------------------------------------------------
// Recording a REMEDIATED response asserts only that the affected organization
// SAID the exposure was fixed. This module deliberately performs no lifecycle
// transition of any kind — it does not touch Case.lifecycleState, it does not
// create a closure request, and it does not verify remediation (automatic
// remediation verification is explicitly out of scope per AGENTS.md).
//
// A REMEDIATED response only becomes load-bearing later, and only as a
// PRECONDITION: caseClosureService refuses a REMEDIATED closure request unless
// one exists, and records exactly which one the closure rests on.
//
// Rows are never updated or deleted. Correcting a mistaken response means
// recording a further response, so the original claim and the correction both
// stay visible.

const {
  RESPONSE_TYPES,
  RESPONSE_TYPE_VALUES,
  MAX_RESPONSE_SUMMARY_LENGTH,
  MAX_RESPONSE_REFERENCE_LENGTH,
  CaseWorkflowStateError,
  assertMemberOf,
  assertPositiveInteger,
  assertValidDate,
  normalizeBoundedText,
} = require("./caseWorkflowRules");

const { loadCaseOrThrow, assertOrganizationBound } = require("./caseLifecycleService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const RESPONSE_ENTITY_TYPE = "CaseOrganizationResponse";

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("Case response audit failed", { name: error && error.name });
  }
}

// Allow-listed audit payload. The response SUMMARY and REFERENCE are
// deliberately excluded and reduced to booleans + a length: the summary is
// analyst-authored free text describing third-party correspondence, and
// copying it into AuditLog would put that correspondence into a second table
// with a different retention story. "A REMEDIATED response with a reference
// was recorded at this time by this actor" is what an auditor needs.
function responseSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    responseType: row.responseType,
    occurredAt: row.occurredAt,
    hasReference: typeof row.reference === "string" && row.reference.length > 0,
    summaryLength: typeof row.summary === "string" ? row.summary.length : 0,
  };
}

/**
 * Records one organization response on a case.
 *
 * Refused only when the case is CLOSED — a concluded case must be reopened
 * before its correspondence timeline can grow again, otherwise a closure's
 * evidence base could change after the reviewer approved it. CLOSURE_PENDING
 * is deliberately ALLOWED: an organization replying while a reviewer is
 * deciding is exactly the information that reviewer needs.
 *
 * @param {number} caseId
 * @param {{responseType:string, summary:string, reference?:string|null,
 *   occurredAt:Date}} input
 * @param {{client?:object, actorUserId?:number|null, auditContext?:object,
 *   recordedAt:Date}} options
 */
async function recordOrganizationResponse(caseId, input, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  const responseType = assertMemberOf(
    input && input.responseType,
    RESPONSE_TYPE_VALUES,
    "responseType"
  );
  const occurredAt = assertValidDate(input && input.occurredAt, "occurredAt");
  const recordedAt = assertValidDate(options.recordedAt, "recordedAt");
  const summary = normalizeBoundedText(input && input.summary, {
    field: "summary",
    maxLength: MAX_RESPONSE_SUMMARY_LENGTH,
    required: true,
  });
  const reference = normalizeBoundedText(input && input.reference, {
    field: "reference",
    maxLength: MAX_RESPONSE_REFERENCE_LENGTH,
    required: false,
  });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const caseRecord = assertOrganizationBound(await loadCaseOrThrow(client, caseId));
  if (caseRecord.lifecycleState === "CLOSED") {
    throw new CaseWorkflowStateError(
      "Responses cannot be recorded on a closed case",
      "CASE_CLOSED"
    );
  }

  let row;
  try {
    row = await client.caseOrganizationResponse.create({
      data: {
        caseId,
        responseType,
        summary,
        reference,
        occurredAt,
        recordedAt,
        recordedByUserId: actorUserId,
      },
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "case.response.recorded",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: RESPONSE_ENTITY_TYPE,
      entityId: caseId,
      reason: "Organization response could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "case.response.recorded",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: RESPONSE_ENTITY_TYPE,
    entityId: row.id,
    after: responseSummary(row),
    // Stated explicitly in the audit trail so nobody reading it later can
    // mistake a REMEDIATED claim for a verified remediation.
    reason:
      responseType === RESPONSE_TYPES.REMEDIATED
        ? "Organization reported remediation (claim recorded, not verified)"
        : "Organization response recorded",
  });

  return row;
}

/**
 * Newest-first response timeline for one case.
 */
async function listResponses(client, caseId) {
  return client.caseOrganizationResponse.findMany({
    where: { caseId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
}

/**
 * The most recent REMEDIATED response for a case, or null.
 *
 * This is the precondition caseClosureService checks. It returns the ROW, not
 * a boolean, because the closure request must persist which specific response
 * it rests on (CaseClosureRequest.supportingResponseId) — a boolean check
 * would prove the rule held at request time and leave nothing behind afterwards.
 */
async function findLatestRemediatedResponse(client, caseId) {
  return client.caseOrganizationResponse.findFirst({
    where: { caseId, responseType: RESPONSE_TYPES.REMEDIATED },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
}

module.exports = {
  RESPONSE_ENTITY_TYPE,
  responseSummary,
  recordOrganizationResponse,
  listResponses,
  findLatestRemediatedResponse,
};
