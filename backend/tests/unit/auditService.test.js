import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  AUDIT_OUTCOMES,
  AUDIT_OUTCOME_VALUES,
  DEFAULT_OUTCOME,
  buildAuditContext,
  sanitizeAuditPayload,
  logAuditEvent,
  safeLogAuditEvent,
} = require("../../src/services/auditService");

const { DEFAULT_TLP } = require("../../src/lib/tlp");

// Stub Prisma client: unit tests never touch a real database or construct
// PrismaClient. created[] captures exactly what would have been persisted.
function makeClient(overrides = {}) {
  const created = [];
  return {
    created,
    auditLog: {
      create: vi.fn(async ({ data }) => {
        created.push(data);
        return { id: created.length, ...data };
      }),
      ...overrides,
    },
  };
}

function makeFailingClient(error) {
  return {
    auditLog: {
      create: vi.fn(async () => {
        throw error;
      }),
    },
  };
}

async function capture(event, client) {
  const c = client || makeClient();
  await logAuditEvent(event, { client: c });
  return c.auditLog.create.mock.calls[0][0].data;
}

let errorSpy;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
});

describe("auditService constants", () => {
  it("exposes the three AuditOutcome values", () => {
    expect(AUDIT_OUTCOME_VALUES).toEqual(
      expect.arrayContaining(["SUCCESS", "FAILURE", "DENIED"])
    );
    expect(AUDIT_OUTCOME_VALUES).toHaveLength(3);
    expect(DEFAULT_OUTCOME).toBe("SUCCESS");
  });
});

