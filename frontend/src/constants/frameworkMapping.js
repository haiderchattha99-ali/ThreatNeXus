// Presentation vocabulary for the Phase 5 framework-mapping workspace.
//
// Mirrors backend/src/services/framework/frameworkMappingRules.js verbatim.
// Like constants/capabilities.js this is UX metadata only — the backend
// validates every one of these values itself and refuses anything outside its
// own closed vocabulary, whatever this file says.
//
// ---------------------------------------------------------------------------
// The language here is load-bearing, not decoration
// ---------------------------------------------------------------------------
// An active mapping means "an analyst associated this control with this case,
// on this basis, and wrote down why". Every label below is worded so a
// screenshot of this screen cannot be read as a compliance statement. There is
// no "compliant", no "implemented", no "covered", no percentage and no gauge.

export const FRAMEWORKS = {
  MITRE_ATTACK: 'MITRE_ATTACK',
  NIST_CSF: 'NIST_CSF',
  CIS_CONTROLS: 'CIS_CONTROLS',
}

export const FRAMEWORK_LABELS = {
  MITRE_ATTACK: 'MITRE ATT&CK',
  NIST_CSF: 'NIST CSF 2.0',
  CIS_CONTROLS: 'CIS Controls v8',
}

// Shown under each family heading. Says what a mapping in that family asserts —
// and, for ATT&CK, what it requires.
export const FRAMEWORK_NOTES = {
  MITRE_ATTACK:
    'Adversary behaviour observed in this case. Requires observed-behaviour evidence — an exposed service, a CVE, KEV membership, an EPSS score or a reputation result is not adversary behaviour.',
  NIST_CSF:
    'Analyst-associated control context. Not a compliance determination and not an assessment of whether the control is implemented.',
  CIS_CONTROLS:
    'Analyst-associated control context. Not a compliance determination and not an assessment of whether the safeguard is implemented.',
}

export const FRAMEWORK_COLORS = {
  MITRE_ATTACK: '#f0a04b',
  NIST_CSF: '#5b8def',
  CIS_CONTROLS: '#3fbf9f',
}

// Placeholder text showing the identifier shape each family expects. The
// backend format-checks these; it does NOT verify the reference exists.
export const REFERENCE_PLACEHOLDERS = {
  MITRE_ATTACK: 'T1110.001',
  NIST_CSF: 'PR.AA-05',
  CIS_CONTROLS: '4.6',
}

export const FRAMEWORK_VERSION_PLACEHOLDERS = {
  MITRE_ATTACK: 'v17.1',
  NIST_CSF: '2.0',
  CIS_CONTROLS: 'v8',
}

export const MAPPING_SCOPES = { CASE: 'CASE', FINDING: 'FINDING' }

export const MAPPING_SCOPE_LABELS = {
  CASE: 'The case as a whole',
  FINDING: 'One specific linked finding',
}

export const EVIDENCE_BASES = {
  OBSERVED_BEHAVIOR: 'OBSERVED_BEHAVIOR',
  CONTROL_GAP: 'CONTROL_GAP',
  REMEDIATION_ALIGNMENT: 'REMEDIATION_ALIGNMENT',
  ANALYST_ASSESSMENT: 'ANALYST_ASSESSMENT',
}

export const EVIDENCE_BASIS_LABELS = {
  OBSERVED_BEHAVIOR: 'Observed behaviour',
  CONTROL_GAP: 'Control gap',
  REMEDIATION_ALIGNMENT: 'Remediation alignment',
  ANALYST_ASSESSMENT: 'Analyst assessment',
}

export const EVIDENCE_BASIS_HINTS = {
  OBSERVED_BEHAVIOR: 'Something was observed, logged or reported to have happened.',
  CONTROL_GAP: 'A control appears absent or ineffective. Asserts nothing about adversary activity.',
  REMEDIATION_ALIGNMENT: 'The recommended remediation aligns with this control.',
  ANALYST_ASSESSMENT: 'A stated professional judgement. Asserts nothing about adversary activity.',
}

// The ONLY basis a MITRE ATT&CK mapping may carry, enforced server-side.
export const ATTACK_REQUIRED_EVIDENCE_BASIS = EVIDENCE_BASES.OBSERVED_BEHAVIOR

export const ATTACK_EVIDENCE_WARNING =
  'A MITRE ATT&CK mapping asserts that adversary behaviour occurred. It must rest on observed ' +
  'behaviour tied to this case or to a linked finding — logs, telemetry, an incident report, or ' +
  'something the constituent confirmed. An exposed service, an open port, a CVE, KEV membership, ' +
  'an EPSS score, a reputation result, the sector and the risk score are NOT adversary behaviour, ' +
  'and a rationale resting only on those will be refused.'

export const MAPPING_STATES = { ACTIVE: 'ACTIVE', REMOVED: 'REMOVED' }

export const MAPPING_STATE_LABELS = { ACTIVE: 'Active', REMOVED: 'Removed' }

export const MAPPING_STATE_COLORS = { ACTIVE: '#3fbf9f', REMOVED: '#9DAFC2' }

