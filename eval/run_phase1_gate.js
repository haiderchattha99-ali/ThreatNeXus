"use strict";

// Executable Phase 1 gate (P1-GATE). Ingests the synthetic
// data/synthetic/accessible-rdp/*.csv fixtures, in the declared order,
// through the REAL production ingestion service (reportIngestionService.js —
// the same code path the HTTP route uses), then compares the resulting
// database state against data/synthetic/ground_truth.yaml.
//
// Usage: EVAL_DATABASE_URL="postgresql://user:pw@localhost:5432/threatnexus_eval" \
//          npm run eval:phase1   (run from backend/, or `node eval/run_phase1_gate.js` from the repo root)
//
// Safety (see assertSafeEvalDatabaseUrl below): refuses to run without an
// explicit EVAL_DATABASE_URL, refuses to run if it equals DATABASE_URL, and
// never reads DATABASE_URL for its own connection — only for that one
// equality check.

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");
const GROUND_TRUTH_PATH = path.join(REPO_ROOT, "data", "synthetic", "ground_truth.yaml");

// A stable prefix on every sourceFileName this run creates, so cleanup can
// derive an exact evaluation-owned id set instead of guessing by IP prefix
// or a loose filename pattern (the same lesson recorded in STATUS.md for
// reportIngestionConcurrency.test.js).
const MARKER = "phase1-gate";

class GateSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "GateSafetyError";
  }
}

class GateStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "GateStateError";
  }
}

// Reads EVAL_DATABASE_URL/DATABASE_URL exactly once, before either is
// mutated by anything else in this process, so the "must not equal
// DATABASE_URL" check is meaningful. Never returns DATABASE_URL to the
// caller — only used here for the comparison.
function assertSafeEvalDatabaseUrl(env) {
  const evalDatabaseUrl = env.EVAL_DATABASE_URL;
  const originalDatabaseUrl = env.DATABASE_URL;

  if (!evalDatabaseUrl || evalDatabaseUrl.trim() === "") {
    throw new GateSafetyError(
      "EVAL_DATABASE_URL is required. Refusing to run without an explicit, dedicated evaluation database."
    );
  }
  if (originalDatabaseUrl && evalDatabaseUrl.trim() === originalDatabaseUrl.trim()) {
    throw new GateSafetyError(
      "EVAL_DATABASE_URL must not equal DATABASE_URL. Refusing to run against the development database."
    );
  }
  return evalDatabaseUrl;
}

// reportIngestionService.js requires config/env at load time, which
// validates NODE_ENV/DATABASE_URL/JWT_SECRET/CORS_ORIGIN unconditionally —
// even though this evaluator always passes an explicit {client} option and
// so never actually touches config/prisma.js (the DATABASE_URL-reading
// singleton). Placeholders are staged only for variables not already set, so
// a real shell value is never overwritten, and only AFTER the safety check
// above has already captured/compared the real DATABASE_URL.
function stageEnvPlaceholdersForConfigLoad(env) {
  env.NODE_ENV = env.NODE_ENV || "test";
  env.DATABASE_URL = env.DATABASE_URL || "postgresql://unused:unused@localhost:5432/unused";
  env.JWT_SECRET = env.JWT_SECRET || "a-reasonably-strong-32-char-plus-secret-value";
  env.CORS_ORIGIN = env.CORS_ORIGIN || "http://localhost:5173";
}

function requireBackend(relativePath) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(BACKEND_DIR, relativePath));
}

function buildIdentityIndex(findingIdentities) {
  const byKey = findingIdentities;
  const keyByTuple = new Map();
  Object.entries(findingIdentities).forEach(([key, identity]) => {
    keyByTuple.set(
      `${identity.indicatorValue}::${identity.port}::${identity.protocol}::${identity.reportType}`,
      key
    );
  });
  return {
    resolveKey(finding) {
      return (
        keyByTuple.get(
          `${finding.indicatorValue}::${finding.port}::${finding.protocol}::${finding.reportType}`
        ) || null
      );
    },
    allIndicatorValues() {
      return Object.values(byKey).map((identity) => identity.indicatorValue);
    },
  };
}

