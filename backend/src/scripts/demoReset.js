"use strict";

// Demonstration-only database reset (docs/demo/DEMO-READINESS.md).
//
// Answers ONE question: "put the DESIGNATED DISPOSABLE demo database back into
// the deterministic, never-enriched state a live demonstration must start
// from." Nothing else. It is a demo operator entry point, exactly like the
// Phase-8D `smoke:*` scripts and the Phase-10C4 `preflight:canary` harness —
// never wired into CI, `npm test`, or any automatic path.
//
// This script:
//   - makes NO provider call (no provider/adapter/execution-service module is
//     required anywhere below — see the no-network-contact unit test);
//   - never reads, prints, or compares a credential VALUE;
//   - REFUSES to act unless it can positively determine, from several
//     independent signals, that it is pointed at a disposable demo database.
//
// ---------------------------------------------------------------------------
// Why the guard is shaped this way
// ---------------------------------------------------------------------------
// The destructive step is `DROP SCHEMA public CASCADE`. A reset command that
// can be pointed at an arbitrary database by a single mistyped environment
// variable is a strictly worse problem than the rehearsal contamination it
// exists to clean up. So every guard below must pass, and each one is
// independent of the others:
//
//   G1  NODE_ENV is not "production".
//   G2  The database NAME carries the disposable-demo marker. This mirrors the
//       Phase-10C4 canary preflight's `DATABASE_NAME_CANARY_MARKER` convention
//       rather than inventing a second, different one.
//   G3  The database name is not the plain default `threatnexus` — the name a
//       long-lived local or shared instance actually uses. G2 alone would let
//       `threatnexus` through if someone ever added the marker to a real name,
//       and the contaminated rehearsal stack this tooling was written for was
//       running on exactly that plain name.
//   G4  DEMO_RESET_CONFIRM equals the resolved database name, spelled out in
//       full by the operator. A marker convention catches an accident; an
//       explicit echo of the target catches a deliberate-but-wrong invocation.
//   G5  AUTO_ENRICHMENT_ENABLED is off.
//
// G5 is not paranoia and it is not about protecting the database — it is the
// whole reason the demo needed repairing. `seed:demo` ingests reports through
// the real pipeline, and report ingestion schedules AUTOMATIC-lane enrichment.
// Resetting with automatic enrichment on therefore re-creates, during the seed
// itself, the very FindingEnrichmentRun rows that make the first analyst click
// answer "Skipped — a fresh result already exists". A reset that leaves the
// database in the state it was supposed to clear is worse than no reset,
// because it looks like it worked.

const { execFileSync } = require("node:child_process");
const path = require("node:path");

// Same marker convention as the canary preflight's disposable-stack check.
const DATABASE_NAME_DEMO_MARKER = "demo";

// The plain database name a long-lived local instance uses. Never a valid
// reset target regardless of what else passes.
const FORBIDDEN_DATABASE_NAMES = Object.freeze(["threatnexus", "postgres", "template1"]);

class DemoResetRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = "DemoResetRefusedError";
  }
}

/**
 * The database name segment of a Postgres connection string, or null if the
 * URL cannot be parsed. Only the NAME is ever returned or inspected — any
 * credentials embedded in the URL are neither returned, logged, nor compared.
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
 * Decides whether this environment may be reset, WITHOUT touching anything.
 *
 * Pure: takes the environment as an argument rather than reading process.env,
 * so every test injects a fake environment explicitly and no test can depend on
 * the developer's real one. Returns the refusal reasons rather than throwing,
 * so a caller (and the unit tests) can assert on the full set at once instead
 * of only the first failure.
 *
 * @param {object} source normally process.env
 * @returns {{allowed: boolean, databaseName: string|null, refusals: string[]}} frozen
 */
function evaluateResetGuards(source) {
  const env = source || {};
  const refusals = [];

  const nodeEnv = String(env.NODE_ENV || "development").trim();
  if (nodeEnv === "production") {
    refusals.push("G1 NODE_ENV=production — demo:reset never runs against a production environment.");
  }

  const databaseName = extractDatabaseName(env.DATABASE_URL);
  if (databaseName === null) {
    refusals.push("G2 DATABASE_URL is missing or not a parseable connection string.");
  } else {
    if (!databaseName.toLowerCase().includes(DATABASE_NAME_DEMO_MARKER)) {
      refusals.push(
        `G2 database name ${JSON.stringify(databaseName)} does not contain the required ` +
          `disposable-demo marker ${JSON.stringify(DATABASE_NAME_DEMO_MARKER)} ` +
          "(e.g. `threatnexus_demo`)."
      );
    }
    if (FORBIDDEN_DATABASE_NAMES.includes(databaseName.toLowerCase())) {
      refusals.push(
        `G3 database name ${JSON.stringify(databaseName)} is a reserved/long-lived name and is ` +
          "never a valid reset target."
      );
    }
    const confirm = String(env.DEMO_RESET_CONFIRM || "").trim();
    if (confirm !== databaseName) {
      refusals.push(
        "G4 DEMO_RESET_CONFIRM must be set to the exact database name being reset " +
          `(expected ${JSON.stringify(databaseName)}).`
      );
    }
  }

  if (String(env.AUTO_ENRICHMENT_ENABLED || "").trim().toLowerCase() === "true") {
    refusals.push(
      "G5 AUTO_ENRICHMENT_ENABLED=true — seeding would schedule AUTOMATIC-lane enrichment during " +
        "ingestion and re-contaminate the demo Findings this reset exists to clear."
    );
  }

  return Object.freeze({
    allowed: refusals.length === 0,
    databaseName,
    refusals: Object.freeze(refusals),
  });
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    cwd: path.resolve(__dirname, "..", ".."),
    ...options,
  });
}

async function main() {
  const guards = evaluateResetGuards(process.env);
  if (!guards.allowed) {
    process.stderr.write("\nDEMO RESET REFUSED\n\n");
    guards.refusals.forEach((reason) => process.stderr.write(`  - ${reason}\n`));
    process.stderr.write("\n");
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`demo:reset — target database ${JSON.stringify(guards.databaseName)}\n`);

  // Required lazily and only after the guards pass, so a refused invocation
  // never even constructs a database client.
  // eslint-disable-next-line global-require
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();

  try {
    process.stdout.write("  1/5 dropping schema\n");
    // The destructive step. Reached only with every guard satisfied.
    await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await prisma.$executeRawUnsafe("CREATE SCHEMA public");
  } finally {
    await prisma.$disconnect();
  }

  process.stdout.write("  2/5 applying migrations\n");
  run("npx", ["prisma", "migrate", "deploy"]);

  process.stdout.write("  3/5 seeding users\n");
  run("node", ["src/scripts/seedUsers.js"]);

  // Demo-only login accounts with a published shared password. Run as a child
  // process like every other step, so it re-evaluates these same guards in its
  // own process rather than trusting this one — it is the only reason those
  // deliberately weak credentials are safe to commit.
  process.stdout.write("  4/5 provisioning demo login accounts\n");
  run("node", ["src/scripts/seedDemoAccounts.js"]);

  process.stdout.write("  5/5 seeding demonstration dataset\n");
  run("node", ["src/scripts/seedDemo.js"]);

  process.stdout.write("\nDEMO RESET COMPLETE — run `npm run demo:preflight` before presenting.\n");
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`\ndemo:reset failed: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DATABASE_NAME_DEMO_MARKER,
  FORBIDDEN_DATABASE_NAMES,
  DemoResetRefusedError,
  extractDatabaseName,
  evaluateResetGuards,
};
