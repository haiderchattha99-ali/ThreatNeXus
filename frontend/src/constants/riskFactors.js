// The Risk v1 truth layer, rendered in English.
//
// Risk v1 stores two identifiers per contribution row: a `factorKey` (which of
// the ten locked factors this is) and an `explanationCode` (which bucket of that
// factor's evidence was matched). Both are storage identifiers, and both used to
// reach the screen raw — `sourceSeverity` and `IOC_REPUTATION_NOT_FOUND` were
// printed at an analyst as if they were sentences.
//
// This file is the ONE place either identifier becomes words. Three rules make
// that a projection of stored evidence rather than a narrative:
//
//   1. Every entry is a FIXED string keyed off the engine's own closed
//      vocabulary (RISK_FACTOR_KEYS / RISK_EXPLANATION_CODES in
//      backend/src/services/risk/riskConfiguration.js). Nothing is generated,
//      nothing is inferred from the numbers, and no model is involved.
//   2. An unknown key or code is never hidden and never guessed at. It falls
//      back to a mechanical de-casing of the identifier itself, so a factor or
//      bucket added to the engine later is legible on the screen the day it
//      ships instead of vanishing.
//   3. The raw code is still rendered beside the sentence wherever it was
//      before. The words are for reading; the code is what an analyst quotes in
//      a case note, and removing it would cost provenance to buy prettiness.
//
// "Could not read the evidence" is never worded as "clean", and "measured and it
// added nothing" is never worded as "unknown". That distinction is the whole
// reason the applicability column exists.

// ---------------------------------------------------------------------------
// Factors (Prisma RiskFactorContribution.factorKey)
// ---------------------------------------------------------------------------
//
// `label` is the analyst-facing name; `meaning` states what the factor measures
// in one line, because a factor contributing zero is only interpretable if you
// know what it was looking for.
export const RISK_FACTOR_LABEL = Object.freeze({
  sourceSeverity: {
    label: 'Source severity',
    meaning: 'Severity carried by the report type the finding came from.',
  },
  exposureCriticality: {
    label: 'Exposure criticality',
    meaning: 'How critical the exposed service itself is. An exposure, never evidence of intrusion.',
  },
  persistence: {
    label: 'Persistence',
    meaning: 'How many separate reports have observed this finding.',
  },
  recurrence: {
    label: 'Recurrence',
    meaning: 'How often it returned after its case was closed.',
  },
  daysUnresolved: {
    label: 'Days unresolved',
    meaning: 'Elapsed time since the finding was first observed and still open.',
  },
  iocReputationContext: {
    label: 'IOC reputation context',
    meaning: 'Stored reputation context for the indicator. Supporting context, never proof.',
  },
  sectorCriticality: {
    label: 'Sector criticality',
    meaning: "Criticality of the owning organization's sector, where ownership resolved.",
  },
  cvePresence: {
    label: 'CVE presence',
    meaning: 'Whether a CVE is associated with the finding at all.',
  },
  kevStatus: {
    label: 'KEV status',
    meaning: 'Whether an associated CVE appears on the CISA known-exploited list.',
  },
  epssScore: {
    label: 'EPSS probability',
    meaning: 'FIRST exploitation-probability score for an associated CVE.',
  },
})

