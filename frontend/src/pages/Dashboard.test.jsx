import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

import { Dashboard } from './Dashboard'
import { dashboardService } from '../services/api'

vi.mock('@gsap/react', () => ({ useGSAP: () => undefined }))
vi.mock('gsap', () => ({ default: { registerPlugin: vi.fn() } }))
vi.mock('gsap/ScrollTrigger', () => ({ ScrollTrigger: {} }))
vi.mock('../hooks/useReducedMotion', () => ({ useReducedMotion: () => true }))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role: 'ANALYST' } }) }))
vi.mock('../services/api', () => ({ dashboardService: { getOverview: vi.fn() } }))

const AS_OF = '2026-08-04T10:26:00.000Z'
const metric = (value, source = 'Finding') => ({ value, availability: 'AVAILABLE', source, asOf: AS_OF })
const distribution = (items, source, denominator) => ({ items, source, denominator, asOf: AS_OF })

function availableQueue(total, source, items = [], totalLabel = 'records') {
  return { availability: 'AVAILABLE', total, totalLabel, source, asOf: AS_OF, items }
}

function overviewFor(role) {
  const finding = {
    id: 5,
    indicatorValue: '192.0.2.40',
    port: 3389,
    reportType: 'ACCESSIBLE_RDP',
    occurrenceCount: 3,
    recurrenceCount: 0,
    risk: { state: 'SCORED', band: 'HIGH', displayScore: 77 },
  }
  const closure = {
    id: 9,
    caseId: 2,
    requestedAt: AS_OF,
    case: { id: 2, caseReference: 'TNX-2026-000002', title: 'Exposed service' },
  }
  const notificationRestricted = { availability: 'RESTRICTED', reason: 'Reading notifications requires read:notifications.' }

  return {
    generatedAt: AS_OF,
    audience: { role },
    datasetScope: 'Loaded dataset only. These figures describe persisted reports.',
    sections: {
      findings: {
        availability: 'AVAILABLE',
        metrics: {
          open: metric(13, 'Finding.status = OPEN'),
          persistent: metric(7, 'Finding.occurrenceCount > 1'),
          reportsProcessed: metric(8, 'RawReport'),
          unscored: metric(7, 'Finding minus current RiskScore'),
        },
        distributions: {
          riskBand: distribution([
            { key: 'INFORMATIONAL', count: 0 },
            { key: 'LOW', count: 2 },
            { key: 'MEDIUM', count: 3 },
            { key: 'HIGH', count: 1 },
            { key: 'CRITICAL', count: 0 },
          ], 'RiskScore.riskBand where currentForFindingId IS NOT NULL', 6),
          ageing: distribution([
            { key: 'LAST_24H', count: 1 },
            { key: '1_7_DAYS', count: 5 },
            { key: '8_30_DAYS', count: 4 },
            { key: 'OVER_30_DAYS', count: 3 },
          ], "Finding.lastSeen relative to this snapshot's asOf", 13),
        },
      },
      cases: {
        availability: 'AVAILABLE',
        metrics: {
          open: metric(2, 'Case.lifecycleState = OPEN'),
          waitingForOrganization: metric(1, 'Case.lifecycleState = WAITING_FOR_ORG'),
          closurePending: metric(1, 'Case.lifecycleState = CLOSURE_PENDING'),
          closed: metric(4, 'Case.lifecycleState = CLOSED'),
        },
      },
      findingQueues: {
        availability: 'AVAILABLE',
        priority: availableQueue(13, 'RiskScore ordered by score', [finding], 'open findings'),
        awaitingTriage: availableQueue(5, 'Finding with no current triage decision', [finding], 'findings awaiting triage'),
      },
      caseQueues: {
        availability: 'AVAILABLE',
        closureReview: availableQueue(1, 'CaseClosureRequest.state = PENDING', [closure], 'pending closure requests'),
      },
      notificationQueue: role === 'VIEWER' ? notificationRestricted : {
        availability: 'AVAILABLE',
        awaitingReview: availableQueue(2, 'Notification.lifecycleState = PENDING_REVIEW'),
        drafting: availableQueue(1, 'Notification.lifecycleState = DRAFT'),
      },
      ingestionTrend: {
        availability: 'AVAILABLE', source: 'FindingOccurrence and RawReport per UTC day', asOf: AS_OF,
        days: [{ date: '2026-08-04', observations: 3, reportsIngested: 1 }], totals: { observations: 3, reportsIngested: 1 },
      },
      recentActivity: {
        availability: 'AVAILABLE', source: 'CaseLifecycleEvent, newest first', asOf: AS_OF,
        items: [{ id: 1, caseId: 2, caseReference: 'TNX-2026-000002', eventType: 'STATE_CHANGED', fromState: 'OPEN', toState: 'WAITING_FOR_ORG', occurredAt: AS_OF }],
      },
      providers: {
        availability: 'AVAILABLE', asOf: AS_OF,
        summary: { fresh: 1, stale: 0, noSuccessfulLookup: 0, source: 'Counted provider entries', asOf: AS_OF },
        ioc: { id: 'ioc', name: 'IP reputation', state: 'FRESH', lastSuccessAt: AS_OF },
        vulnerability: [],
        disclaimer: 'This view performs no provider request.',
      },
    },
  }
}

