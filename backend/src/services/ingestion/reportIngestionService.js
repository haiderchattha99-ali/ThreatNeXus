"use strict";

// End-to-end Accessible-RDP CSV ingestion orchestration (P1-T5). Wires
// together, in order: structural CSV parsing (this package,
// accessibleRdpCsvParser.js) -> per-row validation (P1-T2,
// accessibleRdpRowValidator.js) -> raw-file identity/idempotency
// classification (P1-T3, reportIdentityService.js) -> immutable RawReportRow
// evidence -> Finding identity normalization (findingNormalizer.js) ->
// dedup/persistence/recurrence (P1-T4, dedupService.js) -> aggregate
// AuditLog events.
//
// Deliberately excludes: the HTTP route/controller, multer wiring (both live
// in routes/reportRoutes.js + controllers/reportIngestionController.js),
// finding closure/read endpoints, enrichment, risk scoring, AI, and anything
// framework/ownership-mapping related — none of that exists yet.
//
// ---------------------------------------------------------------------------
// observationDate: an approved, documented design gap (not silently decided)
// ---------------------------------------------------------------------------
// RawReport.observationDate is `TIMESTAMP(3) NOT NULL` with no default. The
// observation-time rule this task is built around is "the earliest VALID row
// observation timestamp in the report" — which has no answer when a report
// produces zero valid rows, either because CSV structure itself is rejected
// (no rows exist at all) or because every row fails row-level validation
// (rows exist, but none has a usable timestamp). Inventing a value (epoch,
// upload time, ingestedAt) was explicitly ruled out.
//
// This was raised to the user as a genuine schema/evidence-integrity
// conflict before writing this file. Approved resolution: for both cases, NO
// RawReport row is created — the upload is rejected with a safe response and
// nothing is persisted. This is a real, documented tradeoff: raw bytes of a
// structurally-rejected or all-invalid upload are not preserved as evidence,
// and re-uploading the same bad bytes is independently rejected each time
// rather than recognised as a duplicate (no RawReport row means no sha256
// row to classify against). See STATUS.md "P1-T5 observationDate gap" for
// the full record; a future task should make the column nullable if evidence
// preservation for rejected uploads becomes a requirement.
//
// Every report that DOES get a RawReport row therefore has parsing and
// validation run to completion first (pure, in-memory, no DB), so the
// correct observationDate is known before the single row that creates it.

const { ReportType, RawReportStatus, RawReportRowStatus } = require("@prisma/client");

const { parseAccessibleRdpCsv } = require("./accessibleRdpCsvParser");
const { validateAccessibleRdpRow, CONTRACT_VERSION } = require("./accessibleRdpRowValidator");
const { normalizeAccessibleRdpFindingIdentity } = require("../normalization/findingNormalizer");
const { recordFindingObservation } = require("../normalization/dedupService");
const {
  computeSourceFileSha256,
  resolveRawReportIdentity,
  createRawReportRecordOrResolveExisting,
  CLASSIFICATION,
} = require("./reportIdentityService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");
const env = require("../../config/env");

const INGESTION_OUTCOMES = Object.freeze({
  REJECTED: "REJECTED",
  UNPROCESSABLE_NO_VALID_ROWS: "UNPROCESSABLE_NO_VALID_ROWS",
  DUPLICATE_COMPLETED: "DUPLICATE_COMPLETED",
  DUPLICATE_IN_PROGRESS: "DUPLICATE_IN_PROGRESS",
  PROCESSED: "PROCESSED",
  FAILED: "FAILED",
});

const NO_VALID_ROWS_REASON = "NO_VALID_ROWS";

class RowEvidenceIntegrityError extends Error {
  constructor(rawReportId, rowNumber) {
    super(`RawReportRow evidence conflict for report ${rawReportId}, row ${rowNumber}`);
    this.name = "RowEvidenceIntegrityError";
  }
}

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

function assertValidInput(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("ingestAccessibleRdpReport: input must be an object");
  }
  if (!Buffer.isBuffer(input.fileBytes)) {
    throw new TypeError("ingestAccessibleRdpReport: input.fileBytes must be a Buffer");
  }
  if (typeof input.sourceFileName !== "string" || input.sourceFileName.trim() === "") {
    throw new TypeError("ingestAccessibleRdpReport: input.sourceFileName must be a non-empty string");
  }
  if (typeof input.contentType !== "string" || input.contentType.trim() === "") {
    throw new TypeError("ingestAccessibleRdpReport: input.contentType must be a non-empty string");
  }
  if (
    input.ingestedByUserId !== null &&
    input.ingestedByUserId !== undefined &&
    !Number.isInteger(input.ingestedByUserId)
  ) {
    throw new TypeError(
      "ingestAccessibleRdpReport: input.ingestedByUserId must be an integer, null, or undefined"
    );
  }
}

