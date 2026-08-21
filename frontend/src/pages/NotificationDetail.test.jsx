import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { NotificationDetail } from './NotificationDetail'
import { CAPABILITIES } from '../constants/capabilities'
import * as useAuthModule from '../hooks/useAuth'
import { notificationService } from '../services/api'

// The Phase 4 notification workspace.
//
// What these tests defend is capability-aware and STATE-aware rendering, which
// is UX only: the backend re-checks every capability and every state guard on
// every request, and refuses a write whether or not this screen ever drew the
// button. What would actually be a defect is the opposite direction — offering
// a control the caller cannot use, or hiding one they can — so that is what is
// asserted, in both directions, for every role.

vi.mock('react-hot-toast', () => {
  const toast = vi.fn()
  toast.success = vi.fn()
  toast.error = vi.fn()
  return { default: toast }
})

vi.mock('../services/api', () => ({
  notificationService: {
    getNotification: vi.fn(),
    editRevision: vi.fn(),
    submitForReview: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    exportNotification: vi.fn(),
    recordDelivery: vi.fn(),
    recordResponse: vi.fn(),
  },
}))

const ADMIN_CAPABILITIES = Object.values(CAPABILITIES)
const ANALYST_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
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
  CAPABILITIES.REVIEW_CASE_CLOSURE,
]

/** A notification detail in the shape the backend actually serializes. */
function detailView(overrides = {}) {
  const state = overrides.state || 'DRAFT'
  return {
    notification: {
      id: 7,
      notificationReference: 'TNX-NOT-2026-000007',
      caseId: 4,
      organizationId: 3,
      organization: { id: 3, name: 'Acme Bank', sector: 'FINANCE' },
      lifecycleState: state,
      approvedRevisionId: overrides.approvedRevisionId ?? null,
      approvedByUserId: overrides.approvedByUserId ?? null,
      approvedAt: overrides.approvedAt ?? null,
      createdByUserId: 10,
      createdAt: '2026-08-03T09:00:00.000Z',
      ...overrides.notification,
    },
    currentRevision: {
      id: 51,
      notificationId: 7,
      revisionNumber: 2,
      subject: 'Accessible RDP service exposure notification — TNX-2026-000004',
      body: 'Dear Acme Bank security contact,\n\n1. 203.0.113.10 port 3389/tcp',
      remediationGuidance: 'Recommended actions:\n\n1. Restrict access.',
      recipientName: 'Sec Contact',
      recipientEmailMasked: 's**@acme.example',
      hasRecipientEmail: true,
      analystNotes: 'Internal: ownership confirmed.',
      contentChecksum: 'a'.repeat(64),
      createdAt: '2026-08-03T10:00:00.000Z',
      supersededAt: null,
      isCurrent: true,
      ...overrides.currentRevision,
    },
    revisions: overrides.revisions ?? [
      {
        id: 51,
        revisionNumber: 2,
        subject: 'Accessible RDP service exposure notification — TNX-2026-000004',
        contentChecksum: 'a'.repeat(64),
        createdAt: '2026-08-03T10:00:00.000Z',
        supersededAt: null,
        isCurrent: true,
      },
      {
        id: 50,
        revisionNumber: 1,
        subject: 'Original subject',
        contentChecksum: 'b'.repeat(64),
        createdAt: '2026-08-03T09:00:00.000Z',
        supersededAt: '2026-08-03T10:00:00.000Z',
        isCurrent: false,
      },
    ],
    lifecycleEvents: overrides.lifecycleEvents ?? [
      {
        id: 81,
        notificationId: 7,
        eventType: 'DRAFT_CREATED',
        fromState: null,
        toState: 'DRAFT',
        revisionId: 50,
        revisionNumber: 1,
        reasonCode: 'DRAFT_CREATED_FROM_CASE',
        note: null,
        occurredAt: '2026-08-03T09:00:00.000Z',
      },
    ],
    exports: overrides.exports ?? [],
    deliveryEvents: overrides.deliveryEvents ?? [],
    case: {
      id: 4,
      caseReference: 'TNX-2026-000004',
      title: 'Accessible RDP',
      lifecycleState: 'OPEN',
      ...overrides.case,
    },
    caseResponses: overrides.caseResponses ?? [],
    permittedActions: {
      isWorkflowBound: true,
      canEdit: state === 'DRAFT' || state === 'APPROVED' || state === 'REJECTED',
      canSubmitForReview: state === 'DRAFT',
      canReview: state === 'PENDING_REVIEW',
      canExport: false,
      exportRefusalCode: 'NOTIFICATION_NOT_APPROVED',
      canRecordDelivery: false,
      canRecordOrganizationResponse: true,
      currentState: state,
      approvedForCurrentRevision: false,
      ...overrides.permittedActions,
    },
  }
}

