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
// Phase 4 added read:notifications to ANALYST and REVIEWER (and to no other
// role), so both fixtures gain it here. VIEWER deliberately does not: the
// approved pre-Phase-4 notification-read policy excluded VIEWER and Phase 4
// widened it only as far as the drafting role.
const ANALYST_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
  CAPABILITIES.INGEST_REPORTS,
  CAPABILITIES.TRIAGE_FINDINGS,
  CAPABILITIES.MANAGE_CASES,
  CAPABILITIES.READ_NOTIFICATIONS,
  CAPABILITIES.MANAGE_NOTIFICATIONS,
  CAPABILITIES.EXPORT_NOTIFICATIONS,
  CAPABILITIES.RECORD_NOTIFICATION_DELIVERY,
]
const REVIEWER_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
  CAPABILITIES.READ_NOTIFICATIONS,
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
      'Operations overview',
      'Findings',
      'Report ingestion',
      'Cases',
      'Notifications',
      'Organizations',
      'Analytics',
      'ATT&CK navigator',
      'Settings',
    ].forEach((label) => expect(screen.getByText(label)).toBeInTheDocument())
  })

  // UX Ticket A: Analytics/ATT&CK navigator moved out of "Administration" into
  // their own "Insight" group. All four headings must render, and the two
  // moved items must sit under the new heading rather than the old one.
  it('renders four groups with Analytics and ATT&CK navigator under Insight, not Administration', () => {
    renderSidebar(CAPABILITY_VALUES)

    ;['Operations', 'Response', 'Insight', 'Administration'].forEach((heading) =>
      expect(screen.getByText(heading)).toBeInTheDocument()
    )

    const insightList = document.querySelector('[aria-labelledby="nav-group-Insight"]')
    const adminList = document.querySelector('[aria-labelledby="nav-group-Administration"]')
    expect(insightList).toContainElement(screen.getByText('Analytics'))
    expect(insightList).toContainElement(screen.getByText('ATT&CK navigator'))
    expect(adminList).toContainElement(screen.getByText('Organizations'))
    expect(adminList).toContainElement(screen.getByText('Settings'))
  })

  it('hides ADMIN-only navigation from ANALYST', () => {
    renderSidebar(ANALYST_CAPABILITIES)

    expect(screen.queryByText('Organizations')).not.toBeInTheDocument()
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
    // ANALYST still gets the work it's granted for.
    expect(screen.getByText('Report ingestion')).toBeInTheDocument()
    expect(screen.getByText('Cases')).toBeInTheDocument()
    expect(screen.getByText('ATT&CK navigator')).toBeInTheDocument()
    // Phase 4: an analyst drafts, edits and exports notifications, so the
    // section is theirs too — it is no longer reviewer-only.
    expect(screen.getByText('Notifications')).toBeInTheDocument()
  })

  it('hides upload and admin settings from REVIEWER, but not the cases they review', () => {
    renderSidebar(REVIEWER_CAPABILITIES)

    expect(screen.queryByText('Report ingestion')).not.toBeInTheDocument()
    expect(screen.queryByText('Organizations')).not.toBeInTheDocument()
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
    // Phase 3: a reviewer cannot decide a closure on a case they cannot open.
    expect(screen.getByText('Cases')).toBeInTheDocument()
    expect(screen.getByText('ATT&CK navigator')).toBeInTheDocument()
    // REVIEWER still gets its own review-specific surface.
    expect(screen.getByText('Notifications')).toBeInTheDocument()
  })

  it('shows only read-only navigation to VIEWER', () => {
    renderSidebar(VIEWER_CAPABILITIES)

    expect(screen.getByText('Operations overview')).toBeInTheDocument()
    expect(screen.getByText('Findings')).toBeInTheDocument()
    expect(screen.getByText('Analytics')).toBeInTheDocument()
    // Phase 3 read-only case oversight is an explicit requirement.
    expect(screen.getByText('Cases')).toBeInTheDocument()
    expect(screen.getByText('ATT&CK navigator')).toBeInTheDocument()
    ;['Report ingestion', 'Notifications', 'Organizations', 'Settings'].forEach((label) =>
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    )
  })

  it('never renders a menu item the user lacks the capability for', () => {
    renderSidebar([])
    ;[
      'Operations overview',
      'Findings',
      'Report ingestion',
      'Cases',
      'Notifications',
      'Organizations',
      'Analytics',
      'ATT&CK navigator',
      'Settings',
    ].forEach((label) => expect(screen.queryByText(label)).not.toBeInTheDocument())
  })
})
