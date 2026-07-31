import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { AuthProvider } from './AuthContext'
import { useAuth } from '../hooks/useAuth'
import { authService } from '../services/api'

vi.mock('../services/api', () => ({
  authService: { getCurrentUser: vi.fn() },
}))

function Probe() {
  const { isAuthenticated, loading, user, capabilities, logout } = useAuth()
  if (loading) return <div>loading</div>
  return (
    <div>
      <div data-testid="auth">{String(isAuthenticated)}</div>
      <div data-testid="role">{user?.role ?? 'none'}</div>
      <div data-testid="caps">{capabilities.join(',')}</div>
      <button onClick={logout}>logout</button>
    </div>
  )
}

describe('AuthContext session validation', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('clears a forged localStorage session when the backend rejects the token', async () => {
    // An attacker (or a stale tab) sets ADMIN role/capabilities directly in
    // localStorage. The mocked backend treats the token as invalid, exactly
    // as it would for an expired/tampered real token.
    localStorage.setItem('token', 'forged-token')
    localStorage.setItem(
      'user',
      JSON.stringify({ id: 1, email: 'attacker@example.test', role: 'ADMIN' })
    )
    localStorage.setItem('capabilities', JSON.stringify(['manage:system', 'delete:records']))

    authService.getCurrentUser.mockRejectedValue({ response: { status: 401 } })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByTestId('auth').textContent).toBe('false'))
    expect(screen.getByTestId('role').textContent).toBe('none')
    expect(screen.getByTestId('caps').textContent).toBe('')
    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('user')).toBeNull()
    expect(localStorage.getItem('capabilities')).toBeNull()
  })

  it('adopts the backend-validated role/capabilities, not the stale localStorage copy', async () => {
    // Stored copy claims ADMIN; the backend says VIEWER. The validated value
    // must win.
    localStorage.setItem('token', 'stale-token')
    localStorage.setItem('user', JSON.stringify({ id: 1, role: 'ADMIN' }))
    localStorage.setItem('capabilities', JSON.stringify(['manage:system']))

    authService.getCurrentUser.mockResolvedValue({
      data: {
        loggedInUser: { id: 1, email: 'real@example.test', role: 'VIEWER' },
        capabilities: ['read:dashboard', 'read:findings'],
      },
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByTestId('auth').textContent).toBe('true'))
    expect(screen.getByTestId('role').textContent).toBe('VIEWER')
    expect(screen.getByTestId('caps').textContent).toBe('read:dashboard,read:findings')
  })

  it('logout clears stored token, user and capability state', async () => {
    localStorage.setItem('token', 'real-token')
    localStorage.setItem('user', JSON.stringify({ id: 1, role: 'VIEWER' }))
    localStorage.setItem('capabilities', JSON.stringify(['read:dashboard']))
    authService.getCurrentUser.mockResolvedValue({
      data: {
        loggedInUser: { id: 1, role: 'VIEWER' },
        capabilities: ['read:dashboard'],
      },
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByTestId('auth').textContent).toBe('true'))

    screen.getByRole('button', { name: 'logout' }).click()

    await waitFor(() => expect(screen.getByTestId('auth').textContent).toBe('false'))
    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('user')).toBeNull()
    expect(localStorage.getItem('capabilities')).toBeNull()
  })

  it('does not expose loading as authenticated with no token present', async () => {
    authService.getCurrentUser.mockRejectedValue(new Error('should not be called'))

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByTestId('auth').textContent).toBe('false'))
    expect(authService.getCurrentUser).not.toHaveBeenCalled()
  })
})
