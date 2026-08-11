// Report-ingestion screen — contract and truthfulness tests.
//
// ---------------------------------------------------------------------------
// Why this file mocks `axios` and NOT `../services/api`
// ---------------------------------------------------------------------------
// The previous version of this suite mocked `threatService.uploadCSV` and
// asserted it was called. It passed while the page posted to the LEGACY
// /threats/upload route, which writes standalone Threat rows and creates no
// Finding, no RawReport evidence and no ingestion audit event — exactly the
// defect this ticket repairs. A test that mocks the service layer can only
// prove "the page called the function the test named"; it is structurally
// incapable of noticing that the function talks to the wrong backend route.
//
// So the seam moved down one level. `axios` is stubbed, `../services/api` is
// the real module, and the assertions are made against the literal URL that
// reaches the HTTP client. A regression back to the legacy contract fails
// here rather than shipping.
//
// Every response body below is shaped exactly as
// backend/src/controllers/reportIngestionController.js builds it, and every
// status is one that controller's own OUTCOME_RESPONSE table assigns.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Upload } from './Upload'

const http = vi.hoisted(() => ({
  posts: [],
  // Set per test: exactly one of these is used for the next post().
  resolve: null,
  reject: null,
  // Captured from the real interceptor registration in services/api.js.
  responseInterceptor: { onFulfilled: null, onRejected: null },
}))

vi.mock('axios', () => {
  const client = {
    post: vi.fn((url, body, config) => {
      http.posts.push({ url, body, config })
      if (http.reject) return Promise.reject(http.reject)
      return Promise.resolve(http.resolve)
    }),
    get: vi.fn(() => Promise.resolve({ status: 200, data: {} })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: {
        use: vi.fn((onFulfilled, onRejected) => {
          http.responseInterceptor.onFulfilled = onFulfilled
          http.responseInterceptor.onRejected = onRejected
        }),
      },
    },
  }
  return { default: { create: () => client } }
})

vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
  http.posts.length = 0
  http.resolve = null
  http.reject = null
  vi.clearAllMocks()
})

function csvFile(name = 'report.csv') {
  return new File(['timestamp,ip,port,protocol\n2026-01-01T00:00:00Z,192.0.2.1,3389,tcp'], name, {
    type: 'text/csv',
  })
}

// Drives the real screen: select a file, submit, wait for the outcome panel.
async function submit(responseOrFailure, { fails = false } = {}) {
  if (fails) http.reject = responseOrFailure
  else http.resolve = responseOrFailure

  const user = userEvent.setup()
  const view = render(<Upload />)
  await user.upload(view.container.querySelector('input[type="file"]'), csvFile())
  await user.click(screen.getByRole('button', { name: 'Import intelligence' }))
  await screen.findByRole('button', { name: 'Import another file' })
  return view
}

// A body carrying exactly the kinds of value that must never be rendered: a
// filesystem path, an internal exception string, a provider key fragment and
// an uploaded row's contents.
const LEAKY_BODY = {
  success: false,
  message:
    'Error: ENOENT /var/lib/threatnexus/uploads/tmp-9f3ac at parseCsv (/app/src/services/ingestion/accessibleRdpCsvParser.js:88:11) — abuseipdb key=ab12cd34 — row: 203.0.113.99,3389,tcp',
  stack: 'at Object.<anonymous> (/app/src/services/ingestion/reportIngestionService.js:463:22)',
}

function expectNoLeakedInternals(container) {
  const dom = container.textContent
  expect(dom).not.toContain('/var/lib/threatnexus')
  expect(dom).not.toContain('accessibleRdpCsvParser.js')
  expect(dom).not.toContain('reportIngestionService.js')
  expect(dom).not.toContain('ab12cd34')
  expect(dom).not.toContain('203.0.113.99')
  expect(dom).not.toContain('ENOENT')
}

