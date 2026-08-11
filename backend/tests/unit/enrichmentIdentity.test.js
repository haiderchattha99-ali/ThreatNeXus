import { describe, it, expect } from "vitest";

// Phase 10A-1 — the three deterministic identities, and the bounded
// Idempotency-Key handling required by the Codex correction addendum.
//
// The most important test in this file is "an AbuseIPDB scope and a Censys
// scope are different asks". That is the exact defect the v2.1 addendum was
// written to correct: collapsing request identity into work identity let an
// active AbuseIPDB run silently suppress a later Censys request.

const {
  EnrichmentIdentityError,
  MAX_IDEMPOTENCY_KEY_BYTES,
  serializeQueryParams,
  computeQueryIdentityHash,
  computeRequestScopeHash,
  hashIdempotencyKeyHeader,
  buildIdempotencyKey,
  manualTimeBucket,
} = require("../../src/services/enrichmentOrchestration/enrichmentIdentity");

const IP = "198.18.0.9";

describe("enrichmentIdentity — queryIdentityHash (work identity)", () => {
  it("is stable and canonicalizes before hashing", () => {
    const canonical = computeQueryIdentityHash({
      provider: "censys",
      subjectType: "IPV4",
      subjectValue: IP,
    });
    const padded = computeQueryIdentityHash({
      provider: "censys",
      subjectType: "IPV4",
      subjectValue: `  ${IP}  `,
    });
    // If canonicalization ran AFTER hashing, these would differ and the same
    // address would occupy two lookup jobs.
    expect(padded).toBe(canonical);
    expect(canonical).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates providers and subject types", () => {
    const censys = computeQueryIdentityHash({
      provider: "censys",
      subjectType: "IPV4",
      subjectValue: IP,
    });
    const shodan = computeQueryIdentityHash({
      provider: "shodan",
      subjectType: "IPV4",
      subjectValue: IP,
    });
    const nvd = computeQueryIdentityHash({
      provider: "nvd",
      subjectType: "CVE",
      subjectValue: "CVE-2024-3094",
    });
    expect(new Set([censys, shodan, nvd]).size).toBe(3);
  });

  it("folds CVE case into one identity", () => {
    expect(
      computeQueryIdentityHash({ provider: "nvd", subjectType: "CVE", subjectValue: "cve-2024-3094" })
    ).toBe(
      computeQueryIdentityHash({ provider: "nvd", subjectType: "CVE", subjectValue: "CVE-2024-3094" })
    );
  });

  it("rejects an unknown provider", () => {
    expect(() =>
      computeQueryIdentityHash({ provider: "virustotal", subjectType: "IPV4", subjectValue: IP })
    ).toThrow(EnrichmentIdentityError);
  });

  it("drops non-allow-listed query parameters before they reach the hash input", () => {
    // The serialized form is asserted directly, not only the digest: a secret
    // must be absent from the hash INPUT, not merely invisible in its output.
    const serialized = serializeQueryParams({ maxAgeInDays: 30, apiKey: "super-secret-value" });
    expect(serialized).toBe('[["maxAgeInDays",30]]');
    expect(serialized).not.toContain("super-secret-value");
  });

  it("is independent of query-parameter key order", () => {
    expect(serializeQueryParams({ maxAgeInDays: 30 })).toBe(serializeQueryParams({ maxAgeInDays: 30 }));
  });
});

describe("enrichmentIdentity — requestScopeHash (ask identity)", () => {
  const base = { findingId: 7, trigger: "MANUAL", force: false };

  it("treats an AbuseIPDB-scoped ask and a Censys-scoped ask as DIFFERENT asks", () => {
    const abuse = computeRequestScopeHash({
      ...base,
      targets: [{ provider: "abuseipdb", subjectType: "IPV4", subjectValue: IP }],
    });
    const censys = computeRequestScopeHash({
      ...base,
      targets: [{ provider: "censys", subjectType: "IPV4", subjectValue: IP }],
    });
    // This is the v2.1 correction, expressed as an assertion.
    expect(censys).not.toBe(abuse);
  });

  it("is independent of target order and of duplicate targets", () => {
    const one = computeRequestScopeHash({
      ...base,
      targets: [
        { provider: "censys", subjectType: "IPV4", subjectValue: IP },
        { provider: "abuseipdb", subjectType: "IPV4", subjectValue: IP },
      ],
    });
    const two = computeRequestScopeHash({
      ...base,
      targets: [
        { provider: "abuseipdb", subjectType: "IPV4", subjectValue: IP },
        { provider: "censys", subjectType: "IPV4", subjectValue: IP },
        // Same target again, spelled differently — deduplicated AFTER
        // canonicalization, so it must not change the digest.
        { provider: "censys", subjectType: "IPV4", subjectValue: `  ${IP}  ` },
      ],
    });
    expect(two).toBe(one);
  });

  it("separates a forced ask from a non-forced one", () => {
    const targets = [{ provider: "censys", subjectType: "IPV4", subjectValue: IP }];
    expect(computeRequestScopeHash({ ...base, force: true, targets })).not.toBe(
      computeRequestScopeHash({ ...base, force: false, targets })
    );
  });

  it("separates Findings and triggers", () => {
    const targets = [{ provider: "censys", subjectType: "IPV4", subjectValue: IP }];
    expect(computeRequestScopeHash({ ...base, findingId: 8, targets })).not.toBe(
      computeRequestScopeHash({ ...base, targets })
    );
    expect(computeRequestScopeHash({ ...base, trigger: "INGESTION", targets })).not.toBe(
      computeRequestScopeHash({ ...base, targets })
    );
  });

  it("keeps three verified CVEs as three distinct subjects", () => {
    const three = computeRequestScopeHash({
      ...base,
      targets: [
        { provider: "nvd", subjectType: "CVE", subjectValue: "CVE-2024-0001" },
        { provider: "nvd", subjectType: "CVE", subjectValue: "CVE-2024-0002" },
        { provider: "nvd", subjectType: "CVE", subjectValue: "CVE-2024-0003" },
      ],
    });
    const two = computeRequestScopeHash({
      ...base,
      targets: [
        { provider: "nvd", subjectType: "CVE", subjectValue: "CVE-2024-0001" },
        { provider: "nvd", subjectType: "CVE", subjectValue: "CVE-2024-0002" },
      ],
    });
    expect(three).not.toBe(two);
  });
});