export const MAPPING_SOURCES = { MANUAL: 'MANUAL', AI_SUGGESTION_PROMOTED: 'AI_SUGGESTION_PROMOTED' }

export const MAPPING_SOURCE_LABELS = {
  MANUAL: 'Created by analyst',
  // Deliberately NOT "created by AI". A human reviewed the content and made
  // the mapping; the label records where the wording originated.
  AI_SUGGESTION_PROMOTED: 'Analyst-approved AI suggestion',
}

export const SUGGESTION_STATES = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
}

export const SUGGESTION_STATE_LABELS = {
  PENDING: 'Awaiting your decision',
  APPROVED: 'Approved and mapped',
  REJECTED: 'Rejected',
}

export const SUGGESTION_STATE_COLORS = {
  PENDING: '#b08bf0',
  APPROVED: '#3fbf9f',
  REJECTED: '#9DAFC2',
}

// Closed reason codes the backend returns on a refused run. Rendered as
// sentences so an analyst is told what happened rather than shown an enum.
export const RUN_REASON_LABELS = {
  AI_DISABLED: 'AI assistance is disabled. No provider was contacted.',
  AI_PROVIDER_NOT_AVAILABLE:
    'AI assistance is enabled but no approved provider is configured. No provider was contacted.',
  SUGGESTIONS_GENERATED: 'Suggestions were generated for your review.',
  NO_SUGGESTIONS_RETURNED: 'The assistant proposed nothing for this case.',
  ALL_CANDIDATES_REJECTED:
    'Every candidate the assistant proposed failed validation and was discarded.',
  PROVIDER_FAILED: 'The assistant could not be reached or returned an error. Nothing was recorded.',
  PROVIDER_MALFORMED_RESULT:
    'The assistant returned output this system could not read. Nothing was recorded.',
}

export const AI_DISABLED_MESSAGE = 'AI assistance is disabled.'

export const AI_DISABLED_DETAIL =
  'ThreatNeXus ships with AI assistance switched off. Every part of the framework-mapping ' +
  'workflow works without it — you can create, remove and reactivate mappings by hand exactly as ' +
  'you would with it enabled. When it is on, it only ever proposes candidates for you to accept ' +
  'or reject; it cannot create a mapping, score anything, or decide anything on its own.'

// Shown wherever a suggestion is displayed.
export const AI_ADVISORY_NOTE =
  'These are proposals, not decisions. Nothing here changes this case until you approve it, and ' +
  'approving it records you as the analyst who made the mapping.'

export const STALE_SUGGESTION_NOTE =
  'The evidence on this case has changed since this suggestion was generated, so it can no longer ' +
  'be approved. Request fresh suggestions against the case as it now stands.'

// Closed rejection codes, rendered as advice.
export const MAPPING_ERROR_MESSAGES = {
  ATTACK_REQUIRES_OBSERVED_BEHAVIOR:
    'A MITRE ATT&CK mapping requires the observed-behaviour evidence basis.',
  ATTACK_RATIONALE_TOO_SHORT:
    'Describe the observed behaviour in more detail — an ATT&CK technique assertion needs a full explanation.',
  ATTACK_RATIONALE_NOT_BEHAVIOURAL:
    'Describe what was actually observed, logged or reported. Exposure and vulnerability signals alone are not adversary behaviour.',
  ATTACK_EXPOSURE_ONLY_RATIONALE:
    'This rationale rests only on exposure, vulnerability, reputation or risk signals. An ATT&CK mapping needs observed behaviour.',
  ATTACK_EVIDENCE_NOT_LINKED:
    'Link the finding this behaviour was observed on before mapping an ATT&CK technique to this case.',
  EVIDENCE_FINDING_NOT_LINKED:
    'That finding is not currently linked to this case. Link it first, or map at case scope.',
  EVIDENCE_FINDING_REQUIRED_FOR_SCOPE:
    'A finding-scoped mapping must name the finding it is about.',
  MAPPING_NOT_CURRENT:
    'This mapping is no longer the current one for its reference. Reload the case and try again.',
  MAPPING_NOT_FOR_CASE: 'That mapping belongs to a different case.',
  CASE_NOT_ORGANIZATION_BOUND:
    'This case is not bound to an organization, so framework mappings cannot be recorded on it.',
  SUGGESTION_STALE:
    'The evidence on this case has changed since this suggestion was generated. Request fresh suggestions.',
  SUGGESTION_NOT_FOR_CASE: 'That suggestion belongs to a different case.',
  SUGGESTION_CONTENT_INVALID:
    'This suggestion no longer passes validation and cannot be approved.',
}

export function describeMappingError(error) {
  const data = error?.response?.data
  if (!data) return 'Something went wrong. Please try again.'
  if (data.code && MAPPING_ERROR_MESSAGES[data.code]) return MAPPING_ERROR_MESSAGES[data.code]
  if (typeof data.message === 'string' && data.message.trim() !== '') return data.message
  if (Array.isArray(data.fields) && data.fields.length > 0) {
    return `Check these fields: ${data.fields.join(', ')}`
  }
  return 'Something went wrong. Please try again.'
}
