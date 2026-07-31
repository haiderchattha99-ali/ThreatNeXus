import { describe, it, expect } from "vitest";

const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
  PROVIDER_ERROR_MESSAGES,
  MAX_TEXT_FIELD_LENGTH,
  MAX_RETRY_AFTER_SECONDS,
  createEnrichmentResult,
  sanitizeQueryParams,
} = require("../../src/services/enrichment/iocEnrichmentTypes");

const ASOF = new Date("2026-06-01T00:00:00Z");

function baseSuccessInput(overrides = {}) {
  return {
    provider: "mock",
    indicatorType: "IPV4",
    indicator: "203.0.113.10",
    status: ENRICHMENT_STATUS.SUCCESS,
    queriedAt: ASOF,
    data: { abuseConfidenceScore: 42, totalReports: 5 },
    ...overrides,
  };
}

describe("createEnrichmentResult — valid SUCCESS", () => {
  it("builds a fully normalized SUCCESS result with defaults for omitted optional data fields", () => {
    const result = createEnrichmentResult(baseSuccessInput());

    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.provider).toBe("mock");
    expect(result.indicatorType).toBe("IPV4");
    expect(result.indicator).toBe("203.0.113.10");
    expect(result.queriedAt).toEqual(ASOF);
    expect(result.expiresAt).toBeNull();
    expect(result.errorInfo).toBeNull();
    expect(result.retryAfterSeconds).toBeNull();
    expect(result.data).toMatchObject({
      abuseConfidenceScore: 42,
      totalReports: 5,
      countryCode: null,
      isp: null,
      domain: null,
      usageType: null,
      isWhitelisted: null,
      lastReportedAt: null,
    });
  });

  it("accepts and normalizes a fully populated data payload", () => {
    const lastReportedAt = new Date("2026-05-30T12:00:00Z");
    const result = createEnrichmentResult(
      baseSuccessInput({
        data: {
          abuseConfidenceScore: 87,
          totalReports: 34,
          countryCode: "US",
          isp: "  Example ISP  ",
          domain: "example.test",
          usageType: "Data Center",
          isWhitelisted: false,
          lastReportedAt,
        },
      })
    );

    expect(result.data.countryCode).toBe("US");
    expect(result.data.isp).toBe("Example ISP");
    expect(result.data.isWhitelisted).toBe(false);
    expect(result.data.lastReportedAt).toEqual(lastReportedAt);
    // The stored Date must be a fresh instance, not the caller's own object.
    expect(result.data.lastReportedAt).not.toBe(lastReportedAt);
  });
});

describe("createEnrichmentResult — abuseConfidenceScore boundaries", () => {
  it("accepts 0 and 100", () => {
    expect(
      createEnrichmentResult(baseSuccessInput({ data: { abuseConfidenceScore: 0, totalReports: 0 } }))
        .data.abuseConfidenceScore
    ).toBe(0);
    expect(
      createEnrichmentResult(baseSuccessInput({ data: { abuseConfidenceScore: 100, totalReports: 0 } }))
        .data.abuseConfidenceScore
    ).toBe(100);
  });

  it("rejects a score below 0, above 100, or non-integer", () => {
    expect(() =>
      createEnrichmentResult(baseSuccessInput({ data: { abuseConfidenceScore: -1, totalReports: 0 } }))
    ).toThrow(TypeError);
    expect(() =>
      createEnrichmentResult(baseSuccessInput({ data: { abuseConfidenceScore: 101, totalReports: 0 } }))
    ).toThrow(TypeError);
    expect(() =>
      createEnrichmentResult(baseSuccessInput({ data: { abuseConfidenceScore: 42.5, totalReports: 0 } }))
    ).toThrow(TypeError);
  });
});

describe("createEnrichmentResult — totalReports", () => {
  it("rejects a negative or non-integer totalReports", () => {
    expect(() =>
      createEnrichmentResult(baseSuccessInput({ data: { abuseConfidenceScore: 1, totalReports: -1 } }))
    ).toThrow(TypeError);
    expect(() =>
      createEnrichmentResult(baseSuccessInput({ data: { abuseConfidenceScore: 1, totalReports: 1.5 } }))
    ).toThrow(TypeError);
  });
});

