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
const { validateReportSource } = require("./reportSourceRegistry");
const { normalizeAccessibleRdpFindingIdentity } = require("../normalization/findingNormalizer");
const { recordFindingObservation } = require("../normalization/dedupService");
const {
  computeSourceFileSha256,
  resolveRawReportIdentity,
  createRawReportRecordOrResolveExisting,
  CLASSIFICATION,
} = require("./reportIdentityService");
const { resolveOneFinding } = require("../ownership/findingOwnershipService");
const { scheduleEnrichment, SCHEDULE_OUTCOME } = require("../enrichment/enrichmentQueueService");
const { INDICATOR_TYPES } = require("../enrichment/iocEnrichmentTypes");
const { EnrichmentCacheKeyError } = require("../enrichment/enrichmentCacheKey");
const { recalculateAfterIngestion } = require("../risk/riskRecalculationService");
const {
  createEnrichmentRun,
} = require("../enrichmentOrchestration/enrichmentRunService");
const {
  resolveOrchestrationConfig,
} = require("../enrichmentOrchestration/enrichmentOrchestrationConfig");
const {
  INGESTION_ENRICHMENT_STATES,
} = require("../enrichmentOrchestration/enrichmentDecisionCodes");
const {
  processRecurrenceReopensSafely,
} = require("../workflow/caseRecurrenceReopenService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");
const env = require("../../config/env");

// P2-T2e-2 — the one provider ingestion ever schedules work for. Never
// user/request-supplied: a report row cannot choose its own enrichment
// provider any more than it can choose its own reportType/schemaVersion (see
// the trusted-source note above).
const ENRICHMENT_PROVIDER = "abuseipdb";

// Phase 10A-1 — the additive `enrichment` upload-response block when
// orchestration is off. Truthful and complete: nothing was recorded, and
// nothing was executed. The four pre-existing response fields (outcome, report,
// findingCounts, enrichmentCounts) are untouched, so every existing consumer is
// unaffected.
//
// `state` is a closed INGESTION_ENRICHMENT_STATES code, never a free string, so
// a consumer can branch on it exhaustively. AUTOMATIC_DISABLED is the default
// deployment's answer.
// The six keys of the binding contract (docs/ai/PHASE-10A1-API-CONTRACT.md),
// and no others. Deliberately absent:
//   enabled            implied by `state` — AUTOMATIC_DISABLED IS "off"
//   runsDeduplicated   an internal convergence detail, not an upload's outcome
//   failedCount        folded into state = PARTIAL, so a consumer branches on
//                      one closed code instead of on a count
//   executed           it is always false and always will be in this milestone;
//                      a field that can only hold one value is documentation
//                      pretending to be data
// Every count describes what THIS upload wrote.
const ENRICHMENT_DISABLED_RESULT = Object.freeze({
  state: INGESTION_ENRICHMENT_STATES.AUTOMATIC_DISABLED,
  runsCreated: 0,
  itemsCreated: 0,
  jobsCreated: 0,
  jobsShared: 0,
  skipped: 0,
});