// Derives the exact evaluation-owned id set from this run's own evidence
// chain (RawReports whose sourceFileName carries MARKER, plus any Finding
// matching one of ground truth's declared synthetic identities) rather than
// a loose IP-prefix or filename-substring guess, so a repeat run always
// starts from a clean, exactly-scoped slate. Mirrors the pattern already
// used by backend/tests/integration/reportIngestionConcurrency.test.js.
async function cleanupEvalState(prisma, identityIndex) {
  const reports = await prisma.rawReport.findMany({
    where: { sourceFileName: { startsWith: MARKER } },
    select: { id: true },
  });
  const reportIds = reports.map((r) => r.id);

  const occurrences = await prisma.findingOccurrence.findMany({
    where: { rawReportId: { in: reportIds } },
    select: { findingId: true },
  });
  const findingsByIdentity = await prisma.finding.findMany({
    where: { indicatorValue: { in: identityIndex.allIndicatorValues() } },
    select: { id: true },
  });
  const findingIds = [
    ...new Set([...occurrences.map((o) => o.findingId), ...findingsByIdentity.map((f) => f.id)]),
  ];

  await prisma.findingOccurrence.deleteMany({ where: { rawReportId: { in: reportIds } } });
  await prisma.rawReportRow.deleteMany({ where: { rawReportId: { in: reportIds } } });
  // P2-T1: ingestAccessibleRdpReport now also resolves ownership for every
  // Finding it touches, and FindingOwnership.findingId is onDelete: Restrict
  // — a Finding can no longer be deleted while it has ownership history.
  // Additive, same scoped-id-set discipline as every other deleteMany here.
  await prisma.findingOwnership.deleteMany({ where: { findingId: { in: findingIds } } });
  // P2-T3: ingestion now also scores every Finding it touches. RiskScore
  // -> Finding and RiskFactorContribution -> RiskScore are both
  // onDelete: Restrict, so contributions must go before scores, and scores
  // before Findings. Same scoped-id-set discipline, never a broad prefix.
  const riskScores = await prisma.riskScore.findMany({
    where: { findingId: { in: findingIds } },
    select: { id: true },
  });
  const riskScoreIds = riskScores.map((r) => r.id);
  await prisma.riskFactorContribution.deleteMany({ where: { riskScoreId: { in: riskScoreIds } } });
  await prisma.riskScore.deleteMany({ where: { id: { in: riskScoreIds } } });
  await prisma.finding.deleteMany({ where: { id: { in: findingIds } } });
  await prisma.rawReport.deleteMany({ where: { id: { in: reportIds } } });
}

function assertFixturesExist(groundTruth, fixturesRoot) {
  groundTruth.scenarios.forEach((scenario) => {
    const fixturePath = path.join(fixturesRoot, scenario.fixtureFile);
    if (!fs.existsSync(fixturePath)) {
      throw new GateStateError(
        `scenario "${scenario.id}" references a missing fixture file: ${scenario.fixtureFile}`
      );
    }
  });
}

async function scopedCounts(prisma, identityIndex) {
  const [rawReportCount, rawReportRowCount, findingOccurrenceCount, findingCount] = await Promise.all([
    prisma.rawReport.count({ where: { sourceFileName: { startsWith: MARKER } } }),
    prisma.rawReportRow.count({ where: { rawReport: { sourceFileName: { startsWith: MARKER } } } }),
    prisma.findingOccurrence.count({ where: { rawReport: { sourceFileName: { startsWith: MARKER } } } }),
    prisma.finding.count({ where: { indicatorValue: { in: identityIndex.allIndicatorValues() } } }),
  ]);
  return { rawReportCount, rawReportRowCount, findingOccurrenceCount, findingCount };
}

