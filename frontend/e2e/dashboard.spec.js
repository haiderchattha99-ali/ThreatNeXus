// Dashboard data behaviour: provenance, refresh semantics, and the standing
// promise that rendering this page contacts no threat-intelligence provider.

import { test, expect } from '@playwright/test'
import { signIn, collectConsoleProblems } from './support.js'

test('rendering the dashboard issues exactly one overview call and no provider request', async ({ page }) => {
  const requests = []
  page.on('request', (request) => requests.push(request.url()))

  await signIn(page, 'ADMIN')
  await expect(page.getByRole('heading', { name: 'What is driving current risk' })).toBeVisible()

  const overviewCalls = requests.filter((u) => u.includes('/api/dashboard/overview'))
  expect(overviewCalls.length, 'the dashboard renders from ONE bounded snapshot call').toBe(1)

  // No request may leave for a provider. The dashboard derives provider status
  // from configuration and previously persisted rows; it never looks anything up.
  const providerHosts = [
    'abuseipdb.com',
    'services.nvd.nist.gov',
    'nvd.nist.gov',
    'cisa.gov',
    'first.org',
    'virustotal.com',
    'otx.alienvault.com',
  ]
  const offenders = requests.filter((url) => providerHosts.some((host) => url.includes(host)))
  expect(offenders, 'no provider was contacted while rendering the dashboard').toEqual([])

  // And the response says so itself.
  await expect(page.getByText(/performs no provider request/i).first()).toBeVisible()
})

test('refresh updates the snapshot while the previous one stays on screen', async ({ page }) => {
  await signIn(page, 'ADMIN')

  const stamp = page.getByTestId('dashboard-snapshot')
  await expect(stamp).toBeVisible()
  const before = await stamp.textContent()

  // Hold the refresh in flight so the intermediate state is observable rather
  // than a race.
  let release
  const held = new Promise((resolve) => { release = resolve })
  await page.route('**/api/dashboard/overview', async (route) => {
    await held
    await route.continue()
  })

  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('button', { name: 'Updating' })).toBeVisible()

  // THE ASSERTION: while updating, the last good snapshot is still fully
  // rendered. A dashboard that blanks to a spinner on refresh throws away the
  // figures the analyst was reading.
  await expect(page.getByRole('heading', { name: 'What is driving current risk' })).toBeVisible()
  await expect(page.locator('[data-kpi]')).toHaveCount(4)
  await expect(stamp).toHaveText(before)

  release()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
})

test('a failed refresh keeps the last good snapshot and says so', async ({ page }) => {
  await signIn(page, 'ADMIN')
  await expect(page.locator('[data-kpi]')).toHaveCount(4)

  await page.route('**/api/dashboard/overview', (route) => route.abort('failed'))
  await page.getByRole('button', { name: 'Refresh' }).click()

  await expect(page.getByText(/Refresh failed\. The last successful timestamped snapshot remains visible\./)).toBeVisible()
  // The evidence is still there — the failure did not zero the page.
  await expect(page.locator('[data-kpi]')).toHaveCount(4)
  await expect(page.getByRole('heading', { name: 'What is driving current risk' })).toBeVisible()
})

test('the factor panel shows raw values, a denominator, and a table alternative', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  await signIn(page, 'ANALYST')

  const panel = page.locator('[data-factor-section]')
  await expect(panel).toBeVisible()

  // Raw basis points, never a bare percentage.
  await expect(panel.locator('[data-factor-value]').first()).toContainText(/\/ [\d,]+ bp/)
  // The denominator is stated.
  await expect(panel.getByText(/scored findings/).first()).toBeVisible()

  // The accessible alternative exists and is a real table.
  await panel.getByText('Factor contributions as a table').click()
  const table = panel.locator('table')
  await expect(table).toBeVisible()
  await expect(table.locator('th', { hasText: 'Contributed' })).toBeVisible()
  await expect(table.locator('th', { hasText: 'No evidence' })).toBeVisible()

  expect(problems()).toEqual([])
})

test('KPI counters settle on the exact backend value', async ({ page }) => {
  await signIn(page, 'ADMIN')

  // Let the entrance timeline finish, then compare every rendered counter
  // against the data attribute it was told to count to.
  await page.waitForTimeout(1500)
  const mismatches = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-count-to]'))
      .map((el) => ({
        expected: Number(el.getAttribute('data-count-to')).toLocaleString('en-US'),
        actual: el.textContent.trim(),
      }))
      .filter((row) => row.expected !== row.actual)
  )
  expect(mismatches, 'every animated counter must land on its persisted value').toEqual([])
})

test('an unavailable or restricted figure renders as an em dash, never a zero', async ({ page }) => {
  await signIn(page, 'VIEWER')
  // VIEWER's notification metric is restricted. It must not read "0".
  const restrictedRegion = page.locator('text=Restricted for this role').locator('xpath=ancestor::*[3]')
  await expect(restrictedRegion).toContainText('—')
})
