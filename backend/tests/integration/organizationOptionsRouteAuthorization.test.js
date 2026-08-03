import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Phase 3 completeness patch — GET /api/organizations/options.
//
// The rest of /api/organizations sits behind manage:system (ADMIN only), so an
// ANALYST creating the first organization-bound case had no way to list the
// registry. This endpoint is gated on manage:cases instead (ADMIN + ANALYST),
// registered before the manage:system gate in organizationRoutes.js, and
// returns only organizationId/name/sector — never contact detail, counters or
// audit data. This file follows the same real-app-plus-stubbed-Prisma shape as
// resourceRouteAuthorization.test.js.

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

// Deliberately carries every sensitive Organization field (contact PII,
// counters) so a test that only checked "did it return 200" could not miss a
// leak — the serializer-safety assertions below inspect the actual response
// body shape.
const RAW_ORGANIZATIONS = [
  {
    id: 1,
    name: "Zed Industries",
    sector: "TECHNOLOGY",
    industry: "Software",
    location: "Lahore",
    contactPerson: "Ops Desk",
    email: "ops@zed.test",
    phone: "+92-300-0000000",
    securityScore: 87,
    activeThreats: 2,
  },
  {
    id: 2,
    name: "Acme Bank",
    sector: "FINANCE",
    industry: "Banking",
    location: "Karachi",
    contactPerson: "Security Team",
    email: "sec@acme.test",
    phone: null,
    securityScore: 91,
    activeThreats: 0,
  },
  {
    id: 3,
    name: "Acme Holdings",
    sector: "FINANCE",
    industry: "Holdings",
    location: "Karachi",
    contactPerson: "Legal",
    email: "legal@acmeholdings.test",
    phone: null,
    securityScore: 95,
    activeThreats: 0,
  },
];

let capturedFindManyArgs;

const prismaStub = {
  organization: {
    findMany: async (args) => {
      capturedFindManyArgs = args;

      const where = args && args.where ? args.where : {};
      const nameFilter =
        where.name && where.name.contains ? where.name.contains.toLowerCase() : null;

      let rows = RAW_ORGANIZATIONS.filter(
        (row) => !nameFilter || row.name.toLowerCase().includes(nameFilter)
      );

      rows = [...rows].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

      const skip = typeof args.skip === "number" ? args.skip : 0;
      const take = typeof args.take === "number" ? args.take : rows.length;
      rows = rows.slice(skip, skip + take);

      // Mimics Prisma's `select` — only the projected fields are returned, so
      // a controller that forgot to allow-list would have nothing extra to
      // leak even if it tried.
      const select = args && args.select ? args.select : null;
      if (!select) return rows.map((row) => ({ ...row }));
      return rows.map((row) => {
        const projected = {};
        Object.keys(select).forEach((key) => {
          if (select[key]) projected[key] = row[key];
        });
        return projected;
      });
    },
  },
  auditLog: {
    create: async ({ data }) => ({ id: 1, ...data }),
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
  capturedFindManyArgs = undefined;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  vi.clearAllMocks();
});

const get = (role, qs = "") =>
  request(app)
    .get(`/api/organizations/options${qs}`)
    .set("Authorization", `Bearer ${tokens[role]}`);

describe("GET /api/organizations/options", () => {
  it("returns 401 with no token", async () => {
    const res = await request(app).get("/api/organizations/options");
    expect(res.status).toBe(401);
  });

  it("ADMIN can read safe organization options", async () => {
    const res = await get("ADMIN");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("ANALYST can read safe organization options", async () => {
    const res = await get("ANALYST");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("REVIEWER is denied before the organization table is ever read", async () => {
    const res = await get("REVIEWER");
    expect(res.status).toBe(403);
    expect(capturedFindManyArgs).toBeUndefined();
  });

  it("VIEWER is denied before the organization table is ever read", async () => {
    const res = await get("VIEWER");
    expect(res.status).toBe(403);
    expect(capturedFindManyArgs).toBeUndefined();
  });

  it("exposes only organizationId, name and sector", async () => {
    const res = await get("ADMIN");
    expect(res.status).toBe(200);
    res.body.data.forEach((row) => {
      expect(Object.keys(row).sort()).toEqual(["name", "organizationId", "sector"]);
    });
  });

  it("never leaks organization contact fields, counters or audit data", async () => {
    const res = await get("ADMIN");
    const serialized = JSON.stringify(res.body.data);
    ["contactPerson", "email", "phone", "industry", "location", "securityScore", "activeThreats"].forEach(
      (leak) => {
        expect(serialized).not.toContain(leak);
      }
    );
    // No PII values themselves leak either.
    expect(serialized).not.toContain("ops@zed.test");
    expect(serialized).not.toContain("+92-300-0000000");
  });

  it("orders results deterministically by name then id", async () => {
    const res = await get("ADMIN");
    expect(res.body.data.map((row) => row.name)).toEqual([
      "Acme Bank",
      "Acme Holdings",
      "Zed Industries",
    ]);
  });

  it("applies a bounded case-insensitive search", async () => {
    const res = await get("ADMIN", "?search=acme");
    expect(res.status).toBe(200);
    expect(res.body.data.map((row) => row.name)).toEqual(["Acme Bank", "Acme Holdings"]);
  });

  it("rejects a search string over the bounded length", async () => {
    const res = await get("ADMIN", `?search=${"a".repeat(101)}`);
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["search"]);
    expect(capturedFindManyArgs).toBeUndefined();
  });

  it("caps an oversized limit rather than rejecting it", async () => {
    const res = await get("ADMIN", "?limit=10000");
    expect(res.status).toBe(200);
    expect(capturedFindManyArgs.take).toBe(50);
  });

  it("rejects a non-numeric limit", async () => {
    const res = await get("ADMIN", "?limit=not-a-number");
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["limit"]);
  });

  it("rejects a negative page", async () => {
    const res = await get("ADMIN", "?page=-1");
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["page"]);
  });

  it("paginates using page and limit together", async () => {
    const res = await get("ADMIN", "?limit=1&page=1");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ organizationId: 3, name: "Acme Holdings", sector: "FINANCE" }]);
  });

  it("returns a safe empty list rather than an error when nothing matches", async () => {
    const res = await get("ADMIN", "?search=no-such-organization-anywhere");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
