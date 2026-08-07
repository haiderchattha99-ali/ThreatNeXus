"use strict";

// Finding-scoped GreyNoise noise/reputation enrichment routes (Phase 8D),
// mounted at /api/findings alongside censysEnrichmentRoutes.js. Kept in its
// own file for the same reason censysEnrichmentRoutes.js is — this phase's
// scope stays visible in the diff.

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { providerRateLimiter } = require("../config/rateLimiters");
const { CAPABILITIES } = require("../lib/roles");

const {
  getGreyNoiseEnrichments,
  triggerGreyNoiseEnrichment,
} = require("../controllers/greyNoiseEnrichmentController");

router.use(authenticate);

// Reads reuse read:findings — the same Finding-read matrix every other
// enrichment read surface already follows.
router.get(
  "/:id/enrichment/greynoise",
  requireCapability(CAPABILITIES.READ_FINDINGS),
  getGreyNoiseEnrichments
);

// Triggering work (and spending GreyNoise quota) is the same narrower grant
// as AbuseIPDB/CVE/Censys enrichment: ADMIN + ANALYST only, and it draws on
// the SAME providerRateLimiter budget as every other provider-execution
// route — a caller cannot get a bigger effective budget by switching to this
// route.
router.post(
  "/:id/enrichment/greynoise",
  providerRateLimiter,
  requireCapability(CAPABILITIES.TRIGGER_FINDING_ENRICHMENT),
  triggerGreyNoiseEnrichment
);

module.exports = router;
