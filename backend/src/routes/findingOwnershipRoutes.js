"use strict";

// Mounted at /api/findings. Deliberately scoped to ownership-specific
// endpoints only — Phase 2 Finding read APIs beyond ownership are explicitly
// out of scope for this packet.

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const {
  getFindingOwnership,
  applyOverride,
  clearOverride,
} = require("../controllers/findingOwnershipController");

router.use(authenticate);

router.get("/:id/ownership", requireCapability(CAPABILITIES.READ_FINDINGS), getFindingOwnership);
router.put(
  "/:id/ownership/override",
  requireCapability(CAPABILITIES.OVERRIDE_FINDING_OWNERSHIP),
  applyOverride
);
router.delete(
  "/:id/ownership/override",
  requireCapability(CAPABILITIES.OVERRIDE_FINDING_OWNERSHIP),
  clearOverride
);

module.exports = router;
