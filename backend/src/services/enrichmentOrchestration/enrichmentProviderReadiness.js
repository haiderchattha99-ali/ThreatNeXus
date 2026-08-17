"use strict";

// Phase 10C-3 — the closed, server-derived readiness vocabulary for one
// (provider, lane). Answers "can this provider execute right now, and if
// not, exactly why" from deployment-level configuration and today's usage —
// never from a provider call.
//
// Pure by construction, mirroring enrichmentApplicabilityRouter.js's shape:
// no Prisma, no network, no wall clock, no process.env. Every fact this
// module needs is passed in, already resolved by the caller.
//
// ---------------------------------------------------------------------------
// The output vocabulary is CLOSED, and evaluated in one fixed order
// ---------------------------------------------------------------------------
// See docs/ai/PHASE-10C3-PROVIDER-CREDENTIAL-BUDGET-OPERABILITY-CONTRACT.md
// §8.2 for the binding precedence and its rationale. Restated briefly:
//
//   1. DELEGATED_BATCH_REQUIRED  nvd is never worker-eligible — structural,
//                                independent of every other input.
//   2. NOT_CONFIGURED            "we cannot call this provider at all"
//                                outranks every other fact.
//   3. EXECUTION_PAUSED          the worker switch blocks BOTH lanes.
//   4. AUTOMATIC_INGESTION_DISABLED  AUTOMATIC lane only — blocks one lane,
//                                so it is reported after the broader refusal.
//   5. BUDGET_ZERO                a known-zero budget, refused at routing
//                                time; no job is ever created.
//   6. BUDGET_EXHAUSTED           a positive budget, fully spent for today.
//                                Reported after BUDGET_ZERO because zero
//                                never resets at midnight and exhaustion
//                                always does.
//   7. READY                      every deployment-level control passes.
//
// `READY` is a complete answer by construction — it already accounts for the
// worker switch and, on the AUTOMATIC lane, for automatic ingestion, so a
// caller never has to AND it with another top-level field.
//
// ---------------------------------------------------------------------------
// Malformed input THROWS; it does not resolve to a refusal value
// ---------------------------------------------------------------------------
// The provider list is closed and server-controlled — a caller iterates
// KNOWN_PROVIDERS — so an unknown provider, or a wrong-shaped budget, can
// only arise from a coding defect (e.g. passing a raw environment map where
// a resolved config was expected). Silently rendering that as NOT_CONFIGURED
// would hide the bug behind a plausible-looking screen. This follows
// enrichmentApplicabilityRouter.routeTarget's own rule: a data condition is a
// decision, a malformed context is a programming error and must surface
// loudly.

const { KNOWN_PROVIDERS, SUBJECT_TYPES, subjectTypeForProvider } = require("./enrichmentSubject");
const { QUOTA_LANES } = require("./enrichmentDecisionCodes");

class ProviderReadinessError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "ProviderReadinessError";
  }
}

const PROVIDER_READINESS = Object.freeze({
  DELEGATED_BATCH_REQUIRED: "DELEGATED_BATCH_REQUIRED",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  EXECUTION_PAUSED: "EXECUTION_PAUSED",
  AUTOMATIC_INGESTION_DISABLED: "AUTOMATIC_INGESTION_DISABLED",
  BUDGET_ZERO: "BUDGET_ZERO",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  READY: "READY",
});

// The ladder's evaluation order (§8.2 steps 1-7). A test asserts this set is
// exactly Object.values(PROVIDER_READINESS) — the same guard
// SUMMARY_STATUS_PRECEDENCE carries in enrichmentDecisionCodes.js — so a
// value added later without a ranking cannot silently fall through
// undetected.
const PROVIDER_READINESS_PRECEDENCE = Object.freeze([
  PROVIDER_READINESS.DELEGATED_BATCH_REQUIRED,
  PROVIDER_READINESS.NOT_CONFIGURED,
  PROVIDER_READINESS.EXECUTION_PAUSED,
  PROVIDER_READINESS.AUTOMATIC_INGESTION_DISABLED,
  PROVIDER_READINESS.BUDGET_ZERO,
  PROVIDER_READINESS.BUDGET_EXHAUSTED,
  PROVIDER_READINESS.READY,
]);

function assertBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new ProviderReadinessError(`resolveProviderReadiness: ${label} must be a boolean`);
  }
}

/**
 * Derives the closed readiness value for one (provider, lane) pair from
 * already-resolved deployment configuration and today's usage.
 *
 * @param {{provider: string, lane: string, credentialConfigured: boolean,
 *   workerEnabled: boolean, automaticIngestionEnabled: boolean,
 *   dailyBudget: number|null, reservedToday: number}} input
 * @returns {string} a PROVIDER_READINESS value
 * @throws {ProviderReadinessError} on any malformed input (§8.3)
 */
function resolveProviderReadiness(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProviderReadinessError("resolveProviderReadiness: input must be an object");
  }

  const {
    provider,
    lane,
    credentialConfigured,
    workerEnabled,
    automaticIngestionEnabled,
    dailyBudget,
    reservedToday,
  } = input;

  if (typeof provider !== "string" || !KNOWN_PROVIDERS.includes(provider)) {
    throw new ProviderReadinessError(
      `resolveProviderReadiness: unknown provider ${JSON.stringify(provider)}`
    );
  }
  if (lane !== QUOTA_LANES.AUTOMATIC && lane !== QUOTA_LANES.MANUAL) {
    throw new ProviderReadinessError("resolveProviderReadiness: lane must be AUTOMATIC or MANUAL");
  }
  assertBoolean(credentialConfigured, "credentialConfigured");
  assertBoolean(workerEnabled, "workerEnabled");
  assertBoolean(automaticIngestionEnabled, "automaticIngestionEnabled");
  if (dailyBudget !== null && (!Number.isInteger(dailyBudget) || dailyBudget < 0)) {
    throw new ProviderReadinessError(
      "resolveProviderReadiness: dailyBudget must be null or a non-negative integer"
    );
  }
  if (!Number.isInteger(reservedToday) || reservedToday < 0) {
    throw new ProviderReadinessError(
      "resolveProviderReadiness: reservedToday must be a non-negative integer"
    );
  }

  // 1. Structural — independent of every other input. Derived from the same
  // provider/subject map enrichmentRunService and enrichmentSummaryReadService
  // already use to single out nvd, rather than a second hardcoded list.
  if (subjectTypeForProvider(provider) === SUBJECT_TYPES.CVE) {
    return PROVIDER_READINESS.DELEGATED_BATCH_REQUIRED;
  }

  // 2. Cannot be called at all.
  if (credentialConfigured !== true) return PROVIDER_READINESS.NOT_CONFIGURED;

  // 3. Nothing will pick up recorded work, on either lane.
  if (workerEnabled !== true) return PROVIDER_READINESS.EXECUTION_PAUSED;

  // 4. AUTOMATIC lane only: no automatic job can ever be recorded.
  if (lane === QUOTA_LANES.AUTOMATIC && automaticIngestionEnabled !== true) {
    return PROVIDER_READINESS.AUTOMATIC_INGESTION_DISABLED;
  }

  // 5. Known-zero budget — refused at routing time, no job ever created.
  if (dailyBudget === 0) return PROVIDER_READINESS.BUDGET_ZERO;

  // 6. Positive budget, fully spent for today. null means unlimited and never
  // reaches this branch.
  if (dailyBudget !== null && reservedToday >= dailyBudget) {
    return PROVIDER_READINESS.BUDGET_EXHAUSTED;
  }

  // 7. Every deployment-level control passes.
  return PROVIDER_READINESS.READY;
}

module.exports = {
  ProviderReadinessError,
  PROVIDER_READINESS,
  PROVIDER_READINESS_PRECEDENCE,
  resolveProviderReadiness,
};
