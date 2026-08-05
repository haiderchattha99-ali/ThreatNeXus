"use strict";

// The Phase 5 read surface: active mappings, mapping history, and safe AI
// suggestion history for one case.
//
// Every row leaves through frameworkMappingSerializers, which constructs a
// fresh object from named fields. Nothing here returns a raw database row, and
// nothing here reads AuditLog.
//
// Ordering is deterministic everywhere (a named sort, always ending in `id`),
// so two identical requests return identical payloads and a paginated read
// cannot skip or repeat a row because two of them shared a timestamp.
//
// Pagination is CLAMPED rather than trusted. `take=100000` becomes the maximum,
// not an unbounded scan — silently honouring it would make the bound
// decorative.

const {
  MAPPING_STATES,
  FrameworkMappingNotFoundError,
  assertPositiveInteger,
} = require("./frameworkMappingRules");

const {
  COMPLIANCE_DISCLAIMER,
  CATALOGUE_DISCLAIMER,
  LEGACY_MAPPING_NOTE,
  serializeMapping,
  serializeMappingGroups,
  serializeNoMappingAssertion,
  serializeSuggestion,
  serializeRun,
  serializeDecision,
} = require("./frameworkMappingSerializers");

const { listMappingHistory, countMappingHistory } = require("./frameworkMappingService");
const { listStandingAssertions } = require("./frameworkNoMappingService");

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function clampTake(value) {
  const parsed = Number.isInteger(value) ? value : DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(parsed, 1), MAX_PAGE_SIZE);
}

function clampSkip(value) {
  const parsed = Number.isInteger(value) ? value : 0;
  return Math.max(parsed, 0);
}

async function loadCaseOr404(client, caseId) {
  const record = await client.case.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      caseReference: true,
      organizationId: true,
      lifecycleState: true,
    },
  });
  if (!record) throw new FrameworkMappingNotFoundError("Case not found");
  return record;
}

/**
 * Currently-ACTIVE mappings, grouped by framework family.
 *
 * Returns counts of MAPPINGS beside each family, labelled
 * MAPPING_COUNT_NOT_COVERAGE, and never a percentage or a ratio. There is no
 * denominator anywhere in this phase: a "62% mapped" figure would require
 * knowing how many references SHOULD apply, which nobody knows, and printing
 * one would create exactly the pressure to force weak mappings that the build
 * plan warns about.
 */
async function getCaseFrameworkMappings(caseId, { client } = {}) {
  assertPositiveInteger(caseId, "caseId");
  const caseRecord = await loadCaseOr404(client, caseId);

  const [rows, standingAssertions] = await Promise.all([
    client.caseFrameworkMapping.findMany({
      where: { caseId, state: MAPPING_STATES.ACTIVE, supersededAt: null },
      orderBy: [{ framework: "asc" }, { referenceId: "asc" }, { id: "asc" }],
      include: { actor: { select: { id: true, name: true, role: true } } },
    }),
    // Phase 6.3. Returned ALONGSIDE the mappings, in the same payload, on
    // purpose: a screen that fetched mappings and then made a second call for
    // determinations would render "no ATT&CK mappings" for a moment before
    // learning that an analyst had explicitly determined none apply. Those two
    // states must never be momentarily confusable, not even during a load.
    listStandingAssertions(client, caseId),
  ]);

  const legacyCount = rows.filter(
    (row) => row.catalogueVerified !== true || !row.evidenceQuote
  ).length;

  return {
    caseId: caseRecord.id,
    caseReference: caseRecord.caseReference,
    organizationBound: caseRecord.organizationId !== null,
    activeCount: rows.length,
    countMeaning: "MAPPING_COUNT_NOT_COVERAGE",
    groups: serializeMappingGroups(rows),
    // The explicit, attributed "we looked, and nothing in this family applies".
    // Its ABSENCE is not evidence that nobody looked, and its presence is not a
    // mapping — which is exactly why it is a separate field with its own name
    // rather than a synthetic entry in `groups`.
    noApplicableDeterminations: standingAssertions.map(serializeNoMappingAssertion),
    legacyUnverifiedCount: legacyCount,
    legacyNote: legacyCount > 0 ? LEGACY_MAPPING_NOTE : null,
    disclaimer: COMPLIANCE_DISCLAIMER,
    catalogueNote: CATALOGUE_DISCLAIMER,
  };
}

