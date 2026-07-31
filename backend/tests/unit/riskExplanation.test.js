import { describe, it, expect } from "vitest";

// P2-T3 — explanation rendering.
//
// The rule under test: an explanation is rendered ONLY from persisted rows.
// No database, no live re-read, no AI, no provider text. Every sentence is
// looked up from a closed explanation code, with only the row's own stored
// normalizedInputValue interpolated.

const {
  EXPLANATION_TEMPLATES,
  UNKNOWN_CODE_SENTENCE,
  renderContributionExplanation,
  renderScoreExplanation,
} = require("../../src/services/risk/riskExplanation");
const {
  RISK_EXPLANATION_CODE_VALUES,
  RISK_EXPLANATION_CODES,
} = require("../../src/services/risk/riskConfiguration");

function contribution(overrides = {}) {
  return {
    factorKey: "persistence",
    applicability: "APPLIED",
    contributionBasisPoints: 400,
    maximumContributionBasisPoints: 1200,
    normalizedInputValue: "2",
    explanationCode: RISK_EXPLANATION_CODES.PERSISTENCE_REPEATED,
    displayOrder: 2,
    ...overrides,
  };
}

describe("closed vocabulary coverage", () => {
  it("has a template for every code the engine can emit", () => {
    const missing = RISK_EXPLANATION_CODE_VALUES.filter(
      (code) => typeof EXPLANATION_TEMPLATES[code] !== "string"
    );
    expect(missing).toEqual([]);
  });

  it("defines no template outside the closed vocabulary", () => {
    const extra = Object.keys(EXPLANATION_TEMPLATES).filter(
      (code) => !RISK_EXPLANATION_CODE_VALUES.includes(code)
    );
    expect(extra).toEqual([]);
  });

  // Strengthened for §2B Packet A. The two checks above compare the template
  // map against the declared VOCABULARY, which cannot catch a code the engine
  // genuinely emits but that was never declared — nor prove that a declared
  // code actually renders to a usable sentence. This drives the real engine
  // over a matrix that reaches every vulnerability branch (and the other
  // factors' unavailable paths), collects the codes ACTUALLY emitted, and
  // renders each one.
  it("renders a real sentence for every code the engine actually emits", () => {
    // eslint-disable-next-line global-require
    const { calculateRisk } = require("../../src/services/risk/riskEngine");

    const base = {
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
      activeCveIds: [],
      cvePresent: false,
      kevListed: null,
      kevLookupAvailable: false,
      kevListedCveId: null,
      epssBasisPoints: null,
      epssSelectedCveId: null,
    };

    const CVE = "CVE-2019-0708";
    const variations = [
      {}, // every vulnerability factor NOT_APPLICABLE
      // cvePresent with no usable KEV/EPSS context: the EPSS_NOT_AVAILABLE and
      // KEV_NOT_AVAILABLE branches that §2B Packet A introduced.
      { activeCveIds: [CVE], cvePresent: true },
      // KEV listed / not listed.
      { activeCveIds: [CVE], cvePresent: true, kevLookupAvailable: true, kevListed: true, kevListedCveId: CVE },
      { activeCveIds: [CVE], cvePresent: true, kevLookupAvailable: true, kevListed: false },
      // Every EPSS bucket, including a genuine score of 0.
      ...[0, 999, 1000, 4999, 5000, 8999, 9000, 10000].map((epssBasisPoints) => ({
        activeCveIds: [CVE],
        cvePresent: true,
        epssBasisPoints,
        epssSelectedCveId: CVE,
      })),
      // Non-vulnerability unavailable/applicable paths, so the assertion covers
      // the whole contract rather than only the new factors.
      { findingStatus: "CLOSED", daysUnresolved: null },
      { daysUnresolved: null },
      { observationCount: 0 },
      { observationCount: 5 },
      { recurredCount: 3 },
      { daysUnresolved: 400 },
      { reportType: "UNKNOWN_TYPE" },
      { port: 9999 },
      { enrichmentPresent: true, enrichmentStatus: "SUCCESS", enrichmentFresh: true, abuseConfidenceScore: 0 },
      { enrichmentPresent: true, enrichmentStatus: "SUCCESS", enrichmentFresh: true, abuseConfidenceScore: 95 },
      { enrichmentPresent: true, enrichmentStatus: "SUCCESS", enrichmentFresh: false },
      { enrichmentPresent: true, enrichmentStatus: "NOT_FOUND", enrichmentFresh: true },
      { enrichmentPresent: true, enrichmentStatus: "RATE_LIMITED" },
      { enrichmentPresent: true, enrichmentStatus: "DEAD_LETTER" },
      { sectorAttributable: true, sector: "CNI" },
      { sectorAttributable: false, sectorNonAttributableReason: "ISP_ATTRIBUTION" },
      { sectorAttributable: false, sectorNonAttributableReason: "LOW_CONFIDENCE" },
      { sectorAttributable: false, sectorNonAttributableReason: "UNKNOWN_SECTOR" },
      { sectorAttributable: false, sectorNonAttributableReason: "AMBIGUOUS" },
      { sectorAttributable: false, sectorNonAttributableReason: "UNRESOLVED" },
    ];

    const emitted = new Set();
    variations.forEach((overrides) => {
      const calculation = calculateRisk({
        inputSnapshot: { inputs: { ...base, ...overrides }, inputFingerprint: "x" },
      });
      calculation.contributions.forEach((row) => {
        emitted.add(row.explanationCode);
        const sentence = renderContributionExplanation(row);
        // A real sentence: never blank, never the unknown-code fallback, and
        // never a leftover interpolation placeholder.
        expect(typeof sentence).toBe("string");
        expect(sentence.trim()).not.toBe("");
        expect(sentence).not.toBe(UNKNOWN_CODE_SENTENCE);
        expect(sentence).not.toContain("{value}");
      });
    });

    // Every emitted code is in the declared vocabulary — the direction the
    // vocabulary-only checks above cannot prove.
    emitted.forEach((code) => expect(RISK_EXPLANATION_CODE_VALUES).toContain(code));

    // And the specific §2B distinction is genuinely reachable: "no usable
    // score" and "a real score of ~0" are different codes, not one collapsed
    // into the other.
    expect(emitted).toContain(RISK_EXPLANATION_CODES.EPSS_NOT_AVAILABLE);
    expect(emitted).toContain(RISK_EXPLANATION_CODES.EPSS_LOW);
    expect(emitted).toContain(RISK_EXPLANATION_CODES.KEV_NOT_AVAILABLE);
    expect(emitted).toContain(RISK_EXPLANATION_CODES.KEV_NOT_LISTED);
    expect(emitted).toContain(RISK_EXPLANATION_CODES.KEV_LISTED);
    expect(emitted).toContain(RISK_EXPLANATION_CODES.CVE_PRESENT);
    expect(emitted).toContain(RISK_EXPLANATION_CODES.CVE_NOT_APPLICABLE_NO_CVE_SOURCE);
  });

  it("renders EPSS_NOT_AVAILABLE and EPSS_LOW as materially different sentences", () => {
    const unavailable = renderContributionExplanation(
      contribution({
        factorKey: "epssScore",
        applicability: "NOT_AVAILABLE",
        contributionBasisPoints: 0,
        normalizedInputValue: null,
        explanationCode: RISK_EXPLANATION_CODES.EPSS_NOT_AVAILABLE,
      })
    );
    const low = renderContributionExplanation(
      contribution({
        factorKey: "epssScore",
        applicability: "APPLIED",
        contributionBasisPoints: 0,
        normalizedInputValue: "0",
        explanationCode: RISK_EXPLANATION_CODES.EPSS_LOW,
      })
    );

    expect(unavailable).not.toBe(low);
    // "We could not check" must never read as "checked and negligible".
    expect(unavailable.toLowerCase()).toContain("unavailable");
    expect(low.toLowerCase()).not.toContain("unavailable");
  });

  it("never leaves a {value} placeholder unfilled for a factor that has no input", () => {
    // Codes that interpolate must only be reachable with a normalized input.
    const interpolating = Object.entries(EXPLANATION_TEMPLATES)
      .filter(([, template]) => template.includes("{value}"))
      .map(([code]) => code);
    // Every interpolating code is a scored bucket, never an unavailable one.
    interpolating.forEach((code) => {
      expect(code).not.toMatch(/NOT_AVAILABLE|NOT_APPLICABLE|_ABSENT$/);
    });
  });
});

