import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Security pass — public self-service registration is closed by default.
//
// ThreatNeXus holds constituent exposure evidence, and its least-privileged
// role (VIEWER) legitimately carries read:dashboard, read:findings and
// read:cases. Both facts are correct on their own. Composed with an OPEN
// POST /api/auth/register they were not: any anonymous caller could mint a
// VIEWER and then read every finding (victim address, port, owning
// organization), every case and the operational dashboard.
//
// auth.test.js sets ALLOW_PUBLIC_REGISTRATION=true so it can describe how the
// endpoint behaves once an operator opens it. This file exists so that
// decision cannot hide the shipped default: here the variable is ABSENT, and
// absent must mean closed.

const path = require("path");
const request = require("supertest");

// Each case builds its OWN app so it can vary ALLOW_PUBLIC_REGISTRATION, and
// loadApp() drops every src/ module from the require cache to do it. That
// makes each test re-import the whole application graph — around 20s of
// imports for the file, most of it on the first call. The default 5s timeout
// measures module loading here, not the behaviour under test.
vi.setConfig({ testTimeout: 30000 });

const JWT_SECRET = "registration-closed-suite-secret-value-32-plus";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
};

// Counts every data-layer touch, so "refused before doing any work" is an
// assertion rather than a claim about reading the source.
const calls = { findUnique: 0, create: 0 };
const auditLogs = [];

const prismaStub = {
  user: {
    findUnique: async () => {
      calls.findUnique += 1;
      return null;
    },
    create: async ({ data, select }) => {
      calls.create += 1;
      const row = { id: 1, createdAt: new Date("2026-01-01T00:00:00.000Z"), ...data };
      if (!select) return { ...row };
      const out = {};
      Object.keys(select).forEach((k) => {
        if (select[k]) out[k] = row[k];
      });
      return out;
    },
  },
  auditLog: {
    create: async ({ data }) => {
      const row = { id: auditLogs.length + 1, ...data };
      auditLogs.push(row);
      return row;
    },
  },
};

function loadApp(envOverrides = {}) {
  Object.assign(process.env, BASE_ENV, envOverrides);

  const prismaPath = require.resolve("../../src/config/prisma");
  const marker = `${path.sep}src${path.sep}`;
  Object.keys(require.cache).forEach((key) => {
    if (key.includes(marker)) delete require.cache[key];
  });
  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: prismaStub,
  };

  return require("../../src/app");
}

const VALID_PAYLOAD = {
  name: "Outside Caller",
  email: "outside-caller@example.test",
  password: "correct-horse-battery",
};

let originalEnv;
let errorSpy;
let logSpy;

beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.ALLOW_PUBLIC_REGISTRATION;
  calls.findUnique = 0;
  calls.create = 0;
  auditLogs.length = 0;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  vi.clearAllMocks();
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

describe("POST /api/auth/register — closed by default", () => {
  it("refuses with 403 when ALLOW_PUBLIC_REGISTRATION is absent", async () => {
    const app = loadApp();
    const res = await request(app).post("/api/auth/register").send(VALID_PAYLOAD);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(
      "Self-service registration is disabled. Accounts are provisioned by an administrator."
    );
  });

  it("creates no account when it refuses", async () => {
    const app = loadApp();
    await request(app).post("/api/auth/register").send(VALID_PAYLOAD);

    expect(calls.create).toBe(0);
  });

  it("refuses before any user lookup, so it is not an email-existence oracle", async () => {
    const app = loadApp();
    await request(app).post("/api/auth/register").send(VALID_PAYLOAD);

    expect(calls.findUnique).toBe(0);
  });

  it("answers identically for a registered and an unregistered address", async () => {
    const app = loadApp();
    const a = await request(app).post("/api/auth/register").send(VALID_PAYLOAD);
    const b = await request(app)
      .post("/api/auth/register")
      .send({ ...VALID_PAYLOAD, email: "someone-else@example.test" });

    expect(a.status).toBe(b.status);
    expect(a.body.message).toBe(b.body.message);
  });

  it("records the refusal as a DENIED auth.register audit event", async () => {
    const app = loadApp();
    await request(app).post("/api/auth/register").send(VALID_PAYLOAD);

    const entry = auditLogs.find((e) => e.action === "auth.register");
    expect(entry).toBeDefined();
    expect(entry.outcome).toBe("DENIED");
    expect(entry.reason).toMatch(/disabled/i);
  });

  it("does not name the environment variable that would reopen it", async () => {
    const app = loadApp();
    const res = await request(app).post("/api/auth/register").send(VALID_PAYLOAD);

    expect(JSON.stringify(res.body)).not.toMatch(/ALLOW_PUBLIC_REGISTRATION/);
  });

  it("stays closed when the flag is any value other than 'true'", async () => {
    for (const value of ["false", "", "0", "yes", "TRUE-ish"]) {
      const app = loadApp({ ALLOW_PUBLIC_REGISTRATION: value });
      const res = await request(app).post("/api/auth/register").send(VALID_PAYLOAD);
      expect(res.status, `ALLOW_PUBLIC_REGISTRATION=${JSON.stringify(value)}`).toBe(403);
    }
  });

  it("opens only on an explicit 'true'", async () => {
    const app = loadApp({ ALLOW_PUBLIC_REGISTRATION: "true" });
    const res = await request(app).post("/api/auth/register").send(VALID_PAYLOAD);

    expect(res.status).toBe(201);
    expect(calls.create).toBe(1);
  });

  it("leaves login reachable while registration is closed", async () => {
    const app = loadApp();
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: VALID_PAYLOAD.email, password: VALID_PAYLOAD.password });

    // No such user in the stub, so the generic credential refusal — the point
    // is that closing registration did not take the login route with it.
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid credentials.");
  });
});
