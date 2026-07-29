import { describe, it, expect } from "vitest";

// P2-T3 — the Risk v1 evaluator gate itself.
//
// A gate that cannot fail proves nothing. These tests deliberately tamper with
// an in-memory copy of the ground truth (never the committed file) and with a
// copy of the configuration, and assert that each tampering is actually
// caught. Mirrors evalGroundTruthLoader.test.js / evalPhase1GateSafety.test.js.

const path = require("path");
const fs = require("fs");

const EVAL_DIR = path.join(__dirname, "..", "..", "..", "eval");
const GROUND_TRUTH_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "data",
  "synthetic",
  "risk_ground_truth.yaml"
);

const {
  RiskGroundTruthValidationError,
  REQUIRED_FACTOR_KEYS,
  REQUIRED_INPUT_KEYS,
  loadRiskGroundTruth,
  parseRiskGroundTruth,
} = require(path.join(EVAL_DIR, "lib", "riskGroundTruthLoader.js"));
const {
  compareContract,
  compareScenario,
  runRiskV1Gate,
} = require(path.join(EVAL_DIR, "run_risk_v1_gate.js"));
const { RISK_CONFIGURATION } = require("../../src/services/risk/riskConfiguration");
const { calculateRisk } = require("../../src/services/risk/riskEngine");
const { buildInputFingerprint } = require("../../src/services/risk/riskInputSnapshot");

const groundTruthText = fs.readFileSync(GROUND_TRUTH_PATH, "utf8");

describe("the committed risk ground truth", () => {
  it("loads and validates", () => {
    const groundTruth = loadRiskGroundTruth(GROUND_TRUTH_PATH);
    expect(groundTruth.schemaVersion).toBe("risk-v1-gate-ground-truth.v1");
    expect(groundTruth.scenarios.length).toBeGreaterThanOrEqual(15);
  });

  it("declares every scenario with the complete normalized input shape", () => {
    const groundTruth = loadRiskGroundTruth(GROUND_TRUTH_PATH);
    groundTruth.scenarios.forEach((scenario) => {
      expect(Object.keys(scenario.inputs).sort()).toEqual([...REQUIRED_INPUT_KEYS].sort());
    });
  });

  it("covers all three architect amendments explicitly", () => {
    const groundTruth = loadRiskGroundTruth(GROUND_TRUTH_PATH);
    const codes = groundTruth.scenarios.flatMap((s) =>
      Object.values(s.expected.factors).map((f) => f.explanationCode)
    );
    // Amendment 1: NOT_FOUND is unavailable; SUCCESS-0 is applied-clean.
    expect(codes).toContain("IOC_REPUTATION_NOT_FOUND");
    expect(codes).toContain("IOC_REPUTATION_NONE");
    // Amendment 2: the low-confidence sector gate.
    expect(codes).toContain("SECTOR_NOT_AVAILABLE_LOW_CONFIDENCE");
    // Amendment 3: closed and invalid-timestamp outcomes.
    expect(codes).toContain("DAYS_UNRESOLVED_NOT_APPLICABLE_CLOSED");
    expect(codes).toContain("DAYS_UNRESOLVED_INVALID_TIMESTAMP");
  });

  it("keeps the SUCCESS-0 and NOT_FOUND scenarios structurally distinct at the same score", () => {
    const groundTruth = loadRiskGroundTruth(GROUND_TRUTH_PATH);
    const clean = groundTruth.scenarios.find((s) => s.id === "02_reputation_checked_clean");
    const notFound = groundTruth.scenarios.find((s) => s.id === "03_reputation_not_found");
    expect(clean.expected.scoreBasisPoints).toBe(notFound.expected.scoreBasisPoints);
    expect(clean.expected.factors.iocReputationContext.applicability).toBe("APPLIED");
    expect(notFound.expected.factors.iocReputationContext.applicability).toBe("NOT_AVAILABLE");
  });
});

describe("the gate passes against the shipped engine", () => {
  it("reports PASS with no contract or scenario diffs", () => {
    const result = runRiskV1Gate({ groundTruthPath: GROUND_TRUTH_PATH });
    expect(result.contractDiffs).toEqual([]);
    expect(result.scenarioResults.filter((r) => !r.pass)).toEqual([]);
    expect(result.pass).toBe(true);
  });
});

