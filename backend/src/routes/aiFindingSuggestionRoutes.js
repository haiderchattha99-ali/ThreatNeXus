"use strict";

// Finding-scoped AI assist routes (Phase 8C), mounted at /api/findings
// alongside censysEnrichmentRoutes.js and findingEnrichmentRoutes.js. Kept in
// its own file for the same reason those are separate — this phase's scope
// stays visible in the diff.
//
// ---------------------------------------------------------------------------
// The capability table, and why each row is what it is
// ---------------------------------------------------------------------------
//   read:ai-finding-suggestions      GET  /:id/ai-suggestions
//        ADMIN, ANALYST, REVIEWER. Not VIEWER — an undecided machine draft is
//        not oversight material, the same policy Phase 5 applies to AI
//        mapping suggestions.
//
//   request:ai-finding-suggestions   POST /:id/ai-suggestions
//        ADMIN and ANALYST — the grant that can cause provider work. Draws on
//        the SAME providerRateLimiter budget every other provider-execution
//        route shares (IOC/CVE/Censys enrichment, AI mapping suggestions).
//
//   review:ai-suggestions            POST /:id/ai-suggestions/:suggestionId/accept
//                                    POST /:id/ai-suggestions/:suggestionId/reject
//        ADMIN and REVIEWER — deliberately NOT ANALYST, so the role that
//        requests a draft can never also accept or reject it. See roles.js's
//        comment on REVIEW_AI_SUGGESTIONS for why this Phase-0 capability,
//        unused until now, fits this decision exactly.

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { providerRateLimiter } = require("../config/rateLimiters");
const { CAPABILITIES } = require("../lib/roles");

const controller = require("../controllers/aiFindingSuggestionController");

router.use(authenticate);

router.get(
  "/:id/ai-suggestions",
  requireCapability(CAPABILITIES.READ_AI_FINDING_SUGGESTIONS),
  controller.listSuggestions
);

router.post(
  "/:id/ai-suggestions",
  providerRateLimiter,
  requireCapability(CAPABILITIES.REQUEST_AI_FINDING_SUGGESTIONS),
  controller.requestSuggestion
);

router.post(
  "/:id/ai-suggestions/:suggestionId/accept",
  requireCapability(CAPABILITIES.REVIEW_AI_SUGGESTIONS),
  controller.acceptSuggestion
);

router.post(
  "/:id/ai-suggestions/:suggestionId/reject",
  requireCapability(CAPABILITIES.REVIEW_AI_SUGGESTIONS),
  controller.rejectSuggestion
);

module.exports = router;
