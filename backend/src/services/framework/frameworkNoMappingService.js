"use strict";

// "No reference in this framework applies to this case", recorded explicitly
// (Phase 6.3).
//
// ===========================================================================
// The state this exists to stop being invisible
// ===========================================================================
// A case with no ATT&CK mapping is, without this table, ambiguous in the worst
// possible way. It might mean an analyst read the evidence and correctly
// concluded that nothing in ATT&CK applies — which is the RIGHT answer for most
// Accessible-RDP findings, because an exposed service is a condition, not
// adversary behaviour. Or it might mean nobody has looked yet.
//
// Those are opposite states. A navigator that renders both as an empty cell
// tells an analyst nothing while appearing to tell them something, and — worse
// — makes the honest answer look like unfinished work. That is precisely the
// pressure that produces a forced mapping: the analyst reaches for the nearest
// plausible technique to make the blank go away. The build guard forbids a
// "percentage mapped" metric for the same reason, and this table is the
// constructive half of that prohibition: it gives "we looked, and nothing
// applies" a first-class recordable form, so it can be a completed action
// rather than a gap.
//
// ===========================================================================
// Shape
// ===========================================================================
// Append-only, supersede-then-insert, one current row per (case, framework) —
// the same discipline as CaseFrameworkMapping, and for the same reason: "this
// case was determined to have no applicable ATT&CK technique between these two
// instants, by this analyst, for this stated reason" must stay answerable after
// somebody later disagrees.
//
// Withdrawing appends a WITHDRAWN row. Nothing is deleted, and repeating an
// operation that would change nothing writes nothing and reports UNCHANGED.
//
// ===========================================================================
// Mutual exclusion with active mappings
// ===========================================================================
// A framework cannot simultaneously carry an active mapping and a standing
// determination that nothing in it applies. Both directions are refused, and
// the refusal names what to do: withdraw the other one first. Forcing the
// reversal to be an explicit, attributed act is the whole point — silently
// dropping the assertion when a mapping arrives would erase the record that an
// analyst once decided otherwise.

const {
  FRAMEWORK_FAMILY_VALUES,
  MAPPING_STATES,
  MIN_RATIONALE_LENGTH,
  MAX_RATIONALE_LENGTH,
  MAX_REMOVAL_REASON_LENGTH,
  FrameworkMappingNotFoundError,
  FrameworkMappingStateError,
  assertMemberOf,
  assertPositiveInteger,
  assertValidDate,
  normalizeBoundedText,
} = require("./frameworkMappingRules");

const { MAPPING_REJECTION_CODES } = require("./frameworkMappingErrors");

const { runSerializable } = require("../workflow/workflowTransaction");
const { loadCaseOrThrow, assertOrganizationBound } = require("../workflow/caseLifecycleService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const NO_MAPPING_ENTITY_TYPE = "CaseFrameworkNoMappingAssertion";

const NO_MAPPING_STATES = Object.freeze({ ASSERTED: "ASSERTED", WITHDRAWN: "WITHDRAWN" });

const NO_MAPPING_OUTCOMES = Object.freeze({
  ASSERTED: "ASSERTED",
  REASSERTED: "REASSERTED",
  WITHDRAWN: "WITHDRAWN",
  UNCHANGED: "UNCHANGED",
});

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("Framework no-mapping audit failed", { name: error && error.name });
  }
}

/**
 * "<caseId>:<framework>" — the current-row key. Same distinct-NULLs mechanism
 * as currentMappingKey; a single column cannot express "at most one current row
 * per (case, framework)".
 */
function currentAssertionKey(caseId, framework) {
  return `${caseId}:${framework}`;
}

// Allow-listed audit payload. Carries no rationale TEXT — an analyst explaining
// why nothing applies may well describe the constituent's environment — but
// records its length, so "was anything actually written?" stays answerable.
function assertionSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    organizationId: row.organizationId,
    framework: row.framework,
    state: row.state,
    rationaleLength: typeof row.rationale === "string" ? row.rationale.length : 0,
  };
}

async function loadCurrentAssertion(tx, caseId, framework) {
  return tx.caseFrameworkNoMappingAssertion.findUnique({
    where: { currentAssertionKey: currentAssertionKey(caseId, framework) },
  });
}

/**
 * The symmetric half of frameworkMappingService.assertNoStandingNoMappingAssertion.
 */
