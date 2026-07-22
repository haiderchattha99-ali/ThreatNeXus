import { describe, it, expect, vi } from "vitest";

const {
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
} = require("../../src/scripts/seedUsers");

const VALID_PASSWORD = "a-strong-local-only-password";

// Cheap stand-in for bcrypt.hash so tests never pay real bcrypt cost and can
// assert on the exact hashed value without depending on bcrypt's output shape.
async function fakeHash(password, rounds) {
  return `HASHED(${rounds}):${password}`;
}

function makePrismaStub() {
  const upserted = [];
  const calls = { upsert: 0, delete: 0, deleteMany: 0 };
  return {
    upserted,
    calls,
    user: {
      upsert: vi.fn(async ({ where, update, create, select }) => {
        calls.upsert += 1;
        const existingIndex = upserted.findIndex((u) => u.email === where.email);
        const merged =
          existingIndex === -1
            ? { id: upserted.length + 1, ...create }
            : { ...upserted[existingIndex], ...update };

        if (existingIndex === -1) {
          upserted.push(merged);
        } else {
          upserted[existingIndex] = merged;
        }

        if (!select) return { ...merged };
        const out = {};
        Object.keys(select).forEach((key) => {
          if (select[key]) out[key] = merged[key];
        });
        return out;
      }),
      delete: vi.fn(async () => {
        calls.delete += 1;
        throw new Error("user.delete should never be called by seedUsers");
      }),
      deleteMany: vi.fn(async () => {
        calls.deleteMany += 1;
        throw new Error("user.deleteMany should never be called by seedUsers");
      }),
    },
  };
}

describe("SEED_USER_DEFINITIONS", () => {
  it("prepares exactly four seed users", () => {
    expect(SEED_USER_DEFINITIONS).toHaveLength(4);
    expect(SEED_EMAILS).toHaveLength(4);
  });

  it("covers ADMIN, ANALYST, REVIEWER and VIEWER exactly once each", () => {
    const roles = SEED_USER_DEFINITIONS.map((u) => u.role).sort();
    expect(roles).toEqual(["ADMIN", "ANALYST", "REVIEWER", "VIEWER"]);
  });

  it("uses lowercase local/demo emails", () => {
    SEED_USER_DEFINITIONS.forEach((user) => {
      expect(user.email).toBe(user.email.toLowerCase());
      expect(user.email).toMatch(/^[a-z]+@threatnexus\.local$/);
    });
  });

  it("gives every definition a non-empty name", () => {
    SEED_USER_DEFINITIONS.forEach((user) => {
      expect(typeof user.name).toBe("string");
      expect(user.name.trim()).not.toBe("");
    });
  });
});

describe("assertSafeEnvironment", () => {
  it("allows development and test environments", () => {
    expect(() => assertSafeEnvironment("development", undefined)).not.toThrow();
    expect(() => assertSafeEnvironment("test", undefined)).not.toThrow();
    expect(() => assertSafeEnvironment(undefined, undefined)).not.toThrow();
  });

  it("refuses to run when NODE_ENV=production without the override", () => {
    expect(() => assertSafeEnvironment("production", undefined)).toThrow(SeedConfigError);
    expect(() => assertSafeEnvironment("production", "true")).toThrow(SeedConfigError);
    expect(() => assertSafeEnvironment("production", "")).toThrow(SeedConfigError);
  });

  it("only proceeds in production with the exact override value", () => {
    expect(() =>
      assertSafeEnvironment("production", PRODUCTION_OVERRIDE_VALUE)
    ).not.toThrow();
  });

  it("exposes the override env var name for operators", () => {
    expect(typeof PRODUCTION_OVERRIDE_ENV).toBe("string");
    expect(PRODUCTION_OVERRIDE_ENV.length).toBeGreaterThan(0);
  });
});

describe("resolveSeedPassword", () => {
  it("fails safely when SEED_USER_PASSWORD is missing", () => {
    expect(() => resolveSeedPassword(undefined)).toThrow(SeedConfigError);
    expect(() => resolveSeedPassword(undefined)).toThrow(/SEED_USER_PASSWORD is required/i);
  });

  it("fails safely on an empty or whitespace-only password", () => {
    expect(() => resolveSeedPassword("")).toThrow(SeedConfigError);
    expect(() => resolveSeedPassword("   ")).toThrow(SeedConfigError);
  });

  it("fails safely on a weak password", () => {
    expect(() => resolveSeedPassword("short")).toThrow(SeedConfigError);
    expect(() => resolveSeedPassword("1234567")).toThrow(/password policy/i);
  });

  it("accepts a password meeting the policy", () => {
    expect(resolveSeedPassword(VALID_PASSWORD)).toBe(VALID_PASSWORD);
  });
});

