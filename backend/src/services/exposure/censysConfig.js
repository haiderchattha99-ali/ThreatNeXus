"use strict";

// Shared, pure bounds/defaults for Censys configuration (Phase 8B). Used by
// both backend/src/config/env.js (startup validation) and censysProvider.js
// (defaults applied when a factory caller doesn't override baseUrl/timeoutMs),
// so the two can never silently drift apart into two different notions of
// "valid" — the same reasoning abuseIpdbConfig.js already established for
// AbuseIPDB. No env access, no I/O — pure data + validation only.

// Censys's current Platform API. The legacy Search v2 API (search.censys.io)
// is a different product with a different auth scheme (Basic Auth, API ID +
// secret) and is not what this provider targets.
const DEFAULT_BASE_URL = "https://api.platform.censys.io/v3";

// A bounded, safe default — long enough for a slow provider response, short
// enough that one lookup can never stall a caller indefinitely.
const DEFAULT_TIMEOUT_MS = 8000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;

class CensysConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "CensysConfigError";
  }
}

// HTTPS is required by default. The one carve-out is an explicit local test
// URL (http://localhost or http://127.0.0.1, with or without a port/path) —
// never a blanket "http is fine", mirroring abuseIpdbConfig.js exactly.
function isLocalTestBaseUrl(value) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/.test(value);
}

function validateBaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CensysConfigError("CENSYS_BASE_URL must be a non-empty string");
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("https://") && !isLocalTestBaseUrl(trimmed)) {
    throw new CensysConfigError(
      "CENSYS_BASE_URL must be HTTPS, or an explicit local test URL (http://localhost or http://127.0.0.1)"
    );
  }
  return trimmed;
}

function validateTimeoutMs(value) {
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new CensysConfigError(
      `CENSYS_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`
    );
  }
  return value;
}

module.exports = {
  CensysConfigError,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  validateBaseUrl,
  validateTimeoutMs,
};
