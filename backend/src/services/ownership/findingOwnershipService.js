"use strict";

// FindingOwnership resolution + override service (P2-T1). Owns every write
// to the FindingOwnership table: automatic resolution (resolveOneFinding),
// bulk re-resolution after a mapping change (reResolveFindingsForMapping),
// analyst override apply/clear, current/history reads, and coverage metrics.
//
// Concurrency strategy mirrors dedupService.js exactly, for the same reason:
// the whole read-decide-write runs inside ONE Prisma interactive transaction
// at SERIALIZABLE isolation, and a recognised concurrency error (P2002 —
// the currentForFindingId unique race; P2034 — write conflict/deadlock)
// re-runs the ENTIRE transaction from scratch, up to MAX_TRANSACTION_ATTEMPTS
// times, re-reading committed state on every attempt. No error is ever
// caught *inside* the transaction (a caught P2002 leaves the surrounding
// transaction aborted — see dedupService.js's header note for the full
// PostgreSQL 25P02 explanation). This is what keeps "at most one current row
// per Finding" true under concurrent resolution attempts without a raw SQL
// partial index or an updatedAt-based compare-and-swap.
//
// ---------------------------------------------------------------------------
// Accepted limitation: ASN is not persisted anywhere in this schema
// ---------------------------------------------------------------------------
// A RawReportRow's `asn` field is deliberately non-authoritative (Phase 1)
// and is never copied onto Finding or FindingOwnership. That means the ASN
// tier of resolveOwnership can only be exercised at the moment of ingestion,
// when the freshly parsed row's asn value is still in memory and passed in
// explicitly (see reportIngestionService.js). Any resolution triggered later
// with no such value at hand — a manual re-resolve, or re-resolution
// triggered by an AssetMapping mutation — passes asn: null and can only
// re-evaluate the exact-IP/CIDR tiers. This is a real, accepted tradeoff
// documented in STATUS.md, not a silent gap: an ASN-mapping change cannot
// retroactively re-resolve Findings whose ASN was never stored.

const { AssetMappingType } = require("@prisma/client");

const { isValidIpv4, ipv4ToInt } = require("./ipv4Cidr");
const {
  OWNERSHIP_RESOLUTION_STATUS,
  OWNERSHIP_CONFIDENCE,
  REASON_CODES,
  resolveOwnership,
} = require("./ownershipResolver");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const PRISMA_UNIQUE_VIOLATION = "P2002";
const PRISMA_TRANSACTION_CONFLICT = "P2034";
const RETRYABLE_ERROR_CODES = Object.freeze([PRISMA_UNIQUE_VIOLATION, PRISMA_TRANSACTION_CONFLICT]);
const MAX_TRANSACTION_ATTEMPTS = 5;
const TRANSACTION_ISOLATION_LEVEL = "Serializable";

const MAX_JUSTIFICATION_LENGTH = 1000;

class FindingOwnershipNotFoundError extends Error {
  constructor(findingId) {
    super(`Finding ${findingId} not found`);
    this.name = "FindingOwnershipNotFoundError";
  }
}

class FindingOwnershipValidationError extends Error {
  constructor(fields) {
    super(`FindingOwnership validation failed: ${fields.join(", ")}`);
    this.name = "FindingOwnershipValidationError";
    this.fields = fields;
  }
}

class FindingOwnershipOverrideStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "FindingOwnershipOverrideStateError";
  }
}

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

function isRetryableConcurrencyError(error) {
  return Boolean(error) && RETRYABLE_ERROR_CODES.includes(error.code);
}

async function runInRetryableTransaction(client, fn) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await client.$transaction(fn, { isolationLevel: TRANSACTION_ISOLATION_LEVEL });
    } catch (error) {
      if (!isRetryableConcurrencyError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function normalizeJustification(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_JUSTIFICATION_LENGTH) return undefined;
  return trimmed;
}

function boundedJustificationPreview(value) {
  if (typeof value !== "string" || value === "") return null;
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...auditContext, ...event }, { client });
  } catch (error) {
    console.error("Ownership audit failed", { name: error && error.name });
  }
}