async function assertNoActiveMappings(tx, caseId, framework) {
  const active = await tx.caseFrameworkMapping.findFirst({
    where: { caseId, framework, state: MAPPING_STATES.ACTIVE, supersededAt: null },
    select: { id: true },
  });
  if (active) {
    throw new FrameworkMappingStateError(
      "This case already carries an active mapping in this framework; remove it before recording that no reference applies",
      MAPPING_REJECTION_CODES.NO_APPLICABLE_CONFLICTS_WITH_ACTIVE_MAPPING
    );
  }
}

async function appendAssertionRow(tx, input) {
  const current = await loadCurrentAssertion(tx, input.caseId, input.framework);
  if (current) {
    await tx.caseFrameworkNoMappingAssertion.update({
      where: { id: current.id },
      data: { supersededAt: input.effectiveAt, currentAssertionKey: null },
    });
  }

  return tx.caseFrameworkNoMappingAssertion.create({
    data: {
      caseId: input.caseId,
      organizationId: input.organizationId,
      framework: input.framework,
      rationale: input.rationale,
      state: input.state,
      actorUserId: input.actorUserId,
      effectiveAt: input.effectiveAt,
      supersededAt: null,
      currentAssertionKey: currentAssertionKey(input.caseId, input.framework),
    },
  });
}

/**
 * Records that a named analyst determined no reference in `framework` applies
 * to this case.
 *
 * The rationale carries the SAME minimum length a mapping rationale carries. An
 * unexplained "nothing applies" is as unreviewable as an unexplained mapping,
 * and is arguably harder to challenge later precisely because it points at no
 * reference for a reviewer to check.
 */
async function assertNoApplicableMapping(caseId, framework, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  const family = assertMemberOf(framework, FRAMEWORK_FAMILY_VALUES, "framework");
  const effectiveAt = assertValidDate(options.effectiveAt, "effectiveAt");
  const rationale = normalizeBoundedText(options.rationale, {
    field: "rationale",
    maxLength: MAX_RATIONALE_LENGTH,
    minLength: MIN_RATIONALE_LENGTH,
    required: true,
  });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const caseRecord = assertOrganizationBound(await loadCaseOrThrow(client, caseId));

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      await assertNoActiveMappings(tx, caseRecord.id, family);

      const current = await loadCurrentAssertion(tx, caseRecord.id, family);
      // Repeating a standing assertion writes nothing. Without this a
      // double-submitted form would append an identical row and the history
      // would stop being a record of decisions.
      if (current && current.state === NO_MAPPING_STATES.ASSERTED) {
        return { assertion: current, outcome: NO_MAPPING_OUTCOMES.UNCHANGED, changed: false };
      }

      const assertion = await appendAssertionRow(tx, {
        caseId: caseRecord.id,
        organizationId: caseRecord.organizationId,
        framework: family,
        rationale,
        state: NO_MAPPING_STATES.ASSERTED,
        actorUserId,
        effectiveAt,
      });

      return {
        assertion,
        // REASSERTED when a WITHDRAWN row preceded it: "we decided this, changed
        // our mind, and changed it back" is a different story from "this is new".
        outcome: current ? NO_MAPPING_OUTCOMES.REASSERTED : NO_MAPPING_OUTCOMES.ASSERTED,
        changed: true,
      };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "framework.no_mapping.failed",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: NO_MAPPING_ENTITY_TYPE,
      entityId: caseId,
      reason:
        error instanceof FrameworkMappingStateError && error.code
          ? `No-applicable-mapping determination refused (${error.code})`
          : "No-applicable-mapping determination could not be persisted",
    });
    throw error;
  }

  if (!outcome.changed) {
    await audit(client, auditContext, {
      action: "framework.no_mapping.unchanged",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: NO_MAPPING_ENTITY_TYPE,
      entityId: outcome.assertion.id,
      after: assertionSummary(outcome.assertion),
      reason: "No-applicable-mapping determination already stands; nothing written",
    });
    return outcome;
  }

  await audit(client, auditContext, {
    action: "framework.no_mapping.asserted",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: NO_MAPPING_ENTITY_TYPE,
    entityId: outcome.assertion.id,
    after: { ...assertionSummary(outcome.assertion), outcome: outcome.outcome },
    reason:
      outcome.outcome === NO_MAPPING_OUTCOMES.REASSERTED
        ? "No-applicable-mapping determination reasserted"
        : "No-applicable-mapping determination recorded",
  });

  return outcome;
}

/**
 * Withdraws a standing determination by appending a WITHDRAWN row.
 *
 * Identified by row id, and verified to belong to this case AND to be the
 * current row — the same stale-page guard removeMapping uses.
 */
