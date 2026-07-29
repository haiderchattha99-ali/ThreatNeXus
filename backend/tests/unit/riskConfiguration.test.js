import { describe, it, expect } from "vitest";

// P2-T3 — the LOCKED Risk v1 numeric contract, asserted value by value.
//
// These tests are deliberately written as a transcription of the architect's
// approval (STATUS.md "Locked Risk v1 numeric contract"), NOT as a read-back of
// riskConfiguration.js. Every number here was copied from the approval message,
// so editing a weight in the module without a new approval fails this file.
//
// Pure: no Prisma, no clock, no network.

const crypto = require("crypto");

const {
  RISK_ALGORITHM_VERSION,
  RISK_CONFIGURATION_VERSION,
  RISK_CONFIGURATION_FINGERPRINT,
  RISK_CONFIGURATION,
  SCORE_MIN_BASIS_POINTS,
  SCORE_MAX_BASIS_POINTS,
  DISPLAY_SCORE_DIVISOR,
  MAX_NORMALIZED_DAYS,
  MILLISECONDS_PER_DAY,
  RISK_FACTOR_KEYS,
  RISK_FACTOR_KEY_VALUES,
  RISK_APPLICABILITY,
  RISK_BAND,
  RISK_BAND_TABLE,
  RISK_EXPLANATION_CODES,
  FACTOR_MAXIMUMS,
  FACTOR_DISPLAY_ORDER,
  VULNERABILITY_FACTOR_KEYS,
  IOC_REPUTATION_MAX_ALLOWED_BASIS_POINTS,
  SECTOR_ATTRIBUTABLE_RESOLVED_CONFIDENCES,
  canonicalize,
  computeConfigurationFingerprint,
  resolveRiskBand,
  resolveDisplayScore,
  selectBucket,
  isValidFactorKey,
  isValidExplanationCode,
  assertConfigurationCoherent,
} = require("../../src/services/risk/riskConfiguration");

describe("locked identity and scale", () => {
  it("pins the approved algorithm and configuration versions", () => {
    expect(RISK_ALGORITHM_VERSION).toBe("risk-additive-bucketed-v1");
    expect(RISK_CONFIGURATION_VERSION).toBe("v1.0.0");
  });

  it("pins the approved integer basis-point scale", () => {
    expect(SCORE_MIN_BASIS_POINTS).toBe(0);
    expect(SCORE_MAX_BASIS_POINTS).toBe(10000);
    expect(DISPLAY_SCORE_DIVISOR).toBe(100);
  });

  it("pins the approved 3650-day normalized-input clamp (G7)", () => {
    expect(MAX_NORMALIZED_DAYS).toBe(3650);
    expect(MILLISECONDS_PER_DAY).toBe(86400000);
  });
});

describe("locked factor caps", () => {
  // Transcribed from the approval's "Final locked factor caps" table.
  const APPROVED_CAPS = {
    sourceSeverity: 800,
    exposureCriticality: 1500,
    persistence: 1200,
    recurrence: 1300,
    daysUnresolved: 1200,
    iocReputationContext: 1200,
    sectorCriticality: 1300,
    cvePresence: 300,
    kevStatus: 800,
    epssScore: 400,
  };

  it("matches the approved cap for every factor, and no others exist", () => {
    expect(FACTOR_MAXIMUMS).toEqual(APPROVED_CAPS);
    expect([...RISK_FACTOR_KEY_VALUES].sort()).toEqual(Object.keys(APPROVED_CAPS).sort());
  });

  it("sums to exactly 10000 basis points", () => {
    const total = Object.values(APPROVED_CAPS).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(10000);
    expect(total).toBe(SCORE_MAX_BASIS_POINTS);
  });

  it("keeps iocReputationContext at or under the mandated 1200 ceiling (D-003)", () => {
    expect(IOC_REPUTATION_MAX_ALLOWED_BASIS_POINTS).toBe(1200);
    expect(FACTOR_MAXIMUMS.iocReputationContext).toBeLessThanOrEqual(1200);
  });

  it("lets a finding with no CVE input still reach CRITICAL on the other seven factors", () => {
    const vulnerabilityTotal = VULNERABILITY_FACTOR_KEYS.reduce(
      (sum, key) => sum + FACTOR_MAXIMUMS[key],
      0
    );
    expect(vulnerabilityTotal).toBe(1500);
    const nonVulnerabilityTotal = SCORE_MAX_BASIS_POINTS - vulnerabilityTotal;
    expect(nonVulnerabilityTotal).toBe(8500);
    // CRITICAL floor is 8000, so 8500 clears it.
    expect(nonVulnerabilityTotal).toBeGreaterThanOrEqual(8000);
  });

  it("never lets the vulnerability factors dominate the total", () => {
    const vulnerabilityTotal = VULNERABILITY_FACTOR_KEYS.reduce(
      (sum, key) => sum + FACTOR_MAXIMUMS[key],
      0
    );
    expect(vulnerabilityTotal * 2).toBeLessThan(SCORE_MAX_BASIS_POINTS);
  });
});

