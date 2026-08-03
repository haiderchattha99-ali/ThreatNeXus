"use strict";

// THE allow-list every Phase 5 row crosses on its way to an API response.
//
// Same design as workflow/caseWorkflowSerializers.js and
// enrichment/findingEnrichmentReadService.js: these functions CONSTRUCT a fresh
// object from named fields rather than deleting keys from a database row,
// because a construct-only serializer stays safe when a future migration adds a
// column, whereas a delete-based one silently starts leaking it.
//
// Deliberately never emitted, by any function below:
//   - current-row keys       currentMappingKey
//   - AI input fingerprints  AiSuggestionRun.inputFingerprint,
//                            AiFrameworkMappingSuggestion.inputFingerprint
//   - the AI input snapshot  never persisted, never returned; it exists only
//                            inside one request and is hashed, not stored
//   - raw provider output    never persisted at all — see aiSuggestionService
//   - provider credentials   no key, token, base URL or header ever reaches a
//                            provider-facing field in the first place
//   - internal model config  providerModel is emitted (it is a public model
//                            identity), timeouts/urls/keys are not stored
//   - organization contacts  email, phone, contactPerson, industry, location
//   - Phase 1/2 internals    no indicator, port, cacheKey, claimToken,
//                            queryParamsHash, configurationFingerprint
//   - audit rows             AuditLog is never read by, or returned from, any
//                            Phase 5 read path
//   - database errors        controllers answer a fixed string
//
// A dedicated test file (frameworkSerializerSafety.test.js) proves these
// exclusions against real row shapes rather than merely asserting them here.

const {
  COMPLIANCE_DISCLAIMER,
  CATALOGUE_DISCLAIMER,
} = require("./frameworkMappingRules");

// Actor identity reduced to id + name + role, exactly as Phase 3 does. Email is
// omitted because a mapping list is readable by VIEWER.
function serializeActor(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, role: user.role };
}

/**
 * One mapping row.
 *
 * `isCurrent` conveys "this is the row in force" without exposing
 * currentMappingKey, the same substitution caseWorkflowSerializers makes for
 * currentForFindingId.
 *
 * `referenceValidated: false` is emitted on EVERY row, always, as a literal.
 * This phase pins no framework catalogue, so the honest answer is that the
 * reference was format-checked and nothing more. Emitting the field (rather
 * than omitting it) means a future catalogue can flip it to true and every
 * existing consumer already renders the distinction.
 */
function serializeMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    organizationId: row.organizationId,
    framework: row.framework,
    frameworkVersion: row.frameworkVersion,
    referenceId: row.referenceId,
    referenceTitle: row.referenceTitle,
    referenceValidated: false,
    mappingScope: row.mappingScope,
    evidenceBasis: row.evidenceBasis,
    rationale: row.rationale,
    evidenceFindingId: row.evidenceFindingId === undefined ? null : row.evidenceFindingId,
    state: row.state,
    source: row.source,
    actorUserId: row.actorUserId === undefined ? null : row.actorUserId,
    actor: row.actor ? serializeActor(row.actor) : undefined,
    effectiveAt: row.effectiveAt,
    supersededAt: row.supersededAt === undefined ? null : row.supersededAt,
    createdAt: row.createdAt,
    isCurrent: row.supersededAt === null || row.supersededAt === undefined,
  };
}

/**
 * Groups ACTIVE mappings by framework family for display.
 *
 * `count` here is a COUNT OF MAPPINGS. It is not a coverage figure, not a
 * percentage, and not a score. Nothing in this repository divides it by
 * anything, and `countMeaning` travels with it saying so — a bare number beside
 * a framework name is exactly how "3" becomes "3 techniques covered" in a
 * screenshot.
 */
function serializeMappingGroups(rows) {
  const groups = new Map();
  (rows || []).forEach((row) => {
    if (!groups.has(row.framework)) groups.set(row.framework, []);
    groups.get(row.framework).push(serializeMapping(row));
  });

  return Array.from(groups.entries()).map(([framework, mappings]) => ({
    framework,
    count: mappings.length,
    countMeaning: "MAPPING_COUNT_NOT_COVERAGE",
    mappings,
  }));
}

