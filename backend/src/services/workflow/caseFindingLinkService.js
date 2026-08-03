"use strict";

// Append-only CaseFinding evidence linkage (Phase 3).
//
// ---------------------------------------------------------------------------
// Linking copies nothing
// ---------------------------------------------------------------------------
// Attaching a Finding to a case creates ONE CaseFinding row. It does not copy
// the indicator, the occurrences, the ownership row, the enrichment result or
// the risk score into the case, and it never writes to any of them. Every
// piece of Finding evidence continues to live in, and be read from, its own
// Phase 1/2 table. A case that duplicated evidence would immediately start
// drifting from it, and the copy — not the original — is what an analyst would
// be looking at when they decided to close.
//
// ---------------------------------------------------------------------------
// The organization-matching rule is the load-bearing safety property
// ---------------------------------------------------------------------------
// A Finding may be linked ONLY when its current ownership settled on exactly
// the case's organization, by a mechanism that identifies the constituent
// (RESOLVED or OVERRIDDEN, and not ISP-attributed). Ambiguous, unresolved,
// ISP-attributed and mismatched ownership are all refused with a closed reason
// code that tells the analyst to resolve ownership first. Getting this wrong
// is how a notification about one organization's exposure reaches a different
// organization.
//
// The check is evaluated by the pure evaluateLinkEligibility() and re-evaluated
// INSIDE the transaction against freshly read ownership, so an override applied
// concurrently cannot be raced past.

const {
  LINK_STATES,
  TRIAGE_SOURCES,
  MAX_LINK_REASON_LENGTH,
  CaseWorkflowNotFoundError,
  CaseWorkflowStateError,
  assertPositiveInteger,
  assertValidDate,
  evaluateLinkEligibility,
  normalizeBoundedText,
} = require("./caseWorkflowRules");

const { runSerializable } = require("./workflowTransaction");
const { loadCaseOrThrow, assertOrganizationBound } = require("./caseLifecycleService");
const { appendWorkflowEscalation } = require("./findingTriageService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const LINK_ENTITY_TYPE = "CaseFinding";

// "<caseId>:<findingId>" — the current-row key. Same shape and reasoning as
// FindingVulnerability.currentAssociationKey: the invariant is per PAIR, so a
// single integer column cannot express it.
function currentLinkKey(caseId, findingId) {
  return `${caseId}:${findingId}`;
}

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("Case finding link audit failed", { name: error && error.name });
  }
}

// Allow-listed audit payload. Deliberately carries NO indicator value: a
// case-link audit event is about the relationship, and putting a victim IP
// into AuditLog on every link would spread indicator data across a table read
// far more widely than the Finding itself.
function linkSummary(row) {
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
  };
}

async function loadCurrentLink(tx, caseId, findingId) {
  return tx.caseFinding.findUnique({ where: { currentLinkKey: currentLinkKey(caseId, findingId) } });
}

// Supersede-then-insert, identical in shape to the triage and ownership
// history writers. The prior row's ONLY mutation is supersededAt +
// currentLinkKey -> null; its state, organization and ownership snapshot are
// never rewritten.
async function appendLinkRow(tx, input) {
  const current = await loadCurrentLink(tx, input.caseId, input.findingId);
  if (current) {
    await tx.caseFinding.update({
      where: { id: current.id },
      data: { supersededAt: input.effectiveAt, currentLinkKey: null },
    });
  }

  return tx.caseFinding.create({
    data: {
      caseId: input.caseId,
      findingId: input.findingId,
      state: input.state,
      organizationId: input.organizationId,
      ownershipStatusAtLink: input.ownershipStatusAtLink,
      ownershipConfidenceAtLink: input.ownershipConfidenceAtLink,
      reason: input.reason,
      actorUserId: input.actorUserId,
      effectiveAt: input.effectiveAt,
      supersededAt: null,
      currentLinkKey: currentLinkKey(input.caseId, input.findingId),
    },
  });
}

/**
 * Links a Finding into a case as evidence.
 *
 * Refuses when the case is CLOSED (evidence cannot be added to a concluded
 * case without reopening it first) or CLOSURE_PENDING (adding evidence while a
 * reviewer is deciding would change what they are approving underneath them).
 *
 * Appends an ESCALATED triage row in the SAME transaction when that records a
 * real change — a Finding that is evidence in a live case is, by definition,
 * escalated, and the two must commit together or neither.
 *
 * Re-linking an already-linked Finding is a no-op that writes nothing.
 *
 * @returns {Promise<{link:object, changed:boolean, escalated:boolean}>}
 */
