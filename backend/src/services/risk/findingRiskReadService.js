"use strict";

// ===========================================================================
// P2-T3 — Finding risk read service.
//
// Returns the current risk snapshot plus bounded, paginated history for one
// Finding, with explanations rendered ONLY from persisted rows.
//
// The rule this module exists to hold: an old score explains itself from its
// own stored contributions. We never re-query live Finding / ownership /
// enrichment state to describe a historical score, because that would make a
// past explanation silently change when today's data changes — the exact
// failure that makes a scoring system untrustworthy in review.
//
// The serializer is an allow-list. inputFingerprint and
// configurationFingerprint are exposed deliberately (they are analyst-facing
// evidence that two scores were computed from identical inputs under an
// identical contract, and neither is a secret), but nothing else internal is:
// no cache key, no claim token, no raw CSV, no provider payload, no error
// text, no database row dump.
// ===========================================================================

const { resolveDisplayScore } = require("./riskConfiguration");
const { renderScoreExplanation } = require("./riskExplanation");

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

class FindingRiskValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "FindingRiskValidationError";
  }
}

class FindingRiskNotFoundError extends Error {
  constructor(findingId) {
    super(`Finding ${findingId} not found`);
    this.name = "FindingRiskNotFoundError";
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
    throw new FindingRiskValidationError("findingId must be a positive integer");
  }
  return findingId;
}

function normalizePage(page) {
  if (page === undefined || page === null) return DEFAULT_PAGE;
  const parsed = Number(page);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new FindingRiskValidationError("page must be a positive integer");
  }
  return parsed;
}

function normalizePageSize(pageSize) {
  if (pageSize === undefined || pageSize === null) return DEFAULT_PAGE_SIZE;
  const parsed = Number(pageSize);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new FindingRiskValidationError("pageSize must be a positive integer");
  }
  return parsed > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : parsed;
}

// Allow-listed contribution shape. evidenceSnapshot is passed through because
// the writer already bounded it to small scalar keys, but it is defensively
// re-checked here so a malformed legacy row cannot emit something unbounded.
function serializeContribution(row) {
  return {
    factorKey: row.factorKey,
    applicability: row.applicability,
    contributionBasisPoints: row.contributionBasisPoints,
    maximumContributionBasisPoints: row.maximumContributionBasisPoints,
    normalizedInputValue: row.normalizedInputValue,
    explanationCode: row.explanationCode,
    evidenceSummary: safeEvidence(row.evidenceSnapshot),
    displayOrder: row.displayOrder,
  };
}

const MAX_EVIDENCE_KEYS = 8;
const MAX_EVIDENCE_STRING_LENGTH = 64;

function safeEvidence(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const out = {};
  Object.keys(snapshot)
    .sort()
    .slice(0, MAX_EVIDENCE_KEYS)
    .forEach((key) => {
      const value = snapshot[key];
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
      else if (typeof value === "boolean") out[key] = value;
      else if (typeof value === "string") out[key] = value.slice(0, MAX_EVIDENCE_STRING_LENGTH);
      // Anything else (nested object, array, null) is dropped rather than
      // forwarded — an evidence summary is scalars only.
    });
  return Object.keys(out).length > 0 ? out : null;
}

function serializeScore(scoreRow, contributionRows) {
  if (!scoreRow) return null;
  const contributions = (contributionRows || []).map(serializeContribution);
  const explanation = renderScoreExplanation(scoreRow, contributionRows || []);

  return {
    id: scoreRow.id,
    findingId: scoreRow.findingId,
    scoreBasisPoints: scoreRow.scoreBasisPoints,
    displayScore: resolveDisplayScore(scoreRow.scoreBasisPoints),
    riskBand: scoreRow.riskBand,
    algorithmVersion: scoreRow.algorithmVersion,
    configurationVersion: scoreRow.configurationVersion,
    configurationFingerprint: scoreRow.configurationFingerprint,
    inputFingerprint: scoreRow.inputFingerprint,
    asOf: scoreRow.asOf,
    calculatedAt: scoreRow.calculatedAt,
    trigger: scoreRow.trigger,
    supersededAt: scoreRow.supersededAt,
    isCurrent: scoreRow.currentForFindingId !== null,
    justification: scoreRow.justification,
    contributions,
    explanation,
  };
}

async function loadContributionsFor(client, scoreIds) {
  if (scoreIds.length === 0) return new Map();
  const rows = await client.riskFactorContribution.findMany({
    where: { riskScoreId: { in: scoreIds } },
    orderBy: [{ riskScoreId: "asc" }, { displayOrder: "asc" }, { id: "asc" }],
  });
  const byScore = new Map();
  rows.forEach((row) => {
    if (!byScore.has(row.riskScoreId)) byScore.set(row.riskScoreId, []);
    byScore.get(row.riskScoreId).push(row);
  });
  return byScore;
}

/**
 * Current score + bounded history for one Finding.
 *
 * @param {number} findingId
 * @param {object} [options] { client, includeHistory, page, pageSize }
 */
async function getFindingRisk(findingId, options = {}) {
  const client = resolveClient(options.client);
  const id = assertValidFindingId(findingId);
  const includeHistory = options.includeHistory === undefined ? true : Boolean(options.includeHistory);
  const page = normalizePage(options.page);
  const pageSize = normalizePageSize(options.pageSize);

  const finding = await client.finding.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!finding) throw new FindingRiskNotFoundError(id);

  const currentRow = await client.riskScore.findUnique({ where: { currentForFindingId: id } });

  let history = [];
  let totalHistory = 0;
  if (includeHistory) {
    totalHistory = await client.riskScore.count({ where: { findingId: id } });
    history = await client.riskScore.findMany({
      where: { findingId: id },
      orderBy: [{ calculatedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
  }

  const scoreIds = [];
  if (currentRow) scoreIds.push(currentRow.id);
  history.forEach((row) => {
    if (!scoreIds.includes(row.id)) scoreIds.push(row.id);
  });
  const contributionsByScore = await loadContributionsFor(client, scoreIds);

  return {
    findingId: id,
    findingStatus: finding.status,
    current: currentRow ? serializeScore(currentRow, contributionsByScore.get(currentRow.id) || []) : null,
    history: includeHistory
      ? history.map((row) => serializeScore(row, contributionsByScore.get(row.id) || []))
      : [],
    pagination: includeHistory
      ? {
          page,
          pageSize,
          totalItems: totalHistory,
          totalPages: totalHistory === 0 ? 0 : Math.ceil(totalHistory / pageSize),
        }
      : null,
  };
}

module.exports = {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  FindingRiskValidationError,
  FindingRiskNotFoundError,
  serializeContribution,
  serializeScore,
  safeEvidence,
  getFindingRisk,
};
