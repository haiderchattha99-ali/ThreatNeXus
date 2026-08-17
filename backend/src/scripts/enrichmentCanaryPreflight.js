"use strict";

// Phase 10C-4 — read-only canary preflight harness
// (docs/ai/PHASE-10C4-CONTROLLED-LIVE-ENRICHMENT-CONTRACT.md §12.2, P1-P17).
//
// Answers ONE question, before a human operator is permitted to authorize
// the single approved greynoise/1.1.1.1 canary (contract §13): "is this
// environment safe and correctly bounded for that exact run, right now?"
//
// This script:
//   - makes NO provider call (no provider/adapter/execution-service module
//     is required anywhere below — see the no-network-contact unit test);
//   - creates NO job, reserves NO quota, writes NO row;
//   - enables NOTHING and mutates NO configuration;
//   - never reads, prints, or compares a credential VALUE — only the boolean
//     "configured" fact via the existing isProviderCredentialConfigured seam.
//
// It composes the canonical resolvers already used by the execution path and
// by enrichmentUsageService (isProviderCredentialConfigured,
// resolveProviderReadiness) rather than re-implementing any decision those
// modules already make — contract §5/§12.2/§14.
//
// EXECUTION BINDING (contract §12.2, P0-level precondition): this script
// MUST be run inside the same process/container that will boot the worker,
// e.g. `docker compose run --rm backend node src/scripts/enrichmentCanaryPreflight.js`.
// It reads `../config/env` — the same frozen, once-resolved config object
// `backend/server.js` and every execution-path module import — so a preflight
// run from a different shell than the one that later starts the worker
// validates a DIFFERENT environment and proves nothing (contract §12.2).
//
// Never wired into CI, `npm test`, or any automatic path. A manual operator
// entry point, exactly like the Phase-8D `smoke:*` scripts.

const {
  isProviderCredentialConfigured,
} = require("../services/enrichmentOrchestration/enrichmentOrchestrationConfig");
const {
  resolveProviderReadiness,
  PROVIDER_READINESS,
} = require("../services/enrichmentOrchestration/enrichmentProviderReadiness");
const { KNOWN_PROVIDERS } = require("../services/enrichmentOrchestration/enrichmentSubject");
const {
  QUOTA_LANES,
  NON_TERMINAL_JOB_STATES,
} = require("../services/enrichmentOrchestration/enrichmentDecisionCodes");
const { utcUsageDate } = require("../services/enrichmentOrchestration/enrichmentQuotaService");

const CANARY_PROVIDER = "greynoise";
const CANARY_SUBJECT = "1.1.1.1";
const REQUIRED_MANUAL_BUDGET = 1;
const REQUIRED_BATCH_SIZE = 1;

// Contract P14's "10 min" margin, added on top of the worker's own lease and
// poll-interval bounds (converted to one common unit, milliseconds).
const UTC_MIDNIGHT_EXTRA_MARGIN_MS = 10 * 60 * 1000;

// Contract P15: "the database name carries the required disposable-canary
// prefix". No such prefix is defined anywhere else in this repository, so
// this preflight establishes the convention and documents it in
// docs/OPERATIONS_RUNBOOK.md — the operator names the disposable canary
// database so its name contains this marker (e.g. `threatnexus_canary`).
// This is a naming-convention sanity check, not a cryptographic guarantee:
// it exists to catch an operator accidentally pointing the canary at a
// long-lived or shared database, not to replace operator discipline.
const DATABASE_NAME_CANARY_MARKER = "canary";

// Contract P17: the Phase-8D live-smoke opt-in variables. Armed only by the
// exact literal "1" (enrichmentCanaryPreflight mirrors greyNoiseLiveSmoke.js's
// own assertOptedIn rule) but this preflight fails closed on ANY non-blank
// value, not only "1" — a stray truthy value is exactly the kind of mistake
// this gate exists to catch.
const LIVE_SMOKE_OPT_IN_VARS = Object.freeze([
  "LIVE_GREYNOISE_SMOKE",
  "LIVE_CENSYS_SMOKE",
  "LIVE_SHODAN_SMOKE",
  "LIVE_NETLAS_SMOKE",
  "LIVE_NVD_SMOKE",
]);

const WORKER_STARTED_ACTION = "enrichment.worker.started";
const WORKER_STOPPED_ACTION = "enrichment.worker.stopped";
const GREYNOISE_LOOKUP_AUDIT_PREFIX = "greynoise.lookup.";

