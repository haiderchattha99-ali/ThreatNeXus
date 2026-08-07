import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { FindingAiAssistPanel } from './FindingAiAssistPanel'
import { CAPABILITIES } from '../constants/capabilities'
import * as useAuthModule from '../hooks/useAuth'
import { aiFindingAssistService, aiMappingService } from '../services/api'

// Phase 8C.1 — the Finding AI-assistance panel.
//
// What these tests defend is capability-aware RENDERING (UX only — the
// backend re-checks every capability on every request and a denied request
// creates no row) and that AI output is never presented as an authoritative
// finding change: a draft is always labelled as a draft, accept/reject only
// ever appear for a role the backend actually grants them to, and a 403
// never triggers a sign-out.

vi.mock('react-hot-toast', () => {
  const toast = vi.fn()
  toast.success = vi.fn()
  toast.error = vi.fn()
  return { default: toast }
})

vi.mock('../services/api', () => ({
  aiMappingService: {
    getConfig: vi.fn(),
  },
  aiFindingAssistService: {
    listSuggestions: vi.fn(),
    requestSuggestion: vi.fn(),
    acceptSuggestion: vi.fn(),
    rejectSuggestion: vi.fn(),
  },
}))

const ADMIN_CAPABILITIES = Object.values(CAPABILITIES)

const ANALYST_CAPABILITIES = [
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_AI_FINDING_SUGGESTIONS,
  CAPABILITIES.REQUEST_AI_FINDING_SUGGESTIONS,
]

// A reviewer may decide a draft but never request one.
const REVIEWER_CAPABILITIES = [
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_AI_FINDING_SUGGESTIONS,
  CAPABILITIES.REVIEW_AI_SUGGESTIONS,
]

// A viewer holds neither read nor request for this feature.
const VIEWER_CAPABILITIES = [CAPABILITIES.READ_FINDINGS]

function aiConfig(overrides = {}) {
  return {
    data: {
      data: {
        aiEnabled: false,
        assistanceAvailable: false,
        providerName: 'disabled',
        reasonCode: 'AI_DISABLED',
        ...overrides,
      },
    },
  }
}

function suggestionsPayload(suggestions = []) {
  return { data: { data: { findingId: 9, suggestions } } }
}

const DRAFT_SUGGESTION = {
  id: 101,
  findingId: 9,
  suggestionType: 'SUMMARY',
  status: 'DRAFT',
  proposedText: 'Accessible RDP finding, currently HIGH risk.',
  evidenceReferences: ['reportType', 'riskBand'],
  providerName: 'mock',
  providerModel: 'mock-deterministic-v1',
  reasonCode: 'SUGGESTION_GENERATED',
  requestedAt: '2026-08-07T09:00:00.000Z',
  decidedAt: null,
  decisionReason: null,
}

function mockAuth(capabilities) {
  vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
    user: { id: 1, name: 'Test', role: 'ANALYST' },
    capabilities,
  })
}

