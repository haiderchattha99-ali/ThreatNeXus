"use strict";

// Phase 10A-1 — the read/serialization boundary for enrichment orchestration.
//
// ===========================================================================
// THE ISOLATION RULE THIS MODULE EXISTS TO ENFORCE
// ===========================================================================
// A ProviderLookupJob is SHARED. Ten Findings on one IP point at one job. That
// is the whole point of the design — and it is exactly why a Finding-scoped
// summary must never serialize a job identifier.
//
// If it did, an analyst holding Finding A's summary would learn a job id that
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

const { isKnownSkipReason } = require("./enrichmentDecisionCodes");

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
 * Serializes a run plus its items.
 *
 * `consideredProviders` reports providers that were in scope but produced no
 * item because the Finding had no subject for them (e.g. nvd with no verified
 * CVE). Recording that is the difference between "we did not ask NVD" and
 * "NVD was never considered".
 *
 * @param {object} run
 * @param {Array<object>} items
 * @param {{unsubjectedProviders?: Array<string>}} [extra]
 * @returns {object} frozen
 */
function serializeRun(run, items, extra = {}) {
  const serializedItems = items.map(serializeRunItem);
  const decisionCounts = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const item of serializedItems) {
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
    itemCount: serializedItems.length,
    decisionCounts,
    items: serializedItems,
    consideredProviders: Object.freeze({
      // In scope, but this Finding has no subject of the required type.
      noSubject: Object.freeze([...(extra.unsubjectedProviders || [])]),
    }),
    // Stated on every response rather than left to documentation: this
    // milestone records intent and executes nothing.
    execution: Object.freeze({
      performed: false,
      reason: "PHASE_10A1_ORCHESTRATION_ONLY",
    }),
  });
}

/**
 * A compact run descriptor for list responses — no items, no hashes.
 */
function serializeRunSummary(run) {
  return Object.freeze({
    id: run.id,
    findingId: run.findingId,
    trigger: run.trigger,
    state: run.state,
    force: run.force,
    requestedAt: run.requestedAt,
    completedAt: run.completedAt,
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
  serializeRunItem,
  serializeRun,
  serializeRunSummary,
};
