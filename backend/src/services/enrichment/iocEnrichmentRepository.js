"use strict";

// Prisma persistence for IocEnrichment (P2-T2b): the durable indicator-level
// reputation cache and its work queue. Every decision this module makes is
// delegated to the pure rules in iocEnrichmentCacheRules.js /
// enrichmentCacheKey.js; what lives here is the database access itself.
//
// Deliberately absent from this whole file:
//   - any provider call (MockProvider included) — a provider is I/O, and I/O
//     never happens inside, or on behalf of, a database transaction here
//   - any audit event — these primitives have no request/actor context; the
//     P2-T2c orchestration layer that does will own auditing
//   - any wall-clock read — every time-sensitive function takes an explicit
//     `asOf`/`now`
//   - any raw SQL
//
// Concurrency model
// -----------------
// Two guarantees have to survive concurrent processes:
//
//   1. At most one ACTIVE (PENDING) job per cacheKey. Enforced by the
//      `activeCacheKey String? @unique` column — a database constraint, not an
//      application check. A losing racer gets P2002, which is recovered from
//      OUTSIDE any transaction (see enrichmentQueueService.js).
//
//   2. At most one live lease owner per job. Enforced by a guarded, single-
//      statement `updateMany` whose WHERE clause names the current lease
//      state. PostgreSQL row-locks the target row for the duration of the
//      UPDATE and re-evaluates the WHERE against the winner's committed row,
//      so the second UPDATE matches zero rows instead of stealing the lease.
//      This is a compare-and-swap on (status, claimToken, leaseExpiresAt) —
//      NOT on `updatedAt`, which is TIMESTAMP(3) and is not a safe version
//      token (that mistake is already recorded and withdrawn in STATUS.md for
//      P1-T4).
//
// These guarded updates are intentionally issued as bare statements rather
// than inside an explicit SERIALIZABLE transaction: at READ COMMITTED the
// blocked writer re-checks the updated row and cleanly loses, whereas
// SERIALIZABLE would instead raise a serialization failure the caller would
// have to retry for no benefit. Callers may still wrap them in their own
// transaction — the guard remains correct, and a rollback simply restores the
// previous durable state.

const crypto = require("node:crypto");

const { ENRICHMENT_STATUS } = require("./iocEnrichmentTypes");
const { buildEnrichmentCacheIdentity } = require("./enrichmentCacheKey");
const {
  IocEnrichmentValidationError,
  TERMINAL_STATUSES,
  QUEUE_STATUS,
  ENRICHMENT_TERMINAL_REASON,
  buildTerminalFields,
  boundBatchSize,
  assertValidLeaseMs,
  assertValidMaxAttempts,
  assertValidTerminalReasonCode,
  isTerminalStatus,
} = require("./iocEnrichmentCacheRules");

// Completion outcomes. NOT_CLAIM_OWNER is the safe failure for every stale or
// wrong credential: a completed job, a reclaimed lease, an unknown id, or a
// forged token all land here rather than throwing or corrupting a row.
const COMPLETION_OUTCOME = Object.freeze({
  COMPLETED: "COMPLETED",
  NOT_CLAIM_OWNER: "NOT_CLAIM_OWNER",
});

const RELEASE_OUTCOME = Object.freeze({
  RELEASED: "RELEASED",
  NOT_CLAIM_OWNER: "NOT_CLAIM_OWNER",
});

// Dead-letter outcomes. NOT_CLAIM_OWNER covers every stale/wrong credential
// exactly as it does for completion; NOT_EXHAUSTED is the specific refusal
// for the unleased sweep path when the row still has budget left.
const DEAD_LETTER_OUTCOME = Object.freeze({
  DEAD_LETTERED: "DEAD_LETTERED",
  NOT_CLAIM_OWNER: "NOT_CLAIM_OWNER",
  NOT_EXHAUSTED: "NOT_EXHAUSTED",
});

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

function assertValidDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new IocEnrichmentValidationError(`${label} must be an explicit, valid Date`);
  }
  return value;
}

