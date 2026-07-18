import React, { useState } from 'react'
import {
  Box,
  Card,
  Typography,
  Button,
  LinearProgress,
  Alert,
  List,
  ListItem,
  ListItemText,
} from '@mui/material'
import { threatService } from '../services/api'
import toast from 'react-hot-toast'
import { FiUpload, FiCheckCircle, FiAlertCircle } from 'react-icons/fi'

export const Upload = () => {
  const [dragActive, setDragActive] = useState(false)
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0]
      if (droppedFile.type === 'text/csv' || droppedFile.name.endsWith('.csv')) {
        setFile(droppedFile)
        setError('')
      } else {
        setError('Please upload a CSV file')
      }
    }
  }

  const handleFileSelect = (e) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0]
      if (selectedFile.type === 'text/csv' || selectedFile.name.endsWith('.csv')) {
        setFile(selectedFile)
        setError('')
      } else {
        setError('Please select a CSV file')
      }
    }
  }

  const handleUpload = async () => {
    if (!file) {
      setError('Please select a file first')
      return
    }

    try {
      setUploading(true)
      setProgress(0)
      setError('')
      setResult(null)

      // Simulate progress
      const progressInterval = setInterval(() => {
        setProgress((prev) => {
          if (prev < 90) return prev + 10
          return prev
        })
      }, 200)

      const response = await threatService.uploadCSV(file)

      clearInterval(progressInterval)
      setProgress(100)

      if (response.data.success) {
        setResult({
          success: true,
          message: response.data.message,
          imported: response.data.imported || 0,
          skipped: response.data.skipped || 0,
          errors: response.data.errors || [],
        })
        toast.success('CSV imported successfully!')
        setFile(null)

        // Reset after 3 seconds
        setTimeout(() => {
          setProgress(0)
          setResult(null)
          setFile(null)
        }, 3000)
      } else {
        setError(response.data.message || 'Upload failed')
        setProgress(0)
      }
    } catch (err) {
      const errorMessage = err.response?.data?.message || 'Upload failed'
      setError(errorMessage)
      toast.error(errorMessage)
      setProgress(0)
    } finally {
      setUploading(false)
    }
  }

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h3" sx={{ mb: 3, color: '#58a6ff' }}>
        Upload Threats
      </Typography>

      <Card sx={{ backgroundColor: '#161b22', p: 3 }}>
        {/* Drag Drop Area */}
        {!result && (
          <>
            <Box
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              sx={{
                border: '2px dashed',
                borderColor: dragActive ? '#58a6ff' : 'rgba(88, 166, 255, 0.3)',
                borderRadius: 2,
                p: 4,
                textAlign: 'center',
                backgroundColor: dragActive ? 'rgba(88, 166, 255, 0.05)' : 'transparent',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                mb: 2,
              }}
            >
              <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2, fontSize: '3rem' }}>
                <FiUpload size={48} color="#58a6ff" />
              </Box>
              <Typography variant="h5" sx={{ mb: 1, color: '#58a6ff' }}>
                Drag and drop your CSV file here
              </Typography>
              <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.6)', mb: 2 }}>
                or
              </Typography>
              <input
                type="file"
                accept=".csv"
                onChange={handleFileSelect}
                style={{ display: 'none' }}
                id="file-input"
              />
              <label htmlFor="file-input">
                <Button
                  variant="contained"
                  component="span"
                  sx={{
                    backgroundColor: '#58a6ff',
                    color: '#0d1117',
                    '&:hover': { backgroundColor: '#1f6feb' },
                  }}
                >
                  Select File
                </Button>
              </label>
            </Box>

            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}

            {file && (
              <Box sx={{ mb: 2, p: 2, backgroundColor: 'rgba(88, 166, 255, 0.1)', borderRadius: 1 }}>
                <Typography variant="body2" sx={{ color: '#58a6ff' }}>
                  Selected File: <strong>{file.name}</strong> ({(file.size / 1024).toFixed(2)} KB)
                </Typography>
              </Box>
            )}

            {uploading && (
              <Box sx={{ mb: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    Uploading...
                  </Typography>
                  <Typography variant="body2">{progress}%</Typography>
                </Box>
                <LinearProgress variant="determinate" value={progress} />
              </Box>
            )}

            <Button
              fullWidth
              variant="contained"
              size="large"
              onClick={handleUpload}
              disabled={!file || uploading}
              sx={{
                backgroundColor: '#58a6ff',
                color: '#0d1117',
                '&:hover': { backgroundColor: '#1f6feb' },
              }}
            >
              {uploading ? 'Uploading...' : 'Upload CSV'}
            </Button>
          </>
        )}

        {/* Success Result */}
        {result && result.success && (
          <Box sx={{ textAlign: 'center' }}>
            <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2, color: '#3fb950' }}>
              <FiCheckCircle size={64} />
            </Box>
            <Typography variant="h5" sx={{ color: '#3fb950', mb: 1 }}>
              {result.message}
            </Typography>
            <Box sx={{ display: 'flex', justifyContent: 'center', gap: 3, mb: 2 }}>
              <Box>
                <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.6)' }}>
                  Imported
                </Typography>
                <Typography variant="h4" sx={{ color: '#3fb950' }}>
                  {result.imported}
                </Typography>
              </Box>
              <Box>
                <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.6)' }}>
                  Skipped
                </Typography>
                <Typography variant="h4" sx={{ color: '#d29922' }}>
                  {result.skipped}
                </Typography>
              </Box>
            </Box>

            {result.errors && result.errors.length > 0 && (
              <Box sx={{ textAlign: 'left', mt: 2 }}>
                <Typography variant="body2" sx={{ color: '#f85149', mb: 1 }}>
                  Errors ({result.errors.length}):
                </Typography>
                <Box
                  sx={{
                    backgroundColor: 'rgba(248, 81, 73, 0.1)',
                    p: 1,
                    borderRadius: 1,
                    maxHeight: 200,
                    overflowY: 'auto',
                  }}
                >
                  <List dense>
                    {result.errors.map((error, i) => (
                      <ListItem key={i} sx={{ py: 0.5 }}>
                        <ListItemText
                          primary={error}
                          primaryTypographyProps={{ variant: 'body2', sx: { color: '#f85149' } }}
                        />
                      </ListItem>
                    ))}
                  </List>
                </Box>
              </Box>
            )}
          </Box>
        )}

        {/* Help Text */}
        {!result && (
          <Box sx={{ mt: 3, pt: 3, borderTop: '1px solid rgba(88, 166, 255, 0.1)' }}>
            <Typography variant="h6" sx={{ color: '#58a6ff', mb: 1 }}>
              CSV Format
            </Typography>
            <Typography variant="body2" sx={{ color: 'rgba(255, 255, 255, 0.6)', mb: 1 }}>
              Your CSV file should include the following columns:
            </Typography>
            <Typography
              component="code"
              sx={{
                display: 'block',
                backgroundColor: 'rgba(0, 0, 0, 0.2)',
                p: 1,
                borderRadius: 1,
                fontSize: '0.85rem',
                color: '#3fb950',
                fontFamily: 'monospace',
              }}
            >
              id, name, severity, status, riskScore, iocCount, description
            </Typography>
          </Box>
        )}
      </Card>
    </Box>
  )
}