/**
 * One P1-P17 assertion outcome. `detail` is always a short, non-secret,
 * operator-facing string — never a credential value, never a raw environment
 * dump.
 */
function assertionResult(id, description, pass, detail) {
  return Object.freeze({ id, description, pass: pass === true, detail: detail || null });
}

function isBlank(rawValue) {
  return rawValue === undefined || rawValue === null || String(rawValue).trim() === "";
}

/**
 * The database name segment of a Postgres connection string, or null if the
 * URL cannot be parsed. Never returns credentials embedded in the URL (the
 * caller only inspects the returned NAME, exactly as it only inspects the
 * boolean "configured" fact for a provider credential).
 *
 * @param {unknown} databaseUrl
 * @returns {string|null}
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
 * Milliseconds remaining until the next UTC midnight — the instant
 * `ProviderDailyUsage`'s per-day budget bucket resets (contract §10).
 *
 * @param {Date} now
 * @returns {number}
 */
function msUntilNextUtcMidnight(now) {
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );
  return nextMidnight - now.getTime();
}

/**
 * Gathers the read-only database facts P9-P11, P13 and P17's belt-and-braces
 * check need. Issues COUNT/SELECT queries only — no create, update, delete,
 * or upsert anywhere in this module.
 *
 * @param {object} prisma a PrismaClient (or a test double exposing the same
 *   narrow surface used below)
 * @param {{now?: Date}} options
 * @returns {Promise<object>} frozen
 */
async function gatherDbFacts(prisma, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const today = utcUsageDate(now);

  const [usageRows, nonTerminalJobCount, findings, greyNoiseEnrichmentCount, greynoiseLookupAuditCount, workerStartedCount, workerStoppedCount] =
    await Promise.all([
      prisma.providerDailyUsage.findMany({
        where: { provider: CANARY_PROVIDER },
        select: { usageDate: true, lane: true, reservedCount: true },
      }),
      prisma.providerLookupJob.count({ where: { state: { in: [...NON_TERMINAL_JOB_STATES] } } }),
      prisma.finding.findMany({ select: { id: true, indicatorValue: true } }),
      prisma.greyNoiseEnrichment.count(),
      prisma.auditLog.count({ where: { action: { startsWith: GREYNOISE_LOOKUP_AUDIT_PREFIX } } }),
      prisma.auditLog.count({ where: { action: WORKER_STARTED_ACTION } }),
      prisma.auditLog.count({ where: { action: WORKER_STOPPED_ACTION } }),
    ]);

  const reservedTodayGreyNoiseManual = usageRows
    .filter(
      (row) =>
        row.lane === QUOTA_LANES.MANUAL && new Date(row.usageDate).getTime() === today.getTime()
    )
    .reduce((sum, row) => sum + row.reservedCount, 0);

  return Object.freeze({
    providerDailyUsageRows: Object.freeze(usageRows),
    nonTerminalJobCount,
    findings: Object.freeze(findings),
    greyNoiseEnrichmentCount,
    greynoiseLookupAuditCount,
    workerStartedCount,
    workerStoppedCount,
    reservedTodayGreyNoiseManual,
  });
}

/**
 * Pure evaluation of all seventeen contract-defined preflight assertions.
 * Takes every fact as an argument — no I/O, no process.env, no wall clock —
 * so it is exactly what the unit suite exercises for every red/green case.
 *
 * @param {{config: object, dbFacts: object, rawEnv?: object, now?: Date}} options
 *   `config` is the resolved application config shape (backend/src/config/env.js's
 *   export, or an equivalent fake in tests). `dbFacts` is gatherDbFacts's output
 *   (or an equivalent fake). `rawEnv` defaults to {} and is consulted ONLY for the
 *   LIVE_*_SMOKE opt-in variables (P17) — never for a provider credential.
 * @returns {{pass: boolean, assertions: Array<object>}} frozen
 */