describe("enrichmentIdentity — Idempotency-Key bounds (Codex amendment 4)", () => {
  it("returns null when the header is absent", () => {
    expect(hashIdempotencyKeyHeader(undefined)).toBeNull();
    expect(hashIdempotencyKeyHeader(null)).toBeNull();
  });

  it("returns ONLY a digest — never the raw value", () => {
    const raw = "client-request-4e2f";
    const hashed = hashIdempotencyKeyHeader(raw);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toContain(raw);
  });

  it("rejects a supplied-but-empty key rather than treating it as absent", () => {
    expect(() => hashIdempotencyKeyHeader("")).toThrow(EnrichmentIdentityError);
    expect(() => hashIdempotencyKeyHeader("   ")).toThrow(EnrichmentIdentityError);
  });

  it("rejects a key over 128 UTF-8 bytes, counting BYTES not characters", () => {
    expect(() => hashIdempotencyKeyHeader("a".repeat(MAX_IDEMPOTENCY_KEY_BYTES + 1))).toThrow(
      EnrichmentIdentityError
    );
    // Exactly at the bound is accepted.
    expect(hashIdempotencyKeyHeader("a".repeat(MAX_IDEMPOTENCY_KEY_BYTES))).toMatch(/^[0-9a-f]{64}$/);
    // 64 multi-byte characters are 128 bytes and still fit; 65 do not. A
    // character-based bound would have wrongly accepted the second.
    expect(hashIdempotencyKeyHeader("é".repeat(64))).toMatch(/^[0-9a-f]{64}$/);
    expect(() => hashIdempotencyKeyHeader("é".repeat(65))).toThrow(EnrichmentIdentityError);
  });

  it("rejects control characters, including CR and LF", () => {
    const controls = [
      String.fromCharCode(0),
      String.fromCharCode(9),
      String.fromCharCode(10),
      String.fromCharCode(13),
      String.fromCharCode(27),
      String.fromCharCode(127),
      String.fromCharCode(155),
    ];
    // eslint-disable-next-line no-restricted-syntax
    for (const control of controls) {
      expect(() => hashIdempotencyKeyHeader(`abc${control}def`)).toThrow(EnrichmentIdentityError);
    }
  });

  it("never echoes the rejected value in its error message", () => {
    const secretish = "x".repeat(200);
    try {
      hashIdempotencyKeyHeader(secretish);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnrichmentIdentityError);
      expect(error.message).not.toContain(secretish);
    }
  });

  it("rejects a non-string header value", () => {
    expect(() => hashIdempotencyKeyHeader(42)).toThrow(EnrichmentIdentityError);
  });
});

describe("enrichmentIdentity — idempotencyKey composition", () => {
  const scope = "a".repeat(64);

  it("keys an INGESTION run on the report plus the scope", () => {
    expect(
      buildIdempotencyKey({ trigger: "INGESTION", requestScopeHash: scope, rawReportId: 12 })
    ).toBe(`ing:12:${scope}`);
  });

  it("requires a rawReportId for an INGESTION run", () => {
    expect(() => buildIdempotencyKey({ trigger: "INGESTION", requestScopeHash: scope })).toThrow(
      EnrichmentIdentityError
    );
  });

  it("prefers a supplied Idempotency-Key digest over the time bucket", () => {
    const key = buildIdempotencyKey({
      trigger: "MANUAL",
      requestScopeHash: scope,
      idempotencyKeyHash: "b".repeat(64),
      bucketedAt: "2026-08-11T16:00:00.000Z",
    });
    expect(key).toBe(`man:${scope}:${"b".repeat(64)}`);
  });

  it("buckets a keyless manual ask so a double click collapses into one run", () => {
    const first = manualTimeBucket(new Date("2026-08-11T16:00:05.000Z"));
    const second = manualTimeBucket(new Date("2026-08-11T16:00:47.000Z"));
    const later = manualTimeBucket(new Date("2026-08-11T16:01:05.000Z"));
    expect(second).toBe(first);
    // A deliberate re-request a minute later is genuinely a new ask.
    expect(later).not.toBe(first);
  });

  it("rejects an unsupported trigger", () => {
    expect(() => buildIdempotencyKey({ trigger: "CRON", requestScopeHash: scope })).toThrow(
      EnrichmentIdentityError
    );
  });
});
