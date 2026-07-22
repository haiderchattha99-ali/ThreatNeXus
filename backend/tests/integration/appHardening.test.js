import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";

const request = require("supertest");

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET: "a-reasonably-strong-32-char-plus-secret-value",
  CORS_ORIGIN: "http://localhost:5173,https://app.example.com",
};

let originalEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  Object.assign(process.env, BASE_ENV);
  delete process.env.UPLOAD_MAX_BYTES;
});

afterEach(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

function loadFreshApp() {
  [require.resolve("../../src/config/env"), require.resolve("../../src/app")].forEach(
    (resolved) => {
      delete require.cache[resolved];
    }
  );
  return require("../../src/app");
}

// Only the config/env and src/app cache entries are ever evicted above, so
// every dependency app.js pulls in transitively — express, cors, all route/
// controller/service files, and native modules like bcrypt — is required
// exactly once per worker process, on whichever test happens to call
// loadFreshApp() first. That one-time cost is ordinarily well under a second,
// but under parallel-worker CPU contention (many vitest workers cold-starting
// bcrypt's native binding and Prisma at once) it has been observed to exceed
// the 5s default testTimeout, failing whichever test paid for it.
//
// Paying that cost here instead — inside beforeAll, which gets vitest's
// larger default hookTimeout — means every `it()` below (including the first)
// starts with a warm require cache and a fast, predictable app load.
beforeAll(() => {
  Object.assign(process.env, BASE_ENV);
  loadFreshApp();
});

describe("Express app hardening (integration)", () => {
  it("keeps existing route mounts working", async () => {
    const res = await request(loadFreshApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.body.project).toBe("ThreatNeXus");
  });

  it("returns a clean 404 JSON body for unknown routes", async () => {
    const res = await request(loadFreshApp()).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.message).toBe("string");
  });

  it("attaches an X-Request-Id header to every response", async () => {
    const res = await request(loadFreshApp()).get("/");
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("reflects the caller's origin (not a wildcard) for an allowed origin", async () => {
    const res = await request(loadFreshApp())
      .get("/")
      .set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173"
    );
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("accepts a second allowed origin from the comma-separated CORS_ORIGIN list", async () => {
    const res = await request(loadFreshApp())
      .get("/")
      .set("Origin", "https://app.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com"
    );
  });

  it("does not grant CORS access to a disallowed origin", async () => {
    const res = await request(loadFreshApp())
      .get("/")
      .set("Origin", "http://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("accepts a payload under the configured JSON body limit", async () => {
    const res = await request(loadFreshApp())
      .post("/api/does-not-exist")
      .set("Content-Type", "application/json")
      .send({ note: "small payload" });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("configures a JSON body limit from env.UPLOAD_MAX_BYTES and returns a safe 413 for oversized payloads", async () => {
    process.env.UPLOAD_MAX_BYTES = "50";
    const oversizedBody = JSON.stringify({ note: "x".repeat(500) });
    const res = await request(loadFreshApp())
      .post("/api/does-not-exist")
      .set("Content-Type", "application/json")
      .send(oversizedBody);
    expect(res.status).toBe(413);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Payload too large.");
    expect(res.body.stack).toBeUndefined();
  });
});
