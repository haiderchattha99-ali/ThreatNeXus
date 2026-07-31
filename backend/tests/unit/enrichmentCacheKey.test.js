import { describe, it, expect } from "vitest";

const {
  EnrichmentCacheKeyError,
  MAX_PROVIDER_NAME_LENGTH,
  serializeQueryParams,
  buildEnrichmentCacheIdentity,
} = require("../../src/services/enrichment/enrichmentCacheKey");

// Pure tests only — no Prisma, no clock, no filesystem. These prove the cache
// IDENTITY contract: the same lookup always produces the same key, two
// different lookups never collide, and nothing that isn't an allow-listed
// query parameter can reach the hash input or the stored key.

const BASE = Object.freeze({
  provider: "mock",
  indicatorType: "IPV4",
  indicator: "198.18.0.10",
});

describe("enrichmentCacheKey — determinism", () => {
  it("produces byte-identical output for repeated identical input", () => {
    const a = buildEnrichmentCacheIdentity({ ...BASE, queryParams: { maxAgeInDays: 30 } });
    const b = buildEnrichmentCacheIdentity({ ...BASE, queryParams: { maxAgeInDays: 30 } });
    expect(a.cacheKey).toBe(b.cacheKey);
    expect(a.queryParamsHash).toBe(b.queryParamsHash);
  });

  it("is stable across equivalent queryParams key ordering", () => {
    // Only `maxAgeInDays` is allow-listed today, so key ordering is exercised
    // by interleaving it with keys that get dropped — the surviving canonical
    // form must be identical whichever order they were supplied in.
    const first = buildEnrichmentCacheIdentity({
      ...BASE,
      queryParams: { maxAgeInDays: 30, verbose: true, zzz: 1 },
    });
    const second = buildEnrichmentCacheIdentity({
      ...BASE,
      queryParams: { zzz: 1, verbose: true, maxAgeInDays: 30 },
    });
    expect(first.cacheKey).toBe(second.cacheKey);
    expect(first.queryParamsHash).toBe(second.queryParamsHash);
  });

  it("serializes query params as a key-sorted pair array, not by insertion order", () => {
    expect(serializeQueryParams({ maxAgeInDays: 30 })).toBe('[["maxAgeInDays",30]]');
    expect(serializeQueryParams(null)).toBe("[]");
    expect(serializeQueryParams({})).toBe("[]");
  });

  it("returns a frozen identity whose queryParams are the sanitized form", () => {
    const identity = buildEnrichmentCacheIdentity({
      ...BASE,
      queryParams: { maxAgeInDays: 90, apiKey: "SECRET" },
    });
    expect(identity.queryParams).toEqual({ maxAgeInDays: 90 });
    expect(Object.isFrozen(identity)).toBe(true);
  });
});

describe("enrichmentCacheKey — identity separation", () => {
  it("a different provider produces a different key", () => {
    const mock = buildEnrichmentCacheIdentity(BASE);
    const abuseipdb = buildEnrichmentCacheIdentity({ ...BASE, provider: "abuseipdb" });
    expect(mock.cacheKey).not.toBe(abuseipdb.cacheKey);
  });

  it("a different indicator produces a different key", () => {
    const a = buildEnrichmentCacheIdentity(BASE);
    const b = buildEnrichmentCacheIdentity({ ...BASE, indicator: "198.18.0.11" });
    expect(a.cacheKey).not.toBe(b.cacheKey);
  });

  it("a different maxAgeInDays produces a different key", () => {
    const thirty = buildEnrichmentCacheIdentity({ ...BASE, queryParams: { maxAgeInDays: 30 } });
    const ninety = buildEnrichmentCacheIdentity({ ...BASE, queryParams: { maxAgeInDays: 90 } });
    expect(thirty.cacheKey).not.toBe(ninety.cacheKey);
    expect(thirty.queryParamsHash).not.toBe(ninety.queryParamsHash);
  });

  it("omitting queryParams differs from supplying maxAgeInDays", () => {
    const none = buildEnrichmentCacheIdentity(BASE);
    const thirty = buildEnrichmentCacheIdentity({ ...BASE, queryParams: { maxAgeInDays: 30 } });
    expect(none.cacheKey).not.toBe(thirty.cacheKey);
  });
});

