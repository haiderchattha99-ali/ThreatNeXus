"use strict";

// ===========================================================================
// P2-T3 — Append-only risk scoring persistence.
//
// One entry point: calculateAndPersistRisk(). It loads normalized inputs at an
// explicit asOf, runs the pure engine, and either recognises that nothing
// changed (UNCHANGED, no write at all) or appends a brand new immutable
// snapshot with a complete set of factor contributions.
//
// Concurrency strategy is a direct copy of findingOwnershipService.js, which
// itself copies dedupService.js — same mechanism, same reason:
//
//   * the whole load -> calculate -> persist cycle runs inside ONE Prisma
//     interactive transaction at SERIALIZABLE isolation;
//   * a recognised concurrency error (P2002 on the currentForFindingId unique
//     race, P2034 write conflict/deadlock) re-runs the ENTIRE transaction from
//     scratch, re-reading committed state every attempt;
//   * no error is EVER caught inside the transaction — a caught P2002 leaves
//     the surrounding PostgreSQL transaction aborted at 25P02, so every
//     subsequent query in it would fail. Recovery must re-run the whole thing.
//
// That is what keeps "at most one current score per Finding" true under
// concurrent rescoring without a raw SQL partial index and without ever using
// updatedAt as a version token.
//
// Scoring performs no network I/O of any kind, so nothing external is ever
// called from inside a transaction.
// ===========================================================================

const { loadRiskInputSnapshot, RiskFindingNotFoundError } = require("./riskInputSnapshot");
const { calculateRisk } = require("./riskEngine");
const { RISK_CONFIGURATION } = require("./riskConfiguration");

const PRISMA_UNIQUE_VIOLATION = "P2002";
const PRISMA_TRANSACTION_CONFLICT = "P2034";
const RETRYABLE_ERROR_CODES = Object.freeze([PRISMA_UNIQUE_VIOLATION, PRISMA_TRANSACTION_CONFLICT]);
const MAX_TRANSACTION_ATTEMPTS = 5;
const TRANSACTION_ISOLATION_LEVEL = "Serializable";

const MAX_JUSTIFICATION_LENGTH = 1000;

// Closed outcome vocabulary. Callers branch on these, never on a message.
const RISK_CALCULATION_OUTCOME = Object.freeze({
  CREATED: "CREATED",
  UNCHANGED: "UNCHANGED",
});

const RISK_TRIGGERS = Object.freeze({
  INGESTION: "INGESTION",
  ENRICHMENT_COMPLETED: "ENRICHMENT_COMPLETED",
  OWNERSHIP_CHANGED: "OWNERSHIP_CHANGED",
  MANUAL: "MANUAL",
  SYSTEM_RECALCULATION: "SYSTEM_RECALCULATION",
});

const RISK_TRIGGER_VALUES = Object.freeze(Object.values(RISK_TRIGGERS));

class RiskScoringValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RiskScoringValidationError";
  }
}

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

function isRetryableConcurrencyError(error) {
  return Boolean(error && RETRYABLE_ERROR_CODES.includes(error.code));
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

function assertValidFindingId(findingId) {
  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new RiskScoringValidationError("findingId must be a positive integer");
  }
  return findingId;
}

function assertValidAsOf(asOf) {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new RiskScoringValidationError("asOf must be a valid Date");
  }
  return asOf;
}

function assertValidTrigger(trigger) {
  if (!RISK_TRIGGER_VALUES.includes(trigger)) {
    throw new RiskScoringValidationError(
      `trigger must be one of ${RISK_TRIGGER_VALUES.join(", ")}`
    );
  }
  return trigger;
}

// Bounded and trimmed. Only a MANUAL recalculation carries one; it is analyst
// prose, never provider or exception text.
function normalizeJustification(justification) {
  if (justification === undefined || justification === null) return null;
  if (typeof justification !== "string") {
    throw new RiskScoringValidationError("justification must be a string");
  }
  const trimmed = justification.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_JUSTIFICATION_LENGTH) {
    throw new RiskScoringValidationError(
      `justification must be at most ${MAX_JUSTIFICATION_LENGTH} characters`
    );
  }
  return trimmed;
}

function normalizeActorUserId(actorUserId) {
  if (actorUserId === undefined || actorUserId === null) return null;
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    throw new RiskScoringValidationError("actorUserId must be a positive integer when provided");
  }
  return actorUserId;
}

async function loadCurrentScoreRow(tx, findingId) {
  return tx.riskScore.findUnique({ where: { currentForFindingId: findingId } });
}

