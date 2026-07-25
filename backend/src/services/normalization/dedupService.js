"use strict";

// Deterministic finding normalization -> exact dedup -> persistence /
// recurrence / historical classification -> immutable FindingOccurrence
// evidence, for the Phase 1 ingestion spine (P1-T4). Deliberately narrow:
// this module takes one already-normalized observation (Finding identity +
// observedAt + the RawReport it came from) and resolves it against the
// Finding/FindingOccurrence tables. It does not parse CSV, serve HTTP, or
// decide which report a row belongs to — those are separate (later, or
// already-complete) Phase 1 concerns.
//
// Finding identity is exactly (indicatorValue, port, protocol, reportType) —
// the schema's `finding_identity` composite unique constraint.
//
// ---------------------------------------------------------------------------
// Concurrency strategy (repaired; see STATUS.md "P1-T4 concurrency repair")
// ---------------------------------------------------------------------------
// The whole read-decide-write runs in ONE Prisma interactive transaction at
// SERIALIZABLE isolation. Race recovery happens by re-running the ENTIRE
// transaction from the outside — never by catching a database error and
// continuing to use the transaction that the error just aborted.
//
// This is not a stylistic choice. On PostgreSQL a constraint violation puts
// the surrounding transaction into an aborted state, and every later
// statement on it fails with SQLSTATE 25P02 ("current transaction is aborted,
// commands ignored until end of transaction block"). Prisma surfaces that as
// a PrismaClientUnknownRequestError with `code: undefined`, so an in-
// transaction `catch (P2002) -> re-query` pattern does not merely fail to
// recover, it converts a recoverable race into an opaque error. Verified
// against PostgreSQL 16 with Prisma 6.19.3.
//
// Under SERIALIZABLE, two concurrent transactions that both read and then
// write the same Finding cannot both commit: PostgreSQL rejects the loser
// (surfaced as Prisma P2034) rather than silently applying a stale
// read-modify-write. That is what makes plain reads plus a plain `update`
// safe here, with no version column, no compare-and-swap, no advisory lock
// and no raw SQL. Because every retry re-reads committed state and
// re-classifies from scratch, the lifecycle action is always derived from the
// state that actually won — which is what keeps recurrenceCount at exactly
// one increment per real CLOSED -> OPEN transition.
//
// Audit logging: this module has no request/actor context, so it does not
// call auditService. The result it returns (action, findingCreated,
// idempotent, recurrence, historical) is what a future ingestion-
// orchestration task needs to write aggregate audit events (e.g.
// "finding.reopened") with real actor context.

const {
  FindingStatus,
  FindingOccurrenceAction,
  ReportType,
  TransportProtocol,
} = require("@prisma/client");

// Unique-constraint violation. Retryable *as a whole transaction*: re-running
// from the start makes the row that won the race visible to our own read.
const PRISMA_UNIQUE_VIOLATION = "P2002";
// Write conflict / deadlock — what PostgreSQL serialization failures (40001)
// and deadlocks (40P01) are surfaced as by the installed Prisma client.
const PRISMA_TRANSACTION_CONFLICT = "P2034";

// The only errors this service retries. Anything else — validation errors,
// programmer errors, the data-integrity throw below, connection failures,
// unknown Prisma errors — propagates untouched.
const RETRYABLE_ERROR_CODES = Object.freeze([
  PRISMA_UNIQUE_VIOLATION,
  PRISMA_TRANSACTION_CONFLICT,
]);

const MAX_TRANSACTION_ATTEMPTS = 5;
const TRANSACTION_ISOLATION_LEVEL = "Serializable";

// Derived from the generated Prisma enums rather than hand-written literals,
// so this allow-list cannot drift from the schema.
const SUPPORTED_REPORT_TYPES = Object.freeze(Object.values(ReportType));
const SUPPORTED_PROTOCOLS = Object.freeze(Object.values(TransportProtocol));

// Retried only when the code is one this service knows how to resolve by
// re-running the whole transaction. Note this deliberately does NOT match a
// PrismaClientUnknownRequestError (code undefined) — that is the signature of
// a genuinely broken transaction, not a resolvable race.
function isRetryableConcurrencyError(error) {
  return Boolean(error) && RETRYABLE_ERROR_CODES.includes(error.code);
}

function resolveClient(client) {
  if (client) return client;
  // Lazy require mirrors reportIdentityService.js: unit tests inject a stub
  // client and never construct the real PrismaClient (no DATABASE_URL/.env
  // needed).
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

function assertValidInput(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("recordFindingObservation: input must be an object");
  }
  if (!Number.isInteger(input.rawReportId) || input.rawReportId < 1) {
    throw new TypeError("recordFindingObservation: rawReportId must be a positive integer");
  }
  // Enum membership, checked before Prisma is touched, so an out-of-contract
  // value is a controlled programmer error here rather than a database enum
  // error several layers down.
  if (!SUPPORTED_REPORT_TYPES.includes(input.reportType)) {
    throw new TypeError(
      `recordFindingObservation: reportType must be one of ${SUPPORTED_REPORT_TYPES.join(", ")}`
    );
  }
  if (!SUPPORTED_PROTOCOLS.includes(input.protocol)) {
    throw new TypeError(
      `recordFindingObservation: protocol must be one of ${SUPPORTED_PROTOCOLS.join(", ")}`
    );
  }
  if (typeof input.indicatorValue !== "string" || input.indicatorValue === "") {
    throw new TypeError("recordFindingObservation: indicatorValue must be a non-empty string");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new TypeError("recordFindingObservation: port must be an integer between 1 and 65535");
  }
  if (!(input.observedAt instanceof Date) || Number.isNaN(input.observedAt.getTime())) {
    throw new TypeError("recordFindingObservation: observedAt must be a valid Date");
  }
}

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

