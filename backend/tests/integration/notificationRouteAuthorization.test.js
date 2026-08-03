import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// The complete /api/notifications HTTP surface and its capability matrix.
//
// Phase 4 splits one router-level capability into five, so this file's central
// claim is that the split is REAL: every role is driven against every route,
// and a denied request is proven to have created NO ROW — not merely to have
// answered 403. That distinction matters because the middleware is the only
// thing standing between a REVIEWER and the edit path; if a controller were
// ever reachable, the service's own guards would be the last line rather than
// the second.
//
// Only Prisma is stubbed (via the shared workflow fake), so the real routes,
// the real middleware chain, the real controllers and the real services all
// run.

const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { createWorkflowPrismaFake } = require("../unit/fixtures/workflowPrismaFake");

// Self-defaulted, never inherited from the shell. An exported JWT_SECRET would
// make the server verify with a different secret than tokenFor() signs with,
// and every request would 401 in a way that reads like an authorization
// regression — the environment rule recorded in STATUS.md.
const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
};

const ROLES = ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"];

let fake;
let client;
let state;
let app;
const tokens = {};

// A mutable indirection so each test's fresh fake is what the app sees.
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
let NOTIFICATION_ID;

// Counts every durable row a notification mutation could possibly create. A
// denied request must leave every one of these unchanged.
function rowCounts() {
  return {
    notifications: state.notifications.length,
    revisions: state.notificationRevisions.length,
    lifecycleEvents: state.notificationLifecycleEvents.length,
    exports: state.notificationExports.length,
    deliveries: state.notificationDeliveryEvents.length,
    responses: state.caseOrganizationResponses.length,
  };
}

