const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const {
    getDashboardStats,
    getDashboardCharts
} = require("../controllers/dashboardController");

// authenticate must run first: requireCapability reads req.user.
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
