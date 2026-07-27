import { describe, it, expect, vi } from "vitest";

const {
  MOCK_SCENARIOS,
  createMockIocEnrichmentProvider,
} = require("../../src/services/enrichment/mockIocEnrichmentProvider");
const { ENRICHMENT_STATUS, PROVIDER_ERROR_CODES } = require("../../src/services/enrichment/iocEnrichmentTypes");

const ASOF = new Date("2026-06-01T00:00:00Z");
const IP = "203.0.113.10";

function lookupArgs(overrides = {}) {
  return { indicatorType: "IPV4", indicator: IP, asOf: ASOF, ...overrides };
}

describe("MockProvider — contract", () => {
  it("exposes the required method shape and a stable lowercase name", () => {
    const provider = createMockIocEnrichmentProvider();
    expect(provider.name).toBe("mock");
    expect(typeof provider.supports).toBe("function");
    expect(typeof provider.lookup).toBe("function");
  });

  it("requires an explicit, valid asOf and rejects otherwise", async () => {
    const provider = createMockIocEnrichmentProvider();
    await expect(provider.lookup(lookupArgs({ asOf: undefined }))).rejects.toThrow(TypeError);
    await expect(provider.lookup(lookupArgs({ asOf: "2026-06-01" }))).rejects.toThrow(TypeError);
    await expect(provider.lookup(lookupArgs({ asOf: new Date("not-a-date") }))).rejects.toThrow(
      TypeError
    );
  });

  it("does not mutate the caller's queryParams object", async () => {
    const provider = createMockIocEnrichmentProvider({
      fixtures: { [IP]: { scenario: MOCK_SCENARIOS.SUCCESS_LOW_CONFIDENCE } },
    });
    const queryParams = Object.freeze({ maxAgeInDays: 10 });
    const result = await provider.lookup(lookupArgs({ queryParams }));
    expect(queryParams).toEqual({ maxAgeInDays: 10 });
    expect(result.queryParams).toEqual({ maxAgeInDays: 10 });
  });

  it("returns an immutable, copy-safe result", async () => {
    const provider = createMockIocEnrichmentProvider({
      fixtures: { [IP]: { scenario: MOCK_SCENARIOS.SUCCESS_LOW_CONFIDENCE } },
    });
    const result = await provider.lookup(lookupArgs());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.data)).toBe(true);
    expect(() => {
      result.status = "TAMPERED";
    }).toThrow();
  });

  it("handles an unsupported indicator with a controlled result, never a thrown parser error", async () => {
    const provider = createMockIocEnrichmentProvider();
    const cases = [
      { indicatorType: "IPV6", indicator: "2001:db8::1" },
      { indicatorType: "IPV4", indicator: "example.com" },
      { indicatorType: "IPV4", indicator: "999.0.113.10" },
      { indicatorType: "IPV4", indicator: "203.0.113.010" },
    ];
    for (const input of cases) {
      // eslint-disable-next-line no-await-in-loop
      const result = await provider.lookup(lookupArgs(input));
      expect(result.status).toBe(ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR);
      expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.UNSUPPORTED_INDICATOR);
    }
  });

  it("lets an unexpected programmer error propagate rather than swallowing it", async () => {
    const provider = createMockIocEnrichmentProvider();
    await expect(provider.lookup({})).rejects.toThrow(TypeError);
  });
});

