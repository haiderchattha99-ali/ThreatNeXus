// The operational overview.
//
// Everything on this page comes from ONE call to GET /api/dashboard/overview,
// and every figure arrives as { value, availability, source, asOf }. This
// component does no arithmetic on those figures, holds no constants that stand
// in for data, and renders `—` plus a reason wherever the backend reported that
// it could not compute or the caller may not read something.
//
// What this page deliberately does NOT contain, all of which the pre-Phase-6
// dashboard did:
//   - an ATT&CK "coverage" percentage
//   - service latencies or an "all systems operational" claim
//   - a live threat feed of invented indicators
//   - a seven-day trend line built from a hardcoded array
//   - per-country attack percentages, or a map of any kind

import React from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Box, Button, Alert } from '@mui/material'
import { FiRefreshCw, FiExternalLink } from 'react-icons/fi'

import { dashboardService } from '../services/api'
import {
  PageHeader,
  Panel,
  MetricTile,
  MetricValue,
  Provenance,
  DistributionBars,
  StatusBadge,
  LoadingState,
  ErrorState,
  EmptyState,
  DeniedState,
  UnavailableState,
  ScopeNote,
  Timeline,
  SectionLabel,
  Reveal,
  formatAsOf,
} from '../components/ui'
import { color, type, riskBandColor, font, radius } from '../theme/tokens'

const RISK_BAND_LABEL = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  INFORMATIONAL: 'Informational',
}

const OCCURRENCE_LABEL = {
  CREATED: 'First observed',
  PERSISTED: 'Seen again',
  RECURRED: 'Recurred after closure',
  HISTORICAL: 'Back-dated observation',
}

const AGEING_LABEL = {
  LAST_24H: 'Last 24 hours',
  '1_7_DAYS': '1–7 days',
  '8_30_DAYS': '8–30 days',
  OVER_30_DAYS: 'Over 30 days',
}

const FRAMEWORK_LABEL = {
  MITRE_ATTACK: 'MITRE ATT&CK',
  NIST_CSF: 'NIST CSF',
  CIS_CONTROLS: 'CIS Controls',
}

const MAPPING_SOURCE_LABEL = {
  MANUAL: 'Created manually',
  AI_SUGGESTION_PROMOTED: 'Promoted from an AI suggestion',
}

const DELIVERY_LABEL = {
  SENT_MANUALLY: 'Sent manually',
  DELIVERED: 'Delivered',
  FAILED: 'Failed',
  BOUNCED: 'Bounced',
  UNKNOWN: 'Unknown',
}

const PROVIDER_STATUS = {
  MOCK_PROVIDER: { label: 'Mock provider (no external calls)', tone: 'neutral', icon: 'power' },
  CONFIGURED: { label: 'Configured', tone: 'success', icon: 'check' },
  NOT_CONFIGURED: { label: 'No API key configured', tone: 'neutral', icon: 'minus' },
  CONFIGURED_WITH_KEY: { label: 'Configured with key', tone: 'success', icon: 'check' },
  KEYLESS_PUBLIC_RATE_LIMIT: { label: 'Keyless (public rate limit)', tone: 'info', icon: 'dot' },
  NO_KEY_REQUIRED: { label: 'No key required', tone: 'info', icon: 'dot' },
  ENABLED: { label: 'Enabled', tone: 'warning', icon: 'power' },
  DISABLED: { label: 'Disabled', tone: 'neutral', icon: 'power' },
}

const FRESHNESS_STATUS = {
  FRESH: { label: 'Recent result stored', tone: 'success', icon: 'check' },
  STALE: { label: 'Last stored result is stale', tone: 'warning', icon: 'clock' },
  NO_SUCCESSFUL_LOOKUP_RECORDED: {
    label: 'No successful lookup recorded',
    tone: 'neutral',
    icon: 'minus',
  },
}

const LIFECYCLE_EVENT_LABEL = {
  CREATED: 'Case created',
  STATE_CHANGED: 'State changed',
  CLOSURE_REQUESTED: 'Closure requested',
  CLOSURE_APPROVED: 'Closure approved',
  CLOSURE_REJECTED: 'Closure rejected',
  REOPENED: 'Case reopened',
}

function labelled(items, dictionary) {
  return (items || []).map((item) => ({
    ...item,
    label: dictionary[item.key] || item.key,
  }))
}

/** Renders a section that the caller may not read, or that failed to compute. */
function SectionFallback({ section, restrictedMessage }) {
  if (section?.availability === 'RESTRICTED') {
    return <DeniedState dense>{section.reason || restrictedMessage}</DeniedState>
  }
  return (
    <UnavailableState title="Not available" dense>
      {section?.reason ||
        'This section could not be computed. It is shown as unavailable rather than as zero.'}
    </UnavailableState>
  )
}

