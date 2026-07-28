import { describe, it, expect } from "vitest";

// P2-T2c — the pure IOC enrichment TTL policy. No wall clock anywhere in
// this file's expectations: every assertion is arithmetic against an
// explicit `queriedAt`, never Date.now().

const {
  EnrichmentTtlPolicyError,
  ABSOLUTE_MIN_TTL_SECONDS,
  ABSOLUTE_MAX_TTL_SECONDS,
  resolveEnrichmentTtl,
} = require("../../src/services/enrichment/enrichmentTtlPolicy");
const { ENRICHMENT_STATUS } = require("../../src/services/enrichment/iocEnrichmentTypes");

const QUERIED_AT = new Date("2026-06-01T00:00:00Z");

function expiresAtPlusSeconds(seconds) {
  return new Date(QUERIED_AT.getTime() + seconds * 1000);
}

describe("resolveEnrichmentTtl — every terminal status has a conservative default", () => {
  const expected = {
    [ENRICHMENT_STATUS.SUCCESS]: 24 * 3600,
    [ENRICHMENT_STATUS.NOT_FOUND]: 6 * 3600,
    [ENRICHMENT_STATUS.INVALID_KEY]: 15 * 60,
    [ENRICHMENT_STATUS.TIMEOUT]: 5 * 60,
    [ENRICHMENT_STATUS.FAILED]: 5 * 60,
    [ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR]: 24 * 3600,
    [ENRICHMENT_STATUS.SKIPPED_DISABLED]: 15 * 60,
  };

  Object.entries(expected).forEach(([status, ttlSeconds]) => {
    it(`${status} -> ${ttlSeconds}s`, () => {
      const result = resolveEnrichmentTtl({ status, queriedAt: QUERIED_AT });
      expect(result.ttlSeconds).toBe(ttlSeconds);
      expect(result.expiresAt.getTime()).toBe(expiresAtPlusSeconds(ttlSeconds).getTime());
      expect(result.policyReason).toBe(`${status}_DEFAULT`);
    });
  });
});

describe("resolveEnrichmentTtl — RATE_LIMITED", () => {
  it("uses retryAfterSeconds when within the floor/cap window", () => {
    const result = resolveEnrichmentTtl({
      status: ENRICHMENT_STATUS.RATE_LIMITED,
      queriedAt: QUERIED_AT,
      retryAfterSeconds: 3600,
    });
    expect(result.ttlSeconds).toBe(3600);
    expect(result.policyReason).toBe("RATE_LIMITED_RETRY_AFTER");
    expect(result.expiresAt.getTime()).toBe(expiresAtPlusSeconds(3600).getTime());
  });

  it("floors a short retryAfterSeconds to the 15-minute minimum", () => {
    const result = resolveEnrichmentTtl({
      status: ENRICHMENT_STATUS.RATE_LIMITED,
      queriedAt: QUERIED_AT,
      retryAfterSeconds: 30,
    });
    expect(result.ttlSeconds).toBe(15 * 60);
    expect(result.policyReason).toBe("RATE_LIMITED_FLOORED_TO_MINIMUM");
  });

  it("caps a very large retryAfterSeconds at 24 hours", () => {
    const result = resolveEnrichmentTtl({
      status: ENRICHMENT_STATUS.RATE_LIMITED,
      queriedAt: QUERIED_AT,
      retryAfterSeconds: 86400 * 10,
    });
    expect(result.ttlSeconds).toBe(24 * 3600);
    expect(result.policyReason).toBe("RATE_LIMITED_CAPPED_TO_MAXIMUM");
  });

  it("uses the 15-minute floor when retryAfterSeconds is null (no header present)", () => {
    const result = resolveEnrichmentTtl({
      status: ENRICHMENT_STATUS.RATE_LIMITED,
      queriedAt: QUERIED_AT,
      retryAfterSeconds: null,
    });
    expect(result.ttlSeconds).toBe(15 * 60);
  });

  it("rounds a fractional retryAfterSeconds up, never shortening the effective backoff", () => {
    const result = resolveEnrichmentTtl({
      status: ENRICHMENT_STATUS.RATE_LIMITED,
      queriedAt: QUERIED_AT,
      retryAfterSeconds: 1800.2,
    });
    expect(result.ttlSeconds).toBe(1801);
  });
});

