"use strict";

// Immutable AI mapping-provider registry.
//
// Mirrors enrichment/providerRegistry.js exactly: a small code-level object,
// not a database table and not a plugin framework. The underlying factory map
// is NEVER exported — only the two resolution functions are — so a consumer
// holds no reference it could mutate, which is a stronger guarantee than
// freezing an exposed object.
//
// ===========================================================================
// No silent fallback from production to mock. Ever.
// ===========================================================================
// `mock` is returned ONLY when the caller passes an explicit
// `allowMockProvider: true`. Without it, asking for "mock" resolves to null,
// exactly as asking for "gpt-5" or "" does. There is no configuration value and
// no environment variable that flips that flag: aiRuntime, the one production
// composition root, never passes it.
//
// So the two failure modes stay honest and distinguishable:
//   - AI off                       -> the disabled provider, by design
//   - AI on, provider unavailable  -> null, surfaced as
//                                     AI_PROVIDER_NOT_AVAILABLE
// Neither one quietly becomes "a mock model answered", which would be the worst
// possible outcome: fabricated suggestions presented as a real assistant's.

const {
  DISABLED_PROVIDER_NAME,
  isAiMappingProvider,
  createDisabledAiMappingProvider,
} = require("./aiMappingProvider");

const { MOCK_PROVIDER_NAME, createMockAiMappingProvider } = require("./mockAiMappingProvider");

// Never exported. Case-sensitive exact keys.
const PROVIDER_FACTORIES = {
  [DISABLED_PROVIDER_NAME]: createDisabledAiMappingProvider,
  [MOCK_PROVIDER_NAME]: createMockAiMappingProvider,
};

// Providers that may only be resolved with an explicit opt-in.
const RESTRICTED_PROVIDER_NAMES = Object.freeze([MOCK_PROVIDER_NAME]);

/**
 * The names a caller may resolve. Reflects the opt-in, so a production caller
 * asking what exists is told the truth about what it can actually get.
 */
function listRegisteredAiProviderNames({ allowMockProvider = false } = {}) {
  return Object.keys(PROVIDER_FACTORIES)
    .filter((name) => allowMockProvider || !RESTRICTED_PROVIDER_NAMES.includes(name))
    .sort();
}

/**
 * Resolves a provider by exact, case-sensitive name.
 *
 * Returns null (never throws, never substitutes) for an unknown name, a
 * restricted name without the opt-in, a non-string, or a prototype-chain
 * lookup. The hasOwnProperty guard is not paranoia: without it, resolving
 * "constructor" or "toString" would return an inherited function and the
 * isAiMappingProvider check below would be the only thing between that and a
 * call.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {boolean} [options.allowMockProvider=false]
 * @param {object}  [options.providerConfig]  passed to the factory
 * @returns {object|null}
 */
function resolveAiMappingProvider(name, options = {}) {
  const { allowMockProvider = false, providerConfig } = options;

  if (typeof name !== "string" || name === "") return null;
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_FACTORIES, name)) return null;
  if (!allowMockProvider && RESTRICTED_PROVIDER_NAMES.includes(name)) return null;

  const factory = PROVIDER_FACTORIES[name];
  if (typeof factory !== "function") return null;

  // A fresh instance per resolution — no shared mutable state (call counts,
  // fixtures) leaks between resolutions.
  const provider = factory(providerConfig);
  return isAiMappingProvider(provider) ? provider : null;
}

module.exports = {
  DISABLED_PROVIDER_NAME,
  MOCK_PROVIDER_NAME,
  RESTRICTED_PROVIDER_NAMES,
  listRegisteredAiProviderNames,
  resolveAiMappingProvider,
};
