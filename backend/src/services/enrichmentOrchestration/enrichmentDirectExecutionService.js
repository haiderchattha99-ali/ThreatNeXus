"use strict";

// Phase 10A-2 — direct provider execution for one claimed ProviderLookupJob.
//
// ===========================================================================
// THIS MODULE REUSES; IT DOES NOT REIMPLEMENT
// ===========================================================================
// Each of the four direct providers already has an execution service that
// exports exactly three things this module needs:
//
//   buildProvider({fetchImpl})  the configured provider, built from config/env
//   toPersistedRow(result)      an ALLOW-LIST mapping into that provider's
//                               Prisma columns — never a spread of the result
//   serializeRecord(row)        the safe outward shape
//
// So there is no second HTTP adapter here, no second result model, no second
// evidence table and no second error vocabulary.
//
// What is deliberately NOT reused is `execute<Provider>Lookup(findingId, ...)`.
// That function is FINDING-scoped and synchronous; a ProviderLookupJob is
// SUBJECT-scoped and may be shared by many Findings. Calling it would force
// this module to pick one Finding out of several and re-derive an indicator
// from it — inventing a relationship the job does not have.
//
// ---------------------------------------------------------------------------
// The ordering here is the contract, and it is not reorderable
// ---------------------------------------------------------------------------
//   claim (caller) -> resolve DESCRIPTOR -> reserve+ledger -> IN_FLIGHT+audit
//   -> lookup -> ONE post-call transaction -> refresh runs
//
// The descriptor step is side-effect-free and sits BEFORE the reservation so
// an unknown or unconfigured provider is discovered without spending a unit of
// real third-party budget. Guarantee 4 is therefore "no lookup() call", not
// "no provider constructed" — resolving whether a provider COULD be built is
// exactly what makes the cheap refusal possible.

const { JOB_STATES } = require("./enrichmentDecisionCodes");
const { isProviderCredentialConfigured } = require("./enrichmentOrchestrationConfig");
const repository = require("./enrichmentOrchestrationRepository");
const quota = require("./enrichmentQuotaService");
const { resolveEnrichmentTtl } = require("../enrichment/enrichmentTtlPolicy");

// provider -> the existing execution service, its evidence model, and the
// typed FK on ProviderLookupJob. Adding a provider is one entry, never a
// change to this module's logic.
const DIRECT_PROVIDERS = Object.freeze({
  censys: { modulePath: "../exposure/censysExecutionService", model: "censysEnrichment", fk: "censysEnrichmentId" },
  greynoise: { modulePath: "../reputation/greyNoiseExecutionService", model: "greyNoiseEnrichment", fk: "greyNoiseEnrichmentId" },
  shodan: { modulePath: "../exposure/shodanExecutionService", model: "shodanEnrichment", fk: "shodanEnrichmentId" },
  netlas: { modulePath: "../exposure/netlasExecutionService", model: "netlasEnrichment", fk: "netlasEnrichmentId" },
});

const DIRECT_PROVIDER_NAMES = Object.freeze(Object.keys(DIRECT_PROVIDERS));

// Terminal provider status -> the Phase-10 job state it produces.
//
// Every negative status is terminal FAILED, never RETRY_WAIT: this milestone
// performs no automatic retry of a provider OUTCOME (D-P10A2-06). The existing
// policy already treats a negative answer as real evidence governed by the TTL
// policy, and a stale answer is re-asked by creating a NEW run.
const STATUS_TO_JOB_STATE = Object.freeze({
  SUCCESS: JOB_STATES.SUCCEEDED,
  NOT_FOUND: JOB_STATES.NO_RECORD,
  RATE_LIMITED: JOB_STATES.FAILED,
  TIMEOUT: JOB_STATES.FAILED,
  INVALID_KEY: JOB_STATES.FAILED,
  FAILED: JOB_STATES.FAILED,
  SKIPPED_DISABLED: JOB_STATES.SKIPPED_DISABLED,
  UNSUPPORTED_INDICATOR: JOB_STATES.SKIPPED_UNSUPPORTED_SUBJECT,
});

const OUTCOMES = quota.ATTEMPT_OUTCOMES;

/**
 * Terminal provider status -> the closed AttemptOutcome recorded in the ledger.
 *
 * `FAILED` is not one outcome. It splits on evidence the provider already
 * gives us, because "the provider refused our request", "the provider broke"
 * and "we never reached the provider" are three different facts and only the
 * first two mean the call was answered at all:
 *
 *   errorCode PROVIDER_REJECTED  -> PROVIDER_REJECTED   (non-auth 3xx/4xx)
 *   httpStatus >= 500            -> SERVER_ERROR
 *   anything else                -> TRANSPORT_ERROR     (network, malformed body)
 *
 * Without PROVIDER_REJECTED a Censys HTTP 400 could only be finalized as
 * SERVER_ERROR or TRANSPORT_ERROR, and both would be false.
 */
