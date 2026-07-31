"use strict";

// ===========================================================================
// P2-T3 — Explanation rendering from stored rows only.
//
// CRITICAL RULE: an explanation is rendered exclusively from a persisted
// RiskScore and its persisted RiskFactorContribution rows. This module never
// touches the database, never re-reads live Finding/ownership/enrichment
// state, and never consults today's configuration. That is what makes a
// six-month-old score still explain itself truthfully after the mappings,
// the enrichment cache and even the weights have all moved on.
//
// No AI. No template is ever generated from a provider payload or an
// exception message: every sentence is looked up from a closed explanation
// code, with only bounded normalized scalars interpolated.
// ===========================================================================

const { RISK_EXPLANATION_CODES, RISK_APPLICABILITY } = require("./riskConfiguration");

// One fixed sentence per closed code. `{value}` interpolates the row's own
// stored normalizedInputValue — never anything read live.
const EXPLANATION_TEMPLATES = Object.freeze({
  [RISK_EXPLANATION_CODES.SOURCE_SEVERITY_ACCESSIBLE_RDP]:
    "Reported by the source as an Accessible RDP exposure.",
  [RISK_EXPLANATION_CODES.SOURCE_SEVERITY_NOT_AVAILABLE]:
    "No source severity is defined for this report type.",

  [RISK_EXPLANATION_CODES.EXPOSURE_CRITICALITY_REMOTE_ACCESS_RDP]:
    "Remote desktop service exposed on {value}, a high-value remote-access entry point.",
  [RISK_EXPLANATION_CODES.EXPOSURE_CRITICALITY_NOT_AVAILABLE]:
    "No exposure criticality is defined for this service and port.",

  [RISK_EXPLANATION_CODES.PERSISTENCE_NO_EVIDENCE]:
    "No report observations are recorded for this finding at the evaluation time.",
  [RISK_EXPLANATION_CODES.PERSISTENCE_SINGLE_OBSERVATION]:
    "Observed in a single report; not yet a persistent exposure.",
  [RISK_EXPLANATION_CODES.PERSISTENCE_REPEATED]:
    "Observed in {value} reports; the exposure is repeating.",
  [RISK_EXPLANATION_CODES.PERSISTENCE_SUSTAINED]:
    "Observed in {value} reports; the exposure is sustained across multiple reports.",
  [RISK_EXPLANATION_CODES.PERSISTENCE_ENTRENCHED]:
    "Observed in {value} reports; the exposure is entrenched.",

  [RISK_EXPLANATION_CODES.RECURRENCE_NONE]:
    "Has not recurred after a closure.",
  [RISK_EXPLANATION_CODES.RECURRENCE_ONCE_AFTER_CLOSURE]:
    "Reappeared once after being manually closed, indicating remediation did not hold.",
  [RISK_EXPLANATION_CODES.RECURRENCE_REPEATED_AFTER_CLOSURE]:
    "Reappeared {value} times after being manually closed.",
  [RISK_EXPLANATION_CODES.RECURRENCE_CHRONIC_AFTER_CLOSURE]:
    "Reappeared {value} times after closure; chronically unresolved.",

  [RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_NOT_APPLICABLE_CLOSED]:
    "Unresolved duration does not apply: the finding is closed.",
  [RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_INVALID_TIMESTAMP]:
    "Unresolved duration could not be determined from the recorded timestamps.",
  [RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_UNDER_7]:
    "Open for {value} days in the current episode; still within the first week.",
  [RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_7_TO_29]:
    "Open for {value} days in the current episode.",
  [RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_30_TO_89]:
    "Open for {value} days in the current episode; well beyond a normal remediation window.",
  [RISK_EXPLANATION_CODES.DAYS_UNRESOLVED_90_PLUS]:
    "Open for {value} days in the current episode; long-term unresolved exposure.",

  [RISK_EXPLANATION_CODES.IOC_REPUTATION_NONE]:
    "Reputation checked: the provider holds no abuse reports for this address.",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_LOW]:
    "Reputation checked: low abuse confidence ({value}/100).",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_MEDIUM]:
    "Reputation checked: moderate abuse confidence ({value}/100).",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_HIGH]:
    "Reputation checked: high abuse confidence ({value}/100).",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_VERY_HIGH]:
    "Reputation checked: very high abuse confidence ({value}/100).",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_NOT_FOUND]:
    "Reputation unavailable: the provider holds no record for this address.",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_STALE]:
    "Reputation unavailable: the most recent lookup has expired.",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_RATE_LIMITED]:
    "Reputation unavailable: the provider rate-limited the lookup.",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_TIMEOUT]:
    "Reputation unavailable: the provider lookup timed out.",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_FAILED]:
    "Reputation unavailable: the provider lookup failed.",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_INVALID_KEY]:
    "Reputation unavailable: the provider rejected the configured credentials.",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_DISABLED]:
    "Reputation unavailable: enrichment is disabled.",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_UNSUPPORTED]:
    "Reputation unavailable: the provider does not support this indicator type.",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_PENDING]:
    "Reputation unavailable: a lookup is queued but has not completed.",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_DEAD_LETTER]:
    "Reputation unavailable: the lookup was abandoned after repeated failures.",
  [RISK_EXPLANATION_CODES.IOC_REPUTATION_ABSENT]:
    "Reputation unavailable: no lookup has been performed for this address.",

  [RISK_EXPLANATION_CODES.SECTOR_CNI]:
    "Owned by a critical national infrastructure organization.",
  [RISK_EXPLANATION_CODES.SECTOR_GOVERNMENT]: "Owned by a government organization.",
  [RISK_EXPLANATION_CODES.SECTOR_ENERGY]: "Owned by an energy-sector organization.",
  [RISK_EXPLANATION_CODES.SECTOR_HEALTHCARE]: "Owned by a healthcare organization.",
  [RISK_EXPLANATION_CODES.SECTOR_FINANCE]: "Owned by a finance-sector organization.",
  [RISK_EXPLANATION_CODES.SECTOR_TELECOM]: "Owned by a telecommunications organization.",
  [RISK_EXPLANATION_CODES.SECTOR_EDUCATION]: "Owned by an education-sector organization.",
  [RISK_EXPLANATION_CODES.SECTOR_GENERAL]: "Owned by a general-sector organization.",
  [RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_NO_OWNERSHIP]:
    "Sector criticality unavailable: no owning organization has been resolved.",
  [RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_AMBIGUOUS_OWNERSHIP]:
    "Sector criticality unavailable: ownership is ambiguous between multiple organizations.",
  [RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_UNRESOLVED_OWNERSHIP]:
    "Sector criticality unavailable: ownership is unresolved.",
  [RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_ISP_ATTRIBUTION]:
    "Sector criticality unavailable: the address maps only to an ISP, which is not confirmed victim ownership.",
  [RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_LOW_CONFIDENCE]:
    "Sector criticality unavailable: ownership confidence is too low to attribute a sector.",
  [RISK_EXPLANATION_CODES.SECTOR_NOT_AVAILABLE_UNKNOWN_SECTOR]:
    "Sector criticality unavailable: the owning organization has no recorded sector.",

  [RISK_EXPLANATION_CODES.CVE_NOT_APPLICABLE_NO_CVE_SOURCE]:
    "Vulnerability factors do not apply: this exposure report carries no CVE.",
  [RISK_EXPLANATION_CODES.CVE_PRESENT]: "A CVE is associated with this finding.",

  [RISK_EXPLANATION_CODES.KEV_NOT_APPLICABLE_NO_CVE]:
    "Known-exploited status does not apply: no CVE is associated with this finding.",
  [RISK_EXPLANATION_CODES.KEV_LISTED]:
    "The associated CVE is on the CISA Known Exploited Vulnerabilities catalogue.",
  [RISK_EXPLANATION_CODES.KEV_NOT_LISTED]:
    "The associated CVE is not on the CISA Known Exploited Vulnerabilities catalogue.",
  [RISK_EXPLANATION_CODES.KEV_NOT_AVAILABLE]:
    "Known-exploited status unavailable: the catalogue could not be consulted.",

  [RISK_EXPLANATION_CODES.EPSS_NOT_APPLICABLE_NO_CVE]:
    "Exploit prediction does not apply: no CVE is associated with this finding.",
  [RISK_EXPLANATION_CODES.EPSS_NOT_AVAILABLE]:
    "Exploit prediction unavailable: no current exploit-prediction score could be read for the associated CVEs.",
  [RISK_EXPLANATION_CODES.EPSS_LOW]: "Exploit prediction score is low.",
  [RISK_EXPLANATION_CODES.EPSS_MODERATE]: "Exploit prediction score is moderate.",
  [RISK_EXPLANATION_CODES.EPSS_HIGH]: "Exploit prediction score is high.",
  [RISK_EXPLANATION_CODES.EPSS_VERY_HIGH]: "Exploit prediction score is very high.",
});

