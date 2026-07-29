"use strict";

// ===========================================================================
// P2-T3 — Normalized risk input snapshot.
//
// Loads every input the locked v1 contract scores, for ONE Finding, at ONE
// explicit asOf, and normalizes it into a small canonical object plus a
// deterministic inputFingerprint.
//
// Boundaries this module holds:
//   * The wall clock is never read. `asOf` is always supplied by the caller
//     and is the only "now" that exists here.
//   * Persistence and recurrence come from immutable FindingOccurrence
//     evidence, never from Finding.occurrenceCount/recurrenceCount (mutable
//     projections) and never from updatedAt.
//   * DEAD_LETTER, PENDING, stale and every provider failure are distinct
//     unavailable states. None of them can ever be read as clean reputation.
//   * ASN/ISP attribution never counts as confirmed ownership.
//   * Nothing raw is carried: no provider response, no cacheKey, no claim
//     token, no CSV row, no actor name, no secret. Only bounded scalars.
// ===========================================================================

const {
  RISK_ALGORITHM_VERSION,
  RISK_CONFIGURATION_VERSION,
  RISK_CONFIGURATION_FINGERPRINT,
  MAX_NORMALIZED_DAYS,
  MILLISECONDS_PER_DAY,
  SECTOR_ATTRIBUTABLE_RESOLVED_CONFIDENCES,
  canonicalize,
} = require("./riskConfiguration");

const {
  loadVulnerabilityRiskContext,
} = require("../vulnerability/vulnerabilityRiskContext");

const crypto = require("crypto");

const DEFAULT_ENRICHMENT_PROVIDER = "abuseipdb";
const DEFAULT_INDICATOR_TYPE = "IPV4";

// Reputation-bearing provider statuses. Only these two mean "the provider
// actually answered a question about this address". Everything else is an
// absence of context, never context itself.
const REPUTATION_BEARING_STATUSES = Object.freeze(["SUCCESS", "NOT_FOUND"]);

class RiskInputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RiskInputValidationError";
  }
}

class RiskFindingNotFoundError extends Error {
  constructor(findingId) {
    super(`Finding ${findingId} not found`);
    this.name = "RiskFindingNotFoundError";
    this.findingId = findingId;
  }
}

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

function assertValidFindingId(findingId) {
  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new RiskInputValidationError("findingId must be a positive integer");
  }
  return findingId;
}

function assertValidAsOf(asOf) {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new RiskInputValidationError("asOf must be a valid Date");
  }
  return asOf;
}

function isUsableDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Whole elapsed days between two instants, floor, integer arithmetic only.
 * Returns null when the interval is undefined or runs backwards — a future or
 * malformed start instant fails closed rather than clamping to "0 days", so a
 * corrupt timestamp is visibly missing context instead of a clean signal.
 */
function elapsedWholeDays(fromDate, toDate) {
  if (!isUsableDate(fromDate) || !isUsableDate(toDate)) return null;
  const deltaMs = toDate.getTime() - fromDate.getTime();
  if (deltaMs < 0) return null;
  const days = Math.floor(deltaMs / MILLISECONDS_PER_DAY);
  return days > MAX_NORMALIZED_DAYS ? MAX_NORMALIZED_DAYS : days;
}

async function loadFinding(client, findingId) {
  const finding = await client.finding.findUnique({ where: { id: findingId } });
  if (!finding) throw new RiskFindingNotFoundError(findingId);
  return finding;
}

/**
 * Immutable lifecycle evidence at or before asOf.
 *
 * observationCount counts EVERY occurrence action (CREATED / PERSISTED /
 * RECURRED / HISTORICAL): each row is exactly one distinct accepted report
 * that observed this exposure, and Phase 1 already guarantees one occurrence
 * per (finding, report) with duplicate in-report rows collapsed.
 *
 * recurredCount counts only RECURRED, which the Phase 1 lifecycle writes only
 * when a manually closed finding is observed again — so recurrence means
 * "came back after a human closed it", never ordinary persistence.
 */
