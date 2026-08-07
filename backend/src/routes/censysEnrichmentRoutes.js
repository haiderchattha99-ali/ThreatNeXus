"use strict";

// Finding-scoped Censys exposure enrichment routes (Phase 8B), mounted at
// /api/findings alongside findingEnrichmentRoutes.js. Kept in its own
// file for the same reason findingEnrichmentRoutes.js is separate from
// findingOwnershipRoutes.js — this phase's scope stays visible in the diff.

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { providerRateLimiter } = require("../config/rateLimiters");
const { CAPABILITIES } = require("../lib/roles");

const {
  getCensysEnrichments,
  triggerCensysEnrichment,
} = require("../controllers/censysEnrichmentController");

router.use(authenticate);

// Reads reuse read:findings — the same Finding-read matrix every other
// enrichment read surface already follows.
router.get(
  "/:id/enrichment/censys",
  requireCapability(CAPABILITIES.READ_FINDINGS),
  getCensysEnrichments
);

// Triggering work (and spending Censys quota) is the same narrower grant as
// AbuseIPDB/CVE enrichment: ADMIN + ANALYST only, and it draws on the SAME
// providerRateLimiter budget as every other provider-execution route — a
// caller cannot get a bigger effective budget by switching to this route.
router.post(
  "/:id/enrichment/censys",
  providerRateLimiter,
  requireCapability(CAPABILITIES.TRIGGER_FINDING_ENRICHMENT),
  triggerCensysEnrichment
);

module.exports = router;
