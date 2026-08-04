// Timeline — the shape almost every defensible record in this system takes.
//
// Case lifecycle, notification revisions and review decisions, export history,
// delivery observations, framework mapping history, ownership history: all of
// them are append-only sequences whose whole value is that they can be read in
// order. This renders one as an ordered list so it is an ordered list to
// assistive technology too, not a stack of divs.

import React from 'react'
import { Box } from '@mui/material'
import { color, type, font } from '../../theme/tokens'
import { formatAsOf } from './Metric'

export function Timeline({ items = [], emptyLabel = 'No recorded events yet.', dense = false }) {
  if (!items.length) {
    return <Box sx={{ ...type.small, color: color.textMuted }}>{emptyLabel}</Box>
  }

  return (
    <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
      {items.map((item, i) => {
        const last = i === items.length - 1
        const tone = item.tone || color.borderStrong
        return (
          <Box
            component="li"
            key={item.id ?? `${item.title}-${i}`}
            sx={{ display: 'flex', gap: 2, pb: last ? 0 : dense ? 2 : 2.75 }}
          >
            {/* Rail */}
            <Box
              aria-hidden="true"
              sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, width: 10 }}
            >
              <Box
                sx={{
                  width: 9,
                  height: 9,
                  mt: '6px',
                  borderRadius: '50%',
                  border: `1.5px solid ${tone}`,
                  backgroundColor: item.filled === false ? 'transparent' : tone,
                  flexShrink: 0,
                }}
              />
              {!last && <Box sx={{ flex: 1, width: '1px', backgroundColor: color.border, mt: 0.75 }} />}
            </Box>

            {/* Body */}
            <Box sx={{ minWidth: 0, flex: 1, pb: last ? 0 : 0 }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 1.25,
                  flexWrap: 'wrap',
                  rowGap: 0.5,
                }}
              >
                <Box sx={{ ...type.bodyStrong, color: color.text }}>{item.title}</Box>
                {item.badge}
                {item.at && (
                  <Box
                    component="time"
                    dateTime={item.at}
                    // 11px operational timestamp — muted, never faint.
                    sx={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}
                  >
                    {formatAsOf(item.at)}
                  </Box>
                )}
              </Box>
              {item.detail && (
                <Box sx={{ ...type.small, color: color.textMuted, mt: 0.5, wordBreak: 'break-word' }}>
                  {item.detail}
                </Box>
              )}
              {item.actor && (
                <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.5 }}>{item.actor}</Box>
              )}
              {item.children && <Box sx={{ mt: 1 }}>{item.children}</Box>}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

export default Timeline
