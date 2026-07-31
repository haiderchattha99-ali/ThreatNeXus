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
  getOrganizationOptions,
} = require("../controllers/organizationController");

// Phase 3 completeness patch — a safe, bounded organization-options list for
// case creation. Registered BEFORE the manage:system gate below so it is
// reachable on its own, narrower capability (manage:cases, held by ADMIN and
// ANALYST) rather than the administrator-only registry grant. REVIEWER and
// VIEWER hold neither manage:cases nor manage:system, so both are denied here
// by requireCapability before this controller (or the organization table) is
// ever reached.
router.get(
  "/options",
  authenticate,
  requireCapability(CAPABILITIES.MANAGE_CASES),
  getOrganizationOptions
);

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
