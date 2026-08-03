"use strict";

const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const { getFindings, getFinding } = require("../controllers/findingReadController");

// Phase 6 — the Findings read surface.
//
// Both routes reuse the EXISTING read:findings capability rather than minting a
// new one: reading a Finding is what that grant has always meant, and every
// role already holds it. No new authority is created by this phase.
//
// authenticate must run first — requireCapability reads req.user.
//
// Registration order matters. app.js mounts this router on /api/findings
// alongside the ownership/enrichment/risk/vulnerability/triage routers, all of
// which own "/:id/<something>" paths. "/" and "/:id" declared here match
// neither, so nothing is shadowed in either direction.
router.get("/", authenticate, requireCapability(CAPABILITIES.READ_FINDINGS), getFindings);

router.get("/:id", authenticate, requireCapability(CAPABILITIES.READ_FINDINGS), getFinding);

module.exports = router;
