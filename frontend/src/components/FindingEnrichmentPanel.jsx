// Phase 10B — analyst-facing visibility into the Phase 10 enrichment
// orchestration read model (docs/ai/PHASE-10A1-API-CONTRACT.md,
// docs/ai/PHASE-10A2-RUNNER-CONTRACT.md). Read-only by default; the one write
// this panel performs (POST /enrichment/runs) is the same existing,
// already-authorized endpoint Phase 10A-1 shipped — no new backend route.
//
// This panel is deliberately SEPARATE from FindingDetail.jsx's "IP reputation
// context" panel, which reads the legacy single-provider AbuseIPDB cache row.
// This one reads the newer six-provider orchestration summary. Neither
// replaces the other; a Finding can have evidence in one but not the other,
// and collapsing them would misattribute which pipeline produced what.
//
// ---------------------------------------------------------------------------
// The truthfulness rules this panel is careful never to break
// ---------------------------------------------------------------------------
//   - every one of the six known providers is always shown, even with no
//     evidence — an OMITTED row would be indistinguishable from "this
//     provider does not exist"
//   - NOT_REQUESTED, PENDING, SKIPPED and UNAVAILABLE never render as the same
//     look as COMPLETED; a stale COMPLETED answer additionally carries its own
//     StaleNotice rather than being shown as current
//   - `executionState` is shown up front: a request being RECORDED is never
//     presented as though it had been EXECUTED
//   - `contacted` on a "last request" item is the backend's own stored
//     boolean, rendered as-is — this component never infers it from a status
//   - a policy-skipped item (decision !== ELIGIBLE) shows "—" for contacted,
//     never "Not yet", because it was never going to be attempted
//
// Request/refresh actions are the ONLY writes/reads this panel triggers, and
// both are explicit analyst actions — nothing here polls or auto-triggers a
// provider call.

import React, { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Button,
  TextField,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from '@mui/material'
import { FiSend, FiRefreshCw } from 'react-icons/fi'
import toast from 'react-hot-toast'

import { findingEnrichmentOrchestrationService } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { CAPABILITIES } from '../constants/capabilities'
import { hasCapability } from '../utils/permissions'
import { Panel, SectionLabel } from './ui/Panel'
import { StatusBadge } from './ui/StatusBadge'
import { LoadingState, ErrorState, StaleNotice } from './ui/States'
import { Provenance, formatAsOf } from './ui/Metric'
import { color, type, font } from '../theme/tokens'
import {
  ENRICHMENT_SUMMARY_STATUS,
  ENRICHMENT_ITEM_DECISION,
  SKIP_REASON_LABELS,
  SUMMARY_SOURCE_LABELS,
  PROVIDER_PURPOSE_LABELS,
  PROVIDER_LABELS,
  EXECUTION_STATE_COPY,
  RUN_OUTCOME_COPY,
  formatJobState,
  describeEnrichmentError,
} from '../constants/findingEnrichment'

// One row per (provider, subject). A provider with verified CVE subjects
// (nvd) contributes one row per CVE instead of one aggregate row, so each
// answer stays attached to the exact question it answers.
function flattenProviderRows(providers) {
  const rows = []
  // eslint-disable-next-line no-restricted-syntax
  for (const p of providers || []) {
    if (Array.isArray(p.subjects) && p.subjects.length > 0) {
      // eslint-disable-next-line no-restricted-syntax
      for (const s of p.subjects) {
        rows.push({ provider: p.provider, purpose: p.purpose, ...s })
      }
    } else {
      rows.push({
        provider: p.provider,
        purpose: p.purpose,
        subjectValue: null,
        status: p.status,
        skipReason: p.skipReason,
        source: p.source,
        freshUntil: p.freshUntil,
        isStale: p.isStale,
      })
    }
  }
  return rows
}

function ProviderRow({ row }) {
  const sourceLabel = SUMMARY_SOURCE_LABELS[row.source]
  return (
    <TableRow>
      <TableCell>
        <Box sx={{ ...type.small, color: color.text, fontWeight: 600 }}>
          {PROVIDER_LABELS[row.provider] || row.provider}
        </Box>
        <Box sx={{ ...type.caption, color: color.textMuted }}>
          {PROVIDER_PURPOSE_LABELS[row.purpose] || row.purpose}
        </Box>
      </TableCell>
      <TableCell>
        {row.subjectValue ? (
          <Box sx={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted }}>
            {row.subjectValue}
          </Box>
        ) : (
          <Box sx={{ color: color.textFaint }}>—</Box>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge dictionary={ENRICHMENT_SUMMARY_STATUS} value={row.status} size="small" />
        {row.skipReason && (
          <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.5 }}>
            {SKIP_REASON_LABELS[row.skipReason] || row.skipReason}
          </Box>
        )}
        {row.isStale && (
          <StaleNotice sx={{ mt: 0.75 }}>
            This evidence is no longer fresh
            {row.freshUntil ? ` — expired ${formatAsOf(row.freshUntil)}` : ''}.
          </StaleNotice>
        )}
      </TableCell>
      <TableCell>
        <Box sx={{ ...type.caption, color: color.textFaint }}>
          {sourceLabel ? `via ${sourceLabel}` : '—'}
        </Box>
      </TableCell>
    </TableRow>
  )
}

