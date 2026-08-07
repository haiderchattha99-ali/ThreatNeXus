// Settings — Phase 6.2 truth cleanup.
//
// WHAT THIS PAGE USED TO BE
// -------------------------
// Six cards, of which five asserted things this system has never done:
//
//   - "Show Threat Map", "Show MITRE ATT&CK Matrix", "Show Live Threat Feed"
//     toggles for dashboard widgets that Phase 6 deleted because they were
//     fabricated. The switches wrote to localStorage and nothing read them.
//   - A "Threat Feed Refresh" interval (every 5/15/30/60 minutes) for scheduled
//     ingestion that is explicitly out of scope and does not exist.
//   - A "Default Provider" selector offering VirusTotal, AlienVault OTX and
//     MISP. None of the three is implemented anywhere in this repository.
//   - Six alert toggles ("Critical Threat Alerts", "Malware Detection…") for an
//     alerting subsystem that does not exist. Nothing was ever sent.
//   - A "System Health" card with hardcoded service-availability bars — 92%,
//     81%, 67%, 88% — and four green "Online / Healthy / Running / Active"
//     chips. Every one of those numbers was a literal in the source.
//   - "AI Engine: Ready", while AI_ENABLED defaults to false and there is no
//     live AI provider in this repository at all.
//   - A profile card showing `new Date().toLocaleString()` as "Last Login" —
//     that is the current clock, not a login record — and name/email fields
//     that saved to localStorage and popped "Profile saved successfully."
//     No server account was ever changed.
//
// WHAT IT IS NOW
// --------------
// Three sections, each of which either reads real state or is honestly labelled
// as a local display preference:
//
//   1. Motion and accessibility — a genuine local preference, plus a safe
//      replay of the product intro. Stated as local-only.
//   2. Session and role — the server-resolved role and capability list this
//      browser is actually holding. Read-only.
//   3. Platform configuration — provider and AI state read from the same
//      capability-gated overview snapshot the dashboard uses. Read-only.
//
// This page is deliberately NOT an HTTP switch for AI_ENABLED, for a provider
// selection, or for an API key. Those are environment configuration, they are
// administered outside the application, and exposing them here would turn a
// deployment decision into a request body.

import React from 'react'
import { Box, Button, Switch, FormControlLabel } from '@mui/material'
import { FiPlay, FiRefreshCw } from 'react-icons/fi'

import { useAuth } from '../hooks/useAuth'
import { useMotionPreference } from '../hooks/useReducedMotion'
import { dashboardService } from '../services/api'
import { OpeningMotif } from '../components/OpeningMotif'
import {
  PageHeader,
  Panel,
  SectionLabel,
  Field,
  FieldGrid,
  StatusBadge,
  Provenance,
  LoadingState,
  ErrorState,
  ScopeNote,
} from '../components/ui'
import { PROVIDER_STATE } from '../components/dashboard/dashboardModel'
import { color, type, radius, font } from '../theme/tokens'

// Provider configuration states, as the backend reports them. Each is a fact
// about configuration — never a health, uptime or availability claim.
const CONFIG_STATE = Object.freeze({
  MOCK_PROVIDER: { label: 'Mock provider', tone: 'neutral', icon: 'minus' },
  CONFIGURED: { label: 'Key present', tone: 'success', icon: 'check' },
  NOT_CONFIGURED: { label: 'No key present', tone: 'warning', icon: 'warning' },
  CONFIGURED_WITH_KEY: { label: 'Key present', tone: 'success', icon: 'check' },
  KEYLESS_PUBLIC_RATE_LIMIT: { label: 'Keyless, public rate limit', tone: 'info', icon: 'dot' },
  NO_KEY_REQUIRED: { label: 'No key required', tone: 'info', icon: 'dot' },
  ENABLED: { label: 'Enabled', tone: 'warning', icon: 'warning' },
  DISABLED: { label: 'Disabled', tone: 'neutral', icon: 'power' },
})

