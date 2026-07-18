const prisma = require("../config/prisma");
const fs = require("fs");
const csv = require("csv-parser");

const { calculateRiskScore } = require("../services/riskScoringService");
const { detectIOCType } = require("../services/iocValidationService");


// ==============================
// Get All Threats
// ==============================
const getAllThreats = async (req, res) => {

    try {

        const threats = await prisma.threat.findMany({
            orderBy: {
                createdAt: "desc"
            }
        });

        return res.json({
            success: true,
            count: threats.length,
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
            return res.status(404).json({
                success: false,
                message: "Threat not found."
            });
        }

        const updatedThreat = await prisma.threat.update({
            where: {
                id: Number(id)
            },
            data: {
                status
            }
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

// ==============================
// Upload CSV
// ==============================
const uploadThreatCSV = async (req, res) => {

    try {

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "Please upload a CSV file."
            });
        }

        const threats = [];

        fs.createReadStream(req.file.path)
            .pipe(csv())
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

                try {

                    let added = 0;
                    let duplicates = 0;

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

                    fs.unlinkSync(req.file.path);

                    return res.json({
                        success: true,
                        added,
                        duplicates,
                        message: `${added} threat(s) added successfully. ${duplicates} duplicate(s) skipped.`
                    });

                } catch (err) {

                    console.error(err);

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
    updateThreatStatus
};