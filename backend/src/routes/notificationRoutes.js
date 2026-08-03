const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const workflow = require("../controllers/notificationWorkflowController");

// authenticate populates req.user, which requireCapability depends on, so the
// order is required.
//
// ---------------------------------------------------------------------------
// Phase 4 splits read / write / review / export at the ROUTE level
// ---------------------------------------------------------------------------
// Before Phase 4 this router applied requireCapability(REVIEW_NOTIFICATIONS)
// once, at router level, which gated reads and writes together and therefore
// denied ANALYST any access at all — including to the drafting surface Phase 4
// requires them to own. Authentication now stays router-wide while the
// capability moves onto each route, the same split Phase 3 applied to
// /api/cases:
//
//   read:notifications            GET  /            GET  /:id
//                                 GET  /:id/history
//   manage:notifications          POST /                      (draft from case)
//                                 PUT  /:id                   (edit current revision)
//                                 POST /:id/submit
//   review:notifications          POST /:id/approve
//                                 POST /:id/reject
//   export:notifications          GET  /:id/export            (download artifact)
//   record:notification-delivery  POST /:id/deliveries
//   manage:cases                  POST /:id/responses         (Phase 3 service)
//   manage:notifications          DELETE /:id                 (409 tombstone)
//
// ANALYST holds manage/export/delivery but NOT review:notifications, so an
// analyst can draft, edit, submit and export an approved notification and can
// never approve one. REVIEWER holds review:notifications and read but none of
// the write grants, so a reviewer can decide and can never edit, submit,
// export, record a delivery or record a response. VIEWER holds none of these
// and is denied the whole router. That separation is enforced here, by the
// middleware, before any controller or service is reached — a denied request
// creates no rows.
//
// POST /:id/responses is gated on manage:cases rather than a new capability
// because it calls the Phase 3 caseResponseService and writes exactly one
// CaseOrganizationResponse row. The authority to record what an organization
// said is the same authority whether the analyst is looking at the case screen
// or the notification screen, and inventing a second capability for it would
// let the two drift apart.
router.use(authenticate);

const canRead = requireCapability(CAPABILITIES.READ_NOTIFICATIONS);
const canManage = requireCapability(CAPABILITIES.MANAGE_NOTIFICATIONS);
const canReview = requireCapability(CAPABILITIES.REVIEW_NOTIFICATIONS);
const canExport = requireCapability(CAPABILITIES.EXPORT_NOTIFICATIONS);
const canRecordDelivery = requireCapability(CAPABILITIES.RECORD_NOTIFICATION_DELIVERY);
const canRecordResponse = requireCapability(CAPABILITIES.MANAGE_CASES);

// --- Reads -------------------------------------------------------------------
router.get("/", canRead, workflow.listNotifications);

// Registered BEFORE "/:id" so Express does not match "history" or "export" as
// an id. (parseResourceId would reject them with a 400 either way, but relying
// on that would make route order a silent correctness dependency.)
router.get("/:id/history", canRead, workflow.getHistory);
router.get("/:id/export", canExport, workflow.exportNotification);
router.get("/:id", canRead, workflow.getNotification);

// --- Drafting and editing -----------------------------------------------------
router.post("/", canManage, workflow.createDraft);
router.put("/:id", canManage, workflow.editRevision);
router.post("/:id/submit", canManage, workflow.submitForReview);

// --- Reviewer decisions --------------------------------------------------------
router.post("/:id/approve", canReview, workflow.approve);
router.post("/:id/reject", canReview, workflow.reject);

// --- Delivery and organization responses ----------------------------------------
router.post("/:id/deliveries", canRecordDelivery, workflow.recordDelivery);
router.post("/:id/responses", canRecordResponse, workflow.recordOrganizationResponse);

// COMPATIBILITY TOMBSTONE. Always answers 409 and deletes nothing — a
// notification's approval trail, export history and delivery claims are the
// evidence that a constituent was contacted, and no HTTP route may remove
// them. Retained only so a pre-Phase-4 client gets an explicable refusal
// rather than a bare 404 from the router. See the controller.
router.delete("/:id", canManage, workflow.deleteNotification);

module.exports = router;
