import { describe, it, expect, beforeAll } from "vitest";

// The continuation token is the only thing standing between "bounded,
// server-controlled pagination" and "a caller can point re-resolution at any
// row range it likes". These tests are about forgery and replay, not encoding.

// config/env validates the whole application configuration at require time.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test_db";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "a-reasonably-strong-32-char-plus-secret-value";
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

const {
  ContinuationTokenError,
  issueContinuationToken,
  readContinuationToken,
} = require("../../src/services/ownership/ownershipContinuationToken");

describe("issueContinuationToken", () => {
  it("round-trips a cursor for the mapping it was issued for", () => {
    const token = issueContinuationToken(42, 1000);
    expect(readContinuationToken(token, 42)).toBe(1000);
  });

  it("returns null when there is nothing to continue", () => {
    expect(issueContinuationToken(42, 0)).toBeNull();
    expect(issueContinuationToken(42, null)).toBeNull();
    expect(issueContinuationToken(null, 10)).toBeNull();
  });
});

describe("readContinuationToken — forgery and replay", () => {
  it("rejects a token whose payload was edited", () => {
    const token = issueContinuationToken(42, 1000);
    const [, signature] = token.split(".");
    // Re-encode a different cursor under the original signature.
    const forgedPayload = Buffer.from(JSON.stringify({ m: 42, a: 999999 })).toString("base64url");
    expect(() => readContinuationToken(`${forgedPayload}.${signature}`, 42)).toThrow(
      ContinuationTokenError
    );
  });

  it("rejects a token minted for a different mapping", () => {
    // Correctly signed, but for mapping 42 — replaying it against mapping 43
    // would drive one mapping's batch with another's cursor.
    const token = issueContinuationToken(42, 1000);
    expect(() => readContinuationToken(token, 43)).toThrow(ContinuationTokenError);
  });

  it("rejects an entirely hand-written token", () => {
    const payload = Buffer.from(JSON.stringify({ m: 1, a: 5 })).toString("base64url");
    expect(() => readContinuationToken(`${payload}.notasignature`, 1)).toThrow(
      ContinuationTokenError
    );
  });

  it("rejects malformed input without throwing something unexpected", () => {
    for (const bad of ["", "nodot", "a.b.c", null, undefined, 42, {}]) {
      expect(() => readContinuationToken(bad, 1)).toThrow(ContinuationTokenError);
    }
  });

  it("rejects a validly signed token whose payload is not a cursor", () => {
    // Signed correctly but semantically wrong — signature validity alone must
    // not be enough to be accepted.
    const payload = Buffer.from(JSON.stringify({ m: "one", a: "two" })).toString("base64url");
    const token = issueContinuationToken(1, 1);
    const [, realSignatureForOtherPayload] = token.split(".");
    expect(() => readContinuationToken(`${payload}.${realSignatureForOtherPayload}`, 1)).toThrow(
      ContinuationTokenError
    );
  });
});
