"use strict";

// The demo login accounts carry a weak, published, shared password. These are
// the tests that keep that password confined to a disposable demo database,
// and that keep the accounts deterministic across repeated resets.

import { describe, it, expect, vi } from "vitest";

const bcrypt = require("bcrypt");

const {
  DEMO_ACCOUNT_DEFINITIONS,
  DEMO_ACCOUNT_EMAILS,
  DEMO_ACCOUNT_PASSWORD,
  DemoAccountsRefusedError,
  assertDisposableDemoEnvironment,
  assertPasswordMeetsPolicy,
  buildDemoAccountRecords,
  seedDemoAccounts,
} = require("../../src/scripts/seedDemoAccounts");

const { isValidPassword, MIN_PASSWORD_LENGTH } = require("../../src/lib/validation");
const { SEED_USER_DEFINITIONS, seedUsers, SeedConfigError } = require("../../src/scripts/seedUsers");

// The one environment in which provisioning is allowed — identical to the
// demo:reset allowed case, because it reuses the same guard set.
const DEMO_ENV = Object.freeze({
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://u:p@postgres:5432/threatnexus_demo?schema=public",
  DEMO_RESET_CONFIRM: "threatnexus_demo",
  AUTO_ENRICHMENT_ENABLED: "false",
});

// A normal, long-lived, production-like stack: the invocation that must fail.
const PRODUCTION_ENV = Object.freeze({
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@db.internal:5432/threatnexus?schema=public",
  DEMO_RESET_CONFIRM: "threatnexus",
});

async function fakeHash(password, rounds) {
  return `HASHED(${rounds}):${password}`;
}

function makePrismaStub() {
  const rows = [];
  return {
    rows,
    user: {
      upsert: vi.fn(async ({ where, update, create, select }) => {
        const index = rows.findIndex((u) => u.email === where.email);
        const merged =
          index === -1 ? { id: rows.length + 1, ...create } : { ...rows[index], ...update };
        if (index === -1) rows.push(merged);
        else rows[index] = merged;

        if (!select) return { ...merged };
        return Object.fromEntries(
          Object.keys(select)
            .filter((key) => select[key])
            .map((key) => [key, merged[key]])
        );
      }),
      delete: vi.fn(async () => {
        throw new Error("user.delete must never be called");
      }),
      deleteMany: vi.fn(async () => {
        throw new Error("user.deleteMany must never be called");
      }),
    },
  };
}

describe("DEMO_ACCOUNT_DEFINITIONS", () => {
  it("declares exactly the three agreed demo accounts with their roles", () => {
    expect(
      DEMO_ACCOUNT_DEFINITIONS.map(({ email, role }) => ({ email, role }))
    ).toEqual([
      { email: "ismail123@threatnexus.local", role: "ANALYST" },
      { email: "admin123@threatnexus.local", role: "ADMIN" },
      { email: "viewer123@threatnexus.local", role: "VIEWER" },
    ]);
  });

  it("uses lowercase .local emails that normalizeEmail leaves untouched", () => {
    DEMO_ACCOUNT_EMAILS.forEach((email) => {
      expect(email).toBe(email.trim().toLowerCase());
      expect(email).toMatch(/@threatnexus\.local$/);
    });
  });

  it("does not collide with the general seedUsers accounts", () => {
    const seeded = SEED_USER_DEFINITIONS.map((d) => d.email);
    DEMO_ACCOUNT_EMAILS.forEach((email) => expect(seeded).not.toContain(email));
  });
});

