import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { UPLOAD_TEMP_DIR } = require("../../src/lib/fileCleanup");

const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
};

// Only Prisma is replaced; the real routes, multer, cleanup middleware,
// controller, auditService and error handler all run, so `npm test` still
// needs no database.
const store = {
  threats: [],
  auditLogs: [],
  nextThreatId: 1,
  failAuditWrite: false,
  failThreatCreate: false,
};

const prismaStub = {
  threat: {
    count: async () => store.threats.length,
    findMany: async () => [...store.threats],
    findFirst: async ({ where }) =>
      store.threats.find(
        (t) =>
          t.ip === (where.ip ?? null) &&
          t.domain === (where.domain ?? null) &&
          t.hash === (where.hash ?? null)
      ) || null,
    findUnique: async ({ where }) =>
      store.threats.find((t) => t.id === where.id) || null,
    create: async ({ data }) => {
      if (store.failThreatCreate) throw new Error("db write refused");
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
      if (store.failAuditWrite) throw new Error("audit backend down");
      const row = { id: store.auditLogs.length + 1, ...data };
      store.auditLogs.push(row);
      return row;
    },
  },
};

let originalEnv;
let app;
let token;
let adminToken;

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
  // ANALYST holds ingest:reports and triage:findings, so it covers the import
  // and status-update paths exercised here.
  token = jwt.sign({ id: 5, email: "analyst@example.test", role: "ANALYST" }, JWT_SECRET);
  // delete:records is ADMIN-only, so the delete paths need their own actor.
  // Route-level enforcement of that split is covered in routeAuthorization.test.js.
  adminToken = jwt.sign({ id: 9, email: "admin@example.test", role: "ADMIN" }, JWT_SECRET);
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
  store.failAuditWrite = false;
  store.failThreatCreate = false;

  fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  vi.clearAllMocks();
});

function auth(req) {
  return req.set("Authorization", `Bearer ${token}`);
}

// Used for the delete paths, which require the ADMIN-only delete:records.
function authAdmin(req) {
  return req.set("Authorization", `Bearer ${adminToken}`);
}

function seedThreat(overrides = {}) {
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
    ...overrides,
  };
  store.threats.push(row);
  return row;
}

function uploadDirFiles() {
  return fs.existsSync(UPLOAD_TEMP_DIR) ? fs.readdirSync(UPLOAD_TEMP_DIR) : [];
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

const CSV_BODY = "ip,domain,hash,severity,source\n8.8.8.8,,,High,CSV\n9.9.9.9,,,Low,CSV\n";

function auditFor(action) {
  return store.auditLogs.filter((entry) => entry.action === action);
}

describe("upload temp-file cleanup", () => {
  it("removes the temp file after a successful import", async () => {
    const before = uploadDirFiles();

    const res = await auth(request(app).post("/api/threats/upload")).attach(
      "file",
      Buffer.from(CSV_BODY),
      "threats.csv"
    );

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(2);
    expect(await waitFor(() => uploadDirFiles().length === before.length)).toBe(true);
  });

  it("removes the temp file when the database write fails", async () => {
    const before = uploadDirFiles();
    store.failThreatCreate = true;

    const res = await auth(request(app).post("/api/threats/upload")).attach(
      "file",
      Buffer.from(CSV_BODY),
      "threats.csv"
    );

    expect(res.status).toBe(500);
    expect(await waitFor(() => uploadDirFiles().length === before.length)).toBe(true);
  });

  it("never writes a client-supplied filename into the upload directory", async () => {
    await auth(request(app).post("/api/threats/upload")).attach(
      "file",
      Buffer.from(CSV_BODY),
      "../../evil-traversal.csv"
    );

    // The generated name is used instead, so nothing escapes and no
    // client-controlled name survives.
    const parent = path.resolve(UPLOAD_TEMP_DIR, "..");
    expect(fs.existsSync(path.join(parent, "evil-traversal.csv"))).toBe(false);
    expect(fs.existsSync(path.resolve(parent, "..", "evil-traversal.csv"))).toBe(false);
    expect(uploadDirFiles().some((f) => f.includes("evil-traversal"))).toBe(false);
  });

  it("does not leak a local file path in the response", async () => {
    const res = await auth(request(app).post("/api/threats/upload")).attach(
      "file",
      Buffer.from(CSV_BODY),
      "threats.csv"
    );

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("uploads");
    expect(serialized).not.toContain(UPLOAD_TEMP_DIR);
    expect(serialized).not.toMatch(/[A-Za-z]:\\|\/home\/|\/tmp\//);
  });

  it("rejects a request with no file without creating anything", async () => {
    const before = uploadDirFiles();
    const res = await auth(request(app).post("/api/threats/upload"));

    expect(res.status).toBe(400);
    expect(store.threats).toHaveLength(0);
    expect(uploadDirFiles().length).toBe(before.length);
  });

  it("still returns a successful response when cleanup fails", async () => {
    const unlinkSpy = vi
      .spyOn(fs.promises, "unlink")
      .mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));

    try {
      const res = await auth(request(app).post("/api/threats/upload")).attach(
        "file",
        Buffer.from(CSV_BODY),
        "threats.csv"
      );

      // The import succeeded; a failed unlink must not turn it into a 500.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      unlinkSpy.mockRestore();
      // Remove whatever survived the mocked failure.
      uploadDirFiles().forEach((f) => fs.rmSync(path.join(UPLOAD_TEMP_DIR, f), { force: true }));
    }
  });
});

