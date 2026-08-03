import React from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Box, Button, Chip, CircularProgress } from '@mui/material'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import {
  FiActivity,
  FiArrowRight,
  FiBarChart2,
  FiBriefcase,
  FiClock,
  FiExternalLink,
  FiFileText,
  FiLock,
  FiRefreshCw,
  FiShield,
  FiUploadCloud,
} from 'react-icons/fi'

import { dashboardService } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useReducedMotion } from '../hooks/useReducedMotion'
import {
  DeniedState,
  ErrorState,
  LoadingState,
  MetricValue,
  Panel,
  Provenance,
  RiskBandBadge,
  ScopeNote,
  SectionLabel,
  StatusBadge,
  UnavailableState,
  formatAsOf,
  formatMetricNumber,
} from '../components/ui'
import { color, font, radius, riskBandColor, shadow, type } from '../theme/tokens'

gsap.registerPlugin(ScrollTrigger, useGSAP)

const ROLE_COPY = {
  ADMIN: {
    eyebrow: 'Administration / operational assurance',
    title: 'Control room',
    description: 'System health, unresolved risk and workflow pressure across the loaded dataset.',
  },
  ANALYST: {
    eyebrow: 'Analyst workspace / daily operations',
    title: 'Investigation command center',
    description: 'Prioritize findings, move investigations forward and keep constituent work from stalling.',
  },
  REVIEWER: {
    eyebrow: 'Reviewer workspace / decision queue',
    title: 'Review command center',
    description: 'Oldest decisions first, with direct access to the evidence required for an independent review.',
  },
  VIEWER: {
    eyebrow: 'Read-only oversight / operational picture',
    title: 'Operational picture',
    description: 'A factual, read-only view of the evidence loaded into this instance.',
  },
}

const RISK_LABEL = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  INFORMATIONAL: 'Informational',
}

const CASE_STATE = {
  OPEN: { label: 'Open', tone: 'info', icon: 'dot' },
  WAITING_FOR_ORG: { label: 'Waiting for organization', tone: 'warning', icon: 'clock' },
  CLOSURE_PENDING: { label: 'Closure pending review', tone: 'accent', icon: 'gavel' },
  CLOSED: { label: 'Closed', tone: 'neutral', icon: 'check' },
}

const NOTIFICATION_STATE = {
  DRAFT: { label: 'Draft', tone: 'neutral', icon: 'edit' },
  PENDING_REVIEW: { label: 'Pending review', tone: 'warning', icon: 'clock' },
  APPROVED: { label: 'Approved', tone: 'success', icon: 'check' },
  REJECTED: { label: 'Rejected', tone: 'danger', icon: 'cross' },
}

const PROVIDER_STATE = {
  FRESH: { label: 'Recent result stored', tone: 'success', icon: 'check' },
  STALE: { label: 'Stored result stale', tone: 'warning', icon: 'clock' },
  NO_SUCCESSFUL_LOOKUP_RECORDED: { label: 'No stored success', tone: 'neutral', icon: 'minus' },
}

function isReadable(section) {
  return section?.availability === 'AVAILABLE'
}

function metricFromQueue(queue) {
  return {
    value: queue?.total,
    availability: queue?.availability || 'UNAVAILABLE',
    source: queue?.source,
    asOf: queue?.asOf,
  }
}

function SectionFallback({ section, compact = false }) {
  if (section?.availability === 'RESTRICTED') {
    return <DeniedState dense={compact}>{section.reason}</DeniedState>
  }
  return <UnavailableState dense={compact}>{section?.reason}</UnavailableState>
}

