const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");

router.get("/", authenticate, (req, res) => {
  res.json({
    success: true,
    message: "Welcome to ThreatNeXus",
    loggedInUser: req.user,
  });
});

module.exports = router;