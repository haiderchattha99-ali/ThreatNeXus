"use strict";

// Raw-file identity and existing-RawReport classification for the ingestion
// spine. Deliberately narrow: this module computes/hashes bytes and
// classifies an already-fetched RawReport row by its status. It does not
// implement the HTTP upload route, multer wiring, CSV parsing, or the full
// ingestion transaction — those are later Phase 1 work.
//
// Audit logging: this module has no request/actor context (no `req`), so it
// does not call auditService itself, matching the existing convention where
// low-level lib/service primitives (e.g. fileCleanup.js) don't audit and the
// controller/orchestrator that has actor context does. The future ingestion
// orchestration task is where the RawReport create path gets its AuditLog
// event, using this service's classification as an input.

const crypto = require("crypto");
const { RawReportStatus } = require("@prisma/client");

const PRISMA_UNIQUE_VIOLATION = "P2002";

const CLASSIFICATION = Object.freeze({
  NEW_FILE: "NEW_FILE",
  DUPLICATE_COMPLETED: "DUPLICATE_COMPLETED",
  RETRYABLE_FAILED: "RETRYABLE_FAILED",
  RETRYABLE_RECEIVED: "RETRYABLE_RECEIVED",
  DUPLICATE_IN_PROGRESS: "DUPLICATE_IN_PROGRESS",
});

// Same bytes must always produce the same hash, and only the exact uploaded
// bytes participate — never a filename, and never parsed/normalized CSV
// values. Rejecting a non-Buffer input is a controlled programmer error
// (thrown), not a data-validation failure.
function computeSourceFileSha256(fileBytes) {
  if (!Buffer.isBuffer(fileBytes)) {
    throw new TypeError("computeSourceFileSha256: fileBytes must be a Buffer");
  }
  return crypto.createHash("sha256").update(fileBytes).digest("hex");
}

// Maps a RawReport.status to what re-ingesting the *same* sha256 should do.
//
// COMPLETED / PARTIALLY_VALID / REJECTED all share one property that matters
// here: processing already ran to a terminal, deterministic conclusion for
// these exact bytes, so re-ingesting them again cannot produce a different
// result. REJECTED means the bytes were structurally rejected (not a
// transient failure) — retrying identical bytes would be rejected the same
// way again, so it is classified as a no-op duplicate alongside COMPLETED and
// PARTIALLY_VALID, not as something retryable.
//
// PROCESSING has no approved stale-processing timeout/config anywhere in this
// repository yet, so it is never inferred to be retryable — it is reported as
// its own DUPLICATE_IN_PROGRESS outcome, and staleness policy is left
// explicitly deferred to a future task rather than guessed here.
function classifyRawReportStatus(status) {
  switch (status) {
    case RawReportStatus.COMPLETED:
    case RawReportStatus.PARTIALLY_VALID:
    case RawReportStatus.REJECTED:
      return CLASSIFICATION.DUPLICATE_COMPLETED;
    case RawReportStatus.FAILED:
      return CLASSIFICATION.RETRYABLE_FAILED;
    case RawReportStatus.RECEIVED:
      return CLASSIFICATION.RETRYABLE_RECEIVED;
    case RawReportStatus.PROCESSING:
      return CLASSIFICATION.DUPLICATE_IN_PROGRESS;
    default:
      // An unrecognized status means the enum drifted from this switch — a
      // schema/code mismatch, not a data condition to paper over.
      throw new Error(`classifyRawReportStatus: unrecognized RawReportStatus "${status}"`);
  }
}

// Pure classification given an already-fetched row (or null/undefined for
// "no existing RawReport with this sha256"). No Prisma calls in here.
function classifyExistingRawReport(existingReport) {
  if (existingReport === null || existingReport === undefined) {
    return { classification: CLASSIFICATION.NEW_FILE, existingReport: null };
  }
  if (typeof existingReport !== "object" || typeof existingReport.status !== "string") {
    throw new TypeError(
      "classifyExistingRawReport: existingReport must be a RawReport-shaped object with a status"
    );
  }
  return {
    classification: classifyRawReportStatus(existingReport.status),
    existingReport,
  };
}

function resolveClient(client) {
  if (client) return client;
  // Lazy require mirrors auditService.js: unit tests inject a stub client and
  // never construct the real PrismaClient (no DATABASE_URL/.env needed).
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

// Looks up an existing RawReport by sourceFileSha256 and classifies it.
// Read-only — no writes, so this alone cannot create a duplicate row.
async function resolveRawReportIdentity(fileBytes, options = {}) {
  const client = resolveClient(options.client);
  const sha256 = computeSourceFileSha256(fileBytes);
  const existingReport = await client.rawReport.findUnique({
    where: { sourceFileSha256: sha256 },
  });
  const { classification, existingReport: resolved } = classifyExistingRawReport(existingReport);
  return { sha256, classification, existingReport: resolved };
}

// Reusable, testable P2002-race handler: attempts to create a RawReport, and
// on a unique-constraint conflict (a concurrent upload of the same bytes that
// won the race), reloads and classifies the row that actually exists instead
// of erroring or creating a second row. The database's unique constraint on
// sourceFileSha256 is the final concurrency authority — this function never
// second-guesses it, and never updates/deletes an existing row (raw evidence
// stays immutable). Does not build createData, send an HTTP response, or run
// CSV/ingestion orchestration — the caller supplies createData and owns that.
async function createRawReportRecordOrResolveExisting(createData, options = {}) {
  const client = resolveClient(options.client);

  try {
    const created = await client.rawReport.create({ data: createData });
    return { created: true, rawReport: created, classification: CLASSIFICATION.NEW_FILE };
  } catch (error) {
    if (!error || error.code !== PRISMA_UNIQUE_VIOLATION) {
      throw error;
    }

    const existing = await client.rawReport.findUnique({
      where: { sourceFileSha256: createData.sourceFileSha256 },
    });

    if (!existing) {
      // The unique constraint fired but the row can't be found on reload —
      // an inconsistent state under Restrict/unique semantics. Surfacing the
      // original error is safer than inventing a classification for it.
      throw error;
    }

    const { classification } = classifyExistingRawReport(existing);
    return { created: false, rawReport: existing, classification };
  }
}

module.exports = {
  CLASSIFICATION,
  PRISMA_UNIQUE_VIOLATION,
  computeSourceFileSha256,
  classifyRawReportStatus,
  classifyExistingRawReport,
  resolveRawReportIdentity,
  createRawReportRecordOrResolveExisting,
};
