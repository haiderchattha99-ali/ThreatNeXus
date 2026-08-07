"use strict";

// Finding AI suggestion generation and reading (Phase 8C).
//
// ===========================================================================
// What this service can and cannot cause
// ===========================================================================
// It writes exactly one row: one FindingAiSuggestion, always in state DRAFT.
// It writes NOTHING else, ever — no Finding column changes, no case state
// change, no notification, no enrichment job, no risk recalculation. A DRAFT
// suggestion is inert: it grants nothing and is read by no authoritative
// workflow until a human explicitly accepts it (see
// findingAiSuggestionDecisionService.js), and even acceptance changes only
// the suggestion's own decision projection — never the Finding.
//
// ===========================================================================
// Disabled is a recorded outcome, not an error
// ===========================================================================
// With AI_ENABLED=false (the shipped default) this service makes NO provider
// call, fabricates no suggestion, records ONE row with status DRAFT and
// reasonCode AI_DISABLED, and returns a controlled result the API surfaces as
// "AI assistance is disabled".
//
// ===========================================================================
// A provider failure never breaks the workflow
// ===========================================================================
// A throwing, hanging or malformed provider produces a recorded failure and a
// normal response — it does not 500 and does not leave the analyst unable to
// continue. No provider error text, message or stack is ever persisted,
// audited or returned; only a closed reason code.

const {
  PROVIDER_RESULT_STATUSES,
  SUGGESTION_REASON_CODES,
  SUGGESTION_STATUSES,
  AiAssistValidationError,
  AiAssistNotFoundError,
  assertValidSuggestionType,
  normalizeRequestContext,
  normalizeSuggestionContent,
  boundedModelName,
  PROMPT_TEMPLATE_VERSION,
} = require("./aiAssistRules");

const { buildFindingEvidenceSnapshot } = require("./findingEvidenceSnapshot");
const { buildAiAssistRuntime } = require("./aiAssistRuntime");
const { runAtomic } = require("../workflow/workflowTransaction");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const SUGGESTION_ENTITY_TYPE = "FindingAiSuggestion";

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...(auditContext || {}), ...event }, { client });
  } catch (error) {
    console.error("AI finding suggestion audit failed", { name: error && error.name });
  }
}

// Allow-listed audit payload. Ids, a provider NAME, a closed reason code and
// LENGTHS. Deliberately NO proposed text, NO snapshot, NO fingerprint — none
// of which is persisted anywhere in AuditLog either.
function suggestionSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    findingId: row.findingId,
    suggestionType: row.suggestionType,
    status: row.status,
    providerName: row.providerName,
    providerModel: row.providerModel === undefined ? null : row.providerModel,
    reasonCode: row.reasonCode,
    proposedTextLength: typeof row.proposedText === "string" ? row.proposedText.length : 0,
  };
}

async function loadFindingOrThrow(client, findingId) {
  const finding = await client.finding.findUnique({
    where: { id: findingId },
    select: { id: true, reportType: true },
  });
  if (!finding) throw new AiAssistNotFoundError("Finding not found");
  return finding;
}

async function persistSuggestion(client, input) {
  return runAtomic(client, async (tx) =>
    tx.findingAiSuggestion.create({
      data: {
        findingId: input.findingId,
        suggestionType: input.suggestionType,
        status: SUGGESTION_STATUSES.DRAFT,
        proposedText: input.proposedText,
        evidenceReferences: input.evidenceReferences,
        providerName: input.providerName,
        providerModel: input.providerModel,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        inputFingerprint: input.inputFingerprint,
        reasonCode: input.reasonCode,
        requestContext: input.requestContext,
        requestedByUserId: input.actorUserId,
        requestedAt: input.requestedAt,
        completedAt: input.completedAt,
      },
    })
  );
}