function resolveAttemptOutcome(result) {
  const status = result && result.status;
  const errorCode = result && result.errorInfo ? result.errorInfo.code : null;
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
    case "SKIPPED_DISABLED":
      return OUTCOMES.DISABLED;
    case "UNSUPPORTED_INDICATOR":
      return OUTCOMES.UNSUPPORTED_SUBJECT;
    case "FAILED":
      if (errorCode === "PROVIDER_REJECTED") return OUTCOMES.PROVIDER_REJECTED;
      if (Number.isInteger(result.httpStatus) && result.httpStatus >= 500) return OUTCOMES.SERVER_ERROR;
      return OUTCOMES.TRANSPORT_ERROR;
    default:
      return OUTCOMES.TRANSPORT_ERROR;
  }
}

/**
 * Whether this provider could be called at all, WITHOUT constructing it or
 * touching the network. Pure, and therefore safe to run before reserving quota.
 */
function resolveDescriptor(provider, appConfig) {
  const entry = DIRECT_PROVIDERS[provider];
  if (!entry) return { ok: false, reason: "UNKNOWN_PROVIDER" };
  if (!isProviderCredentialConfigured(provider, appConfig)) {
    return { ok: false, reason: "NOT_CONFIGURED" };
  }
  return { ok: true, entry };
}

class LookupTimeoutError extends Error {
  constructor() {
    super("lookup exceeded the worker's end-to-end bound");
    this.name = "LookupTimeoutError";
  }
}

/**
 * Runs one lookup under the WORKER'S OWN end-to-end bound.
 *
 * No provider's configured timeout bounds lookup(): every provider clears its
 * timeout as soon as fetch() resolves its HEADERS and reads the body
 * afterwards (censysProvider.js:139/182, greyNoiseProvider.js:117/160). A
 * response whose body stalls therefore runs unbounded, and the stale-attempt
 * sweep would eventually resolve an attempt whose call is STILL EXECUTING —
 * dead-lettering live work and making its real answer unrecordable.
 *
 * The five provider modules are shared unchanged with the ADMIN batch and the
 * synchronous expert endpoints, so they are deliberately not modified here
 * (D-P10A2-09). Bounding the call at this one new call site gives the sweep
 * the real upper bound it needs and touches nothing else.
 */
