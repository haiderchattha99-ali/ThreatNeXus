// Uses the shared Prisma singleton rather than constructing a second
// PrismaClient: a per-controller client opens its own connection pool, and it
// also bypasses the client injection the test suite relies on.
const prisma = require("../config/prisma");

const {
    AUDIT_OUTCOMES,
    buildAuditContext,
    safeLogAuditEvent
} = require("../services/auditService");

const { normalizeRequiredString, parseResourceId, pickDefined } =
    require("../lib/validation");

const CASE_ENTITY_TYPE = "Case";

// Fields a client may set. Anything else in the body — id, createdAt,
// updatedAt, unknown columns — is dropped rather than forwarded to Prisma.
const WRITABLE_FIELDS = [
    "title",
    "threatType",
    "organization",
    "priority",
    "status",
    "analyst",
    "description"
];

// Required on create. priority/status carry schema defaults and description is
// optional, so they are not listed.
const REQUIRED_ON_CREATE = ["title", "threatType", "organization", "analyst"];

// Audit writes must never turn a successful case write into an error.
// safeLogAuditEvent swallows its own failures; the extra guard covers anything
// thrown before it is reached.
const audit = async (req, event) => {
    try {
        await safeLogAuditEvent({ ...buildAuditContext(req), ...event });
    } catch (err) {
        console.error("Case audit failed", { name: err && err.name });
    }
};

// Only these allow-listed fields ever reach the audit trail. The raw request
// body is never recorded: description is free text that can carry incident
// detail which does not belong in an audit summary.
const caseSummary = (record) => {
    if (!record || typeof record !== "object") return null;
    return {
        id: record.id,
        title: record.title,
        threatType: record.threatType,
        organization: record.organization,
        priority: record.priority,
        status: record.status
    };
};

// Errors are logged by name only and answered with a fixed message — a Prisma
// error message can carry column names, constraint text and fragments of the
// submitted values.
const serverError = (res, label, err) => {
    console.error(label, { name: err && err.name });
    return res.status(500).json({
        success: false,
        message: "Server Error"
    });
};

// Get all cases
exports.getCases = async (req, res) => {
    try {
        const cases = await prisma.case.findMany({
            orderBy: {
                createdAt: "desc"
            }
        });

        return res.status(200).json({
            success: true,
            data: cases
        });

    } catch (error) {
        return serverError(res, "Failed to fetch cases", error);
    }
};

// Get one case
exports.getCaseById = async (req, res) => {
    try {

        const id = parseResourceId(req.params.id);

        if (id === null) {
            return res.status(400).json({
                success: false,
                message: "Invalid case id."
            });
        }

        const data = await prisma.case.findUnique({
            where: { id }
        });

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Case not found."
            });
        }

        return res.json({
            success: true,
            data
        });

    } catch (error) {
        return serverError(res, "Failed to fetch case", error);
    }
};

// Create case
exports.createCase = async (req, res) => {

    try {

        const body = req.body && typeof req.body === "object" ? req.body : {};

        const values = {};
        const missing = [];

        REQUIRED_ON_CREATE.forEach((field) => {
            const value = normalizeRequiredString(body[field]);
            if (value === null) {
                missing.push(field);
                return;
            }
            values[field] = value;
        });

        if (missing.length > 0) {
            // The field names are the client's own submitted keys, not stored
            // data, so echoing them back discloses nothing new.
            await audit(req, {
                action: "case.create",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: CASE_ENTITY_TYPE,
                reason: `Case creation rejected: missing required fields (${missing.join(", ")})`
            });

            return res.status(400).json({
                success: false,
                message: "Missing required fields.",
                fields: missing
            });
        }

        const optional = pickDefined(body, ["priority", "status", "description"]);

        const data = await prisma.case.create({
            data: { ...optional, ...values }
        });

        await audit(req, {
            action: "case.create",
            outcome: AUDIT_OUTCOMES.SUCCESS,
            entityType: CASE_ENTITY_TYPE,
            entityId: data.id,
            after: caseSummary(data),
            reason: "Case created"
        });

        return res.status(201).json({
            success: true,
            data
        });

    } catch (error) {
        await audit(req, {
            action: "case.create",
            outcome: AUDIT_OUTCOMES.FAILURE,
            entityType: CASE_ENTITY_TYPE,
            reason: "Case creation failed while persisting the record"
        });

        return serverError(res, "Failed to create case", error);
    }

};