/**
 * The full append-only mapping history, newest first.
 *
 * Includes superseded and REMOVED rows: that is the whole point of an
 * append-only table, and a history view that hid withdrawn mappings would be
 * unable to answer "what did we tell them, and when did we change our mind?".
 */
async function getCaseFrameworkMappingHistory(caseId, { client, take, skip } = {}) {
  assertPositiveInteger(caseId, "caseId");
  const caseRecord = await loadCaseOr404(client, caseId);

  const boundedTake = clampTake(take);
  const boundedSkip = clampSkip(skip);

  const [rows, total] = await Promise.all([
    listMappingHistory(client, caseId, { take: boundedTake, skip: boundedSkip }),
    countMappingHistory(client, caseId),
  ]);

  return {
    caseId: caseRecord.id,
    caseReference: caseRecord.caseReference,
    total,
    take: boundedTake,
    skip: boundedSkip,
    history: rows.map(serializeMapping),
    disclaimer: COMPLIANCE_DISCLAIMER,
    catalogueNote: CATALOGUE_DISCLAIMER,
  };
}

/**
 * Safe AI suggestion history for one case: the runs, and the suggestions with
 * their decisions.
 *
 * Emits no prompt, no snapshot, no fingerprint, no raw provider response and no
 * credential — none of which is persisted anywhere to emit. `staleForApproval`
 * is computed by the caller (the controller passes the current fingerprint) so
 * the UI can grey out a suggestion that would be refused, without ever seeing
 * the fingerprint that decided it.
 */
async function getCaseSuggestionHistory(caseId, { client, take, skip, currentFingerprint } = {}) {
  assertPositiveInteger(caseId, "caseId");
  const caseRecord = await loadCaseOr404(client, caseId);

  const boundedTake = clampTake(take);
  const boundedSkip = clampSkip(skip);

  const [runs, suggestionRows, total] = await Promise.all([
    client.aiSuggestionRun.findMany({
      where: { caseId },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      take: boundedTake,
      include: { actor: { select: { id: true, name: true, role: true } } },
    }),
    client.aiFrameworkMappingSuggestion.findMany({
      where: { caseId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: boundedTake,
      skip: boundedSkip,
      include: { decidedBy: { select: { id: true, name: true, role: true } } },
    }),
    client.aiFrameworkMappingSuggestion.count({ where: { caseId } }),
  ]);

  const decisionRows =
    suggestionRows.length === 0
      ? []
      : await client.aiSuggestionDecision.findMany({
          where: { suggestionId: { in: suggestionRows.map((row) => row.id) } },
          orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
          include: { actor: { select: { id: true, name: true, role: true } } },
        });

  const decisionsBySuggestion = new Map();
  decisionRows.forEach((row) => {
    if (!decisionsBySuggestion.has(row.suggestionId)) {
      decisionsBySuggestion.set(row.suggestionId, []);
    }
    decisionsBySuggestion.get(row.suggestionId).push(serializeDecision(row));
  });

  const suggestions = suggestionRows.map((row) => ({
    ...serializeSuggestion(row),
    decisions: decisionsBySuggestion.get(row.id) || [],
    // A PENDING suggestion generated against evidence that has since changed
    // cannot be approved (the service refuses it). Surfacing that as a flag
    // rather than as a surprise 409 is the difference between a UI that guides
    // and one that traps.
    staleForApproval:
      typeof currentFingerprint === "string" && row.state === "PENDING"
        ? row.inputFingerprint !== currentFingerprint
        : false,
  }));

  return {
    caseId: caseRecord.id,
    caseReference: caseRecord.caseReference,
    total,
    take: boundedTake,
    skip: boundedSkip,
    runs: runs.map(serializeRun),
    suggestions,
    disclaimer: COMPLIANCE_DISCLAIMER,
    catalogueNote: CATALOGUE_DISCLAIMER,
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  clampTake,
  clampSkip,
  loadCaseOr404,
  getCaseFrameworkMappings,
  getCaseFrameworkMappingHistory,
  getCaseSuggestionHistory,
};