describe("logAuditEvent", () => {
  it("writes to prisma.auditLog.create with the expected fields", async () => {
    const client = makeClient();
    const result = await logAuditEvent(
      {
        action: "USER_LOGIN",
        outcome: AUDIT_OUTCOMES.SUCCESS,
        actorUserId: 7,
        actorEmail: "analyst@example.test",
        actorRole: "ANALYST",
        sourceIp: "10.0.0.4",
        requestId: "req-123",
        method: "POST",
        path: "/api/auth/login",
        entityType: "User",
        entityId: 7,
        reason: "credentials verified",
      },
      { client }
    );

    expect(client.auditLog.create).toHaveBeenCalledTimes(1);
    const data = client.auditLog.create.mock.calls[0][0].data;

    expect(data).toMatchObject({
      action: "USER_LOGIN",
      outcome: "SUCCESS",
      actorUserId: "7",
      actorEmail: "analyst@example.test",
      actorRole: "ANALYST",
      sourceIp: "10.0.0.4",
      requestId: "req-123",
      method: "POST",
      path: "/api/auth/login",
      entityType: "User",
      entityId: "7",
      reason: "credentials verified",
      tlp: DEFAULT_TLP,
    });

    // Returns the created row.
    expect(result).toMatchObject({ id: 1, action: "USER_LOGIN" });
  });

  it("leaves occurredAt to the database default unless given a Date", async () => {
    const data = await capture({ action: "A" });
    expect(data.occurredAt).toBeUndefined();

    const when = new Date("2026-01-01T00:00:00.000Z");
    const explicit = await capture({ action: "A", occurredAt: when });
    expect(explicit.occurredAt).toBe(when);
  });

  it("defaults outcome to SUCCESS only when omitted", async () => {
    expect((await capture({ action: "A" })).outcome).toBe("SUCCESS");
    expect(
      (await capture({ action: "A", outcome: "FAILURE" })).outcome
    ).toBe("FAILURE");
    expect((await capture({ action: "A", outcome: "DENIED" })).outcome).toBe(
      "DENIED"
    );
  });

  it("rejects an invalid outcome rather than silently recording SUCCESS", async () => {
    const client = makeClient();
    await expect(
      logAuditEvent({ action: "A", outcome: "MAYBE" }, { client })
    ).rejects.toThrow(/invalid outcome/i);
    expect(client.auditLog.create).not.toHaveBeenCalled();
  });

  it("requires an action", async () => {
    const client = makeClient();
    await expect(logAuditEvent({}, { client })).rejects.toThrow(
      /action is required/i
    );
    await expect(
      logAuditEvent({ action: "   " }, { client })
    ).rejects.toThrow(/action is required/i);
    expect(client.auditLog.create).not.toHaveBeenCalled();
  });

  it("applies DEFAULT_TLP when tlp is omitted", async () => {
    const data = await capture({ action: "A" });
    expect(data.tlp).toBe(DEFAULT_TLP);
    expect(data.tlp).toBe("AMBER");
  });

  it("keeps a valid explicit tlp", async () => {
    expect((await capture({ action: "A", tlp: "RED" })).tlp).toBe("RED");
    expect(
      (await capture({ action: "A", tlp: "AMBER_STRICT" })).tlp
    ).toBe("AMBER_STRICT");
  });

  it("falls back to DEFAULT_TLP for an invalid tlp instead of throwing", async () => {
    for (const bad of ["PURPLE", "tlp:red", "", 42, {}]) {
      expect((await capture({ action: "A", tlp: bad })).tlp).toBe(DEFAULT_TLP);
    }
  });

  it("normalizes a legacy lowercase actorRole", async () => {
    expect((await capture({ action: "A", actorRole: "analyst" })).actorRole).toBe(
      "ANALYST"
    );
    expect((await capture({ action: "A", actorRole: "admin" })).actorRole).toBe(
      "ADMIN"
    );
    expect((await capture({ action: "A", actorRole: "  Reviewer  " })).actorRole).toBe(
      "REVIEWER"
    );
  });

  it("never escalates an unknown actorRole to ADMIN", async () => {
    for (const bad of ["user", "member", "basic", "superuser", "root"]) {
      expect((await capture({ action: "A", actorRole: bad })).actorRole).toBe(
        "VIEWER"
      );
    }
  });

  it("leaves actorRole unset when there is no actor", async () => {
    const data = await capture({ action: "SYSTEM_TASK" });
    expect(data.actorRole).toBeUndefined();
    expect(data.actorUserId).toBeUndefined();
  });

  it("redacts before/after payloads before persistence", async () => {
    const data = await capture({
      action: "USER_UPDATED",
      before: { email: "a@example.test", password: "hunter2" },
      after: {
        email: "a@example.test",
        password: "hunter3",
        nested: { apiKey: "secret-key", authorization: "Bearer abc", keep: "ok" },
      },
    });

    expect(data.before.password).toBe("[REDACTED]");
    expect(data.before.email).toBe("a@example.test");
    expect(data.after.password).toBe("[REDACTED]");
    expect(data.after.nested.apiKey).toBe("[REDACTED]");
    expect(data.after.nested.authorization).toBe("[REDACTED]");
    expect(data.after.nested.keep).toBe("ok");

    // No secret value survives anywhere in the persisted payload.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("hunter3");
    expect(serialized).not.toContain("secret-key");
    expect(serialized).not.toContain("Bearer abc");
  });

  it("strips the query string and fragment from path", async () => {
    expect(
      (await capture({ action: "A", path: "/api/threats?token=abc123" })).path
    ).toBe("/api/threats");
    expect(
      (await capture({ action: "A", path: "/api/x#access_token=abc" })).path
    ).toBe("/api/x");
    expect((await capture({ action: "A", path: "/api/threats" })).path).toBe(
      "/api/threats"
    );

    const leaky = await capture({
      action: "A",
      path: "/api/threats?token=abc123",
    });
    expect(JSON.stringify(leaky)).not.toContain("abc123");
  });

  it("persists no raw headers, cookies or tokens even if passed in", async () => {
    const data = await capture({
      action: "A",
      headers: { authorization: "Bearer leaked", cookie: "session=leaked" },
      cookies: { session: "leaked" },
      token: "leaked",
      body: { password: "leaked" },
      query: { token: "leaked" },
    });

    // Unknown keys are dropped entirely — the write is an allow-list.
    expect(data.headers).toBeUndefined();
    expect(data.cookies).toBeUndefined();
    expect(data.token).toBeUndefined();
    expect(data.body).toBeUndefined();
    expect(data.query).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("leaked");
  });

  it("propagates a Prisma failure to the caller", async () => {
    const client = makeFailingClient(new Error("db unavailable"));
    await expect(logAuditEvent({ action: "A" }, { client })).rejects.toThrow(
      "db unavailable"
    );
  });
});

