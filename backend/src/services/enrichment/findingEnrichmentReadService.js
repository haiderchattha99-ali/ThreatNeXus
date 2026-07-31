"use strict";

// Safe Finding-scoped IOC enrichment reads (P2-T2e-2).
//
// IocEnrichment is deliberately indicator-level, not Finding-level (P2-T2b,
// D-007): it has no findingId FK, so ten Findings sharing one IP share one
// cache row. This module is the one place that bridges the two — load the
// Finding, take its own canonical indicator, then query IocEnrichment by
// (provider, indicatorType, indicator) — never by inventing a direct
// relational link (a phantom FK column, a join table) that does not exist in
// the schema.
//
// Everything this module returns passes through `serializeEnrichmentRecord`,
// the one allow-list every raw IocEnrichment row must cross before it can
// reach an HTTP response. Never exposed, structurally: cacheKey,
// queryParamsHash, activeCacheKey, claimToken, claimedAt, leaseExpiresAt, any
// provider payload, or database/exception text — none of those fields are
// even read out of the row, so a future column addition cannot leak through
// this function by default.
//
// The three states a caller must be able to tell apart, all reachable
// through this one read:
//   - current SUCCESS with abuseConfidenceScore === 0  -> real evidence
//   - current absent (no fresh terminal row)            -> no context exists
//   - current a fresh FAILED/TIMEOUT/RATE_LIMITED row    -> known absence of
//     data, never confused with "no abuse reported"
// DEAD_LETTER is a queue-lifecycle failure, not a reputation outcome (see
// iocEnrichmentCacheRules.js's QUEUE_STATUS note) and can therefore never
// become `current` — `loadCurrent` only ever selects from TERMINAL_STATUSES,
// which excludes it by construction. A dead-lettered row is still visible,
// but only inside `history`, tagged with its own status.

const { ENRICHMENT_STATUS, INDICATOR_TYPES } = require("./iocEnrichmentTypes");
const { TERMINAL_STATUSES } = require("./iocEnrichmentCacheRules");

const DEFAULT_PROVIDER = "abuseipdb";
const MAX_PROVIDER_LENGTH = 64;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

class FindingEnrichmentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "FindingEnrichmentValidationError";
  }
}

class FindingEnrichmentNotFoundError extends Error {
  constructor(findingId) {
    super(`Finding ${findingId} not found`);
    this.name = "FindingEnrichmentNotFoundError";
    this.findingId = findingId;
  }
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

function assertValidAsOf(asOf) {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new FindingEnrichmentValidationError("asOf must be an explicit, valid Date");
  }
  return asOf;
}

// Same lowercase-identifier shape enrichmentCacheKey.js enforces for a
// provider string, applied here to a caller-supplied query parameter rather
// than to persisted data — so a malformed `?provider=` is a controlled 400,
// not a query that silently matches nothing or throws deep in Prisma.
function normalizeProvider(provider) {
  if (provider === undefined || provider === null) return DEFAULT_PROVIDER;
  if (
    typeof provider !== "string" ||
    provider.trim() === "" ||
    provider !== provider.toLowerCase() ||
    provider.length > MAX_PROVIDER_LENGTH
  ) {
    throw new FindingEnrichmentValidationError("provider must be a lowercase identifier");
  }
  return provider;
}

function normalizePage(page) {
  if (page === undefined || page === null) return DEFAULT_PAGE;
  if (!Number.isInteger(page) || page < 1) {
    throw new FindingEnrichmentValidationError("page must be a positive integer");
  }
  return page;
}

function normalizePageSize(pageSize) {
  if (pageSize === undefined || pageSize === null) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new FindingEnrichmentValidationError("pageSize must be a positive integer");
  }
  return Math.min(pageSize, MAX_PAGE_SIZE);
}

/**
 * Loads the Finding this read is scoped to and hands back only what this
 * module needs from it (id + canonical indicator) — never the whole row, so
 * a future Finding column cannot leak through here by accident.
 */
async function loadFindingIndicator(client, findingId) {
  const finding = await client.finding.findUnique({ where: { id: findingId } });
  if (!finding) throw new FindingEnrichmentNotFoundError(findingId);
  return { id: finding.id, indicator: finding.indicatorValue };
}

// Mirrors iocEnrichmentRepository.findFreshCachedResult's own freshness rule
// exactly (half-open window, terminal-only, queriedAt required) but is
// intentionally broader: this module reads by (provider, indicatorType,
// indicator) only, never by one exact cacheKey, because a read should surface
// the freshest evidence for this indicator regardless of which queryParams
// variant produced it.
async function loadCurrent(client, { provider, indicatorType, indicator, asOf }) {
  const rows = await client.iocEnrichment.findMany({
    where: {
      provider,
      indicatorType,
      indicator,
      status: { in: TERMINAL_STATUSES },
      queriedAt: { not: null },
      expiresAt: { gt: asOf },
    },
    orderBy: [{ queriedAt: "desc" }, { id: "desc" }],
    take: 1,
  });
  return rows[0] || null;
}

