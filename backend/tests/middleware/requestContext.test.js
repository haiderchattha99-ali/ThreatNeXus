import { describe, it, expect } from "vitest";

const express = require("express");
const request = require("supertest");
const requestContext = require("../../src/middleware/requestContext");

function buildApp() {
  const app = express();
  app.use(requestContext);
  app.get("/probe", (req, res) => {
    res.json({
      requestId: req.context.requestId,
      hasStartedAt: typeof req.context.startedAt === "number",
    });
  });
  return app;
}

describe("requestContext middleware", () => {
  it("attaches req.context with a requestId and startedAt", async () => {
    const res = await request(buildApp()).get("/probe");
    expect(res.status).toBe(200);
    expect(typeof res.body.requestId).toBe("string");
    expect(res.body.requestId.length).toBeGreaterThan(0);
    expect(res.body.hasStartedAt).toBe(true);
  });

  it("sets the X-Request-Id response header to match req.context.requestId", async () => {
    const res = await request(buildApp()).get("/probe");
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(res.headers["x-request-id"]).toBe(res.body.requestId);
  });

  it("reuses a safe caller-provided request id instead of generating one", async () => {
    const callerId = "caller-supplied-id-123";
    const res = await request(buildApp())
      .get("/probe")
      .set("X-Request-Id", callerId);
    expect(res.headers["x-request-id"]).toBe(callerId);
    expect(res.body.requestId).toBe(callerId);
  });

  it("generates a fresh id when the supplied header is unsafe", async () => {
    const unsafeId = "bad id; DROP TABLE users;--";
    const res = await request(buildApp())
      .get("/probe")
      .set("X-Request-Id", unsafeId);
    expect(res.headers["x-request-id"]).not.toBe(unsafeId);
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("generates different ids across separate requests", async () => {
    const app = buildApp();
    const first = await request(app).get("/probe");
    const second = await request(app).get("/probe");
    expect(first.body.requestId).not.toBe(second.body.requestId);
  });
});
