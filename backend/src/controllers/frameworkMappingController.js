"use strict";

// Framework-mapping and AI-assistance HTTP surface (Phase 5).
//
// ---------------------------------------------------------------------------
// No role name appears in this file
// ---------------------------------------------------------------------------
// Authorization is entirely the routes' requireCapability middleware; a denied
// request is answered there and never reaches a service, so no service call
// below can execute without its capability already having been checked and no
// denied request can create a row. Same division as caseWorkflowController.js.
//
// Every service writes its own audit events on both success and failure paths,
// so this controller passes auditContext through and never audits a second
// time.
//
// ---------------------------------------------------------------------------
// The AI runtime is built per request, never cached
// ---------------------------------------------------------------------------
// buildAiRuntime() reads configuration and resolves a provider; it starts
// nothing and opens no connection, so per-request construction costs an object
// allocation. Caching it would make an operator's AI_ENABLED change require a
// restart to take effect, which is the wrong default for a kill switch.

const prisma = require("../config/prisma");
const { buildAuditContext } = require("../services/auditService");
const { parseResourceId } = require("../lib/validation");

const {
  FRAMEWORK_FAMILY_VALUES,
  MAPPING_SCOPE_VALUES,
  EVIDENCE_BASIS_VALUES,
  COMPLIANCE_DISCLAIMER,
  CONFIDENCE_LEVEL_VALUES,
  EVIDENCE_QUOTE_SOURCE_VALUES,
  FrameworkMappingValidationError,
  FrameworkMappingNotFoundError,
  FrameworkMappingStateError,
} = require("../services/framework/frameworkMappingRules");

const {
  CaseWorkflowNotFoundError,
  CaseWorkflowStateError,
} = require("../services/workflow/caseWorkflowRules");

const {
  createManualMapping,
  removeMapping,
} = require("../services/framework/frameworkMappingService");

// Phase 6.3. Imported under distinct local names: the handlers exported below
// share their verbs, and an unaliased import would make the call inside each
// handler read as a recursive one.
const {
  assertNoApplicableMapping: assertNoApplicableMappingService,
  withdrawNoApplicableMapping: withdrawNoApplicableMappingService,
  listStandingAssertions,
  listAssertionHistory,
} = require("../services/framework/frameworkNoMappingService");

const {
  getAttackNavigator: buildAttackNavigator,
  getCatalogueReadModel,
} = require("../services/framework/attackAnalyticsService");

const {
  AttackCatalogueUnavailableError,
} = require("../services/framework/attackCatalogue");

const {
  getCaseFrameworkMappings,
  getCaseFrameworkMappingHistory,
  getCaseSuggestionHistory,
  loadCaseOr404,
} = require("../services/framework/frameworkReadService");

const {
  AiSuggestionValidationError,
  AiSuggestionNotFoundError,
  AiSuggestionStateError,
} = require("../services/ai/aiSuggestionRules");

const { requestMappingSuggestions } = require("../services/ai/aiSuggestionService");
const {
  approveSuggestion,
  rejectSuggestion,
} = require("../services/ai/aiSuggestionDecisionService");
const { buildAiRuntime } = require("../services/ai/aiRuntime");
const { buildCaseEvidenceSnapshot } = require("../services/ai/caseEvidenceSnapshot");
const {
  serializeAiConfigState,
  serializeSuggestion,
  serializeMapping,
  serializeNoMappingAssertion,
} = require("../services/framework/frameworkMappingSerializers");

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

const actorUserId = (req) => (req.user && Number.isInteger(req.user.id) ? req.user.id : null);

/**
 * Shared error translation.
 *
 *   *NotFoundError            -> 404
 *   *StateError               -> 409 with its CLOSED code
 *   *ValidationError          -> 400 with the offending field names
 *   anything else             -> fixed 500 body
 *
 * A state error's `code` IS returned: every value is a literal from
 * MAPPING_REJECTION_CODES or DECISION_REFUSAL_CODES, never free text and never
 * a database message. Telling an analyst "ATTACK_REQUIRES_OBSERVED_BEHAVIOR" or
 * "SUGGESTION_STALE" is the entire point of having the vocabulary — a bare 409
 * would leave them guessing.
 *
 * A validation error's `code` is returned for the same reason; its `message` is
 * this repository's own text (see frameworkMappingRules), never a caller's
 * input echoed back and never an exception from a lower layer.
 */
