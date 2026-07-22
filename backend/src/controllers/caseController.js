const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Get all cases
exports.getCases = async (req, res) => {
    try {
        const cases = await prisma.case.findMany({
            orderBy: {
                createdAt: "desc"
            }
        });

        res.status(200).json({
            success: true,
            data: cases
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch cases."
        });
    }
};

// Get one case
exports.getCaseById = async (req, res) => {
    try {

        const id = Number(req.params.id);

        const data = await prisma.case.findUnique({
            where: { id }
        });

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Case not found."
            });
        }

        res.json({
            success: true,
            data
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }
};

// Create case
exports.createCase = async (req, res) => {

    try {

        const {
            title,
            threatType,
            organization,
            priority,
            status,
            analyst,
            description
        } = req.body;

        const data = await prisma.case.create({
            data: {
                title,
                threatType,
                organization,
                priority,
                status,
                analyst,
                description
            }
        });

        res.status(201).json({
            success: true,
            data
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

// Update case
exports.updateCase = async (req, res) => {

    try {

        const id = Number(req.params.id);

        const data = await prisma.case.update({
            where: { id },
            data: req.body
        });

        res.json({
            success: true,
            data
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};

// Delete case
exports.deleteCase = async (req, res) => {

    try {

        const id = Number(req.params.id);

        await prisma.case.delete({
            where: { id }
        });

        res.json({
            success: true,
            message: "Case deleted successfully."
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: error.message
        });

    }

};