// The Findings list — the entry point to triage.
//
// Before Phase 6 there was no way to reach a Finding from the UI at all: the
// old "Threat findings" screen listed rows from the legacy `Threat` table,
// which is not the deduplicated Finding lifecycle the rest of the product is
// built on, and it offered a hard delete of security evidence.
//
// This screen reads GET /api/findings. Filters are sent to the server, which
// rejects an invalid value by name rather than silently ignoring it — so the
// count under the table always describes the filter that was actually applied.

import React from 'react'
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Box,
  Button,
  MenuItem,
  TextField,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  Link,
} from '@mui/material'
import { FiRefreshCw, FiSearch } from 'react-icons/fi'

import { findingService } from '../services/api'
import {
  PageHeader,
  Panel,
  StatusBadge,
  RiskBandBadge,
  TableLoadingState,
  EmptyState,
  ErrorState,
  Provenance,
  ScopeNote,
} from '../components/ui'
import {
  FINDING_STATUS,
  OWNERSHIP_CONFIDENCE,
  OWNERSHIP_STATUS,
  color,
  riskBandColor,
  type,
  font,
} from '../theme/tokens'

const RISK_BANDS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL']
const SORTS = [
  { value: 'lastSeen', label: 'Last observed' },
  { value: 'firstSeen', label: 'First observed' },
  { value: 'occurrences', label: 'Times observed' },
  { value: 'recurrences', label: 'Recurrences' },
]

// Derived purely from persisted counters — no inference, no guessing.
function lifecycleOf(finding) {
  if (finding.recurrenceCount > 0) return 'RECURRED'
  if (finding.occurrenceCount > 1) return 'PERSISTED'
  return 'CREATED'
}

const LIFECYCLE = {
  CREATED: { label: 'First observation', tone: 'info', icon: 'plus' },
  PERSISTED: { label: 'Persistent', tone: 'warning', icon: 'repeat' },
  RECURRED: { label: 'Recurred', tone: 'danger', icon: 'rotate' },
}

// The severity spine. A 3px rule down the leading edge of the row, coloured by
// the locked Risk v1 band, so the eye ranks the table before it reads a word of
// it. Colour is never the only carrier — the band NAME sits immediately beside
// it — and an unscored row gets a transparent spine of the same width so the
// column stays aligned rather than jumping by three pixels.
function spineFor(finding) {
  const band = finding.risk?.riskBand
  return `3px solid ${band ? riskBandColor[band] || color.neutral : 'transparent'}`
}

