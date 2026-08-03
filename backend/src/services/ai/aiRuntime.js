"use strict";

// Production composition root for Phase 5 AI mapping assistance.
//
// Mirrors enrichment/enrichmentRuntime.js: it resolves configuration into a
// frozen runtime object and starts NOTHING. No worker, no timer, no daemon, no
// connection, no warm-up call. `require`-ing this module makes no network
// request and needs no API key.
//
// ===========================================================================
// Disabled by default, and disabled means disabled
// ===========================================================================
// AI_ENABLED defaults to false (config/env.js). With it false this runtime
// resolves the disabled provider and reports AI_DISABLED — and the disabled
// provider has no fetch, no timer and no credential, so "no external call" is a
// structural fact rather than a promise.
//
// The application does NOT require an API key to start. There is no
// AI_API_KEY read anywhere in this repository, because no live provider exists
// in it yet; adding one is a future decision that must go through the
// repository's decision record, not a config toggle somebody flips.
//
// ===========================================================================
// aiEnabled and assistanceAvailable are two different questions
// ===========================================================================
// `aiEnabled` is what the operator asked for. `assistanceAvailable` is what the
// system can actually do. They differ when AI_ENABLED=true but AI_PROVIDER
// names something not registered (which, today, is every value except
// "disabled" — no live provider ships in this milestone). Collapsing them into
// one boolean would show an operator a green light over a provider that does
// not exist.

const {
  DISABLED_PROVIDER_NAME,
  resolveAiMappingProvider,
  listRegisteredAiProviderNames,
} = require("./aiProviderRegistry");

const {
  PROMPT_TEMPLATE_VERSION,
  MAX_SUGGESTIONS_PER_RUN,
  RUN_REASON_CODES,
} = require("./aiSuggestionRules");

const { COMPLIANCE_DISCLAIMER } = require("../framework/frameworkMappingRules");

// Provider names that mean "explicitly off". "null" is config/env.js's shipped
// default for AI_PROVIDER and is treated as the disabled provider rather than
// as an unknown name, so a default installation reports AI_DISABLED (accurate)
// rather than AI_PROVIDER_NOT_AVAILABLE (alarming and wrong).
const DISABLED_PROVIDER_ALIASES = Object.freeze(["null", "none", "off", DISABLED_PROVIDER_NAME]);

function normalizeProviderName(rawName) {
  if (typeof rawName !== "string") return DISABLED_PROVIDER_NAME;
  const trimmed = rawName.trim().toLowerCase();
  if (trimmed === "") return DISABLED_PROVIDER_NAME;
  return DISABLED_PROVIDER_ALIASES.includes(trimmed) ? DISABLED_PROVIDER_NAME : trimmed;
}

/**
 * Builds the frozen AI runtime.
 *
 * Every input is an explicit override with an env-backed default, so tests
 * construct a runtime without touching process.env and without the mock
 * provider ever being reachable from the production path.
 *
 * @param {object} [overrides]
 * @param {boolean} [overrides.aiEnabled]
 * @param {string}  [overrides.providerName]
 * @param {boolean} [overrides.allowMockProvider=false]  TEST ONLY
 * @param {object}  [overrides.providerConfig]           TEST ONLY
 */
function buildAiRuntime(overrides = {}) {
  // Lazy require so importing this module never triggers config validation —
  // the same reasoning as enrichmentRuntime.js.
  // eslint-disable-next-line global-require
  const env = overrides.env || require("../../config/env");

  const aiEnabled =
    typeof overrides.aiEnabled === "boolean" ? overrides.aiEnabled : env.AI_ENABLED === true;
  const requestedProviderName = normalizeProviderName(
    overrides.providerName !== undefined ? overrides.providerName : env.AI_PROVIDER
  );
  const allowMockProvider = overrides.allowMockProvider === true;

  // With AI off, nothing else matters: the disabled provider is resolved
  // regardless of what AI_PROVIDER says, so a stale provider name in the
  // environment cannot cause a call.
  if (!aiEnabled) {
    return freezeRuntime({
      aiEnabled: false,
      assistanceAvailable: false,
      provider: resolveAiMappingProvider(DISABLED_PROVIDER_NAME, {}),
      providerName: DISABLED_PROVIDER_NAME,
      reasonCode: RUN_REASON_CODES.AI_DISABLED,
      allowMockProvider,
    });
  }

  const provider = resolveAiMappingProvider(requestedProviderName, {
    allowMockProvider,
    providerConfig: overrides.providerConfig,
  });

  if (!provider || provider.isEnabled !== true) {
    // Deliberately NOT a fallback to mock, and deliberately not a thrown error
    // at boot: an unavailable assistant must never stop the application from
    // starting or a workflow from completing.
    return freezeRuntime({
      aiEnabled: true,
      assistanceAvailable: false,
      provider: resolveAiMappingProvider(DISABLED_PROVIDER_NAME, {}),
      providerName: DISABLED_PROVIDER_NAME,
      reasonCode: RUN_REASON_CODES.AI_PROVIDER_NOT_AVAILABLE,
      allowMockProvider,
    });
  }

  return freezeRuntime({
    aiEnabled: true,
    assistanceAvailable: true,
    provider,
    providerName: provider.name,
    reasonCode: null,
    allowMockProvider,
  });
}

function freezeRuntime(state) {
  return Object.freeze({
    aiEnabled: state.aiEnabled,
    assistanceAvailable: state.assistanceAvailable,
    provider: state.provider,
    providerName: state.providerName,
    providerModel: state.provider ? state.provider.model || null : null,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
    maxSuggestionsPerRun: MAX_SUGGESTIONS_PER_RUN,
    reasonCode: state.reasonCode,

    /**
     * The safe, serializable configuration state.
     *
     * Reports booleans, a provider NAME and a template version — never a key,
     * never a base URL, never a timeout, never a model parameter. Compare
     * enrichmentRuntime.describe(), which reports `abuseIpdbConfigured` as a
     * boolean for exactly the same reason.
     */
    describe() {
      return Object.freeze({
        aiEnabled: state.aiEnabled,
        assistanceAvailable: state.assistanceAvailable,
        providerName: state.providerName,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        maxSuggestionsPerRun: MAX_SUGGESTIONS_PER_RUN,
        reasonCode: state.reasonCode,
        registeredProviders: listRegisteredAiProviderNames({
          allowMockProvider: state.allowMockProvider,
        }),
        disclaimer: COMPLIANCE_DISCLAIMER,
      });
    },
  });
}

module.exports = {
  DISABLED_PROVIDER_ALIASES,
  normalizeProviderName,
  buildAiRuntime,
};
