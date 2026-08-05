"use strict";

// AI mapping-suggestion generation (Phase 5).
//
// ===========================================================================
// What this service can and cannot cause
// ===========================================================================
// It writes exactly two kinds of row: one AiSuggestionRun, and zero or more
// PENDING AiFrameworkMappingSuggestion rows hanging off it. It writes NOTHING
// else, ever — no mapping, no risk score, no triage decision, no case state
// change, no notification, no enrichment job, no ownership row. A PENDING
// suggestion is inert: it appears in no active-mapping list, is excluded from
// every aggregate, and grants nothing until a named human approves it.
//
// ===========================================================================
// Disabled is a recorded outcome, not an error
// ===========================================================================
// With AI_ENABLED=false (the shipped default) this service:
//   - makes NO provider call — the disabled provider is not even invoked with
//     a snapshot to ignore; the branch returns before that
//   - starts no timer and no worker
//   - fabricates no suggestion
//   - records ONE run with status DISABLED and reasonCode AI_DISABLED
//   - returns a controlled result the API surfaces as "AI assistance is
//     disabled"
// Recording the run is deliberate: "somebody asked and the system was off" and
// "nobody ever asked" are different facts, and only one of them means the
// feature is unused.
//
// ===========================================================================
// A provider failure never breaks the workflow
// ===========================================================================
// A throwing, hanging or malformed provider produces a FAILED run and a normal
// response. It does not 500, does not roll anything back, and does not leave
// the analyst unable to continue — the same isolation rule Phase 1 applied to
// enrichment failures during ingestion. No provider error text, message or
// stack is ever persisted, audited or returned; only a closed reason code.

const {
  PROVIDER_RESULT_STATUSES,
  RUN_REASON_CODES,
  PROMPT_TEMPLATE_VERSION,
  MAX_PROVIDER_MODEL_LENGTH,
  AiSuggestionValidationError,
  normalizeRequestContext,
  partitionProviderCandidates,
  resolveRunReasonCode,
  isPlainObject,
} = require("./aiSuggestionRules");

const { buildCaseEvidenceSnapshot } = require("./caseEvidenceSnapshot");
const { buildAiRuntime } = require("./aiRuntime");
const { runAtomic } = require("../workflow/workflowTransaction");
const { loadCaseOrThrow, assertOrganizationBound } = require("../workflow/caseLifecycleService");
const { assertPositiveInteger, assertValidDate } = require("../framework/frameworkMappingRules");
const { resolveAttackCatalogue } = require("../framework/frameworkMappingService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const RUN_ENTITY_TYPE = "AiSuggestionRun";

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("AI suggestion audit failed", { name: error && error.name });
  }
}

// Allow-listed audit payload.
//
// Counts, ids, a provider NAME and a closed reason code. Deliberately NO
// prompt, NO snapshot, NO fingerprint, NO rationale text and NO raw model
// output — none of which is persisted anywhere either, so there is nothing to
// leak even if this allow-list were widened by mistake.
function runSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.caseId,
    organizationId: row.organizationId,
    status: row.status,
    providerName: row.providerName,
    providerModel: row.providerModel === undefined ? null : row.providerModel,
    promptTemplateVersion: row.promptTemplateVersion,
    suggestionCount: row.suggestionCount,
    rejectedCount: row.rejectedCount,
    reasonCode: row.reasonCode,
  };
}

function boundedModelName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, MAX_PROVIDER_MODEL_LENGTH);
}

// Writes the run and its accepted suggestions together. Purely additive — every
// statement is an INSERT and nothing is read-then-written — so runAtomic
// (READ COMMITTED) is correct and SERIALIZABLE would only manufacture index-page
// conflicts between unrelated concurrent runs. Same reasoning as Phase 3 case
// creation.
async function persistRun(client, input) {
  return runAtomic(client, async (tx) => {
    const run = await tx.aiSuggestionRun.create({
      data: {
        caseId: input.caseId,
        organizationId: input.organizationId,
        status: input.status,
        providerName: input.providerName,
        providerModel: input.providerModel,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        inputFingerprint: input.inputFingerprint,
        suggestionCount: input.accepted.length,
        rejectedCount: input.rejectedCount,
        reasonCode: input.reasonCode,
        requestContext: input.requestContext,
        actorUserId: input.actorUserId,
        requestedAt: input.requestedAt,
        completedAt: input.completedAt,
      },
    });

    const suggestions = [];
    // Sequential rather than Promise.all: these share one transaction client,
    // and concurrent statements on a single interactive transaction are how
    // "current transaction is aborted" surfaces from an unrelated failure.
    for (const candidate of input.accepted) {
      // eslint-disable-next-line no-await-in-loop
      const suggestion = await tx.aiFrameworkMappingSuggestion.create({
        data: {
          runId: run.id,
          caseId: input.caseId,
          framework: candidate.content.framework,
          frameworkVersion: candidate.content.frameworkVersion,
          referenceId: candidate.content.referenceId,
          referenceTitle: candidate.content.referenceTitle,
          mappingScope: candidate.content.mappingScope,
          evidenceBasis: candidate.content.evidenceBasis,
          rationale: candidate.content.rationale,
          evidenceFindingId: candidate.content.evidenceFindingId,
          // Phase 6.3. Stored on the suggestion itself rather than deferred to
          // promotion: a reviewer needs the quote in front of them WHILE
          // deciding, not at the moment of approval. A candidate carrying no
          // quote or no confidences never reached this loop —
          // normalizeMappingContent discarded it at partition time, and the run
          // counted the rejection.
          evidenceQuote: candidate.content.evidenceQuote,
          evidenceQuoteSource: candidate.content.evidenceQuoteSource,
          evidenceConfidence: candidate.content.evidenceConfidence,
          mappingConfidence: candidate.content.mappingConfidence,
          catalogueVerified: candidate.content.catalogueVerified === true,
          catalogueVersion: candidate.content.catalogueVersion,
          providerConfidence: candidate.providerConfidence,
          // Copied from the run so staleness stays decidable per suggestion,
          // independently of the run row.
          inputFingerprint: input.inputFingerprint,
          state: "PENDING",
        },
      });
      suggestions.push(suggestion);
    }

    return { run, suggestions };
  });
}

