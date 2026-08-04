import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { FiPlus, FiRefreshCw, FiSearch, FiEye } from 'react-icons/fi'
import toast from 'react-hot-toast'

import { caseService, organizationService } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { CAPABILITIES } from '../constants/capabilities'
import { hasCapability } from '../utils/permissions'
import {
  CASE_STATE_COLORS,
  CASE_STATE_LABELS,
  describeWorkflowError,
} from '../constants/caseWorkflow'
import { PageHeader } from '../components/ui'
import { color } from '../theme/tokens'

const priorityColors = {
  Critical: '#F2617A',
  High: '#E8A33D',
  Medium: '#5AB6D9',
  Low: '#31C7B4',
}

const initialFormState = {
  title: '',
  threatType: '',
  organization: '',
  organizationId: '',
  priority: 'Medium',
  analyst: '',
  description: '',
}

/**
 * The case list.
 *
 * Reachable by EVERY role: `read:cases` is a read-only grant, and a reviewer
 * must be able to find the case whose closure they are being asked to decide.
 * Only the mutation controls are capability-gated, and only for UX — the
 * backend refuses a write from a role without `manage:cases` whether or not
 * this screen ever renders the button.
 *
 * There is deliberately no delete control. Cases are permanent records: the
 * backend's DELETE route is a tombstone that removes nothing, and a case that
 * should no longer be worked is CLOSED through the review workflow.
 */
