import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// Phase 7 — request rate limiting.
//
// BUILD_PLAN 7B requires rate limiting on authentication and upload; the Phase 7
// brief adds explicit provider execution. Before this phase the application had
// none at all: app.js mounted cors, json and the routers, and nothing counted
// requests. These tests are the proof that the three buckets exist, are wired to
// the right routes, and fail closed rather than open.
//
// The suite builds its OWN app with deliberately tiny limits. It does not rely
// on the defaults (30/20/60 per 15 minutes) because driving 31 real login
// attempts to prove one assertion would make the suite slow for no extra
// information — the algorithm is identical at max=2.

const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = "phase7-rate-limit-suite-secret-value-32-plus";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
  // The point of this file: turn the control ON even though the test default
  // (asserted at the bottom) is off.
  RATE_LIMIT_ENABLED: "true",
  RATE_LIMIT_AUTH_MAX: "2",
  RATE_LIMIT_AUTH_WINDOW_MS: "60000",
  RATE_LIMIT_UPLOAD_MAX: "2",
  RATE_LIMIT_UPLOAD_WINDOW_MS: "60000",
  RATE_LIMIT_PROVIDER_MAX: "2",
  RATE_LIMIT_PROVIDER_WINDOW_MS: "60000",
};

// Prisma is stubbed so a refusal is observable without a database. Every route
// under test refuses BEFORE reaching a controller, which is exactly the property
// worth proving: the limiter must not require the expensive work to happen first.
const prismaStub = {
  user: {
    findUnique: async () => null,
    findFirst: async () => null,
    create: async () => ({ id: 1 }),
  },
  auditLog: { create: async () => ({ id: 1 }) },
  finding: { findUnique: async () => null, findFirst: async () => null },
  censysEnrichment: { create: async () => ({ id: 1 }) },
  greyNoiseEnrichment: { create: async () => ({ id: 1 }) },
};

let app;
let limiters;
let originalEnv;
const tokens = {};

function loadApp(envOverrides = {}) {
  Object.assign(process.env, BASE_ENV, envOverrides);

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

  limiters = require("../../src/config/rateLimiters");
  return require("../../src/app");
}

beforeAll(() => {
  originalEnv = { ...process.env };
  app = loadApp();

  ["ADMIN", "ANALYST"].forEach((role, index) => {
    tokens[role] = jwt.sign(
      { id: index + 1, email: `${role.toLowerCase()}@example.test`, role },
      JWT_SECRET
    );
  });
});

afterAll(() => {
  process.env = originalEnv;
});

beforeEach(() => {
  // Each test starts with empty counters, so one test's exhaustion is never
  // another test's starting condition.
  limiters.authRateLimiter.reset();
  limiters.uploadRateLimiter.reset();
  limiters.providerRateLimiter.reset();
});

const auth = (role) => ({ Authorization: `Bearer ${tokens[role]}` });

describe("Phase 7 — the authentication bucket", () => {
  it("refuses the request after the configured number of attempts", async () => {
    const body = { email: "nobody@example.test", password: "wrong-password" };

    const first = await request(app).post("/api/auth/login").send(body);
    const second = await request(app).post("/api/auth/login").send(body);
    const third = await request(app).post("/api/auth/login").send(body);

    // The first two are answered by the application (wrong credentials).
    expect(first.status).not.toBe(429);
    expect(second.status).not.toBe(429);
    // The third is refused by the limiter.
    expect(third.status).toBe(429);
    expect(third.body.success).toBe(false);
  });

  it("counts register and login against ONE credential budget", async () => {
    // Splitting the budget per-route would let an attacker double their attempts
    // by alternating endpoints.
    await request(app).post("/api/auth/login").send({ email: "a@b.test", password: "x" });
    await request(app).post("/api/auth/register").send({ email: "a@b.test", password: "x" });
    const third = await request(app).post("/api/auth/login").send({ email: "a@b.test", password: "x" });

    expect(third.status).toBe(429);
  });

  it("answers with Retry-After and RateLimit headers a client can act on", async () => {
    const body = { email: "nobody@example.test", password: "wrong-password" };
    await request(app).post("/api/auth/login").send(body);
    await request(app).post("/api/auth/login").send(body);
    const refused = await request(app).post("/api/auth/login").send(body);

    expect(refused.status).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(refused.headers["ratelimit-limit"]).toBe("2");
    expect(refused.headers["ratelimit-remaining"]).toBe("0");
  });

  it("leaks nothing about the credential, the secret or the store in the refusal", async () => {
    const body = { email: "victim@example.test", password: "super-secret-password" };
    await request(app).post("/api/auth/login").send(body);
    await request(app).post("/api/auth/login").send(body);
    const refused = await request(app).post("/api/auth/login").send(body);

    const serialized = JSON.stringify(refused.body) + JSON.stringify(refused.headers);
    expect(refused.status).toBe(429);
    expect(serialized).not.toContain("super-secret-password");
    expect(serialized).not.toContain("victim@example.test");
    expect(serialized).not.toContain(JWT_SECRET);
    // No internal detail about which key or store fired.
    expect(serialized).not.toMatch(/127\.0\.0\.1|::ffff:|::1/);
  });

  it("cannot be evaded with a forged X-Forwarded-For header", async () => {
    // Express only honours X-Forwarded-For when `trust proxy` is set, and this
    // app never sets it. If someone enables it without a trusted proxy in front,
    // this test fails — which is the point, because the limiter would then be
    // bypassable by anyone able to type a header.
    const body = { email: "nobody@example.test", password: "wrong-password" };
    await request(app).post("/api/auth/login").set("X-Forwarded-For", "10.0.0.1").send(body);
    await request(app).post("/api/auth/login").set("X-Forwarded-For", "10.0.0.2").send(body);
    const third = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.0.0.3")
      .send(body);

    expect(third.status).toBe(429);
  });
});

