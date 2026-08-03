import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { FrameworkMappingPanel } from './FrameworkMappingPanel'
import { CAPABILITIES } from '../constants/capabilities'
import * as useAuthModule from '../hooks/useAuth'
import { aiMappingService, frameworkMappingService } from '../services/api'

// The Phase 5 framework-mapping workspace.
//
// What these tests defend is capability-aware RENDERING and the anti-
// automation-bias rules. Capability rendering is UX only — the backend
// re-checks every capability on every request and refuses a write whether or
// not this screen ever drew the button — so what is asserted is the direction
// that would actually be a defect: offering a control the caller cannot use, or
// hiding one they can.
//
// The anti-automation-bias assertions are not cosmetic. "No accept-all", "no
// pre-selected decision", "evidence beside the decision" and "a rejection
// reason is required" are the controls that stop a reviewer rubber-stamping
// machine output, and they only exist here — the backend cannot enforce how a
// screen is laid out.

vi.mock('react-hot-toast', () => {
  const toast = vi.fn()
  toast.success = vi.fn()
  toast.error = vi.fn()
  return { default: toast }
})

vi.mock('../services/api', () => ({
  frameworkMappingService: {
    listMappings: vi.fn(),
    getHistory: vi.fn(),
    createMapping: vi.fn(),
    removeMapping: vi.fn(),
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
  CAPABILITIES.MANAGE_CASES,
  CAPABILITIES.MANAGE_FRAMEWORK_MAPPINGS,
  CAPABILITIES.READ_AI_MAPPING_SUGGESTIONS,
  CAPABILITIES.REQUEST_AI_MAPPING_SUGGESTIONS,
  CAPABILITIES.DECIDE_AI_MAPPING_SUGGESTIONS,
]

// A reviewer may look at everything and change nothing.
const REVIEWER_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
  CAPABILITIES.REVIEW_CASE_CLOSURE,
  CAPABILITIES.READ_AI_MAPPING_SUGGESTIONS,
]

// A viewer sees active mappings and no machine proposal at all.
const VIEWER_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
]

const DISCLAIMER =
  'Framework mappings record analyst-associated context only. An active mapping does not state ' +
  'that a control is implemented, audited, assessed or compliant.'
const CATALOGUE_NOTE =
  'Framework reference identifiers and titles are analyst-entered and format-checked only. This ' +
  'system pins no local framework catalogue, so no reference is verified to exist.'

const NIST_MAPPING = {
  id: 21,
  caseId: 4,
  framework: 'NIST_CSF',
  frameworkVersion: '2.0',
  referenceId: 'PR.AA-01',
  referenceTitle: 'Identities and credentials are managed',
  referenceValidated: false,
  mappingScope: 'CASE',
  evidenceBasis: 'CONTROL_GAP',
  rationale: 'Administrative remote access is reachable from any network.',
  evidenceFindingId: null,
  state: 'ACTIVE',
  source: 'MANUAL',
  effectiveAt: '2026-08-05T09:00:00.000Z',
  supersededAt: null,
  createdAt: '2026-08-05T09:00:00.000Z',
  isCurrent: true,
}

const PROMOTED_MAPPING = {
  ...NIST_MAPPING,
  id: 22,
  referenceId: 'PR.AA-05',
  referenceTitle: 'Access permissions are defined and managed',
  source: 'AI_SUGGESTION_PROMOTED',
}

const PENDING_SUGGESTION = {
  id: 31,
  runId: 7,
  caseId: 4,
  framework: 'CIS_CONTROLS',
  frameworkVersion: 'v8',
  referenceId: '4.6',
  referenceTitle: 'Securely Manage Enterprise Assets and Software',
  referenceValidated: false,
  mappingScope: 'CASE',
  evidenceBasis: 'REMEDIATION_ALIGNMENT',
  rationale: 'The recommended remediation places remote management behind a VPN.',
  evidenceFindingId: null,
  providerConfidence: 62,
  providerConfidenceMeaning: 'PROVIDER_SELF_REPORTED_NOT_SYSTEM_ASSESSED',
  state: 'PENDING',
  decidedAt: null,
  decidedByUserId: null,
  decisionReason: null,
  promotedMappingId: null,
  createdAt: '2026-08-05T16:00:00.000Z',
  decisions: [],
  staleForApproval: false,
}

function mappingsPayload(groups = [], activeCount = 0) {
  return {
    data: {
      data: {
        caseId: 4,
        caseReference: 'TNX-2026-000004',
        organizationBound: true,
        activeCount,
        countMeaning: 'MAPPING_COUNT_NOT_COVERAGE',
        groups,
        disclaimer: DISCLAIMER,
        catalogueNote: CATALOGUE_NOTE,
      },
    },
  }
}

function aiConfig({ aiEnabled = false, assistanceAvailable = false, reasonCode = 'AI_DISABLED' }) {
  return {
    data: {
      data: {
        aiEnabled,
        assistanceAvailable,
        providerName: assistanceAvailable ? 'mock' : 'disabled',
        promptTemplateVersion: 'framework-mapping-suggestion-v1',
        reasonCode,
        maxSuggestionsPerRun: 5,
        disclaimer: DISCLAIMER,
      },
    },
  }
}

function suggestionsPayload(suggestions = []) {
  return {
    data: {
      data: {
        caseId: 4,
        total: suggestions.length,
        take: 50,
        skip: 0,
        runs: [],
        suggestions,
        disclaimer: DISCLAIMER,
        catalogueNote: CATALOGUE_NOTE,
      },
    },
  }
}

function mockAuth(capabilities) {
  vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
    // Deliberately does NOT carry `capabilities`: GET /api/profile returns them
    // as a sibling of loggedInUser, so a mock that also nests them inside the
    // user object can hide a component reading the wrong one.
    user: { id: 1, name: 'Test', role: 'ANALYST' },
    capabilities,
  })
}

