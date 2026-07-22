import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  requireRole,
  requireAnyRole,
  requireCapability,
  requireAnyCapability,
  AUTHORIZATION_DENIED_ACTION,
} = require("../../src/middleware/requireRole");

const { CAPABILITIES } = require("../../src/lib/roles");

const C = CAPABILITIES;

// Mock req/res/next — no Express, no database.
function makeReq({ role, id = 12, email = "actor@example.test", ...rest } = {}) {
  const req = {
    method: "POST",
    originalUrl: "/api/threats?token=SHOULD_NOT_LEAK",
    ip: "203.0.113.9",
    context: { requestId: "req-42" },
    headers: { authorization: "Bearer SHOULD_NOT_LEAK", cookie: "s=SHOULD_NOT_LEAK" },
    body: { password: "SHOULD_NOT_LEAK" },
    ...rest,
  };
  if (role !== undefined) {
    req.user = { id, email, role };
  }
  return req;
}

function makeRes() {
  const res = {
    statusCode: undefined,
    body: undefined,
    status: vi.fn(function status(code) {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn(function json(payload) {
      res.body = payload;
      return res;
    }),
  };
  return res;
}

function makeAudit() {
  return vi.fn(async () => ({ id: 1 }));
}

// Runs a guard and returns everything worth asserting on.
async function run(guard, req) {
  const res = makeRes();
  const next = vi.fn();
  await guard(req, res, next);
  return { res, next, status: res.statusCode, body: res.body };
}

let errorSpy;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
});

describe("setup-time configuration errors", () => {
  it("throws immediately for an invalid required role", () => {
    expect(() => requireRole("SUPERADMIN")).toThrow(/invalid required role/i);
    expect(() => requireRole("admin")).toThrow(/invalid required role/i);
    expect(() => requireRole(undefined)).toThrow(/invalid required role/i);
  });

  it("throws immediately for an invalid capability", () => {
    expect(() => requireCapability("read:everything")).toThrow(/invalid capability/i);
    expect(() => requireCapability(null)).toThrow(/invalid capability/i);
  });

  it("throws immediately for empty or invalid lists", () => {
    expect(() => requireAnyRole([])).toThrow(/non-empty array/i);
    expect(() => requireAnyRole(["NOPE"])).toThrow(/invalid required role/i);
    expect(() => requireAnyCapability([])).toThrow(/non-empty array/i);
    expect(() => requireAnyCapability(["nope"])).toThrow(/invalid capability/i);
  });

  it("returns a middleware function for valid configuration", () => {
    expect(typeof requireRole("ADMIN")).toBe("function");
    expect(typeof requireCapability(C.READ_FINDINGS)).toBe("function");
  });
});

