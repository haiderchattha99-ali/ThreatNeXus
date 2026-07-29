"use strict";

// Mounted at /api/findings. Deliberately scoped to risk-specific endpoints
// only, matching findingOwnershipRoutes.js / findingEnrichmentRoutes.js.
//
// Reading a risk score reuses read:findings — every role that can see a
// finding can see why it was prioritised, which is the point of an explainable
// score. Causing a recalculation needs recalculate:finding-risk (ADMIN and
// ANALYST only), so REVIEWER and VIEWER are denied before the service is ever
// reached.

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const { getFindingRisk, recalculateFindingRisk } = require("../controllers/findingRiskController");

router.use(authenticate);

router.get("/:id/risk", requireCapability(CAPABILITIES.READ_FINDINGS), getFindingRisk);
router.post(
  "/:id/risk/recalculate",
  requireCapability(CAPABILITIES.RECALCULATE_FINDING_RISK),
  recalculateFindingRisk
);

module.exports = router;
