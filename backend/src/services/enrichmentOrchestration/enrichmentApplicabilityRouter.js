"use strict";

// Phase 10A-1 — the applicability router. Decides, for ONE (provider, subject)
// pair, whether outbound work should exist.
//
// Pure by construction: no Prisma, no network, no wall clock, no provider
// factory, no executor. Every fact it needs — configuration, lane budget,
// whether a fresh answer already exists — is passed in, already materialized
// by the caller in one batched read. That is what makes the whole decision
// table testable without a database and impossible to accidentally turn into a
// provider call.
//
// ---------------------------------------------------------------------------
// The output vocabulary is CLOSED
// ---------------------------------------------------------------------------
// Every return is one RunItemDecision plus, for a skip, one code from
// SKIP_REASONS. There is no free-text branch, so no exception message,
// provider string or third-party error body can reach the database through
// this module.
//
// ---------------------------------------------------------------------------
// Precedence, and why it is in this order
// ---------------------------------------------------------------------------
//   1. subject compatibility  — asking Shodan about a CVE is not a budget
//      question or a configuration question, it is a category error, and it
//      stays wrong however the deployment is configured.
//   2. credential configured  — "we cannot call this provider at all" outranks
//      "we would not have needed to".
//   3. freshness              — a fresh answer already exists, so no outbound
//      work is warranted regardless of budget. Reported BEFORE budget because
//      it is the more specific and more useful fact: telling an analyst "your
//      budget refused this" when a fresh answer was already on file would be
//      true but misleading.
//   4. lane budget            — a KNOWN-zero budget for this lane. No job is
//      created and no reservation is ever attempted, which is what makes this
//      structurally different from the execution-time refusal recorded as
//      ProviderLookupJobState.SKIPPED_BUDGET.
//   5. ELIGIBLE               — outbound work should exist.
//
// `force` bypasses step 3 ONLY. It never bypasses configuration, budget, or
// subject compatibility, and it never bypasses activeLookupKey uniqueness
// downstream — a forced ask still coalesces onto an in-flight job rather than
// creating a duplicate outbound call.

const {
  RUN_ITEM_DECISIONS,
  SKIP_REASONS,
  QUOTA_LANES,
} = require("./enrichmentDecisionCodes");
const { isProviderSubjectCompatible } = require("./enrichmentSubject");

/**
 * @typedef {object} RoutingContext
 * @property {string} provider lowercase provider identifier
 * @property {string} subjectType EnrichmentSubjectType value
 * @property {string} subjectValue canonical subject value
 * @property {string} lane QuotaLane value — fixed from the run's trigger
 * @property {boolean} credentialConfigured whether the provider has the
 *   credential it needs (isProviderCredentialConfigured)
 * @property {number|null} laneDailyBudget the configured budget for this lane;
 *   null means unlimited
 * @property {boolean} hasFreshResult whether a non-expired answer for this
 *   exact subject already exists
 * @property {boolean} force whether the ask explicitly bypasses freshness
 */

/**
 * @typedef {object} RoutingDecision
 * @property {string} decision RunItemDecision value
 * @property {string|null} skipReason closed SKIP_REASONS code, null when
 *   ELIGIBLE
 */

function skip(decision, skipReason) {
  return Object.freeze({ decision, skipReason });
}

/**
 * Routes one (provider, subject) pair.
 *
 * Never throws for a routing outcome — an unroutable pair is a DECISION, not
 * an exception, so one bad pair can never abort a whole run. It does throw on
 * a malformed context, which is a programming error rather than a data
 * condition.
 *
 * @param {RoutingContext} context
 * @returns {RoutingDecision} frozen
 */
function routeTarget(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new TypeError("enrichmentApplicabilityRouter: context must be an object");
  }
  const {
    provider,
    subjectType,
    lane,
    credentialConfigured,
    laneDailyBudget,
    hasFreshResult,
    force,
  } = context;

  if (lane !== QUOTA_LANES.AUTOMATIC && lane !== QUOTA_LANES.MANUAL) {
    throw new TypeError("enrichmentApplicabilityRouter: lane must be AUTOMATIC or MANUAL");
  }

  // 1. Category error. Also catches an unknown provider identifier, because
  // isProviderSubjectCompatible returns false for one.
  if (!isProviderSubjectCompatible(provider, subjectType)) {
    return skip(
      RUN_ITEM_DECISIONS.SKIPPED_UNSUPPORTED_SUBJECT,
      SKIP_REASONS.PROVIDER_SUBJECT_MISMATCH
    );
  }

  // 2. Cannot be called at all.
  if (credentialConfigured !== true) {
    return skip(
      RUN_ITEM_DECISIONS.SKIPPED_NOT_CONFIGURED,
      SKIP_REASONS.PROVIDER_NOT_CONFIGURED
    );
  }

  // 3. A fresh answer already exists. `force` bypasses this and nothing else.
  if (hasFreshResult === true && force !== true) {
    return skip(RUN_ITEM_DECISIONS.SKIPPED_CACHED, SKIP_REASONS.FRESH_RESULT_EXISTS);
  }

  // 4. A known-zero budget for this lane. null means unlimited and never
  // refuses here. A positive budget is NOT consumed at routing time — the
  // atomic reservation that actually spends it happens at execution time
  // (Phase 10A-2), which is why a positive budget still produces an ELIGIBLE
  // item and a job that may later be refused with job.state = SKIPPED_BUDGET.
  if (laneDailyBudget === 0) {
    return skip(
      RUN_ITEM_DECISIONS.SKIPPED_BUDGET,
      lane === QUOTA_LANES.AUTOMATIC
        ? SKIP_REASONS.AUTOMATIC_BUDGET_ZERO
        : SKIP_REASONS.MANUAL_BUDGET_ZERO
    );
  }

  // 5. Outbound work should exist. In Phase 10A-1 the resulting job is created
  // and left in a non-terminal state: there is no worker, so nothing claims
  // it, nothing reserves quota against it, and no provider is contacted.
  return skip(RUN_ITEM_DECISIONS.ELIGIBLE, null);
}

/**
 * Routes a whole target list, preserving input order.
 *
 * @param {Array<RoutingContext>} contexts
 * @returns {Array<RoutingContext & RoutingDecision>} each input context with
 *   its decision attached, frozen
 */
function routeTargets(contexts) {
  if (!Array.isArray(contexts)) {
    throw new TypeError("enrichmentApplicabilityRouter: contexts must be an array");
  }
  return contexts.map((context) => Object.freeze({ ...context, ...routeTarget(context) }));
}

module.exports = {
  routeTarget,
  routeTargets,
};
