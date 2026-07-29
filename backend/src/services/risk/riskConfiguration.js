"use strict";

// ===========================================================================
// P2-T3 — The LOCKED Risk v1 numeric contract.
//
// This module is the single source of truth for every weight, cap, bucket
// boundary and band edge in deterministic risk scoring. It was approved by the
// architect on 2026-07-28 (see STATUS.md "Locked Risk v1 numeric contract").
//
// Rules this file exists to enforce:
//
//   * Weights live in CODE, not in the database and not in the environment.
//     There is no config table, no env var, no runtime mutation path. This is
//     the approved amendment to BUILD_PLAN.md section 2C's "versioned config
//     row" wording (STATUS.md D-T3-b).
//   * Changing ANY number here requires bumping RISK_CONFIGURATION_VERSION.
//     Old RiskScore rows keep their own version + fingerprint + contributions,
//     so an old explanation stays truthful without consulting this file.
//   * Everything is integer basis points. No floating-point arithmetic
//     participates in scoring at any point.
//   * Ownership is NOT a scored factor. Ownership status/confidence/
//     isIspAttribution contribute zero basis points; they only gate whether
//     sectorCriticality is sufficiently attributable to apply. This preserves
//     DECISIONS.md D-003 and the locked architecture section 6.8.
//   * No CVE is ever inferred from an exposed RDP port. For a finding with no
//     CVE-bearing source, cvePresence/kevStatus/epssScore are NOT_APPLICABLE.
//
// This is deliberately NOT a generic rules engine. It is a frozen data table
// read by explicit per-factor code in riskEngine.js.
// ===========================================================================

const crypto = require("crypto");

const RISK_ALGORITHM_VERSION = "risk-additive-bucketed-v1";
const RISK_CONFIGURATION_VERSION = "v1.0.0";

const SCORE_MIN_BASIS_POINTS = 0;
const SCORE_MAX_BASIS_POINTS = 10000;

// displayScore = floor(scoreBasisPoints / DISPLAY_SCORE_DIVISOR). Floor, never
// round, so a displayed score never overstates the stored basis points.
const DISPLAY_SCORE_DIVISOR = 100;

// Normalized-input clamp for elapsed days. This bounds stored evidence only —
// the contribution table already saturates at 90 days.
const MAX_NORMALIZED_DAYS = 3650;

const MILLISECONDS_PER_DAY = 86400000;

const RISK_FACTOR_KEYS = Object.freeze({
  SOURCE_SEVERITY: "sourceSeverity",
  EXPOSURE_CRITICALITY: "exposureCriticality",
  PERSISTENCE: "persistence",
  RECURRENCE: "recurrence",
  DAYS_UNRESOLVED: "daysUnresolved",
  IOC_REPUTATION_CONTEXT: "iocReputationContext",
  SECTOR_CRITICALITY: "sectorCriticality",
  CVE_PRESENCE: "cvePresence",
  KEV_STATUS: "kevStatus",
  EPSS_SCORE: "epssScore",
});

const RISK_FACTOR_KEY_VALUES = Object.freeze(Object.values(RISK_FACTOR_KEYS));

