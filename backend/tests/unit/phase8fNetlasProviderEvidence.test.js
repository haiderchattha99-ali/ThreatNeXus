import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Phase 8F — Netlas provider-integration evidence.
//
// Companion to phase8eShodanProviderEvidence.test.js: a small set of NAMED,
// explicit assertions for the one new deliverable this ticket adds — Netlas
// as the fifth live provider since NVD, Censys, GreyNoise and Shodan —
// without re-proving what netlasProvider.test.js and
// netlasEnrichmentRouteAuthorization.test.js already cover in depth.

const MANAGED_KEYS = ["NODE_ENV", "DATABASE_URL", "JWT_SECRET", "CORS_ORIGIN", "NETLAS_API_KEY"];
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

describe("Phase 8F — missing Netlas credentials never break startup", () => {
  it("loads configuration with no NETLAS_API_KEY set", () => {
    Object.assign(process.env, VALID_BASE);
    const config = loadEnv();
    expect(config.NETLAS_API_KEY).toBe("");
    expect(config.JWT_SECRET).toBe(VALID_BASE.JWT_SECRET);
  });

  it("still fails fast on a missing REQUIRED secret, independent of the Netlas key", () => {
    Object.assign(process.env, { ...VALID_BASE, NETLAS_API_KEY: "key-value" });
    delete process.env.JWT_SECRET;
    expect(() => loadEnv()).toThrowError(/JWT_SECRET/);
  });
});

describe("Phase 8F — Netlas joins the existing provider foundation without disturbing it", () => {
  it("NVD, AbuseIPDB, Censys, GreyNoise and Shodan are unaffected by the Netlas addition", () => {
    const { listRegisteredVulnerabilityProviderNames } = require("../../src/services/vulnerability/providers/vulnerabilityProviderRegistry");
    const { listRegisteredIocEnrichmentProviderNames } = require("../../src/services/enrichment/providerRegistry");
    const { PROVIDER_NAME: censysName } = require("../../src/services/exposure/censysProvider");
    const { PROVIDER_NAME: greyNoiseName } = require("../../src/services/reputation/greyNoiseProvider");
    const { PROVIDER_NAME: shodanName } = require("../../src/services/exposure/shodanProvider");
    expect(listRegisteredVulnerabilityProviderNames().slice().sort()).toEqual(
      ["CISA_KEV", "FIRST_EPSS", "NVD"].sort()
    );
    expect(listRegisteredIocEnrichmentProviderNames().slice().sort()).toEqual(["abuseipdb", "mock"].sort());
    expect(censysName).toBe("censys");
    expect(greyNoiseName).toBe("greynoise");
    expect(shodanName).toBe("shodan");
  });

  it("Netlas is its own module, not a sixth entry crammed into any existing registry", () => {
    // Deliberate design choice, asserted here so a future edit that tries to
    // add "netlas" into providerRegistry.js or
    // vulnerabilityProviderRegistry.js (forcing exposure data through an
    // incompatible shape) fails this test rather than silently landing.
    const { listRegisteredVulnerabilityProviderNames } = require("../../src/services/vulnerability/providers/vulnerabilityProviderRegistry");
    const { listRegisteredIocEnrichmentProviderNames } = require("../../src/services/enrichment/providerRegistry");
    expect(listRegisteredVulnerabilityProviderNames()).not.toContain("NETLAS");
    expect(listRegisteredIocEnrichmentProviderNames()).not.toContain("netlas");
    const { PROVIDER_NAME } = require("../../src/services/exposure/netlasProvider");
    expect(PROVIDER_NAME).toBe("netlas");
  });
});

describe("Phase 8F — the Netlas error contract is closed and distinct", () => {
  it("every error code is a unique, non-empty string and covers the required safe set", () => {
    const { PROVIDER_ERROR_CODES } = require("../../src/services/exposure/netlasTypes");
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

describe("Phase 8F — Netlas shares the existing provider quota, not a new one", () => {
  it("no NETLAS_RATE_LIMIT_* variable exists — RATE_LIMIT_PROVIDER_* is the only budget", () => {
    Object.assign(process.env, VALID_BASE, { NETLAS_RATE_LIMIT_MAX: "999" });
    const config = loadEnv();
    expect(config).not.toHaveProperty("NETLAS_RATE_LIMIT_MAX");
    expect(Number.isInteger(config.RATE_LIMIT_PROVIDER_MAX)).toBe(true);
    expect(config.RATE_LIMIT_PROVIDER_MAX).toBeGreaterThan(0);
  });
});

describe("Phase 8F — Netlas joins the exposure domain, not a new sibling array", () => {
  it("the Netlas auth key travels as a Bearer Authorization header, never a query parameter this app would need to redact from a logged URL", () => {
    // Documents the deliberate difference from Shodan (query parameter) and
    // the deliberate similarity to Censys (Bearer header) — Netlas's
    // currently documented auth scheme is RFC 6750 Bearer, not its
    // deprecated X-Api-Key header. This is proven not to leak via
    // netlasProvider.test.js's "never leaks the API key" case and the
    // route-authorization suite's audit-log assertion; this test only pins
    // the design fact itself so a future refactor toward a query parameter
    // cannot silently regress un-noticed.
    const providerSource = require("fs").readFileSync(
      require.resolve("../../src/services/exposure/netlasProvider.js"),
      "utf8"
    );
    expect(providerSource).toMatch(/Authorization: `Bearer \$\{apiKey\}`/);
    expect(providerSource).not.toMatch(/\?key=/);
  });
});

describe("Phase 8F — the manual Netlas live-smoke script cannot run unattended", () => {
  it("throws before any lookup is attempted unless LIVE_NETLAS_SMOKE=1 is set explicitly", async () => {
    const { runNetlasLiveSmoke, SmokeConfigError, OPT_IN_ENV } = require("../../src/scripts/netlasLiveSmoke");
    expect(process.env[OPT_IN_ENV]).not.toBe("1"); // true in every CI/test environment
    await expect(runNetlasLiveSmoke({ env: process.env })).rejects.toThrow(SmokeConfigError);
  });
});
