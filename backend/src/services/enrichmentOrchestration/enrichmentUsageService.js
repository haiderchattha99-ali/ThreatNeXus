"use strict";

// Phase 10A-1 / 10C-3 — provider quota usage AND operator-facing readiness.
//
// ===========================================================================
// THE HONESTY PROBLEM THIS MODULE IS BUILT AROUND
// ===========================================================================
// Phase 10A-1 wrote no ProviderDailyUsage row and reserved nothing. Phase
// 10A-2 made reservations live. Phase 10C-3's job is to make this module tell
// the truth about THAT boundary — reservationsActive, executionState and
// reservedToday were each still describing 10A-1 — without widening what this
// endpoint accounts for. Three pre-existing paths still contact providers and
// are not accounted for by this table at all:
//
//   * the legacy ADMIN IOC enrichment batch,
//   * the ADMIN vulnerability enrichment batch,
//   * the synchronous direct-provider expert endpoints (Censys, GreyNoise,
//     Shodan, Netlas).
//
// Returning a bare `0` for those would be a true number presented as a false
// claim, so every response carries explicit scope metadata: what was
// counted, that coverage is PARTIAL, and which paths are excluded.
//
// ---------------------------------------------------------------------------
// I-10 — reported configuration reads the SAME object that authorizes spend
// ---------------------------------------------------------------------------
// The frozen config/env export is the sole spend authority
// (enrichmentWorker.js selects ENRICHMENT_AUTOMATIC_DAILY_BUDGETS /
// ENRICHMENT_MANUAL_DAILY_BUDGETS from it). This module is projected into a
// narrow named shape at the boundary below — never the full config object —
// so it cannot hold JWT_SECRET, DATABASE_URL or a credential value.
//
// executionState is the ONE deliberate exemption from that rule: it is
// produced by calling the pre-existing, EXPORTED, UNMODIFIED
// resolveExecutionState(process.env) — the same function
// enrichmentOrchestrationController.js and enrichmentSummaryReadService.js
// already call. Changing its signature was tried and reverted: any call site
// still passing process.env under a signature expecting resolved config would
// read the string "false" as truthy and report ACTIVE on a default
// deployment. Reusing the function keeps exactly one derivation of that field
// and touches none of its three existing call sites.
//
// ---------------------------------------------------------------------------
// I-11 — reservedToday is TODAY's UTC usage day, computed once
// ---------------------------------------------------------------------------
// The date is derived by enrichmentQuotaService.utcUsageDate(now) — the exact
// function reservations key on — computed once and published byte-identical
// to the value used in the WHERE clause. An absent bucket means 0 ONLY
// because of this binding: ensureUsageBucket is reachable solely from
// reserveProviderQuota, and only after its limit===0 short-circuit, so a
// missing row for today provably means zero reservations, never "not yet
// materialised".

const { KNOWN_PROVIDERS, SUBJECT_TYPES, subjectTypeForProvider } = require("./enrichmentSubject");
const { QUOTA_LANES } = require("./enrichmentDecisionCodes");
const { utcUsageDate } = require("./enrichmentQuotaService");
const {
  missingProviderCredentialVariables,
  isProviderCredentialConfigured,
} = require("./enrichmentOrchestrationConfig");
const { resolveProviderReadiness } = require("./enrichmentProviderReadiness");
const { resolveExecutionState } = require("./enrichmentRunReadService");
const repository = require("./enrichmentOrchestrationRepository");

const ACCOUNTING_SCOPES = Object.freeze({
  PHASE_10_RESERVATIONS: "PHASE_10_RESERVATIONS",
});

const COVERAGE = Object.freeze({
  PARTIAL: "PARTIAL",
  COMPLETE: "COMPLETE",
});

// The paths this table does NOT account for. Stated as data, not prose, so a
// consumer can render them and a test can assert them. The third entry is
// named for what it IS today, not for a phase boundary it survived — those
// routes are still mounted and still contact providers outside Phase-10
// accounting.
const EXCLUDED_PATHS = Object.freeze([
  "LEGACY_ADMIN_IOC_BATCH",
  "ADMIN_VULNERABILITY_BATCH",
  "SYNCHRONOUS_DIRECT_PROVIDER_ROUTES",
]);

// Provider -> its Phase-10 execution path (§3.5). Closed set, never a free
// string: WORKER_DIRECT providers run through enrichmentDirectExecutionService,
// abuseipdb is delegated to the canonical IOC queue, and nvd is never
// worker-eligible at all.
const EXECUTION_PATHS = Object.freeze({
  abuseipdb: "WORKER_DELEGATED_IOC",
  censys: "WORKER_DIRECT",
  greynoise: "WORKER_DIRECT",
  shodan: "WORKER_DIRECT",
  netlas: "WORKER_DIRECT",
  nvd: "ADMIN_VULNERABILITY_BATCH",
});

function executionPathForProvider(provider) {
  return EXECUTION_PATHS[provider] || null;
}

/**
 * Projects the frozen application config into the narrow, named shape this
 * module is allowed to hold — never the full config object, which also
 * carries JWT_SECRET, DATABASE_URL and every provider credential (I-10).
 *
 * @param {object} appConfig the resolved config/env export
 * @returns {object} frozen
 */
