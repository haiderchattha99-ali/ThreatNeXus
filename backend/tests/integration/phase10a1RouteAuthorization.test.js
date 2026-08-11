import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Phase 10A-1 - the HTTP contract and authorization matrix for the enrichment
// orchestration surface, exercised over REAL HTTP against the mounted
// application:
//
//   POST /api/findings/:id/enrichment/runs          trigger:finding-enrichment
//   GET  /api/findings/:id/enrichment/runs          read:findings
//   GET  /api/findings/:id/enrichment/runs/:runId   read:findings
//   GET  /api/enrichment/usage                      execute:enrichment-batch
//
// Mirrors enrichmentRouteAuthorization.test.js's shape exactly: ONLY Prisma is
// stubbed, so the real routes, middleware, controllers and services run end to
// end. That is the point - a service-layer test cannot catch a wrong route, a
// wrong status code, or a capability wired to the wrong grant.
//
// No new capability exists for this surface. Reads reuse READ_FINDINGS and
// writes reuse TRIGGER_FINDING_ENRICHMENT, so these cases assert the EXISTING
// matrix rather than a Phase-10-specific one - and they weaken nothing: every
// denial asserted here is a denial the pre-existing matrix already produces.
//
// Zero network access anywhere. The delegated providers are deliberately kept
// out of the ELIGIBLE paths below (censys is the direct provider under test),
// and no provider is contacted regardless - see the static inertness gate.

const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
  // censys is CONFIGURED -> its targets are genuinely ELIGIBLE, so the 202
  // CREATED case cannot pass trivially against an implementation that skips
  // everything. shodan is deliberately UNCONFIGURED -> the SKIPPED case.
  CENSYS_PAT: "fake-censys-pat-for-tests",
  ABUSEIPDB_API_KEY: "",
  GREYNOISE_API_KEY: "",
  SHODAN_API_KEY: "",
  NETLAS_API_KEY: "",
  NVD_API_KEY: "",
  AUTO_ENRICHMENT_ENABLED: "false",
  ENRICHMENT_WORKER_ENABLED: "false",
};

const FINDING_ID = 1;
const OTHER_FINDING_ID = 2;
const INDICATOR = "203.0.113.90";
const OTHER_INDICATOR = "203.0.113.91";

const store = {
  findings: [],
  runs: [],
  items: [],
  jobs: [],
  auditLogs: [],
  nextId: 100,
};

function nextId() {
  store.nextId += 1;
  return store.nextId;
}

function uniqueViolation() {
  const error = new Error("Unique constraint failed");
  error.code = "P2002";
  return error;
}

