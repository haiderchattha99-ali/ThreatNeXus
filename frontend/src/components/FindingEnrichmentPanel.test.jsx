import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { FindingEnrichmentPanel } from './FindingEnrichmentPanel'
import { CAPABILITIES } from '../constants/capabilities'
import * as useAuthModule from '../hooks/useAuth'
import { findingEnrichmentOrchestrationService } from '../services/api'

// Phase 10B — the Finding enrichment orchestration visibility panel.
//
// What these tests defend: an analyst can never mistake one truthful state for
// another (NOT_REQUESTED / PENDING / COMPLETED / UNAVAILABLE / SKIPPED /
// NO_SUBJECT all render distinctly), a stale COMPLETED answer is never shown
// as current, executionState is never conflated with "executed", the trigger
// action is capability-gated (UX only), and `contacted` is always the
// backend's own stored boolean — never a frontend guess from status.

vi.mock('react-hot-toast', () => {
  const toast = vi.fn()
  toast.success = vi.fn()
  toast.error = vi.fn()
  return { default: toast }
})

vi.mock('../services/api', () => ({
  findingEnrichmentOrchestrationService: {
    getSummary: vi.fn(),
    createRun: vi.fn(),
    getRun: vi.fn(),
  },
}))

const ANALYST_CAPABILITIES = [CAPABILITIES.READ_FINDINGS, CAPABILITIES.TRIGGER_FINDING_ENRICHMENT]
const VIEWER_CAPABILITIES = [CAPABILITIES.READ_FINDINGS]

function mockAuth(capabilities) {
  vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
    user: { id: 1, name: 'Test', role: 'ANALYST' },
    capabilities,
  })
}

function providerRow(overrides = {}) {
  return {
    provider: 'censys',
    purpose: 'EXPOSURE',
    asOf: '2026-08-13T00:00:00.000Z',
    status: 'NOT_REQUESTED',
    skipReason: null,
    source: 'NONE',
    freshUntil: null,
    isStale: false,
    evidenceAvailable: false,
    ...overrides,
  }
}

// One row per known provider, in the backend's own alphabetical order, each
// carrying a DIFFERENT status — this is what asserts the six states never
// collapse into one look.
function fullSummary(overrides = {}) {
  return {
    data: {
      data: {
        findingId: 9,
        asOf: '2026-08-13T00:00:00.000Z',
        executionState: 'PAUSED_WORKER_DISABLED',
        providers: [
          providerRow({ provider: 'abuseipdb', purpose: 'IOC_REPUTATION', status: 'COMPLETED', source: 'IOC_ENRICHMENT', freshUntil: '2026-08-20T00:00:00.000Z', isStale: false, evidenceAvailable: true }),
          providerRow({ provider: 'censys', purpose: 'EXPOSURE', status: 'PENDING', source: 'ORCHESTRATION_JOB' }),
          providerRow({ provider: 'greynoise', purpose: 'IOC_REPUTATION', status: 'UNAVAILABLE', source: 'ORCHESTRATION_JOB' }),
          providerRow({ provider: 'netlas', purpose: 'EXPOSURE', status: 'SKIPPED', skipReason: 'PROVIDER_NOT_CONFIGURED' }),
          providerRow({
            provider: 'nvd',
            purpose: 'VULNERABILITY',
            status: 'NO_SUBJECT',
            skipReason: 'NO_SUBJECT_FOR_PROVIDER',
            subjects: [],
          }),
          providerRow({ provider: 'shodan', purpose: 'EXPOSURE', status: 'NOT_REQUESTED' }),
        ],
        ...overrides,
      },
    },
  }
}

