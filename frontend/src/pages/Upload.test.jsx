import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Upload } from './Upload'
import { threatService } from '../services/api'

vi.mock('../services/api', () => ({ threatService: { uploadCSV: vi.fn() } }))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => vi.clearAllMocks())

function csvFile(name = 'report.csv') {
  return new File(['ip,port\n192.0.2.1,3389'], name, { type: 'text/csv' })
}

describe('report ingestion screen', () => {
  it('starts with a semantic page heading and no enabled mutation', () => {
    render(<Upload />)

    expect(screen.getByRole('heading', { name: 'Ingest a report', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import intelligence' })).toBeDisabled()
  })

  it('renders the backend finding outcomes instead of inventing an imported total', async () => {
    const user = userEvent.setup()
    threatService.uploadCSV.mockResolvedValue({
      data: {
        success: true,
        message: 'Report ingestion completed.',
        findingCounts: { CREATED: 2, PERSISTED: 1 },
      },
    })
    const { container } = render(<Upload />)
    const input = container.querySelector('input[type="file"]')

    await user.upload(input, csvFile())
    await user.click(screen.getByRole('button', { name: 'Import intelligence' }))

    expect(await screen.findByText('created: 2')).toBeInTheDocument()
    expect(screen.getByText('persisted: 1')).toBeInTheDocument()
    expect(screen.queryByText(/indicators imported/i)).not.toBeInTheDocument()
  })

  it('describes a duplicate replay as a processing result, not a new import', async () => {
    const user = userEvent.setup()
    const toast = (await import('react-hot-toast')).default
    threatService.uploadCSV.mockResolvedValue({
      data: {
        success: true,
        message: 'This exact file has already been ingested.',
        report: { status: 'COMPLETED' },
      },
    })
    const { container } = render(<Upload />)

    await user.upload(container.querySelector('input[type="file"]'), csvFile())
    await user.click(screen.getByRole('button', { name: 'Import intelligence' }))

    expect(await screen.findByRole('heading', { name: 'Report processed' })).toBeInTheDocument()
    expect(screen.getByText('This exact file has already been ingested.')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('This exact file has already been ingested.')
  })

  it('shows the backend-safe rejection message and no success result', async () => {
    const user = userEvent.setup()
    threatService.uploadCSV.mockRejectedValue({ response: { data: { message: 'The uploaded report was rejected.' } } })
    const { container } = render(<Upload />)

    await user.upload(container.querySelector('input[type="file"]'), csvFile())
    await user.click(screen.getByRole('button', { name: 'Import intelligence' }))

    expect(await screen.findByText('The uploaded report was rejected.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Report processed' })).not.toBeInTheDocument()
  })
})
