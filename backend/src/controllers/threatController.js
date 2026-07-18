const prisma = require("../config/prisma");
const fs = require("fs");
const csv = require("csv-parser");

// Get all threats
const getAllThreats = async (req, res) => {
  try {
    const threats = await prisma.threat.findMany({
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json({
      success: true,
      count: threats.length,
      data: threats,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
};

// Upload CSV
const uploadThreatCSV = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a CSV file.",
      });
    }

    const threats = [];

    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on("data", (row) => {
        threats.push({
          ip: row.ip || null,
          domain: row.domain || null,
          hash: row.hash || null,
          severity: row.severity || "Low",
          source: row.source || "CSV",
        });
      })
      .on("end", async () => {
        await prisma.threat.createMany({
          data: threats,
        });

        fs.unlinkSync(req.file.path);

        res.json({
          success: true,
          message: `${threats.length} threats uploaded successfully.`,
        });
      });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
};

module.exports = {
  getAllThreats,
  uploadThreatCSV,
};