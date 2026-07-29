"use strict";

// Executable Risk v1 gate (P2-T3). Feeds the hand-authored input snapshots in
// data/synthetic/risk_ground_truth.yaml through the REAL production scoring
// engine (backend/src/services/risk/riskEngine.js — the same pure function the
// persistence service calls), then compares every score, band, display value
// and per-factor contribution against the manually derived expectations.
//
// Usage (from backend/, or `node eval/run_risk_v1_gate.js` from the repo root):
//   npm run eval:risk
//
// Deliberately needs NO database, NO network and NO clock. Risk scoring is a
// total function of the normalized input snapshot, so the gate can pin the
// locked numeric contract exactly, on any machine, with no fixture setup and
// nothing to clean up afterwards. Database-level behaviour (append-only
// history, supersession, the currentForFindingId unique rule, FK Restrict) is
// proven separately against real PostgreSQL in
// backend/tests/integration/riskScoringConcurrency.test.js.
//
// The gate checks three independent things:
//   1. CONTRACT — the weights, caps and bands compiled into
//      riskConfiguration.js still match the architect-approved values
//      transcribed by hand into the YAML;
//   2. SCENARIOS — each hand-derived score, band, display value and factor
//      contribution matches what the engine actually produces;
//   3. DETERMINISM — scoring the same snapshot twice yields byte-identical
//      output, and every factor emits exactly one contribution row.

const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");
const GROUND_TRUTH_PATH = path.join(REPO_ROOT, "data", "synthetic", "risk_ground_truth.yaml");

const { loadRiskGroundTruth, REQUIRED_FACTOR_KEYS } = require("./lib/riskGroundTruthLoader");

class GateStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "GateStateError";
  }
}

function requireBackend(relativePath) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(BACKEND_DIR, relativePath));
}

function diff(pathLabel, expected, actual) {
  return { path: pathLabel, expected, actual };
}

/**
 * Compares the compiled configuration against the hand-transcribed contract.
 * This is the check that makes an unapproved weight change fail loudly instead
 * of silently rescoring every finding in the system.
 */
function compareContract(expected, configuration) {
  const diffs = [];

  if (configuration.algorithmVersion !== expected.algorithmVersion) {
    diffs.push(diff("contract.algorithmVersion", expected.algorithmVersion, configuration.algorithmVersion));
  }
  if (configuration.configurationVersion !== expected.configurationVersion) {
    diffs.push(
      diff("contract.configurationVersion", expected.configurationVersion, configuration.configurationVersion)
    );
  }
  [
    ["scoreMinBasisPoints", "scoreMinBasisPoints"],
    ["scoreMaxBasisPoints", "scoreMaxBasisPoints"],
    ["displayScoreDivisor", "displayScoreDivisor"],
    ["maxNormalizedDays", "maxNormalizedDays"],
  ].forEach(([expectedKey, actualKey]) => {
    if (configuration[actualKey] !== expected[expectedKey]) {
      diffs.push(diff(`contract.${expectedKey}`, expected[expectedKey], configuration[actualKey]));
    }
  });

  REQUIRED_FACTOR_KEYS.forEach((key) => {
    const expectedCap = expected.factorMaximums[key];
    const actualCap = configuration.factorMaximums[key];
    if (actualCap !== expectedCap) {
      diffs.push(diff(`contract.factorMaximums.${key}`, expectedCap, actualCap));
    }
  });

  const declaredTotal = REQUIRED_FACTOR_KEYS.reduce(
    (sum, key) => sum + expected.factorMaximums[key],
    0
  );
  if (declaredTotal !== expected.scoreMaxBasisPoints) {
    diffs.push(diff("contract.factorMaximums(sum)", expected.scoreMaxBasisPoints, declaredTotal));
  }

  const actualBands = configuration.bands.map((row) => ({
    band: row.band,
    minBasisPoints: row.minBasisPoints,
    maxBasisPoints: row.maxBasisPoints,
  }));
  const expectedBands = expected.bands.map((row) => ({
    band: row.band,
    minBasisPoints: row.minBasisPoints,
    maxBasisPoints: row.maxBasisPoints,
  }));
  if (JSON.stringify(actualBands) !== JSON.stringify(expectedBands)) {
    diffs.push(diff("contract.bands", expectedBands, actualBands));
  }

  return diffs;
}

