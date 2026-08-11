// Findings navigation and the CANONICAL report-ingestion path, against the
// real stack.
//
// ---------------------------------------------------------------------------
// What this file used to prove, and why that was not enough
// ---------------------------------------------------------------------------
// The previous ingestion test uploaded a demo CSV and asserted that a heading
// reading "Report processed" appeared. That assertion passed while the page
// was posting to the LEGACY /threats/upload route, which writes standalone
// Threat rows and creates no Finding, no RawReport evidence and no ingestion
// audit event. A green run proved only that the screen rendered a success
// word — not that anything an analyst can work with had been created.
//
// This version follows the evidence instead: upload -> the outcome the
// backend actually returned -> the Finding that upload created, found by its
// own indicator -> that Finding's persisted occurrence evidence -> the
// operational overview's own count of it. Then it uploads the identical bytes
// again and proves the idempotency contract holds: a duplicate-completed
// outcome, no second Finding, and an occurrence count that does not move.
//
// ---------------------------------------------------------------------------
// The fixture, and why it is generated rather than committed
// ---------------------------------------------------------------------------
// The identity this suite asserts on must not collide with the demo seed
// (which ingests data/demo/accessible-rdp/*.csv on port 3389, using
// 192.0.2.40-41, 198.18.7.10-11, 198.51.100.21-23 and 203.0.113.11-14), and
// must not collide with a PREVIOUS RUN of this suite against the same
// database — otherwise the first upload would be a persistence, not a
// creation, and "created exactly one new Finding" would be untrue.
//
// So each test mints its own indicators inside 198.18.100-199.x (RFC 2544
// benchmark range, never routable, well clear of the seed's 198.18.7.x) from
// the run clock. The two indicators in one file are spaced so that neither is
// a string PREFIX of the other — the Findings filter matches on prefix, and
// the whole point of the count assertions is that they are exact.
//
// The bytes are handed to the file input as an in-memory buffer so the
// duplicate-upload test submits provably identical content, which is what the
// backend's sha256 file-identity check keys on.

import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { signIn, collectConsoleProblems } from './support.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEMO_CSV = path.join(__dirname, '..', '..', 'data', 'demo', 'accessible-rdp', 'demo_01_baseline.csv')

// One report, three rows, deliberately mixed: two valid rows carrying two
// distinct Finding identities, and one row that fails per-row validation
// (port above 65535). That makes the accepted/rejected counters non-trivial
// and lands the report PARTIALLY_VALID rather than COMPLETED — real backend
// behaviour an all-valid fixture would never exercise.
function mintProbe() {
  const seed = Date.now() % 25000
  const block = 100 + (seed % 100) // 100-199, clear of the seed's 198.18.7.x
  const host = 20 + (Math.floor(seed / 100) % 80) // 20-99
  const primary = `198.18.${block}.${host}`
  const secondary = `198.18.${block}.${host + 120}` // 140-219: no prefix collision
  const invalid = `198.18.${block}.250`

  const csv = [
    'timestamp,ip,port,protocol,hostname,asn,as_name,country_code',
    `2026-02-14T09:00:00Z,${primary},3389,tcp,,,,`,
    `2026-02-14T09:05:00Z,${secondary},3389,tcp,,,,`,
    `2026-02-14T09:10:00Z,${invalid},99999,tcp,,,,`,
    '',
  ].join('\n')

  return {
    primary,
    secondary,
    // Same filename every time it is uploaded — file identity is the sha256
    // of the BYTES, never the filename, and reusing the name keeps that
    // distinction visible rather than accidentally proven.
    file: { name: 'e2e-ingestion-probe.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') },
  }
}

async function ingest(page, file) {
  await page.getByRole('button', { name: 'Report ingestion' }).click()
  await page.waitForURL('**/upload')
  await page.locator('#csv-upload').setInputFiles(file)
  await page.getByRole('button', { name: 'Import intelligence' }).click()
  // The outcome panel replaces the form on every outcome, success or not.
  await expect(page.getByRole('button', { name: 'Import another file' })).toBeVisible({ timeout: 30_000 })
}

