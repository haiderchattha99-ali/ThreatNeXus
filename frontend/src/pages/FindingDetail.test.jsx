// The Finding detail screen, tested for the two things the final polish pass
// changed about it: WHAT ORDER it puts things in, and whether the truth layer
// reaches an analyst in English.
//
// The child panels are stubbed to markers on purpose. Their internals have
// their own suites; what is under test here is information architecture — which
// region comes before which — and that is only assertable against the real DOM
// order of the page.
//
// The FACTOR_LABEL assertions are regression tests for a defect that SHIPPED:
// the page's factor dictionary was keyed on `EXPOSURE_BASE`, `IOC_REPUTATION`
// and friends, while the engine stores `exposureCriticality` and
// `iocReputationContext`. Not one key ever matched, so the dictionary was dead
// code and every factor rendered as its raw camelCase storage key. A test that
// asserts only "a label appears" would have passed against the broken version,
// so these assert the mapped English AND the absence of the raw key.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { FindingDetail } from './FindingDetail'
import { findingService } from '../services/api'

vi.mock('../services/api', () => ({ findingService: { getFinding: vi.fn() } }))
vi.mock('../components/FindingTriagePanel', () => ({
  FindingTriagePanel: () => <div>TRIAGE PANEL</div>,
}))
vi.mock('../components/FindingAiAssistPanel', () => ({
  FindingAiAssistPanel: () => <div>AI PANEL</div>,
}))
vi.mock('../components/FindingEnrichmentPanel', () => ({
  FindingEnrichmentPanel: () => <div>ENRICHMENT PANEL</div>,
}))

const contribution = (factorKey, explanationCode, points, applicability = 'APPLIED') => ({
  factorKey,
  applicability,
  contributionBasisPoints: points,
  maximumContributionBasisPoints: 1500,
  normalizedInputValue: '3',
  explanationCode,
  displayOrder: 1,
})

function findingFixture(overrides = {}) {
  return {
    id: 7,
    indicatorValue: '203.0.113.10',
    port: 3389,
    protocol: 'TCP',
    reportType: 'ACCESSIBLE_RDP',
    status: 'OPEN',
    firstSeen: '2026-07-01T10:00:00.000Z',
    lastSeen: '2026-08-04T10:26:00.000Z',
    occurrenceCount: 4,
    recurrenceCount: 1,
    closedAt: null,
    closureReason: null,
    occurrenceLimit: 25,
    occurrences: [],
    vulnerabilities: [],
    caseLinks: [],
    triage: { decision: 'IN_REVIEW', reason: null, source: 'ANALYST_DECISION', decidedAt: null, caseId: null },
    ownership: {
      status: 'RESOLVED',
      confidence: 'HIGH',
      reasonCode: 'OWNERSHIP_CIDR_MATCH',
      isIspAttribution: false,
      asOf: '2026-08-04T10:26:00.000Z',
      organization: { id: 3, name: 'Ministry of Water' },
    },
    enrichment: null,
    risk: {
      displayScore: 91,
      riskBand: 'CRITICAL',
      algorithmVersion: 'risk-v1.0.0',
      configurationVersion: 'config-v1.0.0',
      asOf: '2026-08-04T10:26:00.000Z',
      calculatedAt: '2026-08-04T10:26:00.000Z',
      trigger: 'INGESTION',
      contributions: [
        contribution('exposureCriticality', 'EXPOSURE_CRITICALITY_REMOTE_ACCESS_RDP', 1500),
        contribution('iocReputationContext', 'IOC_REPUTATION_TIMEOUT', 0, 'NOT_AVAILABLE'),
        contribution('kevStatus', 'KEV_NOT_APPLICABLE_NO_CVE', 0, 'NOT_APPLICABLE'),
        contribution('recurrence', 'RECURRENCE_NONE', 0, 'APPLIED'),
      ],
    },
    ...overrides,
  }
}

function renderDetail(finding = findingFixture()) {
  findingService.getFinding.mockResolvedValue({ data: { data: finding } })
  return render(
    <MemoryRouter initialEntries={['/findings/7']}>
      <Routes>
        <Route path="/findings/:id" element={<FindingDetail />} />
      </Routes>
    </MemoryRouter>
  )
}

