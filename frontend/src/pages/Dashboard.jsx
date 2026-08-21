import React from 'react'
import { Box, Skeleton } from '@mui/material'
import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

import { dashboardService } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { ErrorState, PageHeader, Panel, ScopeNote, SectionLabel } from '../components/ui'
import {
  AgeingDistribution,
  IngestionActivity,
  MetricStrip,
  PriorityQueue,
  ProviderFreshness,
  RecentActivity,
  RefreshStatus,
  RiskFactorPressure,
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

// UX Ticket A — the full entrance choreography below (header/KPI/queue
// fade-in, the count-up, the below-the-fold scroll reveals) is a first-look
// flourish, not a re-introduction. An analyst who leaves for a Finding and
// comes straight back to Dashboard should find it calm, not replaying the
// same ~900ms show every single time.
//
// Session-scoped only, and read defensively — the same pattern
// useReducedMotion.js's readOptOut uses: private mode or storage disabled
// fails toward "animate", never toward a thrown error, because this flag only
// ever gates a flourish and must never be able to affect data visibility.
export const DASHBOARD_ENTRANCE_SESSION_KEY = 'tnx.dashboard.entranceShown'

export function hasDashboardEntranceRun() {
  try {
    return window.sessionStorage.getItem(DASHBOARD_ENTRANCE_SESSION_KEY) === 'true'
  } catch {
    return false
  }
}

export function markDashboardEntranceRun() {
  try {
    window.sessionStorage.setItem(DASHBOARD_ENTRANCE_SESSION_KEY, 'true')
  } catch {
    /* storage unavailable — nothing to persist; the tab simply animates on
       every visit, which is the safe direction to fail in. */
  }
}

// Below the first screen this page was eleven panels in a row, all the same
// weight, with no statement of what the run of them was for. A reader who
// scrolled past the queue had no way to tell whether the next panel continued
// the same thought or started a new one, so the whole lower half read as
// "additional charts".
//
// Two named bands, and nothing else: no re-layout, no reordering, no panel
// moved between grids. A hairline and a label are enough to say "this run is
// about WHY the risk looks like this" and "this run is about WORK IN FLIGHT".
function Band({ label, note }) {
  return (
    <Box
      component="header"
      sx={{
        mt: 4,
        mb: 2,
        pt: 2.5,
        borderTop: `1px solid ${color.border}`,
        display: 'flex',
        alignItems: 'baseline',
        gap: 2,
        flexWrap: 'wrap',
      }}
    >
      <SectionLabel component="h2">{label}</SectionLabel>
      {note && <Box sx={{ ...type.caption, color: color.textFaint }}>{note}</Box>}
    </Box>
  )
}

// Shaped like the dashboard it stands in for: command header, the four-cell
// metric strip, then the two first-screen panels. The generic three-bar
// skeleton it replaces was the same on every screen, so the layout arrived by
// popping into place rather than by filling in.
function DashboardSkeleton() {
  return (
    <Box role="status" aria-live="polite" aria-busy="true">
      <Box className="tnx-visually-hidden">Loading your operational workspace…</Box>
      <Box sx={{ borderBottom: `1px solid ${color.border}`, mb: 2.25, pb: 2.5 }}>
        <Skeleton variant="text" width={260} height={16} />
        <Skeleton variant="text" width="38%" height={44} sx={{ mt: 1 }} />
        <Skeleton variant="text" width="60%" height={18} />
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr 1fr', lg: 'repeat(4, minmax(0, 1fr))' },
          border: `1px solid ${color.border}`,
          borderRadius: `${radius.md}px`,
          overflow: 'hidden',
        }}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <Box key={i} sx={{ p: { xs: 1.5, sm: 2 }, borderLeft: { lg: i ? `1px solid ${color.border}` : 0 } }}>
            <Skeleton variant="text" width="55%" height={14} />
            <Skeleton variant="text" width="40%" height={34} sx={{ mt: 0.7 }} />
            <Skeleton variant="text" width="70%" height={12} />
          </Box>
        ))}
      </Box>
      <Box
        sx={{
          mt: 2,
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(500px, 1.35fr) minmax(310px, .65fr)' },
          gap: 2,
        }}
      >
        <Skeleton variant="rectangular" height={330} sx={{ borderRadius: `${radius.md}px` }} />
        <Skeleton variant="rectangular" height={330} sx={{ borderRadius: `${radius.md}px` }} />
      </Box>
    </Box>
  )
}