// Narrow candidate query: only mappings that could possibly match this
// observation, pre-filtered to enabled rows. The resolver still applies the
// exact validFrom/validUntil-vs-asOf activity window itself.
async function loadActiveMappingCandidates(tx, indicatorInt, asn) {
  const or = [];
  if (indicatorInt !== null) {
    or.push({ mappingType: AssetMappingType.EXACT_IP, ipStart: indicatorInt, ipEnd: indicatorInt });
    or.push({
      mappingType: AssetMappingType.CIDR,
      ipStart: { lte: indicatorInt },
      ipEnd: { gte: indicatorInt },
    });
  }
  if (asn !== null && asn !== undefined) {
    or.push({ mappingType: AssetMappingType.ASN, asn });
  }
  if (or.length === 0) return [];
  return tx.assetMapping.findMany({ where: { enabled: true, OR: or } });
}

async function loadCurrentOwnershipRow(tx, findingId) {
  return tx.findingOwnership.findUnique({ where: { currentForFindingId: findingId } });
}

// The fields that define "the same effective outcome" — asOf/resolvedAt/id
// deliberately excluded, so a re-resolution that reaches an identical
// decision at a later moment in time is still treated as unchanged.
function effectiveFieldsEqual(currentRow, result) {
  if (!currentRow) return false;
  return (
    currentRow.status === result.status &&
    currentRow.organizationId === result.organizationId &&
    currentRow.confidence === result.confidence &&
    currentRow.matchedMappingId === result.matchedMappingId &&
    currentRow.matchedPrefixLength === result.matchedPrefixLength &&
    currentRow.candidateCount === result.candidateCount &&
    currentRow.isIspAttribution === result.isIspAttribution &&
    currentRow.reasonCode === result.reasonCode
  );
}

// Supersede-then-insert, inside the caller's transaction. `forceNewRow`
// bypasses the identical-outcome dedupe — used by applyOverride/clearOverride,
// which are explicit analyst actions with their own justification each time,
// not automatic re-resolution replay.
async function persistIfChanged(tx, findingId, currentRow, result, options = {}) {
  const { asOf, overrideActorUserId = null, overrideJustification = null, forceNewRow = false } =
    options;

  if (!forceNewRow && effectiveFieldsEqual(currentRow, result)) {
    return { changed: false, current: currentRow, previous: currentRow };
  }

  if (currentRow) {
    await tx.findingOwnership.update({
      where: { id: currentRow.id },
      data: { supersededAt: asOf, currentForFindingId: null },
    });
  }

  const created = await tx.findingOwnership.create({
    data: {
      findingId,
      organizationId: result.organizationId,
      status: result.status,
      confidence: result.confidence,
      matchedMappingId: result.matchedMappingId,
      matchedPrefixLength: result.matchedPrefixLength,
      candidateCount: result.candidateCount,
      isIspAttribution: result.isIspAttribution,
      reasonCode: result.reasonCode,
      asOf,
      currentForFindingId: findingId,
      overrideActorUserId,
      overrideJustification,
    },
  });

  return { changed: true, current: created, previous: currentRow };
}

async function attemptAutomaticResolution(tx, findingId, { asn, asOf }) {
  const finding = await tx.finding.findUnique({ where: { id: findingId } });
  if (!finding) throw new FindingOwnershipNotFoundError(findingId);

  const currentRow = await loadCurrentOwnershipRow(tx, findingId);
  const currentOverride =
    currentRow && currentRow.status === OWNERSHIP_RESOLUTION_STATUS.OVERRIDDEN
      ? { organizationId: currentRow.organizationId }
      : null;

  const indicatorInt = isValidIpv4(finding.indicatorValue) ? ipv4ToInt(finding.indicatorValue) : null;
  const mappings =
    currentOverride === null ? await loadActiveMappingCandidates(tx, indicatorInt, asn ?? null) : [];

  const result = resolveOwnership(
    { indicatorValue: finding.indicatorValue, asn: asn ?? null, asOf },
    { mappings, currentOverride }
  );

  return persistIfChanged(tx, findingId, currentRow, result, { asOf });
}

