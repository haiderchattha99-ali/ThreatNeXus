import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  EnrichmentRuntimeError,
  ABUSEIPDB_PROVIDER_NAME,
  MOCK_PROVIDER_NAME,
  buildEnrichmentRuntime,
} = require("../../src/services/enrichment/enrichmentRuntime");
const { resolveEnrichmentTtl } = require("../../src/services/enrichment/enrichmentTtlPolicy");
const { resolveEnrichmentRetry } = require("../../src/services/enrichment/enrichmentRetryPolicy");

// SCOPE NOTE: the composition root is the one place that reads validated
// configuration and assembles real providers. These tests prove it assembles
// the RIGHT things and leaks nothing — never that a provider works (that is
// abuseIpdbProvider.test.js) and never against the real internet: every
// provider built here gets an injected fetch that fails loudly if called.

const FAKE_KEY = "fake-runtime-abuseipdb-key-must-not-leak";

function fakeEnv(overrides = {}) {
  return {
    ABUSEIPDB_API_KEY: FAKE_KEY,
    ABUSEIPDB_BASE_URL: "https://api.example.invalid/api/v2",
    ABUSEIPDB_TIMEOUT_MS: 5000,
    ABUSEIPDB_MAX_AGE_DAYS: 30,
    ...overrides,
  };
}

// Any call to this is a test failure by construction: no runtime test may
// reach the network.
const forbiddenFetch = async () => {
  throw new Error("network access is forbidden in tests");
};

let consoleLogSpy;
let consoleWarnSpy;
let consoleErrorSpy;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enrichmentRuntime — construction", () => {
  it("builds without touching the network and without requiring an API key", () => {
    const runtime = buildEnrichmentRuntime({
      env: fakeEnv({ ABUSEIPDB_API_KEY: "" }),
      fetchImpl: forbiddenFetch,
    });
    expect(typeof runtime.providerRegistry.resolve).toBe("function");
    // Resolving still succeeds with no key — a missing key only affects
    // lookup() (SKIPPED_DISABLED), never construction.
    const provider = runtime.providerRegistry.resolve(ABUSEIPDB_PROVIDER_NAME);
    expect(provider.name).toBe(ABUSEIPDB_PROVIDER_NAME);
    expect(provider.describe().enabled).toBe(false);
  });

  it("binds the real TTL and retry policies by default", () => {
    const runtime = buildEnrichmentRuntime({ env: fakeEnv(), fetchImpl: forbiddenFetch });
    expect(runtime.ttlPolicy).toBe(resolveEnrichmentTtl);
    expect(runtime.retryPolicy).toBe(resolveEnrichmentRetry);
  });

  it("returns a frozen runtime with bounded defaults", () => {
    const runtime = buildEnrichmentRuntime({ env: fakeEnv(), fetchImpl: forbiddenFetch });
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Number.isInteger(runtime.leaseDurationSeconds)).toBe(true);
    expect(runtime.leaseDurationSeconds).toBeGreaterThan(0);
    expect(Number.isInteger(runtime.defaultBatchSize)).toBe(true);
    expect(Number.isInteger(runtime.defaultMaxAttempts)).toBe(true);
  });

  it("starts no worker, timer or batch", () => {
    // Building a runtime must be inert. If it scheduled anything, a fake
    // timer would show a pending task.
    vi.useFakeTimers();
    try {
      buildEnrichmentRuntime({ env: fakeEnv(), fetchImpl: forbiddenFetch });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed overrides rather than silently substituting defaults", () => {
    expect(() => buildEnrichmentRuntime({ env: fakeEnv(), ttlPolicy: "nope" })).toThrow(EnrichmentRuntimeError);
    expect(() => buildEnrichmentRuntime({ env: fakeEnv(), retryPolicy: null })).toThrow(EnrichmentRuntimeError);
    expect(() => buildEnrichmentRuntime({ env: fakeEnv(), defaultBatchSize: 0 })).toThrow(EnrichmentRuntimeError);
    expect(() => buildEnrichmentRuntime({ env: fakeEnv(), defaultBatchSize: 10000 })).toThrow(
      EnrichmentRuntimeError
    );
    expect(() => buildEnrichmentRuntime({ env: fakeEnv(), providerRegistry: {} })).toThrow(
      EnrichmentRuntimeError
    );
  });
});

