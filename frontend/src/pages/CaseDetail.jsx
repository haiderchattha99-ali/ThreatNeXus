import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Divider,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { FiArrowLeft, FiRefreshCw } from 'react-icons/fi'
import toast from 'react-hot-toast'

import { caseWorkflowService } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { CAPABILITIES } from '../constants/capabilities'
import { hasCapability } from '../utils/permissions'
import { FindingTriagePanel } from '../components/FindingTriagePanel'
import {
  CASE_STATE_COLORS,
  CASE_STATE_LABELS,
  CLOSURE_REASONS,
  CLOSURE_REASON_LABELS,
  LIFECYCLE_EVENT_LABELS,
  LIFECYCLE_REASON_LABELS,
  ORGANIZATION_RESPONSE_TYPES,
  RECURRENCE_OUTCOME_LABELS,
  REMEDIATED_CLOSURE_REQUIREMENT,
  RESPONSE_COLORS,
  RESPONSE_LABELS,
  describeWorkflowError,
  formatInstant,
} from '../constants/caseWorkflow'

function Section({ title, subtitle, children, testId }) {
  return (
    <Card className="surface" sx={{ p: 3, mb: 3 }} data-testid={testId}>
      <Typography sx={{ fontSize: 15, fontWeight: 700, color: '#e7eef9' }}>{title}</Typography>
      {subtitle && (
        <Typography sx={{ fontSize: 12, color: '#8290a5', mt: 0.5 }}>{subtitle}</Typography>
      )}
      <Divider sx={{ my: 2, borderColor: '#233247' }} />
      {children}
    </Card>
  )
}

/**
 * The complete Phase 3 workflow view of one case.
 *
 * Every control below is rendered from TWO independent facts:
 *   1. `permittedActions`, which the backend derives from the case's DURABLE
 *      STATE alone and says nothing about the caller, and
 *   2. the caller's own capability list.
 * Both must allow an action before its control appears. That is UX only — the
 * backend re-checks the capability (route middleware) and the state (service)
 * on every request regardless, so a frontend that ignored this block entirely
 * still could not perform a disallowed action.
 *
 * Every mutation replaces the whole view with what the server returns, so this
 * screen never renders a locally-guessed state.
 */
