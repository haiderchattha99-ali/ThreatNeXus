import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// The complete Phase 5 HTTP surface and its capability matrix.
//
// The central claim is that the capability split is REAL: every role is driven
// against every route, and a denied request is proven to have created NO ROW —
// not merely to have answered 403. That distinction matters because the
// middleware is the only thing standing between a REVIEWER and the mapping
// mutation path; if a controller were ever reachable, the service's own guards
// would be the last line rather than the second.
//
// Only Prisma is stubbed (via the shared workflow fake), so the real routes,
// the real middleware chain, the real controllers and the real services all
// run.

const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { createWorkflowPrismaFake } = require("../unit/fixtures/workflowPrismaFake");

// Self-defaulted, never inherited from the shell — the environment rule
// recorded in STATUS.md. An exported JWT_SECRET would make the server verify
// with a different secret than tokenFor() signs with, and every request would
// 401 in a way that reads like an authorization regression.
const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
  // The shipped default. Every assertion below therefore describes the system
  // as it actually ships, with AI off.
  AI_ENABLED: "false",
  AI_PROVIDER: "null",
};

const ROLES = ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"];

let fake;
let client;
let state;
let app;
const tokens = {};

const prismaProxy = new Proxy(
  {},
  {
    get(_target, property) {
      return client[property];
    },
    has(_target, property) {
      return property in client;
    },
  }
);

beforeAll(() => {
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
    exports: prismaProxy,
  };

  app = require("../../src/app");

  ROLES.forEach((role, index) => {
    tokens[role] = jwt.sign(
      { id: index + 1, email: `${role.toLowerCase()}@example.test`, role },
      JWT_SECRET
    );
  });
  tokens.UNKNOWN = jwt.sign({ id: 99, email: "ghost@example.test", role: "superuser" }, JWT_SECRET);
});

afterAll(() => {
  ROLES.forEach((role) => delete tokens[role]);
});

let errorSpy;
let ORG_ID;
let CASE_ID;
let FINDING_ID;
let MAPPING_ID;

// Counts every durable row a Phase 5 mutation could possibly create. A denied
// request must leave every one of these unchanged.
function rowCounts() {
  return {
    mappings: state.caseFrameworkMappings.length,
    runs: state.aiSuggestionRuns.length,
    suggestions: state.aiFrameworkMappingSuggestions.length,
    decisions: state.aiSuggestionDecisions.length,
  };
}

async function seed() {
  const organization = await client.organization.create({
    data: { name: "Acme Bank", sector: "FINANCE", contactPerson: "SOC", email: "soc@acme.example" },
  });
  ORG_ID = organization.id;

  const finding = await client.finding.create({
    data: {
      indicatorValue: "203.0.113.10",
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      firstSeen: new Date("2026-08-01T00:00:00.000Z"),
      lastSeen: new Date("2026-08-02T00:00:00.000Z"),
      occurrenceCount: 2,
    },
  });
  FINDING_ID = finding.id;

  const record = await client.case.create({
    data: {
      title: "Accessible RDP",
      threatType: "Accessible RDP",
      organization: "Acme Bank",
      analyst: "a.analyst",
      organizationId: ORG_ID,
      lifecycleState: "OPEN",
      caseReference: "TNX-2026-000051",
    },
  });
  CASE_ID = record.id;

  await client.caseFinding.create({
    data: {
      caseId: CASE_ID,
      findingId: FINDING_ID,
      state: "LINKED",
      organizationId: ORG_ID,
      ownershipStatusAtLink: "RESOLVED",
      ownershipConfidenceAtLink: "HIGH",
      effectiveAt: new Date("2026-08-02T00:00:00.000Z"),
      supersededAt: null,
      currentLinkKey: `${CASE_ID}:${finding.id}`,
    },
  });
}

const as = (role) => ({ Authorization: `Bearer ${tokens[role]}` });

