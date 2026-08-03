"use strict";

const dotenv = require("dotenv");
const {
  AbuseIpdbConfigError,
  DEFAULT_BASE_URL: ABUSEIPDB_DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS: ABUSEIPDB_DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_AGE_DAYS: ABUSEIPDB_DEFAULT_MAX_AGE_DAYS,
  validateBaseUrl: validateAbuseIpdbBaseUrl,
  validateTimeoutMs: validateAbuseIpdbTimeoutMs,
  validateMaxAgeDays: validateAbuseIpdbMaxAgeDays,
} = require("../services/enrichment/abuseIpdbConfig");
const {
  VulnerabilityConfigError,
  NVD_DEFAULT_BASE_URL,
  NVD_DEFAULT_TIMEOUT_MS,
  validateNvdBaseUrl,
  validateNvdTimeoutMs,
  CISA_KEV_DEFAULT_URL,
  CISA_KEV_DEFAULT_TIMEOUT_MS,
  validateCisaKevUrl,
  validateCisaKevTimeoutMs,
  FIRST_EPSS_DEFAULT_BASE_URL,
  FIRST_EPSS_DEFAULT_TIMEOUT_MS,
  validateFirstEpssBaseUrl,
  validateFirstEpssTimeoutMs,
  DEFAULT_BATCH_SIZE: VULNERABILITY_DEFAULT_BATCH_SIZE,
  validateBatchSize: validateVulnerabilityBatchSize,
  DEFAULT_LEASE_SECONDS: VULNERABILITY_DEFAULT_LEASE_SECONDS,
  validateLeaseSeconds: validateVulnerabilityLeaseSeconds,
  DEFAULT_MAX_ATTEMPTS: VULNERABILITY_DEFAULT_MAX_ATTEMPTS,
  validateMaxAttempts: validateVulnerabilityMaxAttempts,
} = require("../services/vulnerability/vulnerabilityConfig");

// Loading a developer's .env is right for running the app and wrong for running
// the tests. The automated suite constructs its own environment explicitly (see
// tests/setup.js and each integration suite's BASE_ENV), and a .env on the
// developer's machine silently leaked into it: with real DATABASE_URL and
// ABUSEIPDB_API_KEY values present, three env.test.js cases that assert on a
// MISSING variable stopped failing correctly. The suite therefore only passed
// on a machine that had no .env at all.
//
// TNX_SKIP_DOTENV is set by tests/setup.js and by nothing else. Production and
// local development are unaffected: the variable is absent, so the file loads
// exactly as before.
if (process.env.TNX_SKIP_DOTENV !== "true") {
  dotenv.config();
}

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

// Rejects the value if it IS one of these placeholders (after trim+lowercase),
// or is built entirely by repeating one of them. A strong secret that merely
// contains "test" or "secret" as a substring is not rejected.
const PLACEHOLDER_WORDS = ["secret", "changeme", "password", "test"];

function isPlaceholderSecret(value) {
  const normalized = value.trim().toLowerCase();
  if (PLACEHOLDER_WORDS.includes(normalized)) return true;
  if (/^(.)\1+$/.test(normalized)) return true; // e.g. "aaaaaaaa..."
  return PLACEHOLDER_WORDS.some((word) =>
    new RegExp(`^(${word})+$`).test(normalized)
  );
}

function requireString(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue.trim() === "") {
    return undefined;
  }
  return rawValue;
}

// strict=true throws on an invalid (non-blank) value; strict=false falls back
// to the default instead. Used for values Phase 0 does not yet consume.
function parseOptionalInt(name, rawValue, defaultValue, { strict = false } = {}) {
  if (rawValue === undefined || rawValue === null || rawValue.trim() === "") {
    return defaultValue;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (strict) {
      throw new ConfigError(
        `Invalid numeric value for environment variable: ${name}`
      );
    }
    return defaultValue;
  }
  return parsed;
}

