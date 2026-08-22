import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { CaseDetail } from './CaseDetail'
import { CAPABILITIES } from '../constants/capabilities'
import * as useAuthModule from '../hooks/useAuth'
import {
  aiMappingService,
  attackService,
  caseWorkflowService,
  findingTriageService,
  frameworkMappingService,
  notificationService,
} from '../services/api'

// The Phase 3 case-detail screen.
//
// What these tests defend is capability-aware RENDERING, which is UX only: the
// backend re-checks every capability and every state guard on every request,
// and refuses a write whether or not this screen ever drew the button. What
// would actually be a defect is the opposite direction — offering a control the
// caller cannot use, or hiding one they can — so that is what is asserted.

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../services/api', () => ({
  caseWorkflowService: {
    getWorkflow: vi.fn(),
    linkFinding: vi.fn(),
    unlinkFinding: vi.fn(),
    changeState: vi.fn(),
    recordResponse: vi.fn(),
    requestClosure: vi.fn(),
    approveClosure: vi.fn(),
    rejectClosure: vi.fn(),
    reopenCase: vi.fn(),
  },
  findingTriageService: {
    getTriage: vi.fn(),
    updateTriage: vi.fn(),
  },
  // Phase 4 — the case screen lists the notifications drafted from this case
  // and offers "Draft notification" to holders of manage:notifications. The
  // list load is deliberately non-fatal, so it is mocked to resolve empty
  // unless a test says otherwise.
  notificationService: {
    getNotifications: vi.fn(),
    createDraft: vi.fn(),
  },
  // Phase 5 — the case screen embeds the framework-mapping workspace, which
  // fetches its own data. Mocked to resolve empty so these Phase 3/4 tests
  // stay about the case screen; the panel has its own dedicated suite in
  // components/FrameworkMappingPanel.test.jsx.
  frameworkMappingService: {
    listMappings: vi.fn(),
    getHistory: vi.fn(),
    createMapping: vi.fn(),
    removeMapping: vi.fn(),
    listNoApplicable: vi.fn(),
    assertNoApplicable: vi.fn(),
    withdrawNoApplicable: vi.fn(),
  },
  attackService: {
    getCatalogue: vi.fn(),
  },
  aiMappingService: {
    getConfig: vi.fn(),
    listSuggestions: vi.fn(),
    requestSuggestions: vi.fn(),
    approveSuggestion: vi.fn(),
    rejectSuggestion: vi.fn(),
  },
}))

const ADMIN_CAPABILITIES = Object.values(CAPABILITIES)
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
  CAPABILITIES.REVIEW_CASE_CLOSURE,
]
const VIEWER_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
]

/** A workflow view in the shape the backend actually serializes. */
function workflowView(overrides = {}) {
  return {
    case: {
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
      closedAt: null,
      closureReason: null,
      lastReopenTrigger: null,
      reopenedCount: 0,
      reopenedByRecurrence: false,
      createdAt: '2026-08-01T08:00:00.000Z',
      updatedAt: '2026-08-01T08:00:00.000Z',
      ...overrides.case,
    },
    linkedFindings: overrides.linkedFindings ?? [
      {
        id: 21,
        caseId: 4,
        findingId: 2,
        state: 'LINKED',
        organizationId: 3,
        ownershipStatusAtLink: 'RESOLVED',
        ownershipConfidenceAtLink: 'HIGH',
        reason: null,
        effectiveAt: '2026-08-01T10:00:00.000Z',
        supersededAt: null,
        isCurrent: true,
        finding: {
          id: 2,
          indicatorValue: '192.0.2.10',
          port: 3389,
          protocol: 'tcp',
          reportType: 'accessible-rdp',
          status: 'OPEN',
          occurrenceCount: 3,
          recurrenceCount: 1,
        },
      },
    ],
    lifecycleEvents: overrides.lifecycleEvents ?? [
      {
        id: 31,
        caseId: 4,
        eventType: 'CREATED',
        fromState: null,
        toState: 'OPEN',
        reasonCode: 'CASE_CREATED',
        note: null,
        occurredAt: '2026-08-01T08:00:00.000Z',
      },
    ],
    organizationResponses: overrides.organizationResponses ?? [],
    closureRequests: overrides.closureRequests ?? [],
    pendingClosureRequest: overrides.pendingClosureRequest ?? null,
    recurrenceReopens: overrides.recurrenceReopens ?? [],
    permittedActions: {
      isOrganizationBound: true,
      canLinkFindings: true,
      canUnlinkFindings: true,
      canRecordResponse: true,
      canRequestClosure: true,
      canReviewClosure: false,
      canReopen: false,
      availableStates: ['WAITING_FOR_ORG'],
      ...overrides.permittedActions,
    },
  }
}

