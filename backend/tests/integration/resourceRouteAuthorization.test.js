import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Authorization + write-audit matrix for the Case / Notification / Organization
// route groups added alongside Phase 0. These three groups shipped completely
// unauthenticated; this file is the enforcement proof that they no longer are.
//
// It is the counterpart to routeAuthorization.test.js (threat/dashboard) and
// follows the same shape: only Prisma is stubbed, so the real routes,
// middleware chain and controllers run.

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
  cases: [],
  notifications: [],
  organizations: [],
  auditLogs: [],
  nextId: 1,
};

// One in-memory table implementation reused for all three models — they have
// the same integer-id CRUD surface.
function tableStub(key) {
  return {
    findMany: async () => [...store[key]],
    findUnique: async ({ where }) =>
      store[key].find((row) => row.id === where.id) || null,
    create: async ({ data }) => {
      const row = { id: store.nextId++, createdAt: new Date(), ...data };
      store[key].push(row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = store[key].find((r) => r.id === where.id);
      if (!row) {
        const err = new Error("Record not found");
        err.code = "P2025";
        throw err;
      }
      Object.assign(row, data);
      return { ...row };
    },
    delete: async ({ where }) => {
      const index = store[key].findIndex((r) => r.id === where.id);
      const [removed] = store[key].splice(index, 1);
      return removed;
    },
  };
}

// Phase 3 added six append-only workflow tables that the case READ path
// (caseWorkflowReadService) and the case DELETE guard both query. They are
// empty in this file — its subject is the authorization matrix, not the
// workflow — so each is stubbed to the shape those callers actually use.
// Returning empty results is honest here: a legacy, non-organization-bound
// case genuinely has no workflow history.
function emptyWorkflowTableStub() {
  return {
    findMany: async () => [],
    findUnique: async () => null,
    findFirst: async () => null,
    count: async () => 0,
    groupBy: async () => [],
    create: async ({ data }) => ({ id: store.nextId++, ...data }),
    update: async ({ where, data }) => ({ id: where.id, ...data }),
    updateMany: async () => ({ count: 0 }),
  };
}

// Phase 3 requires every new case to name an existing Organization. This row is
// resolvable by id WITHOUT living in store.organizations, deliberately: the
// organizations group's own tests assert exact table lengths, and seeding a
// real row for the case group to point at would silently change every one of
// them.
const CASE_ORGANIZATION = Object.freeze({
  id: 9001,
  name: "Acme Bank",
  sector: "FINANCE",
});

const organizationTable = tableStub("organizations");

const prismaStub = {
  case: tableStub("cases"),
  notification: tableStub("notifications"),
  organization: {
    ...organizationTable,
    findUnique: async (args) =>
      args.where.id === CASE_ORGANIZATION.id
        ? { ...CASE_ORGANIZATION }
        : organizationTable.findUnique(args),
  },
  caseFinding: emptyWorkflowTableStub(),
  caseLifecycleEvent: emptyWorkflowTableStub(),
  caseOrganizationResponse: emptyWorkflowTableStub(),
  caseClosureRequest: emptyWorkflowTableStub(),
  caseRecurrenceReopen: emptyWorkflowTableStub(),
  findingTriage: emptyWorkflowTableStub(),
  auditLog: {
    create: async ({ data }) => {
      const row = { id: store.auditLogs.length + 1, ...data };
      store.auditLogs.push(row);
      return row;
    },
  },
  // Phase 3 routes case creation through caseLifecycleService.createCase so
  // every case gets its server-generated reference and CREATED lifecycle event
  // atomically. That runs inside runSerializable, so the stub needs a
  // transaction that simply hands back itself — there is nothing to roll back
  // in an in-memory store, and this file asserts authorization, not atomicity
  // (the real-PostgreSQL suites cover that).
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
  // A validly signed token carrying a role the system does not recognise.
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
  store.cases = [];
  store.notifications = [];
  store.organizations = [];
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

// Phase 3 makes organizationId required on create — a case belongs to exactly
// one Organization. The legacy free-text `organization` column is preserved
// alongside it, unchanged, so pre-Phase-3 consumers see no difference.
const VALID_CASE = {
  title: "Exposed RDP on constituent host",
  threatType: "Accessible RDP",
  organization: "Acme Bank",
  analyst: "a.analyst",
  organizationId: CASE_ORGANIZATION.id,
};

const VALID_NOTIFICATION = {
  title: "Exposure notice",
  message: "One host requires remediation.",
};

const VALID_ORGANIZATION = {
  name: "Acme Bank",
  industry: "Finance",
  location: "Karachi",
  contactPerson: "Ops Desk",
  email: "ops@acme.test",
};

// Each group: the mounted path, the capability that gates it, the roles that
// hold that capability, a valid create body, and a seeder for the stub table.
//
// Two optional per-group overrides exist for Phase 3:
//   readDenied      — roles refused the READ actions, when that differs from
//                     `denied`. The case group splits reads (read:cases, held
//                     by every role) from writes (manage:cases, ADMIN/ANALYST),
//                     so its read-denied set is empty.
//   refusedActions  — actions that are refused for a NON-authorization reason
//                     even to a role holding the capability. DELETE /api/cases
//                     is a compatibility tombstone answering 409.
const GROUPS = [
  {
    name: "cases",
    base: "/api/cases",
    capability: "manage:cases",
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
    readDenied: [],
    refusedActions: { delete: 409 },
    body: VALID_CASE,
    table: "cases",
    seed: () => {
      const row = {
        id: store.nextId++,
        ...VALID_CASE,
        priority: "Medium",
        status: "Open",
        lifecycleState: "OPEN",
      };
      store.cases.push(row);
      return row;
    },
  },
  {
    name: "notifications",
    base: "/api/notifications",
    capability: "review:notifications",
    allowed: ["ADMIN", "REVIEWER"],
    denied: ["ANALYST", "VIEWER"],
    body: VALID_NOTIFICATION,
    table: "notifications",
    seed: () => {
      const row = {
        id: store.nextId++,
        ...VALID_NOTIFICATION,
        severity: "Low",
        status: "Unread",
        type: "System",
      };
      store.notifications.push(row);
      return row;
    },
  },
  {
    name: "organizations",
    base: "/api/organizations",
    capability: "manage:system",
    allowed: ["ADMIN"],
    denied: ["ANALYST", "REVIEWER", "VIEWER"],
    body: VALID_ORGANIZATION,
    table: "organizations",
    seed: () => {
      const row = {
        id: store.nextId++,
        ...VALID_ORGANIZATION,
        phone: null,
        securityScore: 100,
        activeThreats: 0,
      };
      store.organizations.push(row);
      return row;
    },
  },
];

// Issues one request per verb as the given role (null = no Authorization).
function callAs(role, group, action, id) {
  const bearer = (req) =>
    role === null ? req : req.set("Authorization", `Bearer ${tokens[role]}`);

  switch (action) {
    case "list":
      return bearer(request(app).get(group.base));
    case "read":
      return bearer(request(app).get(`${group.base}/${id}`));
    case "create":
      return bearer(request(app).post(group.base)).send(group.body);
    case "update":
      return bearer(request(app).put(`${group.base}/${id}`)).send({
        status: "Closed",
        ...(group.name === "organizations" ? { name: "Renamed Org" } : {}),
      });
    case "delete":
      return bearer(request(app).delete(`${group.base}/${id}`));
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

const READ_ACTIONS = ["list", "read"];
const WRITE_ACTIONS = ["create", "update", "delete"];
const ALL_ACTIONS = [...READ_ACTIONS, ...WRITE_ACTIONS];

describe.each(GROUPS)("$name routes", (group) => {
  describe("unauthenticated access", () => {
    it.each(ALL_ACTIONS)("%s returns 401, not 403 and not 200", async (action) => {
      const seeded = group.seed();
      const res = await callAs(null, group, action, seeded.id);

      expect(res.status).toBe(401);
      expect(res.body.message).toBe("Authentication required.");
    });

    it("performs no write and records no audit when unauthenticated", async () => {
      const seeded = group.seed();

      await callAs(null, group, "create");
      await callAs(null, group, "update", seeded.id);
      await callAs(null, group, "delete", seeded.id);

      expect(store[group.table]).toHaveLength(1);
      expect(store.auditLogs).toHaveLength(0);
    });
  });

  const refusedActions = group.refusedActions || {};
  const readDenied = group.readDenied === undefined ? group.denied : group.readDenied;

  describe("roles holding the capability", () => {
    it.each(
      group.allowed.flatMap((role) => ALL_ACTIONS.map((action) => [role, action]))
    )("%s reaches %s", async (role, action) => {
      const seeded = group.seed();
      const res = await callAs(role, group, action, seeded.id);

      const refusalStatus = refusedActions[action];
      if (refusalStatus) {
        // Not an authorization failure — the role DOES hold the capability and
        // still cannot perform the action, because the record is permanent.
        // The row must survive.
        expect(res.status).toBe(refusalStatus);
        expect(res.body.success).toBe(false);
        expect(store[group.table]).toHaveLength(1);
        return;
      }

      expect([200, 201]).toContain(res.status);
      expect(res.body.success).toBe(true);
    });
  });

  describe("roles without the capability", () => {
    it.each(
      group.denied.flatMap((role) => WRITE_ACTIONS.map((action) => [role, action]))
    )("%s is denied %s with 403", async (role, action) => {
      const seeded = group.seed();
      const res = await callAs(role, group, action, seeded.id);

      expect(res.status).toBe(403);
      expect(res.body.message).toBe("Forbidden.");
    });

    if (readDenied.length > 0) {
      it.each(
        readDenied.flatMap((role) => READ_ACTIONS.map((action) => [role, action]))
      )("%s is denied %s with 403", async (role, action) => {
        const seeded = group.seed();
        const res = await callAs(role, group, action, seeded.id);

        expect(res.status).toBe(403);
        expect(res.body.message).toBe("Forbidden.");
      });
    } else {
      // Phase 3: read:cases is a read-only grant held by every role, so the
      // roles refused every WRITE above can still read. This is the whole point
      // of splitting the router's single manage:cases guard — a REVIEWER must
      // be able to read a case in order to decide its closure, and a VIEWER
      // gets read-only oversight.
      it("roles refused every write may still read", async () => {
        const seeded = group.seed();

        // eslint-disable-next-line no-restricted-syntax
        for (const role of group.denied) {
          // eslint-disable-next-line no-await-in-loop
          expect((await callAs(role, group, "list", seeded.id)).status).toBe(200);
          // eslint-disable-next-line no-await-in-loop
          expect((await callAs(role, group, "read", seeded.id)).status).toBe(200);
        }
      });
    }

    it("leaves stored data untouched when denied", async () => {
      const seeded = group.seed();
      const denied = group.denied[0];

      await callAs(denied, group, "create");
      await callAs(denied, group, "update", seeded.id);
      await callAs(denied, group, "delete", seeded.id);

      expect(store[group.table]).toHaveLength(1);
    });
  });

  // A token can only carry an unknown role if it was signed with our secret,
  // but the guard must still refuse rather than fall back to VIEWER.
  describe("unrecognised role fails closed", () => {
    it.each(ALL_ACTIONS)("is denied %s", async (action) => {
      const seeded = group.seed();
      const res = await callAs("UNKNOWN", group, action, seeded.id);
      expect(res.status).toBe(403);
    });
  });

  describe("denied responses do not leak the capability", () => {
    it("returns a fixed body naming neither the capability nor the role", async () => {
      const seeded = group.seed();
      const res = await callAs(group.denied[0], group, "delete", seeded.id);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(group.capability);
      expect(serialized).not.toContain("capability");
      group.denied.forEach((role) => expect(serialized).not.toContain(role));
    });

    it("records the required capability server-side in the audit reason only", async () => {
      const seeded = group.seed();
      const res = await callAs(group.denied[0], group, "delete", seeded.id);

      const [denied] = store.auditLogs.filter(
        (entry) => entry.action === "authorization.denied"
      );
      expect(denied).toMatchObject({ outcome: "DENIED", entityType: "Authorization" });
      expect(denied.reason).toContain(group.capability);
      expect(JSON.stringify(res.body)).not.toContain(group.capability);
    });
  });
});

describe("separation of duties across the three groups", () => {
  // The point of the mapping: ANALYST does case work, REVIEWER approves
  // notifications, and neither inherits the other or the admin registry.
  it("ANALYST reaches cases but not notifications or organizations", async () => {
    expect((await callAs("ANALYST", GROUPS[0], "list")).status).toBe(200);
    expect((await callAs("ANALYST", GROUPS[1], "list")).status).toBe(403);
    expect((await callAs("ANALYST", GROUPS[2], "list")).status).toBe(403);
  });

  // Phase 3 changed exactly one cell of this matrix: REVIEWER and VIEWER can now
  // READ cases. Neither gained any case WRITE — that stays manage:cases, which
  // neither holds.
  it("REVIEWER reaches notifications, reads cases, and writes neither cases nor organizations", async () => {
    expect((await callAs("REVIEWER", GROUPS[1], "list")).status).toBe(200);
    expect((await callAs("REVIEWER", GROUPS[0], "list")).status).toBe(200);
    expect((await callAs("REVIEWER", GROUPS[0], "create")).status).toBe(403);
    expect((await callAs("REVIEWER", GROUPS[2], "list")).status).toBe(403);
  });

  it("VIEWER reads cases only, and writes nothing anywhere", async () => {
    expect((await callAs("VIEWER", GROUPS[0], "list")).status).toBe(200);
    expect((await callAs("VIEWER", GROUPS[1], "list")).status).toBe(403);
    expect((await callAs("VIEWER", GROUPS[2], "list")).status).toBe(403);

    // eslint-disable-next-line no-restricted-syntax
    for (const group of GROUPS) {
      // eslint-disable-next-line no-await-in-loop
      expect((await callAs("VIEWER", group, "create")).status).toBe(403);
    }
    expect(store.cases).toHaveLength(0);
  });

  it("ADMIN reaches all three", async () => {
    for (const group of GROUPS) {
      expect((await callAs("ADMIN", group, "list")).status).toBe(200);
    }
  });
});

describe("write actions are audited", () => {
  // Phase 3 adds `case.created` (written by caseLifecycleService inside the
  // creation transaction, alongside the server-generated reference and the
  // CREATED lifecycle event) and turns `case.delete` into a DENIED tombstone.
  // The legacy `case.create` event is deliberately still emitted so
  // pre-Phase-3 audit consumers see no change.
  it("records case.created / case.create / case.update with SUCCESS", async () => {
    const created = await callAs("ANALYST", GROUPS[0], "create");
    expect(created.status).toBe(201);

    const id = created.body.data.id;
    await callAs("ANALYST", GROUPS[0], "update", id);

    const actions = store.auditLogs
      .filter((entry) => entry.outcome === "SUCCESS")
      .map((entry) => entry.action);

    expect(actions).toEqual(["case.created", "case.create", "case.update"]);
    store.auditLogs
      .filter((entry) => entry.action.startsWith("case."))
      .forEach((entry) => {
        expect(entry.entityType).toBe("Case");
        expect(entry.entityId).toBe(String(id));
      });
  });

  it("records a DENIED audit for the case-deletion tombstone and deletes nothing", async () => {
    const seeded = GROUPS[0].seed();

    const res = await callAs("ADMIN", GROUPS[0], "delete", seeded.id);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      success: false,
      code: "CASE_DELETION_NOT_SUPPORTED",
    });
    expect(store.cases).toHaveLength(1);

    const [refusal] = store.auditLogs.filter((entry) => entry.action === "case.delete");
    expect(refusal.outcome).toBe("DENIED");
    expect(refusal.entityId).toBe(String(seeded.id));
    expect(refusal.reason).toContain("never hard-deleted");
  });

  // The refusal must be identical for a case that does not exist, or the
  // endpoint becomes an existence oracle for anyone holding manage:cases.
  it("refuses deletion of an unknown case identically, disclosing nothing", async () => {
    const seeded = GROUPS[0].seed();

    const known = await callAs("ADMIN", GROUPS[0], "delete", seeded.id);
    const unknown = await callAs("ADMIN", GROUPS[0], "delete", 424242);

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it("rejects a create with no organizationId, writing nothing", async () => {
    const { organizationId, ...withoutOrganizationId } = VALID_CASE;
    expect(organizationId).toBe(CASE_ORGANIZATION.id);

    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .send(withoutOrganizationId);

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["organizationId"]);
    expect(store.cases).toHaveLength(0);

    const [failure] = store.auditLogs.filter((entry) => entry.action === "case.create");
    expect(failure.outcome).toBe("FAILURE");
    expect(failure.reason).toContain("organizationId");
  });

  it("rejects a create naming an organization that does not exist", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .send({ ...VALID_CASE, organizationId: 777777 });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["organizationId"]);
    expect(store.cases).toHaveLength(0);
  });

  it("records notification write events", async () => {
    const created = await callAs("REVIEWER", GROUPS[1], "create");
    const id = created.body.data.id;
    await callAs("REVIEWER", GROUPS[1], "delete", id);

    const actions = store.auditLogs
      .filter((entry) => entry.outcome === "SUCCESS")
      .map((entry) => entry.action);

    expect(actions).toEqual(["notification.create", "notification.delete"]);
  });

  it("records organization write events", async () => {
    const created = await callAs("ADMIN", GROUPS[2], "create");
    const id = created.body.data.id;
    await callAs("ADMIN", GROUPS[2], "delete", id);

    const actions = store.auditLogs
      .filter((entry) => entry.outcome === "SUCCESS")
      .map((entry) => entry.action);

    expect(actions).toEqual(["organization.create", "organization.delete"]);
  });

  it("records a FAILURE audit for a rejected create", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .send({ title: "   " });

    expect(res.status).toBe(400);

    const [failure] = store.auditLogs.filter(
      (entry) => entry.action === "case.create"
    );
    expect(failure.outcome).toBe("FAILURE");
    expect(failure.reason).toContain("missing required fields");
  });

  it("records a FAILURE audit for a write against a missing record", async () => {
    const res = await request(app)
      .put("/api/cases/999")
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send({ status: "Closed" });

    expect(res.status).toBe(404);

    const [failure] = store.auditLogs.filter(
      (entry) => entry.action === "case.update"
    );
    expect(failure.outcome).toBe("FAILURE");
    expect(failure.reason).toContain("not found");
  });

  it("does not break the response when the audit write fails", async () => {
    const original = prismaStub.auditLog.create;
    prismaStub.auditLog.create = async () => {
      throw new Error("audit table unavailable");
    };

    try {
      const res = await callAs("ANALYST", GROUPS[0], "create");
      expect(res.status).toBe(201);
      expect(store.cases).toHaveLength(1);
    } finally {
      prismaStub.auditLog.create = original;
    }
  });
});

