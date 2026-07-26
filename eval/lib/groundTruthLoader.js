"use strict";

// Loads and structurally validates data/synthetic/ground_truth.yaml for the
// Phase 1 gate (eval/run_phase1_gate.js). Pure and side-effect-free apart
// from the one file read: no Prisma access, no network access. Timestamps
// are validated as explicit RFC 3339 UTC *strings* and returned unparsed —
// only the comparator (phase1Comparator.js) turns them into Dates, and only
// at the point of an explicit equality check, so a YAML-level date coercion
// bug can never silently substitute a different instant here.

const fs = require("fs");
const path = require("path");

// eval/ is a sibling of backend/ (not a descendant), so a bare
// require("yaml") here would walk up from eval/ and never find
// backend/node_modules/yaml, where it's actually installed (yaml is a
// backend dependency — eval/ has no package.json of its own). Resolving it
// explicitly as if required from backend/ finds it correctly regardless of
// the process's cwd.
const BACKEND_DIR = path.join(__dirname, "..", "..", "backend");
const YAML = require(require.resolve("yaml", { paths: [BACKEND_DIR] }));

const OCCURRENCE_ACTIONS = Object.freeze(["CREATED", "PERSISTED", "HISTORICAL", "RECURRED"]);
const ROW_STATUSES = Object.freeze(["VALID", "INVALID"]);
const SCENARIO_KINDS = Object.freeze(["ingest"]);
const PRE_STEP_TYPES = Object.freeze(["evalClosureFixture"]);

// Explicit UTC only (Z or +00:00), same discipline as
// accessibleRdpRowValidator.js's own RFC 3339 rule — this file must never
// accept a timestamp whose UTC-ness is ambiguous.
const RFC3339_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|z|\+00:00)$/;

class GroundTruthValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GroundTruthValidationError";
  }
}

