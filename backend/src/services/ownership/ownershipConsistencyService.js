"use strict";

// ===========================================================================
// Ownership consistency detection.
//
// DETECTION ONLY. Nothing in this module writes, corrects, supersedes or
// deletes anything. That is the whole point: ownership history is append-only
// evidence, and a checker that silently "fixed" what it found would destroy
// the very record that shows something went wrong. It reports; a human decides.
//
// WHAT IT LOOKS FOR
// -----------------
// Two families of defect:
//
//   STRUCTURAL — a row that violates the closed ownership contract on its own
//   terms (an AMBIGUOUS row naming an organization, an OVERRIDDEN row leaning
//   on a mapping id, a confidence/status pair that cannot legally coexist).
//   These are cheap: they need only the row.
//
//   DIVERGENT — a current row that no longer matches what the authoritative
//   resolver would decide right now, with no explicit override to explain the
//   difference. This is what "stale after a mapping mutation" actually looks
//   like from the outside, and it is the check that would have caught the gap
//   this packet closed. These are expensive: they re-run resolution per
//   Finding, so they are strictly bounded and cursor-paginated.
//
// SAFETY
// ------
// Findings are identified by id only. An indicatorValue is a victim address
// and never appears in a count, a log line or an audit payload here.
// ===========================================================================

const {
  OWNERSHIP_RESOLUTION_STATUS,
  OWNERSHIP_CONFIDENCE,
  resolveOwnership,
} = require("./ownershipResolver");
const { isValidIpv4, ipv4ToInt } = require("./ipv4Cidr");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

const CONSISTENCY_AUDIT_ACTIONS = Object.freeze({
  REQUESTED: "ownership.consistency.check.requested",
  COMPLETED: "ownership.consistency.check.completed",
  FAILED: "ownership.consistency.check.failed",
});

const AUDIT_ENTITY_TYPE = "OwnershipConsistencyCheck";

const DEFAULT_BATCH_SIZE = 100;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 500;

// Closed issue vocabulary. Every finding of this checker is exactly one of
// these codes — never free text, so callers and the Phase 2 gate can assert on
// them.
const CONSISTENCY_ISSUE = Object.freeze({
  DUPLICATE_CURRENT_ROW: "DUPLICATE_CURRENT_ROW",
  RESOLVED_WITHOUT_ORGANIZATION: "RESOLVED_WITHOUT_ORGANIZATION",
  AMBIGUOUS_WITH_ORGANIZATION: "AMBIGUOUS_WITH_ORGANIZATION",
  UNRESOLVED_WITH_ORGANIZATION: "UNRESOLVED_WITH_ORGANIZATION",
  OVERRIDE_RELIES_ON_MAPPING: "OVERRIDE_RELIES_ON_MAPPING",
  INVALID_STATUS_CONFIDENCE_COMBINATION: "INVALID_STATUS_CONFIDENCE_COMBINATION",
  ISP_ATTRIBUTION_INCOMPATIBLE: "ISP_ATTRIBUTION_INCOMPATIBLE",
  CURRENT_MAPPING_DISABLED: "CURRENT_MAPPING_DISABLED",
  CURRENT_MAPPING_MISSING: "CURRENT_MAPPING_MISSING",
  DIVERGES_FROM_RESOLVER: "DIVERGES_FROM_RESOLVER",
  SECTOR_APPLICABILITY_MISMATCH: "SECTOR_APPLICABILITY_MISMATCH",
});

function normalizeBatchSize(value) {
  if (!Number.isInteger(value)) return DEFAULT_BATCH_SIZE;
  if (value < MIN_BATCH_SIZE) return MIN_BATCH_SIZE;
  if (value > MAX_BATCH_SIZE) return MAX_BATCH_SIZE;
  return value;
}

// ---------------------------------------------------------------------------
// Structural checks — decided from the row alone. Pure and synchronous, so the
// whole contract is testable without a database.
// ---------------------------------------------------------------------------

