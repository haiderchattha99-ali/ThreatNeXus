import { describe, it, expect } from "vitest";

const {
  UnknownIocEnrichmentProviderError,
  resolveIocEnrichmentProvider,
  listRegisteredIocEnrichmentProviderNames,
} = require("../../src/services/enrichment/providerRegistry");

const ASOF = new Date("2026-06-01T00:00:00Z");

describe("providerRegistry — resolution", () => {
  it("resolves the mock provider by its exact registered name", async () => {
    const provider = resolveIocEnrichmentProvider("mock");
    expect(provider.name).toBe("mock");
    const result = await provider.lookup({ indicatorType: "IPV4", indicator: "203.0.113.10", asOf: ASOF });
    expect(result.provider).toBe("mock");
  });

  it("passes config through to the resolved provider's factory", async () => {
    const provider = resolveIocEnrichmentProvider("mock", { enabled: false });
    const result = await provider.lookup({ indicatorType: "IPV4", indicator: "203.0.113.10", asOf: ASOF });
    expect(result.status).toBe("SKIPPED_DISABLED");
  });

  it("rejects an unknown provider name with a controlled, typed error", () => {
    expect(() => resolveIocEnrichmentProvider("abuseipdb")).toThrow(UnknownIocEnrichmentProviderError);
    expect(() => resolveIocEnrichmentProvider("does-not-exist")).toThrow(UnknownIocEnrichmentProviderError);
  });

  it("is case-sensitive: 'Mock'/'MOCK' are not the registered 'mock'", () => {
    expect(() => resolveIocEnrichmentProvider("Mock")).toThrow(UnknownIocEnrichmentProviderError);
    expect(() => resolveIocEnrichmentProvider("MOCK")).toThrow(UnknownIocEnrichmentProviderError);
  });

  it("rejects prototype-chain lookups like 'constructor' or 'toString' as unknown providers", () => {
    expect(() => resolveIocEnrichmentProvider("constructor")).toThrow(UnknownIocEnrichmentProviderError);
    expect(() => resolveIocEnrichmentProvider("toString")).toThrow(UnknownIocEnrichmentProviderError);
    expect(() => resolveIocEnrichmentProvider("hasOwnProperty")).toThrow(UnknownIocEnrichmentProviderError);
  });

  it("throws TypeError for a non-string or empty name", () => {
    expect(() => resolveIocEnrichmentProvider(undefined)).toThrow(TypeError);
    expect(() => resolveIocEnrichmentProvider("")).toThrow(TypeError);
    expect(() => resolveIocEnrichmentProvider(123)).toThrow(TypeError);
  });

  it("gives every resolution a fresh, independent provider instance", async () => {
    const providerA = resolveIocEnrichmentProvider("mock");
    const providerB = resolveIocEnrichmentProvider("mock");
    await providerA.lookup({ indicatorType: "IPV4", indicator: "203.0.113.10", asOf: ASOF });
    expect(providerA.getCallCount()).toBe(1);
    expect(providerB.getCallCount()).toBe(0);
  });
});

describe("providerRegistry — immutability", () => {
  it("lists 'mock' as the only registered provider name", () => {
    expect(listRegisteredIocEnrichmentProviderNames()).toEqual(["mock"]);
  });

  it("returns a frozen names array that cannot be mutated by a consumer", () => {
    const names = listRegisteredIocEnrichmentProviderNames();
    expect(Object.isFrozen(names)).toBe(true);
    expect(() => names.push("abuseipdb")).toThrow();
  });

  it("does not export the underlying factory map for direct mutation", () => {
    // eslint-disable-next-line global-require
    const registryModule = require("../../src/services/enrichment/providerRegistry");
    expect(registryModule.PROVIDER_FACTORIES).toBeUndefined();
  });

  it("exposes no register/unregister mutation entry point", () => {
    // eslint-disable-next-line global-require
    const registryModule = require("../../src/services/enrichment/providerRegistry");
    expect(registryModule.register).toBeUndefined();
    expect(registryModule.unregister).toBeUndefined();
  });
});