export const CaseDetail = () => {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const capabilities = user?.capabilities
  const canManage = hasCapability(capabilities, CAPABILITIES.MANAGE_CASES)
  const canReviewClosure = hasCapability(capabilities, CAPABILITIES.REVIEW_CASE_CLOSURE)

  const [view, setView] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [expandedFindingId, setExpandedFindingId] = useState(null)

  const [linkFindingId, setLinkFindingId] = useState('')
  const [stateNote, setStateNote] = useState('')
  // occurredAt is deliberately NOT collected here. It records when the
  // ORGANIZATION responded, and the backend refuses an unparseable value rather
  // than defaulting it — so until this screen has a real date control, letting
  // the server stamp the recording instant is the honest behaviour. Both
  // occurredAt and recordedAt are stored server-side and never conflated.
  const [responseForm, setResponseForm] = useState({
    responseType: 'ACKNOWLEDGED',
    summary: '',
    reference: '',
  })
  const [closureForm, setClosureForm] = useState({ closureReason: 'OTHER', justification: '' })
  const [reviewNote, setReviewNote] = useState('')
  const [reopenReason, setReopenReason] = useState('')

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const res = await caseWorkflowService.getWorkflow(id)
      setView(res.data?.data || null)
    } catch (error) {
      toast.error(describeWorkflowError(error, 'Failed to load case'))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  // Every workflow mutation returns the refreshed view; this is the single
  // place that swaps it in, so no caller can leave the screen stale.
  const run = async (action, successMessage, failureMessage) => {
    try {
      setBusy(true)
      const res = await action()
      setView(res.data?.data || null)
      toast.success(successMessage)
      return true
    } catch (error) {
      toast.error(describeWorkflowError(error, failureMessage))
      return false
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <Box sx={{ p: 8, textAlign: 'center' }}>
        <CircularProgress />
      </Box>
    )
  }

  if (!view) {
    return (
      <Box sx={{ p: { xs: 2, md: 4 } }}>
        <Typography sx={{ color: '#8290a5' }}>This case could not be loaded.</Typography>
        <Button sx={{ mt: 2, color: '#6ee7c7' }} onClick={() => navigate('/cases')}>
          Back to cases
        </Button>
      </Box>
    )
  }

  const {
    case: record,
    linkedFindings,
    lifecycleEvents,
    organizationResponses,
    closureRequests,
    pendingClosureRequest,
    recurrenceReopens,
    permittedActions,
  } = view

  const hasRemediatedResponse = organizationResponses.some((r) => r.responseType === 'REMEDIATED')
  const closureNeedsRemediation = closureForm.closureReason === 'REMEDIATED'

  return (
    <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 1540, mx: 'auto' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', mb: 3 }}>
        <Box>
          <Button
            startIcon={<FiArrowLeft />}
            onClick={() => navigate('/cases')}
            sx={{ color: '#8290a5', mb: 1 }}
          >
            All cases
          </Button>
          <Typography className="page-title">{record.title}</Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1.5, flexWrap: 'wrap' }}>
            <Typography className="mono" sx={{ fontSize: 12, color: '#9eafc5' }}>
              {record.caseReference || `#${record.id}`}
            </Typography>
            <Chip
              size="small"
              label={CASE_STATE_LABELS[record.lifecycleState] || record.lifecycleState}
              data-testid="case-lifecycle-state"
              sx={{
                bgcolor: `${CASE_STATE_COLORS[record.lifecycleState] || '#8491a4'}20`,
                color: CASE_STATE_COLORS[record.lifecycleState] || '#8491a4',
                fontWeight: 700,
              }}
            />
            {record.reopenedByRecurrence && (
              <Chip
                size="small"
                label={`Reopened by recurrence ×${record.reopenedCount}`}
                data-testid="recurrence-reopened-indicator"
                sx={{ bgcolor: '#ff879520', color: '#ff8795', fontWeight: 700 }}
              />
            )}
            {record.closureReason && (
              <Chip
                size="small"
                label={`Closed: ${CLOSURE_REASON_LABELS[record.closureReason] || record.closureReason}`}
                sx={{ bgcolor: '#8491a420', color: '#b9c6d8', fontWeight: 700 }}
              />
            )}
          </Box>
          <Typography sx={{ mt: 1.5, fontSize: 13, color: '#91a1b7' }}>
            {record.ownerOrganization
              ? `${record.ownerOrganization.name} · ${record.ownerOrganization.sector}`
              : 'Legacy case — not bound to an organization'}
            {' · '}
            {record.threatType} · {record.priority} · {record.analyst}
          </Typography>
        </Box>

        <Button
          startIcon={<FiRefreshCw />}
          onClick={load}
          variant="outlined"
          sx={{ borderColor: '#33445c', color: '#b9c6d8', alignSelf: 'flex-start' }}
        >
          Refresh
        </Button>
      </Box>

      {!permittedActions.isOrganizationBound && (
        <Card className="surface" sx={{ p: 2, mb: 3, borderColor: '#ffb768' }}>
          <Typography sx={{ color: '#ffb768', fontSize: 13 }}>
            This case predates Phase 3 and is not bound to an organization. It stays readable, and
            every workflow action is refused on it.
          </Typography>
        </Card>
      )}

      {/* ---------------- Lifecycle controls ---------------- */}
      {canManage && permittedActions.isOrganizationBound && (
        <Section
          title="Case state"
          subtitle="Only OPEN and WAITING_FOR_ORG are settable here. Closure needs a request and a reviewer; leaving CLOSED needs an explicit reopen."
          testId="state-controls"
        >
          {permittedActions.availableStates.length > 0 ? (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
              <TextField
                size="small"
                label="Note (optional)"
                value={stateNote}
                onChange={(e) => setStateNote(e.target.value)}
                sx={{ minWidth: 280 }}
              />
              {permittedActions.availableStates.map((target) => (
                <Button
                  key={target}
                  variant="outlined"
                  disabled={busy}
                  data-testid={`set-state-${target}`}
                  onClick={async () => {
                    const ok = await run(
                      () => caseWorkflowService.changeState(record.id, target, stateNote.trim()),
                      `Case moved to ${CASE_STATE_LABELS[target]}`,
                      'Failed to change case state',
                    )
                    if (ok) setStateNote('')
                  }}
                  sx={{ borderColor: '#33445c', color: '#b9c6d8' }}
                >
                  Move to {CASE_STATE_LABELS[target]}
                </Button>
              ))}
            </Box>
          ) : (
            <Typography sx={{ fontSize: 12, color: '#8290a5' }}>
              No state change is available while the case is{' '}
              {CASE_STATE_LABELS[record.lifecycleState]}.
            </Typography>
          )}

          {permittedActions.canReopen && (
            <Box sx={{ mt: 2.5, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <TextField
                size="small"
                label="Reopen reason (required)"
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                sx={{ minWidth: 320, flex: 1 }}
              />
              <Button
                variant="contained"
                disabled={busy || reopenReason.trim() === ''}
                data-testid="reopen-case"
                onClick={async () => {
                  const ok = await run(
                    () => caseWorkflowService.reopenCase(record.id, reopenReason.trim()),
                    'Case reopened',
                    'Failed to reopen case',
                  )
                  if (ok) setReopenReason('')
                }}
                sx={{ bgcolor: '#ffb768', color: '#091018' }}
              >
                Reopen case
              </Button>
            </Box>
          )}
        </Section>
      )}

      {/* ---------------- Linked findings ---------------- */}
      <Section
        title="Linked findings"
        subtitle="Evidence. Linking copies nothing — every finding stays in its own record and is read from there."
        testId="linked-findings"
      >
        {canManage && permittedActions.canLinkFindings && (
          <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
            <TextField
              size="small"
              label="Finding id"
              value={linkFindingId}
              onChange={(e) => setLinkFindingId(e.target.value)}
              sx={{ width: 160 }}
            />
            <Button
              variant="contained"
              disabled={busy || linkFindingId.trim() === ''}
              data-testid="link-finding"
              onClick={async () => {
                const findingId = Number.parseInt(linkFindingId, 10)
                if (!Number.isInteger(findingId) || findingId < 1) {
                  toast.error('Enter a numeric finding id.')
                  return
                }
                const ok = await run(
                  () => caseWorkflowService.linkFinding(record.id, findingId),
                  'Finding linked as evidence',
                  'Failed to link finding',
                )
                if (ok) setLinkFindingId('')
              }}
              sx={{ bgcolor: '#6ee7c7', color: '#091018' }}
            >
              Link finding
            </Button>
          </Box>
        )}

        {linkedFindings.length === 0 ? (
          <Typography sx={{ fontSize: 13, color: '#8290a5' }}>
            No findings are currently linked to this case.
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Indicator</TableCell>
                  <TableCell>Port</TableCell>
                  <TableCell>Exposure</TableCell>
                  <TableCell>Ownership at link</TableCell>
                  <TableCell>Linked</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {linkedFindings.map((link) => (
                  <React.Fragment key={link.id}>
                    <TableRow hover>
                      <TableCell>
                        <Typography className="mono" sx={{ fontSize: 12 }}>
                          {link.finding?.indicatorValue || `Finding ${link.findingId}`}
                        </Typography>
                        <Typography sx={{ fontSize: 10, color: '#718096' }}>
                          ID {link.findingId}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {link.finding ? `${link.finding.port}/${link.finding.protocol}` : '—'}
                      </TableCell>
                      <TableCell>{link.finding?.status || '—'}</TableCell>
                      <TableCell>
                        {link.ownershipStatusAtLink}
                        {link.ownershipConfidenceAtLink
                          ? ` · ${link.ownershipConfidenceAtLink}`
                          : ''}
                      </TableCell>
                      <TableCell>{formatInstant(link.effectiveAt)}</TableCell>
                      <TableCell align="right">
                        <Button
                          size="small"
                          sx={{ color: '#7688ff' }}
                          data-testid={`toggle-triage-${link.findingId}`}
                          onClick={() =>
                            setExpandedFindingId(
                              expandedFindingId === link.findingId ? null : link.findingId,
                            )
                          }
                        >
                          {expandedFindingId === link.findingId ? 'Hide triage' : 'Triage'}
                        </Button>
                        {canManage && permittedActions.canUnlinkFindings && (
                          <Button
                            size="small"
                            sx={{ color: '#ff8795' }}
                            disabled={busy}
                            data-testid={`unlink-finding-${link.findingId}`}
                            onClick={async () => {
                              const reason = window.prompt(
                                'Why is this finding no longer evidence in this case?',
                              )
                              if (!reason || reason.trim() === '') return
                              await run(
                                () =>
                                  caseWorkflowService.unlinkFinding(
                                    record.id,
                                    link.findingId,
                                    reason.trim(),
                                  ),
                                'Finding unlinked',
                                'Failed to unlink finding',
                              )
                            }}
                          >
                            Unlink
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    {expandedFindingId === link.findingId && (
                      <TableRow>
                        <TableCell colSpan={6} sx={{ bgcolor: 'rgba(118,136,255,.04)' }}>
                          <FindingTriagePanel findingId={link.findingId} onTriaged={load} />
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Section>

      {/* ---------------- Organization responses ---------------- */}
      <Section
        title="Organization responses"
        subtitle="What the affected organization told us. A response is a claim, never proof — none of these closes anything on its own."
        testId="organization-responses"
      >
        {canManage && permittedActions.canRecordResponse && (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2, alignItems: 'flex-start' }}>
            <TextField
              select
              size="small"
              label="Response"
              value={responseForm.responseType}
              onChange={(e) => setResponseForm({ ...responseForm, responseType: e.target.value })}
              sx={{ minWidth: 190 }}
            >
              {ORGANIZATION_RESPONSE_TYPES.map((type) => (
                <MenuItem key={type} value={type}>
                  {RESPONSE_LABELS[type]}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              size="small"
              label="Summary (required)"
              value={responseForm.summary}
              onChange={(e) => setResponseForm({ ...responseForm, summary: e.target.value })}
              sx={{ minWidth: 280, flex: 1 }}
            />
            <TextField
              size="small"
              label="Reference (optional)"
              value={responseForm.reference}
              onChange={(e) => setResponseForm({ ...responseForm, reference: e.target.value })}
              sx={{ width: 180 }}
            />
            <Button
              variant="contained"
              disabled={busy || responseForm.summary.trim() === ''}
              data-testid="record-response"
              onClick={async () => {
                const payload = {
                  responseType: responseForm.responseType,
                  summary: responseForm.summary.trim(),
                }
                if (responseForm.reference.trim()) payload.reference = responseForm.reference.trim()
                const ok = await run(
                  () => caseWorkflowService.recordResponse(record.id, payload),
                  'Organization response recorded',
                  'Failed to record response',
                )
                if (ok) {
                  setResponseForm({
                    responseType: 'ACKNOWLEDGED',
                    summary: '',
                    reference: '',
                  })
                }
              }}
              sx={{ bgcolor: '#6ee7c7', color: '#091018' }}
            >
              Record
            </Button>
          </Box>
        )}

        {organizationResponses.length === 0 ? (
          <Typography sx={{ fontSize: 13, color: '#8290a5' }}>
            No responses recorded yet. That is different from a recorded &ldquo;no response&rdquo;.
          </Typography>
        ) : (
          organizationResponses.map((response) => (
            <Box key={response.id} sx={{ mb: 1.5 }} data-testid={`response-${response.id}`}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                <Chip
                  size="small"
                  label={RESPONSE_LABELS[response.responseType] || response.responseType}
                  sx={{
                    bgcolor: `${RESPONSE_COLORS[response.responseType] || '#8491a4'}20`,
                    color: RESPONSE_COLORS[response.responseType] || '#8491a4',
                    fontWeight: 700,
                    fontSize: 10,
                  }}
                />
                <Typography sx={{ fontSize: 11, color: '#8290a5' }}>
                  {formatInstant(response.occurredAt)}
                  {response.reference ? ` · ref ${response.reference}` : ''}
                </Typography>
              </Box>
              <Typography sx={{ fontSize: 13, color: '#d6dfeb', mt: 0.5 }}>
                {response.summary}
              </Typography>
            </Box>
          ))
        )}
      </Section>

      {/* ---------------- Closure workflow ---------------- */}
      <Section
        title="Closure review"
        subtitle="Closing a case takes two people: an analyst requests, a reviewer decides. The requester may not approve their own request."
        testId="closure-workflow"
      >
        {pendingClosureRequest ? (
          <Box data-testid="pending-closure-request">
            <Typography sx={{ fontSize: 13, color: '#c08cff', fontWeight: 700 }}>
              Awaiting reviewer decision —{' '}
              {CLOSURE_REASON_LABELS[pendingClosureRequest.closureReason] ||
                pendingClosureRequest.closureReason}
            </Typography>
            <Typography sx={{ fontSize: 13, color: '#d6dfeb', mt: 1 }}>
              {pendingClosureRequest.justification}
            </Typography>
            <Typography sx={{ fontSize: 11, color: '#8290a5', mt: 0.5 }}>
              Requested {formatInstant(pendingClosureRequest.requestedAt)}
              {pendingClosureRequest.requestedBy
                ? ` by ${pendingClosureRequest.requestedBy.name}`
                : ''}
            </Typography>

            {canReviewClosure && permittedActions.canReviewClosure ? (
              <Box sx={{ mt: 2, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <TextField
                  size="small"
                  label="Review note (required to reject)"
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  sx={{ minWidth: 320, flex: 1 }}
                />
                <Button
                  variant="contained"
                  disabled={busy}
                  data-testid="approve-closure"
                  onClick={async () => {
                    const ok = await run(
                      () =>
                        caseWorkflowService.approveClosure(
                          record.id,
                          pendingClosureRequest.id,
                          reviewNote.trim(),
                        ),
                      'Closure approved — case closed',
                      'Failed to approve closure',
                    )
                    if (ok) setReviewNote('')
                  }}
                  sx={{ bgcolor: '#6ee7c7', color: '#091018' }}
                >
                  Approve closure
                </Button>
                <Button
                  variant="outlined"
                  disabled={busy || reviewNote.trim() === ''}
                  data-testid="reject-closure"
                  onClick={async () => {
                    const ok = await run(
                      () =>
                        caseWorkflowService.rejectClosure(
                          record.id,
                          pendingClosureRequest.id,
                          reviewNote.trim(),
                        ),
                      'Closure rejected — case returned to open',
                      'Failed to reject closure',
                    )
                    if (ok) setReviewNote('')
                  }}
                  sx={{ borderColor: '#ff8795', color: '#ff8795' }}
                >
                  Reject closure
                </Button>
              </Box>
            ) : (
              <Typography sx={{ fontSize: 12, color: '#8290a5', mt: 2 }}>
                A reviewer must decide this request.
              </Typography>
            )}
          </Box>
        ) : (
          canManage &&
          permittedActions.canRequestClosure && (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <TextField
                select
                size="small"
                label="Closure reason"
                value={closureForm.closureReason}
                onChange={(e) =>
                  setClosureForm({ ...closureForm, closureReason: e.target.value })
                }
                helperText={closureNeedsRemediation ? REMEDIATED_CLOSURE_REQUIREMENT : ' '}
                sx={{ minWidth: 200 }}
              >
                {CLOSURE_REASONS.map((reason) => (
                  <MenuItem key={reason} value={reason}>
                    {CLOSURE_REASON_LABELS[reason]}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                label="Justification (required)"
                value={closureForm.justification}
                onChange={(e) =>
                  setClosureForm({ ...closureForm, justification: e.target.value })
                }
                sx={{ minWidth: 320, flex: 1 }}
              />
              <Button
                variant="contained"
                disabled={
                  busy ||
                  closureForm.justification.trim() === '' ||
                  (closureNeedsRemediation && !hasRemediatedResponse)
                }
                data-testid="request-closure"
                onClick={async () => {
                  const ok = await run(
                    () =>
                      caseWorkflowService.requestClosure(record.id, {
                        closureReason: closureForm.closureReason,
                        justification: closureForm.justification.trim(),
                      }),
                    'Closure requested — awaiting reviewer',
                    'Failed to request closure',
                  )
                  if (ok) setClosureForm({ closureReason: 'OTHER', justification: '' })
                }}
                sx={{ bgcolor: '#c08cff', color: '#091018' }}
              >
                Request closure
              </Button>
            </Box>
          )
        )}

        {closureRequests.length > 0 && (
          <Box sx={{ mt: 3 }} data-testid="closure-history">
            <Typography sx={{ fontSize: 12, color: '#75849a', textTransform: 'uppercase' }}>
              Closure history
            </Typography>
            {closureRequests.map((request) => (
              <Typography key={request.id} sx={{ fontSize: 12, color: '#9eafc5', mt: 0.75 }}>
                {formatInstant(request.requestedAt)} ·{' '}
                {CLOSURE_REASON_LABELS[request.closureReason] || request.closureReason} ·{' '}
                {request.state}
                {request.reviewedAt ? ` · reviewed ${formatInstant(request.reviewedAt)}` : ''}
                {request.reviewNote ? ` — ${request.reviewNote}` : ''}
              </Typography>
            ))}
          </Box>
        )}
      </Section>

      {/* ---------------- Lifecycle timeline ---------------- */}
      <Section
        title="Lifecycle timeline"
        subtitle="Immutable. One row per accepted transition, written in the same transaction as the change it describes."
        testId="lifecycle-timeline"
      >
        {lifecycleEvents.map((event) => (
          <Box key={event.id} sx={{ mb: 1.25 }} data-testid={`lifecycle-event-${event.id}`}>
            <Typography sx={{ fontSize: 13, color: '#d6dfeb' }}>
              {LIFECYCLE_EVENT_LABELS[event.eventType] || event.eventType}
              {event.fromState ? ` · ${event.fromState} → ${event.toState}` : ` · ${event.toState}`}
            </Typography>
            <Typography sx={{ fontSize: 11, color: '#8290a5' }}>
              {formatInstant(event.occurredAt)} ·{' '}
              {LIFECYCLE_REASON_LABELS[event.reasonCode] || event.reasonCode}
              {event.actor ? ` · ${event.actor.name}` : ' · system'}
              {event.note ? ` — ${event.note}` : ''}
            </Typography>
          </Box>
        ))}
      </Section>

      {/* ---------------- Recurrence ledger ---------------- */}
      {recurrenceReopens.length > 0 && (
        <Section
          title="Recurrence evaluations"
          subtitle="Every recurrence evaluated against this case, including the ones that decided NOT to reopen it."
          testId="recurrence-ledger"
        >
          {recurrenceReopens.map((row) => (
            <Typography key={row.id} sx={{ fontSize: 12, color: '#9eafc5', mb: 0.75 }}>
              {formatInstant(row.observedAt)} · finding {row.findingId} ·{' '}
              {RECURRENCE_OUTCOME_LABELS[row.outcome] || row.outcome}
            </Typography>
          ))}
        </Section>
      )}
    </Box>
  )
}

export default CaseDetail
