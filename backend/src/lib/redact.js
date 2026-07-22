"use strict";

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";

// Substring match on the normalized key, so accessToken/refreshToken/
// passwordHash are caught by "token"/"password" without listing every variant.
const SENSITIVE_KEY_PATTERNS = [
  "password",
  "token",
  "authorization",
  "cookie",
  "jwt",
  "secret",
  "apikey",
  "databaseurl",
];

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function redactValue(value, seen) {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return CIRCULAR;
  }

  if (Array.isArray(value)) {
    seen.add(value);
    const result = value.map((item) => redactValue(item, seen));
    seen.delete(value);
    return result;
  }

  // Non-plain objects (Date, RegExp, ...) carry no key/value pairs that
  // could hold a secret, and their internal state isn't safely enumerable.
  if (value.constructor && value.constructor !== Object) {
    return value;
  }

  seen.add(value);
  const result = {};
  for (const [key, val] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactValue(val, seen);
  }
  seen.delete(value);
  return result;
}

function redact(input) {
  return redactValue(input, new Set());
}

module.exports = { redact };
