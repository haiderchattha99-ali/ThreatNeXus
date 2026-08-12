"use strict";

// Phase 10A-2 — the quota ledger: atomic daily reservation and the
// ProviderLookupAttempt lifecycle.
//
// ===========================================================================
// RESERVATION AND LEDGER CREATION ARE ONE TRANSACTION
// ===========================================================================
// schema.prisma says the attempt "is created RESERVED inside the reservation
// transaction". That is not a stylistic note: if the usage increment commits
// and the attempt insert then fails or the process dies, quota is charged with
// NO ledger row to explain it — an unaccountable unit of real third-party
// budget, and a state no crash table can describe truthfully.
//
// So the guarded increment and the attempt insert are one interactive
// transaction. A refusal, or any failure of the insert (including the
// (lookupJobId, attemptNumber) unique), rolls the increment back.
//
// ---------------------------------------------------------------------------
// The reservation guard is a compare-and-swap, not raw SQL (D-P10A2-02)
// ---------------------------------------------------------------------------
// `updateMany` with `reservedCount: { lt: limit }` is the same mechanism
// claimPendingJob uses and iocEnrichmentRepository.js's header justifies: at
// READ COMMITTED PostgreSQL row-locks the target row for the duration of the
// UPDATE and re-evaluates the WHERE against the winner's committed row, so N
// concurrent workers against a limit of L produce exactly L grants. The
// persistence layer of this repository contains no raw SQL and this does not
// introduce the first.
//
// The guard always compares against the LIVE configured limit, never against
// the stored limitAtLastReservation, so a mid-day configuration change takes
// effect immediately — which is what that column's own schema comment
// requires. limitAtLastReservation is recorded as history, never as policy.
//
// ---------------------------------------------------------------------------
// There is no refund
// ---------------------------------------------------------------------------
// ProviderDailyUsage has no decrement, by design, which is why there is no
// refund race to defend against. Accounting is deliberately CONSERVATIVE: it
// may over-count a call that was reserved but never sent; it can never
// under-count a call that was sent. For a paid third-party budget that is the
// only safe direction, and ProviderLookupAttempt.contactedProvider keeps the
// ledger honest about which case a row is.

const { QUOTA_LANES } = require("./enrichmentDecisionCodes");

const PRISMA_UNIQUE_VIOLATION = "P2002";

// Non-expiring hold placed on a contacted IocEnrichment row (D-P10A2-07). A
// duration cannot express "held until somebody establishes what happened": if
// no worker runs for longer than the duration, the hold lapses and the ADMIN
// batch legitimately reclaims and re-calls the provider. This is cleared only
// by completeClaimedJob (a known terminal result) or by the ambiguity sweep
// driving the row terminal.
const CONTACT_SENTINEL = new Date("9999-12-31T00:00:00.000Z");

const RESERVATION_OUTCOME = Object.freeze({
  GRANTED: "GRANTED",
  REFUSED: "REFUSED",
});

const REFUSAL_REASONS = Object.freeze({
  BUDGET_ZERO: "BUDGET_ZERO",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
});

const ATTEMPT_STATES = Object.freeze({
  RESERVED: "RESERVED",
  IN_FLIGHT: "IN_FLIGHT",
  FINISHED: "FINISHED",
});

// The two non-terminal attempt states. Every finalization is guarded on this
// set, which is what makes finalization exactly-once: a second call matches
// zero rows rather than overwriting a recorded outcome.
const UNFINISHED_ATTEMPT_STATES = Object.freeze([
  ATTEMPT_STATES.RESERVED,
  ATTEMPT_STATES.IN_FLIGHT,
]);

const ATTEMPT_OUTCOMES = Object.freeze({
  SUCCESS: "SUCCESS",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  TRANSPORT_ERROR: "TRANSPORT_ERROR",
  SERVER_ERROR: "SERVER_ERROR",
  INVALID_KEY: "INVALID_KEY",
  PROVIDER_REJECTED: "PROVIDER_REJECTED",
  DISABLED: "DISABLED",
  UNSUPPORTED_SUBJECT: "UNSUPPORTED_SUBJECT",
  LOCAL_VALIDATION_ERROR: "LOCAL_VALIDATION_ERROR",
  ABANDONED: "ABANDONED",
});

class EnrichmentQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentQuotaError";
  }
}

// Thrown INSIDE the reservation transaction purely to roll it back. Never
// escapes this module: reserveProviderQuota catches it and reports REFUSED.
class QuotaRefusedSignal extends Error {
  constructor(reasonCode) {
    super("quota refused");
    this.name = "QuotaRefusedSignal";
    this.reasonCode = reasonCode;
  }
}

function assertValidDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new EnrichmentQuotaError(`${label} must be an explicit, valid Date`);
  }
  return value;
}

