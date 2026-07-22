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

// Generic non-blank string check, used by the resource controllers for
// required text fields. Same rule as normalizeName; named for the general case
// so call sites reading "normalizeName(title)" don't look like a mistake.
const normalizeRequiredString = normalizeName;

// Route params are untrusted strings. Number("") is 0 and Number("1abc") is
// NaN, either of which would reach Prisma as a bogus `where: { id }`, so ids
// are parsed strictly here: only a plain positive integer is accepted and
// anything else returns null for the caller to turn into a controlled 400.
function parseResourceId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// Copies only the listed keys that the caller actually supplied. Two reasons:
// a client cannot set id/createdAt/updatedAt or any unknown column by putting
// it in the body, and an absent key stays absent rather than becoming an
// explicit null that would overwrite stored data.
function pickDefined(source, allowedKeys) {
  const result = {};
  if (!source || typeof source !== "object") return result;

  allowedKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      result[key] = source[key];
    }
  });

  return result;
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
  normalizeRequiredString,
  parseResourceId,
  pickDefined,
};
