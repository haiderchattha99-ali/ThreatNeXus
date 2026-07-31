const express = require("express");
const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { ROLE_CAPABILITIES } = require("../lib/roles");

// capabilities is derived solely from req.user.role (set by authenticate from
// the verified JWT) via ROLE_CAPABILITIES — never from client input. A token
// carrying an unrecognized role resolves req.user.role to null upstream, which
// yields no capabilities here rather than silently granting any. This is the
// session-validation endpoint the frontend calls on init to confirm a stored
// token is still valid and to refresh its (UX-only) capability list; every
// backend route still enforces its own requireCapability/requireRole guard.
router.get("/", authenticate, (req, res) => {
  res.json({
    success: true,
    message: "Welcome to ThreatNeXus",
    loggedInUser: req.user,
    capabilities: ROLE_CAPABILITIES[req.user.role] || [],
  });
});

module.exports = router;