/**
 * Requests AI mapping suggestions for one case.
 *
 * Always resolves. A disabled assistant, an unavailable provider, a throwing
 * provider and a provider that returned nonsense all produce a recorded run and
 * a normal return value — never an exception into the caller's workflow.
 *
 * @param {number} caseId
 * @param {object} options
 * @param {object}  [options.client]
 * @param {object}  [options.runtime]        injected AI runtime (tests supply a
 *                                           mock-enabled one; production never
 *                                           does)
 * @param {number|null} [options.actorUserId]
 * @param {string|null} [options.requestContext]
 * @param {Date}    options.requestedAt      explicit; never a wall-clock read
 * @returns {Promise<{run:object, suggestions:object[]}>}
 */
async function requestMappingSuggestions(caseId, options = {}) {
  assertPositiveInteger(caseId, "caseId");
  const requestedAt = assertValidDate(options.requestedAt, "requestedAt");
  const requestContext = normalizeRequestContext(options.requestContext);

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;
  const runtime = options.runtime || buildAiRuntime();

  const caseRecord = assertOrganizationBound(await loadCaseOrThrow(client, caseId));

  await audit(client, auditContext, {
    action: "ai.mapping.suggestion.requested",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: RUN_ENTITY_TYPE,
    entityId: caseId,
    after: {
      caseId,
      organizationId: caseRecord.organizationId,
      aiEnabled: runtime.aiEnabled === true,
      assistanceAvailable: runtime.assistanceAvailable === true,
      providerName: runtime.providerName,
      requestContextLength: requestContext ? requestContext.length : 0,
    },
    reason: "AI mapping suggestions requested",
  });

  // ---------------------------------------------------------------------
  // Disabled path. Returns BEFORE any snapshot is handed to any provider.
  // ---------------------------------------------------------------------
  if (runtime.assistanceAvailable !== true) {
    // The fingerprint is still computed and stored: a DISABLED run is a real
    // record of "the case looked like this when somebody asked", and it costs
    // one hash. No provider sees the snapshot.
    const { fingerprint } = await buildCaseEvidenceSnapshot(client, caseRecord, {
      requestContext,
    });

    const reasonCode = runtime.reasonCode || RUN_REASON_CODES.AI_DISABLED;
    const { run, suggestions } = await persistRun(client, {
      caseId: caseRecord.id,
      organizationId: caseRecord.organizationId,
      status: "DISABLED",
      providerName: runtime.providerName,
      providerModel: null,
      inputFingerprint: fingerprint,
      accepted: [],
      rejectedCount: 0,
      reasonCode,
      requestContext,
      actorUserId,
      requestedAt,
      completedAt: requestedAt,
    });

    await audit(client, auditContext, {
      action: "ai.mapping.suggestion.disabled",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: RUN_ENTITY_TYPE,
      entityId: run.id,
      after: runSummary(run),
      reason: "AI assistance is disabled; no provider was called",
    });

    return { run, suggestions };
  }

  // ---------------------------------------------------------------------
  // Enabled path.
  // ---------------------------------------------------------------------
  const { snapshot, fingerprint, linkedFindingIds } = await buildCaseEvidenceSnapshot(
    client,
    caseRecord,
    { requestContext }
  );

  let providerResult = null;
  let failureReasonCode = null;

  try {
    // Outside any transaction, deliberately: a provider call must never hold a
    // database transaction open, and a slow provider must never widen a lock
    // window on the case.
    providerResult = await runtime.provider.suggestMappings({
      snapshot,
      asOf: requestedAt,
      signal: options.signal,
    });
  } catch (error) {
    // No error.message, no stack, no provider text — only a closed code. This
    // catch is the boundary at which provider detail stops existing.
    failureReasonCode = RUN_REASON_CODES.PROVIDER_FAILED;
  }

  if (!failureReasonCode) {
    if (!isPlainObject(providerResult)) {
      failureReasonCode = RUN_REASON_CODES.PROVIDER_MALFORMED_RESULT;
    } else if (providerResult.status === PROVIDER_RESULT_STATUSES.FAILED) {
      failureReasonCode = RUN_REASON_CODES.PROVIDER_FAILED;
    } else if (providerResult.status === PROVIDER_RESULT_STATUSES.DISABLED) {
      // A provider may report itself disabled even when the runtime believed
      // otherwise. Its answer wins — it knows its own state.
      failureReasonCode = RUN_REASON_CODES.AI_DISABLED;
    } else if (providerResult.status !== PROVIDER_RESULT_STATUSES.COMPLETED) {
      failureReasonCode = RUN_REASON_CODES.PROVIDER_MALFORMED_RESULT;
    }
  }

  if (failureReasonCode) {
    const status = failureReasonCode === RUN_REASON_CODES.AI_DISABLED ? "DISABLED" : "FAILED";
    const { run, suggestions } = await persistRun(client, {
      caseId: caseRecord.id,
      organizationId: caseRecord.organizationId,
      status,
      providerName: runtime.providerName,
      providerModel: boundedModelName(runtime.providerModel),
      inputFingerprint: fingerprint,
      accepted: [],
      rejectedCount: 0,
      reasonCode: failureReasonCode,
      requestContext,
      actorUserId,
      requestedAt,
      completedAt: requestedAt,
    });

    await audit(client, auditContext, {
      action:
        status === "DISABLED"
          ? "ai.mapping.suggestion.disabled"
          : "ai.mapping.suggestion.failed",
      outcome: status === "DISABLED" ? AUDIT_OUTCOMES.SUCCESS : AUDIT_OUTCOMES.FAILURE,
      entityType: RUN_ENTITY_TYPE,
      entityId: run.id,
      after: runSummary(run),
      reason: `AI mapping suggestion run did not produce suggestions (${failureReasonCode})`,
    });

    return { run, suggestions };
  }

  // Untrusted output. Every candidate is validated by the SAME rules a manual
  // mapping clears; failures are discarded and counted, never repaired.
  let partition;
  try {
    partition = partitionProviderCandidates(providerResult.suggestions, linkedFindingIds, {
      // Phase 6.3: the SAME pinned catalogue the manual writer resolves. Not a
      // parameter a caller can supply, and not a separate lookup that could
      // drift from the one promotion will use.
      attackCatalogue: resolveAttackCatalogue(),
    });
  } catch (error) {
    // Only reachable when the whole result is structurally unusable (e.g.
    // `suggestions` is not an array). A single bad candidate never gets here.
    const reasonCode =
      error instanceof AiSuggestionValidationError
        ? RUN_REASON_CODES.PROVIDER_MALFORMED_RESULT
        : RUN_REASON_CODES.PROVIDER_FAILED;

    const { run, suggestions } = await persistRun(client, {
      caseId: caseRecord.id,
      organizationId: caseRecord.organizationId,
      status: "FAILED",
      providerName: runtime.providerName,
      providerModel: boundedModelName(runtime.providerModel),
      inputFingerprint: fingerprint,
      accepted: [],
      rejectedCount: 0,
      reasonCode,
      requestContext,
      actorUserId,
      requestedAt,
      completedAt: requestedAt,
    });

    await audit(client, auditContext, {
      action: "ai.mapping.suggestion.failed",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: RUN_ENTITY_TYPE,
      entityId: run.id,
      after: runSummary(run),
      reason: `AI mapping suggestion run produced unusable output (${reasonCode})`,
    });

    return { run, suggestions };
  }

  const reasonCode = resolveRunReasonCode({
    acceptedCount: partition.accepted.length,
    rejectedCount: partition.rejectedCount,
  });

  const { run, suggestions } = await persistRun(client, {
    caseId: caseRecord.id,
    organizationId: caseRecord.organizationId,
    status: "COMPLETED",
    providerName: runtime.providerName,
    providerModel: boundedModelName(providerResult.model || runtime.providerModel),
    inputFingerprint: fingerprint,
    accepted: partition.accepted,
    rejectedCount: partition.rejectedCount,
    reasonCode,
    requestContext,
    actorUserId,
    requestedAt,
    completedAt: requestedAt,
  });

  await audit(client, auditContext, {
    action: "ai.mapping.suggestion.completed",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: RUN_ENTITY_TYPE,
    entityId: run.id,
    after: { ...runSummary(run), truncatedCount: partition.truncatedCount },
    reason: "AI mapping suggestion run completed",
  });

  return { run, suggestions };
}

module.exports = {
  RUN_ENTITY_TYPE,
  runSummary,
  boundedModelName,
  persistRun,
  requestMappingSuggestions,
};
