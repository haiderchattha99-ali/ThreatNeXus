"use strict";

const dotenv = require("dotenv");

dotenv.config();

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

  // Phase 2 values: optional in Phase 0, never required, invalid input falls
  // back to the default rather than blocking startup.
  const abuseIpdbTimeoutMs = parseOptionalInt(
    "ABUSEIPDB_TIMEOUT_MS",
    process.env.ABUSEIPDB_TIMEOUT_MS,
    5000,
    { strict: false }
  );
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

    SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL || "",
    SEED_DEFAULT_PASSWORD: process.env.SEED_DEFAULT_PASSWORD || "",

    // Phase 2 — declared, not consumed by anything in Phase 0.
    IOC_ENRICHMENT_PROVIDER: process.env.IOC_ENRICHMENT_PROVIDER || "mock",
    ABUSEIPDB_API_KEY: process.env.ABUSEIPDB_API_KEY || "",
    ABUSEIPDB_BASE_URL:
      process.env.ABUSEIPDB_BASE_URL || "https://api.abuseipdb.com/api/v2",
    ABUSEIPDB_TIMEOUT_MS: abuseIpdbTimeoutMs,
    ABUSEIPDB_CACHE_TTL_HOURS: abuseIpdbCacheTtlHours,

    // Phase 5 — declared, not consumed by anything in Phase 0. Off by default.
    AI_ENABLED: (process.env.AI_ENABLED || "false").trim().toLowerCase() === "true",
    AI_PROVIDER: process.env.AI_PROVIDER || "null",
  });
}

module.exports = buildConfig();
