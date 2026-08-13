"use strict";

// Phase 10A-2 — targeted AbuseIPDB execution.
//
// ===========================================================================
// THE PHASE-10 JOB IS NEVER LEASED HERE
// ===========================================================================
// AbuseIPDB work is described by TWO rows: the canonical IocEnrichment row
// (which the pre-existing ADMIN batch claims through claimPendingJob) and the
// Phase-10 ProviderLookupJob that links it and waits in WAITING_ON_DELEGATE.
//
// Only ONE of them is ever leased: the canonical row. Because the ADMIN batch
// and this path contend on the SAME compare-and-swap for the same row, "no
// provider call is executed or charged twice across the two paths" is
// structural rather than conventional (D-P10A2-05).
//
// ---------------------------------------------------------------------------
// Ordering, and why every step of it is load-bearing
// ---------------------------------------------------------------------------
//   claim -> resolve provider -> check credential -> reserve quota+ledger
//         -> ATOMIC contact transition -> bounded lookup -> finalize
//
// Resolving the provider and checking its credential BEFORE the reservation is
// what stops an unconfigured deployment from spending a unit of real budget on
// a call that could never have been made: AbuseIPDB's own lookup() reports
// SKIPPED_DISABLED without a key, but only after it has been called.
//
// The contact transition is ONE transaction and its result is CHECKED. If the
// lease was lost while quota was being reserved, the guards match zero rows and
// somebody else may already be calling this provider — proceeding then would be
// the duplicate call this design exists to prevent.
//
// After contact, a failure is AMBIGUOUS and terminal. It is never handed to the
// ordinary retry policy, because that policy releases the claim, and releasing
// writes nextAttemptAt — which would clear the non-expiring contact hold and
// make the row claimable again.

const repository = require("./enrichmentOrchestrationRepository");
const quota = require("./enrichmentQuotaService");
const { runTargetedEnrichmentJob } = require("../enrichment/enrichmentRunner");
const { holdContactedJob } = require("../enrichment/iocEnrichmentRepository");
const { isProviderCredentialConfigured } = require("./enrichmentOrchestrationConfig");
const { JOB_STATES } = require("./enrichmentDecisionCodes");

const OUTCOMES = quota.ATTEMPT_OUTCOMES;

/**
 * The terminal delegate status -> the closed AttemptOutcome for the same call.
 *
 * FAILED is deliberately NOT a single outcome. It splits on evidence the
 * delegate row already stores, because "the provider refused our request",
 * "the provider broke" and "we never reached it" are three different facts:
 *
 *   errorCode PROVIDER_REJECTED -> PROVIDER_REJECTED   (non-auth 3xx/4xx)
 *   httpStatus >= 500           -> SERVER_ERROR
 *   otherwise                   -> TRANSPORT_ERROR
 */
function resolveTargetedOutcome(delegate) {
  const status = delegate ? delegate.status : null;
  switch (status) {
    case "SUCCESS":
      return OUTCOMES.SUCCESS;
    case "NOT_FOUND":
      return OUTCOMES.NOT_FOUND;
    case "RATE_LIMITED":
      return OUTCOMES.RATE_LIMITED;
    case "TIMEOUT":
      return OUTCOMES.TIMEOUT;
    case "INVALID_KEY":
      return OUTCOMES.INVALID_KEY;
    case "UNSUPPORTED_INDICATOR":
      return OUTCOMES.UNSUPPORTED_SUBJECT;
    case "SKIPPED_DISABLED":
      return OUTCOMES.DISABLED;
    case "FAILED":
      if (delegate.errorCode === "PROVIDER_REJECTED") return OUTCOMES.PROVIDER_REJECTED;
      if (Number.isInteger(delegate.httpStatus) && delegate.httpStatus >= 500) return OUTCOMES.SERVER_ERROR;
      return OUTCOMES.TRANSPORT_ERROR;
    default:
      return OUTCOMES.TRANSPORT_ERROR;
  }
}

// Kept for compatibility with the earlier export surface and its tests.
const TERMINAL_STATUS_TO_OUTCOME = Object.freeze({
  SUCCESS: OUTCOMES.SUCCESS,
  NOT_FOUND: OUTCOMES.NOT_FOUND,
  RATE_LIMITED: OUTCOMES.RATE_LIMITED,
  TIMEOUT: OUTCOMES.TIMEOUT,
  INVALID_KEY: OUTCOMES.INVALID_KEY,
  FAILED: OUTCOMES.TRANSPORT_ERROR,
  UNSUPPORTED_INDICATOR: OUTCOMES.UNSUPPORTED_SUBJECT,
  SKIPPED_DISABLED: OUTCOMES.DISABLED,
});