/**
 * Resolves (or re-resolves) ownership for exactly one Finding and persists
 * the result if it differs from the current row. Safe to call repeatedly —
 * an unchanged outcome writes nothing (no new row, no audit).
 *
 * @param {number} findingId
 * @param {{client?: object, asn?: number|null, asOf?: Date, auditContext?: object}} [options]
 */
async function resolveOneFinding(findingId, options = {}) {
  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new FindingOwnershipValidationError(["findingId"]);
  }
  const client = resolveClient(options.client);
  const asOf = options.asOf instanceof Date ? options.asOf : new Date();
  const auditContext = options.auditContext || {};

  try {
    const outcome = await runInRetryableTransaction(client, (tx) =>
      attemptAutomaticResolution(tx, findingId, { asn: options.asn ?? null, asOf })
    );

    if (outcome.changed) {
      await audit(client, auditContext, {
        action: "ownership.resolution.changed",
        outcome: AUDIT_OUTCOMES.SUCCESS,
        entityType: "Finding",
        entityId: findingId,
        after: findingOwnershipAuditSummary(outcome.current),
        reason: `Ownership resolution: ${outcome.current.status} (${outcome.current.reasonCode})`,
      });
    }

    return outcome;
  } catch (error) {
    if (error instanceof FindingOwnershipNotFoundError) throw error;

    await audit(client, auditContext, {
      action: "ownership.resolution.failed",
      outcome: AUDIT_OUTCOMES.FAILURE,
      entityType: "Finding",
      entityId: findingId,
      reason: "Ownership resolution failed unexpectedly",
    });
    throw error;
  }
}

// Re-resolves every Finding whose indicatorValue falls inside an EXACT_IP or
// CIDR mapping's range — the precise, correct case, since indicatorValue is
// always known. ASN-type mappings cannot drive re-resolution (see the module
// header note) and are skipped with an explicit `skipped: true` result
// rather than silently doing nothing.
async function reResolveFindingsForMapping(mapping, options = {}) {
  const client = resolveClient(options.client);
  const auditContext = options.auditContext || {};

  if (mapping.mappingType === AssetMappingType.ASN) {
    return { skipped: true, reason: "ASN_NOT_PERSISTED_ON_FINDING", reResolved: [] };
  }

  const allFindings = await client.finding.findMany({ select: { id: true, indicatorValue: true } });
  const affected = allFindings
    .filter((f) => isValidIpv4(f.indicatorValue))
    .filter((f) => {
      const ip = ipv4ToInt(f.indicatorValue);
      return ip >= mapping.ipStart && ip <= mapping.ipEnd;
    })
    .map((f) => f.id)
    .sort((a, b) => a - b); // deterministic, independent of DB row order

  const results = [];
  // Sequential by design — see resolveOneFinding's own transaction scope;
  // there is no benefit and real risk in resolving a shared mapping's
  // affected findings concurrently against each other.
  // eslint-disable-next-line no-restricted-syntax
  for (const findingId of affected) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await resolveOneFinding(findingId, { client, auditContext });
      results.push({ findingId, changed: outcome.changed });
    } catch (error) {
      results.push({ findingId, changed: false, failed: true });
    }
  }

  return { skipped: false, reResolved: results };
}

async function attemptApplyOverride(tx, findingId, organizationId, justification, asOf, actorUserId) {
  const finding = await tx.finding.findUnique({ where: { id: findingId } });
  if (!finding) throw new FindingOwnershipNotFoundError(findingId);

  const organization = await tx.organization.findUnique({ where: { id: organizationId } });
  if (!organization) {
    throw new FindingOwnershipValidationError(["organizationId: organization not found"]);
  }

  const currentRow = await loadCurrentOwnershipRow(tx, findingId);
  const result = {
    status: OWNERSHIP_RESOLUTION_STATUS.OVERRIDDEN,
    organizationId,
    confidence: OWNERSHIP_CONFIDENCE.CONFIRMED,
    matchedMappingId: null,
    matchedPrefixLength: null,
    candidateCount: 1,
    isIspAttribution: false,
    reasonCode: REASON_CODES.ANALYST_OVERRIDE,
  };

  const outcome = await persistIfChanged(tx, findingId, currentRow, result, {
    asOf,
    overrideActorUserId: actorUserId,
    overrideJustification: justification,
    forceNewRow: true,
  });
  return { ...outcome, finding, organization };
}

