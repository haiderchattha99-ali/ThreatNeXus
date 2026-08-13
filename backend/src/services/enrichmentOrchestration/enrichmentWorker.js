"use strict";

// Phase 10A-2 — the enrichment worker.
//
// ===========================================================================
// IMPORTING THIS MODULE STARTS NOTHING
// ===========================================================================
// No timer is created, no poll is issued and no provider is constructed until
// startEnrichmentWorker() is called — and server.js only calls it when
// ENRICHMENT_WORKER_ENABLED is true. A disabled deployment therefore has no
// worker object in memory at all, which is what makes the default-off claim
// assertable by inspecting the process rather than by trusting a branch.
//
// ---------------------------------------------------------------------------
// The tick order is deliberate, not incidental
// ---------------------------------------------------------------------------
//   1. stale-claim recovery      return abandoned direct leases to the queue
//   2. delegate reconciliation   BEFORE the sweep, so a delegate that already
//                                reached a terminal state rolls its job
//                                FORWARD instead of being swept as ambiguous
//   3. stale-attempt sweep       resolve attempts whose worker is gone
//   4. exhausted retirement      retire direct rows that have spent their
//                                attempt budget, so they cannot occupy the
//                                bounded scan that eligible work needs
//   5. run-state reconciliation  runs whose jobs all went terminal on a path
//                                that had no run context of its own
//   6. direct pass               up to batchSize SUCCESSFUL claims
//   7. targeted pass             same, over linked AbuseIPDB delegates
//
// Step 2 before step 3 is a correctness requirement. Reversed, a crash between
// the delegate's terminal write and the Phase-10 attempt's finalization would
// let the sweep dead-letter a job whose provider answer is already on disk.
//
// Ticks never overlap: the next one is scheduled with setTimeout AFTER the
// previous settles, never with setInterval. One provider call is in flight per
// worker process; throughput scales by running more processes, which the
// database-backed claim already makes safe.

const os = require("node:os");
const crypto = require("node:crypto");

const { JOB_STATES } = require("./enrichmentDecisionCodes");
const repository = require("./enrichmentOrchestrationRepository");
const quota = require("./enrichmentQuotaService");
const directExecution = require("./enrichmentDirectExecutionService");
const targetedExecution = require("./enrichmentTargetedIocService");
const { reconcileDelegatedJobs } = require("./enrichmentReconciliationService");
const { deadLetterUnleasedJob } = require("../enrichment/iocEnrichmentRepository");
const { buildEnrichmentRuntime } = require("../enrichment/enrichmentRuntime");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const AUDIT_ENTITY_TYPE = "ProviderLookupJob";

// A worker that hunts more than this before giving up would turn one tick into
// an unbounded scan. Five pages of batchSize is enough to step past a head of
// unclaimable rows without ever becoming a full-table walk.
const MAX_SCAN_MULTIPLIER = 5;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every audit payload this module writes is an ALLOW-LIST — named fields only.
 * A provider key, a raw body, a header, an exception message, a claim token or
 * any identity hash has no path through here even if a caller supplies one.
 */
function buildAuditor(prisma, workerId) {
  return async function audit(action, payload, outcome = AUDIT_OUTCOMES.SUCCESS) {
    try {
      await safeLogAuditEvent(
        {
          actorUserId: null,
          actorEmail: null,
          actorRole: null,
          action,
          outcome,
          entityType: AUDIT_ENTITY_TYPE,
          after: { workerId, ...payload },
          reason: action,
        },
        { client: prisma }
      );
    } catch (error) {
      // An audit failure must never propagate into the operation it describes.
      console.error("Enrichment worker audit failed", { name: error && error.name });
    }
  };
}

/**
 * Returns abandoned direct leases to the queue — but ONLY when it is safe.
 *
 * The lease alone cannot decide that. An attempt that already reached the
 * provider must never be requeued, however long ago its worker died, so the
 * owning attempt is consulted and a contacted one is left for the ambiguity
 * sweep instead.
 */
