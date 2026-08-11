"use strict";

// Phase 10A-1 — configuration bounds and defaults for enrichment
// orchestration. Pure validators plus a small resolver; no Prisma, no network,
// no wall clock. env.js imports the validators so bounds live in ONE place and
// the two can never drift apart — the same arrangement abuseIpdbConfig.js and
// vulnerabilityConfig.js already use.
//
// ---------------------------------------------------------------------------
// Everything is off, and every automatic budget is zero, by default
// ---------------------------------------------------------------------------
// AUTO_ENRICHMENT_ENABLED=false and ENRICHMENT_WORKER_ENABLED=false mean a
// deployment that upgrades to this milestone changes behaviour in no way at
// all. On top of that, every AUTOMATIC per-provider daily budget defaults to
// 0, so even switching orchestration on cannot spend a single unit of third-
// party quota without an operator also raising a budget deliberately. Two
// independent controls, not one, because "on by accident" is the failure mode
// that costs real money.
//
// MANUAL budgets default to null, which means UNLIMITED — an analyst pressing
// a button is an explicit human decision, and the existing synchronous expert
// endpoints already have their own rate limiter (RATE_LIMIT_PROVIDER_*). null
// is still parsed and validated: a malformed value fails configuration
// validation loudly rather than silently resolving to "unlimited".

const { KNOWN_PROVIDERS } = require("./enrichmentSubject");

class EnrichmentOrchestrationConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentOrchestrationConfigError";
  }
}

// Every automatic budget starts here. Deliberately 0, never 1: a "just one
// call" default is still an unrequested outbound call.
const DEFAULT_AUTOMATIC_DAILY_BUDGET = 0;

// null === unlimited.
const DEFAULT_MANUAL_DAILY_BUDGET = null;

// An absurd budget is a configuration mistake, not a licence. Bounded so a
// typo (an extra zero, a pasted timestamp) cannot authorize runaway spend.
const MAX_DAILY_BUDGET = 1000000;

// The env-var prefix for each provider, matching the prefixes Phases 2 and 8
// already established (ABUSEIPDB_*, CENSYS_*, GREYNOISE_*, SHODAN_*,
// NETLAS_*, NVD_*).
const PROVIDER_ENV_PREFIX = Object.freeze({
  abuseipdb: "ABUSEIPDB",
  censys: "CENSYS",
  greynoise: "GREYNOISE",
  shodan: "SHODAN",
  netlas: "NETLAS",
  nvd: "NVD",
});

/**
 * Validates one daily budget value.
 *
 * @param {string} variableName for the error message — the NAME only, never
 *   the value, matching env.js's rule that no variable value appears in a
 *   configuration error.
 * @param {unknown} rawValue the raw environment string, or undefined/blank
 * @param {number|null} defaultValue used when the variable is absent or blank
 * @param {{allowNull: boolean}} options allowNull=true accepts the literal
 *   "unlimited" and resolves it to null (MANUAL lane only)
 * @returns {number|null}
 */
function validateDailyBudget(variableName, rawValue, defaultValue, options = {}) {
  const allowNull = options.allowNull === true;

  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return defaultValue;
  }

  const trimmed = String(rawValue).trim();

  if (allowNull && trimmed.toLowerCase() === "unlimited") return null;

  // Plain decimal digits only, checked BEFORE Number(). Number("1e3") is 1000
  // and Number.isInteger agrees, so a Number()-first check would silently
  // accept exponent notation, "0x10", "+5" and " 5 " as budgets. A budget is
  // an operator-typed integer; every other spelling is a mistake worth
  // reporting.
  if (!/^\d+$/.test(trimmed)) {
    throw new EnrichmentOrchestrationConfigError(
      `Invalid value for environment variable: ${variableName} ` +
        `(must be an integer between 0 and ${MAX_DAILY_BUDGET}` +
        `${allowNull ? ' or the literal "unlimited"' : ""})`
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_DAILY_BUDGET) {
    throw new EnrichmentOrchestrationConfigError(
      `Invalid value for environment variable: ${variableName} ` +
        `(must be an integer between 0 and ${MAX_DAILY_BUDGET}` +
        `${allowNull ? ' or the literal "unlimited"' : ""})`
    );
  }
  return parsed;
}

