import React, {
  createContext,
  useState,
  useEffect,
  useCallback,
} from 'react'

import axios from 'axios'
import { authService, SESSION_EXPIRED_EVENT } from '../services/api'

export const AuthContext = createContext()

// Everything this context stores (user, capabilities) is client-side UX
// state only, used to decide what to render. It is never an authorization
// boundary: every backend route enforces its own requireCapability/
// requireRole middleware independently, and a caller cannot gain backend
// permission by editing localStorage or this context's state.
function clearStoredSession() {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  localStorage.removeItem('capabilities')
  delete axios.defaults.headers.common['Authorization']
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [capabilities, setCapabilities] = useState([])
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(true)

  // On mount, a stored token is re-validated against the backend's
  // GET /api/profile session-validation endpoint rather than trusted as-is.
  // A rejected/expired/tampered token clears all stored state instead of
  // leaving stale user/capability data behind.
  useEffect(() => {
    let cancelled = false

    async function initialize() {
      const storedToken = localStorage.getItem('token')

      if (!storedToken) {
        setLoading(false)
        return
      }

      axios.defaults.headers.common['Authorization'] = `Bearer ${storedToken}`

      try {
        const response = await authService.getCurrentUser()
        if (cancelled) return

        if (!response.data || !response.data.loggedInUser) {
          clearStoredSession()
          setToken(null)
          setUser(null)
          setCapabilities([])
          setLoading(false)
          return
        }

        const validatedUser = response.data.loggedInUser
        const validatedCapabilities = Array.isArray(response.data.capabilities)
          ? response.data.capabilities
          : []

        // Reconcile display fields (name) from any previously stored user
        // record, but role/capabilities always come from this fresh backend
        // response — never from the pre-existing localStorage copy.
        const storedRaw = localStorage.getItem('user')
        let mergedUser = validatedUser
        if (storedRaw) {
          try {
            const storedUser = JSON.parse(storedRaw)
            mergedUser = { ...storedUser, ...validatedUser }
          } catch {
            mergedUser = validatedUser
          }
        }

        localStorage.setItem('user', JSON.stringify(mergedUser))
        localStorage.setItem('capabilities', JSON.stringify(validatedCapabilities))

        setToken(storedToken)
        setUser(mergedUser)
        setCapabilities(validatedCapabilities)
      } catch {
        // Any failure (401, network error, malformed response) is treated as
        // an invalid session: stale state must not survive a failed check.
        if (!cancelled) {
          clearStoredSession()
          setToken(null)
          setUser(null)
          setCapabilities([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    initialize()

    return () => {
      cancelled = true
    }
  }, [])

  // Phase 6 — session expiry. Any authenticated request the backend answers
  // with 401 (expired, revoked or tampered token) clears the stored session and
  // sends the user back to sign-in with an explanation, instead of leaving them
  // on a page whose every request now fails silently.
  //
  // 403 is deliberately NOT handled here: a capability refusal means the
  // session is valid and must survive. See services/api.js.
  useEffect(() => {
    const onExpired = () => {
      clearStoredSession()
      setToken(null)
      setUser(null)
      setCapabilities([])
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login?reason=session-expired')
      }
    }

    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
  }, [])

  const login = useCallback((jwtToken, userData, userCapabilities = []) => {
    const safeCapabilities = Array.isArray(userCapabilities) ? userCapabilities : []

    localStorage.setItem('token', jwtToken)
    localStorage.setItem('user', JSON.stringify(userData))
    localStorage.setItem('capabilities', JSON.stringify(safeCapabilities))

    axios.defaults.headers.common['Authorization'] = `Bearer ${jwtToken}`

    setToken(jwtToken)
    setUser(userData)
    setCapabilities(safeCapabilities)
  }, [])

  const logout = useCallback(() => {
    clearStoredSession()

    setToken(null)
    setUser(null)
    setCapabilities([])
  }, [])

  const updateUser = useCallback((updatedUser) => {
    setUser(updatedUser)
    localStorage.setItem('user', JSON.stringify(updatedUser))
  }, [])

  const isAuthenticated = Boolean(token)

  return (
    <AuthContext.Provider
      value={{
        user,
        capabilities,
        token,
        loading,
        login,
        logout,
        updateUser,
        isAuthenticated,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