// Closed classification for one group's scheduling attempt — used only to
// build the report-level aggregate audit payload below, never persisted or
// returned to a caller.
const ENRICHMENT_SCHEDULE_RESULT = Object.freeze({
  SCHEDULED: "SCHEDULED",
  CACHE_HIT: "CACHE_HIT",
  ALREADY_PENDING: "ALREADY_PENDING",
  UNSUPPORTED: "UNSUPPORTED",
  FAILED: "FAILED",
});

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
  if (typeof input.source !== "string" || input.source.trim() === "") {
    // No implicit default here on purpose: the caller (the controller) must
    // decide and pass the server-controlled source explicitly, so a future
    // call site can never forget to consider it.
    throw new TypeError("ingestAccessibleRdpReport: input.source must be a non-empty string");
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

// P2-T1 — local ownership resolution, triggered once per Finding group after
// that group's dedupService transaction has already committed (never inside
// it: findingOwnershipService.resolveOneFinding opens its own separate
// SERIALIZABLE transaction). An ownership failure must never block, fail, or
// roll back ingestion — resolveOneFinding already writes its own
// "ownership.resolution.failed" audit event before rethrowing, so this catch
// exists purely to stop that rethrow from reaching this pipeline's own
// try/catch (which would otherwise misclassify a pure ownership failure as a
// report-level processing failure and mark the whole report FAILED). On
// failure the Finding is simply left at whatever ownership state it already
// had — visibly UNRESOLVED if this was its first observation, since no
// FindingOwnership row is written when resolveOneFinding never completes.
async function resolveOwnershipSafely(client, auditContext, findingId, asn) {
  try {
    await resolveOneFinding(findingId, { client, asn, auditContext });
  } catch (error) {
    console.error("Ownership resolution failed during ingestion", { name: error && error.name });
  }
}

// P2-T2e-2 — schedules durable IOC enrichment work for one Finding group,
// once per distinct Finding identity (never once per duplicate CSV row: this
// is called from the same per-group loop iteration as resolveOwnershipSafely,
// after the group's dedupService transaction has already committed). Mirrors
// resolveOwnershipSafely's isolation contract exactly:
//   - scheduleEnrichment never performs I/O beyond the database (no provider
//     lookup, no HTTP request, no runner execution) — see
//     enrichmentQueueService.js's own module header
//   - a missing AbuseIPDB API key cannot affect this call: scheduling never
//     constructs or resolves a provider, so no key is ever read here
//   - any failure (a validation error, an unexpected database failure) is
//     caught and classified, never rethrown — ingestion must continue
//     regardless of ownership or enrichment outcome
//
// `asOf` is the caller's single explicit ingestion-processing timestamp
// (never a per-row observedAt, never read from the wall clock inside this
// function) — see the module-level ENRICHMENT_SCHEDULE_RESULT note.
async function scheduleEnrichmentSafely(client, indicatorValue, asOf) {
  try {
    const outcome = await scheduleEnrichment(
      {
        provider: ENRICHMENT_PROVIDER,
        indicatorType: INDICATOR_TYPES.IPV4,
        indicator: indicatorValue,
        // The only allow-listed query parameter (P2-T2a's
        // ALLOWED_QUERY_PARAM_KEYS): a normalized maxAgeInDays, sourced from
        // validated config, never from request/report data. Kept identical
        // to the value the batch runner's AbuseIPDBProvider itself defaults
        // to, so an ingestion-scheduled job and a later manually-scheduled
        // job for the same indicator share one cache identity rather than
        // silently fragmenting into two.
        queryParams: { maxAgeInDays: env.ABUSEIPDB_MAX_AGE_DAYS },
      },
      { client, asOf }
    );
    if (outcome.outcome === SCHEDULE_OUTCOME.SCHEDULED) return ENRICHMENT_SCHEDULE_RESULT.SCHEDULED;
    if (outcome.outcome === SCHEDULE_OUTCOME.CACHE_HIT) return ENRICHMENT_SCHEDULE_RESULT.CACHE_HIT;
    return ENRICHMENT_SCHEDULE_RESULT.ALREADY_PENDING;
  } catch (error) {
    if (error instanceof EnrichmentCacheKeyError) {
      console.error("Enrichment scheduling skipped: unsupported indicator", { name: error.name });
      return ENRICHMENT_SCHEDULE_RESULT.UNSUPPORTED;
    }
    console.error("Enrichment scheduling failed during ingestion", { name: error && error.name });
    return ENRICHMENT_SCHEDULE_RESULT.FAILED;
  }
}

// Phase 10A-1 — durable ORCHESTRATION records for the Findings this report
// touched, behind AUTO_ENRICHMENT_ENABLED (default false).
//
// Same isolation contract as resolveOwnershipSafely and
// scheduleEnrichmentSafely above, and for the same reasons:
//   - createEnrichmentRun performs no I/O beyond the database. It never
//     constructs or calls a provider, never reserves quota, never writes a
//     ProviderLookupAttempt or ProviderDailyUsage row, and starts no worker.
//   - a missing API key cannot affect it: the applicability router reads only
//     WHETHER a credential is configured, never the value.
//   - every failure is caught and classified, never rethrown — an ingested
//     report must not be invalidated by an orchestration problem.
//
// With the switch off this function is never called at all, so a deployment
// that upgrades to this milestone and changes nothing else produces exactly
// the records it produced before: the existing IocEnrichment row only, and
// zero Phase-10 rows of any kind.
async function createEnrichmentRunsSafely(client, auditContext, findingIds, rawReportId, asOf) {
  const counts = {
    runsCreated: 0,
    itemsCreated: 0,
    jobsCreated: 0,
    jobsShared: 0,
    skipped: 0,
    failed: 0,
  };

  // eslint-disable-next-line no-restricted-syntax
  for (const findingId of findingIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await createEnrichmentRun(findingId, {
        client,
        trigger: "INGESTION",
        force: false,
        rawReportId,
        now: asOf,
        auditContext,
      });
      // Only a run this call actually inserted. A replay that converged onto an
      // existing run created nothing, and counting it would report work a
      // previous upload had already recorded.
      if (outcome.created) counts.runsCreated += 1;
      // Same rule for every other count: what THIS call wrote, never the run's
      // totals. jobsCreated and jobsShared are tracked separately because they
      // cannot be told apart afterwards — an item holding a job id looks
      // identical whether it inserted that job or attached to a shared one.
      counts.itemsCreated += outcome.itemsCreated;
      counts.jobsCreated += outcome.jobsCreated;
      counts.jobsShared += outcome.jobsShared;
      counts.skipped += outcome.skipped;
    } catch (error) {
      // Never rethrown: an ingested report must not be invalidated by an
      // orchestration problem. Surfaced as state = PARTIAL.
      counts.failed += 1;
      console.error("Enrichment orchestration failed during ingestion", {
        name: error && error.name,
      });
    }
  }

  return counts;
}

