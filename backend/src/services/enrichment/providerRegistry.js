"use strict";

// Small, immutable, code-level IOC enrichment provider registry (P2-T2a) —
// mirrors the existing reportSourceRegistry.js pattern: no database-backed
// registry, no generic plugin framework, no dependency-injection container.
// Registering the future AbuseIPDBProvider is one small additive entry in
// PROVIDER_FACTORIES below, never a rewrite of this module or its callers.
//
// The registry itself is never exported — only resolve/list functions are —
// so a consumer has no reference to mutate, on top of PROVIDER_FACTORIES
// being frozen. Each resolve() call invokes the provider's factory fresh, so
// callers (and tests) never share mutable provider state such as a mock's
// call count across unrelated resolutions.

const { createMockIocEnrichmentProvider } = require("./mockIocEnrichmentProvider");
const { assertImplementsIocEnrichmentProvider } = require("./iocEnrichmentProvider");

class UnknownIocEnrichmentProviderError extends Error {
  constructor(name) {
    super(`Unknown IOC enrichment provider: ${JSON.stringify(name)}`);
    this.name = "UnknownIocEnrichmentProviderError";
  }
}

// Exact, case-sensitive provider names only — "Mock"/"MOCK"/" mock" are not
// "mock". Do NOT register a fake/stub AbuseIPDB implementation here; that
// provider does not exist until the packet that implements it for real.
const PROVIDER_FACTORIES = Object.freeze({
  mock: (config) => createMockIocEnrichmentProvider(config),
});

/**
 * Resolves a provider by its exact registered name, invoking a fresh
 * instance from that provider's factory every call.
 *
 * @param {string} name
 * @param {object} [config] - passed through verbatim to the provider factory.
 * @throws {TypeError} if `name` is not a non-empty string.
 * @throws {UnknownIocEnrichmentProviderError} if `name` is not registered.
 */
function resolveIocEnrichmentProvider(name, config = {}) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("resolveIocEnrichmentProvider: name must be a non-empty string");
  }
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_FACTORIES, name)) {
    throw new UnknownIocEnrichmentProviderError(name);
  }
  const provider = PROVIDER_FACTORIES[name](config);
  assertImplementsIocEnrichmentProvider(provider);
  return provider;
}

// A frozen snapshot of registered names — safe to hand to a caller since
// mutating the returned array can never affect PROVIDER_FACTORIES itself.
function listRegisteredIocEnrichmentProviderNames() {
  return Object.freeze(Object.keys(PROVIDER_FACTORIES));
}

module.exports = {
  UnknownIocEnrichmentProviderError,
  resolveIocEnrichmentProvider,
  listRegisteredIocEnrichmentProviderNames,
};