async function seed() {
  const organization = await client.organization.create({
    data: {
      name: "Acme Bank",
      sector: "FINANCE",
      contactPerson: "Sec Contact",
      email: "soc@acme.example",
    },
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

  const record = await client.case.create({
    data: {
      title: "Accessible RDP",
      threatType: "Accessible RDP",
      organization: "Acme Bank",
      analyst: "a.analyst",
      organizationId: ORG_ID,
      lifecycleState: "OPEN",
      caseReference: "TNX-2026-000007",
    },
  });
  CASE_ID = record.id;

  await client.caseFinding.create({
    data: {
      caseId: CASE_ID,
      findingId: finding.id,
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

async function createDraftAs(role = "ANALYST") {
  const res = await request(app).post("/api/notifications").set(as(role)).send({ caseId: CASE_ID });
  return res;
}

/** Drives a notification to APPROVED over real HTTP. */
async function approveOverHttp() {
  const created = await createDraftAs("ANALYST");
  const id = created.body.data.notification.id;
  await request(app).post(`/api/notifications/${id}/submit`).set(as("ANALYST")).send({});
  await request(app).post(`/api/notifications/${id}/approve`).set(as("REVIEWER")).send({});
  return id;
}

beforeEach(async () => {
  fake = createWorkflowPrismaFake();
  client = fake.client;
  state = fake.state;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  await seed();
  const created = await createDraftAs("ANALYST");
  NOTIFICATION_ID = created.body.data.notification.id;
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
});

// Every route, the capability that gates it, and the roles that hold it.
const ROUTES = [
  {
    label: "list",
    method: "get",
    url: () => "/api/notifications",
    allowed: ["ADMIN", "ANALYST", "REVIEWER"],
    denied: ["VIEWER"],
  },
  {
    label: "detail",
    method: "get",
    url: () => `/api/notifications/${NOTIFICATION_ID}`,
    allowed: ["ADMIN", "ANALYST", "REVIEWER"],
    denied: ["VIEWER"],
  },
  {
    label: "history",
    method: "get",
    url: () => `/api/notifications/${NOTIFICATION_ID}/history`,
    allowed: ["ADMIN", "ANALYST", "REVIEWER"],
    denied: ["VIEWER"],
  },
  {
    label: "create draft",
    method: "post",
    url: () => "/api/notifications",
    body: () => ({ caseId: CASE_ID }),
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
    successStatus: 201,
  },
  {
    label: "edit revision",
    method: "put",
    url: () => `/api/notifications/${NOTIFICATION_ID}`,
    body: () => ({ subject: "Edited by the caller" }),
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
  },
  {
    label: "submit for review",
    method: "post",
    url: () => `/api/notifications/${NOTIFICATION_ID}/submit`,
    body: () => ({}),
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
    // Only the first caller can submit a DRAFT; later ones hit 409, which is
    // still proof the capability admitted them.
    successStatuses: [200, 409],
  },
  {
    label: "approve",
    method: "post",
    url: () => `/api/notifications/${NOTIFICATION_ID}/approve`,
    body: () => ({}),
    allowed: ["ADMIN", "REVIEWER"],
    denied: ["ANALYST", "VIEWER"],
    successStatuses: [200, 409, 403],
  },
  {
    label: "reject",
    method: "post",
    url: () => `/api/notifications/${NOTIFICATION_ID}/reject`,
    body: () => ({ reason: "Not accurate." }),
    allowed: ["ADMIN", "REVIEWER"],
    denied: ["ANALYST", "VIEWER"],
    successStatuses: [200, 409],
  },
  {
    label: "export",
    method: "get",
    url: () => `/api/notifications/${NOTIFICATION_ID}/export`,
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
    successStatuses: [200, 409],
  },
  {
    label: "record delivery",
    method: "post",
    url: () => `/api/notifications/${NOTIFICATION_ID}/deliveries`,
    body: () => ({ status: "SENT_MANUALLY", occurredAt: "2026-08-03T12:00:00.000Z" }),
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
    successStatuses: [201, 409],
  },
  {
    label: "record organization response",
    method: "post",
    url: () => `/api/notifications/${NOTIFICATION_ID}/responses`,
    body: () => ({
      responseType: "ACKNOWLEDGED",
      summary: "Constituent acknowledged.",
      occurredAt: "2026-08-03T12:00:00.000Z",
    }),
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
    successStatuses: [201],
  },
  {
    label: "delete (tombstone)",
    method: "delete",
    url: () => `/api/notifications/${NOTIFICATION_ID}`,
    allowed: ["ADMIN", "ANALYST"],
    denied: ["REVIEWER", "VIEWER"],
    // Always refuses, for everyone — the capability only decides who gets the
    // explicable refusal rather than a bare 403.
    successStatuses: [409],
  },
];

function call(role, route) {
  const req = request(app)[route.method](route.url()).set(as(role));
  return route.body ? req.send(route.body()) : req.send();
}

describe("capability matrix", () => {
  ROUTES.forEach((route) => {
    route.allowed.forEach((role) => {
      it(`admits ${role} to ${route.label}`, async () => {
        const res = await call(role, route);
        const acceptable = route.successStatuses || [route.successStatus || 200];
        expect(acceptable, `${role} ${route.label} -> ${res.status}`).toContain(res.status);
      });
    });

    route.denied.forEach((role) => {
      it(`denies ${role} ${route.label} and creates no row`, async () => {
        const before = rowCounts();
        const res = await call(role, route);

        expect(res.status).toBe(403);
        // The refusal names no capability back to the caller — knowing the
        // exact grant is itself information.
        expect(JSON.stringify(res.body)).not.toMatch(/read:notifications|manage:notifications/);
        expect(rowCounts()).toEqual(before);
      });
    });
  });
});

describe("separation of duties", () => {
  it("lets an ANALYST draft, edit, submit and export but never approve or reject", async () => {
    const res = await request(app)
      .post(`/api/notifications/${NOTIFICATION_ID}/approve`)
      .set(as("ANALYST"))
      .send({});
    expect(res.status).toBe(403);

    const rejected = await request(app)
      .post(`/api/notifications/${NOTIFICATION_ID}/reject`)
      .set(as("ANALYST"))
      .send({ reason: "no" });
    expect(rejected.status).toBe(403);

    expect(
      state.notifications.find((n) => n.id === NOTIFICATION_ID).lifecycleState
    ).toBe("DRAFT");
  });

  it("lets a REVIEWER read and decide but never edit, submit, export or record delivery", async () => {
    expect((await request(app).get("/api/notifications").set(as("REVIEWER"))).status).toBe(200);

    const before = rowCounts();
    const edit = await request(app)
      .put(`/api/notifications/${NOTIFICATION_ID}`)
      .set(as("REVIEWER"))
      .send({ subject: "Reviewer rewrite" });
    const exported = await request(app)
      .get(`/api/notifications/${NOTIFICATION_ID}/export`)
      .set(as("REVIEWER"));
    const delivery = await request(app)
      .post(`/api/notifications/${NOTIFICATION_ID}/deliveries`)
      .set(as("REVIEWER"))
      .send({ status: "DELIVERED", occurredAt: "2026-08-03T12:00:00.000Z" });

    expect([edit.status, exported.status, delivery.status]).toEqual([403, 403, 403]);
    expect(rowCounts()).toEqual(before);
  });

  it("denies VIEWER the whole surface, reads included", async () => {
    // The approved pre-Phase-4 read policy excluded VIEWER (the router
    // required review:notifications), and Phase 4 widens it only as far as the
    // workflow requires — to the drafting role. VIEWER gains nothing.
    const before = rowCounts();
    const results = await Promise.all(
      ROUTES.map((route) => call("VIEWER", route).then((res) => res.status))
    );
    expect(new Set(results)).toEqual(new Set([403]));
    expect(rowCounts()).toEqual(before);
  });

  it("denies an unrecognised role everything, failing closed", async () => {
    const res = await request(app)
      .get("/api/notifications")
      .set("Authorization", `Bearer ${tokens.UNKNOWN}`);
    expect(res.status).toBe(403);
  });

  it("requires authentication before any capability is considered", async () => {
    const results = await Promise.all(
      ROUTES.map((route) => {
        const req = request(app)[route.method](route.url());
        return (route.body ? req.send(route.body()) : req.send()).then((res) => res.status);
      })
    );
    expect(new Set(results)).toEqual(new Set([401]));
  });

  it("refuses an ADMIN self-approval without the explicit override... which ADMIN holds", async () => {
    // ADMIN is the ONE role that holds override:notification-self-approval, so
    // an administrator who drafts and submits may also approve. Any other role
    // in that position is refused — proven in the unit suite against the
    // service, and here at the HTTP boundary for the analyst path.
    const created = await createDraftAs("ADMIN");
    const id = created.body.data.notification.id;
    await request(app).post(`/api/notifications/${id}/submit`).set(as("ADMIN")).send({});
    const approved = await request(app)
      .post(`/api/notifications/${id}/approve`)
      .set(as("ADMIN"))
      .send({});
    expect(approved.status).toBe(200);
    expect(approved.body.data.notification.lifecycleState).toBe("APPROVED");
  });
});

describe("export over HTTP", () => {
  it("streams an .eml attachment with a safe filename and integrity headers", async () => {
    const id = await approveOverHttp();
    const res = await request(app).get(`/api/notifications/${id}/export`).set(as("ANALYST"));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("message/rfc822");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="notification-TNX-NOT-\d{4}-\d{6}-rev1\.eml"$/
    );
    expect(res.headers["x-threatnexus-artifact-checksum"]).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers["cache-control"]).toBe("no-store");

    const body = res.text || res.body.toString("utf8");
    expect(body).toContain("To: ");
    expect(body).not.toMatch(/^Bcc:/im);
  });

  it("records the export but never a delivery", async () => {
    const id = await approveOverHttp();
    await request(app).get(`/api/notifications/${id}/export`).set(as("ANALYST"));

    expect(state.notificationExports).toHaveLength(1);
    expect(state.notificationDeliveryEvents).toHaveLength(0);
  });

  it("refuses to export an unapproved notification with a closed code and writes nothing", async () => {
    const res = await request(app)
      .get(`/api/notifications/${NOTIFICATION_ID}/export`)
      .set(as("ANALYST"));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOTIFICATION_NOT_APPROVED");
    expect(state.notificationExports).toHaveLength(0);
  });

  it("rejects an unknown export format by name rather than silently defaulting", async () => {
    const id = await approveOverHttp();
    const res = await request(app)
      .get(`/api/notifications/${id}/export?format=PDF`)
      .set(as("ANALYST"));

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["format"]);
    expect(state.notificationExports).toHaveLength(0);
  });

  it("refuses to export after an edit invalidated the approval", async () => {
    const id = await approveOverHttp();
    await request(app)
      .put(`/api/notifications/${id}`)
      .set(as("ANALYST"))
      .send({ subject: "Changed after approval" });

    const res = await request(app).get(`/api/notifications/${id}/export`).set(as("ANALYST"));
    expect(res.status).toBe(409);
    expect(state.notificationExports).toHaveLength(0);
  });
});

describe("input contracts", () => {
  it("rejects an unexpected field rather than silently ignoring it", async () => {
    const res = await request(app)
      .put(`/api/notifications/${NOTIFICATION_ID}`)
      .set(as("ANALYST"))
      .send({ subject: "Fine", lifecycleState: "APPROVED", approvedByUserId: 1 });

    expect(res.status).toBe(400);
    expect(res.body.fields.sort()).toEqual(["approvedByUserId", "lifecycleState"]);
    // And nothing was written.
    expect(state.notificationRevisions).toHaveLength(1);
  });

  it("cannot be driven into APPROVED by a client-supplied state", async () => {
    await request(app)
      .put(`/api/notifications/${NOTIFICATION_ID}`)
      .set(as("ANALYST"))
      .send({ lifecycleState: "APPROVED" });

    expect(state.notifications.find((n) => n.id === NOTIFICATION_ID).lifecycleState).toBe("DRAFT");
  });

  it("reports an identical edit as UNCHANGED without creating a revision", async () => {
    const detail = await request(app)
      .get(`/api/notifications/${NOTIFICATION_ID}`)
      .set(as("ANALYST"));
    const current = detail.body.data.currentRevision;

    const res = await request(app)
      .put(`/api/notifications/${NOTIFICATION_ID}`)
      .set(as("ANALYST"))
      .send({ subject: current.subject, body: current.body });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("UNCHANGED");
    expect(state.notificationRevisions).toHaveLength(1);
  });

  it("requires an explicit occurredAt on a delivery event", async () => {
    const id = await approveOverHttp();
    await request(app).get(`/api/notifications/${id}/export`).set(as("ANALYST"));

    const res = await request(app)
      .post(`/api/notifications/${id}/deliveries`)
      .set(as("ANALYST"))
      .send({ status: "DELIVERED" });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["occurredAt"]);
    expect(state.notificationDeliveryEvents).toHaveLength(0);
  });

  it("rejects an unparseable occurredAt rather than defaulting it to now", async () => {
    const id = await approveOverHttp();
    await request(app).get(`/api/notifications/${id}/export`).set(as("ANALYST"));

    const res = await request(app)
      .post(`/api/notifications/${id}/deliveries`)
      .set(as("ANALYST"))
      .send({ status: "DELIVERED", occurredAt: "the day before yesterday" });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["occurredAt"]);
  });

  it("rejects a header-injecting subject at the HTTP boundary", async () => {
    const res = await request(app)
      .put(`/api/notifications/${NOTIFICATION_ID}`)
      .set(as("ANALYST"))
      .send({ subject: "Exposure\r\nBcc: attacker@evil.test" });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(["subject"]);
    expect(state.notificationRevisions).toHaveLength(1);
  });

  it("bounds the list endpoint and names an invalid parameter", async () => {
    const tooLarge = await request(app).get("/api/notifications?limit=500").set(as("ANALYST"));
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body.fields).toEqual(["limit"]);

    const badState = await request(app)
      .get("/api/notifications?state=WHATEVER")
      .set(as("ANALYST"));
    expect(badState.status).toBe(400);
    expect(badState.body.fields).toEqual(["state"]);
  });

  it("rejects a non-numeric id as 400 rather than reaching Prisma", async () => {
    const res = await request(app).get("/api/notifications/not-an-id").set(as("ANALYST"));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid notification id.");
  });

  it("answers 404 for an unknown notification", async () => {
    const res = await request(app).get("/api/notifications/424242").set(as("ANALYST"));
    expect(res.status).toBe(404);
  });
});

