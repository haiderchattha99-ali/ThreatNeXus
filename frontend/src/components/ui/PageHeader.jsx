// PageHeader — every screen's first block, and the page's only <h1>.
//
// It also owns the breadcrumb trail, so "where am I and how do I get back" is
// answered identically on every route instead of being reinvented per page.

import React from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Box, Breadcrumbs, Link } from '@mui/material'
import { FiChevronRight } from 'react-icons/fi'
import { color, type, space } from '../../theme/tokens'

export function PageHeader({
  eyebrow,
  title,
  description,
  breadcrumbs = [],
  actions,
  meta,
  sx = {},
}) {
  return (
    <Box component="header" sx={{ mb: 4, ...sx }}>
      {breadcrumbs.length > 0 && (
        <Breadcrumbs
          aria-label="Breadcrumb"
          separator={<FiChevronRight size={12} aria-hidden="true" />}
          sx={{ mb: 1.5 }}
        >
          {breadcrumbs.map((crumb, i) => {
            const last = i === breadcrumbs.length - 1
            if (last || !crumb.to) {
              return (
                <Box
                  key={crumb.label}
                  component="span"
                  // The trailing crumb is the current page; marking it removes
                  // the "is this a link?" ambiguity for screen-reader users.
                  aria-current={last ? 'page' : undefined}
                  sx={{ color: last ? color.textMuted : color.textFaint, fontSize: 13 }}
                >
                  {crumb.label}
                </Box>
              )
            }
            return (
              <Link key={crumb.label} component={RouterLink} to={crumb.to} sx={{ fontSize: 13 }}>
                {crumb.label}
              </Link>
            )
          })}
        </Breadcrumbs>
      )}

      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: space.lg,
          flexWrap: 'wrap',
        }}
      >
        <Box sx={{ minWidth: 0, flex: '1 1 380px' }}>
          {eyebrow && (
            <Box sx={{ ...type.label, color: color.accent, mb: 1 }}>{eyebrow}</Box>
          )}
          <Box component="h1" sx={{ ...type.displayLg, color: color.text, m: 0 }}>
            {title}
          </Box>
          {description && (
            <Box sx={{ ...type.body, color: color.textMuted, mt: 1.25, maxWidth: '72ch' }}>
              {description}
            </Box>
          )}
          {meta && <Box sx={{ mt: 1.75 }}>{meta}</Box>}
        </Box>

        {actions && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              flexWrap: 'wrap',
              flexShrink: 0,
              pt: { xs: 0, md: 0.5 },
            }}
          >
            {actions}
          </Box>
        )}
      </Box>
    </Box>
  )
}

export default PageHeader
