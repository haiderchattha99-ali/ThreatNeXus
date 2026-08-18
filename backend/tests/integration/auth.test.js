import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

const path = require("path");
const request = require("supertest");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { ROLE_CAPABILITIES, CAPABILITIES } = require("../../src/lib/roles");

const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
  // Public registration is CLOSED by default in every environment. The cases
  // below describe how the endpoint behaves once an operator opens it, so this
  // suite opens it explicitly — the same shape phase7RateLimiting.test.js uses
  // to turn a rate-limit bucket on. The shipped default is asserted separately
  // in publicRegistrationClosed.test.js, so opening it here cannot hide it.
  ALLOW_PUBLIC_REGISTRATION: "true",
};

// In-memory stand-in for the data layer. The whole Express stack (routing,
// requestContext, JSON limits, errorHandler, the real controller, real bcrypt
// and real jwt) is exercised for real — only Prisma is replaced, which keeps
// `npm test` runnable without a database.
const store = {
  users: [],
  auditLogs: [],
  nextUserId: 1,
  failAuditWrite: false,
  failUserCreateWith: null,
};

function applySelect(row, select) {
  if (!select) return { ...row };
  const out = {};
  Object.keys(select).forEach((key) => {
    if (select[key]) out[key] = row[key];
  });
  return out;
}

const prismaStub = {
  user: {
    findUnique: async ({ where }) =>
      store.users.find((u) => u.email === where.email) || null,
    create: async ({ data, select }) => {
      if (store.failUserCreateWith) throw store.failUserCreateWith;
      const row = {
        id: store.nextUserId++,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        ...data,
      };
      store.users.push(row);
      return applySelect(row, select);
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
  store.users = [];
  store.auditLogs = [];
  store.nextUserId = 1;
  store.failAuditWrite = false;
  store.failUserCreateWith = null;

  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  vi.clearAllMocks();
});

const VALID_PASSWORD = "correct-horse-battery";

function uniqueEmail(tag) {
  return `t8-${tag}-${store.nextUserId}@example.test`;
}

function registerPayload(overrides = {}) {
  return {
    name: "Test User",
    email: uniqueEmail("user"),
    password: VALID_PASSWORD,
    ...overrides,
  };
}

async function seedUser({ email, password = VALID_PASSWORD, role = "VIEWER", name = "Seeded" }) {
  const row = {
    id: store.nextUserId++,
    name,
    email,
    password: await bcrypt.hash(password, 10),
    role,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  store.users.push(row);
  return row;
}

function auditFor(action) {
  return store.auditLogs.filter((entry) => entry.action === action);
}

describe("POST /api/auth/register", () => {
  it("registers a valid user", async () => {
    const payload = registerPayload();
    const res = await request(app).post("/api/auth/register").send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.user).toMatchObject({
      name: "Test User",
      email: payload.email,
    });
  });

  it("creates the user as VIEWER", async () => {
    const res = await request(app).post("/api/auth/register").send(registerPayload());

    expect(res.body.user.role).toBe("VIEWER");
    expect(store.users[0].role).toBe("VIEWER");
  });

  it("ignores a role supplied in the request body", async () => {
    for (const role of ["ADMIN", "admin", "ANALYST", "REVIEWER"]) {
      store.users = [];
      const res = await request(app)
        .post("/api/auth/register")
        .send(registerPayload({ role }));

      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe("VIEWER");
      expect(store.users[0].role).toBe("VIEWER");
    }
  });

  it("never returns a password or hash", async () => {
    const res = await request(app).post("/api/auth/register").send(registerPayload());

    expect(res.body.user.password).toBeUndefined();
    expect(res.body.user.passwordHash).toBeUndefined();
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(VALID_PASSWORD);
    expect(serialized).not.toContain("$2b$");
  });

  it("stores the password hashed, never in plaintext", async () => {
    await request(app).post("/api/auth/register").send(registerPayload());

    const stored = store.users[0].password;
    expect(stored).not.toBe(VALID_PASSWORD);
    expect(stored).toMatch(/^\$2[aby]\$/);
    expect(await bcrypt.compare(VALID_PASSWORD, stored)).toBe(true);
  });

  it("rejects an invalid email", async () => {
    const invalid = ["not-an-email", "no@domain", "@example.test", "a b@example.test", "", 42];

    for (const email of invalid) {
      const res = await request(app)
        .post("/api/auth/register")
        .send(registerPayload({ email }));

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.fields).toContain("email");
    }
    expect(store.users).toHaveLength(0);
  });

  it("rejects a password shorter than 8 characters", async () => {
    for (const password of ["", "short", "1234567"]) {
      const res = await request(app)
        .post("/api/auth/register")
        .send(registerPayload({ password }));

      expect(res.status).toBe(400);
      expect(res.body.fields).toContain("password");
    }
    expect(store.users).toHaveLength(0);
  });

  it("rejects a missing name", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send(registerPayload({ name: "   " }));

    expect(res.status).toBe(400);
    expect(res.body.fields).toContain("name");
  });

  it("normalizes the email before storing it", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send(registerPayload({ email: "  MiXeD.Case@Example.TEST  " }));

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("mixed.case@example.test");
    expect(store.users[0].email).toBe("mixed.case@example.test");
  });

  it("returns a controlled error for a duplicate email", async () => {
    const email = "duplicate@example.test";
    await seedUser({ email });

    const res = await request(app)
      .post("/api/auth/register")
      .send(registerPayload({ email }));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      message: "Email is already registered.",
    });
    expect(res.body.stack).toBeUndefined();
  });

  it("treats a differently-cased duplicate as a duplicate", async () => {
    await seedUser({ email: "dup@example.test" });

    const res = await request(app)
      .post("/api/auth/register")
      .send(registerPayload({ email: "DUP@Example.TEST" }));

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Email is already registered.");
  });

  it("handles a unique-constraint race with the same controlled error", async () => {
    const conflict = new Error("Unique constraint failed");
    conflict.code = "P2002";
    store.failUserCreateWith = conflict;

    const res = await request(app).post("/api/auth/register").send(registerPayload());

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Email is already registered.");
  });

  it("returns a generic 500 without leaking internals on an unexpected error", async () => {
    store.failUserCreateWith = new Error("connection to postgres://user:pw@host failed");

    const res = await request(app).post("/api/auth/register").send(registerPayload());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, message: "Server error." });
    expect(JSON.stringify(res.body)).not.toContain("postgres://");
  });
});