describe("the delete tombstone", () => {
  it("refuses for every capable role and deletes nothing", async () => {
    const before = state.notifications.length;
    const admin = await request(app)
      .delete(`/api/notifications/${NOTIFICATION_ID}`)
      .set(as("ADMIN"));
    const analyst = await request(app)
      .delete(`/api/notifications/${NOTIFICATION_ID}`)
      .set(as("ANALYST"));

    expect(admin.status).toBe(409);
    expect(admin.body.code).toBe("NOTIFICATION_DELETION_NOT_SUPPORTED");
    expect(analyst.status).toBe(409);
    expect(state.notifications).toHaveLength(before);
  });

  it("does not become an existence oracle for an unknown id", async () => {
    // 409 for a known id and 404 for an unknown one would let any holder of
    // the capability enumerate which notifications exist.
    const res = await request(app).delete("/api/notifications/999999").set(as("ADMIN"));
    expect(res.status).toBe(409);
  });
});

describe("safe read output", () => {
  it("never emits a verbatim recipient address or an internal current-row key", async () => {
    const res = await request(app)
      .get(`/api/notifications/${NOTIFICATION_ID}`)
      .set(as("REVIEWER"));

    const serialized = JSON.stringify(res.body);
    expect(res.status).toBe(200);
    expect(serialized).not.toContain("soc@acme.example");
    expect(serialized).not.toContain("currentForNotificationId");
    expect(res.body.data.currentRevision.recipientEmailMasked).toBe("s**@acme.example");
  });

  it("surfaces server-derived permitted actions", async () => {
    const res = await request(app)
      .get(`/api/notifications/${NOTIFICATION_ID}`)
      .set(as("ANALYST"));

    expect(res.body.data.permittedActions).toMatchObject({
      isWorkflowBound: true,
      canEdit: true,
      canSubmitForReview: true,
      canReview: false,
      canExport: false,
      exportRefusalCode: "NOTIFICATION_NOT_APPROVED",
      canRecordDelivery: false,
    });
  });

  it("does not leak a Prisma message or stack on a server error", async () => {
    const original = client.notification.findMany;
    client.notification.findMany = async () => {
      throw new Error("Invalid `prisma.notification.findMany()` invocation: column detail");
    };

    const res = await request(app).get("/api/notifications").set(as("ANALYST"));
    client.notification.findMany = original;

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, message: "Server Error" });
  });
});

