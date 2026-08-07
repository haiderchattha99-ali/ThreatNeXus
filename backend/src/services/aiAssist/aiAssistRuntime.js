"use strict";

// Production composition root for Phase 8C Finding AI assistance. Mirrors
// services/ai/aiRuntime.js exactly, and DELIBERATELY reuses the SAME
// env.AI_ENABLED / env.AI_PROVIDER config surface Phase 5 declared — "AI is
// optional and disabled by default" is one operator decision, not a
// per-feature toggle, so an operator flips one switch to affect both mapping
// suggestions and finding-narrative suggestions together.
//
// Resolves configuration into a frozen runtime object and starts NOTHING. No
// worker, no timer, no daemon, no connection, no warm-up call.

const {
  DISABLED_PROVIDER_NAME,
  resolveAiAssistProvider,
  listRegisteredAiAssistProviderNames,
} = require("./aiAssistProviderRegistry");

const { PROMPT_TEMPLATE_VERSION } = require("./aiAssistRules");

const DISABLED_PROVIDER_ALIASES = Object.freeze(["null", "none", "off", DISABLED_PROVIDER_NAME]);

function normalizeProviderName(rawName) {
  if (typeof rawName !== "string") return DISABLED_PROVIDER_NAME;
  const trimmed = rawName.trim().toLowerCase();
  if (trimmed === "") return DISABLED_PROVIDER_NAME;
  return DISABLED_PROVIDER_ALIASES.includes(trimmed) ? DISABLED_PROVIDER_NAME : trimmed;
}

/**
 * Builds the frozen AI-assist runtime. Same override shape as
 * services/ai/aiRuntime.js's buildAiRuntime, for the same reason: tests
 * construct a runtime without touching process.env, and the mock provider is
 * never reachable from the production path.
 */
function buildAiAssistRuntime(overrides = {}) {
  // eslint-disable-next-line global-require
  const env = overrides.env || require("../../config/env");

  const aiEnabled =
    typeof overrides.aiEnabled === "boolean" ? overrides.aiEnabled : env.AI_ENABLED === true;
  const requestedProviderName = normalizeProviderName(
    overrides.providerName !== undefined ? overrides.providerName : env.AI_PROVIDER
  );
  const allowMockProvider = overrides.allowMockProvider === true;

  if (!aiEnabled) {
    return freezeRuntime({
      aiEnabled: false,
      assistanceAvailable: false,
      provider: resolveAiAssistProvider(DISABLED_PROVIDER_NAME, {}),
      providerName: DISABLED_PROVIDER_NAME,
      reasonCode: "AI_DISABLED",
      allowMockProvider,
    });
  }

  const provider = resolveAiAssistProvider(requestedProviderName, {
    allowMockProvider,
    providerConfig: overrides.providerConfig,
  });

  if (!provider || provider.isEnabled !== true) {
    return freezeRuntime({
      aiEnabled: true,
      assistanceAvailable: false,
      provider: resolveAiAssistProvider(DISABLED_PROVIDER_NAME, {}),
      providerName: DISABLED_PROVIDER_NAME,
      reasonCode: "AI_PROVIDER_NOT_AVAILABLE",
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
    reasonCode: state.reasonCode,

    describe() {
      return Object.freeze({
        aiEnabled: state.aiEnabled,
        assistanceAvailable: state.assistanceAvailable,
        providerName: state.providerName,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        reasonCode: state.reasonCode,
        registeredProviders: listRegisteredAiAssistProviderNames({
          allowMockProvider: state.allowMockProvider,
        }),
      });
    },
  });
}

module.exports = {
  DISABLED_PROVIDER_ALIASES,
  normalizeProviderName,
  buildAiAssistRuntime,
};