const UNKNOWN_CODE_SENTENCE = "No explanation is recorded for this factor.";

/**
 * Renders one stored contribution row into a sentence.
 *
 * Takes the PERSISTED row, not a live evaluation. An unrecognised code (for
 * example one written by a newer configuration version this build predates)
 * degrades to a neutral sentence rather than throwing — an old score must
 * still be readable, and the stored numbers remain authoritative either way.
 */
function renderContributionExplanation(row) {
  if (!row || typeof row !== "object") return UNKNOWN_CODE_SENTENCE;
  const template = EXPLANATION_TEMPLATES[row.explanationCode];
  if (typeof template !== "string") return UNKNOWN_CODE_SENTENCE;

  const value = row.normalizedInputValue;
  return template.replace("{value}", value === null || value === undefined ? "" : String(value));
}

/**
 * Renders the full explanation for one persisted score.
 *
 * Ordering comes from the stored displayOrder, so the narrative reads in the
 * same order on every machine and every replay — never from today's
 * configuration array.
 */
function renderScoreExplanation(scoreRow, contributionRows) {
  const rows = Array.isArray(contributionRows) ? [...contributionRows] : [];
  rows.sort((a, b) => {
    const orderA = Number.isInteger(a.displayOrder) ? a.displayOrder : 0;
    const orderB = Number.isInteger(b.displayOrder) ? b.displayOrder : 0;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.factorKey).localeCompare(String(b.factorKey));
  });

  const factors = rows.map((row) => ({
    factorKey: row.factorKey,
    applicability: row.applicability,
    contributionBasisPoints: row.contributionBasisPoints,
    maximumContributionBasisPoints: row.maximumContributionBasisPoints,
    explanationCode: row.explanationCode,
    sentence: renderContributionExplanation(row),
  }));

  const applied = factors.filter((f) => f.applicability === RISK_APPLICABILITY.APPLIED);
  const contributing = applied.filter((f) => f.contributionBasisPoints > 0);
  const unavailable = factors.filter(
    (f) => f.applicability === RISK_APPLICABILITY.NOT_AVAILABLE
  );
  const notApplicable = factors.filter(
    (f) => f.applicability === RISK_APPLICABILITY.NOT_APPLICABLE
  );

  return {
    summary: buildSummarySentence(scoreRow, contributing.length, unavailable.length),
    factors,
    contributingFactorCount: contributing.length,
    unavailableFactorCount: unavailable.length,
    notApplicableFactorCount: notApplicable.length,
  };
}

// A fixed, bounded summary assembled from stored scalars only.
function buildSummarySentence(scoreRow, contributingCount, unavailableCount) {
  if (!scoreRow || typeof scoreRow !== "object") return "";
  const band = String(scoreRow.riskBand || "");
  const points = Number.isInteger(scoreRow.scoreBasisPoints) ? scoreRow.scoreBasisPoints : 0;

  const parts = [
    `Scored ${points} of 10000 basis points (${band}) from ${contributingCount} contributing factor${
      contributingCount === 1 ? "" : "s"
    }.`,
  ];
  if (unavailableCount > 0) {
    parts.push(
      `${unavailableCount} factor${unavailableCount === 1 ? " was" : "s were"} unavailable and contributed nothing.`
    );
  }
  return parts.join(" ");
}

module.exports = {
  EXPLANATION_TEMPLATES,
  UNKNOWN_CODE_SENTENCE,
  renderContributionExplanation,
  renderScoreExplanation,
};
