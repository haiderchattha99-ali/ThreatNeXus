"use strict";

// Append-only manual framework mapping (Phase 5).
//
// ---------------------------------------------------------------------------
// This is the ONLY module in the repository that writes a CaseFrameworkMapping
// ---------------------------------------------------------------------------
// The AI promotion path (services/ai/aiSuggestionDecisionService.js) does not
// have its own writer: it calls appendMappingWithinTransaction below, the exact
// function the analyst form calls. That is not a stylistic preference — it is
// what makes "an approved suggestion is held to the same standard as a
// hand-written mapping" a structural fact rather than a claim. There is no
// second code path that could drift, relax a rule, or skip the ATT&CK evidence
// gate.
//
// ---------------------------------------------------------------------------
// Append-only, and REMOVED is a state
// ---------------------------------------------------------------------------
// Removing a mapping appends a REMOVED row; re-adding appends a fresh ACTIVE
// row. The prior rows are never rewritten except for supersededAt and
// currentMappingKey, and nothing here — or anywhere in this phase — deletes
// one. "This control was associated with this case between these two instants,
// by this analyst, on this basis" has to stay answerable, because a report or a
// closure that cited the mapping is only defensible while it is still visible.
//
// Repeating an operation that would not change the current state writes NOTHING
// and reports UNCHANGED. Without that guard a double-clicked button would append
// an identical row, and the history would stop being a record of decisions.
//
// ---------------------------------------------------------------------------
// Evidence obligations enforced here (the ones needing the database)
// ---------------------------------------------------------------------------
//   - the case must exist and be organization-bound (a legacy, non-bound case
//     refuses every Phase 5 operation, exactly as it refuses every Phase 3/4
//     one)
//   - evidenceFindingId, when supplied, must be a Finding CURRENTLY linked to
//     THIS case — re-read inside the transaction so a concurrent unlink cannot
//     be raced past
//   - a MITRE ATT&CK mapping must be tied to evidence: either it names a
//     currently-linked Finding, or the case has at least one currently-linked
//     Finding. An ATT&CK technique asserted against a case holding no evidence
//     at all is an assertion about nothing.
//
// The purely lexical/structural obligations (evidenceBasis, rationale
// substance, reference id shape, bounds) are decided before any transaction
// opens, by frameworkMappingRules.normalizeMappingContent.

const {
  MAPPING_STATES,
  MAPPING_SOURCES,
  MAPPING_SOURCE_VALUES,
  MAPPING_REJECTION_CODES,
  FRAMEWORK_FAMILIES,
  MAX_REMOVAL_REASON_LENGTH,
  FrameworkMappingNotFoundError,
  FrameworkMappingStateError,
  assertMemberOf,
  assertPositiveInteger,
  assertValidDate,
  normalizeBoundedText,
  normalizeMappingContent,
  currentMappingKey,
  isMappingChangeMeaningful,
} = require("./frameworkMappingRules");

const { runSerializable } = require("../workflow/workflowTransaction");
const { loadCaseOrThrow, assertOrganizationBound } = require("../workflow/caseLifecycleService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const MAPPING_ENTITY_TYPE = "CaseFrameworkMapping";

// Closed outcome vocabulary returned to callers and written into audit
// payloads. Never free text.
const MAPPING_OUTCOMES = Object.freeze({
  CREATED: "CREATED",
  REACTIVATED: "REACTIVATED",
  REMOVED: "REMOVED",
  UNCHANGED: "UNCHANGED",
});

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

// Audit writes can never roll back or alter a mapping: they run outside the
// transaction and their own failure is swallowed here. Same division as every
// Phase 3/4 workflow service.
async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("Framework mapping audit failed", { name: error && error.name });
  }
}

// Allow-listed audit payload.
//
// Deliberately carries NO rationale text, NO removal reason text and NO
// indicator value. referenceId/framework/version ARE included: they are the
// framework's own published identifiers, they are what an investigator needs to
// know which control was associated, and they carry nothing about the
// constituent. Rationale length is recorded instead of rationale content, so
// "was anything actually written?" stays answerable without copying analyst
// prose into a table that is read far more widely than the case itself.
function mappingSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    organizationId: row.organizationId,
    framework: row.framework,
    frameworkVersion: row.frameworkVersion,
    referenceId: row.referenceId,
    mappingScope: row.mappingScope,
    evidenceBasis: row.evidenceBasis,
    state: row.state,
    source: row.source,
    evidenceFindingId: row.evidenceFindingId === undefined ? null : row.evidenceFindingId,
    rationaleLength: typeof row.rationale === "string" ? row.rationale.length : 0,
  };
}

