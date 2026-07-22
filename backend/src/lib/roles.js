"use strict";

const ROLE_VALUES = Object.freeze(["ADMIN", "ANALYST", "REVIEWER", "VIEWER"]);

const DEFAULT_ROLE = "VIEWER";

// Legacy role strings that predate the Role enum. Anything not listed here —
// including null, undefined, non-strings and typos — falls back to
// DEFAULT_ROLE. The fallback is always the least-privileged role, never ADMIN.
const LEGACY_ROLE_ALIASES = Object.freeze({
  USER: "VIEWER",
  MEMBER: "VIEWER",
  BASIC: "VIEWER",
  UNKNOWN: "VIEWER",
});

function isValidRole(role) {
  return typeof role === "string" && ROLE_VALUES.includes(role);
}

// Fails safe rather than throwing: callers normalizing untrusted input (legacy
// JWT payloads, request bodies) get VIEWER instead of an error or elevation.
function normalizeRole(role) {
  if (typeof role !== "string") return DEFAULT_ROLE;

  const candidate = role.trim().toUpperCase();
  if (candidate === "") return DEFAULT_ROLE;

  if (ROLE_VALUES.includes(candidate)) return candidate;
  if (Object.prototype.hasOwnProperty.call(LEGACY_ROLE_ALIASES, candidate)) {
    return LEGACY_ROLE_ALIASES[candidate];
  }

  return DEFAULT_ROLE;
}

module.exports = {
  ROLE_VALUES,
  DEFAULT_ROLE,
  isValidRole,
  normalizeRole,
};
