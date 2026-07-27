"use strict";

const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const {
  listMappings,
  createMapping,
  updateMapping,
  disableMapping,
} = require("../controllers/assetMappingController");
const { getCoverage } = require("../controllers/findingOwnershipController");

// authenticate first (populates req.user), then a per-route capability guard
// — unlike organizationRoutes.js, this router mixes read and write
// endpoints under one prefix, so a single router.use(requireCapability(...))
// would either over- or under-grant. Reads reuse read:findings (per the
// approved P2-T1 packet: "Ownership reads and coverage: reuse read:findings
// where appropriate"); mutations require manage:ownership-mappings, which
// only ADMIN holds.
router.use(authenticate);

router.get("/coverage", requireCapability(CAPABILITIES.READ_FINDINGS), getCoverage);

router.get("/mappings", requireCapability(CAPABILITIES.READ_FINDINGS), listMappings);
router.post("/mappings", requireCapability(CAPABILITIES.MANAGE_OWNERSHIP_MAPPINGS), createMapping);
router.patch("/mappings/:id", requireCapability(CAPABILITIES.MANAGE_OWNERSHIP_MAPPINGS), updateMapping);
// No hard DELETE for AssetMapping — disable is the only destructive-shaped
// action, and it only ever flips `enabled` to false.
router.post(
  "/mappings/:id/disable",
  requireCapability(CAPABILITIES.MANAGE_OWNERSHIP_MAPPINGS),
  disableMapping
);

module.exports = router;