function MetricCard({ label, metric, description, icon: Icon }) {
  return (
    <Box
      data-kpi
      sx={{
        minWidth: 0,
        p: 2.25,
        border: `1px solid ${color.border}`,
        borderRadius: `${radius.md}px`,
        background: `linear-gradient(145deg, ${color.surfaceRaised} 0%, ${color.surface} 72%)`,
        boxShadow: shadow.panel,
        position: 'relative',
        overflow: 'hidden',
        '&::after': {
          content: '""',
          position: 'absolute',
          inset: '0 auto 0 0',
          width: 2,
          backgroundColor: color.accent,
          opacity: 0.78,
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <SectionLabel component="h2">{label}</SectionLabel>
        {Icon && <Icon size={16} color={color.textFaint} aria-hidden="true" />}
      </Box>
      <Box data-metric-value sx={{ mt: 1.4 }}>
        <MetricValue metric={metric} />
      </Box>
      <Box sx={{ ...type.caption, color: color.textMuted, mt: 1 }}>{description}</Box>
      <Provenance source={metric?.source} asOf={metric?.asOf} sx={{ mt: 1.3 }} />
    </Box>
  )
}

function RiskDonut({ distribution, unscoredMetric }) {
  const items = (distribution?.items || []).filter((item) => item.count > 0)
  const total = distribution?.denominator || items.reduce((sum, item) => sum + item.count, 0)
  let offset = 0

  return (
    <Panel
      title="Current Risk v1 posture"
      description="Scored open and closed findings in the loaded dataset. Arc size is proportional to the printed count."
      sx={{ height: '100%' }}
      contentSx={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      footer={
        <Provenance
          source={distribution?.source}
          asOf={distribution?.asOf}
          note={`denominator ${formatMetricNumber(total) || 0} scored findings`}
        />
      }
    >
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '132px 1fr', sm: '156px 1fr' }, gap: 2.5, alignItems: 'center', flex: 1 }}>
        <Box sx={{ position: 'relative', width: '100%', aspectRatio: '1' }}>
          <Box component="svg" viewBox="0 0 120 120" role="img" aria-label={`Risk distribution across ${total} scored findings`} sx={{ width: '100%', display: 'block', transform: 'rotate(-90deg)' }}>
            <circle cx="60" cy="60" r="46" fill="none" stroke={color.surfaceSunken} strokeWidth="13" />
            {items.map((item) => {
              const portion = total ? (item.count / total) * 100 : 0
              const currentOffset = offset
              offset += portion
              return (
                <circle
                  data-donut-segment
                  key={item.key}
                  cx="60"
                  cy="60"
                  r="46"
                  pathLength="100"
                  fill="none"
                  stroke={riskBandColor[item.key] || color.neutral}
                  strokeWidth="13"
                  strokeLinecap="butt"
                  strokeDasharray={`${portion} ${100 - portion}`}
                  strokeDashoffset={-currentOffset}
                />
              )
            })}
          </Box>
          <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', textAlign: 'center' }}>
            <Box sx={{ ...type.metricSm, color: color.text }}>{formatMetricNumber(total) || '0'}</Box>
            <Box sx={{ ...type.label, color: color.textFaint, mt: 0.5 }}>scored</Box>
          </Box>
        </Box>

        <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, display: 'grid', gap: 1 }}>
          {(distribution?.items || []).map((item) => (
            <Box component="li" key={item.key} sx={{ display: 'grid', gridTemplateColumns: '10px 1fr auto', gap: 1, alignItems: 'center' }}>
              <Box aria-hidden="true" sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: riskBandColor[item.key] || color.neutral }} />
              <Box sx={{ ...type.small, color: color.textMuted }}>{RISK_LABEL[item.key] || item.key}</Box>
              <Box sx={{ ...type.code, color: color.text }}>{formatMetricNumber(item.count) || '0'}</Box>
            </Box>
          ))}
          <Box component="li" sx={{ mt: 0.75, pt: 1.25, borderTop: `1px solid ${color.border}` }}>
            <SectionLabel>Not yet scored</SectionLabel>
            <Box sx={{ mt: 0.5 }}><MetricValue metric={unscoredMetric} size="small" /></Box>
          </Box>
        </Box>
      </Box>
    </Panel>
  )
}