async function loadOccurrenceEvidence(client, findingId, asOf) {
  const occurrences = await client.findingOccurrence.findMany({
    where: { findingId, observedAt: { lte: asOf } },
    select: { action: true, observedAt: true },
    orderBy: [{ observedAt: "asc" }, { id: "asc" }],
  });

  let recurredCount = 0;
  let latestRecurrenceAt = null;

  occurrences.forEach((row) => {
    if (row.action !== "RECURRED") return;
    recurredCount += 1;
    if (!latestRecurrenceAt || row.observedAt.getTime() > latestRecurrenceAt.getTime()) {
      latestRecurrenceAt = row.observedAt;
    }
  });

  return {
    observationCount: occurrences.length,
    recurredCount,
    latestRecurrenceAt,
  };
}

/**
 * The current ownership row plus, only when ownership is strong enough to
 * attribute, the owning organization's sector.
 *
 * Ownership contributes NO basis points. It appears here purely as context and
 * as the applicability gate for sectorCriticality (architect amendment 2):
 *
 *   A. OVERRIDDEN + organizationId + not ISP            -> attributable
 *   B. RESOLVED   + organizationId + not ISP
 *                 + confidence HIGH/MEDIUM              -> attributable
 *
 * Everything else — no row, AMBIGUOUS, UNRESOLVED, missing org, ISP
 * attribution, RESOLVED with LOW confidence — is not attributable, and the
 * reason is recorded so the explanation can say which one it was.
 */
async function loadOwnershipContext(client, findingId) {
  const current = await client.findingOwnership.findUnique({
    where: { currentForFindingId: findingId },
  });

  if (!current) {
    return {
      present: false,
      status: null,
      confidence: null,
      isIspAttribution: false,
      organizationId: null,
      sector: null,
      sectorAttributable: false,
      nonAttributableReason: "NO_OWNERSHIP",
    };
  }

  const base = {
    present: true,
    status: current.status,
    confidence: current.confidence || null,
    isIspAttribution: current.isIspAttribution === true,
    organizationId: Number.isInteger(current.organizationId) ? current.organizationId : null,
    sector: null,
    sectorAttributable: false,
    nonAttributableReason: null,
  };

  if (base.status === "AMBIGUOUS") {
    return { ...base, nonAttributableReason: "AMBIGUOUS" };
  }
  if (base.status === "UNRESOLVED") {
    return { ...base, nonAttributableReason: "UNRESOLVED" };
  }
  if (base.isIspAttribution) {
    // Checked before organizationId so an ASN match that did resolve an org
    // still reports the honest reason: this is an ISP, not the victim.
    return { ...base, nonAttributableReason: "ISP_ATTRIBUTION" };
  }
  if (base.organizationId === null) {
    return { ...base, nonAttributableReason: "NO_ORGANIZATION" };
  }
  if (
    base.status === "RESOLVED" &&
    !SECTOR_ATTRIBUTABLE_RESOLVED_CONFIDENCES.includes(base.confidence)
  ) {
    return { ...base, nonAttributableReason: "LOW_CONFIDENCE" };
  }
  if (base.status !== "RESOLVED" && base.status !== "OVERRIDDEN") {
    return { ...base, nonAttributableReason: "UNRESOLVED" };
  }

  const organization = await client.organization.findUnique({
    where: { id: base.organizationId },
    select: { sector: true },
  });
  const sector = organization ? organization.sector : null;

  if (!sector || sector === "UNKNOWN") {
    // An explicitly unknown sector is missing context, never the least risky
    // sector. It scores 0 as NOT_AVAILABLE, not as GENERAL.
    return { ...base, sector: sector || null, nonAttributableReason: "UNKNOWN_SECTOR" };
  }

  return { ...base, sector, sectorAttributable: true, nonAttributableReason: null };
}

