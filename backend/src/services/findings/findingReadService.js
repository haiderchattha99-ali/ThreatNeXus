"use strict";

// Phase 6 — Findings as a readable surface.
//
// Why this exists: before Phase 6 a Finding could only be seen through a Case
// that already cited it, which made the triage step unreachable from the UI —
// an analyst had to know a Finding's id to act on it. These are pure reads over
// evidence Phases 1-3 already persist. Nothing here writes, and nothing here
// creates a Finding from a catalogue, a provider or an inference.
//
// Serialization rules enforced in this file:
//   - No raw provider payload, no provider key, no claim token, no lease token,
//     no HTTP status and no provider/exception text ever crosses the boundary.
//     IocEnrichment.errorMessage in particular is NEVER selected.
//   - Risk is reported exactly as stored, with its stored factor contributions.
//     Nothing is recomputed, re-bucketed or re-explained here — Risk v1 is a
//     locked contract and this is a read path.
//   - Pagination is bounded server-side; a caller cannot ask for everything.

const prisma = require("../../config/prisma");

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const FINDING_STATUSES = ["OPEN", "CLOSED"];
const RISK_BANDS = ["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const REPORT_TYPES = ["ACCESSIBLE_RDP"];
const SORTS = {
  lastSeen: { lastSeen: "desc" },
  firstSeen: { firstSeen: "desc" },
  occurrences: { occurrenceCount: "desc" },
  recurrences: { recurrenceCount: "desc" },
};

class FindingQueryError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "FindingQueryError";
    this.status = 400;
    this.field = field;
  }
}

/**
 * Validates and normalizes list query parameters.
 *
 * Invalid values are REJECTED with the offending field named, never silently
 * dropped or clamped to a default. A caller who mistypes a filter must find out,
 * rather than receiving a confidently wrong page of results.
 */
function parseListQuery(query = {}) {
  const out = {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    status: null,
    riskBand: null,
    reportType: null,
    indicator: null,
    sort: "lastSeen",
  };

  if (query.page !== undefined && query.page !== "") {
    const page = Number(query.page);
    if (!Number.isInteger(page) || page < 1) {
      throw new FindingQueryError("page must be an integer of 1 or more.", "page");
    }
    out.page = page;
  }

  if (query.pageSize !== undefined && query.pageSize !== "") {
    const size = Number(query.pageSize);
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw new FindingQueryError(
        `pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}.`,
        "pageSize"
      );
    }
    out.pageSize = size;
  }

  if (query.status !== undefined && query.status !== "") {
    if (!FINDING_STATUSES.includes(query.status)) {
      throw new FindingQueryError(`status must be one of ${FINDING_STATUSES.join(", ")}.`, "status");
    }
    out.status = query.status;
  }

  if (query.riskBand !== undefined && query.riskBand !== "") {
    if (!RISK_BANDS.includes(query.riskBand)) {
      throw new FindingQueryError(`riskBand must be one of ${RISK_BANDS.join(", ")}.`, "riskBand");
    }
    out.riskBand = query.riskBand;
  }

  if (query.reportType !== undefined && query.reportType !== "") {
    if (!REPORT_TYPES.includes(query.reportType)) {
      throw new FindingQueryError(
        `reportType must be one of ${REPORT_TYPES.join(", ")}.`,
        "reportType"
      );
    }
    out.reportType = query.reportType;
  }

  if (query.indicator !== undefined && query.indicator !== "") {
    const raw = String(query.indicator).trim();
    // Bounded, and restricted to the characters an IPv4 literal or prefix can
    // contain. This is a `startsWith` filter, not a free-text search, so there
    // is no leading-wildcard scan and nothing user-supplied reaches raw SQL.
    if (raw.length > 45 || !/^[0-9.]+$/.test(raw)) {
      throw new FindingQueryError(
        "indicator must be an IPv4 address or address prefix (digits and dots, 45 characters or fewer).",
        "indicator"
      );
    }
    out.indicator = raw;
  }

  if (query.sort !== undefined && query.sort !== "") {
    if (!Object.prototype.hasOwnProperty.call(SORTS, query.sort)) {
      throw new FindingQueryError(
        `sort must be one of ${Object.keys(SORTS).join(", ")}.`,
        "sort"
      );
    }
    out.sort = query.sort;
  }

  return out;
}

function buildWhere(params) {
  const where = {};
  if (params.status) where.status = params.status;
  if (params.reportType) where.reportType = params.reportType;
  if (params.indicator) where.indicatorValue = { startsWith: params.indicator };
  if (params.riskBand) {
    // Filters on the CURRENT score only. A Finding that was once CRITICAL and
    // has since been rescored must not appear under CRITICAL.
    where.riskScores = {
      some: { currentForFindingId: { not: null }, riskBand: params.riskBand },
    };
  }
  return where;
}