export const Dashboard = () => {
  const shellRef = React.useRef(null)
  const [overview, setOverview] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const [errorStatus, setErrorStatus] = React.useState(null)
  const { user } = useAuth()
  const reducedMotion = useReducedMotion()

  const load = React.useCallback(() => {
    setLoading(true)
    setError(false)
    setErrorStatus(null)
    dashboardService.getOverview()
      .then((res) => setOverview(res.data?.data || null))
      .catch((err) => {
        setError(true)
        setErrorStatus(err?.response?.status ?? null)
      })
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => { load() }, [load])

  // The authenticated entrance.
  //
  // Budget: the whole first-screen timeline finishes inside ~900ms, measured
  // from when the first real snapshot exists — not from mount. It never gates
  // interaction: nothing is pointer-events:none, nothing is position-shifted
  // beyond a few pixels, and every control is clickable from first paint
  // because the elements start at autoAlpha 0 rather than display:none.
  //
  // Order encodes the hierarchy the dashboard is supposed to teach: command
  // header, then the exact metrics, then the primary queue, then risk posture,
  // then everything else on scroll.
  //
  // Runs at most once per browser session (see hasDashboardEntranceRun
  // above). Skipping it is byte-for-byte the same code path reducedMotion
  // already takes — every element's resting state is its plain, fully
  // visible DOM state with no inline transform/opacity, because nothing here
  // is ever hidden except by a running GSAP tween. A return visit is
  // therefore never at risk of stranding content invisible; it just renders
  // instantly instead of animating in.
  useGSAP(() => {
    if (!overview || reducedMotion || hasDashboardEntranceRun()) return undefined
    markDashboardEntranceRun()

    const timeline = gsap.timeline({ defaults: { ease: 'power3.out' } })
    const addEntrance = (selector, from, to, position) => {
      const targets = Array.from(shellRef.current?.querySelectorAll(selector) || [])
      if (targets.length) timeline.fromTo(targets, from, to, position)
    }
    addEntrance('[data-dashboard-header]', { y: 14, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.34, clearProps: 'transform,opacity,visibility' }, 0)
    addEntrance('[data-kpi]', { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.26, stagger: 0.04, clearProps: 'transform,opacity,visibility' }, 0.16)
    addEntrance('[data-primary-panel]', { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.3, stagger: 0.06, clearProps: 'transform,opacity,visibility' }, 0.3)
    addEntrance('[data-queue-row]', { x: -12, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.24, stagger: 0.03, clearProps: 'transform,opacity,visibility' }, 0.42)

    // Counters climb to the EXACT persisted value and then have that value's
    // own rendered string written back over them. A count-up that stopped at
    // whatever the easing produced would be a fabricated figure, which is the
    // one thing this dashboard exists to not do.
    gsap.utils.toArray('[data-count-to]').forEach((element) => {
      const target = Number(element.getAttribute('data-count-to'))
      if (!Number.isFinite(target)) return
      const exact = target.toLocaleString('en-US')
      // Below this, a count-up is imperceptible flicker rather than motion.
      if (Math.abs(target) < 5) {
        element.textContent = exact
        return
      }
      const counter = { value: 0 }
      timeline.to(
        counter,
        {
          value: target,
          duration: 0.5,
          ease: 'power2.out',
          snap: { value: 1 },
          onUpdate() {
            element.textContent = Math.round(counter.value).toLocaleString('en-US')
          },
          onComplete() {
            element.textContent = exact
          },
        },
        0.22
      )
    })

    const donutSegments = gsap.utils.toArray('[data-donut-segment]')
    if (donutSegments.length) {
      timeline.fromTo(
        donutSegments,
        { strokeDashoffset: 100 },
        {
          // Back to the offset the component computed from real counts. The
          // geometry is never invented by the animation.
          strokeDashoffset: (_index, element) => Number(element.getAttribute('stroke-dashoffset') || 0),
          duration: 0.46,
          stagger: 0.04,
          ease: 'power2.out',
          clearProps: 'strokeDashoffset',
        },
        0.4
      )
    }

    // ---- below the fold ----------------------------------------------------
    //
    // Secondary sections animate TRANSFORM ONLY on scroll. Nothing below is
    // ever set to opacity 0 waiting for a trigger: a ScrollTrigger that never
    // fires (short viewport, zoomed page, trigger already past) would otherwise
    // strand operational evidence invisible, which is a defect this phase's
    // predecessor actually shipped and had to fix.
    gsap.utils.toArray('[data-secondary-section]').forEach((section) => {
      gsap.fromTo(section, { y: 16 }, {
        y: 0,
        duration: 0.4,
        ease: 'power3.out',
        clearProps: 'transform',
        scrollTrigger: { trigger: section, start: 'top 94%', once: true },
      })
    })

    // Chart geometry draws from its own factual values: bars scale from a hairline
    // to the height/width the component already computed from persisted counts.
    const drawBars = (selector, sectionSelector, from, duration, stagger) => {
      const bars = gsap.utils.toArray(selector)
      const section = shellRef.current?.querySelector(sectionSelector)
      if (!bars.length || !section) return
      gsap.fromTo(bars, from, {
        scaleX: 1,
        scaleY: 1,
        duration,
        stagger,
        ease: 'power3.out',
        clearProps: 'transform',
        scrollTrigger: { trigger: section, start: 'top 90%', once: true },
      })
    }

    drawBars('[data-trend-bar]', '[data-trend-section]', { scaleY: 0.04 }, 0.52, 0.025)
    drawBars('[data-age-bar]', '[data-age-section]', { scaleX: 0.03 }, 0.48, 0.07)
    drawBars('[data-factor-bar]', '[data-factor-section]', { scaleX: 0.02 }, 0.5, 0.05)

    // Decorative work must not run for a tab nobody is looking at.
    const onVisibility = () => {
      if (document.hidden) timeline.pause()
      else timeline.resume()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      timeline.revert()
    }
  }, { scope: shellRef, dependencies: [overview?.generatedAt, reducedMotion], revertOnUpdate: true })

  if (loading && !overview) return <DashboardSkeleton />
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
          {errorStatus === 403
            ? 'Access refused. Your role no longer holds the required capability to refresh this data. You remain signed in, and the last successful timestamped snapshot remains visible.'
            : 'Refresh failed. The last successful timestamped snapshot remains visible.'}
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

      <Band
        label="Why the risk looks like this"
        note="Persisted evidence behind the figures above. Nothing here is a projection or a forecast."
      />

      {/* Phase 6.2 — the one new primary visualization. Full width, and placed
          directly after the first viewport rather than inside it: the question
          it answers ("which factors are producing this risk, and which had no
          readable evidence?") is the SECOND question an analyst asks, after
          "what needs me now?" — which the queue and metrics above already
          answer. Putting it higher would push the queue off the first screen. */}
      <Box data-secondary-section data-factor-section>
        {isReadable(sections.riskFactorPressure)
          ? <RiskFactorPressure pressure={sections.riskFactorPressure} />
          : <Panel title="What is driving current risk"><SectionFallback section={sections.riskFactorPressure} /></Panel>}
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

      <Band
        label="Work in flight"
        note="Investigation states, the role-appropriate notification queue, and what the system has already stored from providers."
      />

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' }, gap: 2 }}>
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
