"use strict";

// Demonstration-only readiness preflight (docs/demo/DEMO-READINESS.md).
//
// Answers ONE question, before an operator walks into the room: "is this
// environment safe, correctly bounded, and genuinely UNTOUCHED for the exact
// live demonstration that is about to be given?"
//
// This script:
//   - makes NO provider call (no provider/adapter/execution-service module is
//     required anywhere below — see the no-network-contact unit test);
//   - creates NO job, reserves NO quota, writes NO row;
//   - enables NOTHING and mutates NO configuration;
//   - never reads, prints, or compares a credential VALUE — only the boolean
//     "configured" fact via the existing isProviderCredentialConfigured seam.
//
// It composes the canonical resolvers the execution path itself uses
// (isProviderCredentialConfigured, resolveProviderReadiness,
// resolveOrchestrationConfig) and the canonical freshness query
// (repository.findFreshJobForSubject) rather than re-implementing any decision
// those modules already make. A preflight that answers "is a fresh result in
// the way?" with its own second definition of freshness would be capable of
// passing while the product skips — which is precisely the failure it exists
// to prevent.
//
// EXECUTION BINDING: like `preflight:canary`, this MUST run inside the same
// process/container that serves the demonstration, e.g.
// `docker compose exec backend node src/scripts/demoPreflight.js`. It reads
// `../config/env` — the same frozen, once-resolved config object the server
// and every execution-path module import — so a preflight run from a different
// shell validates a DIFFERENT environment and proves nothing.
//
// Never wired into CI, `npm test`, or any automatic path.

const {
  resolveOrchestrationConfig,
  isProviderCredentialConfigured,
} = require("../services/enrichmentOrchestration/enrichmentOrchestrationConfig");
const {
  resolveProviderReadiness,
  PROVIDER_READINESS,
} = require("../services/enrichmentOrchestration/enrichmentProviderReadiness");
const {
  KNOWN_PROVIDERS,
  SUBJECT_TYPES,
  subjectTypeForProvider,
} = require("../services/enrichmentOrchestration/enrichmentSubject");
const { QUOTA_LANES } = require("../services/enrichmentOrchestration/enrichmentDecisionCodes");
const repository = require("../services/enrichmentOrchestration/enrichmentOrchestrationRepository");

// Same disposable-marker convention as demoReset.js and the Phase-10C4 canary
// preflight. One convention, three call sites.
const DATABASE_NAME_DEMO_MARKER = "demo";

// The demonstration provider set. Deliberately small: every enabled provider is
// real third-party quota an audience question can spend.
const DEFAULT_DEMO_PROVIDERS = Object.freeze(["censys", "netlas", "greynoise"]);

// A MANUAL budget must be EXPLICIT and SMALL for a demonstration. `null` means
// unlimited (enrichmentOrchestrationConfig.js DEFAULT_MANUAL_DAILY_BUDGET), so
// a blank variable is a hard failure here, never a default.
const MAX_DEMO_MANUAL_BUDGET = 5;

// Phase-8D live-smoke opt-ins. Any non-blank value is a failure — a stray
// truthy value is exactly the kind of mistake this gate exists to catch.
const LIVE_SMOKE_OPT_IN_VARS = Object.freeze([
  "LIVE_GREYNOISE_SMOKE",
  "LIVE_CENSYS_SMOKE",
  "LIVE_SHODAN_SMOKE",
  "LIVE_NETLAS_SMOKE",
  "LIVE_NVD_SMOKE",
]);

// The LEGACY synchronous provider routes audit under `<provider>.lookup.*`
// (e.g. censysExecutionService.js's "censys.lookup.attempted"). The Phase-10
// orchestration path audits under `enrichment.lookup.*` instead. So a non-zero
// count of the former is the one positive signal that an off-ledger, unmetered
// legacy contact happened — a provider-table row count is NOT, because the
// orchestration path writes those same tables too.
const LEGACY_LOOKUP_AUDIT_PREFIXES = Object.freeze([
  "abuseipdb.lookup.",
  "censys.lookup.",
  "greynoise.lookup.",
  "netlas.lookup.",
  "shodan.lookup.",
]);

