import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Authorization + request-surface matrix for the Phase 3 analyst-workflow HTTP
// surface:
//
//   GET  /api/findings/:id/triage                         read:findings
//   PUT  /api/findings/:id/triage                         triage:findings
//   GET  /api/cases            /:id      /:id/workflow    read:cases
//   POST /api/cases            (create)                   manage:cases
//   POST /api/cases/:id/findings                          manage:cases
//   POST /api/cases/:id/findings/:findingId/unlink        manage:cases
//   POST /api/cases/:id/state                             manage:cases
//   POST /api/cases/:id/responses                         manage:cases
//   POST /api/cases/:id/closure-requests                  manage:cases
//   POST /api/cases/:id/reopen                            manage:cases
//   POST /api/cases/:id/closure-requests/:rid/approve     review:case-closure
//   POST /api/cases/:id/closure-requests/:rid/reject      review:case-closure
//
// Only Prisma is stubbed, so the real routes, middleware, controllers and
// services run end to end. The load-bearing claims defended here:
//
//   * a denied request is answered by the middleware and reaches NO service —
//     proven by asserting that not one durable row was written
//   * ANALYST can request a closure and can never approve one
//   * REVIEWER can decide a closure and can never triage, link, respond,
//     change state or reopen
//   * VIEWER can read and write nothing
//   * no response carries an organization contact, an internal current-row key
//     or the recurrence idempotency key

const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { createWorkflowPrismaFake } = require("../unit/fixtures/workflowPrismaFake");

const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
};

const ROLES = ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"];
const USER_IDS = { ADMIN: 1, ANALYST: 2, REVIEWER: 3, VIEWER: 4 };

const CONTACT_EMAIL = "ops-desk@acme.invalid";
const INDICATOR = "192.0.2.10";

// The live fake is swapped per test, so the module-level prisma singleton the
// app captured at require time must be a stable proxy that forwards to it.
let live = null;
const prismaProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      const model = live && live.client[prop];
      if (typeof model === "function") return model.bind(live.client);
      return model;
    },
  }
);

let app;
let originalEnv;
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
    exports: prismaProxy,
  };

  app = require("../../src/app");

  ROLES.forEach((role) => {
    tokens[role] = jwt.sign(
      { id: USER_IDS[role], email: `${role.toLowerCase()}@example.test`, role },
      JWT_SECRET
    );
  });
  tokens.UNKNOWN = jwt.sign({ id: 99, email: "ghost@example.test", role: "superuser" }, JWT_SECRET);
});