describe("locked bands", () => {
  it("matches the approved band table exactly", () => {
    expect(RISK_BAND_TABLE.map((row) => [row.band, row.minBasisPoints, row.maxBasisPoints])).toEqual([
      ["INFORMATIONAL", 0, 1499],
      ["LOW", 1500, 3499],
      ["MEDIUM", 3500, 5999],
      ["HIGH", 6000, 7999],
      ["CRITICAL", 8000, 10000],
    ]);
  });

  it("tiles 0..10000 with no gap and no overlap", () => {
    let expectedNext = 0;
    RISK_BAND_TABLE.forEach((row) => {
      expect(row.minBasisPoints).toBe(expectedNext);
      expect(row.maxBasisPoints).toBeGreaterThanOrEqual(row.minBasisPoints);
      expectedNext = row.maxBasisPoints + 1;
    });
    expect(expectedNext).toBe(10001);
  });

  it("resolves the band at every boundary from the score alone", () => {
    const cases = [
      [0, RISK_BAND.INFORMATIONAL],
      [1499, RISK_BAND.INFORMATIONAL],
      [1500, RISK_BAND.LOW],
      [3499, RISK_BAND.LOW],
      [3500, RISK_BAND.MEDIUM],
      [5999, RISK_BAND.MEDIUM],
      [6000, RISK_BAND.HIGH],
      [7999, RISK_BAND.HIGH],
      [8000, RISK_BAND.CRITICAL],
      [10000, RISK_BAND.CRITICAL],
    ];
    cases.forEach(([score, band]) => {
      expect(resolveRiskBand(score)).toBe(band);
    });
  });

  it("rejects a non-integer or out-of-range score rather than guessing a band", () => {
    expect(() => resolveRiskBand(1500.5)).toThrow(TypeError);
    expect(() => resolveRiskBand("1500")).toThrow(TypeError);
    expect(() => resolveRiskBand(-1)).toThrow(RangeError);
    expect(() => resolveRiskBand(10001)).toThrow(RangeError);
  });
});

describe("displayScore", () => {
  it("floors, never rounds, so a display never overstates the stored score", () => {
    expect(resolveDisplayScore(0)).toBe(0);
    expect(resolveDisplayScore(99)).toBe(0);
    expect(resolveDisplayScore(2300)).toBe(23);
    expect(resolveDisplayScore(2399)).toBe(23);
    expect(resolveDisplayScore(3499)).toBe(34);
    expect(resolveDisplayScore(10000)).toBe(100);
  });

  it("rejects a non-integer score", () => {
    expect(() => resolveDisplayScore(23.5)).toThrow(TypeError);
  });
});

describe("bucket selection", () => {
  it("selects the first covering bucket and treats a null maxInclusive as open ended", () => {
    const buckets = RISK_CONFIGURATION.persistenceBuckets;
    expect(selectBucket(buckets, 1).contributionBasisPoints).toBe(0);
    expect(selectBucket(buckets, 2).contributionBasisPoints).toBe(400);
    expect(selectBucket(buckets, 3).contributionBasisPoints).toBe(400);
    expect(selectBucket(buckets, 4).contributionBasisPoints).toBe(800);
    expect(selectBucket(buckets, 7).contributionBasisPoints).toBe(800);
    expect(selectBucket(buckets, 8).contributionBasisPoints).toBe(1200);
    expect(selectBucket(buckets, 100000).contributionBasisPoints).toBe(1200);
  });

  it("returns null (fail-closed) for a non-integer or uncovered value", () => {
    expect(selectBucket(RISK_CONFIGURATION.persistenceBuckets, 0)).toBeNull();
    expect(selectBucket(RISK_CONFIGURATION.persistenceBuckets, 1.5)).toBeNull();
    expect(selectBucket(RISK_CONFIGURATION.persistenceBuckets, null)).toBeNull();
    expect(selectBucket(RISK_CONFIGURATION.persistenceBuckets, "3")).toBeNull();
  });
});