// ---------------------------------------------------------------------------
// Explanation codes (Prisma RiskFactorContribution.explanationCode)
// ---------------------------------------------------------------------------
//
// One short sentence per bucket, written to be read in a table cell. Each states
// what was OBSERVED, not what it implies.
export const RISK_EXPLANATION_LABEL = Object.freeze({
  SOURCE_SEVERITY_ACCESSIBLE_RDP: 'Severity carried by an accessible-RDP report.',
  SOURCE_SEVERITY_NOT_AVAILABLE: 'The report type carried no severity that could be read.',

  EXPOSURE_CRITICALITY_REMOTE_ACCESS_RDP: 'Remote-access service (RDP) exposed.',
  EXPOSURE_CRITICALITY_NOT_AVAILABLE: 'The exposed service could not be classified.',

  PERSISTENCE_NO_EVIDENCE: 'No observation history to weigh.',
  PERSISTENCE_SINGLE_OBSERVATION: 'Observed once.',
  PERSISTENCE_REPEATED: 'Observed in several reports.',
  PERSISTENCE_SUSTAINED: 'Observed repeatedly over many reports.',
  PERSISTENCE_ENTRENCHED: 'Observed in report after report without interruption.',

  RECURRENCE_NONE: 'Has not returned after a closure.',
  RECURRENCE_ONCE_AFTER_CLOSURE: 'Returned once after its case was closed.',
  RECURRENCE_REPEATED_AFTER_CLOSURE: 'Returned more than once after closure.',
  RECURRENCE_CHRONIC_AFTER_CLOSURE: 'Returns persistently after every closure.',

  DAYS_UNRESOLVED_NOT_APPLICABLE_CLOSED: 'Closed, so unresolved time does not apply.',
  DAYS_UNRESOLVED_INVALID_TIMESTAMP: 'Stored timestamps could not be compared.',
  DAYS_UNRESOLVED_UNDER_7: 'Open for under 7 days.',
  DAYS_UNRESOLVED_7_TO_29: 'Open for 7 to 29 days.',
  DAYS_UNRESOLVED_30_TO_89: 'Open for 30 to 89 days.',
  DAYS_UNRESOLVED_90_PLUS: 'Open for 90 days or more.',

  IOC_REPUTATION_NONE: 'Looked up: no abuse reports on record.',
  IOC_REPUTATION_LOW: 'Looked up: a low volume of abuse reports.',
  IOC_REPUTATION_MEDIUM: 'Looked up: a moderate volume of abuse reports.',
  IOC_REPUTATION_HIGH: 'Looked up: a high volume of abuse reports.',
  IOC_REPUTATION_VERY_HIGH: 'Looked up: a very high volume of abuse reports.',
  IOC_REPUTATION_NOT_FOUND: 'The provider held no record of this indicator.',
  IOC_REPUTATION_STALE: 'The stored lookup is past its freshness window.',
  IOC_REPUTATION_RATE_LIMITED: 'The provider rate-limited the lookup, so nothing was read.',
  IOC_REPUTATION_TIMEOUT: 'The lookup timed out, so nothing was read.',
  IOC_REPUTATION_FAILED: 'The lookup failed, so nothing was read.',
  IOC_REPUTATION_INVALID_KEY: 'The provider rejected the configured credential.',
  IOC_REPUTATION_DISABLED: 'Reputation lookups are switched off.',
  IOC_REPUTATION_UNSUPPORTED: 'This kind of indicator cannot be looked up.',
  IOC_REPUTATION_PENDING: 'A lookup is queued and has not run yet.',
  IOC_REPUTATION_DEAD_LETTER: 'The lookup was abandoned after repeated failure.',
  IOC_REPUTATION_ABSENT: 'No reputation lookup has ever been recorded.',

  SECTOR_CNI: 'Owner sits in critical national infrastructure.',
  SECTOR_GOVERNMENT: 'Owner is a government body.',
  SECTOR_ENERGY: 'Owner is in the energy sector.',
  SECTOR_HEALTHCARE: 'Owner is in healthcare.',
  SECTOR_FINANCE: 'Owner is in finance.',
  SECTOR_TELECOM: 'Owner is in telecommunications.',
  SECTOR_EDUCATION: 'Owner is in education.',
  SECTOR_GENERAL: 'Owner is in a general sector.',
  SECTOR_NOT_AVAILABLE_NO_OWNERSHIP: 'No owner is attributed, so no sector could be read.',
  SECTOR_NOT_AVAILABLE_AMBIGUOUS_OWNERSHIP: 'Ownership was ambiguous, so no sector was taken.',
  SECTOR_NOT_AVAILABLE_UNRESOLVED_OWNERSHIP: 'Ownership is unresolved, so no sector could be read.',
  SECTOR_NOT_AVAILABLE_ISP_ATTRIBUTION: 'Only the network operator is known, which names no sector.',
  SECTOR_NOT_AVAILABLE_LOW_CONFIDENCE: 'Ownership confidence was too low to take a sector from.',
  SECTOR_NOT_AVAILABLE_UNKNOWN_SECTOR: "The owner's sector is not recorded.",

  CVE_NOT_APPLICABLE_NO_CVE_SOURCE: 'No CVE has been associated with this host.',
  CVE_PRESENT: 'An analyst has associated a CVE with this host.',

  KEV_NOT_APPLICABLE_NO_CVE: 'No associated CVE, so KEV cannot apply.',
  KEV_LISTED: 'An associated CVE is on the CISA known-exploited list.',
  KEV_NOT_LISTED: 'Checked: no associated CVE is on the CISA list.',
  KEV_NOT_AVAILABLE: 'The CISA list could not be read.',

  EPSS_NOT_APPLICABLE_NO_CVE: 'No associated CVE, so EPSS cannot apply.',
  EPSS_NOT_AVAILABLE: 'No usable EPSS score could be read for the associated CVEs.',
  EPSS_LOW: 'EPSS read: negligible exploitation probability.',
  EPSS_MODERATE: 'EPSS read: moderate exploitation probability.',
  EPSS_HIGH: 'EPSS read: high exploitation probability.',
  EPSS_VERY_HIGH: 'EPSS read: very high exploitation probability.',
})

// Turns an unmapped identifier into something readable without pretending to
// know what it means. `IOC_REPUTATION_NEW_BUCKET` becomes "Ioc reputation new
// bucket"; `someNewFactor` becomes "Some new factor". Ugly on purpose — an
// unmapped identifier should look unmapped.
function decase(identifier) {
  return String(identifier)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase())
}

/** The analyst-facing name of one stored factor key. */
export function factorLabel(factorKey) {
  return RISK_FACTOR_LABEL[factorKey]?.label || decase(factorKey)
}

/** What that factor measures, for the rows where zero needs a reading. */
export function factorMeaning(factorKey) {
  return RISK_FACTOR_LABEL[factorKey]?.meaning || null
}

/** The sentence for one stored explanation code. */
export function explanationSentence(explanationCode) {
  if (!explanationCode) return null
  return RISK_EXPLANATION_LABEL[explanationCode] || decase(explanationCode)
}

export default {
  RISK_FACTOR_LABEL,
  RISK_EXPLANATION_LABEL,
  factorLabel,
  factorMeaning,
  explanationSentence,
}
