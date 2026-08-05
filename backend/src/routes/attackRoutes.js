"use strict";

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const controller = require("../controllers/frameworkMappingController");

// Phase 6.3 — the ATT&CK surfaces that are NOT scoped to one case.
//
// Mounted at /api/attack rather than under /api/cases because neither endpoint
// is about a case: one serves the pinned catalogue, the other aggregates across
// every case in scope. Hanging them off a case path would have meant inventing
// a case id for a request that has nothing to do with one.
//
// ---------------------------------------------------------------------------
// The capability table, and why each row is what it is
// ---------------------------------------------------------------------------
//   read:cases      GET /api/attack/catalogue
//                   GET /api/attack/navigator
//
//        Both are READS, both behind read:cases — the same grant that already
//        governs "which controls were associated with this case". All four
//        roles hold it, so VIEWER and REVIEWER can read the matrix. That is
//        correct: the navigator shows which techniques the CERT's own evidence
//        supports, which is oversight material, and it is exactly the audience
//        that most needs to see the legacy/needs-review badges rather than a
//        clean-looking summary.
//
//        The catalogue endpoint could arguably need no capability at all — it
//        serves a public MITRE derivative and nothing about any constituent.
//        It is gated anyway, because an unauthenticated endpoint is a
//        permanent commitment and "it happens to be public data today" is a
//        weak reason to make one.
//
// There is NO write route in this file. The navigator changes only as a
// consequence of mappings written through the case-scoped routes, and the
// catalogue changes only when a human re-runs the build script and commits the
// result. Neither is mutable over HTTP, so neither needs an audit event here.
router.use(authenticate);

const canReadCase = requireCapability(CAPABILITIES.READ_CASES);

// The pinned catalogue: tactics in matrix order, mappable techniques, and the
// provenance (version, checksum, upstream source) behind them.
router.get("/catalogue", canReadCase, controller.getAttackCatalogue);

// The navigator read model: the matrix joined with raw counts of what is
// actually mapped. Raw counts only — no coverage percentage is computed here or
// anywhere beneath here. See attackAnalyticsService for why one cannot be.
router.get("/navigator", canReadCase, controller.getAttackNavigator);

module.exports = router;
