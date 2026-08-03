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

const {
    CaseWorkflowValidationError
} = require("../services/workflow/caseWorkflowRules");
const { createCase: createCaseRecord } =
    require("../services/workflow/caseLifecycleService");
const { listCases, getCaseWorkflow } =
    require("../services/workflow/caseWorkflowReadService");
const { serializeCaseSummary } =
    require("../services/workflow/caseWorkflowSerializers");

const CASE_ENTITY_TYPE = "Case";

// Fields a client may set. Anything else in the body — id, createdAt,
// updatedAt, unknown columns — is dropped rather than forwarded to Prisma.
//
// Phase 3 deliberately does NOT add lifecycleState, caseReference,
// organizationId, closedAt, closureReason, closedByUserId, lastReopenedAt,
// lastReopenTrigger or reopenedCount to this list. The legacy PUT endpoint
// edits the legacy presentation columns only; every Phase 3 column is owned by
// a guarded workflow transition. If lifecycleState were writable here, a PUT
// body could close a case without a closure request or a reviewer, which is
// precisely what Phase 3 exists to prevent. `organizationId` is settable only
// at CREATE (below), because rebinding an existing case to a different
// organization would silently invalidate every CaseFinding link already
// accepted against the original one.
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
//
// Phase 3 routes this through caseWorkflowReadService.listCases instead of a
// bare findMany, so every row crosses the serializer allow-list on its way out
// and the response gains lifecycleState, the organization binding (id, name and
// sector only — never contact details) and a linked-Finding count. This read is
// now gated by read:cases rather than manage:cases, so VIEWER and REVIEWER
// reach it; returning a raw row here would hand them the whole Case record.
exports.getCases = async (req, res) => {
    try {
        const cases = await listCases({ client: prisma });

        return res.status(200).json({
            success: true,
            data: cases
        });

    } catch (error) {
        return serverError(res, "Failed to fetch cases", error);
    }
};

// Get one case
//
// Returns the serialized case plus its full Phase 3 workflow context (linked
// Findings, lifecycle timeline, response timeline, closure history, recurrence
// ledger, permitted actions). `data` keeps every legacy Case field at the top
// level so the existing frontend detail dialog keeps working unchanged, with
// the workflow block added alongside rather than replacing it.
exports.getCaseById = async (req, res) => {
    try {

        const id = parseResourceId(req.params.id);

        if (id === null) {
            return res.status(400).json({
                success: false,
                message: "Invalid case id."
            });
        }

        const record = await prisma.case.findUnique({
            where: { id },
            include: { ownerOrganization: { select: { id: true, name: true, sector: true } } }
        });

        if (!record) {
            return res.status(404).json({
                success: false,
                message: "Case not found."
            });
        }

        const workflow = await getCaseWorkflow(id, { client: prisma });

        return res.json({
            success: true,
            data: { ...serializeCaseSummary(record), workflow }
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

        // Phase 3: organizationId is REQUIRED on every new case.
        //
        // The locked contract states that a case belongs to exactly one
        // Organization. A case with no organization could never accept
        // evidence (the CaseFinding rule compares the Finding's resolved owner
        // against the case's organization) and could never be notified, so
        // creating one would only manufacture dead ends. Legacy rows that
        // predate Phase 3 keep their null binding and stay readable; they are
        // refused by every workflow operation and are not bindable through any
        // endpoint in this milestone.
        //
        // Validated here as a well-formed id, and validated to EXIST inside
        // caseLifecycleService.createCase before the transaction opens.
        const organizationId = parseResourceId(body.organizationId);
        if (organizationId === null) {
            await audit(req, {
                action: "case.create",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: CASE_ENTITY_TYPE,
                reason: "Case creation rejected: missing or invalid organizationId"
            });
            return res.status(400).json({
                success: false,
                message: "Missing required fields.",
                fields: ["organizationId"]
            });
        }

        // Routed through the workflow service rather than a bare prisma create
        // so that EVERY new case receives its server-generated case reference
        // and its CREATED lifecycle event in the same transaction. A case whose
        // timeline began after its creation would be a case whose history could
        // not account for itself. The service writes its own case.created audit
        // event; the legacy case.create event below is kept alongside it so
        // pre-Phase-3 audit consumers see no change.
        const data = await createCaseRecord(
            { ...optional, ...values, organizationId, createdAt: new Date() },
            {
                client: prisma,
                actorUserId: req.user && Number.isInteger(req.user.id) ? req.user.id : null,
                auditContext: buildAuditContext(req)
            }
        );

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
            data: serializeCaseSummary(data)
        });

    } catch (error) {
        await audit(req, {
            action: "case.create",
            outcome: AUDIT_OUTCOMES.FAILURE,
            entityType: CASE_ENTITY_TYPE,
            reason: "Case creation failed while persisting the record"
        });

        if (error instanceof CaseWorkflowValidationError) {
            return res.status(400).json({
                success: false,
                message: "Missing or invalid fields.",
                fields: error.fields
            });
        }

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

// Delete case — COMPATIBILITY TOMBSTONE. Deletes nothing, ever.
//
// The locked Phase 3 contract states: no hard-delete production route. This
// handler is retained ONLY so that a pre-Phase-3 client calling
// DELETE /api/cases/:id receives a controlled, explicable refusal instead of a
// 404 from the router — it does not, and cannot, remove a Case row. There is
// no prisma.case.delete call anywhere in this file, or anywhere else reachable
// from an HTTP route.
//
// Why no case may be hard-deleted, legacy or workflow-enabled:
//
//   - A workflow case IS the defensible record. Its lifecycle timeline, its
//     evidence links, the organization's correspondence and the reviewer's
//     approval are the entire justification for having told a constituent
//     their host was exposed, and for having later declared it resolved.
//     Deleting the case destroys all of it and leaves nothing recording that
//     the case ever existed.
//   - A legacy unbound case is refused for the same reason at one remove: it
//     is still a record that an analyst opened an investigation. "It has no
//     Phase 3 rows yet" is a statement about our schema history, not a reason
//     the record is disposable.
//
// A case that should no longer be worked is CLOSED through the review workflow
// (request -> reviewer approval), which records who decided, when and why.
// That is the supported way to end a case's life, and it is auditable.
//
// 409 rather than 405: the route and method are both real and correctly
// addressed, and 405 would additionally oblige an Allow header enumerating the
// methods this path accepts. The refusal is about the state of the world
// (cases are permanent records), which is what 409 Conflict expresses.
exports.deleteCase = async (req, res) => {

    const id = parseResourceId(req.params.id);

    if (id === null) {
        await audit(req, {
            action: "case.delete",
            outcome: AUDIT_OUTCOMES.DENIED,
            entityType: CASE_ENTITY_TYPE,
            reason: "Case deletion refused: invalid case id"
        });

        return res.status(400).json({
            success: false,
            message: "Invalid case id."
        });
    }

    // Deliberately does NOT look the case up first. Answering 404 for an
    // unknown id and 409 for a known one would turn this endpoint into an
    // existence oracle for any caller holding manage:cases, and the answer is
    // identical either way: nothing will be deleted. One refusal, one shape.
    await audit(req, {
        action: "case.delete",
        outcome: AUDIT_OUTCOMES.DENIED,
        entityType: CASE_ENTITY_TYPE,
        entityId: id,
        reason: "Case deletion refused: cases are permanent records and are never hard-deleted"
    });

    return res.status(409).json({
        success: false,
        message:
            "Cases are permanent records and cannot be deleted. Close the case through the review workflow instead.",
        code: "CASE_DELETION_NOT_SUPPORTED"
    });

};