describe("renderContributionExplanation", () => {
  it("renders a fixed sentence from the stored code", () => {
    expect(renderContributionExplanation(contribution())).toBe(
      "Observed in 2 reports; the exposure is repeating."
    );
  });

  it("interpolates only the row's own stored normalized input", () => {
    expect(
      renderContributionExplanation(
        contribution({
          explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_HIGH,
          normalizedInputValue: "63",
        })
      )
    ).toBe("Reputation checked: high abuse confidence (63/100).");
  });

  it("renders a null normalized input as an empty interpolation, never 'null'", () => {
    const rendered = renderContributionExplanation(
      contribution({
        explanationCode: RISK_EXPLANATION_CODES.PERSISTENCE_REPEATED,
        normalizedInputValue: null,
      })
    );
    expect(rendered).not.toContain("null");
    expect(rendered).not.toContain("{value}");
  });

  it("degrades to a neutral sentence for an unrecognised code rather than throwing", () => {
    expect(
      renderContributionExplanation(contribution({ explanationCode: "SOME_FUTURE_CODE" }))
    ).toBe(UNKNOWN_CODE_SENTENCE);
    expect(renderContributionExplanation(null)).toBe(UNKNOWN_CODE_SENTENCE);
    expect(renderContributionExplanation("not a row")).toBe(UNKNOWN_CODE_SENTENCE);
  });

  it("says 'checked and clean' for SUCCESS-score-0 and 'unavailable' for NOT_FOUND", () => {
    const clean = renderContributionExplanation(
      contribution({
        explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_NONE,
        normalizedInputValue: "0",
      })
    );
    const notFound = renderContributionExplanation(
      contribution({
        explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_NOT_FOUND,
        normalizedInputValue: null,
      })
    );
    expect(clean).toContain("Reputation checked");
    expect(notFound).toContain("Reputation unavailable");
    expect(clean).not.toBe(notFound);
  });

  it("names the exact reason a sector could not be attributed", () => {
    expect(
      renderContributionExplanation(
        contribution({
          explanationCode: RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_LOW_CONFIDENCE,
          normalizedInputValue: null,
        })
      )
    ).toContain("confidence is too low");
    expect(
      renderContributionExplanation(
        contribution({
          explanationCode: RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_ISP_ATTRIBUTION,
          normalizedInputValue: null,
        })
      )
    ).toContain("ISP");
  });

  it("distinguishes a closed finding from an uncomputable duration", () => {
    const closed = renderContributionExplanation(
      contribution({
        explanationCode: RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_NOT_APPLICABLE_CLOSED,
        normalizedInputValue: null,
      })
    );
    const invalid = renderContributionExplanation(
      contribution({
        explanationCode: RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_INVALID_TIMESTAMP,
        normalizedInputValue: null,
      })
    );
    expect(closed).toContain("the finding is closed");
    expect(invalid).toContain("could not be determined");
  });
});