function compareScenario(scenario, result) {
  const diffs = [];
  const { expected } = scenario;

  if (result.scoreBasisPoints !== expected.scoreBasisPoints) {
    diffs.push(diff("scoreBasisPoints", expected.scoreBasisPoints, result.scoreBasisPoints));
  }
  if (result.displayScore !== expected.displayScore) {
    diffs.push(diff("displayScore", expected.displayScore, result.displayScore));
  }
  if (result.riskBand !== expected.riskBand) {
    diffs.push(diff("riskBand", expected.riskBand, result.riskBand));
  }

  // Every approved factor must emit exactly one contribution row on every
  // run — including NOT_AVAILABLE and NOT_APPLICABLE ones. That is what stops
  // a stored explanation silently omitting missing context.
  const emitted = result.contributions.map((row) => row.factorKey);
  if (JSON.stringify(emitted) !== JSON.stringify([...REQUIRED_FACTOR_KEYS])) {
    diffs.push(diff("contributions(factorKeys, in display order)", [...REQUIRED_FACTOR_KEYS], emitted));
  }

  const byKey = new Map(result.contributions.map((row) => [row.factorKey, row]));

  // The additive invariant: the score is exactly the sum of its parts.
  const summed = result.contributions.reduce((sum, row) => sum + row.contributionBasisPoints, 0);
  if (summed !== result.scoreBasisPoints) {
    diffs.push(diff("contributions(sum)", result.scoreBasisPoints, summed));
  }

  // The structural invariant: only APPLIED may be non-zero, and nothing may
  // exceed its own cap.
  result.contributions.forEach((row) => {
    if (row.applicability !== "APPLIED" && row.contributionBasisPoints !== 0) {
      diffs.push(diff(`factors.${row.factorKey}(non-APPLIED must be 0)`, 0, row.contributionBasisPoints));
    }
    if (row.contributionBasisPoints > row.maximumContributionBasisPoints) {
      diffs.push(
        diff(
          `factors.${row.factorKey}(cap)`,
          `<= ${row.maximumContributionBasisPoints}`,
          row.contributionBasisPoints
        )
      );
    }
  });

  Object.entries(expected.factors).forEach(([factorKey, expectedFactor]) => {
    const actual = byKey.get(factorKey);
    if (!actual) {
      diffs.push(diff(`factors.${factorKey}`, expectedFactor, null));
      return;
    }
    if (actual.applicability !== expectedFactor.applicability) {
      diffs.push(
        diff(`factors.${factorKey}.applicability`, expectedFactor.applicability, actual.applicability)
      );
    }
    if (actual.contributionBasisPoints !== expectedFactor.contributionBasisPoints) {
      diffs.push(
        diff(
          `factors.${factorKey}.contributionBasisPoints`,
          expectedFactor.contributionBasisPoints,
          actual.contributionBasisPoints
        )
      );
    }
    if (actual.explanationCode !== expectedFactor.explanationCode) {
      diffs.push(
        diff(`factors.${factorKey}.explanationCode`, expectedFactor.explanationCode, actual.explanationCode)
      );
    }
    if ("normalizedInputValue" in expectedFactor) {
      if (actual.normalizedInputValue !== expectedFactor.normalizedInputValue) {
        diffs.push(
          diff(
            `factors.${factorKey}.normalizedInputValue`,
            expectedFactor.normalizedInputValue,
            actual.normalizedInputValue
          )
        );
      }
    }
  });

  return { pass: diffs.length === 0, diffs };
}

/**
 * Builds the snapshot wrapper the engine expects around a scenario's inputs.
 * The fingerprint comes from the real production helper, so the gate also
 * exercises the fingerprint's determinism rather than inventing a stand-in.
 */
function buildSnapshot(scenario, { buildInputFingerprint, configuration, configurationFingerprint }) {
  return Object.freeze({
    findingId: null,
    asOf: null,
    algorithmVersion: configuration.algorithmVersion,
    configurationVersion: configuration.configurationVersion,
    configurationFingerprint,
    inputs: Object.freeze({ ...scenario.inputs }),
    inputFingerprint: buildInputFingerprint(scenario.inputs),
  });
}

