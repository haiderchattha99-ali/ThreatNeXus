import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Lightweight smoke test for docs/API_CONTRACT_PHASE0.md: it checks that the
// documented routes exist and return the documented shape, so the doc can't
// silently drift from the code. It deliberately does NOT re-test credential
// handling, token edge cases, or write-audit behavior — those are covered in
// depth by tests/integration/auth.test.js, tests/unit/authMiddleware.test.js
// and tests/integration/threatWriteAudit.test.js respectively.

const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
};

// Only Prisma is replaced — routing, middleware and controllers all run for
// real, so this stays database-free like the rest of the suite.
const prismaStub = {
  threat: {
    count: async () => 0,
    findMany: async () => [],
  },
  user: {
    findUnique: async () => null,
  },
};

let originalEnv;
let app;
let token;

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
  token = jwt.sign({ id: 1, email: "contract@example.test", role: "VIEWER" }, JWT_SECRET);
});

afterAll(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

function auth(req) {
  return req.set("Authorization", `Bearer ${token}`);
}

describe("API contract — health and 404", () => {
  it("GET / reports the project name", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.project).toBe("ThreatNeXus");
  });

  it("an undocumented route returns the documented 404 shape", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: "Route not found" });
  });
});

describe("API contract — every protected route requires auth", () => {
  const protectedRoutes = [
    ["get", "/api/profile"],
    ["get", "/api/dashboard/stats"],
    ["get", "/api/dashboard/charts"],
    ["get", "/api/threats"],
    ["get", "/api/threats/search"],
    ["post", "/api/threats/upload"],
    ["patch", "/api/threats/1/status"],
    ["delete", "/api/threats/1"],
  ];

  it.each(protectedRoutes)(
    "%s %s returns 401 with the documented message when unauthenticated",
    async (method, routePath) => {
      const res = await request(app)[method](routePath);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        message: "Authentication required.",
      });
    }
  );
});

describe("API contract — documented success shapes", () => {
  it("GET /api/profile echoes id/email/role only", async () => {
    const res = await auth(request(app).get("/api/profile"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, loggedInUser: { role: "VIEWER" } });
    expect(Object.keys(res.body.loggedInUser).sort()).toEqual(["email", "id", "role"]);
  });

  it("GET /api/dashboard/stats returns the documented count fields", async () => {
    const res = await auth(request(app).get("/api/dashboard/stats"));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Object.keys(res.body.data).sort()).toEqual(
      [
        "critical",
        "domain",
        "high",
        "ipv4",
        "ipv6",
        "low",
        "md5",
        "medium",
        "newThreats",
        "sha1",
        "sha256",
        "totalThreats",
      ].sort()
    );
  });

  it("GET /api/dashboard/charts returns severity/status/iocTypes arrays", async () => {
    const res = await auth(request(app).get("/api/dashboard/charts"));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Object.keys(res.body.data).sort()).toEqual(["iocTypes", "severity", "status"]);
  });

  it("GET /api/threats returns the documented pagination shape", async () => {
    const res = await auth(request(app).get("/api/threats"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      page: 1,
      limit: 10,
      totalRecords: 0,
      totalPages: 0,
      data: [],
    });
  });

  it("GET /api/threats/search returns the documented total/data shape", async () => {
    const res = await auth(request(app).get("/api/threats/search"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, total: 0, data: [] });
  });

  it("POST /api/threats/upload with no file returns the documented 400", async () => {
    const res = await auth(request(app).post("/api/threats/upload"));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      message: "Please upload a CSV file.",
    });
  });
});
