const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const cleanupUpload = require("../middleware/cleanupUpload");
const upload = require("../upload/multer");

const {
    getAllThreats,
    uploadThreatCSV,
    searchThreats,
    updateThreatStatus,
    deleteThreat
} = require("../controllers/threatController");

// Get all threats
router.get("/", authenticate, getAllThreats);
router.get("/search", authenticate, searchThreats);
// Upload CSV
// cleanupUpload is mounted before multer so temp-file removal is armed even if
// multer itself rejects the upload.
router.post(
  "/upload",
  authenticate,
  cleanupUpload,
  upload.single("file"),
  uploadThreatCSV
);
router.patch(
    "/:id/status",
    authenticate,
    updateThreatStatus
);
router.delete(
    "/:id",
    authenticate,
    deleteThreat
);
module.exports = router;