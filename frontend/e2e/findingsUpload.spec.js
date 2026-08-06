// Findings navigation and the report-ingestion (upload) path — the two
// workflow surfaces the earlier browser gate exercised only indirectly
// (Findings appeared solely in the overflow sweep; Upload had no coverage at
// all). Both drive the real backend: the CSV here is one of the same fixtures
// seed:demo already ingested, so a green run also proves the dedup/persistence
// path renders a truthful result instead of crashing on a repeat report.

import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { signIn, collectConsoleProblems } from './support.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEMO_CSV = path.join(__dirname, '..', '..', 'data', 'demo', 'accessible-rdp', 'demo_01_baseline.csv')

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

test('ANALYST can submit a report and see a truthful ingestion result', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  await signIn(page, 'ANALYST')

  await page.getByRole('button', { name: 'Report ingestion' }).click()
  await page.waitForURL('**/upload')

  await page.locator('#csv-upload').setInputFiles(DEMO_CSV)
  await page.getByRole('button', { name: 'Import intelligence' }).click()

  // A toast ("N threat(s) added…") and the panel's own result heading both
  // carry role="status" — the heading is the durable result, the toast fades.
  await expect(page.getByRole('heading', { name: 'Report processed' })).toBeVisible({ timeout: 20_000 })

  expect(problems(), problems().join('\n')).toEqual([])
})

test('VIEWER is denied report ingestion in place and stays signed in', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  await signIn(page, 'VIEWER')

  // Not in the nav for VIEWER at all (capability-filtered) — the direct
  // navigation is what actually proves the route fails closed rather than
  // merely being unlinked.
  await page.goto('/upload')
  await expect(page.getByRole('alert')).toContainText('Access Denied')

  // Still signed in: a 403 must never behave like the 401 session-expiry path.
  await page.goto('/dashboard')
  await expect(page.getByRole('button', { name: /Refresh|Updating/ })).toBeVisible()

  expect(problems(), problems().join('\n')).toEqual([])
})