/**
 * Reputation context for the finding's canonical indicator at asOf.
 *
 * Two reads, in priority order:
 *   1. the newest reputation-bearing row (SUCCESS / NOT_FOUND) — the only rows
 *      that represent the provider actually answering;
 *   2. failing that, the newest row of any status, so the explanation can name
 *      the exact failure (RATE_LIMITED / TIMEOUT / DEAD_LETTER / PENDING ...)
 *      instead of collapsing everything into "absent".
 *
 * Freshness is the half-open window [queriedAt, expiresAt) evaluated at asOf,
 * matching iocEnrichmentRepository.findFreshCachedResult exactly.
 */
async function loadEnrichmentContext(client, { indicator, asOf, provider, indicatorType }) {
  const scope = { provider, indicatorType, indicator };

  const reputationRows = await client.iocEnrichment.findMany({
    where: { ...scope, status: { in: REPUTATION_BEARING_STATUSES }, queriedAt: { not: null } },
    orderBy: [{ queriedAt: "desc" }, { id: "desc" }],
    take: 1,
  });
  const reputationRow = reputationRows[0] || null;

  if (reputationRow) {
    const queriedAt = reputationRow.queriedAt;
    const expiresAt = reputationRow.expiresAt;
    const fresh =
      isUsableDate(queriedAt) &&
      isUsableDate(expiresAt) &&
      queriedAt.getTime() <= asOf.getTime() &&
      expiresAt.getTime() > asOf.getTime();

    if (!fresh) {
      return { present: true, status: reputationRow.status, fresh: false, abuseConfidenceScore: null };
    }
    return {
      present: true,
      status: reputationRow.status,
      fresh: true,
      abuseConfidenceScore:
        reputationRow.status === "SUCCESS" && Number.isInteger(reputationRow.abuseConfidenceScore)
          ? reputationRow.abuseConfidenceScore
          : null,
    };
  }

  const anyRows = await client.iocEnrichment.findMany({
    where: scope,
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    take: 1,
  });
  const anyRow = anyRows[0] || null;
  if (!anyRow) {
    return { present: false, status: null, fresh: false, abuseConfidenceScore: null };
  }
  return { present: true, status: anyRow.status, fresh: false, abuseConfidenceScore: null };
}

/**
 * Vulnerability context (§2B Packet A).
 *
 * Delegated in full to vulnerabilityRiskContext.loadVulnerabilityRiskContext,
 * which is the ONE place persisted CVE evidence becomes Risk v1 input. It reads
 * only current ACTIVE analyst-verified associations and only fresh SUCCESS
 * provider results attached to COMPLETED jobs.
 *
 * A CVE is NEVER inferred from TCP/3389, from an exposed RDP service, or from
 * any provider search — the sole source is an explicit human assertion.
 *
 * Failure is not swallowed here: a broken vulnerability read is a genuine
 * scoring failure, and silently substituting "no CVEs" would turn missing
 * evidence into a clean answer — precisely the collapse this contract exists to
 * prevent. The caller's failure isolation (riskRecalculationService) is what
 * keeps such a failure from disturbing the evidence that triggered the score.
 */
async function loadVulnerabilityContext(client, findingId, asOf) {
  return loadVulnerabilityRiskContext(findingId, { client, asOf });
}

/**
 * Builds the canonical, bounded, serializable snapshot plus its fingerprint.
 *
 * The fingerprint covers algorithm version, configuration version and every
 * normalized factor input — and deliberately NOT: row ids, row ordering,
 * updatedAt, calculatedAt, actor identity, or asOf itself. Excluding asOf is
 * what makes "nothing about this finding changed" return UNCHANGED rather than
 * appending an identical snapshot on every rescore; the elapsed-day bucket is
 * already part of the fingerprint, so real time-driven change is still caught.
 */
