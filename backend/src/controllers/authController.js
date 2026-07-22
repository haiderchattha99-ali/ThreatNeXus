"use strict";

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const prisma = require("../config/prisma");
const env = require("../config/env");
const { redact } = require("../lib/redact");
const { DEFAULT_ROLE, normalizeRole } = require("../lib/roles");
const {
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  normalizeName,
  isValidEmail,
  isValidPassword,
} = require("../lib/validation");
const {
  AUDIT_OUTCOMES,
  buildAuditContext,
  safeLogAuditEvent,
} = require("../services/auditService");

const BCRYPT_SALT_ROUNDS = 10;

const REGISTER_ACTION = "auth.register";
const LOGIN_ACTION = "auth.login";

// One fixed message for every login failure — a different message or status
// for "no such user" versus "wrong password" is a user-enumeration oracle.
const GENERIC_INVALID_CREDENTIALS = "Invalid credentials.";
const SERVER_ERROR_MESSAGE = "Server error.";

// Compared against when no user matches, so a login attempt costs roughly the
// same time whether or not the address exists. Generated per process from
// random bytes, so no hash constant is committed.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  crypto.randomBytes(32).toString("hex"),
  BCRYPT_SALT_ROUNDS
);

// Audit writes must never turn a valid auth response into an error.
// safeLogAuditEvent already swallows its own failures; the extra guard covers
// anything thrown before it (e.g. a broken context).
async function audit(req, event) {
  try {
    await safeLogAuditEvent({ ...buildAuditContext(req), ...event });
  } catch (error) {
    console.error("Auth audit failed", { name: error && error.name });
  }
}

function logServerError(label, error, req) {
  console.error(
    label,
    redact({
      name: error && error.name,
      message: error && error.message,
      requestId: req && req.context ? req.context.requestId : undefined,
    })
  );
}

function getBody(req) {
  return req && req.body && typeof req.body === "object" ? req.body : {};
}

// Only recorded when it is a well-formed address, so arbitrary attacker input
// is not persisted verbatim into the audit trail.
function auditableEmail(email) {
  return isValidEmail(email) ? email : null;
}

const register = async (req, res) => {
  const body = getBody(req);

  const name = normalizeName(body.name);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  const invalidFields = [];
  if (name === null) invalidFields.push("name");
  if (!isValidEmail(email)) invalidFields.push("email");
  if (!isValidPassword(password)) invalidFields.push("password");

  if (invalidFields.length > 0) {
    await audit(req, {
      action: REGISTER_ACTION,
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: "User",
      actorEmail: auditableEmail(email),
      reason: `Registration validation failed: ${invalidFields.join(", ")}`,
    });

    return res.status(400).json({
      success: false,
      message: `Invalid registration details. Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      fields: invalidFields,
    });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      await audit(req, {
        action: REGISTER_ACTION,
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: "User",
        actorEmail: email,
        reason: "Registration rejected: email already registered",
      });

      return res.status(400).json({
        success: false,
        message: "Email is already registered.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    const user = await prisma.user.create({
      // role is never taken from the request body. Public registration always
      // creates the least-privileged role; privileged roles are assigned out
      // of band. The column default is VIEWER too, so both layers agree.
      data: {
        name,
        email,
        password: hashedPassword,
        role: DEFAULT_ROLE,
      },
      // Explicit select so the password hash never leaves the database layer.
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    await audit(req, {
      action: REGISTER_ACTION,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: "User",
      entityId: user.id,
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      reason: "User registered",
    });

    return res.status(201).json({
      success: true,
      message: "User registered successfully",
      user,
    });
  } catch (error) {
    // Unique-constraint violation from a race between the check above and the
    // insert — surfaced as the same controlled message, not a Prisma stack.
    if (error && error.code === "P2002") {
      await audit(req, {
        action: REGISTER_ACTION,
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: "User",
        actorEmail: email,
        reason: "Registration rejected: email already registered",
      });

      return res.status(400).json({
        success: false,
        message: "Email is already registered.",
      });
    }

    logServerError("Registration failed", error, req);
    return res.status(500).json({
      success: false,
      message: SERVER_ERROR_MESSAGE,
    });
  }
};

const login = async (req, res) => {
  const body = getBody(req);

  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  if (!isValidEmail(email) || password === "") {
    await audit(req, {
      action: LOGIN_ACTION,
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: "Authentication",
      actorEmail: auditableEmail(email),
      reason: "Login rejected: missing or malformed credentials",
    });

    return res.status(400).json({
      success: false,
      message: "Email and password are required.",
    });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    // The comparison runs even when no user matched, so response time does not
    // reveal whether the address is registered.
    const passwordHash = user && user.password ? user.password : DUMMY_PASSWORD_HASH;
    const isMatch = await bcrypt.compare(password, passwordHash);

    if (!user || !isMatch) {
      await audit(req, {
        action: LOGIN_ACTION,
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: "Authentication",
        actorEmail: email,
        // Deliberately identical whether or not the account exists.
        reason: "Login failed: invalid credentials",
      });

      return res.status(401).json({
        success: false,
        message: GENERIC_INVALID_CREDENTIALS,
      });
    }

    // Legacy rows/tokens may still hold "analyst"; unknown values fall back to
    // the least-privileged role rather than being trusted.
    const role = normalizeRole(user.role);

    const token = jwt.sign(
      { id: user.id, email: user.email, role },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN }
    );

    await audit(req, {
      action: LOGIN_ACTION,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: "Authentication",
      entityId: user.id,
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: role,
      reason: "Login succeeded",
    });

    // Fields are listed explicitly; the user row from findUnique still holds
    // the password hash and must never be spread into a response.
    return res.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role,
      },
    });
  } catch (error) {
    logServerError("Login failed", error, req);
    return res.status(500).json({
      success: false,
      message: SERVER_ERROR_MESSAGE,
    });
  }
};

module.exports = { register, login };