/**
 * Executes ONE targeted AbuseIPDB job.
 *
 * @param {{prisma: object, job: object, nowFn: Function, limit: number|null,
 *   leaseMs: number, lookupMaxMs: number, runtime: object, appConfig: object,
 *   audit: Function}} input `job` must carry its linked `iocEnrichment`.
 */
async function executeTargetedJob(input) {
  const { prisma, job, nowFn, limit, leaseMs, lookupMaxMs, runtime, appConfig, audit } = input;

  let attempt = null;
  let refusal = null;

  const result = await runTargetedEnrichmentJob({
    prisma,
    providerRegistry: runtime.providerRegistry,
    now: nowFn(),
    ttlPolicy: runtime.ttlPolicy,
    leaseMs,
    lookupMaxMs,
    // The ONLY input naming what may be touched. No listing, no widening:
    // this id comes from the Phase-10 job's own delegate foreign key.
    enrichmentId: job.iocEnrichmentId,
    hooks: {
      // Side-effect-free, and BEFORE any reservation.
      async resolveDescriptor() {
        return { ok: isProviderCredentialConfigured(job.provider, appConfig) };
      },

      async authorize({ record }) {
        const reservation = await quota.reserveProviderQuota({
          client: prisma,
          provider: job.provider,
          lane: job.lane,
          now: nowFn(),
          limit,
          lookupJobId: job.id,
          // The CLAIMED canonical row's post-increment attemptCount, not a
          // constant derived from the Phase-10 job — which is never leased and
          // never incremented, so it would make every attempt number 1 and
          // collide with the (lookupJobId, attemptNumber) unique on any retry.
          attemptNumber: record.attemptCount,
        });
        if (reservation.outcome === quota.RESERVATION_OUTCOME.REFUSED) {
          refusal = reservation;
          return { proceed: false, reasonCode: reservation.reasonCode };
        }
        attempt = reservation.attempt;
        await audit("enrichment.lookup.charged", {
          provider: job.provider,
          lane: job.lane,
          usageDate: reservation.usageDate,
          attemptNumber: attempt.attemptNumber,
        });
        return { proceed: true };
      },

      // ONE transaction, and its success is REPORTED rather than assumed.
      async beforeLookup({ record, claimToken }) {
        const now = nowFn();
        const ok = await prisma.$transaction(async (tx) => {
          const marked = await tx.providerLookupAttempt.updateMany({
            where: { id: attempt.id, state: quota.ATTEMPT_STATES.RESERVED },
            data: { state: quota.ATTEMPT_STATES.IN_FLIGHT, fetchStartedAt: now, contactedProvider: true },
          });
          if (marked.count !== 1) return false;
          const held = await tx.iocEnrichment.updateMany({
            where: { id: record.id, status: "PENDING", claimToken },
            data: { nextAttemptAt: quota.CONTACT_SENTINEL },
          });
          // Both or neither. A marked attempt without the hold would leave the
          // row reclaimable while a request is in flight.
          if (held.count !== 1) throw new Error("contact transition lost");
          return true;
        }).catch(() => false);

        if (ok) {
          await audit("enrichment.lookup.contacted", {
            provider: job.provider,
            lane: job.lane,
            attemptNumber: attempt.attemptNumber,
            contactedProvider: true,
          });
        }
        return ok;
      },
    },
  });

  const now = nowFn();

  // --- Refused or unconfigured before any call -----------------------------
  if (
    result.outcome === "REFUSED_BEFORE_LOOKUP" ||
    result.outcome === "NOT_CONFIGURED_BEFORE_LOOKUP" ||
    result.outcome === "UNKNOWN_PROVIDER"
  ) {
    const state =
      result.outcome === "REFUSED_BEFORE_LOOKUP" ? JOB_STATES.SKIPPED_BUDGET : JOB_STATES.SKIPPED_NOT_CONFIGURED;
    // The Phase-10 job must not stay WAITING_ON_DELEGATE: nothing would ever
    // finish it and it would be re-selected on every tick forever. No
    // queriedAt is written, so the API reports contacted:false truthfully.
    await repository.terminalizeDelegatedJob(prisma, { id: job.id, state, now });
    await audit(
      result.outcome === "REFUSED_BEFORE_LOOKUP" ? "enrichment.lookup.refused" : "enrichment.job.terminalized",
      {
        provider: job.provider,
        lane: job.lane,
        state,
        reasonCode: refusal ? refusal.reasonCode : result.outcome,
      }
    );
    await refreshRuns(prisma, job.id, now);
    return { outcome: state, charged: false };
  }

  // --- Never claimed, or the lease was lost before contact -----------------
  if (
    result.outcome === "TARGET_NOT_CLAIMABLE" ||
    result.outcome === "CLAIM_FAILED" ||
    result.outcome === "CONTACT_TRANSITION_LOST"
  ) {
    // Nobody was called by US. The job stays WAITING_ON_DELEGATE and
    // reconciliation finishes it once the delegate reaches a terminal state,
    // whoever executed it.
    return { outcome: result.outcome, charged: Boolean(attempt) };
  }

  // --- Ambiguous: the request was sent and no durable answer followed ------
  if (result.outcome === "AMBIGUOUS_AFTER_CONTACT") {
    if (attempt) {
      await quota.finalizeAttempt(prisma, attempt.id, { outcome: OUTCOMES.ABANDONED, now });
    }
    await repository.terminalizeDelegatedJob(prisma, {
      id: job.id,
      state: JOB_STATES.DEAD_LETTER,
      now,
      terminalReasonCode: "AMBIGUOUS_AFTER_CONTACT",
    });
    // The canonical row is terminalized by the RUNNER, which is the only place
    // that holds its claim token. It cannot be done from here: an unleased
    // dead-letter requires no live lease, and this row's lease is still held —
    // so that guard would match nothing and leave the row PENDING forever,
    // frozen by its contact hold and blocking every future ask about this
    // subject. A terminal row, by contrast, can never be claimed again, which
    // is what actually closes the duplicate-call window.
    await audit("enrichment.lookup.ambiguous", {
      provider: job.provider,
      lane: job.lane,
      attemptNumber: attempt ? attempt.attemptNumber : null,
      contactedProvider: true,
    });
    await refreshRuns(prisma, job.id, now);
    return { outcome: "AMBIGUOUS", charged: Boolean(attempt) };
  }

  // --- A real terminal result ---------------------------------------------
  if (result.outcome === "COMPLETED") {
    // Read the DELEGATE's durable row: it, not this process's local view, is
    // the source of truth for what the provider actually answered.
    const delegate = await prisma.iocEnrichment.findUnique({ where: { id: job.iocEnrichmentId } });
    const outcome = resolveTargetedOutcome(delegate);

    if (attempt) {
      await quota.finalizeAttempt(prisma, attempt.id, {
        outcome,
        now,
        httpStatus: delegate ? delegate.httpStatus : null,
        errorCode: delegate ? delegate.errorCode : null,
        retryAfterSeconds: delegate ? delegate.retryAfterSeconds : null,
      });
    }
    await audit("enrichment.lookup.finalized", {
      provider: job.provider,
      lane: job.lane,
      outcome,
      httpStatus: delegate ? delegate.httpStatus : null,
      errorCode: delegate ? delegate.errorCode : null,
      contactedProvider: true,
    });

    // Reconciliation copies the delegate's verdict onto the Phase-10 job,
    // carrying its queriedAt so the public `contacted` field is truthful.
    // eslint-disable-next-line global-require
    const { reconcileDelegatedJobs } = require("./enrichmentReconciliationService");
    await reconcileDelegatedJobs({ client: prisma, now, batchSize: 25 });

    // The Risk v1 boundary the ADMIN path already uses. Without it a
    // successful targeted lookup changes the reputation evidence while the
    // stored score keeps describing the previous one.
    if (delegate && delegate.status === "SUCCESS") {
      await recalculateRiskSafely(prisma, delegate.indicator, now);
    }

    await refreshRuns(prisma, job.id, now);
    return { outcome: "COMPLETED", terminalStatus: delegate ? delegate.status : null, charged: Boolean(attempt) };
  }

  return { outcome: result.outcome, charged: Boolean(attempt) };
}

