// Shared Prisma singleton — see the note in caseController.js on why a second
// PrismaClient is not constructed here.
const prisma = require("../config/prisma");

const {
  AUDIT_OUTCOMES,
  buildAuditContext,
  safeLogAuditEvent,
} = require("../services/auditService");

const {
  normalizeEmail,
  isValidEmail,
  normalizeRequiredString,
  parseResourceId,
  pickDefined,
} = require("../lib/validation");

const ORGANIZATION_ENTITY_TYPE = "Organization";

// Fields a client may set. id/createdAt/updatedAt are deliberately absent.
const WRITABLE_FIELDS = [
  "name",
  "industry",
  "location",
  "contactPerson",
  "email",
  "phone",
  "securityScore",
  "activeThreats",
];

// phone is optional and the two counters carry schema defaults.
const REQUIRED_TEXT_FIELDS = ["name", "industry", "location", "contactPerson"];

const COUNTER_FIELDS = ["securityScore", "activeThreats"];

// Prisma's unique-constraint code. Surfaced as a controlled 409 rather than
// being allowed to fall through to a 500 with the constraint text attached.
const PRISMA_UNIQUE_VIOLATION = "P2002";

// Audit writes must never turn a successful organization write into an error.
const audit = async (req, event) => {
  try {
    await safeLogAuditEvent({ ...buildAuditContext(req), ...event });
  } catch (err) {
    console.error("Organization audit failed", { name: err && err.name });
  }
};

// Contact details (email, phone, contactPerson) are constituent PII and are
// deliberately excluded from the audit summary — the organization id and name
// are enough to identify the record under investigation.
const organizationSummary = (record) => {
  if (!record || typeof record !== "object") return null;
  return {
    id: record.id,
    name: record.name,
    industry: record.industry,
    securityScore: record.securityScore,
    activeThreats: record.activeThreats,
  };
};

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({
    success: false,
    message: "Server Error",
  });
};

const duplicateEmail = (error) =>
  Boolean(error) && error.code === PRISMA_UNIQUE_VIOLATION;

// Counters are Int columns: a non-numeric or negative value would otherwise
// reach Prisma and come back as a 500 carrying column detail.
function validateCounters(source, invalid) {
  const values = {};

  COUNTER_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(source, field)) return;

    const raw = source[field];
    const parsed = typeof raw === "string" ? Number(raw.trim()) : raw;

    if (
      typeof parsed !== "number" ||
      !Number.isSafeInteger(parsed) ||
      parsed < 0
    ) {
      invalid.push(field);
      return;
    }

    values[field] = parsed;
  });

  return values;
}

// Phase 3 completeness patch — safe bounded organization-options list.
//
// GET /api/organizations is ADMIN-only (manage:system), so an ANALYST could
// not list the registry to bind a new case to an organization. This endpoint
// is gated on manage:cases instead (see organizationRoutes.js, registered
// before the manage:system gate below) and returns only what a case-creation
// picker needs: organizationId, name and sector. No contact detail, no
// counters, no audit data — see optionSummary.
const MAX_ORGANIZATION_OPTIONS_LIMIT = 50;
const DEFAULT_ORGANIZATION_OPTIONS_LIMIT = 25;
const MAX_ORGANIZATION_OPTIONS_SEARCH_LENGTH = 100;

// Returns null on anything that is not a non-negative-bounded integer, so the
// caller can answer 400 rather than silently clamping a malformed value.
function parseBoundedLimit(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_ORGANIZATION_OPTIONS_LIMIT;
  }
  const parsed = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, MAX_ORGANIZATION_OPTIONS_LIMIT);
}

