import React from 'react'
import { Navigate } from 'react-router-dom'
import { Box } from '@mui/material'
import { useAuth } from '../hooks/useAuth'
import { hasCapability } from '../utils/permissions'
import { BrandMark } from './ui/Brand'
import { color, type, radius } from '../theme/tokens'

// Frontend route protection is UX only — it decides what renders, not what is
// permitted. The backend's requireCapability/requireRole middleware is the sole
// authorization boundary and refuses every request independently of whatever
// this component renders.
//
// Fails CLOSED: a protected application route with no `requiredCapability` and
// no explicit `requireAuthOnly` opt-in is denied, never silently treated as
// "any authenticated user may see this". `requireAuthOnly` is the one
// deliberate escape hatch, reserved for routes that genuinely need nothing
// beyond authentication (e.g. Profile) and have no backend capability of their
// own to mirror.
//
// Phase 6 note: nothing is rendered while `loading` is true — not the page and
// not the denial. That is what stops a restricted page from flashing on screen
// for the moment between mount and the session-validation response.
export const ProtectedRoute = ({ children, requiredCapability, requireAuthOnly = false }) => {
  const { isAuthenticated, loading, capabilities } = useAuth()

  if (loading) {
    return (
      <Box
        role="status"
        aria-live="polite"
        aria-busy="true"
        sx={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          backgroundColor: color.canvas,
          px: 3,
        }}
      >
        <Box sx={{ textAlign: 'center', maxWidth: 340 }}>
          <BrandMark size={40} />
          <Box sx={{ ...type.bodyStrong, color: color.text, mt: 2 }}>Verifying your session</Box>
          <Box sx={{ ...type.small, color: color.textMuted, mt: 0.75 }}>
            Confirming your capabilities with the server before anything is shown.
          </Box>
          <Box
            aria-hidden="true"
            sx={{
              mt: 3,
              height: 2,
              borderRadius: 2,
              backgroundColor: color.border,
              overflow: 'hidden',
              '&::after': {
                content: '""',
                display: 'block',
                height: '100%',
                width: '40%',
                backgroundColor: color.accent,
                animation: 'tnxIndeterminate 1.1s ease-in-out infinite',
              },
              '@keyframes tnxIndeterminate': {
                '0%': { transform: 'translateX(-100%)' },
                '100%': { transform: 'translateX(350%)' },
              },
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
        role="alert"
        sx={{ minHeight: '60vh', display: 'grid', placeItems: 'center', px: 3, py: 6 }}
      >
        <Box
          sx={{
            maxWidth: 460,
            textAlign: 'center',
            border: `1px solid ${color.border}`,
            borderRadius: `${radius.md}px`,
            backgroundColor: color.surface,
            px: 4,
            py: 5,
          }}
        >
          <Box component="h1" sx={{ ...type.display, color: color.text, m: 0 }}>
            403 - Access Denied
          </Box>
          <Box sx={{ ...type.body, color: color.textMuted, mt: 1.5 }}>
            Your role does not hold the capability this screen requires. The
            server enforces this independently — it would refuse the underlying
            request even if this page were rendered.
          </Box>
          {/* The specific capability is deliberately NOT printed: naming the
              exact grant a caller lacks is a small enumeration aid, and the
              analyst does not need it to know who to ask. */}
        </Box>
      </Box>
    )
  }

  return children
}

export default ProtectedRoute
