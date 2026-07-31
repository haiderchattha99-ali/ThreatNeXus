import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

import { ProtectedRoute } from './ProtectedRoute'
import { PAGE_CAPABILITIES } from '../utils/permissions'
import { CAPABILITIES } from '../constants/capabilities'
import * as useAuthModule from '../hooks/useAuth'

function mockAuth(overrides) {
  vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
    isAuthenticated: false,
    loading: false,
    capabilities: [],
    ...overrides,
  })
}

function renderProtected(children, props = {}) {
  return render(
    <MemoryRouter initialEntries={['/target']}>
      <Routes>
        <Route path="/login" element={<div>Login page</div>} />
        <Route
          path="/target"
          element={
            <ProtectedRoute {...props}>{children}</ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

describe('ProtectedRoute', () => {
  it('redirects an unauthenticated user to login', () => {
    mockAuth({ isAuthenticated: false })
    renderProtected(<div>Secret content</div>, { requiredCapability: CAPABILITIES.READ_DASHBOARD })

    expect(screen.getByText('Login page')).toBeInTheDocument()
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument()
  })

  it('renders the route when the user holds the required capability', () => {
    mockAuth({ isAuthenticated: true, capabilities: [CAPABILITIES.READ_DASHBOARD] })
    renderProtected(<div>Secret content</div>, {
      requiredCapability: PAGE_CAPABILITIES.dashboard,
    })

    expect(screen.getByText('Secret content')).toBeInTheDocument()
  })

  it('renders a safe 403 when the user lacks the required capability', () => {
    mockAuth({ isAuthenticated: true, capabilities: [] })
    renderProtected(<div>Secret content</div>, {
      requiredCapability: PAGE_CAPABILITIES.cases,
    })

    expect(screen.getByText('403 - Access Denied')).toBeInTheDocument()
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument()
  })

  it('fails closed when no requiredCapability and no requireAuthOnly opt-in is given', () => {
    mockAuth({ isAuthenticated: true, capabilities: [CAPABILITIES.READ_DASHBOARD] })
    // Simulates a route wired up without a capability declaration by mistake.
    renderProtected(<div>Secret content</div>, {})

    expect(screen.getByText('403 - Access Denied')).toBeInTheDocument()
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument()
  })

  it('renders an authenticated-only route (e.g. Profile) with no capability required', () => {
    mockAuth({ isAuthenticated: true, capabilities: [] })
    renderProtected(<div>Profile content</div>, { requireAuthOnly: true })

    expect(screen.getByText('Profile content')).toBeInTheDocument()
  })

  it('does not expose protected content while auth is still initializing', () => {
    mockAuth({ isAuthenticated: true, loading: true, capabilities: [CAPABILITIES.READ_DASHBOARD] })
    renderProtected(<div>Secret content</div>, {
      requiredCapability: PAGE_CAPABILITIES.dashboard,
    })

    expect(screen.queryByText('Secret content')).not.toBeInTheDocument()
    expect(screen.queryByText('403 - Access Denied')).not.toBeInTheDocument()
  })
})

describe('Sidebar and ProtectedRoute share one capability decision source', () => {
  it('denies REVIEWER the Cases route using the same PAGE_CAPABILITIES.cases mapping the sidebar hides it with', () => {
    const reviewerCapabilities = [CAPABILITIES.READ_DASHBOARD, CAPABILITIES.READ_FINDINGS]
    mockAuth({ isAuthenticated: true, capabilities: reviewerCapabilities })

    renderProtected(<div>Cases content</div>, { requiredCapability: PAGE_CAPABILITIES.cases })

    expect(screen.getByText('403 - Access Denied')).toBeInTheDocument()
  })
})