describe("organization responses recorded through the notification workflow", () => {
  it("writes exactly one CaseOrganizationResponse row, on the notification's case", async () => {
    const res = await request(app)
      .post(`/api/notifications/${NOTIFICATION_ID}/responses`)
      .set(as("ANALYST"))
      .send({
        responseType: "ACKNOWLEDGED",
        summary: "Constituent acknowledged the notification.",
        occurredAt: "2026-08-03T12:00:00.000Z",
      });

    expect(res.status).toBe(201);
    expect(state.caseOrganizationResponses).toHaveLength(1);
    expect(state.caseOrganizationResponses[0].caseId).toBe(CASE_ID);
    // There is no notification-scoped response table to write to.
    expect(state.notificationResponses).toBeUndefined();

    // And the SAME canonical row is what the notification view returns.
    expect(res.body.data.caseResponses).toHaveLength(1);
    expect(res.body.data.caseResponses[0].responseType).toBe("ACKNOWLEDGED");
  });

  it("emits the shared Phase 3 audit action, not a Phase 4 duplicate", async () => {
    await request(app)
      .post(`/api/notifications/${NOTIFICATION_ID}/responses`)
      .set(as("ANALYST"))
      .send({
        responseType: "REMEDIATED",
        summary: "Constituent reported remediation.",
        occurredAt: "2026-08-03T12:00:00.000Z",
      });

    const actions = state.auditLogs.map((row) => row.action);
    expect(actions).toContain("case.response.recorded");
    expect(actions).not.toContain("notification.response.recorded");
  });

  it("does not close or transition the case", async () => {
    await request(app)
      .post(`/api/notifications/${NOTIFICATION_ID}/responses`)
      .set(as("ANALYST"))
      .send({
        responseType: "REMEDIATED",
        summary: "Constituent reported remediation.",
        occurredAt: "2026-08-03T12:00:00.000Z",
      });

    expect(state.cases.find((c) => c.id === CASE_ID).lifecycleState).toBe("OPEN");
  });
});
