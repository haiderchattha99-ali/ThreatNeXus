"use strict";

const {
  assertValidRequiredRole,
  assertValidCapability,
  hasRole,
  hasAnyRole,
  hasCapability,
  hasAnyCapability,
} = require("../lib/roles");

const {
  AUDIT_OUTCOMES,
  buildAuditContext,
  safeLogAuditEvent,
} = require("../services/auditService");

const AUTHORIZATION_DENIED_ACTION = "authorization.denied";
const AUTHORIZATION_ENTITY_TYPE = "Authorization";
const AUTHORIZATION_TLP = "AMBER";

// Generic, fixed client messages. The specific role or capability that was
// required stays server-side in the audit record — telling an unauthorized
// caller exactly which capability to obtain is free reconnaissance.
const UNAUTHENTICATED_MESSAGE = "Authentication required.";
const FORBIDDEN_MESSAGE = "Forbidden.";

function getRequestId(req) {
  return req && req.context ? req.context.requestId : undefined;
}

// Mirrors errorHandler's body shape: requestId is included only when present.
function sendDenial(req, res, status, message) {
  const body = { success: false, message };
  const requestId = getRequestId(req);
  if (requestId) {
    body.requestId = requestId;
  }
  return res.status(status).json(body);
}

// The audit write is awaited so the record is durable before the denial is
// returned, and wrapped defensively: safeLogAuditEvent already swallows its
// own errors, but authorization must not break even if a caller injects a
// broken logger.
async function auditDenial(req, reason, auditLogger) {
  try {
    await auditLogger({
      action: AUTHORIZATION_DENIED_ACTION,
      outcome: AUDIT_OUTCOMES.DENIED,
      entityType: AUTHORIZATION_ENTITY_TYPE,
      tlp: AUTHORIZATION_TLP,
      reason,
      ...buildAuditContext(req),
    });
  } catch (error) {
    // Never rethrow: a failed audit must not convert a clean 403 into a 500.
    console.error("Authorization audit failed", { name: error && error.name });
  }
}

// Shared guard body. `check` receives the raw req.user.role and returns a
// boolean; `reason` describes the requirement for the audit record only.
//
// The reason deliberately does NOT echo the caller-supplied role string:
// req.user.role comes from a JWT payload and is untrusted input that would
// otherwise be persisted verbatim. buildAuditContext already records the
// normalized actor role, id and email for investigation.
function createGuard(check, reason, options = {}) {
  const auditLogger = options.auditLogger || safeLogAuditEvent;

  return async function authorize(req, res, next) {
    if (!req || !req.user) {
      await auditDenial(req, `${reason} (unauthenticated)`, auditLogger);
      return sendDenial(req, res, 401, UNAUTHENTICATED_MESSAGE);
    }

    let allowed = false;
    try {
      allowed = check(req.user.role);
    } catch (error) {
      // Fail closed if the check itself throws for any reason.
      allowed = false;
    }

    if (!allowed) {
      await auditDenial(req, reason, auditLogger);
      return sendDenial(req, res, 403, FORBIDDEN_MESSAGE);
    }

    return next();
  };
}

// Exact role match — see hasRole. requireRole("ANALYST") does not admit ADMIN;
// use requireAnyRole or a capability guard when several roles should pass.
function requireRole(requiredRole, options) {
  assertValidRequiredRole(requiredRole);
  return createGuard(
    (userRole) => hasRole(userRole, requiredRole),
    `Requires role: ${requiredRole}`,
    options
  );
}

function requireAnyRole(requiredRoles, options) {
  if (!Array.isArray(requiredRoles) || requiredRoles.length === 0) {
    throw new Error("requireAnyRole: requiredRoles must be a non-empty array");
  }
  requiredRoles.forEach(assertValidRequiredRole);

  return createGuard(
    (userRole) => hasAnyRole(userRole, requiredRoles),
    `Requires one of roles: ${requiredRoles.join(", ")}`,
    options
  );
}

function requireCapability(capability, options) {
  assertValidCapability(capability);
  return createGuard(
    (userRole) => hasCapability(userRole, capability),
    `Requires capability: ${capability}`,
    options
  );
}

function requireAnyCapability(capabilities, options) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new Error("requireAnyCapability: capabilities must be a non-empty array");
  }
  capabilities.forEach(assertValidCapability);

  return createGuard(
    (userRole) => hasAnyCapability(userRole, capabilities),
    `Requires one of capabilities: ${capabilities.join(", ")}`,
    options
  );
}

module.exports = {
  requireRole,
  requireAnyRole,
  requireCapability,
  requireAnyCapability,
  AUTHORIZATION_DENIED_ACTION,
};
