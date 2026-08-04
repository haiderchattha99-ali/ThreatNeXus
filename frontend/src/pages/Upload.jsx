import React, { useState } from 'react'
import { Alert, Box, Button, Chip, LinearProgress } from '@mui/material'
import { FiCheckCircle, FiFileText, FiUploadCloud, FiX } from 'react-icons/fi'
import toast from 'react-hot-toast'

import { threatService } from '../services/api'
import { PageHeader, Panel, ScopeNote } from '../components/ui'
import { color, font, radius, type } from '../theme/tokens'

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

export const Upload = () => {
  const [drag, setDrag] = useState(false)
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
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

  const upload = async () => {
    if (!file) return
    setLoading(true)
    try {
      const response = await threatService.uploadCSV(file)
      setResult(response.data)
      toast.success(response.data?.message || 'Report processed')
    } catch (errorResponse) {
      setError(errorResponse.response?.data?.message || 'Upload failed.')
    } finally {
      setLoading(false)
    }
  }

  const reset = () => {
    setResult(null)
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
        title={result ? 'Ingestion result' : 'Report file'}
        description={result ? 'The backend accepted the report and returned this result.' : 'One CSV file, up to 10 MB.'}
      >
        {result ? (
          <Box sx={{ textAlign: 'center', py: { xs: 4, md: 6 } }} role="status">
            <FiCheckCircle size={44} color={color.success} aria-hidden="true" />
            <Box component="h2" sx={{ ...type.sectionTitle, color: color.text, mt: 1.5, mb: 0 }}>
              Report processed
            </Box>
            <Box sx={{ ...type.small, color: color.textMuted, mt: 1 }}>
              {result.message || 'The report has been added to this ThreatNeXus instance.'}
            </Box>
            {Object.entries(result.findingCounts || {}).length > 0 && (
              <Box sx={{ mt: 2, display: 'flex', justifyContent: 'center', gap: 1, flexWrap: 'wrap' }} aria-label="Finding lifecycle results">
                {Object.entries(result.findingCounts).map(([outcome, count]) => (
                  <Chip key={outcome} label={`${outcome.replace(/_/g, ' ').toLowerCase()}: ${count}`} sx={{ bgcolor: color.successQuiet, color: color.success }} />
                ))}
              </Box>
            )}
            <Button onClick={reset} variant="outlined" sx={{ display: 'block', mx: 'auto', mt: 2 }}>
              Import another file
            </Button>
          </Box>
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