function renderDetail(capabilities, view = detailView()) {
  vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
    // No `capabilities` inside user — see FrameworkMappingPanel.test.jsx.
    user: { id: 1 },
    capabilities,
  })
  notificationService.getNotification.mockResolvedValue({ data: { data: view } })
  return render(
    <MemoryRouter initialEntries={['/notifications/7']}>
      <Routes>
        <Route path="/notifications/:id" element={<NotificationDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shared presentation', () => {
  it('renders the reference, state, organization and current revision', async () => {
    renderDetail(ANALYST_CAPABILITIES)

    // The reference also appears as the trailing breadcrumb crumb now, so
    // this scopes to the page's one <h1> rather than an ambiguous text match.
    expect(
      await screen.findByRole('heading', { name: 'TNX-NOT-2026-000007' }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('lifecycle-state')).toHaveTextContent('Draft')
    expect(screen.getByText('Acme Bank')).toBeInTheDocument()
    expect(screen.getByTestId('current-revision')).toHaveTextContent('Revision 2')
  })

  it('states plainly that nothing is ever sent', async () => {
    renderDetail(ANALYST_CAPABILITIES)
    expect(await screen.findByTestId('no-send-banner')).toHaveTextContent(
      /does not send messages/i,
    )
  })

  it('shows the recipient with a MASKED address, never the full one', async () => {
    renderDetail(ANALYST_CAPABILITIES)
    const recipient = await screen.findByTestId('recipient')
    expect(recipient).toHaveTextContent('s**@acme.example')
    expect(recipient).not.toHaveTextContent('soc@acme.example')
  })

  it('renders the immutable revision history with exactly one current revision', async () => {
    renderDetail(ANALYST_CAPABILITIES)
    await screen.findByTestId('revision-history')
    expect(screen.getByTestId('revision-2')).toHaveTextContent('Current')
    expect(screen.getByTestId('revision-1')).not.toHaveTextContent('Current')
  })

  it('links back to the case it was drafted from', async () => {
    renderDetail(ANALYST_CAPABILITIES)
    expect(await screen.findByTestId('open-case')).toHaveTextContent('TNX-2026-000004')
  })
})

describe('capability-aware controls', () => {
  it('gives an ANALYST the editor, submit and export controls but no review panel', async () => {
    renderDetail(ANALYST_CAPABILITIES)

    expect(await screen.findByTestId('editor')).toBeInTheDocument()
    expect(screen.getByTestId('submit-for-review')).toBeInTheDocument()
    expect(screen.getByTestId('export-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('review-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approve')).not.toBeInTheDocument()
    expect(screen.queryByTestId('reject')).not.toBeInTheDocument()
  })

  it('gives a REVIEWER the review panel but no editor, submit, export or delivery form', async () => {
    renderDetail(REVIEWER_CAPABILITIES, detailView({ state: 'PENDING_REVIEW' }))

    expect(await screen.findByTestId('review-panel')).toBeInTheDocument()
    expect(screen.getByTestId('approve')).toBeInTheDocument()
    expect(screen.getByTestId('reject')).toBeInTheDocument()

    expect(screen.queryByTestId('editor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('submit-for-review')).not.toBeInTheDocument()
    expect(screen.queryByTestId('export-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('delivery-form')).not.toBeInTheDocument()
    // A reviewer holds no manage:cases either, so no response form.
    expect(screen.queryByTestId('response-form')).not.toBeInTheDocument()
  })

  it('shows a REVIEWER the content read-only, including the internal notes they are approving', async () => {
    renderDetail(REVIEWER_CAPABILITIES, detailView({ state: 'PENDING_REVIEW' }))

    const readOnly = await screen.findByTestId('read-only-content')
    expect(readOnly).toHaveTextContent('203.0.113.10 port 3389/tcp')
    expect(readOnly).toHaveTextContent('Internal: ownership confirmed.')
  })

  it('gives an ADMIN every control at once', async () => {
    renderDetail(ADMIN_CAPABILITIES, detailView({ state: 'PENDING_REVIEW' }))
    // PENDING_REVIEW is not editable by anyone, so no editor — but the review
    // panel and the export panel are both present for an administrator.
    expect(await screen.findByTestId('review-panel')).toBeInTheDocument()
    expect(screen.getByTestId('export-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('editor')).not.toBeInTheDocument()
  })
})

describe('state-aware controls', () => {
  it('hides the editor while a reviewer is deciding, for the analyst too', async () => {
    renderDetail(ANALYST_CAPABILITIES, detailView({ state: 'PENDING_REVIEW' }))

    await screen.findByTestId('current-revision')
    expect(screen.queryByTestId('editor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('submit-for-review')).not.toBeInTheDocument()
  })

  it('warns before an edit that would withdraw a standing approval', async () => {
    renderDetail(
      ANALYST_CAPABILITIES,
      detailView({
        state: 'APPROVED',
        approvedRevisionId: 51,
        approvedByUserId: 11,
        approvedAt: '2026-08-03T12:00:00.000Z',
        permittedActions: {
          canExport: true,
          exportRefusalCode: null,
          approvedForCurrentRevision: true,
        },
      }),
    )

    expect(await screen.findByTestId('edit-invalidates-approval')).toHaveTextContent(
      /withdraws the approval/i,
    )
  })

  it('disables export and explains WHY, from the server refusal code', async () => {
    renderDetail(
      ANALYST_CAPABILITIES,
      detailView({
        state: 'DRAFT',
        permittedActions: {
          canExport: false,
          exportRefusalCode: 'APPROVAL_NOT_FOR_CURRENT_REVISION',
        },
      }),
    )

    expect(await screen.findByTestId('export-button')).toBeDisabled()
    expect(screen.getByTestId('export-refusal')).toHaveTextContent(
      /edited after it was approved/i,
    )
  })

  it('enables export only when the server says the approval covers the current revision', async () => {
    renderDetail(
      ANALYST_CAPABILITIES,
      detailView({
        state: 'APPROVED',
        approvedRevisionId: 51,
        approvedByUserId: 11,
        permittedActions: {
          canExport: true,
          exportRefusalCode: null,
          approvedForCurrentRevision: true,
        },
      }),
    )

    expect(await screen.findByTestId('export-button')).toBeEnabled()
    expect(screen.queryByTestId('export-refusal')).not.toBeInTheDocument()
  })

  it('hides the delivery form until the notification has actually been exported', async () => {
    renderDetail(ANALYST_CAPABILITIES, detailView({ state: 'APPROVED' }))
    await screen.findByTestId('delivery-timeline')
    expect(screen.queryByTestId('delivery-form')).not.toBeInTheDocument()
    expect(screen.getByTestId('no-delivery-events')).toHaveTextContent(
      /not evidence that anything was sent/i,
    )
  })

  it('shows the delivery form once an export exists', async () => {
    renderDetail(
      ANALYST_CAPABILITIES,
      detailView({
        state: 'APPROVED',
        exports: [
          {
            id: 91,
            revisionId: 51,
            revisionNumber: 2,
            format: 'EML',
            artifactChecksum: 'c'.repeat(64),
            artifactByteLength: 1234,
            filename: 'notification-TNX-NOT-2026-000007-rev2.eml',
            exportedAt: '2026-08-03T13:00:00.000Z',
          },
        ],
        permittedActions: { canRecordDelivery: true },
      }),
    )

    expect(await screen.findByTestId('delivery-form')).toBeInTheDocument()
    expect(screen.getByTestId('export-91')).toHaveTextContent(
      'notification-TNX-NOT-2026-000007-rev2.eml',
    )
  })
})

describe('editing', () => {
  it('sends only the six content fields, never a state or approval field', async () => {
    const user = userEvent.setup()
    renderDetail(ANALYST_CAPABILITIES)
    notificationService.editRevision.mockResolvedValue({
      data: { data: detailView(), outcome: 'REVISED' },
    })

    const subject = await screen.findByTestId('edit-subject')
    await user.clear(subject)
    await user.type(subject, 'Corrected subject')
    await user.click(screen.getByTestId('save-revision'))

    await waitFor(() => expect(notificationService.editRevision).toHaveBeenCalled())
    const [, payload] = notificationService.editRevision.mock.calls[0]
    expect(Object.keys(payload).sort()).toEqual([
      'analystNotes',
      'body',
      'recipientName',
      'remediationGuidance',
      'subject',
    ])
    expect(payload.subject).toBe('Corrected subject')
    expect(payload).not.toHaveProperty('lifecycleState')
    expect(payload).not.toHaveProperty('approvedByUserId')
    expect(payload).not.toHaveProperty('contentChecksum')
  })

  it('reports an UNCHANGED edit distinctly rather than claiming a revision was created', async () => {
    const user = userEvent.setup()
    const toast = (await import('react-hot-toast')).default
    renderDetail(ANALYST_CAPABILITIES)
    notificationService.editRevision.mockResolvedValue({
      data: { data: detailView(), outcome: 'UNCHANGED' },
    })

    await screen.findByTestId('editor')
    await user.click(screen.getByTestId('save-revision'))

    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/no revision was created/i))
    expect(toast.success).not.toHaveBeenCalledWith('Revision saved.')
  })
})

describe('review', () => {
  it('requires a reason before the reject button becomes usable', async () => {
    const user = userEvent.setup()
    renderDetail(REVIEWER_CAPABILITIES, detailView({ state: 'PENDING_REVIEW' }))

    const reject = await screen.findByTestId('reject')
    expect(reject).toBeDisabled()

    await user.type(screen.getByTestId('reject-reason'), 'The guidance is wrong.')
    expect(screen.getByTestId('reject')).toBeEnabled()
  })

  it('sends the review note with an approval', async () => {
    const user = userEvent.setup()
    renderDetail(REVIEWER_CAPABILITIES, detailView({ state: 'PENDING_REVIEW' }))
    notificationService.approve.mockResolvedValue({
      data: { data: detailView({ state: 'APPROVED' }) },
    })

    await user.type(await screen.findByTestId('review-note'), 'Matches the evidence.')
    await user.click(screen.getByTestId('approve'))

    await waitFor(() =>
      expect(notificationService.approve).toHaveBeenCalledWith('7', 'Matches the evidence.'),
    )
  })
})

describe('delivery recording', () => {
  const exportedView = () =>
    detailView({
      state: 'APPROVED',
      exports: [
        {
          id: 91,
          revisionId: 51,
          revisionNumber: 2,
          format: 'EML',
          artifactChecksum: 'c'.repeat(64),
          artifactByteLength: 1234,
          filename: 'notification.eml',
          exportedAt: '2026-08-03T13:00:00.000Z',
        },
      ],
      permittedActions: { canRecordDelivery: true },
    })

  it('submits an explicit occurredAt as an ISO instant', async () => {
    const user = userEvent.setup()
    renderDetail(ANALYST_CAPABILITIES, exportedView())
    notificationService.recordDelivery.mockResolvedValue({ data: { data: exportedView() } })

    await screen.findByTestId('delivery-form')
    await user.click(screen.getByTestId('record-delivery'))

    await waitFor(() => expect(notificationService.recordDelivery).toHaveBeenCalled())
    const [, payload] = notificationService.recordDelivery.mock.calls[0]
    expect(payload.status).toBe('SENT_MANUALLY')
    expect(payload.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('blocks submission on an invalid occurredAt rather than round-tripping to find out', async () => {
    const user = userEvent.setup()
    renderDetail(ANALYST_CAPABILITIES, exportedView())

    const field = await screen.findByLabelText('When it happened')
    await user.clear(field)

    expect(screen.getByTestId('record-delivery')).toBeDisabled()
    expect(notificationService.recordDelivery).not.toHaveBeenCalled()
  })

  it('renders an existing delivery timeline without inferring anything', async () => {
    renderDetail(
      ANALYST_CAPABILITIES,
      detailView({
        state: 'APPROVED',
        deliveryEvents: [
          {
            id: 101,
            status: 'BOUNCED',
            revisionNumber: 2,
            occurredAt: '2026-08-03T14:00:00.000Z',
            recordedAt: '2026-08-03T14:05:00.000Z',
            reference: 'TICKET-9',
            note: 'Mailbox full.',
          },
        ],
      }),
    )

    const row = await screen.findByTestId('delivery-101')
    expect(row).toHaveTextContent('Bounced')
    expect(row).toHaveTextContent('TICKET-9')
  })
})

describe('organization responses', () => {
  it('shows the case responses and lets a capable analyst record one', async () => {
    const user = userEvent.setup()
    renderDetail(
      ANALYST_CAPABILITIES,
      detailView({
        caseResponses: [
          {
            id: 71,
            caseId: 4,
            responseType: 'ACKNOWLEDGED',
            summary: 'Constituent acknowledged.',
            reference: null,
            occurredAt: '2026-08-04T10:00:00.000Z',
            recordedAt: '2026-08-04T10:05:00.000Z',
          },
        ],
      }),
    )
    notificationService.recordResponse.mockResolvedValue({ data: { data: detailView() } })

    expect(await screen.findByTestId('response-71')).toHaveTextContent('Acknowledged')

    await user.type(screen.getByTestId('response-summary'), 'They replied by email.')
    await user.click(screen.getByTestId('record-response'))

    await waitFor(() => expect(notificationService.recordResponse).toHaveBeenCalled())
    const [, payload] = notificationService.recordResponse.mock.calls[0]
    expect(payload.responseType).toBe('ACKNOWLEDGED')
    expect(payload.summary).toBe('They replied by email.')
    expect(payload.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('requires a summary before a response can be recorded', async () => {
    renderDetail(ANALYST_CAPABILITIES)
    await screen.findByTestId('response-form')
    expect(screen.getByTestId('record-response')).toBeDisabled()
  })
})

describe('no transport from the browser either', () => {
  it('never renders a mailto: link or any send control', async () => {
    const { container } = renderDetail(
      ANALYST_CAPABILITIES,
      detailView({
        state: 'APPROVED',
        permittedActions: { canExport: true, exportRefusalCode: null },
      }),
    )

    await screen.findByTestId('export-panel')
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull()
    expect(screen.queryByText(/^send$/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send (now|email|notification)/i })).toBeNull()
  })
})

// True when `first` appears before `second` in document order.
function precedes(first, second) {
  // eslint-disable-next-line no-bitwise
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe('UX Ticket B: decision-first hierarchy', () => {
  it('puts current revision, export and the export/delivery/history disclosures in that order', async () => {
    renderDetail(
      ANALYST_CAPABILITIES,
      detailView({
        state: 'APPROVED',
        permittedActions: { canExport: true, exportRefusalCode: null },
      }),
    )

    const current = await screen.findByTestId('current-revision')
    const exportPanel = screen.getByTestId('export-panel')
    const exportHistory = screen.getByTestId('export-history')
    const lifecycleHistory = screen.getByTestId('lifecycle-history')

    expect(precedes(current, exportPanel)).toBe(true)
    expect(precedes(exportPanel, exportHistory)).toBe(true)
    expect(precedes(exportHistory, lifecycleHistory)).toBe(true)
  })

  it('collapses history disclosures by default, without losing any of it', async () => {
    renderDetail(
      ANALYST_CAPABILITIES,
      detailView({
        deliveryEvents: [
          {
            id: 101,
            status: 'BOUNCED',
            revisionNumber: 2,
            occurredAt: '2026-08-03T14:00:00.000Z',
            recordedAt: '2026-08-03T14:05:00.000Z',
            reference: 'TICKET-9',
            note: 'Mailbox full.',
          },
        ],
      }),
    )

    const deliveryTimeline = await screen.findByTestId('delivery-timeline')
    const revisionHistory = screen.getByTestId('revision-history')
    expect(deliveryTimeline).not.toHaveAttribute('open')
    expect(revisionHistory).not.toHaveAttribute('open')
    // Collapsed never means removed — a real delivery problem is still
    // findable, and its summary line surfaces it without opening anything.
    expect(deliveryTimeline).toHaveTextContent('TICKET-9')
    expect(screen.getByText(/Delivery timeline .* a delivery issue was reported/)).toBeInTheDocument()
  })

  it('opens a history disclosure on click, reaching the content inside it', async () => {
    const user = userEvent.setup()
    renderDetail(ANALYST_CAPABILITIES)

    const revisionHistory = await screen.findByTestId('revision-history')
    expect(revisionHistory).not.toHaveAttribute('open')

    await user.click(screen.getByText(/Revision history — 2 revisions/))

    expect(revisionHistory).toHaveAttribute('open')
    expect(screen.getByTestId('revision-2')).toBeInTheDocument()
  })
})
