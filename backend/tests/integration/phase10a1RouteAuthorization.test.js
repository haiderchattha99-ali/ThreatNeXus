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
    // The summary read: the NEWEST item for one (Finding, provider, subject)
    // triple, with its job. No delegate rows exist in this file — its
    // ABUSEIPDB_API_KEY is empty, so nothing is ever delegated here.
    findFirst: async ({ where = {} }) =>
      store.items
        .filter(
          (r) =>
            r.findingId === where.findingId &&
            r.provider === where.provider &&
            r.subjectType === where.subjectType &&
            r.subjectValue === where.subjectValue
        )
        .sort((a, b) => b.id - a.id)
        .map((r) => ({
          ...r,
          lookupJob: r.lookupJobId
            ? {
                ...store.jobs.find((j) => j.id === r.lookupJobId),
                iocEnrichment: null,
                vulnerabilityEnrichmentJob: null,
              }
            : null,
        }))[0] || null,
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
const summaryPath = (findingId = FINDING_ID) => `/api/findings/${findingId}/enrichment/summary`;

// The contract's exact top-level keys, asserted rather than assumed.
const RUN_BODY_KEYS = ["executionState", "items", "outcome", "run", "success"];
const RUN_RECORD_KEYS = [
  "completedAt",
  "consideredProviders",
  "decisionCounts",
  "findingId",
  "force",
  "id",
  "itemCount",
  "requestedAt",
  "state",
  "trigger",
];
const RUN_ITEM_KEYS = [
  "contacted",
  "decision",
  "lookupState",
  "provider",
  "skipReason",
  "subjectType",
  "subjectValue",
];
const SUMMARY_ROW_KEYS = [
  "asOf",
  "evidence",
  "evidenceAvailable",
  "freshUntil",
  "isStale",
  "provider",
  "purpose",
  "skipReason",
  "source",
  "status",
];

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

describe("GET /api/findings/:id/enrichment/runs/:runId - read:findings", () => {
  const READ_ROLES = ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"];

  it.each(READ_ROLES)("%s can read a single run", async (role) => {
    const created = await auth(request(app).post(runsPath()), "ANALYST").send({
      providers: ["censys"],
    });
    const res = await auth(request(app).get(`${runsPath()}/${created.body.run.id}`), role);
    expect(res.status).toBe(200);
    expect(res.body.run.findingId).toBe(FINDING_ID);
    // Same shape as the POST body, minus `outcome` — nothing was requested.
    expect(Object.keys(res.body).sort()).toEqual(["executionState", "items", "run", "success"]);
    expect(Object.keys(res.body.run).sort()).toEqual(RUN_RECORD_KEYS.slice().sort());
  });

  it("returns 401 for an unauthenticated read", async () => {
    const res = await request(app).get(`${runsPath()}/1`);
    expect(res.status).toBe(401);
  });

  it("returns 404 - not 403 - for a run belonging to ANOTHER Finding", async () => {
    const created = await auth(request(app).post(runsPath()), "ANALYST").send({
      providers: ["censys"],
    });
    const res = await auth(
      request(app).get(`${runsPath(OTHER_FINDING_ID)}/${created.body.run.id}`),
      "ADMIN"
    );
    // Confirming it exists under a 403 would itself leak that another Finding
    // holds a run with this id.
    expect(res.status).toBe(404);
  });
});