function assertValidId(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new IocEnrichmentValidationError("id must be a positive integer");
  }
  return id;
}

function assertValidClaimToken(claimToken) {
  if (typeof claimToken !== "string" || claimToken.trim() === "") {
    throw new IocEnrichmentValidationError("claimToken must be a non-empty string");
  }
  return claimToken;
}

/**
 * Newest unexpired TERMINAL result for this cache identity, or null.
 *
 * A PENDING row is never returned: queued work is not cached evidence. The
 * status is returned exactly as stored — a cached NOT_FOUND/TIMEOUT/FAILED is
 * never reshaped into "no abuse reported".
 *
 * Ordering is (queriedAt desc, id desc): deterministic even when two rows
 * share a millisecond.
 *
 * @param {{provider: string, indicatorType: string, indicator: string,
 *   queryParams?: object|null}} identityInput
 * @param {{client?: object, asOf: Date}} options
 */
async function findFreshCachedResult(identityInput, options = {}) {
  const client = resolveClient(options.client);
  const asOf = assertValidDate(options.asOf, "asOf");
  const identity = buildEnrichmentCacheIdentity(identityInput);

  const record = await client.iocEnrichment.findFirst({
    where: {
      cacheKey: identity.cacheKey,
      status: { in: TERMINAL_STATUSES },
      queriedAt: { not: null },
      // Half-open freshness window [queriedAt, expiresAt): a row expiring
      // exactly at `asOf` is already stale. A null expiresAt never matches.
      expiresAt: { gt: asOf },
    },
    orderBy: [{ queriedAt: "desc" }, { id: "desc" }],
  });

  return record || null;
}

/**
 * The one active (PENDING) job for this cacheKey, or null. Uses the unique
 * `activeCacheKey` column, so this is a single index lookup and can never
 * return two rows.
 */
async function findActiveJobByCacheKey(cacheKey, options = {}) {
  const client = resolveClient(options.client);
  if (typeof cacheKey !== "string" || cacheKey.trim() === "") {
    throw new IocEnrichmentValidationError("cacheKey must be a non-empty string");
  }
  return client.iocEnrichment.findUnique({ where: { activeCacheKey: cacheKey } });
}

/**
 * Inserts one PENDING job. Throws Prisma P2002 if an active job already
 * exists for this cacheKey — recovery belongs to the caller, outside any
 * transaction (see enrichmentQueueService.scheduleEnrichment).
 *
 * @param {object} identityInput see buildEnrichmentCacheIdentity
 * @param {{client?: object, requestedAt: Date}} options
 */
async function createPendingJob(identityInput, options = {}) {
  const client = resolveClient(options.client);
  const requestedAt = assertValidDate(options.requestedAt, "requestedAt");
  const identity = buildEnrichmentCacheIdentity(identityInput);
  // Bounded and persisted per job, so this job's budget cannot change under
  // it later. Out-of-range throws rather than clamping (see the rule).
  const maxAttempts = assertValidMaxAttempts(options.maxAttempts ?? null);

  return client.iocEnrichment.create({
    data: {
      provider: identity.provider,
      indicatorType: identity.indicatorType,
      indicator: identity.indicator,
      queryParams: identity.queryParams,
      queryParamsHash: identity.queryParamsHash,
      cacheKey: identity.cacheKey,
      status: ENRICHMENT_STATUS.PENDING,
      requestedAt,
      activeCacheKey: identity.cacheKey,
      // A brand-new job has spent nothing and is eligible immediately.
      attemptCount: 0,
      maxAttempts,
      nextAttemptAt: null,
    },
  });
}

