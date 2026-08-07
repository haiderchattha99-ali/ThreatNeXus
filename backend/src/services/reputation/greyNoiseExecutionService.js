"use strict";

// Analyst-facing, synchronous, audited GreyNoise lookup for one Finding
// (Phase 8D). Deliberately mirrors censysExecutionService.js's shape
// (validate -> audit ATTEMPTED -> do the work -> audit the outcome) —
// there is no queue, no cache-key, no force/justification: a human asks,
// this calls the provider once, persists the terminal result, and returns
// it. "No queues/schedulers" is this phase's explicit scope, same as 8B.
//
// Rate limiting is enforced by the ROUTE (the same providerRateLimiter
// bucket every other provider-execution route already shares), not here —
// this module has no HTTP dependency.

const { createGreyNoiseProvider } = require("./greyNoiseProvider");
const { ENRICHMENT_STATUS } = require("./greyNoiseTypes");
const {
  FindingEnrichmentValidationError,
  FindingEnrichmentNotFoundError,
  loadFindingIndicator,
} = require("../enrichment/findingEnrichmentReadService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");
const env = require("../../config/env");

const AUDIT_ACTIONS = Object.freeze({
  ATTEMPTED: "greynoise.lookup.attempted",
  SUCCEEDED: "greynoise.lookup.succeeded",
  FAILED: "greynoise.lookup.failed",
  UNAVAILABLE: "greynoise.lookup.unavailable",
  RATE_LIMITED: "greynoise.lookup.rate_limited",
});

const AUDIT_ENTITY_TYPE = "Finding";

// Terminal ENRICHMENT_STATUS -> which of the five audit actions it produces.
// NOT_FOUND is a completed, successful call with no matching record — the
// same reasoning NVD's and Censys's own NOT_FOUND already get (a real "no
// evidence" answer, not a failure) — so it audits as SUCCEEDED, not FAILED.
const STATUS_TO_AUDIT_ACTION = Object.freeze({
  [ENRICHMENT_STATUS.SUCCESS]: AUDIT_ACTIONS.SUCCEEDED,
  [ENRICHMENT_STATUS.NOT_FOUND]: AUDIT_ACTIONS.SUCCEEDED,
  [ENRICHMENT_STATUS.RATE_LIMITED]: AUDIT_ACTIONS.RATE_LIMITED,
  [ENRICHMENT_STATUS.SKIPPED_DISABLED]: AUDIT_ACTIONS.UNAVAILABLE,
  [ENRICHMENT_STATUS.INVALID_KEY]: AUDIT_ACTIONS.FAILED,
  [ENRICHMENT_STATUS.TIMEOUT]: AUDIT_ACTIONS.FAILED,
  [ENRICHMENT_STATUS.FAILED]: AUDIT_ACTIONS.FAILED,
  [ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR]: AUDIT_ACTIONS.FAILED,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

function assertValidFindingId(findingId) {
  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new FindingEnrichmentValidationError("findingId must be a positive integer");
  }
  return findingId;
}

function assertValidNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new FindingEnrichmentValidationError("now must be an explicit, valid Date");
  }
  return now;
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...auditContext, ...event }, { client });
  } catch (error) {
    console.error("GreyNoise lookup audit failed", { name: error && error.name });
  }
}

// Builds a fresh GreyNoiseProvider from real environment configuration. A
// caller-injected fetchImpl (tests only) never reaches production code —
// production always resolves globalThis.fetch here.
function buildProvider({ fetchImpl } = {}) {
  return createGreyNoiseProvider({
    apiKey: env.GREYNOISE_API_KEY,
    baseUrl: env.GREYNOISE_BASE_URL,
    timeoutMs: env.GREYNOISE_TIMEOUT_MS,
    fetchImpl,
  });
}

