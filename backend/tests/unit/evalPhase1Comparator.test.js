import { describe, it, expect } from "vitest";

const { compareScenario, formatDiffs } = require("../../../eval/lib/phase1Comparator");

function baseExpected(overrides = {}) {
  return {
    outcome: "PROCESSED",
    reportStatus: "COMPLETED",
    totalRows: 1,
    validRows: 1,
    invalidRows: 0,
    rawReportCountDelta: 1,
    rawReportRowCountDelta: 1,
    findingCountDelta: 1,
    findingOccurrenceCountDelta: 1,
    occurrenceActionCounts: { CREATED: 1, PERSISTED: 0, HISTORICAL: 0, RECURRED: 0 },
    rows: [
      { rowNumber: 1, status: "VALID", duplicateInReport: false, findingIdentity: "FINDING_A", errorCodes: [] },
    ],
    findings: [
      {
        identity: "FINDING_A",
        status: "OPEN",
        firstSeen: "2026-01-01T00:00:00.000Z",
        lastSeen: "2026-01-01T00:00:00.000Z",
        occurrenceCount: 1,
        recurrenceCount: 0,
        closedThroughObservedAt: null,
      },
    ],
    ...overrides,
  };
}

function baseActual(overrides = {}) {
  return {
    outcome: "PROCESSED",
    reportStatus: "COMPLETED",
    totalRows: 1,
    validRows: 1,
    invalidRows: 0,
    rawReportCountDelta: 1,
    rawReportRowCountDelta: 1,
    findingCountDelta: 1,
    findingOccurrenceCountDelta: 1,
    occurrenceActionCounts: { CREATED: 1, PERSISTED: 0, HISTORICAL: 0, RECURRED: 0 },
    rows: [
      { rowNumber: 1, status: "VALID", duplicateInReport: false, findingIdentity: "FINDING_A", errorCodes: [] },
    ],
    findings: [
      {
        identity: "FINDING_A",
        status: "OPEN",
        firstSeen: new Date("2026-01-01T00:00:00.000Z"),
        lastSeen: new Date("2026-01-01T00:00:00.000Z"),
        occurrenceCount: 1,
        recurrenceCount: 0,
        closedThroughObservedAt: null,
      },
    ],
    ...overrides,
  };
}

describe("phase1Comparator — exact match", () => {
  it("passes when actual exactly matches expected", () => {
    const result = compareScenario(baseExpected(), baseActual());
    expect(result.pass).toBe(true);
    expect(result.diffs).toEqual([]);
  });
});

describe("phase1Comparator — count mismatches", () => {
  it("fails on a count delta mismatch", () => {
    const result = compareScenario(baseExpected(), baseActual({ findingCountDelta: 2 }));
    expect(result.pass).toBe(false);
    expect(result.diffs.some((d) => d.path === "findingCountDelta")).toBe(true);
  });
});

describe("phase1Comparator — occurrence action counts", () => {
  it("fails when an occurrence action count is wrong", () => {
    const result = compareScenario(
      baseExpected(),
      baseActual({ occurrenceActionCounts: { CREATED: 0, PERSISTED: 1, HISTORICAL: 0, RECURRED: 0 } })
    );
    expect(result.pass).toBe(false);
    expect(result.diffs.some((d) => d.path === "occurrenceActionCounts.CREATED")).toBe(true);
    expect(result.diffs.some((d) => d.path === "occurrenceActionCounts.PERSISTED")).toBe(true);
  });
});

describe("phase1Comparator — Finding projection mismatches", () => {
  it("fails on a wrong Finding projection field", () => {
    const result = compareScenario(
      baseExpected(),
      baseActual({
        findings: [
          {
            identity: "FINDING_A",
            status: "OPEN",
            firstSeen: new Date("2026-01-01T00:00:00.000Z"),
            lastSeen: new Date("2026-01-01T00:00:00.000Z"),
            occurrenceCount: 99,
            recurrenceCount: 0,
            closedThroughObservedAt: null,
          },
        ],
      })
    );
    expect(result.pass).toBe(false);
    expect(result.diffs.some((d) => d.path === "findings[FINDING_A].occurrenceCount")).toBe(true);
  });

  it("fails on a timestamp mismatch even when both are otherwise Date-shaped", () => {
    const result = compareScenario(
      baseExpected(),
      baseActual({
        findings: [
          {
            identity: "FINDING_A",
            status: "OPEN",
            firstSeen: new Date("2026-01-01T00:00:00.000Z"),
            lastSeen: new Date("2026-01-01T00:00:01.000Z"), // one second later
            occurrenceCount: 1,
            recurrenceCount: 0,
            closedThroughObservedAt: null,
          },
        ],
      })
    );
    expect(result.pass).toBe(false);
    expect(result.diffs.some((d) => d.path === "findings[FINDING_A].lastSeen")).toBe(true);
  });

  it("fails when an expected Finding is missing from actual", () => {
    const result = compareScenario(baseExpected(), baseActual({ findings: [] }));
    expect(result.pass).toBe(false);
    expect(result.diffs.some((d) => d.path === "findings[FINDING_A]")).toBe(true);
  });

  it("fails when actual has an extra Finding beyond what's expected (length mismatch)", () => {
    const result = compareScenario(
      baseExpected(),
      baseActual({
        findings: [
          ...baseActual().findings,
          {
            identity: "FINDING_B",
            status: "OPEN",
            firstSeen: new Date("2026-01-01T00:00:00.000Z"),
            lastSeen: new Date("2026-01-01T00:00:00.000Z"),
            occurrenceCount: 1,
            recurrenceCount: 0,
            closedThroughObservedAt: null,
          },
        ],
      })
    );
    expect(result.pass).toBe(false);
    expect(result.diffs.some((d) => d.path === "findings.length")).toBe(true);
  });
});