const RISK_APPLICABILITY = Object.freeze({
  APPLIED: "APPLIED",
  NOT_AVAILABLE: "NOT_AVAILABLE",
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

const RISK_BAND = Object.freeze({
  INFORMATIONAL: "INFORMATIONAL",
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
});

// Inclusive on both ends, contiguous, covering 0..10000 with no gap or
// overlap. Ordered low to high; resolveRiskBand walks this in order.
const RISK_BAND_TABLE = Object.freeze([
  Object.freeze({ band: RISK_BAND.INFORMATIONAL, minBasisPoints: 0, maxBasisPoints: 1499 }),
  Object.freeze({ band: RISK_BAND.LOW, minBasisPoints: 1500, maxBasisPoints: 3499 }),
  Object.freeze({ band: RISK_BAND.MEDIUM, minBasisPoints: 3500, maxBasisPoints: 5999 }),
  Object.freeze({ band: RISK_BAND.HIGH, minBasisPoints: 6000, maxBasisPoints: 7999 }),
  Object.freeze({ band: RISK_BAND.CRITICAL, minBasisPoints: 8000, maxBasisPoints: 10000 }),
]);

// Closed explanation vocabulary. A rendered sentence is looked up from one of
// these codes — never generated from a provider payload, an exception message,
// or a model.
const RISK_EXPLANATION_CODES = Object.freeze({
  SOURCE_SEVERITY_ACCESSIBLE_RDP: "SOURCE_SEVERITY_ACCESSIBLE_RDP",
  SOURCE_SEVERITY_NOT_AVAILABLE: "SOURCE_SEVERITY_NOT_AVAILABLE",

  EXPOSURE_CRITICALITY_REMOTE_ACCESS_RDP: "EXPOSURE_CRITICALITY_REMOTE_ACCESS_RDP",
  EXPOSURE_CRITICALITY_NOT_AVAILABLE: "EXPOSURE_CRITICALITY_NOT_AVAILABLE",

  PERSISTENCE_NO_EVIDENCE: "PERSISTENCE_NO_EVIDENCE",
  PERSISTENCE_SINGLE_OBSERVATION: "PERSISTENCE_SINGLE_OBSERVATION",
  PERSISTENCE_REPEATED: "PERSISTENCE_REPEATED",
  PERSISTENCE_SUSTAINED: "PERSISTENCE_SUSTAINED",
  PERSISTENCE_ENTRENCHED: "PERSISTENCE_ENTRENCHED",

  RECURRENCE_NONE: "RECURRENCE_NONE",
  RECURRENCE_ONCE_AFTER_CLOSURE: "RECURRENCE_ONCE_AFTER_CLOSURE",
  RECURRENCE_REPEATED_AFTER_CLOSURE: "RECURRENCE_REPEATED_AFTER_CLOSURE",
  RECURRENCE_CHRONIC_AFTER_CLOSURE: "RECURRENCE_CHRONIC_AFTER_CLOSURE",

  DAYS_UNRESOLVED_NOT_APPLICABLE_CLOSED: "DAYS_UNRESOLVED_NOT_APPLICABLE_CLOSED",
  DAYS_UNRESOLVED_INVALID_TIMESTAMP: "DAYS_UNRESOLVED_INVALID_TIMESTAMP",
  DAYS_UNRESOLVED_UNDER_7: "DAYS_UNRESOLVED_UNDER_7",
  DAYS_UNRESOLVED_7_TO_29: "DAYS_UNRESOLVED_7_TO_29",
  DAYS_UNRESOLVED_30_TO_89: "DAYS_UNRESOLVED_30_TO_89",
  DAYS_UNRESOLVED_90_PLUS: "DAYS_UNRESOLVED_90_PLUS",

  IOC_REPUTATION_NONE: "IOC_REPUTATION_NONE",
  IOC_REPUTATION_LOW: "IOC_REPUTATION_LOW",
  IOC_REPUTATION_MEDIUM: "IOC_REPUTATION_MEDIUM",
  IOC_REPUTATION_HIGH: "IOC_REPUTATION_HIGH",
  IOC_REPUTATION_VERY_HIGH: "IOC_REPUTATION_VERY_HIGH",
  IOC_REPUTATION_NOT_FOUND: "IOC_REPUTATION_NOT_FOUND",
  IOC_REPUTATION_STALE: "IOC_REPUTATION_STALE",
  IOC_REPUTATION_RATE_LIMITED: "IOC_REPUTATION_RATE_LIMITED",
  IOC_REPUTATION_TIMEOUT: "IOC_REPUTATION_TIMEOUT",
  IOC_REPUTATION_FAILED: "IOC_REPUTATION_FAILED",
  IOC_REPUTATION_INVALID_KEY: "IOC_REPUTATION_INVALID_KEY",
  IOC_REPUTATION_DISABLED: "IOC_REPUTATION_DISABLED",
  IOC_REPUTATION_UNSUPPORTED: "IOC_REPUTATION_UNSUPPORTED",
  IOC_REPUTATION_PENDING: "IOC_REPUTATION_PENDING",
  IOC_REPUTATION_DEAD_LETTER: "IOC_REPUTATION_DEAD_LETTER",
  IOC_REPUTATION_ABSENT: "IOC_REPUTATION_ABSENT",

  SECTOR_CNI: "SECTOR_CNI",
  SECTOR_GOVERNMENT: "SECTOR_GOVERNMENT",
  SECTOR_ENERGY: "SECTOR_ENERGY",
  SECTOR_HEALTHCARE: "SECTOR_HEALTHCARE",
  SECTOR_FINANCE: "SECTOR_FINANCE",
  SECTOR_TELECOM: "SECTOR_TELECOM",
  SECTOR_EDUCATION: "SECTOR_EDUCATION",
  SECTOR_GENERAL: "SECTOR_GENERAL",
  SECTOR_NOT_AVAILABLE_NO_OWNERSHIP: "SECTOR_NOT_AVAILABLE_NO_OWNERSHIP",
  SECTOR_NOT_AVAILABLE_AMBIGUOUS_OWNERSHIP: "SECTOR_NOT_AVAILABLE_AMBIGUOUS_OWNERSHIP",
  SECTOR_NOT_AVAILABLE_UNRESOLVED_OWNERSHIP: "SECTOR_NOT_AVAILABLE_UNRESOLVED_OWNERSHIP",
  SECTOR_NOT_AVAILABLE_ISP_ATTRIBUTION: "SECTOR_NOT_AVAILABLE_ISP_ATTRIBUTION",
  SECTOR_NOT_AVAILABLE_LOW_CONFIDENCE: "SECTOR_NOT_AVAILABLE_LOW_CONFIDENCE",
  SECTOR_NOT_AVAILABLE_UNKNOWN_SECTOR: "SECTOR_NOT_AVAILABLE_UNKNOWN_SECTOR",

  CVE_NOT_APPLICABLE_NO_CVE_SOURCE: "CVE_NOT_APPLICABLE_NO_CVE_SOURCE",
  CVE_PRESENT: "CVE_PRESENT",

  KEV_NOT_APPLICABLE_NO_CVE: "KEV_NOT_APPLICABLE_NO_CVE",
  KEV_LISTED: "KEV_LISTED",
  KEV_NOT_LISTED: "KEV_NOT_LISTED",
  KEV_NOT_AVAILABLE: "KEV_NOT_AVAILABLE",

  EPSS_NOT_APPLICABLE_NO_CVE: "EPSS_NOT_APPLICABLE_NO_CVE",
  EPSS_LOW: "EPSS_LOW",
  EPSS_MODERATE: "EPSS_MODERATE",
  EPSS_HIGH: "EPSS_HIGH",
  EPSS_VERY_HIGH: "EPSS_VERY_HIGH",
});

const RISK_EXPLANATION_CODE_VALUES = Object.freeze(Object.values(RISK_EXPLANATION_CODES));

// --- Factor caps (locked) ---------------------------------------------------
// Sum is exactly SCORE_MAX_BASIS_POINTS. Proven by assertConfigurationCoherent
// at module load, so an edit that breaks the sum fails fast at require time
// rather than silently producing uncapped scores.
const FACTOR_MAXIMUMS = Object.freeze({
  [RISK_FACTOR_KEYS.SOURCE_SEVERITY]: 800,
  [RISK_FACTOR_KEYS.EXPOSURE_CRITICALITY]: 1500,
  [RISK_FACTOR_KEYS.PERSISTENCE]: 1200,
  [RISK_FACTOR_KEYS.RECURRENCE]: 1300,
  [RISK_FACTOR_KEYS.DAYS_UNRESOLVED]: 1200,
  [RISK_FACTOR_KEYS.IOC_REPUTATION_CONTEXT]: 1200,
  [RISK_FACTOR_KEYS.SECTOR_CRITICALITY]: 1300,
  [RISK_FACTOR_KEYS.CVE_PRESENCE]: 300,
  [RISK_FACTOR_KEYS.KEV_STATUS]: 800,
  [RISK_FACTOR_KEYS.EPSS_SCORE]: 400,
});

// The three vulnerability factors. Broken out because the contract requires
// proving they cannot dominate, and that a non-CVE finding can still reach
// CRITICAL on the remaining seven alone.
const VULNERABILITY_FACTOR_KEYS = Object.freeze([
  RISK_FACTOR_KEYS.CVE_PRESENCE,
  RISK_FACTOR_KEYS.KEV_STATUS,
  RISK_FACTOR_KEYS.EPSS_SCORE,
]);

// Hard ceiling on IOC reputation, mandated by DECISIONS.md D-003 ("visibly
// bounded") and fixed by the architect at 1200. Asserted at load.
const IOC_REPUTATION_MAX_ALLOWED_BASIS_POINTS = 1200;

// --- Factor 1: sourceSeverity ----------------------------------------------
// What the SOURCE asserts about this report class. The Accessible RDP feed
// carries no severity column (its columns are timestamp, ip, port, protocol,
// hostname, asn, as_name, country_code), so severity is a property of the
// report type itself, not of a row.
const SOURCE_SEVERITY_BY_REPORT_TYPE = Object.freeze({
  ACCESSIBLE_RDP: Object.freeze({
    contributionBasisPoints: 800,
    explanationCode: RISK_EXPLANATION_CODES.SOURCE_SEVERITY_ACCESSIBLE_RDP,
  }),
});

// --- Factor 2: exposureCriticality -----------------------------------------
// What the exposed SERVICE is worth technically — distinct from factor 1.
// Keyed by exact "PROTOCOL/port"; an unmapped pair is NOT_AVAILABLE rather
// than a guess.
const EXPOSURE_CRITICALITY_BY_SERVICE = Object.freeze({
  "TCP/3389": Object.freeze({
    contributionBasisPoints: 1500,
    explanationCode: RISK_EXPLANATION_CODES.EXPOSURE_CRITICALITY_REMOTE_ACCESS_RDP,
  }),
});

// --- Factor 3: persistence --------------------------------------------------
// Bucketed on the count of immutable FindingOccurrence rows at or before asOf.
// All four occurrence actions count: each row is one distinct accepted report
// observing this exposure (architect resolution G5). Ordered ascending; the
// first bucket whose maxInclusive covers the value wins (null = open ended).
const PERSISTENCE_BUCKETS = Object.freeze([
  Object.freeze({
    minInclusive: 1,
    maxInclusive: 1,
    contributionBasisPoints: 0,
    explanationCode: RISK_EXPLANATION_CODES.PERSISTENCE_SINGLE_OBSERVATION,
  }),
  Object.freeze({
    minInclusive: 2,
    maxInclusive: 3,
    contributionBasisPoints: 400,
    explanationCode: RISK_EXPLANATION_CODES.PERSISTENCE_REPEATED,
  }),
  Object.freeze({
    minInclusive: 4,
    maxInclusive: 7,
    contributionBasisPoints: 800,
    explanationCode: RISK_EXPLANATION_CODES.PERSISTENCE_SUSTAINED,
  }),
  Object.freeze({
    minInclusive: 8,
    maxInclusive: null,
    contributionBasisPoints: 1200,
    explanationCode: RISK_EXPLANATION_CODES.PERSISTENCE_ENTRENCHED,
  }),
]);

// --- Factor 4: recurrence ---------------------------------------------------
// Bucketed on the count of RECURRED occurrences at or before asOf. RECURRED is
// written by the Phase 1 lifecycle ONLY when a manually closed finding is
// re-observed, so this is "came back after a human closed it" by construction
// — never ordinary persistence and never duplicate rows within one report.
const RECURRENCE_BUCKETS = Object.freeze([
  Object.freeze({
    minInclusive: 0,
    maxInclusive: 0,
    contributionBasisPoints: 0,
    explanationCode: RISK_EXPLANATION_CODES.RECURRENCE_NONE,
  }),
  Object.freeze({
    minInclusive: 1,
    maxInclusive: 1,
    contributionBasisPoints: 700,
    explanationCode: RISK_EXPLANATION_CODES.RECURRENCE_ONCE_AFTER_CLOSURE,
  }),
  Object.freeze({
    minInclusive: 2,
    maxInclusive: 2,
    contributionBasisPoints: 1050,
    explanationCode: RISK_EXPLANATION_CODES.RECURRENCE_REPEATED_AFTER_CLOSURE,
  }),
  Object.freeze({
    minInclusive: 3,
    maxInclusive: null,
    contributionBasisPoints: 1300,
    explanationCode: RISK_EXPLANATION_CODES.RECURRENCE_CHRONIC_AFTER_CLOSURE,
  }),
]);

// --- Factor 5: daysUnresolved ----------------------------------------------
// Measured from the start of the CURRENT unresolved episode, not from the
// original firstSeen: if the finding was closed and later recurred, the clock
// restarts at the latest RECURRED observation. Time spent CLOSED is never
// counted as unresolved time (architect amendment 3).
const DAYS_UNRESOLVED_BUCKETS = Object.freeze([
  Object.freeze({
    minInclusive: 0,
    maxInclusive: 6,
    contributionBasisPoints: 0,
    explanationCode: RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_UNDER_7,
  }),
  Object.freeze({
    minInclusive: 7,
    maxInclusive: 29,
    contributionBasisPoints: 400,
    explanationCode: RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_7_TO_29,
  }),
  Object.freeze({
    minInclusive: 30,
    maxInclusive: 89,
    contributionBasisPoints: 800,
    explanationCode: RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_30_TO_89,
  }),
  Object.freeze({
    minInclusive: 90,
    maxInclusive: null,
    contributionBasisPoints: 1200,
    explanationCode: RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_90_PLUS,
  }),
]);

// --- Factor 6: iocReputationContext ----------------------------------------
// Bucketed on abuseConfidenceScore ONLY for a fresh SUCCESS. Score 0 is
// APPLIED with 0 basis points: the provider looked and found nothing, which is
// real evidence. Every other provider state is NOT_AVAILABLE with its own
// code, so "we could not check" is never readable as "the address is clean".
const IOC_REPUTATION_BUCKETS = Object.freeze([
  Object.freeze({
    minInclusive: 0,
    maxInclusive: 0,
    contributionBasisPoints: 0,
    explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_NONE,
  }),
  Object.freeze({
    minInclusive: 1,
    maxInclusive: 24,
    contributionBasisPoints: 300,
    explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_LOW,
  }),
  Object.freeze({
    minInclusive: 25,
    maxInclusive: 49,
    contributionBasisPoints: 600,
    explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_MEDIUM,
  }),
  Object.freeze({
    minInclusive: 50,
    maxInclusive: 74,
    contributionBasisPoints: 900,
    explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_HIGH,
  }),
  Object.freeze({
    minInclusive: 75,
    maxInclusive: 100,
    contributionBasisPoints: 1200,
    explanationCode: RISK_EXPLANATION_CODES.IOC_REPUTATION_VERY_HIGH,
  }),
]);

// Non-scoring provider states -> the NOT_AVAILABLE explanation code that
// records exactly why reputation context could not be applied. NOT_FOUND is
// deliberately here (architect amendment 1): "no provider record exists" is
// not usable reputation context and must not share APPLIED semantics with a
// confirmed SUCCESS score of 0.
const IOC_UNAVAILABLE_CODE_BY_STATUS = Object.freeze({
  NOT_FOUND: RISK_EXPLANATION_CODES.IOC_REPUTATION_NOT_FOUND,
  RATE_LIMITED: RISK_EXPLANATION_CODES.IOC_REPUTATION_RATE_LIMITED,
  TIMEOUT: RISK_EXPLANATION_CODES.IOC_REPUTATION_TIMEOUT,
  FAILED: RISK_EXPLANATION_CODES.IOC_REPUTATION_FAILED,
  INVALID_KEY: RISK_EXPLANATION_CODES.IOC_REPUTATION_INVALID_KEY,
  SKIPPED_DISABLED: RISK_EXPLANATION_CODES.IOC_REPUTATION_DISABLED,
  UNSUPPORTED_INDICATOR: RISK_EXPLANATION_CODES.IOC_REPUTATION_UNSUPPORTED,
  PENDING: RISK_EXPLANATION_CODES.IOC_REPUTATION_PENDING,
  DEAD_LETTER: RISK_EXPLANATION_CODES.IOC_REPUTATION_DEAD_LETTER,
});

// --- Factor 7: sectorCriticality -------------------------------------------
// Applies ONLY when ownership is strong enough to attribute the finding to a
// real organization. Ownership itself contributes nothing; this is purely an
// applicability gate (architect amendment 2). Confidence is read here and
// nowhere else in scoring.
const SECTOR_CONTRIBUTIONS = Object.freeze({
  CRITICAL_NATIONAL_INFRASTRUCTURE: Object.freeze({
    contributionBasisPoints: 1300,
    explanationCode: RISK_EXPLANATION_CODES.SECTOR_CNI,
  }),
  GOVERNMENT: Object.freeze({
    contributionBasisPoints: 1100,
    explanationCode: RISK_EXPLANATION_CODES.SECTOR_GOVERNMENT,
  }),
  ENERGY: Object.freeze({
    contributionBasisPoints: 1100,
    explanationCode: RISK_EXPLANATION_CODES.SECTOR_ENERGY,
  }),
  HEALTHCARE: Object.freeze({
    contributionBasisPoints: 1000,
    explanationCode: RISK_EXPLANATION_CODES.SECTOR_HEALTHCARE,
  }),
  FINANCE: Object.freeze({
    contributionBasisPoints: 1000,
    explanationCode: RISK_EXPLANATION_CODES.SECTOR_FINANCE,
  }),
  TELECOM: Object.freeze({
    contributionBasisPoints: 900,
    explanationCode: RISK_EXPLANATION_CODES.SECTOR_TELECOM,
  }),
  EDUCATION: Object.freeze({
    contributionBasisPoints: 500,
    explanationCode: RISK_EXPLANATION_CODES.SECTOR_EDUCATION,
  }),
  GENERAL: Object.freeze({
    contributionBasisPoints: 300,
    explanationCode: RISK_EXPLANATION_CODES.SECTOR_GENERAL,
  }),
});

// Ownership confidences strong enough to attribute a sector when the status is
// RESOLVED. The locked contract says exactly HIGH or MEDIUM — CONFIRMED is
// deliberately absent. OVERRIDDEN has its own unconditional applicability path
// (path A) and never consults this list, so CONFIRMED could never be reached
// through RESOLVED anyway; keeping it here would only be an unreachable extra
// value and a future formula-expansion risk.
// OVERRIDDEN is an explicit analyst decision and needs no confidence check.
// LOW-confidence RESOLVED is explicitly excluded (architect amendment 2).
const SECTOR_ATTRIBUTABLE_RESOLVED_CONFIDENCES = Object.freeze(["HIGH", "MEDIUM"]);

// --- Factors 8-10: vulnerability -------------------------------------------
// No CVE-bearing source exists in the schema today, so all three are
// NOT_APPLICABLE for every current finding. The buckets are defined so that a
// future CVE-bearing report type does not require redesigning score history.
const CVE_PRESENCE_CONTRIBUTION_BASIS_POINTS = 300;
const KEV_LISTED_CONTRIBUTION_BASIS_POINTS = 800;

// EPSS probability is normalized to integer basis points (probability * 10000)
// at the input boundary, so no float reaches scoring.
const EPSS_BUCKETS = Object.freeze([
  Object.freeze({
    minInclusive: 0,
    maxInclusive: 999,
    contributionBasisPoints: 0,
    explanationCode: RISK_EXPLANATION_CODES.EPSS_LOW,
  }),
  Object.freeze({
    minInclusive: 1000,
    maxInclusive: 4999,
    contributionBasisPoints: 150,
    explanationCode: RISK_EXPLANATION_CODES.EPSS_MODERATE,
  }),
  Object.freeze({
    minInclusive: 5000,
    maxInclusive: 8999,
    contributionBasisPoints: 300,
    explanationCode: RISK_EXPLANATION_CODES.EPSS_HIGH,
  }),
  Object.freeze({
    minInclusive: 9000,
    maxInclusive: 10000,
    contributionBasisPoints: 400,
    explanationCode: RISK_EXPLANATION_CODES.EPSS_VERY_HIGH,
  }),
]);

// Presentation order for stored contributions and rendered explanations.
const FACTOR_DISPLAY_ORDER = Object.freeze([
  RISK_FACTOR_KEYS.SOURCE_SEVERITY,
  RISK_FACTOR_KEYS.EXPOSURE_CRITICALITY,
  RISK_FACTOR_KEYS.PERSISTENCE,
  RISK_FACTOR_KEYS.RECURRENCE,
  RISK_FACTOR_KEYS.DAYS_UNRESOLVED,
  RISK_FACTOR_KEYS.IOC_REPUTATION_CONTEXT,
  RISK_FACTOR_KEYS.SECTOR_CRITICALITY,
  RISK_FACTOR_KEYS.CVE_PRESENCE,
  RISK_FACTOR_KEYS.KEV_STATUS,
  RISK_FACTOR_KEYS.EPSS_SCORE,
]);

const RISK_CONFIGURATION = deepFreeze({
  algorithmVersion: RISK_ALGORITHM_VERSION,
  configurationVersion: RISK_CONFIGURATION_VERSION,
  scoreMinBasisPoints: SCORE_MIN_BASIS_POINTS,
  scoreMaxBasisPoints: SCORE_MAX_BASIS_POINTS,
  displayScoreDivisor: DISPLAY_SCORE_DIVISOR,
  maxNormalizedDays: MAX_NORMALIZED_DAYS,
  factorDisplayOrder: FACTOR_DISPLAY_ORDER,
  factorMaximums: FACTOR_MAXIMUMS,
  bands: RISK_BAND_TABLE,
  sourceSeverityByReportType: SOURCE_SEVERITY_BY_REPORT_TYPE,
  exposureCriticalityByService: EXPOSURE_CRITICALITY_BY_SERVICE,
  persistenceBuckets: PERSISTENCE_BUCKETS,
  recurrenceBuckets: RECURRENCE_BUCKETS,
  daysUnresolvedBuckets: DAYS_UNRESOLVED_BUCKETS,
  iocReputationBuckets: IOC_REPUTATION_BUCKETS,
  iocUnavailableCodeByStatus: IOC_UNAVAILABLE_CODE_BY_STATUS,
  sectorContributions: SECTOR_CONTRIBUTIONS,
  sectorAttributableResolvedConfidences: SECTOR_ATTRIBUTABLE_RESOLVED_CONFIDENCES,
  cvePresenceContributionBasisPoints: CVE_PRESENCE_CONTRIBUTION_BASIS_POINTS,
  kevListedContributionBasisPoints: KEV_LISTED_CONTRIBUTION_BASIS_POINTS,
  epssBuckets: EPSS_BUCKETS,
});

// Recursively freezes plain objects and arrays. Applied to the whole exported
// configuration so a caller cannot mutate a weight at runtime — a mutation
// would silently change scores while leaving configurationVersion unchanged.
function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  Object.getOwnPropertyNames(value).forEach((key) => {
    deepFreeze(value[key]);
  });
  return Object.freeze(value);
}

// Canonical serialization: object keys sorted, arrays in declared order,
// integers only. Two processes must produce byte-identical output for the same
// contract, which is what makes the fingerprint comparable across machines and
// across replays.
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
  return `{${parts.join(",")}}`;
}

