import { describe, it, expect } from "vitest";

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const {
  GroundTruthValidationError,
  loadGroundTruth,
  parseGroundTruth,
} = require("../../../eval/lib/groundTruthLoader");

const REAL_GROUND_TRUTH_PATH = path.join(__dirname, "..", "..", "..", "data", "synthetic", "ground_truth.yaml");

const MINIMAL_VALID_YAML = `
version: 1
schemaVersion: "phase1-gate-ground-truth.v1"
findingIdentities:
  FINDING_A:
    indicatorValue: "203.0.113.11"
    port: 3389
    protocol: "TCP"
    reportType: "ACCESSIBLE_RDP"
scenarios:
  - id: "s1"
    order: 1
    kind: "ingest"
    fixtureFile: "accessible-rdp/x.csv"
    source: "SYNTHETIC_UPLOAD"
    expected:
      outcome: "PROCESSED"
      rawReportCountDelta: 1
      rawReportRowCountDelta: 1
      findingCountDelta: 1
      findingOccurrenceCountDelta: 1
`;

describe("groundTruthLoader — the real committed ground_truth.yaml", () => {
  it("loads and validates without error", () => {
    const gt = loadGroundTruth(REAL_GROUND_TRUTH_PATH);
    expect(gt.scenarios.length).toBe(9);
    expect(gt.scenarios.map((s) => s.id)).toContain("01_baseline");
  });

  it("keeps timestamps as explicit strings, not parsed Dates", () => {
    const gt = loadGroundTruth(REAL_GROUND_TRUTH_PATH);
    const baseline = gt.scenarios.find((s) => s.id === "01_baseline");
    const finding = baseline.expected.findings[0];
    expect(typeof finding.firstSeen).toBe("string");
    expect(finding.firstSeen).toMatch(/Z$/);
  });
});