describe("enrichmentRuntime — provider selection", () => {
  it("resolves the exact registered name, case-sensitively", () => {
    const runtime = buildEnrichmentRuntime({ env: fakeEnv(), fetchImpl: forbiddenFetch });
    expect(runtime.providerRegistry.resolve(ABUSEIPDB_PROVIDER_NAME).name).toBe(ABUSEIPDB_PROVIDER_NAME);
    expect(() => runtime.providerRegistry.resolve("AbuseIPDB")).toThrow();
    expect(() => runtime.providerRegistry.resolve("ABUSEIPDB")).toThrow();
    expect(() => runtime.providerRegistry.resolve(" abuseipdb")).toThrow();
  });

  it("NEVER falls back to MockProvider for an unknown name", () => {
    const runtime = buildEnrichmentRuntime({ env: fakeEnv(), fetchImpl: forbiddenFetch });
    // Throwing is what the runner turns into UNKNOWN_PROVIDER. A fabricated
    // mock verdict indistinguishable from a real one is the failure mode this
    // prevents.
    expect(() => runtime.providerRegistry.resolve("ghost")).toThrow();
    expect(() => runtime.providerRegistry.resolve("")).toThrow();
    expect(() => runtime.providerRegistry.resolve(null)).toThrow();
  });

  it("can disable MockProvider entirely for a production runtime", () => {
    const permissive = buildEnrichmentRuntime({ env: fakeEnv(), fetchImpl: forbiddenFetch });
    expect(permissive.providerRegistry.resolve(MOCK_PROVIDER_NAME).name).toBe(MOCK_PROVIDER_NAME);

    const strict = buildEnrichmentRuntime({
      env: fakeEnv(),
      fetchImpl: forbiddenFetch,
      allowMockProvider: false,
    });
    expect(() => strict.providerRegistry.resolve(MOCK_PROVIDER_NAME)).toThrow(EnrichmentRuntimeError);
    // ...and it still does not silently substitute anything else.
    expect(() => strict.providerRegistry.resolve("ghost")).toThrow();
  });

  it("configures the AbuseIPDB provider from the validated environment", () => {
    const env = fakeEnv({ ABUSEIPDB_TIMEOUT_MS: 7500, ABUSEIPDB_MAX_AGE_DAYS: 15 });
    const runtime = buildEnrichmentRuntime({ env, fetchImpl: forbiddenFetch });
    const described = runtime.providerRegistry.resolve(ABUSEIPDB_PROVIDER_NAME).describe();
    expect(described.baseUrl).toBe(env.ABUSEIPDB_BASE_URL);
    expect(described.timeoutMs).toBe(7500);
    expect(described.defaultMaxAgeInDays).toBe(15);
    expect(described.enabled).toBe(true);
  });

  it("accepts a wholesale provider-registry override for tests", () => {
    const fake = { resolve: () => ({ name: "fake", supports: () => true, lookup: async () => null }) };
    const runtime = buildEnrichmentRuntime({ env: fakeEnv(), providerRegistry: fake });
    expect(runtime.providerRegistry).toBe(fake);
  });
});

describe("enrichmentRuntime — diagnostics leak nothing", () => {
  it("reports WHETHER a key is configured, never the key itself", () => {
    const runtime = buildEnrichmentRuntime({ env: fakeEnv(), fetchImpl: forbiddenFetch });
    const described = runtime.describe();

    expect(described.abuseIpdbConfigured).toBe(true);
    const serialized = JSON.stringify(described);
    expect(serialized).not.toContain(FAKE_KEY);
    // Not even a prefix or a length hint.
    expect(serialized).not.toContain(FAKE_KEY.slice(0, 8));
    expect(serialized).not.toContain(String(FAKE_KEY.length));
    expect(Object.values(described)).not.toContain(FAKE_KEY);
  });

  it("reports a missing key as unconfigured rather than throwing", () => {
    const runtime = buildEnrichmentRuntime({ env: fakeEnv({ ABUSEIPDB_API_KEY: "   " }), fetchImpl: forbiddenFetch });
    expect(runtime.describe().abuseIpdbConfigured).toBe(false);
  });

  it("lists the registered provider names and the mock policy", () => {
    const runtime = buildEnrichmentRuntime({
      env: fakeEnv(),
      fetchImpl: forbiddenFetch,
      allowMockProvider: false,
    });
    const described = runtime.describe();
    expect(described.registeredProviders).toContain(ABUSEIPDB_PROVIDER_NAME);
    expect(described.mockProviderAllowed).toBe(false);
    expect(Object.isFrozen(described)).toBe(true);
  });

  it("logs nothing at all while building or describing a runtime", () => {
    const runtime = buildEnrichmentRuntime({ env: fakeEnv(), fetchImpl: forbiddenFetch });
    runtime.describe();
    runtime.providerRegistry.resolve(ABUSEIPDB_PROVIDER_NAME);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
