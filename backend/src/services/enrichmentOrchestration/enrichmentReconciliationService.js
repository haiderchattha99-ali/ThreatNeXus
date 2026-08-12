"use strict";

// Phase 10A-1 — delegate reconciliation.
//
// ===========================================================================
// CALLABLE, BUT DELIBERATELY NOT SCHEDULED
// ===========================================================================
// Nothing in this milestone invokes this module: no worker, no cron, no
// interval, no app-startup hook. It exists so the delegate contract is
// implemented and PROVEN by tests before 10A-2 turns a worker on, and so that
// an operator or a test can run one bounded pass explicitly.
//
// It performs NO provider call. It only reads a delegate row that some other,
// pre-existing pipeline (the IOC batch runner, the ADMIN vulnerability batch)
// already drove to a terminal state, and copies that verdict onto the Phase-10
// job that was waiting on it.
//
// ---------------------------------------------------------------------------
// There is no timeout that forces a waiting job terminal
// ---------------------------------------------------------------------------
// If the delegate has not finished, "the delegate has not finished" is the
// truth and the job stays WAITING_ON_DELEGATE. Inventing FAILED after some
// interval would be fabricating an outcome no provider ever gave.

const { JOB_STATES } = require("./enrichmentDecisionCodes");
const repository = require("./enrichmentOrchestrationRepository");
// Re-deriving a run's state from its items after a job goes terminal. Imported
// lazily inside the function that needs it: enrichmentRunService requires
// config/env at call time, and a module-scope import would make every pure
// unit test of this file depend on a fully configured environment.
function refreshRunState(client, runId, now) {
  // eslint-disable-next-line global-require
  return require("./enrichmentRunService").refreshRunState(client, runId, now);
}

// A reconciliation pass is bounded. An unbounded scan would load an arbitrary
// number of rows into memory and would make the pass's cost depend on table
// size rather than on outstanding work.
const DEFAULT_BATCH_SIZE = 100;

// IocEnrichment terminal statuses mapped onto the Phase-10 job vocabulary.
// SUCCESS and NOT_FOUND are both real answers; the rest are failures or
// refusals. RATE_LIMITED is absent on purpose — it is an ATTEMPT outcome the
// delegate's own retry policy handles, so a rate-limited delegate is still
// working and must not be copied over as terminal.
const IOC_STATUS_TO_JOB_STATE = Object.freeze({
  SUCCESS: JOB_STATES.SUCCEEDED,
  NOT_FOUND: JOB_STATES.NO_RECORD,
  INVALID_KEY: JOB_STATES.FAILED,
  TIMEOUT: JOB_STATES.FAILED,
  FAILED: JOB_STATES.FAILED,
  UNSUPPORTED_INDICATOR: JOB_STATES.SKIPPED_UNSUPPORTED_SUBJECT,
  SKIPPED_DISABLED: JOB_STATES.SKIPPED_DISABLED,
  // ---- Added in Phase 10A-2 (D-P10A2-08) ---------------------------------
  // Both of these were MISSING, and their absence was a real defect, not a
  // simplification. The original comment claimed a RATE_LIMITED delegate is
  // "still working" — that is false against the code: TERMINAL_STATUSES is
  // every status except PENDING (iocEnrichmentCacheRules.js:57), and
  // resolveEnrichmentRetry COMPLETEs a rate-limited result as terminal
  // evidence. So the delegate is finished and this map returned null forever,
  // pinning the Phase-10 job in WAITING_ON_DELEGATE and holding its
  // activeLookupKey — which permanently blocks every FUTURE ask about that
  // subject. DEAD_LETTER had the same hole.
  //
  // RATE_LIMITED maps to FAILED because ProviderLookupJobState deliberately
  // carries no RATE_LIMITED value and the honest meaning is "we have no
  // answer" — never NO_RECORD, which would read as "nothing found".
  RATE_LIMITED: JOB_STATES.FAILED,
  // A processing failure, never evidence that an indicator is clean.
  DEAD_LETTER: JOB_STATES.DEAD_LETTER,
});