// The closed status/confidence contract, straight from ownershipResolver:
//   RESOLVED   -> HIGH (exact IP) | HIGH/MEDIUM/LOW (CIDR by prefix) | LOW (ASN)
//   OVERRIDDEN -> CONFIRMED, always
//   AMBIGUOUS  -> null, always (no single confidence to report)
//   UNRESOLVED -> null, always
const ALLOWED_CONFIDENCE_BY_STATUS = Object.freeze({
  [OWNERSHIP_RESOLUTION_STATUS.RESOLVED]: [
    OWNERSHIP_CONFIDENCE.HIGH,
    OWNERSHIP_CONFIDENCE.MEDIUM,
    OWNERSHIP_CONFIDENCE.LOW,
  ],
  [OWNERSHIP_RESOLUTION_STATUS.OVERRIDDEN]: [OWNERSHIP_CONFIDENCE.CONFIRMED],
  [OWNERSHIP_RESOLUTION_STATUS.AMBIGUOUS]: [null],
  [OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED]: [null],
});

function checkRowStructure(row) {
  const issues = [];
  const confidence = row.confidence === undefined ? null : row.confidence;

  const allowed = ALLOWED_CONFIDENCE_BY_STATUS[row.status];
  if (!allowed || !allowed.includes(confidence)) {
    issues.push(CONSISTENCY_ISSUE.INVALID_STATUS_CONFIDENCE_COMBINATION);
  }

  if (row.status === OWNERSHIP_RESOLUTION_STATUS.RESOLVED && row.organizationId === null) {
    issues.push(CONSISTENCY_ISSUE.RESOLVED_WITHOUT_ORGANIZATION);
  }
  if (row.status === OWNERSHIP_RESOLUTION_STATUS.AMBIGUOUS && row.organizationId !== null) {
    issues.push(CONSISTENCY_ISSUE.AMBIGUOUS_WITH_ORGANIZATION);
  }
  if (row.status === OWNERSHIP_RESOLUTION_STATUS.UNRESOLVED && row.organizationId !== null) {
    issues.push(CONSISTENCY_ISSUE.UNRESOLVED_WITH_ORGANIZATION);
  }
  // An override is an analyst's own claim. If it carries a mapping id it is
  // silently depending on registry state it should be independent of — and a
  // later mapping change could appear to alter an explicit human decision.
  if (
    row.status === OWNERSHIP_RESOLUTION_STATUS.OVERRIDDEN &&
    row.matchedMappingId !== null
  ) {
    issues.push(CONSISTENCY_ISSUE.OVERRIDE_RELIES_ON_MAPPING);
  }
  // ISP attribution is the ASN tier's honesty flag: LOW confidence, RESOLVED,
  // and never an override. Anything else misrepresents how strong the claim is.
  if (row.isIspAttribution === true) {
    const compatible =
      (row.status === OWNERSHIP_RESOLUTION_STATUS.RESOLVED &&
        confidence === OWNERSHIP_CONFIDENCE.LOW) ||
      row.status === OWNERSHIP_RESOLUTION_STATUS.AMBIGUOUS;
    if (!compatible) issues.push(CONSISTENCY_ISSUE.ISP_ATTRIBUTION_INCOMPATIBLE);
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Divergence check — re-runs the authoritative resolver for one Finding.
// ---------------------------------------------------------------------------

async function checkRowAgainstResolver(client, finding, row, asOf) {
  const issues = [];

  // An explicit override is ALLOWED to differ from what the mapping registry
  // would say — that is what an override is for. Skip divergence entirely.
  if (row.status === OWNERSHIP_RESOLUTION_STATUS.OVERRIDDEN) return issues;

  if (Number.isInteger(row.matchedMappingId)) {
    const mapping = await client.assetMapping.findUnique({
      where: { id: row.matchedMappingId },
      select: { id: true, enabled: true },
    });
    if (!mapping) {
      issues.push(CONSISTENCY_ISSUE.CURRENT_MAPPING_MISSING);
    } else if (mapping.enabled === false) {
      // The current attribution rests on a mapping that has since been
      // disabled — the exact "stale after a mapping mutation" shape.
      issues.push(CONSISTENCY_ISSUE.CURRENT_MAPPING_DISABLED);
    }
  }

  const indicatorInt = isValidIpv4(finding.indicatorValue)
    ? ipv4ToInt(finding.indicatorValue)
    : null;

  const or = [];
  if (indicatorInt !== null) {
    or.push({ mappingType: "EXACT_IP", ipStart: indicatorInt, ipEnd: indicatorInt });
    or.push({ mappingType: "CIDR", ipStart: { lte: indicatorInt }, ipEnd: { gte: indicatorInt } });
  }
  const mappings =
    or.length > 0
      ? await client.assetMapping.findMany({ where: { enabled: true, OR: or } })
      : [];

  // asn: null — Finding stores no ASN (see findingOwnershipService's header),
  // so a row that legitimately came from the ASN tier at ingestion time cannot
  // be re-derived here. Excluded from divergence rather than reported as a
  // false positive.
  if (row.isIspAttribution === true) return issues;

  const expected = resolveOwnership(
    { indicatorValue: finding.indicatorValue, asn: null, asOf },
    { mappings, currentOverride: null }
  );

  if (
    expected.status !== row.status ||
    expected.organizationId !== row.organizationId ||
    expected.confidence !== (row.confidence === undefined ? null : row.confidence)
  ) {
    issues.push(CONSISTENCY_ISSUE.DIVERGES_FROM_RESOLVER);
  }

  return issues;
}

// Sector applicability implied by the row, compared against the locked Risk v1
// gate. Recomputing the gate here would be a second copy of a locked rule, so
// this asks riskInputSnapshot — the same function the engine scores with.
async function checkSectorApplicability(client, findingId, row) {
  // eslint-disable-next-line global-require
  const { loadOwnershipContext } = require("../risk/riskInputSnapshot");
  const context = await loadOwnershipContext(client, findingId);

  // What the row alone implies: a non-ISP RESOLVED/OVERRIDDEN row with an
  // organization and adequate confidence should be attributable.
  const impliedAttributable =
    row.organizationId !== null &&
    row.isIspAttribution !== true &&
    (row.status === OWNERSHIP_RESOLUTION_STATUS.OVERRIDDEN ||
      (row.status === OWNERSHIP_RESOLUTION_STATUS.RESOLVED &&
        [OWNERSHIP_CONFIDENCE.HIGH, OWNERSHIP_CONFIDENCE.MEDIUM].includes(row.confidence)));

  // A known-but-UNKNOWN sector legitimately makes an otherwise-attributable
  // row non-attributable, so it is not a mismatch.
  if (context.nonAttributableReason === "UNKNOWN_SECTOR") return [];

  return impliedAttributable === context.sectorAttributable
    ? []
    : [CONSISTENCY_ISSUE.SECTOR_APPLICABILITY_MISMATCH];
}

/**
 * Runs one BOUNDED consistency batch.
 *
 * @returns {Promise<object>} { checkedCount, issueCount, countsByCode,
 *   findingIdsByCode, truncated, nextAfterId } — never throws, never writes.
 */
async function checkOwnershipConsistency(client, options = {}) {
  const batchSize = normalizeBatchSize(options.batchSize);
  const afterId = Number.isInteger(options.afterId) && options.afterId > 0 ? options.afterId : 0;
  const asOf = options.asOf instanceof Date ? options.asOf : new Date();

  const countsByCode = {};
  const findingIdsByCode = {};
  Object.values(CONSISTENCY_ISSUE).forEach((code) => {
    countsByCode[code] = 0;
    findingIdsByCode[code] = [];
  });

  function record(findingId, code) {
    countsByCode[code] += 1;
    // Bounded: exact ids are for ADMIN diagnostics, but an unbounded id list
    // would turn one response into a full table export.
    if (findingIdsByCode[code].length < batchSize) findingIdsByCode[code].push(findingId);
  }

  // Current rows only, keyset-paginated on findingId — the same no-OFFSET
  // discipline as re-resolution.
  const rows = await client.findingOwnership.findMany({
    where: {
      currentForFindingId: { not: null },
      ...(afterId > 0 ? { findingId: { gt: afterId } } : {}),
    },
    orderBy: { findingId: "asc" },
    take: batchSize,
  });

  // Structural duplicate-current detection. The schema's @unique on
  // currentForFindingId should make this impossible; it is checked anyway so
  // that a dropped or altered constraint surfaces here instead of silently
  // corrupting every downstream metric.
  const seenFindingIds = new Set();

  const issues = [];
  for (const row of rows) {
    if (seenFindingIds.has(row.findingId)) {
      record(row.findingId, CONSISTENCY_ISSUE.DUPLICATE_CURRENT_ROW);
      issues.push({ findingId: row.findingId, code: CONSISTENCY_ISSUE.DUPLICATE_CURRENT_ROW });
    }
    seenFindingIds.add(row.findingId);

    checkRowStructure(row).forEach((code) => {
      record(row.findingId, code);
      issues.push({ findingId: row.findingId, code });
    });

    // eslint-disable-next-line no-await-in-loop
    const finding = await client.finding.findUnique({
      where: { id: row.findingId },
      select: { id: true, indicatorValue: true },
    });
    if (!finding) continue;

    // eslint-disable-next-line no-await-in-loop
    const divergence = await checkRowAgainstResolver(client, finding, row, asOf);
    divergence.forEach((code) => {
      record(row.findingId, code);
      issues.push({ findingId: row.findingId, code });
    });

    // eslint-disable-next-line no-await-in-loop
    const sector = await checkSectorApplicability(client, row.findingId, row);
    sector.forEach((code) => {
      record(row.findingId, code);
      issues.push({ findingId: row.findingId, code });
    });
  }

  return {
    checkedCount: rows.length,
    issueCount: issues.length,
    countsByCode,
    findingIdsByCode,
    truncated: rows.length === batchSize,
    nextAfterId: rows.length > 0 ? rows[rows.length - 1].findingId : afterId,
  };
}

/**
 * Audited wrapper for the ADMIN diagnostic endpoint.
 *
 * Audit payload carries COUNTS ONLY — never the per-code Finding id lists,
 * never an indicator. The ids go to the ADMIN caller in the response body; an
 * AuditLog row must not become a standing export of which hosts are affected.
 */
async function runAuditedConsistencyCheck(client, options = {}) {
  const auditContext = options.auditContext || {};

  try {
    await safeLogAuditEvent(
      {
        ...auditContext,
        action: CONSISTENCY_AUDIT_ACTIONS.REQUESTED,
        outcome: AUDIT_OUTCOMES.SUCCESS,
        entityType: AUDIT_ENTITY_TYPE,
        reason: "Bounded ownership consistency check requested",
      },
      { client }
    );
  } catch (error) {
    console.error("Ownership consistency audit failed", { name: error && error.name });
  }

  try {
    const report = await checkOwnershipConsistency(client, options);

    try {
      await safeLogAuditEvent(
        {
          ...auditContext,
          action: CONSISTENCY_AUDIT_ACTIONS.COMPLETED,
          outcome: AUDIT_OUTCOMES.SUCCESS,
          entityType: AUDIT_ENTITY_TYPE,
          after: {
            checkedCount: report.checkedCount,
            issueCount: report.issueCount,
            countsByCode: report.countsByCode,
            truncated: report.truncated,
          },
          reason: "Bounded ownership consistency check completed",
        },
        { client }
      );
    } catch (error) {
      console.error("Ownership consistency audit failed", { name: error && error.name });
    }

    return report;
  } catch (error) {
    try {
      await safeLogAuditEvent(
        {
          ...auditContext,
          action: CONSISTENCY_AUDIT_ACTIONS.FAILED,
          outcome: AUDIT_OUTCOMES.FAILURE,
          entityType: AUDIT_ENTITY_TYPE,
          reason: "Bounded ownership consistency check failed",
        },
        { client }
      );
    } catch (auditError) {
      console.error("Ownership consistency audit failed", { name: auditError && auditError.name });
    }
    throw error;
  }
}

module.exports = {
  CONSISTENCY_AUDIT_ACTIONS,
  CONSISTENCY_ISSUE,
  DEFAULT_BATCH_SIZE,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  ALLOWED_CONFIDENCE_BY_STATUS,
  normalizeBatchSize,
  checkRowStructure,
  checkOwnershipConsistency,
  runAuditedConsistencyCheck,
};