// Relation selections shared by list and detail. Each is filtered to the single
// current row and bounded with take:1, so a Finding with a long history costs
// the same as a new one and nothing here degrades into an N+1.
const CURRENT_OWNERSHIP = {
  where: { currentForFindingId: { not: null } },
  take: 1,
  select: {
    status: true,
    confidence: true,
    isIspAttribution: true,
    candidateCount: true,
    reasonCode: true,
    asOf: true,
    organization: { select: { id: true, name: true, sector: true } },
  },
};

const CURRENT_RISK = {
  where: { currentForFindingId: { not: null } },
  take: 1,
  select: {
    id: true,
    scoreBasisPoints: true,
    riskBand: true,
    algorithmVersion: true,
    configurationVersion: true,
    asOf: true,
    calculatedAt: true,
    trigger: true,
  },
};

const CURRENT_TRIAGE = {
  where: { currentForFindingId: { not: null } },
  take: 1,
  select: { decision: true, reason: true, decidedAt: true, caseId: true, source: true },
};

function serializeOwnership(rows) {
  const row = rows?.[0];
  if (!row) return null;
  return {
    status: row.status,
    confidence: row.confidence,
    isIspAttribution: row.isIspAttribution,
    candidateCount: row.candidateCount,
    reasonCode: row.reasonCode,
    asOf: row.asOf ? row.asOf.toISOString() : null,
    organization: row.organization
      ? { id: row.organization.id, name: row.organization.name, sector: row.organization.sector }
      : null,
  };
}

function serializeRisk(rows) {
  const row = rows?.[0];
  if (!row) return null;
  return {
    id: row.id,
    // displayScore is a pure projection of the stored basis points, exactly as
    // Phase 2 defined it. It is derived here, never stored, and never rounded
    // differently from the engine.
    displayScore: Math.floor(row.scoreBasisPoints / 100),
    scoreBasisPoints: row.scoreBasisPoints,
    riskBand: row.riskBand,
    algorithmVersion: row.algorithmVersion,
    configurationVersion: row.configurationVersion,
    asOf: row.asOf ? row.asOf.toISOString() : null,
    calculatedAt: row.calculatedAt ? row.calculatedAt.toISOString() : null,
    trigger: row.trigger,
  };
}

function serializeTriage(rows) {
  const row = rows?.[0];
  if (!row) return null;
  return {
    decision: row.decision,
    reason: row.reason || null,
    source: row.source,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    caseId: row.caseId || null,
  };
}

/** Bounded, paged Findings list with the current ownership/risk/triage projections. */
async function listFindings(query = {}, { client = prisma } = {}) {
  const params = parseListQuery(query);
  const where = buildWhere(params);

  const [total, rows] = await Promise.all([
    client.finding.count({ where }),
    client.finding.findMany({
      where,
      orderBy: [SORTS[params.sort], { id: "desc" }],
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: {
        id: true,
        indicatorValue: true,
        port: true,
        protocol: true,
        reportType: true,
        status: true,
        firstSeen: true,
        lastSeen: true,
        occurrenceCount: true,
        recurrenceCount: true,
        ownershipHistory: CURRENT_OWNERSHIP,
        riskScores: CURRENT_RISK,
        triageHistory: CURRENT_TRIAGE,
      },
    }),
  ]);

  return {
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    appliedFilters: {
      status: params.status,
      riskBand: params.riskBand,
      reportType: params.reportType,
      indicator: params.indicator,
      sort: params.sort,
    },
    items: rows.map((f) => ({
      id: f.id,
      indicatorValue: f.indicatorValue,
      port: f.port,
      protocol: f.protocol,
      reportType: f.reportType,
      status: f.status,
      firstSeen: f.firstSeen ? f.firstSeen.toISOString() : null,
      lastSeen: f.lastSeen ? f.lastSeen.toISOString() : null,
      occurrenceCount: f.occurrenceCount,
      recurrenceCount: f.recurrenceCount,
      ownership: serializeOwnership(f.ownershipHistory),
      risk: serializeRisk(f.riskScores),
      triage: serializeTriage(f.triageHistory),
    })),
  };
}

/**
 * Full evidence view for one Finding.
 *
 * Returns null when the id does not exist, so the controller can answer 404
 * without leaking whether the id is merely out of range.
 */
