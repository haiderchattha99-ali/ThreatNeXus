import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Phase 6 — the two read surfaces this phase adds, and their capability matrix.
//
//   GET /api/dashboard/overview   read:dashboard   (every role)
//   GET /api/findings             read:findings    (every role)
//   GET /api/findings/:id         read:findings    (every role)
//
// The claims under test:
//   - an unauthenticated caller reaches none of them
//   - a role holding no capability at all reaches none of them
//   - the overview's per-SECTION gating is real: VIEWER gets the notification
//     section as RESTRICTED, and never as a zero
//   - an invalid filter is a 400 that names the field, not a silently different
//     result set
//   - these routes are reads: no Prisma write method is ever called
//
// Only Prisma is stubbed. The real routes, the real middleware chain, the real
// controllers and the real services all run.

const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

// Set explicitly, never inherited from the shell or from backend/.env.
// dotenv does not overwrite an already-present key, so assigning these here —
// BEFORE src/config/env is first required — is what keeps this suite
// independent of whatever provider keys the developer's machine happens to
// hold. (This machine's backend/.env carries live AbuseIPDB and NVD keys; a
// test that inherited them would change behaviour between machines.)
const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
  IOC_ENRICHMENT_PROVIDER: "mock",
  ABUSEIPDB_API_KEY: "",
  NVD_API_KEY: "",
  AI_ENABLED: "false",
  AI_PROVIDER: "null",
};

const ROLES = ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"];

// Every write method a Prisma delegate exposes. If any route below touches one,
// the test fails — that is the "these are reads" assertion.
const WRITE_METHODS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
];

let app;
const tokens = {};
const writeCalls = [];

function makeDelegate(name) {
  const delegate = {
    count: vi.fn(async () => 0),
    groupBy: vi.fn(async () => []),
    aggregate: vi.fn(async () => ({ _max: { queriedAt: null } })),
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => null),
  };
  for (const method of WRITE_METHODS) {
    delegate[method] = vi.fn(async () => {
      writeCalls.push(`${name}.${method}`);
      return {};
    });
  }
  return delegate;
}

const delegates = new Map();
const prismaStub = new Proxy(
  {},
  {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      if (property === "$transaction") {
        return async (fn) => (typeof fn === "function" ? fn(prismaStub) : Promise.all(fn));
      }
      if (property === "$connect" || property === "$disconnect") return async () => {};
      if (!delegates.has(property)) delegates.set(property, makeDelegate(property));
      return delegates.get(property);
    },
    has() {
      return true;
    },
  }
);

beforeAll(() => {
  Object.assign(process.env, BASE_ENV);

  // Inject the stub through the CommonJS module cache, the same technique the
  // Phase 3-5 route suites use. `vi.mock` does not work here: the app is
  // CommonJS and requires the client synchronously at module load, so the entry
  // has to be present in require.cache before src/app is first required.
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

  for (const role of ROLES) {
    tokens[role] = jwt.sign({ id: 1, email: `${role.toLowerCase()}@threatnexus.local`, role }, JWT_SECRET, {
      expiresIn: "10m",
    });
  }
});

afterAll(() => {
  const marker = `${path.sep}src${path.sep}`;
  Object.keys(require.cache).forEach((key) => {
    if (key.includes(marker)) delete require.cache[key];
  });
});

const auth = (role) => ({ Authorization: `Bearer ${tokens[role]}` });

