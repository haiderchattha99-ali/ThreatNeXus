const prisma = require("../config/prisma");
const {
  buildOperationalOverview,
} = require("../services/dashboard/operationalOverviewService");

// Phase 6 — the truthful operational overview.
//
// One bounded, read-only snapshot. Every figure it returns carries its own
// availability, the persisted source it came from, and the single asOf instant
// the whole snapshot was evaluated at. Sections the caller's role may not read
// come back RESTRICTED — never absent, and never zero.
//
// This handler makes NO provider request. Provider status is derived from
// configuration flags and from rows earlier phases already persisted.
//
// getDashboardStats/getDashboardCharts below are the pre-Phase-6 handlers over
// the legacy `Threat` table. They are left in place because the legacy screens
// still call them, and they are NOT what the Phase 6 dashboard reads.
const getOperationalOverview = async (req, res, next) => {
  try {
    const overview = await buildOperationalOverview({
      // The role the authenticated session resolved to. Section gating is done
      // against the same capability table every route guard uses.
      role: req.user && req.user.role,
      asOf: new Date(),
    });

    return res.status(200).json({ success: true, data: overview });
  } catch (error) {
    return next(error);
  }
};

const getDashboardStats = async (req, res) => {

    try {

        const totalThreats = await prisma.threat.count();

        const critical = await prisma.threat.count({
            where: { severity: "Critical" }
        });

        const high = await prisma.threat.count({
            where: { severity: "High" }
        });

        const medium = await prisma.threat.count({
            where: { severity: "Medium" }
        });

        const low = await prisma.threat.count({
            where: { severity: "Low" }
        });

        const ipv4 = await prisma.threat.count({
            where: { iocType: "IPv4" }
        });

        const ipv6 = await prisma.threat.count({
            where: { iocType: "IPv6" }
        });

        const domain = await prisma.threat.count({
            where: { iocType: "Domain" }
        });

        const md5 = await prisma.threat.count({
            where: { iocType: "MD5" }
        });

        const sha1 = await prisma.threat.count({
            where: { iocType: "SHA1" }
        });

        const sha256 = await prisma.threat.count({
            where: { iocType: "SHA256" }
        });

        const newThreats = await prisma.threat.count({
            where: { status: "New" }
        });

        res.json({
            success: true,
            data: {
                totalThreats,
                critical,
                high,
                medium,
                low,

                ipv4,
                ipv6,
                domain,
                md5,
                sha1,
                sha256,

                newThreats
            }
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: "Server Error"
        });

    }

};
const getDashboardCharts = async (req, res) => {

    try {

        const threats = await prisma.threat.findMany();

        const severity = [
            { name: "Critical", value: 0 },
            { name: "High", value: 0 },
            { name: "Medium", value: 0 },
            { name: "Low", value: 0 }
        ];

        const status = {};
        const iocTypes = {};

        threats.forEach((threat) => {

            const sev = severity.find(s => s.name === threat.severity);
            if (sev) sev.value++;

            if (threat.status) {
                status[threat.status] = (status[threat.status] || 0) + 1;
            }

            if (threat.iocType) {
                iocTypes[threat.iocType] = (iocTypes[threat.iocType] || 0) + 1;
            }

        });

        res.json({
            success: true,
            data: {
                severity,
                status: Object.entries(status).map(([name, value]) => ({
                    name,
                    value
                })),
                iocTypes: Object.entries(iocTypes).map(([name, value]) => ({
                    name,
                    value
                }))
            }
        });

    } catch (err) {

        console.error(err);

        res.status(500).json({
            success: false,
            message: "Server Error"
        });

    }

};
module.exports = {
    getOperationalOverview,
    getDashboardStats,
    getDashboardCharts
};