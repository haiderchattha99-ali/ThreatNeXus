import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Route-level authorization matrix for Phase 0. Proves that the capability
// guards wired into threatRoutes.js / dashboardRoutes.js actually gate each
// route per role — the enforcement counterpart to tests/unit/requireRole.test.js
// (which tests the middleware in isolation) and tests/unit/roles.test.js
// (which tests the capability model).

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

// Only Prisma is stubbed; the real routes, middleware chain and controllers run.
const store = { threats: [], auditLogs: [], nextThreatId: 1 };

const prismaStub = {
  threat: {
    count: async () => store.threats.length,
    findMany: async () => [...store.threats],
    findFirst: async () => null,
    findUnique: async ({ where }) =>
      store.threats.find((t) => t.id === where.id) || null,
    create: async ({ data }) => {
      const row = { id: store.nextThreatId++, createdAt: new Date(), ...data };
      store.threats.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = store.threats.find((t) => t.id === where.id);
      Object.assign(row, data);
      return { ...row };
    },
    delete: async ({ where }) => {
      const index = store.threats.findIndex((t) => t.id === where.id);
      const [removed] = store.threats.splice(index, 1);
      return removed;
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
  // A signed token carrying a role the system does not recognise.
  tokens.UNKNOWN = jwt.sign(
    { id: 99, email: "ghost@example.test", role: "superuser" },
    JWT_SECRET
  );
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
  store.threats = [];
  store.auditLogs = [];
  store.nextThreatId = 1;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  vi.clearAllMocks();
});

const CSV_BODY = "ip,domain,hash,severity,source\n8.8.8.8,,,High,CSV\n";

function seedThreat() {
  const row = {
    id: store.nextThreatId++,
    ip: "1.1.1.1",
    domain: null,
    hash: null,
    severity: "High",
    source: "CSV",
    riskScore: 80,
    status: "New",
    iocType: "IP",
    createdAt: new Date(),
  };
  store.threats.push(row);
  return row;
}

// Issues each request as the given role. Returns the supertest response.
function callAs(role, action, threatId) {
  const bearer = (req) =>
    role === null ? req : req.set("Authorization", `Bearer ${tokens[role]}`);

  switch (action) {
    case "readDashboardStats":
      return bearer(request(app).get("/api/dashboard/stats"));
    case "readDashboardCharts":
      return bearer(request(app).get("/api/dashboard/charts"));
    case "readThreats":
      return bearer(request(app).get("/api/threats"));
    case "searchThreats":
      return bearer(request(app).get("/api/threats/search"));
    case "upload":
      return bearer(request(app).post("/api/threats/upload")).attach(
        "file",
        Buffer.from(CSV_BODY),
        "threats.csv"
      );
    case "updateStatus":
      return bearer(request(app).patch(`/api/threats/${threatId}/status`)).send({
        status: "Investigating",
      });
    case "delete":
      return bearer(request(app).delete(`/api/threats/${threatId}`));
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

const READ_ACTIONS = [
  "readDashboardStats",
  "readDashboardCharts",
  "readThreats",
  "searchThreats",
];
const WRITE_ACTIONS = ["upload", "updateStatus", "delete"];
const ALL_ACTIONS = [...READ_ACTIONS, ...WRITE_ACTIONS];

describe("unauthenticated access", () => {
  it.each(ALL_ACTIONS)("%s returns 401, not 403", async (action) => {
    const threat = seedThreat();
    const res = await callAs(null, action, threat.id);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Authentication required.");
  });

  it("performs no write and records no audit when unauthenticated", async () => {
    const threat = seedThreat();
    await callAs(null, "delete", threat.id);
    await callAs(null, "updateStatus", threat.id);

    expect(store.threats).toHaveLength(1);
    expect(store.auditLogs).toHaveLength(0);
  });
});

describe("VIEWER", () => {
  it.each(READ_ACTIONS)("can %s", async (action) => {
    const res = await callAs("VIEWER", action);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it.each(WRITE_ACTIONS)("cannot %s", async (action) => {
    const threat = seedThreat();
    const res = await callAs("VIEWER", action, threat.id);
    expect(res.status).toBe(403);
  });

  it("leaves data untouched when denied", async () => {
    const threat = seedThreat();
    await callAs("VIEWER", "delete", threat.id);
    await callAs("VIEWER", "updateStatus", threat.id);
    await callAs("VIEWER", "upload");

    expect(store.threats).toHaveLength(1);
    expect(store.threats[0].status).toBe("New");
  });
});

describe("REVIEWER", () => {
  it.each(READ_ACTIONS)("can %s", async (action) => {
    const res = await callAs("REVIEWER", action);
    expect(res.status).toBe(200);
  });

  // REVIEWER approves work; it does not ingest, triage or delete it.
  it.each(WRITE_ACTIONS)("cannot %s", async (action) => {
    const threat = seedThreat();
    const res = await callAs("REVIEWER", action, threat.id);
    expect(res.status).toBe(403);
  });
});

describe("ANALYST", () => {
  it.each(READ_ACTIONS)("can %s", async (action) => {
    const res = await callAs("ANALYST", action);
    expect(res.status).toBe(200);
  });

  it("can upload reports", async () => {
    const res = await callAs("ANALYST", "upload");
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
  });

  it("can update threat status", async () => {
    const threat = seedThreat();
    const res = await callAs("ANALYST", "updateStatus", threat.id);

    expect(res.status).toBe(200);
    expect(store.threats[0].status).toBe("Investigating");
  });

  // Separation of duties: doing the work does not confer the right to destroy it.
  it("cannot delete records", async () => {
    const threat = seedThreat();
    const res = await callAs("ANALYST", "delete", threat.id);

    expect(res.status).toBe(403);
    expect(store.threats).toHaveLength(1);
  });
});

describe("ADMIN", () => {
  it.each(ALL_ACTIONS)("can %s", async (action) => {
    const threat = seedThreat();
    const res = await callAs("ADMIN", action, threat.id);
    expect(res.status).toBe(200);
  });

  it("can delete records", async () => {
    const threat = seedThreat();
    const res = await callAs("ADMIN", "delete", threat.id);

    expect(res.status).toBe(200);
    expect(store.threats).toHaveLength(0);
  });
});

describe("unrecognised role fails closed", () => {
  // A token can only carry an unknown role if it was signed with our secret,
  // but the guard must still refuse rather than fall back to VIEWER's reads.
  it.each(ALL_ACTIONS)("is denied %s", async (action) => {
    const threat = seedThreat();
    const res = await callAs("UNKNOWN", action, threat.id);
    expect(res.status).toBe(403);
  });
});

describe("denied responses are generic", () => {
  it("returns a fixed message with no capability or role detail", async () => {
    const threat = seedThreat();
    const res = await callAs("VIEWER", "delete", threat.id);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Forbidden.");

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("delete:records");
    expect(serialized).not.toContain("VIEWER");
    expect(serialized).not.toContain("capability");
  });

  it("returns the same body regardless of which capability was missing", async () => {
    const threat = seedThreat();

    const deleteRes = await callAs("VIEWER", "delete", threat.id);
    const updateRes = await callAs("VIEWER", "updateStatus", threat.id);
    const uploadRes = await callAs("VIEWER", "upload");

    expect(deleteRes.body.message).toBe(updateRes.body.message);
    expect(updateRes.body.message).toBe(uploadRes.body.message);
  });

  it("carries a requestId for correlation", async () => {
    const threat = seedThreat();
    const res = await callAs("VIEWER", "delete", threat.id);

    expect(typeof res.body.requestId).toBe("string");
    expect(res.headers["x-request-id"]).toBe(res.body.requestId);
  });
});

describe("denied requests are audited", () => {
  it("records an authorization.denied event with DENIED outcome", async () => {
    const threat = seedThreat();
    await callAs("VIEWER", "delete", threat.id);

    const denied = store.auditLogs.filter(
      (entry) => entry.action === "authorization.denied"
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      outcome: "DENIED",
      entityType: "Authorization",
      tlp: "AMBER",
      method: "DELETE",
      actorRole: "VIEWER",
      actorEmail: "viewer@example.test",
    });
  });

  it("keeps the required capability server-side in the audit reason only", async () => {
    const threat = seedThreat();
    const res = await callAs("VIEWER", "delete", threat.id);

    const [denied] = store.auditLogs.filter(
      (e) => e.action === "authorization.denied"
    );
    // Useful for investigation in the audit trail...
    expect(denied.reason).toMatch(/delete:records/);
    // ...but never disclosed to the caller.
    expect(JSON.stringify(res.body)).not.toContain("delete:records");
  });

  it("does not audit the bearer token, cookies or raw headers", async () => {
    const threat = seedThreat();
    await callAs("VIEWER", "delete", threat.id);

    const serialized = JSON.stringify(store.auditLogs);
    expect(serialized).not.toContain(tokens.VIEWER);
    expect(serialized).not.toContain("Bearer");
    store.auditLogs.forEach((entry) => {
      expect(entry.headers).toBeUndefined();
      expect(entry.cookies).toBeUndefined();
    });
  });

  it("does not emit a denial audit for an allowed request", async () => {
    await callAs("VIEWER", "readThreats");

    expect(
      store.auditLogs.filter((e) => e.action === "authorization.denied")
    ).toHaveLength(0);
  });
});

describe("upload authorization runs before any file is written", () => {
  // Denying before multer means an unauthorized caller cannot cause a temp
  // file to be created at all, so there is nothing for cleanup to reclaim.
  it("denies a VIEWER upload without importing anything", async () => {
    const res = await callAs("VIEWER", "upload");

    expect(res.status).toBe(403);
    expect(store.threats).toHaveLength(0);
    expect(
      store.auditLogs.filter((e) => e.action === "threat.import")
    ).toHaveLength(0);
  });

  it("still cleans up and imports normally for an authorized ANALYST", async () => {
    const res = await callAs("ANALYST", "upload");

    expect(res.status).toBe(200);
    expect(store.threats).toHaveLength(1);
  });
});
