const prisma = require("../config/prisma");

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

module.exports = {
    getDashboardStats
};