// Allow-listed mapping from the validated result into Prisma columns. Never
// a spread of the whole result — an accidental future field on the result
// object cannot leak into a column that doesn't expect it.
function toPersistedRow(result) {
  const data = result.data;
  return {
    indicator: result.indicator,
    status: result.status,
    queriedAt: result.queriedAt,
    httpStatus: result.httpStatus,
    errorCode: result.errorInfo ? result.errorInfo.code : null,
    retryAfterSeconds: result.retryAfterSeconds,
    noise: data ? data.noise : null,
    riot: data ? data.riot : null,
    classification: data ? data.classification : null,
    actorName: data ? data.actorName : null,
    link: data ? data.link : null,
    lastSeen: data ? data.lastSeen : null,
    message: data ? data.message : null,
  };
}

function serializeRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    indicator: row.indicator,
    status: row.status,
    queriedAt: row.queriedAt,
    httpStatus: row.httpStatus,
    errorCode: row.errorCode,
    retryAfterSeconds: row.retryAfterSeconds,
    noise: row.noise,
    riot: row.riot,
    classification: row.classification,
    actorName: row.actorName,
    link: row.link,
    lastSeen: row.lastSeen,
    message: row.message,
  };
}

/**
 * Executes one synchronous, audited GreyNoise lookup for a Finding's
 * indicator. Never throws for an expected provider outcome (disabled,
 * rate-limited, unavailable, ...) — only for a bad findingId, an unknown
 * Finding, or a genuine database failure while persisting the result.
 *
 * @param {number} findingId
 * @param {{client?: object, now: Date, auditContext?: object,
 *   fetchImpl?: Function}} options `now` is the caller's single explicit
 *   evaluation time — this module never reads the wall clock itself.
 * @returns {Promise<{findingId: number, indicator: string, provider: string,
 *   outcome: string, record: object|null}>}
 */
async function executeGreyNoiseLookup(findingId, options = {}) {
  const client = resolveClient(options.client);
  const auditContext = isPlainObject(options.auditContext) ? options.auditContext : {};

  const id = assertValidFindingId(findingId);
  const now = assertValidNow(options.now);

  // Not found is checked before any audit write — an unknown Finding id
  // never emits an "attempted" event.
  const { indicator } = await loadFindingIndicator(client, id);

  await audit(client, auditContext, {
    action: AUDIT_ACTIONS.ATTEMPTED,
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: AUDIT_ENTITY_TYPE,
    entityId: id,
    after: { findingId: id, provider: "greynoise" },
    reason: "GreyNoise noise/reputation lookup attempted",
  });

  const provider = buildProvider({ fetchImpl: options.fetchImpl });
  const result = await provider.lookup({ indicator, asOf: now });

  const row = await client.greyNoiseEnrichment.create({ data: toPersistedRow(result) });

  const auditAction = STATUS_TO_AUDIT_ACTION[result.status] || AUDIT_ACTIONS.FAILED;
  const auditOutcome =
    auditAction === AUDIT_ACTIONS.SUCCEEDED ? AUDIT_OUTCOMES.SUCCESS : AUDIT_OUTCOMES.FAILURE;

  await audit(client, auditContext, {
    action: auditAction,
    outcome: auditOutcome,
    entityType: AUDIT_ENTITY_TYPE,
    entityId: id,
    after: {
      findingId: id,
      provider: "greynoise",
      status: result.status,
      greyNoiseEnrichmentId: row.id,
      // errorCode only — never errorInfo.message and never a raw upstream
      // body, matching Censys's own audit payload shape exactly.
      errorCode: result.errorInfo ? result.errorInfo.code : null,
    },
    reason: `GreyNoise lookup: ${result.status}`,
  });

  return {
    findingId: id,
    indicator,
    provider: "greynoise",
    outcome: result.status,
    record: serializeRecord(row),
  };
}

module.exports = {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPE,
  FindingEnrichmentValidationError,
  FindingEnrichmentNotFoundError,
  buildProvider,
  toPersistedRow,
  serializeRecord,
  executeGreyNoiseLookup,
};