async function loadCurrentMapping(tx, caseId, content) {
  return tx.caseFrameworkMapping.findUnique({
    where: {
      currentMappingKey: currentMappingKey(
        caseId,
        content.framework,
        content.mappingScope,
        content.referenceId
      ),
    },
  });
}

// Currently-LINKED Finding ids for one case. Read inside the caller's
// transaction so evidence eligibility is decided against the same snapshot the
// write commits under.
async function currentlyLinkedFindingIds(tx, caseId) {
  const links = await tx.caseFinding.findMany({
    where: { caseId, state: "LINKED", supersededAt: null },
    select: { findingId: true },
  });
  return links.map((link) => link.findingId);
}

/**
 * Evidence obligations that require reading the database.
 *
 * Throws FrameworkMappingStateError (never a validation error): the content was
 * well formed, the durable state refuses it.
 */
async function assertEvidenceObligations(tx, caseId, content) {
  const linkedFindingIds = await currentlyLinkedFindingIds(tx, caseId);

  if (content.evidenceFindingId !== null && !linkedFindingIds.includes(content.evidenceFindingId)) {
    throw new FrameworkMappingStateError(
      "evidenceFindingId must be a Finding currently linked to this case",
      MAPPING_REJECTION_CODES.EVIDENCE_FINDING_NOT_LINKED
    );
  }

  if (content.framework === FRAMEWORK_FAMILIES.MITRE_ATTACK) {
    const tiedToEvidence = content.evidenceFindingId !== null || linkedFindingIds.length > 0;
    if (!tiedToEvidence) {
      throw new FrameworkMappingStateError(
        "A MITRE ATT&CK mapping requires evidence tied to the case or to a linked Finding",
        MAPPING_REJECTION_CODES.ATTACK_EVIDENCE_NOT_LINKED
      );
    }
  }
}

// Supersede-then-insert, identical in shape to CaseFinding's and
// FindingTriage's history writers. The prior row's ONLY mutation is
// supersededAt + currentMappingKey -> null; its state, content, actor and
// evidence are never rewritten.
async function appendMappingRow(tx, input) {
  const current = await loadCurrentMapping(tx, input.caseId, input.content);
  if (current) {
    await tx.caseFrameworkMapping.update({
      where: { id: current.id },
      data: { supersededAt: input.effectiveAt, currentMappingKey: null },
    });
  }

  return tx.caseFrameworkMapping.create({
    data: {
      caseId: input.caseId,
      organizationId: input.organizationId,
      framework: input.content.framework,
      frameworkVersion: input.content.frameworkVersion,
      referenceId: input.content.referenceId,
      referenceTitle: input.content.referenceTitle,
      mappingScope: input.content.mappingScope,
      evidenceBasis: input.content.evidenceBasis,
      rationale: input.content.rationale,
      evidenceFindingId: input.content.evidenceFindingId,
      state: input.state,
      source: input.source,
      actorUserId: input.actorUserId,
      effectiveAt: input.effectiveAt,
      supersededAt: null,
      currentMappingKey: currentMappingKey(
        input.caseId,
        input.content.framework,
        input.content.mappingScope,
        input.content.referenceId
      ),
    },
  });
}

/**
 * THE shared mapping writer. Runs inside a transaction the caller already
 * opened, so a promotion can commit the mapping and the suggestion decision
 * together or not at all.
 *
 * Re-validates the content and re-checks every database-backed evidence
 * obligation against `tx`, regardless of what the caller already checked. A
 * caller that skipped validation cannot get a row past this function.
 *
 * @param {object} tx        an open Prisma transaction client
 * @param {object} params
 * @param {object} params.caseRecord      already-loaded, organization-bound Case
 * @param {object} params.content         raw or normalized mapping content
 * @param {string} params.source          MANUAL | AI_SUGGESTION_PROMOTED
 * @param {number|null} params.actorUserId the HUMAN who caused this write
 * @param {Date} params.effectiveAt
 * @returns {Promise<{mapping:object|null, outcome:string, changed:boolean}>}
 */