describe("groundTruthLoader — structural validation", () => {
  it("accepts a valid minimal document", () => {
    const gt = parseGroundTruth(MINIMAL_VALID_YAML);
    expect(gt.scenarios).toHaveLength(1);
    expect(gt.scenarios[0].id).toBe("s1");
    // Missing occurrenceActionCounts defaults to all zeros rather than erroring.
    expect(gt.scenarios[0].expected.occurrenceActionCounts).toEqual({
      CREATED: 0,
      PERSISTED: 0,
      HISTORICAL: 0,
      RECURRED: 0,
    });
  });

  it("rejects a missing required section (scenarios)", () => {
    const yaml = `
version: 1
schemaVersion: "v1"
findingIdentities:
  FINDING_A: { indicatorValue: "203.0.113.11", port: 3389, protocol: "TCP", reportType: "ACCESSIBLE_RDP" }
`;
    expect(() => parseGroundTruth(yaml)).toThrow(GroundTruthValidationError);
  });

  it("rejects a missing required section (findingIdentities)", () => {
    const yaml = `
version: 1
schemaVersion: "v1"
scenarios:
  - id: "s1"
    order: 1
    kind: "ingest"
    fixtureFile: "x.csv"
    source: "SYNTHETIC_UPLOAD"
    expected:
      outcome: "PROCESSED"
      rawReportCountDelta: 0
      rawReportRowCountDelta: 0
      findingCountDelta: 0
      findingOccurrenceCountDelta: 0
`;
    expect(() => parseGroundTruth(yaml)).toThrow(GroundTruthValidationError);
  });

  it("rejects malformed YAML", () => {
    const malformed = "version: 1\nscenarios: [ { id: \"s1\" ,, } ]";
    expect(() => parseGroundTruth(malformed)).toThrow(GroundTruthValidationError);
  });

  it("rejects a duplicate scenario identifier", () => {
    const yaml =
      MINIMAL_VALID_YAML +
      `
  - id: "s1"
    order: 2
    kind: "ingest"
    fixtureFile: "accessible-rdp/y.csv"
    source: "SYNTHETIC_UPLOAD"
    expected:
      outcome: "PROCESSED"
      rawReportCountDelta: 0
      rawReportRowCountDelta: 0
      findingCountDelta: 0
      findingOccurrenceCountDelta: 0
`;
    expect(() => parseGroundTruth(yaml)).toThrow(/duplicate scenario identifier/);
  });

  it("rejects an unknown occurrence action", () => {
    const yaml = MINIMAL_VALID_YAML.replace(
      "findingOccurrenceCountDelta: 1",
      "findingOccurrenceCountDelta: 1\n      occurrenceActionCounts: { CREATED: 1, BOGUS_ACTION: 1 }"
    );
    expect(() => parseGroundTruth(yaml)).toThrow(/unknown occurrence action/);
  });

  it("rejects an invalid (negative) expected count", () => {
    const yaml = MINIMAL_VALID_YAML.replace("rawReportCountDelta: 1", "rawReportCountDelta: -1");
    expect(() => parseGroundTruth(yaml)).toThrow(GroundTruthValidationError);
  });

  it("rejects an invalid (non-integer) expected count", () => {
    const yaml = MINIMAL_VALID_YAML.replace("rawReportCountDelta: 1", 'rawReportCountDelta: "one"');
    expect(() => parseGroundTruth(yaml)).toThrow(GroundTruthValidationError);
  });

  it("rejects a row status that isn't VALID or INVALID", () => {
    const yaml =
      MINIMAL_VALID_YAML +
      `      rows:
        - rowNumber: 1
          status: "MAYBE"
          duplicateInReport: false
          findingIdentity: "FINDING_A"
          errorCodes: []
`;
    expect(() => parseGroundTruth(yaml)).toThrow(/status/);
  });

  it("rejects a finding expectation referencing an undeclared identity key", () => {
    const yaml =
      MINIMAL_VALID_YAML +
      `      findings:
        - identity: "NOT_DECLARED"
          status: "OPEN"
          firstSeen: "2026-01-01T00:00:00.000Z"
          lastSeen: "2026-01-01T00:00:00.000Z"
          occurrenceCount: 1
          recurrenceCount: 0
`;
    expect(() => parseGroundTruth(yaml)).toThrow(/declared findingIdentities key/);
  });

  it("rejects a non-UTC-explicit timestamp on a finding expectation", () => {
    const yaml =
      MINIMAL_VALID_YAML +
      `      findings:
        - identity: "FINDING_A"
          status: "OPEN"
          firstSeen: "2026-01-01T00:00:00"
          lastSeen: "2026-01-01T00:00:00.000Z"
          occurrenceCount: 1
          recurrenceCount: 0
`;
    expect(() => parseGroundTruth(yaml)).toThrow(/RFC 3339 UTC string/);
  });

  it("rejects a preStep of an unknown type", () => {
    const yaml = MINIMAL_VALID_YAML.replace(
      'source: "SYNTHETIC_UPLOAD"\n    expected:',
      'source: "SYNTHETIC_UPLOAD"\n    preSteps:\n      - type: "somethingElse"\n        findingIdentity: "FINDING_A"\n        closedThroughObservedAt: "2026-01-01T00:00:00.000Z"\n        closureReason: "x"\n    expected:'
    );
    expect(() => parseGroundTruth(yaml)).toThrow(/preSteps/);
  });

  it("rejects a nonexistent file path", () => {
    expect(() => loadGroundTruth(path.join(__dirname, "does-not-exist.yaml"))).toThrow(
      GroundTruthValidationError
    );
  });

  it("throws a TypeError for a non-string filePath (contract violation)", () => {
    expect(() => loadGroundTruth(null)).toThrow(TypeError);
  });
});

describe("groundTruthLoader — line-ending independence", () => {
  // phase1Gate.test.js's tampered-ground-truth proof used to build its tamper
  // via a hardcoded LF-joined string replace against the raw file text — a
  // no-op on a CRLF checkout (core.autocrlf=true materializes CRLF from the
  // LF-committed blob), so the proof silently never tampered anything. The
  // fix parses the committed YAML into an object, mutates the object, and
  // re-serializes it, which never inspects raw line-ending bytes at all.
  // These tests prove that approach behaves identically no matter which line
  // ending the source text happens to use.
  const realText = fs.readFileSync(REAL_GROUND_TRUTH_PATH, "utf8");
  const lfText = realText.replace(/\r\n/g, "\n");
  const crlfText = lfText.replace(/\n/g, "\r\n");

  it("parses byte-identical content from an LF and a CRLF representation", () => {
    expect(parseGroundTruth(lfText)).toEqual(parseGroundTruth(crlfText));
  });

  it("locates and tampers the same value regardless of source line ending", () => {
    [lfText, crlfText].forEach((text) => {
      const parsed = YAML.parse(text);
      const persistenceScenario = parsed.scenarios.find((s) => s.id === "03_persistence");
      const findingA = persistenceScenario.expected.findings.find((f) => f.identity === "FINDING_A");
      expect(findingA.occurrenceCount).toBe(2);

      findingA.occurrenceCount = 999;
      const tampered = parseGroundTruth(YAML.stringify(parsed));
      const tamperedFindingA = tampered.scenarios
        .find((s) => s.id === "03_persistence")
        .expected.findings.find((f) => f.identity === "FINDING_A");
      expect(tamperedFindingA.occurrenceCount).toBe(999);
    });
  });
});