const NIST_BODY = {
  framework: "NIST_CSF",
  frameworkVersion: "2.0",
  referenceId: "PR.AA-01",
  referenceTitle: "Identities and credentials are managed",
  mappingScope: "CASE",
  evidenceBasis: "CONTROL_GAP",
  rationale:
    "Administrative remote access is reachable from any network, indicating access permissions " +
    "are not constrained to authorised sources.",
};

beforeEach(async () => {
  fake = createWorkflowPrismaFake();
  client = fake.client;
  state = fake.state;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  await seed();

  const created = await request(app)
    .post(`/api/cases/${CASE_ID}/framework-mappings`)
    .set(as("ANALYST"))
    .send(NIST_BODY);
  MAPPING_ID = created.body.data.mapping.id;
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
});

// Every route, the capability that gates it, and the roles that hold it.
const ROUTES = [
  {
    label: "list active mappings",
    method: "get",
    url: () => `/api/cases/${CASE_ID}/framework-mappings`,
    allowed: ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"],
    denied: [],
  },
  {
    label: "mapping history",
    method: "get",
    url: () => `/api/cases/${CASE_ID}/framework-mappings/history`,
    allowed: ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"],
    denied: [],
  },
  {
    label: "create mapping",
    method: "post",
    url: () => `/api/cases/${CASE_ID}/framework-mappings`,
    body: () => ({ ...NIST_BODY, referenceId: "PR.AA-02" }),
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
  },
  {
    label: "remove mapping",
    method: "post",
    url: () => `/api/cases/${CASE_ID}/framework-mappings/${MAPPING_ID}/remove`,
    body: () => ({ reason: "Withdrawn after review of the control assessment." }),
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
  },
  {
    label: "list suggestions",
    method: "get",
    url: () => `/api/cases/${CASE_ID}/ai/mapping-suggestions`,
    allowed: ["ADMIN", "ANALYST", "REVIEWER"],
    denied: ["VIEWER"],
  },
  {
    label: "request suggestions",
    method: "post",
    url: () => `/api/cases/${CASE_ID}/ai/mapping-suggestions`,
    body: () => ({}),
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
  },
  {
    label: "approve suggestion",
    method: "post",
    url: () => `/api/cases/${CASE_ID}/ai/mapping-suggestions/1/approve`,
    body: () => ({}),
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
  },
  {
    label: "reject suggestion",
    method: "post",
    url: () => `/api/cases/${CASE_ID}/ai/mapping-suggestions/1/reject`,
    body: () => ({ reason: "not applicable" }),
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
  },
  {
    label: "ai config",
    method: "get",
    url: () => "/api/ai/config",
    allowed: ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"],
    denied: [],
  },
];

function send(route, role) {
  const req = request(app)[route.method](route.url()).set(as(role));
  return route.body ? req.send(route.body()) : req.send();
}

describe("Phase 5 capability matrix", () => {
  ROUTES.forEach((route) => {
    route.allowed.forEach((role) => {
      it(`${role} may reach "${route.label}"`, async () => {
        const res = await send(route, role);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });
    });

    route.denied.forEach((role) => {
      it(`${role} is refused "${route.label}" and creates no row`, async () => {
        const before = rowCounts();
        const res = await send(route, role);
        expect(res.status).toBe(403);
        expect(res.body).toEqual(expect.objectContaining({ success: false }));
        // The denial must not tell an unauthorized caller which capability to
        // obtain — that is free reconnaissance.
        expect(JSON.stringify(res.body)).not.toContain("framework-mappings");
        expect(JSON.stringify(res.body)).not.toContain("ai-mapping-suggestions");
        expect(rowCounts()).toEqual(before);
      });
    });
  });
});