/**
 * The Finding-scoped Phase 10 enrichment orchestration surface: what is known
 * per provider (`GET .../enrichment/summary`), and the ability to request a
 * fresh look (`POST .../enrichment/runs`, capability-gated, UX only — the
 * backend re-checks it).
 */
export function FindingEnrichmentPanel({ findingId }) {
  const { capabilities } = useAuth()
  const canTrigger = hasCapability(capabilities, CAPABILITIES.TRIGGER_FINDING_ENRICHMENT)

  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [refreshingRun, setRefreshingRun] = useState(false)
  const [lastRun, setLastRun] = useState(null)
  const [forceFormOpen, setForceFormOpen] = useState(false)
  const [justification, setJustification] = useState('')
  const [justificationError, setJustificationError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const res = await findingEnrichmentOrchestrationService.getSummary(findingId)
      setSummary(res.data?.data || null)
    } catch (error) {
      setLoadError(true)
      toast.error(describeEnrichmentError(error))
    } finally {
      setLoading(false)
    }
  }, [findingId])

  useEffect(() => {
    load()
  }, [load])

  const requestRun = async ({ force = false, reason = '' } = {}) => {
    if (requesting) return
    setRequesting(true)
    try {
      const res = force
        ? await findingEnrichmentOrchestrationService.createRun(findingId, {
            force: true,
            justification: reason,
          })
        : await findingEnrichmentOrchestrationService.createRun(findingId)
      setLastRun({
        outcome: res.data?.outcome || null,
        run: res.data?.run || null,
        items: res.data?.items || [],
      })
      if (force) {
        setForceFormOpen(false)
        setJustification('')
        setJustificationError('')
      }
      await load()
    } catch (error) {
      if (error?.response?.status === 403) {
        toast.error('You do not have access to request enrichment for this finding.')
      } else {
        toast.error(describeEnrichmentError(error))
      }
    } finally {
      setRequesting(false)
    }
  }

  const requestForcedRun = async (event) => {
    event.preventDefault()
    const reason = justification.trim()
    if (!reason) {
      setJustificationError('Enter a justification for requesting another run.')
      return
    }
    if (reason.length > 1000) {
      setJustificationError('Justification must be 1000 characters or fewer.')
      return
    }
    setJustificationError('')
    await requestRun({ force: true, reason })
  }

  const refreshRun = async () => {
    if (!lastRun?.run?.id) return
    setRefreshingRun(true)
    try {
      const res = await findingEnrichmentOrchestrationService.getRun(findingId, lastRun.run.id)
      // A GET carries no `outcome` (nothing new was requested) — keep whatever
      // this session already recorded from the POST, if any.
      setLastRun((prev) => ({
        outcome: prev?.outcome || null,
        run: res.data?.run || prev?.run || null,
        items: res.data?.items || [],
      }))
      const summaryRes = await findingEnrichmentOrchestrationService.getSummary(findingId)
      setSummary(summaryRes.data?.data || null)
    } catch (error) {
      toast.error(describeEnrichmentError(error))
    } finally {
      setRefreshingRun(false)
    }
  }

  if (loading) {
    return (
      <Panel title="Enrichment coverage" data-testid="enrichment-panel-loading">
        <LoadingState label="Loading enrichment coverage" dense />
      </Panel>
    )
  }

  if (loadError || !summary) {
    return (
      <Panel title="Enrichment coverage">
        <ErrorState onRetry={load} dense />
      </Panel>
    )
  }

  const executionCopy = EXECUTION_STATE_COPY[summary.executionState]
  const rows = flattenProviderRows(summary.providers)

  return (
    <Panel
      title="Enrichment coverage"
      description="What has actually been asked of every known provider for this finding, and what is known back. Provider evidence is context, never proof — it never creates, closes or scores a finding by itself. AbuseIPDB values shown in the reputation panel above come from a separate, older pipeline and are not reflected in this table."
      data-testid="enrichment-panel"
      actions={
        canTrigger ? (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<FiSend size={13} />}
            disabled={requesting}
            onClick={() => requestRun()}
          >
            {requesting ? 'Requesting…' : 'Request enrichment'}
          </Button>
          <Button
            size="small"
            disabled={requesting}
            aria-expanded={forceFormOpen}
            onClick={() => setForceFormOpen((open) => !open)}
          >
            Run again
          </Button>
          </Box>
        ) : null
      }
    >
      {executionCopy && (
        <Box sx={{ mb: 2, ...type.caption, color: color.textMuted }} data-testid="enrichment-execution-state">
          <Box component="span" sx={{ fontWeight: 700, color: color.text }}>
            {executionCopy.label}.
          </Box>{' '}
          {executionCopy.detail}
        </Box>
      )}

      {canTrigger && forceFormOpen && (
        <Box
          component="form"
          onSubmit={requestForcedRun}
          sx={{ mb: 2, p: 1.5, border: `1px solid ${color.border}`, borderRadius: 1 }}
        >
          <SectionLabel>Request another enrichment run</SectionLabel>
          <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.5, mb: 1.25 }}>
            Run enrichment again even when fresh results would normally prevent it. Configuration,
            budget, and access controls still apply.
          </Box>
          <TextField
            fullWidth
            multiline
            minRows={2}
            size="small"
            label="Why is another run needed?"
            value={justification}
            error={Boolean(justificationError)}
            helperText={justificationError || `${justification.length}/1000 characters`}
            onChange={(event) => {
              setJustification(event.target.value)
              if (justificationError) setJustificationError('')
            }}
            slotProps={{ htmlInput: { maxLength: 1000 } }}
          />
          <Box sx={{ display: 'flex', gap: 1, mt: 1.25 }}>
            <Button type="submit" size="small" variant="contained" disabled={requesting}>
              {requesting ? 'Requesting…' : 'Request another run'}
            </Button>
            <Button
              type="button"
              size="small"
              disabled={requesting}
              onClick={() => {
                setForceFormOpen(false)
                setJustificationError('')
              }}
            >
              Cancel
            </Button>
          </Box>
        </Box>
      )}

      <TableContainer>
        <Table size="small" aria-label="Enrichment coverage by provider">
          <TableHead>
            <TableRow>
              <TableCell scope="col">Provider</TableCell>
              <TableCell scope="col">Subject</TableCell>
              <TableCell scope="col">Status</TableCell>
              <TableCell scope="col">Recorded via</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <ProviderRow key={`${row.provider}-${row.subjectValue || i}`} row={row} />
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Provenance
        source="Finding enrichment summary (stored orchestration state)"
        asOf={summary.asOf}
        sx={{ mt: 2 }}
      />

      {lastRun && (
        <Box sx={{ mt: 2.5, pt: 2, borderTop: `1px solid ${color.border}` }} data-testid="enrichment-last-run">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
            <SectionLabel>
              {lastRun.run?.force ? 'Last forced request' : 'Last request'}
              {lastRun.run ? ` — run #${lastRun.run.id}` : ''}
            </SectionLabel>
            <Button
              size="small"
              startIcon={<FiRefreshCw size={12} />}
              disabled={refreshingRun || !lastRun.run?.id}
              onClick={refreshRun}
            >
              {refreshingRun ? 'Checking status…' : 'Check status'}
            </Button>
          </Box>
          {lastRun.outcome && (
            <Box sx={{ ...type.small, color: color.textMuted, mb: 1.5 }}>
              {RUN_OUTCOME_COPY[lastRun.outcome] || lastRun.outcome}
            </Box>
          )}
          <TableContainer>
            <Table size="small" aria-label="Items recorded by the last request">
              <TableHead>
                <TableRow>
                  <TableCell scope="col">Provider</TableCell>
                  <TableCell scope="col">Decision</TableCell>
                  <TableCell scope="col">Lookup state</TableCell>
                  <TableCell scope="col">Contacted</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(lastRun.items || []).map((item, i) => (
                  <TableRow key={`${item.provider}-${item.subjectValue}-${i}`}>
                    <TableCell>
                      <Box sx={{ ...type.small, color: color.text }}>
                        {PROVIDER_LABELS[item.provider] || item.provider}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <StatusBadge dictionary={ENRICHMENT_ITEM_DECISION} value={item.decision} size="small" />
                      {item.skipReason && (
                        <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.5 }}>
                          {SKIP_REASON_LABELS[item.skipReason] || item.skipReason}
                        </Box>
                      )}
                    </TableCell>
                    <TableCell>
                      <Box sx={{ ...type.small, color: color.textMuted }}>
                        {item.decision === 'ELIGIBLE' ? formatJobState(item.lookupState) : '—'}
                      </Box>
                    </TableCell>
                    <TableCell>
                      {item.decision === 'ELIGIBLE' ? (
                        <Box
                          data-testid={`enrichment-item-contacted-${i}`}
                          sx={{ ...type.small, color: item.contacted ? color.text : color.textMuted }}
                        >
                          {item.contacted ? 'Yes' : 'Not yet'}
                        </Box>
                      ) : (
                        <Box sx={{ color: color.textFaint }} data-testid={`enrichment-item-contacted-${i}`}>
                          —
                        </Box>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      )}
    </Panel>
  )
}

export default FindingEnrichmentPanel
