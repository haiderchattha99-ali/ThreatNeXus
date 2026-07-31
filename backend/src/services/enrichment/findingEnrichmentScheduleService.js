"use strict";

// Analyst-facing manual/forced IOC enrichment scheduling for one Finding
// (P2-T2e-2). This is the one write path in the enrichment surface that a
// human, not ingestion, drives directly — so unlike
// reportIngestionService.js's scheduleEnrichmentSafely (which must swallow
// every failure to protect an unrelated upload), a genuine scheduling
// failure here is surfaced to the caller after being audited, not hidden.
//
// Two distinct operations, both funnelled through enrichmentQueueService so
// the cache-key construction and P2002 recovery loop are never duplicated:
//   force=false -> scheduleEnrichment      (ordinary cache-aware scheduling)
//   force=true  -> scheduleEnrichmentForced (bypasses fresh-cache short-
//                  circuit; NEVER bypasses active-job uniqueness)
//
// No provider call happens anywhere in this module — scheduling is a
// database-only decision, exactly like ingestion's.

const {
  scheduleEnrichment,
  scheduleEnrichmentForced,
  SCHEDULE_OUTCOME,
} = require("./enrichmentQueueService");
const { INDICATOR_TYPES } = require("./iocEnrichmentTypes");
const { DEFAULT_MAX_ATTEMPTS } = require("./iocEnrichmentCacheRules");
const {
  FindingEnrichmentValidationError,
  FindingEnrichmentNotFoundError,
  normalizeProvider,
  loadFindingIndicator,
  serializeEnrichmentRecord,
} = require("./findingEnrichmentReadService");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");
const env = require("../../config/env");

const MAX_JUSTIFICATION_LENGTH = 1000;
const JUSTIFICATION_PREVIEW_LENGTH = 200;

const AUDIT_ACTIONS = Object.freeze({
  REQUESTED: "enrichment.manual.schedule.requested",
  COMPLETED: "enrichment.manual.schedule.completed",
  FAILED: "enrichment.manual.schedule.failed",
});

const AUDIT_ENTITY_TYPE = "Finding";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

function assertValidFindingId(findingId) {
  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new FindingEnrichmentValidationError("findingId must be a positive integer");
  }
  return findingId;
}

function assertValidNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new FindingEnrichmentValidationError("now must be an explicit, valid Date");
  }
  return now;
}

// Same trim/bound rule as findingOwnershipService.js's normalizeJustification
// — deliberately mirrored, not imported, so this module has no dependency on
// the ownership package for an unrelated concern.
function normalizeJustification(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_JUSTIFICATION_LENGTH) return undefined;
  return trimmed;
}

function boundedJustificationPreview(value) {
  if (typeof value !== "string" || value === "") return null;
  return value.length > JUSTIFICATION_PREVIEW_LENGTH
    ? `${value.slice(0, JUSTIFICATION_PREVIEW_LENGTH)}…`
    : value;
}

// maxAgeInDays: bounded through the same rule createEnrichmentResult's
// sanitizeQueryParams already enforces (positive integer) — validated here,
// up front, so a bad value is a controlled 400 rather than a TypeError raised
// deep inside buildEnrichmentCacheIdentity.
function normalizeMaxAgeInDays(maxAgeInDays) {
  if (maxAgeInDays === undefined || maxAgeInDays === null) {
    // No caller override: default to the same value ingestion schedules
    // with, so a Finding's ingestion-scheduled job and an analyst's manual
    // request share one cache identity rather than silently fragmenting.
    return env.ABUSEIPDB_MAX_AGE_DAYS;
  }
  if (!Number.isInteger(maxAgeInDays) || maxAgeInDays <= 0) {
    throw new FindingEnrichmentValidationError("maxAgeInDays must be a positive integer");
  }
  return maxAgeInDays;
}

function assertValidForce(force) {
  if (force === undefined || force === null) return false;
  if (typeof force !== "boolean") {
    throw new FindingEnrichmentValidationError("force must be a boolean");
  }
  return force;
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...auditContext, ...event }, { client });
  } catch (error) {
    console.error("Manual enrichment scheduling audit failed", { name: error && error.name });
  }
}