describe('report ingestion — the API contract', () => {
  it('posts to the canonical /reports/upload route and never to the legacy /threats/upload', async () => {
    await submit({
      status: 201,
      data: { success: true, message: 'Report ingestion completed.', report: {}, findingCounts: {} },
    })

    expect(http.posts).toHaveLength(1)
    expect(http.posts[0].url).toBe('/reports/upload')

    const everyUrl = http.posts.map((call) => call.url)
    expect(everyUrl).not.toContain('/threats/upload')
    expect(everyUrl.some((url) => url.includes('threat'))).toBe(false)
  })

  it('sends the file and nothing else — no client-chosen source, report type or schema version', async () => {
    await submit({ status: 201, data: { success: true, report: {}, findingCounts: {} } })

    const { body, config } = http.posts[0]
    expect(body).toBeInstanceOf(FormData)
    expect([...body.keys()]).toEqual(['file'])
    expect(config.headers['Content-Type']).toBe('multipart/form-data')
  })
})

describe('report ingestion — truthful outcomes', () => {
  it('starts with a semantic page heading and no enabled mutation', () => {
    render(<Upload />)

    expect(screen.getByRole('heading', { name: 'Ingest a report', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import intelligence' })).toBeDisabled()
  })

  it('PROCESSED (201) renders the persisted report facts and the real lifecycle counts', async () => {
    await submit({
      status: 201,
      data: {
        success: true,
        message: 'Report ingestion completed.',
        report: {
          id: 'rr_0191c4',
          status: 'PARTIALLY_VALID',
          sourceFileSha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
          totalRows: 12,
          validRows: 10,
          invalidRows: 2,
          processingAttempts: 1,
        },
        findingCounts: { CREATED: 7, PERSISTED: 2, RECURRED: 1 },
      },
    })

    expect(screen.getByRole('heading', { name: 'Report processed' })).toBeInTheDocument()

    // Persisted identity and counters, exactly as the backend reported them.
    expect(screen.getByText('rr_0191c4')).toBeInTheDocument()
    expect(screen.getByText('PARTIALLY_VALID')).toBeInTheDocument()
    expect(screen.getByText('a1b2c3d4e5f6…')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()

    // Lifecycle results, labelled in the backend's own vocabulary.
    expect(screen.getByText('New findings created: 7')).toBeInTheDocument()
    expect(screen.getByText('Existing findings still exposed: 2')).toBeInTheDocument()
    expect(screen.getByText('Findings that recurred after closure: 1')).toBeInTheDocument()

    // Nothing summed, nothing invented, no legacy wording.
    expect(screen.queryByText(/indicators imported/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/threat\(s\) added/i)).not.toBeInTheDocument()
  })

  it('DUPLICATE_COMPLETED (200) is not reported as a new import', async () => {
    await submit({
      status: 200,
      data: {
        success: true,
        message: 'This exact file has already been ingested.',
        report: { id: 'rr_0191c4', status: 'COMPLETED', totalRows: 12, validRows: 12, invalidRows: 0 },
      },
    })

    expect(screen.getByRole('heading', { name: 'Already ingested' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Report processed' })).not.toBeInTheDocument()

    // The report already on file is shown, but no lifecycle count is — the
    // replay recorded nothing, and the controller sends findingCounts only
    // for a genuine PROCESSED.
    expect(screen.getByText('rr_0191c4')).toBeInTheDocument()
    expect(screen.queryByLabelText('Finding lifecycle results')).not.toBeInTheDocument()
  })

  it('DUPLICATE_COMPLETED never renders lifecycle counts even if a body carries them', async () => {
    await submit({
      status: 200,
      data: {
        success: true,
        report: { id: 'rr_0191c4', status: 'COMPLETED' },
        findingCounts: { CREATED: 99 },
      },
    })

    expect(screen.queryByLabelText('Finding lifecycle results')).not.toBeInTheDocument()
    expect(screen.queryByText(/New findings created: 99/)).not.toBeInTheDocument()
  })

  it('DUPLICATE_IN_PROGRESS (409) says so, and records nothing', async () => {
    const { container } = await submit(
      {
        response: {
          status: 409,
          data: { success: false, message: 'This exact file is currently being processed.' },
        },
      },
      { fails: true }
    )

    expect(screen.getByRole('heading', { name: 'Already being processed' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(container.textContent).toContain('Nothing was recorded twice')
    expect(screen.queryByLabelText('Finding lifecycle results')).not.toBeInTheDocument()
  })

  it('REJECTED (400) shows the bounded reason code and leaks no internals', async () => {
    const { container } = await submit(
      { response: { status: 400, data: { ...LEAKY_BODY, reason: 'MISSING_REQUIRED_COLUMN' } } },
      { fails: true }
    )

    expect(screen.getByRole('heading', { name: 'Report rejected' })).toBeInTheDocument()
    expect(screen.getByText('MISSING_REQUIRED_COLUMN')).toBeInTheDocument()
    expect(container.textContent).toContain('No report, no evidence rows and no finding were created')
    expectNoLeakedInternals(container)
  })

  it('drops a reason that is not a bounded code rather than rendering it', async () => {
    const { container } = await submit(
      { response: { status: 400, data: { reason: 'parse failed at /app/src/x.js:12 — see stack' } } },
      { fails: true }
    )

    expect(screen.getByRole('heading', { name: 'Report rejected' })).toBeInTheDocument()
    expect(container.textContent).not.toContain('/app/src/x.js')
    expect(screen.queryByText('Reason code')).not.toBeInTheDocument()
  })

  it('UNPROCESSABLE_NO_VALID_ROWS (422) reports an empty result, not a success', async () => {
    await submit(
      { response: { status: 422, data: { success: false, reason: 'NO_VALID_ROWS' } } },
      { fails: true }
    )

    expect(screen.getByRole('heading', { name: 'No valid rows to record' })).toBeInTheDocument()
    expect(screen.getByText('NO_VALID_ROWS')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Report processed' })).not.toBeInTheDocument()
  })

  it('FAILED (500) reports the failure without echoing the server error', async () => {
    const { container } = await submit({ response: { status: 500, data: LEAKY_BODY } }, { fails: true })

    expect(screen.getByRole('heading', { name: 'Processing failed' })).toBeInTheDocument()
    expectNoLeakedInternals(container)
  })

  it('a transport failure with no response is UNAVAILABLE, never an optimistic success', async () => {
    await submit({ message: 'Network Error' }, { fails: true })

    expect(screen.getByRole('heading', { name: 'Backend unavailable' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Report processed' })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})

describe('report ingestion — a capability refusal is not a session expiry', () => {
  it('403 renders an access-refused state in place', async () => {
    const { container } = await submit(
      { response: { status: 403, data: { success: false, message: 'Forbidden' } } },
      { fails: true }
    )

    expect(screen.getByRole('heading', { name: 'Access refused' })).toBeInTheDocument()
    expect(container.textContent).toContain('you are still signed in and nothing was recorded')
    expect(screen.queryByRole('heading', { name: 'Report processed' })).not.toBeInTheDocument()
  })

  // Asserted against the REAL interceptor registered by services/api.js, not
  // against a re-implementation of it: 403 must not clear the session, 401
  // must. Captured at module-registration time by the axios stub above.
  it('the shared interceptor dispatches session-expiry for 401 and not for 403', async () => {
    await import('../services/api')
    const { onRejected } = http.responseInterceptor
    expect(typeof onRejected).toBe('function')

    const seen = []
    const listener = () => seen.push('expired')
    window.addEventListener('tnx:session-expired', listener)

    await onRejected({ response: { status: 403 }, config: { url: '/reports/upload' } }).catch(() => {})
    expect(seen).toEqual([])

    await onRejected({ response: { status: 401 }, config: { url: '/reports/upload' } }).catch(() => {})
    expect(seen).toEqual(['expired'])

    window.removeEventListener('tnx:session-expired', listener)
  })
})