function parseBoundedPage(raw) {
  if (raw === undefined || raw === null || raw === "") return 0;
  const parsed = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

// Only these three fields ever leave this endpoint. Built as a fresh object
// from named fields, never by deleting keys off the Prisma row, so a future
// migration adding a column cannot silently start leaking it here.
function organizationOptionSummary(record) {
  return {
    organizationId: record.id,
    name: record.name,
    sector: record.sector,
  };
}

exports.getOrganizationOptions = async (req, res) => {
  try {
    const query = req.query && typeof req.query === "object" ? req.query : {};

    const limit = parseBoundedLimit(query.limit);
    if (limit === null) {
      return res.status(400).json({
        success: false,
        message: "Invalid limit.",
        fields: ["limit"],
      });
    }

    const page = parseBoundedPage(query.page);
    if (page === null) {
      return res.status(400).json({
        success: false,
        message: "Invalid page.",
        fields: ["page"],
      });
    }

    let search = null;
    if (query.search !== undefined && query.search !== null && query.search !== "") {
      if (typeof query.search !== "string") {
        return res.status(400).json({
          success: false,
          message: "Invalid search.",
          fields: ["search"],
        });
      }
      const trimmed = query.search.trim();
      if (trimmed.length > MAX_ORGANIZATION_OPTIONS_SEARCH_LENGTH) {
        return res.status(400).json({
          success: false,
          message: "Invalid search.",
          fields: ["search"],
        });
      }
      search = trimmed.length > 0 ? trimmed : null;
    }

    const where = search
      ? { name: { contains: search, mode: "insensitive" } }
      : {};

    // Deterministic ordering (name, then id as a stable tiebreaker) so a
    // paginated caller never sees a row shift between pages, and an unknown or
    // empty result is simply an empty array — never a fabricated option.
    const organizations = await prisma.organization.findMany({
      where,
      select: { id: true, name: true, sector: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: page * limit,
      take: limit,
    });

    return res.status(200).json({
      success: true,
      data: organizations.map(organizationOptionSummary),
    });
  } catch (error) {
    return serverError(res, "Failed to fetch organization options", error);
  }
};

// Get all organizations
exports.getOrganizations = async (req, res) => {
  try {
    const organizations = await prisma.organization.findMany({
      orderBy: {
        createdAt: "desc",
      },
    });

    return res.status(200).json({
      success: true,
      data: organizations,
    });
  } catch (error) {
    return serverError(res, "Failed to fetch organizations", error);
  }
};

// Get organization by ID
exports.getOrganizationById = async (req, res) => {
  try {
    const id = parseResourceId(req.params.id);

    if (id === null) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization id.",
      });
    }

    const organization = await prisma.organization.findUnique({
      where: { id },
    });

    if (!organization) {
      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    return res.json({
      success: true,
      data: organization,
    });
  } catch (error) {
    return serverError(res, "Failed to fetch organization", error);
  }
};

// Create organization
exports.createOrganization = async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const values = {};
    const invalid = [];

    REQUIRED_TEXT_FIELDS.forEach((field) => {
      const value = normalizeRequiredString(body[field]);
      if (value === null) {
        invalid.push(field);
        return;
      }
      values[field] = value;
    });

    const email = normalizeEmail(body.email);
    if (email === null || !isValidEmail(email)) {
      invalid.push("email");
    } else {
      values.email = email;
    }

    Object.assign(values, validateCounters(body, invalid));

    if (invalid.length > 0) {
      await audit(req, {
        action: "organization.create",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: ORGANIZATION_ENTITY_TYPE,
        // Field names only — never the submitted values, which include the
        // contact email.
        reason: `Organization creation rejected: invalid or missing fields (${invalid.join(", ")})`,
      });

      return res.status(400).json({
        success: false,
        message: "Missing or invalid fields.",
        fields: invalid,
      });
    }

    const optional = pickDefined(body, ["phone"]);

    const organization = await prisma.organization.create({
      data: { ...optional, ...values },
    });

    await audit(req, {
      action: "organization.create",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: ORGANIZATION_ENTITY_TYPE,
      entityId: organization.id,
      after: organizationSummary(organization),
      reason: "Organization created",
    });

    return res.status(201).json({
      success: true,
      data: organization,
    });
  } catch (error) {
    const conflict = duplicateEmail(error);

    await audit(req, {
      action: "organization.create",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: ORGANIZATION_ENTITY_TYPE,
      reason: conflict
        ? "Organization creation rejected: email already registered"
        : "Organization creation failed while persisting the record",
    });

    if (conflict) {
      return res.status(409).json({
        success: false,
        message: "An organization with that email already exists.",
      });
    }

    return serverError(res, "Failed to create organization", error);
  }
};

