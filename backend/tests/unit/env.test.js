import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const MANAGED_KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "JWT_SECRET",
  "CORS_ORIGIN",
  "PORT",
  "UPLOAD_MAX_BYTES",
  "ABUSEIPDB_API_KEY",
  "ABUSEIPDB_BASE_URL",
  "ABUSEIPDB_TIMEOUT_MS",
  "ABUSEIPDB_MAX_AGE_DAYS",
  "ABUSEIPDB_CACHE_TTL_HOURS",
  "SOME_UNRELATED_SECRET",
];

const VALID_BASE = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  JWT_SECRET: "a-reasonably-strong-32-char-plus-secret-value",
  CORS_ORIGIN: "http://localhost:5173",
};

let originalEnv;
let logSpy;

function setEnv(overrides) {
  Object.assign(process.env, overrides);
}

function loadEnv() {
  const modulePath = require.resolve("../../src/config/env");
  delete require.cache[modulePath];
  return require(modulePath);
}

beforeEach(() => {
  originalEnv = { ...process.env };
  MANAGED_KEYS.forEach((key) => delete process.env[key]);
  vi.resetModules();
  // dotenv prints harmless promotional/status output on load; silence it so
  // test output stays readable without hiding real assertion failures.
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
  logSpy.mockRestore();
});