function fail(pathLabel, message) {
  throw new GroundTruthValidationError(`ground truth ${pathLabel}: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertNonNegativeInt(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    fail(label, `must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
}

function assertUtcString(value, label) {
  if (typeof value !== "string" || !RFC3339_UTC_PATTERN.test(value)) {
    fail(label, `must be an explicit RFC 3339 UTC string, got ${JSON.stringify(value)}`);
  }
}

function validateFindingIdentities(findingIdentities) {
  if (!isPlainObject(findingIdentities) || Object.keys(findingIdentities).length === 0) {
    fail("findingIdentities", "must be a non-empty object");
  }
  Object.entries(findingIdentities).forEach(([key, identity]) => {
    if (!isPlainObject(identity)) fail(`findingIdentities.${key}`, "must be an object");
    ["indicatorValue", "protocol", "reportType"].forEach((field) => {
      if (typeof identity[field] !== "string" || identity[field] === "") {
        fail(`findingIdentities.${key}.${field}`, "must be a non-empty string");
      }
    });
    if (!Number.isInteger(identity.port) || identity.port < 1 || identity.port > 65535) {
      fail(`findingIdentities.${key}.port`, "must be an integer between 1 and 65535");
    }
  });
  return findingIdentities;
}

function validateOccurrenceActionCounts(counts, label) {
  if (counts === undefined) return { CREATED: 0, PERSISTED: 0, HISTORICAL: 0, RECURRED: 0 };
  if (!isPlainObject(counts)) fail(label, "must be an object");

  const unknown = Object.keys(counts).filter((key) => !OCCURRENCE_ACTIONS.includes(key));
  if (unknown.length > 0) {
    fail(label, `contains unknown occurrence action(s): ${unknown.join(", ")}`);
  }

  const normalized = {};
  OCCURRENCE_ACTIONS.forEach((action) => {
    const value = action in counts ? counts[action] : 0;
    assertNonNegativeInt(value, `${label}.${action}`);
    normalized[action] = value;
  });
  return normalized;
}

function validateRow(row, index, findingIdentities, label) {
  if (!isPlainObject(row)) fail(`${label}[${index}]`, "must be an object");
  assertNonNegativeInt(row.rowNumber, `${label}[${index}].rowNumber`);
  if (!ROW_STATUSES.includes(row.status)) {
    fail(`${label}[${index}].status`, `must be one of ${ROW_STATUSES.join(", ")}`);
  }
  if (typeof row.duplicateInReport !== "boolean") {
    fail(`${label}[${index}].duplicateInReport`, "must be a boolean");
  }
  if (row.findingIdentity !== null) {
    if (typeof row.findingIdentity !== "string" || !(row.findingIdentity in findingIdentities)) {
      fail(`${label}[${index}].findingIdentity`, "must be null or a declared findingIdentities key");
    }
  }
  if (!Array.isArray(row.errorCodes) || row.errorCodes.some((code) => typeof code !== "string")) {
    fail(`${label}[${index}].errorCodes`, "must be an array of strings");
  }
  return row;
}

function validateFindingExpectation(finding, index, findingIdentities, label) {
  if (!isPlainObject(finding)) fail(`${label}[${index}]`, "must be an object");
  if (typeof finding.identity !== "string" || !(finding.identity in findingIdentities)) {
    fail(`${label}[${index}].identity`, "must be a declared findingIdentities key");
  }
  if (!["OPEN", "CLOSED"].includes(finding.status)) {
    fail(`${label}[${index}].status`, "must be OPEN or CLOSED");
  }
  assertUtcString(finding.firstSeen, `${label}[${index}].firstSeen`);
  assertUtcString(finding.lastSeen, `${label}[${index}].lastSeen`);
  assertNonNegativeInt(finding.occurrenceCount, `${label}[${index}].occurrenceCount`);
  assertNonNegativeInt(finding.recurrenceCount, `${label}[${index}].recurrenceCount`);
  if (finding.closedThroughObservedAt !== null && finding.closedThroughObservedAt !== undefined) {
    assertUtcString(finding.closedThroughObservedAt, `${label}[${index}].closedThroughObservedAt`);
  }
  return finding;
}

function validatePreStep(step, index, findingIdentities, label) {
  if (!isPlainObject(step)) fail(`${label}[${index}]`, "must be an object");
  if (!PRE_STEP_TYPES.includes(step.type)) {
    fail(`${label}[${index}].type`, `must be one of ${PRE_STEP_TYPES.join(", ")}`);
  }
  if (typeof step.findingIdentity !== "string" || !(step.findingIdentity in findingIdentities)) {
    fail(`${label}[${index}].findingIdentity`, "must be a declared findingIdentities key");
  }
  assertUtcString(step.closedThroughObservedAt, `${label}[${index}].closedThroughObservedAt`);
  if (typeof step.closureReason !== "string" || step.closureReason.trim() === "") {
    fail(`${label}[${index}].closureReason`, "must be a non-empty string");
  }
  return step;
}

function validateExpected(expected, scenarioId, findingIdentities) {
  const label = `scenarios[${scenarioId}].expected`;
  if (!isPlainObject(expected)) fail(label, "must be an object");
  if (typeof expected.outcome !== "string" || expected.outcome === "") {
    fail(`${label}.outcome`, "must be a non-empty string");
  }

  ["rawReportCountDelta", "rawReportRowCountDelta", "findingCountDelta", "findingOccurrenceCountDelta"].forEach(
    (field) => assertNonNegativeInt(expected[field], `${label}.${field}`)
  );

  const occurrenceActionCounts = validateOccurrenceActionCounts(
    expected.occurrenceActionCounts,
    `${label}.occurrenceActionCounts`
  );

  const rows = Array.isArray(expected.rows)
    ? expected.rows.map((row, index) => validateRow(row, index, findingIdentities, `${label}.rows`))
    : [];

  const findings = Array.isArray(expected.findings)
    ? expected.findings.map((finding, index) =>
        validateFindingExpectation(finding, index, findingIdentities, `${label}.findings`)
      )
    : [];

  if (expected.reasonCode !== undefined && typeof expected.reasonCode !== "string") {
    fail(`${label}.reasonCode`, "must be a string when present");
  }
  if (expected.reportStatus !== undefined && typeof expected.reportStatus !== "string") {
    fail(`${label}.reportStatus`, "must be a string when present");
  }
  if (expected.auditActionCounts !== undefined) {
    if (!isPlainObject(expected.auditActionCounts)) fail(`${label}.auditActionCounts`, "must be an object");
    Object.entries(expected.auditActionCounts).forEach(([action, count]) =>
      assertNonNegativeInt(count, `${label}.auditActionCounts.${action}`)
    );
  }
  if (expected.reportIdMatchesScenario !== undefined && typeof expected.reportIdMatchesScenario !== "string") {
    fail(`${label}.reportIdMatchesScenario`, "must be a string when present");
  }
  if (
    expected.occurrencesUnchangedSinceScenario !== undefined &&
    typeof expected.occurrencesUnchangedSinceScenario !== "string"
  ) {
    fail(`${label}.occurrencesUnchangedSinceScenario`, "must be a string when present");
  }

  return {
    ...expected,
    occurrenceActionCounts,
    rows,
    findings,
  };
}

function validateScenario(scenario, index, findingIdentities, seenIds) {
  const label = `scenarios[${index}]`;
  if (!isPlainObject(scenario)) fail(label, "must be an object");
  if (typeof scenario.id !== "string" || scenario.id === "") {
    fail(`${label}.id`, "must be a non-empty string");
  }
  if (seenIds.has(scenario.id)) {
    fail(`${label}.id`, `duplicate scenario identifier "${scenario.id}"`);
  }
  seenIds.add(scenario.id);

  assertNonNegativeInt(scenario.order, `${label}.order`);
  if (!SCENARIO_KINDS.includes(scenario.kind)) {
    fail(`${label}.kind`, `must be one of ${SCENARIO_KINDS.join(", ")}`);
  }
  if (typeof scenario.fixtureFile !== "string" || scenario.fixtureFile === "") {
    fail(`${label}.fixtureFile`, "must be a non-empty string");
  }
  if (typeof scenario.source !== "string" || scenario.source === "") {
    fail(`${label}.source`, "must be a non-empty string");
  }

  const preSteps = Array.isArray(scenario.preSteps)
    ? scenario.preSteps.map((step, i) => validatePreStep(step, i, findingIdentities, `${label}.preSteps`))
    : [];

  const expected = validateExpected(scenario.expected, scenario.id, findingIdentities);

  return { ...scenario, preSteps, expected };
}

function validateGroundTruth(raw) {
  if (!isPlainObject(raw)) fail("(root)", "must be a YAML mapping");
  if (!Number.isInteger(raw.version)) fail("version", "must be an integer");
  if (typeof raw.schemaVersion !== "string" || raw.schemaVersion === "") {
    fail("schemaVersion", "must be a non-empty string");
  }
  const findingIdentities = validateFindingIdentities(raw.findingIdentities);

  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    fail("scenarios", "must be a non-empty array");
  }

  const seenIds = new Set();
  const scenarios = raw.scenarios
    .map((scenario, index) => validateScenario(scenario, index, findingIdentities, seenIds))
    .sort((a, b) => a.order - b.order);

  return {
    version: raw.version,
    schemaVersion: raw.schemaVersion,
    datasetDisclaimer: typeof raw.datasetDisclaimer === "string" ? raw.datasetDisclaimer : null,
    findingIdentities,
    scenarios,
  };
}