describe("the production guard", () => {
  it("refuses a production-like database outright", () => {
    expect(() => assertDisposableDemoEnvironment(PRODUCTION_ENV)).toThrow(DemoAccountsRefusedError);
    expect(() => assertDisposableDemoEnvironment(PRODUCTION_ENV)).toThrow(/never exist on a normal or production database/i);
  });

  it("refuses each way the demo environment can fail, independently", () => {
    const broken = {
      "NODE_ENV=production": { ...DEMO_ENV, NODE_ENV: "production" },
      "no demo marker": {
        ...DEMO_ENV,
        DATABASE_URL: "postgresql://u:p@h:5432/threatnexus_staging?schema=public",
        DEMO_RESET_CONFIRM: "threatnexus_staging",
      },
      "reserved name": {
        ...DEMO_ENV,
        DATABASE_URL: "postgresql://u:p@h:5432/threatnexus?schema=public",
        DEMO_RESET_CONFIRM: "threatnexus",
      },
      "missing confirmation": { ...DEMO_ENV, DEMO_RESET_CONFIRM: undefined },
      "wrong confirmation": { ...DEMO_ENV, DEMO_RESET_CONFIRM: "another_demo" },
      "missing DATABASE_URL": { ...DEMO_ENV, DATABASE_URL: undefined },
    };
    Object.entries(broken).forEach(([label, env]) => {
      expect(() => assertDisposableDemoEnvironment(env), label).toThrow(DemoAccountsRefusedError);
    });
  });

  it("allows the designated disposable demo database", () => {
    expect(assertDisposableDemoEnvironment(DEMO_ENV)).toBe("threatnexus_demo");
  });

  it("never touches the database when it refuses", async () => {
    const prisma = makePrismaStub();
    await expect(
      seedDemoAccounts({ env: PRODUCTION_ENV, prismaClient: prisma, hash: fakeHash })
    ).rejects.toThrow(DemoAccountsRefusedError);
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it("never echoes credentials embedded in DATABASE_URL", () => {
    try {
      assertDisposableDemoEnvironment({
        ...DEMO_ENV,
        DATABASE_URL: "postgresql://dbuser:sup3rs3cret@h:5432/threatnexus?schema=public",
        DEMO_RESET_CONFIRM: "threatnexus",
      });
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(DemoAccountsRefusedError);
      expect(err.message).not.toContain("sup3rs3cret");
      expect(err.message).not.toContain("dbuser");
    }
  });
});

describe("the demo password", () => {
  it("satisfies the application's real password policy unchanged", () => {
    expect(DEMO_ACCOUNT_PASSWORD.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    expect(isValidPassword(DEMO_ACCOUNT_PASSWORD)).toBe(true);
    expect(assertPasswordMeetsPolicy()).toBe(DEMO_ACCOUNT_PASSWORD);
  });

  it("fails loudly if the policy ever outgrows it", () => {
    expect(() => assertPasswordMeetsPolicy("short")).toThrow(DemoAccountsRefusedError);
  });

  it("is stored only as a bcrypt hash, never in plaintext", async () => {
    const records = await buildDemoAccountRecords(DEMO_ACCOUNT_PASSWORD, { hash: fakeHash });
    expect(JSON.stringify(records)).not.toContain(`"${DEMO_ACCOUNT_PASSWORD}"`);
  });

  it("authenticates through the same bcrypt comparison authController.login uses", async () => {
    // One real bcrypt round-trip: the point is that the stored hash verifies by
    // the ordinary login path, not by anything this script does specially.
    const [record] = await buildDemoAccountRecords();
    await expect(bcrypt.compare(DEMO_ACCOUNT_PASSWORD, record.password)).resolves.toBe(true);
    await expect(bcrypt.compare("wrong-password", record.password)).resolves.toBe(false);
  });
});

describe("seedDemoAccounts", () => {
  it("provisions all three accounts with the intended roles", async () => {
    const prisma = makePrismaStub();
    const users = await seedDemoAccounts({ env: DEMO_ENV, prismaClient: prisma, hash: fakeHash });

    expect(users.map((u) => `${u.role} ${u.email}`).sort()).toEqual([
      "ADMIN admin123@threatnexus.local",
      "ANALYST ismail123@threatnexus.local",
      "VIEWER viewer123@threatnexus.local",
    ]);
  });

  it("is idempotent: two runs reconcile the same three rows, no duplicates", async () => {
    const prisma = makePrismaStub();
    await seedDemoAccounts({ env: DEMO_ENV, prismaClient: prisma, hash: fakeHash });
    await seedDemoAccounts({ env: DEMO_ENV, prismaClient: prisma, hash: fakeHash });

    expect(prisma.rows).toHaveLength(3);
    expect(prisma.user.upsert).toHaveBeenCalledTimes(6);
  });

  it("reconciles a drifted role back to the intended one", async () => {
    const prisma = makePrismaStub();
    await prisma.user.upsert({
      where: { email: "viewer123@threatnexus.local" },
      create: { email: "viewer123@threatnexus.local", name: "Drifted", role: "ADMIN", password: "x" },
      update: {},
    });

    await seedDemoAccounts({ env: DEMO_ENV, prismaClient: prisma, hash: fakeHash });

    expect(prisma.rows).toHaveLength(3);
    expect(prisma.rows.find((u) => u.email === "viewer123@threatnexus.local").role).toBe("VIEWER");
  });

  it("touches only the three demo emails and deletes nothing", async () => {
    const prisma = makePrismaStub();
    await seedDemoAccounts({ env: DEMO_ENV, prismaClient: prisma, hash: fakeHash });

    expect(prisma.user.upsert.mock.calls.map((c) => c[0].where.email).sort()).toEqual(
      [...DEMO_ACCOUNT_EMAILS].sort()
    );
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
  });

  it("does not return password hashes to the caller", async () => {
    const prisma = makePrismaStub();
    const users = await seedDemoAccounts({ env: DEMO_ENV, prismaClient: prisma, hash: fakeHash });
    users.forEach((user) => expect(user.password).toBeUndefined());
  });
});

describe("wiring into the guarded reset", () => {
  it("runs as a step of demo:reset, so the accounts survive every reset", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "scripts", "demoReset.js"),
      "utf8"
    );
    expect(source).toContain("src/scripts/seedDemoAccounts.js");
  });

  it("makes no provider, adapter, or network call", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "scripts", "seedDemoAccounts.js"),
      "utf8"
    );
    [...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].forEach(([, specifier]) => {
      expect(specifier).not.toMatch(/Provider|provider|ExecutionService|Adapter|axios|node-fetch/);
    });
  });
});

describe("normal registration and seeding behaviour is unchanged", () => {
  it("leaves the general seedUsers accounts and their password requirement alone", async () => {
    expect(SEED_USER_DEFINITIONS).toHaveLength(4);
    const prisma = makePrismaStub();

    // Still refuses without an operator-supplied password — the demo constant
    // is not a fallback for the general seed path.
    await expect(
      seedUsers({ env: { NODE_ENV: "development" }, prismaClient: prisma, hash: fakeHash })
    ).rejects.toThrow(SeedConfigError);
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it("leaves the password policy itself untouched", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(isValidPassword("1234567")).toBe(false);
  });
});