/**
 * Normal or forced manual IOC-enrichment scheduling for one Finding.
 *
 * @param {number} findingId
 * @param {{client?: object, provider?: string, maxAgeInDays?: number,
 *   force?: boolean, justification?: string, now: Date,
 *   auditContext?: object}} options `now` is the caller's single explicit
 *   evaluation time (the controller obtains it once) — this module never
 *   reads the wall clock itself.
 * @returns {Promise<{findingId: number, indicator: string, provider: string,
 *   force: boolean, outcome: string, record: object|null}>}
 */
async function scheduleFindingEnrichment(findingId, options = {}) {
  const client = resolveClient(options.client);
  const auditContext = isPlainObject(options.auditContext) ? options.auditContext : {};

  // Every input is validated up front, before any audit or database write —
  // a bad request never produces a "requested" audit row.
  const id = assertValidFindingId(findingId);
  const now = assertValidNow(options.now);
  const provider = normalizeProvider(options.provider);
  const maxAgeInDays = normalizeMaxAgeInDays(options.maxAgeInDays);
  const force = assertValidForce(options.force);

  let justification;
  if (force) {
    justification = normalizeJustification(options.justification);
    if (justification === undefined) {
      throw new FindingEnrichmentValidationError(
        "justification is required and must be 1-1000 characters when force=true"
      );
    }
  } else if (options.justification !== undefined && options.justification !== null) {
    // Optional even for a normal request; silently ignored if it fails the
    // same bound rather than blocking an otherwise-valid non-forced request.
    justification = normalizeJustification(options.justification);
  }

  // Not found is checked before any audit write too — an unknown Finding id
  // never emits a "requested" event.
  const { indicator } = await loadFindingIndicator(client, id);

  await audit(client, auditContext, {
    action: AUDIT_ACTIONS.REQUESTED,
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: AUDIT_ENTITY_TYPE,
    entityId: id,
    after: { findingId: id, provider, force },
    reason: force
      ? "Forced IOC re-enrichment requested"
      : "Manual IOC enrichment scheduling requested",
  });

  const identity = {
    provider,
    indicatorType: INDICATOR_TYPES.IPV4,
    indicator,
    queryParams: { maxAgeInDays },
  };

  let result;
  try {
    result = force
      ? await scheduleEnrichmentForced(identity, { client, asOf: now, maxAttempts: DEFAULT_MAX_ATTEMPTS })
      : await scheduleEnrichment(identity, { client, asOf: now, maxAttempts: DEFAULT_MAX_ATTEMPTS });
  } catch (error) {
    await audit(client, auditContext, {
      action: AUDIT_ACTIONS.FAILED,
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: AUDIT_ENTITY_TYPE,
      entityId: id,
      after: {
        findingId: id,
        provider,
        force,
        justification: boundedJustificationPreview(justification),
      },
      reason: force
        ? "Forced IOC re-enrichment failed"
        : "Manual IOC enrichment scheduling failed",
    });
    // Re-thrown deliberately: unlike ingestion, there is no unrelated report
    // to protect here, and the caller (the HTTP controller) needs to know a
    // genuine failure occurred rather than silently doing nothing.
    throw error;
  }

  await audit(client, auditContext, {
    action: AUDIT_ACTIONS.COMPLETED,
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: AUDIT_ENTITY_TYPE,
    entityId: id,
    after: {
      findingId: id,
      provider,
      force,
      outcome: result.outcome,
      enrichmentId: result.record ? result.record.id : null,
      justification: boundedJustificationPreview(justification),
    },
    reason: force
      ? `Forced IOC re-enrichment: ${result.outcome}`
      : `Manual IOC enrichment scheduling: ${result.outcome}`,
  });

  return {
    findingId: id,
    indicator,
    provider,
    force,
    outcome: result.outcome,
    record: serializeEnrichmentRecord(result.record),
  };
}

module.exports = {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPE,
  MAX_JUSTIFICATION_LENGTH,
  FindingEnrichmentValidationError,
  FindingEnrichmentNotFoundError,
  SCHEDULE_OUTCOME,
  scheduleFindingEnrichment,
};