describe("safeLogAuditEvent", () => {
  it("returns the created row on success", async () => {
    const client = makeClient();
    const result = await safeLogAuditEvent({ action: "A" }, { client });
    expect(result).toMatchObject({ action: "A" });
  });

  it("does not throw when Prisma fails, and returns null", async () => {
    const client = makeFailingClient(new Error("db unavailable"));
    const result = await safeLogAuditEvent({ action: "A" }, { client });
    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("does not throw on invalid input", async () => {
    const client = makeClient();
    await expect(
      safeLogAuditEvent({ outcome: "MAYBE" }, { client })
    ).resolves.toBeNull();
  });

  it("logs sanitized error metadata without event payloads", async () => {
    const client = makeFailingClient(new Error("db unavailable"));
    await safeLogAuditEvent(
      {
        action: "USER_UPDATED",
        requestId: "req-9",
        after: { password: "hunter2" },
      },
      { client }
    );

    const [message, meta] = errorSpy.mock.calls[0];
    expect(message).toMatch(/audit log write failed/i);
    expect(meta).toMatchObject({ action: "USER_UPDATED", requestId: "req-9" });
    expect(JSON.stringify(meta)).not.toContain("hunter2");
  });
});

describe("buildAuditContext", () => {
  const req = {
    method: "POST",
    originalUrl: "/api/threats?token=abc123",
    ip: "203.0.113.9",
    context: { requestId: "req-42" },
    user: { id: 12, email: "analyst@example.test", role: "analyst" },
    headers: {
      authorization: "Bearer leaked",
      cookie: "session=leaked",
      "x-forwarded-for": "1.2.3.4",
    },
    body: { password: "leaked" },
  };

  it("extracts requestId, method, path, sourceIp and user", () => {
    expect(buildAuditContext(req)).toEqual({
      requestId: "req-42",
      method: "POST",
      path: "/api/threats",
      sourceIp: "203.0.113.9",
      actorUserId: "12",
      actorEmail: "analyst@example.test",
      actorRole: "ANALYST",
    });
  });

  it("strips the query string from path", () => {
    expect(buildAuditContext(req).path).toBe("/api/threats");
    expect(JSON.stringify(buildAuditContext(req))).not.toContain("abc123");
  });

  it("never includes headers, cookies, tokens or body", () => {
    const context = buildAuditContext(req);
    expect(context.headers).toBeUndefined();
    expect(context.cookies).toBeUndefined();
    expect(context.body).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain("leaked");
  });

  it("ignores a spoofable X-Forwarded-For and uses req.ip only", () => {
    const context = buildAuditContext(req);
    expect(context.sourceIp).toBe("203.0.113.9");
    expect(JSON.stringify(context)).not.toContain("1.2.3.4");
  });

  it("falls back to req.url when originalUrl is absent", () => {
    expect(buildAuditContext({ url: "/api/x?y=1" }).path).toBe("/api/x");
  });

  it("returns nulls for an anonymous request", () => {
    expect(buildAuditContext({ method: "GET", url: "/", ip: "127.0.0.1" })).toEqual({
      requestId: null,
      method: "GET",
      path: "/",
      sourceIp: "127.0.0.1",
      actorUserId: null,
      actorEmail: null,
      actorRole: null,
    });
  });

  it("handles a missing or non-object request", () => {
    expect(buildAuditContext(undefined)).toEqual({});
    expect(buildAuditContext(null)).toEqual({});
  });

  it("composes with logAuditEvent", async () => {
    const data = await capture({ action: "THREAT_VIEWED", ...buildAuditContext(req) });
    expect(data).toMatchObject({
      action: "THREAT_VIEWED",
      requestId: "req-42",
      path: "/api/threats",
      sourceIp: "203.0.113.9",
      actorUserId: "12",
      actorRole: "ANALYST",
      outcome: "SUCCESS",
      tlp: DEFAULT_TLP,
    });
    expect(JSON.stringify(data)).not.toContain("leaked");
  });
});

describe("sanitizeAuditPayload", () => {
  it("redacts sensitive keys and returns null for absent input", () => {
    expect(sanitizeAuditPayload(undefined)).toBeNull();
    expect(sanitizeAuditPayload(null)).toBeNull();
    expect(sanitizeAuditPayload({ password: "x", keep: "y" })).toEqual({
      password: "[REDACTED]",
      keep: "y",
    });
  });
});