describe("POST /api/auth/login", () => {
  it("returns a token for valid credentials", async () => {
    const email = "login-ok@example.test";
    await seedUser({ email });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: VALID_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.token).toBe("string");
  });

  it("issues a token containing only id, email and role", async () => {
    const email = "claims@example.test";
    await seedUser({ email, role: "ANALYST" });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: VALID_PASSWORD });

    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(Object.keys(decoded).sort()).toEqual(["email", "exp", "iat", "id", "role"]);
    expect(decoded.password).toBeUndefined();
    expect(JSON.stringify(decoded)).not.toContain(VALID_PASSWORD);
    expect(JSON.stringify(decoded)).not.toContain("$2b$");
  });

  it("issues a canonical uppercase role for a legacy lowercase row", async () => {
    const email = "legacy@example.test";
    await seedUser({ email, role: "analyst" });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: VALID_PASSWORD });

    expect(jwt.verify(res.body.token, JWT_SECRET).role).toBe("ANALYST");
    expect(res.body.user.role).toBe("ANALYST");
  });

  it("never issues ADMIN for an unrecognized stored role", async () => {
    const email = "weird-role@example.test";
    await seedUser({ email, role: "superuser" });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: VALID_PASSWORD });

    expect(jwt.verify(res.body.token, JWT_SECRET).role).toBe("VIEWER");
  });

  it("normalizes the login email", async () => {
    await seedUser({ email: "case@example.test" });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "  CASE@Example.TEST  ", password: VALID_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it("returns a generic 401 for a wrong password", async () => {
    const email = "wrong-pw@example.test";
    await seedUser({ email });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "definitely-not-it" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, message: "Invalid credentials." });
    expect(res.body.token).toBeUndefined();
  });

  // The core anti-enumeration property: an unknown address and a known address
  // with a bad password must be indistinguishable.
  it("returns an identical response for an unknown email and a wrong password", async () => {
    await seedUser({ email: "known@example.test" });

    const unknown = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.test", password: VALID_PASSWORD });

    const wrongPassword = await request(app)
      .post("/api/auth/login")
      .send({ email: "known@example.test", password: "definitely-not-it" });

    expect(unknown.status).toBe(wrongPassword.status);
    expect(unknown.body).toEqual(wrongPassword.body);
    expect(unknown.body.message).toBe("Invalid credentials.");
  });

  it("does not reveal account existence in the audit trail either", async () => {
    await seedUser({ email: "known2@example.test" });

    await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody2@example.test", password: VALID_PASSWORD });
    const unknownReason = auditFor("auth.login")[0].reason;

    store.auditLogs = [];
    await request(app)
      .post("/api/auth/login")
      .send({ email: "known2@example.test", password: "definitely-not-it" });
    const wrongPasswordReason = auditFor("auth.login")[0].reason;

    expect(unknownReason).toBe(wrongPasswordReason);
    expect(unknownReason).not.toMatch(/exist|unknown user|no such|not found/i);
  });

  it("rejects missing credentials without touching the data layer", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "a@b.test" });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Email and password are required.");
    expect(res.body.token).toBeUndefined();
  });

  it("leaks no password or hash in the login response", async () => {
    const email = "no-leak@example.test";
    await seedUser({ email });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: VALID_PASSWORD });

    expect(res.body.user.password).toBeUndefined();
    const serialized = JSON.stringify(res.body.user);
    expect(serialized).not.toContain(VALID_PASSWORD);
    expect(serialized).not.toContain("$2b$");
  });

  it("returns a generic 500 without leaking internals", async () => {
    const email = "boom@example.test";
    await seedUser({ email });
    const original = prismaStub.user.findUnique;
    prismaStub.user.findUnique = async () => {
      throw new Error("connection to postgres://user:pw@host failed");
    };

    try {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email, password: VALID_PASSWORD });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, message: "Server error." });
      expect(JSON.stringify(res.body)).not.toContain("postgres://");
    } finally {
      prismaStub.user.findUnique = original;
    }
  });
});