async function appendMappingWithinTransaction(tx, params) {
  const caseRecord = params.caseRecord;
  const source = assertMemberOf(params.source, MAPPING_SOURCE_VALUES, "source");
  const effectiveAt = assertValidDate(params.effectiveAt, "effectiveAt");
  const actorUserId = Number.isInteger(params.actorUserId) ? params.actorUserId : null;

  // Re-normalized here even when the caller already did it: normalization is
  // idempotent, and re-running it means no caller can hand this function
  // content that skipped the ATT&CK gate.
  const content = normalizeMappingContent(params.content);

  await assertEvidenceObligations(tx, caseRecord.id, content);

  const current = await loadCurrentMapping(tx, caseRecord.id, content);
  if (!isMappingChangeMeaningful(current, MAPPING_STATES.ACTIVE)) {
    return { mapping: current, outcome: MAPPING_OUTCOMES.UNCHANGED, changed: false };
  }

  const mapping = await appendMappingRow(tx, {
    caseId: caseRecord.id,
    organizationId: caseRecord.organizationId,
    content,
    state: MAPPING_STATES.ACTIVE,
    source,
    actorUserId,
    effectiveAt,
  });

  return {
    mapping,
    // REACTIVATED when a REMOVED row for this exact key preceded it. Reported
    // distinctly from CREATED because "this control was withdrawn and later
    // re-associated" is a different story from "this is new", and the frontend
    // says so.
    outcome: current ? MAPPING_OUTCOMES.REACTIVATED : MAPPING_OUTCOMES.CREATED,
    changed: true,
  };
}

/**
 * Creates (or reactivates) a manual framework mapping on one case.
 *
 * A manual mapping becomes ACTIVE immediately: it is an explicit act by an
 * authenticated human analyst holding manage:framework-mappings, and requiring
 * a second human to confirm what the first one just typed would add ceremony
 * without adding assurance. The AI path is different precisely because the
 * content did not originate with a human — see aiSuggestionDecisionService.
 *
 * Creation and reactivation are ONE endpoint and ONE code path on purpose. A
 * separate "reactivate" writer would be a second place the evidence rules could
 * drift; here, re-adding a removed mapping is simply a create that finds a
 * REMOVED current row.
 */
async function createManualMapping(caseId, content, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  const effectiveAt = assertValidDate(options.effectiveAt, "effectiveAt");

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;
  const source = options.source || MAPPING_SOURCES.MANUAL;

  // Normalized BEFORE the transaction so a malformed request is a 400 at the
  // boundary and never opens one.
  const normalized = normalizeMappingContent(content);

  await audit(client, auditContext, {
    action: "framework.mapping.requested",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: MAPPING_ENTITY_TYPE,
    entityId: caseId,
    after: {
      caseId,
      framework: normalized.framework,
      frameworkVersion: normalized.frameworkVersion,
      referenceId: normalized.referenceId,
      mappingScope: normalized.mappingScope,
      evidenceBasis: normalized.evidenceBasis,
      source,
    },
    reason: "Framework mapping requested",
  });

  const caseRecord = assertOrganizationBound(await loadCaseOrThrow(client, caseId));

  let outcome;
  try {
    outcome = await runSerializable(client, async (tx) =>
      appendMappingWithinTransaction(tx, {
        caseRecord,
        content: normalized,
        source,
        actorUserId,
        effectiveAt,
      })
    );
  } catch (error) {
    await audit(client, auditContext, {
      action: "framework.mapping.failed",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: MAPPING_ENTITY_TYPE,
      entityId: caseId,
      // Closed reason code only, never error.message.
      reason:
        error instanceof FrameworkMappingStateError && error.code
          ? `Framework mapping refused (${error.code})`
          : "Framework mapping could not be persisted",
    });
    throw error;
  }

  if (!outcome.changed) {
    await audit(client, auditContext, {
      action: "framework.mapping.unchanged",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: MAPPING_ENTITY_TYPE,
      entityId: outcome.mapping ? outcome.mapping.id : caseId,
      after: mappingSummary(outcome.mapping),
      reason: "Framework mapping already active; nothing written",
    });
    return outcome;
  }

  await audit(client, auditContext, {
    action: "framework.mapping.created",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: MAPPING_ENTITY_TYPE,
    entityId: outcome.mapping.id,
    after: { ...mappingSummary(outcome.mapping), outcome: outcome.outcome },
    reason:
      outcome.outcome === MAPPING_OUTCOMES.REACTIVATED
        ? "Framework mapping reactivated"
        : "Framework mapping created",
  });

  return outcome;
}

/**
 * Withdraws a currently-ACTIVE mapping by appending a REMOVED row.
 *
 * Identified by row id rather than by content so a caller cannot accidentally
 * withdraw a different mapping than the one on their screen; the row is then
 * verified to belong to this case AND to be the current row for its key, which
 * is what stops a stale page from superseding a newer decision it never saw.
 *
 * A reason is required: withdrawing a control association without saying why
 * leaves the earlier assertion unexplained.
 */