async function recoverStaleClaims({ prisma, now, take, audit }) {
  const jobs = await repository.listExpiredDirectLeases(prisma, { asOf: now, take });
  let recovered = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const job of jobs) {
    const latest = job.attempts && job.attempts[0];
    if (latest && latest.contactedProvider === true) {
      // A contacted attempt is NEVER requeued, whatever state it is in.
      //
      // Unfinished, the ambiguity sweep owns it. FINISHED beside a job still
      // holding its lease means the post-call transaction's job transition was
      // lost — a crash in the one window the atomic writes cannot cover, since
      // the attempt row proves the provider was already asked. Requeuing here
      // would buy the same answer twice. Nothing else would ever resolve such a
      // job either: the sweep only looks at UNFINISHED attempts, so it would
      // hold its lease and activeLookupKey forever. Terminalize it instead.
      if (latest.state === quota.ATTEMPT_STATES.FINISHED) {
        // eslint-disable-next-line no-await-in-loop
        const { count } = await prisma.providerLookupJob.updateMany({
          where: { id: job.id, state: JOB_STATES.LEASED, claimToken: job.claimToken },
          data: {
            state: JOB_STATES.DEAD_LETTER,
            completedAt: now,
            deadLetteredAt: now,
            terminalReasonCode: "AMBIGUOUS_AFTER_CONTACT",
            activeLookupKey: null,
            claimToken: null,
            claimedAt: null,
            leaseExpiresAt: null,
          },
        });
        if (count === 1) {
          // eslint-disable-next-line no-await-in-loop
          await audit("enrichment.lookup.ambiguous", {
            provider: job.provider,
            attemptNumber: latest.attemptNumber,
            contactedProvider: true,
          });
          // eslint-disable-next-line no-await-in-loop
          await targetedExecution.refreshRuns(prisma, job.id, now);
        }
      }
      continue; // eslint-disable-line no-continue
    }

    const exhausted = job.attemptCount >= job.maxAttempts;
    // eslint-disable-next-line no-await-in-loop
    const released = await repository.releaseExpiredDirectLease(prisma, {
      id: job.id,
      claimToken: job.claimToken,
      exhausted,
      now,
    });
    if (!released) continue; // eslint-disable-line no-continue
    recovered += 1;
    // eslint-disable-next-line no-await-in-loop
    await audit("enrichment.job.recovered", {
      provider: job.provider,
      reasonCode: exhausted ? "MAX_ATTEMPTS_EXHAUSTED" : "LEASE_EXPIRED",
    });
  }
  return recovered;
}

/**
 * Resolves attempts whose worker is gone.
 *
 * The delegate is checked FIRST for a targeted attempt. completeClaimedJob
 * writes the delegate's terminal result independently of the Phase-10 ledger,
 * so a crash in between leaves a genuinely SUCCESSFUL delegate beside an
 * IN_FLIGHT attempt. Sweeping that as ambiguous would bury a real provider
 * answer under DEAD_LETTER — inventing "we do not know" when the row on disk
 * knows exactly.
 */
