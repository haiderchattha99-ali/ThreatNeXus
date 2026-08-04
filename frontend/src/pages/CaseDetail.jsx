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

import { caseWorkflowService, notificationService } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { CAPABILITIES } from '../constants/capabilities'
import { hasCapability } from '../utils/permissions'
import { FindingTriagePanel } from '../components/FindingTriagePanel'
import { FrameworkMappingPanel } from '../components/FrameworkMappingPanel'
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
import {
  NOTIFICATION_STATE_COLORS,
  NOTIFICATION_STATE_LABELS,
} from '../constants/notificationWorkflow'

// Formats a Date as the value an <input type="datetime-local"> expects, in
// the browser's local timezone (not UTC — toISOString would silently shift
// the displayed instant).
function toLocalDatetimeInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

function parseDatetimeInputValue(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function Section({ title, subtitle, children, testId }) {
  return (
    <Card className="surface" sx={{ p: 3, mb: 3 }} data-testid={testId}>
      <Typography sx={{ fontSize: 15, fontWeight: 700, color: '#EAF1F9' }}>{title}</Typography>
      {subtitle && (
        <Typography sx={{ fontSize: 12, color: '#9DAFC2', mt: 0.5 }}>{subtitle}</Typography>
      )}
      <Divider sx={{ my: 2, borderColor: '#243549' }} />
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
  // See FindingTriagePanel: capabilities live on the AuthContext, not on the
  // user object that GET /api/profile returns alongside them.
  const { capabilities } = useAuth()
  const canManage = hasCapability(capabilities, CAPABILITIES.MANAGE_CASES)
  const canReviewClosure = hasCapability(capabilities, CAPABILITIES.REVIEW_CASE_CLOSURE)
  // Phase 4 — drafting a notification is a notification-workflow grant, not a
  // case one, so it is checked separately. An ANALYST holds both; a REVIEWER
  // holds neither and sees only the read-only notification list below.
  const canReadNotifications = hasCapability(capabilities, CAPABILITIES.READ_NOTIFICATIONS)
  const canManageNotifications = hasCapability(capabilities, CAPABILITIES.MANAGE_NOTIFICATIONS)

  const [view, setView] = useState(null)
  const [notifications, setNotifications] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [expandedFindingId, setExpandedFindingId] = useState(null)

  const [linkFindingId, setLinkFindingId] = useState('')
  const [stateNote, setStateNote] = useState('')
  // occurredAt records when the ORGANIZATION responded — a real-world instant
  // the analyst knows and the server does not — and defaults to the current
  // local date/time. The backend strictly validates it and refuses an
  // unparseable value rather than silently defaulting it, so this screen
  // parses it client-side too and blocks submission on an invalid value
  // rather than letting the request round-trip to find out. recordedAt (when
  // we wrote it down) stays server-captured and is never conflated with it.
  const [responseForm, setResponseForm] = useState({
    responseType: 'ACKNOWLEDGED',
    summary: '',
    reference: '',
    occurredAt: toLocalDatetimeInputValue(new Date()),
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

  // The notifications drafted from THIS case. Loaded separately from the case
  // workflow view because it is a different capability: a caller who may read
  // the case but not notifications simply gets no list, rather than a failed
  // case load.
  const loadNotifications = useCallback(async () => {
    if (!canReadNotifications) return
    try {
      const res = await notificationService.getNotifications({ caseId: Number(id), limit: 25 })
      setNotifications(res.data?.data?.notifications || [])
    } catch {
      // Non-fatal and deliberately silent: the case screen must stay usable
      // when the notification surface is unavailable to this caller.
      setNotifications([])
    }
  }, [canReadNotifications, id])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    loadNotifications()
  }, [loadNotifications])

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
        <Typography sx={{ color: '#9DAFC2' }}>This case could not be loaded.</Typography>
        <Button sx={{ mt: 2, color: '#35C477' }} onClick={() => navigate('/cases')}>
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
            sx={{ color: '#9DAFC2', mb: 1 }}
          >
            All cases
          </Button>
          <Typography className="page-title">{record.title}</Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1.5, flexWrap: 'wrap' }}>
            <Typography className="mono" sx={{ fontSize: 12, color: '#9DAFC2' }}>
              {record.caseReference || `#${record.id}`}
            </Typography>
            <Chip
              size="small"
              label={CASE_STATE_LABELS[record.lifecycleState] || record.lifecycleState}
              data-testid="case-lifecycle-state"
              sx={{
                bgcolor: `${CASE_STATE_COLORS[record.lifecycleState] || '#7C8AA0'}20`,
                color: CASE_STATE_COLORS[record.lifecycleState] || '#7C8AA0',
                fontWeight: 700,
              }}
            />
            {record.reopenedByRecurrence && (
              <Chip
                size="small"
                label={`Reopened by recurrence ×${record.reopenedCount}`}
                data-testid="recurrence-reopened-indicator"
                sx={{ bgcolor: '#F2617A20', color: '#F2617A', fontWeight: 700 }}
              />
            )}
            {record.closureReason && (
              <Chip
                size="small"
                label={`Closed: ${CLOSURE_REASON_LABELS[record.closureReason] || record.closureReason}`}
                sx={{ bgcolor: '#7C8AA020', color: '#9DAFC2', fontWeight: 700 }}
              />
            )}
          </Box>
          <Typography sx={{ mt: 1.5, fontSize: 13, color: '#9DAFC2' }}>
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
          sx={{ borderColor: '#33485F', color: '#9DAFC2', alignSelf: 'flex-start' }}
        >
          Refresh
        </Button>
      </Box>

      {!permittedActions.isOrganizationBound && (
        <Card className="surface" sx={{ p: 2, mb: 3, borderColor: '#E8A33D' }}>
          <Typography sx={{ color: '#E8A33D', fontSize: 13 }}>
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
                  sx={{ borderColor: '#33485F', color: '#9DAFC2' }}
                >
                  Move to {CASE_STATE_LABELS[target]}
                </Button>
              ))}
            </Box>
          ) : (
            <Typography sx={{ fontSize: 12, color: '#9DAFC2' }}>
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
                sx={{ bgcolor: '#E8A33D', color: '#06100A' }}
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
              sx={{ bgcolor: '#35C477', color: '#06100A' }}
            >
              Link finding
            </Button>
          </Box>
        )}

        {linkedFindings.length === 0 ? (
          <Typography sx={{ fontSize: 13, color: '#9DAFC2' }}>
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
                        <Typography sx={{ fontSize: 10, color: '#75899E' }}>
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
                          sx={{ color: '#5AB6D9' }}
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
                            sx={{ color: '#F2617A' }}
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
      {canReadNotifications && (
        <Section
          title="Notifications"
          subtitle="Constituent notifications drafted from this case's evidence. ThreatNeXus never sends one — an approved notification is exported manually."
          testId="case-notifications"
        >
          {canManageNotifications && (
            <Box sx={{ mb: 2 }}>
              <Button
                variant="contained"
                size="small"
                disabled={busy || !permittedActions.isOrganizationBound}
                onClick={async () => {
                  setBusy(true)
                  try {
                    const res = await notificationService.createDraft(Number(id))
                    toast.success('Notification draft created from this case.')
                    navigate(`/notifications/${res.data.data.notification.id}`)
                  } catch (error) {
                    toast.error(
                      describeWorkflowError(error, 'The notification draft could not be created.'),
                    )
                  } finally {
                    setBusy(false)
                  }
                }}
                data-testid="draft-notification"
              >
                Draft notification
              </Button>
              {!permittedActions.isOrganizationBound && (
                <Typography sx={{ fontSize: 12, color: '#9DAFC2', mt: 1 }}>
                  This legacy case has no organization, so a notification cannot be addressed from
                  it.
                </Typography>
              )}
            </Box>
          )}

          {notifications.length === 0 ? (
            <Typography sx={{ fontSize: 13, color: '#9DAFC2' }} data-testid="no-case-notifications">
              No notification has been drafted from this case.
            </Typography>
          ) : (
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Reference</TableCell>
                    <TableCell>Subject</TableCell>
                    <TableCell>State</TableCell>
                    <TableCell align="right">Rev</TableCell>
                    <TableCell align="right">Exports</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {notifications.map((row) => (
                    <TableRow key={row.id} data-testid={`case-notification-${row.id}`}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {row.notificationReference || '—'}
                      </TableCell>
                      <TableCell sx={{ maxWidth: 280 }}>
                        {row.currentRevision?.subject || '—'}
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={
                            NOTIFICATION_STATE_LABELS[row.lifecycleState] || row.lifecycleState
                          }
                          sx={{
                            bgcolor: `${NOTIFICATION_STATE_COLORS[row.lifecycleState]}22`,
                            color: NOTIFICATION_STATE_COLORS[row.lifecycleState],
                            fontWeight: 700,
                          }}
                        />
                      </TableCell>
                      <TableCell align="right">
                        {row.currentRevision?.revisionNumber ?? '—'}
                      </TableCell>
                      <TableCell align="right">{row.exportCount}</TableCell>
                      <TableCell align="right">
                        <Button
                          size="small"
                          onClick={() => navigate(`/notifications/${row.id}`)}
                          data-testid={`open-notification-${row.id}`}
                        >
                          Open
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Section>
      )}

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
            <TextField
              size="small"
              type="datetime-local"
              label="Occurred at"
              data-testid="response-occurred-at"
              value={responseForm.occurredAt}
              onChange={(e) => setResponseForm({ ...responseForm, occurredAt: e.target.value })}
              error={parseDatetimeInputValue(responseForm.occurredAt) === null}
              helperText={
                parseDatetimeInputValue(responseForm.occurredAt) === null
                  ? 'Enter a valid date and time.'
                  : ' '
              }
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ minWidth: 210 }}
            />
            <Button
              variant="contained"
              disabled={
                busy ||
                responseForm.summary.trim() === '' ||
                parseDatetimeInputValue(responseForm.occurredAt) === null
              }
              data-testid="record-response"
              onClick={async () => {
                const occurredAt = parseDatetimeInputValue(responseForm.occurredAt)
                if (occurredAt === null) {
                  toast.error('Enter a valid response date and time.')
                  return
                }
                const payload = {
                  responseType: responseForm.responseType,
                  summary: responseForm.summary.trim(),
                  occurredAt: occurredAt.toISOString(),
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
                    occurredAt: toLocalDatetimeInputValue(new Date()),
                  })
                }
              }}
              sx={{ bgcolor: '#35C477', color: '#06100A' }}
            >
              Record
            </Button>
          </Box>
        )}

        {organizationResponses.length === 0 ? (
          <Typography sx={{ fontSize: 13, color: '#9DAFC2' }}>
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
                    bgcolor: `${RESPONSE_COLORS[response.responseType] || '#7C8AA0'}20`,
                    color: RESPONSE_COLORS[response.responseType] || '#7C8AA0',
                    fontWeight: 700,
                    fontSize: 10,
                  }}
                />
                <Typography sx={{ fontSize: 11, color: '#9DAFC2' }}>
                  {formatInstant(response.occurredAt)}
                  {response.reference ? ` · ref ${response.reference}` : ''}
                </Typography>
              </Box>
              <Typography sx={{ fontSize: 13, color: '#EAF1F9', mt: 0.5 }}>
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
            <Typography sx={{ fontSize: 13, color: '#EAF1F9', mt: 1 }}>
              {pendingClosureRequest.justification}
            </Typography>
            <Typography sx={{ fontSize: 11, color: '#9DAFC2', mt: 0.5 }}>
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
                  sx={{ bgcolor: '#35C477', color: '#06100A' }}
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
                  sx={{ borderColor: '#F2617A', color: '#F2617A' }}
                >
                  Reject closure
                </Button>
              </Box>
            ) : (
              <Typography sx={{ fontSize: 12, color: '#9DAFC2', mt: 2 }}>
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
                sx={{ bgcolor: '#c08cff', color: '#06100A' }}
              >
                Request closure
              </Button>
            </Box>
          )
        )}

        {closureRequests.length > 0 && (
          <Box sx={{ mt: 3 }} data-testid="closure-history">
            <Typography sx={{ fontSize: 12, color: '#75899E', textTransform: 'uppercase' }}>
              Closure history
            </Typography>
            {closureRequests.map((request) => (
              <Typography key={request.id} sx={{ fontSize: 12, color: '#9DAFC2', mt: 0.75 }}>
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

      {/* ---------------- Phase 5: framework mapping workspace ---------------- */}
      {/* Placed after the evidence and response sections and before the
          timeline: a framework mapping is a judgement made ABOUT the evidence
          above it, and it should be read after that evidence rather than
          before. The panel fetches its own data and renders its own capability
          gates, so this screen neither knows nor decides who may map what. */}
      <Section
        title="Framework mapping"
        subtitle="Analyst-associated framework context for this case. Not a compliance determination."
        testId="framework-mapping-section"
      >
        <FrameworkMappingPanel caseId={id} />
      </Section>

      {/* ---------------- Lifecycle timeline ---------------- */}
      <Section
        title="Lifecycle timeline"
        subtitle="Immutable. One row per accepted transition, written in the same transaction as the change it describes."
        testId="lifecycle-timeline"
      >
        {lifecycleEvents.map((event) => (
          <Box key={event.id} sx={{ mb: 1.25 }} data-testid={`lifecycle-event-${event.id}`}>
            <Typography sx={{ fontSize: 13, color: '#EAF1F9' }}>
              {LIFECYCLE_EVENT_LABELS[event.eventType] || event.eventType}
              {event.fromState ? ` · ${event.fromState} → ${event.toState}` : ` · ${event.toState}`}
            </Typography>
            <Typography sx={{ fontSize: 11, color: '#9DAFC2' }}>
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
            <Typography key={row.id} sx={{ fontSize: 12, color: '#9DAFC2', mb: 0.75 }}>
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
