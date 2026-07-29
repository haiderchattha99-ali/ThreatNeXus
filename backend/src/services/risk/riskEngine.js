"use strict";

// ===========================================================================
// P2-T3 — The pure deterministic risk engine.
//
// calculateRisk({ configuration, inputSnapshot }) -> frozen result.
//
// This module has NO database access, NO filesystem access, NO network, NO
// wall clock, NO randomness and NO AI. Given the same configuration and the
// same snapshot it returns byte-identical output forever.
//
// Every approved factor emits exactly one contribution on every run —
// including NOT_AVAILABLE and NOT_APPLICABLE ones — so a stored explanation
// can never silently omit missing context. Only APPLIED contributions may be
// non-zero; the other two are structurally forced to 0 by finalizeFactor.
//
// There is one explicit evaluator per factor. This is deliberately not a
// generic rules interpreter: the numbers live in riskConfiguration.js, the
// meaning lives here in named code that a reviewer can read top to bottom.
// ===========================================================================

const {
  RISK_CONFIGURATION,
  RISK_FACTOR_KEYS,
  RISK_APPLICABILITY,
  RISK_EXPLANATION_CODES,
  FACTOR_MAXIMUMS,
  FACTOR_DISPLAY_ORDER,
  SCORE_MIN_BASIS_POINTS,
  SCORE_MAX_BASIS_POINTS,
  resolveRiskBand,
  resolveDisplayScore,
  selectBucket,
  isValidExplanationCode,
} = require("./riskConfiguration");

class RiskEngineError extends Error {
  constructor(message) {
    super(message);
    this.name = "RiskEngineError";
  }
}

/**
 * Normalizes one factor evaluation into a stored-shape contribution.
 *
 * This is the choke point that enforces the contract's structural rules:
 *   - a non-APPLIED factor contributes exactly 0, whatever the evaluator said;
 *   - a contribution can never exceed its own factor's cap;
 *   - a contribution can never be negative;
 *   - the explanation code must be in the closed vocabulary.
 */
function finalizeFactor(factorKey, evaluation) {
  const maximum = FACTOR_MAXIMUMS[factorKey];
  if (!Number.isInteger(maximum)) {
    throw new RiskEngineError(`riskEngine: unknown factor ${factorKey}`);
  }

  const applicability = evaluation.applicability;
  if (
    applicability !== RISK_APPLICABILITY.APPLIED &&
    applicability !== RISK_APPLICABILITY.NOT_AVAILABLE &&
    applicability !== RISK_APPLICABILITY.NOT_APPLICABLE
  ) {
    throw new RiskEngineError(`riskEngine: factor ${factorKey} produced an invalid applicability`);
  }

  if (!isValidExplanationCode(evaluation.explanationCode)) {
    throw new RiskEngineError(`riskEngine: factor ${factorKey} produced an unknown explanation code`);
  }

  let contribution =
    applicability === RISK_APPLICABILITY.APPLIED ? evaluation.contributionBasisPoints : 0;

  if (!Number.isInteger(contribution)) {
    throw new RiskEngineError(`riskEngine: factor ${factorKey} produced a non-integer contribution`);
  }
  if (contribution < 0) {
    throw new RiskEngineError(`riskEngine: factor ${factorKey} produced a negative contribution`);
  }
  if (contribution > maximum) {
    throw new RiskEngineError(`riskEngine: factor ${factorKey} exceeded its maximum`);
  }

  const normalizedInputValue =
    evaluation.normalizedInputValue === undefined || evaluation.normalizedInputValue === null
      ? null
      : String(evaluation.normalizedInputValue);

  return Object.freeze({
    factorKey,
    applicability,
    contributionBasisPoints: contribution,
    maximumContributionBasisPoints: maximum,
    normalizedInputValue,
    explanationCode: evaluation.explanationCode,
    evidenceSnapshot: evaluation.evidenceSnapshot
      ? Object.freeze({ ...evaluation.evidenceSnapshot })
      : null,
    displayOrder: FACTOR_DISPLAY_ORDER.indexOf(factorKey),
  });
}

const NOT_AVAILABLE = RISK_APPLICABILITY.NOT_AVAILABLE;
const NOT_APPLICABLE = RISK_APPLICABILITY.NOT_APPLICABLE;
const APPLIED = RISK_APPLICABILITY.APPLIED;

// --- Factor 1: sourceSeverity ----------------------------------------------
function evaluateSourceSeverity(config, inputs) {
  const entry = config.sourceSeverityByReportType[inputs.reportType];
  if (!entry) {
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.SOURCE_SEVERITY_NOT_AVAILABLE,
      normalizedInputValue: null,
    };
  }
  return {
    applicability: APPLIED,
    contributionBasisPoints: entry.contributionBasisPoints,
    explanationCode: entry.explanationCode,
    normalizedInputValue: inputs.reportType,
    evidenceSnapshot: { reportType: inputs.reportType },
  };
}

