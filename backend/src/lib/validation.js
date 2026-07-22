"use strict";

// Deliberately conservative rather than RFC-complete: it rejects whitespace,
// missing local/domain parts and dotless domains, which is enough to keep
// malformed input out of the user table without bouncing valid addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_EMAIL_LENGTH = 254;

const MIN_PASSWORD_LENGTH = 8;
// bcrypt silently truncates input beyond 72 bytes, so anything longer is
// rejected instead of being quietly shortened.
const MAX_PASSWORD_LENGTH = 72;

// Lower-casing is what makes the unique constraint meaningful: without it
// "User@x.com" and "user@x.com" would be two accounts.
function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

function isValidEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_EMAIL_LENGTH &&
    EMAIL_PATTERN.test(value)
  );
}

function isValidPassword(value) {
  return (
    typeof value === "string" &&
    value.length >= MIN_PASSWORD_LENGTH &&
    value.length <= MAX_PASSWORD_LENGTH
  );
}

function normalizeName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

module.exports = {
  EMAIL_PATTERN,
  MAX_EMAIL_LENGTH,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  normalizeEmail,
  isValidEmail,
  isValidPassword,
  normalizeName,
};
