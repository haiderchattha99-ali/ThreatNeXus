"use strict";

// Loads and structurally validates data/synthetic/risk_ground_truth.yaml for
// the Risk v1 gate (eval/run_risk_v1_gate.js). Pure and side-effect-free apart
// from the one file read: no Prisma access, no network access, no clock.
//
// Same discipline as groundTruthLoader.js (the Phase 1 gate's loader): the
// file is a hand-authored expectation, so a malformed or under-specified
// scenario must fail loudly here rather than silently comparing nothing.

const fs = require("fs");
const path = require("path");

// eval/ is a sibling of backend/ (not a descendant), so a bare require("yaml")
// would never find backend/node_modules/yaml. Resolve it as if required from
// backend/, regardless of the process's cwd. Same reasoning as
// groundTruthLoader.js.
const BACKEND_DIR = path.join(__dirname, "..", "..", "backend");
const YAML = require(require.resolve("yaml", { paths: [BACKEND_DIR] }));

const APPLICABILITIES = Object.freeze(["APPLIED", "NOT_AVAILABLE", "NOT_APPLICABLE"]);
const BANDS = Object.freeze(["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

// Exactly the normalized snapshot shape riskInputSnapshot.js produces. A
// scenario must declare every key — an omitted input would silently become
// `undefined` and score as missing context, which is a very easy way to write
// a test that proves nothing.
const REQUIRED_INPUT_KEYS = Object.freeze([
  "reportType",
  "protocol",
  "port",
  "findingStatus",
  "observationCount",
  "recurredCount",
  "daysUnresolved",
  "enrichmentPresent",
  "enrichmentStatus",
  "enrichmentFresh",
  "abuseConfidenceScore",
  "ownershipStatus",
  "ownershipConfidence",
  "ownershipIsIspAttribution",
  "sectorAttributable",
  "sectorNonAttributableReason",
  "sector",
  "cvePresent",
  "kevListed",
  "kevLookupAvailable",
  "epssBasisPoints",
]);

const REQUIRED_FACTOR_KEYS = Object.freeze([
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

class RiskGroundTruthValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RiskGroundTruthValidationError";
  }
}

function fail(pathLabel, message) {
  throw new RiskGroundTruthValidationError(`risk ground truth ${pathLabel}: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertInt(value, label, { min = null, max = null } = {}) {
  if (!Number.isInteger(value)) {
    fail(label, `must be an integer, got ${JSON.stringify(value)}`);
  }
  if (min !== null && value < min) fail(label, `must be at least ${min}`);
  if (max !== null && value > max) fail(label, `must be at most ${max}`);
  return value;
}

function validateContract(contract) {
  const label = "contract";
  if (!isPlainObject(contract)) fail(label, "must be an object");

  ["algorithmVersion", "configurationVersion"].forEach((field) => {
    if (typeof contract[field] !== "string" || contract[field] === "") {
      fail(`${label}.${field}`, "must be a non-empty string");
    }
  });

  assertInt(contract.scoreMinBasisPoints, `${label}.scoreMinBasisPoints`, { min: 0 });
  assertInt(contract.scoreMaxBasisPoints, `${label}.scoreMaxBasisPoints`, { min: 1 });
  assertInt(contract.displayScoreDivisor, `${label}.displayScoreDivisor`, { min: 1 });
  assertInt(contract.maxNormalizedDays, `${label}.maxNormalizedDays`, { min: 1 });

  if (!isPlainObject(contract.factorMaximums)) fail(`${label}.factorMaximums`, "must be an object");
  const declared = Object.keys(contract.factorMaximums).sort();
  if (declared.join(",") !== [...REQUIRED_FACTOR_KEYS].sort().join(",")) {
    fail(`${label}.factorMaximums`, "must declare exactly the ten approved factor keys");
  }
  REQUIRED_FACTOR_KEYS.forEach((key) =>
    assertInt(contract.factorMaximums[key], `${label}.factorMaximums.${key}`, { min: 0 })
  );

  if (!Array.isArray(contract.bands) || contract.bands.length === 0) {
    fail(`${label}.bands`, "must be a non-empty array");
  }
  contract.bands.forEach((row, index) => {
    const rowLabel = `${label}.bands[${index}]`;
    if (!isPlainObject(row)) fail(rowLabel, "must be an object");
    if (!BANDS.includes(row.band)) fail(`${rowLabel}.band`, `must be one of ${BANDS.join(", ")}`);
    assertInt(row.minBasisPoints, `${rowLabel}.minBasisPoints`, { min: 0 });
    assertInt(row.maxBasisPoints, `${rowLabel}.maxBasisPoints`, { min: 0 });
    if (row.maxBasisPoints < row.minBasisPoints) fail(rowLabel, "has an inverted range");
  });

  return contract;
}

function validateInputs(inputs, scenarioId) {
  const label = `scenarios[${scenarioId}].inputs`;
  if (!isPlainObject(inputs)) fail(label, "must be an object");

  const missing = REQUIRED_INPUT_KEYS.filter((key) => !(key in inputs));
  if (missing.length > 0) {
    fail(label, `is missing required input(s): ${missing.join(", ")}`);
  }
  const unknown = Object.keys(inputs).filter((key) => !REQUIRED_INPUT_KEYS.includes(key));
  if (unknown.length > 0) {
    fail(label, `declares unknown input(s): ${unknown.join(", ")}`);
  }
  return inputs;
}

function validateExpectedFactor(entry, scenarioId, factorKey) {
  const label = `scenarios[${scenarioId}].expected.factors.${factorKey}`;
  if (!isPlainObject(entry)) fail(label, "must be an object");
  if (!REQUIRED_FACTOR_KEYS.includes(factorKey)) {
    fail(label, `is not one of the ten approved factor keys`);
  }
  if (!APPLICABILITIES.includes(entry.applicability)) {
    fail(`${label}.applicability`, `must be one of ${APPLICABILITIES.join(", ")}`);
  }
  assertInt(entry.contributionBasisPoints, `${label}.contributionBasisPoints`, { min: 0 });
  if (typeof entry.explanationCode !== "string" || entry.explanationCode === "") {
    fail(`${label}.explanationCode`, "must be a non-empty string");
  }
  // The structural rule from the locked contract: only APPLIED may be
  // non-zero. Catching it here means a mis-authored expectation cannot even
  // be compared, let alone pass.
  if (entry.applicability !== "APPLIED" && entry.contributionBasisPoints !== 0) {
    fail(label, "a non-APPLIED factor must expect exactly 0 basis points");
  }
  if (
    "normalizedInputValue" in entry &&
    entry.normalizedInputValue !== null &&
    typeof entry.normalizedInputValue !== "string"
  ) {
    fail(`${label}.normalizedInputValue`, "must be a string or null when present");
  }
  return entry;
}

function validateExpected(expected, scenarioId, contract) {
  const label = `scenarios[${scenarioId}].expected`;
  if (!isPlainObject(expected)) fail(label, "must be an object");

  assertInt(expected.scoreBasisPoints, `${label}.scoreBasisPoints`, {
    min: contract.scoreMinBasisPoints,
    max: contract.scoreMaxBasisPoints,
  });
  assertInt(expected.displayScore, `${label}.displayScore`, { min: 0 });
  if (!BANDS.includes(expected.riskBand)) {
    fail(`${label}.riskBand`, `must be one of ${BANDS.join(", ")}`);
  }

  // Internal coherence of the hand-authored expectation itself: the declared
  // display score and band must follow from the declared score. A typo in the
  // expectation is caught here rather than being blamed on the engine.
  const expectedDisplay = Math.floor(expected.scoreBasisPoints / contract.displayScoreDivisor);
  if (expected.displayScore !== expectedDisplay) {
    fail(
      `${label}.displayScore`,
      `is ${expected.displayScore} but floor(${expected.scoreBasisPoints}/${contract.displayScoreDivisor}) is ${expectedDisplay}`
    );
  }
  const band = contract.bands.find(
    (row) =>
      expected.scoreBasisPoints >= row.minBasisPoints &&
      expected.scoreBasisPoints <= row.maxBasisPoints
  );
  if (!band) fail(`${label}.riskBand`, "no declared band covers the expected score");
  if (band.band !== expected.riskBand) {
    fail(
      `${label}.riskBand`,
      `is ${expected.riskBand} but ${expected.scoreBasisPoints} basis points falls in ${band.band}`
    );
  }

  const factors = {};
  if (expected.factors !== undefined) {
    if (!isPlainObject(expected.factors)) fail(`${label}.factors`, "must be an object");
    Object.entries(expected.factors).forEach(([factorKey, entry]) => {
      factors[factorKey] = validateExpectedFactor(entry, scenarioId, factorKey);
      if (entry.contributionBasisPoints > contract.factorMaximums[factorKey]) {
        fail(
          `${label}.factors.${factorKey}`,
          `expects ${entry.contributionBasisPoints}, above the declared cap ${contract.factorMaximums[factorKey]}`
        );
      }
    });
  }

  return { ...expected, factors };
}

function validateScenario(scenario, index, contract, seenIds) {
  const label = `scenarios[${index}]`;
  if (!isPlainObject(scenario)) fail(label, "must be an object");
  if (typeof scenario.id !== "string" || scenario.id === "") {
    fail(`${label}.id`, "must be a non-empty string");
  }
  if (seenIds.has(scenario.id)) {
    fail(`${label}.id`, `duplicate scenario identifier "${scenario.id}"`);
  }
  seenIds.add(scenario.id);

  assertInt(scenario.order, `${label}.order`, { min: 0 });
  if (typeof scenario.description !== "string" || scenario.description.trim() === "") {
    fail(`${label}.description`, "must be a non-empty string");
  }

  return {
    id: scenario.id,
    order: scenario.order,
    description: scenario.description,
    inputs: validateInputs(scenario.inputs, scenario.id),
    expected: validateExpected(scenario.expected, scenario.id, contract),
  };
}

function validateRiskGroundTruth(raw) {
  if (!isPlainObject(raw)) fail("(root)", "must be a YAML mapping");
  if (!Number.isInteger(raw.version)) fail("version", "must be an integer");
  if (typeof raw.schemaVersion !== "string" || raw.schemaVersion === "") {
    fail("schemaVersion", "must be a non-empty string");
  }

  const contract = validateContract(raw.contract);

  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    fail("scenarios", "must be a non-empty array");
  }
  const seenIds = new Set();
  const scenarios = raw.scenarios
    .map((scenario, index) => validateScenario(scenario, index, contract, seenIds))
    .sort((a, b) => a.order - b.order);

  return {
    version: raw.version,
    schemaVersion: raw.schemaVersion,
    datasetDisclaimer: typeof raw.datasetDisclaimer === "string" ? raw.datasetDisclaimer : null,
    contract,
    scenarios,
  };
}

/**
 * Reads and validates the risk ground-truth YAML file.
 * @param {string} filePath absolute or relative path to risk_ground_truth.yaml
 */
function loadRiskGroundTruth(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TypeError("loadRiskGroundTruth: filePath must be a non-empty string");
  }
  if (!fs.existsSync(filePath)) {
    throw new RiskGroundTruthValidationError(`risk ground truth file not found: ${filePath}`);
  }

  const text = fs.readFileSync(filePath, "utf8");
  let raw;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    throw new RiskGroundTruthValidationError(
      `risk ground truth is not valid YAML: ${error.message}`
    );
  }
  return validateRiskGroundTruth(raw);
}

/** Parses from an in-memory YAML string (used by tests that tamper with one
 * value without ever writing to the committed file). */
function parseRiskGroundTruth(yamlText) {
  let raw;
  try {
    raw = YAML.parse(yamlText);
  } catch (error) {
    throw new RiskGroundTruthValidationError(
      `risk ground truth is not valid YAML: ${error.message}`
    );
  }
  return validateRiskGroundTruth(raw);
}

module.exports = {
  RiskGroundTruthValidationError,
  APPLICABILITIES,
  BANDS,
  REQUIRED_INPUT_KEYS,
  REQUIRED_FACTOR_KEYS,
  loadRiskGroundTruth,
  parseRiskGroundTruth,
  validateRiskGroundTruth,
};