async function renderPanel(capabilities) {
  mockAuth(capabilities)
  render(<FrameworkMappingPanel caseId="4" />)
  await waitFor(() => expect(screen.getByTestId('framework-mapping-panel')).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  frameworkMappingService.listMappings.mockResolvedValue(mappingsPayload())
  frameworkMappingService.getHistory.mockResolvedValue({
    data: { data: { caseId: 4, total: 0, take: 50, skip: 0, history: [] } },
  })
  aiMappingService.getConfig.mockResolvedValue(aiConfig({}))
  aiMappingService.listSuggestions.mockResolvedValue(suggestionsPayload())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('compliance language', () => {
  it("renders the server's own disclaimer rather than re-wording it", async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    const alert = screen.getByTestId('framework-disclaimer')
    expect(alert).toHaveTextContent(/analyst-associated context only/i)
    expect(alert).toHaveTextContent(/pins no local framework catalogue/i)
  })

  it('never claims a control is implemented, audited or compliant', async () => {
    frameworkMappingService.listMappings.mockResolvedValue(
      mappingsPayload(
        [
          {
            framework: 'NIST_CSF',
            count: 1,
            countMeaning: 'MAPPING_COUNT_NOT_COVERAGE',
            mappings: [NIST_MAPPING],
          },
        ],
        1,
      ),
    )
    await renderPanel(VIEWER_CAPABILITIES)

    // The disclaimer is the ONLY place those words may appear, and there they
    // appear as negations — so the assertion strips it before searching.
    const body = screen.getByTestId('framework-mapping-panel').textContent
    const withoutDisclaimer = body.split(DISCLAIMER).join('').split(CATALOGUE_NOTE).join('')
    expect(withoutDisclaimer).not.toMatch(/\bcompliant\b/i)
    expect(withoutDisclaimer).not.toMatch(/\bcertified\b/i)
    expect(withoutDisclaimer).not.toMatch(/\baudited\b/i)
  })

  // A bare number beside a framework name is exactly how "3" becomes "3
  // techniques covered" in a screenshot.
  it('labels counts as mapping counts and shows no percentage or coverage figure', async () => {
    frameworkMappingService.listMappings.mockResolvedValue(
      mappingsPayload(
        [
          {
            framework: 'NIST_CSF',
            count: 1,
            countMeaning: 'MAPPING_COUNT_NOT_COVERAGE',
            mappings: [NIST_MAPPING],
          },
        ],
        1,
      ),
    )
    await renderPanel(VIEWER_CAPABILITIES)

    expect(screen.getByTestId('active-mappings')).toHaveTextContent(/1 mapping recorded/i)
    expect(screen.getByTestId('active-mappings')).toHaveTextContent(
      /not a coverage, completeness or compliance figure/i,
    )
    const body = screen.getByTestId('framework-mapping-panel').textContent
    expect(body).not.toMatch(/\d+\s*%/)
  })

  it('marks every reference as analyst-entered and unverified', async () => {
    frameworkMappingService.listMappings.mockResolvedValue(
      mappingsPayload(
        [
          {
            framework: 'NIST_CSF',
            count: 1,
            countMeaning: 'MAPPING_COUNT_NOT_COVERAGE',
            mappings: [NIST_MAPPING],
          },
        ],
        1,
      ),
    )
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.getByTestId('mapping-21')).toHaveTextContent(/not catalogue-verified/i)
  })
})