// --- Factor 2: exposureCriticality -----------------------------------------
function evaluateExposureCriticality(config, inputs) {
  const serviceKey =
    typeof inputs.protocol === "string" && Number.isInteger(inputs.port)
      ? `${inputs.protocol}/${inputs.port}`
      : null;
  const entry = serviceKey ? config.exposureCriticalityByService[serviceKey] : null;

  if (!entry) {
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.EXPOSURE_CRITICALITY_NOT_AVAILABLE,
      normalizedInputValue: serviceKey,
    };
  }
  return {
    applicability: APPLIED,
    contributionBasisPoints: entry.contributionBasisPoints,
    explanationCode: entry.explanationCode,
    normalizedInputValue: serviceKey,
    evidenceSnapshot: { protocol: inputs.protocol, port: inputs.port },
  };
}

// --- Factor 3: persistence --------------------------------------------------
function evaluatePersistence(config, inputs) {
  const count = inputs.observationCount;
  if (!Number.isInteger(count) || count < 1) {
    // No immutable occurrence evidence at asOf. Fails closed as missing
    // context rather than assuming a single observation.
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.PERSISTENCE_NO_EVIDENCE,
      normalizedInputValue: Number.isInteger(count) ? count : null,
    };
  }
  const bucket = selectBucket(config.persistenceBuckets, count);
  if (!bucket) {
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.PERSISTENCE_NO_EVIDENCE,
      normalizedInputValue: count,
    };
  }
  return {
    applicability: APPLIED,
    contributionBasisPoints: bucket.contributionBasisPoints,
    explanationCode: bucket.explanationCode,
    normalizedInputValue: count,
    evidenceSnapshot: { observationCount: count },
  };
}

// --- Factor 4: recurrence ---------------------------------------------------
function evaluateRecurrence(config, inputs) {
  const count = inputs.recurredCount;
  if (!Number.isInteger(count) || count < 0) {
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.RECURRENCE_NONE,
      normalizedInputValue: null,
    };
  }
  const bucket = selectBucket(config.recurrenceBuckets, count);
  if (!bucket) {
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.RECURRENCE_NONE,
      normalizedInputValue: count,
    };
  }
  return {
    applicability: APPLIED,
    contributionBasisPoints: bucket.contributionBasisPoints,
    explanationCode: bucket.explanationCode,
    normalizedInputValue: count,
    evidenceSnapshot: { recurredCount: count },
  };
}

// --- Factor 5: daysUnresolved ----------------------------------------------
function evaluateDaysUnresolved(config, inputs) {
  // A closed finding is resolved: unresolved duration cannot apply to it.
  // This is NOT_APPLICABLE, distinct from "we could not compute it".
  if (inputs.findingStatus === "CLOSED") {
    return {
      applicability: NOT_APPLICABLE,
      explanationCode: RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_NOT_APPLICABLE_CLOSED,
      normalizedInputValue: null,
    };
  }

  const days = inputs.daysUnresolved;
  if (!Number.isInteger(days) || days < 0) {
    // Missing, future or malformed episode start — fails closed.
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_INVALID_TIMESTAMP,
      normalizedInputValue: null,
    };
  }

  const bucket = selectBucket(config.daysUnresolvedBuckets, days);
  if (!bucket) {
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_INVALID_TIMESTAMP,
      normalizedInputValue: days,
    };
  }
  return {
    applicability: APPLIED,
    contributionBasisPoints: bucket.contributionBasisPoints,
    explanationCode: bucket.explanationCode,
    normalizedInputValue: days,
    evidenceSnapshot: { daysUnresolved: days },
  };
}