function handleError(res, label, error) {
  if (
    error instanceof FrameworkMappingNotFoundError ||
    error instanceof AiSuggestionNotFoundError ||
    error instanceof CaseWorkflowNotFoundError
  ) {
    return res.status(404).json({ success: false, message: "Not found." });
  }
  if (
    error instanceof FrameworkMappingStateError ||
    error instanceof AiSuggestionStateError ||
    error instanceof CaseWorkflowStateError
  ) {
    return res.status(409).json({
      success: false,
      message: "The case is not in a state that allows this operation.",
      code: error.code,
    });
  }
  if (
    error instanceof FrameworkMappingValidationError ||
    error instanceof AiSuggestionValidationError
  ) {
    return res.status(400).json({
      success: false,
      message: error.message,
      fields: error.fields,
      code: error.code,
    });
  }
  return serverError(res, label, error);
}

// The query-string counterpart of rejectUnexpectedFields, added in Phase 6.3
// for the two new read endpoints. Same reasoning: an unknown query parameter is
// answered rather than ignored, so a caller cannot probe for a filter that
// exists internally, and a typo in a legitimate filter fails loudly instead of
// silently widening the read.
function rejectUnexpectedQuery(res, query, allowed) {
  const unexpected = Object.keys(query || {}).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    res
      .status(400)
      .json({ success: false, message: "Unexpected query parameters.", fields: unexpected });
    return true;
  }
  return false;
}

// Rejects unknown keys rather than dropping them, so a caller can never
// discover an internal column by having it silently ignored, and can never
// reach one a future refactor forgets to filter. Same guard as Phase 3/4.
function rejectUnexpectedFields(res, body, allowed) {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    res.status(400).json({ success: false, message: "Unexpected fields.", fields: unexpected });
    return true;
  }
  return false;
}

function readBody(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}

function parseIdOr400(res, raw, label) {
  const id = parseResourceId(raw);
  if (id === null) {
    res.status(400).json({ success: false, message: `Invalid ${label}.` });
    return null;
  }
  return id;
}

function parsePagination(req) {
  const take = Number.parseInt(req.query && req.query.take, 10);
  const skip = Number.parseInt(req.query && req.query.skip, 10);
  return {
    take: Number.isInteger(take) ? take : undefined,
    skip: Number.isInteger(skip) ? skip : undefined,
  };
}

// --- Reads -------------------------------------------------------------------

exports.listMappings = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  try {
    const data = await getCaseFrameworkMappings(caseId, { client: prisma });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, "Failed to list framework mappings", error);
  }
};

exports.listMappingHistory = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  try {
    const { take, skip } = parsePagination(req);
    const data = await getCaseFrameworkMappingHistory(caseId, { client: prisma, take, skip });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, "Failed to read framework mapping history", error);
  }
};

// --- Mapping mutations -------------------------------------------------------

// The complete set of fields a caller may send. actor, source, state,
// effectiveAt, currentMappingKey, organizationId and every other internal
// column are absent, so a caller cannot forge provenance, backdate a mapping,
// or claim a mapping was AI-promoted when it was typed by hand.
const CREATE_ALLOWED_FIELDS = Object.freeze([
  "framework",
  "frameworkVersion",
  "referenceId",
  "referenceTitle",
  "mappingScope",
  "evidenceBasis",
  "rationale",
  "evidenceFindingId",
  // Phase 6.3. Note what is NOT here, and cannot be: catalogueVerified,
  // catalogueVersion, catalogueChecksum and evidenceQuoteLocator are all
  // SERVER-DERIVED. A caller able to set them could claim a catalogue check
  // that never ran, or aim a locator at a record the quote is not in — so they
  // are rejected as unexpected fields rather than merely ignored.
  "evidenceQuote",
  "evidenceQuoteSource",
  "evidenceConfidence",
  "mappingConfidence",
]);

