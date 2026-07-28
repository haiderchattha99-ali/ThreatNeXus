import { describe, it, expect } from "vitest";

const {
  ROLE_VALUES,
  DEFAULT_ROLE,
  CAPABILITIES,
  CAPABILITY_VALUES,
  ROLE_CAPABILITIES,
  isValidRole,
  isValidCapability,
  normalizeRole,
  resolveAuthorizationRole,
  assertValidRequiredRole,
  assertValidCapability,
  hasRole,
  hasAnyRole,
  hasCapability,
  hasAnyCapability,
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

const C = CAPABILITIES;

describe("capability constants", () => {
  it("defines the Phase 0 capability set", () => {
    expect(CAPABILITY_VALUES).toEqual(
      expect.arrayContaining([
        "read:dashboard",
        "read:findings",
        "ingest:reports",
        "triage:findings",
        "manage:cases",
        "review:notifications",
        "review:ai-suggestions",
        "manage:users",
        "manage:system",
        "delete:records",
      ])
    );
    expect(CAPABILITY_VALUES).toHaveLength(10 + 2 + 2); // + P2-T1 ownership + P2-T2e-2 enrichment
  });

  it("defines the P2-T1 ownership capability set", () => {
    expect(CAPABILITY_VALUES).toEqual(
      expect.arrayContaining(["manage:ownership-mappings", "override:finding-ownership"])
    );
  });

  it("defines the P2-T2e-2 enrichment capability set", () => {
    expect(CAPABILITY_VALUES).toEqual(
      expect.arrayContaining(["trigger:finding-enrichment", "execute:enrichment-batch"])
    );
  });

  it("defines a grant list for every role", () => {
    ROLE_VALUES.forEach((role) => {
      expect(Array.isArray(ROLE_CAPABILITIES[role])).toBe(true);
    });
  });

  it("grants only known capabilities", () => {
    ROLE_VALUES.forEach((role) => {
      ROLE_CAPABILITIES[role].forEach((capability) => {
        expect(CAPABILITY_VALUES).toContain(capability);
      });
    });
  });

  it("validates capabilities", () => {
    expect(isValidCapability("read:findings")).toBe(true);
    expect(isValidCapability("read:everything")).toBe(false);
    expect(isValidCapability(null)).toBe(false);
    expect(isValidCapability(42)).toBe(false);
  });
});

describe("resolveAuthorizationRole", () => {
  it("resolves canonical and legacy spellings", () => {
    expect(resolveAuthorizationRole("ADMIN")).toBe("ADMIN");
    expect(resolveAuthorizationRole("analyst")).toBe("ANALYST");
    expect(resolveAuthorizationRole("  Reviewer  ")).toBe("REVIEWER");
    expect(resolveAuthorizationRole("user")).toBe("VIEWER");
    expect(resolveAuthorizationRole("member")).toBe("VIEWER");
  });

  // The key difference from normalizeRole: unknown input holds no role at all
  // for authorization purposes, rather than silently becoming VIEWER.
  it("returns null for unknown roles instead of defaulting to VIEWER", () => {
    ["superuser", "root", "SUPERADMIN", "", "   ", null, undefined, 42, {}].forEach(
      (value) => {
        expect(resolveAuthorizationRole(value)).toBeNull();
      }
    );
    expect(normalizeRole("superuser")).toBe("VIEWER");
  });
});

describe("VIEWER capabilities", () => {
  it("has read-only capabilities", () => {
    expect(hasCapability("VIEWER", C.READ_DASHBOARD)).toBe(true);
    expect(hasCapability("VIEWER", C.READ_FINDINGS)).toBe(true);
  });

  it("has nothing beyond reading", () => {
    [
      C.INGEST_REPORTS,
      C.TRIAGE_FINDINGS,
      C.MANAGE_CASES,
      C.REVIEW_NOTIFICATIONS,
      C.REVIEW_AI_SUGGESTIONS,
      C.MANAGE_USERS,
      C.MANAGE_SYSTEM,
      C.DELETE_RECORDS,
      C.TRIGGER_FINDING_ENRICHMENT,
      C.EXECUTE_ENRICHMENT_BATCH,
    ].forEach((capability) => {
      expect(hasCapability("VIEWER", capability)).toBe(false);
    });
  });
});

describe("REVIEWER capabilities", () => {
  it("can read and review", () => {
    expect(hasCapability("REVIEWER", C.READ_DASHBOARD)).toBe(true);
    expect(hasCapability("REVIEWER", C.READ_FINDINGS)).toBe(true);
    expect(hasCapability("REVIEWER", C.REVIEW_NOTIFICATIONS)).toBe(true);
    expect(hasCapability("REVIEWER", C.REVIEW_AI_SUGGESTIONS)).toBe(true);
  });

  it("cannot ingest, delete, manage users or manage system", () => {
    expect(hasCapability("REVIEWER", C.INGEST_REPORTS)).toBe(false);
    expect(hasCapability("REVIEWER", C.DELETE_RECORDS)).toBe(false);
    expect(hasCapability("REVIEWER", C.MANAGE_USERS)).toBe(false);
    expect(hasCapability("REVIEWER", C.MANAGE_SYSTEM)).toBe(false);
  });

  it("does not inherit ANALYST working capabilities", () => {
    expect(hasCapability("REVIEWER", C.TRIAGE_FINDINGS)).toBe(false);
    expect(hasCapability("REVIEWER", C.MANAGE_CASES)).toBe(false);
  });
});

describe("ANALYST capabilities", () => {
  it("can read, ingest, triage and manage cases", () => {
    expect(hasCapability("ANALYST", C.READ_DASHBOARD)).toBe(true);
    expect(hasCapability("ANALYST", C.READ_FINDINGS)).toBe(true);
    expect(hasCapability("ANALYST", C.INGEST_REPORTS)).toBe(true);
    expect(hasCapability("ANALYST", C.TRIAGE_FINDINGS)).toBe(true);
    expect(hasCapability("ANALYST", C.MANAGE_CASES)).toBe(true);
  });

  it("cannot manage users, manage system or delete records", () => {
    expect(hasCapability("ANALYST", C.MANAGE_USERS)).toBe(false);
    expect(hasCapability("ANALYST", C.MANAGE_SYSTEM)).toBe(false);
    expect(hasCapability("ANALYST", C.DELETE_RECORDS)).toBe(false);
  });

  // Separation of duties: the analyst who does the work must not also approve it.
  it("does not inherit REVIEWER approval capabilities", () => {
    expect(hasCapability("ANALYST", C.REVIEW_NOTIFICATIONS)).toBe(false);
    expect(hasCapability("ANALYST", C.REVIEW_AI_SUGGESTIONS)).toBe(false);
  });

  // P2-T1: an analyst may correct ownership on a Finding but not manage the
  // AssetMapping registry itself.
  it("can override finding ownership but not manage the mapping registry", () => {
    expect(hasCapability("ANALYST", C.OVERRIDE_FINDING_OWNERSHIP)).toBe(true);
    expect(hasCapability("ANALYST", C.MANAGE_OWNERSHIP_MAPPINGS)).toBe(false);
  });

  // P2-T2e-2: an analyst may trigger/force re-enrichment on a Finding but not
  // run the administrator bounded-batch worker.
  it("can trigger finding enrichment but not execute the enrichment batch worker", () => {
    expect(hasCapability("ANALYST", C.TRIGGER_FINDING_ENRICHMENT)).toBe(true);
    expect(hasCapability("ANALYST", C.EXECUTE_ENRICHMENT_BATCH)).toBe(false);
  });
});

describe("P2-T1 ownership capability grants", () => {
  it("manage:ownership-mappings is ADMIN only", () => {
    expect(hasCapability("ADMIN", C.MANAGE_OWNERSHIP_MAPPINGS)).toBe(true);
    expect(hasCapability("ANALYST", C.MANAGE_OWNERSHIP_MAPPINGS)).toBe(false);
    expect(hasCapability("REVIEWER", C.MANAGE_OWNERSHIP_MAPPINGS)).toBe(false);
    expect(hasCapability("VIEWER", C.MANAGE_OWNERSHIP_MAPPINGS)).toBe(false);
  });

  it("override:finding-ownership is ADMIN and ANALYST only", () => {
    expect(hasCapability("ADMIN", C.OVERRIDE_FINDING_OWNERSHIP)).toBe(true);
    expect(hasCapability("ANALYST", C.OVERRIDE_FINDING_OWNERSHIP)).toBe(true);
    expect(hasCapability("REVIEWER", C.OVERRIDE_FINDING_OWNERSHIP)).toBe(false);
    expect(hasCapability("VIEWER", C.OVERRIDE_FINDING_OWNERSHIP)).toBe(false);
  });
});

describe("P2-T2e-2 enrichment capability grants", () => {
  it("trigger:finding-enrichment is ADMIN and ANALYST only", () => {
    expect(hasCapability("ADMIN", C.TRIGGER_FINDING_ENRICHMENT)).toBe(true);
    expect(hasCapability("ANALYST", C.TRIGGER_FINDING_ENRICHMENT)).toBe(true);
    expect(hasCapability("REVIEWER", C.TRIGGER_FINDING_ENRICHMENT)).toBe(false);
    expect(hasCapability("VIEWER", C.TRIGGER_FINDING_ENRICHMENT)).toBe(false);
  });

  it("execute:enrichment-batch is ADMIN only", () => {
    expect(hasCapability("ADMIN", C.EXECUTE_ENRICHMENT_BATCH)).toBe(true);
    expect(hasCapability("ANALYST", C.EXECUTE_ENRICHMENT_BATCH)).toBe(false);
    expect(hasCapability("REVIEWER", C.EXECUTE_ENRICHMENT_BATCH)).toBe(false);
    expect(hasCapability("VIEWER", C.EXECUTE_ENRICHMENT_BATCH)).toBe(false);
  });
});

describe("ADMIN capabilities", () => {
  it("has every capability", () => {
    CAPABILITY_VALUES.forEach((capability) => {
      expect(hasCapability("ADMIN", capability)).toBe(true);
    });
  });
});

describe("authorization fails closed", () => {
  it("grants nothing to unknown roles", () => {
    ["superuser", "root", "SUPERADMIN", "", null, undefined, 42, {}].forEach(
      (role) => {
        CAPABILITY_VALUES.forEach((capability) => {
          expect(hasCapability(role, capability)).toBe(false);
        });
      }
    );
  });

  // Guards against the trap where an unknown role normalizes to VIEWER and
  // therefore quietly acquires read access.
  it("does not grant VIEWER reads to an unknown role", () => {
    expect(hasCapability("superuser", C.READ_DASHBOARD)).toBe(false);
    expect(hasCapability("superuser", C.READ_FINDINGS)).toBe(false);
  });

  it("grants no role match to unknown roles", () => {
    ROLE_VALUES.forEach((role) => {
      expect(hasRole("superuser", role)).toBe(false);
    });
    expect(hasAnyRole("superuser", ROLE_VALUES)).toBe(false);
  });
});

describe("legacy lowercase roles authorize correctly", () => {
  it("authorizes by capability", () => {
    expect(hasCapability("analyst", C.INGEST_REPORTS)).toBe(true);
    expect(hasCapability("admin", C.MANAGE_USERS)).toBe(true);
    expect(hasCapability("reviewer", C.REVIEW_NOTIFICATIONS)).toBe(true);
    expect(hasCapability("viewer", C.READ_FINDINGS)).toBe(true);
  });

  it("does not over-grant to legacy roles", () => {
    expect(hasCapability("analyst", C.MANAGE_USERS)).toBe(false);
    expect(hasCapability("reviewer", C.INGEST_REPORTS)).toBe(false);
    expect(hasCapability("user", C.INGEST_REPORTS)).toBe(false);
  });

  it("authorizes by role", () => {
    expect(hasRole("analyst", "ANALYST")).toBe(true);
    expect(hasRole("  Admin  ", "ADMIN")).toBe(true);
  });
});

describe("hasRole / hasAnyRole", () => {
  it("matches exactly and does not rank roles", () => {
    expect(hasRole("ADMIN", "ADMIN")).toBe(true);
    // ADMIN is not implicitly an ANALYST — no numeric hierarchy exists.
    expect(hasRole("ADMIN", "ANALYST")).toBe(false);
    expect(hasRole("VIEWER", "ANALYST")).toBe(false);
  });

  it("matches any listed role", () => {
    expect(hasAnyRole("ANALYST", ["ADMIN", "ANALYST"])).toBe(true);
    expect(hasAnyRole("analyst", ["ADMIN", "ANALYST"])).toBe(true);
    expect(hasAnyRole("VIEWER", ["ADMIN", "ANALYST"])).toBe(false);
  });

  it("throws on an invalid requirement rather than guarding nothing", () => {
    expect(() => hasRole("ADMIN", "SUPERADMIN")).toThrow(/invalid required role/i);
    expect(() => hasAnyRole("ADMIN", [])).toThrow(/non-empty array/i);
    expect(() => hasAnyRole("ADMIN", ["NOPE"])).toThrow(/invalid required role/i);
  });
});

describe("hasAnyCapability", () => {
  it("passes when any capability is granted", () => {
    expect(hasAnyCapability("REVIEWER", [C.REVIEW_NOTIFICATIONS, C.MANAGE_USERS])).toBe(
      true
    );
    expect(hasAnyCapability("VIEWER", [C.MANAGE_USERS, C.DELETE_RECORDS])).toBe(false);
  });

  it("throws on invalid configuration", () => {
    expect(() => hasAnyCapability("ADMIN", [])).toThrow(/non-empty array/i);
    expect(() => hasAnyCapability("ADMIN", ["read:everything"])).toThrow(
      /invalid capability/i
    );
  });
});

describe("configuration assertions", () => {
  it("accepts valid values and rejects invalid ones", () => {
    expect(assertValidRequiredRole("ADMIN")).toBe("ADMIN");
    expect(assertValidCapability("manage:users")).toBe("manage:users");

    expect(() => assertValidRequiredRole("SUPERADMIN")).toThrow(
      /invalid required role/i
    );
    // Lowercase is not valid *configuration*, even though it normalizes at runtime.
    expect(() => assertValidRequiredRole("admin")).toThrow(/invalid required role/i);
    expect(() => assertValidCapability("read:everything")).toThrow(
      /invalid capability/i
    );
  });

  it("rejects an unknown capability lookup rather than returning false", () => {
    expect(() => hasCapability("ADMIN", "read:everything")).toThrow(
      /invalid capability/i
    );
  });
});
