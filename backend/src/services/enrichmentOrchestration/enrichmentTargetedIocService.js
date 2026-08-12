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
// Only ONE of them is ever leased: the canonical row. Leasing both would give
// one unit of work two mutual-exclusion mechanisms, which can disagree.
// Because the ADMIN batch and this path contend on the SAME compare-and-swap
// for the same row, "no provider call is executed or charged twice across the
// two paths" is structural rather than conventional (D-P10A2-05).
//
// Consequences that follow from that, all deliberate:
//   * reconcileDelegatedJobs keeps working unchanged — it scans exactly the
//     state this path leaves the job in;
//   * a crashed targeted worker leaves no orphaned Phase-10 lease to recover.
//
// The Phase-10 job leaves WAITING_ON_DELEGATE only through reconciliation (the
// delegate reached a terminal state), a budget refusal, or ambiguity recovery.

const { QUOTA_LANES } = require("./enrichmentDecisionCodes");
const repository = require("./enrichmentOrchestrationRepository");
const quota = require("./enrichmentQuotaService");
const { runTargetedEnrichmentJob } = require("../enrichment/enrichmentRunner");
const { holdContactedJob } = require("../enrichment/iocEnrichmentRepository");

const OUTCOMES = quota.ATTEMPT_OUTCOMES;

// The runner's terminal IocEnrichment status -> the closed AttemptOutcome the
// Phase-10 ledger records for the same call.
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
 *   leaseMs: number, runtime: object, audit: Function}} input `job` must carry
 *   its linked `iocEnrichment`.
 */
async function executeTargetedJob(input) {
  const { prisma, job, nowFn, limit, leaseMs, runtime, audit } = input;

  // Carried out of the hooks so the code after the runner call can finalize
  // the ledger row the hooks created. The hooks run inside the runner, which
  // has no reason to know about Phase-10 accounting.
  let attempt = null;
  let refusal = null;

  const result = await runTargetedEnrichmentJob({
    prisma,
    providerRegistry: runtime.providerRegistry,
    now: nowFn(),
    ttlPolicy: runtime.ttlPolicy,
    retryPolicy: runtime.retryPolicy,
    leaseMs,
    // The ONLY input naming what may be touched. There is no listing here and
    // no widening: this id comes from the Phase-10 job's own delegate FK.
    enrichmentId: job.iocEnrichmentId,
    hooks: {
      // Runs after the claim is won and before any provider is resolved, so a
      // lost race leaks no budget and a refusal costs no provider call.
      async authorize() {
        const reservation = await quota.reserveProviderQuota({
          client: prisma,
          provider: job.provider,
          lane: job.lane,
          now: nowFn(),
          limit,
          lookupJobId: job.id,
          attemptNumber: job.attemptCount + 1,
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

      // Runs on the statement immediately preceding provider.lookup.
      async beforeLookup({ record }) {
        const now = nowFn();
        await quota.markAttemptInFlight(prisma, attempt.id, now);
        // The non-expiring hold. Placed BEFORE the request leaves, so even a
        // crash one instruction later cannot let anything reclaim this row.
        await holdContactedJob(
          { id: record.id, claimToken: record.claimToken, until: quota.CONTACT_SENTINEL },
          { client: prisma }
        );
        await audit("enrichment.lookup.contacted", {
          provider: job.provider,
          lane: job.lane,
          attemptNumber: attempt.attemptNumber,
          contactedProvider: true,
        });
      },
    },
  });

  const now = nowFn();

  // --- Refused before any call --------------------------------------------
  if (result.outcome === "REFUSED_BEFORE_LOOKUP") {
    // The Phase-10 job must not stay WAITING_ON_DELEGATE: nothing would ever
    // finish it and it would be re-selected on every tick forever. The
    // delegate row itself stays PENDING and the ADMIN batch may still process
    // it under its own policy — existing behaviour, stated rather than hidden.
    await repository.terminalizeDelegatedJob(prisma, {
      id: job.id,
      state: "SKIPPED_BUDGET",
      now,
    });
    await audit("enrichment.lookup.refused", {
      provider: job.provider,
      lane: job.lane,
      usageDate: refusal ? refusal.usageDate : null,
      reasonCode: refusal ? refusal.reasonCode : "REFUSED",
    });
    await refreshRuns(prisma, job.id, now);
    return { outcome: "SKIPPED_BUDGET", charged: false };
  }

  // --- Never claimed: another worker or the ADMIN batch owns it ------------
  if (result.outcome === "TARGET_NOT_CLAIMABLE" || result.outcome === "CLAIM_FAILED") {
    // Nothing reserved, nothing written, nobody called. The job stays
    // WAITING_ON_DELEGATE and reconciliation finishes it once the delegate
    // reaches a terminal state, whoever executed it.
    return { outcome: result.outcome, charged: false };
  }

  // --- A real terminal result ---------------------------------------------
  if (result.outcome === "COMPLETED" && attempt) {
    const outcome = TERMINAL_STATUS_TO_OUTCOME[result.terminalStatus] || OUTCOMES.TRANSPORT_ERROR;
    await quota.finalizeAttempt(prisma, attempt.id, { outcome, now });
    await audit("enrichment.lookup.finalized", {
      provider: job.provider,
      lane: job.lane,
      outcome,
      contactedProvider: true,
    });
    // The delegate row is now terminal, so reconciliation (which runs earlier
    // in the next tick, and again below for immediacy) copies that verdict
    // onto the Phase-10 job. This module never writes the job's terminal state
    // from its own knowledge — the delegate is the single source of truth.
    return { outcome: "COMPLETED", terminalStatus: result.terminalStatus, charged: true };
  }

  // --- Anything else: the claim was held but no terminal result exists -----
  // The runner already released or held the claim under its own policy. The
  // attempt stays unfinished and the stale sweep resolves it, checking the
  // delegate first so a result that DID land is never buried as ambiguous.
  return { outcome: result.outcome, charged: Boolean(attempt) };
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
  QUOTA_LANES,
  TERMINAL_STATUS_TO_OUTCOME,
  executeTargetedJob,
  refreshRuns,
};