describe("audit payloads carry summaries only", () => {
  it("stores no raw body, token, header or free-text field", async () => {
    const secretDescription = "internal-only incident narrative";

    const created = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .set("Cookie", "session=super-secret-cookie")
      .send({ ...VALID_CASE, description: secretDescription, password: "hunter2" });

    expect(created.status).toBe(201);

    const serialized = JSON.stringify(store.auditLogs);
    expect(serialized).not.toContain(tokens.ANALYST);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("super-secret-cookie");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain(secretDescription);

    store.auditLogs.forEach((entry) => {
      expect(entry.headers).toBeUndefined();
      expect(entry.cookies).toBeUndefined();
      expect(entry.body).toBeUndefined();
    });
  });

  it("limits the case summary to the allow-listed keys", async () => {
    const created = await callAs("ANALYST", GROUPS[0], "create");
    const [entry] = store.auditLogs.filter((e) => e.action === "case.create");

    expect(Object.keys(entry.after).sort()).toEqual(
      ["id", "organization", "priority", "status", "threatType", "title"].sort()
    );
    expect(created.body.data.id).toBe(entry.after.id);
  });

  it("keeps organization contact PII out of the audit summary", async () => {
    await callAs("ADMIN", GROUPS[2], "create");
    const [entry] = store.auditLogs.filter(
      (e) => e.action === "organization.create"
    );

    expect(Object.keys(entry.after).sort()).toEqual(
      ["activeThreats", "id", "industry", "name", "securityScore"].sort()
    );
    expect(JSON.stringify(entry)).not.toContain(VALID_ORGANIZATION.email);
  });

  it("does not strip the query string into the audit path", async () => {
    await request(app)
      .get("/api/cases?token=leaked-value")
      .set("Authorization", `Bearer ${tokens.VIEWER}`);

    const serialized = JSON.stringify(store.auditLogs);
    expect(serialized).not.toContain("leaked-value");
  });
});