describe("MockProvider — scenarios", () => {
  const scenarioCases = [
    [MOCK_SCENARIOS.SUCCESS_LOW_CONFIDENCE, ENRICHMENT_STATUS.SUCCESS],
    [MOCK_SCENARIOS.SUCCESS_MEDIUM_CONFIDENCE, ENRICHMENT_STATUS.SUCCESS],
    [MOCK_SCENARIOS.SUCCESS_HIGH_CONFIDENCE, ENRICHMENT_STATUS.SUCCESS],
    [MOCK_SCENARIOS.SUCCESS_ZERO_CONFIDENCE, ENRICHMENT_STATUS.SUCCESS],
    [MOCK_SCENARIOS.NOT_FOUND, ENRICHMENT_STATUS.NOT_FOUND],
    [MOCK_SCENARIOS.RATE_LIMITED, ENRICHMENT_STATUS.RATE_LIMITED],
    [MOCK_SCENARIOS.INVALID_KEY, ENRICHMENT_STATUS.INVALID_KEY],
    [MOCK_SCENARIOS.TIMEOUT, ENRICHMENT_STATUS.TIMEOUT],
    [MOCK_SCENARIOS.FAILED_UNAVAILABLE, ENRICHMENT_STATUS.FAILED],
    [MOCK_SCENARIOS.FAILED_UNREACHABLE, ENRICHMENT_STATUS.FAILED],
    [MOCK_SCENARIOS.FAILED_MALFORMED_RESPONSE, ENRICHMENT_STATUS.FAILED],
  ];

  it.each(scenarioCases)("scenario %s maps to status %s", async (scenario, expectedStatus) => {
    const provider = createMockIocEnrichmentProvider({ fixtures: { [IP]: { scenario } } });
    const result = await provider.lookup(lookupArgs());
    expect(result.status).toBe(expectedStatus);
  });

  it("SUCCESS_ZERO_CONFIDENCE reports a real 0, not a falsy-treated-as-missing value", async () => {
    const provider = createMockIocEnrichmentProvider({
      fixtures: { [IP]: { scenario: MOCK_SCENARIOS.SUCCESS_ZERO_CONFIDENCE } },
    });
    const result = await provider.lookup(lookupArgs());
    expect(result.data.abuseConfidenceScore).toBe(0);
    expect(result.data.totalReports).toBe(0);
  });

  it("confidence ordering across low/medium/high fixtures is monotonic", async () => {
    const provider = createMockIocEnrichmentProvider({
      fixtures: {
        "203.0.113.1": { scenario: MOCK_SCENARIOS.SUCCESS_LOW_CONFIDENCE },
        "203.0.113.2": { scenario: MOCK_SCENARIOS.SUCCESS_MEDIUM_CONFIDENCE },
        "203.0.113.3": { scenario: MOCK_SCENARIOS.SUCCESS_HIGH_CONFIDENCE },
      },
    });
    const [low, medium, high] = await Promise.all(
      ["203.0.113.1", "203.0.113.2", "203.0.113.3"].map((indicator) =>
        provider.lookup(lookupArgs({ indicator }))
      )
    );
    expect(low.data.abuseConfidenceScore).toBeLessThan(medium.data.abuseConfidenceScore);
    expect(medium.data.abuseConfidenceScore).toBeLessThan(high.data.abuseConfidenceScore);
  });

  it("RATE_LIMITED carries a bounded, non-negative retryAfterSeconds", async () => {
    const provider = createMockIocEnrichmentProvider({
      fixtures: { [IP]: { scenario: MOCK_SCENARIOS.RATE_LIMITED } },
    });
    const result = await provider.lookup(lookupArgs());
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(0);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED);
  });

  it("a fixture may override the default retryAfterSeconds within bounds", async () => {
    const provider = createMockIocEnrichmentProvider({
      fixtures: { [IP]: { scenario: MOCK_SCENARIOS.RATE_LIMITED, retryAfterSeconds: 120 } },
    });
    const result = await provider.lookup(lookupArgs());
    expect(result.retryAfterSeconds).toBe(120);
  });

  it("FAILED_UNAVAILABLE, FAILED_UNREACHABLE and FAILED_MALFORMED_RESPONSE use distinct provider error codes", async () => {
    const provider = createMockIocEnrichmentProvider({
      fixtures: {
        "203.0.113.1": { scenario: MOCK_SCENARIOS.FAILED_UNAVAILABLE },
        "203.0.113.2": { scenario: MOCK_SCENARIOS.FAILED_UNREACHABLE },
        "203.0.113.3": { scenario: MOCK_SCENARIOS.FAILED_MALFORMED_RESPONSE },
      },
    });
    const [unavailable, unreachable, malformed] = await Promise.all(
      ["203.0.113.1", "203.0.113.2", "203.0.113.3"].map((indicator) =>
        provider.lookup(lookupArgs({ indicator }))
      )
    );
    expect(unavailable.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE);
    expect(unreachable.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNREACHABLE);
    expect(malformed.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE);
  });

  it("SKIPPED_DISABLED is returned for every indicator when the provider is constructed disabled", async () => {
    const provider = createMockIocEnrichmentProvider({
      enabled: false,
      fixtures: { [IP]: { scenario: MOCK_SCENARIOS.SUCCESS_HIGH_CONFIDENCE } },
    });
    const result = await provider.lookup(lookupArgs());
    expect(result.status).toBe(ENRICHMENT_STATUS.SKIPPED_DISABLED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED);
  });

  it("an unknown, otherwise-valid IPv4 defaults to NOT_FOUND", async () => {
    const provider = createMockIocEnrichmentProvider();
    const result = await provider.lookup(lookupArgs({ indicator: "198.51.100.77" }));
    expect(result.status).toBe(ENRICHMENT_STATUS.NOT_FOUND);
  });

  it("the unknown-indicator default scenario is configurable", async () => {
    const provider = createMockIocEnrichmentProvider({
      unknownIndicatorScenario: MOCK_SCENARIOS.FAILED_UNAVAILABLE,
    });
    const result = await provider.lookup(lookupArgs({ indicator: "198.51.100.77" }));
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE);
  });
});