// True when `first` appears before `second` in document order.
function precedes(first, second) {
  // eslint-disable-next-line no-bitwise
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('Finding detail — decision-first information architecture', () => {
  it('puts the triage decision above the evidence that supports it, and the optional subsystems last', async () => {
    renderDetail()
    const triage = await screen.findByText('TRIAGE PANEL')
    const risk = screen.getByRole('heading', { name: 'Risk v1 explanation' })
    const timeline = screen.getByRole('heading', { name: 'Observation timeline' })
    const ai = screen.getByText('AI PANEL')

    expect(precedes(triage, risk)).toBe(true)
    expect(precedes(risk, timeline)).toBe(true)
    expect(precedes(timeline, ai)).toBe(true)
  })

  it('answers "how bad, who owns it, what is the state" in one strip before any panel', async () => {
    renderDetail()
    const summary = await screen.findByRole('region', { name: 'Decision summary' })

    expect(within(summary).getByText('CRITICAL')).toBeInTheDocument()
    expect(within(summary).getByText('Ministry of Water')).toBeInTheDocument()
    expect(within(summary).getByText('In review')).toBeInTheDocument()
    expect(within(summary).getByText(/4 observations · 1 recurrence after closure/)).toBeInTheDocument()
    // The summary strip precedes every panel on the page.
    expect(precedes(summary, screen.getByText('TRIAGE PANEL'))).toBe(true)
  })

  it('says "Not yet scored" rather than implying a zero when no score has been written', async () => {
    renderDetail(findingFixture({ risk: null }))
    const summary = await screen.findByRole('region', { name: 'Decision summary' })

    expect(within(summary).getByText('Not yet scored')).toBeInTheDocument()
    expect(
      screen.getByText(/No deterministic score has been written yet. This is not a score of zero./)
    ).toBeInTheDocument()
  })

  it('offers a section rail to every region it renders', async () => {
    renderDetail()
    const rail = await screen.findByRole('navigation', { name: 'Sections of this finding' })

    expect(within(rail).getByRole('link', { name: 'Triage' })).toHaveAttribute('href', '#tnx-triage')
    expect(within(rail).getByRole('link', { name: 'Risk v1' })).toHaveAttribute('href', '#tnx-risk')
    // Every rail target actually exists on the page — a rail link to nowhere is
    // worse than no rail.
    for (const link of within(rail).getAllByRole('link')) {
      const id = link.getAttribute('href').slice(1)
      expect(document.getElementById(id), `no section with id ${id}`).not.toBeNull()
    }
  })
})

describe('Finding detail — the Risk v1 truth layer, in English', () => {
  it('names each stored factor key instead of printing the raw camelCase key', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Risk v1 explanation' })

    expect(screen.getByText('Exposure criticality')).toBeInTheDocument()
    // The shipped defect: this is what used to render in that cell.
    expect(screen.queryByText('exposureCriticality')).not.toBeInTheDocument()
    expect(screen.queryByText('iocReputationContext')).not.toBeInTheDocument()
  })

  it('uses the CURATED factor name, not merely a de-cased storage key', async () => {
    // This is the assertion that can actually fail when the dictionary breaks.
    //
    // The unknown-key fallback de-cases the identifier, and for most factors
    // that lands on the same words as the curated label — `exposureCriticality`
    // de-cases to "Exposure criticality" either way, so the test above cannot
    // tell a working dictionary from a dead one. Red-checking it against the
    // original broken keys proved exactly that: it passed against the defect.
    //
    // These two factors are the ones where the curated name and the mechanical
    // fallback genuinely diverge, so a dictionary that stops matching fails here.
    const finding = findingFixture()
    finding.risk.contributions = [
      contribution('epssScore', 'EPSS_HIGH', 400),
      contribution('kevStatus', 'KEV_LISTED', 300),
    ]
    renderDetail(finding)
    await screen.findByRole('heading', { name: 'Risk v1 explanation' })

    expect(screen.getByText('EPSS probability')).toBeInTheDocument()
    expect(screen.queryByText('Epss score')).not.toBeInTheDocument()
    expect(screen.getByText('KEV status')).toBeInTheDocument()
    expect(screen.queryByText('Kev status')).not.toBeInTheDocument()
  })

  it('renders the stored explanation code as a sentence AND keeps the code itself', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Risk v1 explanation' })

    expect(screen.getByText('Remote-access service (RDP) exposed.')).toBeInTheDocument()
    // The code stays visible: it is the audit identity an analyst quotes.
    expect(screen.getByText('EXPOSURE_CRITICALITY_REMOTE_ACCESS_RDP')).toBeInTheDocument()
  })

  it('never lets "could not read the evidence" collapse into "measured and clean"', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Risk v1 explanation' })

    // Three factors added nothing, for three different reasons, and the
    // disclosure that folds them away is required to say so by state.
    const summary = screen.getByText(
      /3 factors added no points — 1 measured and weighed nothing, 1 with no readable evidence, 1 that cannot apply here/
    )
    expect(summary).toBeInTheDocument()
    expect(screen.getByText('The lookup timed out, so nothing was read.')).toBeInTheDocument()
  })

  it('shows every factor when none of them contributed, because each zero is the answer', async () => {
    const finding = findingFixture()
    finding.risk.contributions = finding.risk.contributions.map((c) => ({
      ...c,
      contributionBasisPoints: 0,
    }))
    renderDetail(finding)
    await screen.findByRole('heading', { name: 'Risk v1 explanation' })

    const table = screen.getByRole('table', { name: 'Risk factor contributions' })
    expect(within(table).getAllByRole('row')).toHaveLength(5) // header + four factors
    expect(screen.queryByText(/factors added no points/)).not.toBeInTheDocument()
  })
})

describe('Finding detail — ownership reads as words, with its code intact', () => {
  it('explains why this owner was chosen and still prints the resolver reason code', async () => {
    renderDetail()
    await screen.findByRole('heading', { name: 'Ownership' })

    expect(
      screen.getAllByText('Matched the longest registered address range.').length
    ).toBeGreaterThan(0)
    expect(screen.getByText('OWNERSHIP_CIDR_MATCH')).toBeInTheDocument()
  })
})
