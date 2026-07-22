const express = require("express");

const router = express.Router();

const {
  getOrganizations,
  getOrganizationById,
  createOrganization,
  updateOrganization,
  deleteOrganization,
} = require("../controllers/organizationController");

// Get all organizations
router.get("/", getOrganizations);

// Get organization by ID
router.get("/:id", getOrganizationById);

// Create organization
router.post("/", createOrganization);

// Update organization
router.put("/:id", updateOrganization);

// Delete organization
router.delete("/:id", deleteOrganization);

module.exports = router;