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
  // eslint-disable-next-line no-restricted-syntax
  for (const job of jobs) {
    const state = resolveDelegateState(job);
    // eslint-disable-next-line no-continue
    if (!state) continue;

    // eslint-disable-next-line no-await-in-loop
    await repository.updateJob(client, job.id, {
      state,
      completedAt: now,
      // Releasing activeLookupKey is what lets the NEXT ask for this subject
      // create fresh work. PostgreSQL treats multiple NULLs in a unique index
      // as distinct, so the terminal row stays as history without blocking.
      activeLookupKey: null,
    });
    reconciled += 1;
  }

  return { scanned: jobs.length, reconciled, stillWaiting: jobs.length - reconciled };
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  IOC_STATUS_TO_JOB_STATE,
  VULNERABILITY_STATUS_TO_JOB_STATE,
  resolveDelegateState,
  reconcileDelegatedJobs,
};