describe("authentication", () => {
  it("refuses every Phase 5 route without a token", async () => {
    const before = rowCounts();
    for (const route of ROUTES) {
      const req = request(app)[route.method](route.url());
      // eslint-disable-next-line no-await-in-loop
      const res = route.body ? await req.send(route.body()) : await req.send();
      expect(res.status).toBe(401);
    }
    expect(rowCounts()).toEqual(before);
  });

  // An unrecognised role resolves to null and holds NO capability at all — it
  // does not silently acquire VIEWER's reads.
  it("refuses an unknown role everywhere, including on reads", async () => {
    const before = rowCounts();
    for (const route of ROUTES) {
      // eslint-disable-next-line no-await-in-loop
      const res = await send(route, "UNKNOWN");
      expect(res.status).toBe(403);
    }
    expect(rowCounts()).toEqual(before);
  });
});

describe("read-only roles see mappings but not machine proposals", () => {
  it("lets VIEWER read active mappings", async () => {
    const res = await request(app)
      .get(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("VIEWER"));
    expect(res.status).toBe(200);
    expect(res.body.data.activeCount).toBe(1);
    expect(res.body.data.groups[0].mappings[0].referenceId).toBe("PR.AA-01");
  });

  it("denies VIEWER the suggestion history entirely", async () => {
    const res = await request(app)
      .get(`/api/cases/${CASE_ID}/ai/mapping-suggestions`)
      .set(as("VIEWER"));
    expect(res.status).toBe(403);
  });

  it("lets REVIEWER read suggestions but not mutate or generate", async () => {
    const read = await request(app)
      .get(`/api/cases/${CASE_ID}/ai/mapping-suggestions`)
      .set(as("REVIEWER"));
    expect(read.status).toBe(200);

    const before = rowCounts();
    const generate = await request(app)
      .post(`/api/cases/${CASE_ID}/ai/mapping-suggestions`)
      .set(as("REVIEWER"))
      .send({});
    expect(generate.status).toBe(403);
    expect(rowCounts()).toEqual(before);
  });
});