async function auditMaxId(prisma) {
  const result = await prisma.auditLog.aggregate({ _max: { id: true } });
  return result._max.id || 0;
}

// A scenario that reuses an existing RawReport id (e.g. an identical
// re-upload or a retryable-report replay) must not have its predecessor's
// occurrences double-counted — only occurrences actually created during
// *this* scenario's own run count toward its occurrenceActionCounts.
async function occurrenceMaxId(prisma) {
  const result = await prisma.findingOccurrence.aggregate({ _max: { id: true } });
  return result._max.id || 0;
}

async function gatherRows(prisma, rawReportId, identityIndex) {
  if (!rawReportId) return [];
  const rows = await prisma.rawReportRow.findMany({
    where: { rawReportId },
    include: { findingOccurrence: { include: { finding: true } } },
    orderBy: { rowNumber: "asc" },
  });
  return rows.map((row) => ({
    rowNumber: row.rowNumber,
    status: row.status,
    duplicateInReport: row.duplicateInReport,
    findingIdentity: row.findingOccurrence ? identityIndex.resolveKey(row.findingOccurrence.finding) : null,
    errorCodes: Array.isArray(row.validationErrors) ? row.validationErrors.map((e) => e.code) : [],
  }));
}

async function gatherFindings(prisma, findingIdentities, keys) {
  const results = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const key of keys) {
    const identity = findingIdentities[key];
    // eslint-disable-next-line no-await-in-loop
    const finding = await prisma.finding.findUnique({
      where: {
        finding_identity: {
          indicatorValue: identity.indicatorValue,
          port: identity.port,
          protocol: identity.protocol,
          reportType: identity.reportType,
        },
      },
    });
    if (!finding) continue;
    results.push({
      identity: key,
      status: finding.status,
      firstSeen: finding.firstSeen,
      lastSeen: finding.lastSeen,
      occurrenceCount: finding.occurrenceCount,
      recurrenceCount: finding.recurrenceCount,
      closedThroughObservedAt: finding.closedThroughObservedAt,
    });
  }
  return results;
}

async function gatherOccurrenceActionCounts(prisma, rawReportId, sinceOccurrenceId) {
  const counts = { CREATED: 0, PERSISTED: 0, HISTORICAL: 0, RECURRED: 0 };
  if (!rawReportId) return counts;
  const occurrences = await prisma.findingOccurrence.findMany({
    where: { rawReportId, id: { gt: sinceOccurrenceId } },
  });
  occurrences.forEach((occ) => {
    counts[occ.action] = (counts[occ.action] || 0) + 1;
  });
  return counts;
}

async function gatherAuditActionCounts(prisma, sinceId) {
  const events = await prisma.auditLog.findMany({ where: { id: { gt: sinceId } } });
  const counts = {};
  events.forEach((event) => {
    counts[event.action] = (counts[event.action] || 0) + 1;
  });
  return counts;
}

async function snapshotOccurrences(prisma, rawReportId) {
  if (!rawReportId) return [];
  const occurrences = await prisma.findingOccurrence.findMany({ where: { rawReportId } });
  return occurrences.map((o) => ({
    id: o.id,
    findingId: o.findingId,
    rawReportId: o.rawReportId,
    observedAt: o.observedAt,
    action: o.action,
    createdAt: o.createdAt,
  }));
}

async function runPreStep(prisma, step, findingIdentities, applyEvalClosureFixture) {
  if (step.type === "evalClosureFixture") {
    const identity = findingIdentities[step.findingIdentity];
    await applyEvalClosureFixture(prisma, identity, {
      closedThroughObservedAt: step.closedThroughObservedAt,
      closureReason: step.closureReason,
    });
    return;
  }
  throw new GateStateError(`unknown preStep type: ${step.type}`);
}

/**
 * Core, testable gate runner: loads ground truth, verifies fixtures, cleans
 * evaluation-owned state, runs every scenario through the real ingestion
 * service, gathers actual database results, and compares them.
 *
 * @param {{groundTruthPath:string, fixturesRoot:string, prisma:object,
 *   log?:function}} options
 * @returns {Promise<{pass:boolean, scenarioResults:Array}>}
 */
