const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const upload = require("../upload/multer");

const {
  getAllThreats,
  uploadThreatCSV,
} = require("../controllers/threatController");

// Get all threats
router.get("/", authenticate, getAllThreats);

// Upload CSV
router.post(
  "/upload",
  authenticate,
  upload.single("file"),
  uploadThreatCSV
);

module.exports = router;