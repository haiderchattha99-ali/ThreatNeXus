import { describe, it, expect } from "vitest";

const {
  ROLE_VALUES,
  DEFAULT_ROLE,
  isValidRole,
  normalizeRole,
} = require("../../src/lib/roles");

describe("roles", () => {
  it("defaults to the least-privileged role", () => {
    expect(DEFAULT_ROLE).toBe("VIEWER");
  });

  it("exposes exactly the four enum values", () => {
    expect(ROLE_VALUES).toEqual(
      expect.arrayContaining(["ADMIN", "ANALYST", "REVIEWER", "VIEWER"])
    );
    expect(ROLE_VALUES).toHaveLength(4);
  });

  it("recognizes valid canonical roles only", () => {
    expect(isValidRole("ADMIN")).toBe(true);
    expect(isValidRole("VIEWER")).toBe(true);
    expect(isValidRole("admin")).toBe(false);
    expect(isValidRole("SUPERUSER")).toBe(false);
    expect(isValidRole(null)).toBe(false);
    expect(isValidRole(undefined)).toBe(false);
    expect(isValidRole(42)).toBe(false);
  });

  it("normalizes lowercase legacy roles to their enum value", () => {
    expect(normalizeRole("admin")).toBe("ADMIN");
    expect(normalizeRole("analyst")).toBe("ANALYST");
    expect(normalizeRole("reviewer")).toBe("REVIEWER");
    expect(normalizeRole("viewer")).toBe("VIEWER");
  });

  it("normalizes mixed case and surrounding whitespace", () => {
    expect(normalizeRole("Admin")).toBe("ADMIN");
    expect(normalizeRole("  Reviewer  ")).toBe("REVIEWER");
    expect(normalizeRole("AnAlYsT")).toBe("ANALYST");
  });

  it("maps legacy non-enum roles to VIEWER", () => {
    expect(normalizeRole("user")).toBe("VIEWER");
    expect(normalizeRole("member")).toBe("VIEWER");
    expect(normalizeRole("basic")).toBe("VIEWER");
    expect(normalizeRole("unknown")).toBe("VIEWER");
  });

  it("maps empty and nullish input to VIEWER", () => {
    expect(normalizeRole("")).toBe("VIEWER");
    expect(normalizeRole("   ")).toBe("VIEWER");
    expect(normalizeRole(null)).toBe("VIEWER");
    expect(normalizeRole(undefined)).toBe("VIEWER");
  });

  it("never escalates unrecognized or hostile input to a privileged role", () => {
    const hostile = [
      "superuser",
      "root",
      "admin;--",
      "ADMINISTRATOR",
      {},
      [],
      42,
      true,
      { role: "ADMIN" },
    ];

    hostile.forEach((value) => {
      const result = normalizeRole(value);
      expect(ROLE_VALUES).toContain(result);
      expect(result).not.toBe("ADMIN");
    });
  });

  it("normalizeRole always returns a valid role", () => {
    ["admin", "nonsense", "", null, undefined, 7].forEach((value) => {
      expect(isValidRole(normalizeRole(value))).toBe(true);
    });
  });
});