exports.createMapping = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, CREATE_ALLOWED_FIELDS)) return undefined;

  try {
    const outcome = await createManualMapping(
      caseId,
      {
        framework: body.framework,
        frameworkVersion: body.frameworkVersion,
        referenceId: body.referenceId,
        referenceTitle: body.referenceTitle,
        mappingScope: body.mappingScope,
        evidenceBasis: body.evidenceBasis,
        rationale: body.rationale,
        evidenceFindingId: body.evidenceFindingId,
        evidenceQuote: body.evidenceQuote,
        evidenceQuoteSource: body.evidenceQuoteSource,
        evidenceConfidence: body.evidenceConfidence,
        mappingConfidence: body.mappingConfidence,
      },
      {
        client: prisma,
        actorUserId: actorUserId(req),
        auditContext: buildAuditContext(req),
        // Server-captured. A caller-supplied instant would let a mapping be
        // backdated ahead of or behind a decision it is meant to justify.
        effectiveAt: new Date(),
      }
    );

    return res.status(outcome.changed ? 201 : 200).json({
      success: true,
      data: {
        outcome: outcome.outcome,
        changed: outcome.changed,
        mapping: serializeMapping(outcome.mapping),
        disclaimer: COMPLIANCE_DISCLAIMER,
      },
    });
  } catch (error) {
    return handleError(res, "Failed to create framework mapping", error);
  }
};

const REMOVE_ALLOWED_FIELDS = Object.freeze(["reason"]);

exports.removeMapping = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;
  const mappingId = parseIdOr400(res, req.params.mappingId, "mapping id");
  if (mappingId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, REMOVE_ALLOWED_FIELDS)) return undefined;

  try {
    const outcome = await removeMapping(caseId, mappingId, {
      client: prisma,
      actorUserId: actorUserId(req),
      auditContext: buildAuditContext(req),
      reason: body.reason,
      effectiveAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      data: {
        outcome: outcome.outcome,
        changed: outcome.changed,
        mapping: serializeMapping(outcome.mapping),
        disclaimer: COMPLIANCE_DISCLAIMER,
      },
    });
  } catch (error) {
    return handleError(res, "Failed to remove framework mapping", error);
  }
};

// --- AI assistance -----------------------------------------------------------

/**
 * The safe Phase 5 configuration state.
 *
 * Gated on read:cases (every role) so the frontend can render "AI assistance is
 * disabled" for anybody who can see a case. Emits booleans, a provider name and
 * a template version — never a key, a URL, a timeout or a model parameter.
 */
exports.getAiConfig = async (req, res) => {
  try {
    const runtime = buildAiRuntime();
    const described = runtime.describe();
    return res.status(200).json({
      success: true,
      data: serializeAiConfigState({
        aiEnabled: described.aiEnabled,
        assistanceAvailable: described.assistanceAvailable,
        providerName: described.providerName,
        promptTemplateVersion: described.promptTemplateVersion,
        reasonCode: described.reasonCode,
        maxSuggestionsPerRun: described.maxSuggestionsPerRun,
        disclaimer: described.disclaimer,
      }),
    });
  } catch (error) {
    return serverError(res, "Failed to read AI configuration", error);
  }
};

exports.listSuggestions = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  try {
    const { take, skip } = parsePagination(req);

    // The current fingerprint is computed server-side and used ONLY to derive
    // the boolean `staleForApproval` per suggestion. It is never returned.
    const caseRecord = await prisma.case.findUnique({ where: { id: caseId } });
    let currentFingerprint;
    if (caseRecord && caseRecord.organizationId !== null) {
      const snapshot = await buildCaseEvidenceSnapshot(prisma, caseRecord, {});
      currentFingerprint = snapshot.fingerprint;
    }

    const data = await getCaseSuggestionHistory(caseId, {
      client: prisma,
      take,
      skip,
      currentFingerprint,
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, "Failed to read AI suggestion history", error);
  }
};

const REQUEST_ALLOWED_FIELDS = Object.freeze(["requestContext"]);

exports.requestSuggestions = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, REQUEST_ALLOWED_FIELDS)) return undefined;

  try {
    const { run, suggestions } = await requestMappingSuggestions(caseId, {
      client: prisma,
      actorUserId: actorUserId(req),
      auditContext: buildAuditContext(req),
      requestContext: body.requestContext,
      requestedAt: new Date(),
    });

    // 200 even for a DISABLED or FAILED run: the request was well formed and
    // was answered. A 503 would tell an analyst something is broken when the
    // shipped default is simply "off".
    return res.status(200).json({
      success: true,
      data: {
        runId: run.id,
        status: run.status,
        reasonCode: run.reasonCode,
        suggestionCount: run.suggestionCount,
        rejectedCount: run.rejectedCount,
        providerName: run.providerName,
        suggestions: suggestions.map(serializeSuggestion),
        disclaimer: COMPLIANCE_DISCLAIMER,
      },
    });
  } catch (error) {
    return handleError(res, "Failed to request AI mapping suggestions", error);
  }
};