/**
 * The UTC calendar day an attempt reserves against — the day the call actually
 * happens, which is the only day a provider could attribute it to.
 *
 * Derived from an explicitly supplied instant, never from the wall clock, and
 * read FRESH per reservation rather than once per tick: a long sequential tick
 * can cross midnight, and a stale timestamp would charge later calls to the
 * previous day.
 *
 * @param {Date} now
 * @returns {Date} midnight UTC, matching the @db.Date column
 */
function utcUsageDate(now) {
  assertValidDate(now, "now");
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function assertValidLane(lane) {
  if (lane !== QUOTA_LANES.AUTOMATIC && lane !== QUOTA_LANES.MANUAL) {
    throw new EnrichmentQuotaError("lane must be AUTOMATIC or MANUAL");
  }
  return lane;
}

/**
 * Creates the (provider, usageDate, lane) bucket if it does not exist.
 *
 * Deliberately OUTSIDE any transaction. A unique violation from a concurrent
 * creator caught inside an open transaction leaves it aborted (25P02) on
 * PostgreSQL and every later statement in it fails opaquely — the same rule
 * enrichmentQueueService.js and enrichmentOrchestrationRepository.js document.
 * Here the loser simply converges on the winner's row.
 */
async function ensureUsageBucket(client, { provider, usageDate, lane }) {
  try {
    await client.providerDailyUsage.upsert({
      where: { provider_usageDate_lane: { provider, usageDate, lane } },
      create: { provider, usageDate, lane, reservedCount: 0 },
      update: {},
    });
  } catch (error) {
    // Another worker created it between our read and our write. That is the
    // outcome we wanted; anything else is a real failure.
    if (!error || error.code !== PRISMA_UNIQUE_VIOLATION) throw error;
  }
}

/**
 * Atomically reserves ONE unit of a provider's daily budget for one lane AND
 * creates the ProviderLookupAttempt that accounts for it, in one transaction.
 *
 * @param {{client: object, provider: string, lane: string, now: Date,
 *   limit: number|null, lookupJobId: number, attemptNumber: number}} input
 *   `limit` null means unlimited; 0 refuses without issuing any statement.
 * @returns {Promise<{outcome: string, attempt: object|null,
 *   usageDate: Date, reasonCode: string|null}>}
 */
async function reserveProviderQuota(input = {}) {
  const { client, provider, lane, now, limit, lookupJobId, attemptNumber } = input;
  if (!client) throw new EnrichmentQuotaError("reserveProviderQuota: client is required");
  if (typeof provider !== "string" || provider.trim() === "") {
    throw new EnrichmentQuotaError("reserveProviderQuota: provider must be a non-empty string");
  }
  assertValidLane(lane);
  assertValidDate(now, "now");
  if (!Number.isInteger(lookupJobId) || lookupJobId <= 0) {
    throw new EnrichmentQuotaError("reserveProviderQuota: lookupJobId must be a positive integer");
  }
  if (!Number.isInteger(attemptNumber) || attemptNumber <= 0) {
    throw new EnrichmentQuotaError("reserveProviderQuota: attemptNumber must be a positive integer");
  }
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
    throw new EnrichmentQuotaError("reserveProviderQuota: limit must be null or a non-negative integer");
  }

  const usageDate = utcUsageDate(now);

  // A zero budget is refused without touching the database at all. The router
  // already skips a known-zero budget at routing time, so reaching here means
  // the budget was lowered after the job was created — still a refusal, and
  // still not worth a write.
  if (limit === 0) {
    return {
      outcome: RESERVATION_OUTCOME.REFUSED,
      attempt: null,
      usageDate,
      reasonCode: REFUSAL_REASONS.BUDGET_ZERO,
    };
  }

  await ensureUsageBucket(client, { provider, usageDate, lane });

  const attemptData = {
    lookupJobId,
    provider,
    lane,
    attemptNumber,
    usageDate,
    state: ATTEMPT_STATES.RESERVED,
    // False at insert, and the ONLY thing that later distinguishes "we never
    // sent a request" from "we may have". Set true immediately before the call.
    contactedProvider: false,
    startedAt: now,
  };

  try {
    const attempt = await client.$transaction(async (tx) => {
      if (limit === null) {
        // Unlimited: still counted, so the usage API can report real activity.
        await tx.providerDailyUsage.update({
          where: { provider_usageDate_lane: { provider, usageDate, lane } },
          data: { reservedCount: { increment: 1 }, limitAtLastReservation: null },
        });
      } else {
        const { count } = await tx.providerDailyUsage.updateMany({
          where: { provider, usageDate, lane, reservedCount: { lt: limit } },
          data: { reservedCount: { increment: 1 }, limitAtLastReservation: limit },
        });
        // The live committed count already reached the limit. Throwing rolls
        // the transaction back, which is why no half-reservation can exist.
        if (count === 0) throw new QuotaRefusedSignal(REFUSAL_REASONS.BUDGET_EXHAUSTED);
      }

      // Same transaction as the increment. If this insert fails for any reason
      // — including the (lookupJobId, attemptNumber) unique that a duplicate
      // claim would violate — the increment is rolled back with it.
      return tx.providerLookupAttempt.create({ data: attemptData });
    });

    return {
      outcome: RESERVATION_OUTCOME.GRANTED,
      attempt,
      usageDate,
      reasonCode: null,
    };
  } catch (error) {
    if (error instanceof QuotaRefusedSignal) {
      return {
        outcome: RESERVATION_OUTCOME.REFUSED,
        attempt: null,
        usageDate,
        reasonCode: error.reasonCode,
      };
    }
    throw error;
  }
}

