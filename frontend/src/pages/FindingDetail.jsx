// One Finding, with everything that makes a decision about it defensible.
//
// The risk section is the important one. It is rendered ENTIRELY from the
// factor contribution rows the scoring engine stored — this page performs no
// scoring arithmetic, applies no weights, and does not re-derive a band. Risk
// v1 is a locked, deterministic, explainable contract; the explanation is a
// projection of stored evidence, never a narrative generated at read time.
//
// The three applicability values are shown distinctly and never collapsed:
//   APPLIED         real evidence was scored (including a legitimate zero)
//   NOT_AVAILABLE   the evidence could not be obtained
//   NOT_APPLICABLE  the factor cannot apply to this kind of finding at all
// Flattening "we could not check" into "clean" is exactly the failure this
// distinction exists to prevent.

import React from 'react'
import { Link as RouterLink, useParams } from 'react-router-dom'
import {
  Box,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Link,
  Alert,
} from '@mui/material'
import { FiArrowLeft, FiRefreshCw } from 'react-icons/fi'

import { findingService } from '../services/api'
import { FindingTriagePanel } from '../components/FindingTriagePanel'
import {
  PageHeader,
  Panel,
  Field,
  FieldGrid,
  StatusBadge,
  RiskBandBadge,
  LoadingState,
  ErrorState,
  EmptyState,
  UnavailableState,
  Provenance,
  Timeline,
  SectionLabel,
  formatAsOf,
} from '../components/ui'
import {
  FINDING_STATUS,
  FINDING_LIFECYCLE,
  OWNERSHIP_CONFIDENCE,
  CASE_STATE,
  color,
  type,
  font,
  radius,
} from '../theme/tokens'

const APPLICABILITY = {
  APPLIED: { label: 'Applied', tone: 'accent', icon: 'check' },
  NOT_AVAILABLE: { label: 'Evidence not available', tone: 'warning', icon: 'warning' },
  NOT_APPLICABLE: { label: 'Not applicable', tone: 'neutral', icon: 'minus' },
}

const ENRICHMENT_STATUS = {
  SUCCESS: { label: 'Lookup succeeded', tone: 'success', icon: 'check' },
  NOT_FOUND: { label: 'Not found', tone: 'neutral', icon: 'minus' },
  PENDING: { label: 'Queued', tone: 'info', icon: 'clock' },
  RATE_LIMITED: { label: 'Rate limited', tone: 'warning', icon: 'clock' },
  INVALID_KEY: { label: 'Invalid API key', tone: 'danger', icon: 'cross' },
  TIMEOUT: { label: 'Timed out', tone: 'warning', icon: 'clock' },
  FAILED: { label: 'Lookup failed', tone: 'danger', icon: 'cross' },
  UNSUPPORTED_INDICATOR: { label: 'Unsupported indicator', tone: 'neutral', icon: 'minus' },
  SKIPPED_DISABLED: { label: 'Provider disabled', tone: 'neutral', icon: 'power' },
  DEAD_LETTER: { label: 'Abandoned after repeated failure', tone: 'danger', icon: 'cross' },
}

const OCCURRENCE_ACTION = {
  CREATED: { label: 'First observed', tone: 'info', icon: 'plus' },
  PERSISTED: { label: 'Observed again', tone: 'warning', icon: 'repeat' },
  RECURRED: { label: 'Recurred after closure', tone: 'danger', icon: 'rotate' },
  HISTORICAL: { label: 'Back-dated observation', tone: 'neutral', icon: 'clock' },
}

// Turns a stored factor key into a readable name. Falls back to the raw key so
// a factor added later is visible rather than silently unnamed.
const FACTOR_LABEL = {
  EXPOSURE_BASE: 'Exposure base',
  RECURRENCE: 'Recurrence history',
  PERSISTENCE: 'Persistence',
  IOC_REPUTATION: 'IP reputation context',
  CVE_PRESENCE: 'Analyst-verified CVE present',
  KEV_STATUS: 'CISA KEV (known exploited)',
  EPSS_PROBABILITY: 'FIRST EPSS probability',
  SECTOR_CRITICALITY: 'Organization sector',
}

function lifecycleOf(finding) {
  if (finding.recurrenceCount > 0) return 'RECURRED'
  if (finding.occurrenceCount > 1) return 'PERSISTED'
  return 'CREATED'
}

