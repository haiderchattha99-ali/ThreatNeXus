// The analyst report-ingestion screen.
//
// It posts to the CANONICAL evidence-backed pipeline, POST /api/reports/upload
// (services/api.js's reportIngestionService), and to nothing else. It used to
// call threatService.uploadCSV — the legacy /threats/upload route, which
// writes standalone Threat rows and creates no Finding, no RawReport evidence
// and no ingestion audit event. That is why this page could show "Report
// processed" while the Findings workspace gained nothing.
//
// Everything rendered below comes from what the backend actually returned. No
// count is computed here, no total is summed, and success is never inferred
// from "the request did not throw": the outcome is read from the status the
// controller assigned it (see constants/reportIngestion.js).

import React, { useState } from 'react'
import { Alert, Box, Button, Chip, LinearProgress } from '@mui/material'
import { FiFileText, FiUploadCloud, FiX } from 'react-icons/fi'
import toast from 'react-hot-toast'

import { reportIngestionService } from '../services/api'
import { PageHeader, Panel, ScopeNote, StatusBadge, Field, FieldGrid } from '../components/ui'
import {
  EVIDENCE_ON_RECORD,
  FINDING_LIFECYCLE_LABELS,
  INGESTION_RESULTS,
  INGESTION_RESULT_HEADLINES,
  INGESTION_RESULT_NOTES,
  INGESTION_RESULT_STATUS,
  classifyIngestionStatus,
  reportFacts,
  safeReasonCode,
} from '../constants/reportIngestion'
import { color, font, radius, type } from '../theme/tokens'

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

// The truthful result view.
//
// Renders the outcome the server assigned, this screen's own prose for it,
// the persisted report facts the backend returned, and — only for a genuine
// PROCESSED — the Finding lifecycle counts it actually recorded. Nothing here
// falls back to zero: a value the backend did not send is simply absent, and
// a replay that recorded nothing says so rather than borrowing the success
// wording.
function IngestionResult({ outcome, onReset }) {
  const { result, body } = outcome
  const recorded = EVIDENCE_ON_RECORD.includes(result)
  const facts = recorded ? reportFacts(body && body.report) : []
  const reason = safeReasonCode(body)
  // Present only on PROCESSED — the controller attaches findingCounts to that
  // outcome and no other, so a replay cannot render lifecycle counts it did
  // not cause.
  const findingCounts =
    result === INGESTION_RESULTS.PROCESSED && body && body.findingCounts ? body.findingCounts : null

  return (
    <Box role={recorded ? 'status' : 'alert'} sx={{ py: { xs: 1, md: 2 } }}>
      <StatusBadge dictionary={INGESTION_RESULT_STATUS} value={result} />

      <Box component="h2" sx={{ ...type.sectionTitle, color: color.text, mt: 1.5, mb: 0 }}>
        {INGESTION_RESULT_HEADLINES[result]}
      </Box>
      <Box sx={{ ...type.small, color: color.textMuted, mt: 1, maxWidth: 640 }}>
        {INGESTION_RESULT_NOTES[result]}
      </Box>

      {reason && (
        <Box sx={{ mt: 2 }}>
          <Field label="Reason code" mono>
            {reason}
          </Field>
        </Box>
      )}

      {facts.length > 0 && (
        <FieldGrid sx={{ mt: 2.5 }} columns={{ xs: '1fr 1fr', md: 'repeat(3, 1fr)' }}>
          {facts.map(([label, value]) => (
            <Field key={label} label={label} mono>
              {String(value)}
            </Field>
          ))}
        </FieldGrid>
      )}

      {findingCounts && (
        <Box sx={{ mt: 2.5 }}>
          <Box sx={{ ...type.caption, color: color.textMuted, mb: 1 }}>
            Finding lifecycle results recorded by this report
          </Box>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }} aria-label="Finding lifecycle results">
            {Object.entries(findingCounts).map(([action, count]) => (
              <Chip
                key={action}
                label={`${FINDING_LIFECYCLE_LABELS[action] || action}: ${count}`}
                sx={{ bgcolor: color.surfaceRaised, color: color.text }}
              />
            ))}
          </Box>
        </Box>
      )}

      <Button onClick={onReset} variant="outlined" sx={{ mt: 2.5 }}>
        Import another file
      </Button>
    </Box>
  )
}

