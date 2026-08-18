// The Findings list, tested for the two things the final polish pass changed
// about it: that severity leads the row, and that the whole row is a target
// WITHOUT the row becoming the control.
//
// The second is the subtle one. Making a table row clickable is easy; making it
// clickable without breaking the three things an evidence table has to keep —
// a real link for the keyboard, text selection for copying an indicator, and
// exactly one link per row for the E2E suite that locates a finding by it — is
// where the defects live. Each of those is asserted here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { Findings } from './Findings'
import { findingService } from '../services/api'

vi.mock('../services/api', () => ({ findingService: { getFindings: vi.fn() } }))

const SCORED = {
  id: 41,
  indicatorValue: '203.0.113.10',
  port: 3389,
  protocol: 'TCP',
  reportType: 'ACCESSIBLE_RDP',
  status: 'OPEN',
  occurrenceCount: 4,
  recurrenceCount: 1,
  lastSeen: '2026-08-04T10:26:00.000Z',
  ownership: {
    status: 'RESOLVED',
    confidence: 'HIGH',
    organization: { id: 3, name: 'Ministry of Water' },
  },
  risk: { riskBand: 'CRITICAL', displayScore: 91 },
}

const UNSCORED = {
  id: 42,
  indicatorValue: '203.0.113.11',
  port: 3389,
  protocol: 'TCP',
  reportType: 'ACCESSIBLE_RDP',
  status: 'CLOSED',
  occurrenceCount: 1,
  recurrenceCount: 0,
  lastSeen: '2026-08-01T09:00:00.000Z',
  ownership: { status: 'UNRESOLVED', confidence: null, organization: null },
  risk: null,
}

function renderFindings(items = [SCORED, UNSCORED]) {
  findingService.getFindings.mockResolvedValue({
    data: { data: { items, total: items.length, page: 1, pageSize: 25 } },
  })
  return render(
    <MemoryRouter initialEntries={['/findings']}>
      <Routes>
        <Route path="/findings" element={<Findings />} />
        <Route path="/findings/:id" element={<div>Finding detail route</div>} />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('Findings list — severity-first hierarchy', () => {
  it('leads every row with the Risk v1 band rather than burying it mid-row', async () => {
    renderFindings()
    const table = await screen.findByRole('table', { name: 'Findings' })

    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers[0]).toBe('Risk v1')
    expect(headers).toEqual(['Risk v1', 'Indicator', 'Owning organization', 'Lifecycle', 'Status', 'Last observed'])

    const firstRow = within(table).getAllByRole('row')[1]
    const cells = within(firstRow).getAllByRole('cell')
    expect(cells[0]).toHaveTextContent('CRITICAL')
    expect(cells[0]).toHaveTextContent('91')
  })

  it('renders an unscored finding as "Not yet scored", never as a zero or a band', async () => {
    renderFindings([UNSCORED])
    const table = await screen.findByRole('table', { name: 'Findings' })
    const cells = within(within(table).getAllByRole('row')[1]).getAllByRole('cell')

    expect(cells[0]).toHaveTextContent('Not yet scored')
    expect(cells[0].textContent).not.toMatch(/\b0\b/)
  })
})

describe('Findings list — full-row interaction', () => {
  it('navigates when the analyst clicks anywhere in the row, not only on the indicator', async () => {
    const user = userEvent.setup()
    renderFindings()
    const table = await screen.findByRole('table', { name: 'Findings' })

    // The "Last observed" cell holds no control at all — under the old table
    // clicking it did nothing whatsoever.
    const lastCell = within(within(table).getAllByRole('row')[1]).getAllByRole('cell')[5]
    await user.click(lastCell)

    expect(await screen.findByText('Finding detail route')).toBeInTheDocument()
  })

  it('keeps exactly one real link per row, so the row stays keyboard-reachable and copyable', async () => {
    renderFindings()
    const table = await screen.findByRole('table', { name: 'Findings' })

    for (const row of within(table).getAllByRole('row').slice(1)) {
      const links = within(row).getAllByRole('link')
      expect(links).toHaveLength(1)
      expect(links[0]).toHaveAttribute('href', expect.stringMatching(/^\/findings\/\d+$/))
    }
  })

  it('stands aside while text is being selected, so an indicator can still be copied out', async () => {
    const user = userEvent.setup()
    renderFindings()
    const table = await screen.findByRole('table', { name: 'Findings' })
    const row = within(table).getAllByRole('row')[1]

    // Simulate a selection being live at the moment of mouseup, which is what
    // dragging across an IPv4 literal leaves behind.
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '203.0.113.10',
    })

    await user.click(within(row).getAllByRole('cell')[5])

    expect(screen.queryByText('Finding detail route')).not.toBeInTheDocument()
    selection.mockRestore()
  })
})