describe('capability-aware rendering', () => {
  it('shows the mapping form to a role holding manage:framework-mappings', async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    expect(screen.getByTestId('mapping-form')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save mapping/i })).toBeInTheDocument()
  })

  it('gives ADMIN every control the workspace offers', async () => {
    aiMappingService.getConfig.mockResolvedValue(
      aiConfig({ aiEnabled: true, assistanceAvailable: true, reasonCode: null }),
    )
    aiMappingService.listSuggestions.mockResolvedValue(suggestionsPayload([PENDING_SUGGESTION]))
    await renderPanel(ADMIN_CAPABILITIES)

    expect(screen.getByTestId('mapping-form')).toBeInTheDocument()
    expect(screen.getByTestId('ai-panel')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /request suggestions/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /approve and map/i })).toBeInTheDocument()
  })

  it('hides the mapping form from REVIEWER and VIEWER', async () => {
    await renderPanel(REVIEWER_CAPABILITIES)
    expect(screen.queryByTestId('mapping-form')).not.toBeInTheDocument()

    vi.restoreAllMocks()
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.queryByTestId('mapping-form')).not.toBeInTheDocument()
  })

  it('hides the withdraw control from read-only roles', async () => {
    frameworkMappingService.listMappings.mockResolvedValue(
      mappingsPayload(
        [
          {
            framework: 'NIST_CSF',
            count: 1,
            countMeaning: 'MAPPING_COUNT_NOT_COVERAGE',
            mappings: [NIST_MAPPING],
          },
        ],
        1,
      ),
    )
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.queryByRole('button', { name: /^remove$/i })).not.toBeInTheDocument()
  })

  // VIEWER never even requests the suggestion list — asking anyway would earn a
  // 403 toast on a screen the role is entitled to use.
  it('does not request the suggestion list for VIEWER, and shows no AI panel', async () => {
    await renderPanel(VIEWER_CAPABILITIES)
    expect(aiMappingService.listSuggestions).not.toHaveBeenCalled()
    expect(screen.queryByTestId('ai-panel')).not.toBeInTheDocument()
  })

  it('shows REVIEWER the AI panel read-only, with no request control', async () => {
    aiMappingService.getConfig.mockResolvedValue(
      aiConfig({ aiEnabled: true, assistanceAvailable: true, reasonCode: null }),
    )
    aiMappingService.listSuggestions.mockResolvedValue(suggestionsPayload([PENDING_SUGGESTION]))
    await renderPanel(REVIEWER_CAPABILITIES)

    expect(screen.getByTestId('ai-panel')).toBeInTheDocument()
    expect(screen.getByTestId('suggestion-31')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /request suggestions/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /approve and map/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^reject$/i })).not.toBeInTheDocument()
  })

  it('records the provenance of a promoted mapping without calling it AI-created', async () => {
    frameworkMappingService.listMappings.mockResolvedValue(
      mappingsPayload(
        [
          {
            framework: 'NIST_CSF',
            count: 1,
            countMeaning: 'MAPPING_COUNT_NOT_COVERAGE',
            mappings: [PROMOTED_MAPPING],
          },
        ],
        1,
      ),
    )
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.getByTestId('mapping-22')).toHaveTextContent(/analyst-approved ai suggestion/i)
    expect(screen.getByTestId('mapping-22')).not.toHaveTextContent(/created by ai/i)
  })
})

