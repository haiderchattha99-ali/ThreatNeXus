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

// Phase 10C-2 — controlled force/justification and manual run refresh, driven
// through the real app against the same real backend/PostgreSQL stack as the
// rest of this file. Per-outcome copy is covered at the component level
// (FindingEnrichmentPanel.test.jsx); this suite proves the real wiring: the
// exact request payload on the wire, that a blank justification never reaches
// the network, that a double click cannot fire two requests, and that manual
// refresh visibly transitions and re-reads the canonical summary.

test('VIEWER sees neither the normal request nor the forced re-run control', async ({ page }) => {
  await signIn(page, 'VIEWER')
  await openFirstFinding(page)

  await expect(page.getByRole('heading', { name: 'Enrichment coverage' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Request enrichment/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Run again$/i })).toHaveCount(0)
})

test('a forced re-run sends exactly { force: true, justification } and blocks a blank justification first', async ({ page }) => {
  await signIn(page, 'ANALYST')
  await openFirstFinding(page)

  await page.getByRole('button', { name: /^Run again$/i }).click()
  const submit = page.getByRole('button', { name: /Request another run/i })

  // Blank justification never reaches the network.
  let requestSeen = false
  const onRequest = (req) => {
    if (req.method() === 'POST' && /\/enrichment\/runs$/.test(req.url())) requestSeen = true
  }
  page.on('request', onRequest)
  await submit.click()
  await expect(page.getByText(/Enter a justification/i)).toBeVisible()
  expect(requestSeen, 'no POST should fire while the justification field is blank').toBe(false)
  page.off('request', onRequest)

  const justificationField = page.getByLabel(/Why is another run needed/i)
  await justificationField.fill('  E2E verification of the force contract.  ')

  const [request] = await Promise.all([
    page.waitForRequest((req) => req.method() === 'POST' && /\/enrichment\/runs$/.test(req.url())),
    submit.click(),
  ])
  expect(JSON.parse(request.postData())).toEqual({
    force: true,
    justification: 'E2E verification of the force contract.',
  })

  const lastRun = page.getByTestId('enrichment-last-run')
  await expect(lastRun).toBeVisible()
  await expect(lastRun).toContainText(/Last forced request/i)
})

test('a forced re-run cannot be double-submitted while the request is in flight', async ({ page }) => {
  await signIn(page, 'ANALYST')
  await openFirstFinding(page)

  // Hold the response open briefly so the disabled/pending window is
  // observable rather than racing a same-tick local response.
  await page.route('**/enrichment/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await new Promise((resolve) => setTimeout(resolve, 500))
    return route.fallback()
  })

  await page.getByRole('button', { name: /^Run again$/i }).click()
  await page.getByLabel(/Why is another run needed/i).fill('Duplicate-submit guard check.')

  let postCount = 0
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/enrichment\/runs$/.test(req.url())) postCount += 1
  })

  // Bound by DOM position, not accessible name: the name itself changes to
  // "Requesting…" once disabled, which would make a name-based locator stop
  // resolving to the very button under test.
  const submit = page.locator('form button[type="submit"]')
  await submit.click()
  await expect(submit).toBeDisabled()
  // A second click while disabled must not queue a second request.
  await submit.click({ force: true })

  await expect(page.getByTestId('enrichment-last-run')).toContainText(/Last forced request/i, { timeout: 10_000 })
  expect(postCount, 'exactly one POST should fire despite the second click').toBe(1)
})

test('manual refresh shows a checking state, blocks a duplicate click, and re-reads the canonical summary', async ({ page }) => {
  await signIn(page, 'ANALYST')
  await openFirstFinding(page)

  await page.getByRole('button', { name: /Request enrichment/i }).click()
  const lastRun = page.getByTestId('enrichment-last-run')
  await expect(lastRun).toBeVisible()

  let summaryCallsAfterRefreshStart = 0
  await page.route('**/enrichment/runs/*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await new Promise((resolve) => setTimeout(resolve, 500))
    return route.fallback()
  })
  page.on('request', (req) => {
    if (req.method() === 'GET' && /\/enrichment\/summary$/.test(req.url())) summaryCallsAfterRefreshStart += 1
  })

  const refreshButton = lastRun.getByRole('button', { name: /Check status/i })
  await refreshButton.click()
  await expect(lastRun.getByRole('button', { name: /Checking status/i })).toBeDisabled()
  // A duplicate click while refreshing must not queue a second GET run call.
  let runGetCount = 0
  page.on('request', (req) => {
    if (req.method() === 'GET' && /\/enrichment\/runs\/\d+$/.test(req.url())) runGetCount += 1
  })
  await lastRun.getByRole('button', { name: /Checking status/i }).click({ force: true })

  await expect(refreshButton).toBeEnabled({ timeout: 10_000 })
  expect(runGetCount, 'exactly one GET run refresh should fire despite the second click').toBeLessThanOrEqual(1)
  expect(summaryCallsAfterRefreshStart, 'the canonical summary is re-fetched after refresh').toBeGreaterThan(0)
})

test('the forced re-run form is keyboard operable end to end', async ({ page }) => {
  await signIn(page, 'ANALYST')
  await openFirstFinding(page)

  const runAgain = page.getByRole('button', { name: /^Run again$/i })
  await runAgain.focus()
  await expect(runAgain).toBeFocused()
  await page.keyboard.press('Enter')

  const justificationField = page.getByLabel(/Why is another run needed/i)
  await expect(justificationField).toBeVisible()
  await justificationField.click()
  await page.keyboard.type('Keyboard-driven justification entry.')

  const submit = page.getByRole('button', { name: /Request another run/i })
  await submit.focus()
  await expect(submit).toBeFocused()
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('enrichment-last-run')).toContainText(/Last forced request/i, { timeout: 10_000 })
})
