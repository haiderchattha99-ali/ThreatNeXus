import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import Settings from './Settings'
import { CAPABILITIES } from '../constants/capabilities'
import * as useAuthModule from '../hooks/useAuth'
import { dashboardService, enrichmentUsageService } from '../services/api'

// Phase 10C-3 — "Enrichment budgets and readiness". What matters here is
// capability-aware RENDERING (UX only — the backend independently refuses
// GET /api/enrichment/usage to anyone without execute:enrichment-batch), and
// that the panel never becomes a mutation surface: no input, no form, no
// budget/credential edit control, ever.

vi.mock('../services/api', () => ({
  dashboardService: { getOverview: vi.fn() },
  enrichmentUsageService: { getUsage: vi.fn() },
}))

const OVERVIEW_PAYLOAD = {
  data: {
    data: {
      sections: {
        providers: {
          asOf: '2026-08-17T00:00:00.000Z',
          disclaimer: 'test',
          ioc: { id: 'ioc-reputation', name: 'IP reputation', status: 'MOCK_PROVIDER', state: 'AVAILABLE' },
          vulnerability: [],
          exposure: [],
          reputation: [],
          ai: { status: 'DISABLED', provider: 'null' },
        },
      },
    },
  },
}

const USAGE_PAYLOAD = {
  data: {
    data: {
      accountingScope: 'PHASE_10_RESERVATIONS',
      coverage: 'PARTIAL',
      reservationsActive: false,
      executionState: 'PAUSED_WORKER_DISABLED',
      automaticIngestionEnabled: false,
      configurationSource: 'ENVIRONMENT',
      configurationMutable: false,
      restartRequiredForChanges: true,
      usageDate: '2026-08-17',
      excludedPaths: ['LEGACY_ADMIN_IOC_BATCH', 'ADMIN_VULNERABILITY_BATCH', 'SYNCHRONOUS_DIRECT_PROVIDER_ROUTES'],
      note: 'Counts Phase-10 quota reservations for today only.',
      providers: [
        {
          provider: 'censys',
          subjectType: 'IPV4',
          executionPath: 'WORKER_DIRECT',
          credentialConfigured: false,
          missingConfiguration: ['CENSYS_PAT'],
          automatic: { dailyBudget: 0, reservedToday: 0, remaining: 0, readiness: 'NOT_CONFIGURED' },
          manual: { dailyBudget: null, reservedToday: 0, remaining: null, readiness: 'NOT_CONFIGURED' },
        },
        {
          provider: 'nvd',
          subjectType: 'CVE',
          executionPath: 'ADMIN_VULNERABILITY_BATCH',
          credentialConfigured: true,
          missingConfiguration: [],
          automatic: { dailyBudget: 0, reservedToday: 0, remaining: 0, readiness: 'DELEGATED_BATCH_REQUIRED' },
          manual: { dailyBudget: null, reservedToday: 0, remaining: null, readiness: 'DELEGATED_BATCH_REQUIRED' },
        },
      ],
    },
  },
}

function mockAuth(capabilities) {
  vi.spyOn(useAuthModule, 'useAuth').mockReturnValue({
    user: { id: 1, name: 'Test', email: 'test@threatnexus.local', role: 'ADMIN' },
    capabilities,
  })
}

async function renderSettings(capabilities) {
  mockAuth(capabilities)
  render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>
  )
  await waitFor(() => expect(dashboardService.getOverview).toHaveBeenCalled())
}

const ADMIN_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
  CAPABILITIES.EXECUTE_ENRICHMENT_BATCH,
]

const ANALYST_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
  CAPABILITIES.TRIGGER_FINDING_ENRICHMENT,
]

beforeEach(() => {
  vi.clearAllMocks()
  dashboardService.getOverview.mockResolvedValue(OVERVIEW_PAYLOAD)
  enrichmentUsageService.getUsage.mockResolvedValue(USAGE_PAYLOAD)
})

