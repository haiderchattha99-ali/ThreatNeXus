// UX Ticket C — the Provider Intelligence Evidence drawer.
//
// ===========================================================================
// This drawer asks nobody anything
// ===========================================================================
// It renders a row the enrichment summary ALREADY returned and the panel
// already holds in state. Opening, closing and switching between providers
// issues no HTTP request of any kind: no provider is contacted, no run, item,
// job or attempt is created, no quota is reserved and no Finding state moves.
// There is deliberately no fetch, no effect and no service import in this file
// — the absence is the guarantee, and a test asserts it holds.
//
// ---------------------------------------------------------------------------
// What it is honest about
// ---------------------------------------------------------------------------
// ThreatNeXus does not retain raw upstream response bodies — no provider table
// has a raw-response column. So this is titled "Provider Intelligence
// Evidence", the sections say "stored" and "normalized", and nothing here ever
// claims to be a complete API response. Every value comes from
// utils/enrichmentEvidence.js, which reads only stored, allow-listed columns.
//
// ---------------------------------------------------------------------------
// Motion and accessibility
// ---------------------------------------------------------------------------
// MUI's own Drawer transition, at `motion.overlay` with `motion.easeOut` — the
// convention theme/tokens.js established in UX Ticket A, which names
// `motion.overlay` for this exact surface and says to prefer MUI's
// reduced-motion-safe transitions over a new tween. useReducedMotion() drops
// the duration to zero outright. Drawer is a Modal: it traps focus, restores it
// on close, and closes on Escape, so the only extra work here is naming the
// dialog and giving the close control a real button.

import React from 'react'
import { Box, Button, Drawer, IconButton } from '@mui/material'
import { FiX } from 'react-icons/fi'

import { StatusBadge } from './ui/StatusBadge'
import { StaleNotice } from './ui/States'
import { SectionLabel } from './ui/Panel'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { color, font, motion, radius, type } from '../theme/tokens'
import { ENRICHMENT_SUMMARY_STATUS } from '../constants/findingEnrichment'
import { buildProviderEvidenceDetail } from '../utils/enrichmentEvidence'

const TITLE_ID = 'provider-evidence-drawer-title'

// A single stored field. `values` (a complete, uncapped list) and `value` (one
// scalar) are the only two shapes the evidence model produces.
function EvidenceItem({ item }) {
  return (
    <Box
      component="div"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'minmax(140px, 34%) 1fr' },
        gap: { xs: 0.25, sm: 2 },
        py: 0.85,
        borderTop: `1px solid ${color.border}`,
        '&:first-of-type': { borderTop: 'none' },
      }}
    >
      <Box sx={{ ...type.caption, color: color.textMuted }}>{item.label}</Box>
      {item.values ? (
        <Box
          component="ul"
          sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}
        >
          {item.values.map((value) => (
            <Box
              component="li"
              key={value}
              sx={{ ...type.small, color: color.text, fontFamily: font.mono, overflowWrap: 'anywhere' }}
            >
              {value}
            </Box>
          ))}
        </Box>
      ) : (
        <Box sx={{ ...type.small, color: color.text, overflowWrap: 'anywhere' }}>{item.value}</Box>
      )}
    </Box>
  )
}

function EvidenceGroup({ group }) {
  return (
    <Box sx={{ mb: 2.5 }} data-testid={`provider-evidence-group-${group.title}`}>
      <SectionLabel component="h3">{group.title}</SectionLabel>
      {group.note && (
        <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.5 }}>{group.note}</Box>
      )}
      <Box
        sx={{
          mt: 1,
          border: `1px solid ${color.border}`,
          borderRadius: `${radius.md}px`,
          backgroundColor: color.surfaceSunken,
          px: 2,
          py: 0.5,
        }}
      >
        {group.items.map((item) => (
          <EvidenceItem key={item.label} item={item} />
        ))}
      </Box>
    </Box>
  )
}

/**
 * The evidence viewer for ONE (provider, subject) summary row.
 *
 * @param {{row: object|null, open: boolean, onClose: function}} props `row` is
 *   a flattened summary row the panel already fetched — this component never
 *   fetches, refreshes or mutates anything.
 */