afterAll(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

let errorSpy;
let logSpy;
let state;
let ids;

/** Total durable Phase 3 rows, so "a denied request wrote nothing" is checkable. */
function workflowRowCount() {
  return (
    state.findingTriages.length +
    state.caseFindings.length +
    state.caseOrganizationResponses.length +
    state.caseClosureRequests.length +
    state.caseRecurrenceReopens.length +
    // The CREATED event of the seeded case is the only lifecycle row that
    // exists before any request is made.
    state.caseLifecycleEvents.length
  );
}

beforeEach(async () => {
  live = createWorkflowPrismaFake();
  state = live.state;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  const organization = await live.client.organization.create({
    data: {
      name: "Acme Bank",
      sector: "FINANCE",
      // Present on the row, and never publishable.
      email: CONTACT_EMAIL,
      phone: "+1-555-0100",
      contactPerson: "Ops Desk",
      industry: "Finance",
      location: "Karachi",
    },
  });
  const finding = await live.client.finding.create({
    data: {
      indicatorValue: INDICATOR,
      port: 3389,
      protocol: "tcp",
      reportType: "accessible-rdp",
      status: "OPEN",
      occurrenceCount: 1,
      recurrenceCount: 0,
    },
  });
  await live.client.findingOwnership.create({
    data: {
      findingId: finding.id,
      status: "RESOLVED",
      confidence: "HIGH",
      organizationId: organization.id,
      isIspAttribution: false,
      reasonCode: "EXACT_IP_MATCH",
      currentForFindingId: finding.id,
    },
  });

  const caseRecord = await live.client.case.create({
    data: {
      title: "Accessible RDP on constituent host",
      threatType: "Accessible RDP",
      organization: "Acme Bank",
      analyst: "a.analyst",
      priority: "High",
      status: "Open",
      organizationId: organization.id,
      lifecycleState: "OPEN",
      caseReference: "TNX-2026-000001",
    },
  });
  await live.client.caseLifecycleEvent.create({
    data: {
      caseId: caseRecord.id,
      eventType: "CREATED",
      fromState: null,
      toState: "OPEN",
      reasonCode: "CASE_CREATED",
      occurredAt: new Date("2026-08-01T08:00:00.000Z"),
    },
  });

  ids = { organizationId: organization.id, findingId: finding.id, caseId: caseRecord.id };
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  vi.clearAllMocks();
});

const as = (role) => (req) =>
  role === null ? req : req.set("Authorization", `Bearer ${tokens[role]}`);

// ---------------------------------------------------------------------------
// The route matrix
// ---------------------------------------------------------------------------

/** Every Phase 3 route, with the roles that hold its capability. */
function routes() {
  const { caseId, findingId, organizationId } = ids;
  return [
    {
      label: "GET finding triage",
      capability: "read:findings",
      allowed: ROLES,
      call: (r) => as(r)(request(app).get(`/api/findings/${findingId}/triage`)),
    },
    {
      label: "PUT finding triage",
      capability: "triage:findings",
      allowed: ["ADMIN", "ANALYST"],
      call: (r) =>
        as(r)(request(app).put(`/api/findings/${findingId}/triage`)).send({
          decision: "IN_REVIEW",
        }),
    },
    {
      label: "GET case list",
      capability: "read:cases",
      allowed: ROLES,
      call: (r) => as(r)(request(app).get("/api/cases")),
    },
    {
      label: "GET case detail",
      capability: "read:cases",
      allowed: ROLES,
      call: (r) => as(r)(request(app).get(`/api/cases/${caseId}`)),
    },
    {
      label: "GET case workflow",
      capability: "read:cases",
      allowed: ROLES,
      call: (r) => as(r)(request(app).get(`/api/cases/${caseId}/workflow`)),
    },
    {
      label: "POST create case",
      capability: "manage:cases",
      allowed: ["ADMIN", "ANALYST"],
      call: (r) =>
        as(r)(request(app).post("/api/cases")).send({
          title: "Second case",
          threatType: "Accessible RDP",
          organization: "Acme Bank",
          analyst: "a.analyst",
          organizationId,
        }),
    },
    {
      label: "POST link finding",
      capability: "manage:cases",
      allowed: ["ADMIN", "ANALYST"],
      call: (r) => as(r)(request(app).post(`/api/cases/${caseId}/findings`)).send({ findingId }),
    },
    {
      label: "POST unlink finding",
      capability: "manage:cases",
      allowed: ["ADMIN", "ANALYST"],
      call: (r) =>
        as(r)(request(app).post(`/api/cases/${caseId}/findings/${findingId}/unlink`)).send({
          reason: "Not evidence after all",
        }),
    },
    {
      label: "POST change state",
      capability: "manage:cases",
      allowed: ["ADMIN", "ANALYST"],
      call: (r) =>
        as(r)(request(app).post(`/api/cases/${caseId}/state`)).send({
          toState: "WAITING_FOR_ORG",
        }),
    },
    {
      label: "POST organization response",
      capability: "manage:cases",
      allowed: ["ADMIN", "ANALYST"],
      call: (r) =>
        as(r)(request(app).post(`/api/cases/${caseId}/responses`)).send({
          responseType: "ACKNOWLEDGED",
          summary: "Constituent acknowledged",
        }),
    },
    {
      label: "POST closure request",
      capability: "manage:cases",
      allowed: ["ADMIN", "ANALYST"],
      call: (r) =>
        as(r)(request(app).post(`/api/cases/${caseId}/closure-requests`)).send({
          closureReason: "FALSE_POSITIVE",
          justification: "Scanner artefact",
        }),
    },
    {
      label: "POST manual reopen",
      capability: "manage:cases",
      allowed: ["ADMIN", "ANALYST"],
      call: (r) =>
        as(r)(request(app).post(`/api/cases/${caseId}/reopen`)).send({ reason: "Seen again" }),
    },
    {
      label: "POST approve closure",
      capability: "review:case-closure",
      allowed: ["ADMIN", "REVIEWER"],
      call: (r) =>
        as(r)(request(app).post(`/api/cases/${caseId}/closure-requests/4242/approve`)).send({}),
    },
    {
      label: "POST reject closure",
      capability: "review:case-closure",
      allowed: ["ADMIN", "REVIEWER"],
      call: (r) =>
        as(r)(request(app).post(`/api/cases/${caseId}/closure-requests/4242/reject`)).send({
          reviewNote: "Insufficient evidence",
        }),
    },
  ];
}

describe("Phase 3 route authorization matrix", () => {
  it("refuses every route with 401 when unauthenticated, and writes nothing", async () => {
    const before = workflowRowCount();

    // eslint-disable-next-line no-restricted-syntax
    for (const route of routes()) {
      // eslint-disable-next-line no-await-in-loop
      const res = await route.call(null);
      expect(res.status, route.label).toBe(401);
      expect(res.body.message).toBe("Authentication required.");
    }

    expect(workflowRowCount()).toBe(before);
    expect(state.auditLogs.filter((e) => e.action.startsWith("case."))).toHaveLength(0);
  });

  // The matrix asserts reachability only: these calls run in sequence against
  // one evolving case, so several are legitimately refused on STATE (409) or
  // for an unknown request id (404). What matters here is that none of them is
  // ever refused on AUTHORIZATION. The per-route success paths are proven in
  // the dedicated describes below.
  it("lets every role holding the capability reach the handler, never a 401/403", async () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const route of routes()) {
      // eslint-disable-next-line no-restricted-syntax
      for (const role of route.allowed) {
        // eslint-disable-next-line no-await-in-loop
        const res = await route.call(role);
        expect([401, 403], `${route.label} as ${role} -> ${res.status}`).not.toContain(res.status);
        expect(res.status, `${route.label} as ${role}`).toBeLessThan(500);
      }
    }
  });

  // The core claim: a denied request never reaches a service, so no row and no
  // domain audit event can exist afterwards.
  it("refuses every role without the capability with 403, creating no rows", async () => {
    const before = workflowRowCount();

    // eslint-disable-next-line no-restricted-syntax
    for (const route of routes()) {
      const denied = ROLES.filter((role) => !route.allowed.includes(role));
      // eslint-disable-next-line no-restricted-syntax
      for (const role of denied) {
        // eslint-disable-next-line no-await-in-loop
        const res = await route.call(role);
        expect(res.status, `${route.label} as ${role}`).toBe(403);
        expect(res.body).toMatchObject({ success: false, message: "Forbidden." });
      }
    }

    expect(workflowRowCount()).toBe(before);
    expect(state.cases).toHaveLength(1);
  });

  it("fails closed for a validly signed token carrying an unknown role", async () => {
    const before = workflowRowCount();

    // eslint-disable-next-line no-restricted-syntax
    for (const route of routes()) {
      // eslint-disable-next-line no-await-in-loop
      const res = await route.call("UNKNOWN");
      expect(res.status, route.label).toBe(403);
    }

    expect(workflowRowCount()).toBe(before);
  });

  it("records the required capability in the audit reason but never in the response", async () => {
    const res = await request(app)
      .post(`/api/cases/${ids.caseId}/state`)
      .set("Authorization", `Bearer ${tokens.REVIEWER}`)
      .send({ toState: "WAITING_FOR_ORG" });

    expect(res.status).toBe(403);
    const [denied] = state.auditLogs.filter((e) => e.action === "authorization.denied");
    expect(denied.reason).toContain("manage:cases");
    expect(JSON.stringify(res.body)).not.toContain("manage:cases");
  });
});

