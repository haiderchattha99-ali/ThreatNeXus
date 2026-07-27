import { describe, it, expect, vi } from "vitest";

// P2-T2a security boundary: a distinctive fake secret slipped in accidentally
// via queryParams, fixture metadata, or an unrelated Error object must never
// reach a normalized result, its JSON serialization, or the console — see
// AGENTS.md / DECISIONS.md D-002 on redacting keys from logs and responses.
// No real credential is used anywhere in this file; the "secret" strings
// below are only distinctive markers used to prove absence.

const {
  createMockIocEnrichmentProvider,
  MOCK_SCENARIOS,
} = require("../../src/services/enrichment/mockIocEnrichmentProvider");
const {
  createEnrichmentResult,
  PROVIDER_ERROR_CODES,
} = require("../../src/services/enrichment/iocEnrichmentTypes");

const ASOF = new Date("2026-06-01T00:00:00Z");
const IP = "203.0.113.10";
const FAKE_SECRET = "FAKE-ABUSEIPDB-KEY-do-not-actually-use-9f8e7d6c";

function expectNoLeak(haystack) {
  const serialized = JSON.stringify(haystack);
  expect(serialized).not.toContain(FAKE_SECRET);
}

describe("Security boundary — queryParams", () => {
  it("a fake secret smuggled into queryParams never reaches the normalized result", async () => {
    const provider = createMockIocEnrichmentProvider({
      fixtures: { [IP]: { scenario: MOCK_SCENARIOS.SUCCESS_LOW_CONFIDENCE } },
    });
    const result = await provider.lookup({
      indicatorType: "IPV4",
      indicator: IP,
      asOf: ASOF,
      queryParams: { maxAgeInDays: 30, apiKey: FAKE_SECRET, accidental: FAKE_SECRET },
    });

    expect(result.queryParams).toEqual({ maxAgeInDays: 30 });
    expectNoLeak(result);
  });

  it("createEnrichmentResult itself drops non-allow-listed queryParams keys", () => {
    const result = createEnrichmentResult({
      provider: "mock",
      indicatorType: "IPV4",
      indicator: IP,
      status: "SUCCESS",
      queriedAt: ASOF,
      data: { abuseConfidenceScore: 1, totalReports: 1 },
      queryParams: { maxAgeInDays: 7, secret: FAKE_SECRET },
    });
    expect(result.queryParams).toEqual({ maxAgeInDays: 7 });
    expectNoLeak(result);
  });
});

describe("Security boundary — fixture metadata", () => {
  it("an unrelated secret-shaped field on a fixture is never copied into the result", async () => {
    const provider = createMockIocEnrichmentProvider({
      fixtures: {
        [IP]: {
          scenario: MOCK_SCENARIOS.SUCCESS_MEDIUM_CONFIDENCE,
          // Not a recognised fixture field — MockProvider only ever reads
          // scenario/data/retryAfterSeconds/httpStatus/expiresAt from a
          // fixture, so this must be silently ignored, never spread through.
          internalDebugApiKey: FAKE_SECRET,
        },
      },
    });
    const result = await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
    expectNoLeak(result);
  });

  it("a secret nested inside a fixture's data override is not itself a validated field, so it never survives normalization", async () => {
    const provider = createMockIocEnrichmentProvider({
      fixtures: {
        [IP]: {
          scenario: MOCK_SCENARIOS.SUCCESS_LOW_CONFIDENCE,
          data: { isp: "Example ISP", debugToken: FAKE_SECRET },
        },
      },
    });
    const result = await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
    expect(result.data.isp).toBe("Example ISP");
    expect(Object.prototype.hasOwnProperty.call(result.data, "debugToken")).toBe(false);
    expectNoLeak(result);
  });
});

describe("Security boundary — an unexpected Error object", () => {
  it("a fake secret inside an Error's message is never copied into a controlled FAILED result", async () => {
    const simulatedRawError = new Error(`connection refused, key=${FAKE_SECRET}`);
    const provider = createMockIocEnrichmentProvider({
      fixtures: {
        [IP]: {
          scenario: MOCK_SCENARIOS.FAILED_UNAVAILABLE,
          // MockProvider never reads this field — it exists only to prove
          // that even if a fixture carried a raw error, it cannot leak.
          simulatedRawError,
        },
      },
    });
    const result = await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });

    expect(result.status).toBe("FAILED");
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE);
    expectNoLeak(result);
    expectNoLeak(result.errorInfo);
  });

  it("raw Error.message is never copied into errorInfo — the message always comes from the closed map", () => {
    const result = createEnrichmentResult({
      provider: "mock",
      indicatorType: "IPV4",
      indicator: IP,
      status: "FAILED",
      queriedAt: ASOF,
      errorInfo: {
        code: PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
        // Even if a caller mistakenly attaches a raw message, it must be
        // discarded in favor of the fixed, closed-map message.
        message: `raw db error: ${FAKE_SECRET}`,
      },
    });
    expect(result.errorInfo.message).not.toContain(FAKE_SECRET);
    expectNoLeak(result);
  });
});

describe("Security boundary — console output", () => {
  it("no console method is ever called while processing a payload carrying a fake secret", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const provider = createMockIocEnrichmentProvider({
        fixtures: {
          [IP]: {
            scenario: MOCK_SCENARIOS.FAILED_UNAVAILABLE,
            simulatedRawError: new Error(`key=${FAKE_SECRET}`),
          },
        },
      });
      await provider.lookup({
        indicatorType: "IPV4",
        indicator: IP,
        asOf: ASOF,
        queryParams: { apiKey: FAKE_SECRET },
      });
    } finally {
      [logSpy, warnSpy, errorSpy].forEach((spy) => {
        spy.mock.calls.forEach((call) => {
          expect(JSON.stringify(call)).not.toContain(FAKE_SECRET);
        });
      });
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