function isReadable(section) {
  return section?.availability === 'AVAILABLE'
}

export const Dashboard = () => {
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

  if (loading && !overview) {
    return (
      <>
        <PageHeader
          eyebrow="Analyst workspace / operations"
          title="Operations overview"
          description="Loading the current snapshot."
        />
        <LoadingState label="Loading the operations overview" />
      </>
    )
  }

  if (error || !overview) {
    return (
      <>
        <PageHeader
          eyebrow="Analyst workspace / operations"
          title="Operations overview"
        />
        <Panel>
          <ErrorState onRetry={load}>
            The overview could not be loaded. Nothing is shown rather than a
            partial or assumed figure.
          </ErrorState>
        </Panel>
      </>
    )
  }

  const { sections, generatedAt, datasetScope, geographic } = overview
  const f = sections.findings
  const c = sections.cases
  const n = sections.notifications
  const fw = sections.frameworkMappings
  const p = sections.providers
  const activity = sections.recentActivity

  return (
    <>
      <PageHeader
        eyebrow="Analyst workspace / operations"
        title="Operations overview"
        description={datasetScope}
        breadcrumbs={[{ label: 'ThreatNeXus' }, { label: 'Operations overview' }]}
        actions={
          <Button variant="outlined" size="small" startIcon={<FiRefreshCw />} onClick={load} disabled={loading}>
            Refresh
          </Button>
        }
        meta={
          <Provenance
            source="Single read-only snapshot · GET /api/dashboard/overview"
            asOf={generatedAt}
            note="no provider request is made to render this page"
          />
        }
      />

      {/* ------------------------------------------------------- findings */}
      {isReadable(f) ? (
        <>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', lg: 'repeat(4, 1fr)' },
              gap: 2,
              mb: 2,
            }}
          >
            <MetricTile label="Open findings" metric={f.metrics.open} description="Exposures currently unresolved." />
            <MetricTile
              label="Persistent findings"
              metric={f.metrics.persistent}
              description="Observed in more than one report."
            />
            <MetricTile
              label="Findings that recurred"
              metric={f.metrics.withRecurrence}
              description="Observed again after being closed."
            />
            <MetricTile
              label="Reports processed"
              metric={f.metrics.reportsProcessed}
              description="Uploads accepted and parsed."
            />
          </Box>

          <Reveal index={0}>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', lg: '1.1fr 1fr' },
                gap: 2,
                mb: 2,
              }}
            >
              <Panel
                title="Risk v1 band distribution"
                description="Current deterministic score for each Finding that has one. Findings with no current score are counted separately rather than folded into the lowest band."
                footer={
                  <Provenance
                    source={f.distributions.riskBand.source}
                    asOf={f.distributions.riskBand.asOf}
                    note={`denominator ${f.distributions.riskBand.denominator} scored findings`}
                  />
                }
              >
                <DistributionBars
                  items={labelled(f.distributions.riskBand.items, RISK_BAND_LABEL)}
                  colorFor={(key) => riskBandColor[key]}
                />
                <Box
                  sx={{
                    mt: 2.5,
                    pt: 2,
                    borderTop: `1px solid ${color.border}`,
                    display: 'flex',
                    gap: 3,
                    flexWrap: 'wrap',
                  }}
                >
                  <Box>
                    <SectionLabel>Scored</SectionLabel>
                    <MetricValue metric={f.metrics.scored} size="small" />
                  </Box>
                  <Box>
                    <SectionLabel>Not yet scored</SectionLabel>
                    <MetricValue metric={f.metrics.unscored} size="small" />
                  </Box>
                </Box>
              </Panel>

              <Panel
                title="Observation outcomes"
                description="What each ingestion did to a Finding, taken from the append-only occurrence ledger."
                footer={
                  <Provenance
                    source={f.distributions.occurrenceOutcome.source}
                    asOf={f.distributions.occurrenceOutcome.asOf}
                    note={`denominator ${f.distributions.occurrenceOutcome.denominator} occurrences`}
                  />
                }
              >
                <DistributionBars
                  items={labelled(f.distributions.occurrenceOutcome.items, OCCURRENCE_LABEL)}
                />
              </Panel>
            </Box>
          </Reveal>

          <Reveal index={1}>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' },
                gap: 2,
                mb: 2,
              }}
            >
              <Panel
                title="Ageing by last observation"
                description="How recently each Finding was last seen in an ingested report."
                footer={
                  <Provenance
                    source={f.distributions.ageing.source}
                    asOf={f.distributions.ageing.asOf}
                    note={`denominator ${f.distributions.ageing.denominator} findings`}
                  />
                }
              >
                <DistributionBars items={labelled(f.distributions.ageing.items, AGEING_LABEL)} />
              </Panel>

              <Panel
                title="Report types loaded"
                description="Only report types actually ingested into this instance appear here."
                footer={
                  <Provenance
                    source={f.distributions.reportType.source}
                    asOf={f.distributions.reportType.asOf}
                  />
                }
                actions={
                  <Button
                    component={RouterLink}
                    to="/findings"
                    size="small"
                    variant="text"
                    endIcon={<FiExternalLink size={13} />}
                  >
                    Open findings
                  </Button>
                }
              >
                <DistributionBars
                  items={(f.distributions.reportType.items || []).map((i) => ({
                    ...i,
                    label: i.key.replace(/_/g, ' '),
                  }))}
                  emptyLabel="No reports have been ingested into this instance yet."
                />
                <ScopeNote sx={{ mt: 2.5 }} />
              </Panel>
            </Box>
          </Reveal>
        </>
      ) : (
        <Panel title="Findings" sx={{ mb: 2 }}>
          <SectionFallback section={f} />
        </Panel>
      )}

      {/* ---------------------------------------------------------- cases */}
      <Reveal index={2}>
        <Panel
          title="Cases"
          description="Organization-bound investigations and their current lifecycle state."
          sx={{ mb: 2 }}
          footer={
            isReadable(c) ? (
              <Provenance source="Case.lifecycleState and the closure/response ledgers" asOf={generatedAt} />
            ) : null
          }
        >
          {isReadable(c) ? (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(3, 1fr)', lg: 'repeat(6, 1fr)' },
                gap: 2.5,
              }}
            >
              {[
                ['Open', c.metrics.open],
                ['Waiting for organization', c.metrics.waitingForOrganization],
                ['Closure pending review', c.metrics.closurePending],
                ['Closed', c.metrics.closed],
                ['Reopened by recurrence', c.metrics.reopenedByRecurrence],
                ['Organization responses', c.metrics.organizationResponses],
              ].map(([label, m]) => (
                <Box key={label}>
                  <SectionLabel component="h3">{label}</SectionLabel>
                  <Box sx={{ mt: 0.75 }}>
                    <MetricValue metric={m} size="small" />
                  </Box>
                </Box>
              ))}
            </Box>
          ) : (
            <SectionFallback section={c} />
          )}
        </Panel>
      </Reveal>

      {/* -------------------------------------------------- notifications */}
      <Reveal index={3}>
        <Panel
          title="Constituent notifications"
          description="Drafting, review and what happened to the artifact afterwards."
          sx={{ mb: 2 }}
          footer={
            isReadable(n) ? (
              <Provenance source="Notification.lifecycleState, NotificationExport, NotificationDeliveryEvent" asOf={generatedAt} />
            ) : null
          }
        >
          {isReadable(n) ? (
            <>
              {/* Not a decoration. Keeping these two figures visually and
                  verbally separate is the point: this system has no SMTP or
                  webhook client, and an export is a file, not a send. */}
              <Alert severity="info" sx={{ mb: 2.5 }}>
                {n.disclaimer}
              </Alert>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(3, 1fr)', lg: 'repeat(6, 1fr)' },
                  gap: 2.5,
                }}
              >
                {[
                  ['Draft', n.metrics.draft],
                  ['Pending review', n.metrics.pendingReview],
                  ['Approved', n.metrics.approved],
                  ['Rejected', n.metrics.rejected],
                  ['Exports produced', n.metrics.exports],
                  ['Delivery observations', n.metrics.deliveryObservations],
                ].map(([label, m]) => (
                  <Box key={label}>
                    <SectionLabel component="h3">{label}</SectionLabel>
                    <Box sx={{ mt: 0.75 }}>
                      <MetricValue metric={m} size="small" />
                    </Box>
                  </Box>
                ))}
              </Box>

              {n.distributions?.deliveryStatus?.denominator > 0 && (
                <Box sx={{ mt: 3, pt: 2.5, borderTop: `1px solid ${color.border}` }}>
                  <SectionLabel component="h3" sx={{ mb: 1.5 }}>
                    Recorded delivery observations
                  </SectionLabel>
                  <DistributionBars
                    items={labelled(n.distributions.deliveryStatus.items, DELIVERY_LABEL)}
                  />
                </Box>
              )}
            </>
          ) : (
            <SectionFallback section={n} />
          )}
        </Panel>
      </Reveal>

      {/* ---------------------------------------------------- frameworks */}
      <Reveal index={4}>
        <Panel
          title={fw?.label || 'Analyst-associated framework context'}
          description={fw?.disclaimer}
          sx={{ mb: 2 }}
          footer={
            isReadable(fw) ? (
              <Provenance source="CaseFrameworkMapping current rows" asOf={generatedAt} />
            ) : null
          }
        >
          {isReadable(fw) ? (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 4 }}>
              <Box>
                <SectionLabel component="h3" sx={{ mb: 1.5 }}>
                  Active mappings by framework
                </SectionLabel>
                <DistributionBars
                  items={labelled(fw.distributions.byFramework.items, FRAMEWORK_LABEL)}
                  emptyLabel="No framework mappings have been created yet."
                />
              </Box>
              <Box>
                <SectionLabel component="h3" sx={{ mb: 1.5 }}>
                  How each active mapping was created
                </SectionLabel>
                <DistributionBars
                  items={labelled(fw.distributions.bySource.items, MAPPING_SOURCE_LABEL)}
                  emptyLabel="No framework mappings have been created yet."
                />
                <Box sx={{ mt: 2.5, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                  <Box>
                    <SectionLabel>History rows</SectionLabel>
                    <MetricValue metric={fw.metrics.historyRows} size="small" />
                  </Box>
                  <Box>
                    <SectionLabel>AI suggestions awaiting a human decision</SectionLabel>
                    <MetricValue metric={fw.metrics.pendingAiSuggestions} size="small" />
                  </Box>
                </Box>
              </Box>
            </Box>
          ) : (
            <SectionFallback section={fw} />
          )}
        </Panel>
      </Reveal>

      {/* ----------------------------------------------------- providers */}
      <Reveal index={5}>
        <Panel
          title="Provider and configuration status"
          description={p?.disclaimer}
          sx={{ mb: 2 }}
        >
          {isReadable(p) ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              {[
                { ...p.ioc, group: 'IP reputation' },
                ...p.vulnerability.map((v) => ({ ...v, group: 'Vulnerability context' })),
              ].map((provider) => (
                <Box
                  key={provider.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 2,
                    flexWrap: 'wrap',
                    px: 2,
                    py: 1.5,
                    borderRadius: `${radius.sm}px`,
                    border: `1px solid ${color.border}`,
                    backgroundColor: color.surfaceSunken,
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Box sx={{ ...type.bodyStrong, color: color.text }}>{provider.name}</Box>
                    <Box sx={{ ...type.caption, color: color.textFaint, fontFamily: font.mono, mt: 0.4 }}>
                      {provider.source}
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <StatusBadge dictionary={PROVIDER_STATUS} value={provider.status} size="small" />
                    <StatusBadge dictionary={FRESHNESS_STATUS} value={provider.state} size="small" />
                    {provider.lastSuccessAt && (
                      <Box sx={{ ...type.caption, color: color.textMuted, fontFamily: font.mono }}>
                        {formatAsOf(provider.lastSuccessAt)}
                      </Box>
                    )}
                  </Box>
                </Box>
              ))}

              <Box
                sx={{
                  px: 2,
                  py: 1.5,
                  borderRadius: `${radius.sm}px`,
                  border: `1px solid ${color.border}`,
                  backgroundColor: color.surfaceSunken,
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
                  <Box sx={{ ...type.bodyStrong, color: color.text }}>{p.ai.name}</Box>
                  <StatusBadge dictionary={PROVIDER_STATUS} value={p.ai.status} size="small" />
                </Box>
                <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.75, maxWidth: '72ch' }}>
                  {p.ai.note}
                </Box>
              </Box>
            </Box>
          ) : (
            <SectionFallback section={p} />
          )}
        </Panel>
      </Reveal>

      {/* ---------------------------------------------------- geographic */}
      <Reveal index={6}>
        <Panel title="Geographic observations" sx={{ mb: 2 }}>
          <UnavailableState title={geographic.message} dense>
            {geographic.reason}
          </UnavailableState>
        </Panel>
      </Reveal>

      {/* ------------------------------------------------ recent activity */}
      <Reveal index={7}>
        <Panel
          title="Recent case activity"
          description={`The ${activity?.limit ?? 8} most recent case lifecycle events.`}
          footer={
            isReadable(activity) ? (
              <Provenance source={activity.source} asOf={activity.asOf} />
            ) : null
          }
        >
          {isReadable(activity) ? (
            activity.items.length ? (
              <Timeline
                items={activity.items.map((e) => ({
                  id: e.id,
                  title: LIFECYCLE_EVENT_LABEL[e.eventType] || e.eventType,
                  at: e.occurredAt,
                  detail:
                    e.fromState && e.toState
                      ? `${e.caseReference || `Case ${e.caseId}`} · ${e.fromState} → ${e.toState}`
                      : e.caseReference || `Case ${e.caseId}`,
                }))}
              />
            ) : (
              <EmptyState title="No case activity recorded yet" dense>
                Case lifecycle events appear here as soon as an analyst opens the
                first case.
              </EmptyState>
            )
          ) : (
            <SectionFallback section={activity} />
          )}
        </Panel>
      </Reveal>
    </>
  )
}

export default Dashboard