// Reads a dashboard KPI tile's value from `data-count-to` rather than from the
// rendered text.
//
// This is not a convenience — it is the only correct read. components/ui/
// Metric.jsx animates a metric with a GSAP count-up, and `data-count-to`
// carries the exact backend figure while the visible digits are still climbing
// toward it. Reading innerText mid-animation returned 10 for a value of 13 the
// first time this test ran. The attribute is written straight from
// metric.value and is present ONLY when the figure is a real counted number —
// so its absence (RESTRICTED / UNAVAILABLE, where the value renders as an em
// dash) correctly yields null, and the caller skips the comparison instead of
// asserting against a coerced zero.
async function kpiValue(page, label) {
  const tile = page.locator('[data-kpi]').filter({ hasText: label }).first()
  await expect(tile).toBeVisible()
  const value = tile.locator('[data-count-to]')
  if ((await value.count()) === 0) return null
  const countTo = await value.first().getAttribute('data-count-to')
  return countTo === null || countTo === '' ? null : Number(countTo)
}

async function openFindingByIndicator(page, indicator) {
  await page.goto(`/findings?indicator=${indicator}`)
  const table = page.getByRole('table', { name: 'Findings' })
  await expect(table).toBeVisible()
  const rows = table.locator('tbody tr')
  await expect(rows).toHaveCount(1)
  await rows.first().getByRole('link').click()
  await page.waitForURL(/\/findings\/[^/]+$/)
  await expect(page.getByRole('heading', { name: indicator })).toBeVisible()
}

// The value rendered beside a <dt> label in a FieldGrid (components/ui/Panel).
async function fieldValue(page, label) {
  const dd = page.locator('dt', { hasText: label }).first().locator('xpath=following-sibling::dd[1]')
  return (await dd.innerText()).trim()
}

test('ANALYST can browse Findings from the nav and open a finding', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  await signIn(page, 'ANALYST')

  await page.getByRole('button', { name: 'Findings' }).click()
  await page.waitForURL('**/findings')

  const table = page.getByRole('table', { name: 'Findings' })
  await expect(table).toBeVisible()

  const firstRowLink = table.locator('tbody tr').first().getByRole('link')
  const indicator = (await firstRowLink.textContent()).trim()
  await firstRowLink.click()

  await page.waitForURL(/\/findings\/[^/]+$/)
  await expect(page.getByRole('heading', { name: indicator })).toBeVisible()

  expect(problems(), problems().join('\n')).toEqual([])
})

test('an uploaded report creates real Findings, real evidence, and moves the dashboard', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  const probe = mintProbe()

  // Every upload-shaped request the browser makes, so the canonical route is
  // asserted from the wire rather than from the page's own claims.
  const uploadRequests = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/(reports|threats)\//.test(request.url())) {
      uploadRequests.push(request.url())
    }
  })

  await signIn(page, 'ANALYST')
  const openFindingsBefore = await kpiValue(page, 'Open findings')

  await ingest(page, probe.file)

  // 1. The canonical contract, proven on the wire.
  expect(uploadRequests).toHaveLength(1)
  expect(uploadRequests[0]).toContain('/api/reports/upload')
  expect(uploadRequests[0]).not.toContain('/threats/')

  // 2. The outcome the backend actually returned — a 201 PROCESSED, never any
  //    2xx read as success.
  await expect(page.getByRole('heading', { name: 'Report processed' })).toBeVisible()

  // 3. The persisted report facts. Three rows read, two accepted, one
  //    rejected: the per-row validator ran, and the counters are the
  //    backend's rather than the page's.
  await expect(page.locator('dt', { hasText: 'Rows read' })).toBeVisible()
  expect(await fieldValue(page, 'Rows read')).toBe('3')
  expect(await fieldValue(page, 'Rows accepted')).toBe('2')
  expect(await fieldValue(page, 'Rows rejected')).toBe('1')
  expect(await fieldValue(page, 'Report status')).toBe('PARTIALLY_VALID')
  expect(await fieldValue(page, 'Report reference')).not.toBe('')
  expect(await fieldValue(page, 'File identity (sha256)')).toMatch(/^[0-9a-f]{12}…$/)

  // 4. The Finding lifecycle result: two brand-new identities, nothing else.
  const lifecycle = page.locator('[aria-label="Finding lifecycle results"]')
  await expect(lifecycle).toContainText('New findings created: 2')
  await expect(lifecycle).not.toContainText('Existing findings still exposed')

  // 5. The Finding itself — reachable in the Findings workspace by the exact
  //    indicator this upload introduced, carrying its own occurrence
  //    evidence. This is the assertion the old test could not make and the
  //    legacy route would fail.
  await openFindingByIndicator(page, probe.primary)
  expect(await fieldValue(page, 'Indicator')).toBe(probe.primary)
  expect(await fieldValue(page, 'Port')).toBe('3389')
  expect(await fieldValue(page, 'Protocol')).toBe('TCP')
  expect(await fieldValue(page, 'Times observed')).toBe('1')
  expect(await fieldValue(page, 'Recurrences after closure')).toBe('0')

  // 6. The operational overview's own count of it, after an explicit refresh.
  //    Skipped honestly if the tile is not showing a number, rather than
  //    asserted against a coerced zero.
  await page.goto('/dashboard')
  await page.getByRole('button', { name: /Refresh|Updating/ }).click()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
  const openFindingsAfter = await kpiValue(page, 'Open findings')
  if (openFindingsBefore !== null && openFindingsAfter !== null) {
    expect(openFindingsAfter).toBe(openFindingsBefore + 2)
  }

  expect(problems(), problems().join('\n')).toEqual([])
})