describe("auth auditing", () => {
  it("audits a successful registration", async () => {
    const payload = registerPayload();
    await request(app).post("/api/auth/register").send(payload);

    const [entry] = auditFor("auth.register");
    expect(entry).toMatchObject({
      outcome: "SUCCESS",
      entityType: "User",
      actorEmail: payload.email,
      actorRole: "VIEWER",
      tlp: "AMBER",
      method: "POST",
      path: "/api/auth/register",
    });
  });

  it("audits a failed registration", async () => {
    await request(app)
      .post("/api/auth/register")
      .send(registerPayload({ password: "short" }));

    const [entry] = auditFor("auth.register");
    expect(entry.outcome).toBe("FAILURE");
    expect(entry.reason).toMatch(/validation failed/i);
  });

  it("audits a successful login", async () => {
    const email = "audit-login@example.test";
    await seedUser({ email, role: "ANALYST" });

    await request(app).post("/api/auth/login").send({ email, password: VALID_PASSWORD });

    const [entry] = auditFor("auth.login");
    expect(entry).toMatchObject({
      outcome: "SUCCESS",
      entityType: "Authentication",
      actorEmail: email,
      actorRole: "ANALYST",
    });
  });

  it("audits a failed login", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({ email: "ghost@example.test", password: "whatever-long" });

    const [entry] = auditFor("auth.login");
    expect(entry.outcome).toBe("FAILURE");
    expect(entry.entityType).toBe("Authentication");
  });

  it("never audits passwords, tokens, raw headers or cookies", async () => {
    const email = "audit-secrets@example.test";
    await seedUser({ email });

    await request(app)
      .post("/api/auth/register")
      .send(registerPayload({ password: "sup3r-s3cret-value" }));
    await request(app)
      .post("/api/auth/login")
      .send({ email, password: VALID_PASSWORD })
      .set("Authorization", "Bearer SHOULD_NOT_PERSIST")
      .set("Cookie", "session=SHOULD_NOT_PERSIST");

    const serialized = JSON.stringify(store.auditLogs);
    expect(serialized).not.toContain("sup3r-s3cret-value");
    expect(serialized).not.toContain(VALID_PASSWORD);
    expect(serialized).not.toContain("SHOULD_NOT_PERSIST");
    expect(serialized).not.toContain("$2b$");

    store.auditLogs.forEach((entry) => {
      expect(entry.headers).toBeUndefined();
      expect(entry.cookies).toBeUndefined();
      expect(entry.body).toBeUndefined();
      expect(entry.password).toBeUndefined();
      expect(entry.token).toBeUndefined();
    });
  });

  it("does not record an arbitrary malformed email as the actor", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({ email: "<script>alert(1)</script>", password: VALID_PASSWORD });

    const [entry] = auditFor("auth.login");
    expect(entry.actorEmail).toBeUndefined();
    expect(JSON.stringify(store.auditLogs)).not.toContain("<script>");
  });

  it("still registers successfully when the audit write fails", async () => {
    store.failAuditWrite = true;

    const res = await request(app).post("/api/auth/register").send(registerPayload());

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(store.users).toHaveLength(1);
  });

  it("still logs in successfully when the audit write fails", async () => {
    const email = "audit-down@example.test";
    await seedUser({ email });
    store.failAuditWrite = true;

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: VALID_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it("still returns 401 when the audit write fails on a bad login", async () => {
    store.failAuditWrite = true;

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "ghost@example.test", password: "whatever-long" });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid credentials.");
  });
});

