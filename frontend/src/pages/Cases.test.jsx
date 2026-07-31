import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

import { Cases } from './Cases'
import { CAPABILITIES } from '../constants/capabilities'
import * as useAuthModule from '../hooks/useAuth'
import { caseService, organizationService } from '../services/api'

// The Phase 3 case list.
//
// Reachable by every role on `read:cases`; only the mutation control is gated.
// The list is also the one screen that must never present the legacy free-text
// `status` column as if it were the authoritative lifecycle state — the two are
// different concepts and the backend returns both.

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../services/api', () => ({
  caseService: {
    getCases: vi.fn(),
    createCase: vi.fn(),
  },
  organizationService: {
    getOrganizations: vi.fn(),
  },
}))

const ADMIN_CAPABILITIES = Object.values(CAPABILITIES)
const ANALYST_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
  CAPABILITIES.TRIAGE_FINDINGS,
  CAPABILITIES.MANAGE_CASES,
]
const REVIEWER_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_CASES,
  CAPABILITIES.REVIEW_CASE_CLOSURE,
]
const VIEWER_CAPABILITIES = [CAPABILITIES.READ_DASHBOARD, CAPABILITIES.READ_CASES]

const CASES = [
  {
    id: 4,
    caseReference: 'TNX-2026-000004',
    title: 'Accessible RDP on a constituent host',
    threatType: 'Accessible RDP',
    priority: 'High',
    status: 'Open',
    lifecycleState: 'OPEN',
    analyst: 'a.analyst',
    organization: 'Acme Bank',
    organizationId: 3,
    ownerOrganization: { id: 3, name: 'Acme Bank', sector: 'FINANCE' },
    reopenedByRecurrence: false,
    reopenedCount: 0,
    linkedFindingCount: 2,
  },
  {
    id: 5,
    caseReference: 'TNX-2026-000005',
    title: 'Recurring exposure at Beta Utilities',
    threatType: 'Accessible RDP',
    priority: 'Critical',
    // The legacy free-text column deliberately disagrees with the enum, so a
    // screen that rendered the wrong one is visible.
    status: 'Closed',
    lifecycleState: 'OPEN',
    analyst: 'b.analyst',
    organization: 'Beta Utilities',
    organizationId: 6,
    ownerOrganization: { id: 6, name: 'Beta Utilities', sector: 'ENERGY' },
    reopenedByRecurrence: true,
    reopenedCount: 1,
    linkedFindingCount: 1,
  },
  {
    id: 6,
    caseReference: null,
    title: 'Legacy investigation',
    threatType: 'Phishing',
    priority: 'Low',
    status: 'Open',
    lifecycleState: 'CLOSURE_PENDING',
    analyst: 'c.analyst',
    organization: 'Unbound Co',
    organizationId: null,
    ownerOrganization: null,
    reopenedByRecurrence: false,
    reopenedCount: 0,
    linkedFindingCount: 0,
  },
]