describe("env.js configuration validation", () => {
  it("fails when required variables are missing", () => {
    expect(() => loadEnv()).toThrowError(/DATABASE_URL/);
  });

  it("fails when JWT_SECRET is too short", () => {
    setEnv({ ...VALID_BASE, JWT_SECRET: "short" });
    expect(() => loadEnv()).toThrowError(/JWT_SECRET/);
  });

  it("fails when JWT_SECRET is a repeated placeholder", () => {
    setEnv({
      ...VALID_BASE,
      JWT_SECRET: "secretsecretsecretsecretsecretsecret",
    });
    expect(() => loadEnv()).toThrowError(/JWT_SECRET/);
  });

  it("loads a valid development configuration", () => {
    setEnv(VALID_BASE);
    const config = loadEnv();
    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(5000);
    expect(config.DATABASE_URL).toBe(VALID_BASE.DATABASE_URL);
    expect(config.JWT_SECRET).toBe(VALID_BASE.JWT_SECRET);
  });

  it("fails when CORS_ORIGIN is '*' in production", () => {
    setEnv({ ...VALID_BASE, NODE_ENV: "production", CORS_ORIGIN: "*" });
    expect(() => loadEnv()).toThrowError(/CORS_ORIGIN/);
  });

  it("parses valid numeric overrides", () => {
    setEnv({ ...VALID_BASE, PORT: "6000", UPLOAD_MAX_BYTES: "1048576" });
    const config = loadEnv();
    expect(config.PORT).toBe(6000);
    expect(config.UPLOAD_MAX_BYTES).toBe(1048576);
  });

  it("fails safely on an invalid required numeric value (PORT)", () => {
    setEnv({ ...VALID_BASE, PORT: "not-a-number" });
    expect(() => loadEnv()).toThrowError(/PORT/);
  });

  it("falls back to the default for an invalid ABUSEIPDB_CACHE_TTL_HOURS (not yet consumed by anything)", () => {
    setEnv({ ...VALID_BASE, ABUSEIPDB_CACHE_TTL_HOURS: "not-a-number" });
    const config = loadEnv();
    expect(config.ABUSEIPDB_CACHE_TTL_HOURS).toBe(24);
  });

  it("loads AbuseIPDB defaults when no Phase 2 vars are set", () => {
    setEnv(VALID_BASE);
    const config = loadEnv();
    expect(config.ABUSEIPDB_API_KEY).toBe("");
    expect(config.ABUSEIPDB_BASE_URL).toBe("https://api.abuseipdb.com/api/v2");
    expect(config.ABUSEIPDB_TIMEOUT_MS).toBe(8000);
    expect(config.ABUSEIPDB_MAX_AGE_DAYS).toBe(90);
  });

  it("fails when ABUSEIPDB_TIMEOUT_MS is not a number", () => {
    setEnv({ ...VALID_BASE, ABUSEIPDB_TIMEOUT_MS: "not-a-number" });
    expect(() => loadEnv()).toThrowError(/ABUSEIPDB_TIMEOUT_MS/);
  });

  it("fails when ABUSEIPDB_TIMEOUT_MS is below the minimum bound", () => {
    setEnv({ ...VALID_BASE, ABUSEIPDB_TIMEOUT_MS: "500" });
    expect(() => loadEnv()).toThrowError(/ABUSEIPDB_TIMEOUT_MS/);
  });

  it("fails when ABUSEIPDB_TIMEOUT_MS is above the maximum bound", () => {
    setEnv({ ...VALID_BASE, ABUSEIPDB_TIMEOUT_MS: "999999" });
    expect(() => loadEnv()).toThrowError(/ABUSEIPDB_TIMEOUT_MS/);
  });

  it("fails when ABUSEIPDB_MAX_AGE_DAYS is out of bounds", () => {
    setEnv({ ...VALID_BASE, ABUSEIPDB_MAX_AGE_DAYS: "0" });
    expect(() => loadEnv()).toThrowError(/ABUSEIPDB_MAX_AGE_DAYS/);
  });

  it("fails when ABUSEIPDB_MAX_AGE_DAYS exceeds the maximum bound", () => {
    setEnv({ ...VALID_BASE, ABUSEIPDB_MAX_AGE_DAYS: "366" });
    expect(() => loadEnv()).toThrowError(/ABUSEIPDB_MAX_AGE_DAYS/);
  });

  it("accepts valid overrides for ABUSEIPDB_TIMEOUT_MS and ABUSEIPDB_MAX_AGE_DAYS", () => {
    setEnv({ ...VALID_BASE, ABUSEIPDB_TIMEOUT_MS: "3000", ABUSEIPDB_MAX_AGE_DAYS: "30" });
    const config = loadEnv();
    expect(config.ABUSEIPDB_TIMEOUT_MS).toBe(3000);
    expect(config.ABUSEIPDB_MAX_AGE_DAYS).toBe(30);
  });

  it("fails when ABUSEIPDB_BASE_URL is not HTTPS and not an explicit local test URL", () => {
    setEnv({ ...VALID_BASE, ABUSEIPDB_BASE_URL: "http://api.abuseipdb.com/api/v2" });
    expect(() => loadEnv()).toThrowError(/ABUSEIPDB_BASE_URL/);
  });

  it("accepts an explicit local test URL for ABUSEIPDB_BASE_URL", () => {
    setEnv({ ...VALID_BASE, ABUSEIPDB_BASE_URL: "http://localhost:4010/api/v2" });
    const config = loadEnv();
    expect(config.ABUSEIPDB_BASE_URL).toBe("http://localhost:4010/api/v2");
  });

  it("never includes the ABUSEIPDB_API_KEY value in a configuration error message", () => {
    const fakeKey = "FAKE-ABUSEIPDB-KEY-do-not-actually-use-1a2b3c";
    setEnv({ ...VALID_BASE, ABUSEIPDB_API_KEY: fakeKey, ABUSEIPDB_TIMEOUT_MS: "not-a-number" });
    try {
      loadEnv();
      throw new Error("expected loadEnv to throw");
    } catch (err) {
      expect(err.message).not.toContain(fakeKey);
      expect(err.message).toMatch(/ABUSEIPDB_TIMEOUT_MS/);
    }
  });

  it("does not expose the supplied secret value in error output", () => {
    const placeholderSecret = "changemechangemechangemechangeme";
    setEnv({ ...VALID_BASE, JWT_SECRET: placeholderSecret });
    try {
      loadEnv();
      throw new Error("expected loadEnv to throw");
    } catch (err) {
      expect(err.message).not.toContain(placeholderSecret);
      expect(err.message).toMatch(/JWT_SECRET/);
    }
  });

  it("does not expose unrelated sensitive-looking env values when failing", () => {
    const leakMarker = "super-unique-leak-marker-value-xyz";
    setEnv({ JWT_SECRET: VALID_BASE.JWT_SECRET, CORS_ORIGIN: VALID_BASE.CORS_ORIGIN });
    process.env.SOME_UNRELATED_SECRET = leakMarker;
    try {
      loadEnv();
      throw new Error("expected loadEnv to throw");
    } catch (err) {
      expect(err.message).not.toContain(leakMarker);
      expect(err.message).toMatch(/DATABASE_URL/);
    }
  });
});
