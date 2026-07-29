import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Authorization + request-surface matrix for the P2-T3 risk routes:
//   GET  /api/findings/:id/risk             (read:findings)
//   POST /api/findings/:id/risk/recalculate (recalculate:finding-risk)
//
// Mirrors enrichmentRouteAuthorization.test.js's shape: only Prisma is
// stubbed, so the real routes/middleware/controllers/services/engine run end
// to end. No network access anywhere — risk scoring performs no I/O.
//
// The load-bearing claim these tests defend: the HTTP surface can influence
// WHEN a score is calculated and WHY, and nothing else. There is no way to
// supply a weight, a score, a band, a configuration version or an asOf.

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

const DAY = 86400000;

const store = {
  findings: [],
  occurrences: [],
  ownerships: [],
  organizations: [],
  iocEnrichments: [],
  riskScores: [],
  contributions: [],
  auditLogs: [],
  nextScoreId: 1,
  nextContributionId: 1,
};

function sortRows(rows, orderBy) {
  return [...rows].sort((a, b) => {
    for (const clause of orderBy) {
      const [field, dir] = Object.entries(clause)[0];
      const av = a[field] instanceof Date ? a[field].getTime() : a[field] ?? -Infinity;
      const bv = b[field] instanceof Date ? b[field].getTime() : b[field] ?? -Infinity;
      if (av !== bv) return dir === "desc" ? bv - av : av - bv;
    }
    return 0;
  });
}