function ReplayIntro() {
  // A replay counter, not a storage write. Bumping it remounts the motif, which
  // replays its own timeline. Nothing about the session, the stored
  // "already seen" marker or the auth token is touched — a demo operator can
  // replay the intro as often as they like without signing anybody out.
  const [run, setRun] = React.useState(0)
  const [playing, setPlaying] = React.useState(false)

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Button
          data-testid="replay-intro"
          size="small"
          variant="outlined"
          startIcon={<FiPlay />}
          onClick={() => {
            setRun((n) => n + 1)
            setPlaying(true)
          }}
        >
          Replay product intro
        </Button>
        <Box sx={{ ...type.caption, color: color.textMuted }}>
          Plays the sign-in opening here. It changes no setting, clears no
          session and signs nobody out.
        </Box>
      </Box>
      {playing && (
        <Box
          data-testid="intro-replay-stage"
          sx={{
            mt: 2,
            p: 2,
            border: `1px solid ${color.border}`,
            borderRadius: `${radius.md}px`,
            backgroundColor: color.canvasAlt,
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          <OpeningMotif key={run} animate size={260} />
          <Box component="p" sx={{ ...type.bodyStrong, color: color.text, mt: 2, mb: 0 }}>
            Connecting Intelligence with Action
          </Box>
          <Box component="p" sx={{ ...type.caption, color: color.textMuted, fontFamily: font.mono, mt: 1, mb: 0 }}>
            No autonomous scanning · no automatic remediation · no automatic sending
          </Box>
        </Box>
      )}
    </Box>
  )
}

const Settings = () => {
  const { user, capabilities } = useAuth()
  const { optOut, systemReduced, setReducedMotion } = useMotionPreference()

  const [overview, setOverview] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)

  const load = React.useCallback(() => {
    setLoading(true)
    setError(false)
    dashboardService
      .getOverview()
      .then((res) => setOverview(res.data?.data || null))
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const providers = overview?.sections?.providers
  const providerRows = providers
    ? [providers.ioc, ...(providers.vulnerability || []), ...(providers.exposure || []), ...(providers.reputation || [])].filter(Boolean)
    : []

  return (
    <>
      <PageHeader
        eyebrow="Workspace / settings"
        title="Settings"
        description="Local display preferences, the role this browser is actually holding, and the platform configuration this instance is running under."
        breadcrumbs={[{ label: 'ThreatNeXus', to: '/dashboard' }, { label: 'Settings' }]}
      />

      <Panel
        title="Motion and accessibility"
        description="Applies to this browser only. It is stored locally and sent nowhere."
        sx={{ mb: 2 }}
      >
        <FormControlLabel
          control={
            <Switch
              data-testid="reduced-motion-toggle"
              checked={optOut || systemReduced}
              disabled={systemReduced}
              onChange={(e) => setReducedMotion(e.target.checked)}
            />
          }
          label="Reduce non-essential motion"
        />
        <Box sx={{ ...type.small, color: color.textMuted, mt: 0.5, mb: 2.5, maxWidth: '70ch' }}>
          {systemReduced
            ? 'Your operating system is set to reduce motion, so non-essential animation is already suppressed everywhere in this application. That setting wins and cannot be overridden here.'
            : 'Suppresses the sign-in opening, the dashboard entrance, chart drawing and the refresh spinner. Nothing operational is hidden either way — every figure, queue and control renders identically with motion off.'}
        </Box>
        <ReplayIntro />
      </Panel>

      <Panel
        title="Session and role"
        description="Resolved by the server from your token. This screen only displays it — no field here can widen what the server already decided."
        sx={{ mb: 2 }}
      >
        <FieldGrid>
          <Field label="Name">{user?.name}</Field>
          <Field label="Email" mono>{user?.email}</Field>
          <Field label="Role">{user?.role}</Field>
          <Field label="Account identifier" mono>{user?.id}</Field>
        </FieldGrid>

        <Box sx={{ mt: 2.5 }}>
          <SectionLabel component="h3">Capabilities granted to this role</SectionLabel>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1 }}>
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
              <Box sx={{ ...type.small, color: color.textMuted }}>No capabilities were returned for this session.</Box>
            )}
          </Box>
          <Box sx={{ ...type.caption, color: color.textMuted, mt: 1.5, maxWidth: '76ch' }}>
            This list is display only. Every route enforces its own capability
            check on the server, so editing it in the browser changes nothing
            about what this account can do.
          </Box>
        </Box>
      </Panel>

      <Panel
        title="Platform configuration"
        description="Read from the same capability-gated snapshot the dashboard uses. Configuration is administered through the deployment environment, never through this screen."
        actions={
          <Button size="small" variant="outlined" startIcon={<FiRefreshCw />} onClick={load}>
            Refresh
          </Button>
        }
        footer={
          providers ? (
            <Provenance
              source="GET /api/dashboard/overview — sections.providers"
              asOf={providers.asOf}
              note={providers.disclaimer}
            />
          ) : null
        }
      >
        {loading && !overview ? (
          <LoadingState label="Reading configuration" />
        ) : error && !overview ? (
          <ErrorState onRetry={load}>
            Configuration could not be read. Nothing is assumed in its place.
          </ErrorState>
        ) : (
          <>
            <SectionLabel component="h3">Enrichment providers</SectionLabel>
            <Box sx={{ mt: 1, mb: 3 }}>
              {providerRows.map((provider, index) => (
                <Box
                  key={provider.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1.5,
                    flexWrap: 'wrap',
                    py: 1.15,
                    borderTop: index ? `1px solid ${color.border}` : 0,
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Box sx={{ ...type.small, color: color.text }}>{provider.name}</Box>
                    <Box sx={{ ...type.caption, color: color.textMuted }}>
                      {provider.lastSuccessAt
                        ? `Last stored success ${new Date(provider.lastSuccessAt).toLocaleString()}`
                        : 'No successful lookup has been stored'}
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                    <StatusBadge dictionary={CONFIG_STATE} value={provider.status} size="small" />
                    <StatusBadge dictionary={PROVIDER_STATE} value={provider.state} size="small" />
                  </Box>
                </Box>
              ))}
            </Box>

            <SectionLabel component="h3">AI assistance</SectionLabel>
            <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <StatusBadge dictionary={CONFIG_STATE} value={providers?.ai?.status || 'DISABLED'} size="small" />
              <Box sx={{ ...type.caption, fontFamily: font.mono, color: color.textMuted }}>
                provider: {providers?.ai?.provider || 'null'}
              </Box>
            </Box>
            <Box sx={{ ...type.small, color: color.textMuted, mt: 1, maxWidth: '76ch' }}>
              {providers?.ai?.note ||
                'Optional and disabled by default. Suggestions are inert until a human approves them.'}
            </Box>

            <Box
              sx={{
                mt: 3,
                p: 1.5,
                backgroundColor: color.surfaceSunken,
                borderRadius: `${radius.sm}px`,
                ...type.caption,
                color: color.textMuted,
              }}
            >
              This instance has no scheduled ingestion, no alerting subsystem, no
              outbound mail or webhook client, and no service-availability
              measurement — so none is reported here. Reading this page performs
              no provider request; every value above is configuration state or a
              previously stored lookup result.
            </Box>
          </>
        )}
      </Panel>

      <ScopeNote sx={{ mt: 2 }} />
    </>
  )
}

export default Settings
