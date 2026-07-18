const prisma = require("../config/prisma");
const fs = require("fs");
const csv = require("csv-parser");

const { calculateRiskScore } = require("../services/riskScoringService");
const { detectIOCType } = require("../services/iocValidationService");

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

const uploadThreatCSV = async (req, res) => {

    try {

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "Please upload CSV."
            });
        }

        const threats = [];

        fs.createReadStream(req.file.path)
            .pipe(csv())

            .on("data", (row) => {

                const threat = {

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

                };

                console.log(threat);

                threats.push(threat);

            })

            .on("end", async () => {

                try {

                    for (const threat of threats) {

                        const saved = await prisma.threat.create({
  data: threat,
});

console.log("Saved Record:", saved);
                    }

                    fs.unlinkSync(req.file.path);

                    return res.json({
                        success: true,
                        message: `${threats.length} threats uploaded successfully`
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
    uploadThreatCSV
};