function IngestionBars({ trend }) {
  const days = trend?.days || []
  const maximum = Math.max(1, ...days.map((day) => Math.max(day.observations || 0, day.reportsIngested || 0)))

  return (
    <Panel
      title="Seven-day ingestion activity"
      description="Persisted observations and accepted reports per whole UTC day—discrete counts, not a continuous feed."
      footer={<Provenance source={trend?.source} asOf={trend?.asOf} note={trend?.note} />}
    >
      {days.length ? (
        <>
          <Box sx={{ display: 'flex', gap: 2, mb: 2, ...type.caption, color: color.textMuted }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}><Box sx={{ width: 8, height: 8, bgcolor: color.accent }} />Observations</Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}><Box sx={{ width: 8, height: 8, bgcolor: color.info }} />Reports</Box>
          </Box>
          <Box component="ol" aria-label="Daily ingestion counts" sx={{ listStyle: 'none', p: 0, m: 0, height: 180, display: 'grid', gridTemplateColumns: `repeat(${days.length}, minmax(34px, 1fr))`, alignItems: 'end', gap: { xs: 0.75, sm: 1.25 } }}>
            {days.map((day) => (
              <Box component="li" key={day.date} sx={{ minWidth: 0, height: '100%', display: 'grid', gridTemplateRows: '1fr auto', gap: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'end', justifyContent: 'center', gap: '3px', borderBottom: `1px solid ${color.border}` }}>
                  {[
                    ['Observations', day.observations, color.accent],
                    ['Reports', day.reportsIngested, color.info],
                  ].map(([label, value, fill]) => (
                    <Box
                      data-trend-bar
                      key={label}
                      title={`${day.date}: ${value} ${label.toLowerCase()}`}
                      aria-label={`${day.date}: ${value} ${label.toLowerCase()}`}
                      sx={{
                        width: { xs: 8, sm: 12 },
                        height: value ? `${Math.max(8, (value / maximum) * 100)}%` : 2,
                        minHeight: value ? 8 : 2,
                        backgroundColor: value ? fill : color.borderStrong,
                        transformOrigin: 'bottom',
                        borderRadius: '3px 3px 0 0',
                      }}
                    />
                  ))}
                </Box>
                <Box sx={{ textAlign: 'center', fontFamily: font.mono, fontSize: 10.5, color: color.textFaint }}>
                  {new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}
                </Box>
              </Box>
            ))}
          </Box>
          <Box sx={{ mt: 2, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            <Box><SectionLabel>Observations</SectionLabel><Box sx={{ ...type.metricSm, mt: 0.5 }}>{formatMetricNumber(trend.totals?.observations) || '0'}</Box></Box>
            <Box><SectionLabel>Reports ingested</SectionLabel><Box sx={{ ...type.metricSm, mt: 0.5 }}>{formatMetricNumber(trend.totals?.reportsIngested) || '0'}</Box></Box>
          </Box>
        </>
      ) : (
        <Box sx={{ ...type.small, color: color.textMuted }}>No UTC day buckets were returned.</Box>
      )}
    </Panel>
  )
}

function QueueRow({ item, kind }) {
  if (kind === 'finding') {
    return (
      <Box component={RouterLink} to={`/findings/${item.id}`} sx={queueRowSx}>
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ ...type.code, color: color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.indicatorValue}{item.port ? `:${item.port}` : ''}</Box>
          <Box sx={{ ...type.caption, color: color.textFaint, mt: 0.35 }}>{item.reportType?.replace(/_/g, ' ')} · seen {item.occurrenceCount} time{item.occurrenceCount === 1 ? '' : 's'}</Box>
        </Box>
        {item.risk?.state === 'SCORED' ? <RiskBandBadge band={item.risk.band} score={item.risk.displayScore} /> : <Chip size="small" label="Not scored" variant="outlined" />}
      </Box>
    )
  }

  if (kind === 'closure') {
    const record = item.case || {}
    return (
      <Box component={RouterLink} to={`/cases/${item.caseId}`} sx={queueRowSx}>
        <Box sx={{ minWidth: 0 }}><Box sx={{ ...type.bodyStrong, color: color.text }}>{record.caseReference || 'Case'}</Box><Box sx={{ ...type.caption, color: color.textFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{record.title} · requested {formatAsOf(item.requestedAt)}</Box></Box>
        <FiArrowRight aria-hidden="true" />
      </Box>
    )
  }

  if (kind === 'notification') {
    return (
      <Box component={RouterLink} to={`/notifications/${item.id}`} sx={queueRowSx}>
        <Box sx={{ minWidth: 0 }}><Box sx={{ ...type.bodyStrong, color: color.text }}>{item.notificationReference || 'Notification'}</Box><Box sx={{ ...type.caption, color: color.textFaint }}>{item.caseReference || 'No case reference'} · {item.organizationName || 'No organization'}</Box></Box>
        <StatusBadge dictionary={NOTIFICATION_STATE} value={item.lifecycleState} size="small" />
      </Box>
    )
  }

  return (
    <Box component={RouterLink} to={`/cases/${item.id}`} sx={queueRowSx}>
      <Box sx={{ minWidth: 0 }}><Box sx={{ ...type.bodyStrong, color: color.text }}>{item.caseReference || 'Case'}</Box><Box sx={{ ...type.caption, color: color.textFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title} · {item.organizationName || 'No organization'}</Box></Box>
      <StatusBadge dictionary={CASE_STATE} value={item.lifecycleState} size="small" />
    </Box>
  )
}

const queueRowSx = {
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  minHeight: 58,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 1.5,
  px: 1.5,
  py: 1.1,
  color: color.textMuted,
  textDecoration: 'none',
  borderRadius: `${radius.sm}px`,
  border: `1px solid transparent`,
  '&:hover': { backgroundColor: color.surfaceRaised, borderColor: color.border },
  '&:focus-visible': { outline: `2px solid ${color.borderFocus}`, outlineOffset: 2 },
}

function QueuePanel({ title, description, queue, kind, emptyLabel, to }) {
  return (
    <Panel
      title={title}
      description={description}
      actions={<Button component={RouterLink} to={to} size="small" variant="text" endIcon={<FiArrowRight />}>Open queue</Button>}
      footer={<Provenance source={queue?.source} asOf={queue?.asOf} note={`${formatMetricNumber(queue?.total) || 0} ${queue?.totalLabel || 'total'} · showing up to ${queue?.items?.length || 0}`} />}
      sx={{ minWidth: 0 }}
    >
      {queue?.items?.length ? (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 0.5 }}>{queue.items.map((item) => <QueueRow key={item.id} item={item} kind={kind} />)}</Box>
      ) : (
        <Box sx={{ minHeight: 116, display: 'grid', placeContent: 'center', textAlign: 'center', ...type.small, color: color.textMuted }}>{emptyLabel}</Box>
      )}
    </Panel>
  )
}

function WorkflowRail({ role, sections }) {
  const actions = {
    ANALYST: [
      { to: '/upload', label: 'Ingest report', detail: 'Add evidence to the loaded dataset', icon: FiUploadCloud },
      { to: '/findings', label: 'Triage findings', detail: `${sections.findingQueues?.awaitingTriage?.total ?? '—'} awaiting a decision`, icon: FiShield },
      { to: '/cases', label: 'Open investigations', detail: 'Continue case work', icon: FiBriefcase },
    ],
    REVIEWER: [
      { to: '/cases', label: 'Review closures', detail: `${sections.caseQueues?.closureReview?.total ?? '—'} pending`, icon: FiBriefcase },
      { to: '/notifications', label: 'Review notifications', detail: `${sections.notificationQueue?.awaitingReview?.total ?? '—'} pending`, icon: FiFileText },
      { to: '/analytics', label: 'Inspect evidence', detail: 'Compare persisted distributions', icon: FiBarChart2 },
    ],
    ADMIN: [
      { to: '/organizations', label: 'Organizations', detail: 'Manage constituent records', icon: FiBriefcase },
      { to: '/settings', label: 'System settings', detail: 'Provider and motion configuration', icon: FiActivity },
      { to: '/analytics', label: 'Operational analysis', detail: 'Inspect persisted distributions', icon: FiBarChart2 },
    ],
    VIEWER: [
      { to: '/findings', label: 'Browse findings', detail: 'Read-only evidence view', icon: FiShield },
      { to: '/cases', label: 'Browse cases', detail: 'Read-only lifecycle view', icon: FiBriefcase },
      { to: '/analytics', label: 'Open analysis', detail: 'Compare persisted distributions', icon: FiBarChart2 },
    ],
  }[role] || []

  return (
    <Box sx={{ position: { lg: 'sticky' }, top: { lg: 84 }, display: 'grid', gap: 1.25 }}>
      <Box sx={{ ...type.label, color: color.textFaint, px: 0.5 }}>Your next actions</Box>
      {actions.map(({ to, label, detail, icon: Icon }) => (
        <Box key={to + label} component={RouterLink} to={to} sx={{ ...queueRowSx, minHeight: 70, p: 1.5, borderColor: color.border, backgroundColor: color.surface }}>
          <Box sx={{ display: 'flex', gap: 1.2, minWidth: 0 }}><Box sx={{ mt: 0.25, color: color.accent }}><Icon size={17} aria-hidden="true" /></Box><Box sx={{ minWidth: 0 }}><Box sx={{ ...type.bodyStrong, color: color.text }}>{label}</Box><Box sx={{ ...type.caption, color: color.textFaint, mt: 0.25 }}>{detail}</Box></Box></Box>
          <FiArrowRight aria-hidden="true" />
        </Box>
      ))}
      <ScopeNote sx={{ mt: 0.75 }} />
    </Box>
  )
}

function roleMetrics(role, sections) {
  const f = sections.findings
  const c = sections.cases
  const fq = sections.findingQueues
  const cq = sections.caseQueues
  const nq = sections.notificationQueue
  const common = {
    open: { label: 'Open findings', metric: f?.metrics?.open, description: 'Unresolved findings in the loaded dataset.', icon: FiShield },
    persistent: { label: 'Persistent findings', metric: f?.metrics?.persistent, description: 'Observed in more than one accepted report.', icon: FiActivity },
    reports: { label: 'Reports processed', metric: f?.metrics?.reportsProcessed, description: 'Reports accepted and parsed by this instance.', icon: FiUploadCloud },
  }

  if (role === 'REVIEWER') return [
    { label: 'Closure decisions', metric: metricFromQueue(cq?.closureReview), description: 'Pending independent reviewer decisions.', icon: FiBriefcase },
    { label: 'Notification reviews', metric: metricFromQueue(nq?.awaitingReview), description: 'Constituent artifacts awaiting review.', icon: FiFileText },
    { label: 'Waiting on organizations', metric: c?.metrics?.waitingForOrganization, description: 'Investigations paused for constituent input.', icon: FiClock },
    common.open,
  ]
  if (role === 'ADMIN') return [
    common.open,
    { label: 'Not yet scored', metric: f?.metrics?.unscored, description: 'Findings without a current Risk v1 snapshot.', icon: FiActivity },
    { label: 'Awaiting triage', metric: metricFromQueue(fq?.awaitingTriage), description: 'Open findings with no current triage decision.', icon: FiClock },
    { label: 'Workflow reviews', metric: metricFromQueue(cq?.closureReview), description: 'Closure requests awaiting an independent reviewer.', icon: FiBriefcase },
  ]
  if (role === 'VIEWER') return [common.open, common.persistent, common.reports, { label: 'Open cases', metric: c?.metrics?.open, description: 'Investigations currently open.', icon: FiBriefcase }]
  return [common.open, { label: 'Awaiting triage', metric: metricFromQueue(fq?.awaitingTriage), description: 'Open findings without a current triage decision.', icon: FiClock }, common.persistent, common.reports]
}

export const Dashboard = () => {
  const shellRef = React.useRef(null)
  const [overview, setOverview] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const { user } = useAuth()
  const reducedMotion = useReducedMotion()

  const load = React.useCallback(() => {
    setLoading(true)
    setError(false)
    dashboardService.getOverview()
      .then((res) => setOverview(res.data?.data || null))
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => { load() }, [load])

  useGSAP(() => {
    if (!overview || reducedMotion) return
    const timeline = gsap.timeline({ defaults: { ease: 'power2.out' } })
    timeline
      .fromTo('[data-dashboard-intro]', { y: 12, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.38 })
      .fromTo('[data-kpi]', { y: 14, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.4, stagger: 0.07 }, '-=0.18')

    const donutSegments = gsap.utils.toArray('[data-donut-segment]')
    if (donutSegments.length) {
      timeline.fromTo(donutSegments, { strokeDashoffset: 100 }, { strokeDashoffset: (index, element) => element.getAttribute('stroke-dashoffset'), duration: 0.72, stagger: 0.07 }, '-=0.22')
    }

    const trendBars = gsap.utils.toArray('[data-trend-bar]')
    const trendSection = shellRef.current?.querySelector('[data-trend-section]')
    if (trendBars.length && trendSection) {
      gsap.fromTo(trendBars, { scaleY: 0.05 }, {
        scaleY: 1,
        duration: 0.5,
        stagger: 0.025,
        ease: 'power2.out',
        scrollTrigger: { trigger: trendSection, start: 'top 88%', once: true },
      })
    }

    gsap.utils.toArray('[data-dashboard-section]').forEach((section) => {
      gsap.fromTo(section, { y: 18 }, {
        y: 0,
        duration: 0.45,
        ease: 'power2.out',
        scrollTrigger: { trigger: section, start: 'top 90%', once: true },
      })
    })
  }, { scope: shellRef, dependencies: [overview, reducedMotion], revertOnUpdate: true })

  if (loading && !overview) return <LoadingState label="Loading your operational workspace" />
  if ((error && !overview) || !overview) return <Panel><ErrorState onRetry={load}>The overview could not be loaded. No assumed figures are shown.</ErrorState></Panel>

  const sections = overview.sections
  const role = overview.audience?.role || user?.role || 'VIEWER'
  const copy = ROLE_COPY[role] || ROLE_COPY.VIEWER
  const metrics = roleMetrics(role, sections)
  const f = sections.findings
  const c = sections.cases
  const n = sections.notifications
  const fq = sections.findingQueues
  const cq = sections.caseQueues
  const nq = sections.notificationQueue

  const mainQueue = role === 'REVIEWER'
    ? { title: 'Oldest closure requests', description: 'Reviewer queue ordered oldest first.', queue: cq?.closureReview, kind: 'closure', emptyLabel: 'No closure requests are waiting.', to: '/cases' }
    : role === 'VIEWER'
      ? { title: 'Highest current Risk v1', description: 'Read-only prioritization by current stored score.', queue: fq?.priority, kind: 'finding', emptyLabel: 'No scored open findings are available.', to: '/findings' }
      : { title: role === 'ADMIN' ? 'Unresolved risk requiring attention' : 'Your triage queue', description: role === 'ADMIN' ? 'Highest current stored Risk v1 scores.' : 'Open findings without a current triage decision.', queue: role === 'ADMIN' ? fq?.priority : fq?.awaitingTriage, kind: 'finding', emptyLabel: 'Nothing is waiting in this queue.', to: '/findings' }

  return (
    <Box ref={shellRef}>
      <Box data-dashboard-intro sx={{ mb: 3.5, position: 'relative', overflow: 'hidden', borderRadius: `${radius.lg}px`, border: `1px solid ${color.border}`, background: `radial-gradient(circle at 78% 12%, rgba(49,199,180,0.12), transparent 32%), linear-gradient(135deg, ${color.surfaceRaised}, ${color.surfaceSunken})`, p: { xs: 2.5, md: 3.5 } }}>
        <Box aria-hidden="true" sx={{ position: 'absolute', right: { xs: -38, md: 22 }, top: -36, fontFamily: font.ui, fontSize: { xs: 120, md: 178 }, fontWeight: 700, lineHeight: 1, color: 'rgba(234,241,249,0.025)', userSelect: 'none' }}>PKCERT</Box>
        <Box sx={{ position: 'relative', maxWidth: 830 }}>
          <Box sx={{ ...type.label, color: color.accent, mb: 1 }}>{copy.eyebrow}</Box>
          <Box component="h1" sx={{ ...type.displayLg, color: color.text, m: 0 }}>{copy.title}</Box>
          <Box sx={{ ...type.body, color: color.textMuted, mt: 1, maxWidth: 760 }}>{copy.description}</Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mt: 2.25 }}>
            <Button variant="contained" startIcon={loading ? <CircularProgress size={14} color="inherit" /> : <FiRefreshCw />} onClick={load} disabled={loading}>{loading ? 'Updating snapshot' : 'Refresh snapshot'}</Button>
            <Chip label={`${role} view`} size="small" variant="outlined" />
            <Box sx={{ ...type.caption, color: color.textFaint }}>Snapshot {formatAsOf(overview.generatedAt)}</Box>
          </Box>
        </Box>
      </Box>

      {error && overview && <Box role="status" sx={{ mb: 2, ...type.small, color: color.warning }}>Refresh failed. The last successful snapshot remains visible and is timestamped below.</Box>}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 288px' }, gap: 2.5, alignItems: 'start' }}>
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(4, minmax(0, 1fr))' }, gap: 1.5, mb: 2.5 }}>
            {metrics.map((item) => <MetricCard key={item.label} {...item} />)}
          </Box>

          {isReadable(f) && isReadable(fq) ? (
            <Box data-dashboard-section sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'minmax(300px, .82fr) minmax(400px, 1.18fr)' }, gap: 2, mb: 2 }}>
              <RiskDonut distribution={f.distributions.riskBand} unscoredMetric={f.metrics.unscored} />
              <QueuePanel {...mainQueue} />
            </Box>
          ) : <Panel sx={{ mb: 2 }}><SectionFallback section={!isReadable(f) ? f : fq} /></Panel>}

          <Box data-dashboard-section data-trend-section sx={{ mb: 2 }}>
            {isReadable(sections.ingestionTrend) ? <IngestionBars trend={sections.ingestionTrend} /> : <Panel title="Seven-day ingestion activity"><SectionFallback section={sections.ingestionTrend} compact /></Panel>}
          </Box>

          <Box data-dashboard-section sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'minmax(0, 1fr) minmax(0, 1fr)' }, gap: 2, mb: 2 }}>
            {isReadable(cq) ? (
              <QueuePanel title="Waiting on constituent organizations" description="Oldest stalled investigation first." queue={cq.waitingOnOrganization} kind="case" emptyLabel="No cases are waiting on an organization." to="/cases" />
            ) : <Panel title="Case workflow"><SectionFallback section={cq} compact /></Panel>}
            {isReadable(nq) ? (
              <QueuePanel title={role === 'REVIEWER' ? 'Notification review queue' : 'Notification drafting queue'} description={role === 'REVIEWER' ? 'Constituent artifacts awaiting an independent decision.' : 'Artifacts still being prepared for review.'} queue={role === 'REVIEWER' ? nq.awaitingReview : nq.drafting} kind="notification" emptyLabel="No notifications are waiting in this queue." to="/notifications" />
            ) : (
              <Panel title="Constituent notifications" description="Constituent-addressed correspondence follows a stricter read boundary."><Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, color: color.textMuted }}><FiLock aria-hidden="true" /><Box sx={type.small}>This role does not receive notification content or counts.</Box></Box><SectionFallback section={nq || n} compact /></Panel>
            )}
          </Box>

          <Box data-dashboard-section sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', xl: 'minmax(0, 1.15fr) minmax(0, .85fr)' }, gap: 2 }}>
            <Panel title="Case pipeline" description="Current investigation lifecycle states—raw counts, not a completion percentage." actions={<Button component={RouterLink} to="/cases" size="small" variant="text" endIcon={<FiExternalLink />}>All cases</Button>}>
              {isReadable(c) ? (
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' }, gap: 1.5 }}>
                  {[
                    ['Open', c.metrics.open],
                    ['Waiting on org', c.metrics.waitingForOrganization],
                    ['Closure review', c.metrics.closurePending],
                    ['Closed', c.metrics.closed],
                  ].map(([label, metric]) => <Box key={label} sx={{ p: 1.4, borderRadius: `${radius.sm}px`, backgroundColor: color.surfaceSunken }}><SectionLabel>{label}</SectionLabel><Box sx={{ mt: 0.8 }}><MetricValue metric={metric} size="small" /></Box></Box>)}
                </Box>
              ) : <SectionFallback section={c} compact />}
            </Panel>

            <Panel title="Provider evidence freshness" description="Configuration and last persisted success; rendering this panel makes no provider request." actions={<Button component={RouterLink} to="/settings" size="small" variant="text">Settings</Button>}>
              {isReadable(sections.providers) ? (
                <Box sx={{ display: 'grid', gap: 1 }}>
                  {[sections.providers.ioc, ...(sections.providers.vulnerability || [])].map((provider) => (
                    <Box key={provider.id} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minWidth: 0, py: 0.75, borderBottom: `1px solid ${color.border}` }}>
                      <Box sx={{ minWidth: 0 }}><Box sx={{ ...type.small, color: color.text, overflowWrap: 'anywhere' }}>{provider.name}</Box><Box sx={{ ...type.caption, color: color.textFaint, overflowWrap: 'anywhere' }}>{provider.source}</Box></Box>
                      <StatusBadge dictionary={PROVIDER_STATE} value={provider.state} size="small" />
                    </Box>
                  ))}
                </Box>
              ) : <SectionFallback section={sections.providers} compact />}
            </Panel>
          </Box>
        </Box>

        <WorkflowRail role={role} sections={sections} />
      </Box>
    </Box>
  )
}

export default Dashboard