function computeConfigurationFingerprint(configuration = RISK_CONFIGURATION) {
  return crypto.createHash("sha256").update(canonicalize(configuration), "utf8").digest("hex");
}

const RISK_CONFIGURATION_FINGERPRINT = computeConfigurationFingerprint(RISK_CONFIGURATION);

// Resolves the band from the final integer score alone. Never from a factor,
// never assigned directly.
function resolveRiskBand(scoreBasisPoints) {
  if (!Number.isInteger(scoreBasisPoints)) {
    throw new TypeError("riskConfiguration: scoreBasisPoints must be an integer");
  }
  if (scoreBasisPoints < SCORE_MIN_BASIS_POINTS || scoreBasisPoints > SCORE_MAX_BASIS_POINTS) {
    throw new RangeError("riskConfiguration: scoreBasisPoints out of range");
  }
  const match = RISK_BAND_TABLE.find(
    (row) => scoreBasisPoints >= row.minBasisPoints && scoreBasisPoints <= row.maxBasisPoints
  );
  // Unreachable while the band table stays contiguous over the full range —
  // assertConfigurationCoherent proves that at load.
  if (!match) throw new RangeError("riskConfiguration: no band covers score");
  return match.band;
}

function resolveDisplayScore(scoreBasisPoints) {
  if (!Number.isInteger(scoreBasisPoints)) {
    throw new TypeError("riskConfiguration: scoreBasisPoints must be an integer");
  }
  return Math.floor(scoreBasisPoints / DISPLAY_SCORE_DIVISOR);
}

