"use strict";

// Gold-standard dataset loader and reporting harness (Phase 7).
//
// BUILD_PLAN 7A specifies `eval/run_gold_standard`: compare AI mapping
// suggestions against a 50–100 finding labelled set and report accept / edit /
// reject rates. The plan is equally specific about where the labels come from —
// the `tasks/` track "Gold-standard labelling", owned by two named people:
//
//     "50–100 findings labelled independently, disagreements resolved,
//      inter-rater agreement recorded. Two people required — this is the
//      answer key, so it must not be AI-generated."
//
// That constraint is the entire point of the artifact. An answer key written by
// the system under evaluation, or by an assistant helping to build it, measures
// nothing: it would report agreement between a model and itself and call the
// number accuracy. So this module does NOT synthesize labels, and there is no
// flag that makes it do so.
//
// What it does instead:
//
//   * defines and enforces the label file's schema, so the human labellers have
//     something concrete to fill in and a validator that tells them when a row
//     is incomplete;
//   * computes accept / edit / reject rates and Cohen's kappa from real labels
//     when they exist;
//   * reports an explicit, machine-readable UNMET DEPENDENCY when they do not,
//     which the Phase 7 gate prints as a dependency rather than a pass or a
//     failure.
//
// A missing answer key is not a bug in the software. It is an outstanding
// human deliverable, and the release report must say so in those words.

const fs = require("fs");
const path = require("path");

const BACKEND_DIR = path.join(__dirname, "..", "..", "backend");
const YAML = require(require.resolve("yaml", { paths: [BACKEND_DIR] }));

const SCHEMA_VERSION = "phase7-gold-standard.v1";

// The plan's own range. A set below the floor cannot support a rate that means
// anything; the loader refuses to report one rather than quoting a percentage
// derived from nine rows.
const MIN_LABELLED_FINDINGS = 50;
const MAX_LABELLED_FINDINGS = 100;

const DECISIONS = Object.freeze(["ACCEPT", "EDIT", "REJECT"]);

class GoldStandardValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoldStandardValidationError";
  }
}

const DEFAULT_PATH = path.join(
  __dirname,
  "..",
  "..",
  "data",
  "synthetic",
  "gold_standard.yaml"
);

/**
 * Describes the dataset's availability without throwing.
 *
 * Returns one of:
 *   { state: "ABSENT",     reason }                 — no label file at all
 *   { state: "INCOMPLETE", reason, detail }          — present but not usable
 *   { state: "READY",      dataset }                 — validated and usable
 *
 * The three are deliberately distinct. "Absent" is a task that has not started;
 * "incomplete" is one in progress; only "ready" may produce a rate.
 */
