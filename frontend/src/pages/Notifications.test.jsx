import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

import { Notifications } from './Notifications'
import { CAPABILITIES } from '../constants/capabilities'
import * as useAuthModule from '../hooks/useAuth'
import { notificationService } from '../services/api'

// The Phase 4 notification list.
//
// The properties worth defending here are that the screen shows only rows the
// workflow can act on, that its state tiles are counted off the authoritative
// lifecycleState rather than a legacy column, and that the "exportable" badge
// comes from the SERVER's eligibility answer rather than from the state alone —
// an APPROVED notification that was edited afterwards is NOT exportable and
// must not look like it is.

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../services/api', () => ({
  notificationService: {
    getNotifications: vi.fn(),
  },
}))

const ANALYST_CAPABILITIES = [
  CAPABILITIES.READ_NOTIFICATIONS,
  CAPABILITIES.MANAGE_NOTIFICATIONS,
  CAPABILITIES.EXPORT_NOTIFICATIONS,
  CAPABILITIES.RECORD_NOTIFICATION_DELIVERY,
]
const REVIEWER_CAPABILITIES = [
  CAPABILITIES.READ_NOTIFICATIONS,
  CAPABILITIES.REVIEW_NOTIFICATIONS,
]

function row(overrides = {}) {
  return {
    id: 7,
    notificationReference: 'TNX-NOT-2026-000007',
    caseId: 4,
    organizationId: 3,
    organization: { id: 3, name: 'Acme Bank', sector: 'FINANCE' },
    lifecycleState: 'DRAFT',
    approvedRevisionId: null,
    approvedByUserId: null,
    approvedAt: null,
    createdAt: '2026-08-03T09:00:00.000Z',
    currentRevision: {
      id: 51,
      revisionNumber: 2,
      subject: 'Accessible RDP exposure notification',
      contentChecksum: 'a'.repeat(64),
      isCurrent: true,
    },
    exportCount: 0,
    deliveryEventCount: 0,
    exportEligible: false,
    ...overrides,
  }
}

function renderList(capabilities, notifications = [row()]) {
  vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
    // No `capabilities` inside user — see FrameworkMappingPanel.test.jsx.
    user: { id: 1 },
    capabilities,
  })
  notificationService.getNotifications.mockResolvedValue({
    data: { data: { notifications, total: notifications.length, page: 1, limit: 25 } },
  })
  return render(
    <MemoryRouter initialEntries={['/notifications']}>
      <Notifications />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('list rendering', () => {
  it('renders a notification with its reference, organization, subject and state', async () => {
    renderList(ANALYST_CAPABILITIES)

    expect(await screen.findByText('TNX-NOT-2026-000007')).toBeInTheDocument()
    expect(screen.getByText('Acme Bank')).toBeInTheDocument()
    expect(screen.getByText('Accessible RDP exposure notification')).toBeInTheDocument()
    expect(screen.getByTestId('state-7')).toHaveTextContent('Draft')
  })

  it('counts the state tiles off the authoritative lifecycleState', async () => {
    renderList(ANALYST_CAPABILITIES, [
      row({ id: 1, lifecycleState: 'DRAFT' }),
      row({ id: 2, lifecycleState: 'PENDING_REVIEW' }),
      row({ id: 3, lifecycleState: 'APPROVED' }),
      row({ id: 4, lifecycleState: 'APPROVED' }),
    ])

    await screen.findByTestId('tile-DRAFT')
    expect(screen.getByTestId('tile-DRAFT')).toHaveTextContent('1')
    expect(screen.getByTestId('tile-PENDING_REVIEW')).toHaveTextContent('1')
    expect(screen.getByTestId('tile-APPROVED')).toHaveTextContent('2')
    expect(screen.getByTestId('tile-REJECTED')).toHaveTextContent('0')
  })

  it('directs the analyst to a case when there is nothing to show', async () => {
    renderList(ANALYST_CAPABILITIES, [])

    const empty = await screen.findByTestId('empty-state')
    // Never a "New notification" button here: a notification must be built
    // from a case's real evidence.
    expect(empty).toHaveTextContent(/drafted from a case/i)
    expect(screen.queryByText(/new notification/i)).not.toBeInTheDocument()
  })
})

describe('badges follow the server, not the state alone', () => {
  it('shows "Exportable" only when the server says the approval covers the current revision', async () => {
    renderList(ANALYST_CAPABILITIES, [
      row({ id: 1, lifecycleState: 'APPROVED', exportEligible: true }),
      // APPROVED but edited since — the server says not eligible.
      row({ id: 2, lifecycleState: 'APPROVED', exportEligible: false }),
    ])

    await screen.findByTestId('exportable-1')
    expect(screen.getByTestId('exportable-1')).toBeInTheDocument()
    expect(screen.queryByTestId('exportable-2')).not.toBeInTheDocument()
  })

  it('hides the exportable badge from a caller without the export capability', async () => {
    renderList(REVIEWER_CAPABILITIES, [
      row({ id: 1, lifecycleState: 'APPROVED', exportEligible: true }),
    ])

    await screen.findByTestId('state-1')
    expect(screen.queryByTestId('exportable-1')).not.toBeInTheDocument()
  })

  it('flags a pending review only to a reviewer', async () => {
    renderList(REVIEWER_CAPABILITIES, [row({ id: 1, lifecycleState: 'PENDING_REVIEW' })])
    expect(await screen.findByTestId('awaiting-review-1')).toBeInTheDocument()
  })

  it('does not flag a pending review to an analyst who cannot decide it', async () => {
    renderList(ANALYST_CAPABILITIES, [row({ id: 1, lifecycleState: 'PENDING_REVIEW' })])
    await screen.findByTestId('state-1')
    expect(screen.queryByTestId('awaiting-review-1')).not.toBeInTheDocument()
  })
})

describe('filtering', () => {
  it('asks the backend for a bounded page and passes the state filter through', async () => {
    const user = userEvent.setup()
    renderList(ANALYST_CAPABILITIES)

    await screen.findByTestId('state-7')
    expect(notificationService.getNotifications).toHaveBeenCalledWith({ page: 1, limit: 25 })

    await user.click(screen.getByLabelText('State'))
    await user.click(await screen.findByRole('option', { name: 'Approved' }))

    await waitFor(() =>
      expect(notificationService.getNotifications).toHaveBeenLastCalledWith({
        page: 1,
        limit: 25,
        state: 'APPROVED',
      }),
    )
  })
})