describe("authentication", () => {
  it("returns 401 when req.user is missing", async () => {
    const audit = makeAudit();
    const guard = requireRole("ADMIN", { auditLogger: audit });
    const { status, body, next } = await run(guard, makeReq());

    expect(status).toBe(401);
    expect(body).toMatchObject({
      success: false,
      message: "Authentication required.",
      requestId: "req-42",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("audits an unauthenticated denial", async () => {
    const audit = makeAudit();
    const guard = requireCapability(C.MANAGE_USERS, { auditLogger: audit });
    await run(guard, makeReq());

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      action: AUTHORIZATION_DENIED_ACTION,
      outcome: "DENIED",
    });
  });
});

describe("requireRole", () => {
  it("calls next() for the exact required role", async () => {
    const guard = requireRole("ANALYST", { auditLogger: makeAudit() });
    const { next, res } = await run(guard, makeReq({ role: "ANALYST" }));

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("accepts a legacy lowercase role from an old JWT", async () => {
    const guard = requireRole("ANALYST", { auditLogger: makeAudit() });
    expect((await run(guard, makeReq({ role: "analyst" }))).next).toHaveBeenCalled();
    expect(
      (await run(guard, makeReq({ role: "  Analyst  " }))).next
    ).toHaveBeenCalled();
  });

  it("returns 403 for the wrong role", async () => {
    const guard = requireRole("ADMIN", { auditLogger: makeAudit() });
    const { status, body, next } = await run(guard, makeReq({ role: "VIEWER" }));

    expect(status).toBe(403);
    expect(body).toMatchObject({ success: false, message: "Forbidden." });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for an unknown role", async () => {
    const guard = requireRole("VIEWER", { auditLogger: makeAudit() });
    for (const role of ["superuser", "root", "", null, 42]) {
      const { status, next } = await run(guard, makeReq({ role }));
      expect(status).toBe(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("does not admit ADMIN to a role-gated route (no hierarchy)", async () => {
    const guard = requireRole("ANALYST", { auditLogger: makeAudit() });
    expect((await run(guard, makeReq({ role: "ADMIN" }))).status).toBe(403);
  });
});

describe("requireAnyRole", () => {
  it("passes when the user holds any listed role", async () => {
    const guard = requireAnyRole(["ADMIN", "ANALYST"], { auditLogger: makeAudit() });
    expect((await run(guard, makeReq({ role: "ADMIN" }))).next).toHaveBeenCalled();
    expect((await run(guard, makeReq({ role: "analyst" }))).next).toHaveBeenCalled();
  });

  it("returns 403 otherwise", async () => {
    const guard = requireAnyRole(["ADMIN", "ANALYST"], { auditLogger: makeAudit() });
    expect((await run(guard, makeReq({ role: "VIEWER" }))).status).toBe(403);
    expect((await run(guard, makeReq({ role: "superuser" }))).status).toBe(403);
  });
});

describe("requireCapability", () => {
  it("allows a role that holds the capability", async () => {
    const guard = requireCapability(C.INGEST_REPORTS, { auditLogger: makeAudit() });
    expect((await run(guard, makeReq({ role: "ANALYST" }))).next).toHaveBeenCalled();
    expect((await run(guard, makeReq({ role: "ADMIN" }))).next).toHaveBeenCalled();
  });

  it("blocks REVIEWER from ingesting reports", async () => {
    const guard = requireCapability(C.INGEST_REPORTS, { auditLogger: makeAudit() });
    const { status, next } = await run(guard, makeReq({ role: "REVIEWER" }));
    expect(status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("blocks ANALYST from reviewing notifications", async () => {
    const guard = requireCapability(C.REVIEW_NOTIFICATIONS, {
      auditLogger: makeAudit(),
    });
    expect((await run(guard, makeReq({ role: "ANALYST" }))).status).toBe(403);
    expect((await run(guard, makeReq({ role: "REVIEWER" }))).next).toHaveBeenCalled();
  });

  it("blocks ANALYST and REVIEWER from managing users", async () => {
    const guard = requireCapability(C.MANAGE_USERS, { auditLogger: makeAudit() });
    expect((await run(guard, makeReq({ role: "ANALYST" }))).status).toBe(403);
    expect((await run(guard, makeReq({ role: "REVIEWER" }))).status).toBe(403);
    expect((await run(guard, makeReq({ role: "ADMIN" }))).next).toHaveBeenCalled();
  });

  it("blocks an unknown role from a VIEWER-level read", async () => {
    const guard = requireCapability(C.READ_DASHBOARD, { auditLogger: makeAudit() });
    expect((await run(guard, makeReq({ role: "superuser" }))).status).toBe(403);
    expect((await run(guard, makeReq({ role: "VIEWER" }))).next).toHaveBeenCalled();
  });
});

describe("requireAnyCapability", () => {
  it("passes when any capability is held", async () => {
    const guard = requireAnyCapability([C.MANAGE_USERS, C.REVIEW_NOTIFICATIONS], {
      auditLogger: makeAudit(),
    });
    expect((await run(guard, makeReq({ role: "REVIEWER" }))).next).toHaveBeenCalled();
    expect((await run(guard, makeReq({ role: "VIEWER" }))).status).toBe(403);
  });
});

describe("denial auditing", () => {
  it("audits a forbidden request with DENIED and authorization metadata", async () => {
    const audit = makeAudit();
    const guard = requireCapability(C.MANAGE_USERS, { auditLogger: audit });
    await run(guard, makeReq({ role: "ANALYST" }));

    expect(audit).toHaveBeenCalledTimes(1);
    const event = audit.mock.calls[0][0];
    expect(event).toMatchObject({
      action: AUTHORIZATION_DENIED_ACTION,
      outcome: "DENIED",
      entityType: "Authorization",
      tlp: "AMBER",
      requestId: "req-42",
      method: "POST",
      sourceIp: "203.0.113.9",
      actorUserId: "12",
      actorEmail: "actor@example.test",
      actorRole: "ANALYST",
    });
    expect(event.reason).toMatch(/manage:users/);
  });

  it("records the path without its query string", async () => {
    const audit = makeAudit();
    const guard = requireCapability(C.MANAGE_USERS, { auditLogger: audit });
    await run(guard, makeReq({ role: "ANALYST" }));

    expect(audit.mock.calls[0][0].path).toBe("/api/threats");
  });

  it("never audits raw headers, cookies, tokens or body", async () => {
    const audit = makeAudit();
    const guard = requireCapability(C.MANAGE_USERS, { auditLogger: audit });
    await run(guard, makeReq({ role: "ANALYST" }));

    const event = audit.mock.calls[0][0];
    expect(event.headers).toBeUndefined();
    expect(event.cookies).toBeUndefined();
    expect(event.body).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("SHOULD_NOT_LEAK");
  });

  // req.user.role is untrusted JWT input; it must not be persisted verbatim.
  it("does not echo an attacker-supplied role into the audit reason", async () => {
    const audit = makeAudit();
    const guard = requireCapability(C.MANAGE_USERS, { auditLogger: audit });
    await run(guard, makeReq({ role: "<script>alert(1)</script>" }));

    expect(audit.mock.calls[0][0].reason).not.toContain("<script>");
  });

  it("does not audit an allowed request", async () => {
    const audit = makeAudit();
    const guard = requireCapability(C.READ_FINDINGS, { auditLogger: audit });
    const { next } = await run(guard, makeReq({ role: "VIEWER" }));

    expect(next).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("audit failure must not break the denial", () => {
  it("still returns 403 when the audit logger rejects", async () => {
    const audit = vi.fn(async () => {
      throw new Error("audit backend down");
    });
    const guard = requireCapability(C.MANAGE_USERS, { auditLogger: audit });
    const { status, body, next } = await run(guard, makeReq({ role: "ANALYST" }));

    expect(status).toBe(403);
    expect(body).toMatchObject({ success: false, message: "Forbidden." });
    expect(next).not.toHaveBeenCalled();
  });

  it("still returns 403 when the audit logger throws synchronously", async () => {
    const audit = vi.fn(() => {
      throw new Error("boom");
    });
    const guard = requireCapability(C.MANAGE_USERS, { auditLogger: audit });
    expect((await run(guard, makeReq({ role: "ANALYST" }))).status).toBe(403);
  });

  it("still returns 401 when the audit logger fails", async () => {
    const audit = vi.fn(async () => {
      throw new Error("audit backend down");
    });
    const guard = requireRole("ADMIN", { auditLogger: audit });
    const { status, body } = await run(guard, makeReq());

    expect(status).toBe(401);
    expect(body.message).toBe("Authentication required.");
  });

  it("logs the audit failure without leaking the error detail", async () => {
    const audit = vi.fn(async () => {
      throw new Error("connection string postgres://user:pw@host/db");
    });
    const guard = requireCapability(C.MANAGE_USERS, { auditLogger: audit });
    await run(guard, makeReq({ role: "ANALYST" }));

    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("postgres://");
  });
});

describe("client response does not leak authorization internals", () => {
  it("returns a fixed message with no role or capability detail", async () => {
    const guard = requireCapability(C.MANAGE_USERS, { auditLogger: makeAudit() });
    const { body } = await run(guard, makeReq({ role: "ANALYST" }));

    expect(Object.keys(body).sort()).toEqual(["message", "requestId", "success"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("manage:users");
    expect(serialized).not.toContain("ANALYST");
    expect(serialized).not.toContain("capability");
    expect(serialized).not.toContain("role");
  });

  it("omits requestId when there is no request context", async () => {
    const guard = requireRole("ADMIN", { auditLogger: makeAudit() });
    const req = makeReq({ role: "VIEWER" });
    delete req.context;

    const { status, body } = await run(guard, req);
    expect(status).toBe(403);
    expect(body).toEqual({ success: false, message: "Forbidden." });
    expect(body.requestId).toBeUndefined();
  });
});