// Order-independent equality for JSON-shaped values (objects/arrays/
// primitives). A plain JSON.stringify comparison is NOT safe here: Postgres
// JSONB does not guarantee preserving object key insertion order, so a
// freshly-parsed row and the same row reloaded from RawReportRow.rawPayload
// can be genuinely identical in content but differ in key order.
function deepEqualJson(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqualJson(item, b[index]));
  }
  if (typeof a === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqualJson(a[key], b[key])
    );
  }
  return false;
}

// Creates a RawReportRow if none exists yet for (rawReportId, rowNumber).
// RawReportRow is immutable evidence: if one already exists, its rawPayload
// must match the freshly parsed content exactly (the file's bytes did not
// change between attempts, so the parse cannot legitimately differ) or this
// throws RowEvidenceIntegrityError rather than silently keeping stale
// evidence or overwriting it. Never deletes, never updates an existing row.
async function persistRowIdempotently(client, rawReportId, rowNumber, data) {
  const existing = await client.rawReportRow.findUnique({
    where: { rawReportId_rowNumber: { rawReportId, rowNumber } },
  });

  if (existing) {
    if (!deepEqualJson(existing.rawPayload, data.rawPayload)) {
      throw new RowEvidenceIntegrityError(rawReportId, rowNumber);
    }
    return existing;
  }

  return client.rawReportRow.create({ data: { rawReportId, rowNumber, ...data } });
}

// Read-only pre-flight counterpart to persistRowIdempotently: verifies a row
// number has no *conflicting* existing evidence, without writing anything.
// Used to check every row in a valid-row group before calling
// recordFindingObservation for it, so a Finding/FindingOccurrence is never
// created for a group whose row-linking is already known to fail closed on a
// prior attempt's conflicting evidence — that failure surfaces before any
// lifecycle mutation, not partway through linking it.
async function assertRowEvidenceCompatible(client, rawReportId, rowNumber, freshRawPayload) {
  const existing = await client.rawReportRow.findUnique({
    where: { rawReportId_rowNumber: { rawReportId, rowNumber } },
  });
  if (existing && !deepEqualJson(existing.rawPayload, freshRawPayload)) {
    throw new RowEvidenceIntegrityError(rawReportId, rowNumber);
  }
}

// Deterministic Finding-identity grouping key. Zero-padding the port keeps
// the sort human-intuitive; correctness only requires that the same identity
// always produces the same key, and processing order is otherwise
// independent of both column ordering and CSV row order.
function groupKey(identity) {
  const portKey = String(identity.port).padStart(5, "0");
  return `${identity.indicatorValue}::${portKey}::${identity.protocol}::${identity.reportType}`;
}