describe('AI disabled state', () => {
  it('says plainly that assistance is disabled and that everything still works', async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    const panel = screen.getByTestId('ai-disabled')
    expect(panel).toHaveTextContent(/AI assistance is disabled/i)
    expect(panel).toHaveTextContent(/works without it/i)
    expect(panel).toHaveTextContent(/no provider was contacted/i)
  })

  it('offers no request control while assistance is unavailable', async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    expect(screen.queryByRole('button', { name: /request suggestions/i })).not.toBeInTheDocument()
  })

  // The whole point of "AI is optional": the manual path is unaffected.
  it('still offers the full manual mapping form with AI off', async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    expect(screen.getByTestId('mapping-form')).toBeInTheDocument()
    expect(screen.getByLabelText(/^Reference id/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Rationale/)).toBeInTheDocument()
  })

  it('distinguishes "enabled but no provider" from "switched off"', async () => {
    aiMappingService.getConfig.mockResolvedValue(
      aiConfig({
        aiEnabled: true,
        assistanceAvailable: false,
        reasonCode: 'AI_PROVIDER_NOT_AVAILABLE',
      }),
    )
    await renderPanel(ANALYST_CAPABILITIES)
    expect(screen.getByTestId('ai-disabled')).toHaveTextContent(
      /no approved provider is configured/i,
    )
  })
})

describe('MITRE ATT&CK evidence guidance', () => {
  it('warns as soon as ATT&CK is selected, listing what is not adversary behaviour', async () => {
    const user = userEvent.setup()
    await renderPanel(ANALYST_CAPABILITIES)

    expect(screen.queryByTestId('attack-warning')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('Framework'))
    await user.click(await screen.findByRole('option', { name: /MITRE ATT&CK/i }))

    const warning = await screen.findByTestId('attack-warning')
    expect(warning).toHaveTextContent(/observed behaviour/i)
    expect(warning).toHaveTextContent(/exposed service/i)
    expect(warning).toHaveTextContent(/CVE/i)
    expect(warning).toHaveTextContent(/reputation result/i)
    expect(warning).toHaveTextContent(/risk score/i)
  })

  // Mirrors the server rule rather than letting an analyst discover it by
  // having a submission refused.
  it('forces and locks the observed-behaviour basis for ATT&CK', async () => {
    const user = userEvent.setup()
    await renderPanel(ANALYST_CAPABILITIES)

    await user.click(screen.getByLabelText('Framework'))
    await user.click(await screen.findByRole('option', { name: /MITRE ATT&CK/i }))

    await waitFor(() => {
      expect(screen.getByTestId('mapping-form')).toHaveTextContent(
        /MITRE ATT&CK requires observed behaviour/i,
      )
    })
  })
})

describe('manual mapping actions', () => {
  it('submits only content fields, never provenance or internal keys', async () => {
    const user = userEvent.setup()
    frameworkMappingService.createMapping.mockResolvedValue({
      data: { data: { outcome: 'CREATED', changed: true, mapping: NIST_MAPPING } },
    })
    await renderPanel(ANALYST_CAPABILITIES)

    await user.type(screen.getByLabelText(/^Framework version/), '2.0')
    await user.type(screen.getByLabelText(/^Reference id/), 'PR.AA-01')
    await user.type(screen.getByLabelText(/^Reference title/), 'Identities and credentials')
    await user.type(
      screen.getByLabelText(/^Rationale/),
      'Administrative remote access is reachable from any network.',
    )
    await user.click(screen.getByRole('button', { name: /save mapping/i }))

    await waitFor(() => expect(frameworkMappingService.createMapping).toHaveBeenCalled())
    const [, payload] = frameworkMappingService.createMapping.mock.calls[0]
    expect(Object.keys(payload).sort()).toEqual([
      'evidenceBasis',
      'framework',
      'frameworkVersion',
      'mappingScope',
      'rationale',
      'referenceId',
      'referenceTitle',
    ])
    ;['source', 'state', 'actorUserId', 'effectiveAt', 'currentMappingKey', 'id'].forEach((key) => {
      expect(payload).not.toHaveProperty(key)
    })
  })

  it('requires a withdrawal reason before calling the API', async () => {
    const user = userEvent.setup()
    frameworkMappingService.listMappings.mockResolvedValue(
      mappingsPayload(
        [
          {
            framework: 'NIST_CSF',
            count: 1,
            countMeaning: 'MAPPING_COUNT_NOT_COVERAGE',
            mappings: [NIST_MAPPING],
          },
        ],
        1,
      ),
    )
    await renderPanel(ANALYST_CAPABILITIES)

    await user.click(screen.getByRole('button', { name: /^remove$/i }))
    expect(frameworkMappingService.removeMapping).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText(/Reason to withdraw PR.AA-01/i), 'Reassessed.')
    await user.click(screen.getByRole('button', { name: /^remove$/i }))
    await waitFor(() =>
      expect(frameworkMappingService.removeMapping).toHaveBeenCalledWith('4', 21, 'Reassessed.'),
    )
  })
})