// Selects the first bucket covering value. maxInclusive null means open ended.
// Returns null when no bucket matches, which callers treat as fail-closed.
function selectBucket(buckets, value) {
  if (!Number.isInteger(value)) return null;
  return (
    buckets.find(
      (bucket) =>
        value >= bucket.minInclusive &&
        (bucket.maxInclusive === null || value <= bucket.maxInclusive)
    ) || null
  );
}

function isValidFactorKey(key) {
  return typeof key === "string" && RISK_FACTOR_KEY_VALUES.includes(key);
}

function isValidExplanationCode(code) {
  return typeof code === "string" && RISK_EXPLANATION_CODE_VALUES.includes(code);
}

// Load-time proof of the contract's arithmetic claims. These are the exact
// properties the architect approved; if an edit breaks one, require() throws
// rather than letting the system score against an incoherent contract.
function assertConfigurationCoherent() {
  const keys = Object.keys(FACTOR_MAXIMUMS);

  if (keys.length !== RISK_FACTOR_KEY_VALUES.length) {
    throw new Error("riskConfiguration: factorMaximums must cover every factor key exactly once");
  }
  RISK_FACTOR_KEY_VALUES.forEach((key) => {
    if (!Number.isInteger(FACTOR_MAXIMUMS[key]) || FACTOR_MAXIMUMS[key] < 0) {
      throw new Error(`riskConfiguration: factor ${key} needs a non-negative integer maximum`);
    }
  });

  if (FACTOR_DISPLAY_ORDER.length !== RISK_FACTOR_KEY_VALUES.length) {
    throw new Error("riskConfiguration: factorDisplayOrder must list every factor exactly once");
  }
  RISK_FACTOR_KEY_VALUES.forEach((key) => {
    if (!FACTOR_DISPLAY_ORDER.includes(key)) {
      throw new Error(`riskConfiguration: factorDisplayOrder is missing ${key}`);
    }
  });

  const total = RISK_FACTOR_KEY_VALUES.reduce((sum, key) => sum + FACTOR_MAXIMUMS[key], 0);
  if (total !== SCORE_MAX_BASIS_POINTS) {
    throw new Error(
      `riskConfiguration: factor maximums sum to ${total}, expected ${SCORE_MAX_BASIS_POINTS}`
    );
  }

  const iocMax = FACTOR_MAXIMUMS[RISK_FACTOR_KEYS.IOC_REPUTATION_CONTEXT];
  if (iocMax > IOC_REPUTATION_MAX_ALLOWED_BASIS_POINTS) {
    throw new Error(
      `riskConfiguration: iocReputationContext cap ${iocMax} exceeds the mandated ceiling ${IOC_REPUTATION_MAX_ALLOWED_BASIS_POINTS}`
    );
  }

  // A finding with no CVE input must still be able to reach CRITICAL on the
  // seven non-vulnerability factors alone.
  const vulnerabilityTotal = VULNERABILITY_FACTOR_KEYS.reduce(
    (sum, key) => sum + FACTOR_MAXIMUMS[key],
    0
  );
  const nonVulnerabilityTotal = total - vulnerabilityTotal;
  const criticalFloor = RISK_BAND_TABLE.find((row) => row.band === RISK_BAND.CRITICAL).minBasisPoints;
  if (nonVulnerabilityTotal < criticalFloor) {
    throw new Error(
      `riskConfiguration: non-vulnerability maximum ${nonVulnerabilityTotal} cannot reach the CRITICAL floor ${criticalFloor}`
    );
  }
  if (vulnerabilityTotal * 2 >= total) {
    throw new Error("riskConfiguration: vulnerability factors must not dominate the total");
  }

  // Bands must tile 0..10000 contiguously with no gap or overlap.
  let expectedNext = SCORE_MIN_BASIS_POINTS;
  RISK_BAND_TABLE.forEach((row) => {
    if (row.minBasisPoints !== expectedNext) {
      throw new Error(`riskConfiguration: band ${row.band} does not start at ${expectedNext}`);
    }
    if (row.maxBasisPoints < row.minBasisPoints) {
      throw new Error(`riskConfiguration: band ${row.band} has an inverted range`);
    }
    expectedNext = row.maxBasisPoints + 1;
  });
  if (expectedNext !== SCORE_MAX_BASIS_POINTS + 1) {
    throw new Error("riskConfiguration: bands do not cover the full score range");
  }

  // No bucket may exceed its own factor's cap.
  const bucketSets = [
    [RISK_FACTOR_KEYS.PERSISTENCE, PERSISTENCE_BUCKETS],
    [RISK_FACTOR_KEYS.RECURRENCE, RECURRENCE_BUCKETS],
    [RISK_FACTOR_KEYS.DAYS_UNRESOLVED, DAYS_UNRESOLVED_BUCKETS],
    [RISK_FACTOR_KEYS.IOC_REPUTATION_CONTEXT, IOC_REPUTATION_BUCKETS],
    [RISK_FACTOR_KEYS.EPSS_SCORE, EPSS_BUCKETS],
  ];
  bucketSets.forEach(([key, buckets]) => {
    buckets.forEach((bucket) => {
      if (!Number.isInteger(bucket.contributionBasisPoints)) {
        throw new Error(`riskConfiguration: ${key} bucket contribution must be an integer`);
      }
      if (bucket.contributionBasisPoints > FACTOR_MAXIMUMS[key]) {
        throw new Error(`riskConfiguration: ${key} bucket exceeds its factor maximum`);
      }
      if (!isValidExplanationCode(bucket.explanationCode)) {
        throw new Error(`riskConfiguration: ${key} bucket has an unknown explanation code`);
      }
    });
  });

  Object.entries(SECTOR_CONTRIBUTIONS).forEach(([sector, entry]) => {
    if (entry.contributionBasisPoints > FACTOR_MAXIMUMS[RISK_FACTOR_KEYS.SECTOR_CRITICALITY]) {
      throw new Error(`riskConfiguration: sector ${sector} exceeds the sectorCriticality maximum`);
    }
  });
}