function assertionResult(id, description, pass, detail) {
  return Object.freeze({ id, description, pass: pass === true, detail: detail || null });
}

function isBlank(rawValue) {
  return rawValue === undefined || rawValue === null || String(rawValue).trim() === "";
}

/**
 * The database name segment of a Postgres connection string, or null. Only the
 * NAME is inspected; credentials embedded in the URL are never returned.
 */
function extractDatabaseName(databaseUrl) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") return null;
  try {
    const parsed = new URL(databaseUrl);
    const name = (parsed.pathname || "").replace(/^\//, "");
    return name === "" ? null : name;
  } catch (err) {
    return null;
  }
}

/**
 * Parses the operator-supplied demo Finding ids.
 *
 * @returns {number[]} may be empty; the caller turns that into a failure.
 */
function parseDemoFindingIds(rawValue) {
  if (isBlank(rawValue)) return [];
  return String(rawValue)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function parseDemoProviders(rawValue) {
  if (isBlank(rawValue)) return [...DEFAULT_DEMO_PROVIDERS];
  return String(rawValue)
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
}

/**
 * Gathers the read-only facts the assertions need. Issues COUNT/SELECT queries
 * only — no create, update, delete, or upsert anywhere in this module.
 *
 * Freshness is read through the CANONICAL repository query the run service
 * itself calls, for every (demo provider x demo Finding subject) pair.
 *
 * @param {object} prisma a PrismaClient (or a test double)
 * @param {{findingIds: number[], demoProviders: string[], now?: Date}} options
 * @returns {Promise<object>} frozen
 */
async function gatherDemoDbFacts(prisma, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const findingIds = Array.isArray(options.findingIds) ? options.findingIds : [];
  const demoProviders = Array.isArray(options.demoProviders) ? options.demoProviders : [];

  const findings = await prisma.finding.findMany({
    where: { id: { in: findingIds } },
    select: { id: true, indicatorValue: true, port: true, protocol: true, reportType: true },
    orderBy: { id: "asc" },
  });

  // Any run at all on a demo Finding means the demonstration has been
  // rehearsed on this database. Freshness alone is not enough: a run whose
  // freshUntil has already lapsed still leaves the Finding Detail screen
  // showing prior history the "first click" story claims does not exist.
  const enrichmentRunCount = await prisma.findingEnrichmentRun.count({
    where: { findingId: { in: findingIds } },
  });

  const freshConflicts = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const finding of findings) {
    // eslint-disable-next-line no-restricted-syntax
    for (const provider of demoProviders) {
      if (subjectTypeForProvider(provider) !== SUBJECT_TYPES.IPV4) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const fresh = await repository.findFreshJobForSubject(prisma, {
        provider,
        subjectType: SUBJECT_TYPES.IPV4,
        subjectValue: finding.indicatorValue,
        asOf: now,
      });
      if (fresh) {
        freshConflicts.push({ findingId: finding.id, provider, jobId: fresh.id });
      }
    }
  }

  const legacyLookupAuditCount = await prisma.auditLog.count({
    where: { OR: LEGACY_LOOKUP_AUDIT_PREFIXES.map((prefix) => ({ action: { startsWith: prefix } })) },
  });

  const reservedToday = new Map();
  const usageRows = await prisma.providerDailyUsage.findMany({
    where: { lane: QUOTA_LANES.MANUAL },
    select: { provider: true, reservedCount: true, usageDate: true },
  });
  const todayKey = now.toISOString().slice(0, 10);
  usageRows
    .filter((row) => row.usageDate.toISOString().slice(0, 10) === todayKey)
    .forEach((row) => reservedToday.set(row.provider, row.reservedCount));

  const appliedMigrations = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS applied FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
  );
  const unfinishedMigrations = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS unfinished FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL'
  );

  return Object.freeze({
    now,
    findings: Object.freeze(findings),
    enrichmentRunCount,
    freshConflicts: Object.freeze(freshConflicts),
    legacyLookupAuditCount,
    reservedToday,
    appliedMigrationCount: appliedMigrations?.[0]?.applied ?? 0,
    unfinishedMigrationCount: unfinishedMigrations?.[0]?.unfinished ?? 0,
  });
}