describe('Settings — Enrichment budgets and readiness (capability-gated)', () => {
  it('renders the section, and reads usage, only for a session holding execute:enrichment-batch', async () => {
    await renderSettings(ADMIN_CAPABILITIES)
    await waitFor(() => expect(screen.getByText('Enrichment budgets and readiness')).toBeInTheDocument())
    expect(enrichmentUsageService.getUsage).toHaveBeenCalledTimes(1)
  })

  it('is absent, and never calls the endpoint, for a session without the capability', async () => {
    await renderSettings(ANALYST_CAPABILITIES)
    // Give any stray effect a tick to fire before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('Enrichment budgets and readiness')).not.toBeInTheDocument()
    expect(enrichmentUsageService.getUsage).not.toHaveBeenCalled()
  })
})

describe('Settings — Enrichment budgets and readiness (content)', () => {
  it('renders readiness through the closed StatusBadge dictionary, never as raw text', async () => {
    await renderSettings(ADMIN_CAPABILITIES)
    await waitFor(() => expect(screen.getByText('Enrichment budgets and readiness')).toBeInTheDocument())

    // "Not configured" and "Delegated to batch" are the dictionary LABELS —
    // the raw enum values (NOT_CONFIGURED, DELEGATED_BATCH_REQUIRED) never
    // reach the DOM verbatim.
    expect(screen.getAllByText('Not configured').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Delegated to batch').length).toBeGreaterThan(0)
    expect(screen.queryByText('NOT_CONFIGURED')).not.toBeInTheDocument()
    expect(screen.queryByText('DELEGATED_BATCH_REQUIRED')).not.toBeInTheDocument()
  })

  it('names the missing configuration variable, literally, for an unconfigured provider', async () => {
    await renderSettings(ADMIN_CAPABILITIES)
    await waitFor(() => expect(screen.getByText(/Missing: CENSYS_PAT/)).toBeInTheDocument())
  })

  it('falls back to a bounded, still-badged rendering for a readiness value outside the closed dictionary', async () => {
    enrichmentUsageService.getUsage.mockResolvedValue({
      data: {
        data: {
          ...USAGE_PAYLOAD.data.data,
          providers: [
            {
              ...USAGE_PAYLOAD.data.data.providers[0],
              automatic: { ...USAGE_PAYLOAD.data.data.providers[0].automatic, readiness: 'SOME_FUTURE_VALUE' },
            },
            USAGE_PAYLOAD.data.data.providers[1],
          ],
        },
      },
    })
    await renderSettings(ADMIN_CAPABILITIES)
    // Matches this codebase's own established StatusBadge fallback contract
    // (Panel.jsx/StatusBadge.jsx): an unmapped value is shown, not hidden or
    // crashed on — it just isn't given an invented friendly label.
    await waitFor(() => expect(screen.getByText('SOME_FUTURE_VALUE')).toBeInTheDocument())
  })

  it('states plainly that configuration is deployment-owned and requires a restart', async () => {
    await renderSettings(ADMIN_CAPABILITIES)
    await waitFor(() =>
      expect(screen.getByText(/requires editing the deployment environment and restarting/)).toBeInTheDocument()
    )
  })

  it('carries the required scope note distinguishing this path from the legacy IOC_ENRICHMENT_PROVIDER selector', async () => {
    await renderSettings(ADMIN_CAPABILITIES)
    await waitFor(() =>
      expect(screen.getByText(/describes the Phase-10 orchestration path only/)).toBeInTheDocument()
    )
  })

  it('contains no input, textarea, or select — no mutating control of any kind', async () => {
    await renderSettings(ADMIN_CAPABILITIES)
    await waitFor(() => expect(screen.getByText('Enrichment budgets and readiness')).toBeInTheDocument())

    const heading = screen.getByText('Enrichment budgets and readiness')
    const panel = heading.closest('section') || heading.closest('[class]')?.parentElement
    const scope = panel || document.body
    expect(within(scope).queryAllByRole('textbox')).toHaveLength(0)
    expect(within(scope).queryAllByRole('combobox')).toHaveLength(0)
    expect(scope.querySelectorAll('input, textarea, select').length).toBe(0)

    // The only buttons in the whole page belonging to this feature are reads.
    const buttons = screen.getAllByRole('button').map((button) => button.textContent)
    expect(buttons.every((label) => !/save|submit|edit key|set budget|enable provider/i.test(label))).toBe(true)
  })
})