/**
 * Applies (or replaces) an analyst override for a Finding. Always inserts a
 * new current row — an explicit analyst action with a fresh justification is
 * never deduplicated against the current outcome, even if it names the same
 * organization.
 */
// P2-T3 — rescore one Finding after an ownership override apply/clear has
// committed.
//
// Ownership contributes NO basis points to risk (DECISIONS.md D-003 stands),
// but it decides whether sectorCriticality is attributable at all: an override
// onto a healthcare organization can turn a NOT_AVAILABLE sector factor into
// an APPLIED one, and clearing it can turn it back. So the score genuinely
// needs recomputing even though ownership itself is unscored.
//
// Runs strictly after the ownership transaction has committed, and never
// throws: a risk failure must not roll back ownership history. Mapping-registry
// bulk changes are deliberately NOT hooked here — bounded re-resolution across
// many findings remains deferred to its own packet.
async function recalculateRiskAfterOwnershipSafely(client, auditContext, findingId, asOf) {
  try {
    // Required lazily to avoid a require-time cycle: the risk pipeline reads
    // ownership state, and this module now triggers the risk pipeline.
    // eslint-disable-next-line global-require
    const { recalculateAfterOwnershipChange } = require("../risk/riskRecalculationService");
    await recalculateAfterOwnershipChange({ findingId, asOf, client, auditContext });
  } catch (error) {
    console.error("Risk recalculation after ownership change failed", {
      name: error && error.name,
    });
  }
}

async function applyOverride(findingId, organizationId, justification, options = {}) {
  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new FindingOwnershipValidationError(["findingId"]);
  }
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    throw new FindingOwnershipValidationError(["organizationId"]);
  }
  const normalizedJustification = normalizeJustification(justification);
  if (normalizedJustification === undefined) {
    throw new FindingOwnershipValidationError(["justification"]);
  }

  const client = resolveClient(options.client);
  const asOf = options.asOf instanceof Date ? options.asOf : new Date();
  const auditContext = options.auditContext || {};
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;

  try {
    const outcome = await runInRetryableTransaction(client, (tx) =>
      attemptApplyOverride(tx, findingId, organizationId, normalizedJustification, asOf, actorUserId)
    );

    await audit(client, auditContext, {
      action: "ownership.override.applied",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: "Finding",
      entityId: findingId,
      before: findingOwnershipAuditSummary(outcome.previous),
      after: {
        ...findingOwnershipAuditSummary(outcome.current),
        justification: boundedJustificationPreview(normalizedJustification),
      },
      reason: "Analyst override applied",
    });

    await recalculateRiskAfterOwnershipSafely(client, auditContext, findingId, asOf);

    return outcome;
  } catch (error) {
    if (
      error instanceof FindingOwnershipNotFoundError ||
      error instanceof FindingOwnershipValidationError
    ) {
      await audit(client, auditContext, {
        action: "ownership.override.applied",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: "Finding",
        entityId: findingId,
        reason: `Override rejected: ${error.message}`,
      });
    }
    throw error;
  }
}