const prismaStub = {
  finding: {
    findUnique: async ({ where: { id } }) => store.findings.find((r) => r.id === id) || null,
  },
  // No verified CVE association exists anywhere in this file, so nvd always
  // resolves to "considered, no subject" and never reaches a delegate.
  findingVulnerability: {
    findMany: async () => [],
  },
  findingEnrichmentRun: {
    findUnique: async ({ where }) => {
      if (where.idempotencyKey !== undefined) {
        return store.runs.find((r) => r.idempotencyKey === where.idempotencyKey) || null;
      }
      return store.runs.find((r) => r.id === where.id) || null;
    },
    create: async ({ data }) => {
      if (store.runs.some((r) => r.idempotencyKey === data.idempotencyKey)) throw uniqueViolation();
      const row = { id: nextId(), completedAt: null, ...data };
      store.runs.push(row);
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = store.runs.find((r) => r.id === where.id);
      Object.assign(row, data);
      return { ...row };
    },
    findMany: async ({ where = {}, take } = {}) => {
      const rows = store.runs
        .filter((r) => r.findingId === where.findingId)
        .sort((a, b) => b.requestedAt - a.requestedAt);
      return take ? rows.slice(0, take) : rows;
    },
  },
  findingEnrichmentRunItem: {
    create: async ({ data }) => {
      const duplicate = store.items.some(
        (r) =>
          r.runId === data.runId &&
          r.provider === data.provider &&
          r.subjectType === data.subjectType &&
          r.subjectValue === data.subjectValue
      );
      if (duplicate) throw uniqueViolation();
      const row = { id: nextId(), skipReason: null, lookupJobId: null, ...data };
      store.items.push(row);
      return { ...row };
    },
    findMany: async ({ where = {} }) =>
      store.items
        .filter((r) => r.runId === where.runId)
        .sort((a, b) => a.id - b.id)
        .map((r) => ({
          ...r,
          lookupJob: r.lookupJobId ? store.jobs.find((j) => j.id === r.lookupJobId) || null : null,
        })),
  },
  providerLookupJob: {
    findUnique: async ({ where }) =>
      store.jobs.find((j) => j.activeLookupKey === where.activeLookupKey) || null,
    create: async ({ data }) => {
      if (store.jobs.some((j) => j.activeLookupKey === data.activeLookupKey)) {
        throw uniqueViolation();
      }
      const row = {
        id: nextId(),
        queriedAt: null,
        claimedAt: null,
        claimToken: null,
        attemptCount: 0,
        freshUntil: null,
        iocEnrichmentId: null,
        vulnerabilityEnrichmentJobId: null,
        ...data,
      };
      store.jobs.push(row);
      return { ...row };
    },
    // Freshness: nothing in this file is ever fresh (no job carries freshUntil).
    findFirst: async () => null,
  },
  providerDailyUsage: {
    findMany: async () => [],
  },
  // Only needed by the pre-existing P2-T2e-2 read surface, which one case below
  // calls to prove the Phase-10 paths did not shadow it. Always empty: this
  // file never schedules an IOC delegate (ABUSEIPDB_API_KEY is unset above).
  iocEnrichment: {
    findFirst: async () => null,
    findUnique: async () => null,
    findMany: async () => [],
    count: async () => 0,
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
  store.findings = [
    { id: FINDING_ID, indicatorValue: INDICATOR, status: "OPEN" },
    { id: OTHER_FINDING_ID, indicatorValue: OTHER_INDICATOR, status: "OPEN" },
  ];
  store.runs = [];
  store.items = [];
  store.jobs = [];
  store.auditLogs = [];
  store.nextId = 100;
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

const runsPath = (findingId = FINDING_ID) => `/api/findings/${findingId}/enrichment/runs`;

describe("POST /api/findings/:id/enrichment/runs - authorization", () => {
  const ALLOWED_ROLES = ["ADMIN", "ANALYST"];
  const DENIED_ROLES = ["REVIEWER", "VIEWER"];

  it.each(ALLOWED_ROLES)("%s can create a run", async (role) => {
    const res = await auth(request(app).post(runsPath()), role).send({ providers: ["censys"] });
    expect(res.status).toBe(202);
    expect(res.body.outcome).toBe("CREATED");
  });

  it.each(DENIED_ROLES)("%s is denied with 403 and records nothing", async (role) => {
    const res = await auth(request(app).post(runsPath()), role).send({ providers: ["censys"] });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Forbidden.");
    expect(store.runs).toHaveLength(0);
    expect(store.jobs).toHaveLength(0);
    const denied = store.auditLogs.filter((e) => e.action === "authorization.denied");
    expect(denied).toHaveLength(1);
  });

  it("returns 401 for an unauthenticated request, and records nothing", async () => {
    const res = await request(app).post(runsPath()).send({ providers: ["censys"] });
    expect(res.status).toBe(401);
    expect(store.runs).toHaveLength(0);
    expect(store.jobs).toHaveLength(0);
  });

  it("a denied caller never reaches the service, even with force=true", async () => {
    const res = await auth(request(app).post(runsPath()), "VIEWER").send({
      providers: ["censys"],
      force: true,
    });
    expect(res.status).toBe(403);
    expect(store.runs).toHaveLength(0);
  });

  // 403 and 401 mean different things and must never be conflated: an
  // authenticated-but-unauthorized caller told "401" would be told to
  // re-authenticate, which is both wrong and a weaker audit signal.
  it("a role denial is 403, never downgraded to 401", async () => {
    const res = await auth(request(app).post(runsPath()), "REVIEWER").send({});
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(401);
  });
});

describe("GET /api/findings/:id/enrichment/runs - read:findings", () => {
  const READ_ROLES = ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"];

  it.each(READ_ROLES)("%s can list runs", async (role) => {
    const res = await auth(request(app).get(runsPath()), role);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("runs");
  });

  it("returns 401 for an unauthenticated list", async () => {
    const res = await request(app).get(runsPath());
    expect(res.status).toBe(401);
  });

  it.each(READ_ROLES)("%s can read a single run", async (role) => {
    const created = await auth(request(app).post(runsPath()), "ANALYST").send({
      providers: ["censys"],
    });
    const res = await auth(request(app).get(`${runsPath()}/${created.body.data.id}`), role);
    expect(res.status).toBe(200);
    expect(res.body.data.findingId).toBe(FINDING_ID);
  });

  it("returns 404 - not 403 - for a run belonging to ANOTHER Finding", async () => {
    const created = await auth(request(app).post(runsPath()), "ANALYST").send({
      providers: ["censys"],
    });
    const res = await auth(
      request(app).get(`${runsPath(OTHER_FINDING_ID)}/${created.body.data.id}`),
      "ADMIN"
    );
    // Confirming it exists under a 403 would itself leak that another Finding
    // holds a run with this id.
    expect(res.status).toBe(404);
  });
});

describe("Enrichment orchestration paths", () => {
  it("serves the slash-separated v2.1 paths", async () => {
    const created = await auth(request(app).post(runsPath()), "ANALYST").send({
      providers: ["censys"],
    });
    expect(created.status).toBe(202);
    expect((await auth(request(app).get(runsPath()), "ADMIN")).status).toBe(200);
    expect(
      (await auth(request(app).get(`${runsPath()}/${created.body.data.id}`), "ADMIN")).status
    ).toBe(200);
  });

  it("404s the obsolete hyphenated paths - no alias was retained", async () => {
    const hyphenated = [
      ["post", "/api/findings/1/enrichment-runs"],
      ["get", "/api/findings/1/enrichment-runs"],
      ["get", "/api/findings/1/enrichment-runs/1"],
    ];
    // eslint-disable-next-line no-restricted-syntax
    for (const [method, url] of hyphenated) {
      // eslint-disable-next-line no-await-in-loop
      const res = await auth(request(app)[method](url), "ADMIN").send({});
      expect(res.status).toBe(404);
    }
    expect(store.runs).toHaveLength(0);
  });

  it("does not disturb the pre-existing /:id/enrichments surface", async () => {
    // "/1/enrichments" still routes to the P2-T2e-2 endpoint; the Phase-10
    // paths did not shadow it.
    const res = await auth(request(app).get("/api/findings/1/enrichments"), "ADMIN");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("current");
  });
});

describe("POST /api/findings/:id/enrichment/runs - outcome contract", () => {
  it("a new run with eligible work is 202 CREATED", async () => {
    const res = await auth(request(app).post(runsPath()), "ANALYST").send({
      providers: ["censys"],
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, outcome: "CREATED" });
    // The response body shape is PINNED here, not derived from convention.
    expect(Object.keys(res.body).sort()).toEqual(["data", "outcome", "success"]);
    expect(Object.keys(res.body.data).sort()).toEqual(
      [
        "completedAt",
        "consideredProviders",
        "decisionCounts",
        "execution",
        "findingId",
        "force",
        "id",
        "itemCount",
        "items",
        "requestedAt",
        "state",
        "trigger",
      ].sort()
    );
    expect(Object.keys(res.body.data.items[0]).sort()).toEqual(
      [
        "contacted",
        "decision",
        "lookupState",
        "provider",
        "skipReason",
        "subjectType",
        "subjectValue",
      ].sort()
    );
    expect(res.body.data.items[0].decision).toBe("ELIGIBLE");
    expect(res.body.data.items[0].contacted).toBe(false);
    expect(res.body.data.execution).toEqual({
      performed: false,
      reason: "PHASE_10A1_ORCHESTRATION_ONLY",
    });
  });

  it("an idempotent replay is 200 ALREADY_RUNNING and returns the EXISTING run", async () => {
    const key = "replay-key-0001";
    const first = await auth(request(app).post(runsPath()), "ANALYST")
      .set("Idempotency-Key", key)
      .send({ providers: ["censys"] });
    expect(first.status).toBe(202);
    expect(first.body.outcome).toBe("CREATED");

    const replay = await auth(request(app).post(runsPath()), "ANALYST")
      .set("Idempotency-Key", key)
      .send({ providers: ["censys"] });

    expect(replay.status).toBe(200);
    expect(replay.body.outcome).toBe("ALREADY_RUNNING");
    expect(replay.body.data.id).toBe(first.body.data.id);
    // One run, not two.
    expect(store.runs).toHaveLength(1);
  });

  it("a run whose every target is refused by policy is 200 SKIPPED", async () => {
    // shodan has no credential in this file's environment.
    const res = await auth(request(app).post(runsPath()), "ANALYST").send({
      providers: ["shodan"],
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("SKIPPED");
    expect(res.body.data.state).toBe("SKIPPED");
    expect(res.body.data.items[0].decision).toBe("SKIPPED_NOT_CONFIGURED");
    // A policy skip creates no outbound work.
    expect(store.jobs).toHaveLength(0);
  });

  it("returns 404 for a nonexistent Finding", async () => {
    const res = await auth(request(app).post(runsPath(999)), "ANALYST").send({
      providers: ["censys"],
    });
    expect(res.status).toBe(404);
    expect(store.runs).toHaveLength(0);
  });
});

describe("POST /api/findings/:id/enrichment/runs - input validation", () => {
  const BAD_BODIES = [
    ["an unknown provider", { providers: ["censsy"] }],
    ["an empty provider array", { providers: [] }],
    ["a non-array provider scope", { providers: "censys" }],
    ["a non-boolean force", { providers: ["censys"], force: "yes" }],
  ];

  it.each(BAD_BODIES)("rejects %s with 400 and records nothing", async (_label, body) => {
    const res = await auth(request(app).post(runsPath()), "ANALYST").send(body);
    expect(res.status).toBe(400);
    expect(store.runs).toHaveLength(0);
    expect(store.jobs).toHaveLength(0);
  });

  it("rejects an over-long Idempotency-Key with 400, naming the rule not the value", async () => {
    const secret = "S".repeat(200);
    const res = await auth(request(app).post(runsPath()), "ANALYST")
      .set("Idempotency-Key", secret)
      .send({ providers: ["censys"] });
    expect(res.status).toBe(400);
    // The rejected value is never echoed back.
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(store.runs).toHaveLength(0);
  });

  // The CONTROL-CHARACTER rule is deliberately not exercised over HTTP: Node's
  // client refuses to transmit one, so such a request can never reach the
  // application and the case would only be testing Node. That rule is proven
  // directly against hashIdempotencyKeyHeader in
  // tests/unit/enrichmentIdentity.test.js. A supplied-but-empty key IS
  // transmittable, so it stands in as the malformed-header HTTP case.
  it("rejects a supplied-but-empty Idempotency-Key with 400", async () => {
    const res = await auth(request(app).post(runsPath()), "ANALYST")
      .set("Idempotency-Key", "   ")
      .send({ providers: ["censys"] });
    expect(res.status).toBe(400);
    expect(store.runs).toHaveLength(0);
  });

  it("rejects a non-numeric finding id with 400", async () => {
    const res = await auth(
      request(app).post("/api/findings/not-a-number/enrichment/runs"),
      "ANALYST"
    ).send({ providers: ["censys"] });
    expect(res.status).toBe(400);
  });
});

describe("Enrichment orchestration responses leak no internal identifier", () => {
  const FORBIDDEN = [
    "lookupJobId",
    "queryIdentityHash",
    "requestScopeHash",
    "idempotencyKey",
    "activeLookupKey",
    "claimToken",
    "iocEnrichmentId",
    "vulnerabilityEnrichmentJobId",
  ];

  it("never serializes a job id, an identity hash, a claim token or a foreign subject", async () => {
    const created = await auth(request(app).post(runsPath()), "ANALYST")
      .set("Idempotency-Key", "leak-check-key")
      .send({ providers: ["censys"] });
    const single = await auth(request(app).get(`${runsPath()}/${created.body.data.id}`), "ADMIN");
    const list = await auth(request(app).get(runsPath()), "ADMIN");

    expect(store.jobs).toHaveLength(1);

    // eslint-disable-next-line no-restricted-syntax
    for (const res of [created, single, list]) {
      const serialized = JSON.stringify(res.body);
      // eslint-disable-next-line no-restricted-syntax
      for (const field of FORBIDDEN) {
        expect(serialized).not.toContain(field);
      }
      expect(serialized).not.toContain("leak-check-key");
      // The shared job's primary key must not be inferable either.
      expect(serialized).not.toContain(String(store.jobs[0].id));
      // No other Finding's subject.
      expect(serialized).not.toContain(OTHER_INDICATOR);
    }
  });
});

describe("GET /api/enrichment/usage - execute:enrichment-batch is ADMIN only", () => {
  const DENIED_ROLES = ["ANALYST", "REVIEWER", "VIEWER"];

  it("ADMIN can read usage, and it states its own partial coverage", async () => {
    const res = await auth(request(app).get("/api/enrichment/usage"), "ADMIN");
    expect(res.status).toBe(200);
    expect(res.body.data.accountingScope).toBe("PHASE_10_RESERVATIONS");
    expect(res.body.data.coverage).toBe("PARTIAL");
    expect(res.body.data.reservationsActive).toBe(false);
    expect(Array.isArray(res.body.data.excludedPaths)).toBe(true);
  });

  it.each(DENIED_ROLES)("%s is denied with 403", async (role) => {
    const res = await auth(request(app).get("/api/enrichment/usage"), role);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Forbidden.");
  });

  it("returns 401 for an unauthenticated request", async () => {
    const res = await request(app).get("/api/enrichment/usage");
    expect(res.status).toBe(401);
  });
});