describe("MockProvider — determinism and isolation", () => {
  it("returns deep-equal results for repeated calls with the same input", async () => {
    const provider = createMockIocEnrichmentProvider({
      fixtures: { [IP]: { scenario: MOCK_SCENARIOS.SUCCESS_MEDIUM_CONFIDENCE } },
    });
    const first = await provider.lookup(lookupArgs());
    const second = await provider.lookup(lookupArgs());
    expect(first).toEqual(second);
  });

  it("queriedAt exactly equals the caller's asOf, proving no wall-clock read", async () => {
    const provider = createMockIocEnrichmentProvider({
      fixtures: { [IP]: { scenario: MOCK_SCENARIOS.SUCCESS_LOW_CONFIDENCE } },
    });
    const farFutureAsOf = new Date("2099-01-01T00:00:00Z");
    const result = await provider.lookup(lookupArgs({ asOf: farFutureAsOf }));
    expect(result.queriedAt.getTime()).toBe(farFutureAsOf.getTime());
  });

  it("never calls the global fetch function", async () => {
    if (typeof global.fetch !== "function") return; // environment without global fetch
    const fetchSpy = vi.spyOn(global, "fetch");
    const provider = createMockIocEnrichmentProvider({
      fixtures: { [IP]: { scenario: MOCK_SCENARIOS.SUCCESS_LOW_CONFIDENCE } },
    });
    await provider.lookup(lookupArgs());
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("never writes to the console, across success and every failure scenario", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const scenarioIndicators = Object.values(MOCK_SCENARIOS).map(
        (scenario, index) => [`203.0.114.${index + 1}`, scenario]
      );
      const fixtures = Object.fromEntries(
        scenarioIndicators.map(([indicator, scenario]) => [indicator, { scenario }])
      );
      const provider = createMockIocEnrichmentProvider({ fixtures });

      // eslint-disable-next-line no-restricted-syntax
      for (const [indicator] of scenarioIndicators) {
        // eslint-disable-next-line no-await-in-loop
        await provider.lookup(lookupArgs({ indicator }));
      }
      await provider.lookup(lookupArgs({ indicatorType: "IPV6", indicator: "2001:db8::1" }));
      await provider.lookup({}).catch(() => {}); // the thrown-TypeError path too
    } finally {
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("call count increments per lookup and is independent across separate provider instances", async () => {
    const providerA = createMockIocEnrichmentProvider();
    const providerB = createMockIocEnrichmentProvider();

    expect(providerA.getCallCount()).toBe(0);
    await providerA.lookup(lookupArgs());
    await providerA.lookup(lookupArgs({ indicator: "198.51.100.5" }));
    expect(providerA.getCallCount()).toBe(2);
    expect(providerB.getCallCount()).toBe(0);
  });

  it("mutating the original fixtures object after construction does not alter later results", async () => {
    const fixtures = { [IP]: { scenario: MOCK_SCENARIOS.SUCCESS_LOW_CONFIDENCE } };
    const provider = createMockIocEnrichmentProvider({ fixtures });

    // Mutate the caller's own object after handing it to the constructor.
    fixtures[IP].scenario = MOCK_SCENARIOS.FAILED_UNAVAILABLE;
    fixtures[IP].data = { abuseConfidenceScore: 99, totalReports: 999 };

    const result = await provider.lookup(lookupArgs());
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.abuseConfidenceScore).toBe(10);
  });

  it("rejects a non-object fixtures config at construction time", () => {
    expect(() => createMockIocEnrichmentProvider({ fixtures: "not-an-object" })).toThrow(TypeError);
  });
});
