// One Finding, ordered by the decision it exists to support.
//
// WHAT CHANGED, AND WHY IT WAS WRONG BEFORE
// -----------------------------------------
// This page used to be about 3,700px of equal-weight panels ending in "Record
// triage" — the one control that moves work forward sat last, below a disabled
// AI panel and a provider table that is empty in a fresh instance. An analyst
// arriving to make a decision had to scroll past everything that was NOT the
// decision to reach it. Reading order is a claim about priority, and that order
// claimed the opposite of the truth.
//
// The page now answers, in this order:
//   1. WHAT IS THIS, HOW BAD, WHO OWNS IT  — the decision summary strip
//   2. WHAT DO I DO ABOUT IT               — triage, first panel on the page
//   3. WHY IS IT SCORED THAT WAY           — identity, ownership, Risk v1
//   4. WHAT ELSE IS KNOWN                  — reputation, CVEs, timeline, cases
//   5. OPTIONAL SUBSYSTEMS                 — enrichment and AI, behind a
//                                            disclosure, mounted either way
// A section rail sticks under the app bar so any of those is one click away
// instead of one scroll-hunt away.
//
// The risk section is still the important one, and its rules are unchanged. It
// is rendered ENTIRELY from the factor contribution rows the scoring engine
// stored — this page performs no scoring arithmetic, applies no weights, and
// does not re-derive a band. Risk v1 is a locked, deterministic, explainable
// contract; the explanation is a projection of stored evidence, never a
// narrative generated at read time.
//
// The three applicability values are shown distinctly and never collapsed:
//   APPLIED         real evidence was scored (including a legitimate zero)
//   NOT_AVAILABLE   the evidence could not be obtained
//   NOT_APPLICABLE  the factor cannot apply to this kind of finding at all
// Flattening "we could not check" into "clean" is exactly the failure this
// distinction exists to prevent — which is also why the disclosure that hides
// the non-contributing factors COUNTS them by state in its own summary line.
// Shortening the page must never cost a fact.

import React from 'react'
import { Link as RouterLink, useParams } from 'react-router-dom'
import {
  Box,
  Button,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Link,
  Alert,
} from '@mui/material'
import { FiArrowLeft, FiRefreshCw } from 'react-icons/fi'

import { findingService } from '../services/api'
import { FindingTriagePanel } from '../components/FindingTriagePanel'
import { FindingAiAssistPanel } from '../components/FindingAiAssistPanel'
import { FindingEnrichmentPanel } from '../components/FindingEnrichmentPanel'
import {
  PageHeader,
  Panel,
  Field,
  FieldGrid,
  StatusBadge,
  RiskBandBadge,
  ErrorState,
  EmptyState,
  UnavailableState,
  Provenance,
  Timeline,
  SectionLabel,
  formatAsOf,
} from '../components/ui'
import { TRIAGE_LABELS } from '../constants/caseWorkflow'
import { factorLabel, factorMeaning, explanationSentence } from '../constants/riskFactors'
import {
  FINDING_STATUS,
  FINDING_LIFECYCLE,
  OWNERSHIP_CONFIDENCE,
  OWNERSHIP_STATUS,
  OWNERSHIP_REASON,
  CASE_STATE,
  color,
  layout,
  type,
  font,
  radius,
} from '../theme/tokens'

const APPLICABILITY = {
  APPLIED: { label: 'Applied', tone: 'accent', icon: 'check' },
  NOT_AVAILABLE: { label: 'Evidence not available', tone: 'warning', icon: 'warning' },
  NOT_APPLICABLE: { label: 'Not applicable', tone: 'neutral', icon: 'minus' },
}