function renderDetail(capabilities, view = workflowView()) {
  vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
    // No `capabilities` inside user — see FrameworkMappingPanel.test.jsx.
    user: { id: 1 },
    capabilities,
  })
  caseWorkflowService.getWorkflow.mockResolvedValue({ data: { data: view } })
  return render(
    <MemoryRouter initialEntries={['/cases/4']}>
      <Routes>
        <Route path="/cases/:id" element={<CaseDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // Phase 5 panel defaults: an empty, AI-disabled workspace. These tests are
  // about the Phase 3/4 case screen; the panel's own behaviour is asserted in
  // components/FrameworkMappingPanel.test.jsx.
  frameworkMappingService.listMappings.mockResolvedValue({
    data: {
      data: {
        caseId: 4,
        activeCount: 0,
        countMeaning: 'MAPPING_COUNT_NOT_COVERAGE',
        groups: [],
        disclaimer: 'Framework mappings record analyst-associated context only.',
        catalogueNote: 'MITRE ATT&CK references use the pinned local catalogue.',
      },
    },
  })
  frameworkMappingService.getHistory.mockResolvedValue({
    data: { data: { caseId: 4, total: 0, take: 50, skip: 0, history: [] } },
  })
  frameworkMappingService.listNoApplicable.mockResolvedValue({
    data: { data: { caseId: 4, standing: [], history: [] } },
  })
  attackService.getCatalogue.mockResolvedValue({
    data: { data: { catalogue: { attackVersion: 'v19.1', checksum: 'abc123' }, tactics: [], techniques: [], retiredExcluded: 0 } },
  })
  aiMappingService.getConfig.mockResolvedValue({
    data: {
      data: {
        aiEnabled: false,
        assistanceAvailable: false,
        providerName: 'disabled',
        promptTemplateVersion: 'framework-mapping-suggestion-v1',
        reasonCode: 'AI_DISABLED',
        maxSuggestionsPerRun: 5,
        disclaimer: 'Framework mappings record analyst-associated context only.',
      },
    },
  })
  aiMappingService.listSuggestions.mockResolvedValue({
    data: { data: { caseId: 4, total: 0, take: 50, skip: 0, runs: [], suggestions: [] } },
  })
  findingTriageService.getTriage.mockResolvedValue({
    data: {
      data: {
        findingId: 2,
        decision: 'ESCALATED',
        current: {
          id: 9,
          decision: 'ESCALATED',
          source: 'CASE_LINK',
          decidedAt: '2026-08-01T10:00:00.000Z',
          isCurrent: true,
        },
        history: [
          {
            id: 9,
            decision: 'ESCALATED',
            source: 'CASE_LINK',
            decidedAt: '2026-08-01T10:00:00.000Z',
            isCurrent: true,
          },
        ],
        linkedCases: [{ id: 4, caseReference: 'TNX-2026-000004' }],
        ownership: { status: 'RESOLVED', confidence: 'HIGH', isIspAttribution: false },
      },
    },
  })
  notificationService.getNotifications.mockResolvedValue({
    data: { data: { notifications: [], total: 0, page: 1, limit: 25 } },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('case detail — shared presentation', () => {
  it('renders the reference, lifecycle state, organization and linked evidence', async () => {
    renderDetail(VIEWER_CAPABILITIES)

    // The title also appears as the trailing breadcrumb crumb now, so this
    // scopes to the page's one <h1> rather than an ambiguous text match.
    expect(
      await screen.findByRole('heading', { name: 'Accessible RDP on a constituent host' }),
    ).toBeInTheDocument()
    expect(screen.getByText('TNX-2026-000004')).toBeInTheDocument()
    expect(screen.getByTestId('case-lifecycle-state')).toHaveTextContent('Open')
    expect(screen.getByText(/Acme Bank · FINANCE/)).toBeInTheDocument()
    expect(screen.getByText('192.0.2.10')).toBeInTheDocument()
    expect(screen.getByTestId('lifecycle-timeline')).toHaveTextContent('Case created')
  })

  it('shows the recurrence-reopened indicator only when the case was reopened by one', async () => {
    renderDetail(
      VIEWER_CAPABILITIES,
      workflowView({
        case: { lastReopenTrigger: 'RECURRENCE', reopenedCount: 2, reopenedByRecurrence: true },
        recurrenceReopens: [
          {
            id: 61,
            caseId: 4,
            findingId: 2,
            outcome: 'REOPENED',
            observedAt: '2026-08-10T06:00:00.000Z',
            processedAt: '2026-08-10T06:05:00.000Z',
          },
        ],
      }),
    )

    const badge = await screen.findByTestId('recurrence-reopened-indicator')
    expect(badge).toHaveTextContent('Reopened by recurrence ×2')
    expect(screen.getByTestId('recurrence-ledger')).toHaveTextContent('Reopened')
  })

  it('renders the recurrence ledger entries that declined to reopen, too', async () => {
    renderDetail(
      VIEWER_CAPABILITIES,
      workflowView({
        recurrenceReopens: [
          {
            id: 62,
            caseId: 4,
            findingId: 2,
            outcome: 'SKIPPED_CLOSURE_REASON_NOT_REMEDIATED',
            observedAt: '2026-08-10T06:00:00.000Z',
            processedAt: '2026-08-10T06:05:00.000Z',
          },
        ],
      }),
    )

    expect(await screen.findByTestId('recurrence-ledger')).toHaveTextContent(
      'Skipped — closure was not a remediation',
    )
  })

  it('warns that a legacy unbound case refuses every workflow action', async () => {
    renderDetail(
      ANALYST_CAPABILITIES,
      workflowView({
        case: { organizationId: null, ownerOrganization: null },
        permittedActions: {
          isOrganizationBound: false,
          canLinkFindings: false,
          canUnlinkFindings: false,
          canRecordResponse: false,
          canRequestClosure: false,
          canReviewClosure: false,
          canReopen: false,
          availableStates: [],
        },
      }),
    )

    // The header subtitle and the banner both say it; the banner is the one
    // that explains the consequence.
    expect(
      await screen.findByText(/every workflow action is refused on it/i),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('state-controls')).not.toBeInTheDocument()
    expect(screen.queryByTestId('link-finding')).not.toBeInTheDocument()
  })
})

describe('case detail — VIEWER is read-only', () => {
  it('renders every timeline but not one mutation control', async () => {
    renderDetail(
      VIEWER_CAPABILITIES,
      workflowView({
        organizationResponses: [
          {
            id: 41,
            caseId: 4,
            responseType: 'REMEDIATED',
            summary: 'Port closed at the perimeter',
            reference: 'TICKET-4711',
            occurredAt: '2026-08-03T09:00:00.000Z',
            recordedAt: '2026-08-03T09:00:00.000Z',
          },
        ],
      }),
    )

    expect(await screen.findByTestId('organization-responses')).toHaveTextContent(
      'Port closed at the perimeter',
    )
    expect(screen.getByTestId('lifecycle-timeline')).toBeInTheDocument()

    ;[
      'state-controls',
      'link-finding',
      'record-response',
      'request-closure',
      'approve-closure',
      'reject-closure',
      'reopen-case',
    ].forEach((testId) => expect(screen.queryByTestId(testId)).not.toBeInTheDocument())
  })

  it('offers no triage action inside the expanded finding panel', async () => {
    const user = userEvent.setup()
    renderDetail(VIEWER_CAPABILITIES)

    await user.click(await screen.findByTestId('toggle-triage-2'))

    expect(await screen.findByTestId('triage-state-2')).toHaveTextContent('Escalated')
    expect(screen.queryByRole('button', { name: /record triage/i })).not.toBeInTheDocument()
  })
})

describe('case detail — ANALYST management controls', () => {
  it('offers linking, responses, state change and closure request', async () => {
    renderDetail(ANALYST_CAPABILITIES)

    expect(await screen.findByTestId('link-finding')).toBeInTheDocument()
    expect(screen.getByTestId('record-response')).toBeInTheDocument()
    expect(screen.getByTestId('request-closure')).toBeInTheDocument()
    expect(screen.getByTestId('set-state-WAITING_FOR_ORG')).toBeInTheDocument()
    // An analyst can request a closure and can never decide one.
    expect(screen.queryByTestId('approve-closure')).not.toBeInTheDocument()
    expect(screen.queryByTestId('reject-closure')).not.toBeInTheDocument()
  })

  it('defaults the response occurredAt field to the current local date/time', async () => {
    renderDetail(ANALYST_CAPABILITIES)

    const input = await screen.findByTestId('response-occurred-at')
    const field = input.querySelector('input')
    // datetime-local values are "YYYY-MM-DDTHH:mm" — assert the shape and that
    // it is not blank, without depending on exactly which instant "now" is.
    expect(field.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })

  it('sends the selected occurredAt as an ISO timestamp when recording a response', async () => {
    const user = userEvent.setup()
    renderDetail(ANALYST_CAPABILITIES)
    caseWorkflowService.recordResponse.mockResolvedValue({ data: { data: workflowView() } })

    await user.type(await screen.findByLabelText('Summary (required)'), 'Confirmed remediation')
    const occurredAtInput = screen.getByTestId('response-occurred-at').querySelector('input')
    await user.clear(occurredAtInput)
    await user.type(occurredAtInput, '2026-08-02T14:30')
    await user.click(screen.getByTestId('record-response'))

    await waitFor(() =>
      expect(caseWorkflowService.recordResponse).toHaveBeenCalledWith(
        4,
        expect.objectContaining({
          summary: 'Confirmed remediation',
          occurredAt: new Date('2026-08-02T14:30').toISOString(),
        }),
      ),
    )
  })

  it('rejects an invalid occurredAt with clear validation feedback, and calls nothing', async () => {
    const user = userEvent.setup()
    renderDetail(ANALYST_CAPABILITIES)

    await user.type(await screen.findByLabelText('Summary (required)'), 'Confirmed remediation')
    const occurredAtInput = screen.getByTestId('response-occurred-at').querySelector('input')
    await user.clear(occurredAtInput)

    expect(screen.getByText('Enter a valid date and time.')).toBeInTheDocument()
    expect(screen.getByTestId('record-response')).toBeDisabled()
    expect(caseWorkflowService.recordResponse).not.toHaveBeenCalled()
  })

  it('links a finding and adopts the refreshed view the server returns', async () => {
    const user = userEvent.setup()
    renderDetail(ANALYST_CAPABILITIES)

    const linked = workflowView({
      case: { lifecycleState: 'OPEN' },
      linkedFindings: [
        ...workflowView().linkedFindings,
        {
          id: 22,
          caseId: 4,
          findingId: 7,
          state: 'LINKED',
          organizationId: 3,
          ownershipStatusAtLink: 'OVERRIDDEN',
          ownershipConfidenceAtLink: 'CONFIRMED',
          effectiveAt: '2026-08-01T11:00:00.000Z',
          supersededAt: null,
          isCurrent: true,
          finding: {
            id: 7,
            indicatorValue: '192.0.2.77',
            port: 3389,
            protocol: 'tcp',
            status: 'OPEN',
          },
        },
      ],
    })
    caseWorkflowService.linkFinding.mockResolvedValue({ data: { data: linked } })

    await user.type(await screen.findByLabelText('Finding id'), '7')
    await user.click(screen.getByTestId('link-finding'))

    await waitFor(() => expect(caseWorkflowService.linkFinding).toHaveBeenCalledWith(4, 7))
    expect(await screen.findByText('192.0.2.77')).toBeInTheDocument()
  })

  it('surfaces the closed ownership-rejection vocabulary as advice, not an error code', async () => {
    const user = userEvent.setup()
    const toast = (await import('react-hot-toast')).default
    renderDetail(ANALYST_CAPABILITIES)

    caseWorkflowService.linkFinding.mockRejectedValue({
      response: { status: 409, data: { code: 'OWNERSHIP_AMBIGUOUS' } },
    })

    await user.type(await screen.findByLabelText('Finding id'), '9')
    await user.click(screen.getByTestId('link-finding'))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('ambiguous')),
    )
  })

  it('offers no state change while the case awaits closure review', async () => {
    renderDetail(
      ANALYST_CAPABILITIES,
      workflowView({
        case: { lifecycleState: 'CLOSURE_PENDING' },
        pendingClosureRequest: {
          id: 51,
          caseId: 4,
          state: 'PENDING',
          closureReason: 'FALSE_POSITIVE',
          justification: 'Scanner artefact',
          requestedAt: '2026-08-03T12:00:00.000Z',
          isPending: true,
        },
        closureRequests: [
          {
            id: 51,
            caseId: 4,
            state: 'PENDING',
            closureReason: 'FALSE_POSITIVE',
            justification: 'Scanner artefact',
            requestedAt: '2026-08-03T12:00:00.000Z',
            isPending: true,
          },
        ],
        permittedActions: {
          canLinkFindings: false,
          canUnlinkFindings: false,
          canRequestClosure: false,
          canReviewClosure: true,
          availableStates: [],
        },
      }),
    )

    expect(await screen.findByTestId('pending-closure-request')).toBeInTheDocument()
    expect(screen.queryByTestId('set-state-OPEN')).not.toBeInTheDocument()
    expect(screen.queryByTestId('link-finding')).not.toBeInTheDocument()
    // The analyst is told a reviewer must act, and given no control to do it.
    expect(screen.getByText(/A reviewer must decide this request/i)).toBeInTheDocument()
    expect(screen.queryByTestId('approve-closure')).not.toBeInTheDocument()
  })

  it('blocks a REMEDIATED closure request until a REMEDIATED response exists', async () => {
    const user = userEvent.setup()
    renderDetail(ANALYST_CAPABILITIES)

    await user.click(await screen.findByLabelText('Closure reason'))
    await user.click(screen.getByRole('option', { name: 'Remediated' }))
    await user.type(screen.getByLabelText('Justification (required)'), 'They confirmed the fix')

    expect(screen.getByTestId('request-closure')).toBeDisabled()
    expect(
      screen.getByText(/Requires a recorded REMEDIATED organization response/i),
    ).toBeInTheDocument()
  })

  it('allows a REMEDIATED closure request once such a response is recorded', async () => {
    const user = userEvent.setup()
    renderDetail(
      ANALYST_CAPABILITIES,
      workflowView({
        organizationResponses: [
          {
            id: 41,
            caseId: 4,
            responseType: 'REMEDIATED',
            summary: 'Port closed',
            occurredAt: '2026-08-03T09:00:00.000Z',
            recordedAt: '2026-08-03T09:00:00.000Z',
          },
        ],
      }),
    )

    await user.click(await screen.findByLabelText('Closure reason'))
    await user.click(screen.getByRole('option', { name: 'Remediated' }))
    await user.type(screen.getByLabelText('Justification (required)'), 'Verified with the org')

    expect(screen.getByTestId('request-closure')).toBeEnabled()
  })

  it('offers a reopen control, requiring a reason, only on a closed case', async () => {
    const user = userEvent.setup()
    renderDetail(
      ANALYST_CAPABILITIES,
      workflowView({
        case: { lifecycleState: 'CLOSED', closureReason: 'FALSE_POSITIVE' },
        permittedActions: {
          canLinkFindings: false,
          canUnlinkFindings: false,
          canRecordResponse: false,
          canRequestClosure: false,
          canReopen: true,
          availableStates: [],
        },
      }),
    )

    const reopen = await screen.findByTestId('reopen-case')
    expect(reopen).toBeDisabled()

    await user.type(screen.getByLabelText('Reopen reason (required)'), 'Observed again')
    expect(reopen).toBeEnabled()
  })
})

describe('case detail — REVIEWER closure review', () => {
  const pendingView = workflowView({
    case: { lifecycleState: 'CLOSURE_PENDING' },
    pendingClosureRequest: {
      id: 51,
      caseId: 4,
      state: 'PENDING',
      closureReason: 'REMEDIATED',
      justification: 'Remediation confirmed with the constituent',
      requestedAt: '2026-08-03T12:00:00.000Z',
      requestedBy: { id: 2, name: 'A. Analyst', role: 'ANALYST' },
      isPending: true,
    },
    closureRequests: [
      {
        id: 51,
        caseId: 4,
        state: 'PENDING',
        closureReason: 'REMEDIATED',
        justification: 'Remediation confirmed with the constituent',
        requestedAt: '2026-08-03T12:00:00.000Z',
        isPending: true,
      },
    ],
    permittedActions: {
      canLinkFindings: false,
      canUnlinkFindings: false,
      canRecordResponse: true,
      canRequestClosure: false,
      canReviewClosure: true,
      availableStates: [],
    },
  })

  it('offers approve and reject, and no ordinary case management', async () => {
    renderDetail(REVIEWER_CAPABILITIES, pendingView)

    expect(await screen.findByTestId('approve-closure')).toBeInTheDocument()
    expect(screen.getByTestId('reject-closure')).toBeInTheDocument()
    expect(screen.getByText('Remediation confirmed with the constituent')).toBeInTheDocument()
    ;['link-finding', 'record-response', 'request-closure', 'state-controls'].forEach((testId) =>
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument(),
    )
  })

  it('requires a review note to reject but not to approve', async () => {
    const user = userEvent.setup()
    renderDetail(REVIEWER_CAPABILITIES, pendingView)

    expect(await screen.findByTestId('reject-closure')).toBeDisabled()
    expect(screen.getByTestId('approve-closure')).toBeEnabled()

    await user.type(screen.getByLabelText(/Review note/i), 'Attach the evidence first')
    expect(screen.getByTestId('reject-closure')).toBeEnabled()
  })

  it('approves and adopts the closed view the server returns', async () => {
    const user = userEvent.setup()
    renderDetail(REVIEWER_CAPABILITIES, pendingView)

    caseWorkflowService.approveClosure.mockResolvedValue({
      data: {
        data: workflowView({
          case: { lifecycleState: 'CLOSED', closureReason: 'REMEDIATED' },
          pendingClosureRequest: null,
          permittedActions: {
            canLinkFindings: false,
            canUnlinkFindings: false,
            canRecordResponse: false,
            canRequestClosure: false,
            canReviewClosure: false,
            canReopen: true,
            availableStates: [],
          },
        }),
      },
    })

    await user.click(await screen.findByTestId('approve-closure'))

    await waitFor(() => expect(caseWorkflowService.approveClosure).toHaveBeenCalledWith(4, 51, ''))
    expect(await screen.findByTestId('case-lifecycle-state')).toHaveTextContent('Closed')
  })

  it('never offers a reviewer the triage action on a linked finding', async () => {
    const user = userEvent.setup()
    renderDetail(REVIEWER_CAPABILITIES)

    await user.click(await screen.findByTestId('toggle-triage-2'))

    expect(await screen.findByTestId('triage-state-2')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /record triage/i })).not.toBeInTheDocument()
  })
})

describe('case detail — ADMIN', () => {
  it('offers both the management and the review controls', async () => {
    renderDetail(
      ADMIN_CAPABILITIES,
      workflowView({
        case: { lifecycleState: 'CLOSURE_PENDING' },
        pendingClosureRequest: {
          id: 51,
          caseId: 4,
          state: 'PENDING',
          closureReason: 'DUPLICATE',
          justification: 'Duplicate of an earlier case',
          requestedAt: '2026-08-03T12:00:00.000Z',
          isPending: true,
        },
        permittedActions: {
          canLinkFindings: false,
          canUnlinkFindings: false,
          canRecordResponse: true,
          canRequestClosure: false,
          canReviewClosure: true,
          availableStates: [],
        },
      }),
    )

    expect(await screen.findByTestId('approve-closure')).toBeInTheDocument()
    expect(screen.getByTestId('record-response')).toBeInTheDocument()
  })

  it('records a triage decision from inside the linked-findings panel', async () => {
    const user = userEvent.setup()
    renderDetail(ADMIN_CAPABILITIES)

    findingTriageService.updateTriage.mockResolvedValue({
      data: {
        data: {
          findingId: 2,
          decision: 'DISMISSED',
          previousDecision: 'ESCALATED',
          current: { id: 10, decision: 'DISMISSED', source: 'ANALYST_DECISION', isCurrent: true },
          history: [],
          linkedCases: [],
          ownership: null,
        },
      },
    })

    await user.click(await screen.findByTestId('toggle-triage-2'))
    await screen.findByTestId('triage-state-2')

    await user.click(screen.getByLabelText('Decision'))
    await user.click(screen.getByRole('option', { name: 'Dismissed' }))

    // A dismissal with no stated reason is not defensible, so the control stays
    // disabled until one is given.
    const record = screen.getByRole('button', { name: /record triage/i })
    expect(record).toBeDisabled()

    await user.type(screen.getByLabelText('Reason (required)'), 'Host decommissioned')
    await user.click(record)

    await waitFor(() =>
      expect(findingTriageService.updateTriage).toHaveBeenCalledWith(
        2,
        'DISMISSED',
        'Host decommissioned',
      ),
    )
    expect(await screen.findByTestId('triage-state-2')).toHaveTextContent('Dismissed')
  })
})

// True when `first` appears before `second` in document order.
function precedes(first, second) {
  // eslint-disable-next-line no-bitwise
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe('case detail — UX Ticket B: decision-first hierarchy', () => {
  it('puts closure review and linked findings ahead of the secondary/history disclosures', async () => {
    renderDetail(ANALYST_CAPABILITIES)

    const closure = await screen.findByTestId('closure-workflow')
    const linkedFindings = screen.getByTestId('linked-findings')
    const orgResponses = screen.getByTestId('organization-responses')
    const lifecycle = screen.getByTestId('lifecycle-timeline')

    expect(precedes(closure, orgResponses)).toBe(true)
    expect(precedes(linkedFindings, orgResponses)).toBe(true)
    expect(precedes(orgResponses, lifecycle)).toBe(true)
  })

  it('collapses secondary context and history by default, without losing any of it', async () => {
    renderDetail(
      ANALYST_CAPABILITIES,
      workflowView({
        organizationResponses: [
          {
            id: 41,
            caseId: 4,
            responseType: 'REMEDIATED',
            summary: 'Port closed at the perimeter',
            occurredAt: '2026-08-03T09:00:00.000Z',
            recordedAt: '2026-08-03T09:00:00.000Z',
          },
        ],
      }),
    )

    const orgResponses = await screen.findByTestId('organization-responses')
    const lifecycle = screen.getByTestId('lifecycle-timeline')
    // Native <details>, collapsed by default: no `open` attribute yet.
    expect(orgResponses).not.toHaveAttribute('open')
    expect(lifecycle).not.toHaveAttribute('open')
    // Collapsed never means removed — the fact is still in the document.
    expect(orgResponses).toHaveTextContent('Port closed at the perimeter')
    expect(orgResponses).toHaveTextContent('1 recorded')
  })

  it('opens a secondary disclosure on click, reaching the record-response control inside it', async () => {
    const user = userEvent.setup()
    renderDetail(ANALYST_CAPABILITIES)

    const orgResponses = await screen.findByTestId('organization-responses')
    expect(orgResponses).not.toHaveAttribute('open')

    await user.click(screen.getByText(/Organization responses — none recorded/))

    expect(orgResponses).toHaveAttribute('open')
    expect(screen.getByTestId('record-response')).toBeInTheDocument()
  })
})
