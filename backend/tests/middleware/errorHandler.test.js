import { describe, it, expect } from "vitest";

const express = require("express");
const request = require("supertest");
const requestContext = require("../../src/middleware/requestContext");
const errorHandler = require("../../src/middleware/errorHandler");

const LEAK_MARKER = "super-secret-db-password-leak-12345";

function buildApp() {
  const app = express();
  app.use(requestContext);

  app.get("/boom", () => {
    throw new Error(LEAK_MARKER);
  });

  app.get("/domain-not-found", (req, res, next) => {
    const err = new Error("Widget not found");
    err.status = 404;
    next(err);
  });

  app.get("/conflict", (req, res, next) => {
    const err = new Error("Duplicate finding");
    err.status = 409;
    next(err);
  });

  app.get("/unlisted-status", (req, res, next) => {
    const err = new Error("I am a teapot");
    err.status = 418;
    next(err);
  });

  app.use((req, res) => {
    res.status(404).json({ success: false, message: "Route not found" });
  });

  app.use(errorHandler);
  return app;
}

describe("errorHandler middleware", () => {
  it("returns a safe generic 500 response for unexpected errors", async () => {
    const res = await request(buildApp()).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).not.toContain(LEAK_MARKER);
    expect(res.body.message).toBe("An unexpected error occurred.");
  });

  it("does not leak a stack trace or extra fields in the response body", async () => {
    const res = await request(buildApp()).get("/boom");
    expect(res.body.stack).toBeUndefined();
    expect(Object.keys(res.body).sort()).toEqual(
      ["message", "requestId", "success"].sort()
    );
  });

  it("includes requestId in the response when available", async () => {
    const res = await request(buildApp()).get("/boom");
    expect(typeof res.body.requestId).toBe("string");
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
  });

  it("preserves a safe 404 status code supplied by the error", async () => {
    const res = await request(buildApp()).get("/domain-not-found");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Widget not found");
  });

  it("preserves a safe 409 status code supplied by the error", async () => {
    const res = await request(buildApp()).get("/conflict");
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("Duplicate finding");
  });

  it("defaults an unlisted status code to 500", async () => {
    const res = await request(buildApp()).get("/unlisted-status");
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("An unexpected error occurred.");
    expect(res.body.message).not.toContain("teapot");
  });
});