// The newest active PENDING job for this indicator, if any. Ordinarily at
// most one can exist per exact cacheKey (the `activeCacheKey` unique
// constraint), but this read is broader than one cacheKey (see loadCurrent),
// so in the rare case two different queryParams variants are both actively
// queued, only the most recently requested is surfaced as `activeJob` — a
// deliberate, documented simplification rather than an unbounded list.
async function loadActiveJob(client, { provider, indicatorType, indicator }) {
  const rows = await client.iocEnrichment.findMany({
    where: { provider, indicatorType, indicator, status: ENRICHMENT_STATUS.PENDING },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    take: 1,
  });
  return rows[0] || null;
}

// Bounded, deterministically ordered terminal history — every non-PENDING
// row, which includes DEAD_LETTER (a real stored status value, even though it
// is not part of the provider ENRICHMENT_STATUS taxonomy TERMINAL_STATUSES
// draws from). Ordered by requestedAt (always present, set explicitly by the
// scheduler) rather than queriedAt, which DEAD_LETTER rows never carry.
async function loadHistory(client, { provider, indicatorType, indicator }, { page, pageSize }) {
  const where = { provider, indicatorType, indicator, status: { not: ENRICHMENT_STATUS.PENDING } };
  const [totalCount, rows] = await Promise.all([
    client.iocEnrichment.count({ where }),
    client.iocEnrichment.findMany({
      where,
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return { rows, totalCount };
}

/**
 * The one allow-list every IocEnrichment row must cross before it can reach
 * an HTTP response. Fields not named here (cacheKey, queryParamsHash,
 * activeCacheKey, claimToken, claimedAt, leaseExpiresAt, ...) are never read
 * off `row` at all.
 */
function serializeEnrichmentRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    indicatorType: row.indicatorType,
    indicator: row.indicator,

    status: row.status,
    requestedAt: row.requestedAt,
    queriedAt: row.queriedAt,
    expiresAt: row.expiresAt,
    nextAttemptAt: row.nextAttemptAt,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    deadLetteredAt: row.deadLetteredAt,
    terminalReasonCode: row.terminalReasonCode,

    abuseConfidenceScore: row.abuseConfidenceScore,
    totalReports: row.totalReports,
    countryCode: row.countryCode,
    isp: row.isp,
    domain: row.domain,
    usageType: row.usageType,
    isWhitelisted: row.isWhitelisted,
    lastReportedAt: row.lastReportedAt,
    httpStatus: row.httpStatus,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    retryAfterSeconds: row.retryAfterSeconds,
  };
}

/**
 * Loads the safe enrichment-read context for one Finding: its current fresh
 * terminal result (if any), its active PENDING job (if any), and a bounded,
 * paginated terminal/dead-letter history — every row already passed through
 * `serializeEnrichmentRecord`.
 *
 * @param {number} findingId
 * @param {{client?: object, provider?: string, asOf: Date, page?: number,
 *   pageSize?: number, includeHistory?: boolean}} options `asOf` is the
 *   caller's explicit evaluation time (the controller obtains it once and
 *   passes it down) — this module never reads the wall clock itself.
 */
async function getFindingEnrichmentContext(findingId, options = {}) {
  const client = resolveClient(options.client);
  const id = assertValidFindingId(findingId);
  const asOf = assertValidAsOf(options.asOf);
  const provider = normalizeProvider(options.provider);
  const page = normalizePage(options.page);
  const pageSize = normalizePageSize(options.pageSize);
  const includeHistory = options.includeHistory !== false;

  const { indicator } = await loadFindingIndicator(client, id);
  const indicatorType = INDICATOR_TYPES.IPV4;

  const identity = { provider, indicatorType, indicator };

  const [current, activeJob, historyResult] = await Promise.all([
    loadCurrent(client, { ...identity, asOf }),
    loadActiveJob(client, identity),
    includeHistory ? loadHistory(client, identity, { page, pageSize }) : Promise.resolve(null),
  ]);

  return {
    findingId: id,
    indicator,
    provider,
    asOf,
    current: serializeEnrichmentRecord(current),
    activeJob: serializeEnrichmentRecord(activeJob),
    history: historyResult ? historyResult.rows.map(serializeEnrichmentRecord) : [],
    pagination: {
      page,
      pageSize,
      totalCount: historyResult ? historyResult.totalCount : null,
      totalPages: historyResult ? Math.max(1, Math.ceil(historyResult.totalCount / pageSize)) : null,
    },
  };
}

module.exports = {
  DEFAULT_PROVIDER,
  MAX_PAGE_SIZE,
  FindingEnrichmentValidationError,
  FindingEnrichmentNotFoundError,
  normalizeProvider,
  normalizePage,
  normalizePageSize,
  loadFindingIndicator,
  serializeEnrichmentRecord,
  getFindingEnrichmentContext,
};