function RiskExplanation({ risk }) {
  if (!risk) {
    return (
      <EmptyState title="No risk score has been calculated yet" dense>
        A deterministic Risk v1 score is written when evidence about this Finding
        changes. None has been recorded for it so far — this is not a score of
        zero.
      </EmptyState>
    )
  }

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          flexWrap: 'wrap',
          pb: 2.5,
          mb: 2.5,
          borderBottom: `1px solid ${color.border}`,
        }}
      >
        <Box>
          <SectionLabel>Current score</SectionLabel>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mt: 0.75 }}>
            <Box sx={{ ...type.metric, color: color.text }}>{risk.displayScore}</Box>
            <RiskBandBadge band={risk.riskBand} />
          </Box>
        </Box>
        <Box>
          <SectionLabel>Algorithm</SectionLabel>
          <Box sx={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, mt: 1 }}>
            {risk.algorithmVersion}
            <br />
            {risk.configurationVersion}
          </Box>
        </Box>
        <Box>
          <SectionLabel>Evaluated as of</SectionLabel>
          <Box sx={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, mt: 1 }}>
            {formatAsOf(risk.asOf) || '—'}
          </Box>
        </Box>
        <Box>
          <SectionLabel>Triggered by</SectionLabel>
          <Box sx={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted, mt: 1 }}>
            {risk.trigger}
          </Box>
        </Box>
      </Box>

      <TableContainer>
        <Table size="small" aria-label="Risk factor contributions">
          <TableHead>
            <TableRow>
              <TableCell scope="col">Factor</TableCell>
              <TableCell scope="col">Applicability</TableCell>
              <TableCell scope="col">Input</TableCell>
              <TableCell scope="col" align="right">
                Contribution
              </TableCell>
              <TableCell scope="col" align="right">
                Maximum
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(risk.contributions || []).map((c) => (
              <TableRow key={c.factorKey}>
                <TableCell>
                  <Box sx={{ ...type.small, color: color.text }}>
                    {FACTOR_LABEL[c.factorKey] || c.factorKey}
                  </Box>
                  <Box sx={{ ...type.caption, color: color.textFaint, fontFamily: font.mono, mt: 0.3 }}>
                    {c.explanationCode}
                  </Box>
                </TableCell>
                <TableCell>
                  <StatusBadge dictionary={APPLICABILITY} value={c.applicability} size="small" />
                </TableCell>
                <TableCell sx={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted }}>
                  {c.normalizedInputValue ?? '—'}
                </TableCell>
                <TableCell align="right" sx={{ fontFamily: font.mono, fontSize: 12.5, color: color.text }}>
                  {(c.contributionBasisPoints / 100).toFixed(2)}
                </TableCell>
                <TableCell align="right" sx={{ fontFamily: font.mono, fontSize: 12, color: color.textFaint }}>
                  {(c.maximumContributionBasisPoints / 100).toFixed(2)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  )
}