/**
 * Marks an attempt IN_FLIGHT immediately before the provider call.
 *
 * Guarded on `state: RESERVED` so it cannot resurrect a finalized attempt.
 * Setting contactedProvider here — BEFORE the call rather than after it — is
 * what makes a crash between reservation and fetch distinguishable from a
 * crash during one, and therefore what makes safe automatic retry decidable.
 *
 * @returns {Promise<boolean>} whether this call performed the transition
 */
async function markAttemptInFlight(client, attemptId, now) {
  assertValidDate(now, "now");
  const { count } = await client.providerLookupAttempt.updateMany({
    where: { id: attemptId, state: ATTEMPT_STATES.RESERVED },
    data: {
      state: ATTEMPT_STATES.IN_FLIGHT,
      fetchStartedAt: now,
      contactedProvider: true,
    },
  });
  return count === 1;
}

/**
 * Finalizes an attempt EXACTLY ONCE.
 *
 * The guard `state IN (RESERVED, IN_FLIGHT)` is the whole mechanism: the first
 * caller matches one row, every later caller matches zero and writes nothing.
 * `contactedProvider` is never touched here, so a sweep can preserve exactly
 * what was recorded before the process died.
 *
 * @returns {Promise<boolean>} true when THIS call finalized it
 */
async function finalizeAttempt(client, attemptId, { outcome, now, httpStatus, errorCode, retryAfterSeconds }) {
  assertValidDate(now, "now");
  if (!Object.prototype.hasOwnProperty.call(ATTEMPT_OUTCOMES, outcome)) {
    throw new EnrichmentQuotaError(`finalizeAttempt: unknown outcome ${JSON.stringify(outcome)}`);
  }
  const { count } = await client.providerLookupAttempt.updateMany({
    where: { id: attemptId, state: { in: [...UNFINISHED_ATTEMPT_STATES] } },
    data: {
      state: ATTEMPT_STATES.FINISHED,
      outcome,
      finishedAt: now,
      httpStatus: httpStatus ?? null,
      errorCode: errorCode ?? null,
      retryAfterSeconds: retryAfterSeconds ?? null,
    },
  });
  return count === 1;
}

/**
 * Unfinished attempts older than the stale threshold, newest-owner-first.
 *
 * Bounded, and index-served by @@index([state, startedAt]). The linked job is
 * included with its delegate, because resolving a targeted attempt requires
 * reading the delegate BEFORE deciding anything (see the worker's sweep: a
 * delegate that already reached a terminal state must roll its job forward,
 * not be swept as ambiguous, or a real provider answer is buried).
 */
async function listStaleAttempts(client, { staleBefore, take }) {
  assertValidDate(staleBefore, "staleBefore");
  return client.providerLookupAttempt.findMany({
    where: {
      state: { in: [...UNFINISHED_ATTEMPT_STATES] },
      startedAt: { lte: staleBefore },
    },
    orderBy: { startedAt: "asc" },
    take,
    include: { lookupJob: { include: { iocEnrichment: true } } },
  });
}

/**
 * Every usage row for one day, or all days. Read-only.
 */
async function listUsage(client, { usageDate }) {
  return client.providerDailyUsage.findMany({
    where: usageDate ? { usageDate } : {},
    orderBy: [{ usageDate: "desc" }, { provider: "asc" }, { lane: "asc" }],
  });
}

module.exports = {
  CONTACT_SENTINEL,
  RESERVATION_OUTCOME,
  REFUSAL_REASONS,
  ATTEMPT_STATES,
  UNFINISHED_ATTEMPT_STATES,
  ATTEMPT_OUTCOMES,
  EnrichmentQuotaError,
  utcUsageDate,
  ensureUsageBucket,
  reserveProviderQuota,
  markAttemptInFlight,
  finalizeAttempt,
  listStaleAttempts,
  listUsage,
};
