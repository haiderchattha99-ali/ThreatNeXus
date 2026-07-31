import { describe, it, expect } from "vitest";

const {
  IocEnrichmentValidationError,
  TERMINAL_STATUSES,
  TERMINAL_RESULT_COLUMNS,
  DEFAULT_PENDING_BATCH_SIZE,
  MAX_PENDING_BATCH_SIZE,
  MIN_LEASE_MS,
  MAX_LEASE_MS,
  isTerminalStatus,
  isFreshTerminalRecord,
  isClaimableRecord,
  buildTerminalFields,
  boundBatchSize,
  assertValidLeaseMs,
} = require("../../src/services/enrichment/iocEnrichmentCacheRules");
const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
  PROVIDER_ERROR_MESSAGES,
  createEnrichmentResult,
} = require("../../src/services/enrichment/iocEnrichmentTypes");

const QUERIED_AT = new Date("2026-07-28T12:00:00.000Z");

function successResult(overrides = {}) {
  return createEnrichmentResult({
    provider: "mock",
    indicatorType: "IPV4",
    indicator: "198.18.0.10",
    status: ENRICHMENT_STATUS.SUCCESS,
    queriedAt: QUERIED_AT,
    httpStatus: 200,
    data: {
      abuseConfidenceScore: 0,
      totalReports: 0,
      countryCode: "SE",
      isp: "Example ISP",
      domain: "example.test",
      usageType: "Data Center",
      isWhitelisted: false,
      lastReportedAt: new Date("2026-07-01T00:00:00.000Z"),
      ...overrides,
    },
  });
}

describe("iocEnrichmentCacheRules — status taxonomy", () => {
  it("treats PENDING as the one non-terminal status", () => {
    expect(isTerminalStatus(ENRICHMENT_STATUS.PENDING)).toBe(false);
    expect(TERMINAL_STATUSES).not.toContain(ENRICHMENT_STATUS.PENDING);
    expect(TERMINAL_STATUSES).toHaveLength(8);
    [
      ENRICHMENT_STATUS.SUCCESS,
      ENRICHMENT_STATUS.NOT_FOUND,
      ENRICHMENT_STATUS.RATE_LIMITED,
      ENRICHMENT_STATUS.INVALID_KEY,
      ENRICHMENT_STATUS.TIMEOUT,
      ENRICHMENT_STATUS.FAILED,
      ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR,
      ENRICHMENT_STATUS.SKIPPED_DISABLED,
    ].forEach((status) => expect(isTerminalStatus(status)).toBe(true));
  });
});

describe("iocEnrichmentCacheRules — freshness boundaries", () => {
  const asOf = new Date("2026-07-28T12:00:00.000Z");
  const base = { status: ENRICHMENT_STATUS.SUCCESS, queriedAt: QUERIED_AT };

  it("is fresh strictly before expiresAt (half-open window)", () => {
    expect(
      isFreshTerminalRecord({ ...base, expiresAt: new Date(asOf.getTime() + 1) }, asOf)
    ).toBe(true);
  });

  it("is NOT fresh at exactly expiresAt", () => {
    expect(isFreshTerminalRecord({ ...base, expiresAt: new Date(asOf.getTime()) }, asOf)).toBe(false);
  });

  it("is NOT fresh after expiresAt", () => {
    expect(
      isFreshTerminalRecord({ ...base, expiresAt: new Date(asOf.getTime() - 1) }, asOf)
    ).toBe(false);
  });

  it("a missing expiresAt is never fresh, for success or failure alike", () => {
    expect(isFreshTerminalRecord({ ...base, expiresAt: null }, asOf)).toBe(false);
    expect(
      isFreshTerminalRecord(
        { status: ENRICHMENT_STATUS.RATE_LIMITED, queriedAt: QUERIED_AT, expiresAt: null },
        asOf
      )
    ).toBe(false);
  });

  it("PENDING is never fresh even with a future expiresAt", () => {
    expect(
      isFreshTerminalRecord(
        {
          status: ENRICHMENT_STATUS.PENDING,
          queriedAt: QUERIED_AT,
          expiresAt: new Date(asOf.getTime() + 3600000),
        },
        asOf
      )
    ).toBe(false);
  });

  it("caches negative statuses with their own expiry, exactly like a success", () => {
    [
      ENRICHMENT_STATUS.NOT_FOUND,
      ENRICHMENT_STATUS.RATE_LIMITED,
      ENRICHMENT_STATUS.INVALID_KEY,
      ENRICHMENT_STATUS.TIMEOUT,
      ENRICHMENT_STATUS.FAILED,
      ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR,
      ENRICHMENT_STATUS.SKIPPED_DISABLED,
    ].forEach((status) => {
      expect(
        isFreshTerminalRecord(
          { status, queriedAt: QUERIED_AT, expiresAt: new Date(asOf.getTime() + 1000) },
          asOf
        )
      ).toBe(true);
    });
  });

  it("requires an explicit asOf — never falls back to the wall clock", () => {
    expect(() => isFreshTerminalRecord({ ...base, expiresAt: asOf }, undefined)).toThrow(
      IocEnrichmentValidationError
    );
  });
});