// ---------------------------------------------------------------------------
// Separation of duties, exercised as a whole workflow over HTTP
// ---------------------------------------------------------------------------

const post = (role, url, body) =>
  request(app).post(url).set("Authorization", `Bearer ${tokens[role]}`).send(body || {});
const put = (role, url, body) =>
  request(app).put(url).set("Authorization", `Bearer ${tokens[role]}`).send(body || {});
const get = (role, url) => request(app).get(url).set("Authorization", `Bearer ${tokens[role]}`);

describe("separation of duties across the closure workflow", () => {
  async function analystRequestsClosure(closureReason = "FALSE_POSITIVE") {
    const res = await post(
      "ANALYST",
      `/api/cases/${ids.caseId}/closure-requests`,
      { closureReason, justification: "Closing this out" }
    );
    expect(res.status).toBe(201);
    return res.body.data.pendingClosureRequest;
  }

  it("lets an ANALYST request a closure and refuses their approval at the route", async () => {
    const pending = await analystRequestsClosure();
    expect(pending.state).toBe("PENDING");

    const approve = await post(
      "ANALYST",
      `/api/cases/${ids.caseId}/closure-requests/${pending.id}/approve`
    );
    expect(approve.status).toBe(403);
    expect(approve.body.message).toBe("Forbidden.");

    // The case stayed pending and the request was never decided.
    expect(state.cases[0].lifecycleState).toBe("CLOSURE_PENDING");
    expect(state.caseClosureRequests[0].state).toBe("PENDING");
  });

  it("lets a REVIEWER approve and close, without ever being able to manage the case", async () => {
    const pending = await analystRequestsClosure();

    const approve = await post(
      "REVIEWER",
      `/api/cases/${ids.caseId}/closure-requests/${pending.id}/approve`,
      { reviewNote: "Agreed" }
    );
    expect(approve.status).toBe(200);
    expect(approve.body.data.case.lifecycleState).toBe("CLOSED");
    expect(approve.body.data.case.closureReason).toBe("FALSE_POSITIVE");

    // ...and still cannot do any ordinary case work.
    expect((await post("REVIEWER", `/api/cases/${ids.caseId}/reopen`, { reason: "x" })).status).toBe(
      403
    );
    expect(
      (await put(`REVIEWER`, `/api/findings/${ids.findingId}/triage`, { decision: "IN_REVIEW" }))
        .status
    ).toBe(403);
  });

  it("lets a REVIEWER reject, returning the case to OPEN with the reason recorded", async () => {
    const pending = await analystRequestsClosure();

    const rejected = await post(
      "REVIEWER",
      `/api/cases/${ids.caseId}/closure-requests/${pending.id}/reject`,
      { reviewNote: "Attach the remediation evidence first" }
    );

    expect(rejected.status).toBe(200);
    expect(rejected.body.data.case.lifecycleState).toBe("OPEN");
    expect(rejected.body.data.closureRequests[0]).toMatchObject({
      state: "REJECTED",
      reviewNote: "Attach the remediation evidence first",
      isPending: false,
    });
  });

  it("refuses rejection with no reviewer note", async () => {
    const pending = await analystRequestsClosure();

    const res = await post(
      "REVIEWER",
      `/api/cases/${ids.caseId}/closure-requests/${pending.id}/reject`
    );
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["reviewNote"]);
    expect(state.caseClosureRequests[0].state).toBe("PENDING");
  });

  // The one deliberate escape hatch: ADMIN holds override:closure-self-approval.
  // Every other role is refused, ANALYST at the route and REVIEWER at the
  // service (a reviewer cannot request a closure, so it is unreachable for them
  // over HTTP — the service guard is proven directly in the unit suite).
  it("permits ADMIN self-approval, which is the only self-approval path that exists", async () => {
    const requested = await post("ADMIN", `/api/cases/${ids.caseId}/closure-requests`, {
      closureReason: "DUPLICATE",
      justification: "Duplicate of an earlier case",
    });
    expect(requested.status).toBe(201);
    const pending = requested.body.data.pendingClosureRequest;

    const approved = await post(
      "ADMIN",
      `/api/cases/${ids.caseId}/closure-requests/${pending.id}/approve`
    );
    expect(approved.status).toBe(200);
    expect(approved.body.data.case.lifecycleState).toBe("CLOSED");
  });

  it("refuses a REMEDIATED closure with no recorded REMEDIATED response", async () => {
    const res = await post("ANALYST", `/api/cases/${ids.caseId}/closure-requests`, {
      closureReason: "REMEDIATED",
      justification: "They told us it is fixed",
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REMEDIATED_RESPONSE_REQUIRED");
    expect(state.caseClosureRequests).toHaveLength(0);
    expect(state.cases[0].lifecycleState).toBe("OPEN");
  });

  it("accepts the REMEDIATED closure once the response exists, and records which one", async () => {
    const recorded = await post("ANALYST", `/api/cases/${ids.caseId}/responses`, {
      responseType: "REMEDIATED",
      summary: "Constituent closed port 3389",
      occurredAt: "2026-08-02T09:00:00.000Z",
    });
    expect(recorded.status).toBe(200);
    const responseId = recorded.body.data.organizationResponses[0].id;

    const requested = await post("ANALYST", `/api/cases/${ids.caseId}/closure-requests`, {
      closureReason: "REMEDIATED",
      justification: "Verified by the constituent",
    });

    expect(requested.status).toBe(201);
    expect(requested.body.data.pendingClosureRequest.supportingResponseId).toBe(responseId);
  });
});

// ---------------------------------------------------------------------------
// Triage over HTTP
// ---------------------------------------------------------------------------

describe("finding triage surface", () => {
  it("reports UNTRIAGED for a Finding with no decision yet", async () => {
    const res = await get("VIEWER", `/api/findings/${ids.findingId}/triage`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ decision: "UNTRIAGED", current: null, history: [] });
  });

  it("records a decision and returns the previous one", async () => {
    await put("ANALYST", `/api/findings/${ids.findingId}/triage`, { decision: "IN_REVIEW" });
    const res = await put("ANALYST", `/api/findings/${ids.findingId}/triage`, {
      decision: "DISMISSED",
      reason: "Host decommissioned",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.decision).toBe("DISMISSED");
    expect(res.body.data.previousDecision).toBe("IN_REVIEW");
    expect(res.body.data.history).toHaveLength(2);
    expect(res.body.data.history.filter((row) => row.isCurrent)).toHaveLength(1);
  });

  it("refuses DISMISSED with no reason and lists the closed decision vocabulary", async () => {
    const res = await put("ANALYST", `/api/findings/${ids.findingId}/triage`, {
      decision: "DISMISSED",
    });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["reason"]);
    expect(res.body.allowedDecisions).toEqual(["IN_REVIEW", "ESCALATED", "DISMISSED"]);
    expect(state.findingTriages).toHaveLength(0);
  });

  // A caller must never be able to backdate a decision, attribute it to a case,
  // or claim it came from the system rather than from them.
  it("rejects unexpected fields rather than silently dropping them", async () => {
    const res = await put("ANALYST", `/api/findings/${ids.findingId}/triage`, {
      decision: "IN_REVIEW",
      source: "RECURRENCE_REOPEN",
      decidedAt: "1999-01-01T00:00:00.000Z",
      caseId: 1,
      currentForFindingId: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Unexpected fields.");
    expect(res.body.fields.sort()).toEqual(
      ["caseId", "currentForFindingId", "decidedAt", "source"].sort()
    );
    expect(state.findingTriages).toHaveLength(0);
  });

  it("answers 404 for an unknown Finding and 400 for a malformed id", async () => {
    expect((await get("ANALYST", "/api/findings/424242/triage")).status).toBe(404);
    expect((await get("ANALYST", "/api/findings/not-an-id/triage")).status).toBe(400);
    expect(
      (await put("ANALYST", "/api/findings/not-an-id/triage", { decision: "IN_REVIEW" })).status
    ).toBe(400);
  });

  it("shows the case a linked Finding was escalated into", async () => {
    await post("ANALYST", `/api/cases/${ids.caseId}/findings`, { findingId: ids.findingId });

    const res = await get("VIEWER", `/api/findings/${ids.findingId}/triage`);
    expect(res.body.data.decision).toBe("ESCALATED");
    expect(res.body.data.current.source).toBe("CASE_LINK");
    expect(res.body.data.linkedCases[0]).toMatchObject({
      id: ids.caseId,
      caseReference: "TNX-2026-000001",
    });
  });
});

// ---------------------------------------------------------------------------
// Evidence linkage over HTTP
// ---------------------------------------------------------------------------

describe("evidence linkage surface", () => {
  it("links a Finding and returns the refreshed workflow view", async () => {
    const res = await post("ANALYST", `/api/cases/${ids.caseId}/findings`, {
      findingId: ids.findingId,
      reason: "Same host, same exposure",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.linkedFindings).toHaveLength(1);
    expect(res.body.data.linkedFindings[0]).toMatchObject({
      findingId: ids.findingId,
      state: "LINKED",
      ownershipStatusAtLink: "RESOLVED",
      isCurrent: true,
    });
    expect(res.body.data.linkedFindings[0].finding.indicatorValue).toBe(INDICATOR);
  });

  it("refuses a Finding whose ownership does not match, naming what to fix", async () => {
    const other = await live.client.organization.create({ data: { name: "Beta Utilities" } });
    await live.client.findingOwnership.updateMany({
      where: { currentForFindingId: ids.findingId },
      data: { organizationId: other.id },
    });

    const res = await post("ANALYST", `/api/cases/${ids.caseId}/findings`, {
      findingId: ids.findingId,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OWNERSHIP_ORGANIZATION_MISMATCH");
    expect(state.caseFindings).toHaveLength(0);
    expect(state.findingTriages).toHaveLength(0);
  });

  it("requires a findingId and rejects unexpected link fields", async () => {
    const missing = await post("ANALYST", `/api/cases/${ids.caseId}/findings`, {});
    expect(missing.status).toBe(400);
    expect(missing.body.fields).toEqual(["findingId"]);

    const unexpected = await post("ANALYST", `/api/cases/${ids.caseId}/findings`, {
      findingId: ids.findingId,
      effectiveAt: "1999-01-01T00:00:00.000Z",
      organizationId: 1,
    });
    expect(unexpected.status).toBe(400);
    expect(unexpected.body.fields.sort()).toEqual(["effectiveAt", "organizationId"]);
    expect(state.caseFindings).toHaveLength(0);
  });

  it("unlinks with a reason and keeps the original link row visible", async () => {
    await post("ANALYST", `/api/cases/${ids.caseId}/findings`, { findingId: ids.findingId });

    const res = await post(
      "ANALYST",
      `/api/cases/${ids.caseId}/findings/${ids.findingId}/unlink`,
      { reason: "Belongs to a different exposure" }
    );

    expect(res.status).toBe(200);
    expect(res.body.data.linkedFindings).toHaveLength(0);
    expect(state.caseFindings).toHaveLength(2);
    expect(state.caseFindings[0].state).toBe("LINKED");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle surface
// ---------------------------------------------------------------------------

describe("lifecycle surface", () => {
  it("moves OPEN <-> WAITING_FOR_ORG and exposes the timeline", async () => {
    const res = await post("ANALYST", `/api/cases/${ids.caseId}/state`, {
      toState: "WAITING_FOR_ORG",
      note: "Notified the constituent",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.case.lifecycleState).toBe("WAITING_FOR_ORG");
    const transition = res.body.data.lifecycleEvents.find((e) => e.eventType === "STATE_CHANGED");
    expect(transition).toMatchObject({
      fromState: "OPEN",
      toState: "WAITING_FOR_ORG",
      reasonCode: "STATE_CHANGED_BY_ANALYST",
    });
  });

  it("refuses CLOSED and CLOSURE_PENDING as directly settable states", async () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const toState of ["CLOSED", "CLOSURE_PENDING", "ARCHIVED"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post("ANALYST", `/api/cases/${ids.caseId}/state`, { toState });
      expect(res.status, toState).toBe(400);
      expect(res.body.allowedStates).toEqual(["OPEN", "WAITING_FOR_ORG"]);
    }
    expect(state.cases[0].lifecycleState).toBe("OPEN");
  });

  it("publishes permittedActions derived from the case state alone", async () => {
    const open = await get("VIEWER", `/api/cases/${ids.caseId}/workflow`);
    expect(open.body.data.permittedActions).toMatchObject({
      isOrganizationBound: true,
      canLinkFindings: true,
      canRequestClosure: true,
      canReviewClosure: false,
      canReopen: false,
      availableStates: ["WAITING_FOR_ORG"],
    });

    await post("ANALYST", `/api/cases/${ids.caseId}/closure-requests`, {
      closureReason: "OTHER",
      justification: "No longer reachable",
    });

    // A VIEWER sees the same state-derived block: it describes the CASE, never
    // the caller. The backend re-checks the capability on every mutation.
    const pending = await get("VIEWER", `/api/cases/${ids.caseId}/workflow`);
    expect(pending.body.data.permittedActions).toMatchObject({
      canLinkFindings: false,
      canRequestClosure: false,
      canReviewClosure: true,
      availableStates: [],
    });
  });

  it("refuses a state change that would withdraw a pending closure", async () => {
    await post("ANALYST", `/api/cases/${ids.caseId}/closure-requests`, {
      closureReason: "OTHER",
      justification: "No longer reachable",
    });

    const res = await post("ANALYST", `/api/cases/${ids.caseId}/state`, { toState: "OPEN" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CASE_STATE_NOT_ANALYST_SETTABLE");
    expect(state.cases[0].lifecycleState).toBe("CLOSURE_PENDING");
    expect(state.caseClosureRequests[0].state).toBe("PENDING");
  });

  it("refuses a manual reopen of a case that is not closed", async () => {
    const res = await post("ANALYST", `/api/cases/${ids.caseId}/reopen`, { reason: "Seen again" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CASE_NOT_CLOSED");
  });

  it("requires a reason on manual reopen", async () => {
    await post("ANALYST", `/api/cases/${ids.caseId}/closure-requests`, {
      closureReason: "ACCEPTED_RISK",
      justification: "Accepted",
    });
    const pending = state.caseClosureRequests[0];
    await post(
      "REVIEWER",
      `/api/cases/${ids.caseId}/closure-requests/${pending.id}/approve`
    );

    const noReason = await post("ANALYST", `/api/cases/${ids.caseId}/reopen`, {});
    expect(noReason.status).toBe(400);
    expect(noReason.body.fields).toEqual(["reason"]);
    expect(state.cases[0].lifecycleState).toBe("CLOSED");

    const reopened = await post("ANALYST", `/api/cases/${ids.caseId}/reopen`, {
      reason: "Risk acceptance withdrawn",
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.case).toMatchObject({
      lifecycleState: "OPEN",
      lastReopenTrigger: "MANUAL",
      reopenedByRecurrence: false,
      reopenedCount: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Response safety
// ---------------------------------------------------------------------------

describe("safe API surface", () => {
  async function fullyPopulatedWorkflow() {
    await post("ANALYST", `/api/cases/${ids.caseId}/findings`, { findingId: ids.findingId });
    await post("ANALYST", `/api/cases/${ids.caseId}/responses`, {
      responseType: "REMEDIATED",
      summary: "Port closed",
      reference: "TICKET-4711",
    });
    await post("ANALYST", `/api/cases/${ids.caseId}/closure-requests`, {
      closureReason: "REMEDIATED",
      justification: "Verified",
    });
    const pending = state.caseClosureRequests[0];
    await post(
      "REVIEWER",
      `/api/cases/${ids.caseId}/closure-requests/${pending.id}/approve`
    );
    await live.client.caseRecurrenceReopen.create({
      data: {
        caseId: ids.caseId,
        findingId: ids.findingId,
        findingOccurrenceId: 987654,
        outcome: "REOPENED",
        observedAt: new Date("2026-08-03T06:00:00.000Z"),
        processedAt: new Date("2026-08-03T06:05:00.000Z"),
      },
    });
    return get("VIEWER", `/api/cases/${ids.caseId}/workflow`);
  }

  it("never exposes an organization contact, a current-row key or the recurrence key", async () => {
    const res = await fullyPopulatedWorkflow();
    expect(res.status).toBe(200);

    const body = JSON.stringify(res.body);
    // Organization contacts.
    expect(body).not.toContain(CONTACT_EMAIL);
    expect(body).not.toContain("+1-555-0100");
    expect(body).not.toContain("Ops Desk");
    // Internal current-row keys.
    expect(body).not.toContain("currentForFindingId");
    expect(body).not.toContain("currentLinkKey");
    expect(body).not.toContain("activeCaseId");
    // The recurrence idempotency key.
    expect(body).not.toContain("findingOccurrenceId");
    expect(body).not.toContain("987654");
    // Audit rows are never read by, or returned from, a Phase 3 read path.
    expect(body).not.toContain("auditLog");

    // The organization IS present, reduced to the three displayable fields.
    expect(res.body.data.case.ownerOrganization).toEqual({
      id: ids.organizationId,
      name: "Acme Bank",
      sector: "FINANCE",
    });
    expect(res.body.data.recurrenceReopens[0]).toMatchObject({ outcome: "REOPENED" });
  });

  it("keeps the same exclusions on the list and legacy detail endpoints", async () => {
    await fullyPopulatedWorkflow();

    // eslint-disable-next-line no-restricted-syntax
    for (const url of ["/api/cases", `/api/cases/${ids.caseId}`]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await get("VIEWER", url);
      expect(res.status, url).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body, url).not.toContain(CONTACT_EMAIL);
      expect(body, url).not.toContain("currentLinkKey");
      expect(body, url).not.toContain("findingOccurrenceId");
    }
  });

  it("reports a linked-Finding count on the list without a per-case query", async () => {
    await post("ANALYST", `/api/cases/${ids.caseId}/findings`, { findingId: ids.findingId });

    const res = await get("VIEWER", "/api/cases");
    expect(res.body.data[0]).toMatchObject({
      id: ids.caseId,
      lifecycleState: "OPEN",
      linkedFindingCount: 1,
    });
  });

  it("answers a fixed 500 body with no Prisma detail when a read fails", async () => {
    const original = live.client.case.findUnique;
    live.client.case.findUnique = async () => {
      throw new Error("Invalid `prisma.case.findUnique()` invocation: column detail");
    };

    try {
      const res = await get("ANALYST", `/api/cases/${ids.caseId}/workflow`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, message: "Server Error" });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("column detail");
    } finally {
      live.client.case.findUnique = original;
    }
  });

  it("rejects a malformed case id on every workflow route", async () => {
    const malformed = [
      get("ANALYST", "/api/cases/not-an-id/workflow"),
      post("ANALYST", "/api/cases/not-an-id/findings", { findingId: ids.findingId }),
      post("ANALYST", "/api/cases/not-an-id/state", { toState: "OPEN" }),
      post("ANALYST", "/api/cases/not-an-id/responses", {
        responseType: "OTHER",
        summary: "x",
      }),
      post("ANALYST", "/api/cases/not-an-id/closure-requests", {
        closureReason: "OTHER",
        justification: "x",
      }),
      post("ANALYST", "/api/cases/not-an-id/reopen", { reason: "x" }),
      post("REVIEWER", "/api/cases/not-an-id/closure-requests/1/approve"),
      post("REVIEWER", `/api/cases/${ids.caseId}/closure-requests/not-an-id/reject`, {
        reviewNote: "x",
      }),
    ];

    // eslint-disable-next-line no-restricted-syntax
    for (const pending of malformed) {
      // eslint-disable-next-line no-await-in-loop
      expect((await pending).status).toBe(400);
    }
  });

  it("rejects an unparseable organization-response occurredAt rather than defaulting it", async () => {
    const res = await post("ANALYST", `/api/cases/${ids.caseId}/responses`, {
      responseType: "ACKNOWLEDGED",
      summary: "Acknowledged",
      occurredAt: "not-a-date",
    });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["occurredAt"]);
    expect(state.caseOrganizationResponses).toHaveLength(0);
  });
});