/**
 * "Same approved input state" means the exact same normalized inputs scored
 * under the exact same numeric contract. asOf is deliberately NOT part of the
 * comparison — otherwise every rescore would append an identical snapshot and
 * flood history. Real time-driven change still registers, because the elapsed
 * day bucket is itself part of the input fingerprint.
 */
function representsSameInputState(currentRow, calculation) {
  if (!currentRow) return false;
  return (
    currentRow.inputFingerprint === calculation.inputFingerprint &&
    currentRow.configurationVersion === calculation.configurationVersion &&
    currentRow.algorithmVersion === calculation.algorithmVersion
  );
}

/**
 * Calculates and, when the input state has genuinely changed, persists one new
 * immutable risk snapshot for one Finding.
 *
 * The score row and ALL of its factor contributions are written in the same
 * transaction as the supersession of the previous current row, so there is
 * never a partial snapshot: either a complete score with a full contribution
 * set becomes current, or nothing changes and the prior current row stands.
 *
 * @returns {Promise<{outcome: string, riskScore: object|null, contributions: array, calculation: object}>}
 */
async function calculateAndPersistRisk(params = {}) {
  const client = resolveClient(params.client);
  const findingId = assertValidFindingId(params.findingId);
  const asOf = assertValidAsOf(params.asOf);
  const trigger = assertValidTrigger(params.trigger);
  const justification = normalizeJustification(params.justification);
  const actorUserId = normalizeActorUserId(params.actorUserId);
  const configuration = params.configuration || RISK_CONFIGURATION;

  return runInRetryableTransaction(client, async (tx) => {
    // Load and calculate INSIDE the transaction so a retry re-reads genuinely
    // fresh committed state rather than re-persisting a stale calculation.
    const inputSnapshot = await loadRiskInputSnapshot(findingId, {
      client: tx,
      asOf,
      provider: params.provider,
      indicatorType: params.indicatorType,
    });
    const calculation = calculateRisk({ configuration, inputSnapshot });

    const currentRow = await loadCurrentScoreRow(tx, findingId);

    if (representsSameInputState(currentRow, calculation)) {
      const contributions = await tx.riskFactorContribution.findMany({
        where: { riskScoreId: currentRow.id },
        orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
      });
      return {
        outcome: RISK_CALCULATION_OUTCOME.UNCHANGED,
        riskScore: currentRow,
        contributions,
        calculation,
      };
    }

    if (currentRow) {
      // Supersession is the ONE permitted mutation of a historical row, and it
      // touches only the pointer and the timestamp — never the score, the
      // band, or any contribution.
      await tx.riskScore.update({
        where: { id: currentRow.id },
        data: { supersededAt: asOf, currentForFindingId: null },
      });
    }

    const created = await tx.riskScore.create({
      data: {
        findingId,
        algorithmVersion: calculation.algorithmVersion,
        configurationVersion: calculation.configurationVersion,
        configurationFingerprint: calculation.configurationFingerprint,
        inputFingerprint: calculation.inputFingerprint,
        scoreBasisPoints: calculation.scoreBasisPoints,
        riskBand: calculation.riskBand,
        asOf,
        trigger,
        actorUserId,
        justification,
        currentForFindingId: findingId,
      },
    });

    await tx.riskFactorContribution.createMany({
      data: calculation.contributions.map((row) => ({
        riskScoreId: created.id,
        factorKey: row.factorKey,
        applicability: row.applicability,
        contributionBasisPoints: row.contributionBasisPoints,
        maximumContributionBasisPoints: row.maximumContributionBasisPoints,
        normalizedInputValue: row.normalizedInputValue,
        explanationCode: row.explanationCode,
        evidenceSnapshot: row.evidenceSnapshot === null ? undefined : row.evidenceSnapshot,
        displayOrder: row.displayOrder,
      })),
    });

    const contributions = await tx.riskFactorContribution.findMany({
      where: { riskScoreId: created.id },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
    });

    return {
      outcome: RISK_CALCULATION_OUTCOME.CREATED,
      riskScore: created,
      contributions,
      calculation,
    };
  });
}

module.exports = {
  RISK_CALCULATION_OUTCOME,
  RISK_TRIGGERS,
  RISK_TRIGGER_VALUES,
  RiskScoringValidationError,
  RiskFindingNotFoundError,
  MAX_JUSTIFICATION_LENGTH,
  MAX_TRANSACTION_ATTEMPTS,
  representsSameInputState,
  calculateAndPersistRisk,
};
