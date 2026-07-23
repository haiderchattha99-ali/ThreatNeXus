// Shared Prisma singleton — see the note in caseController.js on why a second
// PrismaClient is not constructed here.
const prisma = require("../config/prisma");

const {
  AUDIT_OUTCOMES,
  buildAuditContext,
  safeLogAuditEvent,
} = require("../services/auditService");

const {
  normalizeRequiredString,
  parseResourceId,
  pickDefined,
} = require("../lib/validation");

const NOTIFICATION_ENTITY_TYPE = "Notification";

// Fields a client may set. id and createdAt are deliberately absent.
const WRITABLE_FIELDS = ["title", "message", "severity", "status", "type"];

// severity/status/type carry schema defaults, so only these two are required.
const REQUIRED_ON_CREATE = ["title", "message"];

// Audit writes must never turn a successful notification write into an error.
const audit = async (req, event) => {
  try {
    await safeLogAuditEvent({ ...buildAuditContext(req), ...event });
  } catch (err) {
    console.error("Notification audit failed", { name: err && err.name });
  }
};

// `message` is deliberately NOT summarised: it is analyst-authored free text
// addressed to a constituent and can contain incident detail. Only the
// classification fields and the title are recorded.
const notificationSummary = (record) => {
  if (!record || typeof record !== "object") return null;
  return {
    id: record.id,
    title: record.title,
    severity: record.severity,
    status: record.status,
    type: record.type,
  };
};

// Fixed client message; the Prisma error text stays server-side.
const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({
    success: false,
    message: "Server Error",
  });
};

// Get all notifications
exports.getNotifications = async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      orderBy: {
        createdAt: "desc",
      },
    });

    return res.status(200).json({
      success: true,
      data: notifications,
    });
  } catch (error) {
    return serverError(res, "Failed to fetch notifications", error);
  }
};

// Get notification by ID
exports.getNotificationById = async (req, res) => {
  try {
    const id = parseResourceId(req.params.id);

    if (id === null) {
      return res.status(400).json({
        success: false,
        message: "Invalid notification id.",
      });
    }

    const notification = await prisma.notification.findUnique({
      where: { id },
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found.",
      });
    }

    return res.json({
      success: true,
      data: notification,
    });
  } catch (error) {
    return serverError(res, "Failed to fetch notification", error);
  }
};

// Create notification
exports.createNotification = async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const values = {};
    const missing = [];

    REQUIRED_ON_CREATE.forEach((field) => {
      const value = normalizeRequiredString(body[field]);
      if (value === null) {
        missing.push(field);
        return;
      }
      values[field] = value;
    });

    if (missing.length > 0) {
      await audit(req, {
        action: "notification.create",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: NOTIFICATION_ENTITY_TYPE,
        reason: `Notification creation rejected: missing required fields (${missing.join(", ")})`,
      });

      return res.status(400).json({
        success: false,
        message: "Missing required fields.",
        fields: missing,
      });
    }

    const optional = pickDefined(body, ["severity", "status", "type"]);

    const notification = await prisma.notification.create({
      data: { ...optional, ...values },
    });

    await audit(req, {
      action: "notification.create",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: NOTIFICATION_ENTITY_TYPE,
      entityId: notification.id,
      after: notificationSummary(notification),
      reason: "Notification created",
    });

    return res.status(201).json({
      success: true,
      data: notification,
    });
  } catch (error) {
    await audit(req, {
      action: "notification.create",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: NOTIFICATION_ENTITY_TYPE,
      reason: "Notification creation failed while persisting the record",
    });

    return serverError(res, "Failed to create notification", error);
  }
};

// Update notification
exports.updateNotification = async (req, res) => {
  try {
    const id = parseResourceId(req.params.id);

    if (id === null) {
      await audit(req, {
        action: "notification.update",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: NOTIFICATION_ENTITY_TYPE,
        reason: "Notification update rejected: invalid notification id",
      });

      return res.status(400).json({
        success: false,
        message: "Invalid notification id.",
      });
    }

    const updates = pickDefined(req.body, WRITABLE_FIELDS);

    if (Object.keys(updates).length === 0) {
      await audit(req, {
        action: "notification.update",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: NOTIFICATION_ENTITY_TYPE,
        entityId: id,
        reason: "Notification update rejected: no updatable fields supplied",
      });

      return res.status(400).json({
        success: false,
        message: "No updatable fields supplied.",
      });
    }

    const blank = REQUIRED_ON_CREATE.filter(
      (field) =>
        Object.prototype.hasOwnProperty.call(updates, field) &&
        normalizeRequiredString(updates[field]) === null
    );

    if (blank.length > 0) {
      await audit(req, {
        action: "notification.update",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: NOTIFICATION_ENTITY_TYPE,
        entityId: id,
        reason: `Notification update rejected: blank required fields (${blank.join(", ")})`,
      });

      return res.status(400).json({
        success: false,
        message: "Required fields cannot be blank.",
        fields: blank,
      });
    }

    const existing = await prisma.notification.findUnique({ where: { id } });

    if (!existing) {
      await audit(req, {
        action: "notification.update",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: NOTIFICATION_ENTITY_TYPE,
        entityId: id,
        reason: "Notification update rejected: notification not found",
      });

      return res.status(404).json({
        success: false,
        message: "Notification not found.",
      });
    }

    const beforeSummary = notificationSummary(existing);

    const notification = await prisma.notification.update({
      where: { id },
      data: updates,
    });

    await audit(req, {
      action: "notification.update",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: NOTIFICATION_ENTITY_TYPE,
      entityId: notification.id,
      before: beforeSummary,
      after: notificationSummary(notification),
      reason: "Notification updated",
    });

    return res.json({
      success: true,
      data: notification,
    });
  } catch (error) {
    await audit(req, {
      action: "notification.update",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: NOTIFICATION_ENTITY_TYPE,
      reason: "Notification update failed while persisting the record",
    });

    return serverError(res, "Failed to update notification", error);
  }
};

// Delete notification
exports.deleteNotification = async (req, res) => {
  try {
    const id = parseResourceId(req.params.id);

    if (id === null) {
      await audit(req, {
        action: "notification.delete",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: NOTIFICATION_ENTITY_TYPE,
        reason: "Notification deletion rejected: invalid notification id",
      });

      return res.status(400).json({
        success: false,
        message: "Invalid notification id.",
      });
    }

    const existing = await prisma.notification.findUnique({ where: { id } });

    if (!existing) {
      await audit(req, {
        action: "notification.delete",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: NOTIFICATION_ENTITY_TYPE,
        entityId: id,
        reason: "Notification deletion rejected: notification not found",
      });

      return res.status(404).json({
        success: false,
        message: "Notification not found.",
      });
    }

    const beforeSummary = notificationSummary(existing);

    await prisma.notification.delete({
      where: { id },
    });

    await audit(req, {
      action: "notification.delete",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: NOTIFICATION_ENTITY_TYPE,
      entityId: id,
      before: beforeSummary,
      reason: "Notification deleted",
    });

    return res.json({
      success: true,
      message: "Notification deleted successfully.",
    });
  } catch (error) {
    await audit(req, {
      action: "notification.delete",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: NOTIFICATION_ENTITY_TYPE,
      reason: "Notification deletion failed while removing the record",
    });

    return serverError(res, "Failed to delete notification", error);
  }
};