/**
 * Bounded, deterministically ordered list of jobs a consumer could claim as
 * of `asOf`: PENDING rows that are both lease-free (unclaimed, or an expired
 * lease) and retry-eligible (`nextAttemptAt` null or already reached).
 *
 * DEAD_LETTER rows can never appear here: the `status: PENDING` filter
 * excludes them structurally, and dead-lettering also clears the lease
 * metadata, so there is no second way back in.
 *
 * A row that has already spent its attempt budget IS still listed. That is
 * deliberate — it is the only way a job stranded at its limit by an earlier
 * crash gets swept into DEAD_LETTER rather than sitting PENDING forever.
 * `claimPendingJob` refuses it and `deadLetterExhaustedJob` retires it.
 *
 * Reading does NOT claim. Two consumers listing simultaneously will see the
 * same rows; claiming is what decides ownership.
 *
 * @param {{limit?: number}} [criteria]
 * @param {{client?: object, asOf: Date}} options
 */
async function listPendingCandidates(criteria = {}, options = {}) {
  const client = resolveClient(options.client);
  const asOf = assertValidDate(options.asOf, "asOf");
  const take = boundBatchSize(criteria.limit ?? null);

  return client.iocEnrichment.findMany({
    where: {
      status: ENRICHMENT_STATUS.PENDING,
      // Two independent gates, so both must hold. Expressed as an explicit
      // AND of two ORs because a Prisma `where` may carry only one `OR` key.
      AND: [
        {
          // Lease boundary is inclusive: a lease expiring exactly at `asOf`
          // is reclaimable, matching isClaimableRecord.
          OR: [{ claimToken: null }, { leaseExpiresAt: { lte: asOf } }],
        },
        {
          // Retry boundary is inclusive too: nextAttemptAt === asOf is
          // eligible, matching isRetryEligibleRecord.
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: asOf } }],
        },
      ],
    },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    take,
  });
}

/**
 * Atomically establishes a bounded lease on one PENDING job AND consumes one
 * unit of its attempt budget.
 *
 * Returns `{ record, claimToken }` for the single winning consumer, or null
 * for everyone else (already leased by someone with a live lease, already
 * terminal, not yet retry-eligible, budget exhausted, or gone). Reclaiming an
 * EXPIRED lease is allowed and mints a new token — which is precisely what
 * invalidates the previous holder's ability to complete the job.
 *
 * `attemptCount` is incremented by the SAME guarded statement that sets the
 * lease, never by a follow-up write. That is what makes "attemptCount counts
 * real attempts" true under concurrency: the loser of a claim race matches
 * zero rows and therefore increments nothing.
 *
 * The budget guard compares the live `attemptCount` column against the row's
 * own `maxAttempts`, read first. Reading it separately is safe because
 * `maxAttempts` is immutable for the life of a row — the value is a constant
 * in the WHERE clause, while `attemptCount` is re-evaluated by PostgreSQL at
 * update time against the winner's committed row.
 *
 * @param {number} id
 * @param {{client?: object, now: Date, leaseMs: number}} options
 */