async function lookupWithBound(provider, input, lookupMaxMs) {
  let timer = null;
  try {
    return await Promise.race([
      provider.lookup(input),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new LookupTimeoutError()), lookupMaxMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Executes one claimed direct job end to end.
 *
 * @param {{prisma: object, job: object, claimToken: string, nowFn: Function,
 *   limit: number|null, lookupMaxMs: number, appConfig: object,
 *   fetchImpl?: Function, audit: Function}} input
 * @returns {Promise<{outcome: string, jobState: string|null,
 *   attemptOutcome: string|null, charged: boolean}>}
 */
async function executeDirectJob(input) {
  const { prisma, job, claimToken, nowFn, limit, lookupMaxMs, appConfig, fetchImpl, audit } = input;

  // --- 3. descriptor, before any charge ------------------------------------
  const descriptor = resolveDescriptor(job.provider, appConfig);
  if (!descriptor.ok) {
    const now = nowFn();
    await repository.terminalizeClaimedJob(prisma, {
      id: job.id,
      claimToken,
      state: JOB_STATES.SKIPPED_NOT_CONFIGURED,
      now,
      terminalReasonCode: descriptor.reason,
    });
    await audit("enrichment.job.terminalized", {
      provider: job.provider,
      state: JOB_STATES.SKIPPED_NOT_CONFIGURED,
      terminalReasonCode: descriptor.reason,
    });
    return { outcome: "SKIPPED_NOT_CONFIGURED", jobState: JOB_STATES.SKIPPED_NOT_CONFIGURED, attemptOutcome: null, charged: false };
  }

  // --- 4. reserve quota AND create the ledger row, in one transaction ------
  const reserveAt = nowFn();
  const reservation = await quota.reserveProviderQuota({
    client: prisma,
    provider: job.provider,
    lane: job.lane,
    now: reserveAt,
    limit,
    lookupJobId: job.id,
    attemptNumber: job.attemptCount,
  });

  if (reservation.outcome === quota.RESERVATION_OUTCOME.REFUSED) {
    // ONE guarded statement terminalizes, refunds and clears the lease
    // together. "Release, then terminalize" would leave a window in which
    // another worker claims the released job and calls the provider.
    await repository.refuseClaimedJobForBudget(prisma, { id: job.id, claimToken, now: nowFn() });
    await audit("enrichment.lookup.refused", {
      provider: job.provider,
      lane: job.lane,
      usageDate: reservation.usageDate,
      reasonCode: reservation.reasonCode,
    });
    return { outcome: "SKIPPED_BUDGET", jobState: JOB_STATES.SKIPPED_BUDGET, attemptOutcome: null, charged: false };
  }

  const attempt = reservation.attempt;
  await audit("enrichment.lookup.charged", {
    provider: job.provider,
    lane: job.lane,
    usageDate: reservation.usageDate,
    attemptNumber: attempt.attemptNumber,
  });

  // --- 5. IN_FLIGHT immediately before the call ----------------------------
  // contactedProvider becomes true HERE, not after the call returns. That is
  // what makes a crash between reservation and fetch distinguishable from a
  // crash during one, and therefore what makes safe automatic retry decidable.
  await quota.markAttemptInFlight(prisma, attempt.id, nowFn());
  await audit("enrichment.lookup.contacted", {
    provider: job.provider,
    lane: job.lane,
    attemptNumber: attempt.attemptNumber,
    contactedProvider: true,
  });

  // --- 6. the call, outside every transaction ------------------------------
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const service = require(descriptor.entry.modulePath);
  const providerInstance = service.buildProvider({ fetchImpl });
  const queriedAt = nowFn();

  let result;
  try {
    result = await lookupWithBound(
      providerInstance,
      { indicator: job.subjectValue, asOf: queriedAt },
      lookupMaxMs
    );
  } catch (error) {
    // Either our own bound fired, or the provider threw. Either way the
    // request was already handed to the transport (contactedProvider is true),
    // so what the provider did with it is UNKNOWABLE from here. Recording a
    // failure would fabricate an outcome; retrying could double-charge.
    const now = nowFn();
    await quota.finalizeAttempt(prisma, attempt.id, { outcome: OUTCOMES.ABANDONED, now });
    await repository.terminalizeClaimedJob(prisma, {
      id: job.id,
      claimToken,
      state: JOB_STATES.DEAD_LETTER,
      now,
      terminalReasonCode: "AMBIGUOUS_AFTER_CONTACT",
    });
    await audit("enrichment.lookup.ambiguous", {
      provider: job.provider,
      lane: job.lane,
      attemptNumber: attempt.attemptNumber,
      contactedProvider: true,
    });
    await refreshRunsForJob(prisma, job.id, now);
    return { outcome: "AMBIGUOUS", jobState: JOB_STATES.DEAD_LETTER, attemptOutcome: OUTCOMES.ABANDONED, charged: true };
  }

  // --- 7. ONE post-call transaction ----------------------------------------
  // Evidence, ledger finalization and the job transition commit together or
  // not at all. Split across statements, a crash in between leaves a FINISHED
  // attempt beside a job that recovery would requeue — a second paid call for
  // an answer already on disk.
  const now = nowFn();
  const jobState = STATUS_TO_JOB_STATE[result.status] || JOB_STATES.FAILED;
  const attemptOutcome = resolveAttemptOutcome(result);
  const ttl = resolveEnrichmentTtl({
    status: result.status,
    queriedAt: result.queriedAt || queriedAt,
    retryAfterSeconds: result.retryAfterSeconds ?? null,
  });

  await prisma.$transaction(async (tx) => {
    const row = await tx[descriptor.entry.model].create({
      data: service.toPersistedRow(result),
    });
    await tx.providerLookupAttempt.updateMany({
      where: { id: attempt.id, state: { in: [...quota.UNFINISHED_ATTEMPT_STATES] } },
      data: {
        state: quota.ATTEMPT_STATES.FINISHED,
        outcome: attemptOutcome,
        finishedAt: now,
        httpStatus: result.httpStatus ?? null,
        errorCode: result.errorInfo ? result.errorInfo.code : null,
        retryAfterSeconds: result.retryAfterSeconds ?? null,
      },
    });
    await tx.providerLookupJob.updateMany({
      where: { id: job.id, state: JOB_STATES.LEASED, claimToken },
      data: {
        state: jobState,
        completedAt: now,
        queriedAt: result.queriedAt || queriedAt,
        freshUntil: ttl.expiresAt,
        activeLookupKey: null,
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        httpStatus: result.httpStatus ?? null,
        errorCode: result.errorInfo ? result.errorInfo.code : null,
        retryAfterSeconds: result.retryAfterSeconds ?? null,
        [descriptor.entry.fk]: row.id,
      },
    });
  });

  await audit("enrichment.lookup.finalized", {
    provider: job.provider,
    lane: job.lane,
    outcome: attemptOutcome,
    httpStatus: result.httpStatus ?? null,
    errorCode: result.errorInfo ? result.errorInfo.code : null,
    contactedProvider: true,
  });

  // --- 8. every run holding an item on this job ----------------------------
  await refreshRunsForJob(prisma, job.id, now);

  return { outcome: "COMPLETED", jobState, attemptOutcome, charged: true };
}

/**
 * A shared job can belong to many runs. Leaving any of them non-terminal would
 * misreport what is known about that Finding, so every one is refreshed.
 */
async function refreshRunsForJob(prisma, jobId, now) {
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
  DIRECT_PROVIDERS,
  DIRECT_PROVIDER_NAMES,
  STATUS_TO_JOB_STATE,
  LookupTimeoutError,
  resolveAttemptOutcome,
  resolveDescriptor,
  lookupWithBound,
  executeDirectJob,
  refreshRunsForJob,
};
