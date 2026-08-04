import React from 'react'
import { Box } from '@mui/material'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

import { dashboardService } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { ErrorState, LoadingState, PageHeader, Panel, ScopeNote } from '../components/ui'
import {
  AgeingDistribution,
  IngestionActivity,
  MetricStrip,
  PriorityQueue,
  ProviderFreshness,
  RecentActivity,
  RefreshStatus,
  RiskPosture,
  RoleActionButtons,
  SectionFallback,
  WorkflowPressure,
} from '../components/dashboard/DashboardSections'
import {
  ROLE_COPY,
  mainQueueForRole,
  roleActions,
  roleMetrics,
} from '../components/dashboard/dashboardModel'
import { color, font, radius, type } from '../theme/tokens'

gsap.registerPlugin(ScrollTrigger, useGSAP)

function isReadable(section) {
  return section?.availability === 'AVAILABLE'
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
    if (!overview || reducedMotion) return undefined

    const timeline = gsap.timeline({ defaults: { ease: 'power3.out' } })
    timeline
      .fromTo('[data-dashboard-header]', { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.42, clearProps: 'transform,opacity,visibility' })
      .fromTo('[data-kpi]', { y: 12, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.34, stagger: 0.055, clearProps: 'transform,opacity,visibility' }, '-=0.24')
      .fromTo('[data-primary-panel]', { y: 18, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.42, stagger: 0.08, clearProps: 'transform,opacity,visibility' }, '-=0.2')
      .fromTo('[data-queue-row]', { x: -14, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.3, stagger: 0.045, clearProps: 'transform,opacity,visibility' }, '-=0.28')

    const donutSegments = gsap.utils.toArray('[data-donut-segment]')
    if (donutSegments.length) {
      timeline.fromTo(
        donutSegments,
        { strokeDashoffset: 100 },
        {
          strokeDashoffset: (_index, element) => Number(element.getAttribute('stroke-dashoffset') || 0),
          duration: 0.72,
          stagger: 0.06,
          ease: 'power2.out',
          clearProps: 'strokeDashoffset',
        },
        '-=0.36'
      )
    }

    gsap.utils.toArray('[data-secondary-section]').forEach((section) => {
      gsap.fromTo(section, { y: 18 }, {
        y: 0,
        duration: 0.42,
        ease: 'power3.out',
        clearProps: 'transform',
        scrollTrigger: { trigger: section, start: 'top 92%', once: true },
      })
    })

    const trendBars = gsap.utils.toArray('[data-trend-bar]')
    const trendSection = shellRef.current?.querySelector('[data-trend-section]')
    if (trendBars.length && trendSection) {
      gsap.fromTo(trendBars, { scaleY: 0.04 }, {
        scaleY: 1,
        duration: 0.52,
        stagger: 0.025,
        ease: 'power3.out',
        clearProps: 'transform',
        scrollTrigger: { trigger: trendSection, start: 'top 88%', once: true },
      })
    }

    const ageBars = gsap.utils.toArray('[data-age-bar]')
    const ageSection = shellRef.current?.querySelector('[data-age-section]')
    if (ageBars.length && ageSection) {
      gsap.fromTo(ageBars, { scaleX: 0.03 }, {
        scaleX: 1,
        duration: 0.48,
        stagger: 0.07,
        ease: 'power3.out',
        clearProps: 'transform',
        scrollTrigger: { trigger: ageSection, start: 'top 88%', once: true },
      })
    }

    return () => timeline.revert()
  }, { scope: shellRef, dependencies: [overview?.generatedAt, reducedMotion], revertOnUpdate: true })

  if (loading && !overview) return <LoadingState label="Loading your operational workspace" />
  if ((error && !overview) || !overview) {
    return <Panel><ErrorState onRetry={load}>The overview could not be loaded. No assumed figures are shown.</ErrorState></Panel>
  }

  const sections = overview.sections || {}
  const role = overview.audience?.role || user?.role || 'VIEWER'
  const copy = ROLE_COPY[role] || ROLE_COPY.VIEWER
  const metrics = roleMetrics(role, sections)
  const actions = roleActions(role, sections)
  const mainQueue = mainQueueForRole(role, sections)
  const findings = sections.findings
  const cases = sections.cases
  const findingQueues = sections.findingQueues

  return (
    <Box ref={shellRef}>
      <Box
        data-dashboard-header
        sx={{
          position: 'relative',
          overflow: 'hidden',
          borderBottom: `1px solid ${color.border}`,
          mb: 2.25,
          pb: 2.5,
        }}
      >
        <Box aria-hidden="true" sx={{ position: 'absolute', right: { xs: -20, md: 12 }, bottom: -24, fontFamily: font.ui, fontSize: { xs: 78, md: 116 }, fontWeight: 700, lineHeight: 1, color: color.accent, opacity: 0.035, userSelect: 'none', pointerEvents: 'none' }}>PKCERT</Box>
        <PageHeader
          eyebrow={copy.eyebrow}
          title={copy.title}
          description={copy.description}
          actions={<RoleActionButtons actions={actions} />}
          meta={<RefreshStatus loading={loading} onRefresh={load} generatedAt={overview.generatedAt} role={role} reducedMotion={reducedMotion} />}
          sx={{ mb: 0, position: 'relative' }}
        />
      </Box>

      {error && overview && (
        <Box role="status" sx={{ mb: 2, px: 1.5, py: 1, border: `1px solid ${color.warning}`, borderRadius: `${radius.sm}px`, ...type.small, color: color.warning }}>
          Refresh failed. The last successful timestamped snapshot remains visible.
        </Box>
      )}

      <MetricStrip metrics={metrics} />

      <Box sx={{ mt: 2, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(500px, 1.35fr) minmax(310px, .65fr)' }, gap: 2, alignItems: 'stretch' }}>
        <Box data-primary-panel sx={{ minWidth: 0 }}>
          {isReadable(findingQueues)
            ? <PriorityQueue {...mainQueue} />
            : <Panel title="Priority work"><SectionFallback section={findingQueues} /></Panel>}
        </Box>
        <Box data-primary-panel sx={{ minWidth: 0 }}>
          {isReadable(findings)
            ? <RiskPosture distribution={findings.distributions?.riskBand} unscoredMetric={findings.metrics?.unscored} />
            : <Panel title="Risk posture"><SectionFallback section={findings} /></Panel>}
        </Box>
      </Box>

      <Box data-secondary-section sx={{ mt: 2 }}>
        <ScopeNote>{overview.datasetScope}</ScopeNote>
      </Box>

      <Box sx={{ mt: 2, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1.2fr) minmax(320px, .8fr)' }, gap: 2 }}>
        <Box data-secondary-section data-trend-section sx={{ minWidth: 0 }}>
          {isReadable(sections.ingestionTrend)
            ? <IngestionActivity trend={sections.ingestionTrend} />
            : <Panel title="Seven-day ingestion"><SectionFallback section={sections.ingestionTrend} compact /></Panel>}
        </Box>
        <Box data-secondary-section data-age-section sx={{ minWidth: 0 }}>
          {isReadable(findings)
            ? <AgeingDistribution distribution={findings.distributions?.ageing} />
            : <Panel title="Finding age"><SectionFallback section={findings} compact /></Panel>}
        </Box>
      </Box>

      <Box sx={{ mt: 2, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' }, gap: 2 }}>
        <Box data-secondary-section sx={{ minWidth: 0 }}>
          {isReadable(cases)
            ? <WorkflowPressure cases={cases} notificationQueue={sections.notificationQueue} role={role} />
            : <Panel title="Workflow pressure"><SectionFallback section={cases} compact /></Panel>}
        </Box>
        <Box data-secondary-section sx={{ minWidth: 0 }}>
          {isReadable(sections.recentActivity)
            ? <RecentActivity activity={sections.recentActivity} />
            : <Panel title="Recent case activity"><SectionFallback section={sections.recentActivity} compact /></Panel>}
        </Box>
      </Box>

      <Box data-secondary-section sx={{ mt: 2 }}>
        {isReadable(sections.providers)
          ? <ProviderFreshness providers={sections.providers} showSettings={role === 'ADMIN'} />
          : <Panel title="Stored provider evidence"><SectionFallback section={sections.providers} compact /></Panel>}
      </Box>
    </Box>
  )
}

export default Dashboard
