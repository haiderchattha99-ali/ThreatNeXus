"use strict";

// Enrichment scheduling (P2-T2b): the one entry point a caller uses to ask
// "get me reputation context for this indicator", without knowing whether the
// answer is already cached, already queued, or needs new work.
//
// What this module explicitly does NOT do — all of it belongs to P2-T2c:
//   - call a provider (MockProvider or AbuseIPDB): scheduling never performs
//     I/O beyond the database, so no external call can ever end up inside, or
//     be serialized behind, a database transaction
//   - write an audit event: there is no request/actor context here
//   - retry failed lookups on a timer, or run a daemon
//   - decide TTL policy: `asOf` and any TTL are supplied by the caller
//
// Concurrency
// -----------
// The "at most one active PENDING job per cacheKey" rule is a database unique
// constraint (`activeCacheKey`), not an application check, so two processes
// scheduling the same indicator at the same instant cannot both create work.
// The loser sees Prisma P2002 — which is caught OUTSIDE any transaction and
// resolved by re-reading committed state. That placement is the whole point:
// on PostgreSQL a constraint violation caught *inside* an open transaction
// leaves it aborted (25P02), and every subsequent query in it fails with an
// opaque error. `scheduleEnrichment` therefore issues plain statements and
// re-runs the whole read-decide-write cycle, mirroring the bounded
// whole-transaction retry already used by dedupService.js and
// findingOwnershipService.js.

const {
  IocEnrichmentValidationError,
  MIN_LEASE_MS,
  MAX_LEASE_MS,
} = require("./iocEnrichmentCacheRules");
const { buildEnrichmentCacheIdentity } = require("./enrichmentCacheKey");
const {
  findFreshCachedResult,
  findActiveJobByCacheKey,
  createPendingJob,
} = require("./iocEnrichmentRepository");

const PRISMA_UNIQUE_VIOLATION = "P2002";
const PRISMA_TRANSACTION_CONFLICT = "P2034";
const RETRYABLE_ERROR_CODES = Object.freeze([PRISMA_UNIQUE_VIOLATION, PRISMA_TRANSACTION_CONFLICT]);

// Bounded, as with every other retry loop in this repository. Each attempt
// re-reads committed state, so convergence does not depend on a delay.
const MAX_SCHEDULE_ATTEMPTS = 5;

const SCHEDULE_OUTCOME = Object.freeze({
  // A fresh terminal result already exists — no work created, no provider
  // call needed. The exact stored status is returned, success or failure.
  CACHE_HIT: "CACHE_HIT",
  // This call created the active PENDING job.
  SCHEDULED: "SCHEDULED",
  // An active PENDING job for this cacheKey already existed (created by an
  // earlier call or by a concurrent racer). No second job was created.
  ALREADY_PENDING: "ALREADY_PENDING",
});

function isRetryableConcurrencyError(error) {
  return Boolean(error) && RETRYABLE_ERROR_CODES.includes(error.code);
}

/**
 * Ensures reputation context for one indicator is either already available or
 * durably queued — never both, never twice.
 *
 * Resolution order:
 *   1. fresh cached terminal result -> CACHE_HIT (the row, status exactly as
 *      stored; a cached failure is returned as that failure, never as a clean
 *      or zero-score result)
 *   2. existing active PENDING job  -> ALREADY_PENDING
 *   3. otherwise create one         -> SCHEDULED
 *
 * A uniqueness race that can be safely resolved (P2002 on `activeCacheKey`,
 * meaning a concurrent caller won) is not an error and is never thrown: the
 * loop re-reads and returns ALREADY_PENDING, or CACHE_HIT if the winner
 * completed in the meantime.
 *
 * @param {{provider: string, indicatorType: string, indicator: string,
 *   queryParams?: object|null}} identityInput
 * @param {{client?: object, asOf: Date}} options `asOf` is the explicit
 *   evaluation time — used for cache freshness AND as the job's requestedAt.
 * @returns {Promise<{outcome: string, cacheKey: string, record: object}>}
 */
async function scheduleEnrichment(identityInput, options = {}) {
  const { client } = options;
  const { asOf } = options;
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new IocEnrichmentValidationError("scheduleEnrichment: asOf must be an explicit, valid Date");
  }

  // Validates identity up front: a bad provider/indicator is a programmer
  // error and must fail before any row is touched, not inside the retry loop.
  const identity = buildEnrichmentCacheIdentity(identityInput);

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_SCHEDULE_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const cached = await findFreshCachedResult(identity, { client, asOf });
    if (cached) {
      return { outcome: SCHEDULE_OUTCOME.CACHE_HIT, cacheKey: identity.cacheKey, record: cached };
    }

    // eslint-disable-next-line no-await-in-loop
    const active = await findActiveJobByCacheKey(identity.cacheKey, { client });
    if (active) {
      return { outcome: SCHEDULE_OUTCOME.ALREADY_PENDING, cacheKey: identity.cacheKey, record: active };
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const created = await createPendingJob(identity, { client, requestedAt: asOf });
      return { outcome: SCHEDULE_OUTCOME.SCHEDULED, cacheKey: identity.cacheKey, record: created };
    } catch (error) {
      // Only a recoverable race is retried. A validation error, a programmer
      // error, or an unknown database failure propagates untouched.
      if (!isRetryableConcurrencyError(error)) throw error;
      lastError = error;
    }
  }

  // Exhausting the budget means sustained contention on one cacheKey, which
  // is a real operational signal — never swallowed into a fake outcome.
  throw lastError;
}

module.exports = {
  SCHEDULE_OUTCOME,
  MAX_SCHEDULE_ATTEMPTS,
  MIN_LEASE_MS,
  MAX_LEASE_MS,
  scheduleEnrichment,
};
