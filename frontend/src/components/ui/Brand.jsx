// Brand identity and the PKCERT attribution slot.
//
// Two separate things live here, deliberately:
//
//   BrandMark          — the ThreatNeXus mark. Drawn in SVG so it is crisp at
//                        every size, themeable, and needs no network request.
//
//   PkcertAttribution  — the authorized PKCERT asset and the positioning line.
//                        This is a SLOT, not a hardcoded image: the variants
//                        below are the only places the logo may appear, and the
//                        `watermark` variant is intentionally text-only. See
//                        assets/branding/README.md for the authorization
//                        record and for why no transparent derivative exists.
//
// The rule this component encodes: showing the logo records an internship
// context. It never asserts endorsement, certification or deployment, so the
// positioning line travels with the mark rather than being optional.

import React from 'react'
import { Box } from '@mui/material'
import { color, type, radius, font } from '../../theme/tokens'
import pkcertLogo from '../../assets/branding/pkcert-logo-original.png'

export const PKCERT_POSITIONING =
  'Developed during an internship with PKCERT/NCERT as a defensive cybersecurity research and prototype platform.'

export const PKCERT_SHORT = 'Developed during an internship with PKCERT/NCERT'

// The ThreatNeXus mark: a shield outline crossed by a link/nexus motif. Kept
// geometric and quiet — this is a defensive tool, not a game.
export function BrandMark({ size = 28, showWordmark = false, title = 'ThreatNeXus' }) {
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1.25, minWidth: 0 }}>
      <Box
        component="svg"
        viewBox="0 0 32 32"
        role="img"
        aria-label={showWordmark ? undefined : title}
        aria-hidden={showWordmark ? 'true' : undefined}
        sx={{ width: size, height: size, flexShrink: 0, display: 'block' }}
      >
        <path
          d="M16 2.6 27.2 6.4v9.1c0 6.6-4.5 12.2-11.2 14.1C9.3 27.7 4.8 22.1 4.8 15.5V6.4Z"
          fill="none"
          stroke={color.accent}
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path
          d="M10.4 17.2 16 12.1l5.6 5.1"
          fill="none"
          stroke={color.link}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="16" cy="12.1" r="2.1" fill={color.accent} />
        <circle cx="10.4" cy="17.2" r="1.5" fill={color.link} />
        <circle cx="21.6" cy="17.2" r="1.5" fill={color.link} />
        <path d="M16 14.2v6.6" stroke={color.link} strokeWidth="1.6" strokeLinecap="round" />
      </Box>
      {showWordmark && (
        <Box sx={{ minWidth: 0 }}>
          <Box
            sx={{
              fontSize: size > 30 ? 18 : 15,
              fontWeight: 600,
              letterSpacing: '-0.01em',
              color: color.text,
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
            }}
          >
            ThreatNeXus
          </Box>
        </Box>
      )}
    </Box>
  )
}

/**
 * The PKCERT attribution slot.
 *
 * variant:
 *   'card'      full white logo container + positioning sentence (login, About)
 *   'compact'   small white logo container + short line (dense surfaces)
 *   'watermark' TEXT ONLY. The supplied asset has an opaque white field, so
 *               using it as a low-opacity background would show a visible white
 *               rectangle. No transparent derivative was produced, because one
 *               cannot be made from this file without altering the emblem's
 *               white interior detail and its anti-aliased edges. If an
 *               authorized transparent asset is added later, render it here at
 *               3-5% opacity — the branch is kept for exactly that.
 */
export function PkcertAttribution({ variant = 'card', sx = {} }) {
  if (variant === 'watermark') {
    return (
      <Box
        aria-hidden="true"
        sx={{
          ...type.caption,
          color: color.textFaint,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontFamily: font.mono,
          fontSize: 10,
          ...sx,
        }}
      >
        {PKCERT_SHORT}
      </Box>
    )
  }

  const compact = variant === 'compact'

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 1.5 : 2,
        ...sx,
      }}
    >
      {/* A deliberate white container. The asset's own background is white, so
          it is given an honest white card rather than being faked transparent
          against the dark canvas. Aspect ratio is preserved by width/height
          being equal and object-fit: contain. */}
      <Box
        sx={{
          flexShrink: 0,
          width: compact ? 44 : 60,
          height: compact ? 44 : 60,
          backgroundColor: '#FFFFFF',
          borderRadius: `${radius.sm}px`,
          border: `1px solid ${color.borderStrong}`,
          display: 'grid',
          placeItems: 'center',
          overflow: 'hidden',
        }}
      >
        <Box
          component="img"
          src={pkcertLogo}
          alt="PKCERT — Pakistan Computer Emergency Response Team"
          sx={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ ...(compact ? type.caption : type.small), color: color.textMuted }}>
          {compact ? PKCERT_SHORT : PKCERT_POSITIONING}
        </Box>
        {!compact && (
          <Box sx={{ ...type.caption, color: color.textFaint, mt: 0.75 }}>
            Not an official PKCERT/NCERT production platform, and not certified,
            endorsed or deployment-approved by them.
          </Box>
        )}
      </Box>
    </Box>
  )
}

export default BrandMark
