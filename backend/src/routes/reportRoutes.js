"use strict";

const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const cleanupUpload = require("../middleware/cleanupUpload");
const reportUpload = require("../upload/reportUpload");
const { CAPABILITIES } = require("../lib/roles");

const { uploadAccessibleRdpReport } = require("../controllers/reportIngestionController");

// Same secure ordering as threatRoutes.js's /upload: authenticate (populates
// req.user) -> capability check -> cleanupUpload armed -> multer (the only
// middleware that can write a temp file) -> controller. A caller denied by
// either authenticate or requireCapability never reaches multer, so a denied
// request cannot create a temp file at all.
router.post(
  "/upload",
  authenticate,
  requireCapability(CAPABILITIES.INGEST_REPORTS),
  cleanupUpload,
  reportUpload.single("file"),
  uploadAccessibleRdpReport
);

module.exports = router;