describe("authenticated routes end to end", () => {
  async function loginToken(role) {
    const email = `e2e-${role.toLowerCase()}@example.test`;
    await seedUser({ email, role });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: VALID_PASSWORD });
    return res.body.token;
  }

  it("rejects an unauthenticated profile request", async () => {
    const res = await request(app).get("/api/profile");
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Authentication required.");
  });

  it("accepts a freshly issued token", async () => {
    const token = await loginToken("ANALYST");
    const res = await request(app)
      .get("/api/profile")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.loggedInUser).toMatchObject({ role: "ANALYST" });
  });

  // GET /api/profile echoes req.user, so the middleware must not carry claims
  // beyond id/email/role into it.
  it("does not leak iat/exp through the profile response", async () => {
    const token = await loginToken("VIEWER");
    const res = await request(app)
      .get("/api/profile")
      .set("Authorization", `Bearer ${token}`);

    expect(Object.keys(res.body.loggedInUser).sort()).toEqual(["email", "id", "role"]);
    expect(res.body.loggedInUser.iat).toBeUndefined();
    expect(res.body.loggedInUser.exp).toBeUndefined();
  });

  it("rejects an expired token", async () => {
    const expired = jwt.sign({ id: 1, email: "a@b.test", role: "ADMIN" }, JWT_SECRET, {
      expiresIn: "-1s",
    });
    const res = await request(app)
      .get("/api/profile")
      .set("Authorization", `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Authentication required.");
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign(
      { id: 1, email: "a@b.test", role: "ADMIN" },
      "a-different-32-char-plus-secret-value-here"
    );
    const res = await request(app)
      .get("/api/profile")
      .set("Authorization", `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });
});

