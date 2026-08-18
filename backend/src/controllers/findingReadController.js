"use strict";

// Phase 6 — read-only Finding list and detail HTTP surface.
//
// Both handlers are pure reads gated on read:findings by the router. Neither
// writes anything, and neither exposes a provider key, a raw provider payload,
// a claim/lease token or any exception text — the serializer in
// services/findings/findingReadService.js selects an explicit allowlist.

const {
  listFindings,
  getFindingDetail,
  FindingQueryError,
} = require("../services/findings/findingReadService");
const { parseResourceId } = require("../lib/validation");

// This file used to carry its own `Number(raw)` id parser. It is deleted
// rather than patched: a second implementation of "is this a valid id?" is how
// one of them ends up with a bound the other lacks, which is exactly what
// happened — the local copy accepted every integer above the int4 range and
// handed it straight to Prisma. All controllers now share parseResourceId.
const parseId = parseResourceId;

async function getFindings(req, res, next) {
  try {
    const result = await listFindings(req.query);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error instanceof FindingQueryError) {
      // The offending field is named so a caller can fix it. No value is echoed
      // back, so this cannot be turned into a reflection primitive.
      return res
        .status(400)
        .json({ success: false, message: error.message, field: error.field });
    }
    return next(error);
  }
}

async function getFinding(req, res, next) {
  try {
    const id = parseId(req.params.id);
    if (id === null) {
      return res.status(400).json({ success: false, message: "Invalid finding id." });
    }

    const finding = await getFindingDetail(id);
    if (!finding) {
      return res.status(404).json({ success: false, message: "Finding not found." });
    }

    return res.status(200).json({ success: true, data: finding });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getFindings, getFinding };