// --- Factor 6: iocReputationContext ----------------------------------------
function evaluateIocReputationContext(config, inputs) {
  if (!inputs.enrichmentPresent || inputs.enrichmentStatus === null) {
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_ABSENT,
      normalizedInputValue: null,
    };
  }

  const status = inputs.enrichmentStatus;

  // A SUCCESS row is the only thing that can carry a score, and only while
  // fresh. Score 0 is real evidence (the provider looked and found nothing)
  // and is APPLIED — the one place a zero contribution means "checked and
  // clean" rather than "unknown".
  if (status === "SUCCESS" && inputs.enrichmentFresh === true) {
    const score = inputs.abuseConfidenceScore;
    if (!Number.isInteger(score)) {
      return {
        applicability: NOT_AVAILABLE,
        explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_FAILED,
        normalizedInputValue: null,
      };
    }
    const bucket = selectBucket(config.iocReputationBuckets, score);
    if (!bucket) {
      return {
        applicability: NOT_AVAILABLE,
        explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_FAILED,
        normalizedInputValue: null,
      };
    }
    return {
      applicability: APPLIED,
      contributionBasisPoints: bucket.contributionBasisPoints,
      explanationCode: bucket.explanationCode,
      normalizedInputValue: score,
      evidenceSnapshot: { abuseConfidenceScore: score },
    };
  }

  // A reputation-bearing row that has aged out is stale context, not clean
  // context. Distinct code so the explanation says exactly that.
  if ((status === "SUCCESS" || status === "NOT_FOUND") && inputs.enrichmentFresh !== true) {
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_STALE,
      normalizedInputValue: null,
    };
  }

  // Everything else — including a fresh NOT_FOUND (architect amendment 1) —
  // is an absence of usable reputation, each with its own honest code.
  const code = config.iocUnavailableCodeByStatus[status];
  return {
    applicability: NOT_AVAILABLE,
    explanationCode: code || RISK_EXPLANATION_CODES.IOC_REPUTATION_FAILED,
    normalizedInputValue: null,
  };
}

// --- Factor 7: sectorCriticality -------------------------------------------
const SECTOR_UNAVAILABLE_CODE_BY_REASON = Object.freeze({
  NO_OWNERSHIP: RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_NO_OWNERSHIP,
  AMBIGUOUS: RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_AMBIGUOUS_OWNERSHIP,
  UNRESOLVED: RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_UNRESOLVED_OWNERSHIP,
  NO_ORGANIZATION: RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_UNRESOLVED_OWNERSHIP,
  ISP_ATTRIBUTION: RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_ISP_ATTRIBUTION,
  LOW_CONFIDENCE: RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_LOW_CONFIDENCE,
  UNKNOWN_SECTOR: RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_UNKNOWN_SECTOR,
});

function evaluateSectorCriticality(config, inputs) {
  if (inputs.sectorAttributable !== true) {
    const code =
      SECTOR_UNAVAILABLE_CODE_BY_REASON[inputs.sectorNonAttributableReason] ||
      RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_NO_OWNERSHIP;
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: code,
      normalizedInputValue: null,
    };
  }

  const entry = config.sectorContributions[inputs.sector];
  if (!entry) {
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_UNKNOWN_SECTOR,
      normalizedInputValue: null,
    };
  }
  return {
    applicability: APPLIED,
    contributionBasisPoints: entry.contributionBasisPoints,
    explanationCode: entry.explanationCode,
    normalizedInputValue: inputs.sector,
    evidenceSnapshot: { sector: inputs.sector },
  };
}

// --- Factor 8: cvePresence --------------------------------------------------
function evaluateCvePresence(config, inputs) {
  if (inputs.cvePresent !== true) {
    // No CVE-bearing source exists for this finding. NOT_APPLICABLE, never
    // inferred from an exposed RDP port.
    return {
      applicability: NOT_APPLICABLE,
      explanationCode: RISK_EXPLANATION_CODES.CVE_NOT_APPLICABLE_NO_CVE_SOURCE,
      normalizedInputValue: null,
    };
  }
  return {
    applicability: APPLIED,
    contributionBasisPoints: config.cvePresenceContributionBasisPoints,
    explanationCode: RISK_EXPLANATION_CODES.CVE_PRESENT,
    normalizedInputValue: "PRESENT",
  };
}

// --- Factor 9: kevStatus ----------------------------------------------------
function evaluateKevStatus(config, inputs) {
  if (inputs.cvePresent !== true) {
    return {
      applicability: NOT_APPLICABLE,
      explanationCode: RISK_EXPLANATION_CODES.KEV_NOT_APPLICABLE_NO_CVE,
      normalizedInputValue: null,
    };
  }
  if (inputs.kevLookupAvailable !== true) {
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.KEV_NOT_AVAILABLE,
      normalizedInputValue: null,
    };
  }
  if (inputs.kevListed === true) {
    return {
      applicability: APPLIED,
      contributionBasisPoints: config.kevListedContributionBasisPoints,
      explanationCode: RISK_EXPLANATION_CODES.KEV_LISTED,
      normalizedInputValue: "LISTED",
    };
  }
  return {
    applicability: APPLIED,
    contributionBasisPoints: 0,
    explanationCode: RISK_EXPLANATION_CODES.KEV_NOT_LISTED,
    normalizedInputValue: "NOT_LISTED",
  };
}

