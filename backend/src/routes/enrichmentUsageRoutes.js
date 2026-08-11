"use strict";

// Phase 10A-1 — GET /api/enrichment/usage.
//
// Operational data about third-party quota policy and Phase-10 reservations,
// so it is gated on the ADMIN-held EXECUTE_ENRICHMENT_BATCH rather than on a
// Finding read: budgets are a deployment concern, not finding evidence.
//
// The response is deliberately explicit that its coverage is PARTIAL and that
// its zeros are structural, not measured — see enrichmentUsageService.js.

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const { getEnrichmentUsage } = require("../controllers/enrichmentOrchestrationController");

router.use(authenticate);

router.get("/usage", requireCapability(CAPABILITIES.EXECUTE_ENRICHMENT_BATCH), getEnrichmentUsage);

module.exports = router;