async function runPhase1Gate({ groundTruthPath, fixturesRoot, prisma, log = () => {} }) {
  const { loadGroundTruth } = require("./lib/groundTruthLoader");
  const { compareScenario } = require("./lib/phase1Comparator");
  const { applyEvalClosureFixture } = require("./lib/evalClosureFixture");

  // Ground truth and fixture-existence are pure, env-independent checks —
  // deliberately resolved and verified before reportIngestionService.js is
  // even required, since that require needs config/env staged (see
  // stageEnvPlaceholdersForConfigLoad). A missing fixture or invalid ground
  // truth must fail on its own terms, never masked by an unrelated
  // ConfigError from a require that didn't need to happen yet.
  const groundTruth = loadGroundTruth(groundTruthPath);
  assertFixturesExist(groundTruth, fixturesRoot);

  const { ingestAccessibleRdpReport } = requireBackend("src/services/ingestion/reportIngestionService.js");

  const identityIndex = buildIdentityIndex(groundTruth.findingIdentities);
  await cleanupEvalState(prisma, identityIndex);

  const reportIdsByScenario = {};
  const occurrenceSnapshotsByScenario = {};
  const scenarioResults = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const scenario of groundTruth.scenarios) {
    // eslint-disable-next-line no-restricted-syntax
    for (const step of scenario.preSteps) {
      // eslint-disable-next-line no-await-in-loop
      await runPreStep(prisma, step, groundTruth.findingIdentities, applyEvalClosureFixture);
    }

    // Resolved against the explicit fixturesRoot, not the ground-truth
    // file's own directory — a tampered ground-truth copy loaded from a
    // temp directory (see the mandatory tampered-expectation test) must
    // still find the real, committed fixture bytes.
    const fixturePath = path.join(fixturesRoot, scenario.fixtureFile);
    const fileBytes = fs.readFileSync(fixturePath);

    // eslint-disable-next-line no-await-in-loop
    const before = await scopedCounts(prisma, identityIndex);
    // eslint-disable-next-line no-await-in-loop
    const auditSince = await auditMaxId(prisma);
    // eslint-disable-next-line no-await-in-loop
    const occurrenceSince = await occurrenceMaxId(prisma);

    let result;
    let ingestionError = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await ingestAccessibleRdpReport(
        {
          fileBytes,
          source: scenario.source,
          sourceFileName: `${MARKER}-${scenario.id}.csv`,
          contentType: "text/csv",
          ingestedByUserId: null,
        },
        { client: prisma }
      );
    } catch (error) {
      ingestionError = error;
      result = { outcome: "INGESTION_ERROR", report: null };
    }

    // eslint-disable-next-line no-await-in-loop
    const after = await scopedCounts(prisma, identityIndex);
    const rawReportId = result.report ? result.report.id : null;
    reportIdsByScenario[scenario.id] = rawReportId;

    const knownFindingKeys = (scenario.expected.findings || []).map((f) => f.identity);
    // eslint-disable-next-line no-await-in-loop
    const rows = await gatherRows(prisma, rawReportId, identityIndex);
    // eslint-disable-next-line no-await-in-loop
    const findings = await gatherFindings(prisma, groundTruth.findingIdentities, knownFindingKeys);
    // eslint-disable-next-line no-await-in-loop
    const occurrenceActionCounts = await gatherOccurrenceActionCounts(prisma, rawReportId, occurrenceSince);
    // eslint-disable-next-line no-await-in-loop
    const auditActionCounts = await gatherAuditActionCounts(prisma, auditSince);

    let occurrenceSnapshotBefore;
    let occurrenceSnapshotAfter;
    if (scenario.expected.occurrencesUnchangedSinceScenario) {
      const referenceScenarioId = scenario.expected.occurrencesUnchangedSinceScenario;
      occurrenceSnapshotBefore = occurrenceSnapshotsByScenario[referenceScenarioId] || [];
      const referenceReportId = reportIdsByScenario[referenceScenarioId];
      // eslint-disable-next-line no-await-in-loop
      occurrenceSnapshotAfter = await snapshotOccurrences(prisma, referenceReportId);
    }

    // eslint-disable-next-line no-await-in-loop
    occurrenceSnapshotsByScenario[scenario.id] = await snapshotOccurrences(prisma, rawReportId);

    const actual = {
      outcome: result.outcome,
      reportStatus: result.report ? result.report.status : null,
      totalRows: result.report ? result.report.totalRows : result.totalRows ?? null,
      validRows: result.report ? result.report.validRows : null,
      invalidRows: result.report ? result.report.invalidRows : result.invalidRowCount ?? null,
      reasonCode: result.reason || null,
      rawReportId,
      rawReportCountDelta: after.rawReportCount - before.rawReportCount,
      rawReportRowCountDelta: after.rawReportRowCount - before.rawReportRowCount,
      findingCountDelta: after.findingCount - before.findingCount,
      findingOccurrenceCountDelta: after.findingOccurrenceCount - before.findingOccurrenceCount,
      occurrenceActionCounts,
      rows,
      findings,
      auditActionCounts,
      occurrenceSnapshotBefore,
      occurrenceSnapshotAfter,
    };

    const comparison = compareScenario(scenario.expected, actual, { reportIdsByScenario });
    scenarioResults.push({
      id: scenario.id,
      pass: comparison.pass && !ingestionError,
      diffs: comparison.diffs,
      ingestionError: ingestionError ? { name: ingestionError.name, message: ingestionError.message } : null,
    });

    if (ingestionError) {
      log(`FAIL  ${scenario.id} (unexpected ingestion error: ${ingestionError.name})`);
    } else {
      log(`${comparison.pass ? "PASS" : "FAIL"}  ${scenario.id}`);
    }
  }

  const pass = scenarioResults.every((r) => r.pass);
  return { pass, scenarioResults };
}

