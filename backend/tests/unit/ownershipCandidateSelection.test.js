import { describe, it, expect } from "vitest";

// Pure-function tests for the database-pushed ownership candidate filter.
//
// These need no Prisma and no database: deriveIndicatorFilters is the piece
// that decides WHAT PostgreSQL is asked for, and getting it wrong is the
// difference between "read the rows this mapping can own" and either "read
// every row in the table" (the regression this packet removed) or "silently
// skip rows" (a correctness bug a passing integration test would not catch).

const {
  MAX_PREFIX_FILTERS,
  CANDIDATE_FILTER_KIND,
  deriveIndicatorFilters,
  buildRangeWhere,
  findingIsInMappingRange,
  mappingCanAcquireNewFindings,
} = require("../../src/services/ownership/ownershipCandidateSelection");
const { cidrToRange, ipv4ToInt } = require("../../src/services/ownership/ipv4Cidr");

function filtersFor(cidr) {
  const { ipStart, ipEnd } = cidrToRange(cidr);
  return deriveIndicatorFilters(ipStart, ipEnd);
}

describe("deriveIndicatorFilters — granularity ladder", () => {
  it("returns an exact address for a /32", () => {
    const filter = filtersFor("203.0.113.7/32");
    expect(filter.kind).toBe(CANDIDATE_FILTER_KIND.EXACT);
    expect(filter.values).toEqual(["203.0.113.7"]);
  });

  it("returns one /24 prefix for a /24", () => {
    const filter = filtersFor("203.0.113.0/24");
    expect(filter.kind).toBe(CANDIDATE_FILTER_KIND.PREFIX);
    expect(filter.values).toEqual(["203.0.113."]);
  });

  it("returns one /24 prefix for a /25, overshooting by at most that /24", () => {
    // Finer than /24 cannot be expressed as an octet-aligned string prefix, so
    // the filter widens to the enclosing /24 and exact containment narrows it.
    const filter = filtersFor("203.0.113.128/25");
    expect(filter.values).toEqual(["203.0.113."]);
  });

  it("enumerates /24 prefixes exactly for a /22", () => {
    const filter = filtersFor("203.0.112.0/22");
    expect(filter.values).toEqual([
      "203.0.112.",
      "203.0.113.",
      "203.0.114.",
      "203.0.115.",
    ]);
  });

  it("steps up to /16 granularity when /24 enumeration would exceed the cap", () => {
    // A /15 spans 512 /24 blocks — past the cap — so it drops to two /16s.
    const filter = filtersFor("10.0.0.0/15");
    expect(filter.values).toEqual(["10.0.", "10.1."]);
  });

  it("steps up to /8 granularity for a /7", () => {
    const filter = filtersFor("10.0.0.0/7");
    expect(filter.values).toEqual(["10.", "11."]);
  });

  it("never exceeds the filter cap for any prefix length, including /0", () => {
    for (let p = 0; p <= 32; p += 1) {
      const filter = filtersFor(`0.0.0.0/${p}`);
      expect(filter.kind).not.toBe(CANDIDATE_FILTER_KIND.NONE);
      expect(filter.values.length).toBeLessThanOrEqual(MAX_PREFIX_FILTERS);
    }
  });
});

describe("deriveIndicatorFilters — safety properties", () => {
  it("always ends every prefix with a dot so textual prefixes cannot collide", () => {
    // Without the trailing dot, "10.1." would also match "10.10.5.1" — the
    // exact trap the packet forbids. Assert the invariant across the whole
    // ladder, not one shape.
    for (const p of [0, 7, 8, 15, 16, 22, 24, 25, 31]) {
      const filter = filtersFor(`10.1.0.0/${p}`);
      filter.values.forEach((prefix) => expect(prefix.endsWith(".")).toBe(true));
    }
    // A /15 drops to /16 granularity, which is where a bare "10.1" would bite.
    expect(filtersFor("10.0.0.0/15").values).toEqual(["10.0.", "10.1."]);
    expect("10.10.5.1".startsWith("10.1.")).toBe(false);
    expect("10.1.5.1".startsWith("10.1.")).toBe(true);
  });

  it("produces a superset of the range — never misses a member address", () => {
    const cidr = "192.0.2.0/28";
    const { ipStart, ipEnd } = cidrToRange(cidr);
    const filter = deriveIndicatorFilters(ipStart, ipEnd);
    // Every address actually inside the range matches at least one filter.
    for (let i = 0; i < 16; i += 1) {
      const address = `192.0.2.${i}`;
      expect(filter.values.some((p) => address.startsWith(p))).toBe(true);
    }
  });

  it("would be wrong as a lexical range — proving why prefixes are used", () => {
    // String ordering is not address ordering. A `gte "10.0.0.10" lte "10.0.0.9"`
    // style range would exclude real members; prefixes have no such problem.
    expect("10.0.0.9" > "10.0.0.10").toBe(true);
    expect(ipv4ToInt("10.0.0.9") > ipv4ToInt("10.0.0.10")).toBe(false);
  });

  it("returns NONE for a malformed or inverted range rather than throwing", () => {
    expect(deriveIndicatorFilters(5n, 1n).kind).toBe(CANDIDATE_FILTER_KIND.NONE);
    expect(deriveIndicatorFilters(null, null).kind).toBe(CANDIDATE_FILTER_KIND.NONE);
  });
});

describe("buildRangeWhere", () => {
  it("builds an OR of startsWith predicates for a CIDR", () => {
    const { ipStart, ipEnd, prefixLength } = cidrToRange("203.0.112.0/23");
    const where = buildRangeWhere({ id: 1, ipStart, ipEnd, prefixLength });
    expect(where).toEqual({
      OR: [
        { indicatorValue: { startsWith: "203.0.112." } },
        { indicatorValue: { startsWith: "203.0.113." } },
      ],
    });
  });

  it("builds an equality predicate for a single address", () => {
    const ip = ipv4ToInt("203.0.113.7");
    expect(buildRangeWhere({ id: 1, ipStart: ip, ipEnd: ip })).toEqual({
      indicatorValue: { in: ["203.0.113.7"] },
    });
  });

  it("returns null for a mapping with no address range (ASN)", () => {
    expect(buildRangeWhere({ id: 1, mappingType: "ASN", ipStart: null, ipEnd: null })).toBeNull();
  });
});

describe("findingIsInMappingRange", () => {
  const { ipStart, ipEnd } = cidrToRange("203.0.113.128/25");
  const mapping = { id: 1, ipStart, ipEnd };

  it("accepts an address inside the range", () => {
    expect(findingIsInMappingRange("203.0.113.200", mapping)).toBe(true);
  });

  it("rejects an address the widened /24 prefix filter would have returned", () => {
    // .10 is in the same /24 (so the database filter returns it) but outside
    // the /25 — this exact check is what keeps the overshoot from resolving.
    expect(findingIsInMappingRange("203.0.113.10", mapping)).toBe(false);
  });

  it("rejects a non-IPv4 indicator", () => {
    expect(findingIsInMappingRange("not-an-ip", mapping)).toBe(false);
  });
});

describe("mappingCanAcquireNewFindings", () => {
  it("is false for ASN mappings — Finding stores no ASN to match against", () => {
    expect(mappingCanAcquireNewFindings({ mappingType: "ASN" })).toBe(false);
  });

  it("is true for address-based mappings", () => {
    expect(mappingCanAcquireNewFindings({ mappingType: "CIDR" })).toBe(true);
    expect(mappingCanAcquireNewFindings({ mappingType: "EXACT_IP" })).toBe(true);
  });
});
