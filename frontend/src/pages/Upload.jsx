import React, { useState } from 'react'
import { Box, Card, Typography, Button, LinearProgress, Alert, Chip } from '@mui/material'
import { threatService } from '../services/api'
import toast from 'react-hot-toast'
import { FiUploadCloud, FiFileText, FiCheckCircle, FiX } from 'react-icons/fi'

export const Upload = () => {
  const [drag, setDrag] = useState(false); const [file, setFile] = useState(null); const [loading, setLoading] = useState(false); const [progress, setProgress] = useState(0); const [result, setResult] = useState(null); const [error, setError] = useState('')
  const selectFile = (candidate) => { if (candidate?.name?.endsWith('.csv')) { setFile(candidate); setError('') } else setError('Choose a CSV file to continue') }
  const upload = async () => { if (!file) return; setLoading(true); setProgress(20); try { const response = await threatService.uploadCSV(file); setProgress(100); setResult(response.data); toast.success('Intelligence imported') } catch (errorResponse) { setError(errorResponse.response?.data?.message || 'Upload failed'); setProgress(0) } finally { setLoading(false) } }
  const reset = () => { setResult(null); setFile(null); setProgress(0) }
  return <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 1050, mx: 'auto' }}>
    <Typography className="eyebrow">Intelligence operations / ingest</Typography><Typography className="page-title" sx={{ mt: .6 }}>Upload intelligence</Typography><Typography sx={{ mt: 1, color: '#8290a5', fontSize: 13, mb: 3.5 }}>Import indicators from a structured CSV to enrich your workspace.</Typography>
    <Card className="surface" sx={{ p: { xs: 2, md: 3 } }}>
      {result ? <Box sx={{ textAlign: 'center', py: 7 }}><FiCheckCircle size={48} color="#6ee7c7" /><Typography sx={{ fontSize: 20, fontWeight: 800, mt: 2 }}>Import complete</Typography><Typography sx={{ color: '#8290a5', fontSize: 13, mt: 1 }}>{result.message || 'Your threat intelligence has been added to the workspace.'}</Typography><Chip label={`${result.imported || 0} indicators imported`} sx={{ mt: 2, bgcolor: 'rgba(110,231,199,.1)', color: '#6ee7c7' }} /><Button onClick={reset} sx={{ display: 'block', mx: 'auto', mt: 2, color: '#b7c5d8' }}>Import another file</Button></Box> : <>
        <Box onDragOver={(event) => { event.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={(event) => { event.preventDefault(); setDrag(false); selectFile(event.dataTransfer.files?.[0]) }} sx={{ border: '1.5px dashed', borderColor: drag ? '#6ee7c7' : '#314158', borderRadius: 3, px: 2, py: { xs: 5, md: 8 }, textAlign: 'center', bgcolor: drag ? 'rgba(110,231,199,.06)' : '#0b111b', transition: '.2s' }}>
          <Box sx={{ width: 52, height: 52, mx: 'auto', mb: 2, display: 'grid', placeItems: 'center', borderRadius: 3, bgcolor: 'rgba(110,231,199,.1)', color: '#6ee7c7' }}><FiUploadCloud size={27} /></Box><Typography sx={{ fontWeight: 800, fontSize: 18 }}>Drop your intelligence file here</Typography><Typography sx={{ fontSize: 12, color: '#8290a5', mt: 1 }}>CSV only · One file at a time · Maximum 10 MB</Typography><input id="csv-upload" hidden type="file" accept=".csv" onChange={(event) => selectFile(event.target.files?.[0])} /><Button component="label" htmlFor="csv-upload" variant="outlined" sx={{ mt: 2.5, borderColor: '#3c4d65', color: '#d5dfed' }}>Browse files</Button>
        </Box>
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
        {file && <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 1.5, bgcolor: '#131e2c', borderRadius: 2 }}><Box sx={{ display: 'flex', alignItems: 'center', gap: 1.2 }}><FiFileText color="#6ee7c7" /><Box><Typography sx={{ fontSize: 12, fontWeight: 700 }}>{file.name}</Typography><Typography className="mono" sx={{ fontSize: 10, color: '#7d8da1' }}>{(file.size / 1024).toFixed(1)} KB · READY TO IMPORT</Typography></Box></Box><Button onClick={() => setFile(null)} sx={{ minWidth: 35, color: '#92a2b6' }}><FiX /></Button></Box>}
        {loading && <Box sx={{ mt: 2 }}><LinearProgress variant="determinate" value={progress} sx={{ height: 6, borderRadius: 5, bgcolor: '#26354b', '& .MuiLinearProgress-bar': { bgcolor: '#6ee7c7' } }} /><Typography sx={{ fontSize: 11, color: '#7d8da1', mt: .7 }}>Processing intelligence... {progress}%</Typography></Box>}
        <Button fullWidth disabled={!file || loading} onClick={upload} variant="contained" sx={{ mt: 2.5, py: 1.2, bgcolor: '#6ee7c7', color: '#081018', '&:hover': { bgcolor: '#98f1d9' } }}>{loading ? 'Importing...' : 'Import intelligence'}</Button>
      </>}
    </Card>
  </Box>
}
