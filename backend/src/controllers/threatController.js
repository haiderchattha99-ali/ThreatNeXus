const prisma = require("../config/prisma");
const fs = require("fs");
const csv = require("csv-parser");

const { calculateRiskScore } = require("../services/riskScoringService");
const { detectIOCType } = require("../services/iocValidationService");

const {
    AUDIT_OUTCOMES,
    buildAuditContext,
    safeLogAuditEvent
} = require("../services/auditService");

const THREAT_ENTITY_TYPE = "Threat";

// Audit writes must never turn a successful threat write into an error.
// safeLogAuditEvent swallows its own failures; the extra guard covers anything
// thrown before it is reached.
const audit = async (req, event) => {
    try {
        await safeLogAuditEvent({ ...buildAuditContext(req), ...event });
    } catch (err) {
        console.error("Threat audit failed", { name: err && err.name });
    }
};

// Only the small allow-listed fields below are ever persisted to the audit
// trail. Raw rows, raw request bodies and uploaded CSV content are never
// recorded — a threat row carries indicator values that do not belong in an
// audit summary.
const threatSummary = (threat) => {
    if (!threat || typeof threat !== "object") return null;
    return {
        id: threat.id,
        status: threat.status,
        severity: threat.severity,
        iocType: threat.iocType
    };
};


// ==============================
// Get All Threats
// ==============================
const getAllThreats = async (req, res) => {
    try {

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const sort = req.query.sort || "createdAt";
        const order = req.query.order === "asc" ? "asc" : "desc";

        const skip = (page - 1) * limit;

        const totalRecords = await prisma.threat.count();

        const threats = await prisma.threat.findMany({
            skip,
            take: limit,
            orderBy: {
                [sort]: order
            }
        });

        const totalPages = Math.ceil(totalRecords / limit);

        return res.json({
            success: true,
            page,
            limit,
            totalRecords,
            totalPages,
            data: threats
        });

    } catch (err) {

        console.error(err);

        return res.status(500).json({
            success: false,
            message: "Server Error"
        });

    }
};
const searchThreats = async (req, res) => {
    try {

        const {
            ip,
            domain,
            hash,
            severity,
            status,
            iocType,
            source
        } = req.query;

        const where = {};

        if (ip) {
            where.ip = {
                contains: ip,
                mode: "insensitive"
            };
        }

        if (domain) {
            where.domain = {
                contains: domain,
                mode: "insensitive"
            };
        }

        if (hash) {
            where.hash = {
                contains: hash,
                mode: "insensitive"
            };
        }

        if (severity) {
            where.severity = severity;
        }

        if (status) {
            where.status = status;
        }

        if (iocType) {
            where.iocType = iocType;
        }

        if (source) {
            where.source = {
                contains: source,
                mode: "insensitive"
            };
        }

        const threats = await prisma.threat.findMany({
            where,
            orderBy: {
                createdAt: "desc"
            }
        });

        res.json({
            success: true,
            total: threats.length,
            data: threats
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: "Server Error"
        });

    }
};
const updateThreatStatus = async (req, res) => {
    try {

        const { id } = req.params;
        const { status } = req.body;

        const validStatuses = [
            "New",
            "Investigating",
            "Mitigated",
            "Resolved",
            "False Positive"
        ];

        if (!validStatuses.includes(status)) {
            await audit(req, {
                action: "threat.update",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: THREAT_ENTITY_TYPE,
                entityId: id,
                reason: "Threat status update rejected: invalid status value"
            });

            return res.status(400).json({
                success: false,
                message: "Invalid status."
            });
        }

        const threat = await prisma.threat.findUnique({
            where: {
                id: Number(id)
            }
        });

        if (!threat) {
            await audit(req, {
                action: "threat.update",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: THREAT_ENTITY_TYPE,
                entityId: id,
                reason: "Threat status update rejected: threat not found"
            });

            return res.status(404).json({
                success: false,
                message: "Threat not found."
            });
        }

        // Snapshotted before the write so the "before" state cannot be
        // affected by the update that follows.
        const beforeSummary = threatSummary(threat);

        const updatedThreat = await prisma.threat.update({
            where: {
                id: Number(id)
            },
            data: {
                status
            }
        });

        await audit(req, {
            action: "threat.update",
            outcome: AUDIT_OUTCOMES.SUCCESS,
            entityType: THREAT_ENTITY_TYPE,
            entityId: updatedThreat.id,
            before: beforeSummary,
            after: threatSummary(updatedThreat),
            reason: "Threat status updated"
        });

        return res.json({
            success: true,
            message: "Threat status updated successfully.",
            data: updatedThreat
        });

    } catch (err) {

        console.error(err);

        return res.status(500).json({
            success: false,
            message: "Server Error"
        });

    }
};
const deleteThreat = async (req, res) => {
    try {

        const { id } = req.params;

        const threat = await prisma.threat.findUnique({
            where: {
                id: Number(id)
            }
        });

        if (!threat) {
            await audit(req, {
                action: "threat.delete",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: THREAT_ENTITY_TYPE,
                entityId: id,
                reason: "Threat deletion rejected: threat not found"
            });

            return res.status(404).json({
                success: false,
                message: "Threat not found."
            });
        }

        // Snapshotted before the row is removed.
        const beforeSummary = threatSummary(threat);
        const deletedId = threat.id;

        await prisma.threat.delete({
            where: {
                id: Number(id)
            }
        });

        await audit(req, {
            action: "threat.delete",
            outcome: AUDIT_OUTCOMES.SUCCESS,
            entityType: THREAT_ENTITY_TYPE,
            entityId: deletedId,
            before: beforeSummary,
            reason: "Threat deleted"
        });

        return res.json({
            success: true,
            message: "Threat deleted successfully."
        });

    } catch (err) {

        console.error(err);

        return res.status(500).json({
            success: false,
            message: "Server Error"
        });

    }
};