assertConfigurationCoherent();

module.exports = {
  RISK_ALGORITHM_VERSION,
  RISK_CONFIGURATION_VERSION,
  RISK_CONFIGURATION_FINGERPRINT,
  RISK_CONFIGURATION,
  SCORE_MIN_BASIS_POINTS,
  SCORE_MAX_BASIS_POINTS,
  DISPLAY_SCORE_DIVISOR,
  MAX_NORMALIZED_DAYS,
  MILLISECONDS_PER_DAY,
  RISK_FACTOR_KEYS,
  RISK_FACTOR_KEY_VALUES,
  RISK_APPLICABILITY,
  RISK_BAND,
  RISK_BAND_TABLE,
  RISK_EXPLANATION_CODES,
  RISK_EXPLANATION_CODE_VALUES,
  FACTOR_MAXIMUMS,
  FACTOR_DISPLAY_ORDER,
  VULNERABILITY_FACTOR_KEYS,
  IOC_REPUTATION_MAX_ALLOWED_BASIS_POINTS,
  SECTOR_ATTRIBUTABLE_RESOLVED_CONFIDENCES,
  canonicalize,
  computeConfigurationFingerprint,
  resolveRiskBand,
  resolveDisplayScore,
  selectBucket,
  isValidFactorKey,
  isValidExplanationCode,
  assertConfigurationCoherent,
};