export function ProviderEvidenceDrawer({ row, open, onClose }) {
  const reduced = useReducedMotion()
  const detail = row ? buildProviderEvidenceDetail(row) : null

  return (
    <Drawer
      anchor="right"
      open={open && Boolean(detail)}
      onClose={onClose}
      transitionDuration={reduced ? 0 : motion.overlay}
      slotProps={{
        paper: {
          // The paper IS the dialog surface: MUI's Modal traps focus and
          // restores it on close, but does not name the region itself, so the
          // role and the label belong here rather than on the presentational
          // modal root.
          role: 'dialog',
          'aria-labelledby': TITLE_ID,
          'data-testid': 'provider-evidence-drawer',
          sx: {
            width: { xs: '100%', sm: 480, md: 560 },
            maxWidth: '100%',
            backgroundColor: color.surface,
            backgroundImage: 'none',
            borderLeft: `1px solid ${color.border}`,
            // Long evidence scrolls inside the drawer; nothing overflows
            // sideways, because every value wraps rather than widening.
            display: 'flex',
            flexDirection: 'column',
          },
        },
        transition: { easing: motion.easeOut },
      }}
    >
      {detail && (
        <>
          {/* Header — pinned, so the analyst never loses which lookup this is */}
          <Box
            sx={{
              px: 3,
              py: 2,
              borderBottom: `1px solid ${color.border}`,
              backgroundColor: color.surface,
              flexShrink: 0,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ ...type.label, color: color.textFaint }}>
                  Provider intelligence evidence
                </Box>
                <Box
                  component="h2"
                  id={TITLE_ID}
                  sx={{ ...type.sectionTitle, color: color.text, m: 0, mt: 0.5 }}
                >
                  {detail.providerLabel}
                  {detail.purposeLabel ? ` — ${detail.purposeLabel}` : ''}
                </Box>
                {detail.subjectValue && (
                  <Box
                    sx={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, mt: 0.5, overflowWrap: 'anywhere' }}
                  >
                    {detail.subjectValue}
                  </Box>
                )}
                <Box sx={{ mt: 1 }}>
                  <StatusBadge
                    dictionary={ENRICHMENT_SUMMARY_STATUS}
                    value={detail.status}
                    size="small"
                  />
                </Box>
              </Box>
              <IconButton
                onClick={onClose}
                aria-label="Close provider evidence"
                size="small"
                sx={{ color: color.textMuted, flexShrink: 0 }}
              >
                <FiX size={18} />
              </IconButton>
            </Box>
          </Box>

          <Box sx={{ px: 3, py: 2.5, overflowY: 'auto', flex: 1, minWidth: 0 }}>
            {detail.summary && (
              <Box sx={{ mb: 2.5 }}>
                <Box sx={{ ...type.body, color: color.text }} data-testid="provider-evidence-summary">
                  {detail.summary}
                </Box>
                <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.75 }}>
                  Interpretation of the stored result. Provider evidence is context, never proof —
                  it never creates, closes or scores a finding by itself.
                </Box>
              </Box>
            )}

            {detail.isStale && (
              <StaleNotice sx={{ mb: 2.5 }}>
                This evidence is no longer fresh. It is shown as it was recorded, not as current
                truth.
              </StaleNotice>
            )}

            {detail.groups.length > 0 ? (
              <Box sx={{ mb: 1 }} data-testid="provider-evidence-groups">
                <Box sx={{ ...type.caption, color: color.textMuted, mb: 1.5 }}>
                  Every normalized field ThreatNeXus retained from this lookup. ThreatNeXus stores a
                  normalized, allow-listed subset of each provider&apos;s answer. Raw upstream
                  response bodies are never retained.
                </Box>
                {detail.groups.map((group) => (
                  <EvidenceGroup key={group.title} group={group} />
                ))}
              </Box>
            ) : (
              <Box
                sx={{
                  ...type.small,
                  color: color.textMuted,
                  border: `1px solid ${color.border}`,
                  borderRadius: `${radius.md}px`,
                  px: 2,
                  py: 1.75,
                  mb: 2.5,
                }}
                data-testid="provider-evidence-empty"
              >
                No stored provider fields exist for this lookup. The execution record below is what
                ThreatNeXus knows about it.
              </Box>
            )}

            {/* Provenance last: it explains the record, it is not the answer. */}
            <Box data-testid="provider-evidence-provenance">
              <SectionLabel component="h3">Execution record</SectionLabel>
              <Box
                sx={{
                  mt: 1,
                  border: `1px solid ${color.border}`,
                  borderRadius: `${radius.md}px`,
                  backgroundColor: color.surfaceSunken,
                  px: 2,
                  py: 0.5,
                }}
              >
                {detail.provenance.map((item) => (
                  <EvidenceItem key={item.label} item={item} />
                ))}
              </Box>
            </Box>
          </Box>

          <Box sx={{ px: 3, py: 1.75, borderTop: `1px solid ${color.border}`, flexShrink: 0 }}>
            <Button size="small" onClick={onClose}>
              Close
            </Button>
          </Box>
        </>
      )}
    </Drawer>
  )
}

export default ProviderEvidenceDrawer