async function attemptClearOverride(tx, findingId, justification, asOf, actorUserId) {
  const finding = await tx.finding.findUnique({ where: { id: findingId } });
  if (!finding) throw new FindingOwnershipNotFoundError(findingId);

  const currentRow = await loadCurrentOwnershipRow(tx, findingId);
  if (!currentRow || currentRow.status !== OWNERSHIP_RESOLUTION_STATUS.OVERRIDDEN) {
    throw new FindingOwnershipOverrideStateError(
      `Finding ${findingId} has no active analyst override to clear`
    );
  }

  const indicatorInt = isValidIpv4(finding.indicatorValue) ? ipv4ToInt(finding.indicatorValue) : null;
  const mappings = await loadActiveMappingCandidates(tx, indicatorInt, null);
  const result = resolveOwnership(
    { indicatorValue: finding.indicatorValue, asn: null, asOf },
    { mappings, currentOverride: null }
  );

  const outcome = await persistIfChanged(tx, findingId, currentRow, result, {
    asOf,
    overrideActorUserId: actorUserId,
    overrideJustification: justification,
    forceNewRow: true,
  });
  return { ...outcome, finding };
}

/**
 * Clears an active analyst override and reverts the Finding to whatever the
 * automatic resolver currently produces (RESOLVED/AMBIGUOUS/UNRESOLVED) —
 * never simply back to "no ownership". Throws
 * FindingOwnershipOverrideStateError if there is nothing to clear.
 */
async function clearOverride(findingId, options = {}) {
  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new FindingOwnershipValidationError(["findingId"]);
  }
  const normalizedJustification =
    options.justification === undefined || options.justification === null
      ? null
      : normalizeJustification(options.justification);
  if (normalizedJustification === undefined) {
    throw new FindingOwnershipValidationError(["justification"]);
  }

  const client = resolveClient(options.client);
  const asOf = options.asOf instanceof Date ? options.asOf : new Date();
  const auditContext = options.auditContext || {};
  const actorUserId = Number.isInteger(options.actorUserId) ? options.actorUserId : null;

  try {
    const outcome = await runInRetryableTransaction(client, (tx) =>
      attemptClearOverride(tx, findingId, normalizedJustification, asOf, actorUserId)
    );

    await audit(client, auditContext, {
      action: "ownership.override.cleared",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: "Finding",
      entityId: findingId,
      before: findingOwnershipAuditSummary(outcome.previous),
      after: findingOwnershipAuditSummary(outcome.current),
      reason: "Analyst override cleared; reverted to automatic resolution",
    });

    await recalculateRiskAfterOwnershipSafely(client, auditContext, findingId, asOf);

    return outcome;
  } catch (error) {
    if (
      error instanceof FindingOwnershipNotFoundError ||
      error instanceof FindingOwnershipOverrideStateError ||
      error instanceof FindingOwnershipValidationError
    ) {
      await audit(client, auditContext, {
        action: "ownership.override.cleared",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: "Finding",
        entityId: findingId,
        reason: `Override clear rejected: ${error.message}`,
      });
    }
    throw error;
  }
}

// Current + full history for one Finding, in deterministic order
// (resolvedAt desc, id desc as a tiebreak for same-millisecond rows).
async function getFindingOwnership(findingId, options = {}) {
  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new FindingOwnershipValidationError(["findingId"]);
  }
  const client = resolveClient(options.client);

  const finding = await client.finding.findUnique({ where: { id: findingId } });
  if (!finding) throw new FindingOwnershipNotFoundError(findingId);

  const [current, history] = await Promise.all([
    client.findingOwnership.findUnique({ where: { currentForFindingId: findingId } }),
    client.findingOwnership.findMany({
      where: { findingId },
      orderBy: [{ resolvedAt: "desc" }, { id: "desc" }],
    }),
  ]);

  return { current, history };
}