export const Findings = () => {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [data, setData] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(null)

  // Filters live in the URL, so a filtered view is linkable and survives a
  // reload — an analyst handing a colleague "the critical open ones" should be
  // able to send an address, not a description.
  const page = Number(searchParams.get('page') || 1)
  const pageSize = Number(searchParams.get('pageSize') || 25)
  const status = searchParams.get('status') || ''
  const riskBand = searchParams.get('riskBand') || ''
  const sort = searchParams.get('sort') || 'lastSeen'
  const [indicatorInput, setIndicatorInput] = React.useState(searchParams.get('indicator') || '')
  const indicator = searchParams.get('indicator') || ''

  const setParam = (patch, { resetPage = true } = {}) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(patch).forEach(([k, v]) => {
      if (v === '' || v === null || v === undefined) next.delete(k)
      else next.set(k, String(v))
    })
    if (resetPage) next.delete('page')
    setSearchParams(next, { replace: true })
  }

  const load = React.useCallback(() => {
    setLoading(true)
    setError(null)
    findingService
      .getFindings({ page, pageSize, status, riskBand, sort, indicator })
      .then((res) => setData(res.data?.data || null))
      .catch((err) => {
        // The backend names the offending field; surfacing it is what lets a
        // mistyped filter be fixed instead of silently returning wrong rows.
        setError(err?.response?.data?.message || 'The findings list could not be loaded.')
      })
      .finally(() => setLoading(false))
  }, [page, pageSize, status, riskBand, sort, indicator])

  React.useEffect(() => {
    load()
  }, [load])

  const items = data?.items || []
  const showSkeleton = loading && !data

  return (
    <>
      <PageHeader
        eyebrow="Analyst workspace / evidence"
        title="Findings"
        description="Deduplicated exposures built from ingested reports. One row is one (indicator, port, protocol, report type) identity, carrying its whole observation history."
        breadcrumbs={[{ label: 'ThreatNeXus', to: '/dashboard' }, { label: 'Findings' }]}
        actions={
          <Button variant="outlined" size="small" startIcon={<FiRefreshCw />} onClick={load} disabled={loading}>
            Refresh
          </Button>
        }
      />

      <Panel sx={{ mb: 2 }} padded>
        <Box
          component="form"
          onSubmit={(e) => {
            e.preventDefault()
            setParam({ indicator: indicatorInput.trim() })
          }}
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', lg: '2fr 1fr 1fr 1fr auto' },
            gap: 2,
            alignItems: 'start',
          }}
        >
          <TextField
            id="finding-indicator"
            label="Indicator starts with"
            placeholder="203.0.113"
            size="small"
            value={indicatorInput}
            onChange={(e) => setIndicatorInput(e.target.value)}
            helperText="IPv4 address or prefix"
            fullWidth
          />
          <TextField
            id="finding-status"
            label="Status"
            select
            size="small"
            value={status}
            onChange={(e) => setParam({ status: e.target.value })}
            fullWidth
          >
            <MenuItem value="">Any status</MenuItem>
            <MenuItem value="OPEN">Open</MenuItem>
            <MenuItem value="CLOSED">Closed</MenuItem>
          </TextField>
          <TextField
            id="finding-band"
            label="Risk v1 band"
            select
            size="small"
            value={riskBand}
            onChange={(e) => setParam({ riskBand: e.target.value })}
            helperText="Current score only"
            fullWidth
          >
            <MenuItem value="">Any band</MenuItem>
            {RISK_BANDS.map((b) => (
              <MenuItem key={b} value={b}>
                {b}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            id="finding-sort"
            label="Sort by"
            select
            size="small"
            value={sort}
            onChange={(e) => setParam({ sort: e.target.value })}
            fullWidth
          >
            {SORTS.map((s) => (
              <MenuItem key={s.value} value={s.value}>
                {s.label}
              </MenuItem>
            ))}
          </TextField>
          <Button type="submit" variant="contained" startIcon={<FiSearch />} sx={{ mt: { xs: 0, lg: 0.25 } }}>
            Apply
          </Button>
        </Box>
      </Panel>

      <Panel
        padded={false}
        title="Findings"
        titleLevel="h2"
        description={
          data ? `${data.total.toLocaleString('en-US')} finding${data.total === 1 ? '' : 's'} match the applied filters.` : undefined
        }
        footer={
          <Provenance
            source="Finding + current FindingOwnership + current RiskScore"
            asOf={undefined}
            note="loaded dataset only"
          />
        }
      >
        <TableContainer>
          {showSkeleton ? (
            <TableLoadingState columns={6} rows={6} label="Loading findings" />
          ) : error ? (
            <ErrorState onRetry={load}>{error}</ErrorState>
          ) : items.length === 0 ? (
            <EmptyState title="No findings match these filters">
              {data?.total === 0 && !status && !riskBand && !indicator
                ? 'No reports have been ingested into this instance yet. Upload an authorized or synthetic report to create findings.'
                : 'Adjust or clear the filters above to widen the search.'}
            </EmptyState>
          ) : (
            <Table aria-label="Findings">
              <TableHead>
                <TableRow>
                  {/* The transparent 3px border matches the spine on the body
                      cells, so the header text stays aligned with the column. */}
                  <TableCell scope="col" sx={{ borderLeft: '3px solid transparent' }}>
                    Risk v1
                  </TableCell>
                  <TableCell scope="col">Indicator</TableCell>
                  <TableCell scope="col">Owning organization</TableCell>
                  <TableCell scope="col">Lifecycle</TableCell>
                  <TableCell scope="col">Status</TableCell>
                  <TableCell scope="col">Last observed</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((finding) => (
                  // The whole row is the target, and the row is not the control.
                  //
                  // The indicator is a REAL link — it is what a keyboard reaches,
                  // what focus-within highlights, and what middle-click, ctrl-click
                  // and "copy link address" act on. The row-level handler is a
                  // convenience on top of it, and it stands aside twice: when the
                  // click landed on the link itself, and when the analyst is
                  // selecting text. An evidence table whose rows swallow a
                  // selection is a table you cannot copy an IP address out of.
                  //
                  // A stretched-anchor overlay would give the same hit area with
                  // fewer lines and take text selection with it, which is why it
                  // is not used here.
                  <TableRow
                    key={finding.id}
                    hover
                    onClick={(event) => {
                      if (event.target.closest('a')) return
                      if (window.getSelection()?.toString()) return
                      navigate(`/findings/${finding.id}`)
                    }}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell sx={{ borderLeft: spineFor(finding), whiteSpace: 'nowrap' }}>
                      {finding.risk ? (
                        <RiskBandBadge band={finding.risk.riskBand} score={finding.risk.displayScore} />
                      ) : (
                        <Box sx={{ ...type.small, color: color.textMuted }}>Not yet scored</Box>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link
                        component={RouterLink}
                        to={`/findings/${finding.id}`}
                        sx={{ fontFamily: font.mono, fontSize: 13, fontWeight: 500 }}
                      >
                        {finding.indicatorValue}
                      </Link>
                      <Box sx={{ ...type.caption, color: color.textMuted, fontFamily: font.mono, mt: 0.3 }}>
                        port {finding.port} · {finding.protocol} · {finding.reportType.replace(/_/g, ' ')}
                      </Box>
                    </TableCell>
                    <TableCell>
                      {finding.ownership?.organization ? (
                        <>
                          <Box sx={{ ...type.small, color: color.text }}>
                            {finding.ownership.organization.name}
                          </Box>
                          <Box sx={{ mt: 0.5 }}>
                            <StatusBadge
                              dictionary={OWNERSHIP_CONFIDENCE}
                              value={finding.ownership.confidence}
                              size="small"
                              quiet
                            />
                          </Box>
                        </>
                      ) : (
                        <Box sx={{ ...type.small, color: color.textMuted }}>
                          {finding.ownership?.status === 'AMBIGUOUS'
                            ? 'Ambiguous — several organizations tied'
                            : OWNERSHIP_STATUS[finding.ownership?.status]?.label || 'Unresolved'}
                        </Box>
                      )}
                    </TableCell>
                    {/* Quiet from here on. Severity owns the colour in this
                        table; lifecycle and exposure state keep their icon and
                        their words, which is what carries them. */}
                    <TableCell>
                      <StatusBadge dictionary={LIFECYCLE} value={lifecycleOf(finding)} size="small" quiet />
                      <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.4, fontFamily: font.mono }}>
                        {finding.occurrenceCount}× observed
                        {finding.recurrenceCount > 0 ? ` · ${finding.recurrenceCount}× recurred` : ''}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <StatusBadge dictionary={FINDING_STATUS} value={finding.status} size="small" quiet />
                    </TableCell>
                    <TableCell>
                      <Box
                        component="time"
                        dateTime={finding.lastSeen || undefined}
                        sx={{ fontFamily: font.mono, fontSize: 12, color: color.textMuted }}
                      >
                        {finding.lastSeen ? finding.lastSeen.slice(0, 10) : '—'}
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TableContainer>

        {data && data.total > 0 && (
          <TablePagination
            component="div"
            count={data.total}
            page={Math.max(0, data.page - 1)}
            rowsPerPage={data.pageSize}
            onPageChange={(_, next) => setParam({ page: next + 1 }, { resetPage: false })}
            onRowsPerPageChange={(e) => setParam({ pageSize: e.target.value })}
            rowsPerPageOptions={[10, 25, 50, 100]}
          />
        )}
      </Panel>

      <ScopeNote sx={{ mt: 2 }} />
    </>
  )
}

export default Findings