/**
 * Evaluates every demo-readiness assertion.
 *
 * Pure: takes the environment and the gathered database facts as arguments
 * rather than reading either itself, so every test injects them explicitly.
 *
 * @param {{env: object, dbFacts: object, expectedMigrationCount?: number|null}} options
 * @returns {{ready: boolean, assertions: object[]}} frozen
 */
function evaluateDemoPreflight(options = {}) {
  const env = options.env || {};
  const dbFacts = options.dbFacts || {};
  const expectedMigrationCount =
    Number.isInteger(options.expectedMigrationCount) ? options.expectedMigrationCount : null;

  const assertions = [];
  const add = (...args) => assertions.push(assertionResult(...args));

  const config = resolveOrchestrationConfig(env);
  const demoProviders = parseDemoProviders(env.DEMO_PROVIDERS);
  const findingIds = parseDemoFindingIds(env.DEMO_FINDING_IDS);
  const expectWorkerEnabled = String(env.DEMO_EXPECT_WORKER || "true").trim().toLowerCase() === "true";

  // --- BASE / STACK -------------------------------------------------------
  const databaseName = extractDatabaseName(env.DATABASE_URL);
  add(
    "B1",
    "DATABASE_URL names a disposable demo database",
    databaseName !== null && databaseName.toLowerCase().includes(DATABASE_NAME_DEMO_MARKER),
    databaseName === null ? "DATABASE_URL unparseable" : `database=${JSON.stringify(databaseName)}`
  );
  add(
    "B2",
    "No unfinished or rolled-back migrations",
    dbFacts.unfinishedMigrationCount === 0,
    `unfinished=${dbFacts.unfinishedMigrationCount}`
  );
  add(
    "B3",
    "Every migration in the repository is applied",
    expectedMigrationCount === null || dbFacts.appliedMigrationCount === expectedMigrationCount,
    `applied=${dbFacts.appliedMigrationCount}, expected=${expectedMigrationCount ?? "unknown"}`
  );
  add(
    "B4",
    "Exactly the declared demo Findings exist (one primary + at least two backups)",
    findingIds.length >= 3 && (dbFacts.findings || []).length === findingIds.length,
    `declared=[${findingIds.join(",")}], found=[${(dbFacts.findings || []).map((f) => f.id).join(",")}]`
  );

  // --- DEMO STATE (hard gates) -------------------------------------------
  add(
    "D1",
    "No enrichment run of ANY kind exists on the demo Findings",
    dbFacts.enrichmentRunCount === 0,
    `FindingEnrichmentRun rows on demo Findings=${dbFacts.enrichmentRunCount}`
  );
  const freshConflicts = dbFacts.freshConflicts || [];
  add(
    "D2",
    "No fresh provider result exists for any demo Finding x demo provider (first click cannot be skipped)",
    freshConflicts.length === 0,
    freshConflicts.length === 0
      ? "no fresh job for any demo subject"
      : freshConflicts
          .map((c) => `finding ${c.findingId}/${c.provider} blocked by job ${c.jobId}`)
          .join("; ")
  );

  // --- SAFETY -------------------------------------------------------------
  add(
    "S1",
    "AUTO_ENRICHMENT_ENABLED is off",
    config.AUTO_ENRICHMENT_ENABLED === false,
    `AUTO_ENRICHMENT_ENABLED=${config.AUTO_ENRICHMENT_ENABLED}`
  );
  const nonZeroAutomatic = KNOWN_PROVIDERS.filter((p) => config.automaticDailyBudgets[p] !== 0);
  add(
    "S2",
    "Every AUTOMATIC daily budget is exactly 0",
    nonZeroAutomatic.length === 0,
    nonZeroAutomatic.length === 0
      ? "all automatic budgets 0"
      : nonZeroAutomatic.map((p) => `${p}=${config.automaticDailyBudgets[p]}`).join(", ")
  );
  add(
    "S3",
    `ENRICHMENT_WORKER_ENABLED matches the intended demo state (${expectWorkerEnabled})`,
    config.ENRICHMENT_WORKER_ENABLED === expectWorkerEnabled,
    `ENRICHMENT_WORKER_ENABLED=${config.ENRICHMENT_WORKER_ENABLED}, expected=${expectWorkerEnabled}`
  );
  const badManual = KNOWN_PROVIDERS.filter((provider) => {
    const budget = config.manualDailyBudgets[provider];
    if (demoProviders.includes(provider)) {
      // Explicit, positive, small. `null` (unlimited) is a failure, not a pass.
      return !(Number.isInteger(budget) && budget >= 1 && budget <= MAX_DEMO_MANUAL_BUDGET);
    }
    // Every provider NOT in the demo set must be pinned to 0, never left blank.
    return budget !== 0;
  });
  add(
    "S4",
    `MANUAL budgets are explicit: demo providers 1..${MAX_DEMO_MANUAL_BUDGET}, every other provider 0 (blank means UNLIMITED)`,
    badManual.length === 0,
    badManual.length === 0
      ? demoProviders.map((p) => `${p}=${config.manualDailyBudgets[p]}`).join(", ")
      : badManual
          .map((p) => `${p}=${JSON.stringify(config.manualDailyBudgets[p])}`)
          .join(", ")
  );
  add(
    "S5",
    "The legacy unmetered provider path is inert (zero <provider>.lookup.* audit rows)",
    dbFacts.legacyLookupAuditCount === 0,
    `legacy lookup audit rows=${dbFacts.legacyLookupAuditCount}`
  );
  const armedSmokeVars = LIVE_SMOKE_OPT_IN_VARS.filter((name) => !isBlank(env[name]));
  add(
    "S6",
    "No Phase-8D live-smoke opt-in is armed",
    armedSmokeVars.length === 0,
    armedSmokeVars.length === 0 ? "all unset" : `armed: ${armedSmokeVars.join(", ")}`
  );

  // S5 detects a legacy contact that ALREADY happened. This one keeps the
  // legacy path inert going FORWARD.
  //
  // Report ingestion unconditionally enqueues a PENDING `abuseipdb`
  // IocEnrichment row per indicator (reportIngestionService.js's
  // scheduleEnrichmentSafely), independently of AUTO_ENRICHMENT_ENABLED. No
  // background worker drains that legacy queue, but an ADMIN-triggered
  // enrichment batch or the delegated orchestration lane would, and the legacy
  // synchronous per-provider routes (`POST /api/findings/:id/enrichment/
  // <provider>`) call provider.lookup() directly with no job, no reservation
  // and no attempt row — they never consult ENRICHMENT_WORKER_ENABLED and go
  // live the moment a credential exists.
  //
  // So for a provider deliberately EXCLUDED from the demonstration, an absent
  // credential is what actually makes every one of those paths incapable of
  // contact. A zero budget alone does not: it bounds the orchestration lane
  // only.
  const excludedProviders = KNOWN_PROVIDERS.filter(
    (p) => !demoProviders.includes(p) && p !== "nvd"
  );
  const credentialedExclusions = excludedProviders.filter((p) =>
    isProviderCredentialConfigured(p, env)
  );
  add(
    "S7",
    "Every provider EXCLUDED from the demo has no credential, so the legacy unmetered path cannot contact it",
    credentialedExclusions.length === 0,
    credentialedExclusions.length === 0
      ? `excluded and uncredentialed: ${excludedProviders.join(", ")}`
      : `still credentialed: ${credentialedExclusions.join(", ")}`
  );

  // --- PROVIDER CONFIGURATION --------------------------------------------
  const unknownProviders = demoProviders.filter((p) => !KNOWN_PROVIDERS.includes(p));
  add(
    "P1",
    "Every declared demo provider is a supported provider",
    unknownProviders.length === 0,
    unknownProviders.length === 0
      ? `demo providers: ${demoProviders.join(", ")}`
      : `unknown: ${unknownProviders.join(", ")}`
  );

  // nvd's credential check is unconditionally true (it works keyless at a lower
  // public rate limit), so asserting on it would be vacuous. Excluded on
  // purpose rather than silently passing.
  const credentialProviders = demoProviders.filter(
    (p) => KNOWN_PROVIDERS.includes(p) && p !== "nvd"
  );
  const missingCredentials = credentialProviders.filter(
    (p) => isProviderCredentialConfigured(p, env) !== true
  );
  add(
    "P2",
    "Every credentialed demo provider has its credential variable present (presence only — NOT proof the credential is externally valid)",
    missingCredentials.length === 0,
    missingCredentials.length === 0
      ? `configured: ${credentialProviders.join(", ")}`
      : `missing: ${missingCredentials.join(", ")}`
  );

  const notReady = [];
  credentialProviders.forEach((provider) => {
    // resolveProviderReadiness returns one plain PROVIDER_READINESS string.
    // Note EXECUTION_PAUSED (worker off) is evaluated BEFORE any budget state,
    // so it masks BUDGET_ZERO/BUDGET_EXHAUSTED — which is why S4 checks the
    // budgets directly rather than inferring them from readiness.
    let status;
    try {
      status = resolveProviderReadiness({
        provider,
        lane: QUOTA_LANES.MANUAL,
        credentialConfigured: isProviderCredentialConfigured(provider, env),
        workerEnabled: config.ENRICHMENT_WORKER_ENABLED,
        automaticIngestionEnabled: config.AUTO_ENRICHMENT_ENABLED,
        dailyBudget: config.manualDailyBudgets[provider],
        reservedToday: (dbFacts.reservedToday && dbFacts.reservedToday.get(provider)) || 0,
      });
    } catch (err) {
      status = `ERROR:${err.message}`;
    }
    if (status !== PROVIDER_READINESS.READY) notReady.push(`${provider}=${status}`);
  });
  add(
    "P3",
    "Every credentialed demo provider resolves to READY on the MANUAL lane",
    notReady.length === 0,
    notReady.length === 0 ? "all READY" : notReady.join(", ")
  );

  return Object.freeze({
    ready: assertions.every((a) => a.pass),
    assertions: Object.freeze(assertions),
  });
}