const ENRICHMENT_STATUS = {
  SUCCESS: { label: 'Lookup succeeded', tone: 'success', icon: 'check' },
  NOT_FOUND: { label: 'Not found', tone: 'neutral', icon: 'minus' },
  PENDING: { label: 'Queued', tone: 'info', icon: 'clock' },
  RATE_LIMITED: { label: 'Rate limited', tone: 'warning', icon: 'clock' },
  INVALID_KEY: { label: 'Invalid API key', tone: 'danger', icon: 'cross' },
  TIMEOUT: { label: 'Timed out', tone: 'warning', icon: 'clock' },
  FAILED: { label: 'Lookup failed', tone: 'danger', icon: 'cross' },
  UNSUPPORTED_INDICATOR: { label: 'Unsupported indicator', tone: 'neutral', icon: 'minus' },
  SKIPPED_DISABLED: { label: 'Provider disabled', tone: 'neutral', icon: 'power' },
  DEAD_LETTER: { label: 'Abandoned after repeated failure', tone: 'danger', icon: 'cross' },
}

const OCCURRENCE_ACTION = {
  CREATED: { label: 'First observed', tone: 'info', icon: 'plus' },
  PERSISTED: { label: 'Observed again', tone: 'warning', icon: 'repeat' },
  RECURRED: { label: 'Recurred after closure', tone: 'danger', icon: 'rotate' },
  HISTORICAL: { label: 'Back-dated observation', tone: 'neutral', icon: 'clock' },
}

// The sticky rail's targets. Order IS the page order, and the labels are the
// questions the sections answer rather than the tables they contain.
const SECTIONS = [
  { id: 'tnx-triage', label: 'Triage' },
  { id: 'tnx-identity', label: 'Identity and owner' },
  { id: 'tnx-risk', label: 'Risk v1' },
  { id: 'tnx-context', label: 'Reputation and CVEs' },
  { id: 'tnx-timeline', label: 'Observations' },
  { id: 'tnx-cases', label: 'Cases' },
  { id: 'tnx-optional', label: 'Enrichment and AI' },
]

// Clears the fixed app bar AND the sticky rail, so an anchored heading lands
// below both instead of underneath them.
const ANCHOR_OFFSET = layout.topBarHeight + 60

function lifecycleOf(finding) {
  if (finding.recurrenceCount > 0) return 'RECURRED'
  if (finding.occurrenceCount > 1) return 'PERSISTED'
  return 'CREATED'
}

// One hairline-separated strip. The 1px grid gap on a bordered background IS
// the hairline, so the dividers stay correct however the cells wrap — no
// nth-child arithmetic that breaks at one breakpoint.
function DecisionSummary({ cells }) {
  return (
    <Box
      component="section"
      aria-label="Decision summary"
      data-decision-summary
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          sm: 'repeat(2, minmax(0, 1fr))',
          lg: `repeat(${cells.length}, minmax(0, 1fr))`,
        },
        gap: '1px',
        backgroundColor: color.border,
        border: `1px solid ${color.border}`,
        borderRadius: `${radius.md}px`,
        overflow: 'hidden',
        mb: 2,
        // An odd number of cells in the two-up layout would otherwise leave a
        // blank half-panel hanging off the bottom row, which reads as a cell
        // whose content failed to load rather than as a deliberate end.
        ...(cells.length % 2 === 1
          ? { '& > :last-of-type': { gridColumn: { xs: 'auto', sm: 'span 2', lg: 'auto' } } }
          : null),
      }}
    >
      {cells.map((cell) => (
        <Box key={cell.label} sx={{ backgroundColor: color.surface, px: 2, py: 1.75, minWidth: 0 }}>
          {/* Deliberately not headings: five micro-labels in the page outline
              would be noise for a screen-reader user navigating by heading, and
              the region already names itself. */}
          <SectionLabel>{cell.label}</SectionLabel>
          <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            {cell.value}
          </Box>
          {cell.detail && (
            <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.75, overflowWrap: 'anywhere' }}>
              {cell.detail}
            </Box>
          )}
        </Box>
      ))}
    </Box>
  )
}