// Pure classification of what an observation means against an *existing*
// Finding. Never called for a brand-new Finding (that path is always
// CREATED). Re-evaluated on every transaction attempt against freshly read
// state, so a Finding that another transaction reopened between attempts is
// classified against its new OPEN state rather than the stale CLOSED one.
//
// OPEN: an observation strictly before the current lastSeen is out-of-order
// evidence (HISTORICAL) rather than the normal forward-moving case
// (PERSISTED). An equal timestamp is not "before", so it is PERSISTED — the
// documented tie-break for OPEN findings.
//
// CLOSED: reopens (RECURRED) only for an observation strictly after
// closedThroughObservedAt. An equal-or-earlier observation is HISTORICAL —
// it predates (or exactly matches) the point the finding was already known
// closed through, so it must never reopen the case. A CLOSED finding with no
// closedThroughObservedAt is a data-integrity violation (the close path must
// always set both together); this throws rather than guessing, and is not a
// retryable condition.
function classifyObservation(finding, observedAt) {
  if (finding.status === FindingStatus.CLOSED) {
    const threshold = finding.closedThroughObservedAt;
    if (threshold === null || threshold === undefined) {
      throw new Error(
        "classifyObservation: CLOSED finding is missing closedThroughObservedAt — data integrity violation"
      );
    }
    return observedAt.getTime() > asDate(threshold).getTime()
      ? FindingOccurrenceAction.RECURRED
      : FindingOccurrenceAction.HISTORICAL;
  }

  return observedAt.getTime() < asDate(finding.lastSeen).getTime()
    ? FindingOccurrenceAction.HISTORICAL
    : FindingOccurrenceAction.PERSISTED;
}

function minDate(a, b) {
  return a.getTime() <= b.getTime() ? a : b;
}
function maxDate(a, b) {
  return a.getTime() >= b.getTime() ? a : b;
}

// Builds the projection patch from the state read inside this attempt's
// transaction. Safe as a read-modify-write because SERIALIZABLE rejects a
// conflicting concurrent writer (P2034) instead of letting a stale
// computation land — see the header note.
function buildProjectionPatch(current, observedAt, action) {
  const patch = {
    firstSeen: minDate(asDate(current.firstSeen), observedAt),
    lastSeen: maxDate(asDate(current.lastSeen), observedAt),
    occurrenceCount: current.occurrenceCount + 1,
  };

  if (action === FindingOccurrenceAction.RECURRED) {
    // Reopen. closedAt/closedByUserId/closureReason/closedThroughObservedAt
    // describe the *current* closure state (schema.prisma's FindingStatus
    // comment: "a later observation reopens ... when the service layer
    // confirms it post-dates closedThroughObservedAt") — once reopened there
    // is no current closure, so all four are cleared.
    //
    // BINDING REQUIREMENT for the future manual close endpoint: it must write
    // an AuditLog event capturing the prior closure state (actor, time,
    // reason) at the moment it closes a Finding. That audit event plus the
    // immutable FindingOccurrence row created here (action RECURRED, this
    // observedAt) are the permanent evidence of the close/reopen cycle —
    // these four mutable Finding columns are current-state projections and
    // must not be the only record of a closure. See STATUS.md.
    patch.status = FindingStatus.OPEN;
    patch.recurrenceCount = current.recurrenceCount + 1;
    patch.closedAt = null;
    patch.closedByUserId = null;
    patch.closureReason = null;
    patch.closedThroughObservedAt = null;
  }

  return patch;
}

function findingIdentityWhere(input) {
  return {
    finding_identity: {
      indicatorValue: input.indicatorValue,
      port: input.port,
      protocol: input.protocol,
      reportType: input.reportType,
    },
  };
}

// Loads the Finding for this identity, creating it if this attempt does not
// see one. There is deliberately NO try/catch around the create: if a
// concurrent transaction created the same identity first, the P2002 must
// escape this transaction so the outer loop can re-run the whole thing and
// simply read the winning row. Catching it here and re-querying `tx` is
// exactly the 25P02 defect described in the header.
async function loadOrCreateFinding(tx, input) {
  const existing = await tx.finding.findUnique({ where: findingIdentityWhere(input) });
  if (existing) {
    return { finding: existing, created: false };
  }

  const created = await tx.finding.create({
    data: {
      indicatorValue: input.indicatorValue,
      port: input.port,
      protocol: input.protocol,
      reportType: input.reportType,
      status: FindingStatus.OPEN,
      firstSeen: input.observedAt,
      lastSeen: input.observedAt,
      occurrenceCount: 1,
      recurrenceCount: 0,
    },
  });
  return { finding: created, created: true };
}