function runRiskV1Gate({ groundTruthPath = GROUND_TRUTH_PATH, log = () => {} } = {}) {
  const groundTruth = loadRiskGroundTruth(groundTruthPath);

  const { calculateRisk } = requireBackend("src/services/risk/riskEngine.js");
  const { buildInputFingerprint } = requireBackend("src/services/risk/riskInputSnapshot.js");
  const {
    RISK_CONFIGURATION,
    RISK_CONFIGURATION_FINGERPRINT,
  } = requireBackend("src/services/risk/riskConfiguration.js");

  if (!RISK_CONFIGURATION || typeof calculateRisk !== "function") {
    throw new GateStateError("risk engine or configuration failed to load");
  }

  const contractDiffs = compareContract(groundTruth.contract, RISK_CONFIGURATION);
  log(`${contractDiffs.length === 0 ? "PASS" : "FAIL"}  contract (locked Risk v1 numeric contract)`);

  const scenarioResults = [];
  groundTruth.scenarios.forEach((scenario) => {
    const snapshot = buildSnapshot(scenario, {
      buildInputFingerprint,
      configuration: RISK_CONFIGURATION,
      configurationFingerprint: RISK_CONFIGURATION_FINGERPRINT,
    });

    let result;
    let engineError = null;
    try {
      result = calculateRisk({ configuration: RISK_CONFIGURATION, inputSnapshot: snapshot });
    } catch (error) {
      engineError = error;
    }

    if (engineError) {
      scenarioResults.push({
        id: scenario.id,
        pass: false,
        diffs: [],
        engineError: { name: engineError.name, message: engineError.message },
      });
      log(`FAIL  ${scenario.id} (unexpected engine error: ${engineError.name})`);
      return;
    }

    const comparison = compareScenario(scenario, result);

    // Determinism: the same snapshot must score byte-identically on a second
    // pass. A hidden clock read, a Map iteration order dependency or a mutated
    // configuration would all surface here.
    const replay = calculateRisk({ configuration: RISK_CONFIGURATION, inputSnapshot: snapshot });
    if (JSON.stringify(replay) !== JSON.stringify(result)) {
      comparison.diffs.push(diff("determinism(replay)", JSON.stringify(result), JSON.stringify(replay)));
      comparison.pass = false;
    }

    scenarioResults.push({ id: scenario.id, pass: comparison.pass, diffs: comparison.diffs, engineError: null });
    log(`${comparison.pass ? "PASS" : "FAIL"}  ${scenario.id}`);
  });

  const pass = contractDiffs.length === 0 && scenarioResults.every((r) => r.pass);
  return { pass, contractDiffs, scenarioResults, scenarioCount: groundTruth.scenarios.length };
}

function main() {
  console.log("Risk v1 Gate");
  try {
    const { pass, contractDiffs, scenarioResults, scenarioCount } = runRiskV1Gate({
      log: (line) => console.log(line),
    });

    if (contractDiffs.length > 0) {
      console.log("");
      console.log("  The compiled configuration no longer matches the approved contract:");
      contractDiffs.forEach((d) => {
        console.log(`  contract :: ${d.path}`);
        console.log(`    approved: ${JSON.stringify(d.expected)}`);
        console.log(`    compiled: ${JSON.stringify(d.actual)}`);
      });
    }

    const failed = scenarioResults.filter((r) => !r.pass);
    if (failed.length > 0) {
      console.log("");
      failed.forEach((r) => {
        if (r.engineError) {
          console.log(`  ${r.id}: unexpected engine error — ${r.engineError.name}: ${r.engineError.message}`);
        }
        r.diffs.forEach((d) => {
          console.log(`  ${r.id} :: ${d.path}`);
          console.log(`    expected: ${JSON.stringify(d.expected)}`);
          console.log(`    actual:   ${JSON.stringify(d.actual)}`);
        });
      });
    }

    console.log("");
    console.log(
      pass
        ? `Final:\nPASS — the locked contract and all ${scenarioCount} manually derived scenarios match exactly`
        : "Final:\nFAIL — see mismatches above"
    );
    process.exitCode = pass ? 0 : 1;
  } catch (error) {
    console.error(`Risk v1 Gate — errored: ${error.name || "Error"}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  GateStateError,
  GROUND_TRUTH_PATH,
  compareContract,
  compareScenario,
  runRiskV1Gate,
};

if (require.main === module) {
  main();
}