function evaluateCanaryPreflight(options = {}) {
  const config = options.config || {};
  const dbFacts = options.dbFacts || {};
  const rawEnv = options.rawEnv || {};
  const now = options.now instanceof Date ? options.now : new Date();

  const manualBudgets = config.ENRICHMENT_MANUAL_DAILY_BUDGETS || {};
  const automaticBudgets = config.ENRICHMENT_AUTOMATIC_DAILY_BUDGETS || {};

  const assertions = [];

  // P1 — the worker switch itself is off at preflight time.
  assertions.push(
    assertionResult(
      "P1",
      "ENRICHMENT_WORKER_ENABLED === false at preflight time",
      config.ENRICHMENT_WORKER_ENABLED === false,
      `ENRICHMENT_WORKER_ENABLED=${config.ENRICHMENT_WORKER_ENABLED === true}`
    )
  );

  // P2 — the AUTOMATIC lane stays structurally dead throughout the canary.
  assertions.push(
    assertionResult(
      "P2",
      "AUTO_ENRICHMENT_ENABLED === false",
      config.AUTO_ENRICHMENT_ENABLED === false,
      `AUTO_ENRICHMENT_ENABLED=${config.AUTO_ENRICHMENT_ENABLED === true}`
    )
  );

  // P3 — the one provider that IS allowed to be armed has its credential.
  const greynoiseCredentialConfigured = isProviderCredentialConfigured(CANARY_PROVIDER, config);
  assertions.push(
    assertionResult(
      "P3",
      "isProviderCredentialConfigured('greynoise') === true",
      greynoiseCredentialConfigured === true,
      `greynoise credential configured=${greynoiseCredentialConfigured}`
    )
  );

  // P4 — every OTHER provider except nvd (keyless, unconditionally "true")
  // must be NOT configured. Naming only the failing providers, never a value.
  const p4OffendingProviders = KNOWN_PROVIDERS.filter(
    (provider) =>
      provider !== CANARY_PROVIDER &&
      provider !== "nvd" &&
      isProviderCredentialConfigured(provider, config) === true
  );
  assertions.push(
    assertionResult(
      "P4",
      "Every provider except greynoise and nvd is NOT credential-configured",
      p4OffendingProviders.length === 0,
      p4OffendingProviders.length === 0
        ? "no other provider is credentialed"
        : `unexpectedly credentialed: ${p4OffendingProviders.join(", ")}`
    )
  );

  // P5 — the one positive, explicit budget the canary depends on. STRICTLY
  // === 1: blank/null (unlimited), the literal "unlimited", and 0 all fail.
  const greynoiseManualBudget = manualBudgets[CANARY_PROVIDER];
  assertions.push(
    assertionResult(
      "P5",
      "manualDailyBudgets.greynoise === 1 (strict)",
      greynoiseManualBudget === REQUIRED_MANUAL_BUDGET,
      `GREYNOISE_MANUAL_DAILY_BUDGET resolves to ${JSON.stringify(greynoiseManualBudget)}`
    )
  );

  // P6 — every OTHER provider's MANUAL budget (including nvd and abuseipdb)
  // must be explicitly 0. Blank/null is unlimited, not safely disabled.
  const p6OffendingProviders = KNOWN_PROVIDERS.filter(
    (provider) => provider !== CANARY_PROVIDER && manualBudgets[provider] !== 0
  );
  assertions.push(
    assertionResult(
      "P6",
      "Every other provider's MANUAL daily budget === 0",
      p6OffendingProviders.length === 0,
      p6OffendingProviders.length === 0
        ? "every other MANUAL budget is 0"
        : `not explicitly 0: ${p6OffendingProviders.join(", ")}`
    )
  );

  // P7 — every provider's AUTOMATIC budget stays 0, including greynoise.
  const p7OffendingProviders = KNOWN_PROVIDERS.filter((provider) => automaticBudgets[provider] !== 0);
  assertions.push(
    assertionResult(
      "P7",
      "Every provider's AUTOMATIC daily budget === 0",
      p7OffendingProviders.length === 0,
      p7OffendingProviders.length === 0
        ? "every AUTOMATIC budget is 0"
        : `not 0: ${p7OffendingProviders.join(", ")}`
    )
  );

  // P8 — the worker claims at most one job per tick.
  assertions.push(
    assertionResult(
      "P8",
      "ENRICHMENT_WORKER_BATCH_SIZE === 1",
      config.ENRICHMENT_WORKER_BATCH_SIZE === REQUIRED_BATCH_SIZE,
      `ENRICHMENT_WORKER_BATCH_SIZE=${JSON.stringify(config.ENRICHMENT_WORKER_BATCH_SIZE)}`
    )
  );

  // P9 — no pre-existing greynoise spend on any day (all-days, not just
  // today — the UTC-rollover note in contract §10).
  const usageRows = dbFacts.providerDailyUsageRows || [];
  const p9Pass = usageRows.length === 0 || usageRows.every((row) => row.reservedCount === 0);
  assertions.push(
    assertionResult(
      "P9",
      "ProviderDailyUsage has zero rows for greynoise across every usageDate, or all reservedCount === 0",
      p9Pass,
      `${usageRows.length} usage row(s) found for greynoise`
    )
  );

  // P10 — no leftover claimable work of any kind, for any provider.
  const nonTerminalJobCount = dbFacts.nonTerminalJobCount;
  assertions.push(
    assertionResult(
      "P10",
      "Zero non-terminal ProviderLookupJob rows (PENDING/LEASED/RETRY_WAIT/WAITING_ON_DELEGATE)",
      nonTerminalJobCount === 0,
      `${nonTerminalJobCount} non-terminal job row(s) found`
    )
  );

  // P11 — exactly one Finding, and it is the approved canary subject.
  const findings = dbFacts.findings || [];
  const p11Pass = findings.length === 1 && findings[0].indicatorValue === CANARY_SUBJECT;
  assertions.push(
    assertionResult(
      "P11",
      `Exactly one Finding exists and its indicator is ${CANARY_SUBJECT}`,
      p11Pass,
      `${findings.length} Finding row(s) found`
    )
  );

  // P12 — cheap consistency check on the readiness surface itself. Proves
  // NOTHING about budget state on its own (EXECUTION_PAUSED masks every
  // budget branch below it) — see contract §12.2's correction. The real
  // "only the worker switch remains" property is the conjunction below.
  //
  // resolveProviderReadiness THROWS on a malformed dailyBudget (by design —
  // enrichmentProviderReadiness.js treats a non-null/non-integer value as a
  // programming error, not a data condition). A resolved config from env.js
  // can never actually produce one (validateDailyBudget already normalizes
  // "unlimited" to null upstream), but this preflight must still terminate
  // with a clean FAIL rather than crash if some other malformed value ever
  // reaches here — P5 already reports the real defect independently.
  const dailyBudgetForReadiness =
    greynoiseManualBudget === null || Number.isInteger(greynoiseManualBudget) ? greynoiseManualBudget : null;
  const readiness = resolveProviderReadiness({
    provider: CANARY_PROVIDER,
    lane: QUOTA_LANES.MANUAL,
    credentialConfigured: greynoiseCredentialConfigured,
    workerEnabled: config.ENRICHMENT_WORKER_ENABLED === true,
    automaticIngestionEnabled: config.AUTO_ENRICHMENT_ENABLED === true,
    dailyBudget: dailyBudgetForReadiness,
    reservedToday: dbFacts.reservedTodayGreyNoiseManual || 0,
  });
  assertions.push(
    assertionResult(
      "P12",
      "resolveProviderReadiness(greynoise, MANUAL) === EXECUTION_PAUSED",
      readiness === PROVIDER_READINESS.EXECUTION_PAUSED,
      `readiness=${readiness}`
    )
  );

  // P13 — the legacy-path baseline (contract §3.2): zero prior contact via
  // EITHER channel, before the canary is ever authorized.
  const p13Pass = dbFacts.greyNoiseEnrichmentCount === 0 && dbFacts.greynoiseLookupAuditCount === 0;
  assertions.push(
    assertionResult(
      "P13",
      "Zero GreyNoiseEnrichment rows and zero greynoise.lookup.% audit rows",
      p13Pass,
      `GreyNoiseEnrichment=${dbFacts.greyNoiseEnrichmentCount}, greynoise.lookup.* audit rows=${dbFacts.greynoiseLookupAuditCount}`
    )
  );

  // P14 — enough runway before the UTC-midnight budget-bucket reset for the
  // canary to reach a terminal state.
  const leaseMs = (config.ENRICHMENT_WORKER_LEASE_SECONDS || 0) * 1000;
  const pollIntervalMs = config.ENRICHMENT_WORKER_POLL_INTERVAL_MS || 0;
  const requiredMarginMs = leaseMs + pollIntervalMs + UTC_MIDNIGHT_EXTRA_MARGIN_MS;
  const remainingMs = msUntilNextUtcMidnight(now);
  assertions.push(
    assertionResult(
      "P14",
      "At least ENRICHMENT_WORKER_LEASE_SECONDS + ENRICHMENT_WORKER_POLL_INTERVAL_MS + 10 min remain before UTC midnight",
      remainingMs >= requiredMarginMs,
      `${remainingMs}ms remain, ${requiredMarginMs}ms required`
    )
  );

  // P15 — the execution-binding sanity check: this process resolved a
  // DATABASE_URL, and its database name follows the disposable-canary naming
  // convention (docs/OPERATIONS_RUNBOOK.md). Does not and cannot prove which
  // *process* will boot the worker — that property is established by running
  // this script inside the worker's own container (see the module header).
  const databaseName = extractDatabaseName(config.DATABASE_URL);
  const p15Pass = Boolean(databaseName) && databaseName.toLowerCase().includes(DATABASE_NAME_CANARY_MARKER);
  assertions.push(
    assertionResult(
      "P15",
      `Resolved DATABASE_URL's database name contains "${DATABASE_NAME_CANARY_MARKER}"`,
      p15Pass,
      databaseName ? `database name=${databaseName}` : "DATABASE_URL is blank or unparseable"
    )
  );

  // P16 — closes the legacy ADMIN IOC batch path (contract §3.2).
  assertions.push(
    assertionResult(
      "P16",
      "IOC_ENRICHMENT_PROVIDER === 'mock'",
      config.IOC_ENRICHMENT_PROVIDER === "mock",
      `IOC_ENRICHMENT_PROVIDER=${JSON.stringify(config.IOC_ENRICHMENT_PROVIDER)}`
    )
  );

  // P17 — belt-and-braces: no Phase-8D live-smoke opt-in armed, and no
  // worker-started audit row without a matching worker-stopped row.
  const armedSmokeVars = LIVE_SMOKE_OPT_IN_VARS.filter((name) => !isBlank(rawEnv[name]));
  const workerStartedCount = dbFacts.workerStartedCount || 0;
  const workerStoppedCount = dbFacts.workerStoppedCount || 0;
  const p17Pass = armedSmokeVars.length === 0 && workerStartedCount === workerStoppedCount;
  assertions.push(
    assertionResult(
      "P17",
      "No LIVE_*_SMOKE opt-in variable is set, and every worker-started audit row has a matching worker-stopped row",
      p17Pass,
      `armed opt-in vars: ${armedSmokeVars.length === 0 ? "none" : armedSmokeVars.join(", ")}; ` +
        `worker.started=${workerStartedCount}, worker.stopped=${workerStoppedCount}`
    )
  );

  return Object.freeze({
    pass: assertions.every((assertion) => assertion.pass),
    assertions: Object.freeze(assertions),
  });
}

