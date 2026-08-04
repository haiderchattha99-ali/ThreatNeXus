// Analysis — the deeper visual workspace over the same persisted evidence.
//
// This page was rewritten in Phase 6. The previous version fetched
// `http://localhost:5000/api/threats` with a bare axios call: a hardcoded host
// that ignored VITE_API_BASE_URL, and a request that carried no Authorization
// header because it bypassed the configured client entirely. It then drew
// severity/status charts from the legacy `Threat` table, which is not the
// deduplicated Finding lifecycle the rest of the product reasons about.
//
// Phase 6.2 widened it into the deeper workspace the dashboard links out to,
// WITHOUT extending the backend: every section below is a distribution the
// single `GET /api/dashboard/overview` snapshot already returned. That is why
// the two screens can never disagree, and why this page still needs no charting
// library — chart.js, react-chartjs-2, leaflet and react-leaflet were all
// removed from the bundle in Phase 6 and none has come back.
//
// Three rules every section here obeys:
//
//   1. RAW VALUES ALWAYS. Every bar sits beside its own count, and every panel
//      states its denominator. No proportion is shown without the number it was
//      taken over.
//   2. AN ACCESSIBLE ALTERNATIVE ALWAYS. Bars are aria-hidden decoration over a
//      real list, and each panel additionally offers the same figures as a
//      table. Nothing here is legible only as a picture.
//   3. RESTRICTED IS NOT ZERO. A section the role may not read renders its
//      reason. VIEWER holds read:dashboard but not read:notifications, so the
//      notification panels below are RESTRICTED for them — never an empty
//      chart, and never a zero.

import React from 'react'
import { Box, Button } from '@mui/material'
import { FiRefreshCw } from 'react-icons/fi'

import { dashboardService } from '../services/api'
import {
  PageHeader,
  Panel,
  DistributionBars,
  LoadingState,
  ErrorState,
  DeniedState,
  UnavailableState,
  Provenance,
  ScopeNote,
  MetricValue,
  SectionLabel,
  Reveal,
  formatMetricNumber,
} from '../components/ui'
import { RISK_FACTOR_LABEL, FACTOR_EVIDENCE_STATE, factorEvidenceState } from '../components/dashboard/dashboardModel'
import { StatusBadge } from '../components/ui'
import { riskBandColor, color, type, font, radius } from '../theme/tokens'

const RISK_BAND_LABEL = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  INFORMATIONAL: 'Informational',
}
const OCCURRENCE_LABEL = {
  CREATED: 'First observed',
  PERSISTED: 'Seen again',
  RECURRED: 'Recurred after closure',
  HISTORICAL: 'Back-dated observation',
}
const AGEING_LABEL = {
  LAST_24H: 'Last 24 hours',
  '1_7_DAYS': '1–7 days',
  '8_30_DAYS': '8–30 days',
  OVER_30_DAYS: 'Over 30 days',
}
const CASE_STATE_LABEL = {
  OPEN: 'Open',
  WAITING_FOR_ORG: 'Waiting for organization',
  CLOSURE_PENDING: 'Closure pending review',
  CLOSED: 'Closed',
}
const NOTIFICATION_STATE_LABEL = {
  DRAFT: 'Draft',
  PENDING_REVIEW: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
}
const DELIVERY_LABEL = {
  SENT_MANUALLY: 'Sent manually',
  DELIVERED: 'Reported delivered',
  FAILED: 'Reported failed',
  BOUNCED: 'Reported bounced',
  UNKNOWN: 'Outcome unknown',
}
const FRAMEWORK_LABEL = {
  MITRE_ATTACK: 'MITRE ATT&CK',
  NIST_CSF: 'NIST CSF',
  CIS_CONTROLS: 'CIS Controls',
}
const MAPPING_SOURCE_LABEL = {
  MANUAL: 'Recorded by an analyst',
  AI_SUGGESTION_PROMOTED: 'Promoted from an AI suggestion by a human',
}

function labelled(items, dict) {
  return (items || []).map((i) => ({ ...i, label: dict[i.key] || i.key }))
}

function readable(section) {
  return section?.availability === 'AVAILABLE'
}

function SectionFallback({ section }) {
  if (section?.availability === 'RESTRICTED') {
    return <DeniedState dense>{section.reason}</DeniedState>
  }
  return <UnavailableState dense>{section?.reason}</UnavailableState>
}

/**
 * The same distribution twice: as bars for a glance, and as a real table for a
 * screen reader, a keyboard user, or anybody who needs the exact figures rather
 * than the shape. The table is the accessible alternative every chart on this
 * page is required to carry.
 */
