import { describe, it, expect } from "vitest";

const {
  OWNERSHIP_RESOLUTION_STATUS,
  OWNERSHIP_CONFIDENCE,
  REASON_CODES,
  resolveOwnership,
} = require("../../src/services/ownership/ownershipResolver");
const { ipv4ToInt, cidrToRange } = require("../../src/services/ownership/ipv4Cidr");

const ASOF = new Date("2026-06-01T00:00:00Z");

let nextId = 1;
function mapping(overrides = {}) {
  return {
    id: nextId++,
    organizationId: 1,
    mappingType: "EXACT_IP",
    ipStart: null,
    ipEnd: null,
    prefixLength: null,
    asn: null,
    enabled: true,
    validFrom: null,
    validUntil: null,
    ...overrides,
  };
}

function exactIpMapping(ip, organizationId, overrides = {}) {
  const ipInt = ipv4ToInt(ip);
  return mapping({
    mappingType: "EXACT_IP",
    organizationId,
    ipStart: ipInt,
    ipEnd: ipInt,
    ...overrides,
  });
}

function cidrMapping(cidr, organizationId, overrides = {}) {
  const range = cidrToRange(cidr);
  return mapping({
    mappingType: "CIDR",
    organizationId,
    ipStart: range.ipStart,
    ipEnd: range.ipEnd,
    prefixLength: range.prefixLength,
    ...overrides,
  });
}

function asnMapping(asn, organizationId, overrides = {}) {
  return mapping({ mappingType: "ASN", organizationId, asn, ...overrides });
}

describe("resolveOwnership — invalid/unsupported indicator", () => {
  it("returns UNRESOLVED for a non-IPv4 indicator, ignoring an override", () => {
    const result = resolveOwnership(
      { indicatorValue: "not-an-ip", asOf: ASOF },
      { mappings: [], currentOverride: { organizationId: 5 } }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED);
    expect(result.reasonCode).toBe(REASON_CODES.UNSUPPORTED_INDICATOR);
    expect(result.organizationId).toBeNull();
  });
});

describe("resolveOwnership — analyst override precedence", () => {
  it("an active override outranks exact-IP, CIDR and ASN matches", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asn: 64500, asOf: ASOF },
      {
        mappings: [
          exactIpMapping("203.0.113.10", 1),
          cidrMapping("203.0.113.0/24", 2),
          asnMapping(64500, 3),
        ],
        currentOverride: { organizationId: 99 },
      }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.OVERRIDDEN);
    expect(result.organizationId).toBe(99);
    expect(result.confidence).toBe(OWNERSHIP_CONFIDENCE.CONFIRMED);
    expect(result.candidateCount).toBe(1);
    expect(result.isIspAttribution).toBe(false);
    expect(result.reasonCode).toBe(REASON_CODES.ANALYST_OVERRIDE);
  });
});

describe("resolveOwnership — exact IP tier", () => {
  it("resolves a single matching exact-IP mapping at HIGH confidence", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      { mappings: [exactIpMapping("203.0.113.10", 7)] }
    );
    expect(result).toMatchObject({
      status: OWNERSHIP_RESOLUTION_STATUS.RESOLVED,
      organizationId: 7,
      confidence: OWNERSHIP_CONFIDENCE.HIGH,
      candidateCount: 1,
      isIspAttribution: false,
      reasonCode: REASON_CODES.EXACT_IP_MATCH,
    });
    expect(result.matchedMappingId).toBeDefined();
  });

  it("exact IP outranks a CIDR and ASN match for the same address", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asn: 64500, asOf: ASOF },
      {
        mappings: [
          exactIpMapping("203.0.113.10", 1),
          cidrMapping("203.0.113.0/24", 2),
          asnMapping(64500, 3),
        ],
      }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.RESOLVED);
    expect(result.organizationId).toBe(1);
    expect(result.reasonCode).toBe(REASON_CODES.EXACT_IP_MATCH);
  });

  it("duplicate exact-IP mappings for the same org are not ambiguous", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      { mappings: [exactIpMapping("203.0.113.10", 4), exactIpMapping("203.0.113.10", 4)] }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.RESOLVED);
    expect(result.candidateCount).toBe(1);
  });

  it("two distinct organizations at exact-IP tier produce AMBIGUOUS", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      { mappings: [exactIpMapping("203.0.113.10", 1), exactIpMapping("203.0.113.10", 2)] }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.AMBIGUOUS);
    expect(result.organizationId).toBeNull();
    expect(result.candidateCount).toBe(2);
    expect(result.reasonCode).toBe(REASON_CODES.AMBIGUOUS_EXACT_IP);
  });

  it("does not fall through to CIDR when exact-IP is ambiguous", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      {
        mappings: [
          exactIpMapping("203.0.113.10", 1),
          exactIpMapping("203.0.113.10", 2),
          cidrMapping("203.0.113.0/24", 3),
        ],
      }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.AMBIGUOUS);
    expect(result.reasonCode).toBe(REASON_CODES.AMBIGUOUS_EXACT_IP);
  });
});

