import { describe, it, expect } from "vitest";

// P2-T3 — the pure deterministic risk engine.
//
// No Prisma, no clock, no network, no randomness: every case here is a fixed
// input snapshot with a HAND-DERIVED expected score, computed from the locked
// contract in STATUS.md rather than read back from the implementation.
//
// The three architect amendments each get their own describe block, because
// they are the cases most likely to be silently regressed by a later refactor.

const { calculateRisk, finalizeFactor, RiskEngineError } = require("../../src/services/risk/riskEngine");
const {
  RISK_CONFIGURATION,
  RISK_CONFIGURATION_FINGERPRINT,
  RISK_APPLICABILITY,
  RISK_BAND,
  FACTOR_DISPLAY_ORDER,
  FACTOR_MAXIMUMS,
} = require("../../src/services/risk/riskConfiguration");

const ASOF = new Date("2026-07-01T00:00:00Z");

// A finding at the fixed ACCESSIBLE_RDP baseline: one observation, never
// recurred, open today, no enrichment, no ownership, no CVE.
// Hand-derived total: 800 + 1500 = 2300 -> LOW.
const BASELINE_INPUTS = Object.freeze({
  reportType: "ACCESSIBLE_RDP",
  protocol: "TCP",
  port: 3389,
  findingStatus: "OPEN",

  observationCount: 1,
  recurredCount: 0,
  daysUnresolved: 0,

  enrichmentPresent: false,
  enrichmentStatus: null,
  enrichmentFresh: false,
  abuseConfidenceScore: null,

  ownershipStatus: null,
  ownershipConfidence: null,
  ownershipIsIspAttribution: false,
  sectorAttributable: false,
  sectorNonAttributableReason: "NO_OWNERSHIP",
  sector: null,

  cvePresent: false,
  kevListed: null,
  kevLookupAvailable: false,
  epssBasisPoints: null,
});

function snapshot(overrides = {}) {
  return {
    findingId: 1,
    asOf: ASOF,
    algorithmVersion: RISK_CONFIGURATION.algorithmVersion,
    configurationVersion: RISK_CONFIGURATION.configurationVersion,
    configurationFingerprint: RISK_CONFIGURATION_FINGERPRINT,
    // The engine only requires a non-empty string here; the real fingerprint is
    // built by riskInputSnapshot and tested there.
    inputFingerprint: "test-input-fingerprint",
    inputs: { ...BASELINE_INPUTS, ...overrides },
  };
}

function score(overrides = {}) {
  return calculateRisk({ inputSnapshot: snapshot(overrides) });
}

function factor(result, factorKey) {
  const row = result.contributions.find((c) => c.factorKey === factorKey);
  if (!row) throw new Error(`no contribution emitted for ${factorKey}`);
  return row;
}