// ==============================
// Upload CSV
// ==============================
const uploadThreatCSV = async (req, res) => {

    try {

        if (!req.file) {
            await audit(req, {
                action: "threat.import",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: THREAT_ENTITY_TYPE,
                reason: "CSV import rejected: no file supplied"
            });

            return res.status(400).json({
                success: false,
                message: "Please upload a CSV file."
            });
        }

        const threats = [];

        // The temp file is removed by the cleanupUpload middleware once the
        // response finishes, so every branch below — including the error
        // handlers — is covered without an unlink call of its own.
        const stream = fs.createReadStream(req.file.path).pipe(csv());

        // Without this the stream's "error" event has no listener, so an
        // unreadable or malformed file throws instead of returning a response.
        stream.on("error", async (err) => {
            console.error("CSV parse failed", { name: err && err.name });

            await audit(req, {
                action: "threat.import",
                outcome: AUDIT_OUTCOMES.FAILURE,
                entityType: THREAT_ENTITY_TYPE,
                reason: "CSV import failed: file could not be parsed"
            });

            if (res.headersSent) return;

            return res.status(400).json({
                success: false,
                message: "Could not parse the uploaded CSV file."
            });
        });

        stream
            .on("data", (row) => {

                threats.push({

                    ip: row.ip ? row.ip.trim() : null,
                    domain: row.domain ? row.domain.trim() : null,
                    hash: row.hash ? row.hash.trim() : null,

                    severity: row.severity || "Low",
                    source: row.source || "CSV",

                    riskScore: calculateRiskScore(row.severity),

                    iocType: detectIOCType({
                        ip: row.ip,
                        domain: row.domain,
                        hash: row.hash
                    }),

                    status: "New"

                });

            })

            .on("end", async () => {

                // Declared outside the try so the failure audit below can still
                // report how far the import got.
                let added = 0;
                let duplicates = 0;

                try {

                    for (const threat of threats) {

                        const existing = await prisma.threat.findFirst({
                            where: {
                                ip: threat.ip || null,
                                domain: threat.domain || null,
                                hash: threat.hash || null
                            }
                        });

                        if (existing) {
                            duplicates++;
                            continue;
                        }

                        await prisma.threat.create({
                            data: threat
                        });

                        added++;
                    }

                    await audit(req, {
                        action: "threat.import",
                        outcome: AUDIT_OUTCOMES.SUCCESS,
                        entityType: THREAT_ENTITY_TYPE,
                        // Counts only — never the parsed rows or file contents.
                        after: {
                            rows: threats.length,
                            added,
                            duplicates
                        },
                        reason: "CSV import completed"
                    });

                    return res.json({
                        success: true,
                        added,
                        duplicates,
                        message: `${added} threat(s) added successfully. ${duplicates} duplicate(s) skipped.`
                    });

                } catch (err) {

                    console.error("CSV import failed", { name: err && err.name });

                    await audit(req, {
                        action: "threat.import",
                        outcome: AUDIT_OUTCOMES.FAILURE,
                        entityType: THREAT_ENTITY_TYPE,
                        after: {
                            rows: threats.length,
                            added,
                            duplicates
                        },
                        reason: "CSV import failed while persisting rows"
                    });

                    return res.status(500).json({
                        success: false,
                        message: "Database Error"
                    });

                }

            });

    } catch (err) {

        console.error(err);

        return res.status(500).json({
            success: false,
            message: "Server Error"
        });

    }

};

module.exports = {
    getAllThreats,
    uploadThreatCSV,
    searchThreats,
    updateThreatStatus,
    deleteThreat
};