/**
 * Parses a boolean switch that defaults to false.
 *
 * Anything other than the exact string "true" (case-insensitively, trimmed) is
 * false. There is deliberately no "1"/"yes"/"on" synonym set: a switch that
 * spends third-party quota should be turned on by one unambiguous spelling.
 *
 * @param {unknown} rawValue
 * @returns {boolean}
 */
function parseDefaultOffSwitch(rawValue) {
  if (rawValue === undefined || rawValue === null) return false;
  return String(rawValue).trim().toLowerCase() === "true";
}

/**
 * Resolves the full orchestration configuration from a raw environment map.
 *
 * Takes the environment as an argument rather than reading process.env, so
 * every test injects a fake configuration explicitly and no test can depend on
 * the developer's real environment (the trap env.js's TNX_SKIP_DOTENV note
 * already documents).
 *
 * @param {object} source normally process.env
 * @returns {{AUTO_ENRICHMENT_ENABLED: boolean, ENRICHMENT_WORKER_ENABLED: boolean,
 *   automaticDailyBudgets: object, manualDailyBudgets: object}} frozen
 */
function resolveOrchestrationConfig(source) {
  const env = source || {};

  const automaticDailyBudgets = {};
  const manualDailyBudgets = {};

  // eslint-disable-next-line no-restricted-syntax
  for (const provider of KNOWN_PROVIDERS) {
    const prefix = PROVIDER_ENV_PREFIX[provider];
    const automaticName = `${prefix}_AUTOMATIC_DAILY_BUDGET`;
    const manualName = `${prefix}_MANUAL_DAILY_BUDGET`;

    automaticDailyBudgets[provider] = validateDailyBudget(
      automaticName,
      env[automaticName],
      DEFAULT_AUTOMATIC_DAILY_BUDGET,
      { allowNull: false }
    );
    manualDailyBudgets[provider] = validateDailyBudget(
      manualName,
      env[manualName],
      DEFAULT_MANUAL_DAILY_BUDGET,
      { allowNull: true }
    );
  }

  return Object.freeze({
    AUTO_ENRICHMENT_ENABLED: parseDefaultOffSwitch(env.AUTO_ENRICHMENT_ENABLED),
    ENRICHMENT_WORKER_ENABLED: parseDefaultOffSwitch(env.ENRICHMENT_WORKER_ENABLED),
    automaticDailyBudgets: Object.freeze(automaticDailyBudgets),
    manualDailyBudgets: Object.freeze(manualDailyBudgets),
  });
}

/**
 * Whether a provider has the credential it needs to be called at all.
 *
 * NVD is deliberately special-cased as always configured: the NVD API works
 * without a key (at a lower public rate limit), so reporting it as "not
 * configured" when NVD_API_KEY is blank would be false. Every other provider
 * genuinely cannot be called without its credential.
 *
 * Reads only whether the value is non-blank. The value itself is never
 * returned, logged or compared.
 *
 * @param {string} provider
 * @param {object} config the resolved application config (env.js's export)
 * @returns {boolean}
 */
function isProviderCredentialConfigured(provider, config) {
  const source = config || {};
  switch (provider) {
    case "abuseipdb":
      return Boolean(source.ABUSEIPDB_API_KEY);
    case "censys":
      return Boolean(source.CENSYS_PAT);
    case "greynoise":
      return Boolean(source.GREYNOISE_API_KEY);
    case "shodan":
      return Boolean(source.SHODAN_API_KEY);
    case "netlas":
      return Boolean(source.NETLAS_API_KEY);
    case "nvd":
      return true;
    default:
      return false;
  }
}

module.exports = {
  EnrichmentOrchestrationConfigError,
  DEFAULT_AUTOMATIC_DAILY_BUDGET,
  DEFAULT_MANUAL_DAILY_BUDGET,
  MAX_DAILY_BUDGET,
  PROVIDER_ENV_PREFIX,
  validateDailyBudget,
  parseDefaultOffSwitch,
  resolveOrchestrationConfig,
  isProviderCredentialConfigured,
};