function projectConfig(appConfig) {
  const source = appConfig || {};
  return Object.freeze({
    workerEnabled: source.ENRICHMENT_WORKER_ENABLED === true,
    autoIngestionEnabled: source.AUTO_ENRICHMENT_ENABLED === true,
    automaticBudgets: source.ENRICHMENT_AUTOMATIC_DAILY_BUDGETS || {},
    manualBudgets: source.ENRICHMENT_MANUAL_DAILY_BUDGETS || {},
    credentialConfigured: Object.freeze(
      KNOWN_PROVIDERS.reduce((acc, provider) => {
        acc[provider] = isProviderCredentialConfigured(provider, source);
        return acc;
      }, {})
    ),
    missingVariables: Object.freeze(
      KNOWN_PROVIDERS.reduce((acc, provider) => {
        acc[provider] = missingProviderCredentialVariables(provider, source);
        return acc;
      }, {})
    ),
  });
}

// UTC calendar day, formatted YYYY-MM-DD. The column is @db.Date; JSON.stringify
// on a raw Date would emit a full ISO datetime and imply a precision the
// column does not carry.
function formatUsageDate(usageDate) {
  return usageDate.toISOString().slice(0, 10);
}

/**
 * Reports configured budgets, TODAY's Phase-10 reservations, and closed
 * per-provider readiness — server-derived, non-secret, and read-only.
 *
 * @param {{client: object, now?: Date, appConfig?: object}} options `now`
 *   defaults to the current instant; `appConfig` defaults to the real
 *   config/env export (injectable so tests never depend on process.env).
 * @returns {Promise<object>} frozen
 */
async function getProviderUsage(options = {}) {
  const { client } = options;
  if (!client) throw new TypeError("getProviderUsage: client is required");

  const now = options.now instanceof Date ? options.now : new Date();
  // eslint-disable-next-line global-require
  const appConfig = options.appConfig || require("../../config/env");
  const config = projectConfig(appConfig);

  // I-11: computed once, from the same function reservations key on, and
  // never taken from a request parameter (§10).
  const usageDate = utcUsageDate(now);

  const rows = await repository.listDailyUsage(client, { usageDate });

  // At most one row per (provider, lane) is possible for one usageDate — the
  // ProviderDailyUsage primary key guarantees it — so this index can never be
  // overwritten by a second, unrelated day the way the pre-10C3 unscoped
  // query could.
  const reserved = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const row of rows) {
    if (!reserved[row.provider]) reserved[row.provider] = {};
    reserved[row.provider][row.lane] = row.reservedCount;
  }

  function reservedTodayFor(provider, lane) {
    return reserved[provider] && reserved[provider][lane] !== undefined ? reserved[provider][lane] : 0;
  }

  function laneReport(provider, lane) {
    const budgets = lane === QUOTA_LANES.AUTOMATIC ? config.automaticBudgets : config.manualBudgets;
    const dailyBudget = budgets[provider] === undefined ? null : budgets[provider];
    const reservedToday = reservedTodayFor(provider, lane);
    const remaining = dailyBudget === null ? null : Math.max(0, dailyBudget - reservedToday);
    const readiness = resolveProviderReadiness({
      provider,
      lane,
      credentialConfigured: config.credentialConfigured[provider] === true,
      workerEnabled: config.workerEnabled,
      automaticIngestionEnabled: config.autoIngestionEnabled,
      dailyBudget,
      reservedToday,
    });
    return Object.freeze({ dailyBudget, reservedToday, remaining, readiness });
  }

  const providers = KNOWN_PROVIDERS.map((provider) =>
    Object.freeze({
      provider,
      subjectType: subjectTypeForProvider(provider),
      executionPath: executionPathForProvider(provider),
      credentialConfigured: config.credentialConfigured[provider] === true,
      missingConfiguration: config.missingVariables[provider] || Object.freeze([]),
      automatic: laneReport(provider, QUOTA_LANES.AUTOMATIC),
      manual: laneReport(provider, QUOTA_LANES.MANUAL),
    })
  );

  // executionState: the ONE deliberate exception to I-10 — see the module
  // header. Calls the existing exported function, unmodified, on the raw
  // environment map exactly as its other two call sites do.
  // eslint-disable-next-line global-require
  const executionState = resolveExecutionState(process.env);

  return Object.freeze({
    accountingScope: ACCOUNTING_SCOPES.PHASE_10_RESERVATIONS,
    coverage: COVERAGE.PARTIAL,
    // Reservations are live whenever the worker can run at all — see
    // enrichmentDirectExecutionService.js and enrichmentTargetedIocService.js,
    // both reachable ONLY through the worker (enrichmentWorker.js), which
    // server.js starts only when ENRICHMENT_WORKER_ENABLED is true.
    reservationsActive: config.workerEnabled,
    executionState,
    automaticIngestionEnabled: config.autoIngestionEnabled,
    configurationSource: "ENVIRONMENT",
    configurationMutable: false,
    restartRequiredForChanges: true,
    usageDate: formatUsageDate(usageDate),
    excludedPaths: EXCLUDED_PATHS,
    note:
      "Counts Phase-10 quota reservations for today's UTC usage day only. Reservations became " +
      "live in Phase 10A-2 and are active whenever ENRICHMENT_WORKER_ENABLED is true. This is " +
      "NOT a total of provider calls made by the application: the excluded paths above contact " +
      "providers and are not accounted for here.",
    providers: Object.freeze(providers),
  });
}

module.exports = {
  ACCOUNTING_SCOPES,
  COVERAGE,
  EXCLUDED_PATHS,
  getProviderUsage,
};