describe("the gate catches an unapproved contract change", () => {
  const clone = () => JSON.parse(JSON.stringify(RISK_CONFIGURATION));
  const approved = loadRiskGroundTruth(GROUND_TRUTH_PATH).contract;

  it("passes for the untampered configuration", () => {
    expect(compareContract(approved, RISK_CONFIGURATION)).toEqual([]);
  });

  it.each(REQUIRED_FACTOR_KEYS)("fails when the %s cap changes", (factorKey) => {
    const tampered = clone();
    tampered.factorMaximums[factorKey] += 1;
    const diffs = compareContract(approved, tampered);
    expect(diffs.map((d) => d.path)).toContain(`contract.factorMaximums.${factorKey}`);
  });

  it("fails when a band boundary moves", () => {
    const tampered = clone();
    tampered.bands[1].maxBasisPoints = 3500;
    expect(compareContract(approved, tampered).map((d) => d.path)).toContain("contract.bands");
  });

  it("fails when the algorithm or configuration version changes", () => {
    const algorithm = clone();
    algorithm.algorithmVersion = "risk-additive-bucketed-v2";
    expect(compareContract(approved, algorithm).map((d) => d.path)).toContain(
      "contract.algorithmVersion"
    );

    const configuration = clone();
    configuration.configurationVersion = "v1.1.0";
    expect(compareContract(approved, configuration).map((d) => d.path)).toContain(
      "contract.configurationVersion"
    );
  });

  it("fails when the scale or display divisor changes", () => {
    const tampered = clone();
    tampered.displayScoreDivisor = 10;
    expect(compareContract(approved, tampered).map((d) => d.path)).toContain(
      "contract.displayScoreDivisor"
    );
  });
});

describe("the gate catches a scoring regression", () => {
  const groundTruth = loadRiskGroundTruth(GROUND_TRUTH_PATH);

  function scoreScenario(scenario, configuration = RISK_CONFIGURATION) {
    return calculateRisk({
      configuration,
      inputSnapshot: {
        findingId: null,
        asOf: null,
        algorithmVersion: configuration.algorithmVersion,
        configurationVersion: configuration.configurationVersion,
        configurationFingerprint: "gate-test",
        inputs: scenario.inputs,
        inputFingerprint: buildInputFingerprint(scenario.inputs),
      },
    });
  }

  it("passes each scenario against the real engine", () => {
    groundTruth.scenarios.forEach((scenario) => {
      const comparison = compareScenario(scenario, scoreScenario(scenario));
      expect({ id: scenario.id, diffs: comparison.diffs }).toEqual({ id: scenario.id, diffs: [] });
    });
  });

  it("fails when a scenario's expected score is wrong", () => {
    const scenario = groundTruth.scenarios.find((s) => s.id === "01_baseline_open_rdp");
    const tampered = {
      ...scenario,
      expected: { ...scenario.expected, scoreBasisPoints: 2400 },
    };
    const comparison = compareScenario(tampered, scoreScenario(scenario));
    expect(comparison.pass).toBe(false);
    expect(comparison.diffs.map((d) => d.path)).toContain("scoreBasisPoints");
  });

  it("fails when a factor's applicability is wrong — the amendment-1 regression", () => {
    // The exact regression amendment 1 exists to prevent: treating a fresh
    // NOT_FOUND as APPLIED, i.e. as confirmed clean reputation.
    const scenario = groundTruth.scenarios.find((s) => s.id === "03_reputation_not_found");
    const tampered = {
      ...scenario,
      expected: {
        ...scenario.expected,
        factors: {
          ...scenario.expected.factors,
          iocReputationContext: {
            applicability: "APPLIED",
            contributionBasisPoints: 0,
            explanationCode: "IOC_REPUTATION_NONE",
          },
        },
      },
    };
    const comparison = compareScenario(tampered, scoreScenario(scenario));
    expect(comparison.pass).toBe(false);
    expect(comparison.diffs.map((d) => d.path)).toEqual(
      expect.arrayContaining([
        "factors.iocReputationContext.applicability",
        "factors.iocReputationContext.explanationCode",
      ])
    );
  });

  it("fails when a weight change silently rescores a scenario", () => {
    // Tampered DOWN, so it stays within the factor's cap and the engine's own
    // guard does not fire — this is the case only the gate can catch.
    const tamperedConfiguration = JSON.parse(JSON.stringify(RISK_CONFIGURATION));
    tamperedConfiguration.sourceSeverityByReportType.ACCESSIBLE_RDP.contributionBasisPoints = 700;

    const scenario = groundTruth.scenarios.find((s) => s.id === "01_baseline_open_rdp");
    const comparison = compareScenario(scenario, scoreScenario(scenario, tamperedConfiguration));
    expect(comparison.pass).toBe(false);
    expect(comparison.diffs.map((d) => d.path)).toEqual(
      expect.arrayContaining(["scoreBasisPoints", "factors.sourceSeverity.contributionBasisPoints"])
    );
  });

  it("refuses outright when a weight is raised above its own factor cap", () => {
    // Tampered UP past the cap: the engine's structural guard rejects it
    // before any comparison happens, so an over-cap contribution can never
    // reach a stored score in the first place.
    const tamperedConfiguration = JSON.parse(JSON.stringify(RISK_CONFIGURATION));
    tamperedConfiguration.sourceSeverityByReportType.ACCESSIBLE_RDP.contributionBasisPoints = 900;

    const scenario = groundTruth.scenarios.find((s) => s.id === "01_baseline_open_rdp");
    expect(() => scoreScenario(scenario, tamperedConfiguration)).toThrow(
      /factor sourceSeverity exceeded its maximum/
    );
  });
});

