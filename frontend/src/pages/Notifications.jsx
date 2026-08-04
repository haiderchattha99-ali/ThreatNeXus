import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
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
import { FiRefreshCw } from 'react-icons/fi'
import toast from 'react-hot-toast'

import { notificationService } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { CAPABILITIES } from '../constants/capabilities'
import { hasCapability } from '../utils/permissions'
import {
  NOTIFICATION_STATE_COLORS,
  NOTIFICATION_STATE_LABELS,
  NOTIFICATION_STATE_OPTIONS,
  describeNotificationError,
  formatInstant,
} from '../constants/notificationWorkflow'
import { PageHeader } from '../components/ui'

// The constituent-notification workflow list (Phase 4).
//
// Every row is a real, persisted, case-bound notification. Legacy Phase 0
// notification rows are excluded by the backend's list query (they have no
// case, no revision and no approval path), so nothing here can be a row the
// workflow cannot act on — and nothing is fabricated to fill the table.
//
// Creation happens from a CASE, not from here: a notification must be built
// from that case's persisted evidence. The empty state says so rather than
// offering a "New notification" button that could not work.

const PAGE_SIZE = 25

export const Notifications = () => {
  const navigate = useNavigate()
  const { capabilities } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [data, setData] = useState({ notifications: [], total: 0, page: 1, limit: PAGE_SIZE })
  const [loading, setLoading] = useState(true)
  const [stateFilter, setStateFilter] = useState(searchParams.get('state') || '')

  // UX only. The backend re-checks each of these on every request regardless
  // of what is rendered here.
  const canExport = hasCapability(capabilities, CAPABILITIES.EXPORT_NOTIFICATIONS)
  const canReview = hasCapability(capabilities, CAPABILITIES.REVIEW_NOTIFICATIONS)

  const load = useCallback(async (state) => {
    setLoading(true)
    try {
      const params = { page: 1, limit: PAGE_SIZE }
      if (state) params.state = state
      const res = await notificationService.getNotifications(params)
      setData(res.data.data)
    } catch (error) {
      toast.error(describeNotificationError(error, 'Failed to load notifications.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(stateFilter)
  }, [load, stateFilter])

  const onFilterChange = (value) => {
    setStateFilter(value)
    setSearchParams(value ? { state: value } : {})
  }

  // Counted off the returned rows' authoritative `lifecycleState`, never off a
  // legacy status column, so the tiles can never disagree with the workflow.
  const tiles = useMemo(() => {
    const counts = { DRAFT: 0, PENDING_REVIEW: 0, APPROVED: 0, REJECTED: 0 }
    data.notifications.forEach((row) => {
      if (counts[row.lifecycleState] !== undefined) counts[row.lifecycleState] += 1
    })
    return counts
  }, [data.notifications])

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
        <PageHeader
          eyebrow="Response / constituent communications"
          title="Notifications"
          description="Drafted from persisted case evidence. ThreatNeXus never sends a message; approved artifacts are exported for manual delivery and any outcome is recorded by a person."
          sx={{ mb: 0, flex: '1 1 440px' }}
        />

        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', flex: '1 1 280px', justifyContent: { xs: 'stretch', sm: 'flex-end' }, '& .MuiTextField-root': { flex: { xs: '1 1 100%', sm: '0 0 auto' } } }}>
          <TextField
            select
            size="small"
            label="State"
            value={stateFilter}
            onChange={(event) => onFilterChange(event.target.value)}
            sx={{ minWidth: 200 }}
          >
            <MenuItem value="">All states</MenuItem>
            {NOTIFICATION_STATE_OPTIONS.map((state) => (
              <MenuItem key={state} value={state}>
                {NOTIFICATION_STATE_LABELS[state]}
              </MenuItem>
            ))}
          </TextField>
          <Button
            variant="outlined"
            startIcon={<FiRefreshCw />}
            onClick={() => load(stateFilter)}
            data-testid="refresh"
          >
            Refresh
          </Button>
        </Box>
      </Box>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 3 }}>
        {NOTIFICATION_STATE_OPTIONS.map((state) => (
          <Card
            key={state}
            className="surface"
            sx={{ px: 2.5, py: 1.5, minWidth: 150, flex: '1 1 150px' }}
            data-testid={`tile-${state}`}
          >
            <Typography sx={{ fontSize: 12, color: '#9DAFC2' }}>
              {NOTIFICATION_STATE_LABELS[state]}
            </Typography>
            <Typography
              sx={{ fontSize: 22, fontWeight: 700, color: NOTIFICATION_STATE_COLORS[state] }}
            >
              {tiles[state]}
            </Typography>
          </Card>
        ))}
      </Box>

      <Card className="surface" sx={{ p: 0 }}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
            <CircularProgress size={28} />
          </Box>
        ) : data.notifications.length === 0 ? (
          <Box sx={{ p: 6, textAlign: 'center' }} data-testid="empty-state">
            <Typography sx={{ fontSize: 15, color: '#EAF1F9', fontWeight: 600 }}>
              No notifications yet
            </Typography>
            <Typography sx={{ fontSize: 13, color: '#9DAFC2', mt: 1 }}>
              A notification is drafted from a case, so its content comes from that case&apos;s real
              linked evidence. Open a case and use &ldquo;Draft notification&rdquo;.
            </Typography>
            <Button sx={{ mt: 2 }} variant="outlined" onClick={() => navigate('/cases')}>
              Go to cases
            </Button>
          </Box>
        ) : (
          <TableContainer sx={{ overflowX: 'auto', maxWidth: '100%' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Reference</TableCell>
                  <TableCell>Organization</TableCell>
                  <TableCell>Subject</TableCell>
                  <TableCell>State</TableCell>
                  <TableCell align="right">Rev</TableCell>
                  <TableCell align="right">Exports</TableCell>
                  <TableCell align="right">Delivery events</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.notifications.map((row) => (
                  <TableRow key={row.id} hover data-testid={`notification-row-${row.id}`}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {row.notificationReference || '—'}
                    </TableCell>
                    <TableCell>{row.organization?.name || '—'}</TableCell>
                    <TableCell sx={{ maxWidth: 320 }}>
                      {row.currentRevision?.subject || '—'}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={NOTIFICATION_STATE_LABELS[row.lifecycleState] || row.lifecycleState}
                        sx={{
                          bgcolor: `${NOTIFICATION_STATE_COLORS[row.lifecycleState]}22`,
                          color: NOTIFICATION_STATE_COLORS[row.lifecycleState],
                          fontWeight: 700,
                        }}
                        data-testid={`state-${row.id}`}
                      />
                      {/* Only shown when the SERVER says so — never inferred
                          from the state alone, because an APPROVED
                          notification that was edited afterwards is not
                          exportable and must not look like it is. */}
                      {canExport && row.exportEligible && (
                        <Chip
                          size="small"
                          label="Exportable"
                          sx={{ ml: 1, bgcolor: '#31C7B422', color: '#31C7B4', fontWeight: 700 }}
                          data-testid={`exportable-${row.id}`}
                        />
                      )}
                      {canReview && row.lifecycleState === 'PENDING_REVIEW' && (
                        <Chip
                          size="small"
                          label="Awaiting you"
                          sx={{ ml: 1, bgcolor: '#c08cff22', color: '#c08cff', fontWeight: 700 }}
                          data-testid={`awaiting-review-${row.id}`}
                        />
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {row.currentRevision?.revisionNumber ?? '—'}
                    </TableCell>
                    <TableCell align="right">{row.exportCount}</TableCell>
                    <TableCell align="right">{row.deliveryEventCount}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {formatInstant(row.createdAt)}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        onClick={() => navigate(`/notifications/${row.id}`)}
                        data-testid={`open-${row.id}`}
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
      </Card>

      {data.total > data.notifications.length && (
        <Typography sx={{ fontSize: 12, color: '#9DAFC2', mt: 2 }} data-testid="page-note">
          Showing {data.notifications.length} of {data.total}. Refine the state filter to narrow the
          list.
        </Typography>
      )}
    </Box>
  )
}

export default Notifications
