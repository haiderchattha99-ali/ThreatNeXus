import { describe, it, expect } from "vitest";

const {
  parseResourceId,
  MAX_RESOURCE_ID,
} = require("../../src/lib/validation");

// Security pass — the id bound must match the STORAGE bound, not the
// JavaScript one.
//
// parseResourceId previously accepted anything Number.isSafeInteger allows
// (up to 2^53-1). Every id column in schema.prisma is a Prisma `Int`, i.e.
// PostgreSQL int4, so every value in (2^31-1, 2^53-1] passed validation,
// reached Prisma and was refused there — as an unhandled
// PrismaClientUnknownRequestError. Measured against a running stack, that
// turned one caller-supplied path segment into a 500 on every entity-by-id
// route (findings, cases, notifications, organizations and their sub-routes),
// while the very next value down, 2147483647, correctly answered 404.
//
// An out-of-range id is a bad request, not a server fault.

describe("parseResourceId — bounds match the int4 id columns", () => {
  it("exposes the PostgreSQL int4 maximum as the bound", () => {
    expect(MAX_RESOURCE_ID).toBe(2147483647);
  });

  it("accepts the largest id a column can actually hold", () => {
    expect(parseResourceId("2147483647")).toBe(2147483647);
    expect(parseResourceId(2147483647)).toBe(2147483647);
  });

  it("rejects the first value past int4 — the exact regression boundary", () => {
    expect(parseResourceId("2147483648")).toBeNull();
    expect(parseResourceId(2147483648)).toBeNull();
  });

  it("rejects safe integers above int4 that used to reach Prisma", () => {
    // 1e21 is what Number("999999999999999999999") produces, and it satisfies
    // Number.isInteger — which is how the old check let it through.
    for (const value of ["9007199254740991", "999999999999999999999", "4294967296"]) {
      expect(parseResourceId(value), value).toBeNull();
    }
  });

  it("still accepts ordinary ids", () => {
    expect(parseResourceId("1")).toBe(1);
    expect(parseResourceId(" 42 ")).toBe(42);
    expect(parseResourceId(7)).toBe(7);
  });

  it("still rejects everything that was already invalid", () => {
    for (const value of ["", "0", "-1", "1abc", "1.5", "0x10", null, undefined, {}, [], NaN, 1.5, -3]) {
      expect(parseResourceId(value), JSON.stringify(value)).toBeNull();
    }
  });
});