async function sweepStaleAttempts({ prisma, now, staleBefore, take, audit }) {
  const attempts = await quota.listStaleAttempts(prisma, { staleBefore, take });
  let swept = 0;
  let ambiguous = 0;

  // eslint-disable-next-line no-restricted-syntax
  for (const attempt of attempts) {
    const job = attempt.lookupJob;
    const delegate = job ? job.iocEnrichment : null;
    const delegateTerminal = delegate && delegate.status !== "PENDING";

    if (delegateTerminal) {
      // Forward recovery: finalize from the durable provider-derived result.
      const outcome =
        targetedExecution.TERMINAL_STATUS_TO_OUTCOME[delegate.status] || quota.ATTEMPT_OUTCOMES.TRANSPORT_ERROR;
      // eslint-disable-next-line no-await-in-loop
      await quota.finalizeAttempt(prisma, attempt.id, { outcome, now });
      swept += 1;
      continue; // eslint-disable-line no-continue
    }

    if (attempt.contactedProvider !== true) {
      // Died between reservation and the call: no request reached the
      // provider, so the job is safely re-queued by stale-claim recovery and
      // the attempt can be finalized on its own.
      // eslint-disable-next-line no-await-in-loop
      await quota.finalizeAttempt(prisma, attempt.id, { outcome: quota.ATTEMPT_OUTCOMES.ABANDONED, now });
      swept += 1;
      continue; // eslint-disable-line no-continue
    }

    // Ambiguous. Terminal, and never retried.
    //
    // ONE transaction. Finalizing the attempt first and terminalizing the job
    // afterwards leaves a crash window in which a FINISHED attempt sits beside
    // a still-LEASED job — the exact state that would let recovery requeue a
    // question the provider has already been asked and charged for.
    // eslint-disable-next-line no-await-in-loop
    const contained = await prisma
      .$transaction(async (tx) => {
        const finalized = await quota.finalizeAttempt(tx, attempt.id, {
          outcome: quota.ATTEMPT_OUTCOMES.ABANDONED,
          now,
        });
        if (!finalized) return false;
        if (job && job.trigger === "RUN_DELEGATED") {
          return repository.terminalizeDelegatedJob(tx, {
            id: job.id,
            state: JOB_STATES.DEAD_LETTER,
            now,
            terminalReasonCode: "AMBIGUOUS_AFTER_CONTACT",
          });
        }
        if (job) {
          const { count } = await tx.providerLookupJob.updateMany({
            where: { id: job.id, state: JOB_STATES.LEASED },
            data: {
              state: JOB_STATES.DEAD_LETTER,
              completedAt: now,
              deadLetteredAt: now,
              terminalReasonCode: "AMBIGUOUS_AFTER_CONTACT",
              activeLookupKey: null,
              claimToken: null,
              claimedAt: null,
              leaseExpiresAt: null,
            },
          });
          return count === 1;
        }
        // An attempt with no job left to terminalize: finalizing it is the
        // whole of the work, and it committed.
        return true;
      })
      // A guard that matched nothing rolls the whole thing back. The attempt
      // stays unfinished and the next tick sweeps it again — idempotent, and
      // it never invents a terminal state it could not prove.
      .catch(() => false);

    if (!contained) continue; // eslint-disable-line no-continue
    swept += 1;
    ambiguous += 1;

    if (job && job.trigger === "RUN_DELEGATED" && delegate) {
      // Close the duplicate-call window for good: the contact hold is
      // non-expiring, and only a terminal row can never be claimed again.
      // Outside the transaction deliberately — if this write is lost the hold
      // still stands, so the row remains unclaimable either way.
      // eslint-disable-next-line no-await-in-loop
      await deadLetterUnleasedJob(
        { id: delegate.id, reasonCode: "AMBIGUOUS_AFTER_CONTACT" },
        { client: prisma, now }
      );
    }

    // eslint-disable-next-line no-await-in-loop
    await audit("enrichment.lookup.ambiguous", {
      provider: attempt.provider,
      lane: attempt.lane,
      attemptNumber: attempt.attemptNumber,
      contactedProvider: true,
    });
    // A job driven terminal here has no run context of its own to refresh, so
    // without this its owning runs report PENDING forever.
    if (job) {
      // eslint-disable-next-line no-await-in-loop
      await targetedExecution.refreshRuns(prisma, job.id, now);
    }
  }

  return { swept, ambiguous };
}