// VulnerabilityJobStatus is a three-value enum. COMPLETED means the ADMIN
// batch finished the CVE; DEAD_LETTER is a PROCESSING failure and is never
// evidence that a CVE is not exploited — it maps to DEAD_LETTER, not NO_RECORD.
const VULNERABILITY_STATUS_TO_JOB_STATE = Object.freeze({
  COMPLETED: JOB_STATES.SUCCEEDED,
  DEAD_LETTER: JOB_STATES.DEAD_LETTER,
});

/**
 * Resolves the terminal state a waiting job should adopt, or null when its
 * delegate is still working (or absent).
 *
 * Pure — exported so the mapping table is testable without a database.
 *
 * @param {object} job a ProviderLookupJob with its delegate included
 * @returns {string|null}
 */
function resolveDelegateState(job) {
  if (job.provider === "abuseipdb" && job.iocEnrichment) {
    return IOC_STATUS_TO_JOB_STATE[job.iocEnrichment.status] || null;
  }
  if (job.provider === "nvd" && job.vulnerabilityEnrichmentJob) {
    return VULNERABILITY_STATUS_TO_JOB_STATE[job.vulnerabilityEnrichmentJob.status] || null;
  }
  return null;
}

/**
 * Runs ONE bounded reconciliation pass over WAITING_ON_DELEGATE jobs.
 *
 * @param {{client: object, now: Date, batchSize?: number}} options `now` is the
 *   caller's single explicit evaluation time — this module never reads the
 *   wall clock.
 * @returns {Promise<{scanned: number, reconciled: number, stillWaiting: number}>}
 */
async function reconcileDelegatedJobs(options = {}) {
  const { client, now } = options;
  if (!client) throw new TypeError("reconcileDelegatedJobs: client is required");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("reconcileDelegatedJobs: now must be an explicit, valid Date");
  }
  const batchSize = Number.isInteger(options.batchSize) ? options.batchSize : DEFAULT_BATCH_SIZE;

  const jobs = await repository.listJobsInState(client, {
    state: JOB_STATES.WAITING_ON_DELEGATE,
    take: batchSize,
  });

  let reconciled = 0;
  const refreshedRunIds = new Set();
  // eslint-disable-next-line no-restricted-syntax
  for (const job of jobs) {
    const state = resolveDelegateState(job);
    // eslint-disable-next-line no-continue
    if (!state) continue;

    // GUARDED transition (Phase 10A-2). The previous unguarded `updateJob`
    // would happily overwrite a job another process had already moved on;
    // this matches zero rows and reports nothing reconciled instead.
    //
    // Releasing activeLookupKey is what lets the NEXT ask for this subject
    // create fresh work. PostgreSQL treats multiple NULLs in a unique index
    // as distinct, so the terminal row stays as history without blocking.
    // eslint-disable-next-line no-await-in-loop
    const transitioned = await repository.terminalizeDelegatedJob(client, {
      id: job.id,
      state,
      now,
    });
    // eslint-disable-next-line no-continue
    if (!transitioned) continue;
    reconciled += 1;

    // A job going terminal changes what every run holding an item on it can
    // truthfully report. A shared job may belong to many runs, and leaving any
    // of them PENDING would misstate what is known. Previously nothing
    // refreshed run state here at all, so even a successful delegate left its
    // runs stale forever.
    // eslint-disable-next-line no-await-in-loop
    const runIds = await repository.listRunIdsForJob(client, job.id);
    // eslint-disable-next-line no-restricted-syntax
    for (const runId of runIds) {
      // eslint-disable-next-line no-await-in-loop
      await refreshRunState(client, runId, now);
      refreshedRunIds.add(runId);
    }
  }

  return {
    scanned: jobs.length,
    reconciled,
    stillWaiting: jobs.length - reconciled,
    runsRefreshed: refreshedRunIds.size,
  };
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  IOC_STATUS_TO_JOB_STATE,
  VULNERABILITY_STATUS_TO_JOB_STATE,
  resolveDelegateState,
  reconcileDelegatedJobs,
};
