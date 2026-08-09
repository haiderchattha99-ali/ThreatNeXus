"use strict";

// Analyst-facing, synchronous, audited Netlas lookup for one Finding
// (Phase 8F). Deliberately mirrors censysExecutionService.js's/
// shodanExecutionService.js's shape (validate -> audit ATTEMPTED -> do the
// work -> audit the outcome) — there is no queue, no cache-key, no
// force/justification: a human asks, this calls the provider once, persists
// the terminal result, and returns it. "No queues/schedulers" is this
// phase's explicit scope, same as 8B/8D/8E.
//
// Rate limiting is enforced by the ROUTE (the same providerRateLimiter
// bucket every other provider-execution route already shares), not here —
// this module has no HTTP dependency.

const { createNetlasProvider } = require("./netlasProvider");
const { ENRICHMENT_STATUS } = require("./netlasTypes");
const {
  FindingEnrichmentValidationError,
  FindingEnrichmentNotFoundError,
  loadFindingIndicator,
} = require("../enrichment/findingEnrichmentReadService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");
const env = require("../../config/env");

const AUDIT_ACTIONS = Object.freeze({
  ATTEMPTED: "netlas.lookup.attempted",
  SUCCEEDED: "netlas.lookup.succeeded",
  FAILED: "netlas.lookup.failed",
  UNAVAILABLE: "netlas.lookup.unavailable",
  RATE_LIMITED: "netlas.lookup.rate_limited",
});

const AUDIT_ENTITY_TYPE = "Finding";

// Terminal ENRICHMENT_STATUS -> which of the five audit actions it produces.
// NOT_FOUND is a completed, successful call with no matching record — the
// same reasoning NVD's/Censys's/GreyNoise's/Shodan's own NOT_FOUND already
// get (a real "no evidence" answer, not a failure) — so it audits as
// SUCCEEDED, not FAILED.
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
    console.error("Netlas lookup audit failed", { name: error && error.name });
  }
}

// Builds a fresh NetlasProvider from real environment configuration. A
// caller-injected fetchImpl (tests only) never reaches production code —
// production always resolves globalThis.fetch here.
function buildProvider({ fetchImpl } = {}) {
  return createNetlasProvider({
    apiKey: env.NETLAS_API_KEY,
    baseUrl: env.NETLAS_BASE_URL,
    timeoutMs: env.NETLAS_TIMEOUT_MS,
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
    services: data ? data.services : undefined,
    products: data ? data.products : undefined,
    hostnames: data ? data.hostnames : undefined,
    dnsNames: data ? data.dnsNames : undefined,
    organization: data ? data.organization : null,
    asn: data ? data.asn : null,
    asnOrg: data ? data.asnOrg : null,
    country: data ? data.country : null,
    certificateSubject: data ? data.certificateSubject : null,
    certificateIssuer: data ? data.certificateIssuer : null,
    certificateSan: data ? data.certificateSan : undefined,
    lastSeen: data ? data.lastSeen : null,
    firstSeen: data ? data.firstSeen : null,
    link: data ? data.link : null,
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
    services: row.services ?? [],
    products: row.products ?? [],
    hostnames: row.hostnames ?? [],
    dnsNames: row.dnsNames ?? [],
    organization: row.organization,
    asn: row.asn,
    asnOrg: row.asnOrg,
    country: row.country,
    certificateSubject: row.certificateSubject,
    certificateIssuer: row.certificateIssuer,
    certificateSan: row.certificateSan ?? [],
    lastSeen: row.lastSeen,
    firstSeen: row.firstSeen,
    link: row.link,
  };
}

/**
 * Executes one synchronous, audited Netlas lookup for a Finding's indicator.
 * Never throws for an expected provider outcome (disabled, rate-limited,
 * unavailable, ...) — only for a bad findingId, an unknown Finding, or a
 * genuine database failure while persisting the result.
 *
 * @param {number} findingId
 * @param {{client?: object, now: Date, auditContext?: object,
 *   fetchImpl?: Function}} options `now` is the caller's single explicit
 *   evaluation time — this module never reads the wall clock itself.
 * @returns {Promise<{findingId: number, indicator: string, provider: string,
 *   outcome: string, record: object|null}>}
 */
async function executeNetlasLookup(findingId, options = {}) {
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
    after: { findingId: id, provider: "netlas" },
    reason: "Netlas cross-source attack-surface lookup attempted",
  });

  const provider = buildProvider({ fetchImpl: options.fetchImpl });
  const result = await provider.lookup({ indicator, asOf: now });

  const row = await client.netlasEnrichment.create({ data: toPersistedRow(result) });

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
      provider: "netlas",
      status: result.status,
      netlasEnrichmentId: row.id,
      // errorCode only — never errorInfo.message and never a raw upstream
      // body or the Authorization header (which carries the API key),
      // matching Censys's/GreyNoise's/Shodan's own audit payload shape
      // exactly.
      errorCode: result.errorInfo ? result.errorInfo.code : null,
    },
    reason: `Netlas cross-source attack-surface lookup: ${result.status}`,
  });

  return {
    findingId: id,
    indicator,
    provider: "netlas",
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
  executeNetlasLookup,
};
