import React from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import {
  Box,
  CircularProgress,
  Typography,
  Avatar,
} from '@mui/material'
import { FiShield } from 'react-icons/fi'

export const ProtectedRoute = ({ children }) => {
  const { isAuthenticated, loading } = useAuth()

  if (loading) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          backgroundColor: '#0F172A',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Box
          sx={{
            textAlign: 'center',
            p: 5,
            borderRadius: 3,
            background: '#111827',
            border: '1px solid #1E293B',
            width: 360,
          }}
        >
          <Avatar
            sx={{
              bgcolor: '#2563EB',
              width: 70,
              height: 70,
              margin: '0 auto',
              mb: 3,
            }}
          >
            <FiShield size={35} />
          </Avatar>

          <Typography
            sx={{
              color: '#F8FAFC',
              fontWeight: 700,
              fontSize: 24,
              mb: 1,
            }}
          >
            ThreatNeXus
          </Typography>

          <Typography
            sx={{
              color: '#94A3B8',
              mb: 4,
            }}
          >
            Verifying your session...
          </Typography>

          <CircularProgress
            size={35}
            thickness={5}
            sx={{
              color: '#2563EB',
            }}
          />
        </Box>
      </Box>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return children
}