function SectionRail({ sections }) {
  return (
    <Box
      component="nav"
      aria-label="Sections of this finding"
      sx={{
        position: 'sticky',
        top: `${layout.topBarHeight}px`,
        zIndex: 2,
        display: 'flex',
        gap: 0.5,
        mb: 2,
        py: 1,
        // The rail sits over scrolling evidence, so it needs its own ground.
        backgroundColor: color.canvas,
        borderBottom: `1px solid ${color.border}`,
        // Narrow viewports scroll the rail rather than wrapping it into a block
        // that eats the first screen.
        overflowX: 'auto',
        scrollbarWidth: 'thin',
      }}
    >
      {sections.map((section) => (
        <Box
          key={section.id}
          component="a"
          href={`#${section.id}`}
          sx={{
            flexShrink: 0,
            px: 1.25,
            py: 0.75,
            borderRadius: `${radius.sm}px`,
            ...type.caption,
            fontWeight: 600,
            color: color.textMuted,
            textDecoration: 'none',
            whiteSpace: 'nowrap',
            '&:hover': { color: color.text, backgroundColor: color.surfaceRaised },
            '&:focus-visible': { outline: `2px solid ${color.borderFocus}`, outlineOffset: 2 },
          }}
        >
          {section.label}
        </Box>
      ))}
    </Box>
  )
}

// A section wrapper that owns its anchor and its scroll offset, so no page
// heading is ever left hidden under the app bar after a rail click.
function Section({ id, children, sx = {} }) {
  return (
    <Box id={id} sx={{ scrollMarginTop: `${ANCHOR_OFFSET}px`, mb: 2, ...sx }}>
      {children}
    </Box>
  )
}

// Native <details>. Progressive disclosure with no JavaScript, no focus trap and
// no chance of stranding content: the children are mounted and fetched either
// way, so collapsing changes what is SHOWN, never what is known.
function Disclosure({ summary, hint, children }) {
  return (
    <Box
      component="details"
      sx={{
        // A grid/flex item's default `min-width: auto` refuses to shrink below
        // its content's min-content width, so a wide evidence table inside would
        // push the DOCUMENT sideways instead of scrolling inside its own
        // TableContainer. Measured: 607px of document scroll at a 390px
        // viewport with the enrichment panel disclosed. This one line is what
        // lets the container do the job it was already configured for.
        minWidth: 0,
        border: `1px solid ${color.border}`,
        borderRadius: `${radius.md}px`,
        backgroundColor: color.surfaceSunken,
        px: 2,
        py: 1.5,
        '& > summary': {
          cursor: 'pointer',
          width: 'fit-content',
          color: color.link,
          ...type.bodyStrong,
          '&:hover': { color: color.linkHover },
          '&:focus-visible': { outline: `2px solid ${color.borderFocus}`, outlineOffset: 3 },
        },
        '&[open] > summary': { mb: 1.5 },
      }}
    >
      <Box component="summary">{summary}</Box>
      {hint && <Box sx={{ ...type.caption, color: color.textMuted, mb: 1.5 }}>{hint}</Box>}
      {children}
    </Box>
  )
}

function FactorRows({ contributions, showMeaning = false }) {
  return contributions.map((c) => (
    <TableRow key={c.factorKey}>
      <TableCell>
        <Box sx={{ ...type.small, color: color.text }}>{factorLabel(c.factorKey)}</Box>
        {/* Shown only where a factor added nothing: "why is this zero?" is not
            answerable without knowing what the factor was looking for, and that
            is exactly the set of rows where the question gets asked. */}
        {showMeaning && factorMeaning(c.factorKey) && (
          <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.4, maxWidth: '38ch' }}>
            {factorMeaning(c.factorKey)}
          </Box>
        )}
        <Box sx={{ ...type.caption, color: color.textFaint, fontFamily: font.mono, mt: 0.3 }}>
          {c.explanationCode}
        </Box>
      </TableCell>
      <TableCell>
        {/* The sentence is what an analyst reads; the code above is what they
            quote. Both are stored values, neither is generated. */}
        <Box sx={{ ...type.small, color: color.textMuted, maxWidth: '46ch' }}>
          {explanationSentence(c.explanationCode)}
        </Box>
        {c.normalizedInputValue !== null && c.normalizedInputValue !== undefined && (
          <Box sx={{ ...type.caption, color: color.textFaint, fontFamily: font.mono, mt: 0.3 }}>
            stored input {c.normalizedInputValue}
          </Box>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge dictionary={APPLICABILITY} value={c.applicability} size="small" />
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        <Box sx={{ fontFamily: font.mono, fontSize: 12.5, color: color.text }}>
          {(c.contributionBasisPoints / 100).toFixed(2)}
        </Box>
        <Box sx={{ fontFamily: font.mono, fontSize: 11, color: color.textFaint, mt: 0.3 }}>
          of {(c.maximumContributionBasisPoints / 100).toFixed(2)}
        </Box>
      </TableCell>
    </TableRow>
  ))
}

