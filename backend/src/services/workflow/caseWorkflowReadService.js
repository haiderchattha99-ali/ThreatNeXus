"use strict";

// Safe read paths for the Phase 3 analyst workflow.
//
// Every row this module returns has crossed caseWorkflowSerializers.js, which
// is the single allow-list choke point. Nothing here selects an AuditLog row,
// a current-row key, an internal fingerprint, an organization contact field or
// an internal recurrence key — see that module's header for the full exclusion
// list and the dedicated test file that proves it.
//
// Reads are gated by read:cases / read:findings, which VIEWER holds, so these
// functions are the widest-audience code in the phase and are written
// accordingly: no free-text database error can reach them (controllers answer
// a fixed string), and no field is included merely because it happened to be
// on the row.

const {
  UNTRIAGED,
  CASE_STATES,
  CLOSURE_REQUEST_STATES,
  CaseWorkflowNotFoundError,
  assertPositiveInteger,
  analystAvailableStates,
} = require("./caseWorkflowRules");

const {
  serializeCaseSummary,
  serializeTriageRow,
  serializeLinkRow,
  serializeLifecycleEvent,
  serializeOrganizationResponse,
  serializeClosureRequest,
  serializeRecurrenceReopen,
} = require("./caseWorkflowSerializers");

const { listCurrentLinks, listCurrentLinksForFinding } = require("./caseFindingLinkService");

// Bounded page sizes. A case that accumulated thousands of responses must not
// be able to turn one detail read into an unbounded result set.
const MAX_TIMELINE_ROWS = 200;
const MAX_LINK_ROWS = 500;

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

// Only the three organization fields the workflow displays are selected at the
// QUERY level, not merely dropped at serialization time. Selecting the whole
// row and then filtering would still pull contact details into process memory
// and into any future logging of that object.
const ORGANIZATION_SELECT = Object.freeze({ id: true, name: true, sector: true });

/**
 * Case list. Returns the legacy-compatible fields plus the Phase 3 lifecycle
 * state, organization binding and a per-case linked-Finding count.
 *
 * The count comes from a grouped query rather than N per-case counts, so
 * listing stays one round trip regardless of how many cases exist.
 */
async function listCases(options = {}) {
  const client = resolveClient(options.client);

  const cases = await client.case.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { ownerOrganization: { select: ORGANIZATION_SELECT } },
  });

  const caseIds = cases.map((record) => record.id);
  const linkCounts =
    caseIds.length === 0
      ? []
      : await client.caseFinding.groupBy({
          by: ["caseId"],
          where: { caseId: { in: caseIds }, state: "LINKED", supersededAt: null },
          _count: { _all: true },
        });

  const countByCaseId = new Map(linkCounts.map((row) => [row.caseId, row._count._all]));

  return cases.map((record) => ({
    ...serializeCaseSummary(record),
    linkedFindingCount: countByCaseId.get(record.id) || 0,
  }));
}

/**
 * The complete case detail view: linked Findings, lifecycle timeline,
 * organization-response timeline, closure history and the recurrence-reopen
 * ledger, plus a permitted-actions block the frontend uses to decide which
 * controls to render.
 *
 * `permittedActions` is derived from the case's DURABLE STATE only — it says
 * nothing about the caller's capabilities. The frontend intersects it with the
 * caller's capability list for UX; the backend re-checks both the capability
 * (middleware) and the state (service) on every mutation regardless. A
 * frontend that ignored this block entirely could still not perform a
 * disallowed action.
 */
