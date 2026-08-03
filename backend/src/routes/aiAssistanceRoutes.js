"use strict";

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const controller = require("../controllers/frameworkMappingController");

// Phase 5 AI configuration state, mounted at /api/ai.
//
// Gated on read:cases — held by all four roles — because every role that can
// see a case needs to know whether the assistance panel on it is available.
// The endpoint returns booleans, a provider NAME, a prompt-template version and
// a suggestion cap. It returns no key, no base URL, no timeout and no model
// parameter, because none of those is stored in a form this route can reach.
//
// Deliberately read-only: there is no route anywhere that turns AI on or off.
// AI_ENABLED is an operator/environment decision, and an HTTP toggle would make
// "disabled by default" a runtime state anybody with a session could change.
router.use(authenticate);

router.get("/config", requireCapability(CAPABILITIES.READ_CASES), controller.getAiConfig);

module.exports = router;
