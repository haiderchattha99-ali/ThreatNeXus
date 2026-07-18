import React, { useState, useEffect } from 'react'
import {
  Box,
  TextField,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip,
  Typography,
  Card,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  CircularProgress,
} from '@mui/material'
import { threatService } from '../services/api'
import toast from 'react-hot-toast'
import { FiTrash2, FiRefreshCw } from 'react-icons/fi'

const severityColors = {
  Critical: '#f85149',
  High: '#d29922',
  Medium: '#58a6ff',
  Low: '#3fb950',
}

const statusColors = {
  New: '#58a6ff',
  Analyzing: '#d29922',
  Resolved: '#3fb950',
  Dismissed: '#6e7681',
}

export const Threats = () => {
  const [threats, setThreats] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(10)
  const [deleteDialog, setDeleteDialog] = useState({ open: false, threat: null })
  const [statusDialog, setStatusDialog] = useState({ open: false, threat: null })
  const [newStatus, setNewStatus] = useState('')

  const statuses = ['New', 'Analyzing', 'Resolved', 'Dismissed']

  useEffect(() => {
    fetchThreats()
  }, [])

  const fetchThreats = async () => {
    try {
      setLoading(true)
      const response = await threatService.getThreats()
      console.log("Threat API:", JSON.stringify(response.data, null, 2))
      console.log("Threat API:", JSON.stringify(response.data, null, 2))
      setThreats(response.data.data || [])
    } catch (error) {
      toast.error('Failed to load threats')
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      fetchThreats()
      return
    }

    try {
      setLoading(true)
      const response = await threatService.searchThreats(searchQuery)
      setThreats(response.data.data || [])
      setPage(0)
    } catch (error) {
      toast.error('Search failed')
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteClick = (threat) => {
    setDeleteDialog({ open: true, threat })
  }

  const handleDeleteConfirm = async () => {
    try {
      await threatService.deleteThreat(deleteDialog.threat.id)
      toast.success('Threat deleted')
      setDeleteDialog({ open: false, threat: null })
      fetchThreats()
    } catch (error) {
      toast.error('Failed to delete threat')
    }
  }

  const handleStatusClick = (threat) => {
    setStatusDialog({ open: true, threat })
    setNewStatus(threat.status || 'New')
  }

  const handleStatusChange = async () => {
    try {
      await threatService.updateThreatStatus(statusDialog.threat.id, newStatus)
      toast.success('Status updated')
      setStatusDialog({ open: false, threat: null })
      fetchThreats()
    } catch (error) {
      toast.error('Failed to update status')
    }
  }

  const handleChangePage = (event, newPage) => {
    setPage(newPage)
  }

  const handleChangeRowsPerPage = (event) => {
    setRowsPerPage(parseInt(event.target.value, 10))
    setPage(0)
  }

  const paginatedThreats = threats.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h3" sx={{ color: '#58a6ff' }}>
          Threat Management
        </Typography>
        <Button
          startIcon={<FiRefreshCw />}
          variant="outlined"
          onClick={fetchThreats}
          disabled={loading}
        >
          Refresh
        </Button>
      </Box>

      {/* Search Bar */}
      <Card sx={{ backgroundColor: '#161b22', p: 2, mb: 3 }}>
        <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
          <TextField
            fullWidth
            placeholder="Search threats..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            sx={{ flexGrow: 1 }}
          />
          <Button
            variant="contained"
            sx={{
              backgroundColor: '#58a6ff',
              color: '#0d1117',
              '&:hover': { backgroundColor: '#1f6feb' },
            }}
            onClick={handleSearch}
            disabled={loading}
          >
            Search
          </Button>
        </Box>
      </Card>

      {/* Threats Table */}
      {loading && !threats.length ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <TableContainer component={Card} sx={{ backgroundColor: '#161b22' }}>
          <Table>
            <TableHead>
              <TableRow sx={{ backgroundColor: 'rgba(88, 166, 255, 0.1)' }}>
                <TableCell sx={{ color: '#58a6ff', fontWeight: 'bold' }}>ID</TableCell>
                <TableCell sx={{ color: '#58a6ff', fontWeight: 'bold' }}>Name</TableCell>
                <TableCell sx={{ color: '#58a6ff', fontWeight: 'bold' }}>Severity</TableCell>
                <TableCell sx={{ color: '#58a6ff', fontWeight: 'bold' }}>Status</TableCell>
                <TableCell sx={{ color: '#58a6ff', fontWeight: 'bold' }}>Risk Score</TableCell>
                <TableCell sx={{ color: '#58a6ff', fontWeight: 'bold' }} align="center">
                  Actions
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {paginatedThreats.length > 0 ? (
                paginatedThreats.map((threat) => (
                  <TableRow
                    key={threat.id}
                    sx={{
                      '&:hover': { backgroundColor: 'rgba(88, 166, 255, 0.05)' },
                      borderBottom: '1px solid rgba(88, 166, 255, 0.1)',
                    }}
                  >
                    <TableCell>{threat.id}</TableCell>
                    <TableCell>
  {threat.iocType === "IPv4"
    ? threat.ip
    : threat.iocType === "Domain"
    ? threat.domain
    : threat.hash}
</TableCell>
                    <TableCell>
                      <Chip
                        label={threat.severity}
                        sx={{
                          backgroundColor: severityColors[threat.severity] || '#58a6ff',
                          color: '#0d1117',
                          fontWeight: 'bold',
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={threat.status}
                        sx={{
                          backgroundColor: statusColors[threat.status] || '#6e7681',
                          color: threat.status === 'Dismissed' ? '#ffffff' : '#0d1117',
                          fontWeight: 'bold',
                          cursor: 'pointer',
                        }}
                        onClick={() => handleStatusClick(threat)}
                      />
                    </TableCell>
                    <TableCell>{threat.riskScore}</TableCell>
                    <TableCell align="center">
                      <Button
                        size="small"
                        startIcon={<FiTrash2 />}
                        sx={{ color: '#f85149' }}
                        onClick={() => handleDeleteClick(threat)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 3 }}>
                    <Typography color="textSecondary">No threats found</Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <TablePagination
            rowsPerPageOptions={[5, 10, 25]}
            component="div"
            count={threats.length}
            rowsPerPage={rowsPerPage}
            page={page}
            onPageChange={handleChangePage}
            onRowsPerPageChange={handleChangeRowsPerPage}
            sx={{
              borderTop: '1px solid rgba(88, 166, 255, 0.1)',
              '& .MuiTablePagination-root': {
                color: 'rgba(255, 255, 255, 0.7)',
              },
            }}
          />
        </TableContainer>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialog.open} onClose={() => setDeleteDialog({ open: false, threat: null })}>
        <DialogTitle sx={{ backgroundColor: '#161b22', color: '#58a6ff' }}>
          Delete Threat
        </DialogTitle>
        <DialogContent sx={{ backgroundColor: '#0d1117', color: '#ffffff' }}>
          <Typography sx={{ mt: 2 }}>
            Are you sure you want to delete "{deleteDialog.threat?.name}"?
          </Typography>
        </DialogContent>
        <DialogActions sx={{ backgroundColor: '#161b22', p: 2 }}>
          <Button onClick={() => setDeleteDialog({ open: false, threat: null })}>
            Cancel
          </Button>
          <Button
            variant="contained"
            sx={{ backgroundColor: '#f85149' }}
            onClick={handleDeleteConfirm}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Status Update Dialog */}
      <Dialog open={statusDialog.open} onClose={() => setStatusDialog({ open: false, threat: null })}>
        <DialogTitle sx={{ backgroundColor: '#161b22', color: '#58a6ff' }}>
          Update Status
        </DialogTitle>
        <DialogContent sx={{ backgroundColor: '#0d1117', color: '#ffffff', minWidth: 300 }}>
          <Typography sx={{ mt: 2, mb: 1 }}>New Status:</Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {statuses.map((status) => (
              <Chip
                key={status}
                label={status}
                onClick={() => setNewStatus(status)}
                sx={{
                  backgroundColor: newStatus === status ? '#58a6ff' : 'rgba(88, 166, 255, 0.2)',
                  color: newStatus === status ? '#0d1117' : '#58a6ff',
                  cursor: 'pointer',
                }}
              />
            ))}
          </Box>
        </DialogContent>
        <DialogActions sx={{ backgroundColor: '#161b22', p: 2 }}>
          <Button onClick={() => setStatusDialog({ open: false, threat: null })}>
            Cancel
          </Button>
          <Button
            variant="contained"
            sx={{
              backgroundColor: '#58a6ff',
              color: '#0d1117',
              '&:hover': { backgroundColor: '#1f6feb' },
            }}
            onClick={handleStatusChange}
          >
            Update
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
