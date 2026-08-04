import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Box, TextField, Button, Alert, InputAdornment, IconButton } from '@mui/material'
import { FiArrowRight, FiEye, FiEyeOff } from 'react-icons/fi'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'

import { useAuth } from '../hooks/useAuth'
import { authService } from '../services/api'
import { OpeningMotif } from '../components/OpeningMotif'
import { BrandMark, PkcertAttribution } from '../components/ui/Brand'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { color, type, layout, font } from '../theme/tokens'

gsap.registerPlugin(useGSAP)

// Marks that the opening has already been seen in THIS browser session, so a
// sign-out/sign-in round trip does not replay it. Session storage, not local:
// the flourish should return on a genuinely new session.
const OPENING_SEEN_KEY = 'tnx.opening.seen'

function openingAlreadySeen() {
  try {
    return window.sessionStorage.getItem(OPENING_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

function markOpeningSeen() {
  try {
    window.sessionStorage.setItem(OPENING_SEEN_KEY, '1')
  } catch {
    /* storage unavailable — the opening simply plays again next time */
  }
}

export const Login = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { login, isAuthenticated } = useAuth()
  const reducedMotion = useReducedMotion()

  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [showPassword, setShowPassword] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState('')
  const [fieldErrors, setFieldErrors] = React.useState({})

  // The opening plays only on a first visit in this session, and never when the
  // user has asked for reduced motion. It is purely visual: the form below is
  // interactive from the first paint either way, so it can never gate sign-in.
  const [playOpening] = React.useState(() => !reducedMotion && !openingAlreadySeen())
  // Set by the Skip control. Flipping it changes the motif's `animate`
  // dependency, which makes useGSAP revert the running timeline and re-run its
  // static branch — so skipping lands on the same final state the animation
  // would have reached, not on a half-played one.
  const [skipped, setSkipped] = React.useState(false)
  const openingActive = playOpening && !skipped
  const asideRef = React.useRef(null)

  const sessionExpired = new URLSearchParams(location.search).get('reason') === 'session-expired'

  React.useEffect(() => {
    if (playOpening) markOpeningSeen()
  }, [playOpening])

  // The opening as a readable sequence rather than one simultaneous fade:
  // the mark identifies the product, the motif traces its evidence lines, the
  // tagline states what it does, and the PKCERT attribution closes it. Total
  // ~1.85s, inside the 1.6-2.0s budget.
  //
  // Two constraints hold absolutely: this timeline touches ONLY elements inside
  // the decorative aside (the form is in a sibling column and is interactive
  // from first paint), and under reduced motion no timeline is constructed at
  // all — the `if` below returns before gsap.timeline() is ever called.
  useGSAP(
    () => {
      if (!openingActive) {
        // Static path: final state, no animation objects.
        gsap.set('[data-open-step]', { autoAlpha: 1, y: 0 })
        return
      }
      const tl = gsap.timeline({ defaults: { ease: 'power2.out' } })
      tl.fromTo('[data-open-step="brand"]', { autoAlpha: 0, y: -8 }, { autoAlpha: 1, y: 0, duration: 0.5 }, 0)
        .fromTo('[data-open-step="tagline"]', { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.5 }, 0.95)
        .fromTo('[data-open-step="summary"]', { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.45 }, 1.2)
        .fromTo('[data-open-step="constraints"]', { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4 }, 1.45)
        .fromTo('[data-open-step="attribution"]', { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.4 }, 1.45)
      return () => tl.revert()
    },
    { scope: asideRef, dependencies: [openingActive], revertOnUpdate: true }
  )

  React.useEffect(() => {
    if (isAuthenticated) navigate('/dashboard', { replace: true })
  }, [isAuthenticated, navigate])

  const validate = () => {
    const next = {}
    if (!email.trim()) next.email = 'Enter the email address for your account.'
    if (!password) next.password = 'Enter your password.'
    setFieldErrors(next)
    return Object.keys(next).length === 0
  }

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    if (!validate()) return

    setSubmitting(true)
    try {
      const response = await authService.login(email.trim(), password)
      if (response.data?.success && response.data?.token) {
        login(response.data.token, response.data.user, response.data.capabilities)
        navigate('/dashboard', { replace: true })
        return
      }
      // A 200 that is not a success is still a failed sign-in; it must not fall
      // through to a signed-in state.
      setError('Sign-in did not complete. Check your details and try again.')
    } catch (err) {
      // Never surfaces a raw error or server exception text — only the
      // backend's own safe message, or a generic fallback.
      setError(err?.response?.data?.message || 'Sign-in failed. Check your details and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: '1.05fr 1fr' },
        backgroundColor: color.canvas,
      }}
    >
      {/* -------------------------------------------------- brand / context */}
      <Box
        component="aside"
        ref={asideRef}
        sx={{
          position: 'relative',
          display: { xs: 'none', md: 'flex' },
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 4,
          px: 6,
          py: 5,
          borderRight: `1px solid ${color.border}`,
          backgroundColor: color.canvasAlt,
          backgroundImage: `radial-gradient(circle at 50% 38%, ${color.accent}0F, transparent 60%)`,
        }}
      >
        <Box data-open-step="brand">
          <BrandMark size={30} showWordmark />
        </Box>

        <Box sx={{ textAlign: 'center' }}>
          {/* Decorative and non-interactive. It sits in this column only; the
              sign-in form is a sibling and is never covered by it. */}
          <Box sx={{ pointerEvents: 'none' }}>
            <OpeningMotif animate={openingActive} size={320} />
          </Box>
          <Box component="p" data-open-step="tagline" sx={{ ...type.display, color: color.text, mt: 4, mb: 0 }}>
            Connecting Intelligence with Action
          </Box>
          <Box
            component="p"
            data-open-step="summary"
            sx={{ ...type.small, color: color.textMuted, mt: 1.5, mx: 'auto', maxWidth: '46ch' }}
          >
            A defensive cyber-threat-intelligence orchestration and
            incident-response research prototype. Authorized or clearly synthetic
            reports in; deduplicated findings, explainable risk, analyst-owned
            cases and reviewer-approved constituent notifications out.
          </Box>
          <Box
            component="p"
            data-open-step="constraints"
            sx={{
              ...type.caption,
              color: color.textFaint,
              fontFamily: font.mono,
              mt: 2.5,
              mb: 0,
            }}
          >
            No autonomous scanning · no automatic remediation · no automatic sending
          </Box>
        </Box>

        <Box data-open-step="attribution">
          <PkcertAttribution variant="card" />
        </Box>

        {/* Skip. Shown only while the opening is actually running, because a
            control that skips nothing is noise. It changes no stored
            preference and signs nobody in or out — it only lands this one
            playthrough on its final frame. */}
        {openingActive && (
          <Button
            data-testid="skip-intro"
            size="small"
            variant="text"
            onClick={() => setSkipped(true)}
            sx={{
              position: 'absolute',
              top: 16,
              right: 16,
              ...type.caption,
              color: color.textMuted,
              '&:hover': { color: color.text, backgroundColor: color.surfaceRaised },
            }}
          >
            Skip intro
          </Button>
        )}
      </Box>

      {/* ----------------------------------------------------------- sign in */}
      <Box
        component="main"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          px: { xs: 3, sm: 6 },
          py: { xs: 5, md: 6 },
        }}
      >
        <Box sx={{ width: '100%', maxWidth: 400, mx: 'auto' }}>
          <Box sx={{ display: { xs: 'block', md: 'none' }, mb: 4 }}>
            <BrandMark size={28} showWordmark />
          </Box>

          <Box component="h1" sx={{ ...type.display, color: color.text, m: 0 }}>
            Sign in
          </Box>
          <Box component="p" sx={{ ...type.small, color: color.textMuted, mt: 1, mb: 4 }}>
            Access is granted by role. The server decides what you may do — this
            interface only reflects it.
          </Box>

          {sessionExpired && (
            <Alert severity="warning" sx={{ mb: 2.5 }}>
              Your session ended and you were signed out. Sign in again to continue.
            </Alert>
          )}

          {/* role="alert" so a failed sign-in is announced, not only shown. */}
          {error && (
            <Alert severity="error" role="alert" sx={{ mb: 2.5 }}>
              {error}
            </Alert>
          )}

          <Box component="form" onSubmit={submit} noValidate>
            <TextField
              id="login-email"
              label="Email address"
              type="email"
              autoComplete="username"
              fullWidth
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              error={Boolean(fieldErrors.email)}
              helperText={fieldErrors.email || ' '}
              sx={{ mb: 1 }}
            />

            <TextField
              id="login-password"
              label="Password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              fullWidth
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              error={Boolean(fieldErrors.password)}
              helperText={fieldErrors.password || ' '}
              slotProps={{ input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={() => setShowPassword((v) => !v)}
                      edge="end"
                      // An icon-only control must still have a name.
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                    >
                      {showPassword ? <FiEyeOff size={16} /> : <FiEye size={16} />}
                    </IconButton>
                  </InputAdornment>
                ),
              } }}
            />

            <Button
              type="submit"
              fullWidth
              variant="contained"
              disabled={submitting}
              endIcon={submitting ? null : <FiArrowRight />}
              sx={{ mt: 2.5, py: 1.15 }}
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>

            {/* Announces the in-flight state to assistive technology, which the
                disabled button alone does not do. */}
            <Box role="status" aria-live="polite" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
              {submitting ? 'Signing in, please wait' : ''}
            </Box>
          </Box>

          <Box
            sx={{
              mt: 5,
              pt: 3,
              borderTop: `1px solid ${color.border}`,
              display: { xs: 'block', md: 'none' },
            }}
          >
            <PkcertAttribution variant="compact" />
          </Box>

          <Box sx={{ ...type.caption, color: color.textFaint, mt: 3, maxWidth: `${layout.readableMaxWidth}ch` }}>
            Local accounts are created by an administrator. There is no
            self-registration, and this prototype holds no real constituent data.
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

export default Login
