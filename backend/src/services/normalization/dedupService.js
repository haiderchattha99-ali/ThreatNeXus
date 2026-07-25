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
// the schema's `finding_identity` composite unique constraint, which this
// module treats as the final concurrency authority, matching the same
// P2002-catch-and-reload convention established by reportIdentityService.js.
//
// Audit logging: like reportIdentityService.js, this module has no
// request/actor context, so it does not call auditService. The result it
// returns (action, findingCreated, idempotent, recurrence, historical) is
// exactly what a future ingestion-orchestration task needs to write
// aggregate audit events (e.g. "finding.reopened") with real actor context.

const { FindingStatus, FindingOccurrenceAction } = require("@prisma/client");

const PRISMA_UNIQUE_VIOLATION = "P2002";
const MAX_PROJECTION_UPDATE_ATTEMPTS = 5;

function isPrismaUniqueViolation(error) {
  return Boolean(error) && error.code === PRISMA_UNIQUE_VIOLATION;
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
  if (typeof input.reportType !== "string" || input.reportType === "") {
    throw new TypeError("recordFindingObservation: reportType must be a non-empty string");
  }
  if (typeof input.indicatorValue !== "string" || input.indicatorValue === "") {
    throw new TypeError("recordFindingObservation: indicatorValue must be a non-empty string");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new TypeError("recordFindingObservation: port must be an integer between 1 and 65535");
  }
  if (typeof input.protocol !== "string" || input.protocol === "") {
    throw new TypeError("recordFindingObservation: protocol must be a non-empty string");
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
// CREATED).
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
// always set both together); this throws rather than guessing.
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

// Builds the literal (non-atomic-operator) projection patch for an existing
// Finding given the freshly-read `current` row. Literal values (rather than
// Prisma's {increment: n}) are used deliberately so the optimistic-
// concurrency retry in applyProjectionUpdate always computes off a known-
// consistent snapshot, and the returned Finding reflects real numbers
// immediately without an extra read.
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
    // is no current closure, so all four are cleared. This does not destroy
    // the only historical record of the closure: the immutable
    // FindingOccurrence row created alongside this update (action RECURRED,
    // this observedAt) is that evidence, and the original close's who/when/
    // why belongs to the AuditLog event the future close-endpoint task
    // writes when it closes a Finding — these four Finding columns are
    // mutable current-state projections, not the evidence of record.
    patch.status = FindingStatus.OPEN;
    patch.recurrenceCount = current.recurrenceCount + 1;
    patch.closedAt = null;
    patch.closedByUserId = null;
    patch.closureReason = null;
    patch.closedThroughObservedAt = null;
  }

  return patch;
}

