// Organizations — Phase 6.2 truth cleanup.
//
// WHAT CHANGED AND WHY
// --------------------
// `securityScore` and `activeThreats` are real Int columns on the Organization
// model, but nothing in this system ever computes them. They are typed in by an
// administrator through this form and stored verbatim. Nothing reads them for
// scoring, routing, prioritisation or reporting — they are not inputs to Risk
// v1, and ownership confidence (which IS derived) is a separate concept stored
// elsewhere.
//
// The previous version of this page presented them as operational measurements:
//
//   - an "Average Security Score" card, computed by averaging every
//     organization's hand-typed number;
//   - an "Active Threats" card, computed by SUMMING every organization's
//     hand-typed number into one headline figure.
//
// Both are gone. Averaging and summing hand-entered numbers produces a figure
// that looks measured, sits beside a real record count, and — on a page listing
// a national CERT's constituents — reads as a national exposure statistic. It
// is not one. It is the sum of whatever somebody last typed.
//
// The two fields remain editable, because they are the administrative notes
// they always were and removing the columns would need a migration this phase
// does not take. They are now labelled as manually entered everywhere they
// appear, and they are excluded from every aggregate on this page.
//
// The record count stays, because a count of rows in this instance is a fact
// this page can defend — and it is labelled as exactly that.

import React from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
} from '@mui/material'
import { FiEdit2, FiEye, FiPlus, FiSearch, FiTrash2 } from 'react-icons/fi'

import { organizationService } from '../services/api'
import {
  PageHeader,
  Panel,
  Field,
  FieldGrid,
  SectionLabel,
  LoadingState,
  ErrorState,
  EmptyState,
  ScopeNote,
  Provenance,
} from '../components/ui'
import { color, type, radius, font } from '../theme/tokens'

const EMPTY_FORM = {
  name: '',
  industry: '',
  location: '',
  contactPerson: '',
  email: '',
  phone: '',
  securityScore: 100,
  activeThreats: 0,
}

// One shared caption for both hand-entered columns, so the label can never
// drift apart between the table, the detail dialog and the edit form.
const MANUAL_FIELD_NOTE =
  'Manually entered by an administrator. Not measured, not computed, and not used by risk scoring, prioritisation or any report.'

