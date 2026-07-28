import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Authorization matrix for the P2-T2e-2 enrichment routes:
//   GET  /api/findings/:id/enrichments   (read:findings)
//   POST /api/findings/:id/enrichment    (trigger:finding-enrichment)
//   POST /api/enrichment/batches/run     (execute:enrichment-batch)
// Mirrors ownershipRouteAuthorization.test.js's shape: only Prisma is
// stubbed, so the real routes/middleware/controllers/services run end to
// end. Zero real network access anywhere — the batch route's runtime import
// never calls a provider when there are no PENDING candidates to claim.

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

const store = {
  findings: [],
  iocEnrichments: [],
  auditLogs: [],
  nextId: 1,
};

function matches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND" && Array.isArray(condition)) {
      return condition.every((clause) => matches(row, clause));
    }
    if (key === "OR" && Array.isArray(condition)) {
      return condition.some((clause) => matches(row, clause));
    }
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      if ("in" in condition) return condition.in.includes(row[key]);
      if ("not" in condition) return row[key] !== condition.not;
      if ("lte" in condition) return row[key] <= condition.lte;
      if ("gte" in condition) return row[key] >= condition.gte;
      if ("gt" in condition) return row[key] instanceof Date && row[key].getTime() > condition.gt.getTime();
      return true;
    }
    return row[key] === condition;
  });
}

const prismaStub = {
  finding: {
    findUnique: async ({ where: { id } }) => store.findings.find((r) => r.id === id) || null,
  },
  iocEnrichment: {
    findFirst: async ({ where = {} }) => {
      const rows = store.iocEnrichments.filter((r) => matches(r, where));
      rows.sort((a, b) => {
        const aq = a.queriedAt ? a.queriedAt.getTime() : -Infinity;
        const bq = b.queriedAt ? b.queriedAt.getTime() : -Infinity;
        if (aq !== bq) return bq - aq;
        return b.id - a.id;
      });
      return rows[0] || null;
    },
    findUnique: async ({ where }) => {
      if (where.activeCacheKey !== undefined) {
        return store.iocEnrichments.find((r) => r.activeCacheKey === where.activeCacheKey) || null;
      }
      if (where.id !== undefined) return store.iocEnrichments.find((r) => r.id === where.id) || null;
      return null;
    },
    findMany: async ({ where = {}, orderBy = [], skip = 0, take } = {}) => {
      let rows = store.iocEnrichments.filter((r) => matches(r, where));
      rows = [...rows].sort((a, b) => {
        for (const clause of orderBy) {
          const [field, dir] = Object.entries(clause)[0];
          const av = a[field] instanceof Date ? a[field].getTime() : a[field] ?? -Infinity;
          const bv = b[field] instanceof Date ? b[field].getTime() : b[field] ?? -Infinity;
          if (av !== bv) return dir === "desc" ? bv - av : av - bv;
        }
        return 0;
      });
      return rows.slice(skip, take ? skip + take : undefined);
    },
    count: async ({ where = {} } = {}) => store.iocEnrichments.filter((r) => matches(r, where)).length,
    create: async ({ data }) => {
      const row = { id: store.nextId++, createdAt: new Date(), updatedAt: new Date(), ...data };
      store.iocEnrichments.push(row);
      return { ...row };
    },
    updateMany: async () => ({ count: 0 }),
  },
  auditLog: {
    create: async ({ data }) => {
      const row = { id: store.auditLogs.length + 1, ...data };
      store.auditLogs.push(row);
      return row;
    },
  },
  $transaction: async (fn) => fn(prismaStub),
};

let originalEnv;
let app;
const tokens = {};

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
});