// Coverage metrics — every category reported separately, never collapsed
// into one "percentage mapped" figure (BUILD_PLAN.md's explicit instruction).
async function calculateCoverage(options = {}) {
  const client = resolveClient(options.client);

  const [totalFindings, grouped, enabledMappingCount, confirmedEnabledMappingCount] =
    await Promise.all([
      client.finding.count(),
      client.findingOwnership.groupBy({
        by: ["status", "reasonCode", "isIspAttribution"],
        where: { currentForFindingId: { not: null } },
        _count: { _all: true },
      }),
      client.assetMapping.count({ where: { enabled: true } }),
      client.assetMapping.count({ where: { enabled: true, mappingConfirmed: true } }),
    ]);

  const counts = {
    resolvedExactIp: 0,
    resolvedCidr: 0,
    resolvedOverride: 0,
    ispAttribution: 0,
    ambiguous: 0,
    unresolved: 0,
    unknown: 0,
  };
  let totalResolutions = 0;

  // Classification priority (most-specific/most-urgent first): a status of
  // OVERRIDDEN/AMBIGUOUS/UNRESOLVED always wins over isIspAttribution, since
  // the ASN tier can itself produce AMBIGUOUS (two orgs sharing one ASN —
  // see ownershipResolver.js's decideAtTier) and that row must still be
  // counted as ambiguous, never miscounted as a settled ISP attribution.
  // Only a RESOLVED row's isIspAttribution/reasonCode decide its sub-bucket.
  // Any state this ladder doesn't recognise falls into `unknown` rather than
  // silently vanishing from the totals.
  grouped.forEach((row) => {
    const n = row._count._all;
    totalResolutions += n;

    if (row.status === OWNERSHIP_RESOLUTION_STATUS.OVERRIDDEN) {
      counts.resolvedOverride += n;
    } else if (row.status === OWNERSHIP_RESOLUTION_STATUS.AMBIGUOUS) {
      counts.ambiguous += n;
    } else if (row.status === OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED) {
      counts.unresolved += n;
    } else if (row.status === OWNERSHIP_RESOLUTION_STATUS.RESOLVED && row.isIspAttribution) {
      counts.ispAttribution += n;
    } else if (row.status === OWNERSHIP_RESOLUTION_STATUS.RESOLVED && row.reasonCode === REASON_CODES.EXACT_IP_MATCH) {
      counts.resolvedExactIp += n;
    } else if (row.status === OWNERSHIP_RESOLUTION_STATUS.RESOLVED && row.reasonCode === REASON_CODES.CIDR_MATCH) {
      counts.resolvedCidr += n;
    } else {
      counts.unknown += n;
    }
  });

  return {
    totalFindings,
    findingsWithResolution: totalResolutions,
    findingsWithoutResolution: Math.max(0, totalFindings - totalResolutions),
    resolvedExactIp: counts.resolvedExactIp,
    resolvedCidr: counts.resolvedCidr,
    resolvedOverride: counts.resolvedOverride,
    ispAttribution: counts.ispAttribution,
    ambiguous: counts.ambiguous,
    unresolved: counts.unresolved,
    unknown: counts.unknown,
    mappingRegistry: {
      enabledMappings: enabledMappingCount,
      confirmedEnabledMappings: confirmedEnabledMappingCount,
      confirmedMappingShare: enabledMappingCount === 0 ? null : confirmedEnabledMappingCount / enabledMappingCount,
    },
  };
}

// Safe audit summary — ids/codes/counts only, never a BigInt, never raw
// evidence, never the full mapping registry or unbounded justification text.
function findingOwnershipAuditSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    findingId: row.findingId,
    organizationId: row.organizationId,
    status: row.status,
    confidence: row.confidence,
    matchedMappingId: row.matchedMappingId,
    matchedPrefixLength: row.matchedPrefixLength,
    candidateCount: row.candidateCount,
    isIspAttribution: row.isIspAttribution,
    reasonCode: row.reasonCode,
  };
}

module.exports = {
  FindingOwnershipNotFoundError,
  FindingOwnershipValidationError,
  FindingOwnershipOverrideStateError,
  MAX_JUSTIFICATION_LENGTH,
  MAX_TRANSACTION_ATTEMPTS,
  TRANSACTION_ISOLATION_LEVEL,
  effectiveFieldsEqual,
  resolveOneFinding,
  reResolveFindingsForMapping,
  applyOverride,
  clearOverride,
  getFindingOwnership,
  calculateCoverage,
  findingOwnershipAuditSummary,
  boundedJustificationPreview,
};