test('re-uploading the identical file is idempotent — no second Finding, no extra occurrence', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  const probe = mintProbe()

  await signIn(page, 'ANALYST')

  // First pass: the file becomes evidence.
  await ingest(page, probe.file)
  await expect(page.getByRole('heading', { name: 'Report processed' })).toBeVisible()
  const firstReportReference = await fieldValue(page, 'Report reference')

  await openFindingByIndicator(page, probe.primary)
  expect(await fieldValue(page, 'Times observed')).toBe('1')

  // Second pass: the exact same bytes.
  await page.goto('/dashboard')
  await ingest(page, probe.file)

  // The duplicate-completed contract: recognised by file identity, reported
  // as a replay, and explicitly NOT rendered as a new import.
  await expect(page.getByRole('heading', { name: 'Already ingested' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Report processed' })).toHaveCount(0)
  // No lifecycle counts at all — nothing was recorded a second time.
  await expect(page.locator('[aria-label="Finding lifecycle results"]')).toHaveCount(0)
  // The SAME RawReport, not a second one for the same bytes.
  expect(await fieldValue(page, 'Report reference')).toBe(firstReportReference)

  // And the Finding is untouched: still exactly one row for this identity,
  // still one observation, still no recurrence.
  await openFindingByIndicator(page, probe.primary)
  expect(await fieldValue(page, 'Times observed')).toBe('1')
  expect(await fieldValue(page, 'Recurrences after closure')).toBe('0')

  expect(problems(), problems().join('\n')).toEqual([])
})

test('the demo fixture replays as a duplicate rather than double-counting', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  await signIn(page, 'ANALYST')

  // seed:demo already ingested this exact file, so the canonical pipeline must
  // recognise its bytes and record nothing again. Under the legacy route the
  // same upload silently created another batch of Threat rows every time.
  await ingest(page, DEMO_CSV)
  await expect(page.getByRole('heading', { name: 'Already ingested' })).toBeVisible()
  await expect(page.locator('[aria-label="Finding lifecycle results"]')).toHaveCount(0)

  expect(problems(), problems().join('\n')).toEqual([])
})

test('VIEWER is denied report ingestion in place, sends no upload, and stays signed in', async ({ page }) => {
  const problems = collectConsoleProblems(page)

  const uploadRequests = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/(reports|threats)\//.test(request.url())) {
      uploadRequests.push(request.url())
    }
  })

  await signIn(page, 'VIEWER')

  // Not in the nav for VIEWER at all (capability-filtered) — the direct
  // navigation is what actually proves the route fails closed rather than
  // merely being unlinked.
  await page.goto('/upload')
  await expect(page.getByRole('alert')).toContainText('Access Denied')

  // The refusal happens before any request leaves the browser.
  expect(uploadRequests).toEqual([])

  // Still signed in: a 403 must never behave like the 401 session-expiry path.
  await page.goto('/dashboard')
  await expect(page.getByRole('button', { name: /Refresh|Updating/ })).toBeVisible()

  expect(problems(), problems().join('\n')).toEqual([])
})
