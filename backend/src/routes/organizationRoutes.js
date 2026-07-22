const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const {
  getOrganizations,
  getOrganizationById,
  createOrganization,
  updateOrganization,
  deleteOrganization,
} = require("../controllers/organizationController");

// authenticate first (it populates req.user), then the capability guard.
//
// Organizations are the constituent registry — the records that eventually
// decide who a notification is sent to. Editing them is an administrative act,
// so the whole group sits behind manage:system, which only ADMIN holds.
router.use(authenticate, requireCapability(CAPABILITIES.MANAGE_SYSTEM));

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