async function getCaseWorkflow(caseId, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  const client = resolveClient(options.client);

  const record = await client.case.findUnique({
    where: { id: caseId },
    include: { ownerOrganization: { select: ORGANIZATION_SELECT } },
  });
  if (!record) throw new CaseWorkflowNotFoundError("Case not found");

  const [links, lifecycleEvents, responses, closureRequests, recurrenceReopens] = await Promise.all([
    listCurrentLinks(client, caseId).then((rows) => rows.slice(0, MAX_LINK_ROWS)),
    client.caseLifecycleEvent.findMany({
      where: { caseId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: MAX_TIMELINE_ROWS,
    }),
    client.caseOrganizationResponse.findMany({
      where: { caseId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: MAX_TIMELINE_ROWS,
    }),
    client.caseClosureRequest.findMany({
      where: { caseId },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      take: MAX_TIMELINE_ROWS,
    }),
    client.caseRecurrenceReopen.findMany({
      where: { caseId },
      orderBy: [{ processedAt: "desc" }, { id: "desc" }],
      take: MAX_TIMELINE_ROWS,
    }),
  ]);

  const pendingClosureRequest =
    closureRequests.find((row) => row.state === CLOSURE_REQUEST_STATES.PENDING) || null;

  return {
    case: serializeCaseSummary(record),
    linkedFindings: links.map(serializeLinkRow),
    lifecycleEvents: lifecycleEvents.map(serializeLifecycleEvent),
    organizationResponses: responses.map(serializeOrganizationResponse),
    closureRequests: closureRequests.map(serializeClosureRequest),
    pendingClosureRequest: serializeClosureRequest(pendingClosureRequest),
    recurrenceReopens: recurrenceReopens.map(serializeRecurrenceReopen),
    permittedActions: derivePermittedActions(record, pendingClosureRequest),
  };
}

// State-derived only. Never consults a role or a capability — see
// getCaseWorkflow's note.
function derivePermittedActions(record, pendingClosureRequest) {
  const state = record.lifecycleState;
  const bound = Number.isInteger(record.organizationId);
  const acceptsEvidence = state === CASE_STATES.OPEN || state === CASE_STATES.WAITING_FOR_ORG;

  return {
    isOrganizationBound: bound,
    canLinkFindings: bound && acceptsEvidence,
    canUnlinkFindings: bound && acceptsEvidence,
    canRecordResponse: bound && state !== CASE_STATES.CLOSED,
    canRequestClosure: bound && acceptsEvidence && pendingClosureRequest === null,
    canReviewClosure: bound && state === CASE_STATES.CLOSURE_PENDING && pendingClosureRequest !== null,
    canReopen: bound && state === CASE_STATES.CLOSED,
    // Which OPEN/WAITING_FOR_ORG targets are reachable right now. Derived from
    // the SAME rule caseLifecycleService guards with, so the frontend can
    // neither offer a transition the service would refuse nor hide one it
    // would accept. Empty while CLOSURE_PENDING or CLOSED — leaving either is
    // a reviewer decision or an explicit reopen, not a state change.
    availableStates: bound ? analystAvailableStates(state) : [],
  };
}

/**
 * Finding-side view: the current triage decision, the append-only triage
 * history, and the cases this Finding is currently evidence in.
 *
 * The case context is what makes the Findings screen able to show "escalated
 * into TNX-2026-000042" rather than a bare decision with no explanation.
 */
async function getFindingTriageContext(findingId, options = {}) {
  assertPositiveInteger(findingId, "findingId");
  const client = resolveClient(options.client);

  const finding = await client.finding.findUnique({ where: { id: findingId } });
  if (!finding) throw new CaseWorkflowNotFoundError("Finding not found");

  const [history, links] = await Promise.all([
    client.findingTriage.findMany({
      where: { findingId },
      orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
      take: MAX_TIMELINE_ROWS,
    }),
    listCurrentLinksForFinding(client, findingId),
  ]);

  const current = history.find((row) => row.supersededAt === null) || null;

  const linkedCaseIds = links.map((link) => link.caseId);
  const linkedCases =
    linkedCaseIds.length === 0
      ? []
      : await client.case.findMany({
          where: { id: { in: linkedCaseIds } },
          include: { ownerOrganization: { select: ORGANIZATION_SELECT } },
          orderBy: [{ id: "asc" }],
        });

  // Current ownership is included because it is precisely what decides whether
  // this Finding can be linked to a case at all, and an analyst looking at an
  // unlinkable Finding needs to be told why. Only the decision fields are
  // exposed — never the matched mapping's address range.
  const ownership = await client.findingOwnership.findUnique({
    where: { currentForFindingId: findingId },
  });

  return {
    findingId,
    decision: current ? current.decision : UNTRIAGED,
    current: serializeTriageRow(current),
    history: history.map(serializeTriageRow),
    linkedCases: linkedCases.map(serializeCaseSummary),
    ownership: ownership
      ? {
          status: ownership.status,
          confidence: ownership.confidence,
          organizationId: ownership.organizationId,
          isIspAttribution: ownership.isIspAttribution,
          reasonCode: ownership.reasonCode,
        }
      : null,
  };
}

module.exports = {
  MAX_TIMELINE_ROWS,
  MAX_LINK_ROWS,
  ORGANIZATION_SELECT,
  listCases,
  getCaseWorkflow,
  derivePermittedActions,
  getFindingTriageContext,
};
