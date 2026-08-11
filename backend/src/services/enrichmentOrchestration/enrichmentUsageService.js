"use strict";

// Phase 10A-1 — provider quota usage reporting.
//
// ===========================================================================
// THE HONESTY PROBLEM THIS MODULE IS BUILT AROUND
// ===========================================================================
// Phase 10A-1 writes NO ProviderDailyUsage row, because it makes no provider
// call and reserves no quota. So the raw answer to "how much quota has been
// used?" is, from this table, always zero.
//
// Zero here does NOT mean zero provider calls happened in the application. It
// means zero PHASE-10 RESERVATIONS happened. Three pre-existing paths still
// contact providers and are not accounted for by this table at all:
//
//   * the legacy ADMIN IOC enrichment batch,
//   * the ADMIN vulnerability enrichment batch,
//   * the synchronous direct-provider expert endpoints (Censys, GreyNoise,
//     Shodan, Netlas), which remain in place until 10A-2.
//
// Returning a bare `0` would therefore be a true number presented as a false
// claim. Every response instead carries explicit scope metadata saying what
// was counted, that the coverage is PARTIAL, that reservations are not active,
// and which paths are excluded. No total provider-call count is fabricated:
// this module cannot know one, so it does not report one.
//
// Phase 10A-2 may widen accountingScope once reservations are live. The
// vocabulary is deliberately shaped like the availability/provenance labels
// the dashboard snapshot already uses, where "unknown" is never rendered as
// zero.

const { KNOWN_PROVIDERS } = require("./enrichmentSubject");
const { QUOTA_LANES } = require("./enrichmentDecisionCodes");
const {
  resolveOrchestrationConfig,
} = require("./enrichmentOrchestrationConfig");
const repository = require("./enrichmentOrchestrationRepository");

const ACCOUNTING_SCOPES = Object.freeze({
  PHASE_10_RESERVATIONS: "PHASE_10_RESERVATIONS",
});

const COVERAGE = Object.freeze({
  PARTIAL: "PARTIAL",
  COMPLETE: "COMPLETE",
});

// The paths this table does NOT account for. Stated as data, not prose, so a
// consumer can render them and a test can assert them.
const EXCLUDED_PATHS = Object.freeze([
  "LEGACY_ADMIN_IOC_BATCH",
  "ADMIN_VULNERABILITY_BATCH",
  "PRE_10A2_SYNCHRONOUS_DIRECT_PROVIDER_ROUTES",
]);

/**
 * Reports configured budgets and recorded Phase-10 reservations.
 *
 * @param {{client: object, usageDate?: Date|null, env?: object}} options
 * @returns {Promise<object>} frozen
 */
async function getProviderUsage(options = {}) {
  const { client } = options;
  if (!client) throw new TypeError("getProviderUsage: client is required");

  const config = resolveOrchestrationConfig(options.env || process.env);
  const rows = await repository.listDailyUsage(client, {
    usageDate: options.usageDate || null,
  });

  // Index the (always empty in 10A-1) reservation rows by provider and lane.
  const reserved = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const row of rows) {
    if (!reserved[row.provider]) reserved[row.provider] = {};
    reserved[row.provider][row.lane] = row.reservedCount;
  }

  const providers = KNOWN_PROVIDERS.map((provider) =>
    Object.freeze({
      provider,
      automatic: Object.freeze({
        // null === unlimited, and is reported as null rather than coerced to a
        // number that would read as a limit.
        dailyBudget: config.automaticDailyBudgets[provider],
        reservedToday:
          reserved[provider] && reserved[provider][QUOTA_LANES.AUTOMATIC] !== undefined
            ? reserved[provider][QUOTA_LANES.AUTOMATIC]
            : 0,
      }),
      manual: Object.freeze({
        dailyBudget: config.manualDailyBudgets[provider],
        reservedToday:
          reserved[provider] && reserved[provider][QUOTA_LANES.MANUAL] !== undefined
            ? reserved[provider][QUOTA_LANES.MANUAL]
            : 0,
      }),
    })
  );

  return Object.freeze({
    accountingScope: ACCOUNTING_SCOPES.PHASE_10_RESERVATIONS,
    coverage: COVERAGE.PARTIAL,
    // False for the whole of Phase 10A-1: no code path reserves quota, so
    // every reservedToday above is a structural zero, not a measurement.
    reservationsActive: false,
    excludedPaths: EXCLUDED_PATHS,
    // Said in words as well as codes, because this is the sentence a reader
    // would otherwise supply incorrectly for themselves.
    note:
      "Counts Phase-10 quota reservations only. Phase 10A-1 performs no provider " +
      "calls and creates no reservations, so every count is zero. This is NOT a " +
      "total of provider calls made by the application: the excluded paths above " +
      "contact providers and are not accounted for here.",
    providers: Object.freeze(providers),
  });
}

module.exports = {
  ACCOUNTING_SCOPES,
  COVERAGE,
  EXCLUDED_PATHS,
  getProviderUsage,
};