const prismaStub = {
  finding: {
    findUnique: async ({ where: { id } }) => store.findings.find((r) => r.id === id) || null,
  },
  findingOccurrence: {
    findMany: async ({ where = {} } = {}) =>
      store.occurrences
        .filter((r) => r.findingId === where.findingId)
        .filter((r) => (where.observedAt ? r.observedAt <= where.observedAt.lte : true)),
  },
  findingOwnership: {
    findUnique: async ({ where }) =>
      store.ownerships.find((r) => r.currentForFindingId === where.currentForFindingId) || null,
  },
  organization: {
    findUnique: async ({ where: { id } }) => store.organizations.find((r) => r.id === id) || null,
  },
  iocEnrichment: {
    findMany: async () => [],
  },
  riskScore: {
    findUnique: async ({ where }) =>
      store.riskScores.find((r) => r.currentForFindingId === where.currentForFindingId) || null,
    findMany: async ({ where = {}, orderBy = [], skip = 0, take } = {}) => {
      const rows = sortRows(
        store.riskScores.filter((r) => r.findingId === where.findingId),
        orderBy
      );
      return rows.slice(skip, take ? skip + take : undefined);
    },
    count: async ({ where = {} } = {}) =>
      store.riskScores.filter((r) => r.findingId === where.findingId).length,
    update: async ({ where, data }) => {
      const row = store.riskScores.find((r) => r.id === where.id);
      Object.assign(row, data);
      return { ...row };
    },
    create: async ({ data }) => {
      const row = {
        id: store.nextScoreId++,
        calculatedAt: new Date(),
        supersededAt: null,
        ...data,
      };
      store.riskScores.push(row);
      return { ...row };
    },
  },
  riskFactorContribution: {
    createMany: async ({ data }) => {
      data.forEach((row) => store.contributions.push({ id: store.nextContributionId++, ...row }));
      return { count: data.length };
    },
    findMany: async ({ where = {} } = {}) => {
      const ids = where.riskScoreId && where.riskScoreId.in ? where.riskScoreId.in : [where.riskScoreId];
      return store.contributions
        .filter((r) => ids.includes(r.riskScoreId))
        .sort((a, b) => a.riskScoreId - b.riskScoreId || a.displayOrder - b.displayOrder);
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
  const firstSeen = new Date(Date.now() - 3 * DAY);
  store.findings = [
    {
      id: 1,
      indicatorValue: "203.0.113.60",
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      status: "OPEN",
      firstSeen,
      lastSeen: new Date(),
    },
  ];
  store.occurrences = [{ id: 1, findingId: 1, action: "CREATED", observedAt: firstSeen }];
  store.ownerships = [];
  store.organizations = [];
  store.iocEnrichments = [];
  store.riskScores = [];
  store.contributions = [];
  store.auditLogs = [];
  store.nextScoreId = 1;
  store.nextContributionId = 1;
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

describe("GET /api/findings/:id/risk — read:findings", () => {
  const READ_ROLES = ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"];

  it.each(READ_ROLES)("%s can read risk context", async (role) => {
    const res = await auth(request(app).get("/api/findings/1/risk"), role);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("current");
    expect(res.body.data).toHaveProperty("history");
    expect(res.body.data).toHaveProperty("pagination");
    expect(res.body.data.findingId).toBe(1);
  });

  it("returns 401 for an unauthenticated read", async () => {
    const res = await request(app).get("/api/findings/1/risk");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a nonexistent finding", async () => {
    const res = await auth(request(app).get("/api/findings/999/risk"), "ADMIN");
    expect(res.status).toBe(404);
  });

  it("returns 400 for a malformed finding id", async () => {
    const res = await auth(request(app).get("/api/findings/not-a-number/risk"), "ADMIN");
    expect(res.status).toBe(400);
  });

  it("returns a null current score for a Finding that has never been scored", async () => {
    const res = await auth(request(app).get("/api/findings/1/risk"), "VIEWER");
    expect(res.status).toBe(200);
    expect(res.body.data.current).toBeNull();
  });

  it("rejects a malformed page, pageSize or includeHistory rather than silently defaulting", async () => {
    const bad = [
      "/api/findings/1/risk?page=0",
      "/api/findings/1/risk?page=abc",
      "/api/findings/1/risk?pageSize=0",
      "/api/findings/1/risk?pageSize=101",
      "/api/findings/1/risk?includeHistory=yes",
    ];
    // eslint-disable-next-line no-restricted-syntax
    for (const url of bad) {
      // eslint-disable-next-line no-await-in-loop
      const res = await auth(request(app).get(url), "ADMIN");
      expect(res.status).toBe(400);
    }
  });

  it("a GET never causes a calculation — reads are strictly safe", async () => {
    await auth(request(app).get("/api/findings/1/risk"), "ADMIN");
    expect(store.riskScores).toHaveLength(0);
    expect(store.auditLogs).toHaveLength(0);
  });
});

describe("POST /api/findings/:id/risk/recalculate — recalculate:finding-risk is ADMIN + ANALYST only", () => {
  const ALLOWED_ROLES = ["ADMIN", "ANALYST"];
  const DENIED_ROLES = ["REVIEWER", "VIEWER"];

  it.each(ALLOWED_ROLES)("%s can recalculate risk", async (role) => {
    const res = await auth(request(app).post("/api/findings/1/risk/recalculate"), role).send({
      justification: "analyst triage review",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe("CREATED");
    expect(res.body.data.current.scoreBasisPoints).toBe(2300);
    expect(res.body.data.current.riskBand).toBe("LOW");
    expect(store.riskScores).toHaveLength(1);
  });

  it.each(DENIED_ROLES)("%s is denied with 403 and nothing is calculated", async (role) => {
    const res = await auth(request(app).post("/api/findings/1/risk/recalculate"), role).send({
      justification: "trying anyway",
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Forbidden.");
    expect(store.riskScores).toHaveLength(0);
    expect(store.contributions).toHaveLength(0);
    const denied = store.auditLogs.filter((e) => e.action === "authorization.denied");
    expect(denied).toHaveLength(1);
  });

  it("returns 401 for an unauthenticated request, and calculates nothing", async () => {
    const res = await request(app)
      .post("/api/findings/1/risk/recalculate")
      .send({ justification: "no token" });
    expect(res.status).toBe(401);
    expect(store.riskScores).toHaveLength(0);
  });

  it("requires a justification", async () => {
    const missing = await auth(
      request(app).post("/api/findings/1/risk/recalculate"),
      "ANALYST"
    ).send({});
    expect(missing.status).toBe(400);

    const blank = await auth(request(app).post("/api/findings/1/risk/recalculate"), "ANALYST").send({
      justification: "   ",
    });
    expect(blank.status).toBe(400);
    expect(store.riskScores).toHaveLength(0);
  });

  it("rejects an over-long justification without calculating", async () => {
    const res = await auth(request(app).post("/api/findings/1/risk/recalculate"), "ANALYST").send({
      justification: "x".repeat(1001),
    });
    expect(res.status).toBe(400);
    expect(store.riskScores).toHaveLength(0);
  });

  it("returns 404 for a nonexistent finding", async () => {
    const res = await auth(request(app).post("/api/findings/999/risk/recalculate"), "ADMIN").send({
      justification: "does not exist",
    });
    expect(res.status).toBe(404);
    expect(store.riskScores).toHaveLength(0);
  });

  it("emits a bounded requested/completed audit pair, attributed to the actor", async () => {
    await auth(request(app).post("/api/findings/1/risk/recalculate"), "ANALYST").send({
      justification: "escalated by SOC",
    });

    const actions = store.auditLogs.map((e) => e.action);
    expect(actions).toEqual([
      "risk.manual.recalculation.requested",
      "risk.manual.recalculation.completed",
    ]);
    expect(store.riskScores[0].trigger).toBe("MANUAL");
    expect(store.riskScores[0].actorUserId).toBe(2); // ANALYST token id
    expect(store.riskScores[0].justification).toBe("escalated by SOC");
  });

  it("returns UNCHANGED without appending history when nothing changed", async () => {
    const body = { justification: "second look" };
    const first = await auth(request(app).post("/api/findings/1/risk/recalculate"), "ADMIN").send(body);
    const second = await auth(request(app).post("/api/findings/1/risk/recalculate"), "ADMIN").send(body);

    expect(first.body.data.outcome).toBe("CREATED");
    expect(second.body.data.outcome).toBe("UNCHANGED");
    expect(store.riskScores).toHaveLength(1);
  });

  it("appends a new snapshot and supersedes the old one when the evidence changed", async () => {
    await auth(request(app).post("/api/findings/1/risk/recalculate"), "ADMIN").send({
      justification: "before",
    });
    store.occurrences.push({
      id: 2,
      findingId: 1,
      action: "PERSISTED",
      observedAt: new Date(Date.now() - DAY),
    });
    const res = await auth(request(app).post("/api/findings/1/risk/recalculate"), "ADMIN").send({
      justification: "after a new report",
    });

    expect(res.body.data.outcome).toBe("CREATED");
    expect(res.body.data.current.scoreBasisPoints).toBe(2700);
    expect(store.riskScores).toHaveLength(2);
    expect(store.riskScores.filter((r) => r.currentForFindingId === 1)).toHaveLength(1);
  });
});

describe("the request can never influence the score itself", () => {
  const ATTACKER_BODY = {
    justification: "legitimate-looking reason",
    scoreBasisPoints: 10000,
    riskBand: "CRITICAL",
    displayScore: 100,
    weights: { sourceSeverity: 9999 },
    factorMaximums: { persistence: 9999 },
    configuration: { scoreMaxBasisPoints: 999999 },
    configurationVersion: "v9.9.9",
    algorithmVersion: "attacker-algorithm",
    asOf: "1999-01-01T00:00:00Z",
    trigger: "INGESTION",
    actorUserId: 999,
    contributions: [{ factorKey: "sourceSeverity", contributionBasisPoints: 9999 }],
  };

  it("ignores every score-shaped field in the request body", async () => {
    const res = await auth(request(app).post("/api/findings/1/risk/recalculate"), "ADMIN").send(
      ATTACKER_BODY
    );

    expect(res.status).toBe(200);
    const stored = store.riskScores[0];
    expect(stored.scoreBasisPoints).toBe(2300);
    expect(stored.riskBand).toBe("LOW");
    expect(stored.algorithmVersion).toBe("risk-additive-bucketed-v1");
    expect(stored.configurationVersion).toBe("v1.0.0");
    // The trigger is fixed by the endpoint, not chosen by the caller.
    expect(stored.trigger).toBe("MANUAL");
    // The actor comes from the verified token, never from the body.
    expect(stored.actorUserId).toBe(1);
  });

  it("ignores a caller-supplied asOf — the controller captures now exactly once", async () => {
    const before = Date.now();
    await auth(request(app).post("/api/findings/1/risk/recalculate"), "ADMIN").send(ATTACKER_BODY);
    const after = Date.now();

    const asOf = new Date(store.riskScores[0].asOf).getTime();
    expect(asOf).toBeGreaterThanOrEqual(before);
    expect(asOf).toBeLessThanOrEqual(after);
    expect(new Date(store.riskScores[0].asOf).getFullYear()).not.toBe(1999);
  });

  it("still stores a complete contribution set, all within their own caps", async () => {
    await auth(request(app).post("/api/findings/1/risk/recalculate"), "ADMIN").send(ATTACKER_BODY);
    expect(store.contributions).toHaveLength(10);
    store.contributions.forEach((row) => {
      expect(row.contributionBasisPoints).toBeLessThanOrEqual(row.maximumContributionBasisPoints);
    });
  });
});

describe("response surface", () => {
  it("exposes the explanation rendered from stored rows, and never an internal row dump", async () => {
    await auth(request(app).post("/api/findings/1/risk/recalculate"), "ADMIN").send({
      justification: "seed a score",
    });
    const res = await auth(request(app).get("/api/findings/1/risk"), "VIEWER");

    expect(res.status).toBe(200);
    const current = res.body.data.current;
    expect(current.explanation.summary).toContain("2300 of 10000 basis points (LOW)");
    expect(current.contributions).toHaveLength(10);
    current.contributions.forEach((row) => {
      expect(Object.keys(row).sort()).toEqual(
        [
          "factorKey",
          "applicability",
          "contributionBasisPoints",
          "maximumContributionBasisPoints",
          "normalizedInputValue",
          "explanationCode",
          "evidenceSummary",
          "displayOrder",
        ].sort()
      );
    });
    // No raw evidence pass-through, no actor id, no internal pointer column.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("currentForFindingId");
    expect(serialized).not.toContain("actorUserId");
    expect(serialized).not.toContain("evidenceSnapshot");
  });

  it("never leaks the victim indicator through the risk surface", async () => {
    await auth(request(app).post("/api/findings/1/risk/recalculate"), "ADMIN").send({
      justification: "seed a score",
    });
    const res = await auth(request(app).get("/api/findings/1/risk"), "ADMIN");
    expect(JSON.stringify(res.body)).not.toContain("203.0.113.60");
  });

  it("shows a NOT_AVAILABLE reputation factor as unavailable, never as clean", async () => {
    await auth(request(app).post("/api/findings/1/risk/recalculate"), "ADMIN").send({
      justification: "seed a score",
    });
    const res = await auth(request(app).get("/api/findings/1/risk"), "REVIEWER");
    const ioc = res.body.data.current.contributions.find(
      (c) => c.factorKey === "iocReputationContext"
    );
    expect(ioc.applicability).toBe("NOT_AVAILABLE");
    expect(ioc.contributionBasisPoints).toBe(0);
    expect(ioc.explanationCode).toBe("IOC_REPUTATION_ABSENT");
    const sentence = res.body.data.current.explanation.factors.find(
      (f) => f.factorKey === "iocReputationContext"
    ).sentence;
    expect(sentence).toContain("Reputation unavailable");
  });
});