// Optimistic-concurrency update: uses the existing `updatedAt` column
// (Prisma `@updatedAt`, no schema change) as a compare-and-swap token via
// updateMany's WHERE clause, so two concurrent transactions touching the
// *same* existing Finding (e.g. two different reports observing the same
// indicator at once) cannot silently lose one side's firstSeen/lastSeen
// change. Prisma has no atomic MIN/MAX operator — that's why this can't just
// use {increment: 1}-style atomic ops for those two fields. No raw SQL, no
// advisory/application-global lock: the database row itself, addressed by a
// version stamp already on the row, is the authority.
async function applyProjectionUpdate(tx, startingFinding, observedAt, action) {
  let current = startingFinding;
  for (let attempt = 0; attempt < MAX_PROJECTION_UPDATE_ATTEMPTS; attempt += 1) {
    const patch = buildProjectionPatch(current, observedAt, action);
    // eslint-disable-next-line no-await-in-loop
    const result = await tx.finding.updateMany({
      where: { id: current.id, updatedAt: current.updatedAt },
      data: patch,
    });
    if (result.count === 1) {
      return { ...current, ...patch };
    }
    // Lost the compare-and-swap: someone else committed an update to this
    // Finding first. Reload the committed state and recompute from it.
    // eslint-disable-next-line no-await-in-loop
    current = await tx.finding.findUniqueOrThrow({ where: { id: current.id } });
  }
  throw new Error(
    `applyProjectionUpdate: projection update for finding ${startingFinding.id} did not converge after ${MAX_PROJECTION_UPDATE_ATTEMPTS} attempts`
  );
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

// Locates the Finding for this identity, creating it if none exists yet.
// Concurrent creation of the same brand-new identity is resolved by the
// database's unique constraint: a losing create's P2002 reloads and returns
// the winner instead of erroring or creating a second row.
async function getOrCreateFinding(tx, input) {
  const where = findingIdentityWhere(input);
  const existing = await tx.finding.findUnique({ where });
  if (existing) {
    return { finding: existing, created: false };
  }

  try {
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
  } catch (error) {
    if (!isPrismaUniqueViolation(error)) throw error;
    const winner = await tx.finding.findUnique({ where });
    if (!winner) throw error;
    return { finding: winner, created: false };
  }
}

// Creates the (findingId, rawReportId) occurrence, or — on a concurrent
// P2002 — loads and returns whichever occurrence actually won the race.
// Never updates or deletes an existing occurrence (immutable evidence).
async function createOccurrenceOrResolveExisting(tx, findingId, rawReportId, observedAt, action) {
  try {
    const row = await tx.findingOccurrence.create({
      data: { findingId, rawReportId, observedAt, action },
    });
    return { created: true, row };
  } catch (error) {
    if (!isPrismaUniqueViolation(error)) throw error;
    const existing = await tx.findingOccurrence.findUnique({
      where: { findingId_rawReportId: { findingId, rawReportId } },
    });
    if (!existing) throw error;
    return { created: false, row: existing };
  }
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

/**
 * Resolves one normalized observation (Finding identity + observation time +
 * the RawReport it came from) against the deduplicated Finding/
 * FindingOccurrence spine: locates or creates the Finding, ensures exactly
 * one FindingOccurrence exists for (finding, rawReport), classifies the
 * lifecycle action (CREATED/PERSISTED/RECURRED/HISTORICAL), and updates the
 * Finding's mutable projection fields accordingly.
 *
 * Read-decide-write happens inside a single Prisma transaction; database
 * unique constraints are the final concurrency authority — P2002 on either
 * table resolves by reloading, never by erroring or double-writing, and a
 * lost occurrence-create race never mutates the Finding projection a second
 * time.
 *
 * Safe to call twice with the same (identity, rawReportId): the second call
 * finds the existing FindingOccurrence and returns it unchanged with
 * idempotent: true and no projection mutation — including duplicate rows
 * within one report, which collapse to the same (finding, report) pair.
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

  return client.$transaction(async (tx) => {
    const { finding, created: findingCreated } = await getOrCreateFinding(tx, input);

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

    const occurrenceResult = await createOccurrenceOrResolveExisting(
      tx,
      finding.id,
      input.rawReportId,
      input.observedAt,
      action
    );

    if (!occurrenceResult.created) {
      // Lost a concurrent race for this exact (finding, report) pair after
      // the initial check above missed it — resolve idempotently, and do
      // NOT touch the projection a second time.
      return buildResult({
        finding,
        occurrence: occurrenceResult.row,
        action: occurrenceResult.row.action,
        findingCreated,
        idempotent: true,
      });
    }

    if (findingCreated) {
      // The Finding row was created with its final CREATED-state projection
      // values already, in this same transaction — nothing further to update.
      return buildResult({
        finding,
        occurrence: occurrenceResult.row,
        action,
        findingCreated: true,
        idempotent: false,
      });
    }

    const updatedFinding = await applyProjectionUpdate(tx, finding, input.observedAt, action);
    return buildResult({
      finding: updatedFinding,
      occurrence: occurrenceResult.row,
      action,
      findingCreated: false,
      idempotent: false,
    });
  });
}

module.exports = {
  PRISMA_UNIQUE_VIOLATION,
  classifyObservation,
  recordFindingObservation,
};
