"use strict";

const fs = require("fs/promises");

const {
  INGESTION_OUTCOMES,
  ingestAccessibleRdpReport,
} = require("../services/ingestion/reportIngestionService");
const { AUDIT_OUTCOMES, buildAuditContext, safeLogAuditEvent } = require("../services/auditService");

const REPORT_ENTITY_TYPE = "RawReport";

// Fixed, generic messages only, one per outcome — never the parser/validator
// message text, a raw error, a stack trace, or a filesystem path reaches the
// client. Structural rejection reasons are surfaced separately as a safe,
// bounded `reason` code (see below), not as free text from deep in the
// pipeline.
const OUTCOME_RESPONSE = Object.freeze({
  [INGESTION_OUTCOMES.PROCESSED]: { status: 201, message: "Report ingestion completed." },
  [INGESTION_OUTCOMES.DUPLICATE_COMPLETED]: {
    status: 200,
    message: "This exact file has already been ingested.",
  },
  [INGESTION_OUTCOMES.DUPLICATE_IN_PROGRESS]: {
    status: 409,
    message: "This exact file is currently being processed.",
  },
  [INGESTION_OUTCOMES.REJECTED]: { status: 400, message: "The uploaded report was rejected." },
  [INGESTION_OUTCOMES.UNPROCESSABLE_NO_VALID_ROWS]: {
    status: 422,
    message: "The uploaded report contained no valid rows to record.",
  },
  [INGESTION_OUTCOMES.FAILED]: { status: 500, message: "Report processing failed unexpectedly." },
});

const SUCCESS_OUTCOMES = new Set([INGESTION_OUTCOMES.PROCESSED, INGESTION_OUTCOMES.DUPLICATE_COMPLETED]);
const REASON_OUTCOMES = new Set([
  INGESTION_OUTCOMES.REJECTED,
  INGESTION_OUTCOMES.UNPROCESSABLE_NO_VALID_ROWS,
]);

// Thin by design: reads the exact uploaded bytes and hands everything else —
// parsing, validation, identity/idempotency, row evidence, Finding lifecycle,
// audits — to reportIngestionService. cleanupUpload (mounted ahead of
// multer in the route chain) removes the temp file once this response ends,
// on every outcome including an uncaught error, so nothing here unlinks it.
async function uploadAccessibleRdpReport(req, res) {
  if (!req.file) {
    await safeLogAuditEvent({
      ...buildAuditContext(req),
      action: "report.ingestion.rejected",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: REPORT_ENTITY_TYPE,
      reason: "Report upload rejected: no file supplied",
    });

    return res.status(400).json({ success: false, message: "Please upload a CSV file." });
  }

  const fileBytes = await fs.readFile(req.file.path);

  const result = await ingestAccessibleRdpReport(
    {
      fileBytes,
      sourceFileName: req.file.originalname,
      contentType: req.file.mimetype,
      ingestedByUserId: req.user ? req.user.id : null,
    },
    { auditContext: buildAuditContext(req) }
  );

  const { status, message } = OUTCOME_RESPONSE[result.outcome];

  const body = {
    success: SUCCESS_OUTCOMES.has(result.outcome),
    message,
    report: result.report,
  };

  if (result.outcome === INGESTION_OUTCOMES.PROCESSED) {
    body.findingCounts = result.findingCounts;
  }
  if (REASON_OUTCOMES.has(result.outcome)) {
    body.reason = result.reason;
  }

  return res.status(status).json(body);
}

module.exports = { uploadAccessibleRdpReport };
