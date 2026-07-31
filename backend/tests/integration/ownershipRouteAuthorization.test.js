import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Authorization matrix for the P2-T1 ownership routes: /api/ownership/* (the
// AssetMapping registry + coverage) and /api/findings/:id/ownership* (finding
// ownership reads + analyst override). Mirrors
// resourceRouteAuthorization.test.js's shape: only Prisma is stubbed, so the
// real routes/middleware/controllers run end to end.

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
  organizations: [],
  findings: [],
  assetMappings: [],
  findingOwnerships: [],
  auditLogs: [],
  nextId: 1,
};

// Operator support mirrors tests/unit/findingOwnershipService.test.js: AND/OR,
// startsWith, in and gt were added for the database-pushed ownership candidate
// selection. Without them this stub would match everything and the new
// re-resolution assertions below would pass vacuously.
function matches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return condition.every((clause) => matches(row, clause));
    if (key === "OR") return condition.some((clause) => matches(row, clause));
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      if ("not" in condition) return row[key] !== condition.not;
      if ("lte" in condition) return row[key] <= condition.lte;
      if ("gte" in condition) return row[key] >= condition.gte;
      if ("gt" in condition) return row[key] > condition.gt;
      if ("lt" in condition) return row[key] < condition.lt;
      if ("in" in condition) return condition.in.includes(row[key]);
      if ("startsWith" in condition) {
        return typeof row[key] === "string" && row[key].startsWith(condition.startsWith);
      }
      return true;
    }
    return row[key] === condition;
  });
}
function matchesOr(row, orConditions) {
  return orConditions.some((cond) => matches(row, cond));
}
function applyOrderAndTake(rows, orderBy, take) {
  const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  let out = rows;
  if (clauses.length > 0) {
    out = [...out].sort((a, b) => {
      for (const clause of clauses) {
        const [field, dir] = Object.entries(clause)[0];
        const av = a[field] instanceof Date ? a[field].getTime() : a[field];
        const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
        if (av !== bv) return dir === "desc" ? (bv > av ? 1 : -1) : av > bv ? 1 : -1;
      }
      return 0;
    });
  }
  return Number.isInteger(take) && take > 0 ? out.slice(0, take) : out;
}

const prismaStub = {
  organization: {
    findUnique: async ({ where: { id } }) => store.organizations.find((r) => r.id === id) || null,
  },
  finding: {
    findUnique: async ({ where: { id } }) => store.findings.find((r) => r.id === id) || null,
    findMany: async ({ where, orderBy, take } = {}) => {
      const filtered = store.findings.filter((r) => matches(r, where || {}));
      return applyOrderAndTake(filtered, orderBy, take).map((r) => ({ ...r }));
    },
    count: async () => store.findings.length,
  },
  assetMapping: {
    create: async ({ data }) => {
      const row = {
        id: store.nextId++,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      store.assetMappings.push(row);
      return { ...row };
    },
    findUnique: async ({ where: { id } }) => {
      const row = store.assetMappings.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    update: async ({ where: { id }, data }) => {
      const row = store.assetMappings.find((r) => r.id === id);
      if (!row) {
        const err = new Error("Record not found");
        err.code = "P2025";
        throw err;
      }
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
    findMany: async ({ where = {}, skip = 0, take } = {}) => {
      const rows = store.assetMappings.filter((r) => matches(r, where)).sort((a, b) => a.id - b.id);
      return rows.slice(skip, take ? skip + take : undefined).map((r) => ({ ...r }));
    },
    count: async ({ where = {} } = {}) => store.assetMappings.filter((r) => matches(r, where)).length,
  },
  findingOwnership: {
    findUnique: async ({ where }) => {
      const key = Object.keys(where)[0];
      const row = store.findingOwnerships.find((r) => r[key] === where[key]);
      return row ? { ...row } : null;
    },
    findMany: async ({ where = {}, orderBy, take } = {}) => {
      const rows = store.findingOwnerships.filter((r) => matches(r, where));
      return applyOrderAndTake(rows, orderBy, take).map((r) => ({ ...r }));
    },
    create: async ({ data }) => {
      const row = {
        id: store.nextId++,
        resolvedAt: new Date(),
        createdAt: new Date(),
        supersededAt: null,
        ...data,
      };
      store.findingOwnerships.push(row);
      return { ...row };
    },
    update: async ({ where: { id }, data }) => {
      const row = store.findingOwnerships.find((r) => r.id === id);
      Object.assign(row, data);
      return { ...row };
    },
    groupBy: async ({ by, where = {} }) => {
      const rows = store.findingOwnerships.filter((r) => matches(r, where));
      const groups = new Map();
      rows.forEach((row) => {
        const key = by.map((f) => String(row[f])).join("::");
        if (!groups.has(key)) {
          const shape = {};
          by.forEach((f) => {
            shape[f] = row[f];
          });
          groups.set(key, { ...shape, _count: { _all: 0 } });
        }
        groups.get(key)._count._all += 1;
      });
      return [...groups.values()];
    },
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
  store.organizations = [{ id: 1, name: "Acme Bank" }, { id: 2, name: "Other Org" }];
  store.findings = [{ id: 1, indicatorValue: "203.0.113.10", status: "OPEN" }];
  store.assetMappings = [];
  store.findingOwnerships = [];
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

const VALID_MAPPING = {
  organizationId: 1,
  mappingType: "EXACT_IP",
  exactIp: "203.0.113.10",
  confidence: "HIGH",
  source: "MANUAL",
};

describe("GET /api/ownership/mappings, /coverage, /api/findings/:id/ownership — reads", () => {
  const READ_ROLES = ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"];

  it.each(READ_ROLES)("%s can list mappings", async (role) => {
    const res = await auth(request(app).get("/api/ownership/mappings"), role);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pagination).toMatchObject({ page: 1 });
  });

  it.each(READ_ROLES)("%s can read coverage", async (role) => {
    const res = await auth(request(app).get("/api/ownership/coverage"), role);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("resolvedExactIp");
    expect(res.body.data).toHaveProperty("resolvedCidr");
    expect(res.body.data).toHaveProperty("resolvedOverride");
    expect(res.body.data).toHaveProperty("ispAttribution");
    expect(res.body.data).toHaveProperty("ambiguous");
    expect(res.body.data).toHaveProperty("unresolved");
  });

  it.each(READ_ROLES)("%s can read finding ownership", async (role) => {
    const res = await auth(request(app).get("/api/findings/1/ownership"), role);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("current");
    expect(res.body.data).toHaveProperty("history");
  });

  it("returns 401 for unauthenticated reads", async () => {
    const res = await request(app).get("/api/ownership/mappings");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a nonexistent finding", async () => {
    const res = await auth(request(app).get("/api/findings/999/ownership"), "ADMIN");
    expect(res.status).toBe(404);
  });
});

describe("AssetMapping mutations — manage:ownership-mappings is ADMIN only", () => {
  const DENIED_ROLES = ["ANALYST", "REVIEWER", "VIEWER"];

  it("ADMIN can create a mapping", async () => {
    const res = await auth(request(app).post("/api/ownership/mappings"), "ADMIN").send(VALID_MAPPING);
    expect(res.status).toBe(201);
    expect(res.body.data.exactIp).toBe("203.0.113.10");
    expect(res.body.data).not.toHaveProperty("ipStart");
    expect(res.body.data).not.toHaveProperty("ipEnd");
  });

  it.each(DENIED_ROLES)("%s is denied create with 403 and creates nothing", async (role) => {
    const res = await auth(request(app).post("/api/ownership/mappings"), role).send(VALID_MAPPING);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Forbidden.");
    expect(store.assetMappings).toHaveLength(0);
  });

  it("returns 401 for unauthenticated create, and creates nothing", async () => {
    const res = await request(app).post("/api/ownership/mappings").send(VALID_MAPPING);
    expect(res.status).toBe(401);
    expect(store.assetMappings).toHaveLength(0);
  });

  it("records an authorization.denied audit for a denied write, without leaking the capability in the response", async () => {
    const res = await auth(request(app).post("/api/ownership/mappings"), "VIEWER").send(VALID_MAPPING);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("manage:ownership-mappings");

    const [denied] = store.auditLogs.filter((e) => e.action === "authorization.denied");
    expect(denied).toMatchObject({ outcome: "DENIED", entityType: "Authorization" });
    expect(denied.reason).toContain("manage:ownership-mappings");
  });

  it("ADMIN can update and disable a mapping", async () => {
    const created = await auth(request(app).post("/api/ownership/mappings"), "ADMIN").send(VALID_MAPPING);
    const id = created.body.data.id;

    const updated = await auth(request(app).patch(`/api/ownership/mappings/${id}`), "ADMIN").send({
      mappingConfirmed: true,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.mappingConfirmed).toBe(true);

    const disabled = await auth(request(app).post(`/api/ownership/mappings/${id}/disable`), "ADMIN");
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.enabled).toBe(false);
  });

  it.each(DENIED_ROLES)("%s is denied update/disable with 403", async (role) => {
    const created = await auth(request(app).post("/api/ownership/mappings"), "ADMIN").send(
      VALID_MAPPING
    );
    const id = created.body.data.id;

    const updated = await auth(request(app).patch(`/api/ownership/mappings/${id}`), role).send({
      mappingConfirmed: true,
    });
    expect(updated.status).toBe(403);

    const disabled = await auth(request(app).post(`/api/ownership/mappings/${id}/disable`), role);
    expect(disabled.status).toBe(403);
  });

  it("rejects an invalid mapping (both fields wrong) with 400 and creates nothing", async () => {
    const res = await auth(request(app).post("/api/ownership/mappings"), "ADMIN").send({
      organizationId: 1,
      mappingType: "EXACT_IP",
      exactIp: "999.0.0.1",
      confidence: "MADE_UP",
      source: "MANUAL",
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(Array.isArray(res.body.fields)).toBe(true);
    expect(store.assetMappings).toHaveLength(0);
  });

  it("has no hard DELETE route for a mapping", async () => {
    const created = await auth(request(app).post("/api/ownership/mappings"), "ADMIN").send(
      VALID_MAPPING
    );
    const id = created.body.data.id;
    const res = await auth(request(app).delete(`/api/ownership/mappings/${id}`), "ADMIN");
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Route not found");
  });

  it("bounds pagination even when a huge pageSize is requested", async () => {
    const res = await auth(request(app).get("/api/ownership/mappings?pageSize=99999"), "ADMIN");
    expect(res.status).toBe(200);
    expect(res.body.pagination.pageSize).toBeLessThanOrEqual(100);
  });
});

describe("Finding ownership override — override:finding-ownership is ADMIN and ANALYST", () => {
  const ALLOWED_ROLES = ["ADMIN", "ANALYST"];
  const DENIED_ROLES = ["REVIEWER", "VIEWER"];

  it.each(ALLOWED_ROLES)("%s can apply and clear an override", async (role) => {
    const applied = await auth(request(app).put("/api/findings/1/ownership/override"), role).send({
      organizationId: 2,
      justification: "confirmed via WHOIS",
    });
    expect(applied.status).toBe(200);
    expect(applied.body.data.status).toBe("OVERRIDDEN");
    expect(applied.body.data.organizationId).toBe(2);

    const cleared = await auth(request(app).delete("/api/findings/1/ownership/override"), role).send({
      justification: "resolved automatically now",
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.status).not.toBe("OVERRIDDEN");
  });

  it.each(DENIED_ROLES)("%s is denied apply/clear with 403, before any mutation", async (role) => {
    const applied = await auth(request(app).put("/api/findings/1/ownership/override"), role).send({
      organizationId: 2,
      justification: "confirmed via WHOIS",
    });
    expect(applied.status).toBe(403);
    expect(store.findingOwnerships).toHaveLength(0);

    const cleared = await auth(request(app).delete("/api/findings/1/ownership/override"), role);
    expect(cleared.status).toBe(403);
  });

  it("returns 401 for unauthenticated override apply", async () => {
    const res = await request(app)
      .put("/api/findings/1/ownership/override")
      .send({ organizationId: 2, justification: "x" });
    expect(res.status).toBe(401);
  });

  it("rejects an override with a missing justification as 400", async () => {
    const res = await auth(request(app).put("/api/findings/1/ownership/override"), "ADMIN").send({
      organizationId: 2,
    });
    expect(res.status).toBe(400);
    expect(store.findingOwnerships).toHaveLength(0);
  });

  it("returns 404 applying an override to a nonexistent finding", async () => {
    const res = await auth(request(app).put("/api/findings/999/ownership/override"), "ADMIN").send({
      organizationId: 2,
      justification: "x",
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 clearing an override that does not exist", async () => {
    const res = await auth(request(app).delete("/api/findings/1/ownership/override"), "ADMIN");
    expect(res.status).toBe(409);
  });

  it("does not leak override:finding-ownership in a denied response body", async () => {
    const res = await auth(request(app).put("/api/findings/1/ownership/override"), "VIEWER").send({
      organizationId: 2,
      justification: "x",
    });
    expect(JSON.stringify(res.body)).not.toContain("override:finding-ownership");
  });
});

describe("bounded re-resolution continuation — ADMIN only", () => {
  const DENIED_ROLES = ["ANALYST", "REVIEWER", "VIEWER"];

  it("denies every non-ADMIN role, and never reaches the controller", async () => {
    for (const role of DENIED_ROLES) {
      const res = await auth(
        request(app).post("/api/ownership/mappings/1/re-resolve"),
        role
      ).send({ batchSize: 5 });
      expect(res.status).toBe(403);
      // A denied caller must not learn whether mapping 1 exists.
      expect(JSON.stringify(res.body)).not.toContain("manage:ownership-mappings");
    }
  });

  it("returns 401 unauthenticated", async () => {
    const res = await request(app).post("/api/ownership/mappings/1/re-resolve").send({});
    expect(res.status).toBe(401);
  });

  it("rejects caller-supplied internals rather than ignoring them", async () => {
    // Every one of these is a value the server must own: an actor, a clock, a
    // raw cursor, a resolver outcome, a risk number.
    const forbidden = [
      { actorUserId: 1 },
      { asOf: "2020-01-01T00:00:00Z" },
      { afterId: 5 },
      { cursor: 5 },
      { workerId: "w1" },
      { riskScore: 9999 },
      { confidence: "CONFIRMED" },
      { status: "RESOLVED" },
      { matchedMappingId: 2 },
    ];
    for (const body of forbidden) {
      const res = await auth(
        request(app).post("/api/ownership/mappings/1/re-resolve"),
        "ADMIN"
      ).send(body);
      expect(res.status).toBe(400);
      expect(res.body.fields).toEqual(Object.keys(body));
    }
  });

  it("rejects an out-of-range batchSize", async () => {
    for (const batchSize of [0, -1, 100000, 1.5, "10"]) {
      const res = await auth(
        request(app).post("/api/ownership/mappings/1/re-resolve"),
        "ADMIN"
      ).send({ batchSize });
      expect(res.status).toBe(400);
      expect(res.body.fields).toEqual(["batchSize"]);
    }
  });

  it("rejects a continuation token the server did not issue", async () => {
    const res = await auth(
      request(app).post("/api/ownership/mappings/1/re-resolve"),
      "ADMIN"
    ).send({ continuationToken: "eyJtIjoxLCJhIjo5OTl9.forged" });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["continuationToken"]);
  });

  it("returns 404 for a mapping that does not exist", async () => {
    const res = await auth(
      request(app).post("/api/ownership/mappings/99999/re-resolve"),
      "ADMIN"
    ).send({});
    expect(res.status).toBe(404);
  });
});

describe("ownership consistency diagnostic — ADMIN only", () => {
  it("denies every non-ADMIN role", async () => {
    for (const role of ["ANALYST", "REVIEWER", "VIEWER"]) {
      const res = await auth(request(app).post("/api/ownership/consistency-check"), role).send({});
      expect(res.status).toBe(403);
    }
  });

  it("returns 401 unauthenticated", async () => {
    const res = await request(app).post("/api/ownership/consistency-check").send({});
    expect(res.status).toBe(401);
  });

  it("rejects caller-supplied internals", async () => {
    for (const body of [{ afterId: 3 }, { asOf: "2020-01-01" }, { actorUserId: 1 }]) {
      const res = await auth(request(app).post("/api/ownership/consistency-check"), "ADMIN").send(
        body
      );
      expect(res.status).toBe(400);
      expect(res.body.fields).toEqual(Object.keys(body));
    }
  });

  it("reports aggregate counts to an ADMIN and never repairs anything", async () => {
    const before = store.findingOwnerships.map((r) => ({ ...r }));
    const res = await auth(request(app).post("/api/ownership/consistency-check"), "ADMIN").send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("checkedCount");
    expect(res.body.data).toHaveProperty("countsByCode");
    // Detection only: not one ownership row changed.
    expect(store.findingOwnerships).toEqual(before);
  });

  it("never exposes an indicator address in the report", async () => {
    const res = await auth(request(app).post("/api/ownership/consistency-check"), "ADMIN").send({});
    expect(JSON.stringify(res.body)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});

describe("no BigInt leaks through any ownership response", () => {
  it("mapping list/create responses are valid JSON with no raw ip range fields", async () => {
    await auth(request(app).post("/api/ownership/mappings"), "ADMIN").send({
      organizationId: 1,
      mappingType: "CIDR",
      cidr: "203.0.113.0/24",
      confidence: "MEDIUM",
      source: "MANUAL",
    });

    const res = await auth(request(app).get("/api/ownership/mappings"), "ADMIN");
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/"ipStart"/);
    expect(serialized).not.toMatch(/"ipEnd"/);
  });
});
