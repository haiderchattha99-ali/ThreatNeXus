const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const cleanupUpload = require("../middleware/cleanupUpload");
const upload = require("../upload/multer");
const { CAPABILITIES } = require("../lib/roles");

const {
    getAllThreats,
    uploadThreatCSV,
    searchThreats,
    updateThreatStatus,
    deleteThreat
} = require("../controllers/threatController");

// Every route authenticates first, then checks a capability. requireCapability
// depends on req.user, which authenticate populates, so the order is required.

// Reads
router.get(
    "/",
    authenticate,
    requireCapability(CAPABILITIES.READ_FINDINGS),
    getAllThreats
);
router.get(
    "/search",
    authenticate,
    requireCapability(CAPABILITIES.READ_FINDINGS),
    searchThreats
);

// Upload CSV.
//
// Order matters here. cleanupUpload still sits immediately before multer, which
// preserves the T10 invariant: temp-file removal is armed before the only
// middleware that can write a file, so a multer failure that leaves a partial
// upload is still cleaned up.
//
// Authorization runs before both. Because multer is what creates the temp file,
// a caller denied here never causes a file to be written at all — an
// unauthorized upload cannot consume disk, and there is nothing for
// cleanupUpload to have been armed for.
router.post(
    "/upload",
    authenticate,
    requireCapability(CAPABILITIES.INGEST_REPORTS),
    cleanupUpload,
    upload.single("file"),
    uploadThreatCSV
);

// Writes
router.patch(
    "/:id/status",
    authenticate,
    requireCapability(CAPABILITIES.TRIAGE_FINDINGS),
    updateThreatStatus
);
router.delete(
    "/:id",
    authenticate,
    requireCapability(CAPABILITIES.DELETE_RECORDS),
    deleteThreat
);
module.exports = router;
