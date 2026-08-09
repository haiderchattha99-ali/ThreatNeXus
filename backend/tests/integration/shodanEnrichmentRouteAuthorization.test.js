import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Phase 8E — authorization matrix and redaction proof for the Shodan
// routes:
//   GET  /api/findings/:id/enrichment/shodan   (read:findings)
//   POST /api/findings/:id/enrichment/shodan   (trigger:finding-enrichment)
// Mirrors greyNoiseEnrichmentRouteAuthorization.test.js's shape: only Prisma
// is stubbed, so the real routes/middleware/controllers/services run end to
// end. Every fetchImpl is injected via the module cache override below —
// zero real network access anywhere in this suite.

const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";
const SECRET_KEY = "SECRET-SHODAN-API-KEY-MUST-NOT-LEAK";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
  SHODAN_API_KEY: SECRET_KEY,
};

const store = {
  findings: [],
  shodanEnrichments: [],
  auditLogs: [],
  nextId: 1,
};

const prismaStub = {
  finding: {
    findUnique: async ({ where: { id } }) => store.findings.find((r) => r.id === id) || null,
  },
  shodanEnrichment: {
    findMany: async ({ where = {} }) => {
      let rows = store.shodanEnrichments.filter((r) => r.indicator === where.indicator);
      rows = [...rows].sort((a, b) => b.queriedAt.getTime() - a.queriedAt.getTime());
      return rows;
    },
    create: async ({ data }) => {
      const row = { id: store.nextId++, createdAt: new Date(), ...data };
      store.shodanEnrichments.push(row);
      return { ...row };
    },
  },
  auditLog: {
    create: async ({ data }) => {
      const row = { id: store.auditLogs.length + 1, ...data };
      store.auditLogs.push(row);
      return row;
    },
  },
};

let originalEnv;
let app;
const tokens = {};

function fakeSuccessFetch() {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      ip_str: "203.0.113.40",
      hostnames: ["example-host.test"],
      org: "Example Org",
      isp: "Example ISP",
      country_name: "United States",
      country_code: "US",
      city: "Ashburn",
      data: [{ port: 22, transport: "tcp", product: "OpenSSH", version: "8.9" }],
      vulns: ["CVE-2023-12345"],
      last_update: "2026-08-07T00:00:00.000000",
    }),
  });
}

beforeAll(() => {
  originalEnv = { ...process.env };
  Object.assign(process.env, BASE_ENV);

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

  app = require("../../src/app");

  ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"].forEach((role, index) => {
    tokens[role] = jwt.sign(
      { id: index + 1, email: `${role.toLowerCase()}@example.test`, role },
      JWT_SECRET
    );
  });

  // Production always resolves globalThis.fetch inside shodanExecutionService.js
  // (buildProvider never accepts a test fetchImpl there — only this script's
  // own smoke command does). This suite proxies globalThis.fetch instead, so
  // "the real code path" is what's under test, and every response body is
  // fully controlled and contains zero live data.
  globalThis.fetch = fakeSuccessFetch();
});

afterAll(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
  delete globalThis.fetch;
});

let errorSpy;
let logSpy;

beforeEach(() => {
  store.findings = [{ id: 1, indicatorValue: "203.0.113.40", status: "OPEN" }];
  store.shodanEnrichments = [];
  store.auditLogs = [];
  store.nextId = 1;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  vi.clearAllMocks();
});

function auth(req, role) {
  return role === null ? req : req.set("Authorization", `Bearer ${tokens[role]}`);
}

describe("GET /api/findings/:id/enrichment/shodan — read:findings", () => {
  const READ_ROLES = ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"];

  it.each(READ_ROLES)("%s can read Shodan enrichment history", async (role) => {
    const res = await auth(request(app).get("/api/findings/1/enrichment/shodan"), role);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("records");
    expect(res.body.data.provider).toBe("shodan");
  });

  it("returns 401 for an unauthenticated read", async () => {
    const res = await request(app).get("/api/findings/1/enrichment/shodan");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a nonexistent finding", async () => {
    const res = await auth(request(app).get("/api/findings/999/enrichment/shodan"), "ADMIN");
    expect(res.status).toBe(404);
  });

  it("never leaks SHODAN_API_KEY in the response body", async () => {
    const res = await auth(request(app).post("/api/findings/1/enrichment/shodan"), "ADMIN").send({});
    expect(res.status).toBe(200);
    const read = await auth(request(app).get("/api/findings/1/enrichment/shodan"), "ADMIN");
    const serialized = JSON.stringify(read.body) + JSON.stringify(res.body);
    expect(serialized).not.toContain(SECRET_KEY);
  });
});

describe("POST /api/findings/:id/enrichment/shodan — trigger:finding-enrichment is ADMIN + ANALYST only", () => {
  const ALLOWED_ROLES = ["ADMIN", "ANALYST"];
  const DENIED_ROLES = ["REVIEWER", "VIEWER"];

  it.each(ALLOWED_ROLES)("%s can trigger a Shodan lookup", async (role) => {
    const res = await auth(request(app).post("/api/findings/1/enrichment/shodan"), role).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe("SUCCESS");
    expect(res.body.data.record.organization).toBe("Example Org");
    expect(res.body.data.record.services).toHaveLength(1);
    expect(store.shodanEnrichments).toHaveLength(1);
  });

  it.each(DENIED_ROLES)("%s is denied with 403 and no lookup is attempted", async (role) => {
    const res = await auth(request(app).post("/api/findings/1/enrichment/shodan"), role).send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Forbidden.");
    expect(store.shodanEnrichments).toHaveLength(0);
  });

  it("returns 401 for an unauthenticated request, and triggers nothing", async () => {
    const res = await request(app).post("/api/findings/1/enrichment/shodan").send({});
    expect(res.status).toBe(401);
    expect(store.shodanEnrichments).toHaveLength(0);
  });

  it("returns 404 for a nonexistent finding, and audits nothing", async () => {
    const res = await auth(request(app).post("/api/findings/999/enrichment/shodan"), "ADMIN").send({});
    expect(res.status).toBe(404);
    expect(store.auditLogs).toHaveLength(0);
  });

  it("writes an attempted + succeeded audit pair with no secret and no raw upstream body", async () => {
    await auth(request(app).post("/api/findings/1/enrichment/shodan"), "ADMIN").send({});
    const actions = store.auditLogs.map((e) => e.action);
    expect(actions).toEqual(["shodan.lookup.attempted", "shodan.lookup.succeeded"]);
    const serialized = JSON.stringify(store.auditLogs);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toMatch(/"org":"Example Org"/); // the raw upstream body, never audited
  });
});