describe("Phase 7 — the upload bucket", () => {
  it("refuses further uploads once the budget is spent", async () => {
    const send = () =>
      request(app)
        .post("/api/reports/accessible-rdp")
        .set(auth("ANALYST"))
        .attach("file", Buffer.from("ip,port\n"), "report.csv");

    await send();
    await send();
    const third = await send();

    expect(third.status).toBe(429);
  });

  it("draws on a budget separate from authentication", async () => {
    // Exhaust auth completely.
    const body = { email: "nobody@example.test", password: "wrong" };
    await request(app).post("/api/auth/login").send(body);
    await request(app).post("/api/auth/login").send(body);
    expect((await request(app).post("/api/auth/login").send(body)).status).toBe(429);

    // Upload is untouched by that.
    const upload = await request(app)
      .post("/api/reports/accessible-rdp")
      .set(auth("ANALYST"))
      .attach("file", Buffer.from("ip,port\n"), "report.csv");
    expect(upload.status).not.toBe(429);
  });
});

describe("Phase 7 — the provider-execution bucket", () => {
  it("bounds how often a caller may cause IOC enrichment work", async () => {
    const send = () =>
      request(app).post("/api/findings/1/enrichment").set(auth("ANALYST")).send({});

    await send();
    await send();
    expect((await send()).status).toBe(429);
  });

  it("shares ONE budget across every quota-spending route", async () => {
    // Two IOC enrichment requests, then the batch worker — as the SAME caller,
    // because the budget is per user. If each route owned its own counter the
    // third would pass; it must not, because all three spend somebody else's
    // quota and a caller must not be able to reset their budget by changing
    // which door they knock on.
    await request(app).post("/api/findings/1/enrichment").set(auth("ADMIN")).send({});
    await request(app).post("/api/findings/2/enrichment").set(auth("ADMIN")).send({});

    const batch = await request(app).post("/api/enrichment/batches/run").set(auth("ADMIN")).send({});
    expect(batch.status).toBe(429);
  });

  it("Phase 8B — counts the Censys route in the SAME budget, not a fresh one", async () => {
    // A caller cannot get a bigger effective budget by switching from IOC
    // enrichment to the newer Censys route — both spend the same provider
    // quota, so two of one plus one of the other must already refuse.
    await request(app).post("/api/findings/1/enrichment").set(auth("ADMIN")).send({});
    await request(app).post("/api/findings/2/enrichment").set(auth("ADMIN")).send({});

    const censys = await request(app).post("/api/findings/1/enrichment/censys").set(auth("ADMIN")).send({});
    expect(censys.status).toBe(429);
  });

  it("Phase 8B — the Censys route alone also bounds its own request rate", async () => {
    const send = () =>
      request(app).post("/api/findings/1/enrichment/censys").set(auth("ANALYST")).send({});

    await send();
    await send();
    expect((await send()).status).toBe(429);
  });

  it("Phase 8C — counts the AI finding-suggestion route in the SAME budget, not a fresh one", async () => {
    // Same proof as Phase 8B's Censys case, for the newer AI-assist route: a
    // caller cannot get a bigger effective budget by switching to it.
    await request(app).post("/api/findings/1/enrichment").set(auth("ADMIN")).send({});
    await request(app).post("/api/findings/2/enrichment").set(auth("ADMIN")).send({});

    const aiSuggestion = await request(app)
      .post("/api/findings/1/ai-suggestions")
      .set(auth("ADMIN"))
      .send({ suggestionType: "SUMMARY" });
    expect(aiSuggestion.status).toBe(429);
  });

  it("Phase 8C — the AI finding-suggestion route alone also bounds its own request rate", async () => {
    const send = () =>
      request(app)
        .post("/api/findings/1/ai-suggestions")
        .set(auth("ANALYST"))
        .send({ suggestionType: "SUMMARY" });

    await send();
    await send();
    expect((await send()).status).toBe(429);
  });

  it("Phase 8D — counts the GreyNoise route in the SAME budget, not a fresh one", async () => {
    // Same proof as Phase 8B's Censys case and Phase 8C's AI-suggestion case,
    // for the newer GreyNoise route.
    await request(app).post("/api/findings/1/enrichment").set(auth("ADMIN")).send({});
    await request(app).post("/api/findings/2/enrichment").set(auth("ADMIN")).send({});

    const greyNoise = await request(app)
      .post("/api/findings/1/enrichment/greynoise")
      .set(auth("ADMIN"))
      .send({});
    expect(greyNoise.status).toBe(429);
  });

  it("Phase 8D — the GreyNoise route alone also bounds its own request rate", async () => {
    const send = () =>
      request(app).post("/api/findings/1/enrichment/greynoise").set(auth("ANALYST")).send({});

    await send();
    await send();
    expect((await send()).status).toBe(429);
  });

  it("does not rate-limit reading enrichment results", async () => {
    // Reading spends nothing. Limiting a read because it shares a router with a
    // write would be an availability bug wearing a security-control costume.
    await request(app).post("/api/findings/1/enrichment").set(auth("ANALYST")).send({});
    await request(app).post("/api/findings/2/enrichment").set(auth("ANALYST")).send({});

    const read = await request(app).get("/api/findings/1/enrichments").set(auth("ANALYST"));
    expect(read.status).not.toBe(429);
  });

  it("counts per authenticated user, not per address", async () => {
    // Two different analysts from the same loopback address must not share a
    // budget — otherwise one busy analyst denies service to the whole team.
    await request(app).post("/api/findings/1/enrichment").set(auth("ANALYST")).send({});
    await request(app).post("/api/findings/2/enrichment").set(auth("ANALYST")).send({});
    expect(
      (await request(app).post("/api/findings/3/enrichment").set(auth("ANALYST")).send({})).status
    ).toBe(429);

    const otherUser = await request(app)
      .post("/api/findings/1/enrichment")
      .set(auth("ADMIN"))
      .send({});
    expect(otherUser.status).not.toBe(429);
  });
});