// --- Factor 10: epssScore ---------------------------------------------------
function evaluateEpssScore(config, inputs) {
  if (inputs.cvePresent !== true) {
    return {
      applicability: NOT_APPLICABLE,
      explanationCode: RISK_EXPLANATION_CODES.EPSS_NOT_APPLICABLE_NO_CVE,
      normalizedInputValue: null,
    };
  }
  const basisPoints = inputs.epssBasisPoints;
  if (!Number.isInteger(basisPoints)) {
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.EPSS_LOW,
      normalizedInputValue: null,
    };
  }
  const bucket = selectBucket(config.epssBuckets, basisPoints);
  if (!bucket) {
    return {
      applicability: NOT_AVAILABLE,
      explanationCode: RISK_EXPLANATION_CODES.EPSS_LOW,
      normalizedInputValue: null,
    };
  }
  return {
    applicability: APPLIED,
    contributionBasisPoints: bucket.contributionBasisPoints,
    explanationCode: bucket.explanationCode,
    normalizedInputValue: basisPoints,
    evidenceSnapshot: { epssBasisPoints: basisPoints },
  };
}

// Explicit evaluator per factor, in locked display order.
const FACTOR_EVALUATORS = Object.freeze({
  [RISK_FACTOR_KEYS.SOURCE_SEVERITY]: evaluateSourceSeverity,
  [RISK_FACTOR_KEYS.EXPOSURE_CRITICALITY]: evaluateExposureCriticality,
  [RISK_FACTOR_KEYS.PERSISTENCE]: evaluatePersistence,
  [RISK_FACTOR_KEYS.RECURRENCE]: evaluateRecurrence,
  [RISK_FACTOR_KEYS.DAYS_UNRESOLVED]: evaluateDaysUnresolved,
  [RISK_FACTOR_KEYS.IOC_REPUTATION_CONTEXT]: evaluateIocReputationContext,
  [RISK_FACTOR_KEYS.SECTOR_CRITICALITY]: evaluateSectorCriticality,
  [RISK_FACTOR_KEYS.CVE_PRESENCE]: evaluateCvePresence,
  [RISK_FACTOR_KEYS.KEV_STATUS]: evaluateKevStatus,
  [RISK_FACTOR_KEYS.EPSS_SCORE]: evaluateEpssScore,
});

/**
 * The pure entry point.
 *
 * @param {object} params
 * @param {object} [params.configuration] locked contract; defaults to v1
 * @param {object} params.inputSnapshot   from riskInputSnapshot.loadRiskInputSnapshot
 * @returns frozen { scoreBasisPoints, displayScore, riskBand, contributions, ... }
 */
function calculateRisk({ configuration = RISK_CONFIGURATION, inputSnapshot } = {}) {
  if (!inputSnapshot || typeof inputSnapshot !== "object") {
    throw new RiskEngineError("riskEngine: inputSnapshot is required");
  }
  const inputs = inputSnapshot.inputs;
  if (!inputs || typeof inputs !== "object") {
    throw new RiskEngineError("riskEngine: inputSnapshot.inputs is required");
  }
  if (typeof inputSnapshot.inputFingerprint !== "string" || inputSnapshot.inputFingerprint === "") {
    throw new RiskEngineError("riskEngine: inputSnapshot.inputFingerprint is required");
  }

  const contributions = FACTOR_DISPLAY_ORDER.map((factorKey) => {
    const evaluator = FACTOR_EVALUATORS[factorKey];
    if (typeof evaluator !== "function") {
      throw new RiskEngineError(`riskEngine: no evaluator for factor ${factorKey}`);
    }
    return finalizeFactor(factorKey, evaluator(configuration, inputs));
  });

  const rawTotal = contributions.reduce((sum, row) => sum + row.contributionBasisPoints, 0);

  // Defensive cap. With the locked v1 caps summing to exactly 10000 this can
  // bind but can never truncate, so no contribution is ever silently
  // discarded; it exists so a future configuration cannot overflow the scale.
  const scoreBasisPoints = Math.min(Math.max(rawTotal, SCORE_MIN_BASIS_POINTS), SCORE_MAX_BASIS_POINTS);

  return Object.freeze({
    algorithmVersion: configuration.algorithmVersion,
    configurationVersion: configuration.configurationVersion,
    configurationFingerprint: inputSnapshot.configurationFingerprint,
    inputFingerprint: inputSnapshot.inputFingerprint,
    findingId: inputSnapshot.findingId,
    asOf: inputSnapshot.asOf,
    scoreBasisPoints,
    displayScore: resolveDisplayScore(scoreBasisPoints),
    riskBand: resolveRiskBand(scoreBasisPoints),
    contributions: Object.freeze(contributions),
  });
}

module.exports = {
  RiskEngineError,
  calculateRisk,
  finalizeFactor,
  FACTOR_EVALUATORS,
};
