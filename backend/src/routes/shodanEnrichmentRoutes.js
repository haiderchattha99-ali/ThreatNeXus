"use strict";

// Finding-scoped Shodan exposure enrichment routes (Phase 8E), mounted at
// /api/findings alongside censysEnrichmentRoutes.js/greyNoiseEnrichmentRoutes.js.
// Kept in its own file for the same reason those are separate from
// findingEnrichmentRoutes.js — this phase's scope stays visible in the diff.

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { providerRateLimiter } = require("../config/rateLimiters");
const { CAPABILITIES } = require("../lib/roles");

const {
  getShodanEnrichments,
  triggerShodanEnrichment,
} = require("../controllers/shodanEnrichmentController");

router.use(authenticate);

// Reads reuse read:findings — the same Finding-read matrix every other
// enrichment read surface already follows.
router.get(
  "/:id/enrichment/shodan",
  requireCapability(CAPABILITIES.READ_FINDINGS),
  getShodanEnrichments
);

// Triggering work (and spending Shodan quota) is the same narrower grant as
// AbuseIPDB/Censys/GreyNoise enrichment: ADMIN + ANALYST only, and it draws
// on the SAME providerRateLimiter budget as every other provider-execution
// route — a caller cannot get a bigger effective budget by switching to
// this route.
router.post(
  "/:id/enrichment/shodan",
  providerRateLimiter,
  requireCapability(CAPABILITIES.TRIGGER_FINDING_ENRICHMENT),
  triggerShodanEnrichment
);

module.exports = router;
