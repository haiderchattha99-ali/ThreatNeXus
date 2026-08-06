"use strict";

// Finding-scoped IOC enrichment routes (P2-T2e-2), mounted at /api/findings
// alongside findingOwnershipRoutes.js. Kept in its own router/file — same
// separation findingOwnershipRoutes.js already draws from ownershipRoutes.js
// — so this packet's scope stays visible in the diff rather than growing an
// existing "ownership-only" file into a general Finding-read surface.

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { providerRateLimiter } = require("../config/rateLimiters");
const { CAPABILITIES } = require("../lib/roles");

const {
  getFindingEnrichments,
  scheduleFindingEnrichment,
} = require("../controllers/findingEnrichmentController");

router.use(authenticate);

// Reads reuse read:findings — ADMIN/ANALYST/REVIEWER/VIEWER all hold it, so
// this endpoint follows the existing Finding-read matrix exactly rather than
// introducing a new capability just for enrichment context.
router.get(
  "/:id/enrichments",
  requireCapability(CAPABILITIES.READ_FINDINGS),
  getFindingEnrichments
);

// Triggering work (and, for a real provider, spending quota) is a narrower
// grant than reading results: ADMIN + ANALYST only.
router.post(
  "/:id/enrichment",
  providerRateLimiter,
  requireCapability(CAPABILITIES.TRIGGER_FINDING_ENRICHMENT),
  scheduleFindingEnrichment
);

module.exports = router;
