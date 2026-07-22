"use strict";

const jwt = require("jsonwebtoken");

const env = require("../config/env");
const { resolveAuthorizationRole } = require("../lib/roles");

// One message for missing, malformed, invalid and expired tokens alike. Naming
// the specific failure (and especially surfacing jwt's TokenExpiredError /
// JsonWebTokenError text) tells a caller how to refine an attack.
const UNAUTHENTICATED_MESSAGE = "Authentication required.";

// Mirrors errorHandler / requireRole: requestId only when the context exists.
function unauthenticated(req, res) {
  const body = { success: false, message: UNAUTHENTICATED_MESSAGE };
  const requestId = req && req.context ? req.context.requestId : undefined;
  if (requestId) {
    body.requestId = requestId;
  }
  return res.status(401).json(body);
}

// Accepts exactly "Bearer <token>" (scheme case-insensitive). Anything else —
// no header, wrong scheme, missing or extra parts — is rejected before the
// token is ever handed to jwt.verify.
function extractBearerToken(authHeader) {
  if (typeof authHeader !== "string") return null;

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== "bearer") return null;
  if (!parts[1]) return null;

  return parts[1];
}

const authenticate = (req, res, next) => {
  const authHeader = req && req.headers ? req.headers.authorization : undefined;
  const token = extractBearerToken(authHeader);

  if (token === null) {
    return unauthenticated(req, res);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch (error) {
    // The token value and the jwt error detail are both deliberately unlogged:
    // a token is a live credential and belongs in neither logs nor responses.
    return unauthenticated(req, res);
  }

  if (!decoded || typeof decoded !== "object") {
    return unauthenticated(req, res);
  }

  // Only the fields the app actually uses are carried forward. iat/exp are
  // dropped because req.user is echoed straight back by GET /api/profile.
  //
  // resolveAuthorizationRole — not normalizeRole — is used on purpose: it maps
  // legacy spellings ("analyst") to the canonical enum but resolves an
  // unrecognised role to null rather than to VIEWER, so a token carrying an
  // unknown role holds no capability instead of quietly gaining read access.
  req.user = {
    id: decoded.id,
    email: decoded.email,
    role: resolveAuthorizationRole(decoded.role),
  };

  return next();
};

module.exports = authenticate;
