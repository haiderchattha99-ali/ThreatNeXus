// Metric — the Phase 6 dashboard integrity contract, expressed as a component.
//
// The rule this file exists to make unbreakable: a ThreatNeXus metric is not a
// number. It is the tuple
//
//     { value, availability, source, asOf }
//
// and the UI must render all four. In particular an UNAVAILABLE or RESTRICTED
// metric renders an em dash and a reason — NEVER a zero. A zero is a factual
// claim ("we counted and found none"); showing one because a query failed or
// because the caller may not read that domain is a fabricated claim, which is
// exactly the defect Phase 6 was opened to remove from the previous dashboard.
//
// `MetricValue` is the low-level renderer; `MetricTile` is the dashboard card.
// Both take the SAME shape the backend returns, so there is no place for a page
// to quietly coerce null into 0 on the way through.

import React from 'react'
import { Box, Tooltip } from '@mui/material'
import { FiAlertTriangle, FiLock, FiClock, FiMinus, FiPower } from 'react-icons/fi'
import { color, type, radius, font } from '../../theme/tokens'
import { AVAILABILITY } from '../../theme/tokens'
import { Panel, SectionLabel } from './Panel'

const REASON_ICON = {
  UNAVAILABLE: FiAlertTriangle,
  RESTRICTED: FiLock,
  STALE: FiClock,
  DISABLED: FiPower,
  NOT_CONFIGURED: FiMinus,
}

export function formatMetricNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value.toLocaleString('en-US')
}

// Renders the value of one metric according to its availability.
export function MetricValue({ metric, size = 'large' }) {
  const availability = metric?.availability || 'UNAVAILABLE'
  const spec = AVAILABILITY[availability] || AVAILABILITY.UNAVAILABLE
  const typeStyle = size === 'large' ? type.metric : type.metricSm

  if (!spec.showsValue) {
    const Icon = REASON_ICON[availability] || FiAlertTriangle
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 34 }}>
        <Box
          component="span"
          aria-hidden="true"
          // This em dash IS the value — it is what stands in place of a figure
          // the caller may not read or the server could not compute. Supporting
          // copy may be faint; a value never is.
          sx={{ ...typeStyle, color: color.textMuted, lineHeight: 1 }}
        >
          —
        </Box>
        <Box
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            color: color.textMuted,
            fontSize: 12,
          }}
        >
          <Icon size={12} aria-hidden="true" />
          <span>{spec.label}</span>
        </Box>
      </Box>
    )
  }

  const rendered = formatMetricNumber(metric?.value)

  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.25, flexWrap: 'wrap' }}>
      <Box
        component="span"
        // Phase 6.2 — the count-up hook. Present ONLY when this metric really is
        // a finite number that was actually counted, so the em dash standing in
        // for a restricted or unavailable figure can never be animated as if it
        // were a zero climbing to something. The animation's final act is to
        // write this exact rendered string back, so a count-up can never leave a
        // figure that disagrees with the backend value.
        data-count-to={rendered === null ? undefined : metric.value}
        sx={{ ...typeStyle, color: color.text }}
      >
        {rendered === null ? '—' : rendered}
      </Box>
      {availability === 'STALE' && (
        <Box
          sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: color.warning, fontSize: 12 }}
        >
          <FiClock size={12} aria-hidden="true" />
          <span>Stale</span>
        </Box>
      )}
    </Box>
  )
}

// The provenance line. Deliberately always rendered — a metric with no source
// is a metric nobody can defend, and hiding the line would let one slip in.
export function Provenance({ source, asOf, note, sx = {} }) {
  const stamp = formatAsOf(asOf)
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 0.5,
        alignItems: 'baseline',
        fontFamily: font.mono,
        fontSize: 11,
        lineHeight: 1.5,
        color: color.textFaint,
        minWidth: 0,
        overflowWrap: 'anywhere',
        ...sx,
      }}
    >
      <Box component="span">{source || 'source not recorded'}</Box>
      {stamp && (
        <>
          <Box component="span" aria-hidden="true">
            ·
          </Box>
          <Box component="span">
            as of <time dateTime={asOf}>{stamp}</time>
          </Box>
        </>
      )}
      {note && (
        <>
          <Box component="span" aria-hidden="true">
            ·
          </Box>
          <Box component="span">{note}</Box>
        </>
      )}
    </Box>
  )
}

