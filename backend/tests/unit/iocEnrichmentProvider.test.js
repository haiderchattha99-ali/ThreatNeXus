import { describe, it, expect } from "vitest";

const {
  isSupportedIocIndicator,
  assertValidLookupRequest,
  assertImplementsIocEnrichmentProvider,
} = require("../../src/services/enrichment/iocEnrichmentProvider");

const ASOF = new Date("2026-06-01T00:00:00Z");

describe("isSupportedIocIndicator", () => {
  it("supports a strict, canonical IPv4 address typed IPV4", () => {
    expect(isSupportedIocIndicator({ indicatorType: "IPV4", indicator: "203.0.113.10" })).toBe(true);
  });

  it("rejects IPv6, hostnames, URLs, malformed IPv4, leading-zero octets, and whitespace", () => {
    const rejected = [
      { indicatorType: "IPV6", indicator: "2001:db8::1" },
      { indicatorType: "IPV4", indicator: "2001:db8::1" },
      { indicatorType: "IPV4", indicator: "example.com" },
      { indicatorType: "IPV4", indicator: "https://203.0.113.10/" },
      { indicatorType: "IPV4", indicator: "999.0.113.10" },
      { indicatorType: "IPV4", indicator: "203.0.113.010" },
      { indicatorType: "IPV4", indicator: " 203.0.113.10" },
      { indicatorType: "IPV4", indicator: "203.0.113.10 " },
      { indicatorType: "HOSTNAME", indicator: "example.com" },
    ];
    rejected.forEach((input) => {
      expect(isSupportedIocIndicator(input)).toBe(false);
    });
  });

  it("is side-effect-free and synchronous — returns a plain boolean, not a Promise", () => {
    const result = isSupportedIocIndicator({ indicatorType: "IPV4", indicator: "203.0.113.10" });
    expect(typeof result).toBe("boolean");
  });

  it("handles missing/malformed input without throwing", () => {
    expect(isSupportedIocIndicator()).toBe(false);
    expect(isSupportedIocIndicator({})).toBe(false);
    expect(isSupportedIocIndicator({ indicatorType: "IPV4", indicator: 12345 })).toBe(false);
  });
});

describe("assertValidLookupRequest", () => {
  it("does not throw for a valid request", () => {
    expect(() =>
      assertValidLookupRequest({ indicatorType: "IPV4", indicator: "203.0.113.10", asOf: ASOF })
    ).not.toThrow();
  });

  it("throws TypeError for a missing/empty indicatorType or indicator", () => {
    expect(() =>
      assertValidLookupRequest({ indicator: "203.0.113.10", asOf: ASOF })
    ).toThrow(TypeError);
    expect(() =>
      assertValidLookupRequest({ indicatorType: "IPV4", asOf: ASOF })
    ).toThrow(TypeError);
    expect(() =>
      assertValidLookupRequest({ indicatorType: "", indicator: "203.0.113.10", asOf: ASOF })
    ).toThrow(TypeError);
  });

  it("throws TypeError for a missing, wrong-typed, or invalid asOf", () => {
    expect(() =>
      assertValidLookupRequest({ indicatorType: "IPV4", indicator: "203.0.113.10" })
    ).toThrow(TypeError);
    expect(() =>
      assertValidLookupRequest({ indicatorType: "IPV4", indicator: "203.0.113.10", asOf: "2026-06-01" })
    ).toThrow(TypeError);
    expect(() =>
      assertValidLookupRequest({
        indicatorType: "IPV4",
        indicator: "203.0.113.10",
        asOf: new Date("not-a-date"),
      })
    ).toThrow(TypeError);
  });
});

describe("assertImplementsIocEnrichmentProvider", () => {
  function validCandidate() {
    return { name: "example", supports: () => true, lookup: async () => ({}) };
  }

  it("does not throw for a well-formed provider candidate", () => {
    expect(() => assertImplementsIocEnrichmentProvider(validCandidate())).not.toThrow();
  });

  it("throws for a missing or non-lowercase name", () => {
    expect(() =>
      assertImplementsIocEnrichmentProvider({ ...validCandidate(), name: undefined })
    ).toThrow(TypeError);
    expect(() =>
      assertImplementsIocEnrichmentProvider({ ...validCandidate(), name: "Example" })
    ).toThrow(TypeError);
    expect(() =>
      assertImplementsIocEnrichmentProvider({ ...validCandidate(), name: "" })
    ).toThrow(TypeError);
  });

  it("throws for a missing supports or lookup function", () => {
    expect(() =>
      assertImplementsIocEnrichmentProvider({ ...validCandidate(), supports: undefined })
    ).toThrow(TypeError);
    expect(() =>
      assertImplementsIocEnrichmentProvider({ ...validCandidate(), lookup: undefined })
    ).toThrow(TypeError);
  });

  it("throws for a non-object candidate", () => {
    expect(() => assertImplementsIocEnrichmentProvider(null)).toThrow(TypeError);
    expect(() => assertImplementsIocEnrichmentProvider("mock")).toThrow(TypeError);
  });
});
