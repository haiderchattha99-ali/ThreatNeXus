import React from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Box, Button, Chip } from '@mui/material'
import {
  FiArrowRight,
  FiClock,
  FiDatabase,
  FiExternalLink,
  FiLock,
  FiRefreshCw,
} from 'react-icons/fi'

import {
  DeniedState,
  MetricValue,
  Panel,
  RiskBandBadge,
  SectionLabel,
  StatusBadge,
  UnavailableState,
  formatAsOf,
  formatMetricNumber,
} from '../ui'
import { color, font, radius, riskBandColor, type } from '../../theme/tokens'
import {
  AGE_LABEL,
  FACTOR_EVIDENCE_STATE,
  PROVIDER_STATE,
  RISK_FACTOR_LABEL,
  RISK_LABEL,
  factorEvidenceState,
} from './dashboardModel'

export function SectionFallback({ section, compact = false }) {
  if (section?.availability === 'RESTRICTED') return <DeniedState dense={compact}>{section.reason}</DeniedState>
  return <UnavailableState dense={compact}>{section?.reason}</UnavailableState>
}

export function DataDefinition({ source, asOf, note, countNote, sx = {} }) {
  const stamp = formatAsOf(asOf)
  return (
    <Box sx={{ ...type.caption, color: color.textMuted, ...sx }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
        <FiDatabase size={12} aria-hidden="true" />
        {stamp ? <span>Snapshot <time dateTime={asOf}>{stamp}</time></span> : <span>Snapshot time unavailable</span>}
        {countNote && <><span aria-hidden="true">·</span><span>{countNote}</span></>}
      </Box>
      <Box
        component="details"
        sx={{
          mt: 0.75,
          '& summary': { cursor: 'pointer', width: 'fit-content', color: color.link, '&:hover': { color: color.linkHover } },
          '&[open] summary': { mb: 0.75 },
        }}
      >
        <summary>Data definition</summary>
        <Box sx={{ fontFamily: font.mono, fontSize: 11, lineHeight: 1.55, overflowWrap: 'anywhere' }}>
          <Box>{source || 'Source not recorded'}</Box>
          {note && <Box sx={{ mt: 0.5, fontFamily: font.ui }}>{note}</Box>}
        </Box>
      </Box>
    </Box>
  )
}

export function MetricStrip({ metrics }) {
  return (
    <Box
      component="section"
      aria-label="Operational metrics"
      data-dashboard-metrics
    >
      <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr 1fr', lg: 'repeat(4, minmax(0, 1fr))' },
        border: `1px solid ${color.border}`,
        borderRadius: `${radius.md}px`,
        backgroundColor: color.surface,
        overflow: 'hidden',
      }}
      >
        {metrics.map(({ label, metric, hint, icon: Icon, to }, index) => (
          <Box
            key={label}
            component={RouterLink}
            to={to}
            data-kpi
            sx={{
              minWidth: 0,
              p: { xs: 1.5, sm: 2 },
              color: 'inherit',
              textDecoration: 'none',
              borderLeft: { lg: index ? `1px solid ${color.border}` : 0 },
              borderTop: { xs: index > 1 ? `1px solid ${color.border}` : 0, lg: 0 },
              '&:nth-of-type(even)': { borderLeft: { xs: `1px solid ${color.border}`, lg: index ? `1px solid ${color.border}` : 0 } },
              '&:hover': { backgroundColor: color.surfaceRaised },
              '&:focus-visible': { outline: `2px solid ${color.borderFocus}`, outlineOffset: -2 },
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
              <Box sx={{ ...type.small, color: color.textMuted }}>{label}</Box>
              <Icon size={15} color={color.textFaint} aria-hidden="true" />
            </Box>
            <Box data-metric-value sx={{ mt: 0.7 }}><MetricValue metric={metric} size="small" /></Box>
            <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.35 }}>{hint}</Box>
          </Box>
        ))}
      </Box>
      <Box component="details" sx={{ mt: 0.75, px: 0.25, ...type.caption, color: color.textMuted, '& summary': { width: 'fit-content', cursor: 'pointer', color: color.link }, '&[open] summary': { mb: 0.75 } }}>
        <summary>Metric definitions and snapshot times</summary>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 0.75, pl: 0.25 }}>
          {metrics.map(({ label, metric }) => <Box key={label} sx={{ fontFamily: font.mono, overflowWrap: 'anywhere' }}><Box component="span" sx={{ color: color.textMuted }}>{label}: </Box>{metric?.source || 'Source not recorded'}{metric?.asOf ? ` · ${formatAsOf(metric.asOf)}` : ''}</Box>)}
        </Box>
      </Box>
    </Box>
  )
}