describe("resolveOwnership — CIDR tier / longest-prefix", () => {
  it("resolves the longest (most specific) prefix, ignoring a shorter covering prefix", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      { mappings: [cidrMapping("203.0.0.0/16", 1), cidrMapping("203.0.113.0/24", 2)] }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.RESOLVED);
    expect(result.organizationId).toBe(2);
    expect(result.matchedPrefixLength).toBe(24);
    expect(result.confidence).toBe(OWNERSHIP_CONFIDENCE.HIGH);
  });

  it("two distinct orgs at the SAME longest prefix produce AMBIGUOUS, not an arbitrary winner", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      { mappings: [cidrMapping("203.0.113.0/24", 1), cidrMapping("203.0.113.0/24", 2)] }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.AMBIGUOUS);
    expect(result.candidateCount).toBe(2);
    expect(result.matchedPrefixLength).toBe(24);
    expect(result.reasonCode).toBe(REASON_CODES.AMBIGUOUS_CIDR);
  });

  it("a shorter-prefix distinct org never breaks the longest-prefix tie", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      {
        mappings: [
          cidrMapping("203.0.113.0/24", 1),
          cidrMapping("203.0.113.0/24", 2),
          cidrMapping("203.0.0.0/16", 3),
        ],
      }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.AMBIGUOUS);
    expect(result.candidateCount).toBe(2);
  });

  it("duplicate CIDR mappings for the same org at the same tier are not ambiguous", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      { mappings: [cidrMapping("203.0.113.0/24", 5), cidrMapping("203.0.113.0/24", 5)] }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.RESOLVED);
    expect(result.candidateCount).toBe(1);
  });

  // Every row's indicator is chosen to actually fall inside its CIDR, so
  // every row resolves and every row asserts — a row that returned early
  // without asserting anything (as the old table's /23 and /15 rows did)
  // would pass while proving nothing. Boundary cases required by P2-H1:
  // /32 and /24 -> HIGH, /23 and /16 -> MEDIUM, /15 and /0 -> LOW.
  it.each([
    ["203.0.113.10", "203.0.113.10/32", 32, OWNERSHIP_CONFIDENCE.HIGH],
    ["203.0.113.10", "203.0.113.0/24", 24, OWNERSHIP_CONFIDENCE.HIGH],
    ["203.0.113.10", "203.0.112.0/23", 23, OWNERSHIP_CONFIDENCE.MEDIUM],
    ["203.0.113.10", "203.0.0.0/16", 16, OWNERSHIP_CONFIDENCE.MEDIUM],
    ["203.0.113.10", "203.0.0.0/15", 15, OWNERSHIP_CONFIDENCE.LOW],
    ["203.0.113.10", "0.0.0.0/0", 0, OWNERSHIP_CONFIDENCE.LOW],
  ])(
    "exact confidence table: %s in %s -> prefix %i, %s",
    (indicatorValue, cidr, prefixLength, expectedConfidence) => {
      const result = resolveOwnership(
        { indicatorValue, asOf: ASOF },
        { mappings: [cidrMapping(cidr, 42)] }
      );
      expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.RESOLVED);
      expect(result.organizationId).toBe(42);
      expect(result.confidence).toBe(expectedConfidence);
      expect(result.matchedPrefixLength).toBe(prefixLength);
      expect(result.isIspAttribution).toBe(false);
    }
  );
});

