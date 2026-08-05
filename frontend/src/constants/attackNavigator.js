// Vocabulary for the ATT&CK navigator (Phase 6.3).
//
// Kept beside the other constants files rather than in theme/tokens.js because
// these are DOMAIN states, not design tokens — the tone each one carries is a
// consequence of what the state means, and a palette change must not be able to
// silently re-encode "needs review" as "fine".
//
// ---------------------------------------------------------------------------
// Status is never communicated by colour alone
// ---------------------------------------------------------------------------
// Every dictionary entry carries a LABEL and an ICON as well as a tone, because
// the build guard requires it and because an analyst with a colour-vision
// difference reading a matrix of shaded cells would otherwise be reading noise.
// The matrix additionally prints the raw count inside each cell, so the
// information survives even if every colour were stripped.

// A technique cell's state. Deliberately only two values: a technique either
// has mappings resting on this CERT's evidence, or it does not. There is no
// "partially covered" — that would be a coverage judgement, and no honest
// denominator exists to make one against.
export const TECHNIQUE_STATUS = Object.freeze({
  MAPPED: { label: 'Mapped', tone: 'accent', icon: 'check' },
  UNMAPPED: { label: 'No mappings', tone: 'neutral', icon: 'dot' },
})

// A tactic column's state.
export const TACTIC_STATUS = Object.freeze({
  PRESENT_IN_EVIDENCE: { label: 'Present in evidence', tone: 'accent', icon: 'check' },
  EMPTY: { label: 'Empty', tone: 'neutral', icon: 'dot' },
})

// Why a mapping is flagged for a human. Each is independently checkable and
// each is rendered distinctly — they are FLAGS, never automatic actions.
// Nothing withdraws, downgrades, hides or re-scores a mapping on their account.
export const REVIEW_REASON = Object.freeze({
  LEGACY_UNVERIFIED: {
    label: 'Legacy — unverified',
    tone: 'warning',
    icon: 'clock',
    description:
      'Recorded before catalogue validation and evidence quoting existed. Its reference was ' +
      'format-checked only and it carries no verbatim evidence quote. It is shown unchanged ' +
      'and is not claimed to be verified.',
  },
  LOW_MAPPING_CONFIDENCE: {
    label: 'Low mapping confidence',
    tone: 'info',
    icon: 'dot',
    description:
      'The analyst declared low confidence that this framework reference is the right one for ' +
      'the evidence. That is an honest record, not a defect — it is surfaced so a reviewer can ' +
      'decide whether to look again.',
  },
  STALE_CATALOGUE_VERSION: {
    label: 'Stale catalogue version',
    tone: 'warning',
    icon: 'clock',
    description:
      'Verified against an ATT&CK release this system no longer pins. The check that passed is ' +
      'not the check that would run today.',
  },
})

// Whether the navigator could be built at all. UNAVAILABLE is rendered as an
// explicit state, never as an empty matrix — an empty grid reads as "nothing is
// mapped", which is a completely different and much more reassuring claim than
// "the catalogue could not be loaded".
export const NAVIGATOR_AVAILABILITY = Object.freeze({
  AVAILABLE: { label: 'Available', tone: 'success', icon: 'check' },
  UNAVAILABLE: { label: 'Unavailable', tone: 'danger', icon: 'alert' },
})

export const EVIDENCE_QUOTE_SOURCE = Object.freeze({
  FINDING_RECORD: { label: 'Finding record', tone: 'info', icon: 'dot' },
  RAW_REPORT_ROW: { label: 'Ingested report row', tone: 'info', icon: 'dot' },
  CASE_RESPONSE: { label: 'Organization response', tone: 'info', icon: 'dot' },
})

export const CONFIDENCE = Object.freeze({
  LOW: { label: 'Low', tone: 'neutral', icon: 'dot' },
  MEDIUM: { label: 'Medium', tone: 'info', icon: 'dot' },
  HIGH: { label: 'High', tone: 'accent', icon: 'check' },
})

// The filter a reviewer reaches for. "Needs review" is the working queue;
// "Legacy" is the migration backlog; the two overlap but are not the same
// question, so they are separate filters rather than one combined one.
export const STATUS_FILTERS = Object.freeze([
  { value: 'ALL', label: 'All techniques' },
  { value: 'MAPPED', label: 'Mapped' },
  { value: 'UNMAPPED', label: 'No mappings' },
  { value: 'NEEDS_REVIEW', label: 'Needs review' },
  { value: 'LEGACY', label: 'Legacy / unverified' },
])

// The sentence printed wherever a reader might expect a coverage figure.
//
// Stated positively and in full, rather than simply omitting the number: an
// absent metric invites a reader to assume it was forgotten, or to compute
// their own. This says why there is not one.
export const NO_COVERAGE_EXPLANATION =
  'No coverage percentage is shown, and none is computed. A percentage would need a count of ' +
  'the techniques that SHOULD apply to these constituents, which nobody knows. Every figure ' +
  'here is a raw count of mappings that exist in the loaded dataset.'

// Printed under the matrix. The build guard requires dashboards to describe the
// loaded dataset and never to present figures as national statistics.
export const DATASET_SCOPE_NOTE =
  'Describes the cases and findings currently loaded in this system only. Not a measure of ' +
  'national exposure, and not a claim of visibility beyond the reports ingested here.'
