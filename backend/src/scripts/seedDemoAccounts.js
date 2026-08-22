"use strict";

// DEMONSTRATION-ONLY login accounts (docs/demo/DEMO-READINESS.md).
//
// Answers ONE question: "which human accounts can a presenter log in with,
// deterministically, on the DESIGNATED DISPOSABLE demo database?" It touches
// nothing else — no Finding, organization, occurrence, case, provider fixture
// or reset semantic is read or written here.
//
// ---------------------------------------------------------------------------
// These are DEMO CREDENTIALS. They are not production defaults.
// ---------------------------------------------------------------------------
// The password below is deliberately weak, memorable, shared across three
// accounts, and committed in the clear. That is acceptable for exactly one
// reason: this script physically cannot run against anything but a disposable
// demo database, because it reuses `demoReset.evaluateResetGuards` — the same
// guard set that stands in front of `DROP SCHEMA public CASCADE`.
//
// Sibling `seedUsers.js` is the general local-seed entry point and takes the
// password from SEED_USER_PASSWORD, so an operator seeding a normal local
// stack still chooses their own. This script exists precisely because the
// demo needs stable, pre-agreed credentials that survive every reset, and it
// pays for that convenience with a much stricter environment guard than
// seedUsers.js carries.
//
// Nothing here changes public registration, the password policy applied to
// normal users, JWT issuance, or any authorization rule. The accounts are
// ordinary User rows created through the same upsert and the same bcrypt cost
// factor that registration uses, so login verifies them by the ordinary path.

const bcrypt = require("bcrypt");

const { evaluateResetGuards } = require("./demoReset");
const { upsertSeedUsers } = require("./seedUsers");
const { isValidPassword, MIN_PASSWORD_LENGTH } = require("../lib/validation");

// Matches the salt rounds authController.js uses for registration/login.
const BCRYPT_SALT_ROUNDS = 10;

// The shared, published, demo-only password. See the header: weak on purpose,
// safe only because of the guard. Still checked against the real password
// policy below so a demo account can never be created with a credential the
// application itself would reject.
const DEMO_ACCOUNT_PASSWORD = "ismail321";

// Exactly these three emails are ever created or updated. Any other user —
// including the seedUsers.js accounts — is left untouched, and no row is ever
// deleted.
const DEMO_ACCOUNT_DEFINITIONS = Object.freeze([
  Object.freeze({
    email: "ismail123@threatnexus.local",
    name: "Ismail (Demo Analyst)",
    role: "ANALYST",
  }),
  Object.freeze({
    email: "admin123@threatnexus.local",
    name: "Demo Administrator",
    role: "ADMIN",
  }),
  Object.freeze({
    email: "viewer123@threatnexus.local",
    name: "Demo Viewer",
    role: "VIEWER",
  }),
]);

const DEMO_ACCOUNT_EMAILS = Object.freeze(DEMO_ACCOUNT_DEFINITIONS.map((def) => def.email));

class DemoAccountsRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = "DemoAccountsRefusedError";
  }
}

/**
 * Throws unless the environment is the designated disposable demo stack.
 *
 * Reuses the demo:reset guard set rather than inventing a second, weaker
 * convention — a credential that must never reach production deserves at
 * least the protection the destructive reset already gets. G5
 * (AUTO_ENRICHMENT_ENABLED off) is not about accounts, but sharing one guard
 * definition is worth more than trimming a condition that is already true in
 * every environment this script is meant to run in.
 *
 * @param {object} source normally process.env
 * @returns {string} the resolved (demo) database name
 */
function assertDisposableDemoEnvironment(source) {
  const guards = evaluateResetGuards(source || {});
  if (!guards.allowed) {
    throw new DemoAccountsRefusedError(
      "Refusing to provision demo login accounts: this is not a designated disposable demo " +
        "environment. These are deliberately weak, published demo credentials and must never " +
        `exist on a normal or production database.\n  - ${guards.refusals.join("\n  - ")}`
    );
  }
  return guards.databaseName;
}

// The constant is not operator input, but it is still a credential the app has
// to accept: if the password policy ever tightens past it, fail loudly here
// rather than seeding three accounts nobody can log in with.
function assertPasswordMeetsPolicy(password = DEMO_ACCOUNT_PASSWORD) {
  if (!isValidPassword(password)) {
    throw new DemoAccountsRefusedError(
      `The demo account password no longer meets the password policy (minimum ` +
        `${MIN_PASSWORD_LENGTH} characters). Update DEMO_ACCOUNT_PASSWORD and the demo runbook.`
    );
  }
  return password;
}

// hash is injectable so unit tests avoid real bcrypt cost while still proving
// the seeded record never carries the plaintext password.
async function buildDemoAccountRecords(password = DEMO_ACCOUNT_PASSWORD, { hash = bcrypt.hash } = {}) {
  const hashedPassword = await hash(password, BCRYPT_SALT_ROUNDS);
  return DEMO_ACCOUNT_DEFINITIONS.map((definition) => ({
    ...definition,
    password: hashedPassword,
  }));
}

function resolveClient(client) {
  if (client) return client;
  // Lazily required: importing this module must not require a live
  // DATABASE_URL, and a refused invocation must never construct a client.
  // eslint-disable-next-line global-require
  return require("../config/prisma");
}

async function seedDemoAccounts({ env = process.env, prismaClient, hash } = {}) {
  assertDisposableDemoEnvironment(env);
  const password = assertPasswordMeetsPolicy();

  const records = await buildDemoAccountRecords(password, hash ? { hash } : undefined);
  // Idempotent by upsert on the unique email: a second run reconciles
  // name/role/password on the same three rows instead of creating duplicates.
  return upsertSeedUsers(records, resolveClient(prismaClient));
}

module.exports = {
  DEMO_ACCOUNT_DEFINITIONS,
  DEMO_ACCOUNT_EMAILS,
  DEMO_ACCOUNT_PASSWORD,
  DemoAccountsRefusedError,
  assertDisposableDemoEnvironment,
  assertPasswordMeetsPolicy,
  buildDemoAccountRecords,
  seedDemoAccounts,
};

if (require.main === module) {
  seedDemoAccounts()
    .then(async (users) => {
      console.log(`Provisioned ${users.length} DEMO-ONLY login accounts:`);
      users.forEach((user) => {
        console.log(`  ${user.role.padEnd(8)} ${user.email}`);
      });
      console.log(
        `\nShared demo password: ${DEMO_ACCOUNT_PASSWORD}\n` +
          "DEMO CREDENTIALS ONLY — never valid outside the disposable demo database."
      );
      await resolveClient().$disconnect();
    })
    .catch((error) => {
      console.error(`\nDEMO ACCOUNTS REFUSED\n\n${error.message}\n`);
      process.exitCode = 1;
    });
}