/**
 * Retires direct jobs that have spent their attempt budget.
 *
 * They are excluded from the candidate query on purpose — claimLookupJob would
 * refuse them anyway, so leaving them in it burns bounded scan windows on rows
 * that can never be claimed, and enough of them at the head of the queue
 * starves every eligible job behind them forever. Excluding them alone would
 * strand them non-terminal, still holding activeLookupKey, so this pass is the
 * other half of that fix rather than an optional tidy-up.
 *
 * Bounded like every other pass: a backlog is worked off over several ticks,
 * never in one unbounded walk.
 */
async function retireExhaustedDirectJobs({ prisma, now, take, audit }) {
  const jobs = await repository.listExhaustedDirectJobs(prisma, { asOf: now, take });
  let retired = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const job of jobs) {
    // eslint-disable-next-line no-await-in-loop
    const done = await repository.retireExhaustedDirectJob(prisma, { id: job.id, now });
    // Lost to another worker between the scan and the write.
    if (!done) continue; // eslint-disable-line no-continue
    retired += 1;
    // eslint-disable-next-line no-await-in-loop
    await audit("enrichment.job.terminalized", {
      provider: job.provider,
      state: JOB_STATES.DEAD_LETTER,
      terminalReasonCode: "MAX_ATTEMPTS_EXHAUSTED",
    });
    // eslint-disable-next-line no-await-in-loop
    await targetedExecution.refreshRuns(prisma, job.id, now);
  }
  return retired;
}

/**
 * Settles runs whose every job is terminal but whose own state is not.
 *
 * Each terminalization path refreshes the runs it knows about, but some paths
 * have no run context at all — an attempt swept by a worker that never saw the
 * run, a row retired by the pass above, a job terminalized by an earlier
 * crash. Without a general pass those runs report PENDING forever while all of
 * their work has finished. Idempotent: a run already terminal is not selected.
 */
async function reconcileRunStates({ prisma, now, take }) {
  // eslint-disable-next-line global-require
  const { refreshRunState } = require("./enrichmentRunService");
  const runs = await repository.listStaleNonTerminalRuns(prisma, { take });
  let refreshed = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const run of runs) {
    // eslint-disable-next-line no-await-in-loop
    await refreshRunState(prisma, run.id, now);
    refreshed += 1;
  }
  return refreshed;
}

/** One bounded direct pass, counted in SUCCESSFUL claims. */
async function runDirectPass({ prisma, nowFn, batchSize, leaseMs, lookupMaxMs, appConfig, fetchImpl, audit }) {
  const candidates = await repository.listDirectCandidates(prisma, {
    providers: directExecution.DIRECT_PROVIDER_NAMES,
    asOf: nowFn(),
    take: batchSize * MAX_SCAN_MULTIPLIER,
  });

  let claimed = 0;
  let completed = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const candidate of candidates) {
    if (claimed >= batchSize) break;
    // eslint-disable-next-line no-await-in-loop
    const claim = await repository.claimLookupJob(prisma, candidate.id, {
      now: nowFn(),
      leaseMs,
    });
    // Lost the race. Nothing reserved, nothing written, nobody called.
    if (!claim) continue; // eslint-disable-line no-continue
    claimed += 1;

    // eslint-disable-next-line no-await-in-loop
    await audit("enrichment.lookup.claimed", {
      provider: claim.record.provider,
      lane: claim.record.lane,
      attemptNumber: claim.record.attemptCount,
    });

    const budgets =
      claim.record.lane === "AUTOMATIC"
        ? appConfig.ENRICHMENT_AUTOMATIC_DAILY_BUDGETS
        : appConfig.ENRICHMENT_MANUAL_DAILY_BUDGETS;

    // eslint-disable-next-line no-await-in-loop
    const outcome = await directExecution.executeDirectJob({
      prisma,
      job: claim.record,
      claimToken: claim.claimToken,
      nowFn,
      limit: budgets[claim.record.provider],
      lookupMaxMs,
      appConfig,
      fetchImpl,
      audit,
    });
    if (outcome.outcome === "COMPLETED") completed += 1;
  }
  return { claimed, completed };
}