function FactorTable({ contributions, label, showMeaning = false }) {
  return (
    <TableContainer>
      <Table size="small" aria-label={label}>
        <TableHead>
          <TableRow>
            <TableCell scope="col">Factor</TableCell>
            <TableCell scope="col">What the stored evidence said</TableCell>
            <TableCell scope="col">Applicability</TableCell>
            <TableCell scope="col" align="right">
              Points
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <FactorRows contributions={contributions} showMeaning={showMeaning} />
        </TableBody>
      </Table>
    </TableContainer>
  )
}

// "6 factors added nothing — 4 measured, 2 with no readable evidence" is the
// whole point of this sentence. A count that said only "6 factors added
// nothing" would be the flattening this page exists to prevent.
function describeSilent(silent) {
  const measured = silent.filter((c) => c.applicability === 'APPLIED').length
  const unreadable = silent.filter((c) => c.applicability === 'NOT_AVAILABLE').length
  const inapplicable = silent.filter((c) => c.applicability === 'NOT_APPLICABLE').length
  const parts = []
  if (measured) parts.push(`${measured} measured and weighed nothing`)
  if (unreadable) parts.push(`${unreadable} with no readable evidence`)
  if (inapplicable) parts.push(`${inapplicable} that cannot apply here`)
  return `${silent.length} factor${silent.length === 1 ? '' : 's'} added no points — ${parts.join(', ')}`
}

function RiskExplanation({ risk }) {
  if (!risk) {
    return (
      <EmptyState title="No risk score has been calculated yet" dense>
        A deterministic Risk v1 score is written when evidence about this Finding
        changes. None has been recorded for it so far — this is not a score of
        zero.
      </EmptyState>
    )
  }

  const contributions = risk.contributions || []
  const contributing = contributions.filter((c) => c.contributionBasisPoints > 0)
  const silent = contributions.filter((c) => !(c.contributionBasisPoints > 0))

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          flexWrap: 'wrap',
          pb: 2.5,
          mb: 2.5,
          borderBottom: `1px solid ${color.border}`,
        }}
      >
        <Box>
          <SectionLabel>Current score</SectionLabel>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mt: 0.75 }}>
            <Box sx={{ ...type.metric, color: color.text }}>{risk.displayScore}</Box>
            <RiskBandBadge band={risk.riskBand} />
          </Box>
        </Box>
        <Box>
          <SectionLabel>Algorithm</SectionLabel>
          <Box sx={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, mt: 1 }}>
            {risk.algorithmVersion}
            <br />
            {risk.configurationVersion}
          </Box>
        </Box>
        <Box>
          <SectionLabel>Evaluated as of</SectionLabel>
          <Box sx={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, mt: 1 }}>
            {formatAsOf(risk.asOf) || '—'}
          </Box>
        </Box>
        <Box>
          <SectionLabel>Triggered by</SectionLabel>
          <Box sx={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, mt: 1 }}>
            {risk.trigger}
          </Box>
        </Box>
      </Box>

      {contributing.length === 0 ? (
        // Nothing contributed, so there is no "rest" to fold away. Every row is
        // shown, because the reason each one is silent is the entire answer.
        <FactorTable contributions={contributions} label="Risk factor contributions" showMeaning />
      ) : (
        <>
          <FactorTable contributions={contributing} label="Risk factors contributing to this score" />
          {silent.length > 0 && (
            <Box sx={{ mt: 2 }}>
              <Disclosure
                summary={describeSilent(silent)}
                hint="Measured-and-zero, unreadable and inapplicable are three different facts. They are kept apart here, and none of them means the finding is clean."
              >
                <FactorTable contributions={silent} label="Risk factors contributing no points" showMeaning />
              </Disclosure>
            </Box>
          )}
        </>
      )}
    </>
  )
}