// Frontend RBAC alignment (Phase 2 integration packet): both endpoints expose
// a server-derived capabilities array so the frontend can mirror backend
// authorization instead of maintaining an independently-authored role table.
// Every assertion here proves the array traces only to ROLE_CAPABILITIES
// (lib/roles.js) keyed by the verified role — never to anything a caller
// supplies — and that adding it does not loosen any existing response shape.
describe("capabilities in login and profile responses", () => {
  async function loginToken(role) {
    const email = `caps-${role.toLowerCase()}@example.test`;
    await seedUser({ email, role });
    return request(app).post("/api/auth/login").send({ email, password: VALID_PASSWORD });
  }

  it.each(["ADMIN", "ANALYST", "REVIEWER", "VIEWER"])(
    "login returns exactly the ROLE_CAPABILITIES set for %s",
    async (role) => {
      const res = await loginToken(role);

      expect(res.status).toBe(200);
      expect(res.body.capabilities.slice().sort()).toEqual(
        [...ROLE_CAPABILITIES[role]].sort()
      );
    }
  );

  it.each(["ADMIN", "ANALYST", "REVIEWER", "VIEWER"])(
    "profile returns exactly the ROLE_CAPABILITIES set for %s",
    async (role) => {
      const loginRes = await loginToken(role);
      const res = await request(app)
        .get("/api/profile")
        .set("Authorization", `Bearer ${loginRes.body.token}`);

      expect(res.status).toBe(200);
      expect(res.body.capabilities.slice().sort()).toEqual(
        [...ROLE_CAPABILITIES[role]].sort()
      );
    }
  );

  it("ADMIN alone receives every capability", async () => {
    const res = await loginToken("ADMIN");
    expect(res.body.capabilities.slice().sort()).toEqual(
      Object.values(CAPABILITIES).slice().sort()
    );
  });

  it("VIEWER receives only the read-only capabilities", async () => {
    const res = await loginToken("VIEWER");
    expect(res.body.capabilities.sort()).toEqual(
      [
        CAPABILITIES.READ_DASHBOARD,
        CAPABILITIES.READ_FINDINGS,
        // Phase 3: read-only, serializer-filtered case and triage access. It
        // joined READ_ONLY_CAPABILITIES because a VIEWER's oversight of case
        // work is an explicit Phase 3 requirement, and the case read paths
        // expose no organization contact, no audit row and no internal key.
        CAPABILITIES.READ_CASES,
      ].sort()
    );
  });

  it("a client cannot submit or override the capabilities it receives", async () => {
    const email = "caps-no-override@example.test";
    await seedUser({ email, role: "VIEWER" });

    const res = await request(app)
      .post("/api/auth/login")
      .send({
        email,
        password: VALID_PASSWORD,
        capabilities: Object.values(CAPABILITIES),
        role: "ADMIN",
      });

    expect(res.body.capabilities.sort()).toEqual(
      [
        CAPABILITIES.READ_DASHBOARD,
        CAPABILITIES.READ_FINDINGS,
        // Phase 3: read-only, serializer-filtered case and triage access. It
        // joined READ_ONLY_CAPABILITIES because a VIEWER's oversight of case
        // work is an explicit Phase 3 requirement, and the case read paths
        // expose no organization contact, no audit row and no internal key.
        CAPABILITIES.READ_CASES,
      ].sort()
    );
  });

  it("a forged token with an unrecognized role receives no capabilities", async () => {
    const forged = jwt.sign({ id: 1, email: "a@b.test", role: "superuser" }, JWT_SECRET);
    const res = await request(app)
      .get("/api/profile")
      .set("Authorization", `Bearer ${forged}`);

    expect(res.status).toBe(200);
    expect(res.body.capabilities).toEqual([]);
  });

  it("still leaks no password/hash with capabilities present", async () => {
    const res = await loginToken("ADMIN");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(VALID_PASSWORD);
    expect(serialized).not.toContain("$2b$");
  });

  it("does not change the existing loggedInUser key shape", async () => {
    const loginRes = await loginToken("ANALYST");
    const res = await request(app)
      .get("/api/profile")
      .set("Authorization", `Bearer ${loginRes.body.token}`);

    expect(Object.keys(res.body.loggedInUser).sort()).toEqual(["email", "id", "role"]);
  });
});