async function renderPanel(capabilities) {
  mockAuth(capabilities)
  render(<FindingEnrichmentPanel findingId={9} />)
  await waitFor(() => expect(screen.getByTestId('enrichment-panel')).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  findingEnrichmentOrchestrationService.getSummary.mockResolvedValue(fullSummary())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('coexistence with the legacy AbuseIPDB-only panel', () => {
  it('explains that the legacy reputation panel is a separate pipeline, not reflected here', async () => {
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.getByText(/separate, older pipeline/i)).toBeInTheDocument()
  })
})

describe('provider status rendering', () => {
  it('shows all six known providers even though most have no evidence', async () => {
    await renderPanel(VIEWER_CAPABILITIES)
    ;['AbuseIPDB', 'Censys', 'GreyNoise', 'Netlas', 'NVD', 'Shodan'].forEach((label) => {
      expect(screen.getByText(label)).toBeInTheDocument()
    })
  })

  it.each([
    ['COMPLETED', /Lookup completed/i],
    ['PENDING', /Pending/i],
    ['UNAVAILABLE', /Unavailable/i],
    ['SKIPPED', /Skipped/i],
    ['NOT_REQUESTED', /Not requested/i],
    ['NO_SUBJECT', /No subject/i],
  ])('%s renders its own distinct label', async (status, matcher) => {
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.getAllByText(matcher).length).toBeGreaterThan(0)
  })

  it('never renders UNAVAILABLE as though it were a clean "nothing found" COMPLETED result', async () => {
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.queryByText(/Unavailable.*Lookup completed/i)).not.toBeInTheDocument()
    expect(screen.getByText('Unavailable')).toBeInTheDocument()
    expect(screen.getByText('Lookup completed')).toBeInTheDocument()
  })

  it('a stale COMPLETED answer shows a stale notice alongside it, not instead of it', async () => {
    findingEnrichmentOrchestrationService.getSummary.mockResolvedValue(
      fullSummary({
        providers: [
          providerRow({
            provider: 'abuseipdb',
            purpose: 'IOC_REPUTATION',
            status: 'COMPLETED',
            source: 'IOC_ENRICHMENT',
            freshUntil: '2026-01-01T00:00:00.000Z',
            isStale: true,
          }),
          providerRow({ provider: 'censys' }),
          providerRow({ provider: 'greynoise' }),
          providerRow({ provider: 'netlas' }),
          providerRow({ provider: 'nvd', purpose: 'VULNERABILITY', status: 'NO_SUBJECT', subjects: [] }),
          providerRow({ provider: 'shodan' }),
        ],
      }),
    )
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.getByText('Lookup completed')).toBeInTheDocument()
    expect(screen.getByText(/no longer fresh/i)).toBeInTheDocument()
  })

  it('a SKIPPED row shows its specific reason, not a bare "skipped"', async () => {
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.getByText(/No credential configured for this provider/i)).toBeInTheDocument()
  })

  it('renders one row per verified CVE subject on NVD, each with its own status', async () => {
    findingEnrichmentOrchestrationService.getSummary.mockResolvedValue(
      fullSummary({
        providers: [
          providerRow({ provider: 'abuseipdb' }),
          providerRow({ provider: 'censys' }),
          providerRow({ provider: 'greynoise' }),
          providerRow({ provider: 'netlas' }),
          providerRow({
            provider: 'nvd',
            purpose: 'VULNERABILITY',
            status: 'COMPLETED',
            subjects: [
              { subjectValue: 'CVE-2024-0001', status: 'COMPLETED', skipReason: null, source: 'VULNERABILITY_ENRICHMENT', freshUntil: null, isStale: false, evidenceAvailable: true },
              { subjectValue: 'CVE-2024-0002', status: 'PENDING', skipReason: null, source: 'ORCHESTRATION_JOB', freshUntil: null, isStale: false, evidenceAvailable: false },
            ],
          }),
          providerRow({ provider: 'shodan' }),
        ],
      }),
    )
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.getByText('CVE-2024-0001')).toBeInTheDocument()
    expect(screen.getByText('CVE-2024-0002')).toBeInTheDocument()
  })
})

describe('executionState — recorded is never presented as executed', () => {
  it('PAUSED_WORKER_DISABLED explains that nothing will be looked up yet', async () => {
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.getByTestId('enrichment-execution-state')).toHaveTextContent(/Execution paused/i)
    expect(screen.getByTestId('enrichment-execution-state')).toHaveTextContent(/nothing will be looked up/i)
  })

  it('ACTIVE renders a distinct message from PAUSED_WORKER_DISABLED', async () => {
    findingEnrichmentOrchestrationService.getSummary.mockResolvedValue(fullSummary({ executionState: 'ACTIVE' }))
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.getByTestId('enrichment-execution-state')).toHaveTextContent(/Execution active/i)
    expect(screen.getByTestId('enrichment-execution-state')).not.toHaveTextContent(/paused/i)
  })
})