// Allow-listed aggregate-only payload for the one enrichment-scheduling audit
// event this report emits — never an indicator, cacheKey, claim token, or
// exception message. Every count is derived from the closed
// ENRICHMENT_SCHEDULE_RESULT tally built while looping over groups, so it can
// never drift from what actually happened.
function enrichmentScheduleSummary(counts, distinctFindingCount) {
  return {
    distinctFindingCount,
    scheduledCount: counts[ENRICHMENT_SCHEDULE_RESULT.SCHEDULED] || 0,
    cacheHitCount: counts[ENRICHMENT_SCHEDULE_RESULT.CACHE_HIT] || 0,
    alreadyPendingCount: counts[ENRICHMENT_SCHEDULE_RESULT.ALREADY_PENDING] || 0,
    unsupportedCount: counts[ENRICHMENT_SCHEDULE_RESULT.UNSUPPORTED] || 0,
    failedCount: counts[ENRICHMENT_SCHEDULE_RESULT.FAILED] || 0,
    provider: ENRICHMENT_PROVIDER,
  };
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
 * @param {{fileBytes: Buffer, source: string, sourceFileName: string,
 *   contentType: string, ingestedByUserId?: number|null}} input - `source`
 *   must be a server-controlled identifier (see reportSourceRegistry.js /
 *   reportIngestionController.js) — never a value taken from the request.
 * @param {{client?: object, auditContext?: object}} [options]
 * @returns {Promise<{outcome: string, report: object|null, reason?: string,
 *   message?: string, findingCounts?: Object<string, number>}>}
 */
async function ingestAccessibleRdpReport(input, options = {}) {
  assertValidInput(input);
  const client = resolveClient(options.client);
  const auditContext = options.auditContext || {};
  const maxDataRows = Number.isInteger(options.maxDataRows) ? options.maxDataRows : env.REPORT_MAX_ROWS;

  // 0. Trusted-source validation (P1-T6a) — runs before structural parsing,
  // row validation, and any RawReport/RawReportRow/Finding/FindingOccurrence
  // access, so an untrusted tuple produces no ingestion evidence or
  // lifecycle mutation whatsoever. reportType/schemaVersion are this
  // pipeline's own fixed values (single report type, single contract
  // version), never taken from the request.
  const sourceValidation = validateReportSource({
    source: input.source,
    reportType: ReportType.ACCESSIBLE_RDP,
    schemaVersion: CONTRACT_VERSION,
  });
  if (!sourceValidation.ok) {
    await audit(client, auditContext, {
      action: "report.ingestion.rejected",
      outcome: AUDIT_OUTCOMES.FAILURE,
      reason: `Report rejected: ${sourceValidation.code}`,
      after: {
        reasonCode: sourceValidation.code,
        requestedReportType: ReportType.ACCESSIBLE_RDP,
        requestedSchemaVersion: CONTRACT_VERSION,
        source: input.source,
      },
    });
    return {
      outcome: INGESTION_OUTCOMES.REJECTED,
      report: null,
      reason: sourceValidation.code,
      message: sourceValidation.message,
    };
  }

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
  // Phase 3 — each entry is {finding, occurrence} rather than the bare Finding
  // it used to hold. The occurrence is required: CaseRecurrenceReopen's
  // idempotency key is (findingOccurrenceId, caseId), so the specific
  // occurrence that caused a reopen is what makes re-processing this report a
  // no-op instead of a second reopen.
  const reopenedFindings = [];
  const enrichmentCounts = {};
  // P2-T3 — distinct Finding ids touched by this report, collected for one
  // bounded risk-scoring pass after all evidence has committed. A Set because
  // the same Finding identity can only appear once per report, but collecting
  // defensively keeps the later rescore idempotent regardless.
  const touchedFindingIds = new Set();
  // Set once the groups are computed inside the try block below; declared
  // here (not `const groups` inside the try) so the success-path audit after
  // the try/catch can still read the count.
  let distinctFindingCount = 0;
  // P2-T2e-2 — one explicit ingestion-processing timestamp, captured once
  // for this whole attempt and reused as every group's `asOf`. Deliberately
  // NOT a per-row/per-group value and NOT derived from any row's own
  // observedAt (see scheduleEnrichmentSafely's header): cache freshness must
  // reflect when this report was actually processed, never when the
  // Shadowserver-style report claims the row was observed.
  const enrichmentAsOf = new Date();

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
    distinctFindingCount = groups.length;

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
        reopenedFindings.push({
          finding: lifecycleResult.finding,
          occurrence: lifecycleResult.occurrence,
        });
      }

      // P2-T1 — local ownership resolution for this Finding, sequential and
      // deterministic within the report, outside dedupService's own
      // transaction (which has already committed by this point). The
      // canonical row's own observed ASN is the only ASN input available —
      // see findingOwnershipService.js's module header for why it is never
      // persisted for later re-resolution.
      // eslint-disable-next-line no-await-in-loop
      await resolveOwnershipSafely(
        client,
        auditContext,
        lifecycleResult.finding.id,
        canonicalRow.validated.normalized ? canonicalRow.validated.normalized.asn : null
      );

      // P2-T2e-2 — durable enrichment scheduling for this Finding group, once
      // per distinct identity (this loop iterates groups, never rows), fully
      // isolated from the lifecycle transaction above exactly like ownership
      // resolution: no provider call, no HTTP request, never rethrown.
      // eslint-disable-next-line no-await-in-loop
      const enrichmentOutcome = await scheduleEnrichmentSafely(
        client,
        lifecycleResult.finding.indicatorValue,
        enrichmentAsOf
      );
      enrichmentCounts[enrichmentOutcome] = (enrichmentCounts[enrichmentOutcome] || 0) + 1;

      // P2-T3 — remember this Finding for the single bounded risk pass that
      // runs after the whole report is processed. Scoring is deliberately NOT
      // done here inside the per-group loop: it must see the ownership and
      // enrichment state this report just produced, and it must never sit
      // between a group's evidence write and the next group's.
      touchedFindingIds.add(lifecycleResult.finding.id);

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

  // 11b. One bounded aggregate enrichment-scheduling audit event per
  // processed report — never one per Finding/group. The per-group scheduling
  // calls above never throw (scheduleEnrichmentSafely catches everything),
  // so reaching `.failed` here means summarizing the already-collected counts
  // itself misbehaved — a defensive branch, not the common path — and even
  // then nothing already committed (RawReport/RawReportRow/Finding/
  // FindingOccurrence, or the report-level audit above) is affected.
  try {
    const summary = enrichmentScheduleSummary(enrichmentCounts, distinctFindingCount);
    await audit(client, auditContext, {
      action: "enrichment.ingestion.schedule.completed",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: "RawReport",
      entityId: finishedReport.id,
      after: summary,
      reason: "IOC enrichment scheduling evaluated for report findings",
    });
  } catch (error) {
    console.error("Enrichment scheduling summary failed", { name: error && error.name });
    await audit(client, auditContext, {
      action: "enrichment.ingestion.schedule.failed",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: "RawReport",
      entityId: finishedReport.id,
      reason: "IOC enrichment scheduling summary could not be computed",
    });
  }

  // 11c. P2-T3 — one bounded, sequential risk-scoring pass over the distinct
  // Findings this report touched, emitting ONE aggregate audit event.
  //
  // Isolation contract, identical to ownership resolution and enrichment
  // scheduling above: every RawReport / RawReportRow / Finding /
  // FindingOccurrence write has already committed, recalculateAfterIngestion
  // never throws (it classifies failures into closed codes internally), and
  // scoring performs no network I/O. A total risk failure therefore leaves a
  // fully valid ingested report with no risk snapshot — never a rolled-back
  // or partially-invalidated one.
  //
  // Idempotent replay is handled by the scoring service itself: re-uploading
  // the identical file produces the identical input fingerprint, which returns
  // UNCHANGED and appends nothing, so duplicate ingestion cannot flood risk
  // history.
  if (touchedFindingIds.size > 0) {
    await recalculateAfterIngestion({
      findingIds: [...touchedFindingIds],
      asOf: enrichmentAsOf,
      client,
      auditContext,
      rawReportId: finishedReport.id,
    });
  }

  // 11c-2. Phase 10A-1 — enrichment orchestration, OFF BY DEFAULT.
  //
  // Runs after risk scoring so the orchestration record reflects the state
  // this report actually produced. Records intent only: no provider is
  // contacted here or anywhere else in this milestone.
  //
  // The switch is resolved from process.env at call time, NOT from env.js's
  // frozen startup snapshot. Two reasons, and the second is the important one:
  //   * enrichmentRunService already resolves the per-provider BUDGETS the same
  //     way on every call, so reading the switch from a different source would
  //     let the two disagree after a configuration change;
  //   * env.js still validates both switches at startup, so a malformed value
  //     is caught there and this read cannot be the first to see a bad one.
  let enrichment = ENRICHMENT_DISABLED_RESULT;
  const autoEnrichmentEnabled =
    resolveOrchestrationConfig(process.env).AUTO_ENRICHMENT_ENABLED;
  if (autoEnrichmentEnabled && touchedFindingIds.size === 0) {
    // Enabled, but this report touched no Finding. Reporting AUTOMATIC_DISABLED
    // here would misstate the deployment's configuration, so it gets its own
    // state rather than borrowing the disabled one.
    enrichment = {
      ...ENRICHMENT_DISABLED_RESULT,
      state: INGESTION_ENRICHMENT_STATES.NO_FINDINGS,
    };
  } else if (autoEnrichmentEnabled) {
    const counts = await createEnrichmentRunsSafely(
      client,
      auditContext,
      [...touchedFindingIds],
      finishedReport.id,
      enrichmentAsOf
    );
    enrichment = {
      // A failure to record orchestration for one Finding is reported as
      // PARTIAL rather than as a count, so a consumer branches on one closed
      // code. Ingestion itself still succeeded either way.
      state:
        counts.failed > 0
          ? INGESTION_ENRICHMENT_STATES.PARTIAL
          : INGESTION_ENRICHMENT_STATES.RECORDED,
      runsCreated: counts.runsCreated,
      itemsCreated: counts.itemsCreated,
      jobsCreated: counts.jobsCreated,
      jobsShared: counts.jobsShared,
      skipped: counts.skipped,
    };

    await audit(client, auditContext, {
      action: "enrichment.orchestration.ingestion.completed",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: "RawReport",
      entityId: finishedReport.id,
      // The audit payload MAY carry more than the public block — failedCount is
      // exactly the sort of operational detail an audit trail is for and a
      // public response is not.
      after: {
        ...enrichment,
        failedCount: counts.failed,
        distinctFindingCount: touchedFindingIds.size,
      },
      reason: "Enrichment orchestration recorded for report findings (no provider contacted)",
    });
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const entry of reopenedFindings) {
    // eslint-disable-next-line no-await-in-loop
    await audit(client, auditContext, {
      action: "finding.reopened",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: "Finding",
      entityId: entry.finding.id,
      after: findingSummary(entry.finding),
      reason: "Finding reopened by a newer observation (recurrence)",
    });
  }

  // 11d. Phase 3 — recurrence-driven case reopening.
  //
  // Runs LAST, after every RawReport / RawReportRow / Finding /
  // FindingOccurrence write has committed, after risk scoring, and outside
  // every transaction this pipeline opened. Same isolation contract as
  // ownership resolution, enrichment scheduling and risk scoring above:
  // processRecurrenceReopensSafely never throws (it classifies every failure
  // into closed outcome codes and audits the aggregate itself), performs no
  // network I/O, and cannot roll back or invalidate the recurrence evidence
  // that triggered it. A total reopen failure leaves a fully valid ingested
  // report with fully valid recurrence evidence and simply no reopen.
  //
  // Idempotent replay: re-uploading the identical file produces the identical
  // FindingOccurrence rows, and CaseRecurrenceReopen's (findingOccurrenceId,
  // caseId) unique means the second pass records ALREADY_PROCESSED and reopens
  // nothing — a closed case cannot be reopened twice by one recurrence.
  if (reopenedFindings.length > 0) {
    await processRecurrenceReopensSafely(
      client,
      reopenedFindings.map((entry) => ({
        findingId: entry.finding.id,
        findingOccurrenceId: entry.occurrence.id,
        observedAt: entry.occurrence.observedAt,
      })),
      { processedAt: enrichmentAsOf, auditContext }
    );
  }

  return {
    outcome: INGESTION_OUTCOMES.PROCESSED,
    report: reportSummary(finishedReport),
    findingCounts,
    enrichmentCounts,
    // Phase 10A-1 — additive only. Every field above is unchanged.
    enrichment,
  };
}

module.exports = {
  INGESTION_OUTCOMES,
  NO_VALID_ROWS_REASON,
  ENRICHMENT_PROVIDER,
  ENRICHMENT_SCHEDULE_RESULT,
  ENRICHMENT_DISABLED_RESULT,
  RowEvidenceIntegrityError,
  resolveOwnershipSafely,
  scheduleEnrichmentSafely,
  createEnrichmentRunsSafely,
  enrichmentScheduleSummary,
  deepEqualJson,
  ingestAccessibleRdpReport,
};