describe("phase1Comparator — row-to-occurrence relation mismatches", () => {
  it("fails when a row links to the wrong Finding identity", () => {
    const result = compareScenario(
      baseExpected(),
      baseActual({
        rows: [
          { rowNumber: 1, status: "VALID", duplicateInReport: false, findingIdentity: "FINDING_B", errorCodes: [] },
        ],
      })
    );
    expect(result.pass).toBe(false);
    expect(result.diffs.some((d) => d.path === "rows[rowNumber=1].findingIdentity")).toBe(true);
  });

  it("fails when a row's duplicateInReport flag is wrong", () => {
    const result = compareScenario(
      baseExpected(),
      baseActual({
        rows: [
          { rowNumber: 1, status: "VALID", duplicateInReport: true, findingIdentity: "FINDING_A", errorCodes: [] },
        ],
      })
    );
    expect(result.pass).toBe(false);
    expect(result.diffs.some((d) => d.path === "rows[rowNumber=1].duplicateInReport")).toBe(true);
  });
});

describe("phase1Comparator — canonical sorting", () => {
  it("passes for equivalent results supplied in a different order (rows and findings)", () => {
    const expected = baseExpected({
      rows: [
        { rowNumber: 1, status: "VALID", duplicateInReport: false, findingIdentity: "FINDING_A", errorCodes: [] },
        { rowNumber: 2, status: "VALID", duplicateInReport: false, findingIdentity: "FINDING_B", errorCodes: [] },
      ],
      findings: [
        {
          identity: "FINDING_A",
          status: "OPEN",
          firstSeen: "2026-01-01T00:00:00.000Z",
          lastSeen: "2026-01-01T00:00:00.000Z",
          occurrenceCount: 1,
          recurrenceCount: 0,
          closedThroughObservedAt: null,
        },
        {
          identity: "FINDING_B",
          status: "OPEN",
          firstSeen: "2026-01-02T00:00:00.000Z",
          lastSeen: "2026-01-02T00:00:00.000Z",
          occurrenceCount: 1,
          recurrenceCount: 0,
          closedThroughObservedAt: null,
        },
      ],
    });
    // Actual returns the same data in reverse/unsorted order — the database
    // gives no ordering guarantee, and the comparator must not depend on one.
    const actual = baseActual({
      rows: [
        { rowNumber: 2, status: "VALID", duplicateInReport: false, findingIdentity: "FINDING_B", errorCodes: [] },
        { rowNumber: 1, status: "VALID", duplicateInReport: false, findingIdentity: "FINDING_A", errorCodes: [] },
      ],
      findings: [
        {
          identity: "FINDING_B",
          status: "OPEN",
          firstSeen: new Date("2026-01-02T00:00:00.000Z"),
          lastSeen: new Date("2026-01-02T00:00:00.000Z"),
          occurrenceCount: 1,
          recurrenceCount: 0,
          closedThroughObservedAt: null,
        },
        {
          identity: "FINDING_A",
          status: "OPEN",
          firstSeen: new Date("2026-01-01T00:00:00.000Z"),
          lastSeen: new Date("2026-01-01T00:00:00.000Z"),
          occurrenceCount: 1,
          recurrenceCount: 0,
          closedThroughObservedAt: null,
        },
      ],
    });

    const result = compareScenario(expected, actual);
    expect(result.pass).toBe(true);
  });
});

describe("phase1Comparator — cross-scenario checks", () => {
  it("fails a reportIdMatchesScenario check when the ids differ", () => {
    const expected = baseExpected({ reportIdMatchesScenario: "01_baseline" });
    const actual = baseActual({ rawReportId: 5 });
    const result = compareScenario(expected, actual, { reportIdsByScenario: { "01_baseline": 1 } });
    expect(result.pass).toBe(false);
    expect(result.diffs.some((d) => d.path === "reportIdMatchesScenario")).toBe(true);
  });

  it("fails an occurrencesUnchangedSinceScenario check when an occurrence row differs after replay", () => {
    const expected = baseExpected({ occurrencesUnchangedSinceScenario: "01_baseline" });
    const before = [{ id: 1, findingId: 1, rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z"), action: "CREATED", createdAt: new Date("2026-01-01T00:00:00Z") }];
    const after = [{ id: 1, findingId: 1, rawReportId: 1, observedAt: new Date("2026-01-01T00:00:01Z"), action: "CREATED", createdAt: new Date("2026-01-01T00:00:00Z") }];
    const actual = baseActual({ occurrenceSnapshotBefore: before, occurrenceSnapshotAfter: after });
    const result = compareScenario(expected, actual);
    expect(result.pass).toBe(false);
    expect(result.diffs.some((d) => d.path.includes("observedAt"))).toBe(true);
  });

  it("passes an occurrencesUnchangedSinceScenario check when nothing changed", () => {
    const expected = baseExpected({ occurrencesUnchangedSinceScenario: "01_baseline" });
    const snapshot = [{ id: 1, findingId: 1, rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z"), action: "CREATED", createdAt: new Date("2026-01-01T00:00:00Z") }];
    const actual = baseActual({ occurrenceSnapshotBefore: snapshot, occurrenceSnapshotAfter: snapshot });
    const result = compareScenario(expected, actual);
    expect(result.pass).toBe(true);
  });
});

describe("phase1Comparator — readable diff output", () => {
  it("produces a safe, readable diff string with expected/actual values", () => {
    const result = compareScenario(baseExpected(), baseActual({ findingCountDelta: 2 }));
    const text = formatDiffs("some-scenario", result.diffs);
    expect(text).toContain("some-scenario");
    expect(text).toContain("findingCountDelta");
    expect(text).toContain("expected:");
    expect(text).toContain("actual:");
  });
});
