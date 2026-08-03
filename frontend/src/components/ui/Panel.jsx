// Panel — the document-like surface the whole application is built from.
//
// One component instead of the per-page `<Card className="surface" sx={{...}}>`
// that Phases 0-5 repeated in every file. A Panel owns its own heading level,
// which matters more than it looks: a screen reader user navigates this product
// by heading, and a page of visually-identical cards with no headings is a flat
// wall to them.

import React from 'react'
import { Box, Paper } from '@mui/material'
import { color, radius, shadow, type, space } from '../../theme/tokens'

// The uppercase micro-label used for section eyebrows and field names.
export function SectionLabel({ children, component = 'div', sx = {}, ...rest }) {
  return (
    <Box component={component} sx={{ ...type.label, color: color.textFaint, ...sx }} {...rest}>
      {children}
    </Box>
  )
}

export function Panel({
  title,
  // Explicit, because a panel's correct heading level depends on where it sits
  // in the page outline — not on how it looks.
  titleLevel = 'h2',
  description,
  actions,
  footer,
  padded = true,
  children,
  sx = {},
  contentSx = {},
  ...rest
}) {
  const headingId = React.useId()
  const hasHeader = Boolean(title || actions || description)

  return (
    <Paper
      component="section"
      aria-labelledby={title ? headingId : undefined}
      sx={{
        backgroundColor: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: `${radius.md}px`,
        boxShadow: shadow.panel,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        ...sx,
      }}
      {...rest}
    >
      {hasHeader && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: space.md,
            flexWrap: 'wrap',
            px: 3,
            pt: 2.5,
            pb: description ? 1.5 : 2,
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            {title && (
              <Box
                component={titleLevel}
                id={headingId}
                sx={{ ...type.sectionTitle, color: color.text, m: 0 }}
              >
                {title}
              </Box>
            )}
            {description && (
              <Box sx={{ ...type.small, color: color.textMuted, mt: 0.75, maxWidth: '72ch' }}>
                {description}
              </Box>
            )}
          </Box>
          {actions && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>{actions}</Box>
          )}
        </Box>
      )}

      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          px: padded ? 3 : 0,
          pt: hasHeader ? 0 : padded ? 2.5 : 0,
          pb: padded ? 3 : 0,
          ...contentSx,
        }}
      >
        {children}
      </Box>

      {footer && (
        <Box
          sx={{
            borderTop: `1px solid ${color.border}`,
            px: 3,
            py: 1.75,
            backgroundColor: color.surfaceSunken,
            borderBottomLeftRadius: `${radius.md}px`,
            borderBottomRightRadius: `${radius.md}px`,
          }}
        >
          {footer}
        </Box>
      )}
    </Paper>
  )
}

// A labelled field for detail views. Used everywhere a key/value pair is shown,
// so the label/value relationship is a real one (<dt>/<dd>) rather than two
// visually adjacent divs.
export function Field({ label, children, mono = false, sx = {} }) {
  return (
    <Box sx={{ minWidth: 0, ...sx }}>
      <SectionLabel component="dt">{label}</SectionLabel>
      <Box
        component="dd"
        sx={{
          m: 0,
          mt: 0.6,
          ...type.body,
          color: color.text,
          fontFamily: mono ? 'IBM Plex Mono, ui-monospace, monospace' : undefined,
          wordBreak: 'break-word',
        }}
      >
        {children === null || children === undefined || children === '' ? (
          <Box component="span" sx={{ color: color.textFaint }} aria-label="Not recorded">
            —
          </Box>
        ) : (
          children
        )}
      </Box>
    </Box>
  )
}

// Groups Fields into a responsive definition list.
export function FieldGrid({ columns = { xs: '1fr', sm: '1fr 1fr', lg: 'repeat(3, 1fr)' }, gap = 2.5, children, sx = {} }) {
  return (
    <Box
      component="dl"
      sx={{ display: 'grid', gridTemplateColumns: columns, gap, m: 0, ...sx }}
    >
      {children}
    </Box>
  )
}

export default Panel