describe("CSV import auditing", () => {
  it("audits a successful import with counts only", async () => {
    await auth(request(app).post("/api/threats/upload")).attach(
      "file",
      Buffer.from(CSV_BODY),
      "threats.csv"
    );

    const [entry] = auditFor("threat.import");
    expect(entry).toMatchObject({
      outcome: "SUCCESS",
      entityType: "Threat",
      method: "POST",
      path: "/api/threats/upload",
      actorUserId: "5",
      actorRole: "ANALYST",
    });
    expect(entry.after).toEqual({ rows: 2, added: 2, duplicates: 0 });
  });

  it("never audits raw CSV content, file paths or indicator rows", async () => {
    await auth(request(app).post("/api/threats/upload")).attach(
      "file",
      Buffer.from(CSV_BODY),
      "threats.csv"
    );

    const serialized = JSON.stringify(store.auditLogs);
    expect(serialized).not.toContain("8.8.8.8");
    expect(serialized).not.toContain("9.9.9.9");
    expect(serialized).not.toContain("uploads");
    expect(serialized).not.toContain(UPLOAD_TEMP_DIR);
    expect(serialized).not.toContain("threats.csv");
  });

  it("audits a failed import", async () => {
    store.failThreatCreate = true;
    await auth(request(app).post("/api/threats/upload")).attach(
      "file",
      Buffer.from(CSV_BODY),
      "threats.csv"
    );

    const [entry] = auditFor("threat.import");
    expect(entry.outcome).toBe("FAILURE");
    expect(entry.reason).toMatch(/persisting/i);
  });

  it("audits a missing-file rejection", async () => {
    await auth(request(app).post("/api/threats/upload"));

    const [entry] = auditFor("threat.import");
    expect(entry.outcome).toBe("FAILURE");
    expect(entry.reason).toMatch(/no file/i);
  });

  it("still imports successfully when the audit write fails", async () => {
    store.failAuditWrite = true;

    const res = await auth(request(app).post("/api/threats/upload")).attach(
      "file",
      Buffer.from(CSV_BODY),
      "threats.csv"
    );

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(2);
    expect(store.threats).toHaveLength(2);
  });
});

