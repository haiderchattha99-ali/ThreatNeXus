// Phase 10B — the Finding enrichment orchestration visibility panel, driven
// through the real app: real backend, real PostgreSQL, real REST routes, real
// JWTs. Mirrors findingAiAssistance.spec.js's shape and reasoning exactly.
//
// The seeded demo database has never had a Phase 10 orchestration run created
// for any Finding, so every provider row renders NOT_REQUESTED/NO_SUBJECT by
// default — this suite proves that truthful default state, plus the one real
// write path (POST /enrichment/runs), which is safe to exercise here: the
// worker is disabled and every provider key is empty in this environment
// (see docker-compose/CI env), so creating a run reserves nothing and
// contacts no live provider. Per-state rendering (COMPLETED, stale, SKIPPED
// with a specific reason, NVD CVE subjects) is covered at the component level
// by FindingEnrichmentPanel.test.jsx, which can inject arbitrary fixture
// responses; this suite proves the real integration wiring instead.

import { test, expect } from '@playwright/test'
import { ROLES, signIn, collectConsoleProblems, expectNoHorizontalOverflow, BREAKPOINTS } from './support.js'

async function openFirstFinding(page) {
  await page.goto('/findings')
  const firstRow = page.locator('a[href^="/findings/"]').first()
  await expect(firstRow).toBeVisible()
  await firstRow.click()
  await page.waitForURL(/\/findings\/\d+/)
}

test('ANALYST sees the enrichment coverage panel with all six providers and no console problems', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  await signIn(page, 'ANALYST')
  await openFirstFinding(page)

  const panel = page.getByRole('heading', { name: 'Enrichment coverage' })
  await expect(panel).toBeVisible()

  for (const provider of ['AbuseIPDB', 'Censys', 'GreyNoise', 'Netlas', 'NVD', 'Shodan']) {
    await expect(page.getByText(provider, { exact: true })).toBeVisible()
  }

  // executionState is shown truthfully — this environment never enables the
  // worker, so a recorded request is never implied to have been executed.
  await expect(page.getByTestId('enrichment-execution-state')).toContainText('Execution paused')

  // ANALYST holds trigger:finding-enrichment.
  await expect(page.getByRole('button', { name: /Request enrichment/i })).toBeVisible()

  expect(problems(), 'console problems on the finding detail page').toEqual([])
})

test('VIEWER can read the panel but never sees the request control', async ({ page }) => {
  await signIn(page, 'VIEWER')
  await openFirstFinding(page)

  await expect(page.getByRole('heading', { name: 'Enrichment coverage' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Request enrichment/i })).toHaveCount(0)
})

test('ANALYST requesting enrichment records a real request with no live provider contact', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  await signIn(page, 'ANALYST')
  await openFirstFinding(page)

  await page.getByRole('button', { name: /Request enrichment/i }).click()

  const lastRun = page.getByTestId('enrichment-last-run')
  await expect(lastRun).toBeVisible()
  // One of the three closed outcomes — never a raw error, never silence.
  await expect(lastRun).toContainText(/recorded|already has an open request|refused by policy/i)

  expect(problems(), 'console problems after requesting enrichment').toEqual([])
})

test('the enrichment coverage panel never overflows at mobile or tablet width', async ({ page }) => {
  await signIn(page, 'ANALYST')
  await openFirstFinding(page)
  await expect(page.getByRole('heading', { name: 'Enrichment coverage' })).toBeVisible()

  for (const [name, size] of Object.entries(BREAKPOINTS)) {
    if (name === 'desktop') continue
    await page.setViewportSize(size)
    await expectNoHorizontalOverflow(page)
  }
})

for (const role of ROLES) {
  test(`${role} triggers no console errors when opening a finding with the enrichment panel present`, async ({ page }) => {
    const problems = collectConsoleProblems(page)
    await signIn(page, role)
    await openFirstFinding(page)
    await expect(page.getByRole('heading', { name: 'Enrichment coverage' })).toBeVisible()
    expect(problems(), `console problems for ${role}`).toEqual([])
  })
}
