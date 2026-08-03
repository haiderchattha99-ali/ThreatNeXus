import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Alert,
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
import { FiArrowLeft, FiDownload, FiRefreshCw } from 'react-icons/fi'
import toast from 'react-hot-toast'

import { notificationService } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { CAPABILITIES } from '../constants/capabilities'
import { hasCapability } from '../utils/permissions'
import {
  DELIVERY_STATUS_COLORS,
  DELIVERY_STATUS_LABELS,
  DELIVERY_STATUS_OPTIONS,
  EXPORT_FORMAT_LABELS,
  EXPORT_FORMAT_OPTIONS,
  LIFECYCLE_EVENT_LABELS,
  LIFECYCLE_REASON_LABELS,
  NOTIFICATION_STATE_COLORS,
  NOTIFICATION_STATE_LABELS,
  describeExportRefusal,
  describeNotificationError,
  formatInstant,
  shortChecksum,
} from '../constants/notificationWorkflow'
import {
  ORGANIZATION_RESPONSE_TYPES,
  RESPONSE_COLORS,
  RESPONSE_LABELS,
} from '../constants/caseWorkflow'

// The Phase 4 notification workspace.
//
// ---------------------------------------------------------------------------
// Every control is rendered from the intersection of TWO independent facts
// ---------------------------------------------------------------------------
// `permittedActions`, which the backend derives from the notification's
// DURABLE STATE alone and which says nothing about the caller, and the
// caller's own capability list. Both must allow an action for its control to
// appear.
//
// This is UX ONLY. The backend re-checks the capability (route middleware) and
// the state (service) on every request regardless, so a frontend that ignored
// this block entirely could still not perform a disallowed action. What it
// buys is that an analyst is never shown a button that would 409, and — more
// importantly — is never denied one that would have worked.

// Formats a Date as the value an <input type="datetime-local"> expects, in the
// browser's local timezone (not UTC — toISOString would silently shift the
// displayed instant). Same helper, same reasoning, as CaseDetail.
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

function Section({ title, subtitle, children, testId, action }) {
  return (
    <Card className="surface" sx={{ p: 3, mb: 3 }} data-testid={testId}>
      <Box
        sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', justifyContent: 'space-between' }}
      >
        <Box>
          <Typography sx={{ fontSize: 15, fontWeight: 700, color: '#e7eef9' }}>{title}</Typography>
          {subtitle && (
            <Typography sx={{ fontSize: 12, color: '#8290a5', mt: 0.5 }}>{subtitle}</Typography>
          )}
        </Box>
        {action}
      </Box>
      <Divider sx={{ my: 2, borderColor: '#233247' }} />
      {children}
    </Card>
  )
}

const EMPTY_EDIT = {
  subject: '',
  body: '',
  remediationGuidance: '',
  recipientName: '',
  analystNotes: '',
}