export function formatAsOf(asOf) {
  if (!asOf) return null
  const d = new Date(asOf)
  if (Number.isNaN(d.getTime())) return null
  // UTC, explicitly labelled. A dashboard that renders an incident timestamp in
  // whatever zone the analyst's laptop happens to hold is a dashboard two
  // analysts will read differently.
  return `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`
}

// A dashboard metric card.
export function MetricTile({ label, metric, description, sx = {} }) {
  const availability = metric?.availability || 'UNAVAILABLE'
  const spec = AVAILABILITY[availability] || AVAILABILITY.UNAVAILABLE

  const tile = (
    <Panel
      padded
      sx={{ height: '100%', ...sx }}
      contentSx={{ display: 'flex', flexDirection: 'column', gap: 1.1 }}
    >
      <SectionLabel component="h3">{label}</SectionLabel>
      <MetricValue metric={metric} />
      {description && (
        <Box sx={{ ...type.caption, color: color.textMuted }}>{description}</Box>
      )}
      <Provenance source={metric?.source} asOf={metric?.asOf} sx={{ mt: 'auto', pt: 0.5 }} />
    </Panel>
  )

  // The reason a figure is missing belongs in the accessible layer too, not
  // only in a hover tooltip — hover-only information is unreachable by keyboard
  // and touch.
  if (!spec.showsValue && metric?.reason) {
    return (
      <Tooltip title={metric.reason} enterTouchDelay={0}>
        <Box sx={{ height: '100%' }} aria-description={metric.reason}>
          {tile}
        </Box>
      </Tooltip>
    )
  }
  return tile
}

// A horizontal distribution bar list (used for the Risk v1 band distribution
// and report-type breakdown). Honest scale: bars are proportional to the LARGEST
// bucket, and the raw count is always printed, so a long bar can never imply a
// percentage that was never computed.
export function DistributionBars({ items, colorFor, emptyLabel = 'No records yet' }) {
  const max = items.reduce((m, i) => Math.max(m, i.count || 0), 0)

  // Only a genuinely EMPTY distribution gets the empty label. A distribution
  // whose buckets are all zero is still rendered, one row per bucket, showing
  // 0 — because the backend deliberately returns every bucket as an explicit
  // counted zero, and collapsing that into "No records yet" would throw away
  // the distinction it went to the trouble of preserving. A missing bar and a
  // zero bar do not mean the same thing.
  if (!items.length) {
    return (
      <Box sx={{ ...type.small, color: color.textMuted, py: 1 }}>{emptyLabel}</Box>
    )
  }

  return (
    <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, display: 'flex', flexDirection: 'column', gap: 1.4 }}>
      {items.map((item) => (
        <Box component="li" key={item.key} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box sx={{ width: 128, flexShrink: 0, fontSize: 12, color: color.textMuted, letterSpacing: '0.03em' }}>
            {item.label}
          </Box>
          <Box
            sx={{
              flex: 1,
              minWidth: 40,
              height: 8,
              backgroundColor: color.surfaceSunken,
              borderRadius: `${radius.sm}px`,
              overflow: 'hidden',
            }}
            aria-hidden="true"
          >
            <Box
              sx={{
                width: `${max ? (item.count / max) * 100 : 0}%`,
                height: '100%',
                backgroundColor: colorFor ? colorFor(item.key) : color.accent,
                opacity: 0.9,
              }}
            />
          </Box>
          <Box
            sx={{ width: 44, textAlign: 'right', fontFamily: font.mono, fontSize: 13, color: color.text }}
          >
            {formatMetricNumber(item.count) ?? '—'}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

export default MetricTile
