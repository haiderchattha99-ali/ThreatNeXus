import { describe, it, expect } from "vitest";

const { redact } = require("../../src/lib/redact");

describe("redact", () => {
  it("redacts sensitive keys in nested objects", () => {
    const input = {
      user: "alice",
      password: "hunter2",
      nested: { apiKey: "abc123", note: "keep" },
    };
    const result = redact(input);
    expect(result.password).toBe("[REDACTED]");
    expect(result.nested.apiKey).toBe("[REDACTED]");
    expect(result.nested.note).toBe("keep");
    expect(result.user).toBe("alice");
  });

  it("redacts sensitive keys inside arrays", () => {
    const input = {
      items: [
        { token: "t1", fine: 1 },
        { refreshToken: "t2", fine: 2 },
      ],
    };
    const result = redact(input);
    expect(result.items[0].token).toBe("[REDACTED]");
    expect(result.items[1].refreshToken).toBe("[REDACTED]");
    expect(result.items[0].fine).toBe(1);
    expect(result.items[1].fine).toBe(2);
  });

  it("matches sensitive keys case-insensitively", () => {
    const input = { PASSWORD: "x", Authorization: "y", jWt: "z" };
    const result = redact(input);
    expect(result.PASSWORD).toBe("[REDACTED]");
    expect(result.Authorization).toBe("[REDACTED]");
    expect(result.jWt).toBe("[REDACTED]");
  });

  it("leaves non-sensitive values unchanged", () => {
    const input = { id: 1, name: "test", active: true, tags: ["a", "b"] };
    const result = redact(input);
    expect(result).toEqual(input);
  });

  it("does not mutate the original input", () => {
    const input = { password: "secret", nested: { apiKey: "k" } };
    const snapshot = JSON.parse(JSON.stringify(input));
    redact(input);
    expect(input).toEqual(snapshot);
  });

  it("handles null and primitive input without crashing", () => {
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
    expect(redact(42)).toBe(42);
    expect(redact("plain string")).toBe("plain string");
    expect(redact(true)).toBe(true);
  });

  it("handles circular references without crashing", () => {
    const input = { name: "circular", secret: "s" };
    input.self = input;
    expect(() => redact(input)).not.toThrow();
  });

  it("represents circular references safely as [Circular]", () => {
    const input = { name: "circular" };
    input.self = input;
    const result = redact(input);
    expect(result.self).toBe("[Circular]");
    expect(result.name).toBe("circular");
  });
});