function printReport(result) {
  process.stdout.write("\nThreatNeXus — demonstration readiness preflight\n");
  process.stdout.write("(non-contact: no provider was called to produce this report)\n\n");
  result.assertions.forEach((a) => {
    process.stdout.write(`  ${a.pass ? "PASS" : "FAIL"}  ${a.id}  ${a.description}\n`);
    if (a.detail) process.stdout.write(`              ${a.detail}\n`);
  });
  const passed = result.assertions.filter((a) => a.pass).length;
  process.stdout.write(`\n  ${passed}/${result.assertions.length} assertions passed\n`);
  process.stdout.write(`\n${result.ready ? "DEMO READY" : "DEMO NOT READY"}\n\n`);
}

async function main() {
  // eslint-disable-next-line global-require
  const { PrismaClient } = require("@prisma/client");
  // eslint-disable-next-line global-require
  const fs = require("node:fs");
  // eslint-disable-next-line global-require
  const path = require("node:path");

  let expectedMigrationCount = null;
  try {
    const migrationsDir = path.resolve(__dirname, "..", "..", "prisma", "migrations");
    expectedMigrationCount = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length;
  } catch (err) {
    expectedMigrationCount = null;
  }

  const prisma = new PrismaClient();
  try {
    const dbFacts = await gatherDemoDbFacts(prisma, {
      findingIds: parseDemoFindingIds(process.env.DEMO_FINDING_IDS),
      demoProviders: parseDemoProviders(process.env.DEMO_PROVIDERS),
    });
    const result = evaluateDemoPreflight({
      env: process.env,
      dbFacts,
      expectedMigrationCount,
    });
    printReport(result);
    process.exitCode = result.ready ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`\ndemo:preflight failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DATABASE_NAME_DEMO_MARKER,
  DEFAULT_DEMO_PROVIDERS,
  MAX_DEMO_MANUAL_BUDGET,
  LIVE_SMOKE_OPT_IN_VARS,
  LEGACY_LOOKUP_AUDIT_PREFIXES,
  extractDatabaseName,
  parseDemoFindingIds,
  parseDemoProviders,
  gatherDemoDbFacts,
  evaluateDemoPreflight,
  printReport,
};