function ManualFieldLabel({ children }) {
  return (
    <Box component="span">
      {children}
      <Box component="span" sx={{ display: 'block', ...type.caption, color: color.textMuted, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
        manually entered
      </Box>
    </Box>
  )
}

const Organizations = () => {
  const [organizations, setOrganizations] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const [search, setSearch] = React.useState('')

  const [createOpen, setCreateOpen] = React.useState(false)
  const [viewOpen, setViewOpen] = React.useState(false)
  const [editOpen, setEditOpen] = React.useState(false)
  const [selected, setSelected] = React.useState(null)
  const [form, setForm] = React.useState(EMPTY_FORM)
  const [writeError, setWriteError] = React.useState('')

  const load = React.useCallback(() => {
    setLoading(true)
    setError(false)
    organizationService
      .getOrganizations()
      .then((res) => setOrganizations(res.data?.data || []))
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const safeMessage = (err) =>
    err?.response?.data?.message || 'The request was refused. Nothing was changed.'

  const create = async () => {
    setWriteError('')
    try {
      await organizationService.createOrganization(form)
      setCreateOpen(false)
      setForm(EMPTY_FORM)
      load()
    } catch (err) {
      setWriteError(safeMessage(err))
    }
  }

  const update = async () => {
    setWriteError('')
    try {
      await organizationService.updateOrganization(selected.id, selected)
      setEditOpen(false)
      load()
    } catch (err) {
      setWriteError(safeMessage(err))
    }
  }

  const remove = async (id) => {
    if (!window.confirm('Delete this organization record? Cases, notifications and mappings that reference it will block the delete.')) return
    setWriteError('')
    try {
      await organizationService.deleteOrganization(id)
      load()
    } catch (err) {
      setWriteError(safeMessage(err))
    }
  }

  const term = search.trim().toLowerCase()
  const filtered = term
    ? organizations.filter((org) =>
        [org.name, org.industry, org.location].some((v) => String(v || '').toLowerCase().includes(term))
      )
    : organizations

  return (
    <>
      <PageHeader
        eyebrow="Administration / constituents"
        title="Organizations"
        description="Constituent records held by this instance, used to attribute findings to an owner and to address notifications."
        breadcrumbs={[{ label: 'ThreatNeXus', to: '/dashboard' }, { label: 'Organizations' }]}
        actions={
          <Button variant="contained" size="small" startIcon={<FiPlus />} onClick={() => { setForm(EMPTY_FORM); setWriteError(''); setCreateOpen(true) }}>
            Add organization
          </Button>
        }
        meta={<Provenance source="GET /api/organizations" note="Records stored in this instance." />}
      />

      {writeError && (
        <Box role="alert" sx={{ mb: 2, px: 1.5, py: 1, border: `1px solid ${color.danger}`, borderRadius: `${radius.sm}px`, ...type.small, color: color.danger }}>
          {writeError}
        </Box>
      )}

      {/* One aggregate only, and it is a count of rows — not an average or a sum
          of anything a human typed. */}
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
        <Box sx={{ ...type.metricSm, color: color.text }}>{organizations.length}</Box>
        <Box sx={{ ...type.small, color: color.textMuted }}>
          constituent records loaded into this instance
        </Box>
      </Box>

      <Panel padded={false} sx={{ mb: 2 }}>
        <Box sx={{ p: 2, borderBottom: `1px solid ${color.border}` }}>
          <TextField
            size="small"
            placeholder="Search name, industry or location"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            slotProps={{ input: { startAdornment: <Box sx={{ display: 'flex', mr: 1, color: color.textMuted }}><FiSearch /></Box> } }}
            sx={{ maxWidth: 340, width: '100%' }}
          />
        </Box>

        {loading && !organizations.length ? (
          <Box sx={{ p: 2 }}><LoadingState label="Loading organizations" /></Box>
        ) : error ? (
          <Box sx={{ p: 2 }}><ErrorState onRetry={load} /></Box>
        ) : !filtered.length ? (
          <Box sx={{ p: 2 }}>
            <EmptyState title={term ? 'No record matches that search' : 'No organizations have been added'}>
              {term ? 'Try a different name, industry or location.' : 'Add a constituent organization to attribute findings to an owner.'}
            </EmptyState>
          </Box>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Industry</TableCell>
                  <TableCell>Location</TableCell>
                  <TableCell align="right"><ManualFieldLabel>Security score</ManualFieldLabel></TableCell>
                  <TableCell align="right"><ManualFieldLabel>Active threats</ManualFieldLabel></TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filtered.map((org) => (
                  <TableRow key={org.id} hover>
                    <TableCell sx={{ color: color.text }}>{org.name}</TableCell>
                    <TableCell>{org.industry}</TableCell>
                    <TableCell>{org.location}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: font.mono, color: color.textMuted }}>{org.securityScore}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: font.mono, color: color.textMuted }}>{org.activeThreats}</TableCell>
                    <TableCell align="right">
                      <Box sx={{ display: 'flex', gap: 0.5, justifyContent: 'flex-end' }}>
                        <Button size="small" aria-label={`View ${org.name}`} onClick={() => { setSelected(org); setViewOpen(true) }}><FiEye /></Button>
                        <Button size="small" aria-label={`Edit ${org.name}`} onClick={() => { setSelected(org); setWriteError(''); setEditOpen(true) }}><FiEdit2 /></Button>
                        <Button size="small" color="error" aria-label={`Delete ${org.name}`} onClick={() => remove(org.id)}><FiTrash2 /></Button>
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Panel>

      <Panel title="How the two numeric columns should be read">
        <Box sx={{ ...type.small, color: color.textMuted, maxWidth: '80ch' }}>
          {MANUAL_FIELD_NOTE} They are deliberately not averaged, summed or
          rolled up into a posture or threat headline anywhere in this
          application: an average of hand-typed values would look like a
          measurement without being one. Ownership attribution and Risk v1
          scoring both ignore these columns entirely.
        </Box>
        <ScopeNote sx={{ mt: 2 }} />
      </Panel>

      {/* ------------------------------------------------------------ create */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Add organization</DialogTitle>
        <DialogContent>
          {['name', 'industry', 'location', 'contactPerson', 'email', 'phone'].map((key) => (
            <TextField
              key={key}
              fullWidth
              margin="normal"
              label={key === 'contactPerson' ? 'Contact person' : key.charAt(0).toUpperCase() + key.slice(1)}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          ))}
          <Box sx={{ mt: 2, p: 1.5, backgroundColor: color.surfaceSunken, borderRadius: `${radius.sm}px`, ...type.caption, color: color.textMuted }}>
            Security score and active threats are administrative notes only and
            can be set after the record exists. {MANUAL_FIELD_NOTE}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={create}>Save</Button>
        </DialogActions>
      </Dialog>

      {/* -------------------------------------------------------------- view */}
      <Dialog open={viewOpen} onClose={() => setViewOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Organization details</DialogTitle>
        <DialogContent>
          {selected && (
            <Box sx={{ pt: 1 }}>
              <FieldGrid columns={{ xs: '1fr', sm: '1fr 1fr' }}>
                <Field label="Name">{selected.name}</Field>
                <Field label="Industry">{selected.industry}</Field>
                <Field label="Location">{selected.location}</Field>
                <Field label="Contact person">{selected.contactPerson}</Field>
                <Field label="Email" mono>{selected.email}</Field>
                <Field label="Phone" mono>{selected.phone}</Field>
              </FieldGrid>
              <Box sx={{ mt: 2.5 }}>
                <SectionLabel component="h3">Administrative notes</SectionLabel>
                <FieldGrid columns={{ xs: '1fr', sm: '1fr 1fr' }} sx={{ mt: 1 }}>
                  <Field label="Security score (manually entered)" mono>{selected.securityScore}</Field>
                  <Field label="Active threats (manually entered)" mono>{selected.activeThreats}</Field>
                </FieldGrid>
                <Box sx={{ ...type.caption, color: color.textMuted, mt: 1.5 }}>{MANUAL_FIELD_NOTE}</Box>
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* -------------------------------------------------------------- edit */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit organization</DialogTitle>
        <DialogContent>
          {['name', 'industry', 'location', 'contactPerson', 'email', 'phone'].map((key) => (
            <TextField
              key={key}
              fullWidth
              margin="normal"
              label={key === 'contactPerson' ? 'Contact person' : key.charAt(0).toUpperCase() + key.slice(1)}
              value={selected?.[key] || ''}
              onChange={(e) => setSelected({ ...selected, [key]: e.target.value })}
            />
          ))}
          <Box sx={{ mt: 2.5, pt: 2, borderTop: `1px solid ${color.border}` }}>
            <SectionLabel component="h3">Administrative notes</SectionLabel>
            <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.75, mb: 1 }}>{MANUAL_FIELD_NOTE}</Box>
            <TextField
              fullWidth
              margin="normal"
              type="number"
              label="Security score (manually entered)"
              value={selected?.securityScore ?? 0}
              onChange={(e) => setSelected({ ...selected, securityScore: Number(e.target.value) })}
            />
            <TextField
              fullWidth
              margin="normal"
              type="number"
              label="Active threats (manually entered)"
              value={selected?.activeThreats ?? 0}
              onChange={(e) => setSelected({ ...selected, activeThreats: Number(e.target.value) })}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={update}>Update</Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

export default Organizations
