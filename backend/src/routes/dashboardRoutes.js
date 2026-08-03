const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const {
    getOperationalOverview,
    getDashboardStats,
    getDashboardCharts
} = require("../controllers/dashboardController");

// authenticate must run first: requireCapability reads req.user.

// Phase 6 — the truthful operational overview. Gated on the SAME existing
// read:dashboard capability as the legacy handlers below: this phase introduces
// no new authority. Sections whose underlying domain the caller may not read
// (notifications for VIEWER, for example) are individually re-checked inside
// the service and returned as RESTRICTED rather than counted.
router.get(
    "/overview",
    authenticate,
    requireCapability(CAPABILITIES.READ_DASHBOARD),
    getOperationalOverview
);

router.get(
    "/stats",
    authenticate,
    requireCapability(CAPABILITIES.READ_DASHBOARD),
    getDashboardStats
);
router.get(
    "/charts",
    authenticate,
    requireCapability(CAPABILITIES.READ_DASHBOARD),
    getDashboardCharts
);
module.exports = router;