async function withdrawNoApplicableMapping(caseId, assertionId, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  assertPositiveInteger(assertionId, "assertionId");
  const effectiveAt = assertValidDate(options.effectiveAt, "effectiveAt");
  const reason = normalizeBoundedText(options.reason, {
    field: "reason",
    maxLength: MAX_REMOVAL_REASON_LENGTH,
    required: true,
  });

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;

  const caseRecord = assertOrganizationBound(await loadCaseOrThrow(client, caseId));

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) => {
      const existing = await tx.caseFrameworkNoMappingAssertion.findUnique({
        where: { id: assertionId },
      });
      if (!existing) {
        throw new FrameworkMappingNotFoundError("No-applicable-mapping determination not found");
      }
      if (existing.caseId !== caseRecord.id) {
        throw new FrameworkMappingStateError(
          "This determination does not belong to this case",
          MAPPING_REJECTION_CODES.NO_APPLICABLE_ASSERTION_NOT_FOR_CASE
        );
      }
      if (existing.supersededAt !== null || existing.currentAssertionKey === null) {
        throw new FrameworkMappingStateError(
          "This determination is not the current row for its framework",
          MAPPING_REJECTION_CODES.NO_APPLICABLE_ASSERTION_NOT_CURRENT
        );
      }
      if (existing.state === NO_MAPPING_STATES.WITHDRAWN) {
        return { assertion: existing, outcome: NO_MAPPING_OUTCOMES.UNCHANGED, changed: false };
      }

      const assertion = await appendAssertionRow(tx, {
        caseId: caseRecord.id,
        organizationId: existing.organizationId,
        framework: existing.framework,
        // On a WITHDRAWN row the rationale IS the withdrawal reason. Keeping the
        // original would make the row read as a fresh determination — the same
        // choice removeMapping makes for a REMOVED mapping.
        rationale: reason,
        state: NO_MAPPING_STATES.WITHDRAWN,
        actorUserId,
        effectiveAt,
      });

      return { assertion, outcome: NO_MAPPING_OUTCOMES.WITHDRAWN, changed: true };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "framework.no_mapping.failed",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: NO_MAPPING_ENTITY_TYPE,
      entityId: assertionId,
      reason:
        error instanceof FrameworkMappingStateError && error.code
          ? `No-applicable-mapping withdrawal refused (${error.code})`
          : "No-applicable-mapping withdrawal could not be persisted",
    });
    throw error;
  }

  await audit(client, auditContext, {
    action: outcome.changed
      ? "framework.no_mapping.withdrawn"
      : "framework.no_mapping.unchanged",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: NO_MAPPING_ENTITY_TYPE,
    entityId: outcome.assertion.id,
    before: outcome.changed
      ? { id: assertionId, caseId, state: NO_MAPPING_STATES.ASSERTED }
      : undefined,
    after: assertionSummary(outcome.assertion),
    reason: outcome.changed
      ? "No-applicable-mapping determination withdrawn"
      : "No-applicable-mapping determination already withdrawn; nothing written",
  });

  return outcome;
}

/**
 * Current standing determinations for one case, deterministically ordered.
 */
async function listStandingAssertions(client, caseId) {
  return client.caseFrameworkNoMappingAssertion.findMany({
    where: { caseId, state: NO_MAPPING_STATES.ASSERTED, supersededAt: null },
    orderBy: [{ framework: "asc" }, { id: "asc" }],
    include: { actor: { select: { id: true, name: true, role: true } } },
  });
}

async function listAssertionHistory(client, caseId, { take = 50, skip = 0 } = {}) {
  const boundedTake = Math.min(Math.max(Number.isInteger(take) ? take : 50, 1), 200);
  const boundedSkip = Math.max(Number.isInteger(skip) ? skip : 0, 0);
  return client.caseFrameworkNoMappingAssertion.findMany({
    where: { caseId },
    orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
    take: boundedTake,
    skip: boundedSkip,
    include: { actor: { select: { id: true, name: true, role: true } } },
  });
}

module.exports = {
  NO_MAPPING_ENTITY_TYPE,
  NO_MAPPING_STATES,
  NO_MAPPING_OUTCOMES,
  currentAssertionKey,
  assertionSummary,
  loadCurrentAssertion,
  assertNoActiveMappings,
  appendAssertionRow,
  assertNoApplicableMapping,
  withdrawNoApplicableMapping,
  listStandingAssertions,
  listAssertionHistory,
};