function renderCases(capabilities, rows = CASES) {
  vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
    user: { id: 1, capabilities },
    capabilities,
  })
  caseService.getCases.mockResolvedValue({ data: { data: rows } })
  organizationService.getOrganizations.mockResolvedValue({ data: { data: [] } })
  return render(
    <MemoryRouter>
      <Cases />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('case list — presentation', () => {
  it('renders the reference, organization, evidence count and lifecycle state', async () => {
    renderCases(VIEWER_CAPABILITIES)

    expect(await screen.findByText('TNX-2026-000004')).toBeInTheDocument()
    expect(screen.getByText('Acme Bank')).toBeInTheDocument()
    expect(screen.getByText('2 findings')).toBeInTheDocument()
    expect(screen.getByTestId('case-state-4')).toHaveTextContent('Open')
  })

  // The legacy `status` column and the Phase 3 `lifecycleState` enum are
  // different concepts. Case 5 has status "Closed" and lifecycleState OPEN;
  // the state chip must follow the enum.
  it('shows the authoritative lifecycle state, not the legacy status column', async () => {
    renderCases(VIEWER_CAPABILITIES)

    expect(await screen.findByTestId('case-state-5')).toHaveTextContent('Open')
    expect(screen.getByTestId('case-state-6')).toHaveTextContent('Closure pending review')
  })

  it('counts the tiles off the lifecycle state, so they cannot disagree with it', async () => {
    renderCases(VIEWER_CAPABILITIES)

    expect(await screen.findByTestId('case-count-OPEN')).toHaveTextContent('2')
    expect(screen.getByTestId('case-count-CLOSURE_PENDING')).toHaveTextContent('1')
    expect(screen.getByTestId('case-count-CLOSED')).toHaveTextContent('0')
  })

  it('badges a case reopened by a recurrence, and only that one', async () => {
    renderCases(VIEWER_CAPABILITIES)

    expect(await screen.findByTestId('case-recurrence-5')).toBeInTheDocument()
    expect(screen.queryByTestId('case-recurrence-4')).not.toBeInTheDocument()
  })

  it('marks a legacy case as unbound rather than inventing an organization', async () => {
    renderCases(VIEWER_CAPABILITIES)

    expect(await screen.findByText(/Unbound Co \(legacy, unbound\)/)).toBeInTheDocument()
  })
})

describe('case list — capability-aware controls', () => {
  it('offers no create control to VIEWER or REVIEWER', async () => {
    renderCases(VIEWER_CAPABILITIES)
    expect(await screen.findByText('TNX-2026-000004')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /new case/i })).not.toBeInTheDocument()

    vi.clearAllMocks()
    renderCases(REVIEWER_CAPABILITIES)
    await screen.findAllByText('TNX-2026-000004')
    expect(screen.queryByRole('button', { name: /new case/i })).not.toBeInTheDocument()
  })

  it('offers the create control to ANALYST', async () => {
    renderCases(ANALYST_CAPABILITIES)
    expect(await screen.findByRole('button', { name: /new case/i })).toBeInTheDocument()
  })

  // Cases are permanent records. The backend's DELETE route is a tombstone that
  // removes nothing, so no role is offered a delete control at all.
  it('offers no delete control to any role, including ADMIN', async () => {
    renderCases(ADMIN_CAPABILITIES)
    expect(await screen.findByText('TNX-2026-000004')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })

  it('lets every role open a case detail', async () => {
    renderCases(VIEWER_CAPABILITIES)
    const openButtons = await screen.findAllByRole('button', { name: /open/i })
    expect(openButtons.length).toBe(CASES.length)
  })
})

describe('case list — creation', () => {
  it('refuses to submit without an organization, and calls nothing', async () => {
    const user = userEvent.setup()
    const toast = (await import('react-hot-toast')).default
    renderCases(ANALYST_CAPABILITIES, [])

    await user.click(await screen.findByRole('button', { name: /new case/i }))
    await user.type(screen.getByLabelText('Case title'), 'New exposure')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(caseService.createCase).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('organization is required'))
  })

  it('sends a numeric organizationId with the case', async () => {
    const user = userEvent.setup()
    renderCases(ANALYST_CAPABILITIES)
    caseService.createCase.mockResolvedValue({ data: { data: { id: 9 } } })

    await user.click(await screen.findByRole('button', { name: /new case/i }))
    await user.type(screen.getByLabelText('Case title'), 'New exposure')
    // The picker is populated from the organizations already visible on
    // existing cases, because the organization registry itself is ADMIN-only.
    await user.click(screen.getByLabelText('Organization'))
    await user.click(screen.getByRole('option', { name: 'Acme Bank' }))
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(caseService.createCase).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'New exposure', organizationId: 3 }),
      ),
    )
  })

  it('falls back to a numeric id field when no organization is visible yet', async () => {
    const user = userEvent.setup()
    renderCases(ANALYST_CAPABILITIES, [])

    await user.click(await screen.findByRole('button', { name: /new case/i }))
    expect(screen.getByLabelText('Organization id')).toBeInTheDocument()
    expect(
      screen.getByText(/No organization is visible from here yet/i),
    ).toBeInTheDocument()
  })

  it('does not attempt the ADMIN-only organization registry as an ANALYST', async () => {
    renderCases(ANALYST_CAPABILITIES)
    await screen.findByText('TNX-2026-000004')
    expect(organizationService.getOrganizations).not.toHaveBeenCalled()
  })

  it('does load the organization registry for ADMIN', async () => {
    renderCases(ADMIN_CAPABILITIES)
    await screen.findByText('TNX-2026-000004')
    expect(organizationService.getOrganizations).toHaveBeenCalled()
  })
})