describe('capability gating', () => {
  it('a role without trigger:finding-enrichment sees no request control', async () => {
    await renderPanel(VIEWER_CAPABILITIES)
    expect(screen.queryByRole('button', { name: /Request enrichment/i })).not.toBeInTheDocument()
  })

  it('a role with trigger:finding-enrichment sees the request control', async () => {
    await renderPanel(ANALYST_CAPABILITIES)
    expect(screen.getByRole('button', { name: /Request enrichment/i })).toBeInTheDocument()
  })
})

describe('requesting a run', () => {
  it('shows the outcome and the recorded items, with contacted read from the stored field', async () => {
    const user = userEvent.setup()
    findingEnrichmentOrchestrationService.createRun.mockResolvedValue({
      data: {
        success: true,
        outcome: 'CREATED',
        executionState: 'PAUSED_WORKER_DISABLED',
        run: { id: 42, findingId: 9, state: 'PENDING', itemCount: 2 },
        items: [
          { provider: 'censys', subjectType: 'IPV4', subjectValue: '203.0.113.5', decision: 'ELIGIBLE', skipReason: null, lookupState: 'PENDING', contacted: false },
          { provider: 'netlas', subjectType: 'IPV4', subjectValue: '203.0.113.5', decision: 'SKIPPED_NOT_CONFIGURED', skipReason: 'PROVIDER_NOT_CONFIGURED', lookupState: null, contacted: false },
        ],
      },
    })

    await renderPanel(ANALYST_CAPABILITIES)
    await user.click(screen.getByRole('button', { name: /Request enrichment/i }))

    await waitFor(() => expect(findingEnrichmentOrchestrationService.createRun).toHaveBeenCalledWith(9))
    const lastRun = await screen.findByTestId('enrichment-last-run')
    expect(within(lastRun).getByText(/A new enrichment request was recorded/i)).toBeInTheDocument()

    // The ELIGIBLE item's contacted:false is shown as "Not yet" (a real,
    // durable answer) — the policy-skipped item shows "—" (never attempted).
    expect(within(lastRun).getByTestId('enrichment-item-contacted-0')).toHaveTextContent('Not yet')
    expect(within(lastRun).getByTestId('enrichment-item-contacted-1')).toHaveTextContent('—')
  })

  it('a 403 shows a denial message and never tears down the panel', async () => {
    const user = userEvent.setup()
    findingEnrichmentOrchestrationService.createRun.mockRejectedValue({ response: { status: 403 } })

    await renderPanel(ANALYST_CAPABILITIES)
    await user.click(screen.getByRole('button', { name: /Request enrichment/i }))

    const toast = (await import('react-hot-toast')).default
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByTestId('enrichment-panel')).toBeInTheDocument()
  })

  it('checking status re-fetches the same run and reflects a newly contacted item', async () => {
    const user = userEvent.setup()
    findingEnrichmentOrchestrationService.createRun.mockResolvedValue({
      data: {
        success: true,
        outcome: 'CREATED',
        executionState: 'ACTIVE',
        run: { id: 7, findingId: 9, state: 'PENDING', itemCount: 1 },
        items: [
          { provider: 'censys', subjectType: 'IPV4', subjectValue: '203.0.113.5', decision: 'ELIGIBLE', skipReason: null, lookupState: 'LEASED', contacted: false },
        ],
      },
    })
    findingEnrichmentOrchestrationService.getRun.mockResolvedValue({
      data: {
        success: true,
        executionState: 'ACTIVE',
        run: { id: 7, findingId: 9, state: 'SUCCEEDED', itemCount: 1 },
        items: [
          { provider: 'censys', subjectType: 'IPV4', subjectValue: '203.0.113.5', decision: 'ELIGIBLE', skipReason: null, lookupState: 'SUCCEEDED', contacted: true },
        ],
      },
    })

    await renderPanel(ANALYST_CAPABILITIES)
    await user.click(screen.getByRole('button', { name: /Request enrichment/i }))
    const lastRun = await screen.findByTestId('enrichment-last-run')
    expect(within(lastRun).getByTestId('enrichment-item-contacted-0')).toHaveTextContent('Not yet')

    await user.click(within(lastRun).getByRole('button', { name: /Check status/i }))

    await waitFor(() => expect(findingEnrichmentOrchestrationService.getRun).toHaveBeenCalledWith(9, 7))
    await waitFor(() =>
      expect(within(lastRun).getByTestId('enrichment-item-contacted-0')).toHaveTextContent('Yes'),
    )
  })
})