// The loading state is shaped like the page it replaces: header block, decision
// strip, rail, then panels. A generic three-bar skeleton made the whole layout
// jump into place on arrival, and content that moves under a pointer is content
// that gets misclicked.
function FindingSkeleton() {
  return (
    <Box role="status" aria-live="polite" aria-busy="true">
      <Box className="tnx-visually-hidden">Loading this finding…</Box>
      <Box sx={{ mb: 4 }}>
        <Skeleton variant="text" width={220} height={16} />
        <Skeleton variant="text" width="42%" height={40} sx={{ mt: 1 }} />
        <Skeleton variant="text" width="66%" height={18} />
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(5, minmax(0, 1fr))' },
          gap: '1px',
          backgroundColor: color.border,
          border: `1px solid ${color.border}`,
          borderRadius: `${radius.md}px`,
          overflow: 'hidden',
          mb: 2,
        }}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <Box key={i} sx={{ backgroundColor: color.surface, px: 2, py: 1.75 }}>
            <Skeleton variant="text" width="60%" height={12} />
            <Skeleton variant="text" width="80%" height={26} sx={{ mt: 0.75 }} />
          </Box>
        ))}
      </Box>
      {[168, 132, 260].map((height, i) => (
        <Skeleton
          key={i}
          variant="rectangular"
          height={height}
          sx={{ borderRadius: `${radius.md}px`, mb: 2 }}
        />
      ))}
    </Box>
  )
}

