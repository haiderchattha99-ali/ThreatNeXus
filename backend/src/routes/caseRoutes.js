const express = require("express");

const router = express.Router();

const {
    getCases,
    getCaseById,
    createCase,
    updateCase,
    deleteCase
} = require("../controllers/caseController");

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