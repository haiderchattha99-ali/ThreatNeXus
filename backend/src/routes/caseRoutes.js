const express = require("express");

const router = express.Router();

const authenticate = require("../middleware/authMiddleware");
const { requireCapability } = require("../middleware/requireRole");
const { CAPABILITIES } = require("../lib/roles");

const {
    getCases,
    getCaseById,
    createCase,
    updateCase,
    deleteCase
} = require("../controllers/caseController");

// Same shape as threatRoutes.js: authenticate first (it populates req.user),
// then a capability guard. Nothing under /api/cases is reachable without both.
//
// Reads are gated by manage:cases too, not by read:findings. Case records name
// the affected organization and analyst, which is narrower information than the
// generic threat feed; until there is a reason to widen it, the conservative
// grant is the correct default. ANALYST and ADMIN hold manage:cases.
router.use(authenticate, requireCapability(CAPABILITIES.MANAGE_CASES));

// GET all cases
router.get("/", getCases);

// GET single case
router.get("/:id", getCaseById);

// CREATE case
router.post("/", createCase);

// UPDATE case
router.put("/:id", updateCase);

// DELETE case
router.delete("/:id", deleteCase);

module.exports = router;
