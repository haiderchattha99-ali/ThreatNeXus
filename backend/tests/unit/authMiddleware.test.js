import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

const jwt = require("jsonwebtoken");

const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";
const OTHER_SECRET = "a-different-32-char-plus-secret-value-here";

let originalEnv;
let authenticate;

beforeAll(() => {
  originalEnv = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
    JWT_SECRET,
    CORS_ORIGIN: "http://localhost:5173",
  });

  // Loaded after env is in place: config/env validates at require time.
  [
    require.resolve("../../src/config/env"),
    require.resolve("../../src/middleware/authMiddleware"),
  ].forEach((resolved) => delete require.cache[resolved]);

  authenticate = require("../../src/middleware/authMiddleware");
});

afterAll(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

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

function makeReq(authorization, extra = {}) {
  return {
    headers: authorization === undefined ? {} : { authorization },
    context: { requestId: "req-42" },
    ...extra,
  };
}

function run(req) {
  const res = makeRes();
  const next = vi.fn();
  authenticate(req, res, next);
  return { res, next, status: res.statusCode, body: res.body };
}

function sign(payload, options = {}) {
  return jwt.sign(payload, JWT_SECRET, options);
}

let errorSpy;
let logSpy;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  vi.clearAllMocks();
});

describe("authMiddleware rejects bad credentials with 401", () => {
  it("rejects a missing Authorization header", () => {
    const { status, body, next } = run(makeReq(undefined));
    expect(status).toBe(401);
    expect(body).toMatchObject({
      success: false,
      message: "Authentication required.",
      requestId: "req-42",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects malformed Authorization headers", () => {
    const malformed = [
      "",
      "   ",
      "sometoken",
      "Basic sometoken",
      "Bearer",
      "Bearer ",
      `Bearer ${sign({ id: 1 })} extra`,
      "Token abc.def.ghi",
    ];

    malformed.forEach((header) => {
      const { status, next } = run(makeReq(header));
      expect(status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  it("rejects a non-string Authorization header", () => {
    expect(run(makeReq(["Bearer", "x"])).status).toBe(401);
  });

  it("rejects a token that is not a valid JWT", () => {
    expect(run(makeReq("Bearer not-a-jwt")).status).toBe(401);
    expect(run(makeReq("Bearer abc.def.ghi")).status).toBe(401);
  });

  it("rejects a token signed with a different secret", () => {
    const forged = jwt.sign({ id: 1, role: "ADMIN" }, OTHER_SECRET);
    const { status, next } = run(makeReq(`Bearer ${forged}`));
    expect(status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an expired token", () => {
    const expired = sign({ id: 1, email: "a@b.test", role: "ADMIN" }, { expiresIn: "-1s" });
    const { status, body, next } = run(makeReq(`Bearer ${expired}`));
    expect(status).toBe(401);
    expect(body.message).toBe("Authentication required.");
    expect(next).not.toHaveBeenCalled();
  });

  it("uses one identical message for every failure mode", () => {
    const messages = [
      run(makeReq(undefined)).body.message,
      run(makeReq("Basic x")).body.message,
      run(makeReq("Bearer not-a-jwt")).body.message,
      run(makeReq(`Bearer ${sign({ id: 1 }, { expiresIn: "-1s" })}`)).body.message,
    ];
    expect(new Set(messages).size).toBe(1);
  });

  it("leaks no jwt internals to the client", () => {
    const bodies = [
      run(makeReq("Bearer not-a-jwt")).body,
      run(makeReq(`Bearer ${sign({ id: 1 }, { expiresIn: "-1s" })}`)).body,
      run(makeReq(`Bearer ${jwt.sign({ id: 1 }, OTHER_SECRET)}`)).body,
    ];

    bodies.forEach((body) => {
      expect(Object.keys(body).sort()).toEqual(["message", "requestId", "success"]);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/jwt|TokenExpiredError|JsonWebTokenError|signature|malformed/i);
    });
  });

  it("never logs the token value", () => {
    const token = sign({ id: 1 }, { expiresIn: "-1s" });
    run(makeReq(`Bearer ${token}`));

    const logged = JSON.stringify([errorSpy.mock.calls, logSpy.mock.calls]);
    expect(logged).not.toContain(token);
  });

  it("omits requestId when there is no request context", () => {
    const req = makeReq(undefined);
    delete req.context;
    expect(run(req).body).toEqual({
      success: false,
      message: "Authentication required.",
    });
  });
});

describe("authMiddleware accepts a valid token", () => {
  it("calls next() and sets req.user", () => {
    const req = makeReq(`Bearer ${sign({ id: 7, email: "a@b.test", role: "ADMIN" })}`);
    const { next, res } = run(req);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toEqual({ id: 7, email: "a@b.test", role: "ADMIN" });
  });

  it("accepts a lowercase bearer scheme", () => {
    const req = makeReq(`bearer ${sign({ id: 7, email: "a@b.test", role: "VIEWER" })}`);
    expect(run(req).next).toHaveBeenCalled();
  });

  it("normalizes a legacy lowercase role to the canonical enum", () => {
    const cases = [
      ["analyst", "ANALYST"],
      ["admin", "ADMIN"],
      ["  Reviewer  ", "REVIEWER"],
      ["viewer", "VIEWER"],
      ["user", "VIEWER"],
    ];

    cases.forEach(([tokenRole, expected]) => {
      const req = makeReq(`Bearer ${sign({ id: 1, email: "a@b.test", role: tokenRole })}`);
      run(req);
      expect(req.user.role).toBe(expected);
    });
  });

  // The counterpart to T7: an unrecognised role must hold no capability, so it
  // resolves to null here rather than being normalized down to VIEWER.
  it("resolves an unknown role to null so it fails closed", () => {
    ["superuser", "root", "SUPERADMIN", "", 42].forEach((tokenRole) => {
      const req = makeReq(`Bearer ${sign({ id: 1, email: "a@b.test", role: tokenRole })}`);
      run(req);
      expect(req.user.role).toBeNull();
    });
  });

  it("does not expose iat/exp on req.user", () => {
    const req = makeReq(`Bearer ${sign({ id: 7, email: "a@b.test", role: "ADMIN" })}`);
    run(req);

    expect(Object.keys(req.user).sort()).toEqual(["email", "id", "role"]);
    expect(req.user.iat).toBeUndefined();
    expect(req.user.exp).toBeUndefined();
  });

  // GET /api/profile echoes req.user straight back to the caller.
  it("carries no extra token claims through to req.user", () => {
    const req = makeReq(
      `Bearer ${sign({ id: 7, email: "a@b.test", role: "ADMIN", isSuperUser: true, password: "leaked" })}`
    );
    run(req);

    expect(req.user.isSuperUser).toBeUndefined();
    expect(req.user.password).toBeUndefined();
    expect(JSON.stringify(req.user)).not.toContain("leaked");
  });
});
