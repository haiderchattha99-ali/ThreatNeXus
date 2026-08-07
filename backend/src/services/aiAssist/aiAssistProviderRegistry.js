"use strict";

// Immutable AI assist-provider registry. Mirrors
// services/ai/aiProviderRegistry.js exactly, including the "no silent
// fallback from production to mock" guarantee: `mock` resolves ONLY when the
// caller passes an explicit `allowMockProvider: true`, and aiAssistRuntime
// (the production composition root) never passes it.
//
// A separate registry from aiProviderRegistry.js on purpose, not an
// oversight: this codebase already keeps its provider registries
// domain-separated (IOC vs vulnerability vs exposure, and now Phase 5's AI
// mapping registry) rather than unifying similar-shaped ones — see
// docs/ai/SECURITY.md's "Provider foundation" section. The finding-assist
// contract (generateSuggestion) is structurally different from the mapping
// contract (suggestMappings), so it gets its own small registry rather than
// overloading the Phase 5 one.

const {
  DISABLED_PROVIDER_NAME,
  isAiAssistProvider,
  createDisabledAiAssistProvider,
} = require("./aiAssistProvider");

const { MOCK_PROVIDER_NAME, createMockAiAssistProvider } = require("./mockAiAssistProvider");

const PROVIDER_FACTORIES = {
  [DISABLED_PROVIDER_NAME]: createDisabledAiAssistProvider,
  [MOCK_PROVIDER_NAME]: createMockAiAssistProvider,
};

const RESTRICTED_PROVIDER_NAMES = Object.freeze([MOCK_PROVIDER_NAME]);

function listRegisteredAiAssistProviderNames({ allowMockProvider = false } = {}) {
  return Object.keys(PROVIDER_FACTORIES)
    .filter((name) => allowMockProvider || !RESTRICTED_PROVIDER_NAMES.includes(name))
    .sort();
}

function resolveAiAssistProvider(name, options = {}) {
  const { allowMockProvider = false, providerConfig } = options;

  if (typeof name !== "string" || name === "") return null;
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_FACTORIES, name)) return null;
  if (!allowMockProvider && RESTRICTED_PROVIDER_NAMES.includes(name)) return null;

  const factory = PROVIDER_FACTORIES[name];
  if (typeof factory !== "function") return null;

  const provider = factory(providerConfig);
  return isAiAssistProvider(provider) ? provider : null;
}

module.exports = {
  DISABLED_PROVIDER_NAME,
  MOCK_PROVIDER_NAME,
  RESTRICTED_PROVIDER_NAMES,
  listRegisteredAiAssistProviderNames,
  resolveAiAssistProvider,
};