/** One bounded targeted pass, counted in SUCCESSFUL claims. */
async function runTargetedPass({ prisma, nowFn, batchSize, leaseMs, lookupMaxMs, runtime, appConfig, audit }) {
  const candidates = await repository.listTargetedDelegateCandidates(prisma, {
    asOf: nowFn(),
    take: batchSize * MAX_SCAN_MULTIPLIER,
  });

  let executed = 0;
  let completed = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const job of candidates) {
    if (executed >= batchSize) break;

    const budgets =
      job.lane === "AUTOMATIC"
        ? appConfig.ENRICHMENT_AUTOMATIC_DAILY_BUDGETS
        : appConfig.ENRICHMENT_MANUAL_DAILY_BUDGETS;

    // eslint-disable-next-line no-await-in-loop
    const outcome = await targetedExecution.executeTargetedJob({
      prisma,
      job,
      nowFn,
      limit: budgets[job.provider],
      leaseMs,
      // The worker's OWN end-to-end bound. No provider's internal timeout
      // bounds lookup() — each clears it when response headers arrive and
      // reads the body afterwards — so without this a stalled body read runs
      // until the stale sweep resolves an attempt that is still live.
      lookupMaxMs,
      runtime,
      // Carries the credential configuration the side-effect-free descriptor
      // check reads BEFORE quota is reserved. Omitted, an unconfigured
      // deployment would spend real budget reaching a disabled provider.
      appConfig,
      audit,
    });
    // A lost claim is not an execution — it must not consume a slot that a
    // genuinely claimable job could have used.
    if (outcome.outcome === "TARGET_NOT_CLAIMABLE" || outcome.outcome === "CLAIM_FAILED") continue; // eslint-disable-line no-continue
    executed += 1;
    if (outcome.outcome === "COMPLETED") completed += 1;
  }
  return { executed, completed };
}

/**
 * Runs ONE bounded tick. Exported so a test can drive exactly one pass without
 * starting a timer, which is also how every worker behaviour in the suite is
 * asserted deterministically.
 */
async function runWorkerTick(input) {
  const {
    prisma,
    nowFn,
    batchSize,
    leaseMs,
    lookupMaxMs,
    attemptStaleMs,
    appConfig,
    runtime,
    fetchImpl,
    audit,
  } = input;

  const staleClaimsRecovered = await recoverStaleClaims({
    prisma,
    now: nowFn(),
    take: batchSize * MAX_SCAN_MULTIPLIER,
    audit,
  });

  // BEFORE the sweep — see the module header.
  const reconciliation = await reconcileDelegatedJobs({
    client: prisma,
    now: nowFn(),
    batchSize: batchSize * MAX_SCAN_MULTIPLIER,
  });

  const sweep = await sweepStaleAttempts({
    prisma,
    now: nowFn(),
    staleBefore: new Date(nowFn().getTime() - attemptStaleMs),
    take: batchSize * MAX_SCAN_MULTIPLIER,
    audit,
  });

  const exhaustedRetired = await retireExhaustedDirectJobs({
    prisma,
    now: nowFn(),
    take: batchSize * MAX_SCAN_MULTIPLIER,
    audit,
  });

  // AFTER everything that can drive a job terminal in this tick, so a run
  // settled here needs no second tick to report the truth.
  const runsReconciled = await reconcileRunStates({
    prisma,
    now: nowFn(),
    take: batchSize * MAX_SCAN_MULTIPLIER,
  });

  const direct = await runDirectPass({
    prisma,
    nowFn,
    batchSize,
    leaseMs,
    lookupMaxMs,
    appConfig,
    fetchImpl,
    audit,
  });

  const targeted = await runTargetedPass({
    prisma,
    nowFn,
    batchSize,
    leaseMs,
    lookupMaxMs,
    runtime,
    appConfig,
    audit,
  });

  return {
    staleClaimsRecovered,
    reconciled: reconciliation.reconciled,
    runsRefreshed: reconciliation.runsRefreshed || 0,
    staleAttemptsSwept: sweep.swept,
    ambiguousTerminated: sweep.ambiguous,
    exhaustedRetired,
    runsReconciled,
    directClaimed: direct.claimed,
    directCompleted: direct.completed,
    targetedClaimed: targeted.executed,
    targetedCompleted: targeted.completed,
  };
}

