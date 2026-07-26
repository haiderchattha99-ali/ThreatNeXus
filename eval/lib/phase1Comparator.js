"use strict";

// Deterministic, order-stable comparison of one scenario's actual database
// results against its ground-truth expectation. Pure: no Prisma access, no
// I/O. Every array comparison sorts both sides by an explicit canonical key
// first (never relies on whatever order the evaluator's queries happened to
// return), so re-running the same scenario twice always produces the same
// comparison result regardless of default database row order.

function diff(path, expected, actual) {
  return { path, expected, actual };
}

function toComparableDate(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

// undefined return means "not a valid date" — the caller treats that as a
// mismatch rather than two nulls silently comparing equal to two invalids.
function datesEqual(expected, actual) {
  const expectedMs = toComparableDate(expected);
  const actualMs = toComparableDate(actual);
  if (expectedMs === null || actualMs === null) return expectedMs === actualMs;
  if (expectedMs === undefined || actualMs === undefined) return false;
  return expectedMs === actualMs;
}

function sortByKey(items, keyFn) {
  return [...items].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
}

function compareScalar(diffs, path, expected, actual) {
  if (expected === undefined) return; // not asserted by this scenario
  if (expected !== actual) diffs.push(diff(path, expected, actual));
}

function compareOccurrenceActionCounts(diffs, pathPrefix, expected, actual) {
  const safeActual = actual || { CREATED: 0, PERSISTED: 0, HISTORICAL: 0, RECURRED: 0 };
  ["CREATED", "PERSISTED", "HISTORICAL", "RECURRED"].forEach((action) => {
    compareScalar(diffs, `${pathPrefix}.${action}`, expected[action], safeActual[action]);
  });
}

function compareRows(diffs, pathPrefix, expectedRows, actualRows) {
  if (!expectedRows || expectedRows.length === 0) return;
  const actual = actualRows || [];

  compareScalar(diffs, `${pathPrefix}.length`, expectedRows.length, actual.length);

  const expectedSorted = sortByKey(expectedRows, (r) => r.rowNumber);
  const actualSorted = sortByKey(actual, (r) => r.rowNumber);

  expectedSorted.forEach((expectedRow) => {
    const actualRow = actualSorted.find((r) => r.rowNumber === expectedRow.rowNumber);
    const rowPath = `${pathPrefix}[rowNumber=${expectedRow.rowNumber}]`;
    if (!actualRow) {
      diffs.push(diff(rowPath, "row present", "row missing"));
      return;
    }
    compareScalar(diffs, `${rowPath}.status`, expectedRow.status, actualRow.status);
    compareScalar(diffs, `${rowPath}.duplicateInReport`, expectedRow.duplicateInReport, actualRow.duplicateInReport);
    compareScalar(diffs, `${rowPath}.findingIdentity`, expectedRow.findingIdentity, actualRow.findingIdentity);

    const expectedCodes = [...(expectedRow.errorCodes || [])].sort();
    const actualCodes = [...(actualRow.errorCodes || [])].sort();
    if (JSON.stringify(expectedCodes) !== JSON.stringify(actualCodes)) {
      diffs.push(diff(`${rowPath}.errorCodes`, expectedCodes, actualCodes));
    }
  });
}

function compareFindings(diffs, pathPrefix, expectedFindings, actualFindings) {
  if (!expectedFindings || expectedFindings.length === 0) return;
  const actual = actualFindings || [];

  compareScalar(diffs, `${pathPrefix}.length`, expectedFindings.length, actual.length);

  const expectedSorted = sortByKey(expectedFindings, (f) => f.identity);
  const actualSorted = sortByKey(actual, (f) => f.identity);

  expectedSorted.forEach((expectedFinding) => {
    const actualFinding = actualSorted.find((f) => f.identity === expectedFinding.identity);
    const findingPath = `${pathPrefix}[${expectedFinding.identity}]`;
    if (!actualFinding) {
      diffs.push(diff(findingPath, "finding present", "finding missing"));
      return;
    }
    compareScalar(diffs, `${findingPath}.status`, expectedFinding.status, actualFinding.status);
    compareScalar(diffs, `${findingPath}.occurrenceCount`, expectedFinding.occurrenceCount, actualFinding.occurrenceCount);
    compareScalar(diffs, `${findingPath}.recurrenceCount`, expectedFinding.recurrenceCount, actualFinding.recurrenceCount);

    if (!datesEqual(expectedFinding.firstSeen, actualFinding.firstSeen)) {
      diffs.push(diff(`${findingPath}.firstSeen`, expectedFinding.firstSeen, actualFinding.firstSeen));
    }
    if (!datesEqual(expectedFinding.lastSeen, actualFinding.lastSeen)) {
      diffs.push(diff(`${findingPath}.lastSeen`, expectedFinding.lastSeen, actualFinding.lastSeen));
    }
    if (expectedFinding.closedThroughObservedAt !== undefined) {
      if (!datesEqual(expectedFinding.closedThroughObservedAt, actualFinding.closedThroughObservedAt)) {
        diffs.push(
          diff(
            `${findingPath}.closedThroughObservedAt`,
            expectedFinding.closedThroughObservedAt,
            actualFinding.closedThroughObservedAt
          )
        );
      }
    }
  });
}

function compareAuditActionCounts(diffs, pathPrefix, expected, actual) {
  if (!expected) return;
  const safeActual = actual || {};
  Object.entries(expected).forEach(([action, count]) => {
    compareScalar(diffs, `${pathPrefix}.${action}`, count, safeActual[action] || 0);
  });
}

// occurrenceSnapshotBefore/After: arrays of {id, findingId, rawReportId,
// observedAt, action, createdAt}, taken by the evaluator immediately after
// the referenced scenario and immediately after the current one. An exact,
// order-independent match (by occurrence id) is the proof that replaying an
// already-processed report never mutates existing FindingOccurrence rows.
function compareOccurrenceImmutability(diffs, pathPrefix, before, after) {
  const beforeList = before || [];
  const afterList = after || [];

  compareScalar(diffs, `${pathPrefix}.length`, beforeList.length, afterList.length);

  const beforeSorted = sortByKey(beforeList, (o) => o.id);
  const afterSorted = sortByKey(afterList, (o) => o.id);

  beforeSorted.forEach((beforeRow) => {
    const afterRow = afterSorted.find((o) => o.id === beforeRow.id);
    const rowPath = `${pathPrefix}[occurrenceId=${beforeRow.id}]`;
    if (!afterRow) {
      diffs.push(diff(rowPath, "occurrence still present", "occurrence missing after replay"));
      return;
    }
    compareScalar(diffs, `${rowPath}.findingId`, beforeRow.findingId, afterRow.findingId);
    compareScalar(diffs, `${rowPath}.rawReportId`, beforeRow.rawReportId, afterRow.rawReportId);
    compareScalar(diffs, `${rowPath}.action`, beforeRow.action, afterRow.action);
    if (!datesEqual(beforeRow.observedAt, afterRow.observedAt)) {
      diffs.push(diff(`${rowPath}.observedAt`, beforeRow.observedAt, afterRow.observedAt));
    }
    if (!datesEqual(beforeRow.createdAt, afterRow.createdAt)) {
      diffs.push(diff(`${rowPath}.createdAt`, beforeRow.createdAt, afterRow.createdAt));
    }
  });
}

/**
 * Compares one scenario's actual result against its ground-truth
 * expectation.
 *
 * @param {Object} expected - a validated scenario.expected block from
 *   groundTruthLoader.js.
 * @param {Object} actual - the evaluator's gathered actual result for the
 *   same scenario (see eval/run_phase1_gate.js for the exact shape).
 * @param {{reportIdsByScenario?: Object<string, number>}} [context]
 * @returns {{pass: boolean, diffs: Array<{path:string, expected:*, actual:*}>}}
 */
function compareScenario(expected, actual, context = {}) {
  const diffs = [];

  compareScalar(diffs, "outcome", expected.outcome, actual.outcome);
  compareScalar(diffs, "reportStatus", expected.reportStatus, actual.reportStatus);
  compareScalar(diffs, "totalRows", expected.totalRows, actual.totalRows);
  compareScalar(diffs, "validRows", expected.validRows, actual.validRows);
  compareScalar(diffs, "invalidRows", expected.invalidRows, actual.invalidRows);
  compareScalar(diffs, "reasonCode", expected.reasonCode, actual.reasonCode);

  compareScalar(diffs, "rawReportCountDelta", expected.rawReportCountDelta, actual.rawReportCountDelta);
  compareScalar(diffs, "rawReportRowCountDelta", expected.rawReportRowCountDelta, actual.rawReportRowCountDelta);
  compareScalar(diffs, "findingCountDelta", expected.findingCountDelta, actual.findingCountDelta);
  compareScalar(
    diffs,
    "findingOccurrenceCountDelta",
    expected.findingOccurrenceCountDelta,
    actual.findingOccurrenceCountDelta
  );

  compareOccurrenceActionCounts(
    diffs,
    "occurrenceActionCounts",
    expected.occurrenceActionCounts,
    actual.occurrenceActionCounts
  );

  compareRows(diffs, "rows", expected.rows, actual.rows);
  compareFindings(diffs, "findings", expected.findings, actual.findings);
  compareAuditActionCounts(diffs, "auditActionCounts", expected.auditActionCounts, actual.auditActionCounts);

  if (expected.reportIdMatchesScenario) {
    const referenceId = (context.reportIdsByScenario || {})[expected.reportIdMatchesScenario];
    compareScalar(diffs, "reportIdMatchesScenario", referenceId, actual.rawReportId);
  }

  if (expected.occurrencesUnchangedSinceScenario) {
    compareOccurrenceImmutability(
      diffs,
      "occurrencesUnchanged",
      actual.occurrenceSnapshotBefore,
      actual.occurrenceSnapshotAfter
    );
  }

  return { pass: diffs.length === 0, diffs };
}

function formatDiffs(scenarioId, diffs) {
  return diffs
    .map(
      (d) =>
        `  ${scenarioId} :: ${d.path}\n` +
        `    expected: ${JSON.stringify(d.expected)}\n` +
        `    actual:   ${JSON.stringify(d.actual)}`
    )
    .join("\n");
}

module.exports = {
  compareScenario,
  formatDiffs,
};