// Groups every valid row by exact Finding identity. Grouping — not the
// per-row timestamp — is what determines how many FindingOccurrence rows a
// report can produce: exactly one per distinct identity, however many rows
// share it.
function groupValidRows(normalizedValidRows) {
  const groups = new Map();
  normalizedValidRows.forEach(({ validated, identity }) => {
    const key = groupKey(identity);
    if (!groups.has(key)) {
      groups.set(key, { key, identity, rows: [] });
    }
    groups.get(key).rows.push({
      rowNumber: validated.rowNumber,
      validated,
      observedAt: identity.observedAt,
    });
  });

  // Sorted by identity key so group processing order never depends on CSV
  // row order — same file, same bytes, same processing order every time.
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// Canonical row = the one carrying the maximum observedAt for this identity
// (the "canonical lifecycle timestamp"), tie-broken by the lowest rowNumber
// when two rows share the exact same maximum timestamp. Every other row in
// the group is a within-report duplicate, regardless of its own timestamp.
function pickCanonicalRow(rows) {
  const sorted = [...rows].sort((a, b) => {
    const byTime = b.observedAt.getTime() - a.observedAt.getTime();
    if (byTime !== 0) return byTime;
    return a.rowNumber - b.rowNumber;
  });
  return sorted[0];
}

function reportSummary(rawReport) {
  if (!rawReport) return null;
  return {
    id: rawReport.id,
    reportType: rawReport.reportType,
    schemaVersion: rawReport.schemaVersion,
    status: rawReport.status,
    sourceFileName: rawReport.sourceFileName,
    sourceFileSha256: rawReport.sourceFileSha256,
    totalRows: rawReport.totalRows,
    validRows: rawReport.validRows,
    invalidRows: rawReport.invalidRows,
    processingAttempts: rawReport.processingAttempts,
  };
}

// Only safe, non-authoritative identifiers and counters — never
// closureReason (analyst free text) or anything else beyond what an audit
// summary needs.
function findingSummary(finding) {
  if (!finding) return null;
  return {
    id: finding.id,
    indicatorValue: finding.indicatorValue,
    port: finding.port,
    protocol: finding.protocol,
    reportType: finding.reportType,
    status: finding.status,
    occurrenceCount: finding.occurrenceCount,
    recurrenceCount: finding.recurrenceCount,
  };
}

function buildSafeErrorSummary(error) {
  const isIntegrityConflict = error instanceof RowEvidenceIntegrityError;
  const prismaCode =
    error && typeof error.code === "string" && /^[A-Za-z0-9]{1,10}$/.test(error.code)
      ? error.code
      : null;

  return {
    code: isIntegrityConflict ? "ROW_EVIDENCE_INTEGRITY_CONFLICT" : "PROCESSING_ERROR",
    prismaCode,
    // Fixed, generic messages only — never error.message or a stack trace,
    // which could echo raw evidence or internal details back out.
    message: isIntegrityConflict
      ? "Existing row evidence did not match the current upload's parsed content."
      : "Report processing failed unexpectedly.",
  };
}

// Non-throwing audit wrapper, mirroring the existing controller convention
// (e.g. threatController.js's `audit`): safeLogAuditEvent already swallows
// its own failures, but this is a second guard so a broken/injected logger
// can never turn a successful or already-decided ingestion outcome into an
// unhandled rejection.
async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...auditContext, ...event }, { client });
  } catch (error) {
    console.error("Report ingestion audit failed", { name: error && error.name });
  }
}

// Terminal short-circuit for a classification that means "do not process":
// returns a result object for DUPLICATE_COMPLETED / DUPLICATE_IN_PROGRESS, or
// null when the classification means processing should continue
// (NEW_FILE / RETRYABLE_FAILED / RETRYABLE_RECEIVED).
function terminalResultForClassification(classification, rawReport) {
  if (classification === CLASSIFICATION.DUPLICATE_COMPLETED) {
    return { outcome: INGESTION_OUTCOMES.DUPLICATE_COMPLETED, report: reportSummary(rawReport) };
  }
  if (classification === CLASSIFICATION.DUPLICATE_IN_PROGRESS) {
    return { outcome: INGESTION_OUTCOMES.DUPLICATE_IN_PROGRESS, report: reportSummary(rawReport) };
  }
  return null;
}

/**
 * Runs the full Accessible-RDP CSV ingestion pipeline for one uploaded file.
 * Deterministic and restartable: safe to call again with the exact same
 * bytes after a FAILED or interrupted attempt (RETRYABLE_FAILED /
 * RETRYABLE_RECEIVED), safe to call again with bytes already fully processed
 * (returns the existing report, idempotent, no new evidence or lifecycle
 * mutation).
 *
 * @param {{fileBytes: Buffer, sourceFileName: string, contentType: string,
 *   ingestedByUserId?: number|null}} input
 * @param {{client?: object, auditContext?: object}} [options]
 * @returns {Promise<{outcome: string, report: object|null, reason?: string,
 *   message?: string, findingCounts?: Object<string, number>}>}
 */
