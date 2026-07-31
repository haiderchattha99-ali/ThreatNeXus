"use strict";

// Shared, pure bounds/defaults for AbuseIPDB configuration (P2-T2c). Used by
// both backend/src/config/env.js (startup validation) and
// abuseIpdbProvider.js (defaults applied when a factory caller doesn't
// override baseUrl/timeoutMs/maxAgeInDays), so the two can never silently
// drift apart into two different notions of "valid". No env access, no I/O —
// pure data + validation only.

const DEFAULT_BASE_URL = "https://api.abuseipdb.com/api/v2";

// A bounded, safe default — long enough for a slow provider response, short
// enough that one lookup can never stall a caller indefinitely.
const DEFAULT_TIMEOUT_MS = 8000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;

// AbuseIPDB's own documented maximum for the check endpoint's maxAgeInDays
// parameter is 365.
const DEFAULT_MAX_AGE_DAYS = 90;
const MIN_MAX_AGE_DAYS = 1;
const MAX_MAX_AGE_DAYS = 365;

class AbuseIpdbConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "AbuseIpdbConfigError";
  }
}

// HTTPS is required by default. The one carve-out is an explicit local test
// URL (http://localhost or http://127.0.0.1, with or without a port/path) —
// never a blanket "http is fine", and never based on NODE_ENV alone.
function isLocalTestBaseUrl(value) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/.test(value);
}

function validateBaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AbuseIpdbConfigError("ABUSEIPDB_BASE_URL must be a non-empty string");
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("https://") && !isLocalTestBaseUrl(trimmed)) {
    throw new AbuseIpdbConfigError(
      "ABUSEIPDB_BASE_URL must be HTTPS, or an explicit local test URL (http://localhost or http://127.0.0.1)"
    );
  }
  return trimmed;
}

function validateBoundedInt(value, { label, min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AbuseIpdbConfigError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function validateTimeoutMs(value) {
  return validateBoundedInt(value, {
    label: "ABUSEIPDB_TIMEOUT_MS",
    min: MIN_TIMEOUT_MS,
    max: MAX_TIMEOUT_MS,
  });
}

function validateMaxAgeDays(value) {
  return validateBoundedInt(value, {
    label: "ABUSEIPDB_MAX_AGE_DAYS",
    min: MIN_MAX_AGE_DAYS,
    max: MAX_MAX_AGE_DAYS,
  });
}

module.exports = {
  AbuseIpdbConfigError,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_AGE_DAYS,
  MIN_MAX_AGE_DAYS,
  MAX_MAX_AGE_DAYS,
  validateBaseUrl,
  validateTimeoutMs,
  validateMaxAgeDays,
};