describe("createEnrichmentResult — countryCode", () => {
  it("accepts null and a valid two-letter uppercase code", () => {
    expect(
      createEnrichmentResult(
        baseSuccessInput({ data: { abuseConfidenceScore: 1, totalReports: 1, countryCode: null } })
      ).data.countryCode
    ).toBeNull();
    expect(
      createEnrichmentResult(
        baseSuccessInput({ data: { abuseConfidenceScore: 1, totalReports: 1, countryCode: "GB" } })
      ).data.countryCode
    ).toBe("GB");
  });

  it("rejects a lowercase, three-letter, or malformed country code", () => {
    ["gb", "USA", "12", ""].forEach((countryCode) => {
      expect(() =>
        createEnrichmentResult(
          baseSuccessInput({ data: { abuseConfidenceScore: 1, totalReports: 1, countryCode } })
        )
      ).toThrow(TypeError);
    });
  });
});

describe("createEnrichmentResult — partial data prohibited on non-success status", () => {
  it("rejects any status other than SUCCESS if it carries data", () => {
    expect(() =>
      createEnrichmentResult({
        provider: "mock",
        indicatorType: "IPV4",
        indicator: "203.0.113.10",
        status: ENRICHMENT_STATUS.NOT_FOUND,
        queriedAt: ASOF,
        data: { abuseConfidenceScore: 1, totalReports: 1 },
      })
    ).toThrow(TypeError);
  });

  it("rejects SUCCESS without valid data", () => {
    expect(() =>
      createEnrichmentResult({
        provider: "mock",
        indicatorType: "IPV4",
        indicator: "203.0.113.10",
        status: ENRICHMENT_STATUS.SUCCESS,
        queriedAt: ASOF,
        data: null,
      })
    ).toThrow(TypeError);
  });
});

describe("createEnrichmentResult — closed error code/message mapping", () => {
  it("derives errorInfo.message from the closed map for every defined code", () => {
    Object.values(PROVIDER_ERROR_CODES).forEach((code) => {
      const result = createEnrichmentResult({
        provider: "mock",
        indicatorType: "IPV4",
        indicator: "203.0.113.10",
        status: ENRICHMENT_STATUS.FAILED,
        queriedAt: ASOF,
        errorInfo: { code },
      });
      expect(result.errorInfo).toEqual({ code, message: PROVIDER_ERROR_MESSAGES[code] });
    });
  });

  it("ignores a caller-supplied message and always uses the map's fixed message", () => {
    const result = createEnrichmentResult({
      provider: "mock",
      indicatorType: "IPV4",
      indicator: "203.0.113.10",
      status: ENRICHMENT_STATUS.FAILED,
      queriedAt: ASOF,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE, message: "raw injected text" },
    });
    expect(result.errorInfo.message).toBe(PROVIDER_ERROR_MESSAGES[PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE]);
    expect(JSON.stringify(result)).not.toContain("raw injected text");
  });

  it("rejects an unknown error code", () => {
    expect(() =>
      createEnrichmentResult({
        provider: "mock",
        indicatorType: "IPV4",
        indicator: "203.0.113.10",
        status: ENRICHMENT_STATUS.FAILED,
        queriedAt: ASOF,
        errorInfo: { code: "NOT_A_REAL_CODE" },
      })
    ).toThrow(TypeError);
  });

  it("requires errorInfo for a status that mandates it, and rejects errorInfo on SUCCESS", () => {
    expect(() =>
      createEnrichmentResult({
        provider: "mock",
        indicatorType: "IPV4",
        indicator: "203.0.113.10",
        status: ENRICHMENT_STATUS.TIMEOUT,
        queriedAt: ASOF,
      })
    ).toThrow(TypeError);
    expect(() =>
      createEnrichmentResult(
        baseSuccessInput({ errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT } })
      )
    ).toThrow(TypeError);
  });
});

describe("createEnrichmentResult — retryAfterSeconds bounds", () => {
  it("accepts null, 0, and the maximum bound", () => {
    const withCode = (retryAfterSeconds) =>
      createEnrichmentResult({
        provider: "mock",
        indicatorType: "IPV4",
        indicator: "203.0.113.10",
        status: ENRICHMENT_STATUS.RATE_LIMITED,
        queriedAt: ASOF,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED },
        retryAfterSeconds,
      });
    expect(withCode(null).retryAfterSeconds).toBeNull();
    expect(withCode(0).retryAfterSeconds).toBe(0);
    expect(withCode(MAX_RETRY_AFTER_SECONDS).retryAfterSeconds).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it("rejects a negative value, a value beyond the bound, and a non-number", () => {
    const withCode = (retryAfterSeconds) =>
      createEnrichmentResult({
        provider: "mock",
        indicatorType: "IPV4",
        indicator: "203.0.113.10",
        status: ENRICHMENT_STATUS.RATE_LIMITED,
        queriedAt: ASOF,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED },
        retryAfterSeconds,
      });
    expect(() => withCode(-1)).toThrow(TypeError);
    expect(() => withCode(MAX_RETRY_AFTER_SECONDS + 1)).toThrow(TypeError);
    expect(() => withCode("60")).toThrow(TypeError);
  });
});