describe('anti-automation-bias controls', () => {
  beforeEach(() => {
    aiMappingService.getConfig.mockResolvedValue(
      aiConfig({ aiEnabled: true, assistanceAvailable: true, reasonCode: null }),
    )
    aiMappingService.listSuggestions.mockResolvedValue(
      suggestionsPayload([
        PENDING_SUGGESTION,
        { ...PENDING_SUGGESTION, id: 32, referenceId: '6.3', referenceTitle: 'Require MFA' },
      ]),
    )
  })

  it('offers no accept-all or bulk-decision control', async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    expect(screen.queryByRole('button', { name: /accept all/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /approve all/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('gives every suggestion its own decision controls, none pre-selected', async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    const first = screen.getByTestId('suggestion-31')
    const second = screen.getByTestId('suggestion-32')

    expect(within(first).getByRole('button', { name: /approve and map/i })).toBeEnabled()
    expect(within(second).getByRole('button', { name: /approve and map/i })).toBeEnabled()
    // Reject is disabled until a reason exists — nothing is pre-filled.
    expect(within(first).getByRole('button', { name: /^reject$/i })).toBeDisabled()
    expect(within(first).getByLabelText(/Reason to reject 4.6/i)).toHaveValue('')
  })

  it('shows the evidence beside the decision, not behind a click', async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    const card = screen.getByTestId('suggestion-31')
    expect(card).toHaveTextContent(PENDING_SUGGESTION.rationale)
    expect(card).toHaveTextContent(/remediation alignment/i)
  })

  it("labels provider confidence as the model's own claim", async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    expect(screen.getByTestId('suggestion-31')).toHaveTextContent(
      /model-reported confidence 62\/100 \(the model's own claim, not an assessment by this system\)/i,
    )
  })

  it('requires a rejection reason and passes it through', async () => {
    const user = userEvent.setup()
    aiMappingService.rejectSuggestion.mockResolvedValue({
      data: { data: { outcome: 'REJECTED', changed: false } },
    })
    await renderPanel(ANALYST_CAPABILITIES)

    const card = screen.getByTestId('suggestion-31')
    await user.type(within(card).getByLabelText(/Reason to reject 4.6/i), 'Control already in place.')
    await user.click(within(card).getByRole('button', { name: /^reject$/i }))

    await waitFor(() =>
      expect(aiMappingService.rejectSuggestion).toHaveBeenCalledWith(
        '4',
        31,
        'Control already in place.',
      ),
    )
  })

  it('approves one suggestion at a time and reloads from the server', async () => {
    const user = userEvent.setup()
    aiMappingService.approveSuggestion.mockResolvedValue({
      data: { data: { outcome: 'APPROVED_AND_PROMOTED', changed: true, mapping: PROMOTED_MAPPING } },
    })
    await renderPanel(ANALYST_CAPABILITIES)

    await user.click(
      within(screen.getByTestId('suggestion-31')).getByRole('button', { name: /approve and map/i }),
    )
    await waitFor(() =>
      expect(aiMappingService.approveSuggestion).toHaveBeenCalledWith('4', 31),
    )
    expect(aiMappingService.approveSuggestion).toHaveBeenCalledTimes(1)
    // The screen never renders a locally-guessed state.
    await waitFor(() => expect(frameworkMappingService.listMappings).toHaveBeenCalledTimes(2))
  })

  it('blocks approval of a stale suggestion and says why', async () => {
    aiMappingService.listSuggestions.mockResolvedValue(
      suggestionsPayload([{ ...PENDING_SUGGESTION, staleForApproval: true }]),
    )
    await renderPanel(ANALYST_CAPABILITIES)

    const card = screen.getByTestId('suggestion-31')
    expect(within(card).getByTestId('stale-31')).toHaveTextContent(/evidence on this case has changed/i)
    expect(within(card).getByRole('button', { name: /approve and map/i })).toBeDisabled()
    // Rejection stays available: a stale proposal must still be clearable.
    expect(within(card).getByRole('button', { name: /^reject$/i })).toBeInTheDocument()
  })

  it('keeps decided suggestions visible rather than hiding what was refused', async () => {
    aiMappingService.listSuggestions.mockResolvedValue(
      suggestionsPayload([
        {
          ...PENDING_SUGGESTION,
          id: 33,
          state: 'REJECTED',
          decisionReason: 'Not confirmed by the constituent.',
          decidedAt: '2026-08-05T18:00:00.000Z',
        },
      ]),
    )
    await renderPanel(ANALYST_CAPABILITIES)

    expect(screen.getByTestId('decided-suggestions')).toBeInTheDocument()
    expect(screen.getByTestId('decided-33')).toHaveTextContent(/rejected/i)
    expect(screen.getByTestId('decided-33')).toHaveTextContent(/Not confirmed by the constituent/i)
  })

  it('states that suggestions are proposals, not decisions', async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    expect(screen.getByTestId('ai-panel')).toHaveTextContent(/proposals, not decisions/i)
    expect(screen.getByTestId('ai-panel')).toHaveTextContent(
      /nothing here changes this case until you approve it/i,
    )
  })
})

describe('history', () => {
  it('shows the append-only history on request, including removed rows', async () => {
    const user = userEvent.setup()
    frameworkMappingService.getHistory.mockResolvedValue({
      data: {
        data: {
          caseId: 4,
          total: 2,
          take: 50,
          skip: 0,
          history: [
            { ...NIST_MAPPING, id: 24, state: 'REMOVED', rationale: 'Reassessed.', isCurrent: true },
            { ...NIST_MAPPING, id: 21, isCurrent: false, supersededAt: '2026-08-05T13:00:00.000Z' },
          ],
        },
      },
    })
    await renderPanel(ANALYST_CAPABILITIES)

    await user.click(screen.getByRole('button', { name: /show history/i }))
    const history = await screen.findByTestId('mapping-history')
    expect(history).toHaveTextContent(/append-only/i)
    expect(within(history).getByTestId('history-24')).toHaveTextContent(/removed/i)
    expect(within(history).getByTestId('history-21')).toHaveTextContent(/active/i)
  })

  it('offers reactivation of a currently-removed mapping to a manager only', async () => {
    const user = userEvent.setup()
    frameworkMappingService.getHistory.mockResolvedValue({
      data: {
        data: {
          caseId: 4,
          total: 1,
          take: 50,
          skip: 0,
          history: [
            { ...NIST_MAPPING, id: 24, state: 'REMOVED', rationale: 'Reassessed.', isCurrent: true },
          ],
        },
      },
    })
    await renderPanel(ANALYST_CAPABILITIES)
    await user.click(screen.getByRole('button', { name: /show history/i }))
    expect(await screen.findByRole('button', { name: /reactivate/i })).toBeInTheDocument()

    // Reactivation pre-fills the form and deliberately leaves the rationale
    // blank: re-asserting a control association deserves a fresh explanation.
    await user.click(screen.getByRole('button', { name: /reactivate/i }))
    expect(screen.getByLabelText(/^Reference id/)).toHaveValue('PR.AA-01')
    expect(screen.getByLabelText(/^Rationale/)).toHaveValue('')
  })
})
