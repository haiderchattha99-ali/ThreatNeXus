const express = require("express");

const router = express.Router();

const {
  getNotifications,
  getNotificationById,
  createNotification,
  updateNotification,
  deleteNotification,
} = require("../controllers/notificationController");

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