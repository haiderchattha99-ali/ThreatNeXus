const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Get all organizations
exports.getOrganizations = async (req, res) => {
  try {
    const organizations = await prisma.organization.findMany({
      orderBy: {
        createdAt: "desc",
      },
    });

    res.status(200).json({
      success: true,
      data: organizations,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch organizations.",
    });
  }
};

// Get organization by ID
exports.getOrganizationById = async (req, res) => {
  try {
    const id = Number(req.params.id);

    const organization = await prisma.organization.findUnique({
      where: { id },
    });

    if (!organization) {
      return res.status(404).json({
        success: false,
        message: "Organization not found.",
      });
    }

    res.json({
      success: true,
      data: organization,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Create organization
exports.createOrganization = async (req, res) => {
  try {
    const {
      name,
      industry,
      location,
      contactPerson,
      email,
      phone,
      securityScore,
      activeThreats,
    } = req.body;

    const organization = await prisma.organization.create({
      data: {
        name,
        industry,
        location,
        contactPerson,
        email,
        phone,
        securityScore,
        activeThreats,
      },
    });

    res.status(201).json({
      success: true,
      data: organization,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Update organization
exports.updateOrganization = async (req, res) => {
  try {
    const id = Number(req.params.id);

    const organization = await prisma.organization.update({
      where: { id },
      data: req.body,
    });

    res.json({
      success: true,
      data: organization,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Delete organization
exports.deleteOrganization = async (req, res) => {
  try {
    const id = Number(req.params.id);

    await prisma.organization.delete({
      where: { id },
    });

    res.json({
      success: true,
      message: "Organization deleted successfully.",
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};