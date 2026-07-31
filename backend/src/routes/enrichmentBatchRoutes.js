"use strict";

// Administrator bounded IOC enrichment batch execution route (P2-T2e-2),
// mounted at /api/enrichment. ADMIN only: this is the one route in the
// enrichment surface that can spend real provider quota.

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const { runEnrichmentBatch } = require("../controllers/enrichmentBatchController");

router.use(authenticate);

router.post(
  "/batches/run",
  requireCapability(CAPABILITIES.EXECUTE_ENRICHMENT_BATCH),
  runEnrichmentBatch
);

module.exports = router;
