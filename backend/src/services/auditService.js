"use strict";

const { redact } = require("../lib/redact");
const { DEFAULT_TLP, isValidTlp } = require("../lib/tlp");
const { normalizeRole } = require("../lib/roles");

const AUDIT_OUTCOMES = Object.freeze({
  SUCCESS: "SUCCESS",
  FAILURE: "FAILURE",
  DENIED: "DENIED",
});

const AUDIT_OUTCOME_VALUES = Object.freeze(Object.keys(AUDIT_OUTCOMES));

const DEFAULT_OUTCOME = AUDIT_OUTCOMES.SUCCESS;

// The Prisma singleton is resolved lazily rather than required at module load:
// constructing PrismaClient needs DATABASE_URL, and unit tests inject a stub
// client instead. This still reuses src/config/prisma.js — no second client.
function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../config/prisma");
}

function toNullableString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Prisma treats undefined as "column not provided" and leaves it NULL, whereas
// an explicit null on a Json? field needs Prisma.DbNull. Normalising absent
// values to undefined keeps both nullable scalars and Json columns correct.
function orUndefined(value) {
  return value === null ? undefined : value;
}

// Query strings and fragments routinely carry tokens and other secrets
// (?token=..., #access_token=...), so only the path portion is ever stored.
function stripQueryString(value) {
  const str = toNullableString(value);
  if (str === null) return null;
  const cut = str.search(/[?#]/);
  return cut === -1 ? str : str.slice(0, cut);
}

function requireAction(action) {
  const normalized = toNullableString(action);
  if (normalized === null) {
    throw new Error("auditService: action is required");
  }
  return normalized;
}

// An outcome the caller got wrong is a programming error: silently recording
// SUCCESS would corrupt the audit trail, so this throws. safeLogAuditEvent
// contains the blast radius for callers on a primary request path.
function resolveOutcome(outcome) {
  if (outcome === undefined || outcome === null) return DEFAULT_OUTCOME;
  if (AUDIT_OUTCOME_VALUES.includes(outcome)) return outcome;
  throw new Error(
    `auditService: invalid outcome (expected one of ${AUDIT_OUTCOME_VALUES.join(", ")})`
  );
}

// TLP fails safe instead of throwing: a mislabelled record is worth keeping,
// and the fallback is the more restrictive default rather than a wider label.
function resolveTlp(tlp) {
  if (tlp === undefined || tlp === null) return DEFAULT_TLP;
  return isValidTlp(tlp) ? tlp : DEFAULT_TLP;
}

// Absent actor role stays null: normalizeRole(undefined) returns VIEWER, which
// would falsely attribute a role to an unauthenticated or system actor.
function resolveActorRole(role) {
  if (role === undefined || role === null) return null;
  return normalizeRole(role);
}

function resolveActorUserId(id) {
  if (id === undefined || id === null) return null;
  if (typeof id === "number") {
    return Number.isFinite(id) ? String(id) : null;
  }
  return toNullableString(id);
}

// before/after are arbitrary entity snapshots, so they are redacted by key
// (password, token, authorization, cookie, secret, apiKey, ...) before they
// can reach the database.
function sanitizeAuditPayload(payload) {
  if (payload === undefined || payload === null) return null;
  return redact(payload);
}

// Extracts only the non-sensitive request metadata the AuditLog model holds.
// Deliberately omitted: raw headers, cookies, Authorization, query string and
// request body. sourceIp comes from req.ip only — the app does not enable
// Express "trust proxy", so req.ip is the real socket address and a spoofable
// X-Forwarded-For header is never read. If a trusted proxy is introduced
// later, configure app.set("trust proxy", ...) so req.ip stays authoritative
// rather than parsing the header here.
function buildAuditContext(req) {
  if (!req || typeof req !== "object") return {};

  const context = req.context && typeof req.context === "object" ? req.context : {};
  const user = req.user && typeof req.user === "object" ? req.user : {};

  return {
    requestId: toNullableString(context.requestId),
    method: toNullableString(req.method),
    path: stripQueryString(req.originalUrl || req.url),
    sourceIp: toNullableString(req.ip),
    actorUserId: resolveActorUserId(user.id),
    actorEmail: toNullableString(user.email),
    actorRole: resolveActorRole(user.role),
  };
}

function buildAuditData(event) {
  const before = sanitizeAuditPayload(event.before);
  const after = sanitizeAuditPayload(event.after);

  return {
    action: requireAction(event.action),
    outcome: resolveOutcome(event.outcome),
    tlp: resolveTlp(event.tlp),

    actorUserId: orUndefined(resolveActorUserId(event.actorUserId)),
    actorEmail: orUndefined(toNullableString(event.actorEmail)),
    actorRole: orUndefined(resolveActorRole(event.actorRole)),

    sourceIp: orUndefined(toNullableString(event.sourceIp)),
    requestId: orUndefined(toNullableString(event.requestId)),
    method: orUndefined(toNullableString(event.method)),
    path: orUndefined(stripQueryString(event.path)),

    entityType: orUndefined(toNullableString(event.entityType)),
    entityId: orUndefined(resolveActorUserId(event.entityId)),

    before: orUndefined(before),
    after: orUndefined(after),
    reason: orUndefined(toNullableString(event.reason)),

    // occurredAt is left to the database default unless a caller backdates an
    // event explicitly (e.g. replaying an imported record).
    occurredAt: event.occurredAt instanceof Date ? event.occurredAt : undefined,
  };
}

// Throws on bad input or on a failed write, so explicit service calls and
// tests surface problems. Returns the created AuditLog row.
async function logAuditEvent(event = {}, options = {}) {
  const prisma = resolveClient(options.client);
  const data = buildAuditData(event);
  return prisma.auditLog.create({ data });
}

// Non-throwing wrapper for primary request paths: a failed audit write must
// not break the user-facing operation. The error metadata is redacted before
// logging and never includes the event payloads.
async function safeLogAuditEvent(event = {}, options = {}) {
  try {
    return await logAuditEvent(event, options);
  } catch (error) {
    console.error(
      "Audit log write failed",
      redact({
        name: error && error.name,
        message: error && error.message,
        action: event && event.action,
        requestId: event && event.requestId,
      })
    );
    return null;
  }
}

module.exports = {
  AUDIT_OUTCOMES,
  AUDIT_OUTCOME_VALUES,
  DEFAULT_OUTCOME,
  buildAuditContext,
  sanitizeAuditPayload,
  logAuditEvent,
  safeLogAuditEvent,
};
