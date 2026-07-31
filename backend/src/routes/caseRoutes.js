const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const {
    getCases,
    getCaseById,
    createCase,
    updateCase,
    deleteCase
} = require("../controllers/caseController");

const workflow = require("../controllers/caseWorkflowController");

// Same shape as threatRoutes.js: authenticate first (it populates req.user),
// then a capability guard. Nothing under /api/cases is reachable without both.
//
// ---------------------------------------------------------------------------
// Phase 3 splits reads from writes at the ROUTE level
// ---------------------------------------------------------------------------
// Before Phase 3 this router applied requireCapability(MANAGE_CASES) once, at
// router level, which gated GET and every mutation together and therefore
// denied REVIEWER and VIEWER any access at all. Phase 3 requires a reviewer to
// read a case in order to decide its closure, and requires VIEWER read-only
// oversight, so authentication stays router-wide while the capability moves
// onto each route:
//
//   read:cases                 GET  /            GET  /:id       GET  /:id/workflow
//   manage:cases               POST /            PUT  /:id       DELETE /:id
//                              POST /:id/findings              (link evidence)
//                              POST /:id/findings/:findingId/unlink
//                              POST /:id/state                 (OPEN <-> WAITING_FOR_ORG)
//                              POST /:id/responses             (organization response)
//                              POST /:id/closure-requests      (request closure)
//                              POST /:id/reopen                (explicit manual reopen)
//   review:case-closure        POST /:id/closure-requests/:requestId/approve
//                              POST /:id/closure-requests/:requestId/reject
//
// ANALYST holds manage:cases but NOT review:case-closure, so an analyst can
// request a closure and can never approve one. REVIEWER holds
// review:case-closure but NOT manage:cases, so a reviewer can decide a closure
// and can never triage, link evidence, record a response, change state, or
// reopen. That separation is enforced here, by the middleware, before any
// controller or service is reached — a denied request creates no rows.
router.use(authenticate);

const canRead = requireCapability(CAPABILITIES.READ_CASES);
const canManage = requireCapability(CAPABILITIES.MANAGE_CASES);
const canReviewClosure = requireCapability(CAPABILITIES.REVIEW_CASE_CLOSURE);

// --- Reads ------------------------------------------------------------------
router.get("/", canRead, getCases);

// Registered BEFORE "/:id" so Express does not match "workflow" as an id.
// (parseResourceId would reject it with a 400 either way, but relying on that
// would make route order a silent correctness dependency.)
router.get("/:id/workflow", canRead, workflow.getWorkflow);
router.get("/:id", canRead, getCaseById);

// --- Legacy case record management -----------------------------------------
router.post("/", canManage, createCase);
router.put("/:id", canManage, updateCase);
// COMPATIBILITY TOMBSTONE. Always answers 409 and deletes nothing — legacy or
// workflow-enabled, no Case row can be removed through any production HTTP
// route. Retained only so a pre-Phase-3 client gets an explicable refusal
// rather than a bare 404 from the router. See caseController.deleteCase.
router.delete("/:id", canManage, deleteCase);

// --- Phase 3 workflow mutations ---------------------------------------------
router.post("/:id/findings", canManage, workflow.linkFinding);
router.post("/:id/findings/:findingId/unlink", canManage, workflow.unlinkFinding);
router.post("/:id/state", canManage, workflow.changeState);
router.post("/:id/responses", canManage, workflow.recordResponse);
router.post("/:id/closure-requests", canManage, workflow.requestClosure);
router.post("/:id/reopen", canManage, workflow.reopenCase);

// --- Reviewer decisions ------------------------------------------------------
router.post(
    "/:id/closure-requests/:requestId/approve",
    canReviewClosure,
    workflow.approveClosure
);
router.post(
    "/:id/closure-requests/:requestId/reject",
    canReviewClosure,
    workflow.rejectClosure
);

module.exports = router;