async function ingestAccessibleRdpReport(input, options = {}) {
  assertValidInput(input);
  const client = resolveClient(options.client);
  const auditContext = options.auditContext || {};
  const maxDataRows = Number.isInteger(options.maxDataRows) ? options.maxDataRows : env.REPORT_MAX_ROWS;

  // 1. Structural parse (pure, in-memory). No RawReport row for a
  // structural rejection — see the module-level observationDate note.
  const parseResult = parseAccessibleRdpCsv(input.fileBytes, { maxDataRows });
  if (!parseResult.ok) {
    await audit(client, auditContext, {
      action: "report.ingestion.rejected",
      outcome: AUDIT_OUTCOMES.FAILURE,
      reason: `Report rejected: ${parseResult.code} — ${parseResult.message}`,
    });
    return {
      outcome: INGESTION_OUTCOMES.REJECTED,
      report: null,
      reason: parseResult.code,
      message: parseResult.message,
    };
  }

  // 2. Row validation (pure, in-memory, P1-T2). Every row, regardless of
  // outcome, so counts are always known before any DB write.
  const validated = parseResult.rows.map(({ rowNumber, rawRow }) =>
    validateAccessibleRdpRow(rawRow, rowNumber)
  );
  const validRows = validated.filter((row) => row.status === RawReportRowStatus.VALID);
  const invalidRows = validated.filter((row) => row.status === RawReportRowStatus.INVALID);

  if (validRows.length === 0) {
    // Structurally valid CSV, but no row produced a usable observation
    // timestamp — the schema conflict described at the top of this file.
    await audit(client, auditContext, {
      action: "report.ingestion.rejected",
      outcome: AUDIT_OUTCOMES.FAILURE,
      reason: `Report rejected: ${NO_VALID_ROWS_REASON} — no row produced a valid observation timestamp`,
    });
    return {
      outcome: INGESTION_OUTCOMES.UNPROCESSABLE_NO_VALID_ROWS,
      report: null,
      reason: NO_VALID_ROWS_REASON,
      message: "No row in the report validated successfully; nothing to record.",
      totalRows: validated.length,
      invalidRowCount: invalidRows.length,
    };
  }

  // 3. observationDate is now knowable: the earliest valid row observation
  // timestamp in the report (never upload/ingest time).
  const normalizedValidRows = validRows.map((row) => ({
    validated: row,
    identity: normalizeAccessibleRdpFindingIdentity(row),
  }));
  const observationDate = normalizedValidRows.reduce(
    (min, row) => (row.identity.observedAt < min ? row.identity.observedAt : min),
    normalizedValidRows[0].identity.observedAt
  );

  // 4. File identity / idempotency classification (P1-T3).
  const identity = await resolveRawReportIdentity(input.fileBytes, { client });
  const preCheck = terminalResultForClassification(identity.classification, identity.existingReport);
  if (preCheck) return preCheck;

  let rawReport;
  if (identity.classification === CLASSIFICATION.NEW_FILE) {
    const createResult = await createRawReportRecordOrResolveExisting(
      {
        reportType: ReportType.ACCESSIBLE_RDP,
        schemaVersion: CONTRACT_VERSION,
        sourceFileName: input.sourceFileName,
        sourceFileSha256: identity.sha256,
        fileSizeBytes: input.fileBytes.length,
        contentType: input.contentType,
        rawContent: input.fileBytes,
        observationDate,
        ingestedByUserId: input.ingestedByUserId ?? null,
        status: RawReportStatus.RECEIVED,
        totalRows: validated.length,
        validRows: validRows.length,
        invalidRows: invalidRows.length,
      },
      { client }
    );

    const raceResult = terminalResultForClassification(createResult.classification, createResult.rawReport);
    if (raceResult) return raceResult;

    rawReport = createResult.rawReport;
  } else {
    // RETRYABLE_FAILED or RETRYABLE_RECEIVED — reuse the immutable evidence
    // row already on file for these exact bytes. Never a second RawReport
    // for the same sourceFileSha256.
    rawReport = identity.existingReport;
  }

  // 5. Begin (or resume) this processing attempt.
  rawReport = await client.rawReport.update({
    where: { id: rawReport.id },
    data: { status: RawReportStatus.PROCESSING, processingAttempts: { increment: 1 } },
  });

  await audit(client, auditContext, {
    action: "report.ingestion.started",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: "RawReport",
    entityId: rawReport.id,
    after: { status: rawReport.status, processingAttempts: rawReport.processingAttempts },
    reason: "Report ingestion attempt started",
  });

  const findingCounts = {};
  const reopenedFindings = [];

  try {
    // 6. Persist invalid rows — no Finding/FindingOccurrence involvement.
    // Sequential, never parallelized, within one report.
    // eslint-disable-next-line no-restricted-syntax
    for (const row of invalidRows) {
      // eslint-disable-next-line no-await-in-loop
      await persistRowIdempotently(client, rawReport.id, row.rowNumber, {
        rawPayload: row.raw,
        normalizedPayload: row.normalized,
        status: RawReportRowStatus.INVALID,
        validationErrors: row.errors,
        duplicateInReport: false,
        findingOccurrenceId: null,
      });
    }

    // 7-8. Group valid rows by exact Finding identity, process groups
    // sequentially in deterministic order, one dedup-service call per group.
    const groups = groupValidRows(normalizedValidRows);

    // eslint-disable-next-line no-restricted-syntax
    for (const group of groups) {
      const canonicalRow = pickCanonicalRow(group.rows);

      // Pre-flight: every row in this group must be new or match its
      // existing evidence BEFORE the group's Finding/FindingOccurrence is
      // touched at all.
      // eslint-disable-next-line no-restricted-syntax
      for (const rowInGroup of group.rows) {
        // eslint-disable-next-line no-await-in-loop
        await assertRowEvidenceCompatible(
          client,
          rawReport.id,
          rowInGroup.rowNumber,
          rowInGroup.validated.raw
        );
      }

      // eslint-disable-next-line no-await-in-loop
      const lifecycleResult = await recordFindingObservation(
        {
          rawReportId: rawReport.id,
          reportType: group.identity.reportType,
          indicatorValue: group.identity.indicatorValue,
          port: group.identity.port,
          protocol: group.identity.protocol,
          observedAt: canonicalRow.observedAt,
        },
        { client }
      );

      findingCounts[lifecycleResult.action] = (findingCounts[lifecycleResult.action] || 0) + 1;
      if (lifecycleResult.recurrence) {
        reopenedFindings.push(lifecycleResult.finding);
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const rowInGroup of group.rows) {
        // eslint-disable-next-line no-await-in-loop
        await persistRowIdempotently(client, rawReport.id, rowInGroup.rowNumber, {
          rawPayload: rowInGroup.validated.raw,
          normalizedPayload: rowInGroup.validated.normalized,
          status: RawReportRowStatus.VALID,
          validationErrors: null,
          duplicateInReport: rowInGroup !== canonicalRow,
          findingOccurrenceId: lifecycleResult.occurrence.id,
        });
      }
    }
  } catch (error) {
    // Any failure here — a P1-T4 concurrency-retry exhaustion (P2002/P2034),
    // a row-evidence integrity conflict, or any other unexpected
    // filesystem/database/service failure — is a system processing failure,
    // never a per-row validation outcome. Raw evidence and any rows already
    // persisted in this or a prior attempt are left exactly as they are;
    // nothing is deleted or rolled back at the report level, so a later
    // P1-T3-approved retry can continue idempotently.
    const failedReport = await client.rawReport.update({
      where: { id: rawReport.id },
      data: {
        status: RawReportStatus.FAILED,
        totalRows: validated.length,
        validRows: validRows.length,
        invalidRows: invalidRows.length,
        errorSummary: buildSafeErrorSummary(error),
      },
    });

    await audit(client, auditContext, {
      action: "report.ingestion.failed",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: "RawReport",
      entityId: failedReport.id,
      after: reportSummary(failedReport),
      reason: "Report ingestion failed during processing",
    });

    return { outcome: INGESTION_OUTCOMES.FAILED, report: reportSummary(failedReport) };
  }

  // 9-10. Success: compute final counts and the terminal status.
  const finalStatus =
    invalidRows.length === 0 ? RawReportStatus.COMPLETED : RawReportStatus.PARTIALLY_VALID;

  const finishedReport = await client.rawReport.update({
    where: { id: rawReport.id },
    data: {
      status: finalStatus,
      completedAt: new Date(),
      totalRows: validated.length,
      validRows: validRows.length,
      invalidRows: invalidRows.length,
      errorSummary: null,
    },
  });

  // 11. Aggregate audits — one terminal event for the report, plus one
  // finding.reopened per actual RECURRED result (an analyst-visible
  // lifecycle change, not routine per-row/per-occurrence noise).
  await audit(client, auditContext, {
    action:
      finalStatus === RawReportStatus.COMPLETED
        ? "report.ingestion.completed"
        : "report.ingestion.partially_valid",
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: "RawReport",
    entityId: finishedReport.id,
    after: reportSummary(finishedReport),
    reason:
      finalStatus === RawReportStatus.COMPLETED
        ? "Report ingestion completed"
        : "Report ingestion completed with invalid rows",
  });

  // eslint-disable-next-line no-restricted-syntax
  for (const finding of reopenedFindings) {
    // eslint-disable-next-line no-await-in-loop
    await audit(client, auditContext, {
      action: "finding.reopened",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: "Finding",
      entityId: finding.id,
      after: findingSummary(finding),
      reason: "Finding reopened by a newer observation (recurrence)",
    });
  }

  return {
    outcome: INGESTION_OUTCOMES.PROCESSED,
    report: reportSummary(finishedReport),
    findingCounts,
  };
}

module.exports = {
  INGESTION_OUTCOMES,
  NO_VALID_ROWS_REASON,
  RowEvidenceIntegrityError,
  deepEqualJson,
  ingestAccessibleRdpReport,
};