function printReport(result) {
  console.log("Phase 10C-4 canary preflight (P1-P17) — read-only, no provider contact:");
  // eslint-disable-next-line no-restricted-syntax
  for (const assertion of result.assertions) {
    console.log(`  [${assertion.pass ? "PASS" : "FAIL"}] ${assertion.id} — ${assertion.description}`);
    console.log(`         ${assertion.detail}`);
  }
  console.log(
    result.pass
      ? "PREFLIGHT PASS — the environment matches the contract-approved bounded canary shape."
      : "PREFLIGHT FAIL — canary must NOT be authorized until every assertion above passes."
  );
}

async function main() {
  // eslint-disable-next-line global-require
  const config = require("../config/env");
  // eslint-disable-next-line global-require
  const prisma = require("../config/prisma");
  const now = new Date();

  let result;
  try {
    const dbFacts = await gatherDbFacts(prisma, { now });
    result = evaluateCanaryPreflight({ config, dbFacts, rawEnv: process.env, now });
  } finally {
    await prisma.$disconnect();
  }

  printReport(result);
  if (!result.pass) process.exitCode = 1;
}

module.exports = {
  CANARY_PROVIDER,
  CANARY_SUBJECT,
  REQUIRED_MANUAL_BUDGET,
  REQUIRED_BATCH_SIZE,
  DATABASE_NAME_CANARY_MARKER,
  LIVE_SMOKE_OPT_IN_VARS,
  extractDatabaseName,
  msUntilNextUtcMidnight,
  gatherDbFacts,
  evaluateCanaryPreflight,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`Canary preflight failed to run: ${error.message}`);
    process.exitCode = 1;
  });
}