const DECIDE_ALLOWED_FIELDS = Object.freeze(["reason"]);

exports.approveSuggestion = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;
  const suggestionId = parseIdOr400(res, req.params.suggestionId, "suggestion id");
  if (suggestionId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, DECIDE_ALLOWED_FIELDS)) return undefined;

  try {
    const outcome = await approveSuggestion(caseId, suggestionId, {
      client: prisma,
      actorUserId: actorUserId(req),
      auditContext: buildAuditContext(req),
      reason: body.reason,
      decidedAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      data: {
        outcome: outcome.outcome,
        changed: outcome.changed,
        suggestion: serializeSuggestion(outcome.suggestion),
        mapping: serializeMapping(outcome.mapping),
        disclaimer: COMPLIANCE_DISCLAIMER,
      },
    });
  } catch (error) {
    return handleError(res, "Failed to approve AI suggestion", error);
  }
};

exports.rejectSuggestion = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;
  const suggestionId = parseIdOr400(res, req.params.suggestionId, "suggestion id");
  if (suggestionId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, DECIDE_ALLOWED_FIELDS)) return undefined;

  try {
    const outcome = await rejectSuggestion(caseId, suggestionId, {
      client: prisma,
      actorUserId: actorUserId(req),
      auditContext: buildAuditContext(req),
      reason: body.reason,
      decidedAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      data: {
        outcome: outcome.outcome,
        changed: outcome.changed,
        suggestion: serializeSuggestion(outcome.suggestion),
        // Always null. Emitted explicitly so a client cannot read the absence
        // of the key as "a mapping may have been created and omitted".
        mapping: null,
        disclaimer: COMPLIANCE_DISCLAIMER,
      },
    });
  } catch (error) {
    return handleError(res, "Failed to reject AI suggestion", error);
  }
};

// ---------------------------------------------------------------------------
// Phase 6.3 — the pinned ATT&CK catalogue and the navigator read model
// ---------------------------------------------------------------------------
//
// Both are READS behind read:cases, the same capability that already governs
// "which controls were associated with this case". Neither writes anything, so
// neither audits: the audit trail records state changes, and filling it with
// read events would bury the writes it exists to make findable.

/**
 * Organization scope for a navigator read.
 *
 * Returns `null` for UNRESTRICTED. In this system that is the correct default
 * and not an oversight: ThreatNeXus is the CERT's own console, users carry no
 * organization binding, and a role holding read:cases is meant to see every
 * constituent — that IS the remit. The optional `organizationId` filter narrows
 * the view for an analyst working one constituent; it is a convenience, never a
 * security boundary, and the service takes the value explicitly so it can never
 * fall back to an implicit "everything" it was not told to use.
 */
function navigatorOrganizationScope(res, req) {
  if (req.query.organizationId === undefined) return { ok: true, organizationIds: null };
  const parsed = parseResourceId(req.query.organizationId);
  if (parsed === null) {
    res.status(400).json({ success: false, message: "Invalid organization id." });
    return { ok: false };
  }
  return { ok: true, organizationIds: [parsed] };
}

exports.getAttackCatalogue = async (req, res) => {
  if (rejectUnexpectedQuery(res, req.query, ["includeRetired"])) return undefined;
  try {
    const model = getCatalogueReadModel({
      includeRetired: req.query.includeRetired === "true",
    });
    return res.status(200).json({ success: true, data: model });
  } catch (error) {
    if (error instanceof AttackCatalogueUnavailableError) {
      // 503, not 500. The service is correctly refusing to serve a catalogue it
      // cannot verify; that is a dependency being unavailable, not a bug in the
      // request, and the closed code tells an operator which one.
      return res.status(503).json({
        success: false,
        message: "The pinned MITRE ATT&CK catalogue is unavailable.",
        code: error.code,
      });
    }
    return handleError(res, "Failed to read the ATT&CK catalogue", error);
  }
};