/**
 * Rescoring is isolated exactly as enrichmentExecutionService isolates it: a
 * risk failure must never alter or invalidate the enrichment result that was
 * just durably written.
 */
async function recalculateRiskSafely(prisma, indicator, now) {
  try {
    if (typeof indicator !== "string" || indicator === "") return;
    const findings = await prisma.finding.findMany({
      where: { indicatorValue: indicator },
      select: { id: true },
    });
    if (findings.length === 0) return;
    // eslint-disable-next-line global-require
    const { recalculateAfterEnrichment } = require("../risk/riskRecalculationService");
    await recalculateAfterEnrichment({
      findingIds: findings.map((row) => row.id),
      asOf: now,
      client: prisma,
      auditContext: { actorUserId: null, actorEmail: null, actorRole: null },
    });
  } catch (error) {
    console.error("Targeted enrichment risk recalculation failed", { name: error && error.name });
  }
}

async function refreshRuns(prisma, jobId, now) {
  // eslint-disable-next-line global-require
  const { refreshRunState } = require("./enrichmentRunService");
  const runIds = await repository.listRunIdsForJob(prisma, jobId);
  // eslint-disable-next-line no-restricted-syntax
  for (const runId of runIds) {
    // eslint-disable-next-line no-await-in-loop
    await refreshRunState(prisma, runId, now);
  }
  return runIds.length;
}

module.exports = {
  TERMINAL_STATUS_TO_OUTCOME,
  resolveTargetedOutcome,
  executeTargetedJob,
  recalculateRiskSafely,
  refreshRuns,
};
