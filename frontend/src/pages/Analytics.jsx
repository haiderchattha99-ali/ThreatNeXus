// Analysis — the same persisted evidence as the overview, arranged for
// comparison rather than for a first glance.
//
// This page was rewritten in Phase 6. The previous version fetched
// `http://localhost:5000/api/threats` with a bare axios call: a hardcoded host
// that ignored VITE_API_BASE_URL, and a request that carried no Authorization
// header because it bypassed the configured client entirely. It then drew
// severity/status charts from the legacy `Threat` table, which is not the
// deduplicated Finding lifecycle the rest of the product reasons about.
//
// It now reads the same single, capability-guarded, provenance-carrying
// snapshot the overview does, so the two screens can never disagree — and it
// needs no charting library, which is why chart.js, react-chartjs-2, leaflet
// and react-leaflet were removed from the bundle in this phase.

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
} from '../components/ui'
import { riskBandColor, color, type } from '../theme/tokens'

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

function labelled(items, dict) {
  return (items || []).map((i) => ({ ...i, label: dict[i.key] || i.key }))
}

function SectionFallback({ section }) {
  if (section?.availability === 'RESTRICTED') {
    return <DeniedState dense>{section.reason}</DeniedState>
  }
  return <UnavailableState dense>{section?.reason}</UnavailableState>
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

  const f = overview.sections.findings
  const c = overview.sections.cases
  const readable = (s) => s?.availability === 'AVAILABLE'

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

      {readable(f) ? (
        <>
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
            </Panel>
          </Reveal>

          <Reveal index={1}>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2, mb: 2 }}>
              <Panel
                title="Persistence and recurrence"
                description="What repeated ingestion actually did, from the append-only occurrence ledger. This is the honest alternative to a trend line: it counts events that happened rather than interpolating a curve."
                footer={
                  <Provenance
                    source={f.distributions.occurrenceOutcome.source}
                    asOf={f.distributions.occurrenceOutcome.asOf}
                  />
                }
              >
                <DistributionBars items={labelled(f.distributions.occurrenceOutcome.items, OCCURRENCE_LABEL)} />
              </Panel>

              <Panel
                title="Ageing"
                description="How long since each Finding was last observed."
                footer={
                  <Provenance source={f.distributions.ageing.source} asOf={f.distributions.ageing.asOf} />
                }
              >
                <DistributionBars items={labelled(f.distributions.ageing.items, AGEING_LABEL)} />
              </Panel>
            </Box>
          </Reveal>
        </>
      ) : (
        <Panel title="Findings" sx={{ mb: 2 }}>
          <SectionFallback section={f} />
        </Panel>
      )}

      <Reveal index={2}>
        <Panel
          title="Investigation load"
          description="Cases by current lifecycle state."
          sx={{ mb: 2 }}
          footer={readable(c) ? <Provenance source="Case.lifecycleState" asOf={overview.generatedAt} /> : null}
        >
          {readable(c) ? (
            <DistributionBars
              items={labelled(c.distributions.lifecycleState.items, CASE_STATE_LABEL)}
              emptyLabel="No cases have been opened yet."
            />
          ) : (
            <SectionFallback section={c} />
          )}
        </Panel>
      </Reveal>

      <Panel title="What is deliberately not shown here">
        <Box component="ul" sx={{ ...type.small, color: color.textMuted, pl: 2.5, m: 0 }}>
          <li>
            No geographic map or origin-country ranking. No provenance-backed
            coordinate is persisted by any phase, and location is never inferred
            from an address or an organization name.
          </li>
          <li>
            No framework &ldquo;coverage&rdquo; percentage. Mappings are
            analyst-asserted context, and no proportion of any catalogue is
            implied by counting them.
          </li>
          <li>
            No time-series trend line. This instance holds discretely ingested
            reports, not a continuous feed, so a smooth curve over time would be
            an interpolation rather than a measurement.
          </li>
          <li>No provider latency, uptime or &ldquo;all systems operational&rdquo; claim.</li>
        </Box>
        <ScopeNote sx={{ mt: 2 }} />
      </Panel>
    </>
  )
}

export default Analytics