export const FindingDetail = () => {
  const { id } = useParams()
  const [finding, setFinding] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)

  const load = React.useCallback(() => {
    setLoading(true)
    setError(null)
    findingService
      .getFinding(id)
      .then((res) => setFinding(res.data?.data || null))
      .catch((err) =>
        setError(err?.response?.status === 404 ? 'notfound' : 'error')
      )
      .finally(() => setLoading(false))
  }, [id])

  React.useEffect(() => {
    load()
  }, [load])

  if (loading && !finding) {
    return (
      <>
        <PageHeader eyebrow="Analyst workspace / evidence" title="Finding" />
        <LoadingState label="Loading this finding" />
      </>
    )
  }

  if (error === 'notfound') {
    return (
      <>
        <PageHeader eyebrow="Analyst workspace / evidence" title="Finding not found" />
        <Panel>
          <EmptyState title="No finding with that identifier">
            It may never have existed. Findings are never hard-deleted by this
            application, so an identifier that once worked still will.
          </EmptyState>
        </Panel>
        <Button component={RouterLink} to="/findings" startIcon={<FiArrowLeft />} sx={{ mt: 2 }}>
          Back to findings
        </Button>
      </>
    )
  }

  if (error || !finding) {
    return (
      <>
        <PageHeader eyebrow="Analyst workspace / evidence" title="Finding" />
        <Panel>
          <ErrorState onRetry={load} />
        </Panel>
      </>
    )
  }

  return (
    <>
      <PageHeader
        eyebrow="Analyst workspace / evidence"
        title={finding.indicatorValue}
        description={`Port ${finding.port} · ${finding.protocol} · ${finding.reportType.replace(/_/g, ' ')}. This identity is the deduplication key — every observation of it across every report is the same Finding.`}
        breadcrumbs={[
          { label: 'ThreatNeXus', to: '/dashboard' },
          { label: 'Findings', to: '/findings' },
          { label: finding.indicatorValue },
        ]}
        actions={
          <>
            <Button component={RouterLink} to="/findings" size="small" startIcon={<FiArrowLeft />}>
              All findings
            </Button>
            <Button variant="outlined" size="small" startIcon={<FiRefreshCw />} onClick={load}>
              Refresh
            </Button>
          </>
        }
        meta={
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <StatusBadge dictionary={FINDING_STATUS} value={finding.status} />
            <StatusBadge dictionary={FINDING_LIFECYCLE} value={lifecycleOf(finding)} />
            {finding.risk && (
              <RiskBandBadge band={finding.risk.riskBand} score={finding.risk.displayScore} />
            )}
          </Box>
        }
      />

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1.5fr 1fr' }, gap: 2, mb: 2 }}>
        <Panel title="Identity and observation history">
          <FieldGrid columns={{ xs: '1fr 1fr', md: 'repeat(3, 1fr)' }}>
            <Field label="Indicator" mono>
              {finding.indicatorValue}
            </Field>
            <Field label="Port" mono>
              {finding.port}
            </Field>
            <Field label="Protocol" mono>
              {finding.protocol}
            </Field>
            <Field label="First observed" mono>
              {formatAsOf(finding.firstSeen)}
            </Field>
            <Field label="Last observed" mono>
              {formatAsOf(finding.lastSeen)}
            </Field>
            <Field label="Times observed" mono>
              {finding.occurrenceCount}
            </Field>
            <Field label="Recurrences after closure" mono>
              {finding.recurrenceCount}
            </Field>
            <Field label="Closed at" mono>
              {formatAsOf(finding.closedAt)}
            </Field>
            <Field label="Closure reason">{finding.closureReason}</Field>
          </FieldGrid>
        </Panel>

        <Panel
          title="Ownership"
          description="Resolved deterministically: analyst override, then exact address, then longest matching prefix, then ASN."
        >
          {finding.ownership ? (
            <>
              <FieldGrid columns={{ xs: '1fr' }} gap={2}>
                <Field label="Organization">
                  {finding.ownership.organization?.name || 'Not resolved'}
                </Field>
                <Field label="Resolution">
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                    <Box component="span" sx={{ fontFamily: font.mono, fontSize: 12 }}>
                      {finding.ownership.status}
                    </Box>
                    <StatusBadge
                      dictionary={OWNERSHIP_CONFIDENCE}
                      value={finding.ownership.confidence}
                      size="small"
                    />
                  </Box>
                </Field>
                <Field label="Reason code" mono>
                  {finding.ownership.reasonCode}
                </Field>
              </FieldGrid>

              {finding.ownership.isIspAttribution && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  This is ASN-based attribution to a network operator, not
                  confirmed ownership of the affected host. Treat it as low
                  confidence.
                </Alert>
              )}
              {finding.ownership.status === 'AMBIGUOUS' && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  Several organizations tied at the winning precedence tier, so
                  no owner was chosen. An arbitrary winner is never picked.
                </Alert>
              )}
              <Provenance
                source="FindingOwnership current row"
                asOf={finding.ownership.asOf}
                sx={{ mt: 2 }}
              />
            </>
          ) : (
            <EmptyState title="Ownership has not been resolved" dense>
              No organization has been attributed to this indicator.
            </EmptyState>
          )}
        </Panel>
      </Box>

      <Panel
        title="Risk v1 explanation"
        description="Reconstructed from the factor contributions stored with the score. Nothing here is generated, and no model influences the official score."
        sx={{ mb: 2 }}
        footer={
          finding.risk ? (
            <Provenance
              source="RiskScore + RiskFactorContribution (current snapshot)"
              asOf={finding.risk.calculatedAt}
            />
          ) : null
        }
      >
        <RiskExplanation risk={finding.risk} />
      </Panel>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2, mb: 2 }}>
        <Panel
          title="IP reputation context"
          description="Third-party context about the address. Reputation is never proof, and it never creates or closes a Finding."
        >
          {finding.enrichment ? (
            <>
              <Box sx={{ mb: 2 }}>
                <StatusBadge dictionary={ENRICHMENT_STATUS} value={finding.enrichment.status} />
              </Box>
              {finding.enrichment.status === 'SUCCESS' ? (
                <FieldGrid columns={{ xs: '1fr 1fr' }}>
                  <Field label="Provider" mono>
                    {finding.enrichment.provider}
                  </Field>
                  <Field label="Abuse confidence" mono>
                    {finding.enrichment.abuseConfidenceScore}
                  </Field>
                  <Field label="Reports" mono>
                    {finding.enrichment.totalReports}
                  </Field>
                  <Field label="Usage type">{finding.enrichment.usageType}</Field>
                </FieldGrid>
              ) : (
                <Box sx={{ ...type.small, color: color.textMuted }}>
                  No reputation values are shown, because the lookup did not
                  succeed. This is not a clean result.
                </Box>
              )}
              <Provenance
                source="IocEnrichment active cache row"
                asOf={finding.enrichment.queriedAt}
                sx={{ mt: 2 }}
              />
            </>
          ) : (
            <UnavailableState title="No reputation lookup recorded" dense>
              No enrichment result is stored for this indicator. Enrichment is
              optional and never blocks ingestion.
            </UnavailableState>
          )}
        </Panel>

        <Panel
          title="Analyst-verified vulnerabilities"
          description="CVEs an analyst explicitly associated with this host. Nothing here is inferred from a port, banner, product or operating system."
        >
          {finding.vulnerabilities.length ? (
            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {finding.vulnerabilities.map((v) => (
                <Box
                  component="li"
                  key={v.id}
                  sx={{
                    border: `1px solid ${color.border}`,
                    borderRadius: `${radius.sm}px`,
                    p: 2,
                    backgroundColor: color.surfaceSunken,
                  }}
                >
                  <Box sx={{ fontFamily: font.mono, fontSize: 13, color: color.text }}>{v.cveId}</Box>
                  <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.75 }}>{v.justification}</Box>
                  <Provenance source={`FindingVulnerability · ${v.evidenceSource}`} asOf={v.effectiveAt} sx={{ mt: 1 }} />
                </Box>
              ))}
            </Box>
          ) : (
            <EmptyState title="No CVE association recorded" dense>
              An analyst has not verified any CVE against this host. Association
              is a deliberate human act in this system.
            </EmptyState>
          )}
        </Panel>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2, mb: 2 }}>
        <FindingTriagePanel findingId={finding.id} onTriaged={load} />

        <Panel
          title="Observation timeline"
          description={`Most recent ${finding.occurrenceLimit} occurrences. Every row is immutable evidence of what one ingestion did.`}
        >
          <Timeline
            items={finding.occurrences.map((o) => ({
              id: o.id,
              title: OCCURRENCE_ACTION[o.action]?.label || o.action,
              at: o.observedAt,
              detail: `Report #${o.rawReportId}`,
              tone:
                o.action === 'RECURRED'
                  ? color.danger
                  : o.action === 'PERSISTED'
                    ? color.warning
                    : color.borderStrong,
            }))}
            emptyLabel="No occurrences recorded."
            dense
          />
        </Panel>
      </Box>

      <Panel
        title="Cases citing this finding"
        description="Where this evidence is currently linked."
      >
        {finding.caseLinks.length ? (
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {finding.caseLinks.map((l) => (
              <Box
                component="li"
                key={l.caseId}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                  flexWrap: 'wrap',
                  border: `1px solid ${color.border}`,
                  borderRadius: `${radius.sm}px`,
                  px: 2,
                  py: 1.5,
                }}
              >
                <Link component={RouterLink} to={`/cases/${l.caseId}`} sx={{ fontFamily: font.mono, fontSize: 13 }}>
                  {l.caseReference || `Case ${l.caseId}`}
                </Link>
                <StatusBadge dictionary={CASE_STATE} value={l.lifecycleState} size="small" />
              </Box>
            ))}
          </Box>
        ) : (
          <EmptyState title="Not currently linked to a case" dense>
            Escalating this Finding during triage is what creates or joins a case.
          </EmptyState>
        )}
      </Panel>
    </>
  )
}

export default FindingDetail
