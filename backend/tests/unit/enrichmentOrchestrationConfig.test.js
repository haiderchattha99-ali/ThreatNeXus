import { describe, it, expect } from "vitest";

// Phase 10A-1 — configuration defaults and bounds.
//
// The single most important assertion here is the default-off contract: with
// an EMPTY environment, both switches are false and every AUTOMATIC budget is
// 0. A regression that flipped either would let a deployment start spending
// third-party quota on upgrade, which is the failure mode this milestone is
// specifically built to make impossible.
//
// Every case injects a fake environment object. Nothing reads process.env, so
// no test can depend on the developer's machine (and backend/.env is never
// involved).

const {
  EnrichmentOrchestrationConfigError,
  DEFAULT_AUTOMATIC_DAILY_BUDGET,
  DEFAULT_MANUAL_DAILY_BUDGET,
  MAX_DAILY_BUDGET,
  validateDailyBudget,
  parseDefaultOffSwitch,
  resolveOrchestrationConfig,
  isProviderCredentialConfigured,
} = require("../../src/services/enrichmentOrchestration/enrichmentOrchestrationConfig");
const { KNOWN_PROVIDERS } = require("../../src/services/enrichmentOrchestration/enrichmentSubject");

describe("enrichmentOrchestrationConfig — the default-off contract", () => {
  it("resolves both switches to false from an empty environment", () => {
    const config = resolveOrchestrationConfig({});
    expect(config.AUTO_ENRICHMENT_ENABLED).toBe(false);
    expect(config.ENRICHMENT_WORKER_ENABLED).toBe(false);
  });

  it("defaults EVERY automatic provider budget to 0", () => {
    const config = resolveOrchestrationConfig({});
    // eslint-disable-next-line no-restricted-syntax
    for (const provider of KNOWN_PROVIDERS) {
      expect(config.automaticDailyBudgets[provider]).toBe(0);
      expect(DEFAULT_AUTOMATIC_DAILY_BUDGET).toBe(0);
    }
  });

  it("defaults every manual provider budget to null (unlimited)", () => {
    const config = resolveOrchestrationConfig({});
    // eslint-disable-next-line no-restricted-syntax
    for (const provider of KNOWN_PROVIDERS) {
      expect(config.manualDailyBudgets[provider]).toBeNull();
    }
    expect(DEFAULT_MANUAL_DAILY_BUDGET).toBeNull();
  });

  it("covers all six providers in both lanes", () => {
    const config = resolveOrchestrationConfig({});
    expect(Object.keys(config.automaticDailyBudgets).sort()).toEqual([...KNOWN_PROVIDERS]);
    expect(Object.keys(config.manualDailyBudgets).sort()).toEqual([...KNOWN_PROVIDERS]);
  });

  it("freezes the resolved configuration", () => {
    const config = resolveOrchestrationConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.automaticDailyBudgets)).toBe(true);
  });
});

describe("enrichmentOrchestrationConfig — switch parsing", () => {
  it('accepts only the exact string "true"', () => {
    expect(parseDefaultOffSwitch("true")).toBe(true);
    expect(parseDefaultOffSwitch("  TRUE  ")).toBe(true);
    // No 1/yes/on synonyms: a quota-spending switch gets one spelling.
    // eslint-disable-next-line no-restricted-syntax
    for (const value of ["1", "yes", "on", "True!", "", undefined, null, "false"]) {
      expect(parseDefaultOffSwitch(value)).toBe(false);
    }
  });

  it("turns on only when explicitly asked", () => {
    const config = resolveOrchestrationConfig({
      AUTO_ENRICHMENT_ENABLED: "true",
      ENRICHMENT_WORKER_ENABLED: "true",
    });
    expect(config.AUTO_ENRICHMENT_ENABLED).toBe(true);
    expect(config.ENRICHMENT_WORKER_ENABLED).toBe(true);
  });
});

describe("enrichmentOrchestrationConfig — budget validation", () => {
  it("accepts a blank value as the default rather than as zero-by-accident", () => {
    expect(validateDailyBudget("X", "", 7, {})).toBe(7);
    expect(validateDailyBudget("X", undefined, null, { allowNull: true })).toBeNull();
  });

  it("accepts integers within bounds, including 0", () => {
    expect(validateDailyBudget("X", "0", 5, {})).toBe(0);
    expect(validateDailyBudget("X", "250", 5, {})).toBe(250);
    expect(validateDailyBudget("X", String(MAX_DAILY_BUDGET), 5, {})).toBe(MAX_DAILY_BUDGET);
  });

  it("rejects a malformed value loudly instead of silently defaulting", () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const value of ["-1", "1.5", "lots", String(MAX_DAILY_BUDGET + 1), "1e3"]) {
      expect(() => validateDailyBudget("SOME_BUDGET", value, 0, {})).toThrow(
        EnrichmentOrchestrationConfigError
      );
    }
  });

  it('accepts the literal "unlimited" on the MANUAL lane only', () => {
    expect(validateDailyBudget("X", "unlimited", 0, { allowNull: true })).toBeNull();
    expect(() => validateDailyBudget("X", "unlimited", 0, { allowNull: false })).toThrow(
      EnrichmentOrchestrationConfigError
    );
  });

  it("names the variable but never the value in its error message", () => {
    try {
      validateDailyBudget("CENSYS_AUTOMATIC_DAILY_BUDGET", "not-a-number-9f3a", 0, {});
      throw new Error("should have thrown");
    } catch (error) {
      expect(error.message).toContain("CENSYS_AUTOMATIC_DAILY_BUDGET");
      expect(error.message).not.toContain("not-a-number-9f3a");
    }
  });

  it("reads per-provider env vars under the existing provider prefixes", () => {
    const config = resolveOrchestrationConfig({
      CENSYS_AUTOMATIC_DAILY_BUDGET: "25",
      NVD_MANUAL_DAILY_BUDGET: "10",
    });
    expect(config.automaticDailyBudgets.censys).toBe(25);
    expect(config.manualDailyBudgets.nvd).toBe(10);
    // Untouched providers keep their defaults.
    expect(config.automaticDailyBudgets.shodan).toBe(0);
    expect(config.manualDailyBudgets.shodan).toBeNull();
  });
});

describe("enrichmentOrchestrationConfig — credential presence", () => {
  it("reports only WHETHER a credential exists, per provider", () => {
    const config = {
      ABUSEIPDB_API_KEY: "",
      CENSYS_PAT: "a-pat",
      GREYNOISE_API_KEY: "",
      SHODAN_API_KEY: "a-key",
      NETLAS_API_KEY: "",
    };
    expect(isProviderCredentialConfigured("abuseipdb", config)).toBe(false);
    expect(isProviderCredentialConfigured("censys", config)).toBe(true);
    expect(isProviderCredentialConfigured("greynoise", config)).toBe(false);
    expect(isProviderCredentialConfigured("shodan", config)).toBe(true);
    expect(isProviderCredentialConfigured("netlas", config)).toBe(false);
  });

  it("treats nvd as always configured, because NVD works without a key", () => {
    // Reporting nvd as NOT_CONFIGURED when NVD_API_KEY is blank would be
    // false: the public API works, at a lower rate limit.
    expect(isProviderCredentialConfigured("nvd", { NVD_API_KEY: "" })).toBe(true);
  });

  it("treats an unknown provider as not configured", () => {
    expect(isProviderCredentialConfigured("virustotal", {})).toBe(false);
  });
});