function FindingQueueRow({ item }) {
  return (
    <Box component={RouterLink} to={`/findings/${item.id}`} data-queue-row sx={queueRowSx}>
      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ ...type.code, color: color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.indicatorValue}{item.port ? `:${item.port}` : ''}
        </Box>
        <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.35, display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
          <span>{item.reportType?.replace(/_/g, ' ') || 'Unknown report type'}</span>
          <span aria-hidden="true">·</span>
          <span>{item.occurrenceCount} observation{item.occurrenceCount === 1 ? '' : 's'}</span>
          {item.recurred && <><span aria-hidden="true">·</span><span style={{ color: color.danger }}>Recurred</span></>}
        </Box>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
        {item.risk?.state === 'SCORED'
          ? <RiskBandBadge band={item.risk.band} score={item.risk.displayScore} />
          : <Chip size="small" label="Not scored" variant="outlined" />}
        <FiArrowRight aria-hidden="true" />
      </Box>
    </Box>
  )
}

function ClosureQueueRow({ item }) {
  const record = item.case || {}
  return (
    <Box component={RouterLink} to={`/cases/${item.caseId}`} data-queue-row sx={queueRowSx}>
      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ ...type.bodyStrong, color: color.text }}>{record.caseReference || 'Case'}</Box>
        <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {record.title || 'Untitled case'} · requested {formatAsOf(item.requestedAt) || 'time unavailable'}
        </Box>
      </Box>
      <FiArrowRight aria-hidden="true" />
    </Box>
  )
}

const queueRowSx = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 1.5,
  minWidth: 0,
  minHeight: 61,
  px: { xs: 1.25, sm: 1.75 },
  py: 1.15,
  color: color.textMuted,
  textDecoration: 'none',
  borderTop: `1px solid ${color.border}`,
  '&:hover': { backgroundColor: color.surfaceRaised },
  '&:focus-visible': { outline: `2px solid ${color.borderFocus}`, outlineOffset: -2 },
}

export function PriorityQueue({ title, description, queue, kind, shownLabel = 'records', emptyLabel, to }) {
  const rows = queue?.items || []
  const visibleRowLabel = rows.length === 1 ? shownLabel.replace(/s$/, '') : shownLabel
  return (
    <Panel
      title={title}
      description={description}
      padded={false}
      actions={<Button component={RouterLink} to={to} size="small" variant="text" endIcon={<FiArrowRight />}>Open full queue</Button>}
      contentSx={{ pt: 0 }}
      footer={<DataDefinition source={queue?.source} asOf={queue?.asOf} countNote={`${formatMetricNumber(queue?.total) || 0} ${queue?.totalLabel || 'total records'} · ${rows.length} ${visibleRowLabel} shown`} />}
      sx={{ height: '100%' }}
    >
      {rows.length ? (
        <Box sx={{ borderBottom: `1px solid ${color.border}` }}>
          {rows.map((item) => kind === 'closure'
            ? <ClosureQueueRow key={item.id} item={item} />
            : <FindingQueueRow key={item.id} item={item} />)}
        </Box>
      ) : (
        <Box sx={{ minHeight: 170, display: 'grid', placeContent: 'center', textAlign: 'center', ...type.small, color: color.textMuted }}>{emptyLabel}</Box>
      )}
    </Panel>
  )
}

