import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

import { AttackNavigator } from './AttackNavigator'
import { attackService } from '../services/api'

vi.mock('../services/api', () => ({
  attackService: { getNavigator: vi.fn() },
}))

vi.mock('../hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}))

const SNAPSHOT = {
  availability: 'AVAILABLE',
  asOf: '2026-08-05T12:00:00.000Z',
  catalogue: {
    attackVersion: 'v19.1',
    checksum: 'd59e40e9d114a92af2f170a0af729bcbd578f960c7b12f51b0f104305e816398',
  },
  tactics: [
    {
      id: 'TA0008',
      shortName: 'lateral-movement',
      name: 'Lateral Movement',
      status: 'PRESENT_IN_EVIDENCE',
      techniqueCount: 2,
      mappedTechniqueCount: 1,
      mappingCount: 1,
      needsReviewCount: 0,
    },
    {
      id: 'TA0006',
      shortName: 'credential-access',
      name: 'Credential Access',
      status: 'EMPTY',
      techniqueCount: 1,
      mappedTechniqueCount: 0,
      mappingCount: 0,
      needsReviewCount: 0,
    },
  ],
  techniques: [
    {
      id: 'T1021.001',
      name: 'Remote Desktop Protocol',
      displayName: 'Remote Services: Remote Desktop Protocol',
      isSubTechnique: true,
      parentId: 'T1021',
      tactics: ['lateral-movement'],
      url: 'https://attack.mitre.org/techniques/T1021/001/',
      mappingCount: 1,
      caseCount: 1,
      organizationCount: 1,
      findingCount: 1,
      needsReviewCount: 0,
      verifiedCount: 1,
      legacyCount: 0,
      status: 'MAPPED',
    },
    {
      id: 'T1078',
      name: 'Valid Accounts',
      displayName: 'Valid Accounts',
      isSubTechnique: false,
      parentId: null,
      tactics: ['lateral-movement'],
      mappingCount: 0,
      caseCount: 0,
      organizationCount: 0,
      findingCount: 0,
      needsReviewCount: 0,
      verifiedCount: 0,
      legacyCount: 0,
      status: 'UNMAPPED',
    },
    {
      id: 'T1110',
      name: 'Brute Force',
      displayName: 'Brute Force',
      isSubTechnique: false,
      parentId: null,
      tactics: ['credential-access'],
      mappingCount: 0,
      caseCount: 0,
      organizationCount: 0,
      findingCount: 0,
      needsReviewCount: 0,
      verifiedCount: 0,
      legacyCount: 0,
      status: 'UNMAPPED',
    },
  ],
  mappings: [
    {
      id: 41,
      caseId: 4,
      caseReference: 'TNX-2026-000004',
      evidenceFindingId: 2,
      referenceId: 'T1021.001',
      source: 'MANUAL',
      evidenceQuote: 'An external session authenticated successfully over Remote Desktop Protocol.',
      evidenceQuoteSource: 'RAW_REPORT_ROW',
      evidenceQuoteLocator: 'RAW_REPORT_ROW:88:event_text',
      evidenceConfidence: 'HIGH',
      mappingConfidence: 'MEDIUM',
      reviewReasons: [],
    },
  ],
  orphanedMappings: [],
  noApplicableAssertions: [],
  needsReview: [],
  totals: {
    activeMappings: 1,
    mappedTechniques: 1,
    catalogueTechniques: 3,
    casesWithMappings: 1,
    casesWithNoApplicableDetermination: 0,
    needsReview: 0,
    legacyUnverified: 0,
    orphanedMappings: 0,
    truncated: false,
  },
  countMeaning: 'MAPPING_COUNT_NOT_COVERAGE',
  coveragePercentage: null,
  coveragePercentageMeaning: 'NOT_COMPUTED_NO_HONEST_DENOMINATOR_EXISTS',
}

function renderPage() {
  return render(<MemoryRouter><AttackNavigator /></MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  attackService.getNavigator.mockResolvedValue({ data: { data: SNAPSHOT } })
})

describe('ATT&CK evidence navigator', () => {
  it('renders raw counts and explicitly refuses a fabricated coverage percentage', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'ATT&CK evidence navigator' })).toBeInTheDocument()
    expect(screen.getByText(/No coverage percentage is shown/i)).toBeInTheDocument()
    expect(screen.getByText('Active mappings').parentElement.parentElement).toHaveTextContent('1')
    expect(screen.getByText('Mapped techniques').parentElement.parentElement).toHaveTextContent('1')
    expect(screen.getByText(/1 mapped techniques · 1 mappings/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/\d+\s*%/)
  })

  it('drills from a mapped technique into its exact evidence and separate confidences', async () => {
    renderPage()
    expect(await screen.findByText('TNX-2026-000004')).toBeInTheDocument()
    expect(screen.getByText(/external session authenticated successfully/i)).toBeInTheDocument()
    expect(screen.getByText('Evidence confidence').parentElement).toHaveTextContent('High')
    expect(screen.getByText('Mapping confidence').parentElement).toHaveTextContent('Medium')
    expect(screen.getByText(/never combines them into a score/i)).toBeInTheDocument()
  })

  it('searches the catalogue and preserves the honest empty state for an unmapped technique', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('TNX-2026-000004')
    await user.type(screen.getByLabelText(/Search technique ID or name/i), 'T1110')
    const button = screen.getByRole('button', { name: /T1110/i })
    await user.click(button)
    expect(screen.getByText(/No mappings in the loaded dataset/i)).toBeInTheDocument()
    expect(screen.getByText(/not a gap assessment/i)).toBeInTheDocument()
  })

  it('keeps the last successful timestamped snapshot when refresh fails', async () => {
    renderPage()
    await screen.findByText('TNX-2026-000004')
    attackService.getNavigator.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: /Refresh evidence/i }))
    await waitFor(() => expect(screen.getByText(/last successful timestamped navigator snapshot remains visible/i)).toBeInTheDocument())
    expect(screen.getByText('TNX-2026-000004')).toBeInTheDocument()
  })
})