describe("Enrichment orchestration paths", () => {
  it("serves the three contract paths and nothing else", async () => {
    const created = await auth(request(app).post(runsPath()), "ANALYST").send({
      providers: ["censys"],
    });
    expect(created.status).toBe(202);
    expect(
      (await auth(request(app).get(`${runsPath()}/${created.body.run.id}`), "ADMIN")).status
    ).toBe(200);
    expect((await auth(request(app).get(summaryPath()), "ADMIN")).status).toBe(200);
  });

  // The unplanned run-list surface was removed rather than kept: a paged
  // history of request records is not part of the binding contract, and the
  // summary answers the question it was standing in for.
  it("404s the removed run-list surface", async () => {
    const res = await auth(request(app).get(runsPath()), "ADMIN");
    expect(res.status).toBe(404);
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
  it("a new run with eligible work is 202 CREATED, with a Location header", async () => {
    const res = await auth(request(app).post(runsPath()), "ANALYST").send({
      providers: ["censys"],
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, outcome: "CREATED" });
    // The response body shape is PINNED here, not derived from convention.
    // `run` and `items` are distinct top-level fields; the run is NOT flattened
    // into a generic `data` object.
    expect(Object.keys(res.body).sort()).toEqual(RUN_BODY_KEYS.slice().sort());
    expect(res.body.data).toBeUndefined();
    expect(Object.keys(res.body.run).sort()).toEqual(RUN_RECORD_KEYS.slice().sort());
    expect(Object.keys(res.body.items[0]).sort()).toEqual(RUN_ITEM_KEYS.slice().sort());
    expect(res.body.items[0].decision).toBe("ELIGIBLE");
    expect(res.body.items[0].contacted).toBe(false);
    // The worker switch is off in this file's environment.
    expect(res.body.executionState).toBe("PAUSED_WORKER_DISABLED");
    // The exact header, pinned.
    expect(res.headers.location).toBe(
      `/api/findings/${FINDING_ID}/enrichment/runs/${res.body.run.id}`
    );
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
    expect(replay.body.run.id).toBe(first.body.run.id);
    // The caller still gets a pointer to the run that exists.
    expect(replay.headers.location).toBe(
      `/api/findings/${FINDING_ID}/enrichment/runs/${first.body.run.id}`
    );
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
    expect(res.body.run.state).toBe("SKIPPED");
    expect(res.body.items[0].decision).toBe("SKIPPED_NOT_CONFIGURED");
    expect(res.headers.location).toBe(
      `/api/findings/${FINDING_ID}/enrichment/runs/${res.body.run.id}`
    );
    // A policy skip creates no outbound work.
    expect(store.jobs).toHaveLength(0);
  });

  it("records nvd as considered-but-unsubjected, durably, and creates NO nvd item", async () => {
    // No FindingVulnerability exists anywhere in this file, so nvd has no
    // subject. It must be reported, not silently omitted — and reported from
    // the STORED column, so a later GET says the same thing.
    const created = await auth(request(app).post(runsPath()), "ANALYST").send({
      providers: ["censys", "nvd"],
    });
    expect(created.status).toBe(202);
    expect(created.body.run.consideredProviders.noSubject).toEqual(["nvd"]);
    // T-09: no NVD item exists, and an IP was never substituted as its subject.
    expect(store.items.some((item) => item.provider === "nvd")).toBe(false);
    expect(created.body.items.map((item) => item.provider)).toEqual(["censys"]);

    const fetched = await auth(
      request(app).get(`${runsPath()}/${created.body.run.id}`),
      "VIEWER"
    );
    // THE regression this pass exists to prevent: the two must not contradict.
    expect(fetched.body.run.consideredProviders).toEqual(
      created.body.run.consideredProviders
    );
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
    // A justification is never SILENTLY DISCARDED. One that fails the bound is
    // a 400, not a request that quietly proceeds with the reason dropped.
    ["a non-string justification", { providers: ["censys"], justification: 42 }],
    ["a blank justification", { providers: ["censys"], justification: "   " }],
    [
      "an over-long justification",
      { providers: ["censys"], justification: "j".repeat(1001) },
    ],
    // force spends real third-party quota once a worker exists. An unexplained
    // bypass is exactly what the audit trail is for.
    ["force=true with no justification", { providers: ["censys"], force: true }],
    [
      "force=true with a blank justification",
      { providers: ["censys"], force: true, justification: "  " },
    ],
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

  it("accepts force=true with a justification, and never echoes it back", async () => {
    const secret = "Escalation TNX-4471: the constituent disputes the cached verdict.";
    const res = await auth(request(app).post(runsPath()), "ANALYST").send({
      providers: ["censys"],
      force: true,
      justification: secret,
    });

    expect(res.status).toBe(202);
    expect(store.runs[0].force).toBe(true);
    // Not in the response, and not stored on the run row.
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(JSON.stringify(store.runs[0])).not.toContain(secret);

    // The audit trail keeps a BOUNDED preview — the existing convention — and
    // nothing longer.
    const created = store.auditLogs.find(
      (event) => event.action === "enrichment.orchestration.run.created"
    );
    expect(created.after.justification).toBe(secret);
    expect(created.after.justification.length).toBeLessThanOrEqual(200);
  });

  it("truncates an over-length justification preview in the audit payload", async () => {
    const long = `${"z".repeat(400)}TAIL`;
    await auth(request(app).post(runsPath()), "ANALYST").send({
      providers: ["censys"],
      force: true,
      justification: long,
    });
    const created = store.auditLogs.find(
      (event) => event.action === "enrichment.orchestration.run.created"
    );
    expect(created.after.justification).toHaveLength(200);
    expect(created.after.justification.endsWith("…")).toBe(true);
    expect(created.after.justification).not.toContain("TAIL");
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
    const single = await auth(request(app).get(`${runsPath()}/${created.body.run.id}`), "ADMIN");
    const summary = await auth(request(app).get(summaryPath()), "ADMIN");

    expect(store.jobs).toHaveLength(1);

    // eslint-disable-next-line no-restricted-syntax
    for (const res of [created, single, summary]) {
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

describe("GET /api/findings/:id/enrichment/summary", () => {
  const READ_ROLES = ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"];

  it.each(READ_ROLES)("%s can read the summary through read:findings", async (role) => {
    const res = await auth(request(app).get(summaryPath()), role);
    expect(res.status).toBe(200);
    expect(res.body.data.findingId).toBe(FINDING_ID);
  });

  it("returns 401 for an unauthenticated request", async () => {
    expect((await request(app).get(summaryPath())).status).toBe(401);
  });

  it("returns 404 for a nonexistent Finding and 400 for a malformed id", async () => {
    expect((await auth(request(app).get(summaryPath(999)), "ADMIN")).status).toBe(404);
    expect(
      (await auth(request(app).get("/api/findings/nope/enrichment/summary"), "ADMIN")).status
    ).toBe(400);
  });

  it("emits ONE timestamped row per known provider, with the pinned shape", async () => {
    const res = await auth(request(app).get(summaryPath()), "ANALYST");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual([
      "asOf",
      "executionState",
      "findingId",
      "providers",
    ]);

    // All six, always, in a stable order. Omitting one would make "we never
    // asked" and "this provider does not exist" indistinguishable.
    expect(res.body.data.providers.map((row) => row.provider)).toEqual([
      "abuseipdb",
      "censys",
      "greynoise",
      "netlas",
      "nvd",
      "shodan",
    ]);

    const censys = res.body.data.providers.find((row) => row.provider === "censys");
    expect(Object.keys(censys).sort()).toEqual(SUMMARY_ROW_KEYS.slice().sort());
    expect(censys.purpose).toBe("EXPOSURE");
    expect(censys.asOf).toBeTruthy();
    // Nothing has been requested for this Finding yet.
    expect(censys.status).toBe("NOT_REQUESTED");
    expect(censys.source).toBe("NONE");
    expect(censys.evidence).toBeNull();
    expect(censys.evidenceAvailable).toBe(false);

    expect(censys.isStale).toBe(false);
  });

  it("shows NVD as considered-with-no-valid-subject, and creates no NVD item", async () => {
    const res = await auth(request(app).get(summaryPath()), "VIEWER");
    const nvd = res.body.data.providers.find((row) => row.provider === "nvd");

    expect(nvd.purpose).toBe("VULNERABILITY");
    // Considered — never silently absent, and never NOT_REQUESTED, which would
    // suggest somebody could have asked.
    expect(nvd.status).toBe("NO_SUBJECT");
    expect(nvd.skipReason).toBe("NO_SUBJECT_FOR_PROVIDER");
    expect(nvd.subjects).toEqual([]);
    // An IP is never substituted as an NVD subject.
    expect(JSON.stringify(nvd)).not.toContain(INDICATOR);
    expect(store.items.some((item) => item.provider === "nvd")).toBe(false);
  });

  it("reflects a recorded item's real state, and never contacts anybody", async () => {
    await auth(request(app).post(runsPath()), "ANALYST").send({ providers: ["censys"] });
    const jobsBefore = store.jobs.length;
    const itemsBefore = store.items.length;
    const runsBefore = store.runs.length;
    const auditsBefore = store.auditLogs.length;

    const res = await auth(request(app).get(summaryPath()), "REVIEWER");
    const censys = res.body.data.providers.find((row) => row.provider === "censys");

    expect(censys.status).toBe("PENDING");
    expect(censys.source).toBe("ORCHESTRATION_JOB");
    // Recorded, not executed: no evidence exists.
    expect(censys.evidenceAvailable).toBe(false);

    expect(res.body.data.executionState).toBe("PAUSED_WORKER_DISABLED");

    // THE claim: a summary read is a pure read. It writes nothing at all.
    expect(store.jobs).toHaveLength(jobsBefore);
    expect(store.items).toHaveLength(itemsBefore);
    expect(store.runs).toHaveLength(runsBefore);
    expect(store.auditLogs).toHaveLength(auditsBefore);
  });

  it("is isolated per Finding - one Finding's item never appears in another's summary", async () => {
    await auth(request(app).post(runsPath(FINDING_ID)), "ANALYST").send({
      providers: ["censys"],
    });

    const other = await auth(request(app).get(summaryPath(OTHER_FINDING_ID)), "ADMIN");
    const censys = other.body.data.providers.find((row) => row.provider === "censys");

    // Finding 2 asked for nothing, even though Finding 1 did — and even though
    // both would share one job if they shared a subject.
    expect(censys.status).toBe("NOT_REQUESTED");
    expect(other.body.data.findingId).toBe(OTHER_FINDING_ID);
    expect(JSON.stringify(other.body)).not.toContain(INDICATOR);
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