describe("structural guarantees", () => {
  it("emits exactly one contribution per approved factor, in locked display order", () => {
    const result = score();
    expect(result.contributions).toHaveLength(FACTOR_DISPLAY_ORDER.length);
    expect(result.contributions.map((c) => c.factorKey)).toEqual([...FACTOR_DISPLAY_ORDER]);
    expect(result.contributions.map((c) => c.displayOrder)).toEqual(
      FACTOR_DISPLAY_ORDER.map((_key, index) => index)
    );
  });

  it("emits stored rows even for NOT_AVAILABLE and NOT_APPLICABLE factors", () => {
    const result = score();
    const unavailable = result.contributions.filter(
      (c) => c.applicability === RISK_APPLICABILITY.NOT_AVAILABLE
    );
    const notApplicable = result.contributions.filter(
      (c) => c.applicability === RISK_APPLICABILITY.NOT_APPLICABLE
    );
    // baseline: ioc + sector unavailable; cve/kev/epss not applicable (G4).
    expect(unavailable.map((c) => c.factorKey)).toEqual([
      "iocReputationContext",
      "sectorCriticality",
    ]);
    expect(notApplicable.map((c) => c.factorKey)).toEqual(["cvePresence", "kevStatus", "epssScore"]);
  });

  it("records the cap alongside every contribution so an old score stays explicable", () => {
    const result = score();
    result.contributions.forEach((row) => {
      expect(row.maximumContributionBasisPoints).toBe(FACTOR_MAXIMUMS[row.factorKey]);
    });
  });

  it("never lets a non-APPLIED factor carry basis points", () => {
    const result = score();
    result.contributions.forEach((row) => {
      if (row.applicability !== RISK_APPLICABILITY.APPLIED) {
        expect(row.contributionBasisPoints).toBe(0);
      }
    });
  });

  it("is deterministic: identical input yields byte-identical output", () => {
    const a = score({ observationCount: 5, recurredCount: 2, daysUnresolved: 45 });
    const b = score({ observationCount: 5, recurredCount: 2, daysUnresolved: 45 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("returns a frozen result whose contributions cannot be mutated", () => {
    const result = score();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.contributions)).toBe(true);
    expect(Object.isFrozen(result.contributions[0])).toBe(true);
  });

  it("rejects a missing or malformed snapshot rather than scoring a guess", () => {
    expect(() => calculateRisk({})).toThrow(RiskEngineError);
    expect(() => calculateRisk({ inputSnapshot: {} })).toThrow(RiskEngineError);
    expect(() => calculateRisk({ inputSnapshot: { inputs: {} } })).toThrow(RiskEngineError);
    expect(() =>
      calculateRisk({ inputSnapshot: { inputs: {}, inputFingerprint: "" } })
    ).toThrow(RiskEngineError);
  });
});

describe("the fixed ACCESSIBLE_RDP baseline (G2)", () => {
  it("scores 2300 basis points, display 23, band LOW — never INFORMATIONAL", () => {
    const result = score();
    expect(result.scoreBasisPoints).toBe(2300);
    expect(result.displayScore).toBe(23);
    expect(result.riskBand).toBe(RISK_BAND.LOW);
    expect(factor(result, "sourceSeverity")).toMatchObject({
      applicability: "APPLIED",
      contributionBasisPoints: 800,
      explanationCode: "SOURCE_SEVERITY_ACCESSIBLE_RDP",
      normalizedInputValue: "ACCESSIBLE_RDP",
    });
    expect(factor(result, "exposureCriticality")).toMatchObject({
      applicability: "APPLIED",
      contributionBasisPoints: 1500,
      explanationCode: "EXPOSURE_CRITICALITY_REMOTE_ACCESS_RDP",
      normalizedInputValue: "TCP/3389",
    });
  });

  it("carries the algorithm/configuration identity onto the result", () => {
    const result = score();
    expect(result.algorithmVersion).toBe("risk-additive-bucketed-v1");
    expect(result.configurationVersion).toBe("v1.0.0");
    expect(result.configurationFingerprint).toBe(RISK_CONFIGURATION_FINGERPRINT);
  });
});

describe("factor 1/2 — unmapped inputs are NOT_AVAILABLE, never a fallback score", () => {
  it("marks an unknown report type NOT_AVAILABLE", () => {
    const result = score({ reportType: "SOME_FUTURE_REPORT" });
    expect(factor(result, "sourceSeverity")).toMatchObject({
      applicability: "NOT_AVAILABLE",
      contributionBasisPoints: 0,
      explanationCode: "SOURCE_SEVERITY_NOT_AVAILABLE",
      normalizedInputValue: null,
    });
    expect(result.scoreBasisPoints).toBe(1500);
  });

  it("marks an unmapped protocol/port pair NOT_AVAILABLE but still records what it saw", () => {
    const result = score({ protocol: "TCP", port: 22 });
    expect(factor(result, "exposureCriticality")).toMatchObject({
      applicability: "NOT_AVAILABLE",
      contributionBasisPoints: 0,
      explanationCode: "EXPOSURE_CRITICALITY_NOT_AVAILABLE",
      normalizedInputValue: "TCP/22",
    });
    expect(result.scoreBasisPoints).toBe(800);
  });

  it("marks a missing port NOT_AVAILABLE with a null normalized input", () => {
    const result = score({ port: null });
    expect(factor(result, "exposureCriticality")).toMatchObject({
      applicability: "NOT_AVAILABLE",
      normalizedInputValue: null,
    });
  });
});

describe("factor 3 — persistence is count-based over immutable occurrences (G3/G5)", () => {
  const cases = [
    [1, 0, "PERSISTENCE_SINGLE_OBSERVATION"],
    [2, 400, "PERSISTENCE_REPEATED"],
    [3, 400, "PERSISTENCE_REPEATED"],
    [4, 800, "PERSISTENCE_SUSTAINED"],
    [7, 800, "PERSISTENCE_SUSTAINED"],
    [8, 1200, "PERSISTENCE_ENTRENCHED"],
    [500, 1200, "PERSISTENCE_ENTRENCHED"],
  ];

  it.each(cases)("count %i contributes %i (%s)", (count, expected, code) => {
    const result = score({ observationCount: count });
    expect(factor(result, "persistence")).toMatchObject({
      applicability: "APPLIED",
      contributionBasisPoints: expected,
      explanationCode: code,
      normalizedInputValue: String(count),
    });
    expect(result.scoreBasisPoints).toBe(2300 + expected);
  });

  it("treats zero or malformed occurrence evidence as NOT_AVAILABLE, not as a single observation", () => {
    [0, -1, null, undefined, "3"].forEach((value) => {
      const result = score({ observationCount: value });
      expect(factor(result, "persistence")).toMatchObject({
        applicability: "NOT_AVAILABLE",
        contributionBasisPoints: 0,
        explanationCode: "PERSISTENCE_NO_EVIDENCE",
      });
    });
  });
});

describe("factor 4 — recurrence means reopened after a human closed it", () => {
  const cases = [
    [0, 0, "RECURRENCE_NONE"],
    [1, 700, "RECURRENCE_ONCE_AFTER_CLOSURE"],
    [2, 1050, "RECURRENCE_REPEATED_AFTER_CLOSURE"],
    [3, 1300, "RECURRENCE_CHRONIC_AFTER_CLOSURE"],
    [12, 1300, "RECURRENCE_CHRONIC_AFTER_CLOSURE"],
  ];

  it.each(cases)("recurredCount %i contributes %i (%s)", (count, expected, code) => {
    const result = score({ recurredCount: count });
    expect(factor(result, "recurrence")).toMatchObject({
      applicability: "APPLIED",
      contributionBasisPoints: expected,
      explanationCode: code,
    });
  });

  it("never exceeds its 1300 cap", () => {
    const result = score({ recurredCount: 1000 });
    expect(factor(result, "recurrence").contributionBasisPoints).toBeLessThanOrEqual(1300);
  });

  it("treats a malformed recurrence count as NOT_AVAILABLE", () => {
    const result = score({ recurredCount: -1 });
    expect(factor(result, "recurrence").applicability).toBe("NOT_AVAILABLE");
  });
});

describe("amendment 3 — daysUnresolved is the CURRENT unresolved episode", () => {
  it("is NOT_APPLICABLE for a CLOSED finding, distinct from 'could not compute'", () => {
    const result = score({ findingStatus: "CLOSED", daysUnresolved: null });
    expect(factor(result, "daysUnresolved")).toMatchObject({
      applicability: "NOT_APPLICABLE",
      contributionBasisPoints: 0,
      explanationCode: "DAYS_UNRESOLVED_NOT_APPLICABLE_CLOSED",
      normalizedInputValue: null,
    });
  });

  it("ignores a stale non-null day count when the finding is CLOSED", () => {
    // Defence in depth: even if a caller handed us days for a closed finding,
    // time spent CLOSED must never be scored as unresolved time.
    const result = score({ findingStatus: "CLOSED", daysUnresolved: 900 });
    expect(factor(result, "daysUnresolved")).toMatchObject({
      applicability: "NOT_APPLICABLE",
      contributionBasisPoints: 0,
    });
    expect(result.scoreBasisPoints).toBe(2300);
  });

  it("is NOT_AVAILABLE with the invalid-timestamp code when the episode start is unusable", () => {
    [null, undefined, -1, 1.5].forEach((value) => {
      const result = score({ daysUnresolved: value });
      expect(factor(result, "daysUnresolved")).toMatchObject({
        applicability: "NOT_AVAILABLE",
        contributionBasisPoints: 0,
        explanationCode: "DAYS_UNRESOLVED_INVALID_TIMESTAMP",
        normalizedInputValue: null,
      });
    });
  });

  const buckets = [
    [0, 0, "DAYS_UNRESOLVED_UNDER_7"],
    [6, 0, "DAYS_UNRESOLVED_UNDER_7"],
    [7, 400, "DAYS_UNRESOLVED_7_TO_29"],
    [29, 400, "DAYS_UNRESOLVED_7_TO_29"],
    [30, 800, "DAYS_UNRESOLVED_30_TO_89"],
    [89, 800, "DAYS_UNRESOLVED_30_TO_89"],
    [90, 1200, "DAYS_UNRESOLVED_90_PLUS"],
    [3650, 1200, "DAYS_UNRESOLVED_90_PLUS"],
  ];

  it.each(buckets)("%i days contributes %i (%s)", (days, expected, code) => {
    const result = score({ daysUnresolved: days });
    expect(factor(result, "daysUnresolved")).toMatchObject({
      applicability: "APPLIED",
      contributionBasisPoints: expected,
      explanationCode: code,
      normalizedInputValue: String(days),
    });
  });
});

describe("amendment 1 — IOC reputation availability semantics", () => {
  const fresh = (status, overrides = {}) => ({
    enrichmentPresent: true,
    enrichmentStatus: status,
    enrichmentFresh: true,
    ...overrides,
  });

  it("scores a fresh SUCCESS with abuseConfidenceScore 0 as APPLIED / 0 / IOC_REPUTATION_NONE", () => {
    const result = score(fresh("SUCCESS", { abuseConfidenceScore: 0 }));
    expect(factor(result, "iocReputationContext")).toMatchObject({
      applicability: "APPLIED",
      contributionBasisPoints: 0,
      explanationCode: "IOC_REPUTATION_NONE",
      normalizedInputValue: "0",
    });
  });

  it("treats a fresh NOT_FOUND as NOT_AVAILABLE / 0 / IOC_REPUTATION_NOT_FOUND with a null input", () => {
    const result = score(fresh("NOT_FOUND"));
    expect(factor(result, "iocReputationContext")).toMatchObject({
      applicability: "NOT_AVAILABLE",
      contributionBasisPoints: 0,
      explanationCode: "IOC_REPUTATION_NOT_FOUND",
      normalizedInputValue: null,
    });
  });

  it("keeps SUCCESS-score-0 and NOT_FOUND structurally distinct, both scoring 2300", () => {
    const successZero = score(fresh("SUCCESS", { abuseConfidenceScore: 0 }));
    const notFound = score(fresh("NOT_FOUND"));
    expect(successZero.scoreBasisPoints).toBe(2300);
    expect(notFound.scoreBasisPoints).toBe(2300);
    // Same number, deliberately different meaning.
    expect(factor(successZero, "iocReputationContext").applicability).toBe("APPLIED");
    expect(factor(notFound, "iocReputationContext").applicability).toBe("NOT_AVAILABLE");
  });

  const scoreBuckets = [
    [1, 300, "IOC_REPUTATION_LOW"],
    [24, 300, "IOC_REPUTATION_LOW"],
    [25, 600, "IOC_REPUTATION_MEDIUM"],
    [49, 600, "IOC_REPUTATION_MEDIUM"],
    [50, 900, "IOC_REPUTATION_HIGH"],
    [74, 900, "IOC_REPUTATION_HIGH"],
    [75, 1200, "IOC_REPUTATION_VERY_HIGH"],
    [100, 1200, "IOC_REPUTATION_VERY_HIGH"],
  ];

  it.each(scoreBuckets)(
    "a fresh SUCCESS with confidence %i contributes %i (%s)",
    (confidence, expected, code) => {
      const result = score(fresh("SUCCESS", { abuseConfidenceScore: confidence }));
      expect(factor(result, "iocReputationContext")).toMatchObject({
        applicability: "APPLIED",
        contributionBasisPoints: expected,
        explanationCode: code,
      });
      expect(result.scoreBasisPoints).toBe(2300 + expected);
    }
  );

  it("never exceeds the 1200 reputation ceiling even at confidence 100", () => {
    const result = score(fresh("SUCCESS", { abuseConfidenceScore: 100 }));
    expect(factor(result, "iocReputationContext").contributionBasisPoints).toBe(1200);
  });

  it("marks an expired reputation row STALE, never clean", () => {
    ["SUCCESS", "NOT_FOUND"].forEach((status) => {
      const result = score({
        enrichmentPresent: true,
        enrichmentStatus: status,
        enrichmentFresh: false,
        abuseConfidenceScore: status === "SUCCESS" ? 90 : null,
      });
      expect(factor(result, "iocReputationContext")).toMatchObject({
        applicability: "NOT_AVAILABLE",
        contributionBasisPoints: 0,
        explanationCode: "IOC_REPUTATION_STALE",
      });
    });
  });

  it("gives every provider failure state its own honest unavailable code", () => {
    const expectations = {
      RATE_LIMITED: "IOC_REPUTATION_RATE_LIMITED",
      TIMEOUT: "IOC_REPUTATION_TIMEOUT",
      FAILED: "IOC_REPUTATION_FAILED",
      INVALID_KEY: "IOC_REPUTATION_INVALID_KEY",
      SKIPPED_DISABLED: "IOC_REPUTATION_DISABLED",
      UNSUPPORTED_INDICATOR: "IOC_REPUTATION_UNSUPPORTED",
      PENDING: "IOC_REPUTATION_PENDING",
      DEAD_LETTER: "IOC_REPUTATION_DEAD_LETTER",
    };
    Object.entries(expectations).forEach(([status, code]) => {
      const result = score(fresh(status));
      expect(factor(result, "iocReputationContext")).toMatchObject({
        applicability: "NOT_AVAILABLE",
        contributionBasisPoints: 0,
        explanationCode: code,
      });
    });
  });

  it("reports a complete absence of any lookup as IOC_REPUTATION_ABSENT", () => {
    const result = score({ enrichmentPresent: false, enrichmentStatus: null });
    expect(factor(result, "iocReputationContext").explanationCode).toBe("IOC_REPUTATION_ABSENT");
  });

  it("does not score a fresh SUCCESS whose confidence value is missing or malformed", () => {
    [null, undefined, 101, -1, "80"].forEach((value) => {
      const result = score(fresh("SUCCESS", { abuseConfidenceScore: value }));
      expect(factor(result, "iocReputationContext")).toMatchObject({
        applicability: "NOT_AVAILABLE",
        contributionBasisPoints: 0,
      });
    });
  });
});

describe("amendment 2 — sectorCriticality applies only when ownership can attribute it", () => {
  const attributable = (sector, overrides = {}) => ({
    ownershipStatus: "OVERRIDDEN",
    ownershipConfidence: "CONFIRMED",
    ownershipIsIspAttribution: false,
    sectorAttributable: true,
    sectorNonAttributableReason: null,
    sector,
    ...overrides,
  });

  const sectors = [
    ["CRITICAL_NATIONAL_INFRASTRUCTURE", 1300, "SECTOR_CNI"],
    ["GOVERNMENT", 1100, "SECTOR_GOVERNMENT"],
    ["ENERGY", 1100, "SECTOR_ENERGY"],
    ["HEALTHCARE", 1000, "SECTOR_HEALTHCARE"],
    ["FINANCE", 1000, "SECTOR_FINANCE"],
    ["TELECOM", 900, "SECTOR_TELECOM"],
    ["EDUCATION", 500, "SECTOR_EDUCATION"],
    ["GENERAL", 300, "SECTOR_GENERAL"],
  ];

  it.each(sectors)("%s contributes %i (%s) when attributable", (sector, expected, code) => {
    const result = score(attributable(sector));
    expect(factor(result, "sectorCriticality")).toMatchObject({
      applicability: "APPLIED",
      contributionBasisPoints: expected,
      explanationCode: code,
      normalizedInputValue: sector,
    });
    expect(result.scoreBasisPoints).toBe(2300 + expected);
  });

  const nonAttributable = [
    ["NO_OWNERSHIP", "SECTOR_NOT_AVAILABLE_NO_OWNERSHIP"],
    ["AMBIGUOUS", "SECTOR_NOT_AVAILABLE_AMBIGUOUS_OWNERSHIP"],
    ["UNRESOLVED", "SECTOR_NOT_AVAILABLE_UNRESOLVED_OWNERSHIP"],
    ["NO_ORGANIZATION", "SECTOR_NOT_AVAILABLE_UNRESOLVED_OWNERSHIP"],
    ["ISP_ATTRIBUTION", "SECTOR_NOT_AVAILABLE_ISP_ATTRIBUTION"],
    ["LOW_CONFIDENCE", "SECTOR_NOT_AVAILABLE_LOW_CONFIDENCE"],
    ["UNKNOWN_SECTOR", "SECTOR_NOT_AVAILABLE_UNKNOWN_SECTOR"],
  ];

  it.each(nonAttributable)("reason %s renders as %s and scores nothing", (reason, code) => {
    const result = score({ sectorAttributable: false, sectorNonAttributableReason: reason });
    expect(factor(result, "sectorCriticality")).toMatchObject({
      applicability: "NOT_AVAILABLE",
      contributionBasisPoints: 0,
      explanationCode: code,
      normalizedInputValue: null,
    });
    expect(result.scoreBasisPoints).toBe(2300);
  });

  it("scores nothing for a sector the contract does not price, even if marked attributable", () => {
    const result = score(attributable("UNKNOWN"));
    expect(factor(result, "sectorCriticality")).toMatchObject({
      applicability: "NOT_AVAILABLE",
      explanationCode: "SECTOR_NOT_AVAILABLE_UNKNOWN_SECTOR",
    });
  });

  it("adds no basis points for ownership status, confidence or ISP attribution themselves", () => {
    // Same finding, three very different ownership contexts, none attributable:
    // the score must be identical, because ownership is not a scored factor.
    const a = score({ ownershipStatus: "RESOLVED", ownershipConfidence: "LOW", sectorNonAttributableReason: "LOW_CONFIDENCE" });
    const b = score({ ownershipStatus: "AMBIGUOUS", ownershipConfidence: null, sectorNonAttributableReason: "AMBIGUOUS" });
    const c = score({
      ownershipStatus: "RESOLVED",
      ownershipConfidence: "LOW",
      ownershipIsIspAttribution: true,
      sectorNonAttributableReason: "ISP_ATTRIBUTION",
    });
    expect(a.scoreBasisPoints).toBe(2300);
    expect(b.scoreBasisPoints).toBe(2300);
    expect(c.scoreBasisPoints).toBe(2300);
  });
});

describe("G4 — vulnerability factors never fire for a finding with no CVE-bearing source", () => {
  it("marks cvePresence / kevStatus / epssScore NOT_APPLICABLE, all with stored rows", () => {
    const result = score();
    expect(factor(result, "cvePresence")).toMatchObject({
      applicability: "NOT_APPLICABLE",
      contributionBasisPoints: 0,
      explanationCode: "CVE_NOT_APPLICABLE_NO_CVE_SOURCE",
    });
    expect(factor(result, "kevStatus")).toMatchObject({
      applicability: "NOT_APPLICABLE",
      contributionBasisPoints: 0,
      explanationCode: "KEV_NOT_APPLICABLE_NO_CVE",
    });
    expect(factor(result, "epssScore")).toMatchObject({
      applicability: "NOT_APPLICABLE",
      contributionBasisPoints: 0,
      explanationCode: "EPSS_NOT_APPLICABLE_NO_CVE",
    });
  });

  it("never infers a CVE from an exposed RDP service, whatever the KEV/EPSS inputs say", () => {
    const result = score({ cvePresent: false, kevListed: true, kevLookupAvailable: true, epssBasisPoints: 9500 });
    expect(factor(result, "kevStatus").contributionBasisPoints).toBe(0);
    expect(factor(result, "epssScore").contributionBasisPoints).toBe(0);
    expect(result.scoreBasisPoints).toBe(2300);
  });

  it("prices the deferred CVE-bearing shape correctly if one is ever supplied", () => {
    const result = score({
      cvePresent: true,
      kevListed: true,
      kevLookupAvailable: true,
      epssBasisPoints: 9500,
    });
    expect(factor(result, "cvePresence").contributionBasisPoints).toBe(300);
    expect(factor(result, "kevStatus").contributionBasisPoints).toBe(800);
    expect(factor(result, "epssScore").contributionBasisPoints).toBe(400);
    expect(result.scoreBasisPoints).toBe(2300 + 1500);
  });

  it("distinguishes 'KEV catalogue not consulted' from 'CVE not on the catalogue'", () => {
    const unavailable = score({ cvePresent: true, kevLookupAvailable: false });
    expect(factor(unavailable, "kevStatus")).toMatchObject({
      applicability: "NOT_AVAILABLE",
      explanationCode: "KEV_NOT_AVAILABLE",
    });

    const notListed = score({ cvePresent: true, kevLookupAvailable: true, kevListed: false });
    expect(factor(notListed, "kevStatus")).toMatchObject({
      applicability: "APPLIED",
      contributionBasisPoints: 0,
      explanationCode: "KEV_NOT_LISTED",
    });
  });
});

describe("aggregation, capping and banding", () => {
  it("reaches CRITICAL on the seven non-vulnerability factors alone (8500)", () => {
    const result = score({
      observationCount: 8, // 1200
      recurredCount: 3, // 1300
      daysUnresolved: 90, // 1200
      enrichmentPresent: true,
      enrichmentStatus: "SUCCESS",
      enrichmentFresh: true,
      abuseConfidenceScore: 100, // 1200
      ownershipStatus: "OVERRIDDEN",
      ownershipConfidence: "CONFIRMED",
      sectorAttributable: true,
      sectorNonAttributableReason: null,
      sector: "CRITICAL_NATIONAL_INFRASTRUCTURE", // 1300
    });
    // 800 + 1500 + 1200 + 1300 + 1200 + 1200 + 1300 = 8500
    expect(result.scoreBasisPoints).toBe(8500);
    expect(result.displayScore).toBe(85);
    expect(result.riskBand).toBe(RISK_BAND.CRITICAL);
  });

  it("reaches exactly 10000 with every factor at its cap, and never exceeds it", () => {
    const result = score({
      observationCount: 8,
      recurredCount: 3,
      daysUnresolved: 3650,
      enrichmentPresent: true,
      enrichmentStatus: "SUCCESS",
      enrichmentFresh: true,
      abuseConfidenceScore: 100,
      ownershipStatus: "OVERRIDDEN",
      sectorAttributable: true,
      sectorNonAttributableReason: null,
      sector: "CRITICAL_NATIONAL_INFRASTRUCTURE",
      cvePresent: true,
      kevListed: true,
      kevLookupAvailable: true,
      epssBasisPoints: 10000,
    });
    expect(result.scoreBasisPoints).toBe(10000);
    expect(result.displayScore).toBe(100);
    expect(result.riskBand).toBe(RISK_BAND.CRITICAL);
  });

  it("lands each band from a hand-derived combination", () => {
    // LOW: baseline only.
    expect(score().riskBand).toBe(RISK_BAND.LOW);

    // MEDIUM: 2300 + 1300 (CNI) = 3600.
    const medium = score({
      ownershipStatus: "OVERRIDDEN",
      sectorAttributable: true,
      sectorNonAttributableReason: null,
      sector: "CRITICAL_NATIONAL_INFRASTRUCTURE",
    });
    expect(medium.scoreBasisPoints).toBe(3600);
    expect(medium.riskBand).toBe(RISK_BAND.MEDIUM);

    // HIGH: 2300 + 1200 (persistence) + 1300 (recurrence) + 1200 (90+ days) = 6000.
    const high = score({ observationCount: 8, recurredCount: 3, daysUnresolved: 90 });
    expect(high.scoreBasisPoints).toBe(6000);
    expect(high.riskBand).toBe(RISK_BAND.HIGH);
  });

  it("is purely additive — each factor's delta is independent of the others", () => {
    const base = score().scoreBasisPoints;
    const withPersistence = score({ observationCount: 4 }).scoreBasisPoints;
    const withRecurrence = score({ recurredCount: 1 }).scoreBasisPoints;
    const withBoth = score({ observationCount: 4, recurredCount: 1 }).scoreBasisPoints;
    expect(withPersistence - base).toBe(800);
    expect(withRecurrence - base).toBe(700);
    expect(withBoth - base).toBe(1500);
  });
});

describe("finalizeFactor — the structural choke point", () => {
  it("zeroes any contribution an evaluator attaches to a non-APPLIED result", () => {
    const row = finalizeFactor("persistence", {
      applicability: "NOT_AVAILABLE",
      contributionBasisPoints: 900,
      explanationCode: "PERSISTENCE_NO_EVIDENCE",
    });
    expect(row.contributionBasisPoints).toBe(0);
  });

  it("rejects an unknown factor, an invalid applicability, and an unknown explanation code", () => {
    expect(() =>
      finalizeFactor("ownershipConfidence", {
        applicability: "APPLIED",
        contributionBasisPoints: 0,
        explanationCode: "PERSISTENCE_NO_EVIDENCE",
      })
    ).toThrow(RiskEngineError);

    expect(() =>
      finalizeFactor("persistence", {
        applicability: "MAYBE",
        contributionBasisPoints: 0,
        explanationCode: "PERSISTENCE_NO_EVIDENCE",
      })
    ).toThrow(RiskEngineError);

    expect(() =>
      finalizeFactor("persistence", {
        applicability: "APPLIED",
        contributionBasisPoints: 0,
        explanationCode: "MADE_UP_CODE",
      })
    ).toThrow(RiskEngineError);
  });

  it("rejects a negative, non-integer or over-cap contribution", () => {
    const build = (contributionBasisPoints) => () =>
      finalizeFactor("persistence", {
        applicability: "APPLIED",
        contributionBasisPoints,
        explanationCode: "PERSISTENCE_REPEATED",
      });
    expect(build(-1)).toThrow(RiskEngineError);
    expect(build(1.5)).toThrow(RiskEngineError);
    expect(build(1201)).toThrow(RiskEngineError);
    expect(build(1200)).not.toThrow();
  });

  it("stringifies the normalized input and copies evidence rather than aliasing it", () => {
    const evidence = { observationCount: 4 };
    const row = finalizeFactor("persistence", {
      applicability: "APPLIED",
      contributionBasisPoints: 800,
      explanationCode: "PERSISTENCE_SUSTAINED",
      normalizedInputValue: 4,
      evidenceSnapshot: evidence,
    });
    expect(row.normalizedInputValue).toBe("4");
    expect(row.evidenceSnapshot).toEqual({ observationCount: 4 });
    expect(row.evidenceSnapshot).not.toBe(evidence);
    expect(Object.isFrozen(row.evidenceSnapshot)).toBe(true);
  });
});