describe("iocEnrichmentCacheRules — claimability", () => {
  const now = new Date("2026-07-28T12:00:00.000Z");

  it("an unclaimed PENDING row is claimable", () => {
    expect(
      isClaimableRecord({ status: ENRICHMENT_STATUS.PENDING, claimToken: null, leaseExpiresAt: null }, now)
    ).toBe(true);
  });

  it("a live lease is not claimable", () => {
    expect(
      isClaimableRecord(
        {
          status: ENRICHMENT_STATUS.PENDING,
          claimToken: "t",
          leaseExpiresAt: new Date(now.getTime() + 1),
        },
        now
      )
    ).toBe(false);
  });

  it("a lease expiring exactly now is reclaimable (inclusive boundary)", () => {
    expect(
      isClaimableRecord(
        { status: ENRICHMENT_STATUS.PENDING, claimToken: "t", leaseExpiresAt: new Date(now.getTime()) },
        now
      )
    ).toBe(true);
  });

  it("a terminal row is never claimable", () => {
    expect(
      isClaimableRecord({ status: ENRICHMENT_STATUS.SUCCESS, claimToken: null, leaseExpiresAt: null }, now)
    ).toBe(false);
  });
});

describe("iocEnrichmentCacheRules — buildTerminalFields", () => {
  it("projects a SUCCESS result onto exactly the allow-listed columns", () => {
    const fields = buildTerminalFields(successResult({ abuseConfidenceScore: 95, totalReports: 150 }));
    expect(Object.keys(fields).sort()).toEqual([...TERMINAL_RESULT_COLUMNS].sort());
    expect(fields).toEqual({
      abuseConfidenceScore: 95,
      totalReports: 150,
      countryCode: "SE",
      isp: "Example ISP",
      domain: "example.test",
      usageType: "Data Center",
      isWhitelisted: false,
      lastReportedAt: new Date("2026-07-01T00:00:00.000Z"),
      httpStatus: 200,
      errorCode: null,
      errorMessage: null,
      retryAfterSeconds: null,
    });
  });

  it("keeps a successful score of 0 distinguishable from no data", () => {
    const fields = buildTerminalFields(successResult({ abuseConfidenceScore: 0, totalReports: 0 }));
    expect(fields.abuseConfidenceScore).toBe(0);
    expect(fields.totalReports).toBe(0);
    expect(fields.errorCode).toBeNull();
  });

  it("writes null into every SUCCESS-payload column for a failure — no partial data", () => {
    const failure = createEnrichmentResult({
      provider: "mock",
      indicatorType: "IPV4",
      indicator: "198.18.0.10",
      status: ENRICHMENT_STATUS.RATE_LIMITED,
      queriedAt: QUERIED_AT,
      httpStatus: 429,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED },
      retryAfterSeconds: 3600,
    });
    const fields = buildTerminalFields(failure);
    expect(fields.abuseConfidenceScore).toBeNull();
    expect(fields.totalReports).toBeNull();
    expect(fields.countryCode).toBeNull();
    expect(fields.isp).toBeNull();
    expect(fields.domain).toBeNull();
    expect(fields.usageType).toBeNull();
    expect(fields.isWhitelisted).toBeNull();
    expect(fields.lastReportedAt).toBeNull();
    expect(fields.httpStatus).toBe(429);
    expect(fields.errorCode).toBe(PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED);
    expect(fields.retryAfterSeconds).toBe(3600);
  });

  it("re-derives errorMessage from the closed map, never from the result object", () => {
    const failure = createEnrichmentResult({
      provider: "mock",
      indicatorType: "IPV4",
      indicator: "198.18.0.10",
      status: ENRICHMENT_STATUS.FAILED,
      queriedAt: QUERIED_AT,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE },
    });

    // A tampered result carrying a raw Error message / secret in `message`.
    const SECRET = "Bearer abuseipdb-live-key";
    const tampered = {
      ...failure,
      errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE, message: `ECONNRESET ${SECRET}` },
    };

    const fields = buildTerminalFields(tampered);
    expect(fields.errorMessage).toBe(
      PROVIDER_ERROR_MESSAGES[PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE]
    );
    expect(JSON.stringify(fields)).not.toContain(SECRET);
    expect(JSON.stringify(fields)).not.toContain("ECONNRESET");
  });

  it("never emits a rawResponse-like column", () => {
    const fields = buildTerminalFields(successResult());
    expect(Object.keys(fields)).not.toContain("rawResponse");
    expect(Object.keys(fields)).not.toContain("apiKey");
    expect(Object.keys(fields)).not.toContain("headers");
  });

  it("rounds a fractional retryAfterSeconds up, never down", () => {
    const failure = {
      ...createEnrichmentResult({
        provider: "mock",
        indicatorType: "IPV4",
        indicator: "198.18.0.10",
        status: ENRICHMENT_STATUS.TIMEOUT,
        queriedAt: QUERIED_AT,
        errorInfo: { code: PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT },
        retryAfterSeconds: 1.2,
      }),
    };
    expect(buildTerminalFields(failure).retryAfterSeconds).toBe(2);
  });

  it("rejects a PENDING or unknown status", () => {
    expect(() => buildTerminalFields({ status: ENRICHMENT_STATUS.PENDING })).toThrow(
      IocEnrichmentValidationError
    );
    expect(() => buildTerminalFields({ status: "NOPE" })).toThrow(IocEnrichmentValidationError);
    expect(() => buildTerminalFields(null)).toThrow(IocEnrichmentValidationError);
  });

  it("rejects an unknown provider error code", () => {
    expect(() =>
      buildTerminalFields({
        status: ENRICHMENT_STATUS.FAILED,
        errorInfo: { code: "MADE_UP_CODE" },
        data: null,
      })
    ).toThrow(IocEnrichmentValidationError);
  });
});

describe("iocEnrichmentCacheRules — bounds", () => {
  it("defaults and caps the pending batch size", () => {
    expect(boundBatchSize(null)).toBe(DEFAULT_PENDING_BATCH_SIZE);
    expect(boundBatchSize(5)).toBe(5);
    expect(boundBatchSize(MAX_PENDING_BATCH_SIZE + 1000)).toBe(MAX_PENDING_BATCH_SIZE);
    expect(() => boundBatchSize(0)).toThrow(IocEnrichmentValidationError);
    expect(() => boundBatchSize(-1)).toThrow(IocEnrichmentValidationError);
  });

  it("bounds the lease duration", () => {
    expect(assertValidLeaseMs(MIN_LEASE_MS)).toBe(MIN_LEASE_MS);
    expect(assertValidLeaseMs(MAX_LEASE_MS)).toBe(MAX_LEASE_MS);
    expect(() => assertValidLeaseMs(MIN_LEASE_MS - 1)).toThrow(IocEnrichmentValidationError);
    expect(() => assertValidLeaseMs(MAX_LEASE_MS + 1)).toThrow(IocEnrichmentValidationError);
    expect(() => assertValidLeaseMs(1.5)).toThrow(IocEnrichmentValidationError);
  });
});