describe("validation produces controlled responses", () => {
  it("rejects a create with missing required fields as 400", async () => {
    const res = await request(app)
      .post("/api/notifications")
      .set("Authorization", `Bearer ${tokens.REVIEWER}`)
      .send({ title: "no message" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, message: "Missing required fields." });
    expect(res.body.fields).toEqual(["message"]);
    expect(store.notifications).toHaveLength(0);
  });

  it("rejects a non-numeric id as 400 rather than reaching Prisma", async () => {
    const res = await request(app)
      .get("/api/cases/not-an-id")
      .set("Authorization", `Bearer ${tokens.ANALYST}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid case id.");
  });

  it("rejects an update with no updatable fields", async () => {
    const seeded = GROUPS[0].seed();
    const res = await request(app)
      .put(`/api/cases/${seeded.id}`)
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .send({ id: 42, createdAt: "1999-01-01" });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("No updatable fields supplied.");
    // The immutable keys were dropped, not written.
    expect(store.cases[0].id).toBe(seeded.id);
  });

  it("rejects an invalid organization email", async () => {
    const res = await request(app)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send({ ...VALID_ORGANIZATION, email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(res.body.fields).toContain("email");
    expect(store.organizations).toHaveLength(0);
  });

  it("rejects a non-numeric securityScore", async () => {
    const res = await request(app)
      .post("/api/organizations")
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send({ ...VALID_ORGANIZATION, securityScore: "high" });

    expect(res.status).toBe(400);
    expect(res.body.fields).toContain("securityScore");
  });

  it("returns 404, not 500, for a write against a missing record", async () => {
    const res = await request(app)
      .put("/api/notifications/4242")
      .set("Authorization", `Bearer ${tokens.REVIEWER}`)
      .send({ status: "Read" });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Notification not found.");
  });

  it("does not expose a stack trace or Prisma detail on a server error", async () => {
    const original = prismaStub.case.findMany;
    prismaStub.case.findMany = async () => {
      throw new Error("Invalid `prisma.case.findMany()` invocation: column detail");
    };

    try {
      const res = await request(app)
        .get("/api/cases")
        .set("Authorization", `Bearer ${tokens.ANALYST}`);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, message: "Server Error" });
      expect(JSON.stringify(res.body)).not.toContain("prisma");
      expect(res.body.stack).toBeUndefined();
    } finally {
      prismaStub.case.findMany = original;
    }
  });
});