describe("input handling", () => {
  it("rejects unknown body fields rather than dropping them", async () => {
    const before = rowCounts();
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send({ ...NIST_BODY, referenceId: "PR.AA-03", source: "AI_SUGGESTION_PROMOTED" });

    expect(res.status).toBe(400);
    expect(res.body.fields).toContain("source");
    expect(rowCounts()).toEqual(before);
  });

  // A caller must not be able to forge provenance, backdate a mapping, or claim
  // a mapping was AI-promoted when it was typed by hand.
  it("refuses every internal field a caller might try to set", async () => {
    for (const field of [
      "state",
      "actorUserId",
      "effectiveAt",
      "currentMappingKey",
      "organizationId",
      "supersededAt",
      "id",
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .post(`/api/cases/${CASE_ID}/framework-mappings`)
        .set(as("ANALYST"))
        .send({ ...NIST_BODY, referenceId: "PR.AA-04", [field]: 1 });
      expect(res.status).toBe(400);
      expect(res.body.fields).toContain(field);
    }
  });

  it("answers 400 for a non-numeric case id", async () => {
    const res = await request(app)
      .get("/api/cases/not-a-number/framework-mappings")
      .set(as("ANALYST"));
    expect(res.status).toBe(400);
  });

  it("answers 404 for a case that does not exist", async () => {
    const res = await request(app).get("/api/cases/999999/framework-mappings").set(as("ANALYST"));
    expect(res.status).toBe(404);
  });

  it("answers 400 with the closed rejection code for an exposure-only ATT&CK mapping", async () => {
    const before = rowCounts();
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send({
        framework: "MITRE_ATTACK",
        frameworkVersion: "v17.1",
        referenceId: "T1021.001",
        referenceTitle: "Remote Services: Remote Desktop Protocol",
        mappingScope: "CASE",
        evidenceBasis: "CONTROL_GAP",
        rationale: "Port 3389 is exposed and CVE-2019-0708 applies with a high reputation score.",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ATTACK_REQUIRES_OBSERVED_BEHAVIOR");
    expect(rowCounts()).toEqual(before);
  });
});

describe("shipped default: AI is off", () => {
  it("reports the assistance state without exposing configuration", async () => {
    const res = await request(app).get("/api/ai/config").set(as("VIEWER"));
    expect(res.status).toBe(200);
    expect(res.body.data.aiEnabled).toBe(false);
    expect(res.body.data.assistanceAvailable).toBe(false);
    expect(res.body.data.reasonCode).toBe("AI_DISABLED");

    const blob = JSON.stringify(res.body).toLowerCase();
    ["apikey", "secret", "token", "http://", "https://", "temperature"].forEach((needle) => {
      expect(blob).not.toContain(needle);
    });
  });

  it("answers a suggestion request with a recorded DISABLED run and no suggestion", async () => {
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/ai/mapping-suggestions`)
      .set(as("ANALYST"))
      .send({});

    // 200, not 503: the request was well formed and was answered. The shipped
    // default is "off", not "broken".
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("DISABLED");
    expect(res.body.data.reasonCode).toBe("AI_DISABLED");
    expect(res.body.data.suggestions).toEqual([]);
    expect(state.aiFrameworkMappingSuggestions).toHaveLength(0);
    expect(state.aiSuggestionRuns).toHaveLength(1);
  });

  // The whole point of "AI is optional": the manual path is unaffected.
  it("completes the entire manual mapping workflow with AI off", async () => {
    const created = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send({ ...NIST_BODY, referenceId: "PR.AA-05" });
    expect(created.status).toBe(201);

    const removed = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/${created.body.data.mapping.id}/remove`)
      .set(as("ANALYST"))
      .send({ reason: "Reassessed; the control is in place after all." });
    expect(removed.status).toBe(200);
    expect(removed.body.data.outcome).toBe("REMOVED");

    const reactivated = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send({ ...NIST_BODY, referenceId: "PR.AA-05" });
    expect(reactivated.body.data.outcome).toBe("REACTIVATED");

    const history = await request(app)
      .get(`/api/cases/${CASE_ID}/framework-mappings/history`)
      .set(as("VIEWER"));
    expect(history.status).toBe(200);
    expect(history.body.data.total).toBe(4);
  });
});

describe("response safety", () => {
  it("never returns a current-row key or an input fingerprint", async () => {
    await request(app)
      .post(`/api/cases/${CASE_ID}/ai/mapping-suggestions`)
      .set(as("ANALYST"))
      .send({ requestContext: "focus on access control" });

    for (const url of [
      `/api/cases/${CASE_ID}/framework-mappings`,
      `/api/cases/${CASE_ID}/framework-mappings/history`,
      `/api/cases/${CASE_ID}/ai/mapping-suggestions`,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(url).set(as("ANALYST"));
      const blob = JSON.stringify(res.body);
      expect(blob).not.toContain("currentMappingKey");
      expect(blob).not.toContain("inputFingerprint");
      expect(blob).not.toContain("promotedFromSuggestion");
    }
  });

  it("carries the compliance disclaimer on every mapping read", async () => {
    const res = await request(app)
      .get(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("VIEWER"));
    expect(res.body.data.disclaimer).toMatch(/analyst-associated context only/i);
    expect(res.body.data.catalogueNote).toMatch(/pins no local framework catalogue/i);
  });

  it("never claims an organization is compliant", async () => {
    const res = await request(app)
      .get(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("VIEWER"));
    const blob = JSON.stringify(res.body).toLowerCase();
    // The disclaimer is the ONLY place these words may appear, and there they
    // appear as negations.
    expect(blob).toContain("does not state that a control is implemented");
    const withoutDisclaimer = blob
      .split(res.body.data.disclaimer.toLowerCase())
      .join("")
      .split(res.body.data.catalogueNote.toLowerCase())
      .join("");
    ["compliant", "certified", "audited"].forEach((word) => {
      expect(withoutDisclaimer).not.toContain(word);
    });
  });

  it("never returns a Prisma or stack detail on failure", async () => {
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/999999/remove`)
      .set(as("ANALYST"))
      .send({ reason: "does not exist" });

    expect([404, 409]).toContain(res.status);
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain("prisma");
    expect(blob).not.toContain("at Object.");
    expect(blob).not.toContain("node_modules");
  });
});