// Update organization
exports.updateOrganization = async (req, res) => {
  try {
    const id = parseResourceId(req.params.id);

    if (id === null) {
      await audit(req, {
        action: "organization.update",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: ORGANIZATION_ENTITY_TYPE,
        reason: "Organization update rejected: invalid organization id",
      });

      return res.status(400).json({
        success: false,
        message: "Invalid organization id.",
      });
    }

    const submitted = pickDefined(req.body, WRITABLE_FIELDS);

    if (Object.keys(submitted).length === 0) {
      await audit(req, {
        action: "organization.update",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: ORGANIZATION_ENTITY_TYPE,
        entityId: id,
        reason: "Organization update rejected: no updatable fields supplied",
      });

      return res.status(400).json({
        success: false,
        message: "No updatable fields supplied.",
      });
    }

    const updates = { ...submitted };
    const invalid = [];

    REQUIRED_TEXT_FIELDS.forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(updates, field)) return;

      const value = normalizeRequiredString(updates[field]);
      if (value === null) {
        invalid.push(field);
        return;
      }
      updates[field] = value;
    });

    if (Object.prototype.hasOwnProperty.call(updates, "email")) {
      const email = normalizeEmail(updates.email);
      if (email === null || !isValidEmail(email)) {
        invalid.push("email");
      } else {
        updates.email = email;
      }
    }

    Object.assign(updates, validateCounters(submitted, invalid));

    if (invalid.length > 0) {
      await audit(req, {
        action: "organization.update",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: ORGANIZATION_ENTITY_TYPE,
        entityId: id,
        reason: `Organization update rejected: invalid fields (${invalid.join(", ")})`,
      });

      return res.status(400).json({
        success: false,
        message: "Missing or invalid fields.",
        fields: invalid,
      });
    }

    const existing = await prisma.organization.findUnique({ where: { id } });

    if (!existing) {
      await audit(req, {
        action: "organization.update",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: ORGANIZATION_ENTITY_TYPE,
        entityId: id,
        reason: "Organization update rejected: organization not found",
      });

      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    const beforeSummary = organizationSummary(existing);

    const organization = await prisma.organization.update({
      where: { id },
      data: updates,
    });

    await audit(req, {
      action: "organization.update",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: ORGANIZATION_ENTITY_TYPE,
      entityId: organization.id,
      before: beforeSummary,
      after: organizationSummary(organization),
      reason: "Organization updated",
    });

    return res.json({
      success: true,
      data: organization,
    });
  } catch (error) {
    const conflict = duplicateEmail(error);

    await audit(req, {
      action: "organization.update",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: ORGANIZATION_ENTITY_TYPE,
      reason: conflict
        ? "Organization update rejected: email already registered"
        : "Organization update failed while persisting the record",
    });

    if (conflict) {
      return res.status(409).json({
        success: false,
        message: "An organization with that email already exists.",
      });
    }

    return serverError(res, "Failed to update organization", error);
  }
};

// Delete organization
exports.deleteOrganization = async (req, res) => {
  try {
    const id = parseResourceId(req.params.id);

    if (id === null) {
      await audit(req, {
        action: "organization.delete",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: ORGANIZATION_ENTITY_TYPE,
        reason: "Organization deletion rejected: invalid organization id",
      });

      return res.status(400).json({
        success: false,
        message: "Invalid organization id.",
      });
    }

    const existing = await prisma.organization.findUnique({ where: { id } });

    if (!existing) {
      await audit(req, {
        action: "organization.delete",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: ORGANIZATION_ENTITY_TYPE,
        entityId: id,
        reason: "Organization deletion rejected: organization not found",
      });

      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    const beforeSummary = organizationSummary(existing);

    await prisma.organization.delete({
      where: { id },
    });

    await audit(req, {
      action: "organization.delete",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: ORGANIZATION_ENTITY_TYPE,
      entityId: id,
      before: beforeSummary,
      reason: "Organization deleted",
    });

    return res.json({
      success: true,
      message: "Organization deleted successfully.",
    });
  } catch (error) {
    await audit(req, {
      action: "organization.delete",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: ORGANIZATION_ENTITY_TYPE,
      reason: "Organization deletion failed while removing the record",
    });

    return serverError(res, "Failed to delete organization", error);
  }
};