describe("enrichmentCacheKey — unknown parameters and secrets", () => {
  it("unknown query params do not enter the cache key at all", () => {
    const bare = buildEnrichmentCacheIdentity(BASE);
    const noisy = buildEnrichmentCacheIdentity({
      ...BASE,
      queryParams: { nonce: "abc", verbose: true, page: 2 },
    });
    expect(noisy.cacheKey).toBe(bare.cacheKey);
    expect(noisy.queryParams).toEqual({});
  });

  it("a secret supplied as a query param appears in neither the hash input nor any output", () => {
    const SECRET = "abuseipdb-live-key-do-not-store";
    const serialized = serializeQueryParams({ maxAgeInDays: 30, apiKey: SECRET, key: SECRET });
    expect(serialized).toBe('[["maxAgeInDays",30]]');
    expect(serialized).not.toContain(SECRET);

    const identity = buildEnrichmentCacheIdentity({
      ...BASE,
      queryParams: { maxAgeInDays: 30, apiKey: SECRET, key: SECRET },
    });
    const rendered = JSON.stringify(identity);
    expect(rendered).not.toContain(SECRET);
    expect(identity.queryParams).toEqual({ maxAgeInDays: 30 });

    // And it is identical to the same lookup made without the secret at all,
    // so a leaked key can never fracture the cache either.
    const clean = buildEnrichmentCacheIdentity({ ...BASE, queryParams: { maxAgeInDays: 30 } });
    expect(identity.cacheKey).toBe(clean.cacheKey);
  });
});

describe("enrichmentCacheKey — validation", () => {
  it("rejects a non-lowercase provider rather than folding its case", () => {
    expect(() => buildEnrichmentCacheIdentity({ ...BASE, provider: "AbuseIPDB" })).toThrow(
      EnrichmentCacheKeyError
    );
  });

  it("rejects an empty, over-long, or separator-bearing provider", () => {
    expect(() => buildEnrichmentCacheIdentity({ ...BASE, provider: "" })).toThrow(EnrichmentCacheKeyError);
    expect(() =>
      buildEnrichmentCacheIdentity({ ...BASE, provider: "a".repeat(MAX_PROVIDER_NAME_LENGTH + 1) })
    ).toThrow(EnrichmentCacheKeyError);
    expect(() => buildEnrichmentCacheIdentity({ ...BASE, provider: "a|b" })).toThrow(
      EnrichmentCacheKeyError
    );
  });

  it("rejects any indicatorType other than IPV4", () => {
    expect(() => buildEnrichmentCacheIdentity({ ...BASE, indicatorType: "IPV6" })).toThrow(
      EnrichmentCacheKeyError
    );
    expect(() => buildEnrichmentCacheIdentity({ ...BASE, indicatorType: "DOMAIN" })).toThrow(
      EnrichmentCacheKeyError
    );
    expect(() => buildEnrichmentCacheIdentity({ ...BASE, indicatorType: undefined })).toThrow(
      EnrichmentCacheKeyError
    );
  });

  it("enforces strict canonical IPv4 (no leading zeros, padding, CIDR, IPv6, hostnames)", () => {
    const rejected = [
      "198.18.0.010",
      " 198.18.0.10",
      "198.18.0.10 ",
      "198.18.0.10/32",
      "198.18.0",
      "198.18.0.256",
      "2001:db8::1",
      "example.test",
      "",
    ];
    rejected.forEach((indicator) => {
      expect(() => buildEnrichmentCacheIdentity({ ...BASE, indicator })).toThrow(
        EnrichmentCacheKeyError
      );
    });
  });

  it("rejects an invalid maxAgeInDays rather than silently dropping it", () => {
    expect(() => buildEnrichmentCacheIdentity({ ...BASE, queryParams: { maxAgeInDays: 0 } })).toThrow(
      TypeError
    );
    expect(() =>
      buildEnrichmentCacheIdentity({ ...BASE, queryParams: { maxAgeInDays: 1.5 } })
    ).toThrow(TypeError);
  });

  it("rejects a non-object input", () => {
    expect(() => buildEnrichmentCacheIdentity(null)).toThrow(EnrichmentCacheKeyError);
    expect(() => buildEnrichmentCacheIdentity("mock")).toThrow(EnrichmentCacheKeyError);
  });
});