export const FindingDetail = () => {
  const { id } = useParams()
  const [finding, setFinding] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)

  const load = React.useCallback(() => {
    setLoading(true)
    setError(null)
    findingService
      .getFinding(id)
      .then((res) => setFinding(res.data?.data || null))
      .catch((err) =>
        setError(err?.response?.status === 404 ? 'notfound' : 'error')
      )
      .finally(() => setLoading(false))
  }, [id])

  React.useEffect(() => {
    load()
  }, [load])

  if (loading && !finding) {
    return (
      <>
        <PageHeader eyebrow="Analyst workspace / evidence" title="Finding" />
        <FindingSkeleton />
      </>
    )
  }

  if (error === 'notfound') {
    return (
      <>
        <PageHeader eyebrow="Analyst workspace / evidence" title="Finding not found" />
        <Panel>
          <EmptyState title="No finding with that identifier">
            It may never have existed. Findings are never hard-deleted by this
            application, so an identifier that once worked still will.
          </EmptyState>
        </Panel>
        <Button component={RouterLink} to="/findings" startIcon={<FiArrowLeft />} sx={{ mt: 2 }}>
          Back to findings
        </Button>
      </>
    )
  }

  if (error || !finding) {
    return (
      <>
        <PageHeader eyebrow="Analyst workspace / evidence" title="Finding" />
        <Panel>
          <ErrorState onRetry={load} />
        </Panel>
      </>
    )
  }

  const ownership = finding.ownership
  const organizationName = ownership?.organization?.name
  const caseLinks = finding.caseLinks || []
  const triage = finding.triage

  const decisionCells = [
    {
      label: 'Current risk',
      // The score is the largest thing in the strip, because it is the first
      // question. The band badge sits beside it rather than swallowing it: a
      // 12px numeral inside a chip ranked the most important figure on the page
      // level with a lifecycle label.
      value: finding.risk ? (
        <>
          <Box sx={{ ...type.metricSm, color: color.text }}>{finding.risk.displayScore}</Box>
          <RiskBandBadge band={finding.risk.riskBand} />
        </>
      ) : (
        <Box sx={{ ...type.bodyStrong, color: color.textMuted }}>Not yet scored</Box>
      ),
      detail: finding.risk
        ? `Risk v1, evaluated ${formatAsOf(finding.risk.asOf) || 'at an unrecorded time'}`
        : 'No deterministic score has been written yet. This is not a score of zero.',
    },
    {
      label: 'Exposure',
      value: <StatusBadge dictionary={FINDING_STATUS} value={finding.status} />,
      detail: finding.status === 'CLOSED'
        ? `Closed ${formatAsOf(finding.closedAt) || 'at an unrecorded time'}`
        : `Last observed ${formatAsOf(finding.lastSeen) || 'at an unrecorded time'}`,
    },
    {
      label: 'Observation pressure',
      value: <StatusBadge dictionary={FINDING_LIFECYCLE} value={lifecycleOf(finding)} />,
      detail: `${finding.occurrenceCount} observation${finding.occurrenceCount === 1 ? '' : 's'} · ${finding.recurrenceCount} recurrence${finding.recurrenceCount === 1 ? '' : 's'} after closure`,
    },
    {
      label: 'Owning organization',
      value: organizationName ? (
        <Box sx={{ ...type.bodyStrong, color: color.text }}>{organizationName}</Box>
      ) : (
        <StatusBadge
          dictionary={OWNERSHIP_STATUS}
          value={ownership?.status || 'UNRESOLVED'}
        />
      ),
      detail: ownership
        ? OWNERSHIP_REASON[ownership.reasonCode] || ownership.reasonCode
        : 'No ownership resolution has been recorded.',
    },
    {
      label: 'Triage',
      value: (
        <Box sx={{ ...type.bodyStrong, color: triage?.decision ? color.text : color.textMuted }}>
          {TRIAGE_LABELS[triage?.decision] || 'Untriaged'}
        </Box>
      ),
      detail: caseLinks.length
        ? `Cited by ${caseLinks.length} case${caseLinks.length === 1 ? '' : 's'}`
        : 'Not currently linked to a case',
    },
  ]

  return (
    <>
      <PageHeader
        eyebrow="Analyst workspace / evidence"
        title={finding.indicatorValue}
        description={`Port ${finding.port} · ${finding.protocol} · ${finding.reportType.replace(/_/g, ' ')}. This identity is the deduplication key — every observation of it across every report is the same Finding.`}
        breadcrumbs={[
          { label: 'ThreatNeXus', to: '/dashboard' },
          { label: 'Findings', to: '/findings' },
          { label: finding.indicatorValue },
        ]}
        actions={
          <>
            <Button component={RouterLink} to="/findings" size="small" startIcon={<FiArrowLeft />}>
              All findings
            </Button>
            {/* Pending is STATED, not merely disabled: a control that goes quiet
                without saying why reads as broken rather than busy. */}
            <Button
              variant="outlined"
              size="small"
              startIcon={<FiRefreshCw />}
              onClick={load}
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? 'Refreshing' : 'Refresh'}
            </Button>
          </>
        }
      />

      {loading && (
        <Box
          role="status"
          aria-live="polite"
          sx={{ ...type.caption, color: color.textMuted, mb: 1.5 }}
        >
          Refreshing this finding. The values below are the last ones the server
          confirmed.
        </Box>
      )}

      <DecisionSummary cells={decisionCells} />

      <SectionRail sections={SECTIONS} />

      <Section id="tnx-triage">
        <Panel
          title="Triage decision"
          description="The decision this screen exists to support, and its append-only history. Triage is separate from the OPEN/CLOSED exposure state above: a finding can be open and dismissed, or closed and escalated."
        >
          <FindingTriagePanel findingId={finding.id} onTriaged={load} />
        </Panel>
      </Section>

      <Section id="tnx-identity">
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1.5fr 1fr' }, gap: 2 }}>
          <Panel title="Identity and observation history">
            <FieldGrid columns={{ xs: '1fr 1fr', md: 'repeat(3, 1fr)' }}>
              <Field label="Indicator" mono>
                {finding.indicatorValue}
              </Field>
              <Field label="Port" mono>
                {finding.port}
              </Field>
              <Field label="Protocol" mono>
                {finding.protocol}
              </Field>
              <Field label="First observed" mono>
                {formatAsOf(finding.firstSeen)}
              </Field>
              <Field label="Last observed" mono>
                {formatAsOf(finding.lastSeen)}
              </Field>
              <Field label="Times observed" mono>
                {finding.occurrenceCount}
              </Field>
              <Field label="Recurrences after closure" mono>
                {finding.recurrenceCount}
              </Field>
              <Field label="Closed at" mono>
                {formatAsOf(finding.closedAt)}
              </Field>
              <Field label="Closure reason">{finding.closureReason}</Field>
            </FieldGrid>
          </Panel>

          <Panel
            title="Ownership"
            description="Resolved deterministically: analyst override, then exact address, then longest matching prefix, then ASN."
          >
            {ownership ? (
              <>
                <FieldGrid columns={{ xs: '1fr' }} gap={2}>
                  <Field label="Organization">{organizationName || 'Not resolved'}</Field>
                  <Field label="Resolution">
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                      <StatusBadge dictionary={OWNERSHIP_STATUS} value={ownership.status} size="small" />
                      <StatusBadge
                        dictionary={OWNERSHIP_CONFIDENCE}
                        value={ownership.confidence}
                        size="small"
                      />
                    </Box>
                  </Field>
                  {/* Words first, code second. The reason code is the audit
                      identity and stays visible; the sentence is what makes it
                      readable without knowing the resolver's vocabulary. */}
                  <Field label="Why this owner">
                    {OWNERSHIP_REASON[ownership.reasonCode] || ownership.reasonCode}
                    <Box
                      sx={{ ...type.caption, color: color.textFaint, fontFamily: font.mono, mt: 0.5 }}
                    >
                      {ownership.reasonCode}
                    </Box>
                  </Field>
                </FieldGrid>

                {ownership.isIspAttribution && (
                  <Alert severity="warning" sx={{ mt: 2 }}>
                    This is ASN-based attribution to a network operator, not
                    confirmed ownership of the affected host. Treat it as low
                    confidence.
                  </Alert>
                )}
                {ownership.status === 'AMBIGUOUS' && (
                  <Alert severity="warning" sx={{ mt: 2 }}>
                    Several organizations tied at the winning precedence tier, so
                    no owner was chosen. An arbitrary winner is never picked.
                  </Alert>
                )}
                <Provenance
                  source="FindingOwnership current row"
                  asOf={ownership.asOf}
                  sx={{ mt: 2 }}
                />
              </>
            ) : (
              <EmptyState title="Ownership has not been resolved" dense>
                No organization has been attributed to this indicator.
              </EmptyState>
            )}
          </Panel>
        </Box>
      </Section>

      <Section id="tnx-risk">
        <Panel
          title="Risk v1 explanation"
          description="Reconstructed from the factor contributions stored with the score. Nothing here is generated, and no model influences the official score."
          footer={
            finding.risk ? (
              <Provenance
                source="RiskScore + RiskFactorContribution (current snapshot)"
                asOf={finding.risk.calculatedAt}
              />
            ) : null
          }
        >
          <RiskExplanation risk={finding.risk} />
        </Panel>
      </Section>

      <Section id="tnx-context">
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2 }}>
          <Panel
            title="IP reputation context"
            description="Third-party context about the address. Reputation is never proof, and it never creates or closes a Finding."
          >
            {finding.enrichment ? (
              <>
                <Box sx={{ mb: 2 }}>
                  <StatusBadge dictionary={ENRICHMENT_STATUS} value={finding.enrichment.status} />
                </Box>
                {finding.enrichment.status === 'SUCCESS' ? (
                  <FieldGrid columns={{ xs: '1fr 1fr' }}>
                    <Field label="Provider" mono>
                      {finding.enrichment.provider}
                    </Field>
                    <Field label="Abuse confidence" mono>
                      {finding.enrichment.abuseConfidenceScore}
                    </Field>
                    <Field label="Reports" mono>
                      {finding.enrichment.totalReports}
                    </Field>
                    <Field label="Usage type">{finding.enrichment.usageType}</Field>
                  </FieldGrid>
                ) : (
                  <Box sx={{ ...type.small, color: color.textMuted }}>
                    No reputation values are shown, because the lookup did not
                    succeed. This is not a clean result.
                  </Box>
                )}
                <Provenance
                  source="IocEnrichment active cache row"
                  asOf={finding.enrichment.queriedAt}
                  sx={{ mt: 2 }}
                />
              </>
            ) : (
              <UnavailableState title="No reputation lookup recorded" dense>
                No enrichment result is stored for this indicator. Enrichment is
                optional and never blocks ingestion.
              </UnavailableState>
            )}
          </Panel>

          <Panel
            title="Analyst-verified vulnerabilities"
            description="CVEs an analyst explicitly associated with this host. Nothing here is inferred from a port, banner, product or operating system."
          >
            {finding.vulnerabilities.length ? (
              <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {finding.vulnerabilities.map((v) => (
                  <Box
                    component="li"
                    key={v.id}
                    sx={{
                      border: `1px solid ${color.border}`,
                      borderRadius: `${radius.sm}px`,
                      p: 2,
                      backgroundColor: color.surfaceSunken,
                    }}
                  >
                    <Box sx={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{v.cveId}</Box>
                    <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.75 }}>{v.justification}</Box>
                    <Provenance source={`FindingVulnerability · ${v.evidenceSource}`} asOf={v.effectiveAt} sx={{ mt: 1 }} />
                  </Box>
                ))}
              </Box>
            ) : (
              <EmptyState title="No CVE association recorded" dense>
                An analyst has not verified any CVE against this host. Association
                is a deliberate human act in this system.
              </EmptyState>
            )}
          </Panel>
        </Box>
      </Section>

      <Section id="tnx-timeline">
        <Panel
          title="Observation timeline"
          description={`Most recent ${finding.occurrenceLimit} occurrences. Every row is immutable evidence of what one ingestion did.`}
        >
          <Timeline
            items={finding.occurrences.map((o) => ({
              id: o.id,
              title: OCCURRENCE_ACTION[o.action]?.label || o.action,
              at: o.observedAt,
              detail: `Report #${o.rawReportId}`,
              tone:
                o.action === 'RECURRED'
                  ? color.danger
                  : o.action === 'PERSISTED'
                    ? color.warning
                    : color.borderStrong,
            }))}
            emptyLabel="No occurrences recorded."
            dense
          />
        </Panel>
      </Section>

      <Section id="tnx-cases">
        <Panel
          title="Cases citing this finding"
          description="Where this evidence is currently linked."
        >
          {caseLinks.length ? (
            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              {caseLinks.map((l) => (
                <Box
                  component="li"
                  key={l.caseId}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 2,
                    flexWrap: 'wrap',
                    border: `1px solid ${color.border}`,
                    borderRadius: `${radius.sm}px`,
                    px: 2,
                    py: 1.5,
                  }}
                >
                  <Link component={RouterLink} to={`/cases/${l.caseId}`} sx={{ fontFamily: font.mono, fontSize: 13 }}>
                    {l.caseReference || `Case ${l.caseId}`}
                  </Link>
                  <StatusBadge dictionary={CASE_STATE} value={l.lifecycleState} size="small" />
                </Box>
              ))}
            </Box>
          ) : (
            <EmptyState title="Not currently linked to a case" dense>
              Escalating this Finding during triage is what creates or joins a case.
            </EmptyState>
          )}
        </Panel>
      </Section>

      {/* Optional subsystems, last and folded away by default.
          Both are real evidence surfaces, so neither is removed and neither is
          unmounted — each still loads, still reports its own denial or disabled
          state, and is one click from view. They are collapsed because a fresh
          instance ships with AI off and no provider credential, and an analyst
          should not scroll past two empty subsystems to reach a decision. */}
      <Section id="tnx-optional" sx={{ display: 'grid', gap: 2 }}>
        <SectionLabel component="h2">Optional subsystems</SectionLabel>
        <Disclosure
          summary="Enrichment coverage and provider requests"
          hint="What has been asked of which provider for this indicator, and what came back. Nothing here creates or closes a Finding."
        >
          <FindingEnrichmentPanel findingId={finding.id} />
        </Disclosure>
        <Disclosure
          summary="AI assistance"
          hint="Drafts and suggestions only. Disabled by default, never in the decision path, and it cannot triage, score or close anything."
        >
          <FindingAiAssistPanel findingId={finding.id} />
        </Disclosure>
      </Section>
    </>
  )
}

export default FindingDetail
