const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const upload = require("../upload/multer");

const {
    getAllThreats,
    uploadThreatCSV,
    searchThreats,
    updateThreatStatus
} = require("../controllers/threatController");

// Get all threats
router.get("/", authenticate, getAllThreats);
router.get("/search", authenticate, searchThreats);
// Upload CSV
router.post(
  "/upload",
  authenticate,
  upload.single("file"),
  uploadThreatCSV
);
router.patch(
    "/:id/status",
    authenticate,
    updateThreatStatus
);
module.exports = router;