"use strict";

// Phase 10A-1 — the read/serialization boundary for enrichment orchestration.
//
// ===========================================================================
// THE ISOLATION RULE THIS MODULE EXISTS TO ENFORCE
// ===========================================================================
// A ProviderLookupJob is SHARED. Ten Findings on one IP point at one job. That
// is the whole point of the design — and it is exactly why a Finding-scoped
// response must never serialize a job identifier.
//
// If it did, an analyst holding Finding A's response would learn a job id that
// also belongs to Findings B..J, which is a cross-tenant inference channel
// built out of an internal primary key. So:
//
//   * NO lookupJobId, and no job primary key, in any serialized output.
//   * NO queryIdentityHash, requestScopeHash, idempotencyKey or activeLookupKey
//     — every one of them is a stable identifier for work shared across
//     Findings, so publishing one lets a holder correlate two Findings by
//     equality even without an id.
//   * NO claimToken, ever.
//   * NO subject value that did not come from THIS Finding's own items.
//   * skipReason is emitted only when it is inside the closed vocabulary, so a
//     value written by some future code path that ignored the enum cannot
//     become a free-text leak here.
//
// What IS published is the run's own identity (its id, scoped to the Finding
// the caller already asked about), the decision, and the shared job's STATE —
// a state is a fact about progress, not an identifier.
//
// ---------------------------------------------------------------------------
// `run` and `items` are SEPARATE fields, not one flattened object
// ---------------------------------------------------------------------------
// A run is a request record; an item is a per-target decision. Nesting the
// items inside the run made the two read as one blob and pushed callers toward
// treating `data` as an opaque payload. The contract names them separately
// (docs/ai/PHASE-10A1-API-CONTRACT.md), so this module produces them
// separately and the controller assembles the envelope.

const { isKnownSkipReason, EXECUTION_STATES } = require("./enrichmentDecisionCodes");
const { parseProviderList } = require("./enrichmentSubject");
const { resolveOrchestrationConfig } = require("./enrichmentOrchestrationConfig");

/**
 * Whether anything will actually pick a recorded job up.
 *
 * Stated on every orchestration response as its own top-level field rather than
 * left to documentation: without it, "CREATED" reads as "contacted".
 *
 * @param {object} [source] normally process.env
 * @returns {string} an EXECUTION_STATES value
 */
function resolveExecutionState(source) {
  const config = resolveOrchestrationConfig(source || process.env);
  // The switch being ON does not make a worker exist — Phase 10A-1 ships none.
  // Reporting "paused" in that case would imply one is merely idle.
  return config.ENRICHMENT_WORKER_ENABLED
    ? EXECUTION_STATES.NOT_IMPLEMENTED
    : EXECUTION_STATES.PAUSED_WORKER_DISABLED;
}

/**
 * Serializes one run item for a Finding-scoped response.
 *
 * @param {object} item a FindingEnrichmentRunItem with `lookupJob` included
 * @returns {object} frozen, allow-listed
 */
function serializeRunItem(item) {
  return Object.freeze({
    provider: item.provider,
    subjectType: item.subjectType,
    // This Finding's own subject. Safe because the caller is already
    // authorized for this Finding and every item queried belongs to it.
    subjectValue: item.subjectValue,
    decision: item.decision,
    skipReason: isKnownSkipReason(item.skipReason) ? item.skipReason : null,
    // The shared job's observable progress, with NO identifier attached. null
    // for a policy skip, which has no job by CHECK constraint.
    lookupState: item.lookupJob ? item.lookupJob.state : null,
    // Whether a third party has actually been contacted for this item yet.
    // In Phase 10A-1 this is false for every item in existence.
    contacted: Boolean(item.lookupJob && item.lookupJob.queriedAt),
  });
}

/**
 * Serializes the run record itself. Items are serialized separately.
 *
 * `consideredProviders.noSubject` is read from the STORED column, never
 * recomputed from today's Finding and never recovered by reversing a hash. That
 * is what makes the POST response and a GET six months later agree, and what
 * stops a CVE association added afterwards from rewriting history.
 *
 * @param {object} run a FindingEnrichmentRun row
 * @param {Array<object>} items the run's items (for counts only)
 * @returns {object} frozen
 */
function serializeRunRecord(run, items) {
  const decisionCounts = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const item of items) {
    decisionCounts[item.decision] = (decisionCounts[item.decision] || 0) + 1;
  }

  return Object.freeze({
    id: run.id,
    findingId: run.findingId,
    trigger: run.trigger,
    state: run.state,
    force: run.force,
    requestedAt: run.requestedAt,
    completedAt: run.completedAt,
    itemCount: items.length,
    decisionCounts: Object.freeze(decisionCounts),
    consideredProviders: Object.freeze({
      // In scope when this run was requested, but the Finding had no subject of
      // the required type — so no item exists, and never will for this run.
      noSubject: Object.freeze(parseProviderList(run.noSubjectProviders)),
    }),
  });
}

/**
 * The full `{ run, items }` pair a response body carries.
 *
 * @param {object} run
 * @param {Array<object>} items
 * @returns {{run: object, items: Array<object>}} frozen
 */
function serializeRun(run, items) {
  const serializedItems = Object.freeze(items.map(serializeRunItem));
  return Object.freeze({
    run: serializeRunRecord(run, serializedItems),
    items: serializedItems,
  });
}

// The fields that must NEVER appear in any serialized output. Exported so a
// test can assert the list itself, rather than a hand-copied duplicate of it,
// against every serializer's output.
const FORBIDDEN_OUTPUT_FIELDS = Object.freeze([
  "idempotencyKey",
  "requestScopeHash",
  "queryIdentityHash",
  "activeLookupKey",
  "claimToken",
  "lookupJobId",
  "iocEnrichmentId",
  "vulnerabilityEnrichmentJobId",
  "censysEnrichmentId",
  "greyNoiseEnrichmentId",
  "shodanEnrichmentId",
  "netlasEnrichmentId",
]);

module.exports = {
  FORBIDDEN_OUTPUT_FIELDS,
  resolveExecutionState,
  serializeRunItem,
  serializeRunRecord,
  serializeRun,
};