async function main() {
  let evalDatabaseUrl;
  try {
    evalDatabaseUrl = assertSafeEvalDatabaseUrl(process.env);
  } catch (error) {
    console.error(`Phase 1 Gate — refusing to run: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  stageEnvPlaceholdersForConfigLoad(process.env);
  const { createPrismaClient } = requireBackend("src/config/prismaFactory.js");
  const prisma = createPrismaClient(evalDatabaseUrl);

  console.log("Phase 1 Gate");
  try {
    const { pass, scenarioResults } = await runPhase1Gate({
      groundTruthPath: GROUND_TRUTH_PATH,
      fixturesRoot: path.dirname(GROUND_TRUTH_PATH),
      prisma,
      log: (line) => console.log(line),
    });

    const failed = scenarioResults.filter((r) => !r.pass);
    if (failed.length > 0) {
      console.log("");
      failed.forEach((r) => {
        if (r.ingestionError) {
          console.log(`  ${r.id}: unexpected ingestion error — ${r.ingestionError.name}: ${r.ingestionError.message}`);
        }
        r.diffs.forEach((d) => {
          console.log(`  ${r.id} :: ${d.path}`);
          console.log(`    expected: ${JSON.stringify(d.expected)}`);
          console.log(`    actual:   ${JSON.stringify(d.actual)}`);
        });
      });
    }

    console.log("");
    console.log(pass ? "Final:\nPASS — expected and actual Phase 1 results match exactly" : "Final:\nFAIL — see mismatches above");
    process.exitCode = pass ? 0 : 1;
  } catch (error) {
    console.error(`Phase 1 Gate — errored: ${error.name || "Error"}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  GateSafetyError,
  GateStateError,
  assertSafeEvalDatabaseUrl,
  runPhase1Gate,
  MARKER,
};

if (require.main === module) {
  main();
}
