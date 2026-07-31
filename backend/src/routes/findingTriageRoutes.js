"use strict";

// Finding-triage routes (Phase 3), mounted under /api/findings alongside the
// Phase 2 ownership / enrichment / risk / vulnerability routers.
//
// Reads reuse READ_FINDINGS, which every role holds: seeing that a Finding is
// escalated, and into which case, is part of understanding the Finding, and
// the read path exposes no organization contact detail (see
// caseWorkflowSerializers.js). Writes require TRIAGE_FINDINGS, held by ADMIN
// and ANALYST only — REVIEWER and VIEWER may see a triage decision and never
// make one.

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const { getTriage, updateTriage } = require("../controllers/findingTriageController");

router.use(authenticate);

router.get("/:id/triage", requireCapability(CAPABILITIES.READ_FINDINGS), getTriage);
router.put("/:id/triage", requireCapability(CAPABILITIES.TRIAGE_FINDINGS), updateTriage);

module.exports = router;