async function getFindingDetail(findingId, { client = prisma, occurrenceLimit = 25 } = {}) {
  const finding = await client.finding.findUnique({
    where: { id: findingId },
    select: {
      id: true,
      indicatorValue: true,
      port: true,
      protocol: true,
      reportType: true,
      status: true,
      firstSeen: true,
      lastSeen: true,
      occurrenceCount: true,
      recurrenceCount: true,
      closedAt: true,
      closureReason: true,
      closedThroughObservedAt: true,
      createdAt: true,
      ownershipHistory: CURRENT_OWNERSHIP,
      triageHistory: CURRENT_TRIAGE,
      riskScores: {
        where: { currentForFindingId: { not: null } },
        take: 1,
        select: {
          ...CURRENT_RISK.select,
          // The explanation is rendered from these stored rows, never generated.
          contributions: {
            orderBy: { displayOrder: "asc" },
            select: {
              factorKey: true,
              applicability: true,
              contributionBasisPoints: true,
              maximumContributionBasisPoints: true,
              normalizedInputValue: true,
              explanationCode: true,
              displayOrder: true,
            },
          },
        },
      },
      occurrences: {
        orderBy: { observedAt: "desc" },
        take: occurrenceLimit,
        select: {
          id: true,
          observedAt: true,
          action: true,
          rawReportId: true,
        },
      },
      vulnerabilityAssociations: {
        where: { currentAssociationKey: { not: null }, state: "ACTIVE" },
        take: 25,
        select: {
          id: true,
          state: true,
          evidenceSource: true,
          justification: true,
          effectiveAt: true,
          vulnerability: { select: { id: true, cveId: true } },
        },
      },
      caseLinks: {
        where: { currentLinkKey: { not: null }, state: "LINKED" },
        take: 25,
        select: {
          caseId: true,
          effectiveAt: true,
          case: { select: { caseReference: true, lifecycleState: true } },
        },
      },
    },
  });

  if (!finding) return null;

  // IOC enrichment is keyed on the indicator, not on the Finding, so it is
  // fetched separately. The select list is an allowlist: errorMessage,
  // httpStatus, claimToken, queryParams and every other operational/provider
  // field are deliberately absent and must stay absent.
  const enrichment = await client.iocEnrichment.findFirst({
    where: { indicator: finding.indicatorValue, activeCacheKey: { not: null } },
    orderBy: { queriedAt: "desc" },
    select: {
      provider: true,
      status: true,
      queriedAt: true,
      expiresAt: true,
      abuseConfidenceScore: true,
      totalReports: true,
      countryCode: true,
      usageType: true,
      isWhitelisted: true,
      lastReportedAt: true,
    },
  });

  const risk = finding.riskScores?.[0] || null;

  return {
    id: finding.id,
    indicatorValue: finding.indicatorValue,
    port: finding.port,
    protocol: finding.protocol,
    reportType: finding.reportType,
    status: finding.status,
    firstSeen: finding.firstSeen ? finding.firstSeen.toISOString() : null,
    lastSeen: finding.lastSeen ? finding.lastSeen.toISOString() : null,
    occurrenceCount: finding.occurrenceCount,
    recurrenceCount: finding.recurrenceCount,
    closedAt: finding.closedAt ? finding.closedAt.toISOString() : null,
    closureReason: finding.closureReason || null,
    closedThroughObservedAt: finding.closedThroughObservedAt
      ? finding.closedThroughObservedAt.toISOString()
      : null,
    ownership: serializeOwnership(finding.ownershipHistory),
    triage: serializeTriage(finding.triageHistory),
    risk: risk
      ? {
          ...serializeRisk([risk]),
          contributions: risk.contributions.map((c) => ({
            factorKey: c.factorKey,
            applicability: c.applicability,
            contributionBasisPoints: c.contributionBasisPoints,
            maximumContributionBasisPoints: c.maximumContributionBasisPoints,
            normalizedInputValue: c.normalizedInputValue,
            explanationCode: c.explanationCode,
            displayOrder: c.displayOrder,
          })),
        }
      : null,
    enrichment: enrichment
      ? {
          provider: enrichment.provider,
          status: enrichment.status,
          queriedAt: enrichment.queriedAt ? enrichment.queriedAt.toISOString() : null,
          expiresAt: enrichment.expiresAt ? enrichment.expiresAt.toISOString() : null,
          abuseConfidenceScore: enrichment.abuseConfidenceScore,
          totalReports: enrichment.totalReports,
          countryCode: enrichment.countryCode,
          usageType: enrichment.usageType,
          isWhitelisted: enrichment.isWhitelisted,
          lastReportedAt: enrichment.lastReportedAt
            ? enrichment.lastReportedAt.toISOString()
            : null,
        }
      : null,
    vulnerabilities: finding.vulnerabilityAssociations.map((v) => ({
      id: v.id,
      cveId: v.vulnerability?.cveId || null,
      state: v.state,
      evidenceSource: v.evidenceSource,
      justification: v.justification,
      effectiveAt: v.effectiveAt ? v.effectiveAt.toISOString() : null,
    })),
    caseLinks: finding.caseLinks.map((l) => ({
      caseId: l.caseId,
      caseReference: l.case?.caseReference || null,
      lifecycleState: l.case?.lifecycleState || null,
      effectiveAt: l.effectiveAt ? l.effectiveAt.toISOString() : null,
    })),
    occurrences: finding.occurrences.map((o) => ({
      id: o.id,
      observedAt: o.observedAt ? o.observedAt.toISOString() : null,
      action: o.action,
      rawReportId: o.rawReportId,
    })),
    occurrenceLimit,
  };
}

module.exports = {
  listFindings,
  getFindingDetail,
  parseListQuery,
  FindingQueryError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};
