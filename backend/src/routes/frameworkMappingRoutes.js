"use strict";

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const controller = require("../controllers/frameworkMappingController");

// Phase 5 framework-mapping and AI-assistance surface, mounted under
// /api/cases alongside caseRoutes.js (Express runs routers in registration
// order and a router that matches nothing falls through to the next one).
//
// Mounted SECOND, after caseRoutes, deliberately: caseRoutes owns "/:id" and
// "/:id/workflow", neither of which can match any two-or-more-segment path
// below, so no route here is shadowed and no route here shadows one there.
//
// ---------------------------------------------------------------------------
// The capability table, and why each row is what it is
// ---------------------------------------------------------------------------
//   read:cases                        GET  /:id/framework-mappings
//                                     GET  /:id/framework-mappings/history
//        Reading which controls were associated with a case IS reading the
//        case. All four roles hold read:cases, so VIEWER and REVIEWER see
//        active mappings and full history — serializer-filtered, no internal
//        key, no fingerprint.
//
//   manage:framework-mappings         POST /:id/framework-mappings
//                                     POST /:id/framework-mappings/:mappingId/remove
//        ADMIN and ANALYST only. REVIEWER and VIEWER hold it nowhere, so a
//        mutation from either is refused HERE, by the middleware, before any
//        controller or service is reached — a denied request creates no rows.
//
//   read:ai-mapping-suggestions       GET  /:id/ai/mapping-suggestions
//        ADMIN, ANALYST, REVIEWER. Not VIEWER: an undecided machine proposal
//        is not oversight material.
//
//   request:ai-mapping-suggestions    POST /:id/ai/mapping-suggestions
//        ADMIN and ANALYST — this is the grant that can cause provider work.
//
//   decide:ai-mapping-suggestions     POST /:id/ai/mapping-suggestions/:suggestionId/approve
//                                     POST /:id/ai/mapping-suggestions/:suggestionId/reject
//        ADMIN and ANALYST, the SAME holders as manage:framework-mappings.
//        Approving promotes into a mapping, so approval authority must never
//        exceed the authority to write that mapping by hand.
//
// Creation and REACTIVATION share ONE route on purpose. Re-adding a previously
// removed mapping is a create that happens to find a REMOVED current row; a
// separate reactivate endpoint would be a second place the ATT&CK evidence rule
// and the organization binding could drift apart.
//
// There is no DELETE route anywhere in this file, and no service beneath it can
// hard-delete a mapping. Withdrawal is an appended REMOVED row.
router.use(authenticate);

const canReadCase = requireCapability(CAPABILITIES.READ_CASES);
const canManageMappings = requireCapability(CAPABILITIES.MANAGE_FRAMEWORK_MAPPINGS);
const canReadSuggestions = requireCapability(CAPABILITIES.READ_AI_MAPPING_SUGGESTIONS);
const canRequestSuggestions = requireCapability(CAPABILITIES.REQUEST_AI_MAPPING_SUGGESTIONS);
const canDecideSuggestions = requireCapability(CAPABILITIES.DECIDE_AI_MAPPING_SUGGESTIONS);

// --- Framework mappings ------------------------------------------------------
// "/history" is registered before the bare collection route for the same reason
// caseRoutes registers "/:id/workflow" first: route order must not become a
// silent correctness dependency.
router.get("/:id/framework-mappings/history", canReadCase, controller.listMappingHistory);
router.get("/:id/framework-mappings", canReadCase, controller.listMappings);

router.post("/:id/framework-mappings", canManageMappings, controller.createMapping);
router.post(
  "/:id/framework-mappings/:mappingId/remove",
  canManageMappings,
  controller.removeMapping
);

// --- AI mapping assistance ---------------------------------------------------
router.get("/:id/ai/mapping-suggestions", canReadSuggestions, controller.listSuggestions);
router.post("/:id/ai/mapping-suggestions", canRequestSuggestions, controller.requestSuggestions);
router.post(
  "/:id/ai/mapping-suggestions/:suggestionId/approve",
  canDecideSuggestions,
  controller.approveSuggestion
);
router.post(
  "/:id/ai/mapping-suggestions/:suggestionId/reject",
  canDecideSuggestions,
  controller.rejectSuggestion
);

module.exports = router;
