"use strict";

// Phase 10A-1 — Finding-scoped enrichment orchestration routes, mounted at
// /api/findings alongside findingEnrichmentRoutes.js.
//
// Kept in its own router/file for the same reason findingEnrichmentRoutes.js
// was split from ownershipRoutes.js: this milestone's surface stays visible in
// the diff instead of growing an existing file into something broader.
//
// ---------------------------------------------------------------------------
// No new capability was introduced
// ---------------------------------------------------------------------------
// Reads reuse READ_FINDINGS and writes reuse TRIGGER_FINDING_ENRICHMENT, so
// this endpoint inherits the EXISTING, already-tested authorization matrix
// exactly. Inventing a Phase-10-specific capability would have created a
// second grant meaning the same thing, and a second thing to get wrong.
//
// providerRateLimiter is applied to run creation even though Phase 10A-1
// contacts no provider: the endpoint's PURPOSE is to request provider work,
// and the limiter must already be in place when 10A-2 makes that real.

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { providerRateLimiter } = require("../config/rateLimiters");
const { CAPABILITIES } = require("../lib/roles");

const {
  createFindingEnrichmentRun,
  getFindingEnrichmentRun,
  getFindingEnrichmentRuns,
} = require("../controllers/enrichmentOrchestrationController");

router.use(authenticate);

// Slash-separated, per the approved v2.1 contract:
//   POST /api/findings/:id/enrichment/runs
//   GET  /api/findings/:id/enrichment/runs
//   GET  /api/findings/:id/enrichment/runs/:runId
//
// These do NOT collide with findingEnrichmentRoutes.js's "/:id/enrichment" and
// "/:id/enrichments": Express matches a route path exactly, so "/1/enrichment"
// and "/1/enrichment/runs" are different routes even though one is a prefix of
// the other.
//
// There is deliberately no "/:id/enrichment-runs" alias. That spelling was
// never released — this surface is unmerged — so keeping it would mean shipping
// a deprecated path that nothing has ever called.

router.get(
  "/:id/enrichment/runs",
  requireCapability(CAPABILITIES.READ_FINDINGS),
  getFindingEnrichmentRuns
);

router.get(
  "/:id/enrichment/runs/:runId",
  requireCapability(CAPABILITIES.READ_FINDINGS),
  getFindingEnrichmentRun
);

router.post(
  "/:id/enrichment/runs",
  providerRateLimiter,
  requireCapability(CAPABILITIES.TRIGGER_FINDING_ENRICHMENT),
  createFindingEnrichmentRun
);

module.exports = router;