describe("renderScoreExplanation", () => {
  const scoreRow = { scoreBasisPoints: 3600, riskBand: "MEDIUM" };

  const rows = [
    contribution({
      factorKey: "sourceSeverity",
      displayOrder: 0,
      contributionBasisPoints: 800,
      maximumContributionBasisPoints: 800,
      explanationCode: RISK_EXPLANATION_CODES.SOURCE_SEVERITY_ACCESSIBLE_RDP,
      normalizedInputValue: "ACCESSIBLE_RDP",
    }),
    contribution({
      factorKey: "exposureCriticality",
      displayOrder: 1,
      contributionBasisPoints: 1500,
      maximumContributionBasisPoints: 1500,
      explanationCode: RISK_EXPLANATION_CODES.EXPOSURE_CRITICALITY_REMOTE_ACCESS_RDP,
      normalizedInputValue: "TCP/3389",
    }),
    contribution({
      factorKey: "iocReputationContext",
      displayOrder: 5,
      applicability: "NOT_AVAILABLE",
      contributionBasisPoints: 0,
      maximumContributionBasisPoints: 1200,
      explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_ABSENT,
      normalizedInputValue: null,
    }),
    contribution({
      factorKey: "sectorCriticality",
      displayOrder: 6,
      contributionBasisPoints: 1300,
      maximumContributionBasisPoints: 1300,
      explanationCode: RISK_EXPLANATION_CODES.SECTOR_CNI,
      normalizedInputValue: "CRITICAL_NATIONAL_INFRASTRUCTURE",
    }),
    contribution({
      factorKey: "cvePresence",
      displayOrder: 7,
      applicability: "NOT_APPLICABLE",
      contributionBasisPoints: 0,
      maximumContributionBasisPoints: 300,
      explanationCode: RISK_EXPLANATION_CODES.CVE_NOT_APPLICABLE_NO_CVE_SOURCE,
      normalizedInputValue: null,
    }),
  ];

  it("orders factors by their STORED displayOrder, not by today's configuration", () => {
    const shuffled = [rows[3], rows[0], rows[4], rows[2], rows[1]];
    const explanation = renderScoreExplanation(scoreRow, shuffled);
    expect(explanation.factors.map((f) => f.factorKey)).toEqual([
      "sourceSeverity",
      "exposureCriticality",
      "iocReputationContext",
      "sectorCriticality",
      "cvePresence",
    ]);
  });

  it("counts contributing, unavailable and not-applicable factors separately", () => {
    const explanation = renderScoreExplanation(scoreRow, rows);
    expect(explanation.contributingFactorCount).toBe(3);
    expect(explanation.unavailableFactorCount).toBe(1);
    expect(explanation.notApplicableFactorCount).toBe(1);
  });

  it("does not count an APPLIED zero as a contributing factor", () => {
    const withAppliedZero = [
      ...rows,
      contribution({
        factorKey: "persistence",
        displayOrder: 2,
        applicability: "APPLIED",
        contributionBasisPoints: 0,
        explanationCode: RISK_EXPLANATION_CODES.PERSISTENCE_SINGLE_OBSERVATION,
        normalizedInputValue: "1",
      }),
    ];
    const explanation = renderScoreExplanation(scoreRow, withAppliedZero);
    expect(explanation.contributingFactorCount).toBe(3);
    // ...but it is still present and explained.
    expect(explanation.factors.map((f) => f.factorKey)).toContain("persistence");
  });

  it("builds a bounded summary from stored scalars only", () => {
    const explanation = renderScoreExplanation(scoreRow, rows);
    expect(explanation.summary).toBe(
      "Scored 3600 of 10000 basis points (MEDIUM) from 3 contributing factors. 1 factor was unavailable and contributed nothing."
    );
  });

  it("keeps the summary grammatical for a single contributing factor", () => {
    const explanation = renderScoreExplanation({ scoreBasisPoints: 800, riskBand: "INFORMATIONAL" }, [
      rows[0],
    ]);
    expect(explanation.summary).toBe(
      "Scored 800 of 10000 basis points (INFORMATIONAL) from 1 contributing factor."
    );
  });

  it("returns an empty summary for a missing score row rather than throwing", () => {
    expect(renderScoreExplanation(null, rows).summary).toBe("");
    expect(renderScoreExplanation(undefined, undefined).factors).toEqual([]);
  });

  it("exposes each factor's own cap so 'x of a possible y' stays truthful", () => {
    const explanation = renderScoreExplanation(scoreRow, rows);
    const sector = explanation.factors.find((f) => f.factorKey === "sectorCriticality");
    expect(sector.contributionBasisPoints).toBe(1300);
    expect(sector.maximumContributionBasisPoints).toBe(1300);
  });

  it("renders from the stored rows alone — an old row with a retired cap still explains itself", () => {
    // Simulates a score written under a hypothetical earlier contract whose
    // persistence cap was 900: the rendered explanation must use the STORED
    // cap, not today's 1200.
    const legacy = [
      contribution({
        factorKey: "persistence",
        displayOrder: 2,
        contributionBasisPoints: 900,
        maximumContributionBasisPoints: 900,
        explanationCode: RISK_EXPLANATION_CODES.PERSISTENCE_ENTRENCHED,
        normalizedInputValue: "12",
      }),
    ];
    const explanation = renderScoreExplanation({ scoreBasisPoints: 900, riskBand: "INFORMATIONAL" }, legacy);
    expect(explanation.factors[0].maximumContributionBasisPoints).toBe(900);
    expect(explanation.factors[0].sentence).toBe(
      "Observed in 12 reports; the exposure is entrenched."
    );
  });

  it("does not mutate the caller's contribution array", () => {
    const input = [rows[3], rows[0]];
    const before = input.map((r) => r.factorKey);
    renderScoreExplanation(scoreRow, input);
    expect(input.map((r) => r.factorKey)).toEqual(before);
  });
});
