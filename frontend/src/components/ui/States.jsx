// The non-happy paths, as first-class components.
//
// Phase 6 requires every screen to handle loading, empty, error, permission
// denied, provider-unavailable/stale and validation states. Before this file
// each page improvised them (usually a bare <CircularProgress /> and a toast),
// which meant a failed request was announced to sighted users only and an
// empty table was indistinguishable from a broken one.
//
// Every state here:
//   - announces itself to assistive technology (role="status" / role="alert")
//   - explains what happened in words, not just an icon
//   - offers the next action where one exists

import React from 'react'
import { Box, Button, Skeleton, Table, TableBody, TableCell, TableRow } from '@mui/material'
import {
  FiAlertTriangle,
  FiInbox,
  FiLock,
  FiRefreshCw,
  FiSlash,
  FiClock,
  FiWifiOff,
} from 'react-icons/fi'
import { color, type, radius } from '../../theme/tokens'

function Shell({ icon: Icon, tone, title, children, action, role = 'status', dense = false }) {
  return (
    <Box
      role={role}
      // Polite for status, assertive is implied by role="alert".
      aria-live={role === 'status' ? 'polite' : undefined}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 1.25,
        px: 3,
        py: dense ? 4 : 7,
      }}
    >
      <Box
        aria-hidden="true"
        sx={{
          width: 40,
          height: 40,
          display: 'grid',
          placeItems: 'center',
          borderRadius: `${radius.md}px`,
          border: `1px solid ${tone}44`,
          color: tone,
          backgroundColor: `${tone}12`,
        }}
      >
        <Icon size={18} />
      </Box>
      <Box sx={{ ...type.bodyStrong, color: color.text }}>{title}</Box>
      {children && (
        <Box sx={{ ...type.small, color: color.textMuted, maxWidth: '52ch' }}>{children}</Box>
      )}
      {action && <Box sx={{ mt: 1 }}>{action}</Box>}
    </Box>
  )
}

export function LoadingState({ label = 'Loading', description, dense = false }) {
  return (
    <Box
      role="status"
      aria-live="polite"
      aria-busy="true"
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, px: 3, py: dense ? 3 : 5 }}
    >
      {/* The visible skeleton is decorative; this sentence is what a screen
          reader actually announces. */}
      <Box sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        {label}…
      </Box>
      <Skeleton variant="text" width="38%" height={22} />
      <Skeleton variant="rectangular" height={dense ? 60 : 96} sx={{ borderRadius: `${radius.sm}px` }} />
      <Skeleton variant="text" width="62%" height={18} />
      {description && (
        <Box sx={{ ...type.caption, color: color.textFaint, mt: 0.5 }}>{description}</Box>
      )}
    </Box>
  )
}

// A skeleton shaped like the table it replaces, so the page does not jump when
// real rows arrive. Layout stability is an accessibility concern, not a polish
// one — content that moves under a pointer is content that gets misclicked.
export function TableLoadingState({ columns = 5, rows = 5, label = 'Loading records' }) {
  return (
    <Table aria-busy="true" aria-live="polite" aria-label={label}>
      <TableBody>
        {Array.from({ length: rows }).map((_, r) => (
          <TableRow key={r}>
            {Array.from({ length: columns }).map((__, c) => (
              <TableCell key={c}>
                <Skeleton variant="text" width={c === 0 ? '70%' : '45%'} height={18} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function EmptyState({ title = 'Nothing here yet', children, action, dense }) {
  return (
    <Shell icon={FiInbox} tone={color.neutral} title={title} action={action} dense={dense}>
      {children}
    </Shell>
  )
}

export function ErrorState({
  title = 'Could not load this view',
  children,
  onRetry,
  retryLabel = 'Try again',
  dense,
}) {
  return (
    <Shell
      icon={FiAlertTriangle}
      tone={color.danger}
      title={title}
      role="alert"
      dense={dense}
      action={
        onRetry ? (
          <Button size="small" variant="outlined" startIcon={<FiRefreshCw />} onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : null
      }
    >
      {children ||
        'The request did not complete. No partial data is shown, because a partly-loaded view of security evidence is worse than none.'}
    </Shell>
  )
}

// Permission denied. Deliberately explicit that the backend is the authority —
// hiding the control would be a lie about why it is not there, and the backend
// refuses the request either way.
export function DeniedState({ capability, children, dense }) {
  return (
    <Shell icon={FiLock} tone={color.neutral} title="You do not have access to this view" dense={dense}>
      {children || (
        <>
          Your role does not hold the capability required for this screen
          {capability ? (
            <>
              {' '}
              (<code>{capability}</code>)
            </>
          ) : null}
          . Access is enforced by the server, not by this page.
        </>
      )}
    </Shell>
  )
}

// A provider or optional subsystem is off/unreachable. Distinct from an error:
// nothing is broken and the analyst does not need to retry.
export function UnavailableState({ title = 'Not available', children, dense }) {
  return (
    <Shell icon={FiWifiOff} tone={color.warning} title={title} dense={dense}>
      {children}
    </Shell>
  )
}

export function DisabledState({ title = 'Disabled', children, dense }) {
  return (
    <Shell icon={FiSlash} tone={color.neutral} title={title} dense={dense}>
      {children}
    </Shell>
  )
}

// An inline banner for a value that is present but past its freshness window.
// Shown WITH the data, never instead of it.
export function StaleNotice({ children, sx = {} }) {
  return (
    <Box
      role="status"
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        px: 1.5,
        py: 1,
        borderRadius: `${radius.sm}px`,
        border: `1px solid ${color.warning}44`,
        backgroundColor: color.warningQuiet,
        color: color.text,
        ...type.caption,
        ...sx,
      }}
    >
      <FiClock size={13} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0, color: color.warning }} />
      <Box>{children}</Box>
    </Box>
  )
}

// A short, always-visible caption used under charts and tiles.
export function ScopeNote({ children, sx = {} }) {
  return (
    <Box sx={{ ...type.caption, color: color.textFaint, ...sx }}>
      {children || 'Loaded dataset only — not a national or Internet-wide measurement.'}
    </Box>
  )
}

export default {
  LoadingState,
  TableLoadingState,
  EmptyState,
  ErrorState,
  DeniedState,
  UnavailableState,
  DisabledState,
  StaleNotice,
  ScopeNote,
}
