import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { Sidebar } from './Sidebar'
import { CAPABILITIES, CAPABILITY_VALUES } from '../constants/capabilities'
import * as useAuthModule from '../hooks/useAuth'

// Phase 3 added read:cases to every role, so the Cases item is now visible to
// all four. Reaching the screen is not the same as being able to change
// anything on it — the mutation controls inside it are gated separately, and
// the backend re-checks every write regardless.
const ANALYST_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
  CAPABILITIES.INGEST_REPORTS,
  CAPABILITIES.TRIAGE_FINDINGS,
  CAPABILITIES.MANAGE_CASES,
]
const REVIEWER_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
  CAPABILITIES.REVIEW_NOTIFICATIONS,
  CAPABILITIES.REVIEW_AI_SUGGESTIONS,
  CAPABILITIES.REVIEW_CASE_CLOSURE,
]
const VIEWER_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
]

function renderSidebar(capabilities) {
  vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({ capabilities })
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>
  )
}

describe('Sidebar navigation visibility', () => {
  it('shows every intended item to ADMIN (all capabilities)', () => {
    renderSidebar(CAPABILITY_VALUES)

    ;[
      'Command center',
      'Threat findings',
      'Intelligence upload',
      'Cases',
      'Notifications',
      'Organizations',
      'Analytics',
      'Settings',
    ].forEach((label) => expect(screen.getByText(label)).toBeInTheDocument())
  })

  it('hides ADMIN-only navigation from ANALYST', () => {
    renderSidebar(ANALYST_CAPABILITIES)

    expect(screen.queryByText('Organizations')).not.toBeInTheDocument()
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
    // ANALYST still gets the work it's granted for.
    expect(screen.getByText('Intelligence upload')).toBeInTheDocument()
    expect(screen.getByText('Cases')).toBeInTheDocument()
  })

  it('hides upload and admin settings from REVIEWER, but not the cases they review', () => {
    renderSidebar(REVIEWER_CAPABILITIES)

    expect(screen.queryByText('Intelligence upload')).not.toBeInTheDocument()
    expect(screen.queryByText('Organizations')).not.toBeInTheDocument()
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
    // Phase 3: a reviewer cannot decide a closure on a case they cannot open.
    expect(screen.getByText('Cases')).toBeInTheDocument()
    // REVIEWER still gets its own review-specific surface.
    expect(screen.getByText('Notifications')).toBeInTheDocument()
  })

  it('shows only read-only navigation to VIEWER', () => {
    renderSidebar(VIEWER_CAPABILITIES)

    expect(screen.getByText('Command center')).toBeInTheDocument()
    expect(screen.getByText('Threat findings')).toBeInTheDocument()
    expect(screen.getByText('Analytics')).toBeInTheDocument()
    // Phase 3 read-only case oversight is an explicit requirement.
    expect(screen.getByText('Cases')).toBeInTheDocument()
    ;['Intelligence upload', 'Notifications', 'Organizations', 'Settings'].forEach((label) =>
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    )
  })

  it('never renders a menu item the user lacks the capability for', () => {
    renderSidebar([])
    ;[
      'Command center',
      'Threat findings',
      'Intelligence upload',
      'Cases',
      'Notifications',
      'Organizations',
      'Analytics',
      'Settings',
    ].forEach((label) => expect(screen.queryByText(label)).not.toBeInTheDocument())
  })
})