afterAll(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

let errorSpy;
let logSpy;

beforeEach(() => {
  store.findings = [{ id: 1, indicatorValue: "203.0.113.40", status: "OPEN" }];
  store.iocEnrichments = [];
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

describe("GET /api/findings/:id/enrichments — read:findings", () => {
  const READ_ROLES = ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"];

  it.each(READ_ROLES)("%s can read enrichment context", async (role) => {
    const res = await auth(request(app).get("/api/findings/1/enrichments"), role);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("current");
    expect(res.body.data).toHaveProperty("activeJob");
    expect(res.body.data).toHaveProperty("history");
    expect(res.body.data).toHaveProperty("pagination");
  });

  it("returns 401 for an unauthenticated read", async () => {
    const res = await request(app).get("/api/findings/1/enrichments");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a nonexistent finding", async () => {
    const res = await auth(request(app).get("/api/findings/999/enrichments"), "ADMIN");
    expect(res.status).toBe(404);
  });

  it("never leaks cacheKey/claimToken in the response body", async () => {
    store.iocEnrichments.push({
      id: 1,
      provider: "abuseipdb",
      indicatorType: "IPV4",
      indicator: "203.0.113.40",
      cacheKey: "SECRET-CACHE-KEY",
      claimToken: "SECRET-CLAIM-TOKEN",
      status: "SUCCESS",
      queriedAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 3600000),
      requestedAt: new Date(Date.now() - 2000),
      abuseConfidenceScore: 10,
    });
    const res = await auth(request(app).get("/api/findings/1/enrichments"), "ADMIN");
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("SECRET-CACHE-KEY");
    expect(serialized).not.toContain("SECRET-CLAIM-TOKEN");
  });
});

describe("POST /api/findings/:id/enrichment — trigger:finding-enrichment is ADMIN + ANALYST only", () => {
  const ALLOWED_ROLES = ["ADMIN", "ANALYST"];
  const DENIED_ROLES = ["REVIEWER", "VIEWER"];

  it.each(ALLOWED_ROLES)("%s can schedule enrichment", async (role) => {
    const res = await auth(request(app).post("/api/findings/1/enrichment"), role).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe("SCHEDULED");
    expect(store.iocEnrichments).toHaveLength(1);
  });

  it.each(DENIED_ROLES)("%s is denied with 403 and schedules nothing", async (role) => {
    const res = await auth(request(app).post("/api/findings/1/enrichment"), role).send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Forbidden.");
    expect(store.iocEnrichments).toHaveLength(0);
    const denied = store.auditLogs.filter((e) => e.action === "authorization.denied");
    expect(denied).toHaveLength(1);
  });

  it("returns 401 for an unauthenticated request, and schedules nothing", async () => {
    const res = await request(app).post("/api/findings/1/enrichment").send({});
    expect(res.status).toBe(401);
    expect(store.iocEnrichments).toHaveLength(0);
  });

  it("force=true without justification is rejected with 400", async () => {
    const res = await auth(request(app).post("/api/findings/1/enrichment"), "ANALYST").send({
      force: true,
    });
    expect(res.status).toBe(400);
    expect(store.iocEnrichments).toHaveLength(0);
  });

  it("a denied caller's request never reaches the scheduling service, even with force=true", async () => {
    const res = await auth(request(app).post("/api/findings/1/enrichment"), "VIEWER").send({
      force: true,
      justification: "trying anyway",
    });
    expect(res.status).toBe(403);
    expect(store.iocEnrichments).toHaveLength(0);
  });
});

describe("POST /api/enrichment/batches/run — execute:enrichment-batch is ADMIN only", () => {
  const DENIED_ROLES = ["ANALYST", "REVIEWER", "VIEWER"];

  it("ADMIN can run a bounded batch", async () => {
    const res = await auth(request(app).post("/api/enrichment/batches/run"), "ADMIN").send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("candidateCount");
    expect(res.body.data).toHaveProperty("results");
    expect(res.body.data.candidateCount).toBe(0);
    // Never a workerId, indicator, cacheKey or claimToken in the response.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("workerId");
    expect(serialized).not.toContain("cacheKey");
    expect(serialized).not.toContain("claimToken");
  });

  it.each(DENIED_ROLES)("%s is denied with 403 and no batch executes", async (role) => {
    const res = await auth(request(app).post("/api/enrichment/batches/run"), role).send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Forbidden.");
    const requested = store.auditLogs.filter((e) => e.action === "enrichment.batch.requested");
    expect(requested).toHaveLength(0);
  });

  it("returns 401 for an unauthenticated request", async () => {
    const res = await request(app).post("/api/enrichment/batches/run").send({});
    expect(res.status).toBe(401);
  });

  it("rejects a batchSize above the runner's upper bound with 400, never executing", async () => {
    const res = await auth(request(app).post("/api/enrichment/batches/run"), "ADMIN").send({
      batchSize: 999999,
    });
    expect(res.status).toBe(400);
    const requested = store.auditLogs.filter((e) => e.action === "enrichment.batch.requested");
    expect(requested).toHaveLength(0);
  });

  it("ignores a caller-supplied workerId entirely", async () => {
    const res = await auth(request(app).post("/api/enrichment/batches/run"), "ADMIN").send({
      workerId: "attacker-supplied-worker",
    });
    expect(res.status).toBe(200);
    const requested = store.auditLogs.filter((e) => e.action === "enrichment.batch.requested");
    expect(requested).toHaveLength(1);
    expect(requested[0].after.workerId).not.toBe("attacker-supplied-worker");
  });
});