/**
 * One AI suggestion, as a human reviewer sees it.
 *
 * inputFingerprint is NOT emitted — it is the staleness mechanism, and exposing
 * it would let a client compute or compare it, which is the server's job alone.
 *
 * providerConfidence IS emitted and is labelled. It is provider self-report and
 * nothing in this system reads it to decide anything; the label travels with the
 * value so a UI cannot render it as a system assessment.
 */
function serializeSuggestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.runId,
    caseId: row.caseId,
    framework: row.framework,
    frameworkVersion: row.frameworkVersion,
    referenceId: row.referenceId,
    referenceTitle: row.referenceTitle,
    referenceValidated: false,
    mappingScope: row.mappingScope,
    evidenceBasis: row.evidenceBasis,
    rationale: row.rationale,
    evidenceFindingId: row.evidenceFindingId === undefined ? null : row.evidenceFindingId,
    providerConfidence: row.providerConfidence === undefined ? null : row.providerConfidence,
    providerConfidenceMeaning: "PROVIDER_SELF_REPORTED_NOT_SYSTEM_ASSESSED",
    state: row.state,
    decidedAt: row.decidedAt === undefined ? null : row.decidedAt,
    decidedByUserId: row.decidedByUserId === undefined ? null : row.decidedByUserId,
    decidedBy: row.decidedBy ? serializeActor(row.decidedBy) : undefined,
    decisionReason: row.decisionReason === undefined ? null : row.decisionReason,
    promotedMappingId: row.promotedMappingId === undefined ? null : row.promotedMappingId,
    createdAt: row.createdAt,
  };
}

/**
 * One generation run.
 *
 * `promptTemplateVersion` and `providerName`/`providerModel` are emitted
 * because they are the provenance a reviewer needs ("which contract produced
 * this, and from what"). No prompt text, no snapshot, no fingerprint and no raw
 * response is emitted, because none of those is persisted anywhere to emit.
 */
function serializeRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    status: row.status,
    providerName: row.providerName,
    providerModel: row.providerModel === undefined ? null : row.providerModel,
    promptTemplateVersion: row.promptTemplateVersion,
    suggestionCount: row.suggestionCount,
    rejectedCount: row.rejectedCount,
    reasonCode: row.reasonCode,
    requestContext: row.requestContext === undefined ? null : row.requestContext,
    actorUserId: row.actorUserId === undefined ? null : row.actorUserId,
    actor: row.actor ? serializeActor(row.actor) : undefined,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt === undefined ? null : row.completedAt,
    createdAt: row.createdAt,
  };
}

function serializeDecision(row) {
  if (!row) return null;
  return {
    id: row.id,
    suggestionId: row.suggestionId,
    decision: row.decision,
    outcomeCode: row.outcomeCode,
    reason: row.reason === undefined ? null : row.reason,
    actorUserId: row.actorUserId === undefined ? null : row.actorUserId,
    actor: row.actor ? serializeActor(row.actor) : undefined,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

/**
 * The safe Phase 5 configuration state.
 *
 * Emits WHETHER assistance is available and WHICH provider name is in force —
 * never a key, never a base URL, never a timeout, never a model parameter.
 * `aiEnabled` is the environment flag; `assistanceAvailable` is the effective
 * answer after provider resolution, and the two differ when AI_ENABLED=true but
 * no approved provider is registered. Reporting only one of them would hide a
 * misconfiguration behind a green light.
 */
function serializeAiConfigState(state) {
  return {
    aiEnabled: state.aiEnabled === true,
    assistanceAvailable: state.assistanceAvailable === true,
    providerName: state.providerName,
    promptTemplateVersion: state.promptTemplateVersion,
    reasonCode: state.reasonCode,
    maxSuggestionsPerRun: state.maxSuggestionsPerRun,
    disclaimer: state.disclaimer,
  };
}

module.exports = {
  COMPLIANCE_DISCLAIMER,
  CATALOGUE_DISCLAIMER,
  serializeActor,
  serializeMapping,
  serializeMappingGroups,
  serializeSuggestion,
  serializeRun,
  serializeDecision,
  serializeAiConfigState,
};