describe("createEnrichmentResult — bounded text fields", () => {
  it("trims and truncates isp/domain/usageType at the provider boundary", () => {
    const longValue = `  ${"a".repeat(MAX_TEXT_FIELD_LENGTH + 50)}  `;
    const result = createEnrichmentResult(
      baseSuccessInput({
        data: { abuseConfidenceScore: 1, totalReports: 1, isp: longValue, domain: longValue, usageType: longValue },
      })
    );
    expect(result.data.isp).toHaveLength(MAX_TEXT_FIELD_LENGTH);
    expect(result.data.domain).toHaveLength(MAX_TEXT_FIELD_LENGTH);
    expect(result.data.usageType).toHaveLength(MAX_TEXT_FIELD_LENGTH);
    expect(result.data.isp.startsWith(" ")).toBe(false);
  });

  it("normalizes an empty/whitespace-only text field to null", () => {
    const result = createEnrichmentResult(
      baseSuccessInput({ data: { abuseConfidenceScore: 1, totalReports: 1, isp: "   " } })
    );
    expect(result.data.isp).toBeNull();
  });
});

describe("createEnrichmentResult — queriedAt/expiresAt", () => {
  it("requires an explicit, valid queriedAt Date", () => {
    expect(() => createEnrichmentResult(baseSuccessInput({ queriedAt: "2026-06-01T00:00:00Z" }))).toThrow(
      TypeError
    );
    expect(() => createEnrichmentResult(baseSuccessInput({ queriedAt: new Date("not-a-date") }))).toThrow(
      TypeError
    );
  });

  it("rejects an invalid expiresAt but accepts null/omitted", () => {
    expect(() =>
      createEnrichmentResult(baseSuccessInput({ expiresAt: new Date("not-a-date") }))
    ).toThrow(TypeError);
    expect(createEnrichmentResult(baseSuccessInput({ expiresAt: null })).expiresAt).toBeNull();
  });
});

describe("createEnrichmentResult — httpStatus", () => {
  it("accepts null and a valid HTTP status integer, rejects out-of-range values", () => {
    expect(createEnrichmentResult(baseSuccessInput({ httpStatus: null })).httpStatus).toBeNull();
    expect(createEnrichmentResult(baseSuccessInput({ httpStatus: 200 })).httpStatus).toBe(200);
    expect(() => createEnrichmentResult(baseSuccessInput({ httpStatus: 99 }))).toThrow(TypeError);
    expect(() => createEnrichmentResult(baseSuccessInput({ httpStatus: 600 }))).toThrow(TypeError);
  });
});

describe("createEnrichmentResult — immutability", () => {
  it("returns a deeply frozen result", () => {
    const result = createEnrichmentResult(baseSuccessInput());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.data)).toBe(true);
    expect(Object.isFrozen(result.queryParams)).toBe(true);
    expect(() => {
      result.status = "TAMPERED";
    }).toThrow();
    expect(() => {
      result.data.abuseConfidenceScore = 999;
    }).toThrow();
  });
});

describe("sanitizeQueryParams — allow-list", () => {
  it("keeps only maxAgeInDays and drops any other key", () => {
    const sanitized = sanitizeQueryParams({ maxAgeInDays: 30, unknownField: "dropped" });
    expect(sanitized).toEqual({ maxAgeInDays: 30 });
    expect(Object.prototype.hasOwnProperty.call(sanitized, "unknownField")).toBe(false);
  });

  it("returns a frozen empty object for null/undefined input", () => {
    expect(sanitizeQueryParams(null)).toEqual({});
    expect(Object.isFrozen(sanitizeQueryParams(undefined))).toBe(true);
  });

  it("rejects a non-positive-integer maxAgeInDays", () => {
    expect(() => sanitizeQueryParams({ maxAgeInDays: 0 })).toThrow(TypeError);
    expect(() => sanitizeQueryParams({ maxAgeInDays: -5 })).toThrow(TypeError);
    expect(() => sanitizeQueryParams({ maxAgeInDays: "30" })).toThrow(TypeError);
  });
});