function renderDashboard(role) {
  dashboardService.getOverview.mockResolvedValue({ data: { data: overviewFor(role) } })
  return render(<MemoryRouter><Dashboard /></MemoryRouter>)
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('operations dashboard', () => {
  it('puts analyst decisions and truthful risk navigation above supporting analysis', async () => {
    renderDashboard('ANALYST')

    expect(await screen.findByRole('heading', { name: 'Analyst operations', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Findings awaiting triage' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /192\.0\.2\.40:3389/ })).toHaveAttribute('href', '/findings/5')
    expect(screen.getByRole('link', { name: 'High 1' })).toHaveAttribute('href', '/findings?riskBand=HIGH')
    expect(screen.getByRole('link', { name: 'Triage findings' })).toBeInTheDocument()
  })

  it('keeps exact metric provenance available without printing it through every tile', async () => {
    const user = userEvent.setup()
    renderDashboard('ANALYST')
    const definitions = await screen.findByText('Metric definitions and snapshot times')
    await user.click(definitions)

    expect(screen.getByText(/Finding\.status = OPEN/)).toBeInTheDocument()
    expect(screen.getAllByText(/2026-08-04 10:26Z/).length).toBeGreaterThan(0)
  })

  it('composes a reviewer-first decision queue', async () => {
    renderDashboard('REVIEWER')

    expect(await screen.findByRole('heading', { name: 'Review operations', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Oldest closure requests' })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /TNX-2026-000002/ }).some((link) => link.getAttribute('href') === '/cases/2')).toBe(true)
    expect(screen.getByRole('link', { name: 'Review closures' })).toBeInTheDocument()
  })

  it('renders viewer notification authority as restricted, never as a zero', async () => {
    renderDashboard('VIEWER')

    expect(await screen.findByRole('heading', { name: 'Operational picture', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('Not available to your role')).toBeInTheDocument()
    expect(screen.getByText('Restricted for this role')).toBeInTheDocument()
    expect(screen.getByText('Notification drafts')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open notifications' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Browse findings' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Reports recorded 8 All ingestion outcomes' })).toHaveAttribute('href', '/analytics')
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.getByText('13 open findings · 1 scored row shown')).toBeInTheDocument()
  })

  it('states the loaded-dataset boundary and never claims a live feed', async () => {
    renderDashboard('ADMIN')

    expect(await screen.findByText(/Loaded dataset only/)).toBeInTheDocument()
    expect(screen.queryByText(/live threat/i)).not.toBeInTheDocument()
    expect(screen.getAllByText(/This view performs no provider request/).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
  })
})