function buildConfig() {
  const missing = [];
  const invalid = [];

  const nodeEnv = (process.env.NODE_ENV || "development").trim();

  const databaseUrl = requireString(process.env.DATABASE_URL);
  if (databaseUrl === undefined) missing.push("DATABASE_URL");

  let jwtSecret = requireString(process.env.JWT_SECRET);
  if (jwtSecret === undefined) {
    missing.push("JWT_SECRET");
  } else if (jwtSecret.trim().length < 32) {
    invalid.push("JWT_SECRET (must be at least 32 characters)");
    jwtSecret = undefined;
  } else if (isPlaceholderSecret(jwtSecret)) {
    invalid.push("JWT_SECRET (insecure placeholder value)");
    jwtSecret = undefined;
  }

  let corsOrigin = requireString(process.env.CORS_ORIGIN);
  if (corsOrigin === undefined) {
    missing.push("CORS_ORIGIN");
  } else if (corsOrigin.trim() === "*" && nodeEnv === "production") {
    invalid.push('CORS_ORIGIN (wildcard "*" is not allowed in production)');
    corsOrigin = undefined;
  }

  if (missing.length > 0 || invalid.length > 0) {
    const parts = [];
    if (missing.length > 0) {
      parts.push(`missing: ${missing.join(", ")}`);
    }
    if (invalid.length > 0) {
      parts.push(`invalid: ${invalid.join(", ")}`);
    }
    throw new ConfigError(
      `Configuration validation failed (${parts.join("; ")}). ` +
        "See backend/.env.example for the expected variables. " +
        "No variable values are included in this message."
    );
  }

  const port = parseOptionalInt("PORT", process.env.PORT, 5000, {
    strict: true,
  });
  const uploadMaxBytes = parseOptionalInt(
    "UPLOAD_MAX_BYTES",
    process.env.UPLOAD_MAX_BYTES,
    5242880,
    { strict: true }
  );

  // Phase 1 (report ingestion) — bounds how many data rows a single
  // accessible-rdp.synthetic.v1 CSV upload may contain, so a very large file
  // (still under UPLOAD_MAX_BYTES but pathologically wide/short-rowed) cannot
  // force unbounded per-row processing.
  const reportMaxRows = parseOptionalInt(
    "REPORT_MAX_ROWS",
    process.env.REPORT_MAX_ROWS,
    5000,
    { strict: true }
  );

  // Phase 2 (P2-T2c) — the API key stays optional at startup (a missing key
  // only disables the provider at lookup time, never blocks the app from
  // starting), but base URL/timeout/max-age are now real request parameters
  // sent to a live third party, so an invalid value fails configuration
  // validation loudly rather than silently substituting a default. Bounds
  // and defaults are shared with abuseIpdbProvider.js via abuseIpdbConfig.js
  // so the two can never drift apart.
  let abuseIpdbBaseUrl;
  let abuseIpdbTimeoutMs;
  let abuseIpdbMaxAgeDays;
  try {
    abuseIpdbBaseUrl = validateAbuseIpdbBaseUrl(
      requireString(process.env.ABUSEIPDB_BASE_URL) || ABUSEIPDB_DEFAULT_BASE_URL
    );
    abuseIpdbTimeoutMs = validateAbuseIpdbTimeoutMs(
      parseOptionalInt("ABUSEIPDB_TIMEOUT_MS", process.env.ABUSEIPDB_TIMEOUT_MS, ABUSEIPDB_DEFAULT_TIMEOUT_MS, {
        strict: true,
      })
    );
    abuseIpdbMaxAgeDays = validateAbuseIpdbMaxAgeDays(
      parseOptionalInt(
        "ABUSEIPDB_MAX_AGE_DAYS",
        process.env.ABUSEIPDB_MAX_AGE_DAYS,
        ABUSEIPDB_DEFAULT_MAX_AGE_DAYS,
        { strict: true }
      )
    );
  } catch (err) {
    // Normalized to ConfigError so every configuration failure this module
    // throws is the same class, whatever variable caused it. No variable
    // value is ever included — validateAbuseIpdb*'s own messages never
    // interpolate the raw input, only the variable name and its bounds.
    throw new ConfigError(err instanceof AbuseIpdbConfigError ? err.message : `Invalid AbuseIPDB configuration: ${err.message}`);
  }

  // Phase 2 (§2B, Packet B) — vulnerability provider configuration. NVD_API_KEY
  // stays optional at startup exactly like ABUSEIPDB_API_KEY: a missing key
  // only affects NvdCveProvider.lookup() (the public rate limit applies), never
  // whether the app starts. CISA KEV and FIRST EPSS take no key at all. Base
  // URL/timeout are real request parameters sent to a live third party, so an
  // invalid value fails configuration validation loudly rather than silently
  // substituting a default — the same reasoning P2-T2c already applied to
  // AbuseIPDB.
  let nvdBaseUrl;
  let nvdTimeoutMs;
  let cisaKevUrl;
  let cisaKevTimeoutMs;
  let firstEpssBaseUrl;
  let firstEpssTimeoutMs;
  let vulnerabilityBatchSize;
  let vulnerabilityLeaseSeconds;
  let vulnerabilityMaxAttempts;
  try {
    nvdBaseUrl = validateNvdBaseUrl(requireString(process.env.NVD_BASE_URL) || NVD_DEFAULT_BASE_URL);
    nvdTimeoutMs = validateNvdTimeoutMs(
      parseOptionalInt("NVD_TIMEOUT_MS", process.env.NVD_TIMEOUT_MS, NVD_DEFAULT_TIMEOUT_MS, { strict: true })
    );
    cisaKevUrl = validateCisaKevUrl(requireString(process.env.CISA_KEV_URL) || CISA_KEV_DEFAULT_URL);
    cisaKevTimeoutMs = validateCisaKevTimeoutMs(
      parseOptionalInt("CISA_KEV_TIMEOUT_MS", process.env.CISA_KEV_TIMEOUT_MS, CISA_KEV_DEFAULT_TIMEOUT_MS, {
        strict: true,
      })
    );
    firstEpssBaseUrl = validateFirstEpssBaseUrl(
      requireString(process.env.FIRST_EPSS_BASE_URL) || FIRST_EPSS_DEFAULT_BASE_URL
    );
    firstEpssTimeoutMs = validateFirstEpssTimeoutMs(
      parseOptionalInt(
        "FIRST_EPSS_TIMEOUT_MS",
        process.env.FIRST_EPSS_TIMEOUT_MS,
        FIRST_EPSS_DEFAULT_TIMEOUT_MS,
        { strict: true }
      )
    );
    vulnerabilityBatchSize = validateVulnerabilityBatchSize(
      parseOptionalInt(
        "VULNERABILITY_BATCH_SIZE",
        process.env.VULNERABILITY_BATCH_SIZE,
        VULNERABILITY_DEFAULT_BATCH_SIZE,
        { strict: true }
      )
    );
    vulnerabilityLeaseSeconds = validateVulnerabilityLeaseSeconds(
      parseOptionalInt(
        "VULNERABILITY_LEASE_SECONDS",
        process.env.VULNERABILITY_LEASE_SECONDS,
        VULNERABILITY_DEFAULT_LEASE_SECONDS,
        { strict: true }
      )
    );
    vulnerabilityMaxAttempts = validateVulnerabilityMaxAttempts(
      parseOptionalInt(
        "VULNERABILITY_MAX_ATTEMPTS",
        process.env.VULNERABILITY_MAX_ATTEMPTS,
        VULNERABILITY_DEFAULT_MAX_ATTEMPTS,
        { strict: true }
      )
    );
  } catch (err) {
    throw new ConfigError(
      err instanceof VulnerabilityConfigError
        ? err.message
        : `Invalid vulnerability enrichment configuration: ${err.message}`
    );
  }

  // Declared, not consumed by anything: no code reads this value — the TTL
  // policy (enrichmentTtlPolicy.js) is a pure module configured through
  // explicit policy input, never through the environment.
  const abuseIpdbCacheTtlHours = parseOptionalInt(
    "ABUSEIPDB_CACHE_TTL_HOURS",
    process.env.ABUSEIPDB_CACHE_TTL_HOURS,
    24,
    { strict: false }
  );

  return Object.freeze({
    NODE_ENV: nodeEnv,
    PORT: port,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "24h",
    CORS_ORIGIN: corsOrigin,
    LOG_LEVEL: process.env.LOG_LEVEL || "info",
    UPLOAD_MAX_BYTES: uploadMaxBytes,
    REPORT_MAX_ROWS: reportMaxRows,

    // Seeding is not configured here. backend/src/scripts/seedUsers.js reads
    // SEED_USER_PASSWORD straight from process.env so the value stays a
    // one-off shell variable and never becomes part of the app's config
    // surface. The former SEED_ADMIN_EMAIL / SEED_DEFAULT_PASSWORD entries
    // belonged to a seed script that never existed.

    // Phase 2 (P2-T2c) — real AbuseIPDBProvider configuration. API key is
    // optional (never required to start the app); never logged or included
    // in any error message this module throws.
    IOC_ENRICHMENT_PROVIDER: process.env.IOC_ENRICHMENT_PROVIDER || "mock",
    ABUSEIPDB_API_KEY: process.env.ABUSEIPDB_API_KEY || "",
    ABUSEIPDB_BASE_URL: abuseIpdbBaseUrl,
    ABUSEIPDB_TIMEOUT_MS: abuseIpdbTimeoutMs,
    ABUSEIPDB_MAX_AGE_DAYS: abuseIpdbMaxAgeDays,
    ABUSEIPDB_CACHE_TTL_HOURS: abuseIpdbCacheTtlHours,

    // Phase 2 (§2B, Packet B) — vulnerability provider/runtime configuration.
    // NVD_API_KEY is optional and never required to start the app; never
    // logged or included in any error message this module throws.
    NVD_API_KEY: process.env.NVD_API_KEY || "",
    NVD_BASE_URL: nvdBaseUrl,
    NVD_TIMEOUT_MS: nvdTimeoutMs,
    CISA_KEV_URL: cisaKevUrl,
    CISA_KEV_TIMEOUT_MS: cisaKevTimeoutMs,
    FIRST_EPSS_BASE_URL: firstEpssBaseUrl,
    FIRST_EPSS_TIMEOUT_MS: firstEpssTimeoutMs,
    VULNERABILITY_BATCH_SIZE: vulnerabilityBatchSize,
    VULNERABILITY_LEASE_SECONDS: vulnerabilityLeaseSeconds,
    VULNERABILITY_MAX_ATTEMPTS: vulnerabilityMaxAttempts,

    // Phase 5 — declared, not consumed by anything in Phase 0. Off by default.
    AI_ENABLED: (process.env.AI_ENABLED || "false").trim().toLowerCase() === "true",
    AI_PROVIDER: process.env.AI_PROVIDER || "null",
  });
}

module.exports = buildConfig();