describe("Phase 6 read routes — authentication", () => {
  const routes = ["/api/dashboard/overview", "/api/findings", "/api/findings/1"];

  it("refuses every route without a token", async () => {
    for (const route of routes) {
      const res = await request(app).get(route);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    }
  });

  it("refuses a token signed with the wrong secret", async () => {
    const forged = jwt.sign({ id: 1, role: "ADMIN" }, "a-different-secret-of-sufficient-length-x", {
      expiresIn: "10m",
    });
    for (const route of routes) {
      const res = await request(app).get(route).set("Authorization", `Bearer ${forged}`);
      expect(res.status).toBe(401);
    }
  });

  it("refuses an expired token", async () => {
    const expired = jwt.sign({ id: 1, role: "ADMIN" }, JWT_SECRET, { expiresIn: "-1s" });
    const res = await request(app).get("/api/findings").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it("grants no capability to an unrecognized role, so the routes stay closed", async () => {
    // resolveAuthorizationRole returns null for anything not in the enum, which
    // must mean "no capabilities", never "VIEWER's capabilities".
    const odd = jwt.sign({ id: 1, role: "SUPERUSER" }, JWT_SECRET, { expiresIn: "10m" });
    for (const route of routes) {
      const res = await request(app).get(route).set("Authorization", `Bearer ${odd}`);
      expect(res.status).toBe(403);
    }
  });
});

describe("Phase 6 read routes — capability matrix", () => {
  it("admits every role to the overview on read:dashboard", async () => {
    for (const role of ROLES) {
      const res = await request(app).get("/api/dashboard/overview").set(auth(role));
      expect(res.status, `role ${role}`).toBe(200);
      expect(res.body.data.generatedAt).toBeTruthy();
    }
  });

  it("admits every role to the findings list on read:findings", async () => {
    for (const role of ROLES) {
      const res = await request(app).get("/api/findings").set(auth(role));
      expect(res.status, `role ${role}`).toBe(200);
      expect(Array.isArray(res.body.data.items)).toBe(true);
    }
  });
});

describe("Phase 6 overview — per-section gating is real", () => {
  it("restricts the notification section from VIEWER without zeroing it", async () => {
    const res = await request(app).get("/api/dashboard/overview").set(auth("VIEWER"));
    const notifications = res.body.data.sections.notifications;

    expect(notifications.availability).toBe("RESTRICTED");
    expect(notifications.metrics).toEqual({});
    // The whole point: nothing a reader could mistake for a counted zero.
    expect(JSON.stringify(notifications)).not.toMatch(/"value":\s*0/);
  });

  it("gives ANALYST and REVIEWER the notification section they are entitled to", async () => {
    for (const role of ["ANALYST", "REVIEWER", "ADMIN"]) {
      const res = await request(app).get("/api/dashboard/overview").set(auth(role));
      expect(res.body.data.sections.notifications.availability, `role ${role}`).toBe("AVAILABLE");
    }
  });

  it("never returns a geographic coordinate to any role", async () => {
    for (const role of ROLES) {
      const res = await request(app).get("/api/dashboard/overview").set(auth(role));
      expect(res.body.data.geographic.availability).toBe("UNAVAILABLE");
      expect(JSON.stringify(res.body)).not.toMatch(/latitude|longitude/i);
    }
  });

  it("performs no live provider lookup while rendering", async () => {
    const res = await request(app).get("/api/dashboard/overview").set(auth("ADMIN"));
    expect(res.body.data.sections.providers.liveLookupPerformed).toBe(false);
  });
});

describe("Phase 6.1 overview — attention queues over the real route chain", () => {
  it("restricts the notification queue from VIEWER, exactly like the notification section", async () => {
    const res = await request(app).get("/api/dashboard/overview").set(auth("VIEWER"));
    const queue = res.body.data.sections.notificationQueue;

    expect(queue.availability).toBe("RESTRICTED");
    expect(queue.awaitingReview).toBeUndefined();
    // VIEWER still gets the queues it IS entitled to.
    expect(res.body.data.sections.findingQueues.availability).toBe("AVAILABLE");
    expect(res.body.data.sections.caseQueues.availability).toBe("AVAILABLE");
  });

  it("gives every role the finding and case queues, bounded and with a real total", async () => {
    for (const role of ROLES) {
      const res = await request(app).get("/api/dashboard/overview").set(auth(role));
      const { findingQueues, caseQueues } = res.body.data.sections;

      expect(findingQueues.availability, `role ${role}`).toBe("AVAILABLE");
      expect(Array.isArray(findingQueues.priority.items)).toBe(true);
      expect(typeof findingQueues.priority.total).toBe("number");
      expect(caseQueues.availability, `role ${role}`).toBe("AVAILABLE");
      expect(Array.isArray(caseQueues.waitingOnOrganization.items)).toBe(true);
    }
  });

  it("reports the audience role the overview was actually gated against", async () => {
    for (const role of ROLES) {
      const res = await request(app).get("/api/dashboard/overview").set(auth(role));
      expect(res.body.data.audience.role).toBe(role);
    }
  });

  it("returns a real stored 7-day trend with no live provider traffic", async () => {
    const res = await request(app).get("/api/dashboard/overview").set(auth("ADMIN"));
    const trend = res.body.data.sections.ingestionTrend;

    expect(trend.availability).toBe("AVAILABLE");
    expect(trend.days).toHaveLength(7);
    expect(res.body.data.sections.providers.liveLookupPerformed).toBe(false);
  });
});

describe("Phase 6 findings list — input validation", () => {
  it("rejects an unknown filter value by naming the field", async () => {
    const res = await request(app).get("/api/findings?riskBand=SEVERE").set(auth("ANALYST"));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("riskBand");
    // The submitted value is never reflected back into the response body.
    expect(JSON.stringify(res.body)).not.toContain("SEVERE");
  });

  it("rejects an oversized page size instead of quietly clamping it", async () => {
    const res = await request(app).get("/api/findings?pageSize=5000").set(auth("ANALYST"));
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("pageSize");
  });

  it("rejects a non-numeric finding id", async () => {
    const res = await request(app).get("/api/findings/not-an-id").set(auth("ANALYST"));
    expect(res.status).toBe(400);
  });

  it("answers 404 for an id that does not exist", async () => {
    const res = await request(app).get("/api/findings/424242").set(auth("ANALYST"));
    expect(res.status).toBe(404);
  });
});

describe("Phase 6 read routes are reads", () => {
  it("never invokes a Prisma write method", async () => {
    writeCalls.length = 0;

    for (const role of ROLES) {
      await request(app).get("/api/dashboard/overview").set(auth(role));
      await request(app).get("/api/findings").set(auth(role));
      await request(app).get("/api/findings/1").set(auth(role));
    }

    expect(writeCalls).toEqual([]);
  });
});
