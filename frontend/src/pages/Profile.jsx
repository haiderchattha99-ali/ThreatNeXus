// Profile — Phase 6.2 truth cleanup.
//
// WHAT THIS PAGE USED TO CLAIM
// ----------------------------
//   - "Backend Connected", "Session Active", "Active Session" status chips that
//     were static JSX. None was wired to a connection, a session record or a
//     heartbeat; they rendered green whether or not anything was reachable.
//   - "Department: Threat Intelligence" — a hardcoded string. The User model
//     has no department column.
//   - A "Security Information" grid marking "JWT Authentication", "Backend
//     Connected", "Role Based Access" and "Encrypted Session" as "Enabled".
//     Two of those are real architectural facts, one was a duplicate of the
//     fake connection chip, and "Encrypted Session" asserted transport
//     security this page cannot observe.
//   - "Analyst Statistics": Threats Reviewed / Cases Assigned / Reports
//     Uploaded / Notifications, all four hardcoded to the string "0". They were
//     not queried, and a real zero and a literal zero are not the same claim.
//
// The sibling Settings card additionally showed `new Date().toLocaleString()`
// as "Last Login" and offered editable name/email fields that wrote to
// localStorage and reported "Profile saved successfully." No server account was
// ever modified. Both are gone.
//
// WHAT IT SHOWS NOW
// -----------------
// Only what the server actually returned for this token from GET /api/profile,
// plus the capability list that response carried. There is no editable field,
// because this application exposes no authenticated account-update route — and
// an input that silently edits nothing is worse than no input.
//
// "Last login" is absent, and stays absent, because the User model persists no
// login timestamp. Rendering the current clock in its place — which is what the
// previous version did — states a fact the database does not hold.

import React from 'react'
import { Box, Button } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import { FiSettings } from 'react-icons/fi'

import { useAuth } from '../hooks/useAuth'
import {
  PageHeader,
  Panel,
  Field,
  FieldGrid,
  SectionLabel,
  ScopeNote,
  EmptyState,
} from '../components/ui'
import { color, type, radius, font } from '../theme/tokens'

export const Profile = () => {
  const { user, capabilities } = useAuth()

  if (!user) {
    return (
      <>
        <PageHeader eyebrow="Workspace / account" title="Account" />
        <Panel>
          <EmptyState title="No account is loaded">
            This browser is not holding a validated session. Sign in again to
            view your account.
          </EmptyState>
        </Panel>
      </>
    )
  }

  return (
    <>
      <PageHeader
        eyebrow="Workspace / account"
        title="Account"
        description="The identity and role the server resolved for this session."
        breadcrumbs={[{ label: 'ThreatNeXus', to: '/dashboard' }, { label: 'Account' }]}
        actions={
          <Button component={RouterLink} to="/settings" size="small" variant="outlined" startIcon={<FiSettings />}>
            Settings
          </Button>
        }
      />

      <Panel
        title="Account"
        description="Returned by GET /api/profile for the token this browser is holding."
        sx={{ mb: 2 }}
      >
        <FieldGrid>
          <Field label="Name">{user.name}</Field>
          <Field label="Email" mono>{user.email}</Field>
          <Field label="Role">{user.role}</Field>
          <Field label="Account identifier" mono>{user.id}</Field>
        </FieldGrid>

        <Box
          sx={{
            mt: 2.5,
            p: 1.5,
            backgroundColor: color.surfaceSunken,
            borderRadius: `${radius.sm}px`,
            ...type.caption,
            color: color.textMuted,
            maxWidth: '78ch',
          }}
        >
          These details are not editable here. Local accounts are created and
          changed by an administrator directly against the database — this
          application exposes no authenticated account-update route, so a form
          on this page would save nothing.
        </Box>
      </Panel>

      <Panel
        title="What this role may do"
        description="The capability list the server returned with your session. Every route re-checks these server-side on each request."
        sx={{ mb: 2 }}
      >
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          {(capabilities || []).length ? (
            capabilities.map((capability) => (
              <Box
                key={capability}
                sx={{
                  ...type.caption,
                  fontFamily: font.mono,
                  color: color.text,
                  border: `1px solid ${color.border}`,
                  borderRadius: `${radius.sm}px`,
                  px: 0.9,
                  py: 0.35,
                }}
              >
                {capability}
              </Box>
            ))
          ) : (
            <Box sx={{ ...type.small, color: color.textMuted }}>
              No capabilities were returned for this session.
            </Box>
          )}
        </Box>
      </Panel>

      <Panel title="Not recorded for this account">
        <Box component="ul" sx={{ ...type.small, color: color.textMuted, pl: 2.5, m: 0, maxWidth: '78ch' }}>
          <li>
            <strong style={{ color: color.text }}>Last sign-in time.</strong> No
            login timestamp is persisted on the account, so none is shown. The
            previous version of this screen displayed the current clock in this
            position, which described the moment the page was opened rather than
            any sign-in that occurred.
          </li>
          <li>
            <strong style={{ color: color.text }}>Per-analyst activity counts.</strong>{' '}
            Audit events record the actor behind every state change, but no
            per-user rollup is queried or exposed by any current route. Numbers
            in this position would have to be invented, so there are none.
          </li>
          <li>
            <strong style={{ color: color.text }}>Session or connection health.</strong>{' '}
            This page observes neither. A request either succeeded or it did
            not — that is visible from whether these fields loaded at all.
          </li>
        </Box>
        <Box sx={{ mt: 2 }}>
          <SectionLabel component="h3">About ThreatNeXus</SectionLabel>
          <Box sx={{ ...type.small, color: color.textMuted, mt: 1, maxWidth: '78ch' }}>
            A defensive cyber-threat-intelligence orchestration and
            incident-response research prototype built for PKCERT. Reports in;
            deduplicated findings, explainable Risk v1 scores, analyst-owned
            cases and reviewer-approved constituent notifications out. It
            performs no autonomous scanning, no automatic remediation and no
            automatic sending.
          </Box>
        </Box>
        <ScopeNote sx={{ mt: 2 }} />
      </Panel>
    </>
  )
}

export default Profile