describe("threat update auditing", () => {
  it("audits a successful status update with before/after summaries", async () => {
    const threat = seedThreat({ status: "New" });

    const res = await auth(
      request(app).patch(`/api/threats/${threat.id}/status`)
    ).send({ status: "Investigating" });

    expect(res.status).toBe(200);

    const [entry] = auditFor("threat.update");
    expect(entry).toMatchObject({
      outcome: "SUCCESS",
      entityType: "Threat",
      entityId: String(threat.id),
      actorUserId: "5",
    });
    expect(entry.before).toEqual({
      id: threat.id,
      status: "New",
      severity: "High",
      iocType: "IP",
    });
    expect(entry.after.status).toBe("Investigating");
  });

  it("does not audit indicator values", async () => {
    const threat = seedThreat({ ip: "203.0.113.77" });
    await auth(request(app).patch(`/api/threats/${threat.id}/status`)).send({
      status: "Resolved",
    });

    expect(JSON.stringify(store.auditLogs)).not.toContain("203.0.113.77");
  });

  it("audits an invalid-status rejection as FAILURE", async () => {
    const threat = seedThreat();
    const res = await auth(request(app).patch(`/api/threats/${threat.id}/status`)).send({
      status: "Bogus",
    });

    expect(res.status).toBe(400);
    const [entry] = auditFor("threat.update");
    expect(entry.outcome).toBe("FAILURE");
    expect(entry.reason).toMatch(/invalid status/i);
  });

  it("audits a not-found rejection as FAILURE", async () => {
    const res = await auth(request(app).patch("/api/threats/999/status")).send({
      status: "Resolved",
    });

    expect(res.status).toBe(404);
    expect(auditFor("threat.update")[0].outcome).toBe("FAILURE");
  });

  it("still updates when the audit write fails", async () => {
    const threat = seedThreat({ status: "New" });
    store.failAuditWrite = true;

    const res = await auth(request(app).patch(`/api/threats/${threat.id}/status`)).send({
      status: "Mitigated",
    });

    expect(res.status).toBe(200);
    expect(store.threats[0].status).toBe("Mitigated");
  });
});

describe("threat delete auditing", () => {
  it("audits a successful delete with a before summary", async () => {
    const threat = seedThreat({ status: "Resolved", severity: "Low" });

    const res = await authAdmin(request(app).delete(`/api/threats/${threat.id}`));

    expect(res.status).toBe(200);
    expect(store.threats).toHaveLength(0);

    const [entry] = auditFor("threat.delete");
    expect(entry).toMatchObject({
      outcome: "SUCCESS",
      entityType: "Threat",
      entityId: String(threat.id),
    });
    expect(entry.before).toEqual({
      id: threat.id,
      status: "Resolved",
      severity: "Low",
      iocType: "IP",
    });
    expect(entry.after).toBeUndefined();
  });

  it("audits a not-found delete as FAILURE", async () => {
    const res = await authAdmin(request(app).delete("/api/threats/999"));

    expect(res.status).toBe(404);
    expect(auditFor("threat.delete")[0].outcome).toBe("FAILURE");
  });

  it("still deletes when the audit write fails", async () => {
    const threat = seedThreat();
    store.failAuditWrite = true;

    const res = await authAdmin(request(app).delete(`/api/threats/${threat.id}`));

    expect(res.status).toBe(200);
    expect(store.threats).toHaveLength(0);
  });
});

describe("write audits never carry credentials or raw request data", () => {
  it("omits Authorization, Cookie, token, body and query from every entry", async () => {
    const threat = seedThreat();

    await auth(request(app).patch(`/api/threats/${threat.id}/status`))
      .set("Cookie", "session=SHOULD_NOT_PERSIST")
      .query({ token: "SHOULD_NOT_PERSIST" })
      .send({ status: "Resolved", note: "SHOULD_NOT_PERSIST" });

    await authAdmin(request(app).delete(`/api/threats/${threat.id}`)).set(
      "Cookie",
      "session=SHOULD_NOT_PERSIST"
    );

    const serialized = JSON.stringify(store.auditLogs);
    expect(serialized).not.toContain("SHOULD_NOT_PERSIST");
    expect(serialized).not.toContain(token);

    store.auditLogs.forEach((entry) => {
      expect(entry.headers).toBeUndefined();
      expect(entry.cookies).toBeUndefined();
      expect(entry.body).toBeUndefined();
      expect(entry.token).toBeUndefined();
      // Query strings are stripped from the recorded path.
      expect(entry.path).not.toContain("?");
    });
  });

  it("requires authentication for every write route", async () => {
    const threat = seedThreat();

    const upload = await request(app).post("/api/threats/upload");
    const patch = await request(app)
      .patch(`/api/threats/${threat.id}/status`)
      .send({ status: "Resolved" });
    const remove = await request(app).delete(`/api/threats/${threat.id}`);

    [upload, patch, remove].forEach((res) => expect(res.status).toBe(401));
    expect(store.auditLogs).toHaveLength(0);
  });
});
