import React, { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material'
import toast from 'react-hot-toast'

import { findingTriageService } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { CAPABILITIES } from '../constants/capabilities'
import { hasCapability } from '../utils/permissions'
import {
  TRIAGE_COLORS,
  TRIAGE_DECISION_OPTIONS,
  TRIAGE_DECISIONS_REQUIRING_REASON,
  TRIAGE_LABELS,
  describeWorkflowError,
  formatInstant,
} from '../constants/caseWorkflow'

/**
 * The current triage state of one Finding, its append-only decision history,
 * and the triage actions the caller is permitted to take.
 *
 * Triage is deliberately SEPARATE from the Finding's OPEN/CLOSED exposure
 * state, and this panel never displays one as the other: a Finding can be OPEN
 * and DISMISSED (we looked, we are not pursuing it) or CLOSED and ESCALATED (it
 * stopped being observed while an investigation is live).
 *
 * The action controls are hidden without `triage:findings`. That is UX only —
 * the backend refuses the request regardless of what is rendered here.
 */
export function FindingTriagePanel({ findingId, onTriaged }) {
  const { user } = useAuth()
  const capabilities = user?.capabilities
  const canTriage = hasCapability(capabilities, CAPABILITIES.TRIAGE_FINDINGS)

  const [context, setContext] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [decision, setDecision] = useState('IN_REVIEW')
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const res = await findingTriageService.getTriage(findingId)
      setContext(res.data?.data || null)
    } catch (error) {
      toast.error(describeWorkflowError(error, 'Failed to load triage'))
    } finally {
      setLoading(false)
    }
  }, [findingId])

  useEffect(() => {
    load()
  }, [load])

  const reasonRequired = TRIAGE_DECISIONS_REQUIRING_REASON.includes(decision)

  const submit = async () => {
    try {
      setSaving(true)
      const res = await findingTriageService.updateTriage(findingId, decision, reason.trim())
      setContext(res.data?.data || null)
      setReason('')
      toast.success('Triage decision recorded')
      if (onTriaged) onTriaged()
    } catch (error) {
      toast.error(describeWorkflowError(error, 'Failed to record triage'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Box sx={{ py: 3, textAlign: 'center' }} data-testid="triage-loading">
        <CircularProgress size={20} />
      </Box>
    )
  }

  if (!context) {
    return (
      <Typography sx={{ color: '#7b899c', fontSize: 12 }}>Triage unavailable.</Typography>
    )
  }

  const current = context.decision || 'UNTRIAGED'

  return (
    <Box sx={{ py: 1 }} data-testid={`triage-panel-${findingId}`}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: 11, color: '#75849a', textTransform: 'uppercase' }}>
          Triage
        </Typography>
        <Chip
          size="small"
          label={TRIAGE_LABELS[current] || current}
          data-testid={`triage-state-${findingId}`}
          sx={{
            bgcolor: `${TRIAGE_COLORS[current] || '#8491a4'}22`,
            color: TRIAGE_COLORS[current] || '#8491a4',
            fontWeight: 700,
            fontSize: 10,
          }}
        />
        {context.ownership ? (
          <Typography sx={{ fontSize: 11, color: '#7b899c' }}>
            Ownership: {context.ownership.status}
            {context.ownership.isIspAttribution ? ' (ISP-attributed)' : ''}
          </Typography>
        ) : (
          <Typography sx={{ fontSize: 11, color: '#7b899c' }}>Ownership: not resolved</Typography>
        )}
      </Box>

      {context.linkedCases?.length > 0 && (
        <Typography sx={{ mt: 1, fontSize: 11, color: '#9eafc5' }}>
          Evidence in{' '}
          {context.linkedCases.map((c) => c.caseReference || `case ${c.id}`).join(', ')}
        </Typography>
      )}

      {context.history?.length > 0 && (
        <Box sx={{ mt: 1.5 }} data-testid={`triage-history-${findingId}`}>
          {context.history.map((row) => (
            <Typography key={row.id} sx={{ fontSize: 11, color: '#8290a5', mt: 0.4 }}>
              {formatInstant(row.decidedAt)} · {TRIAGE_LABELS[row.decision] || row.decision} ·{' '}
              {row.source}
              {row.isCurrent ? ' · current' : ''}
              {row.reason ? ` — ${row.reason}` : ''}
            </Typography>
          ))}
        </Box>
      )}

      {canTriage && (
        <Box sx={{ mt: 2, display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <TextField
            select
            size="small"
            label="Decision"
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
            sx={{ minWidth: 160 }}
            slotProps={{ htmlInput: { 'aria-label': 'Triage decision' } }}
          >
            {TRIAGE_DECISION_OPTIONS.map((option) => (
              <MenuItem key={option} value={option}>
                {TRIAGE_LABELS[option]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label={reasonRequired ? 'Reason (required)' : 'Reason (optional)'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            sx={{ minWidth: 260, flex: 1 }}
          />
          <Button
            variant="contained"
            disabled={saving || (reasonRequired && reason.trim() === '')}
            onClick={submit}
            sx={{ bgcolor: '#6ee7c7', color: '#091018', '&:hover': { bgcolor: '#92f0d5' } }}
          >
            Record triage
          </Button>
        </Box>
      )}
    </Box>
  )
}

export default FindingTriagePanel