describe("resolveEnrichmentTtl — invariants", () => {
  it("rejects PENDING", () => {
    expect(() => resolveEnrichmentTtl({ status: ENRICHMENT_STATUS.PENDING, queriedAt: QUERIED_AT })).toThrow(
      EnrichmentTtlPolicyError
    );
  });

  it("rejects an unknown status", () => {
    expect(() => resolveEnrichmentTtl({ status: "NOT_A_REAL_STATUS", queriedAt: QUERIED_AT })).toThrow(
      EnrichmentTtlPolicyError
    );
  });

  it("requires an explicit, valid queriedAt", () => {
    expect(() => resolveEnrichmentTtl({ status: ENRICHMENT_STATUS.SUCCESS })).toThrow(EnrichmentTtlPolicyError);
    expect(() =>
      resolveEnrichmentTtl({ status: ENRICHMENT_STATUS.SUCCESS, queriedAt: "2026-06-01" })
    ).toThrow(EnrichmentTtlPolicyError);
    expect(() =>
      resolveEnrichmentTtl({ status: ENRICHMENT_STATUS.SUCCESS, queriedAt: new Date("not-a-date") })
    ).toThrow(EnrichmentTtlPolicyError);
  });

  it("rejects a negative retryAfterSeconds", () => {
    expect(() =>
      resolveEnrichmentTtl({ status: ENRICHMENT_STATUS.RATE_LIMITED, queriedAt: QUERIED_AT, retryAfterSeconds: -1 })
    ).toThrow(EnrichmentTtlPolicyError);
  });

  it("every resolved ttlSeconds is a positive bounded integer", () => {
    Object.values(ENRICHMENT_STATUS)
      .filter((status) => status !== ENRICHMENT_STATUS.PENDING)
      .forEach((status) => {
        const result = resolveEnrichmentTtl({ status, queriedAt: QUERIED_AT, retryAfterSeconds: 1e9 });
        expect(Number.isInteger(result.ttlSeconds)).toBe(true);
        expect(result.ttlSeconds).toBeGreaterThanOrEqual(ABSOLUTE_MIN_TTL_SECONDS);
        expect(result.ttlSeconds).toBeLessThanOrEqual(ABSOLUTE_MAX_TTL_SECONDS);
      });
  });

  it("is deterministic — the same input always produces the same output", () => {
    const input = { status: ENRICHMENT_STATUS.SUCCESS, queriedAt: QUERIED_AT };
    const a = resolveEnrichmentTtl(input);
    const b = resolveEnrichmentTtl(input);
    expect(a).toEqual(b);
  });

  it("never reads the wall clock — expiresAt is always exactly queriedAt + ttlSeconds", () => {
    const laterQueriedAt = new Date("2030-01-01T00:00:00Z");
    const result = resolveEnrichmentTtl({ status: ENRICHMENT_STATUS.FAILED, queriedAt: laterQueriedAt });
    expect(result.expiresAt.getTime()).toBe(laterQueriedAt.getTime() + result.ttlSeconds * 1000);
  });
});

describe("resolveEnrichmentTtl — policy overrides", () => {
  it("accepts a bounded per-status override", () => {
    const result = resolveEnrichmentTtl({
      status: ENRICHMENT_STATUS.SUCCESS,
      queriedAt: QUERIED_AT,
      policyOverrides: { ttlSecondsByStatus: { [ENRICHMENT_STATUS.SUCCESS]: 3600 } },
    });
    expect(result.ttlSeconds).toBe(3600);
  });

  it("rejects an out-of-bounds per-status override", () => {
    expect(() =>
      resolveEnrichmentTtl({
        status: ENRICHMENT_STATUS.SUCCESS,
        queriedAt: QUERIED_AT,
        policyOverrides: { ttlSecondsByStatus: { [ENRICHMENT_STATUS.SUCCESS]: 1 } },
      })
    ).toThrow(EnrichmentTtlPolicyError);
    expect(() =>
      resolveEnrichmentTtl({
        status: ENRICHMENT_STATUS.SUCCESS,
        queriedAt: QUERIED_AT,
        policyOverrides: { ttlSecondsByStatus: { [ENRICHMENT_STATUS.SUCCESS]: ABSOLUTE_MAX_TTL_SECONDS + 1 } },
      })
    ).toThrow(EnrichmentTtlPolicyError);
  });

  it("accepts bounded rateLimitedMinTtlSeconds/rateLimitedMaxTtlSeconds overrides", () => {
    const result = resolveEnrichmentTtl({
      status: ENRICHMENT_STATUS.RATE_LIMITED,
      queriedAt: QUERIED_AT,
      retryAfterSeconds: 100,
      policyOverrides: { rateLimitedMinTtlSeconds: 120, rateLimitedMaxTtlSeconds: 600 },
    });
    expect(result.ttlSeconds).toBe(120);
    expect(result.policyReason).toBe("RATE_LIMITED_FLOORED_TO_MINIMUM");
  });

  it("rejects an out-of-bounds rate-limit override", () => {
    expect(() =>
      resolveEnrichmentTtl({
        status: ENRICHMENT_STATUS.RATE_LIMITED,
        queriedAt: QUERIED_AT,
        policyOverrides: { rateLimitedMinTtlSeconds: ABSOLUTE_MIN_TTL_SECONDS - 1 },
      })
    ).toThrow(EnrichmentTtlPolicyError);
  });

  it("rejects overriding RATE_LIMITED through ttlSecondsByStatus", () => {
    expect(() =>
      resolveEnrichmentTtl({
        status: ENRICHMENT_STATUS.SUCCESS,
        queriedAt: QUERIED_AT,
        policyOverrides: { ttlSecondsByStatus: { [ENRICHMENT_STATUS.RATE_LIMITED]: 3600 } },
      })
    ).toThrow(EnrichmentTtlPolicyError);
  });
});
