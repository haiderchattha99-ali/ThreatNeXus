// Disclosure — the shared progressive-disclosure primitive for detail pages.
//
// Extracted for UX Ticket B from the native <details> pattern FindingDetail.jsx
// established first (see that file's own comment for the full rationale). Two
// more detail pages (Case, Notification) now need the identical treatment, so
// this is the "TINY shared helper" the ticket brief explicitly allows rather
// than a third hand-copied implementation.
//
// Deliberately NOT animated with GSAP. Native <details> is progressive
// disclosure with no JavaScript, no focus trap and no chance of stranding
// content: children are mounted and fetched either way, so collapsing changes
// what is SHOWN, never what is known — and the browser's own open/close
// behaviour is already reduced-motion-safe by construction, which is what
// tokens.js's motion convention exists to guarantee in the first place. A
// GSAP height tween here would be a new decorative surface for no behavioural
// gain, which the ticket brief rules out directly ("No decorative
// animations").

import React from 'react'
import { Box } from '@mui/material'
import { color, radius, type } from '../../theme/tokens'

export function Disclosure({ summary, hint, defaultOpen = false, children, sx = {}, ...rest }) {
  return (
    <Box
      component="details"
      open={defaultOpen || undefined}
      sx={{
        // See FindingDetail.jsx's own Disclosure comment: a grid/flex item's
        // default min-width:auto refuses to shrink below its content's
        // min-content width, which pushes the whole document sideways instead
        // of letting a wide evidence table scroll in its own container.
        minWidth: 0,
        border: `1px solid ${color.border}`,
        borderRadius: `${radius.md}px`,
        backgroundColor: color.surfaceSunken,
        px: 2,
        py: 1.5,
        '& > summary': {
          cursor: 'pointer',
          listStyle: 'none',
          display: 'flex',
          alignItems: 'baseline',
          gap: 1,
          flexWrap: 'wrap',
          color: color.link,
          ...type.bodyStrong,
          '&::-webkit-details-marker': { display: 'none' },
          '&:hover': { color: color.linkHover },
          '&:focus-visible': { outline: `2px solid ${color.borderFocus}`, outlineOffset: 3 },
        },
        '&[open] > summary': { mb: 1.5 },
        ...sx,
      }}
      {...rest}
    >
      <Box component="summary">{summary}</Box>
      {hint && <Box sx={{ ...type.caption, color: color.textMuted, mb: 1.5 }}>{hint}</Box>}
      {children}
    </Box>
  )
}

export default Disclosure