function DistributionTable({ items, denominator, denominatorLabel }) {
  const total = (items || []).reduce((n, i) => n + (i.count || 0), 0)
  return (
    <Box
      component="details"
      sx={{
        mt: 2,
        ...type.caption,
        color: color.textMuted,
        '& summary': { cursor: 'pointer', width: 'fit-content', color: color.link },
        '&[open] summary': { mb: 1 },
      }}
    >
      <summary>Show these figures as a table</summary>
      <Box component="table" sx={{ width: '100%', maxWidth: 520, borderCollapse: 'collapse', fontFamily: font.mono, fontSize: 12 }}>
        <caption style={{ textAlign: 'left', paddingBottom: 8, color: color.textMuted }}>
          {typeof denominator === 'number'
            ? `Out of ${formatMetricNumber(denominator)} ${denominatorLabel || 'records'}.`
            : `${formatMetricNumber(total)} records counted.`}
        </caption>
        <Box component="thead">
          <Box component="tr">
            <Box component="th" scope="col" sx={{ textAlign: 'left', p: 0.75, borderBottom: `1px solid ${color.border}`, color: color.textMuted }}>Bucket</Box>
            <Box component="th" scope="col" sx={{ textAlign: 'right', p: 0.75, borderBottom: `1px solid ${color.border}`, color: color.textMuted }}>Count</Box>
          </Box>
        </Box>
        <Box component="tbody">
          {(items || []).map((item) => (
            <Box component="tr" key={item.key}>
              <Box component="th" scope="row" sx={{ textAlign: 'left', p: 0.75, borderBottom: `1px solid ${color.border}`, color: color.text, fontWeight: 400 }}>{item.label}</Box>
              <Box component="td" sx={{ textAlign: 'right', p: 0.75, borderBottom: `1px solid ${color.border}`, color: color.text }}>{formatMetricNumber(item.count) ?? '0'}</Box>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

/** Panel + bars + table + provenance, so no section can forget one of them. */
function DistributionPanel({ title, description, distribution, dict, colorFor, denominatorLabel, note, section, sx }) {
  if (!readable(section)) {
    return (
      <Panel title={title} description={description} sx={sx}>
        <SectionFallback section={section} />
      </Panel>
    )
  }
  const items = labelled(distribution?.items, dict)
  return (
    <Panel
      title={title}
      description={description}
      sx={sx}
      footer={<Provenance source={distribution?.source} asOf={distribution?.asOf} note={note} />}
    >
      <DistributionBars items={items} colorFor={colorFor} />
      <DistributionTable items={items} denominator={distribution?.denominator} denominatorLabel={denominatorLabel} />
    </Panel>
  )
}

/** The full per-factor breakdown the dashboard panel links out to. */
function FactorBreakdown({ pressure }) {
  if (!readable(pressure)) {
    return (
      <Panel title="Risk v1 factor contributions">
        <SectionFallback section={pressure} />
      </Panel>
    )
  }
  const factors = pressure.factors || []
  return (
    <Panel
      title="Risk v1 factor contributions"
      description="Every factor the locked scoring engine persisted, summed across findings holding a current score. The applicability columns are what separate a factor that was measured and added nothing from one whose evidence could never be read."
      footer={
        <Provenance
          source={pressure.source}
          asOf={pressure.asOf}
          note={`${pressure.denominatorDefinition} ${pressure.disclaimer}`}
        />
      }
    >
      {factors.length ? (
        <Box sx={{ overflowX: 'auto' }}>
          <Box component="table" sx={{ width: '100%', minWidth: 620, borderCollapse: 'collapse', fontSize: 12.5 }}>
            <caption style={{ textAlign: 'left', paddingBottom: 10, color: color.textMuted, fontSize: 12 }}>
              Basis points contributed and possible, out of {formatMetricNumber(pressure.denominator)} findings
              holding a current Risk v1 score.
            </caption>
            <Box component="thead">
              <Box component="tr">
                {['Factor', 'State', 'Contributed', 'Possible', 'Measured', 'No evidence', 'Cannot apply'].map((h, i) => (
                  <Box component="th" key={h} scope="col" sx={{ textAlign: i > 1 ? 'right' : 'left', p: 1, borderBottom: `1px solid ${color.borderStrong}`, color: color.textMuted, ...type.label }}>{h}</Box>
                ))}
              </Box>
            </Box>
            <Box component="tbody">
              {factors.map((factor) => {
                const meta = RISK_FACTOR_LABEL[factor.factorKey] || {}
                return (
                  <Box component="tr" key={factor.factorKey}>
                    <Box component="th" scope="row" sx={{ textAlign: 'left', p: 1, borderBottom: `1px solid ${color.border}`, fontWeight: 400 }}>
                      <Box sx={{ ...type.small, color: color.text }}>{meta.label || factor.factorKey}</Box>
                      <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.25, maxWidth: '44ch' }}>{meta.meaning}</Box>
                    </Box>
                    <Box component="td" sx={{ p: 1, borderBottom: `1px solid ${color.border}` }}>
                      <StatusBadge dictionary={FACTOR_EVIDENCE_STATE} value={factorEvidenceState(factor)} size="small" />
                    </Box>
                    {[factor.contributionBasisPoints, factor.maximumContributionBasisPoints, factor.applied, factor.notAvailable, factor.notApplicable].map((value, i) => (
                      <Box component="td" key={i} sx={{ textAlign: 'right', p: 1, borderBottom: `1px solid ${color.border}`, fontFamily: font.mono, color: i === 0 && value ? color.text : color.textMuted }}>
                        {formatMetricNumber(value) ?? '0'}
                      </Box>
                    ))}
                  </Box>
                )
              })}
            </Box>
          </Box>
        </Box>
      ) : (
        <Box sx={{ ...type.small, color: color.textMuted }}>
          No finding currently holds a Risk v1 score, so no factor contribution has been persisted.
        </Box>
      )}
      <Box sx={{ mt: 2, p: 1.25, backgroundColor: color.surfaceSunken, borderRadius: `${radius.sm}px`, ...type.caption, color: color.textMuted }}>
        {pressure.totals?.note}
      </Box>
    </Panel>
  )
}

const Analytics = () => {
  const [overview, setOverview] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)

  const load = React.useCallback(() => {
    setLoading(true)
    setError(false)
    dashboardService
      .getOverview()
      .then((res) => setOverview(res.data?.data || null))
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  if (loading && !overview) {
    return (
      <>
        <PageHeader eyebrow="Analyst workspace / analysis" title="Analysis" />
        <LoadingState label="Loading analysis" />
      </>
    )
  }

  if (error || !overview) {
    return (
      <>
        <PageHeader eyebrow="Analyst workspace / analysis" title="Analysis" />
        <Panel>
          <ErrorState onRetry={load} />
        </Panel>
      </>
    )
  }

  const s = overview.sections
  const f = s.findings
  const c = s.cases
  const n = s.notifications
  const fw = s.frameworkMappings

  return (
    <>
      <PageHeader
        eyebrow="Analyst workspace / analysis"
        title="Analysis"
        description={overview.datasetScope}
        breadcrumbs={[{ label: 'ThreatNeXus', to: '/dashboard' }, { label: 'Analysis' }]}
        actions={
          <Button variant="outlined" size="small" startIcon={<FiRefreshCw />} onClick={load}>
            Refresh
          </Button>
        }
        meta={<Provenance source="GET /api/dashboard/overview" asOf={overview.generatedAt} />}
      />

      {/* ------------------------------------------------------- risk posture */}
      {readable(f) ? (
        <Reveal index={0}>
          <Panel
            title="Where the risk sits"
            description="Current Risk v1 band for every Finding that has a score. Findings with no current score are counted separately and are never folded into the lowest band."
            sx={{ mb: 2 }}
            footer={
              <Provenance
                source={f.distributions.riskBand.source}
                asOf={f.distributions.riskBand.asOf}
                note={`denominator ${f.distributions.riskBand.denominator} scored findings`}
              />
            }
          >
            <DistributionBars
              items={labelled(f.distributions.riskBand.items, RISK_BAND_LABEL)}
              colorFor={(k) => riskBandColor[k]}
            />
            <Box sx={{ mt: 3, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <Box>
                <SectionLabel component="h3">Total findings</SectionLabel>
                <MetricValue metric={f.metrics.total} size="small" />
              </Box>
              <Box>
                <SectionLabel component="h3">Scored</SectionLabel>
                <MetricValue metric={f.metrics.scored} size="small" />
              </Box>
              <Box>
                <SectionLabel component="h3">Not yet scored</SectionLabel>
                <MetricValue metric={f.metrics.unscored} size="small" />
              </Box>
            </Box>
            <DistributionTable
              items={labelled(f.distributions.riskBand.items, RISK_BAND_LABEL)}
              denominator={f.distributions.riskBand.denominator}
              denominatorLabel="scored findings"
            />
          </Panel>
        </Reveal>
      ) : (
        <Panel title="Findings" sx={{ mb: 2 }}>
          <SectionFallback section={f} />
        </Panel>
      )}

      {/* --------------------------------------------- factor contributions */}
      <Reveal index={1}>
        <Box sx={{ mb: 2 }}>
          <FactorBreakdown pressure={s.riskFactorPressure} />
        </Box>
      </Reveal>

      {/* ------------------------------------------- observation composition */}
      <Reveal index={2}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2, mb: 2 }}>
          <DistributionPanel
            title="What repeated ingestion actually did"
            description="Outcome of every observation in the append-only occurrence ledger. This is the honest alternative to a trend line: it counts events that happened rather than interpolating a curve between them."
            section={f}
            distribution={f?.distributions?.occurrenceOutcome}
            dict={OCCURRENCE_LABEL}
            denominatorLabel="observations"
          />
          <DistributionPanel
            title="Ageing"
            description="Time since each Finding was last observed. Age is operational context, never severity."
            section={f}
            distribution={f?.distributions?.ageing}
            dict={AGEING_LABEL}
            denominatorLabel="findings"
          />
        </Box>
      </Reveal>

      {/* ------------------------------------------------ report composition */}
      <Reveal index={3}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2, mb: 2 }}>
          <DistributionPanel
            title="Findings by report type"
            description="Which Shadowserver-style report each finding came from. One report type is carried to closure before a second is started, so a single dominant bucket here is the intended shape, not a gap."
            section={f}
            distribution={f?.distributions?.reportType}
            dict={{}}
            denominatorLabel="findings"
          />
          <DistributionPanel
            title="Investigation load"
            description="Cases by current lifecycle state."
            section={c}
            distribution={c?.distributions?.lifecycleState}
            dict={CASE_STATE_LABEL}
            denominatorLabel="cases"
          />
        </Box>
      </Reveal>

      {/* ------------------------------------------------------ notification */}
      <Reveal index={4}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2, mb: 2 }}>
          <DistributionPanel
            title="Notification review state"
            description="Constituent notifications by lifecycle state. Approval is bound to an exact revision — editing an approved draft invalidates its approval."
            section={n}
            distribution={n?.distributions?.lifecycleState}
            dict={NOTIFICATION_STATE_LABEL}
            denominatorLabel="workflow notifications"
          />
          <DistributionPanel
            title="Manual delivery observations"
            description="What an analyst reported AFTER sending an exported artifact by hand. This system has no mail or webhook client, so every figure here is a human observation — never something the platform did or watched."
            section={n}
            distribution={n?.distributions?.deliveryStatus}
            dict={DELIVERY_LABEL}
            denominatorLabel="recorded observations"
            note={n?.disclaimer}
          />
        </Box>
      </Reveal>

      {/* -------------------------------------------------------- frameworks */}
      <Reveal index={5}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2, mb: 2 }}>
          <DistributionPanel
            title="Framework mappings by family"
            description="COUNTS OF MAPPINGS an analyst associated with a case, on a stated evidence basis. Not coverage, not compliance, not maturity, and not a proportion of any catalogue."
            section={fw}
            distribution={fw?.distributions?.byFramework}
            dict={FRAMEWORK_LABEL}
            denominatorLabel="active mappings"
            note={fw?.disclaimer}
          />
          <DistributionPanel
            title="How each mapping was recorded"
            description="Every active mapping was written by a human. An AI suggestion is inert until a person promotes it, and promotion goes through the same manual writer — which is why 'promoted' is a provenance label, not a second authority."
            section={fw}
            distribution={fw?.distributions?.bySource}
            dict={MAPPING_SOURCE_LABEL}
            denominatorLabel="active mappings"
          />
        </Box>
      </Reveal>

      <Panel title="What is deliberately not shown here">
        <Box component="ul" sx={{ ...type.small, color: color.textMuted, pl: 2.5, m: 0 }}>
          <li>
            No geographic map or origin-country ranking. No provenance-backed
            coordinate is persisted by any phase, and location is never inferred
            from an address or an organization name.
          </li>
          <li>
            No framework &ldquo;coverage&rdquo; percentage, and no ATT&amp;CK
            tactic matrix. Mappings are analyst-asserted context; counting them
            implies no proportion of any catalogue, and the current references
            are not catalogue-validated.
          </li>
          <li>
            No time-series trend line. This instance holds discretely ingested
            reports, not a continuous feed, so a smooth curve over time would be
            an interpolation rather than a measurement. The dashboard&rsquo;s
            seven-day view is discrete bars for the same reason.
          </li>
          <li>No provider latency, uptime or &ldquo;all systems operational&rdquo; claim.</li>
          <li>
            No per-organization posture score. The two numeric columns on an
            organization record are administrator-entered notes and are excluded
            from every aggregate in this application.
          </li>
        </Box>
        <ScopeNote sx={{ mt: 2 }} />
      </Panel>
    </>
  )
}

export default Analytics