export const Cases = () => {
  const navigate = useNavigate()
  // See FindingTriagePanel: capabilities live on the AuthContext, not on the
  // user object that GET /api/profile returns alongside them.
  const { capabilities } = useAuth()
  const canManage = hasCapability(capabilities, CAPABILITIES.MANAGE_CASES)

  const [cases, setCases] = useState([])
  const [organizationOptions, setOrganizationOptions] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(10)
  const [search, setSearch] = useState('')
  const [createDialog, setCreateDialog] = useState(false)
  const [formData, setFormData] = useState(initialFormState)

  const fetchCases = useCallback(async () => {
    try {
      setLoading(true)
      const res = await caseService.getCases()
      setCases(res.data?.data || [])
    } catch (error) {
      toast.error(describeWorkflowError(error, 'Failed to load cases'))
    } finally {
      setLoading(false)
    }
  }, [])

  // The safe, bounded organization-options endpoint (`manage:cases`, held by
  // both ADMIN and ANALYST) — unlike GET /api/organizations (`manage:system`,
  // ADMIN only), this is reachable by an analyst creating the first
  // organization-bound case, even when zero cases currently exist to derive
  // an organization from.
  const fetchOrganizationOptions = useCallback(async () => {
    if (!canManage) return
    try {
      const res = await organizationService.getOrganizationOptions()
      setOrganizationOptions(res.data?.data || [])
    } catch {
      setOrganizationOptions([])
    }
  }, [canManage])

  useEffect(() => {
    fetchCases()
    fetchOrganizationOptions()
  }, [fetchCases, fetchOrganizationOptions])

  const handleSearchChange = (event) => {
    setSearch(event.target.value)
    setPage(0)
  }

  const createCase = async () => {
    const organizationId = Number.parseInt(formData.organizationId, 10)
    if (!Number.isInteger(organizationId) || organizationId < 1) {
      toast.error('An organization is required — a case belongs to exactly one.')
      return
    }
    try {
      setCreating(true)
      await caseService.createCase({ ...formData, organizationId })
      toast.success('Case created')
      setCreateDialog(false)
      setFormData(initialFormState)
      await fetchCases()
    } catch (error) {
      toast.error(describeWorkflowError(error, 'Failed to create case'))
    } finally {
      setCreating(false)
    }
  }

  const filteredCases = cases.filter((row) => {
    const query = search.toLowerCase()
    return (
      (row.title || '').toLowerCase().includes(query) ||
      (row.caseReference || '').toLowerCase().includes(query) ||
      (row.ownerOrganization?.name || row.organization || '').toLowerCase().includes(query) ||
      (row.analyst || '').toLowerCase().includes(query) ||
      (row.threatType || '').toLowerCase().includes(query)
    )
  })

  const visibleCases = filteredCases.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)

  // Counted off the authoritative Phase 3 lifecycle state, never the legacy
  // free-text `status` column, so the tiles cannot disagree with the workflow.
  const countByState = (state) => cases.filter((row) => row.lifecycleState === state).length

  return (
    <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 1540, mx: 'auto' }}>
      <PageHeader
        eyebrow="Intelligence operations / cases"
        title="Investigation cases"
        description="Organization-bound investigations, their linked evidence and independent closure review."
        actions={<Button
          startIcon={<FiRefreshCw />}
          onClick={fetchCases}
          disabled={loading}
          variant="outlined"
          sx={{ borderColor: color.borderStrong, color: color.textMuted }}
        >
          Refresh
        </Button>}
      />

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(4, 1fr)' },
          gap: 2,
          mb: 3,
        }}
      >
        {['OPEN', 'WAITING_FOR_ORG', 'CLOSURE_PENDING', 'CLOSED'].map((state) => (
          <Card className="surface" sx={{ p: 3 }} key={state}>
            <Typography color="#9DAFC2" sx={{ fontSize: 12 }}>
              {CASE_STATE_LABELS[state]}
            </Typography>
            <Typography
              sx={{ fontSize: 34, fontWeight: 700, color: CASE_STATE_COLORS[state] }}
              data-testid={`case-count-${state}`}
            >
              {countByState(state)}
            </Typography>
          </Card>
        ))}
      </Box>

      <Card
        className="surface"
        sx={{ p: 1.5, mb: 3, display: 'flex', gap: 1, alignItems: 'center', flexWrap: { xs: 'wrap', sm: 'nowrap' } }}
      >
        <FiSearch color="#5AB6D9" />
        <TextField
          variant="standard"
          fullWidth
          placeholder="Search reference, title, organization, analyst..."
          value={search}
          onChange={handleSearchChange}
          slotProps={{ input: { disableUnderline: true, 'aria-label': 'Search cases' } }}
          sx={{ '& input': { color: '#EAF1F9' } }}
        />
        {canManage && (
          <Button
            startIcon={<FiPlus />}
            variant="contained"
            onClick={() => setCreateDialog(true)}
            sx={{
              bgcolor: '#31C7B4',
              color: '#08121B',
              '&:hover': { bgcolor: '#4FD8C6' },
              whiteSpace: 'nowrap',
            }}
          >
            New case
          </Button>
        )}
      </Card>

      <TableContainer component={Card} className="surface" sx={{ maxWidth: '100%', overflowX: 'auto' }}>
        {loading ? (
          <Box sx={{ p: 8, textAlign: 'center' }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Reference</TableCell>
                  <TableCell>Title</TableCell>
                  <TableCell>Organization</TableCell>
                  <TableCell>Priority</TableCell>
                  <TableCell>Lifecycle state</TableCell>
                  <TableCell>Evidence</TableCell>
                  <TableCell>Analyst</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visibleCases.length ? (
                  visibleCases.map((item) => (
                    <TableRow key={item.id} hover>
                      <TableCell>
                        <Typography className="mono" sx={{ fontSize: 12 }}>
                          {item.caseReference || `#${item.id}`}
                        </Typography>
                      </TableCell>
                      <TableCell>{item.title}</TableCell>
                      <TableCell>
                        {item.ownerOrganization ? (
                          item.ownerOrganization.name
                        ) : (
                          <Typography sx={{ fontSize: 12, color: '#7C8AA0' }}>
                            {item.organization} (legacy, unbound)
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={item.priority}
                          sx={{
                            bgcolor: `${priorityColors[item.priority] || '#5AB6D9'}20`,
                            color: priorityColors[item.priority] || '#5AB6D9',
                            fontWeight: 700,
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center' }}>
                          <Chip
                            size="small"
                            label={CASE_STATE_LABELS[item.lifecycleState] || item.lifecycleState}
                            data-testid={`case-state-${item.id}`}
                            sx={{
                              bgcolor: `${CASE_STATE_COLORS[item.lifecycleState] || '#7C8AA0'}20`,
                              color: CASE_STATE_COLORS[item.lifecycleState] || '#7C8AA0',
                              fontWeight: 700,
                            }}
                          />
                          {item.reopenedByRecurrence && (
                            <Chip
                              size="small"
                              label="Reopened by recurrence"
                              data-testid={`case-recurrence-${item.id}`}
                              sx={{
                                bgcolor: '#F2617A20',
                                color: '#F2617A',
                                fontWeight: 700,
                                fontSize: 10,
                              }}
                            />
                          )}
                        </Box>
                      </TableCell>
                      <TableCell>{item.linkedFindingCount ?? 0} findings</TableCell>
                      <TableCell>{item.analyst}</TableCell>
                      <TableCell align="right">
                        <Button
                          size="small"
                          startIcon={<FiEye />}
                          sx={{ color: '#31C7B4' }}
                          onClick={() => navigate(`/cases/${item.id}`)}
                        >
                          Open
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={8} align="center">
                      No cases found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

            <TablePagination
              component="div"
              count={filteredCases.length}
              page={page}
              rowsPerPage={rowsPerPage}
              rowsPerPageOptions={[5, 10, 25]}
              onPageChange={(_event, newPage) => setPage(newPage)}
              onRowsPerPageChange={(event) => {
                setRowsPerPage(+event.target.value)
                setPage(0)
              }}
            />
          </>
        )}
      </TableContainer>

      <Dialog
        open={createDialog}
        onClose={() => setCreateDialog(false)}
        slotProps={{
          paper: {
            sx: {
              bgcolor: '#111C2A',
              color: '#fff',
              minWidth: 520,
              border: '1px solid #2d3d55',
            },
          },
        }}
      >
        <DialogTitle>Create investigation case</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12, color: '#9DAFC2', mb: 1.5 }}>
            A case belongs to exactly one organization. Findings can only be linked to it when
            their resolved owner is that same organization.
          </Typography>
          <TextField
            margin="dense"
            fullWidth
            label="Case title"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
          />
          <TextField
            margin="dense"
            fullWidth
            label="Threat type"
            value={formData.threatType}
            onChange={(e) => setFormData({ ...formData, threatType: e.target.value })}
          />
          {organizationOptions.length > 0 ? (
            <TextField
              select
              margin="dense"
              fullWidth
              label="Organization"
              value={formData.organizationId}
              onChange={(e) => {
                const selected = organizationOptions.find(
                  (org) => String(org.organizationId) === String(e.target.value),
                )
                setFormData({
                  ...formData,
                  organizationId: e.target.value,
                  organization: selected ? selected.name : formData.organization,
                })
              }}
            >
              {organizationOptions.map((org) => (
                <MenuItem key={org.organizationId} value={String(org.organizationId)}>
                  {org.name}
                </MenuItem>
              ))}
            </TextField>
          ) : (
            <TextField
              margin="dense"
              fullWidth
              label="Organization id"
              helperText="No organization exists yet — enter its numeric id, or create the organization first."
              value={formData.organizationId}
              onChange={(e) => setFormData({ ...formData, organizationId: e.target.value })}
            />
          )}
          <TextField
            margin="dense"
            fullWidth
            label="Organization label"
            helperText="Free-text label preserved for pre-Phase-3 screens."
            value={formData.organization}
            onChange={(e) => setFormData({ ...formData, organization: e.target.value })}
          />
          <TextField
            margin="dense"
            fullWidth
            label="Analyst"
            value={formData.analyst}
            onChange={(e) => setFormData({ ...formData, analyst: e.target.value })}
          />
          <TextField
            select
            margin="dense"
            fullWidth
            label="Priority"
            value={formData.priority}
            onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
          >
            {['Critical', 'High', 'Medium', 'Low'].map((value) => (
              <MenuItem key={value} value={value}>
                {value}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            margin="dense"
            fullWidth
            multiline
            rows={3}
            label="Description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateDialog(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={creating}
            onClick={createCase}
            sx={{ bgcolor: '#31C7B4', color: '#08121B' }}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default Cases