async function linkFinding(caseId, findingId, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  assertPositiveInteger(findingId, "findingId");
  const effectiveAt = assertValidDate(options.effectiveAt, "effectiveAt");
  const reason = normalizeBoundedText(options.reason, {
    field: "reason",
    maxLength: MAX_LINK_REASON_LENGTH,
    required: false,
  });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const caseRecord = assertOrganizationBound(await loadCaseOrThrow(client, caseId));
  if (caseRecord.lifecycleState === "CLOSED" || caseRecord.lifecycleState === "CLOSURE_PENDING") {
    throw new CaseWorkflowStateError(
      "Findings cannot be linked while the case is closed or awaiting closure review",
      "CASE_NOT_ACCEPTING_EVIDENCE"
    );
  }

  const finding = await client.finding.findUnique({ where: { id: findingId } });
  if (!finding) throw new CaseWorkflowNotFoundError("Finding not found");

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      // Ownership is re-read INSIDE the transaction. Evaluating it from the
      // pre-transaction read would let a concurrent clearOverride slip a
      // now-unresolved Finding into the case.
      const ownership = await tx.findingOwnership.findUnique({
        where: { currentForFindingId: findingId },
      });
      const eligibility = evaluateLinkEligibility(caseRecord, ownership);
      if (!eligibility.allowed) {
        throw new CaseWorkflowStateError(
          "Finding ownership does not permit linking to this case",
          eligibility.code
        );
      }

      const existing = await loadCurrentLink(tx, caseId, findingId);
      if (existing && existing.state === LINK_STATES.LINKED) {
        return { link: existing, changed: false, escalated: false };
      }

      const link = await appendLinkRow(tx, {
        caseId,
        findingId,
        state: LINK_STATES.LINKED,
        organizationId: caseRecord.organizationId,
        ownershipStatusAtLink: eligibility.ownershipStatus,
        ownershipConfidenceAtLink: eligibility.ownershipConfidence,
        reason,
        actorUserId,
        effectiveAt,
      });

      const escalation = await appendWorkflowEscalation(tx, {
        findingId,
        source: TRIAGE_SOURCES.CASE_LINK,
        caseId,
        actorUserId,
        decidedAt: effectiveAt,
      });

      return { link, changed: true, escalated: escalation.changed };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "case.finding.linked",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: LINK_ENTITY_TYPE,
      entityId: caseId,
      // Closed reason, never error.message. A CaseWorkflowStateError's own
      // `code` is a closed vocabulary value and is safe to include.
      reason:
        error instanceof CaseWorkflowStateError && error.code
          ? `Finding link refused (${error.code})`
          : "Finding link could not be persisted",
    });
    throw error;
  }

  if (outcome.changed) {
    await audit(client, auditContext, {
      action: "case.finding.linked",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: LINK_ENTITY_TYPE,
      entityId: outcome.link.id,
      after: { ...linkSummary(outcome.link), escalatedTriage: outcome.escalated },
      reason: "Finding linked to case as evidence",
    });
  }

  return outcome;
}

/**
 * Removes a Finding from a case by appending an UNLINKED state row.
 *
 * Never deletes the prior LINKED row: "this Finding was evidence in that case
 * between these two instants" must stay answerable, because a closure that was
 * justified partly by that Finding is only defensible if the link is still
 * visible. A reason is required for the same reason.
 *
 * Unlinking deliberately does NOT retract the ESCALATED triage decision. The
 * escalation was a real judgement made at a real time; a later decision that
 * this Finding did not belong in this case does not un-make it, and an analyst
 * who wants to change the triage state does so explicitly.
 */
async function unlinkFinding(caseId, findingId, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  assertPositiveInteger(findingId, "findingId");
  const effectiveAt = assertValidDate(options.effectiveAt, "effectiveAt");
  const reason = normalizeBoundedText(options.reason, {
    field: "reason",
    maxLength: MAX_LINK_REASON_LENGTH,
    required: true,
  });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const caseRecord = assertOrganizationBound(await loadCaseOrThrow(client, caseId));

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      const existing = await loadCurrentLink(tx, caseId, findingId);
      if (!existing || existing.state !== LINK_STATES.LINKED) {
        throw new CaseWorkflowStateError(
          "Finding is not currently linked to this case",
          "LINK_NOT_ACTIVE"
        );
      }

      const link = await appendLinkRow(tx, {
        caseId,
        findingId,
        state: LINK_STATES.UNLINKED,
        organizationId: existing.organizationId,
        // The ownership snapshot is carried forward verbatim from the LINKED
        // row rather than re-evaluated: this row records the removal of that
        // link, and re-deriving the basis now would misstate why it was
        // originally accepted.
        ownershipStatusAtLink: existing.ownershipStatusAtLink,
        ownershipConfidenceAtLink: existing.ownershipConfidenceAtLink,
        reason,
        actorUserId,
        effectiveAt,
      });

      return { link, changed: true };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "case.finding.unlinked",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: LINK_ENTITY_TYPE,
      entityId: caseId,
      reason:
        error instanceof CaseWorkflowStateError && error.code
          ? `Finding unlink refused (${error.code})`
          : "Finding unlink could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: "case.finding.unlinked",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: LINK_ENTITY_TYPE,
    entityId: outcome.link.id,
    before: { caseId, findingId, state: LINK_STATES.LINKED },
    after: linkSummary(outcome.link),
    reason: "Finding unlinked from case",
  });

  return outcome;
}

/**
 * Currently-linked rows for one case, oldest link first.
 */
async function listCurrentLinks(client, caseId, { includeFinding = true } = {}) {
  return client.caseFinding.findMany({
    where: { caseId, state: LINK_STATES.LINKED, supersededAt: null },
    orderBy: [{ effectiveAt: "asc" }, { id: "asc" }],
    ...(includeFinding ? { include: { finding: true } } : {}),
  });
}

/**
 * Cases one Finding is CURRENTLY evidence in. Used by the recurrence path and
 * by the Finding-side triage read.
 */
async function listCurrentLinksForFinding(client, findingId) {
  return client.caseFinding.findMany({
    where: { findingId, state: LINK_STATES.LINKED, supersededAt: null },
    orderBy: [{ effectiveAt: "asc" }, { id: "asc" }],
  });
}

module.exports = {
  LINK_ENTITY_TYPE,
  currentLinkKey,
  linkSummary,
  appendLinkRow,
  linkFinding,
  unlinkFinding,
  listCurrentLinks,
  listCurrentLinksForFinding,
};