async function renderPanel(capabilities) {
  mockAuth(capabilities)
  render(<FindingAiAssistPanel findingId={9} />)
  await waitFor(() => expect(screen.getByTestId('ai-assist-panel')).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  aiMappingService.getConfig.mockResolvedValue(aiConfig())
  aiFindingAssistService.listSuggestions.mockResolvedValue(suggestionsPayload())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('capability gating', () => {
  it('VIEWER sees a denied state and never calls the list endpoint', async () => {
    mockAuth(VIEWER_CAPABILITIES)
    render(<FindingAiAssistPanel findingId={9} />)
    await waitFor(() => expect(screen.getByText(/do not have access/i)).toBeInTheDocument())
    expect(aiFindingAssistService.listSuggestions).not.toHaveBeenCalled()
    expect(aiFindingAssistService.requestSuggestion).not.toHaveBeenCalled()
  })

  it('ANALYST can request drafts but sees no accept/reject controls', async () => {
    aiMappingService.getConfig.mockResolvedValue(aiConfig({ aiEnabled: true, assistanceAvailable: true, providerName: 'mock', reasonCode: null }))
    aiFindingAssistService.listSuggestions.mockResolvedValue(suggestionsPayload([DRAFT_SUGGESTION]))
    await renderPanel(ANALYST_CAPABILITIES)

    expect(screen.getByRole('button', { name: /Generate summary draft/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Accept/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Reject/i })).not.toBeInTheDocument()
  })

  it('REVIEWER sees accept/reject but no generate controls', async () => {
    aiMappingService.getConfig.mockResolvedValue(aiConfig({ aiEnabled: true, assistanceAvailable: true, providerName: 'mock', reasonCode: null }))
    aiFindingAssistService.listSuggestions.mockResolvedValue(suggestionsPayload([DRAFT_SUGGESTION]))
    await renderPanel(REVIEWER_CAPABILITIES)

    expect(screen.queryByRole('button', { name: /Generate/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Accept/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Reject/i })).toBeInTheDocument()
  })

  it('ADMIN sees both generate and decide controls', async () => {
    aiMappingService.getConfig.mockResolvedValue(aiConfig({ aiEnabled: true, assistanceAvailable: true, providerName: 'mock', reasonCode: null }))
    aiFindingAssistService.listSuggestions.mockResolvedValue(suggestionsPayload([DRAFT_SUGGESTION]))
    await renderPanel(ADMIN_CAPABILITIES)

    expect(screen.getByRole('button', { name: /Generate summary draft/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Accept/i })).toBeInTheDocument()
  })
})

describe('disabled / unavailable states', () => {
  it('shows AI disabled, never a fabricated "online" status, when AI_ENABLED is false', async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    expect(screen.getByTestId('ai-assist-unavailable')).toHaveTextContent(/disabled/i)
    expect(screen.queryByRole('button', { name: /Generate/i })).not.toBeInTheDocument()
  })

  it('shows "no provider configured", distinct from disabled, when enabled but unavailable', async () => {
    aiMappingService.getConfig.mockResolvedValue(
      aiConfig({ aiEnabled: true, assistanceAvailable: false, reasonCode: 'AI_PROVIDER_NOT_AVAILABLE' }),
    )
    await renderPanel(ANALYST_CAPABILITIES)
    expect(screen.getByTestId('ai-assist-unavailable')).toHaveTextContent(/no provider is configured/i)
  })

  it('never renders "No AI drafts yet" as if it were the disabled explanation — both can appear together, distinctly', async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    expect(screen.getByTestId('ai-assist-unavailable')).toBeInTheDocument()
    expect(screen.getByText(/No AI drafts yet/i)).toBeInTheDocument()
  })
})

describe('generating a draft', () => {
  it('a successful request refreshes the list and shows the new draft', async () => {
    const user = userEvent.setup()
    aiMappingService.getConfig.mockResolvedValue(aiConfig({ aiEnabled: true, assistanceAvailable: true, providerName: 'mock', reasonCode: null }))
    aiFindingAssistService.listSuggestions
      .mockResolvedValueOnce(suggestionsPayload([]))
      .mockResolvedValueOnce(suggestionsPayload([DRAFT_SUGGESTION]))
    aiFindingAssistService.requestSuggestion.mockResolvedValue({
      data: { data: { ...DRAFT_SUGGESTION, reasonCode: 'SUGGESTION_GENERATED' } },
    })

    await renderPanel(ANALYST_CAPABILITIES)
    await user.click(screen.getByRole('button', { name: /Generate summary draft/i }))

    await waitFor(() => expect(aiFindingAssistService.requestSuggestion).toHaveBeenCalledWith(9, 'SUMMARY', ''))
    await waitFor(() => expect(screen.getByText(DRAFT_SUGGESTION.proposedText)).toBeInTheDocument())
  })

  it('a 403 on request shows a denial message and does not crash or hide the panel', async () => {
    const user = userEvent.setup()
    aiMappingService.getConfig.mockResolvedValue(aiConfig({ aiEnabled: true, assistanceAvailable: true, providerName: 'mock', reasonCode: null }))
    const forbidden = { response: { status: 403, data: { message: 'Forbidden.' } } }
    aiFindingAssistService.requestSuggestion.mockRejectedValue(forbidden)

    await renderPanel(ANALYST_CAPABILITIES)
    await user.click(screen.getByRole('button', { name: /Generate summary draft/i }))

    const toast = (await import('react-hot-toast')).default
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // The panel itself is still on screen — a 403 on an action never tears
    // down the whole view or signs the session out.
    expect(screen.getByTestId('ai-assist-panel')).toBeInTheDocument()
  })

  it('never dumps a raw error object or stack into the UI', async () => {
    const user = userEvent.setup()
    aiMappingService.getConfig.mockResolvedValue(aiConfig({ aiEnabled: true, assistanceAvailable: true, providerName: 'mock', reasonCode: null }))
    aiFindingAssistService.requestSuggestion.mockRejectedValue(new Error('ECONNRESET at TCPWrap.onStreamRead'))

    await renderPanel(ANALYST_CAPABILITIES)
    await user.click(screen.getByRole('button', { name: /Generate summary draft/i }))

    const toast = (await import('react-hot-toast')).default
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const message = toast.error.mock.calls.at(-1)[0]
    expect(message).not.toMatch(/ECONNRESET|TCPWrap|at .*:\d+:\d+/)
  })
})

