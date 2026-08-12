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

// The closed outcome vocabulary of ONE run-creation request. It is the API's
// contract, not an internal detail, so it lives here beside the other closed
// vocabularies rather than being spelled out in the controller:
//
//   CREATED         a new run was recorded AND it has at least one ELIGIBLE
//                   item. Answered 202 Accepted — recorded, not executed.
//   ALREADY_RUNNING this exact ask already had a run (idempotent replay, or the
//                   loser of a concurrent race). Answered 200 with the EXISTING
//                   run; nothing new was recorded.
//   SKIPPED         a new run was recorded, and every target was refused by
//                   policy, so no outbound work exists. Answered 200: there is
//                   nothing to accept.
//
// A boolean `created` cannot express this — it collapses "recorded work" and
// "recorded that there is nothing to do" into the same answer.
const RUN_REQUEST_OUTCOMES = Object.freeze({
  CREATED: "CREATED",
  ALREADY_RUNNING: "ALREADY_RUNNING",
  SKIPPED: "SKIPPED",
});

// Whether anything will actually pick a recorded job up. Stated as its own
// top-level response field rather than left to documentation, so no consumer
// can read "CREATED" as "three providers were contacted".
//
//   PAUSED_WORKER_DISABLED  ENRICHMENT_WORKER_ENABLED is false — the default.
//   NOT_IMPLEMENTED         the switch is on, but Phase 10A-1 ships no worker,
//                           so nothing will run either way. Reporting
//                           "paused" there would imply a worker exists.
const EXECUTION_STATES = Object.freeze({
  PAUSED_WORKER_DISABLED: "PAUSED_WORKER_DISABLED",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
});

// The closed status vocabulary of ONE provider row in the Finding enrichment
// summary. Every value is resolved from STORED state — no provider is asked
// anything to compute one.
//
//   NO_SUBJECT     considered, but this Finding carries no subject of the
//                  provider's required type. This is the answer for `nvd` on a
//                  Finding with no ACTIVE, ANALYST_VERIFIED CVE, and it exists
//                  precisely so that truth can be told WITHOUT creating an NVD
//                  item (T-09).
//   NOT_REQUESTED  a subject exists, but no orchestration item was ever
//                  recorded for it. Never conflated with NO_SUBJECT: one is
//                  "there was nothing to ask about", the other is "nobody
//                  asked".
//   PENDING        an item exists and its work is non-terminal.
//   COMPLETED      the work reached a real answer.
//   UNAVAILABLE    the work reached a terminal failure. Never reported as
//                  COMPLETED-with-no-evidence, which would read as "nothing
//                  found" rather than "we do not know".
//   SKIPPED        refused by policy, or refused before it could be attempted.
const SUMMARY_STATUSES = Object.freeze({
  NO_SUBJECT: "NO_SUBJECT",
  NOT_REQUESTED: "NOT_REQUESTED",
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  UNAVAILABLE: "UNAVAILABLE",
  SKIPPED: "SKIPPED",
});

// WHICH stored record answered a summary row. A delegated provider's truth
// lives in the canonical queue's own row, not in the Phase-10 job that waits on
// it, so naming the source is what keeps the answer honest rather than
// approximate.
const SUMMARY_SOURCES = Object.freeze({
  NONE: "NONE",
  ORCHESTRATION_JOB: "ORCHESTRATION_JOB",
  IOC_ENRICHMENT: "IOC_ENRICHMENT",
  VULNERABILITY_ENRICHMENT: "VULNERABILITY_ENRICHMENT",
});

// The closed state vocabulary of the report-upload response's `enrichment`
// block. Distinct from RUN_REQUEST_OUTCOMES: one upload can touch many
// Findings, so this describes the WHOLE orchestration attempt for one report.
//
//   AUTOMATIC_DISABLED  AUTO_ENRICHMENT_ENABLED is false. The default.
//   NO_FINDINGS         enabled, but the report touched no Finding, so there
//                       was nothing to orchestrate. Never reported as disabled,
//                       which would misstate the deployment's configuration.
//   RECORDED            enabled, and every touched Finding was recorded.
//   PARTIAL             enabled, and at least one Finding failed to record.
//                       Ingestion still succeeded — orchestration never blocks
//                       it, exactly as enrichment never blocks it.
const INGESTION_ENRICHMENT_STATES = Object.freeze({
  AUTOMATIC_DISABLED: "AUTOMATIC_DISABLED",
  NO_FINDINGS: "NO_FINDINGS",
  RECORDED: "RECORDED",
  PARTIAL: "PARTIAL",
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
  // The canonical queue service that owns this provider's execution refused or
  // failed to produce a schedulable delegate row. The item is recorded as
  // SKIPPED_EXECUTION_UNAVAILABLE and NO ProviderLookupJob is created — a
  // RUN_DELEGATED job with no delegate would be a job nothing can ever finish.
  DELEGATE_UNAVAILABLE: "DELEGATE_UNAVAILABLE",
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
  RUN_REQUEST_OUTCOMES,
  EXECUTION_STATES,
  SUMMARY_STATUSES,
  SUMMARY_SOURCES,
  INGESTION_ENRICHMENT_STATES,
  SKIP_REASONS,
  SKIP_REASON_VALUES,
  isKnownSkipReason,
};
