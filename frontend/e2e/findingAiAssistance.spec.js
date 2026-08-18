// Phase 8C.1 — the Finding AI-assistance panel, driven through the real app.
//
// The demo/CI environment ships with AI_ENABLED unset (the shipped default:
// false), so this suite proves the state every fresh deployment actually
// shows — disabled, role-gated, no console errors, no fabricated
// availability — rather than a populated draft, which would require the
// mock provider to be reachable from a production HTTP path. It deliberately
// is not (see backend/src/services/aiAssist/aiAssistRuntime.js): no caller
// on the request path ever passes the test-only allowMockProvider flag, so
// there is no way to observe a populated draft here without weakening that
// guarantee. The populated-state rendering (accept/reject, evidence tags,
// every status) is covered instead by
// frontend/src/components/FindingAiAssistPanel.test.jsx, which injects the
// mock provider directly at the component level.

import { test, expect } from '@playwright/test'
import { ROLES, signIn, collectConsoleProblems, expectNoHorizontalOverflow, BREAKPOINTS } from './support.js'

async function openFirstFinding(page) {
  await page.goto('/findings')
  const firstRow = page.locator('a[href^="/findings/"]').first()
  await expect(firstRow).toBeVisible()
  await firstRow.click()
  await page.waitForURL(/\/findings\/\d+/)
  // The finding page is decision-first: the optional subsystems sit last and
  // folded away, so an analyst does not scroll past two subsystems that are off
  // by default to reach triage. The panel is still MOUNTED and still loads —
  // only its visibility is deferred — so opening the disclosure is what this
  // suite has to do before asserting on what it rendered.
  await page.locator('summary', { hasText: 'AI assistance' }).click()
}

test('ANALYST sees the AI-assistance panel, correctly disabled by default, with no console problems', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  await signIn(page, 'ANALYST')
  await openFirstFinding(page)

  const panel = page.getByRole('heading', { name: 'AI assistance' })
  await expect(panel).toBeVisible()

  // The shipped default: AI_ENABLED is unset. Disabled must render as
  // "Disabled", never as an empty or zeroed section, and never as if a live
  // provider were running.
  await expect(page.getByText('AI assistance is disabled.')).toBeVisible()
  await expect(page.getByText('No AI drafts yet')).toBeVisible()
  // ANALYST holds request:ai-finding-suggestions, but with AI off there is
  // nothing to generate against — no generate control is offered.
  await expect(page.getByRole('button', { name: /Generate summary draft/i })).toHaveCount(0)

  expect(problems(), 'console problems on the finding detail page').toEqual([])
})

test('VIEWER is refused the AI panel as a denial, not as an absent or empty section', async ({ page }) => {
  await signIn(page, 'VIEWER')
  await openFirstFinding(page)

  await expect(page.getByRole('heading', { name: 'AI assistance' })).toBeVisible()
  await expect(page.getByText('You do not have access to this view')).toBeVisible()
  await expect(page.getByText(/read:ai-finding-suggestions/)).toBeVisible()
})

test('REVIEWER can read the AI panel and never sees a generate control', async ({ page }) => {
  await signIn(page, 'REVIEWER')
  await openFirstFinding(page)

  await expect(page.getByRole('heading', { name: 'AI assistance' })).toBeVisible()
  await expect(page.getByText('You do not have access to this view')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Generate/i })).toHaveCount(0)
})

test('the AI-assistance panel never overflows at mobile or tablet width', async ({ page }) => {
  await signIn(page, 'ANALYST')
  await openFirstFinding(page)
  await expect(page.getByRole('heading', { name: 'AI assistance' })).toBeVisible()

  for (const [name, size] of Object.entries(BREAKPOINTS)) {
    if (name === 'desktop') continue
    await page.setViewportSize(size)
    await expectNoHorizontalOverflow(page)
  }
})

for (const role of ROLES) {
  test(`${role} triggers no console errors when opening a finding with the AI panel present`, async ({ page }) => {
    const problems = collectConsoleProblems(page)
    await signIn(page, role)
    await openFirstFinding(page)
    await expect(page.getByRole('heading', { name: 'AI assistance' })).toBeVisible()
    expect(problems(), `console problems for ${role}`).toEqual([])
  })
}