/**
 * Reads and validates a ground-truth YAML file.
 * @param {string} filePath - absolute or relative path to ground_truth.yaml.
 * @returns {{version:number, schemaVersion:string, datasetDisclaimer:string|null,
 *   findingIdentities:Object, scenarios:Array}}
 */
function loadGroundTruth(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TypeError("loadGroundTruth: filePath must be a non-empty string");
  }
  if (!fs.existsSync(filePath)) {
    throw new GroundTruthValidationError(`ground truth file not found: ${filePath}`);
  }

  const text = fs.readFileSync(filePath, "utf8");
  let raw;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    throw new GroundTruthValidationError(`ground truth is not valid YAML: ${error.message}`);
  }

  return validateGroundTruth(raw);
}

/**
 * Parses ground truth from an in-memory YAML string (used by tests that
 * deliberately tamper with one value without ever writing to the committed
 * ground_truth.yaml file).
 */
function parseGroundTruth(yamlText) {
  let raw;
  try {
    raw = YAML.parse(yamlText);
  } catch (error) {
    throw new GroundTruthValidationError(`ground truth is not valid YAML: ${error.message}`);
  }
  return validateGroundTruth(raw);
}

function resolveFixturePath(groundTruthFilePath, scenarioFixtureFile) {
  return path.join(path.dirname(groundTruthFilePath), scenarioFixtureFile);
}

module.exports = {
  GroundTruthValidationError,
  OCCURRENCE_ACTIONS,
  ROW_STATUSES,
  SCENARIO_KINDS,
  PRE_STEP_TYPES,
  loadGroundTruth,
  parseGroundTruth,
  validateGroundTruth,
  resolveFixturePath,
};