/**
 * Requests one AI suggestion draft for one Finding.
 *
 * Always resolves. A disabled assistant, an unavailable provider, a throwing
 * provider and a provider that returned nonsense all produce a recorded
 * outcome and a normal return value — never an exception into the caller's
 * workflow, and never a Finding mutation of any kind.
 *
 * @param {number} findingId
 * @param {string} suggestionType   SUGGESTION_TYPES.SUMMARY | .EXPLANATION
 * @param {object} options
 * @param {object}  [options.client]
 * @param {object}  [options.runtime]        injected AI-assist runtime (tests
 *                                           supply a mock-enabled one)
 * @param {number|null} [options.actorUserId]
 * @param {string|null} [options.requestContext]
 * @param {Date}    options.requestedAt      explicit; never a wall-clock read
 * @returns {Promise<{suggestion:object}>}
 */
async function requestFindingAiSuggestion(findingId, suggestionType, options = {}) {
  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new AiAssistValidationError("findingId must be a positive integer", ["findingId"]);
  }
  assertValidSuggestionType(suggestionType);
  if (!(options.requestedAt instanceof Date) || Number.isNaN(options.requestedAt.getTime())) {
    throw new AiAssistValidationError("requestedAt must be a valid Date", ["requestedAt"]);
  }
  const requestedAt = options.requestedAt;
  const requestContext = normalizeRequestContext(options.requestContext);

  const client = resolveClient(options.client);
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;
  const auditContext = options.auditContext;
  const runtime = options.runtime || buildAiAssistRuntime();

  const finding = await loadFindingOrThrow(client, findingId);

  await audit(client, auditContext, {
    action: "ai.suggestion.requested",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: SUGGESTION_ENTITY_TYPE,
    entityId: findingId,
    after: {
      findingId,
      suggestionType,
      aiEnabled: runtime.aiEnabled === true,
      assistanceAvailable: runtime.assistanceAvailable === true,
      providerName: runtime.providerName,
      requestContextLength: requestContext ? requestContext.length : 0,
    },
    reason: "AI finding suggestion requested",
  });

  // ---------------------------------------------------------------------
  // Disabled path. Returns BEFORE any snapshot is handed to any provider.
  // ---------------------------------------------------------------------
  if (runtime.assistanceAvailable !== true) {
    const { fingerprint } = await buildFindingEvidenceSnapshot(client, finding, { requestContext });
    const reasonCode = runtime.reasonCode || SUGGESTION_REASON_CODES.AI_DISABLED;

    const suggestion = await persistSuggestion(client, {
      findingId,
      suggestionType,
      proposedText: "",
      evidenceReferences: [],
      providerName: runtime.providerName,
      providerModel: null,
      inputFingerprint: fingerprint,
      reasonCode,
      requestContext,
      actorUserId,
      requestedAt,
      completedAt: requestedAt,
    });

    await audit(client, auditContext, {
      action: "ai.unavailable",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: SUGGESTION_ENTITY_TYPE,
      entityId: suggestion.id,
      after: suggestionSummary(suggestion),
      reason: "AI assistance is disabled; no provider was called",
    });

    return { suggestion };
  }

  // ---------------------------------------------------------------------
  // Enabled path.
  // ---------------------------------------------------------------------
  const { snapshot, fingerprint } = await buildFindingEvidenceSnapshot(client, finding, {
    requestContext,
  });

  let providerResult = null;
  let failureReasonCode = null;

  try {
    // Outside any transaction, deliberately: a provider call must never hold a
    // database transaction open.
    providerResult = await runtime.provider.generateSuggestion({
      snapshot,
      suggestionType,
      asOf: requestedAt,
      signal: options.signal,
    });
  } catch (error) {
    failureReasonCode = SUGGESTION_REASON_CODES.PROVIDER_FAILED;
  }

  let content = null;
  if (!failureReasonCode) {
    if (!providerResult || typeof providerResult !== "object") {
      failureReasonCode = SUGGESTION_REASON_CODES.PROVIDER_MALFORMED_RESULT;
    } else if (providerResult.status === PROVIDER_RESULT_STATUSES.FAILED) {
      failureReasonCode = SUGGESTION_REASON_CODES.PROVIDER_FAILED;
    } else if (providerResult.status === PROVIDER_RESULT_STATUSES.DISABLED) {
      failureReasonCode = SUGGESTION_REASON_CODES.AI_DISABLED;
    } else if (providerResult.status !== PROVIDER_RESULT_STATUSES.COMPLETED) {
      failureReasonCode = SUGGESTION_REASON_CODES.PROVIDER_MALFORMED_RESULT;
    } else {
      try {
        content = normalizeSuggestionContent({
          text: providerResult.text,
          evidenceReferences: providerResult.evidenceReferences,
        });
      } catch (error) {
        failureReasonCode =
          error instanceof AiAssistValidationError
            ? SUGGESTION_REASON_CODES.PROVIDER_MALFORMED_RESULT
            : SUGGESTION_REASON_CODES.PROVIDER_FAILED;
      }
    }
  }

  if (failureReasonCode) {
    const suggestion = await persistSuggestion(client, {
      findingId,
      suggestionType,
      proposedText: "",
      evidenceReferences: [],
      providerName: runtime.providerName,
      providerModel: boundedModelName(runtime.providerModel),
      inputFingerprint: fingerprint,
      reasonCode: failureReasonCode,
      requestContext,
      actorUserId,
      requestedAt,
      completedAt: requestedAt,
    });

    await audit(client, auditContext, {
      action:
        failureReasonCode === SUGGESTION_REASON_CODES.AI_DISABLED
          ? "ai.unavailable"
          : "ai.suggestion.failed",
      outcome:
        failureReasonCode === SUGGESTION_REASON_CODES.AI_DISABLED
          ? AUDIT_OUTCOMES.SUCCESS
          : AUDIT_OUTCOMES.FAILURE,
      entityType: SUGGESTION_ENTITY_TYPE,
      entityId: suggestion.id,
      after: suggestionSummary(suggestion),
      reason: `AI finding suggestion did not produce a draft (${failureReasonCode})`,
    });

    return { suggestion };
  }

  const suggestion = await persistSuggestion(client, {
    findingId,
    suggestionType,
    proposedText: content.proposedText,
    evidenceReferences: content.evidenceReferences,
    providerName: runtime.providerName,
    providerModel: boundedModelName(providerResult.model || runtime.providerModel),
    inputFingerprint: fingerprint,
    reasonCode: SUGGESTION_REASON_CODES.SUGGESTION_GENERATED,
    requestContext,
    actorUserId,
    requestedAt,
    completedAt: requestedAt,
  });

  await audit(client, auditContext, {
    action: "ai.suggestion.generated",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: SUGGESTION_ENTITY_TYPE,
    entityId: suggestion.id,
    after: suggestionSummary(suggestion),
    reason: "AI finding suggestion draft generated",
  });

  return { suggestion };
}

/**
 * Lists suggestions for one Finding, newest first.
 */
async function listFindingAiSuggestions(findingId, options = {}) {
  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new AiAssistValidationError("findingId must be a positive integer", ["findingId"]);
  }
  const client = resolveClient(options.client);
  await loadFindingOrThrow(client, findingId);

  const take = Number.isInteger(options.take) && options.take > 0 ? Math.min(options.take, 100) : 20;
  const skip = Number.isInteger(options.skip) && options.skip >= 0 ? options.skip : 0;

  return client.findingAiSuggestion.findMany({
    where: { findingId },
    orderBy: [{ createdAt: "desc" }],
    take,
    skip,
  });
}

module.exports = {
  SUGGESTION_ENTITY_TYPE,
  suggestionSummary,
  loadFindingOrThrow,
  persistSuggestion,
  requestFindingAiSuggestion,
  listFindingAiSuggestions,
};
