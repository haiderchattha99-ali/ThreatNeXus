import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const MANAGED_KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "JWT_SECRET",
  "CORS_ORIGIN",
  "PORT",
  "UPLOAD_MAX_BYTES",
  "ABUSEIPDB_TIMEOUT_MS",
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

  it("falls back to defaults for invalid optional numeric values (Phase 2 vars)", () => {
    setEnv({ ...VALID_BASE, ABUSEIPDB_TIMEOUT_MS: "not-a-number" });
    const config = loadEnv();
    expect(config.ABUSEIPDB_TIMEOUT_MS).toBe(5000);
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
