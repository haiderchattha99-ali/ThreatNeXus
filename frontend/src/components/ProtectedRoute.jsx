import React from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { hasCapability } from '../utils/permissions'
import {
  Box,
  CircularProgress,
  Typography,
  Avatar,
} from '@mui/material'
import { FiShield } from 'react-icons/fi'

// Frontend route protection is UX only — it decides what renders, not what is
// permitted. The backend's requireCapability/requireRole middleware is the
// sole authorization boundary and refuses every request independently of
// whatever this component renders.
//
// Fails CLOSED: a protected application route with no `requiredCapability`
// and no explicit `requireAuthOnly` opt-in is denied, never silently treated
// as "any authenticated user may see this". `requireAuthOnly` is the one
// deliberate escape hatch, reserved for routes that genuinely need nothing
// beyond authentication (e.g. Profile) and have no backend capability of
// their own to mirror.
export const ProtectedRoute = ({
  children,
  requiredCapability,
  requireAuthOnly = false,
}) => {
  const { isAuthenticated, loading, capabilities } = useAuth()

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

  const authorized = requireAuthOnly
    ? true
    : Boolean(requiredCapability) && hasCapability(capabilities, requiredCapability)

  if (!authorized) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: '#0F172A',
        }}
      >
        <Typography
          variant="h4"
          sx={{ color: '#EF4444', fontWeight: 700 }}
        >
          403 - Access Denied
        </Typography>
      </Box>
    )
  }

  return children
}