/**
 * Starts the worker. Called by server.js ONLY when ENRICHMENT_WORKER_ENABLED
 * is true, so a disabled deployment never constructs any of this.
 *
 * @returns {{stop: Function, describe: Function}}
 */
function startEnrichmentWorker(options = {}) {
  if (!isPlainObject(options) || !options.prisma) {
    throw new TypeError("startEnrichmentWorker: prisma is required");
  }
  const prisma = options.prisma;
  const appConfig = options.appConfig || require("../../config/env"); // eslint-disable-line global-require
  // Read FRESH per claim, per reservation and per write — never once per tick.
  // A sequential tick can outlive a lease or cross UTC midnight, which would
  // mint an already-expired lease or charge a call to the wrong day.
  const nowFn = typeof options.nowFn === "function" ? options.nowFn : () => new Date();
  const workerId = options.workerId || `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
  const runtime = options.runtime || buildEnrichmentRuntime({});
  const audit = options.audit || buildAuditor(prisma, workerId);

  const pollIntervalMs = appConfig.ENRICHMENT_WORKER_POLL_INTERVAL_MS;
  const batchSize = appConfig.ENRICHMENT_WORKER_BATCH_SIZE;
  const leaseMs = appConfig.ENRICHMENT_WORKER_LEASE_SECONDS * 1000;
  const lookupMaxMs = appConfig.ENRICHMENT_LOOKUP_MAX_MS;
  const attemptStaleMs = appConfig.ENRICHMENT_ATTEMPT_STALE_SECONDS * 1000;

  let stopped = false;
  let timer = null;
  let inFlight = null;
  let ticksCompleted = 0;

  async function tick() {
    try {
      const counts = await runWorkerTick({
        prisma,
        nowFn,
        batchSize,
        leaseMs,
        lookupMaxMs,
        attemptStaleMs,
        appConfig,
        runtime,
        fetchImpl: options.fetchImpl,
        audit,
      });
      ticksCompleted += 1;
      await audit("enrichment.worker.tick.completed", counts);
    } catch (error) {
      // A worker that dies on one bad row is worse than one that skips it.
      // The error's own text is never audited.
      console.error("Enrichment worker tick failed", { name: error && error.name });
      await audit("enrichment.worker.tick.failed", {}, AUDIT_OUTCOMES.FAILURE);
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      inFlight = tick();
      await inFlight;
      inFlight = null;
      schedule();
    }, pollIntervalMs);
    // Never hold the process open for a poll that has not fired yet.
    if (typeof timer.unref === "function") timer.unref();
  }

  audit("enrichment.worker.started", { pollIntervalMs, batchSize, leaseSeconds: leaseMs / 1000 });
  schedule();

  return {
    /**
     * Drains rather than aborts. A lookup that has already contacted a
     * provider is never cancelled: the ADMIN runner releases a cancelled claim
     * WITH a refund, which on a contacted row is exactly the duplicate charge
     * the contact hold exists to prevent.
     */
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
      await audit("enrichment.worker.stopped", { ticksCompleted });
    },
    describe() {
      return Object.freeze({ workerId, pollIntervalMs, batchSize, leaseMs, lookupMaxMs, attemptStaleMs });
    },
  };
}

module.exports = {
  MAX_SCAN_MULTIPLIER,
  buildAuditor,
  recoverStaleClaims,
  sweepStaleAttempts,
  retireExhaustedDirectJobs,
  reconcileRunStates,
  runDirectPass,
  runTargetedPass,
  runWorkerTick,
  startEnrichmentWorker,
};