async function removeMapping(caseId, mappingId, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  assertPositiveInteger(mappingId, "mappingId");
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
      const existing = await tx.caseFrameworkMapping.findUnique({ where: { id: mappingId } });
      if (!existing) throw new FrameworkMappingNotFoundError("Framework mapping not found");
      if (existing.caseId !== caseRecord.id) {
        throw new FrameworkMappingStateError(
          "Framework mapping does not belong to this case",
          MAPPING_REJECTION_CODES.MAPPING_NOT_FOR_CASE
        );
      }
      if (existing.supersededAt !== null || existing.currentMappingKey === null) {
        throw new FrameworkMappingStateError(
          "Framework mapping is not the current row for its reference",
          MAPPING_REJECTION_CODES.MAPPING_NOT_CURRENT
        );
      }

      const content = {
        framework: existing.framework,
        frameworkVersion: existing.frameworkVersion,
        referenceId: existing.referenceId,
        referenceTitle: existing.referenceTitle,
        mappingScope: existing.mappingScope,
        evidenceBasis: existing.evidenceBasis,
        rationale: existing.rationale,
        evidenceFindingId: existing.evidenceFindingId,
      };

      if (!isMappingChangeMeaningful(existing, MAPPING_STATES.REMOVED)) {
        return { mapping: existing, outcome: MAPPING_OUTCOMES.UNCHANGED, changed: false };
      }

      // The REMOVED row carries the ORIGINAL content forward verbatim and the
      // withdrawal reason separately, for the same reason Phase 3's UNLINKED
      // row carries the original ownership snapshot: re-deriving the basis now
      // would misstate why the mapping was originally made. Only `rationale`
      // is replaced — on a REMOVED row, the rationale IS the withdrawal reason,
      // and keeping the old one would make the row read as a fresh assertion.
      const mapping = await appendMappingRow(tx, {
        caseId: caseRecord.id,
        organizationId: existing.organizationId,
        content: { ...content, rationale: reason },
        state: MAPPING_STATES.REMOVED,
        source: existing.source,
        actorUserId,
        effectiveAt,
      });

      return { mapping, outcome: MAPPING_OUTCOMES.REMOVED, changed: true };
    });
  } catch (error) {
    await audit(client, auditContext, {
      action: "framework.mapping.failed",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: MAPPING_ENTITY_TYPE,
      entityId: mappingId,
      reason:
        error instanceof FrameworkMappingStateError && error.code
          ? `Framework mapping removal refused (${error.code})`
          : "Framework mapping removal could not be persisted",
    });
    throw error;
  }

  if (!outcome.changed) {
    await audit(client, auditContext, {
      action: "framework.mapping.unchanged",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: MAPPING_ENTITY_TYPE,
      entityId: outcome.mapping.id,
      after: mappingSummary(outcome.mapping),
      reason: "Framework mapping already removed; nothing written",
    });
    return outcome;
  }

  await audit(client, auditContext, {
    action: "framework.mapping.removed",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: MAPPING_ENTITY_TYPE,
    entityId: outcome.mapping.id,
    before: { id: mappingId, caseId, state: MAPPING_STATES.ACTIVE },
    after: mappingSummary(outcome.mapping),
    reason: "Framework mapping removed",
  });

  return outcome;
}

/**
 * Currently-ACTIVE mappings for one case, deterministically ordered
 * (framework, then reference, then id) so two identical reads never differ.
 */
async function listActiveMappings(client, caseId, { includeEvidenceFinding = false } = {}) {
  return client.caseFrameworkMapping.findMany({
    where: { caseId, state: MAPPING_STATES.ACTIVE, supersededAt: null },
    orderBy: [{ framework: "asc" }, { referenceId: "asc" }, { id: "asc" }],
    ...(includeEvidenceFinding ? { include: { evidenceFinding: true } } : {}),
  });
}

/**
 * Full append-only mapping history for one case, newest first, bounded.
 *
 * `take` is clamped rather than trusted: an unbounded history read on a case
 * with years of revisions is a denial-of-service surface, and silently
 * accepting take=100000 would make the bound decorative.
 */
async function listMappingHistory(client, caseId, { take = 50, skip = 0 } = {}) {
  const boundedTake = Math.min(Math.max(Number.isInteger(take) ? take : 50, 1), 200);
  const boundedSkip = Math.max(Number.isInteger(skip) ? skip : 0, 0);
  return client.caseFrameworkMapping.findMany({
    where: { caseId },
    orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
    take: boundedTake,
    skip: boundedSkip,
  });
}

async function countMappingHistory(client, caseId) {
  return client.caseFrameworkMapping.count({ where: { caseId } });
}

module.exports = {
  MAPPING_ENTITY_TYPE,
  MAPPING_OUTCOMES,
  mappingSummary,
  loadCurrentMapping,
  currentlyLinkedFindingIds,
  assertEvidenceObligations,
  appendMappingRow,
  appendMappingWithinTransaction,
  createManualMapping,
  removeMapping,
  listActiveMappings,
  listMappingHistory,
  countMappingHistory,
};