export function RiskPosture({ distribution, unscoredMetric }) {
  const items = distribution?.items || []
  const scoredItems = items.filter((item) => item.count > 0)
  const total = distribution?.denominator || 0
  let offset = 0

  return (
    <Panel
      title="Risk posture"
      description="Current Risk v1 bands for scored findings. Select a band to inspect its records."
      footer={<DataDefinition source={distribution?.source} asOf={distribution?.asOf} countNote={`${formatMetricNumber(total) || 0} scored findings`} />}
      sx={{ height: '100%' }}
    >
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '132px minmax(0, 1fr)', sm: '154px minmax(0, 1fr)' }, gap: 2.5, alignItems: 'center' }}>
        <Box sx={{ position: 'relative', aspectRatio: '1' }}>
          <Box component="svg" viewBox="0 0 120 120" role="img" aria-label={`Risk distribution across ${total} scored findings`} sx={{ width: '100%', display: 'block', transform: 'rotate(-90deg)' }}>
            <circle cx="60" cy="60" r="46" fill="none" stroke={color.surfaceSunken} strokeWidth="14" />
            {scoredItems.map((item) => {
              const portion = total ? (item.count / total) * 100 : 0
              const currentOffset = offset
              offset += portion
              return <circle key={item.key} data-donut-segment cx="60" cy="60" r="46" pathLength="100" fill="none" stroke={riskBandColor[item.key] || color.neutral} strokeWidth="14" strokeDasharray={`${portion} ${100 - portion}`} strokeDashoffset={-currentOffset} />
            })}
          </Box>
          <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', textAlign: 'center' }}>
            <Box sx={{ ...type.metricSm, color: color.text }}>{formatMetricNumber(total) || '0'}</Box>
            <Box sx={{ ...type.caption, color: color.textMuted }}>scored</Box>
          </Box>
        </Box>
        <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {items.slice().reverse().map((item) => (
            <Box component="li" key={item.key}>
              <Box component={RouterLink} to={`/findings?riskBand=${item.key}`} sx={{ display: 'grid', gridTemplateColumns: '10px 1fr auto', alignItems: 'center', gap: 1, py: 0.7, color: 'inherit', textDecoration: 'none', borderRadius: `${radius.sm}px`, '&:hover': { backgroundColor: color.surfaceRaised }, '&:focus-visible': { outline: `2px solid ${color.borderFocus}` } }}>
                <Box aria-hidden="true" sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: riskBandColor[item.key] || color.neutral }} />
                <Box sx={{ ...type.small, color: color.textMuted }}>{RISK_LABEL[item.key] || item.key}</Box>
                <Box sx={{ ...type.code, color: color.text }}>{formatMetricNumber(item.count) || '0'}</Box>
              </Box>
            </Box>
          ))}
          <Box component="li" sx={{ mt: 0.5, pt: 1, borderTop: `1px solid ${color.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
            <Box sx={{ ...type.small, color: color.textMuted }}>Not yet scored</Box>
            <MetricValue metric={unscoredMetric} size="small" />
          </Box>
        </Box>
      </Box>
    </Panel>
  )
}

export function IngestionActivity({ trend }) {
  const days = trend?.days || []
  const maximum = Math.max(1, ...days.map((day) => Math.max(day.observations || 0, day.reportsIngested || 0)))
  return (
    <Panel title="Seven-day ingestion" description="Persisted observations and accepted reports per whole UTC day." footer={<DataDefinition source={trend?.source} asOf={trend?.asOf} note={trend?.note} />}>
      {days.length ? <>
        <Box sx={{ display: 'flex', gap: 2, mb: 1.5, ...type.caption, color: color.textMuted }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}><Box sx={{ width: 8, height: 8, bgcolor: color.accent }} />Observations</Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}><Box sx={{ width: 8, height: 8, bgcolor: color.info }} />Reports</Box>
        </Box>
        <Box component="ol" aria-label="Daily ingestion counts" sx={{ listStyle: 'none', p: 0, m: 0, height: 172, display: 'grid', gridTemplateColumns: `repeat(${days.length}, minmax(26px, 1fr))`, alignItems: 'end', gap: { xs: 0.5, sm: 1 } }}>
          {days.map((day) => <Box component="li" key={day.date} sx={{ height: '100%', display: 'grid', gridTemplateRows: '1fr auto', gap: 0.75 }}>
            <Box component="span" sx={{ position: 'absolute', display: 'block', left: 0, top: 0, width: 1, height: 1, p: 0, m: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0 }}>{day.date}: {day.observations} observations and {day.reportsIngested} reports ingested</Box>
            <Box sx={{ display: 'flex', alignItems: 'end', justifyContent: 'center', gap: '3px', borderBottom: `1px solid ${color.border}` }}>
              {[
                ['Observations', day.observations, color.accent],
                ['Reports', day.reportsIngested, color.info],
              ].map(([label, value, fill]) => <Box key={label} data-trend-bar title={`${day.date}: ${value} ${label.toLowerCase()}`} aria-label={`${day.date}: ${value} ${label.toLowerCase()}`} sx={{ width: { xs: 8, sm: 12 }, height: value ? `${Math.max(7, (value / maximum) * 100)}%` : 2, minHeight: value ? 7 : 2, backgroundColor: value ? fill : color.borderStrong, transformOrigin: 'bottom' }} />)}
            </Box>
            <Box sx={{ textAlign: 'center', fontFamily: font.mono, fontSize: 10.5, color: color.textMuted }}>{new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</Box>
          </Box>)}
        </Box>
        <Box sx={{ mt: 1.5, display: 'flex', gap: 3 }}>
          <Box><SectionLabel>Observations</SectionLabel><Box sx={{ ...type.metricSm, mt: 0.4 }}>{formatMetricNumber(trend.totals?.observations) || '0'}</Box></Box>
          <Box><SectionLabel>Reports</SectionLabel><Box sx={{ ...type.metricSm, mt: 0.4 }}>{formatMetricNumber(trend.totals?.reportsIngested) || '0'}</Box></Box>
        </Box>
      </> : <Box sx={{ ...type.small, color: color.textMuted }}>No UTC day buckets were returned.</Box>}
    </Panel>
  )
}

export function AgeingDistribution({ distribution }) {
  const items = distribution?.items || []
  const maximum = Math.max(1, ...items.map((item) => item.count || 0))
  return (
    <Panel title="Finding age" description="Time since each finding was last observed." footer={<DataDefinition source={distribution?.source} asOf={distribution?.asOf} countNote={`${formatMetricNumber(distribution?.denominator) || 0} findings`} />}>
      <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, display: 'grid', gap: 1.6 }}>
        {items.map((item) => <Box component="li" key={item.key}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mb: 0.6 }}><Box sx={{ ...type.small, color: color.textMuted }}>{AGE_LABEL[item.key] || item.key}</Box><Box sx={{ ...type.code, color: color.text }}>{formatMetricNumber(item.count) || '0'}</Box></Box>
          <Box sx={{ height: 8, backgroundColor: color.surfaceSunken, overflow: 'hidden' }}><Box data-age-bar sx={{ width: `${(item.count / maximum) * 100}%`, height: '100%', backgroundColor: item.key === 'OVER_30_DAYS' ? color.warning : color.accent, transformOrigin: 'left' }} /></Box>
        </Box>)}
      </Box>
      <Box sx={{ mt: 2.25, p: 1.25, backgroundColor: color.surfaceSunken, ...type.caption, color: color.textMuted }}>
        Age is operational context, not severity. Open a finding to inspect its current stored risk and evidence.
      </Box>
    </Panel>
  )
}

export function WorkflowPressure({ cases, notificationQueue, role }) {
  const caseMetrics = cases?.metrics || {}
  const notification = role === 'REVIEWER' ? notificationQueue?.awaitingReview : notificationQueue?.drafting
  const workflowSource = [
    caseMetrics.open?.source,
    caseMetrics.waitingForOrganization?.source,
    caseMetrics.closurePending?.source,
    caseMetrics.closed?.source,
    notification?.source,
  ].filter(Boolean).join('; ')
  const workflowAsOf = caseMetrics.open?.asOf || notification?.asOf
  return (
    <Panel title="Workflow pressure" description="Investigation states and the role-appropriate notification queue." actions={<Button component={RouterLink} to="/cases" size="small" variant="text" endIcon={<FiExternalLink />}>Cases</Button>} footer={<DataDefinition source={workflowSource} asOf={workflowAsOf} note="Raw persisted counts; no completion percentage is implied." />}>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, border: `1px solid ${color.border}` }}>
        {[
          ['Open', caseMetrics.open],
          ['Waiting on org', caseMetrics.waitingForOrganization],
          ['Closure review', caseMetrics.closurePending],
          ['Closed', caseMetrics.closed],
        ].map(([label, metric], index) => <Box key={label} sx={{ p: 1.25, borderLeft: { md: index ? `1px solid ${color.border}` : 0 }, borderTop: { xs: index > 1 ? `1px solid ${color.border}` : 0, md: 0 }, '&:nth-of-type(even)': { borderLeft: { xs: `1px solid ${color.border}`, md: index ? `1px solid ${color.border}` : 0 } } }}><Box sx={{ ...type.caption, color: color.textMuted }}>{label}</Box><Box sx={{ mt: 0.55 }}><MetricValue metric={metric} size="small" /></Box></Box>)}
      </Box>
      <Box sx={{ mt: 2.25, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Box><SectionLabel>{role === 'REVIEWER' ? 'Notifications awaiting review' : 'Notification drafts'}</SectionLabel><Box sx={{ mt: 0.55 }}><MetricValue metric={notification ? { ...notification, value: notification.total } : { availability: 'RESTRICTED' }} size="small" /></Box></Box>
        {notification?.availability === 'AVAILABLE' ? <Button component={RouterLink} to="/notifications" size="small" endIcon={<FiArrowRight />}>Open notifications</Button> : <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, ...type.small, color: color.textMuted }}><FiLock /> Restricted for this role</Box>}
      </Box>
    </Panel>
  )
}

export function RecentActivity({ activity }) {
  const items = activity?.items || []
  return (
    <Panel title="Recent case activity" description="Newest persisted lifecycle events." footer={<DataDefinition source={activity?.source} asOf={activity?.asOf} countNote={`${items.length} recent events shown`} />}>
      {items.length ? <Box component="ol" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {items.map((item, index) => <Box component="li" key={item.id}>
          <Box component={RouterLink} to={`/cases/${item.caseId}`} sx={{ display: 'grid', gridTemplateColumns: '18px minmax(0, 1fr) auto', gap: 1.25, alignItems: 'start', py: 1.1, color: 'inherit', textDecoration: 'none', borderTop: index ? `1px solid ${color.border}` : 0, '&:hover strong': { color: color.linkHover }, '&:focus-visible': { outline: `2px solid ${color.borderFocus}` } }}>
            <Box sx={{ mt: 0.35, width: 9, height: 9, borderRadius: '50%', border: `2px solid ${color.accent}` }} />
            <Box sx={{ minWidth: 0 }}><Box component="strong" sx={{ ...type.bodyStrong, color: color.text }}>{item.caseReference || 'Case'}</Box><Box sx={{ ...type.caption, color: color.textMuted, mt: 0.25 }}>{item.eventType?.replace(/_/g, ' ')}{item.toState ? ` · ${item.fromState || 'No state'} to ${item.toState}` : ''}</Box></Box>
            <Box sx={{ ...type.caption, color: color.textMuted, whiteSpace: 'nowrap' }}>{formatAsOf(item.occurredAt) || 'Time unavailable'}</Box>
          </Box>
        </Box>)}
      </Box> : <Box sx={{ ...type.small, color: color.textMuted, py: 2 }}>No lifecycle events have been persisted.</Box>}
    </Panel>
  )
}

export function ProviderFreshness({ providers, showSettings = false }) {
  const rows = providers ? [providers.ioc, ...(providers.vulnerability || [])].filter(Boolean) : []
  const summary = providers?.summary
  return (
    <Panel title="Stored provider evidence" description="Freshness of prior successful lookups. This view performs no provider request." actions={showSettings ? <Button component={RouterLink} to="/settings" size="small" variant="text">Settings</Button> : undefined} footer={<DataDefinition source={summary?.source} asOf={summary?.asOf || providers?.asOf} note={providers?.disclaimer} />}>
      {rows.length ? <>
        <Box sx={{ display: 'flex', gap: 2.5, mb: 1.5, flexWrap: 'wrap' }}>
          <Box><SectionLabel>Fresh</SectionLabel><Box sx={{ ...type.metricSm, color: color.success, mt: 0.4 }}>{summary?.fresh ?? 0}</Box></Box>
          <Box><SectionLabel>Stale</SectionLabel><Box sx={{ ...type.metricSm, color: color.warning, mt: 0.4 }}>{summary?.stale ?? 0}</Box></Box>
          <Box><SectionLabel>No stored success</SectionLabel><Box sx={{ ...type.metricSm, color: color.textMuted, mt: 0.4 }}>{summary?.noSuccessfulLookup ?? 0}</Box></Box>
        </Box>
        <Box>{rows.map((provider, index) => <Box key={provider.id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.25, py: 1, borderTop: index ? `1px solid ${color.border}` : 0 }}><Box sx={{ minWidth: 0 }}><Box sx={{ ...type.small, color: color.text }}>{provider.name}</Box><Box sx={{ ...type.caption, color: color.textMuted }}>{provider.lastSuccessAt ? `Stored ${formatAsOf(provider.lastSuccessAt)}` : 'No successful lookup recorded'}</Box></Box><StatusBadge dictionary={PROVIDER_STATE} value={provider.state} size="small" /></Box>)}</Box>
      </> : <Box sx={{ ...type.small, color: color.textMuted }}>No provider entries were returned.</Box>}
    </Panel>
  )
}

// Phase 6.2 — the one new primary dashboard visualization.
//
// The question: "across the findings that currently carry a Risk v1 score,
// which factors are actually producing that risk, and which are producing none
// because their evidence was never read?"
//
// Two decisions make this honest rather than decorative:
//
//  1. Every bar is scaled against the SAME denominator — the largest per-factor
//     stored cap in this snapshot — so bar lengths are comparable across rows
//     and the empty part of a track is the headroom that factor did not use.
//     No bar is scaled to its own maximum, which would make a factor that
//     contributed 100 of a possible 100 look identical to one that contributed
//     3000 of a possible 3000.
//  2. A zero-length bar is never left to speak for itself. Each row carries an
//     evidence state, because "measured and it added nothing", "we could not
//     read the evidence" and "this factor cannot apply here" are three
//     different facts that all draw an empty bar.
//
// There is deliberately NO click-through on a factor row. GET /api/findings
// exposes no factor filter, so a link here would either 404 or quietly return
// an unfiltered list — and a control that lies about what it will show is worse
// than no control. The panel links to Analysis instead, which is where the full
// per-factor table with applicability breakdowns actually lives.
export function RiskFactorPressure({ pressure }) {
  const factors = pressure?.factors || []
  // The scale denominator: the largest stored cap among the factors present.
  // Falls back to 1 so an all-zero dataset divides safely rather than rendering
  // NaN-width bars.
  const scale = Math.max(1, ...factors.map((f) => f.maximumContributionBasisPoints || 0))

  return (
    <Panel
      title="What is driving current risk"
      description="Persisted Risk v1 factor contributions, summed across every finding that holds a current score. A factor with no bar contributed nothing — the state beside it says whether that was measured or unreadable."
      actions={<Button component={RouterLink} to="/analytics" size="small" variant="text" endIcon={<FiExternalLink />}>Full breakdown</Button>}
      footer={
        <DataDefinition
          source={pressure?.source}
          asOf={pressure?.asOf}
          countNote={`${formatMetricNumber(pressure?.denominator) || 0} scored findings`}
          note={`${pressure?.denominatorDefinition || ''} ${pressure?.disclaimer || ''}`.trim()}
        />
      }
    >
      {factors.length ? (
        <>
          <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, display: 'grid', gap: 1.5 }}>
            {factors.map((factor) => {
              const meta = RISK_FACTOR_LABEL[factor.factorKey] || {}
              const state = factorEvidenceState(factor)
              const contributed = factor.contributionBasisPoints || 0
              const possible = factor.maximumContributionBasisPoints || 0
              return (
                <Box component="li" key={factor.factorKey}>
                  <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1.5, flexWrap: 'wrap', mb: 0.6 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                      <Box sx={{ ...type.small, color: color.text }}>{meta.label || factor.factorKey}</Box>
                      <StatusBadge dictionary={FACTOR_EVIDENCE_STATE} value={state} size="small" />
                    </Box>
                    <Box sx={{ ...type.code, color: contributed ? color.text : color.textMuted, whiteSpace: 'nowrap' }}>
                      {formatMetricNumber(contributed) || '0'}
                      <Box component="span" sx={{ color: color.textMuted }}> / {formatMetricNumber(possible) || '0'} bp</Box>
                    </Box>
                  </Box>
                  {/* The track is this factor's stored headroom; the fill is what
                      it actually contributed. Both are scaled by `scale`. */}
                  <Box sx={{ height: 9, backgroundColor: color.surfaceSunken, position: 'relative' }}>
                    <Box aria-hidden="true" sx={{ position: 'absolute', inset: 0, width: `${(possible / scale) * 100}%`, backgroundColor: color.canvasAlt, border: `1px solid ${color.border}` }} />
                    <Box
                      data-factor-bar
                      aria-hidden="true"
                      sx={{ position: 'absolute', insetBlock: 0, left: 0, width: `${(contributed / scale) * 100}%`, backgroundColor: contributed ? color.accent : 'transparent', transformOrigin: 'left' }}
                    />
                  </Box>
                  <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.5 }}>
                    {meta.meaning || 'Risk v1 factor.'}{' '}
                    {factor.applied > 0 && `${factor.applied} measured. `}
                    {factor.notAvailable > 0 && `${factor.notAvailable} with no readable evidence. `}
                    {factor.notApplicable > 0 && `${factor.notApplicable} where it cannot apply.`}
                  </Box>
                </Box>
              )
            })}
          </Box>

          {/* Accessible, non-visual alternative to the bars above: the same
              numbers as a real table, with the applicability split spelled out. */}
          <Box component="details" sx={{ mt: 2, ...type.caption, color: color.textMuted, '& summary': { cursor: 'pointer', width: 'fit-content', color: color.link }, '&[open] summary': { mb: 1 } }}>
            <summary>Factor contributions as a table</summary>
            <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', fontFamily: font.mono, fontSize: 12 }}>
              <caption style={{ textAlign: 'left', paddingBottom: 8, color: color.textMuted }}>
                Basis points contributed and possible, out of {formatMetricNumber(pressure?.denominator) || 0} findings holding a current Risk v1 score.
              </caption>
              <Box component="thead">
                <Box component="tr">
                  {['Factor', 'Contributed', 'Possible', 'Measured', 'No evidence', 'N/A'].map((h, i) => (
                    <Box component="th" key={h} scope="col" sx={{ textAlign: i ? 'right' : 'left', p: 0.75, borderBottom: `1px solid ${color.border}`, color: color.textMuted, fontWeight: 600 }}>{h}</Box>
                  ))}
                </Box>
              </Box>
              <Box component="tbody">
                {factors.map((factor) => (
                  <Box component="tr" key={factor.factorKey}>
                    <Box component="th" scope="row" sx={{ textAlign: 'left', p: 0.75, borderBottom: `1px solid ${color.border}`, color: color.text, fontWeight: 400 }}>
                      {RISK_FACTOR_LABEL[factor.factorKey]?.label || factor.factorKey}
                    </Box>
                    {[factor.contributionBasisPoints, factor.maximumContributionBasisPoints, factor.applied, factor.notAvailable, factor.notApplicable].map((value, i) => (
                      <Box component="td" key={i} sx={{ textAlign: 'right', p: 0.75, borderBottom: `1px solid ${color.border}`, color: color.text }}>{formatMetricNumber(value) ?? '0'}</Box>
                    ))}
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>

          <Box sx={{ mt: 2, p: 1.25, backgroundColor: color.surfaceSunken, ...type.caption, color: color.textMuted }}>
            Totals: {formatMetricNumber(pressure?.totals?.contributionBasisPoints) || 0} of{' '}
            {formatMetricNumber(pressure?.totals?.maximumContributionBasisPoints) || 0} possible basis points.{' '}
            {pressure?.totals?.note}
          </Box>
        </>
      ) : (
        <Box sx={{ ...type.small, color: color.textMuted, py: 2 }}>
          No finding currently holds a Risk v1 score, so no factor contribution has been persisted yet.
        </Box>
      )}
    </Panel>
  )
}

export function RoleActionButtons({ actions }) {
  return actions.map(({ to, label, icon: Icon, primary }) => <Button key={label} component={RouterLink} to={to} variant={primary ? 'contained' : 'outlined'} startIcon={<Icon />} size="small">{label}</Button>)
}

export function RefreshStatus({ loading, onRefresh, generatedAt, role, reducedMotion = false }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <Chip label={`${role} view`} size="small" variant="outlined" />
      <Box sx={{ ...type.caption, color: color.textMuted, display: 'flex', alignItems: 'center', gap: 0.6 }}><FiClock size={12} />Snapshot {formatAsOf(generatedAt) || 'time unavailable'}</Box>
      <Button
        onClick={onRefresh}
        disabled={loading}
        size="small"
        variant="text"
        startIcon={<FiRefreshCw className={loading ? 'tnx-spin' : undefined} />}
        sx={{ '& .tnx-spin': { animation: reducedMotion ? 'none' : 'tnxSpin .8s linear infinite' }, '@keyframes tnxSpin': { to: { transform: 'rotate(360deg)' } } }}
      >
        {loading ? 'Updating' : 'Refresh'}
      </Button>
    </Box>
  )
}