function buildInputFingerprint(normalized) {
  const canonical = canonicalize({
    algorithmVersion: RISK_ALGORITHM_VERSION,
    configurationVersion: RISK_CONFIGURATION_VERSION,
    configurationFingerprint: RISK_CONFIGURATION_FINGERPRINT,
    inputs: normalized,
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function loadRiskInputSnapshot(findingId, options = {}) {
  const client = resolveClient(options.client);
  const id = assertValidFindingId(findingId);
  const asOf = assertValidAsOf(options.asOf);
  const provider =
    typeof options.provider === "string" && options.provider.trim() !== ""
      ? options.provider.trim()
      : DEFAULT_ENRICHMENT_PROVIDER;
  const indicatorType =
    typeof options.indicatorType === "string" && options.indicatorType.trim() !== ""
      ? options.indicatorType.trim()
      : DEFAULT_INDICATOR_TYPE;

  const finding = await loadFinding(client, id);
  const occurrence = await loadOccurrenceEvidence(client, id, asOf);
  const ownership = await loadOwnershipContext(client, id);
  const enrichment = await loadEnrichmentContext(client, {
    indicator: finding.indicatorValue,
    asOf,
    provider,
    indicatorType,
  });
  const vulnerability = await loadVulnerabilityContext(client, id, asOf);

  // The current unresolved episode starts at the latest RECURRED observation
  // when the finding has recurred, otherwise at firstSeen. Time spent CLOSED
  // is therefore never counted as unresolved time (architect amendment 3).
  const unresolvedSince = occurrence.latestRecurrenceAt || finding.firstSeen;
  const isOpen = finding.status === "OPEN";
  const daysUnresolved = isOpen ? elapsedWholeDays(unresolvedSince, asOf) : null;

  const normalized = {
    reportType: finding.reportType,
    protocol: finding.protocol,
    port: finding.port,
    findingStatus: finding.status,

    observationCount: occurrence.observationCount,
    recurredCount: occurrence.recurredCount,

    // null for a CLOSED finding (NOT_APPLICABLE) and for an invalid or future
    // episode start (NOT_AVAILABLE); the engine tells those two apart using
    // findingStatus, so the distinction survives into the stored explanation.
    daysUnresolved,

    enrichmentPresent: enrichment.present,
    enrichmentStatus: enrichment.status,
    enrichmentFresh: enrichment.fresh,
    abuseConfidenceScore: enrichment.abuseConfidenceScore,

    ownershipStatus: ownership.status,
    ownershipConfidence: ownership.confidence,
    ownershipIsIspAttribution: ownership.isIspAttribution,
    sectorAttributable: ownership.sectorAttributable,
    sectorNonAttributableReason: ownership.nonAttributableReason,
    sector: ownership.sectorAttributable ? ownership.sector : null,

    // The canonical, deterministically sorted ACTIVE CVE list. Included in the
    // fingerprint so attaching or removing a CVE is a genuine input change,
    // and sorted canonically so the fingerprint never depends on row order.
    activeCveIds: vulnerability.activeCveIds,
    cvePresent: vulnerability.cvePresent,
    kevListed: vulnerability.kevListed,
    kevLookupAvailable: vulnerability.kevLookupAvailable,
    // Bounded normalized evidence context: WHICH CVE supplied the listing and
    // WHICH supplied the selected maximum probability. Both are canonical CVE
    // strings, never a row id, a description, or provider error text. They are
    // fingerprinted because they are stored as contribution evidence — if the
    // naming changed but the fingerprint did not, an old explanation would keep
    // citing a CVE that no longer supplies the number.
    kevListedCveId: vulnerability.kevListedCveId,
    epssBasisPoints: vulnerability.epssBasisPoints,
    epssSelectedCveId: vulnerability.epssSelectedCveId,
  };

  return Object.freeze({
    findingId: id,
    asOf: new Date(asOf.getTime()),
    algorithmVersion: RISK_ALGORITHM_VERSION,
    configurationVersion: RISK_CONFIGURATION_VERSION,
    configurationFingerprint: RISK_CONFIGURATION_FINGERPRINT,
    inputs: Object.freeze(normalized),
    inputFingerprint: buildInputFingerprint(normalized),
  });
}

module.exports = {
  RiskInputValidationError,
  RiskFindingNotFoundError,
  DEFAULT_ENRICHMENT_PROVIDER,
  DEFAULT_INDICATOR_TYPE,
  REPUTATION_BEARING_STATUSES,
  elapsedWholeDays,
  buildInputFingerprint,
  loadRiskInputSnapshot,
};
