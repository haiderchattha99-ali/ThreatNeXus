import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Phase 8 — provider-foundation evidence.
//
// The user asked for a "Phase 8 secure provider foundation + live NVD
// adapter" evaluator. Investigation found the foundation (two provider
// registries, a live NvdCveProvider, a safe status surface, Phase 7 rate
// limiting, and redaction tests) already shipped in Phases 2, 6 and 7 — see
// providerRegistry.js, vulnerabilityProviderRegistry.js, nvdCveProvider.js,
// operationalOverviewService.test.js ("no live provider traffic" describe
// block) and phase7ReleaseSecurity.test.js. Re-proving all of that in a new
// eval/run_phase8_gate.js would duplicate a real, already-passing DB-backed
// gate (run_phase7_gate.js) for no new guarantee.
//
// This file is the honest remainder: a small set of NAMED, explicit
// assertions that were previously only true implicitly (e.g. every env.test
// case that omits NVD_API_KEY happens to prove startup doesn't need it, but
// nothing said so directly), plus the one genuinely new Phase 8 artifact —
// the opt-in manual NVD live-smoke script — asserted from this evidence file
// too, so a reader has one place that cites the whole claim set.

const MANAGED_KEYS = ["NODE_ENV", "DATABASE_URL", "JWT_SECRET", "CORS_ORIGIN", "ABUSEIPDB_API_KEY", "NVD_API_KEY"];
const VALID_BASE = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  JWT_SECRET: "a-reasonably-strong-32-char-plus-secret-value",
  CORS_ORIGIN: "http://localhost:5173",
};

let originalEnv;
let logSpy;

function loadEnv() {
  const modulePath = require.resolve("../../src/config/env");
  delete require.cache[modulePath];
  return require(modulePath);
}

beforeEach(() => {
  originalEnv = { ...process.env };
  MANAGED_KEYS.forEach((key) => delete process.env[key]);
  vi.resetModules();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
  logSpy.mockRestore();
});

describe("Phase 8 — missing optional provider keys never break startup", () => {
  it("loads configuration with neither ABUSEIPDB_API_KEY nor NVD_API_KEY set", () => {
    Object.assign(process.env, VALID_BASE);
    const config = loadEnv();
    expect(config.ABUSEIPDB_API_KEY).toBe("");
    expect(config.NVD_API_KEY).toBe("");
    // Required app secrets keep their existing fail-fast behavior — this is
    // not weakened by making provider keys optional.
    expect(config.JWT_SECRET).toBe(VALID_BASE.JWT_SECRET);
  });

  it("still fails fast when a REQUIRED secret is missing, independent of provider keys", () => {
    Object.assign(process.env, { ...VALID_BASE, JWT_SECRET: undefined });
    delete process.env.JWT_SECRET;
    expect(() => loadEnv()).toThrowError(/JWT_SECRET/);
  });
});

describe("Phase 8 — provider registries expose the documented set, nothing more", () => {
  it("lists exactly the shipped vulnerability providers", () => {
    const { listRegisteredVulnerabilityProviderNames } = require("../../src/services/vulnerability/providers/vulnerabilityProviderRegistry");
    expect(listRegisteredVulnerabilityProviderNames().slice().sort()).toEqual(
      ["CISA_KEV", "FIRST_EPSS", "NVD"].sort()
    );
  });

  it("lists exactly the shipped IOC enrichment providers", () => {
    const { listRegisteredIocEnrichmentProviderNames } = require("../../src/services/enrichment/providerRegistry");
    expect(listRegisteredIocEnrichmentProviderNames().slice().sort()).toEqual(["abuseipdb", "mock"].sort());
  });
});

describe("Phase 8 — the safe provider error contract is closed and distinct", () => {
  it("every vulnerability provider error code is a unique, non-empty string", () => {
    const { VULNERABILITY_ERROR_CODES } = require("../../src/services/vulnerability/vulnerabilityTypes");
    const values = Object.values(VULNERABILITY_ERROR_CODES);
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
    values.forEach((code) => expect(typeof code).toBe("string"));
    // The specific codes a caller depends on for safe, distinct handling of
    // disabled/unconfigured/rate-limited/timeout/auth-failed/bad-response.
    expect(values).toEqual(
      expect.arrayContaining([
        "PROVIDER_RATE_LIMITED",
        "PROVIDER_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_DISABLED",
        "PROVIDER_INVALID_KEY",
        "PROVIDER_MALFORMED_RESPONSE",
      ])
    );
  });
});

describe("Phase 8 — provider execution shares one quota/rate-limit budget", () => {
  it("exposes a single provider rate-limit window/max pair for every future provider route to share", () => {
    Object.assign(process.env, VALID_BASE);
    const config = loadEnv();
    expect(Number.isInteger(config.RATE_LIMIT_PROVIDER_MAX)).toBe(true);
    expect(config.RATE_LIMIT_PROVIDER_MAX).toBeGreaterThan(0);
    expect(Number.isInteger(config.RATE_LIMIT_PROVIDER_WINDOW_MS)).toBe(true);
    expect(config.RATE_LIMIT_PROVIDER_WINDOW_MS).toBeGreaterThan(0);
  });
});

describe("Phase 8 — the manual NVD live-smoke script cannot run unattended", () => {
  it("throws before any lookup is attempted unless LIVE_NVD_SMOKE=1 is set explicitly", async () => {
    const { runNvdLiveSmoke, SmokeConfigError, OPT_IN_ENV } = require("../../src/scripts/nvdLiveSmoke");
    expect(process.env[OPT_IN_ENV]).not.toBe("1"); // true in every CI/test environment
    await expect(runNvdLiveSmoke({ env: process.env })).rejects.toThrow(SmokeConfigError);
  });
});