export const NotificationDetail = () => {
  const { id } = useParams()
  const navigate = useNavigate()
  const { capabilities } = useAuth()

  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const [edit, setEdit] = useState(EMPTY_EDIT)
  const [reviewNote, setReviewNote] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [exportFormat, setExportFormat] = useState('EML')

  const [delivery, setDelivery] = useState({
    status: 'SENT_MANUALLY',
    occurredAt: toLocalDatetimeInputValue(new Date()),
    reference: '',
    note: '',
  })

  const [response, setResponse] = useState({
    responseType: 'ACKNOWLEDGED',
    summary: '',
    reference: '',
    occurredAt: toLocalDatetimeInputValue(new Date()),
  })

  const canManage = hasCapability(capabilities, CAPABILITIES.MANAGE_NOTIFICATIONS)
  const canReview = hasCapability(capabilities, CAPABILITIES.REVIEW_NOTIFICATIONS)
  const canExport = hasCapability(capabilities, CAPABILITIES.EXPORT_NOTIFICATIONS)
  const canRecordDelivery = hasCapability(
    capabilities,
    CAPABILITIES.RECORD_NOTIFICATION_DELIVERY,
  )
  // Recording an organization response reuses the Phase 3 case capability,
  // because it is the same act on the same table as recording one from the
  // case screen.
  const canRecordResponse = hasCapability(capabilities, CAPABILITIES.MANAGE_CASES)

  // Seeds the editor from the server's current revision, so an analyst always
  // edits what is actually stored rather than a stale local copy.
  const seedEditor = useCallback((data) => {
    const current = data?.currentRevision
    setEdit({
      subject: current?.subject || '',
      body: current?.body || '',
      remediationGuidance: current?.remediationGuidance || '',
      recipientName: current?.recipientName || '',
      analystNotes: current?.analystNotes || '',
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await notificationService.getNotification(id)
      setDetail(res.data.data)
      seedEditor(res.data.data)
    } catch (error) {
      toast.error(describeNotificationError(error, 'Failed to load the notification.'))
    } finally {
      setLoading(false)
    }
  }, [id, seedEditor])

  useEffect(() => {
    load()
  }, [load])

  // Every mutation returns the full refreshed detail, so state is replaced
  // wholesale rather than patched — the screen can never render a stale
  // lifecycle state, history or permittedActions block after an action.
  const apply = (data, message) => {
    setDetail(data)
    seedEditor(data)
    if (message) toast.success(message)
  }

  const run = async (fn, successMessage, fallback) => {
    setBusy(true)
    try {
      const res = await fn()
      apply(res.data.data, successMessage)
      return res
    } catch (error) {
      toast.error(describeNotificationError(error, fallback))
      return null
    } finally {
      setBusy(false)
    }
  }

  const onSave = async () => {
    const res = await run(
      () =>
        notificationService.editRevision(id, {
          subject: edit.subject,
          body: edit.body,
          // Empty string clears an optional field; the backend normalizes
          // blank to null, so "cleared" and "absent" cannot diverge.
          remediationGuidance: edit.remediationGuidance,
          recipientName: edit.recipientName,
          analystNotes: edit.analystNotes,
        }),
      null,
      'The revision could not be saved.',
    )
    if (!res) return
    // UNCHANGED is a first-class success, reported distinctly so an analyst is
    // told their edit changed nothing rather than silently seeing no new
    // revision appear.
    if (res.data.outcome === 'UNCHANGED') {
      toast('No change — the content is identical, so no revision was created.')
    } else {
      toast.success('Revision saved.')
    }
  }

  const onExport = async () => {
    setBusy(true)
    try {
      const res = await notificationService.exportNotification(id, exportFormat)
      // The artifact is a downloaded file, never rendered into the page. No
      // network request is made by the browser beyond this one — there is no
      // mail client launch and no mailto: link anywhere in this screen.
      const disposition = res.headers['content-disposition'] || ''
      const match = /filename="([^"]+)"/.exec(disposition)
      const filename = match ? match[1] : `notification-${id}.eml`

      const url = URL.createObjectURL(res.data)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(url)

      toast.success(`Exported ${filename}. Nothing was sent — record the delivery once you send it.`)
      await load()
    } catch (error) {
      toast.error(describeNotificationError(error, 'The notification could not be exported.'))
    } finally {
      setBusy(false)
    }
  }

  const onRecordDelivery = async () => {
    const occurredAt = parseDatetimeInputValue(delivery.occurredAt)
    if (!occurredAt) {
      toast.error('Enter a valid date and time for when this was observed.')
      return
    }
    const res = await run(
      () =>
        notificationService.recordDelivery(id, {
          status: delivery.status,
          occurredAt: occurredAt.toISOString(),
          reference: delivery.reference || undefined,
          note: delivery.note || undefined,
        }),
      'Delivery event recorded.',
      'The delivery event could not be recorded.',
    )
    if (res) setDelivery((prev) => ({ ...prev, reference: '', note: '' }))
  }

  const onRecordResponse = async () => {
    const occurredAt = parseDatetimeInputValue(response.occurredAt)
    if (!occurredAt) {
      toast.error('Enter a valid date and time for when the organization responded.')
      return
    }
    const res = await run(
      () =>
        notificationService.recordResponse(id, {
          responseType: response.responseType,
          summary: response.summary,
          reference: response.reference || undefined,
          occurredAt: occurredAt.toISOString(),
        }),
      'Organization response recorded on the case.',
      'The response could not be recorded.',
    )
    if (res) setResponse((prev) => ({ ...prev, summary: '', reference: '' }))
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 8 }}>
        <CircularProgress size={30} />
      </Box>
    )
  }

  if (!detail) {
    return (
      <Box sx={{ p: 3 }}>
        <Button startIcon={<FiArrowLeft />} onClick={() => navigate('/notifications')}>
          Back to notifications
        </Button>
        <Typography sx={{ mt: 3, color: '#8290a5' }}>This notification is unavailable.</Typography>
      </Box>
    )
  }

  const { notification, currentRevision, permittedActions: actions } = detail
  const state = notification.lifecycleState
  const exportRefusal = describeExportRefusal(actions.exportRefusalCode)

  const showEditor = canManage && actions.canEdit
  const showSubmit = canManage && actions.canSubmitForReview
  const showReviewPanel = canReview && actions.canReview
  const showExport = canExport
  const showDeliveryForm = canRecordDelivery && actions.canRecordDelivery
  const showResponseForm = canRecordResponse && actions.canRecordOrganizationResponse

  return (
    <Box sx={{ p: 3 }}>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 2,
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 3,
        }}
      >
        <Box>
          <Button
            startIcon={<FiArrowLeft />}
            onClick={() => navigate('/notifications')}
            data-testid="back"
          >
            Back to notifications
          </Button>
          <Typography sx={{ fontSize: 22, fontWeight: 700, color: '#e7eef9', mt: 1 }}>
            {notification.notificationReference || `Notification ${notification.id}`}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1, flexWrap: 'wrap' }}>
            <Chip
              size="small"
              label={NOTIFICATION_STATE_LABELS[state] || state}
              sx={{
                bgcolor: `${NOTIFICATION_STATE_COLORS[state]}22`,
                color: NOTIFICATION_STATE_COLORS[state],
                fontWeight: 700,
              }}
              data-testid="lifecycle-state"
            />
            <Typography sx={{ fontSize: 13, color: '#8290a5' }}>
              {notification.organization?.name || 'Unknown organization'}
            </Typography>
            {detail.case && (
              <Button
                size="small"
                onClick={() => navigate(`/cases/${detail.case.id}`)}
                data-testid="open-case"
              >
                {detail.case.caseReference || `Case ${detail.case.id}`}
              </Button>
            )}
          </Box>
        </Box>

        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center' }}>
          <Button variant="outlined" startIcon={<FiRefreshCw />} onClick={load} data-testid="refresh">
            Refresh
          </Button>
        </Box>
      </Box>

      {/* The no-send guarantee, stated on the screen rather than only in the
          documentation. */}
      <Alert severity="info" sx={{ mb: 3 }} data-testid="no-send-banner">
        ThreatNeXus does not send messages. An approved notification is downloaded as a file and
        sent by you; delivery is only ever what you record here afterwards.
      </Alert>

      <Section
        title="Current revision"
        subtitle={
          currentRevision
            ? `Revision ${currentRevision.revisionNumber} · content fingerprint ${shortChecksum(
                currentRevision.contentChecksum,
              )}`
            : 'No current revision.'
        }
        testId="current-revision"
      >
        {currentRevision && (
          <>
            <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', mb: 2 }}>
              <Box>
                <Typography sx={{ fontSize: 11, color: '#8290a5' }}>Recipient</Typography>
                <Typography sx={{ fontSize: 13, color: '#e7eef9' }} data-testid="recipient">
                  {currentRevision.recipientName || 'Unnamed'} ·{' '}
                  {currentRevision.recipientEmailMasked || 'no address'}
                </Typography>
              </Box>
              <Box>
                <Typography sx={{ fontSize: 11, color: '#8290a5' }}>Approved</Typography>
                <Typography sx={{ fontSize: 13, color: '#e7eef9' }} data-testid="approval-summary">
                  {actions.approvedForCurrentRevision
                    ? `Yes — for this exact revision, ${formatInstant(notification.approvedAt)}`
                    : 'Not for this revision'}
                </Typography>
              </Box>
            </Box>

            {showEditor ? (
              <Box sx={{ display: 'grid', gap: 2 }} data-testid="editor">
                <TextField
                  label="Subject"
                  size="small"
                  value={edit.subject}
                  onChange={(e) => setEdit({ ...edit, subject: e.target.value })}
                  slotProps={{ htmlInput: { 'data-testid': 'edit-subject', maxLength: 200 } }}
                />
                <TextField
                  label="Body"
                  size="small"
                  multiline
                  minRows={10}
                  value={edit.body}
                  onChange={(e) => setEdit({ ...edit, body: e.target.value })}
                  slotProps={{ htmlInput: { 'data-testid': 'edit-body' } }}
                />
                <TextField
                  label="Remediation guidance"
                  size="small"
                  multiline
                  minRows={5}
                  value={edit.remediationGuidance}
                  onChange={(e) => setEdit({ ...edit, remediationGuidance: e.target.value })}
                  slotProps={{ htmlInput: { 'data-testid': 'edit-guidance' } }}
                />
                <TextField
                  label="Recipient name"
                  size="small"
                  value={edit.recipientName}
                  onChange={(e) => setEdit({ ...edit, recipientName: e.target.value })}
                  slotProps={{ htmlInput: { 'data-testid': 'edit-recipient-name', maxLength: 200 } }}
                />
                <TextField
                  label="Internal analyst notes (never exported)"
                  size="small"
                  multiline
                  minRows={3}
                  value={edit.analystNotes}
                  onChange={(e) => setEdit({ ...edit, analystNotes: e.target.value })}
                  slotProps={{ htmlInput: { 'data-testid': 'edit-notes' } }}
                  helperText="Visible to analysts and reviewers only. Never included in an export."
                />
                <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                  <Button
                    variant="contained"
                    disabled={busy}
                    onClick={onSave}
                    data-testid="save-revision"
                  >
                    Save revision
                  </Button>
                  {showSubmit && (
                    <Button
                      variant="outlined"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () => notificationService.submitForReview(id),
                          'Submitted for review.',
                          'It could not be submitted for review.',
                        )
                      }
                      data-testid="submit-for-review"
                    >
                      Submit for review
                    </Button>
                  )}
                </Box>
                {state === 'APPROVED' && (
                  <Alert severity="warning" data-testid="edit-invalidates-approval">
                    Saving a change to an approved notification creates a new draft revision and
                    withdraws the approval. It will need to be reviewed again before it can be
                    exported.
                  </Alert>
                )}
              </Box>
            ) : (
              <Box data-testid="read-only-content">
                <Typography sx={{ fontSize: 13, fontWeight: 700, color: '#e7eef9' }}>
                  {currentRevision.subject}
                </Typography>
                <Typography
                  component="pre"
                  sx={{
                    fontSize: 12.5,
                    color: '#c4d0e0',
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'inherit',
                    mt: 1.5,
                  }}
                >
                  {currentRevision.body}
                </Typography>
                {currentRevision.remediationGuidance && (
                  <Typography
                    component="pre"
                    sx={{
                      fontSize: 12.5,
                      color: '#c4d0e0',
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'inherit',
                      mt: 2,
                    }}
                  >
                    {currentRevision.remediationGuidance}
                  </Typography>
                )}
                {currentRevision.analystNotes && (
                  <Box sx={{ mt: 2, p: 1.5, borderRadius: 1, bgcolor: '#1a2536' }}>
                    <Typography sx={{ fontSize: 11, color: '#8290a5' }}>
                      Internal analyst notes — never exported
                    </Typography>
                    <Typography sx={{ fontSize: 12.5, color: '#c4d0e0' }}>
                      {currentRevision.analystNotes}
                    </Typography>
                  </Box>
                )}
              </Box>
            )}
          </>
        )}
      </Section>

      {showReviewPanel && (
        <Section
          title="Reviewer decision"
          subtitle="You are deciding on the exact revision shown above. An approval is bound to it and does not carry over to a later edit."
          testId="review-panel"
        >
          <Box sx={{ display: 'grid', gap: 2 }}>
            <TextField
              label="Review note (optional, recorded on the approval)"
              size="small"
              multiline
              minRows={2}
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              slotProps={{ htmlInput: { 'data-testid': 'review-note' } }}
            />
            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
              <Button
                variant="contained"
                disabled={busy}
                onClick={() =>
                  run(
                    () => notificationService.approve(id, reviewNote || undefined),
                    'Approved for this revision.',
                    'The notification could not be approved.',
                  ).then((res) => {
                    if (res) setReviewNote('')
                  })
                }
                data-testid="approve"
              >
                Approve
              </Button>
            </Box>
            <Divider sx={{ borderColor: '#233247' }} />
            <TextField
              label="Rejection reason (required)"
              size="small"
              multiline
              minRows={2}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              slotProps={{ htmlInput: { 'data-testid': 'reject-reason' } }}
              helperText="Sending a notification back without saying why leaves the analyst nothing to act on."
            />
            <Box>
              <Button
                variant="outlined"
                color="error"
                disabled={busy || rejectReason.trim() === ''}
                onClick={() =>
                  run(
                    () => notificationService.reject(id, rejectReason),
                    'Rejected and returned to the analyst.',
                    'The notification could not be rejected.',
                  ).then((res) => {
                    if (res) setRejectReason('')
                  })
                }
                data-testid="reject"
              >
                Reject
              </Button>
            </Box>
          </Box>
        </Section>
      )}

      {showExport && (
        <Section
          title="Manual export"
          subtitle="Downloads the approved revision as a file. Nothing is transmitted."
          testId="export-panel"
        >
          <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <TextField
              select
              size="small"
              label="Format"
              value={exportFormat}
              onChange={(e) => setExportFormat(e.target.value)}
              sx={{ minWidth: 220 }}
            >
              {EXPORT_FORMAT_OPTIONS.map((format) => (
                <MenuItem key={format} value={format}>
                  {EXPORT_FORMAT_LABELS[format]}
                </MenuItem>
              ))}
            </TextField>
            <Button
              variant="contained"
              startIcon={<FiDownload />}
              // Disabled from the SERVER's eligibility answer, not from the
              // state alone.
              disabled={busy || !actions.canExport}
              onClick={onExport}
              data-testid="export-button"
            >
              Export approved revision
            </Button>
          </Box>
          {exportRefusal && (
            <Alert severity="warning" sx={{ mt: 2 }} data-testid="export-refusal">
              {exportRefusal}
            </Alert>
          )}
        </Section>
      )}

      <Section
        title="Export history"
        subtitle="Every download is a recorded act. Exporting is not delivery."
        testId="export-history"
      >
        {detail.exports.length === 0 ? (
          <Typography sx={{ fontSize: 13, color: '#8290a5' }}>
            This notification has never been exported.
          </Typography>
        ) : (
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Exported</TableCell>
                  <TableCell align="right">Rev</TableCell>
                  <TableCell>Format</TableCell>
                  <TableCell>Filename</TableCell>
                  <TableCell>Artifact fingerprint</TableCell>
                  <TableCell align="right">Bytes</TableCell>
                  <TableCell>By</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {detail.exports.map((row) => (
                  <TableRow key={row.id} data-testid={`export-${row.id}`}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {formatInstant(row.exportedAt)}
                    </TableCell>
                    <TableCell align="right">{row.revisionNumber ?? '—'}</TableCell>
                    <TableCell>{row.format}</TableCell>
                    <TableCell>{row.filename}</TableCell>
                    <TableCell>{shortChecksum(row.artifactChecksum)}</TableCell>
                    <TableCell align="right">{row.artifactByteLength}</TableCell>
                    <TableCell>{row.exportedBy?.name || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Section>

      <Section
        title="Delivery timeline"
        subtitle="What a human observed after sending the exported file. Nothing here is ever inferred."
        testId="delivery-timeline"
      >
        {showDeliveryForm && (
          <Box sx={{ display: 'grid', gap: 2, mb: 3 }} data-testid="delivery-form">
            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
              <TextField
                select
                size="small"
                label="What happened"
                value={delivery.status}
                onChange={(e) => setDelivery({ ...delivery, status: e.target.value })}
                sx={{ minWidth: 200 }}
              >
                {DELIVERY_STATUS_OPTIONS.map((status) => (
                  <MenuItem key={status} value={status}>
                    {DELIVERY_STATUS_LABELS[status]}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                type="datetime-local"
                label="When it happened"
                value={delivery.occurredAt}
                onChange={(e) => setDelivery({ ...delivery, occurredAt: e.target.value })}
                slotProps={{ inputLabel: { shrink: true }, htmlInput: { 'data-testid': 'delivery-occurred-at' } }}
                error={parseDatetimeInputValue(delivery.occurredAt) === null}
                helperText={
                  parseDatetimeInputValue(delivery.occurredAt) === null
                    ? 'Enter a valid date and time.'
                    : 'When you observed it, not when you are recording it.'
                }
              />
              <TextField
                size="small"
                label="Reference (optional)"
                value={delivery.reference}
                onChange={(e) => setDelivery({ ...delivery, reference: e.target.value })}
                slotProps={{ htmlInput: { 'data-testid': 'delivery-reference', maxLength: 256 } }}
              />
            </Box>
            <TextField
              size="small"
              label="Note (optional)"
              multiline
              minRows={2}
              value={delivery.note}
              onChange={(e) => setDelivery({ ...delivery, note: e.target.value })}
              slotProps={{ htmlInput: { 'data-testid': 'delivery-note' } }}
            />
            <Box>
              <Button
                variant="contained"
                disabled={busy || parseDatetimeInputValue(delivery.occurredAt) === null}
                onClick={onRecordDelivery}
                data-testid="record-delivery"
              >
                Record delivery event
              </Button>
            </Box>
          </Box>
        )}

        {detail.deliveryEvents.length === 0 ? (
          <Typography sx={{ fontSize: 13, color: '#8290a5' }} data-testid="no-delivery-events">
            No delivery has been recorded. An export on its own is not evidence that anything was
            sent or received.
          </Typography>
        ) : (
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Observed</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="right">Rev</TableCell>
                  <TableCell>Reference</TableCell>
                  <TableCell>Note</TableCell>
                  <TableCell>Recorded</TableCell>
                  <TableCell>By</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {detail.deliveryEvents.map((row) => (
                  <TableRow key={row.id} data-testid={`delivery-${row.id}`}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {formatInstant(row.occurredAt)}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={DELIVERY_STATUS_LABELS[row.status] || row.status}
                        sx={{
                          bgcolor: `${DELIVERY_STATUS_COLORS[row.status]}22`,
                          color: DELIVERY_STATUS_COLORS[row.status],
                          fontWeight: 700,
                        }}
                      />
                    </TableCell>
                    <TableCell align="right">{row.revisionNumber ?? '—'}</TableCell>
                    <TableCell>{row.reference || '—'}</TableCell>
                    <TableCell sx={{ maxWidth: 280 }}>{row.note || '—'}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {formatInstant(row.recordedAt)}
                    </TableCell>
                    <TableCell>{row.recordedBy?.name || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Section>

      <Section
        title="Organization responses"
        subtitle="The case's own response timeline — the same rows the case screen shows. A response never closes anything."
        testId="response-timeline"
      >
        {showResponseForm && (
          <Box sx={{ display: 'grid', gap: 2, mb: 3 }} data-testid="response-form">
            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
              <TextField
                select
                size="small"
                label="Response"
                value={response.responseType}
                onChange={(e) => setResponse({ ...response, responseType: e.target.value })}
                sx={{ minWidth: 200 }}
              >
                {ORGANIZATION_RESPONSE_TYPES.map((type) => (
                  <MenuItem key={type} value={type}>
                    {RESPONSE_LABELS[type]}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                type="datetime-local"
                label="When they responded"
                value={response.occurredAt}
                onChange={(e) => setResponse({ ...response, occurredAt: e.target.value })}
                slotProps={{ inputLabel: { shrink: true }, htmlInput: { 'data-testid': 'response-occurred-at' } }}
                error={parseDatetimeInputValue(response.occurredAt) === null}
              />
              <TextField
                size="small"
                label="Reference (optional)"
                value={response.reference}
                onChange={(e) => setResponse({ ...response, reference: e.target.value })}
                slotProps={{ htmlInput: { 'data-testid': 'response-reference', maxLength: 256 } }}
              />
            </Box>
            <TextField
              size="small"
              label="Summary of what they said"
              multiline
              minRows={2}
              value={response.summary}
              onChange={(e) => setResponse({ ...response, summary: e.target.value })}
              slotProps={{ htmlInput: { 'data-testid': 'response-summary' } }}
            />
            <Box>
              <Button
                variant="contained"
                disabled={
                  busy ||
                  response.summary.trim() === '' ||
                  parseDatetimeInputValue(response.occurredAt) === null
                }
                onClick={onRecordResponse}
                data-testid="record-response"
              >
                Record response
              </Button>
            </Box>
          </Box>
        )}

        {detail.caseResponses.length === 0 ? (
          <Typography sx={{ fontSize: 13, color: '#8290a5' }}>
            No organization response has been recorded on this case.
          </Typography>
        ) : (
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Occurred</TableCell>
                  <TableCell>Response</TableCell>
                  <TableCell>Summary</TableCell>
                  <TableCell>Reference</TableCell>
                  <TableCell>Recorded by</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {detail.caseResponses.map((row) => (
                  <TableRow key={row.id} data-testid={`response-${row.id}`}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {formatInstant(row.occurredAt)}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={RESPONSE_LABELS[row.responseType] || row.responseType}
                        sx={{
                          bgcolor: `${RESPONSE_COLORS[row.responseType]}22`,
                          color: RESPONSE_COLORS[row.responseType],
                          fontWeight: 700,
                        }}
                      />
                    </TableCell>
                    <TableCell sx={{ maxWidth: 320 }}>{row.summary}</TableCell>
                    <TableCell>{row.reference || '—'}</TableCell>
                    <TableCell>{row.recordedBy?.name || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Section>

      <Section
        title="Revision history"
        subtitle="Immutable. A revision is never rewritten; an edit appends a new one."
        testId="revision-history"
      >
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell align="right">Rev</TableCell>
                <TableCell>Subject</TableCell>
                <TableCell>Fingerprint</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>By</TableCell>
                <TableCell>Superseded</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {detail.revisions.map((row) => (
                <TableRow key={row.id} data-testid={`revision-${row.revisionNumber}`}>
                  <TableCell align="right">
                    {row.revisionNumber}
                    {row.isCurrent && (
                      <Chip
                        size="small"
                        label="Current"
                        sx={{ ml: 1, bgcolor: '#7688ff22', color: '#7688ff', fontWeight: 700 }}
                      />
                    )}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 320 }}>{row.subject}</TableCell>
                  <TableCell>{shortChecksum(row.contentChecksum)}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatInstant(row.createdAt)}</TableCell>
                  <TableCell>{row.createdBy?.name || '—'}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {row.supersededAt ? formatInstant(row.supersededAt) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Section>

      <Section
        title="Lifecycle and review history"
        subtitle="Append-only. A rejection survives a later approval."
        testId="lifecycle-history"
      >
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>When</TableCell>
                <TableCell>Event</TableCell>
                <TableCell align="right">Rev</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell>Note</TableCell>
                <TableCell>By</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {detail.lifecycleEvents.map((row) => (
                <TableRow key={row.id} data-testid={`event-${row.id}`}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatInstant(row.occurredAt)}</TableCell>
                  <TableCell>{LIFECYCLE_EVENT_LABELS[row.eventType] || row.eventType}</TableCell>
                  <TableCell align="right">{row.revisionNumber ?? '—'}</TableCell>
                  <TableCell>{LIFECYCLE_REASON_LABELS[row.reasonCode] || row.reasonCode}</TableCell>
                  <TableCell sx={{ maxWidth: 320 }}>{row.note || '—'}</TableCell>
                  <TableCell>{row.actor?.name || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Section>
    </Box>
  )
}

export default NotificationDetail