async function claimPendingJob(id, options = {}) {
  const client = resolveClient(options.client);
  const now = assertValidDate(options.now, "now");
  const leaseMs = assertValidLeaseMs(options.leaseMs);
  assertValidId(id);

  const existing = await client.iocEnrichment.findUnique({ where: { id } });
  if (!existing || existing.status !== ENRICHMENT_STATUS.PENDING) return null;
  const maxAttempts = Number.isInteger(existing.maxAttempts) ? existing.maxAttempts : 0;

  const claimToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  // The guard IS the concurrency control — a single statement whose WHERE
  // names the lease state, the retry gate and the budget it expects.
  const { count } = await client.iocEnrichment.updateMany({
    where: {
      id,
      status: ENRICHMENT_STATUS.PENDING,
      attemptCount: { lt: maxAttempts },
      AND: [
        { OR: [{ claimToken: null }, { leaseExpiresAt: { lte: now } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      ],
    },
    data: {
      claimToken,
      claimedAt: now,
      leaseExpiresAt,
      lastAttemptAt: now,
      // Atomic with the lease: no separate read-modify-write, so two racers
      // can never both count an attempt for the same lease.
      attemptCount: { increment: 1 },
    },
  });

  if (count === 0) return null;

  const record = await client.iocEnrichment.findUnique({ where: { id } });
  // Defensive: only report ownership if the durable row still carries our
  // token (a lease long enough to matter makes this practically unreachable,
  // but ownership is never assumed from a local variable alone).
  if (!record || record.claimToken !== claimToken) return null;

  return { record, claimToken };
}

/**
 * Lists candidates and claims as many as it can, in the listed order. Returns
 * only the jobs this consumer actually owns — a job another consumer won in
 * between is silently skipped, never reported as claimed.
 */
async function claimPendingBatch(criteria = {}, options = {}) {
  const client = resolveClient(options.client);
  const now = assertValidDate(options.now, "now");
  const leaseMs = assertValidLeaseMs(options.leaseMs);

  const candidates = await listPendingCandidates(criteria, { client, asOf: now });

  const claimed = [];
  // Sequential by design: claiming is a per-row compare-and-swap, and racing
  // a consumer's own claims against each other buys nothing.
  // eslint-disable-next-line no-restricted-syntax
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await claimPendingJob(candidate.id, { client, now, leaseMs });
    if (outcome) claimed.push(outcome);
  }
  return claimed;
}

// A completion must describe the job it is completing. A result for a
// different provider/indicator/type is a programmer error, not a race.
function assertResultMatchesRecord(result, record) {
  if (!result || typeof result !== "object") {
    throw new IocEnrichmentValidationError("result must be a normalized enrichment result object");
  }
  if (!isTerminalStatus(result.status)) {
    throw new IocEnrichmentValidationError(
      `result.status "${String(result.status)}" is not a terminal status`
    );
  }
  if (
    result.provider !== record.provider ||
    result.indicatorType !== record.indicatorType ||
    result.indicator !== record.indicator
  ) {
    throw new IocEnrichmentValidationError(
      "result identity does not match the claimed job's provider/indicatorType/indicator"
    );
  }
}

/**
 * Transitions the claimed PENDING row into exactly one terminal status,
 * storing only allow-listed normalized fields.
 *
 * Guarantees:
 *  - requires the correct claim token; a wrong/stale one returns
 *    NOT_CLAIM_OWNER and changes nothing
 *  - cannot complete the same claim twice (the token is cleared on success)
 *  - cannot overwrite an already-terminal result (`status: PENDING` guard)
 *  - clears `activeCacheKey`, freeing the cacheKey for a future attempt while
 *    this row stays as history
 *  - writes `queriedAt`/`expiresAt` explicitly; TTL policy is the caller's,
 *    never invented here
 *  - never reaches the network, and stores no raw provider body
 *
 * @param {{id: number, claimToken: string, result: object,
 *   expiresAt?: Date|null}} input `expiresAt` omitted falls back to the
 *   result's own; an explicit null means "never fresh".
 * @param {{client?: object}} [options]
 */
async function completeClaimedJob(input, options = {}) {
  const client = resolveClient(options.client);
  if (!input || typeof input !== "object") {
    throw new IocEnrichmentValidationError("completeClaimedJob: input must be an object");
  }
  const id = assertValidId(input.id);
  const claimToken = assertValidClaimToken(input.claimToken);
  const { result } = input;

  const record = await client.iocEnrichment.findUnique({ where: { id } });
  if (!record) return { outcome: COMPLETION_OUTCOME.NOT_CLAIM_OWNER, record: null };

  // Validation runs before the guarded write, so an invalid result is a
  // thrown programmer error rather than a half-written row.
  assertResultMatchesRecord(result, record);
  const terminalFields = buildTerminalFields(result);
  const queriedAt = assertValidDate(result.queriedAt, "result.queriedAt");

  const expiresAt =
    input.expiresAt === undefined ? result.expiresAt ?? null : input.expiresAt;
  if (expiresAt !== null) assertValidDate(expiresAt, "expiresAt");

  const { count } = await client.iocEnrichment.updateMany({
    where: { id, status: ENRICHMENT_STATUS.PENDING, claimToken },
    data: {
      ...terminalFields,
      status: result.status,
      queriedAt,
      expiresAt,
      // Frees the cacheKey for a future attempt; this row remains as history.
      activeCacheKey: null,
      claimToken: null,
      leaseExpiresAt: null,
      // A terminal row is never re-attempted, so a leftover retry gate from a
      // previous failed attempt would be misleading history.
      nextAttemptAt: null,
    },
  });

  if (count === 0) return { outcome: COMPLETION_OUTCOME.NOT_CLAIM_OWNER, record: null };

  const completed = await client.iocEnrichment.findUnique({ where: { id } });
  return { outcome: COMPLETION_OUTCOME.COMPLETED, record: completed };
}

/**
 * Releases a lease WITHOUT recording a result — the narrow abandon path for a
 * worker that failed before it made any provider call, or hit an unexpected
 * internal error and has nothing truthful to persist. The job stays durably
 * PENDING; no terminal status is invented on the provider's behalf.
 *
 * `nextAttemptAt` is the retry gate the caller's policy decided
 * (enrichmentRetryPolicy.js). Omitting it releases the job as immediately
 * eligible — correct for a plain abandon, wrong for a repeatable failure,
 * which is exactly why the runner always passes one.
 *
 * `attemptCount` is NEVER reset. `refundAttempt` reverses exactly the single
 * increment this claim made, and is used only for caller cancellation, where
 * no processing attempt actually took place. It is safe under concurrency for
 * the same reason the rest of this statement is: the guard requires our claim
 * token, so no other worker can be mutating this row's attemptCount while we
 * still hold the lease.
 *
 * This packet ships no retry loop and no daemon: releasing simply returns the
 * job to the queue for whatever invokes a runner later.
 *
 * @param {{id: number, claimToken: string, nextAttemptAt?: Date|null,
 *   refundAttempt?: boolean}} input
 * @param {{client?: object}} [options]
 */
async function releaseClaimedJob(input, options = {}) {
  const client = resolveClient(options.client);
  if (!input || typeof input !== "object") {
    throw new IocEnrichmentValidationError("releaseClaimedJob: input must be an object");
  }
  const id = assertValidId(input.id);
  const claimToken = assertValidClaimToken(input.claimToken);
  const nextAttemptAt = input.nextAttemptAt === undefined ? null : input.nextAttemptAt;
  if (nextAttemptAt !== null) assertValidDate(nextAttemptAt, "nextAttemptAt");
  const refundAttempt = input.refundAttempt === true;

  const { count } = await client.iocEnrichment.updateMany({
    where: { id, status: ENRICHMENT_STATUS.PENDING, claimToken },
    data: {
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      nextAttemptAt,
      ...(refundAttempt ? { attemptCount: { decrement: 1 } } : {}),
    },
  });

  if (count === 0) return { outcome: RELEASE_OUTCOME.NOT_CLAIM_OWNER, record: null };

  const released = await client.iocEnrichment.findUnique({ where: { id } });
  return { outcome: RELEASE_OUTCOME.RELEASED, record: released };
}

/**
 * Retires a job this worker holds the lease on into DEAD_LETTER — the "we
 * have attempted this the agreed number of times and it fails the same way
 * every time" path.
 *
 * Guarantees, all mirroring completeClaimedJob:
 *  - requires the correct claim token; a wrong/stale one returns
 *    NOT_CLAIM_OWNER and changes nothing
 *  - cannot overwrite an already-terminal row (`status: PENDING` guard), so a
 *    real provider result is never buried by a late dead-letter
 *  - clears `activeCacheKey` (freeing the cacheKey for a future attempt) and
 *    every piece of lease/claim metadata
 *  - PRESERVES all previously stored normalized/provider evidence: this
 *    statement writes only lifecycle columns, so whatever diagnostic context
 *    a prior attempt recorded stays readable
 *  - stores only a closed `terminalReasonCode`; no exception content, no
 *    provider payload, no stack
 *
 * @param {{id: number, claimToken: string, reasonCode: string}} input
 * @param {{client?: object, now: Date}} options
 */
async function deadLetterClaimedJob(input, options = {}) {
  const client = resolveClient(options.client);
  if (!input || typeof input !== "object") {
    throw new IocEnrichmentValidationError("deadLetterClaimedJob: input must be an object");
  }
  const id = assertValidId(input.id);
  const claimToken = assertValidClaimToken(input.claimToken);
  const reasonCode = assertValidTerminalReasonCode(input.reasonCode);
  const now = assertValidDate(options.now, "now");

  const { count } = await client.iocEnrichment.updateMany({
    where: { id, status: ENRICHMENT_STATUS.PENDING, claimToken },
    data: {
      status: QUEUE_STATUS.DEAD_LETTER,
      deadLetteredAt: now,
      terminalReasonCode: reasonCode,
      activeCacheKey: null,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
    },
  });

  if (count === 0) return { outcome: DEAD_LETTER_OUTCOME.NOT_CLAIM_OWNER, record: null };

  const deadLettered = await client.iocEnrichment.findUnique({ where: { id } });
  return { outcome: DEAD_LETTER_OUTCOME.DEAD_LETTERED, record: deadLettered };
}

/**
 * Retires a PENDING job that has ALREADY spent its attempt budget, without
 * holding a claim on it — the sweep for a row stranded at its limit by an
 * earlier crashed worker, which would otherwise stay PENDING and unclaimable
 * forever (claimPendingJob refuses it, so no one can ever hold its token).
 *
 * Safe without a claim token because the guard is strictly narrower than
 * "some row": it requires the row to still be PENDING, to be at or over its
 * budget, and to have NO live lease. A job another worker is actively
 * processing therefore cannot be retired out from under it.
 *
 * @param {{id: number}} input
 * @param {{client?: object, now: Date, reasonCode?: string}} options
 */
async function deadLetterExhaustedJob(input, options = {}) {
  const client = resolveClient(options.client);
  if (!input || typeof input !== "object") {
    throw new IocEnrichmentValidationError("deadLetterExhaustedJob: input must be an object");
  }
  const id = assertValidId(input.id);
  const now = assertValidDate(options.now, "now");
  const reasonCode = assertValidTerminalReasonCode(
    options.reasonCode ?? ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_EXHAUSTED
  );

  const existing = await client.iocEnrichment.findUnique({ where: { id } });
  if (!existing || existing.status !== ENRICHMENT_STATUS.PENDING) {
    return { outcome: DEAD_LETTER_OUTCOME.NOT_CLAIM_OWNER, record: null };
  }
  const maxAttempts = Number.isInteger(existing.maxAttempts) ? existing.maxAttempts : 0;

  const { count } = await client.iocEnrichment.updateMany({
    where: {
      id,
      status: ENRICHMENT_STATUS.PENDING,
      attemptCount: { gte: maxAttempts },
      OR: [{ claimToken: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: {
      status: QUEUE_STATUS.DEAD_LETTER,
      deadLetteredAt: now,
      terminalReasonCode: reasonCode,
      activeCacheKey: null,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
    },
  });

  if (count === 0) return { outcome: DEAD_LETTER_OUTCOME.NOT_EXHAUSTED, record: null };

  const deadLettered = await client.iocEnrichment.findUnique({ where: { id } });
  return { outcome: DEAD_LETTER_OUTCOME.DEAD_LETTERED, record: deadLettered };
}

module.exports = {
  COMPLETION_OUTCOME,
  RELEASE_OUTCOME,
  DEAD_LETTER_OUTCOME,
  findFreshCachedResult,
  findActiveJobByCacheKey,
  createPendingJob,
  listPendingCandidates,
  claimPendingJob,
  claimPendingBatch,
  completeClaimedJob,
  releaseClaimedJob,
  deadLetterClaimedJob,
  deadLetterExhaustedJob,
};
