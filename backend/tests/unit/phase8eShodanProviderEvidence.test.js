import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Phase 8E — Shodan provider-integration evidence.
//
// Companion to phase8dGreyNoiseProviderEvidence.test.js: a small set of
// NAMED, explicit assertions for the one new deliverable this ticket adds —
// Shodan as the fourth live provider since NVD, Censys and GreyNoise —
// without re-proving what shodanProvider.test.js and
// shodanEnrichmentRouteAuthorization.test.js already cover in depth.

const MANAGED_KEYS = ["NODE_ENV", "DATABASE_URL", "JWT_SECRET", "CORS_ORIGIN", "SHODAN_API_KEY"];
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

describe("Phase 8E — missing Shodan credentials never break startup", () => {
  it("loads configuration with no SHODAN_API_KEY set", () => {
    Object.assign(process.env, VALID_BASE);
    const config = loadEnv();
    expect(config.SHODAN_API_KEY).toBe("");
    expect(config.JWT_SECRET).toBe(VALID_BASE.JWT_SECRET);
  });

  it("still fails fast on a missing REQUIRED secret, independent of the Shodan key", () => {
    Object.assign(process.env, { ...VALID_BASE, SHODAN_API_KEY: "key-value" });
    delete process.env.JWT_SECRET;
    expect(() => loadEnv()).toThrowError(/JWT_SECRET/);
  });
});

describe("Phase 8E — Shodan joins the existing provider foundation without disturbing it", () => {
  it("NVD, AbuseIPDB, Censys and GreyNoise are unaffected by the Shodan addition", () => {
    const { listRegisteredVulnerabilityProviderNames } = require("../../src/services/vulnerability/providers/vulnerabilityProviderRegistry");
    const { listRegisteredIocEnrichmentProviderNames } = require("../../src/services/enrichment/providerRegistry");
    const { PROVIDER_NAME: censysName } = require("../../src/services/exposure/censysProvider");
    const { PROVIDER_NAME: greyNoiseName } = require("../../src/services/reputation/greyNoiseProvider");
    expect(listRegisteredVulnerabilityProviderNames().slice().sort()).toEqual(
      ["CISA_KEV", "FIRST_EPSS", "NVD"].sort()
    );
    expect(listRegisteredIocEnrichmentProviderNames().slice().sort()).toEqual(["abuseipdb", "mock"].sort());
    expect(censysName).toBe("censys");
    expect(greyNoiseName).toBe("greynoise");
  });

  it("Shodan is its own module, not a fourth/fifth entry crammed into any existing registry", () => {
    // Deliberate design choice, asserted here so a future edit that tries to
    // add "shodan" into providerRegistry.js or
    // vulnerabilityProviderRegistry.js (forcing exposure data through an
    // incompatible shape) fails this test rather than silently landing.
    const { listRegisteredVulnerabilityProviderNames } = require("../../src/services/vulnerability/providers/vulnerabilityProviderRegistry");
    const { listRegisteredIocEnrichmentProviderNames } = require("../../src/services/enrichment/providerRegistry");
    expect(listRegisteredVulnerabilityProviderNames()).not.toContain("SHODAN");
    expect(listRegisteredIocEnrichmentProviderNames()).not.toContain("shodan");
    const { PROVIDER_NAME } = require("../../src/services/exposure/shodanProvider");
    expect(PROVIDER_NAME).toBe("shodan");
  });
});

describe("Phase 8E — the Shodan error contract is closed and distinct", () => {
  it("every error code is a unique, non-empty string and covers the required safe set", () => {
    const { PROVIDER_ERROR_CODES } = require("../../src/services/exposure/shodanTypes");
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

  it("a malformed CVE identifier is never passed through as a real vulnerability", () => {
    const { CVE_PATTERN } = require("../../src/services/exposure/shodanTypes");
    expect(CVE_PATTERN.test("CVE-2023-12345")).toBe(true);
    expect(CVE_PATTERN.test("not-a-cve")).toBe(false);
    expect(CVE_PATTERN.test("<script>alert(1)</script>")).toBe(false);
  });
});

describe("Phase 8E — Shodan shares the existing provider quota, not a new one", () => {
  it("no SHODAN_RATE_LIMIT_* variable exists — RATE_LIMIT_PROVIDER_* is the only budget", () => {
    Object.assign(process.env, VALID_BASE, { SHODAN_RATE_LIMIT_MAX: "999" });
    const config = loadEnv();
    expect(config).not.toHaveProperty("SHODAN_RATE_LIMIT_MAX");
    expect(Number.isInteger(config.RATE_LIMIT_PROVIDER_MAX)).toBe(true);
    expect(config.RATE_LIMIT_PROVIDER_MAX).toBeGreaterThan(0);
  });
});

describe("Phase 8E — Shodan joins the exposure domain, not a new sibling array", () => {
  it("the Shodan auth key travels as a query parameter, never a header this app would need to redact separately", () => {
    // Documents the deliberate difference from Censys (Bearer header) and
    // GreyNoise (`key` header) — Shodan's REST API has no header-based auth
    // option. This is proven not to leak via shodanProvider.test.js's
    // "never leaks the API key" case and the route-authorization suite's
    // audit-log assertion; this test only pins the design fact itself so a
    // future refactor toward a header cannot silently regress un-noticed.
    const providerSource = require("fs").readFileSync(
      require.resolve("../../src/services/exposure/shodanProvider.js"),
      "utf8"
    );
    expect(providerSource).toMatch(/\?key=\$\{encodeURIComponent\(apiKey\)\}/);
  });
});

describe("Phase 8E — the manual Shodan live-smoke script cannot run unattended", () => {
  it("throws before any lookup is attempted unless LIVE_SHODAN_SMOKE=1 is set explicitly", async () => {
    const { runShodanLiveSmoke, SmokeConfigError, OPT_IN_ENV } = require("../../src/scripts/shodanLiveSmoke");
    expect(process.env[OPT_IN_ENV]).not.toBe("1"); // true in every CI/test environment
    await expect(runShodanLiveSmoke({ env: process.env })).rejects.toThrow(SmokeConfigError);
  });
});
