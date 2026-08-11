"use strict";

// Phase 10A-1 — the closed vocabularies the orchestration layer is allowed to
// persist. Pure data; no Prisma, no network, no clock.
//
// FindingEnrichmentRunItem.skipReason is a CODE from SKIP_REASONS, never free
// text, never an exception message, never a provider string. That is what lets
// a run summary be serialized to an analyst without leaking an internal
// identifier, a stack frame or a third-party error body.

// Mirrors RunItemDecision in schema.prisma.
const RUN_ITEM_DECISIONS = Object.freeze({
  ELIGIBLE: "ELIGIBLE",
  SKIPPED_CACHED: "SKIPPED_CACHED",
  SKIPPED_DISABLED: "SKIPPED_DISABLED",
  SKIPPED_NOT_CONFIGURED: "SKIPPED_NOT_CONFIGURED",
  SKIPPED_NOT_APPLICABLE: "SKIPPED_NOT_APPLICABLE",
  SKIPPED_UNSUPPORTED_SUBJECT: "SKIPPED_UNSUPPORTED_SUBJECT",
  SKIPPED_BUDGET: "SKIPPED_BUDGET",
  SKIPPED_EXECUTION_UNAVAILABLE: "SKIPPED_EXECUTION_UNAVAILABLE",
});

// Mirrors EnrichmentRunState.
const RUN_STATES = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
});

// Mirrors EnrichmentRunTrigger.
const RUN_TRIGGERS = Object.freeze({
  INGESTION: "INGESTION",
  MANUAL: "MANUAL",
});

// Mirrors LookupJobTrigger.
const JOB_TRIGGERS = Object.freeze({
  RUN_DELEGATED: "RUN_DELEGATED",
  RUN_DIRECT: "RUN_DIRECT",
  MANUAL_DIRECT: "MANUAL_DIRECT",
});

// Mirrors ProviderLookupJobState.
const JOB_STATES = Object.freeze({
  PENDING: "PENDING",
  LEASED: "LEASED",
  RETRY_WAIT: "RETRY_WAIT",
  WAITING_ON_DELEGATE: "WAITING_ON_DELEGATE",
  SUCCEEDED: "SUCCEEDED",
  NO_RECORD: "NO_RECORD",
  FAILED: "FAILED",
  DEAD_LETTER: "DEAD_LETTER",
  SKIPPED_DISABLED: "SKIPPED_DISABLED",
  SKIPPED_NOT_CONFIGURED: "SKIPPED_NOT_CONFIGURED",
  SKIPPED_UNSUPPORTED_SUBJECT: "SKIPPED_UNSUPPORTED_SUBJECT",
  SKIPPED_BUDGET: "SKIPPED_BUDGET",
});

// The four non-terminal job states. Everything else is terminal.
const NON_TERMINAL_JOB_STATES = Object.freeze([
  JOB_STATES.PENDING,
  JOB_STATES.LEASED,
  JOB_STATES.RETRY_WAIT,
  JOB_STATES.WAITING_ON_DELEGATE,
]);

// Terminal states that mean the work reached a real answer (as opposed to
// having been refused before it could be attempted). Used by run-state
// recomputation, which must not call a budget refusal a success.
const SUCCESSFUL_JOB_STATES = Object.freeze([JOB_STATES.SUCCEEDED, JOB_STATES.NO_RECORD]);

const FAILED_JOB_STATES = Object.freeze([JOB_STATES.FAILED, JOB_STATES.DEAD_LETTER]);

const SKIPPED_JOB_STATES = Object.freeze([
  JOB_STATES.SKIPPED_DISABLED,
  JOB_STATES.SKIPPED_NOT_CONFIGURED,
  JOB_STATES.SKIPPED_UNSUPPORTED_SUBJECT,
  JOB_STATES.SKIPPED_BUDGET,
]);

// Mirrors QuotaLane.
const QUOTA_LANES = Object.freeze({
  AUTOMATIC: "AUTOMATIC",
  MANUAL: "MANUAL",
});

// The closed skipReason vocabulary. One code per REASON, not per provider: a
// provider name in a skip reason would be redundant (the item already carries
// `provider`) and would turn a bounded enum into an open string.
const SKIP_REASONS = Object.freeze({
  // The provider is switched off by configuration.
  PROVIDER_DISABLED: "PROVIDER_DISABLED",
  // The provider has no credential configured. Distinct from disabled: one is
  // a decision, the other is an incomplete deployment.
  PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  // A fresh answer for this exact subject already exists.
  FRESH_RESULT_EXISTS: "FRESH_RESULT_EXISTS",
  // This provider does not accept this subject type at all.
  PROVIDER_SUBJECT_MISMATCH: "PROVIDER_SUBJECT_MISMATCH",
  // The Finding has no subject of the type this provider needs — e.g. no
  // ACTIVE, ANALYST_VERIFIED CVE association for nvd.
  NO_SUBJECT_FOR_PROVIDER: "NO_SUBJECT_FOR_PROVIDER",
  // The configured AUTOMATIC budget for this provider is 0, known at routing
  // time. No job is created and no reservation is ever attempted. Structurally
  // different from ProviderLookupJobState.SKIPPED_BUDGET, which means an
  // already-created eligible job had its execution-time reservation refused.
  AUTOMATIC_BUDGET_ZERO: "AUTOMATIC_BUDGET_ZERO",
  // The same routing-time refusal on the MANUAL lane. Kept as its own code
  // rather than folded into the automatic one: an operator who deliberately
  // set a manual budget to 0 should see that decision reflected back, not a
  // message about a lane they did not configure.
  MANUAL_BUDGET_ZERO: "MANUAL_BUDGET_ZERO",
  // Phase 10A-1 executes nothing. Honest, and never conflated with "disabled".
  EXECUTION_NOT_IMPLEMENTED: "EXECUTION_NOT_IMPLEMENTED",
  // nvd work is delegated to the existing ADMIN vulnerability batch, which
  // Phase 10A-2 deliberately does not make worker-eligible.
  DELEGATE_BATCH_REQUIRED: "DELEGATE_BATCH_REQUIRED",
});

const SKIP_REASON_VALUES = Object.freeze(Object.values(SKIP_REASONS));

/**
 * Whether a persisted skipReason is inside the closed vocabulary. Used by the
 * serializers and by tests that assert no free text can reach the database.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isKnownSkipReason(value) {
  return typeof value === "string" && SKIP_REASON_VALUES.includes(value);
}

module.exports = {
  RUN_ITEM_DECISIONS,
  RUN_STATES,
  RUN_TRIGGERS,
  JOB_TRIGGERS,
  JOB_STATES,
  NON_TERMINAL_JOB_STATES,
  SUCCESSFUL_JOB_STATES,
  FAILED_JOB_STATES,
  SKIPPED_JOB_STATES,
  QUOTA_LANES,
  SKIP_REASONS,
  SKIP_REASON_VALUES,
  isKnownSkipReason,
};