describe('deciding a draft', () => {
  beforeEach(() => {
    aiMappingService.getConfig.mockResolvedValue(aiConfig({ aiEnabled: true, assistanceAvailable: true, providerName: 'mock', reasonCode: null }))
    aiFindingAssistService.listSuggestions.mockResolvedValue(suggestionsPayload([DRAFT_SUGGESTION]))
  })

  it('reject is disabled until a reason is entered', async () => {
    const user = userEvent.setup()
    await renderPanel(REVIEWER_CAPABILITIES)

    const rejectButton = screen.getByRole('button', { name: /^Reject/i })
    expect(rejectButton).toBeDisabled()

    await user.type(screen.getByLabelText(/Reason to reject this draft/i), 'Not specific enough.')
    expect(rejectButton).not.toBeDisabled()
  })

  it('accept calls the API and reports the reviewer was recorded', async () => {
    const user = userEvent.setup()
    aiFindingAssistService.acceptSuggestion.mockResolvedValue({
      data: { data: { outcome: 'ACCEPTED', changed: true, suggestion: { ...DRAFT_SUGGESTION, status: 'ACCEPTED' } } },
    })
    await renderPanel(REVIEWER_CAPABILITIES)

    await user.click(screen.getByRole('button', { name: /^Accept/i }))
    await waitFor(() => expect(aiFindingAssistService.acceptSuggestion).toHaveBeenCalledWith(9, 101))

    const toast = (await import('react-hot-toast')).default
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })
})

describe('status rendering', () => {
  it.each([
    ['ACCEPTED', /Accepted/i],
    ['REJECTED', /Rejected/i],
    ['EXPIRED', /Expired/i],
  ])('%s renders its own distinct label, not a generic "decided" word', async (status, matcher) => {
    aiMappingService.getConfig.mockResolvedValue(aiConfig({ aiEnabled: true, assistanceAvailable: true, providerName: 'mock', reasonCode: null }))
    aiFindingAssistService.listSuggestions.mockResolvedValue(
      suggestionsPayload([{ ...DRAFT_SUGGESTION, id: 202, status, decisionReason: status === 'REJECTED' ? 'Too vague.' : null }]),
    )
    await renderPanel(ADMIN_CAPABILITIES)
    expect(screen.getByTestId('ai-assist-decided')).toHaveTextContent(matcher)
  })

  it('an EXPIRED draft shows the staleness explanation and no accept/reject controls', async () => {
    aiMappingService.getConfig.mockResolvedValue(aiConfig({ aiEnabled: true, assistanceAvailable: true, providerName: 'mock', reasonCode: null }))
    aiFindingAssistService.listSuggestions.mockResolvedValue(
      suggestionsPayload([{ ...DRAFT_SUGGESTION, id: 303, status: 'EXPIRED' }]),
    )
    await renderPanel(ADMIN_CAPABILITIES)
    expect(screen.getByTestId('ai-suggestion-expired-303')).toHaveTextContent(/evidence.*has changed/i)
    expect(screen.queryByRole('button', { name: /^Accept/i })).not.toBeInTheDocument()
  })
})