exports.getAttackNavigator = async (req, res) => {
  if (rejectUnexpectedQuery(res, req.query, ["organizationId"])) return undefined;
  const scope = navigatorOrganizationScope(res, req);
  if (!scope.ok) return undefined;

  try {
    const model = await buildAttackNavigator({
      client: prisma,
      organizationIds: scope.organizationIds,
      // Server-captured, and returned. Every figure on the navigator is "as of"
      // this instant over the loaded dataset — the UI states both rather than
      // presenting counts as standing facts.
      asOf: new Date(),
    });
    return res.status(200).json({
      success: true,
      data: { ...model, disclaimer: COMPLIANCE_DISCLAIMER },
    });
  } catch (error) {
    return handleError(res, "Failed to build the ATT&CK navigator", error);
  }
};

// ---------------------------------------------------------------------------
// Phase 6.3 — "no reference in this framework applies"
// ---------------------------------------------------------------------------

const NO_MAPPING_ALLOWED_FIELDS = Object.freeze(["framework", "rationale"]);
const NO_MAPPING_WITHDRAW_ALLOWED_FIELDS = Object.freeze(["reason"]);

exports.assertNoApplicableMapping = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, NO_MAPPING_ALLOWED_FIELDS)) return undefined;

  try {
    const outcome = await assertNoApplicableMappingService(caseId, body.framework, {
      client: prisma,
      actorUserId: actorUserId(req),
      auditContext: buildAuditContext(req),
      rationale: body.rationale,
      effectiveAt: new Date(),
    });

    return res.status(outcome.changed ? 201 : 200).json({
      success: true,
      data: {
        outcome: outcome.outcome,
        changed: outcome.changed,
        assertion: serializeNoMappingAssertion(outcome.assertion),
        disclaimer: COMPLIANCE_DISCLAIMER,
      },
    });
  } catch (error) {
    return handleError(res, "Failed to record the no-applicable-mapping determination", error);
  }
};

exports.withdrawNoApplicableMapping = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;
  const assertionId = parseIdOr400(res, req.params.assertionId, "assertion id");
  if (assertionId === null) return undefined;

  const body = readBody(req);
  if (rejectUnexpectedFields(res, body, NO_MAPPING_WITHDRAW_ALLOWED_FIELDS)) return undefined;

  try {
    const outcome = await withdrawNoApplicableMappingService(caseId, assertionId, {
      client: prisma,
      actorUserId: actorUserId(req),
      auditContext: buildAuditContext(req),
      reason: body.reason,
      effectiveAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      data: {
        outcome: outcome.outcome,
        changed: outcome.changed,
        assertion: serializeNoMappingAssertion(outcome.assertion),
        disclaimer: COMPLIANCE_DISCLAIMER,
      },
    });
  } catch (error) {
    return handleError(res, "Failed to withdraw the no-applicable-mapping determination", error);
  }
};

exports.listNoApplicableMappings = async (req, res) => {
  const caseId = parseIdOr400(res, req.params.id, "case id");
  if (caseId === null) return undefined;

  try {
    const caseRecord = await loadCaseOr404(prisma, caseId);
    const [standing, history] = await Promise.all([
      listStandingAssertions(prisma, caseRecord.id),
      listAssertionHistory(prisma, caseRecord.id, parsePagination(req)),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        caseId: caseRecord.id,
        caseReference: caseRecord.caseReference,
        standing: standing.map(serializeNoMappingAssertion),
        history: history.map(serializeNoMappingAssertion),
        disclaimer: COMPLIANCE_DISCLAIMER,
      },
    });
  } catch (error) {
    return handleError(res, "Failed to read no-applicable-mapping determinations", error);
  }
};

// Exported for the route table's own vocabulary checks and for tests.
exports.VOCABULARY = Object.freeze({
  FRAMEWORK_FAMILY_VALUES,
  MAPPING_SCOPE_VALUES,
  EVIDENCE_BASIS_VALUES,
  CONFIDENCE_LEVEL_VALUES,
  EVIDENCE_QUOTE_SOURCE_VALUES,
});

exports.internals = Object.freeze({
  handleError,
  rejectUnexpectedFields,
  rejectUnexpectedQuery,
  navigatorOrganizationScope,
  NO_MAPPING_ALLOWED_FIELDS,
  NO_MAPPING_WITHDRAW_ALLOWED_FIELDS,
  parsePagination,
  loadCaseOr404,
  CREATE_ALLOWED_FIELDS,
  REMOVE_ALLOWED_FIELDS,
  REQUEST_ALLOWED_FIELDS,
  DECIDE_ALLOWED_FIELDS,
});