function buildResult({ finding, occurrence, action, findingCreated, idempotent }) {
  return {
    finding,
    occurrence,
    action,
    findingCreated,
    idempotent,
    recurrence: action === FindingOccurrenceAction.RECURRED,
    historical: action === FindingOccurrenceAction.HISTORICAL,
  };
}

// One full attempt of the read-decide-write. Every step re-reads state, so
// re-running this after a concurrency loss produces a decision based on
// whatever actually committed — never on a stale snapshot from a prior
// attempt.
async function runObservationAttempt(tx, input) {
  const { finding, created: findingCreated } = await loadOrCreateFinding(tx, input);

  // Idempotent replay: exactly one FindingOccurrence per (finding, report).
  // A duplicate row within one report, a retried report, or a literal repeat
  // call all land here and mutate nothing.
  const existingOccurrence = await tx.findingOccurrence.findUnique({
    where: { findingId_rawReportId: { findingId: finding.id, rawReportId: input.rawReportId } },
  });
  if (existingOccurrence) {
    return buildResult({
      finding,
      occurrence: existingOccurrence,
      action: existingOccurrence.action,
      findingCreated,
      idempotent: true,
    });
  }

  const action = findingCreated
    ? FindingOccurrenceAction.CREATED
    : classifyObservation(finding, input.observedAt);

  // No try/catch, for the same reason as loadOrCreateFinding: a concurrent
  // winner's P2002 must abort this transaction and be resolved by re-running
  // it, at which point the findUnique above returns the committed occurrence
  // and this call reports an idempotent result.
  const occurrence = await tx.findingOccurrence.create({
    data: {
      findingId: finding.id,
      rawReportId: input.rawReportId,
      observedAt: input.observedAt,
      action,
    },
  });

  if (findingCreated) {
    // The Finding was created in this same transaction already carrying its
    // final CREATED-state projection values — nothing further to update.
    return buildResult({ finding, occurrence, action, findingCreated: true, idempotent: false });
  }

  // Returns the actual committed post-update row, not a locally merged
  // object, so callers never see a stale projection or stale updatedAt.
  const updatedFinding = await tx.finding.update({
    where: { id: finding.id },
    data: buildProjectionPatch(finding, input.observedAt, action),
  });

  return buildResult({
    finding: updatedFinding,
    occurrence,
    action,
    findingCreated: false,
    idempotent: false,
  });
}

/**
 * Resolves one normalized observation (Finding identity + observation time +
 * the RawReport it came from) against the deduplicated Finding/
 * FindingOccurrence spine: locates or creates the Finding, ensures exactly
 * one FindingOccurrence exists for (finding, rawReport), classifies the
 * lifecycle action (CREATED/PERSISTED/RECURRED/HISTORICAL), and updates the
 * Finding's mutable projection fields accordingly.
 *
 * Runs inside a SERIALIZABLE interactive transaction. On a recognised
 * concurrency error (P2002 uniqueness race, P2034 write conflict/deadlock)
 * the ENTIRE transaction is re-run — up to MAX_TRANSACTION_ATTEMPTS times —
 * with state reloaded and the lifecycle action recomputed from scratch each
 * attempt. Any other error propagates unchanged and is never retried.
 *
 * If a retryable code still escapes this function, the bounded retries were
 * exhausted; the original Prisma error is re-thrown unchanged so the caller
 * can see the real cause.
 *
 * Safe to call twice with the same (identity, rawReportId): the second call
 * finds the existing FindingOccurrence and returns it unchanged with
 * idempotent: true and no projection mutation.
 *
 * @param {{rawReportId:number, reportType:string, indicatorValue:string,
 *   port:number, protocol:string, observedAt:Date}} input
 * @param {{client?:object}} [options]
 * @returns {Promise<{finding:object, occurrence:object, action:string,
 *   findingCreated:boolean, idempotent:boolean, recurrence:boolean,
 *   historical:boolean}>}
 */
async function recordFindingObservation(input, options = {}) {
  assertValidInput(input);
  const client = resolveClient(options.client);

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await client.$transaction((tx) => runObservationAttempt(tx, input), {
        isolationLevel: TRANSACTION_ISOLATION_LEVEL,
      });
    } catch (error) {
      if (!isRetryableConcurrencyError(error)) throw error;
      lastError = error;
    }
  }

  throw lastError;
}

module.exports = {
  PRISMA_UNIQUE_VIOLATION,
  PRISMA_TRANSACTION_CONFLICT,
  RETRYABLE_ERROR_CODES,
  MAX_TRANSACTION_ATTEMPTS,
  TRANSACTION_ISOLATION_LEVEL,
  SUPPORTED_REPORT_TYPES,
  SUPPORTED_PROTOCOLS,
  isRetryableConcurrencyError,
  classifyObservation,
  recordFindingObservation,
};
