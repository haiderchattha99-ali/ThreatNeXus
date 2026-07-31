import { describe, it, expect } from "vitest";

// The structural half of the ownership consistency checker is a pure function
// over one row, so the entire closed contract is testable with no database.
// Each case below is a state the system must never silently hold.

const {
  CONSISTENCY_ISSUE,
  ALLOWED_CONFIDENCE_BY_STATUS,
  normalizeBatchSize,
  checkRowStructure,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
} = require("../../src/services/ownership/ownershipConsistencyService");

// A row that satisfies the contract, which each test then breaks in one way.
function validResolvedRow(overrides = {}) {
  return {
    findingId: 1,
    organizationId: 7,
    status: "RESOLVED",
    confidence: "HIGH",
    matchedMappingId: 3,
    isIspAttribution: false,
    ...overrides,
  };
}

describe("checkRowStructure — clean rows", () => {
  it("accepts a well-formed RESOLVED row", () => {
    expect(checkRowStructure(validResolvedRow())).toEqual([]);
  });

  it("accepts a well-formed OVERRIDDEN row", () => {
    const row = validResolvedRow({
      status: "OVERRIDDEN",
      confidence: "CONFIRMED",
      matchedMappingId: null,
    });
    expect(checkRowStructure(row)).toEqual([]);
  });

  it("accepts a well-formed AMBIGUOUS row", () => {
    const row = validResolvedRow({
      status: "AMBIGUOUS",
      confidence: null,
      organizationId: null,
      matchedMappingId: null,
    });
    expect(checkRowStructure(row)).toEqual([]);
  });

  it("accepts a well-formed ISP attribution row", () => {
    const row = validResolvedRow({ confidence: "LOW", isIspAttribution: true });
    expect(checkRowStructure(row)).toEqual([]);
  });
});

describe("checkRowStructure — contract violations", () => {
  it("flags RESOLVED with no organization", () => {
    expect(checkRowStructure(validResolvedRow({ organizationId: null }))).toContain(
      CONSISTENCY_ISSUE.RESOLVED_WITHOUT_ORGANIZATION
    );
  });

  it("flags AMBIGUOUS that still names an organization", () => {
    // Ambiguity means we could not choose. A row that is both ambiguous and
    // attributed would let a downstream consumer treat a guess as a decision.
    const row = validResolvedRow({ status: "AMBIGUOUS", confidence: null, organizationId: 7 });
    expect(checkRowStructure(row)).toContain(CONSISTENCY_ISSUE.AMBIGUOUS_WITH_ORGANIZATION);
  });

  it("flags UNRESOLVED that still names an organization", () => {
    const row = validResolvedRow({ status: "UNRESOLVED", confidence: null, organizationId: 7 });
    expect(checkRowStructure(row)).toContain(CONSISTENCY_ISSUE.UNRESOLVED_WITH_ORGANIZATION);
  });

  it("flags an OVERRIDDEN row that leans on a mapping id", () => {
    // An analyst's explicit claim must not depend on registry state, or a later
    // mapping change would appear to move a human decision.
    const row = validResolvedRow({
      status: "OVERRIDDEN",
      confidence: "CONFIRMED",
      matchedMappingId: 3,
    });
    expect(checkRowStructure(row)).toContain(CONSISTENCY_ISSUE.OVERRIDE_RELIES_ON_MAPPING);
  });

  it("flags every illegal status/confidence pairing", () => {
    const illegal = [
      { status: "RESOLVED", confidence: "CONFIRMED" }, // CONFIRMED is override-only
      { status: "RESOLVED", confidence: null },
      { status: "OVERRIDDEN", confidence: "HIGH" },
      { status: "AMBIGUOUS", confidence: "LOW" },
      { status: "UNRESOLVED", confidence: "HIGH" },
    ];
    for (const pairing of illegal) {
      const row = validResolvedRow({ ...pairing, matchedMappingId: null, organizationId: null });
      expect(checkRowStructure(row)).toContain(
        CONSISTENCY_ISSUE.INVALID_STATUS_CONFIDENCE_COMBINATION
      );
    }
  });

  it("flags ISP attribution with an incompatible status or confidence", () => {
    // The ISP flag is an honesty signal: this is the carrier, not the victim.
    // It only ever accompanies a LOW-confidence RESOLVED row or an AMBIGUOUS one.
    const highConfidenceIsp = validResolvedRow({ confidence: "HIGH", isIspAttribution: true });
    expect(checkRowStructure(highConfidenceIsp)).toContain(
      CONSISTENCY_ISSUE.ISP_ATTRIBUTION_INCOMPATIBLE
    );

    const overriddenIsp = validResolvedRow({
      status: "OVERRIDDEN",
      confidence: "CONFIRMED",
      matchedMappingId: null,
      isIspAttribution: true,
    });
    expect(checkRowStructure(overriddenIsp)).toContain(
      CONSISTENCY_ISSUE.ISP_ATTRIBUTION_INCOMPATIBLE
    );
  });

  it("reports every independent defect on one row, not just the first", () => {
    const row = {
      findingId: 1,
      status: "AMBIGUOUS",
      confidence: "HIGH", // illegal for AMBIGUOUS
      organizationId: 7, // illegal for AMBIGUOUS
      matchedMappingId: null,
      isIspAttribution: false,
    };
    const issues = checkRowStructure(row);
    expect(issues).toContain(CONSISTENCY_ISSUE.INVALID_STATUS_CONFIDENCE_COMBINATION);
    expect(issues).toContain(CONSISTENCY_ISSUE.AMBIGUOUS_WITH_ORGANIZATION);
  });
});

describe("ALLOWED_CONFIDENCE_BY_STATUS is the closed contract", () => {
  it("permits CONFIRMED only for OVERRIDDEN", () => {
    Object.entries(ALLOWED_CONFIDENCE_BY_STATUS).forEach(([status, allowed]) => {
      if (status !== "OVERRIDDEN") expect(allowed).not.toContain("CONFIRMED");
    });
    expect(ALLOWED_CONFIDENCE_BY_STATUS.OVERRIDDEN).toEqual(["CONFIRMED"]);
  });

  it("permits only a null confidence for AMBIGUOUS and UNRESOLVED", () => {
    expect(ALLOWED_CONFIDENCE_BY_STATUS.AMBIGUOUS).toEqual([null]);
    expect(ALLOWED_CONFIDENCE_BY_STATUS.UNRESOLVED).toEqual([null]);
  });
});

describe("normalizeBatchSize", () => {
  it("clamps into safe bounds instead of throwing", () => {
    expect(normalizeBatchSize(0)).toBe(MIN_BATCH_SIZE);
    expect(normalizeBatchSize(-5)).toBe(MIN_BATCH_SIZE);
    expect(normalizeBatchSize(999999)).toBe(MAX_BATCH_SIZE);
    expect(normalizeBatchSize(50)).toBe(50);
  });

  it("falls back to the default for non-integers", () => {
    expect(normalizeBatchSize(undefined)).toBe(DEFAULT_BATCH_SIZE);
    expect(normalizeBatchSize("100")).toBe(DEFAULT_BATCH_SIZE);
    expect(normalizeBatchSize(1.5)).toBe(DEFAULT_BATCH_SIZE);
  });
});