describe("buildSeedUserRecords", () => {
  it("hashes the password before attaching it to any record", async () => {
    const records = await buildSeedUserRecords(VALID_PASSWORD, { hash: fakeHash });

    expect(records).toHaveLength(4);
    records.forEach((record) => {
      expect(record.password).toBe(`HASHED(10):${VALID_PASSWORD}`);
    });
  });

  it("never persists the plaintext password", async () => {
    const records = await buildSeedUserRecords(VALID_PASSWORD, { hash: fakeHash });
    const serialized = JSON.stringify(records);

    // The plaintext appears only inside the fake hash's own encoding.
    expect(serialized).not.toContain(`"${VALID_PASSWORD}"`);
  });

  it("preserves the four definitions' email/name/role unchanged", async () => {
    const records = await buildSeedUserRecords(VALID_PASSWORD, { hash: fakeHash });
    expect(records.map((r) => ({ email: r.email, name: r.name, role: r.role }))).toEqual(
      SEED_USER_DEFINITIONS.map((d) => ({ email: d.email, name: d.name, role: d.role }))
    );
  });
});

describe("upsertSeedUsers", () => {
  it("touches only the four known seed emails", async () => {
    const prisma = makePrismaStub();
    const records = await buildSeedUserRecords(VALID_PASSWORD, { hash: fakeHash });
    await upsertSeedUsers(records, prisma);

    expect(prisma.user.upsert).toHaveBeenCalledTimes(4);
    const touchedEmails = prisma.user.upsert.mock.calls.map((call) => call[0].where.email);
    expect(touchedEmails.sort()).toEqual([...SEED_EMAILS].sort());
  });

  it("never calls delete or deleteMany", async () => {
    const prisma = makePrismaStub();
    const records = await buildSeedUserRecords(VALID_PASSWORD, { hash: fakeHash });
    await upsertSeedUsers(records, prisma);

    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
    expect(prisma.calls.delete).toBe(0);
    expect(prisma.calls.deleteMany).toBe(0);
  });

  it("is idempotent: running twice updates the same four rows, no duplicates", async () => {
    const prisma = makePrismaStub();
    const records = await buildSeedUserRecords(VALID_PASSWORD, { hash: fakeHash });

    await upsertSeedUsers(records, prisma);
    await upsertSeedUsers(records, prisma);

    expect(prisma.upserted).toHaveLength(4);
    expect(prisma.user.upsert).toHaveBeenCalledTimes(8);
  });

  it("updates role/name/password on a second run with different values", async () => {
    const prisma = makePrismaStub();
    const first = await buildSeedUserRecords(VALID_PASSWORD, { hash: fakeHash });
    await upsertSeedUsers(first, prisma);

    const second = await buildSeedUserRecords("a-different-strong-password", { hash: fakeHash });
    await upsertSeedUsers(second, prisma);

    expect(prisma.upserted).toHaveLength(4);
    const admin = prisma.upserted.find((u) => u.email === "admin@threatnexus.local");
    expect(admin.password).toBe("HASHED(10):a-different-strong-password");
  });

  it("does not return password hashes to the caller", async () => {
    const prisma = makePrismaStub();
    const records = await buildSeedUserRecords(VALID_PASSWORD, { hash: fakeHash });
    const results = await upsertSeedUsers(records, prisma);

    results.forEach((result) => {
      expect(result.password).toBeUndefined();
      expect(Object.keys(result).sort()).toEqual(["email", "id", "name", "role"]);
    });
  });
});

describe("seedUsers (end to end with mocked prisma/bcrypt)", () => {
  it("refuses to run in production even with a valid password", async () => {
    const prisma = makePrismaStub();
    await expect(
      seedUsers({
        env: { NODE_ENV: "production", SEED_USER_PASSWORD: VALID_PASSWORD },
        prismaClient: prisma,
        hash: fakeHash,
      })
    ).rejects.toThrow(SeedConfigError);

    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it("fails safely without touching the database when the password is missing", async () => {
    const prisma = makePrismaStub();
    await expect(
      seedUsers({ env: { NODE_ENV: "development" }, prismaClient: prisma, hash: fakeHash })
    ).rejects.toThrow(/SEED_USER_PASSWORD is required/i);

    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it("fails safely without touching the database when the password is weak", async () => {
    const prisma = makePrismaStub();
    await expect(
      seedUsers({
        env: { NODE_ENV: "development", SEED_USER_PASSWORD: "weak" },
        prismaClient: prisma,
        hash: fakeHash,
      })
    ).rejects.toThrow(/password policy/i);

    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it("seeds exactly four users end to end with hashed passwords", async () => {
    const prisma = makePrismaStub();
    const results = await seedUsers({
      env: { NODE_ENV: "development", SEED_USER_PASSWORD: VALID_PASSWORD },
      prismaClient: prisma,
      hash: fakeHash,
    });

    expect(results).toHaveLength(4);
    expect(prisma.upserted.every((u) => u.password.startsWith("HASHED(10):"))).toBe(true);
    expect(JSON.stringify(prisma.upserted)).not.toContain(`"${VALID_PASSWORD}"`);
  });

  it("allows production only with the exact override value", async () => {
    const prisma = makePrismaStub();
    const results = await seedUsers({
      env: {
        NODE_ENV: "production",
        SEED_USER_PASSWORD: VALID_PASSWORD,
        [PRODUCTION_OVERRIDE_ENV]: PRODUCTION_OVERRIDE_VALUE,
      },
      prismaClient: prisma,
      hash: fakeHash,
    });

    expect(results).toHaveLength(4);
  });
});
