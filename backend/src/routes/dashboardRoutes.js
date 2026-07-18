const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");

const {
    getDashboardStats,
    getDashboardCharts
} = require("../controllers/dashboardController");

router.get("/stats", authenticate, getDashboardStats);
router.get("/charts", authenticate, getDashboardCharts);
module.exports = router;