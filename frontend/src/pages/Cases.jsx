import React, { useCallback, useEffect, useMemo, useState } from 'react'
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

const priorityColors = {
  Critical: '#ff6678',
  High: '#ffb768',
  Medium: '#7688ff',
  Low: '#6ee7c7',
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
  const { user } = useAuth()
  const capabilities = user?.capabilities
  const canManage = hasCapability(capabilities, CAPABILITIES.MANAGE_CASES)
  const canListOrganizations = hasCapability(capabilities, CAPABILITIES.MANAGE_SYSTEM)

  const [cases, setCases] = useState([])
  const [organizations, setOrganizations] = useState([])
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

  // The organization registry is ADMIN-only (`manage:system`), so an ANALYST
  // cannot list it. Rather than fail, the picker falls back to the
  // organizations already visible on existing cases — which every role can
  // read — plus a free numeric entry for one that has no case yet.
  const fetchOrganizations = useCallback(async () => {
    if (!canListOrganizations) return
    try {
      const res = await organizationService.getOrganizations()
      setOrganizations(res.data?.data || [])
    } catch {
      setOrganizations([])
    }
  }, [canListOrganizations])

  useEffect(() => {
    fetchCases()
    fetchOrganizations()
  }, [fetchCases, fetchOrganizations])

  const organizationOptions = useMemo(() => {
    const byId = new Map()
    organizations.forEach((org) => byId.set(org.id, { id: org.id, name: org.name }))
    cases.forEach((row) => {
      if (row.ownerOrganization) {
        byId.set(row.ownerOrganization.id, {
          id: row.ownerOrganization.id,
          name: row.ownerOrganization.name,
        })
      }
    })
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [organizations, cases])

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
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 4,
          gap: 2,
          flexWrap: 'wrap',
        }}
      >
        <Box>
          <Typography className="eyebrow">Intelligence operations / cases</Typography>
          <Typography className="page-title" sx={{ mt: 1 }}>
            Investigation cases
          </Typography>
          <Typography sx={{ mt: 1, color: '#91a1b7', fontSize: 13 }}>
            Organization-bound cases, their evidence, and their closure review.
          </Typography>
        </Box>

        <Button
          startIcon={<FiRefreshCw />}
          onClick={fetchCases}
          disabled={loading}
          variant="outlined"
          sx={{ borderColor: '#33445c', color: '#b9c6d8' }}
        >
          Refresh
        </Button>
      </Box>

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
            <Typography color="#91a1b7" sx={{ fontSize: 12 }}>
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
        sx={{ p: 1.5, mb: 3, display: 'flex', gap: 1, alignItems: 'center' }}
      >
        <FiSearch color="#7688ff" />
        <TextField
          variant="standard"
          fullWidth
          placeholder="Search reference, title, organization, analyst..."
          value={search}
          onChange={handleSearchChange}
          slotProps={{ input: { disableUnderline: true, 'aria-label': 'Search cases' } }}
          sx={{ '& input': { color: '#e7eef9' } }}
        />
        {canManage && (
          <Button
            startIcon={<FiPlus />}
            variant="contained"
            onClick={() => setCreateDialog(true)}
            sx={{
              bgcolor: '#6ee7c7',
              color: '#091018',
              '&:hover': { bgcolor: '#92f0d5' },
              whiteSpace: 'nowrap',
            }}
          >
            New case
          </Button>
        )}
      </Card>

      <TableContainer component={Card} className="surface">
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
                          <Typography sx={{ fontSize: 12, color: '#8491a4' }}>
                            {item.organization} (legacy, unbound)
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={item.priority}
                          sx={{
                            bgcolor: `${priorityColors[item.priority] || '#7688ff'}20`,
                            color: priorityColors[item.priority] || '#7688ff',
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
                              bgcolor: `${CASE_STATE_COLORS[item.lifecycleState] || '#8491a4'}20`,
                              color: CASE_STATE_COLORS[item.lifecycleState] || '#8491a4',
                              fontWeight: 700,
                            }}
                          />
                          {item.reopenedByRecurrence && (
                            <Chip
                              size="small"
                              label="Reopened by recurrence"
                              data-testid={`case-recurrence-${item.id}`}
                              sx={{
                                bgcolor: '#ff879520',
                                color: '#ff8795',
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
                          sx={{ color: '#6ee7c7' }}
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
              bgcolor: '#101723',
              color: '#fff',
              minWidth: 520,
              border: '1px solid #2d3d55',
            },
          },
        }}
      >
        <DialogTitle>Create investigation case</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12, color: '#91a1b7', mb: 1.5 }}>
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
                  (org) => String(org.id) === String(e.target.value),
                )
                setFormData({
                  ...formData,
                  organizationId: e.target.value,
                  organization: selected ? selected.name : formData.organization,
                })
              }}
            >
              {organizationOptions.map((org) => (
                <MenuItem key={org.id} value={String(org.id)}>
                  {org.name}
                </MenuItem>
              ))}
            </TextField>
          ) : (
            <TextField
              margin="dense"
              fullWidth
              label="Organization id"
              helperText="No organization is visible from here yet — enter its numeric id."
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
            sx={{ bgcolor: '#6ee7c7', color: '#091018' }}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default Cases