export const Upload = () => {
  const [drag, setDrag] = useState(false)
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  // { result, body } — `result` is one of the closed INGESTION_RESULTS keys,
  // `body` is the raw response payload, read ONLY through the shape-checking
  // helpers in constants/reportIngestion.js.
  const [outcome, setOutcome] = useState(null)
  // Client-side pre-validation only (wrong extension, oversized selection).
  // Server outcomes are never rendered here — they are outcomes, not errors.
  const [error, setError] = useState('')

  const selectFile = (candidate) => {
    if (!candidate?.name?.toLowerCase().endsWith('.csv')) {
      setFile(null)
      setError('Choose a CSV file to continue.')
      return
    }
    if (candidate.size > MAX_UPLOAD_BYTES) {
      setFile(null)
      setError('The selected CSV is larger than 10 MB.')
      return
    }
    setFile(candidate)
    setError('')
  }

  // One place decides the outcome, for both the resolved and the rejected
  // branch, so a refusal can never take a different (and more optimistic)
  // path than a success. A failure with no response at all — network down,
  // request aborted — arrives here as `undefined` and classifies as
  // UNAVAILABLE, never as a silent success.
  const applyOutcome = (status, body) => {
    const result = classifyIngestionStatus(status)
    setOutcome({ result, body: body && typeof body === 'object' ? body : null })
    const label = INGESTION_RESULT_STATUS[result].label
    if (EVIDENCE_ON_RECORD.includes(result)) toast.success(label)
    else toast.error(label)
  }

  const upload = async () => {
    if (!file) return
    setLoading(true)
    setError('')
    try {
      const response = await reportIngestionService.uploadReport(file)
      applyOutcome(response.status, response.data)
    } catch (failure) {
      applyOutcome(failure?.response?.status, failure?.response?.data)
    } finally {
      setLoading(false)
    }
  }

  const reset = () => {
    setOutcome(null)
    setFile(null)
    setError('')
  }

  return (
    <Box sx={{ maxWidth: 1050, mx: 'auto' }}>
      <PageHeader
        eyebrow="Intelligence operations / ingestion"
        title="Ingest a report"
        description="Add a structured CSV to the loaded dataset. The backend validates and persists accepted evidence before it can appear in findings or dashboard counts."
      />

      <ScopeNote sx={{ mb: 2.5 }}>
        Importing is a data-changing operation. Review the selected filename and size before continuing.
      </ScopeNote>

      <Panel
        title={outcome ? 'Ingestion result' : 'Report file'}
        description={
          outcome
            ? 'What the backend recorded for this file. Every value below was returned by the server.'
            : 'One CSV file, up to 10 MB.'
        }
      >
        {outcome ? (
          <IngestionResult outcome={outcome} onReset={reset} />
        ) : (
          <>
            <Box
              onDragOver={(event) => { event.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDrag(false)
                selectFile(event.dataTransfer.files?.[0])
              }}
              sx={{
                border: `1px dashed ${drag ? color.accent : color.borderStrong}`,
                borderRadius: `${radius.md}px`,
                px: 2,
                py: { xs: 4, md: 6 },
                textAlign: 'center',
                backgroundColor: drag ? color.accentQuiet : color.surfaceSunken,
                transition: 'background-color 160ms ease, border-color 160ms ease',
              }}
            >
              <Box sx={{ width: 48, height: 48, mx: 'auto', mb: 1.5, display: 'grid', placeItems: 'center', borderRadius: `${radius.md}px`, bgcolor: color.accentQuiet, color: color.accent }}>
                <FiUploadCloud size={25} aria-hidden="true" />
              </Box>
              <Box sx={{ ...type.sectionTitle, color: color.text }}>Drop a CSV report here</Box>
              <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.75 }}>CSV only · one file · maximum 10 MB</Box>
              <input id="csv-upload" hidden type="file" accept=".csv,text/csv" onChange={(event) => selectFile(event.target.files?.[0])} />
              <Button component="label" htmlFor="csv-upload" variant="outlined" sx={{ mt: 2 }}>
                Browse files
              </Button>
            </Box>

            {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}

            {file && (
              <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, p: 1.5, bgcolor: color.surfaceRaised, border: `1px solid ${color.border}`, borderRadius: `${radius.sm}px` }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.2, minWidth: 0 }}>
                  <FiFileText color={color.accent} aria-hidden="true" />
                  <Box sx={{ minWidth: 0 }}>
                    <Box sx={{ ...type.bodyStrong, color: color.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</Box>
                    <Box sx={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>{(file.size / 1024).toFixed(1)} KB · ready to import</Box>
                  </Box>
                </Box>
                <Button onClick={() => setFile(null)} aria-label="Remove selected file" size="small" sx={{ minWidth: 36, color: color.textMuted }}>
                  <FiX aria-hidden="true" />
                </Button>
              </Box>
            )}

            {loading && (
              <Box sx={{ mt: 2 }} role="status" aria-live="polite">
                <LinearProgress sx={{ height: 6, bgcolor: color.surfaceSunken, '& .MuiLinearProgress-bar': { bgcolor: color.accent } }} />
                <Box sx={{ ...type.caption, color: color.textMuted, mt: 0.75 }}>Uploading and processing the report…</Box>
              </Box>
            )}

            <Button fullWidth disabled={!file || loading} onClick={upload} variant="contained" sx={{ mt: 2.5, py: 1.15 }}>
              {loading ? 'Importing…' : 'Import intelligence'}
            </Button>
          </>
        )}
      </Panel>
    </Box>
  )
}

export default Upload