// Update case
exports.updateCase = async (req, res) => {

    try {

        const id = parseResourceId(req.params.id);

        if (id === null) {
            await audit(req, {
                action: "case.update",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: CASE_ENTITY_TYPE,
                reason: "Case update rejected: invalid case id"
            });

            return res.status(400).json({
                success: false,
                message: "Invalid case id."
            });
        }

        const updates = pickDefined(req.body, WRITABLE_FIELDS);

        if (Object.keys(updates).length === 0) {
            await audit(req, {
                action: "case.update",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: CASE_ENTITY_TYPE,
                entityId: id,
                reason: "Case update rejected: no updatable fields supplied"
            });

            return res.status(400).json({
                success: false,
                message: "No updatable fields supplied."
            });
        }

        // Required columns may be present but blank — an empty title would pass
        // the NOT NULL constraint while leaving the record unusable.
        const blank = REQUIRED_ON_CREATE.filter(
            (field) =>
                Object.prototype.hasOwnProperty.call(updates, field) &&
                normalizeRequiredString(updates[field]) === null
        );

        if (blank.length > 0) {
            await audit(req, {
                action: "case.update",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: CASE_ENTITY_TYPE,
                entityId: id,
                reason: `Case update rejected: blank required fields (${blank.join(", ")})`
            });

            return res.status(400).json({
                success: false,
                message: "Required fields cannot be blank.",
                fields: blank
            });
        }

        const existing = await prisma.case.findUnique({ where: { id } });

        if (!existing) {
            await audit(req, {
                action: "case.update",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: CASE_ENTITY_TYPE,
                entityId: id,
                reason: "Case update rejected: case not found"
            });

            return res.status(404).json({
                success: false,
                message: "Case not found."
            });
        }

        // Snapshotted before the write so "before" cannot be affected by it.
        const beforeSummary = caseSummary(existing);

        const data = await prisma.case.update({
            where: { id },
            data: updates
        });

        await audit(req, {
            action: "case.update",
            outcome: AUDIT_OUTCOMES.SUCCESS,
            entityType: CASE_ENTITY_TYPE,
            entityId: data.id,
            before: beforeSummary,
            after: caseSummary(data),
            reason: "Case updated"
        });

        return res.json({
            success: true,
            data
        });

    } catch (error) {
        await audit(req, {
            action: "case.update",
            outcome: AUDIT_OUTCOMES.FAILURE,
            entityType: CASE_ENTITY_TYPE,
            reason: "Case update failed while persisting the record"
        });

        return serverError(res, "Failed to update case", error);
    }

};

// Delete case
exports.deleteCase = async (req, res) => {

    try {

        const id = parseResourceId(req.params.id);

        if (id === null) {
            await audit(req, {
                action: "case.delete",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: CASE_ENTITY_TYPE,
                reason: "Case deletion rejected: invalid case id"
            });

            return res.status(400).json({
                success: false,
                message: "Invalid case id."
            });
        }

        const existing = await prisma.case.findUnique({ where: { id } });

        if (!existing) {
            await audit(req, {
                action: "case.delete",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: CASE_ENTITY_TYPE,
                entityId: id,
                reason: "Case deletion rejected: case not found"
            });

            return res.status(404).json({
                success: false,
                message: "Case not found."
            });
        }

        // Snapshotted before the row is removed.
        const beforeSummary = caseSummary(existing);

        await prisma.case.delete({
            where: { id }
        });

        await audit(req, {
            action: "case.delete",
            outcome: AUDIT_OUTCOMES.SUCCESS,
            entityType: CASE_ENTITY_TYPE,
            entityId: id,
            before: beforeSummary,
            reason: "Case deleted"
        });

        return res.json({
            success: true,
            message: "Case deleted successfully."
        });

    } catch (error) {
        await audit(req, {
            action: "case.delete",
            outcome: AUDIT_OUTCOMES.FAILURE,
            entityType: CASE_ENTITY_TYPE,
            reason: "Case deletion failed while removing the record"
        });

        return serverError(res, "Failed to delete case", error);
    }

};
