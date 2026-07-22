const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const {
  getNotifications,
  getNotificationById,
  createNotification,
  updateNotification,
  deleteNotification,
} = require("../controllers/notificationController");

// authenticate populates req.user, which requireCapability depends on, so the
// order is required. Applied at router level so a route added later cannot be
// left unguarded by omission.
//
// review:notifications is held by REVIEWER and ADMIN only — ANALYST does the
// work and REVIEWER approves it, and neither inherits the other (see
// lib/roles.js). Notifications are the approval-before-export surface, so
// keeping ANALYST out of them is the separation of duties, not an oversight.
router.use(authenticate, requireCapability(CAPABILITIES.REVIEW_NOTIFICATIONS));

// Get all notifications
router.get("/", getNotifications);

// Get notification by ID
router.get("/:id", getNotificationById);

// Create notification
router.post("/", createNotification);

// Update notification
router.put("/:id", updateNotification);

// Delete notification
router.delete("/:id", deleteNotification);

module.exports = router;