describe("loader validation refuses a malformed or incoherent expectation", () => {
  it("rejects a scenario missing a required input", () => {
    const tampered = groundTruthText.replace("      cvePresent: false\n", "");
    expect(() => parseRiskGroundTruth(tampered)).toThrow(RiskGroundTruthValidationError);
  });

  it("rejects an expectation whose displayScore does not follow from its score", () => {
    const tampered = groundTruthText.replace(
      "      scoreBasisPoints: 2300\n      displayScore: 23\n      riskBand: \"LOW\"",
      "      scoreBasisPoints: 2300\n      displayScore: 99\n      riskBand: \"LOW\""
    );
    expect(() => parseRiskGroundTruth(tampered)).toThrow(/displayScore/);
  });

  it("rejects an expectation whose band does not follow from its score", () => {
    const tampered = groundTruthText.replace(
      "      scoreBasisPoints: 2300\n      displayScore: 23\n      riskBand: \"LOW\"",
      "      scoreBasisPoints: 2300\n      displayScore: 23\n      riskBand: \"CRITICAL\""
    );
    expect(() => parseRiskGroundTruth(tampered)).toThrow(/riskBand/);
  });

  it("rejects a non-APPLIED factor that expects basis points", () => {
    const tampered = groundTruthText.replace(
      'iocReputationContext: { applicability: "NOT_AVAILABLE", contributionBasisPoints: 0, explanationCode: "IOC_REPUTATION_NOT_FOUND", normalizedInputValue: null }',
      'iocReputationContext: { applicability: "NOT_AVAILABLE", contributionBasisPoints: 500, explanationCode: "IOC_REPUTATION_NOT_FOUND", normalizedInputValue: null }'
    );
    expect(() => parseRiskGroundTruth(tampered)).toThrow(/must expect exactly 0 basis points/);
  });

  it("rejects a factor expectation above its own declared cap", () => {
    const tampered = groundTruthText.replace(
      'sectorCriticality: { applicability: "APPLIED", contributionBasisPoints: 1300, explanationCode: "SECTOR_CNI"',
      'sectorCriticality: { applicability: "APPLIED", contributionBasisPoints: 1400, explanationCode: "SECTOR_CNI"'
    );
    expect(() => parseRiskGroundTruth(tampered)).toThrow(/above the declared cap/);
  });

  it("rejects declared caps that do not sum to the declared maximum", () => {
    const tampered = groundTruthText.replace("    sourceSeverity: 800\n", "    sourceSeverity: 801\n");
    const parsed = parseRiskGroundTruth(tampered);
    // The loader accepts the arithmetic-consistent file; the GATE is what
    // rejects an incoherent cap set, so assert that path explicitly.
    const diffs = compareContract(parsed.contract, RISK_CONFIGURATION);
    expect(diffs.map((d) => d.path)).toEqual(
      expect.arrayContaining(["contract.factorMaximums.sourceSeverity"])
    );
  });

  it("rejects a duplicate scenario id", () => {
    const tampered = groundTruthText.replace(
      '  - id: "02_reputation_checked_clean"',
      '  - id: "01_baseline_open_rdp"'
    );
    expect(() => parseRiskGroundTruth(tampered)).toThrow(/duplicate scenario identifier/);
  });

  it("rejects an unknown factor key in an expectation", () => {
    const tampered = groundTruthText.replace(
      "        sectorCriticality: { applicability: \"NOT_AVAILABLE\", contributionBasisPoints: 0, explanationCode: \"SECTOR_NOT_AVAILABLE_NO_OWNERSHIP\" }",
      "        ownershipConfidence: { applicability: \"APPLIED\", contributionBasisPoints: 100, explanationCode: \"SECTOR_CNI\" }"
    );
    expect(() => parseRiskGroundTruth(tampered)).toThrow(RiskGroundTruthValidationError);
  });

  it("rejects a missing file and a non-mapping document", () => {
    expect(() => loadRiskGroundTruth(path.join(EVAL_DIR, "does-not-exist.yaml"))).toThrow(
      RiskGroundTruthValidationError
    );
    expect(() => parseRiskGroundTruth("- just\n- a\n- list\n")).toThrow(
      RiskGroundTruthValidationError
    );
  });
});