describe("locked bucket tables", () => {
  const asPairs = (buckets) =>
    buckets.map((b) => [b.minInclusive, b.maxInclusive, b.contributionBasisPoints]);

  it("persistence — count-based (G3/G5)", () => {
    expect(asPairs(RISK_CONFIGURATION.persistenceBuckets)).toEqual([
      [1, 1, 0],
      [2, 3, 400],
      [4, 7, 800],
      [8, null, 1200],
    ]);
  });

  it("recurrence — reopened-after-closure only", () => {
    expect(asPairs(RISK_CONFIGURATION.recurrenceBuckets)).toEqual([
      [0, 0, 0],
      [1, 1, 700],
      [2, 2, 1050],
      [3, null, 1300],
    ]);
  });

  it("daysUnresolved — the approved 0/400/800/1200 buckets (amendment 3)", () => {
    expect(asPairs(RISK_CONFIGURATION.daysUnresolvedBuckets)).toEqual([
      [0, 6, 0],
      [7, 29, 400],
      [30, 89, 800],
      [90, null, 1200],
    ]);
  });

  it("iocReputationContext — score 0 is its own APPLIED bucket", () => {
    expect(asPairs(RISK_CONFIGURATION.iocReputationBuckets)).toEqual([
      [0, 0, 0],
      [1, 24, 300],
      [25, 49, 600],
      [50, 74, 900],
      [75, 100, 1200],
    ]);
    expect(selectBucket(RISK_CONFIGURATION.iocReputationBuckets, 0).explanationCode).toBe(
      RISK_EXPLANATION_CODES.IOC_REPUTATION_NONE
    );
  });

  it("sourceSeverity and exposureCriticality are keyed, never guessed (G1)", () => {
    expect(RISK_CONFIGURATION.sourceSeverityByReportType.ACCESSIBLE_RDP.contributionBasisPoints).toBe(
      800
    );
    expect(RISK_CONFIGURATION.exposureCriticalityByService["TCP/3389"].contributionBasisPoints).toBe(
      1500
    );
    // No wildcard/default entry exists for either — an unmapped input must be
    // NOT_AVAILABLE, never a fallback score.
    expect(Object.keys(RISK_CONFIGURATION.sourceSeverityByReportType)).toEqual(["ACCESSIBLE_RDP"]);
    expect(Object.keys(RISK_CONFIGURATION.exposureCriticalityByService)).toEqual(["TCP/3389"]);
  });

  it("the fixed ACCESSIBLE_RDP baseline is 2300 basis points — LOW, never INFORMATIONAL (G2)", () => {
    const baseline =
      RISK_CONFIGURATION.sourceSeverityByReportType.ACCESSIBLE_RDP.contributionBasisPoints +
      RISK_CONFIGURATION.exposureCriticalityByService["TCP/3389"].contributionBasisPoints;
    expect(baseline).toBe(2300);
    expect(resolveRiskBand(baseline)).toBe(RISK_BAND.LOW);
  });

  it("sector contributions never exceed the sectorCriticality cap", () => {
    Object.values(RISK_CONFIGURATION.sectorContributions).forEach((entry) => {
      expect(entry.contributionBasisPoints).toBeLessThanOrEqual(FACTOR_MAXIMUMS.sectorCriticality);
    });
    expect(RISK_CONFIGURATION.sectorContributions.CRITICAL_NATIONAL_INFRASTRUCTURE.contributionBasisPoints).toBe(
      1300
    );
  });

  it("UNKNOWN is not a scorable sector — missing context is never the least risky sector", () => {
    expect(RISK_CONFIGURATION.sectorContributions.UNKNOWN).toBeUndefined();
  });
});

describe("amendment 1 — NOT_FOUND is an unavailable status, not a scored bucket", () => {
  it("maps NOT_FOUND onto IOC_REPUTATION_NOT_FOUND in the unavailable table", () => {
    expect(RISK_CONFIGURATION.iocUnavailableCodeByStatus.NOT_FOUND).toBe(
      RISK_EXPLANATION_CODES.IOC_REPUTATION_NOT_FOUND
    );
  });

  it("gives every non-reputation-bearing provider status its own honest code", () => {
    expect(RISK_CONFIGURATION.iocUnavailableCodeByStatus).toEqual({
      NOT_FOUND: "IOC_REPUTATION_NOT_FOUND",
      RATE_LIMITED: "IOC_REPUTATION_RATE_LIMITED",
      TIMEOUT: "IOC_REPUTATION_TIMEOUT",
      FAILED: "IOC_REPUTATION_FAILED",
      INVALID_KEY: "IOC_REPUTATION_INVALID_KEY",
      SKIPPED_DISABLED: "IOC_REPUTATION_DISABLED",
      UNSUPPORTED_INDICATOR: "IOC_REPUTATION_UNSUPPORTED",
      PENDING: "IOC_REPUTATION_PENDING",
      DEAD_LETTER: "IOC_REPUTATION_DEAD_LETTER",
    });
  });
});

