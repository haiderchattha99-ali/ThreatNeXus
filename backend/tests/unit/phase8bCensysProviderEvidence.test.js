import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Phase 8B — Censys provider-integration evidence.
//
// Companion to phase8ProviderFoundationEvidence.test.js: a small set of
// NAMED, explicit assertions for the one new deliverable this ticket adds —
// Censys as the first new live provider since NVD — without re-proving what
// censysProvider.test.js and censysEnrichmentRouteAuthorization.test.js
// already cover in depth.

const MANAGED_KEYS = ["NODE_ENV", "DATABASE_URL", "JWT_SECRET", "CORS_ORIGIN", "CENSYS_PAT", "CENSYS_ORG_ID"];
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

describe("Phase 8B — missing Censys credentials never break startup", () => {
  it("loads configuration with neither CENSYS_PAT nor CENSYS_ORG_ID set", () => {
    Object.assign(process.env, VALID_BASE);
    const config = loadEnv();
    expect(config.CENSYS_PAT).toBe("");
    expect(config.CENSYS_ORG_ID).toBe("");
    expect(config.JWT_SECRET).toBe(VALID_BASE.JWT_SECRET);
  });

  it("still fails fast on a missing REQUIRED secret, independent of the Censys PAT", () => {
    Object.assign(process.env, { ...VALID_BASE, CENSYS_PAT: "pat-value" });
    delete process.env.JWT_SECRET;
    expect(() => loadEnv()).toThrowError(/JWT_SECRET/);
  });
});

describe("Phase 8B — Censys joins the existing provider foundation without disturbing it", () => {
  it("NVD and AbuseIPDB registries are unaffected by the Censys addition", () => {
    const { listRegisteredVulnerabilityProviderNames } = require("../../src/services/vulnerability/providers/vulnerabilityProviderRegistry");
    const { listRegisteredIocEnrichmentProviderNames } = require("../../src/services/enrichment/providerRegistry");
    expect(listRegisteredVulnerabilityProviderNames().slice().sort()).toEqual(
      ["CISA_KEV", "FIRST_EPSS", "NVD"].sort()
    );
    expect(listRegisteredIocEnrichmentProviderNames().slice().sort()).toEqual(["abuseipdb", "mock"].sort());
  });

  it("Censys is its own module, not a third entry crammed into either existing registry", () => {
    // Deliberate design choice, asserted here so a future edit that tries to
    // add "censys" into providerRegistry.js or vulnerabilityProviderRegistry.js
    // (forcing exposure data through an incompatible reputation/CVE shape)
    // fails this test rather than silently landing.
    const { listRegisteredVulnerabilityProviderNames } = require("../../src/services/vulnerability/providers/vulnerabilityProviderRegistry");
    const { listRegisteredIocEnrichmentProviderNames } = require("../../src/services/enrichment/providerRegistry");
    expect(listRegisteredVulnerabilityProviderNames()).not.toContain("CENSYS");
    expect(listRegisteredIocEnrichmentProviderNames()).not.toContain("censys");
    const { PROVIDER_NAME } = require("../../src/services/exposure/censysProvider");
    expect(PROVIDER_NAME).toBe("censys");
  });
});

describe("Phase 8B — the Censys error contract is closed and distinct", () => {
  it("every error code is a unique, non-empty string and covers the required safe set", () => {
    const { PROVIDER_ERROR_CODES } = require("../../src/services/exposure/censysTypes");
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
});

describe("Phase 8B — Censys shares the existing provider quota, not a new one", () => {
  it("no CENSYS_RATE_LIMIT_* variable exists — RATE_LIMIT_PROVIDER_* is the only budget", () => {
    Object.assign(process.env, VALID_BASE, { CENSYS_RATE_LIMIT_MAX: "999" });
    const config = loadEnv();
    expect(config).not.toHaveProperty("CENSYS_RATE_LIMIT_MAX");
    expect(Number.isInteger(config.RATE_LIMIT_PROVIDER_MAX)).toBe(true);
    expect(config.RATE_LIMIT_PROVIDER_MAX).toBeGreaterThan(0);
  });
});

describe("Phase 8B — the manual Censys live-smoke script cannot run unattended", () => {
  it("throws before any lookup is attempted unless LIVE_CENSYS_SMOKE=1 is set explicitly", async () => {
    const { runCensysLiveSmoke, SmokeConfigError, OPT_IN_ENV } = require("../../src/scripts/censysLiveSmoke");
    expect(process.env[OPT_IN_ENV]).not.toBe("1"); // true in every CI/test environment
    await expect(runCensysLiveSmoke({ env: process.env })).rejects.toThrow(SmokeConfigError);
  });
});
