// StatusBadge — the ONE way this application renders a state.
//
// The Phase 6 accessibility rule it exists to enforce: status is never carried
// by colour alone. Every badge renders three redundant signals —
//   shape   : an icon whose glyph differs per state
//   words   : a human label, always visible, never truncated to an icon
//   colour  : the semantic tone
// so the same state survives a monochrome display, a colour-vision deficiency
// and a screen reader (the icon is aria-hidden; the label is the accessible
// name, and `role="status"` is opt-in for states that change in place).
//
// Callers pass a dictionary from tokens.js plus a key, rather than a colour:
//   <StatusBadge dictionary={CASE_STATE} value={caseRow.lifecycleState} />
// An unknown key degrades to a neutral badge showing the RAW value, which is
// deliberately ugly — an unmapped state should be visible, not silently hidden.

import React from 'react'
import { Box } from '@mui/material'
import {
  FiCircle,
  FiCheck,
  FiPlus,
  FiRepeat,
  FiRotateCw,
  FiClock,
  FiCheckSquare,
  FiEdit3,
  FiX,
  FiSend,
  FiHelpCircle,
  FiMinus,
  FiAlertTriangle,
  FiLock,
  FiPower,
} from 'react-icons/fi'
import { TONES, radius, color, riskBandColor, font } from '../../theme/tokens'

const ICONS = {
  dot: FiCircle,
  check: FiCheck,
  plus: FiPlus,
  repeat: FiRepeat,
  rotate: FiRotateCw,
  clock: FiClock,
  gavel: FiCheckSquare,
  edit: FiEdit3,
  cross: FiX,
  send: FiSend,
  question: FiHelpCircle,
  minus: FiMinus,
  warning: FiAlertTriangle,
  lock: FiLock,
  power: FiPower,
}

const FALLBACK = { label: null, tone: 'neutral', icon: 'question' }

export function StatusBadge({
  dictionary,
  value,
  size = 'medium',
  live = false,
  sx = {},
}) {
  if (value === null || value === undefined || value === '') return null

  const entry = (dictionary && dictionary[value]) || FALLBACK
  const toneKey = entry.tone in TONES ? entry.tone : 'neutral'
  const { fg, bg } = TONES[toneKey]
  const Icon = ICONS[entry.icon] || ICONS.question
  // An unmapped state shows its raw enum value rather than pretending to be
  // something recognised.
  const label = entry.label || String(value)
  const small = size === 'small'

  return (
    <Box
      component="span"
      role={live ? 'status' : undefined}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: small ? 0.5 : 0.75,
        maxWidth: '100%',
        px: small ? 0.75 : 1,
        py: small ? '2px' : '3px',
        borderRadius: `${radius.sm}px`,
        border: `1px solid ${fg}55`,
        backgroundColor: bg,
        color: fg,
        fontSize: small ? 11 : 12,
        fontWeight: 600,
        lineHeight: 1.4,
        letterSpacing: '0.01em',
        whiteSpace: 'nowrap',
        ...sx,
      }}
    >
      <Icon size={small ? 10 : 12} aria-hidden="true" style={{ flexShrink: 0 }} />
      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </Box>
    </Box>
  )
}

// A risk band rendered with the locked Risk v1 colours. Separate from
// StatusBadge because a band additionally shows its numeric score, and because
// the band scale must never be restyled by a future palette change.
export function RiskBandBadge({ band, score, size = 'medium' }) {
  if (!band) return null
  const bandColor = riskBandColor[band] || color.neutral
  const small = size === 'small'
  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: small ? 0.75 : 1 }}
    >
      {/* The bar is decorative reinforcement; the word carries the meaning. */}
      <Box
        aria-hidden="true"
        sx={{ width: 3, height: small ? 12 : 14, borderRadius: 1, backgroundColor: bandColor, flexShrink: 0 }}
      />
      <Box
        component="span"
        sx={{
          color: bandColor,
          fontWeight: 600,
          fontSize: small ? 11 : 12,
          letterSpacing: '0.03em',
        }}
      >
        {band}
      </Box>
      {score !== null && score !== undefined && (
        <Box
          component="span"
          sx={{ fontFamily: font.mono, fontSize: small ? 11 : 12, color: color.textMuted }}
        >
          {score}
        </Box>
      )}
    </Box>
  )
}

export default StatusBadge