function describeGoldStandard(filePath = DEFAULT_PATH) {
  if (!fs.existsSync(filePath)) {
    return {
      state: "ABSENT",
      path: filePath,
      reason:
        "No gold-standard label file. This is a human deliverable (BUILD_PLAN " +
        "tasks/ track 'Gold-standard labelling'): two named team members must " +
        "label 50-100 findings independently, resolve disagreements, and record " +
        "inter-rater agreement. It must not be AI-generated.",
    };
  }

  let parsed;
  try {
    parsed = YAML.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return {
      state: "INCOMPLETE",
      path: filePath,
      reason: "The gold-standard file is present but is not valid YAML.",
      detail: error.message,
    };
  }

  try {
    const dataset = validate(parsed, filePath);
    return { state: "READY", path: filePath, dataset };
  } catch (error) {
    return {
      state: "INCOMPLETE",
      path: filePath,
      reason: "The gold-standard file is present but does not satisfy the schema.",
      detail: error.message,
    };
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GoldStandardValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function validate(parsed, filePath) {
  if (!parsed || typeof parsed !== "object") {
    throw new GoldStandardValidationError("the file must contain a YAML mapping");
  }

  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new GoldStandardValidationError(
      `schemaVersion must be "${SCHEMA_VERSION}" (got ${JSON.stringify(parsed.schemaVersion)})`
    );
  }

  // Two independent labellers, named. One labeller cannot disagree with
  // themself, so inter-rater agreement would be undefined — and an answer key
  // with no second opinion is exactly what the plan forbids.
  const labellers = parsed.labellers;
  if (!Array.isArray(labellers) || labellers.length !== 2) {
    throw new GoldStandardValidationError(
      "labellers must be a list of exactly two named people"
    );
  }
  labellers.forEach((labeller, index) => {
    requireString(labeller && labeller.name, `labellers[${index}].name`);
    requireString(labeller && labeller.role, `labellers[${index}].role`);
  });
  if (labellers[0].name === labellers[1].name) {
    throw new GoldStandardValidationError("the two labellers must be different people");
  }

  requireString(parsed.disagreementResolution, "disagreementResolution");

  const findings = parsed.findings;
  if (!Array.isArray(findings)) {
    throw new GoldStandardValidationError("findings must be a list");
  }
  if (findings.length < MIN_LABELLED_FINDINGS) {
    throw new GoldStandardValidationError(
      `findings must contain at least ${MIN_LABELLED_FINDINGS} labelled rows ` +
        `(got ${findings.length}); a rate computed from fewer would not mean anything`
    );
  }
  if (findings.length > MAX_LABELLED_FINDINGS) {
    throw new GoldStandardValidationError(
      `findings must contain at most ${MAX_LABELLED_FINDINGS} labelled rows (got ${findings.length})`
    );
  }

  const seen = new Set();
  findings.forEach((finding, index) => {
    const id = requireString(finding && finding.id, `findings[${index}].id`);
    if (seen.has(id)) {
      throw new GoldStandardValidationError(`findings[${index}].id "${id}" is duplicated`);
    }
    seen.add(id);

    // Each labeller's independent verdict, plus the resolved one. Storing all
    // three is what makes agreement computable AFTER the fact rather than
    // asserted in a comment.
    for (const field of ["labelA", "labelB", "resolved"]) {
      const value = finding && finding[field];
      if (!DECISIONS.includes(value)) {
        throw new GoldStandardValidationError(
          `findings[${index}].${field} must be one of ${DECISIONS.join(", ")} (got ${JSON.stringify(value)})`
        );
      }
    }

    if (finding.resolved === "REJECT" || finding.resolved === "EDIT") {
      requireString(finding.reason, `findings[${index}].reason`);
    }
  });

  return {
    schemaVersion: parsed.schemaVersion,
    path: filePath,
    labellers: labellers.map((labeller) => ({ name: labeller.name, role: labeller.role })),
    disagreementResolution: parsed.disagreementResolution,
    findings: findings.map((finding) => ({
      id: finding.id,
      labelA: finding.labelA,
      labelB: finding.labelB,
      resolved: finding.resolved,
      reason: finding.reason || null,
    })),
  };
}

/**
 * Cohen's kappa over the two independent label columns.
 *
 * Raw percent agreement is reported alongside it on purpose: when one decision
 * dominates the set, kappa can be low while agreement is high, and quoting
 * either number alone misrepresents the other.
 */
function interRaterAgreement(dataset) {
  const rows = dataset.findings;
  const total = rows.length;

  let observed = 0;
  const countsA = Object.fromEntries(DECISIONS.map((decision) => [decision, 0]));
  const countsB = Object.fromEntries(DECISIONS.map((decision) => [decision, 0]));

  for (const row of rows) {
    if (row.labelA === row.labelB) observed += 1;
    countsA[row.labelA] += 1;
    countsB[row.labelB] += 1;
  }

  const observedAgreement = observed / total;
  const expectedAgreement = DECISIONS.reduce(
    (sum, decision) => sum + (countsA[decision] / total) * (countsB[decision] / total),
    0
  );

  const kappa =
    expectedAgreement === 1
      ? 1
      : (observedAgreement - expectedAgreement) / (1 - expectedAgreement);

  return {
    total,
    observedAgreement,
    expectedAgreement,
    cohensKappa: kappa,
  };
}

/**
 * Accept / edit / reject rates from the RESOLVED labels.
 *
 * The edit rate is returned beside the acceptance rate because BUILD_PLAN 7A
 * requires it: a high acceptance rate with a high edit rate is rubber-stamping
 * with extra steps, and reading acceptance alone would hide that.
 */
function decisionRates(dataset) {
  const rows = dataset.findings;
  const total = rows.length;
  const counts = Object.fromEntries(DECISIONS.map((decision) => [decision, 0]));

  for (const row of rows) counts[row.resolved] += 1;

  return {
    total,
    accepted: counts.ACCEPT,
    edited: counts.EDIT,
    rejected: counts.REJECT,
    acceptRate: counts.ACCEPT / total,
    editRate: counts.EDIT / total,
    rejectRate: counts.REJECT / total,
    rejectionReasons: rows
      .filter((row) => row.resolved === "REJECT" && row.reason)
      .map((row) => row.reason),
  };
}

module.exports = {
  SCHEMA_VERSION,
  MIN_LABELLED_FINDINGS,
  MAX_LABELLED_FINDINGS,
  DECISIONS,
  DEFAULT_PATH,
  GoldStandardValidationError,
  describeGoldStandard,
  interRaterAgreement,
  decisionRates,
};