describe("Phase 7 — configuration resolution", () => {
  it("is ON by default outside the test environment", async () => {
    // This is the assertion that stops "the tests run with it off" from being
    // read as "it ships off".
    const saved = { ...process.env };
    try {
      delete process.env.RATE_LIMIT_ENABLED;
      process.env.NODE_ENV = "production";
      process.env.CORS_ORIGIN = "https://threatnexus.example";

      const marker = `${path.sep}src${path.sep}`;
      Object.keys(require.cache).forEach((key) => {
        if (key.includes(marker)) delete require.cache[key];
      });
      const env = require("../../src/config/env");
      expect(env.RATE_LIMIT_ENABLED).toBe(true);
    } finally {
      process.env = saved;
      const marker = `${path.sep}src${path.sep}`;
      Object.keys(require.cache).forEach((key) => {
        if (key.includes(marker)) delete require.cache[key];
      });
      app = loadApp();
    }
  });

  it("is OFF by default under NODE_ENV=test, and that is the only reason the rest of the suite is unaffected", async () => {
    const saved = { ...process.env };
    try {
      delete process.env.RATE_LIMIT_ENABLED;
      process.env.NODE_ENV = "test";

      const marker = `${path.sep}src${path.sep}`;
      Object.keys(require.cache).forEach((key) => {
        if (key.includes(marker)) delete require.cache[key];
      });
      const env = require("../../src/config/env");
      expect(env.RATE_LIMIT_ENABLED).toBe(false);
    } finally {
      process.env = saved;
      const marker = `${path.sep}src${path.sep}`;
      Object.keys(require.cache).forEach((key) => {
        if (key.includes(marker)) delete require.cache[key];
      });
      app = loadApp();
    }
  });

  it("rejects a non-numeric limit at startup instead of silently defaulting", async () => {
    const saved = { ...process.env };
    try {
      process.env.RATE_LIMIT_AUTH_MAX = "not-a-number";
      const marker = `${path.sep}src${path.sep}`;
      Object.keys(require.cache).forEach((key) => {
        if (key.includes(marker)) delete require.cache[key];
      });
      expect(() => require("../../src/config/env")).toThrow(/RATE_LIMIT_AUTH_MAX/);
    } finally {
      process.env = saved;
      const marker = `${path.sep}src${path.sep}`;
      Object.keys(require.cache).forEach((key) => {
        if (key.includes(marker)) delete require.cache[key];
      });
      app = loadApp();
    }
  });
});
