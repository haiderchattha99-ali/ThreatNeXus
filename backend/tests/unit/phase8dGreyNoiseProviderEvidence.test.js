import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Phase 8D — GreyNoise provider-integration evidence.
//
// Companion to phase8bCensysProviderEvidence.test.js: a small set of NAMED,
// explicit assertions for the one new deliverable this ticket adds —
// GreyNoise as the third live provider since NVD and Censys — without
// re-proving what greyNoiseProvider.test.js and
// greyNoiseEnrichmentRouteAuthorization.test.js already cover in depth.

const MANAGED_KEYS = ["NODE_ENV", "DATABASE_URL", "JWT_SECRET", "CORS_ORIGIN", "GREYNOISE_API_KEY"];
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

describe("Phase 8D — missing GreyNoise credentials never break startup", () => {
  it("loads configuration with no GREYNOISE_API_KEY set", () => {
    Object.assign(process.env, VALID_BASE);
    const config = loadEnv();
    expect(config.GREYNOISE_API_KEY).toBe("");
    expect(config.JWT_SECRET).toBe(VALID_BASE.JWT_SECRET);
  });

  it("still fails fast on a missing REQUIRED secret, independent of the GreyNoise key", () => {
    Object.assign(process.env, { ...VALID_BASE, GREYNOISE_API_KEY: "key-value" });
    delete process.env.JWT_SECRET;
    expect(() => loadEnv()).toThrowError(/JWT_SECRET/);
  });
});

describe("Phase 8D — GreyNoise joins the existing provider foundation without disturbing it", () => {
  it("NVD, AbuseIPDB and Censys are unaffected by the GreyNoise addition", () => {
    const { listRegisteredVulnerabilityProviderNames } = require("../../src/services/vulnerability/providers/vulnerabilityProviderRegistry");
    const { listRegisteredIocEnrichmentProviderNames } = require("../../src/services/enrichment/providerRegistry");
    const { PROVIDER_NAME: censysName } = require("../../src/services/exposure/censysProvider");
    expect(listRegisteredVulnerabilityProviderNames().slice().sort()).toEqual(
      ["CISA_KEV", "FIRST_EPSS", "NVD"].sort()
    );
    expect(listRegisteredIocEnrichmentProviderNames().slice().sort()).toEqual(["abuseipdb", "mock"].sort());
    expect(censysName).toBe("censys");
  });

  it("GreyNoise is its own module, not a fourth entry crammed into any existing registry", () => {
    // Deliberate design choice, asserted here so a future edit that tries to
    // add "greynoise" into providerRegistry.js or
    // vulnerabilityProviderRegistry.js (forcing noise/reputation data through
    // an incompatible shape) fails this test rather than silently landing.
    const { listRegisteredVulnerabilityProviderNames } = require("../../src/services/vulnerability/providers/vulnerabilityProviderRegistry");
    const { listRegisteredIocEnrichmentProviderNames } = require("../../src/services/enrichment/providerRegistry");
    expect(listRegisteredVulnerabilityProviderNames()).not.toContain("GREYNOISE");
    expect(listRegisteredIocEnrichmentProviderNames()).not.toContain("greynoise");
    const { PROVIDER_NAME } = require("../../src/services/reputation/greyNoiseProvider");
    expect(PROVIDER_NAME).toBe("greynoise");
  });
});

describe("Phase 8D — the GreyNoise error contract is closed and distinct", () => {
  it("every error code is a unique, non-empty string and covers the required safe set", () => {
    const { PROVIDER_ERROR_CODES } = require("../../src/services/reputation/greyNoiseTypes");
    const values = Object.values(PROVIDER_ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(
      expect.arrayContaining([
        "PROVIDER_RATE_LIMITED",
        "PROVIDER_TIMEOUT",
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_INVALID_KEY",
        "PROVIDER_MALFORMED_RESPONSE",
        "ENRICHMENT_DISABLED",
      ])
    );
  });

  it("classification is restricted to GreyNoise's own closed vocabulary", () => {
    const { CLASSIFICATION_VALUES } = require("../../src/services/reputation/greyNoiseTypes");
    expect(CLASSIFICATION_VALUES.slice().sort()).toEqual(["benign", "malicious", "unknown"].sort());
  });
});

describe("Phase 8D — GreyNoise shares the existing provider quota, not a new one", () => {
  it("no GREYNOISE_RATE_LIMIT_* variable exists — RATE_LIMIT_PROVIDER_* is the only budget", () => {
    Object.assign(process.env, VALID_BASE, { GREYNOISE_RATE_LIMIT_MAX: "999" });
    const config = loadEnv();
    expect(config).not.toHaveProperty("GREYNOISE_RATE_LIMIT_MAX");
    expect(Number.isInteger(config.RATE_LIMIT_PROVIDER_MAX)).toBe(true);
    expect(config.RATE_LIMIT_PROVIDER_MAX).toBeGreaterThan(0);
  });
});

describe("Phase 8D — the manual GreyNoise live-smoke script cannot run unattended", () => {
  it("throws before any lookup is attempted unless LIVE_GREYNOISE_SMOKE=1 is set explicitly", async () => {
    const { runGreyNoiseLiveSmoke, SmokeConfigError, OPT_IN_ENV } = require("../../src/scripts/greyNoiseLiveSmoke");
    expect(process.env[OPT_IN_ENV]).not.toBe("1"); // true in every CI/test environment
    await expect(runGreyNoiseLiveSmoke({ env: process.env })).rejects.toThrow(SmokeConfigError);
  });
});