describe("amendment 2 — sector applicability confidence gate", () => {
  it("accepts only HIGH/MEDIUM (plus the structurally stronger CONFIRMED) for RESOLVED ownership", () => {
    expect(SECTOR_ATTRIBUTABLE_RESOLVED_CONFIDENCES).toContain("HIGH");
    expect(SECTOR_ATTRIBUTABLE_RESOLVED_CONFIDENCES).toContain("MEDIUM");
    expect(SECTOR_ATTRIBUTABLE_RESOLVED_CONFIDENCES).not.toContain("LOW");
  });

  it("has a dedicated low-confidence explanation code", () => {
    expect(RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_LOW_CONFIDENCE).toBe(
      "SECTOR_NOT_AVAILABLE_LOW_CONFIDENCE"
    );
  });
});

describe("applicability and factor vocabularies", () => {
  it("exposes exactly the three approved applicability states", () => {
    expect(RISK_APPLICABILITY).toEqual({
      APPLIED: "APPLIED",
      NOT_AVAILABLE: "NOT_AVAILABLE",
      NOT_APPLICABLE: "NOT_APPLICABLE",
    });
  });

  it("validates factor keys and explanation codes against a closed vocabulary", () => {
    expect(isValidFactorKey(RISK_FACTOR_KEYS.PERSISTENCE)).toBe(true);
    expect(isValidFactorKey("ownershipConfidence")).toBe(false);
    expect(isValidFactorKey(null)).toBe(false);
    expect(isValidExplanationCode(RISK_EXPLANATION_CODES.KEV_LISTED)).toBe(true);
    expect(isValidExplanationCode("ANYTHING_ELSE")).toBe(false);
  });

  it("lists every factor exactly once in display order", () => {
    expect([...FACTOR_DISPLAY_ORDER].sort()).toEqual([...RISK_FACTOR_KEY_VALUES].sort());
    expect(new Set(FACTOR_DISPLAY_ORDER).size).toBe(FACTOR_DISPLAY_ORDER.length);
    expect(FACTOR_DISPLAY_ORDER).toEqual([
      "sourceSeverity",
      "exposureCriticality",
      "persistence",
      "recurrence",
      "daysUnresolved",
      "iocReputationContext",
      "sectorCriticality",
      "cvePresence",
      "kevStatus",
      "epssScore",
    ]);
  });

  it("does not expose ownership as a factor key — ownership is contextual only", () => {
    RISK_FACTOR_KEY_VALUES.forEach((key) => {
      expect(key.toLowerCase()).not.toContain("ownership");
    });
  });
});

describe("immutability", () => {
  it("is deeply frozen, so a weight cannot be mutated at runtime", () => {
    expect(Object.isFrozen(RISK_CONFIGURATION)).toBe(true);
    expect(Object.isFrozen(RISK_CONFIGURATION.factorMaximums)).toBe(true);
    expect(Object.isFrozen(RISK_CONFIGURATION.persistenceBuckets)).toBe(true);
    expect(Object.isFrozen(RISK_CONFIGURATION.persistenceBuckets[0])).toBe(true);

    // Silent no-op in sloppy mode, TypeError in strict mode; either way the
    // value must be unchanged afterwards.
    try {
      RISK_CONFIGURATION.factorMaximums.persistence = 9999;
    } catch (_error) {
      /* strict-mode throw is an acceptable outcome */
    }
    expect(RISK_CONFIGURATION.factorMaximums.persistence).toBe(1200);
  });
});

describe("configuration fingerprint", () => {
  it("is a stable sha256 hex digest of the canonical serialization", () => {
    expect(RISK_CONFIGURATION_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
    const expected = crypto
      .createHash("sha256")
      .update(canonicalize(RISK_CONFIGURATION), "utf8")
      .digest("hex");
    expect(RISK_CONFIGURATION_FINGERPRINT).toBe(expected);
  });

  it("is deterministic across repeated computation", () => {
    expect(computeConfigurationFingerprint()).toBe(RISK_CONFIGURATION_FINGERPRINT);
    expect(computeConfigurationFingerprint()).toBe(computeConfigurationFingerprint());
  });

  it("changes when any weight changes", () => {
    const tampered = JSON.parse(JSON.stringify(RISK_CONFIGURATION));
    tampered.factorMaximums.persistence = 1201;
    expect(computeConfigurationFingerprint(tampered)).not.toBe(RISK_CONFIGURATION_FINGERPRINT);
  });

  it("is insensitive to key ORDER but sensitive to key VALUES", () => {
    // Canonicalization sorts object keys, so two orderings of the same data
    // must hash identically — that is what makes the fingerprint comparable
    // across machines and replays.
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize({ a: 1, b: 2 })).not.toBe(canonicalize({ a: 1, b: 3 }));
    // Array order, by contrast, is meaningful (bucket precedence).
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
});

describe("load-time coherence proof", () => {
  it("passes for the shipped contract", () => {
    expect(() => assertConfigurationCoherent()).not.toThrow();
  });
});
