"use strict";

const bcrypt = require("bcrypt");

const { isValidPassword, MIN_PASSWORD_LENGTH } = require("../lib/validation");

// Matches the salt rounds authController.js uses for registration/login.
const BCRYPT_SALT_ROUNDS = 10;

// Exactly these four emails are ever created or updated by this script. Any
// other user in the database is untouched, and the script never deletes rows.
const SEED_USER_DEFINITIONS = Object.freeze([
  Object.freeze({ email: "admin@threatnexus.local", name: "ThreatNeXus Admin", role: "ADMIN" }),
  Object.freeze({ email: "analyst@threatnexus.local", name: "ThreatNeXus Analyst", role: "ANALYST" }),
  Object.freeze({ email: "reviewer@threatnexus.local", name: "ThreatNeXus Reviewer", role: "REVIEWER" }),
  Object.freeze({ email: "viewer@threatnexus.local", name: "ThreatNeXus Viewer", role: "VIEWER" }),
]);

const SEED_EMAILS = Object.freeze(SEED_USER_DEFINITIONS.map((def) => def.email));

// Deliberately awkward name and value rather than a plain boolean flag: this
// script creates four accounts with well-known emails and a shared password,
// which must never run against a real environment. The friction is the point.
const PRODUCTION_OVERRIDE_ENV = "SEED_USERS_FORCE_PRODUCTION_I_UNDERSTAND_THE_RISK";
const PRODUCTION_OVERRIDE_VALUE = "I_UNDERSTAND_THE_RISK";

class SeedConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeedConfigError";
  }
}

// Throws rather than defaulting to "skip" so a misconfigured production
// deploy fails loudly instead of silently running (or silently no-op'ing).
function assertSafeEnvironment(nodeEnv, overrideValue) {
  if (nodeEnv === "production" && overrideValue !== PRODUCTION_OVERRIDE_VALUE) {
    throw new SeedConfigError(
      "Refusing to seed demo users in production (NODE_ENV=production). " +
        "This script creates four accounts with well-known local emails and a shared password."
    );
  }
}

// Enforces the same password policy as public registration. Missing and weak
// passwords fail with distinct, actionable messages rather than proceeding
// with a default/blank credential.
function resolveSeedPassword(rawPassword) {
  if (typeof rawPassword !== "string" || rawPassword.trim() === "") {
    throw new SeedConfigError(
      "SEED_USER_PASSWORD is required. Set it as a temporary shell variable, e.g.:\n" +
        "  SEED_USER_PASSWORD=<a-strong-local-only-password> npm run seed:users"
    );
  }
  if (!isValidPassword(rawPassword)) {
    throw new SeedConfigError(
      `SEED_USER_PASSWORD does not meet the password policy (minimum ${MIN_PASSWORD_LENGTH} characters).`
    );
  }
  return rawPassword;
}

// hash is injectable so unit tests can avoid real bcrypt cost while still
// proving the seeded record never carries the plaintext password.
async function buildSeedUserRecords(password, { hash = bcrypt.hash } = {}) {
  const hashedPassword = await hash(password, BCRYPT_SALT_ROUNDS);
  return SEED_USER_DEFINITIONS.map((definition) => ({
    ...definition,
    password: hashedPassword,
  }));
}

// Upsert on the unique email keeps the script idempotent: a second run
// updates name/role/password on the same four rows rather than creating
// duplicates, and no other row is ever read, created, updated or deleted.
async function upsertSeedUsers(records, prismaClient) {
  const results = [];
  for (const record of records) {
    const { email, name, role, password } = record;
    // eslint-disable-next-line no-await-in-loop
    const user = await prismaClient.user.upsert({
      where: { email },
      update: { name, role, password },
      create: { email, name, role, password },
      select: { id: true, email: true, name: true, role: true },
    });
    results.push(user);
  }
  return results;
}

function resolveClient(client) {
  if (client) return client;
  // Lazily required: constructing this at module load would tie an import of
  // seedUsers.js to a live DATABASE_URL, which unit tests must not require.
  // eslint-disable-next-line global-require
  return require("../config/prisma");
}

async function seedUsers({ env = process.env, prismaClient, hash } = {}) {
  assertSafeEnvironment(env.NODE_ENV, env[PRODUCTION_OVERRIDE_ENV]);
  const password = resolveSeedPassword(env.SEED_USER_PASSWORD);

  const records = await buildSeedUserRecords(password, hash ? { hash } : undefined);
  const client = resolveClient(prismaClient);
  return upsertSeedUsers(records, client);
}

module.exports = {
  SEED_USER_DEFINITIONS,
  SEED_EMAILS,
  PRODUCTION_OVERRIDE_ENV,
  PRODUCTION_OVERRIDE_VALUE,
  SeedConfigError,
  assertSafeEnvironment,
  resolveSeedPassword,
  buildSeedUserRecords,
  upsertSeedUsers,
  seedUsers,
};

if (require.main === module) {
  seedUsers()
    .then(async (users) => {
      console.log(`Seeded ${users.length} local demo users:`);
      users.forEach((user) => {
        console.log(`  ${user.role.padEnd(8)} ${user.email}`);
      });
      console.log(
        "\nPasswords are never printed. Log in with the SEED_USER_PASSWORD value you set for this run."
      );
      await resolveClient().$disconnect();
    })
    .catch((error) => {
      console.error(`Seeding failed: ${error.message}`);
      process.exitCode = 1;
    });
}