describe("resolveOwnership — ASN tier", () => {
  it("resolves via ASN as LOW confidence, ISP attribution, only when no IP tier matched", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asn: 64500, asOf: ASOF },
      { mappings: [asnMapping(64500, 9)] }
    );
    expect(result).toMatchObject({
      status: OWNERSHIP_RESOLUTION_STATUS.RESOLVED,
      organizationId: 9,
      confidence: OWNERSHIP_CONFIDENCE.LOW,
      isIspAttribution: true,
      reasonCode: REASON_CODES.ASN_MATCH,
    });
  });

  it("does not consult ASN when a CIDR tier already produced a result", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asn: 64500, asOf: ASOF },
      { mappings: [cidrMapping("203.0.113.0/24", 1), asnMapping(64500, 2)] }
    );
    expect(result.reasonCode).toBe(REASON_CODES.CIDR_MATCH);
    expect(result.isIspAttribution).toBe(false);
  });

  it("multiple distinct orgs on the same ASN produce AMBIGUOUS with ISP attribution still true", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asn: 64500, asOf: ASOF },
      { mappings: [asnMapping(64500, 1), asnMapping(64500, 2)] }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.AMBIGUOUS);
    expect(result.isIspAttribution).toBe(true);
    expect(result.reasonCode).toBe(REASON_CODES.AMBIGUOUS_ASN);
  });

  it("is never consulted when no ASN was observed", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      { mappings: [asnMapping(64500, 1)] }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED);
  });
});

describe("resolveOwnership — unresolved / mapping activity window", () => {
  it("returns UNRESOLVED with OWNERSHIP_NO_MATCH when nothing matches", () => {
    const result = resolveOwnership({ indicatorValue: "203.0.113.10", asOf: ASOF }, { mappings: [] });
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED);
    expect(result.reasonCode).toBe(REASON_CODES.NO_MATCH);
    expect(result.candidateCount).toBe(0);
  });

  it("ignores a disabled mapping", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      { mappings: [exactIpMapping("203.0.113.10", 1, { enabled: false })] }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED);
  });

  it("ignores a not-yet-valid (future validFrom) mapping", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      {
        mappings: [
          exactIpMapping("203.0.113.10", 1, { validFrom: new Date("2027-01-01T00:00:00Z") }),
        ],
      }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED);
  });

  it("ignores an expired (validUntil <= asOf) mapping", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      {
        mappings: [
          exactIpMapping("203.0.113.10", 1, { validUntil: new Date("2026-01-01T00:00:00Z") }),
        ],
      }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED);
  });

  it("includes a mapping exactly at validUntil boundary as expired (exclusive)", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      { mappings: [exactIpMapping("203.0.113.10", 1, { validUntil: ASOF })] }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED);
  });

  it("includes a mapping exactly at validFrom boundary as active (inclusive)", () => {
    const result = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      { mappings: [exactIpMapping("203.0.113.10", 1, { validFrom: ASOF })] }
    );
    expect(result.status).toBe(OWNERSHIP_RESOLUTION_STATUS.RESOLVED);
  });
});

describe("resolveOwnership — order independence", () => {
  it("produces the same result regardless of mapping array order", () => {
    const mappings = [cidrMapping("203.0.0.0/16", 1), exactIpMapping("203.0.113.10", 2)];
    const forward = resolveOwnership({ indicatorValue: "203.0.113.10", asOf: ASOF }, { mappings });
    const reversed = resolveOwnership(
      { indicatorValue: "203.0.113.10", asOf: ASOF },
      { mappings: [...mappings].reverse() }
    );
    expect(forward).toEqual(reversed);
  });
});
