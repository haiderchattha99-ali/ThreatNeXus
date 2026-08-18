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
  CensysConfigError,
  DEFAULT_BASE_URL: CENSYS_DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS: CENSYS_DEFAULT_TIMEOUT_MS,
  validateBaseUrl: validateCensysBaseUrl,
  validateTimeoutMs: validateCensysTimeoutMs,
} = require("../services/exposure/censysConfig");
const {
  GreyNoiseConfigError,
  DEFAULT_BASE_URL: GREYNOISE_DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS: GREYNOISE_DEFAULT_TIMEOUT_MS,
  validateBaseUrl: validateGreyNoiseBaseUrl,
  validateTimeoutMs: validateGreyNoiseTimeoutMs,
} = require("../services/reputation/greyNoiseConfig");
const {
  ShodanConfigError,
  DEFAULT_BASE_URL: SHODAN_DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS: SHODAN_DEFAULT_TIMEOUT_MS,
  validateBaseUrl: validateShodanBaseUrl,
  validateTimeoutMs: validateShodanTimeoutMs,
} = require("../services/exposure/shodanConfig");
const {
  NetlasConfigError,
  DEFAULT_BASE_URL: NETLAS_DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS: NETLAS_DEFAULT_TIMEOUT_MS,
  validateBaseUrl: validateNetlasBaseUrl,
  validateTimeoutMs: validateNetlasTimeoutMs,
} = require("../services/exposure/netlasConfig");
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
const {
  EnrichmentOrchestrationConfigError,
  resolveOrchestrationConfig,
  resolveWorkerRuntimeConfig,
} = require("../services/enrichmentOrchestration/enrichmentOrchestrationConfig");

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

  // Phase 7 — request rate limiting. Three independent buckets so one surface
  // cannot exhaust another's budget: authentication, report upload, and
  // explicit provider execution (the routes that spend third-party quota).
  //
  // RATE_LIMIT_ENABLED defaults to ON everywhere except NODE_ENV=test. The test
  // default is off because ~3,000 tests share one process and one loopback
  // address, so a live limiter would make unrelated suites fail by position
  // rather than by behaviour. The control is not thereby unproven: the Phase 7
  // security suite turns each bucket on explicitly and drives it past its limit,
  // and a test in that suite asserts this default resolution itself, so nobody
  // can conclude from "off in tests" that it is off in production.
  const rateLimitEnabled = (() => {
    const raw = process.env.RATE_LIMIT_ENABLED;
    if (raw === undefined || raw === null || raw.trim() === "") {
      return nodeEnv !== "test";
    }
    return raw.trim().toLowerCase() === "true";
  })();

  // Security pass — public self-service registration.
  //
  // ThreatNeXus holds constituent exposure evidence. Its least-privileged role,
  // VIEWER, deliberately carries read:dashboard, read:findings and read:cases,
  // because a read-only oversight role is a stated requirement. That is correct
  // for an account the organization issued — and wrong for an account anybody
  // can mint. With POST /api/auth/register open, those two correct decisions
  // composed into an anonymous read of every finding (victim address, port,
  // owning organization), every case and the operational dashboard: one
  // unauthenticated request to create the account, one to sign in.
  //
  // The route is therefore CLOSED unless an operator opens it. It is left
  // mounted rather than deleted so the refusal is explicit, audited, and
  // reversible for a bootstrap or a demonstration; the route census exception
  // ("unauthenticated by necessity") stays accurate either way. Accounts are
  // otherwise provisioned out of band by seedUsers.js.
  //
  // Default false in EVERY environment, test included. A control whose default
  // differs between test and production is a control whose production
  // behaviour no test observes.
  const allowPublicRegistration =
    String(process.env.ALLOW_PUBLIC_REGISTRATION || "").trim().toLowerCase() ===
    "true";

  const rateLimitAuthWindowMs = parseOptionalInt(
    "RATE_LIMIT_AUTH_WINDOW_MS",
    process.env.RATE_LIMIT_AUTH_WINDOW_MS,
    900000, // 15 minutes
    { strict: true }
  );
  const rateLimitAuthMax = parseOptionalInt(
    "RATE_LIMIT_AUTH_MAX",
    process.env.RATE_LIMIT_AUTH_MAX,
    30,
    { strict: true }
  );
  const rateLimitUploadWindowMs = parseOptionalInt(
    "RATE_LIMIT_UPLOAD_WINDOW_MS",
    process.env.RATE_LIMIT_UPLOAD_WINDOW_MS,
    900000,
    { strict: true }
  );
  const rateLimitUploadMax = parseOptionalInt(
    "RATE_LIMIT_UPLOAD_MAX",
    process.env.RATE_LIMIT_UPLOAD_MAX,
    20,
    { strict: true }
  );
  const rateLimitProviderWindowMs = parseOptionalInt(
    "RATE_LIMIT_PROVIDER_WINDOW_MS",
    process.env.RATE_LIMIT_PROVIDER_WINDOW_MS,
    900000,
    { strict: true }
  );
  const rateLimitProviderMax = parseOptionalInt(
    "RATE_LIMIT_PROVIDER_MAX",
    process.env.RATE_LIMIT_PROVIDER_MAX,
    60,
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

  // Phase 8B — Censys internet-exposure/attack-surface provider, against
  // Censys's current Platform API (Bearer Personal Access Token, not the
  // legacy Search v2 API's Basic Auth pair). CENSYS_PAT stays optional at
  // startup exactly like ABUSEIPDB_API_KEY: a missing credential only affects
  // censysProvider.js's lookup() (SKIPPED_DISABLED), never whether the app
  // starts. CENSYS_ORG_ID is optional even when CENSYS_PAT is set — only
  // accounts belonging to more than one Censys organization need it.
  let censysBaseUrl;
  let censysTimeoutMs;
  try {
    censysBaseUrl = validateCensysBaseUrl(requireString(process.env.CENSYS_BASE_URL) || CENSYS_DEFAULT_BASE_URL);
    censysTimeoutMs = validateCensysTimeoutMs(
      parseOptionalInt("CENSYS_TIMEOUT_MS", process.env.CENSYS_TIMEOUT_MS, CENSYS_DEFAULT_TIMEOUT_MS, {
        strict: true,
      })
    );
  } catch (err) {
    throw new ConfigError(
      err instanceof CensysConfigError ? err.message : `Invalid Censys configuration: ${err.message}`
    );
  }

  // Phase 8D — GreyNoise internet-noise/reputation provider (Community API).
  // GREYNOISE_API_KEY stays optional at startup exactly like
  // CENSYS_PAT/ABUSEIPDB_API_KEY: a missing credential only affects
  // greyNoiseProvider.js's lookup() (SKIPPED_DISABLED), never whether the
  // app starts.
  let greyNoiseBaseUrl;
  let greyNoiseTimeoutMs;
  try {
    greyNoiseBaseUrl = validateGreyNoiseBaseUrl(
      requireString(process.env.GREYNOISE_BASE_URL) || GREYNOISE_DEFAULT_BASE_URL
    );
    greyNoiseTimeoutMs = validateGreyNoiseTimeoutMs(
      parseOptionalInt("GREYNOISE_TIMEOUT_MS", process.env.GREYNOISE_TIMEOUT_MS, GREYNOISE_DEFAULT_TIMEOUT_MS, {
        strict: true,
      })
    );
  } catch (err) {
    throw new ConfigError(
      err instanceof GreyNoiseConfigError
        ? err.message
        : `Invalid GreyNoise configuration: ${err.message}`
    );
  }

  // Phase 8E — Shodan internet-exposure provider (exposed service/banner/
  // port intelligence). SHODAN_API_KEY stays optional at startup exactly
  // like CENSYS_PAT/GREYNOISE_API_KEY: a missing credential only affects
  // shodanProvider.js's lookup() (SKIPPED_DISABLED), never whether the app
  // starts.
  let shodanBaseUrl;
  let shodanTimeoutMs;
  try {
    shodanBaseUrl = validateShodanBaseUrl(requireString(process.env.SHODAN_BASE_URL) || SHODAN_DEFAULT_BASE_URL);
    shodanTimeoutMs = validateShodanTimeoutMs(
      parseOptionalInt("SHODAN_TIMEOUT_MS", process.env.SHODAN_TIMEOUT_MS, SHODAN_DEFAULT_TIMEOUT_MS, {
        strict: true,
      })
    );
  } catch (err) {
    throw new ConfigError(
      err instanceof ShodanConfigError ? err.message : `Invalid Shodan configuration: ${err.message}`
    );
  }

  // Phase 8F — Netlas cross-source attack-surface/DNS/certificate provider.
  // NETLAS_API_KEY stays optional at startup exactly like
  // CENSYS_PAT/GREYNOISE_API_KEY/SHODAN_API_KEY: a missing credential only
  // affects netlasProvider.js's lookup() (SKIPPED_DISABLED), never whether
  // the app starts.
  let netlasBaseUrl;
  let netlasTimeoutMs;
  try {
    netlasBaseUrl = validateNetlasBaseUrl(requireString(process.env.NETLAS_BASE_URL) || NETLAS_DEFAULT_BASE_URL);
    netlasTimeoutMs = validateNetlasTimeoutMs(
      parseOptionalInt("NETLAS_TIMEOUT_MS", process.env.NETLAS_TIMEOUT_MS, NETLAS_DEFAULT_TIMEOUT_MS, {
        strict: true,
      })
    );
  } catch (err) {
    throw new ConfigError(
      err instanceof NetlasConfigError ? err.message : `Invalid Netlas configuration: ${err.message}`
    );
  }

  // Phase 10A-1 — enrichment orchestration. Two independent default-OFF
  // switches plus per-provider daily budgets, all resolved and validated
  // through enrichmentOrchestrationConfig.js so the bounds live in one place.
  //
  // Every AUTOMATIC budget defaults to 0 and every MANUAL budget defaults to
  // null (unlimited). That is deliberate belt-and-braces: even an operator who
  // turns AUTO_ENRICHMENT_ENABLED on cannot spend a single unit of automatic
  // third-party quota without also raising a budget on purpose.
  let orchestrationConfig;
  try {
    orchestrationConfig = resolveOrchestrationConfig(process.env);
  } catch (err) {
    throw new ConfigError(
      err instanceof EnrichmentOrchestrationConfigError
        ? err.message
        : `Invalid enrichment orchestration configuration: ${err.message}`
    );
  }

  // Phase 10A-2 — the worker runtime. Resolved and CROSS-VALIDATED here even
  // when ENRICHMENT_WORKER_ENABLED is false, so a deployment learns its timing
  // configuration is unsafe at startup rather than the first time an operator
  // turns the worker on.
  let workerRuntimeConfig;
  try {
    workerRuntimeConfig = resolveWorkerRuntimeConfig(process.env);
  } catch (err) {
    throw new ConfigError(
      err instanceof EnrichmentOrchestrationConfigError
        ? err.message
        : `Invalid enrichment worker configuration: ${err.message}`
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

    // Security pass — public registration is closed by default (see above).
    ALLOW_PUBLIC_REGISTRATION: allowPublicRegistration,

    // Phase 7 — rate limiting (see the block that computes these).
    RATE_LIMIT_ENABLED: rateLimitEnabled,
    RATE_LIMIT_AUTH_WINDOW_MS: rateLimitAuthWindowMs,
    RATE_LIMIT_AUTH_MAX: rateLimitAuthMax,
    RATE_LIMIT_UPLOAD_WINDOW_MS: rateLimitUploadWindowMs,
    RATE_LIMIT_UPLOAD_MAX: rateLimitUploadMax,
    RATE_LIMIT_PROVIDER_WINDOW_MS: rateLimitProviderWindowMs,
    RATE_LIMIT_PROVIDER_MAX: rateLimitProviderMax,

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

    // Phase 8B — Censys configuration. Both credential fields are optional
    // and never required to start the app; never logged or included in any
    // error message this module throws.
    CENSYS_PAT: process.env.CENSYS_PAT || "",
    CENSYS_ORG_ID: process.env.CENSYS_ORG_ID || "",
    CENSYS_BASE_URL: censysBaseUrl,
    CENSYS_TIMEOUT_MS: censysTimeoutMs,

    // Phase 8D — GreyNoise configuration. Optional and never required to
    // start the app; never logged or included in any error message this
    // module throws.
    GREYNOISE_API_KEY: process.env.GREYNOISE_API_KEY || "",
    GREYNOISE_BASE_URL: greyNoiseBaseUrl,
    GREYNOISE_TIMEOUT_MS: greyNoiseTimeoutMs,

    // Phase 8E — Shodan configuration. Optional and never required to start
    // the app; never logged or included in any error message this module
    // throws.
    SHODAN_API_KEY: process.env.SHODAN_API_KEY || "",
    SHODAN_BASE_URL: shodanBaseUrl,
    SHODAN_TIMEOUT_MS: shodanTimeoutMs,

    // Phase 8F — Netlas configuration. Optional and never required to start
    // the app; never logged or included in any error message this module
    // throws.
    NETLAS_API_KEY: process.env.NETLAS_API_KEY || "",
    NETLAS_BASE_URL: netlasBaseUrl,
    NETLAS_TIMEOUT_MS: netlasTimeoutMs,

    // Phase 5 — declared, not consumed by anything in Phase 0. Off by default.
    AI_ENABLED: (process.env.AI_ENABLED || "false").trim().toLowerCase() === "true",
    AI_PROVIDER: process.env.AI_PROVIDER || "null",

    // Phase 10A-1 — enrichment orchestration. Both switches default to false.
    // With AUTO_ENRICHMENT_ENABLED=false, report ingestion behaves exactly as
    // it did before this milestone: the existing IocEnrichment row is still
    // created and NO Phase-10 run, item, job, attempt or usage row exists.
    // ENRICHMENT_WORKER_ENABLED is declared and validated but consumed by
    // nothing in 10A-1 — there is no worker to enable.
    AUTO_ENRICHMENT_ENABLED: orchestrationConfig.AUTO_ENRICHMENT_ENABLED,
    ENRICHMENT_WORKER_ENABLED: orchestrationConfig.ENRICHMENT_WORKER_ENABLED,
    ENRICHMENT_AUTOMATIC_DAILY_BUDGETS: orchestrationConfig.automaticDailyBudgets,
    ENRICHMENT_MANUAL_DAILY_BUDGETS: orchestrationConfig.manualDailyBudgets,

    // Phase 10A-2 — worker runtime. Cross-validated above: the lease outlives
    // the longest permitted lookup, and the stale-attempt sweep can never
    // reach an attempt whose lookup is still executing.
    ...workerRuntimeConfig,
  });
}

module.exports = buildConfig();
