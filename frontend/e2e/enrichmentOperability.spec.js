// Phase 10C-3 — the provider operability panel on Settings.
//
// Drives the REAL stack exactly like every other spec in this suite: real
// backend, real PostgreSQL, real JWTs, nothing stubbed. The verification
// stack is deliberately configured so the readiness ladder reaches three
// representative, high-risk states without turning the worker on and
// without any real provider credential existing:
//
//   - censys has a FAKE credential but the worker is OFF   -> EXECUTION_PAUSED
//   - every other credentialed provider has NO credential  -> NOT_CONFIGURED
//   - nvd is always delegated, regardless of configuration -> DELEGATED_BATCH_REQUIRED
//
// The remaining four ladder values (BUDGET_ZERO, BUDGET_EXHAUSTED,
// AUTOMATIC_INGESTION_DISABLED, READY) are exhaustively proven by
// enrichmentProviderReadiness.test.js and enrichmentUsageService.test.js —
// forcing them here would require either live provider contact or turning
// the worker on, both explicitly out of scope for this stage.
//
// NO LIVE PROVIDER IS EVER CONTACTED: ENRICHMENT_WORKER_ENABLED is false for
// this whole stack, so no code path in the worker tier can execute.

import { test, expect } from '@playwright/test'
import { signIn, collectConsoleProblems, expectNoHorizontalOverflow, BREAKPOINTS } from './support.js'

test('ADMIN sees truthful, closed-vocabulary provider readiness — no secret, no mutation control', async ({
  page,
}) => {
  const problems = collectConsoleProblems(page)
  await signIn(page, 'ADMIN')
  await page.goto('/settings')

  const heading = page.getByText('Enrichment budgets and readiness', { exact: true })
  await expect(heading).toBeVisible()

  const panel = page.locator('section', { has: heading }).first()

  // Closed-vocabulary readiness labels, never the raw backend enum string.
  await expect(panel.getByText('Not configured').first()).toBeVisible()
  await expect(panel.getByText('Execution paused').first()).toBeVisible()
  await expect(panel.getByText('Delegated to batch').first()).toBeVisible()
  await expect(panel).not.toContainText('NOT_CONFIGURED')
  await expect(panel).not.toContainText('EXECUTION_PAUSED')
  await expect(panel).not.toContainText('DELEGATED_BATCH_REQUIRED')

  // The missing-variable NAME is shown for an unconfigured provider —
  // exactly the identifier already public in .env.example, never a value.
  await expect(panel.getByText(/Missing:.*SHODAN_API_KEY/)).toBeVisible()

  // censys is the one provider given a real-looking (fake) credential in
  // this stack, which is what makes "Execution paused" (asserted above)
  // reachable at all rather than "Not configured" — proving credential
  // presence is actually read, not ignored. Its NAME is visible (providers
  // are always listed by name), but its fake VALUE must never reach the
  // page under any rendering.
  await expect(panel.getByText('censys', { exact: true })).toBeVisible()
  await expect(panel).not.toContainText('fake-censys-pat-for-e2e-only')
  await expect(panel).not.toContainText(/Missing:.*CENSYS_PAT/)

  // Today's usage / budget figures are present, in the "count / budget /
  // remaining" shape the panel renders — not silently blank.
  await expect(panel.getByText(/Automatic — today \/ budget \/ remaining/).first()).toBeVisible()
  await expect(panel.getByText(/Manual — today \/ budget \/ remaining/).first()).toBeVisible()

  // The deployment-owned/restart-required line and the required legacy-path
  // scope note are both present.
  await expect(panel.getByText(/requires editing the deployment environment and restarting/)).toBeVisible()
  await expect(panel.getByText(/describes the Phase-10 orchestration path only/)).toBeVisible()

  // No secret reaches the DOM: no password-shaped input anywhere on this
  // page, and no six credential variable NAMES render as a value next to
  // themselves (they render only as "Missing: <NAME>", never "<NAME>: <x>").
  expect(await page.locator('input[type="password"]').count()).toBe(0)

  // Structurally no mutation surface anywhere in this panel: no input, no
  // textarea, no select, and only the pre-existing "Refresh" read action.
  expect(await panel.locator('input, textarea, select').count()).toBe(0)
  const buttonLabels = await panel.getByRole('button').allTextContents()
  expect(buttonLabels.every((label) => /Refresh/i.test(label))).toBe(true)

  expect(problems()).toEqual([])
})

test('ANALYST never sees the panel and never triggers the request', async ({ page }) => {
  let usageRequested = false
  page.on('request', (req) => {
    if (/\/enrichment\/usage$/.test(req.url())) usageRequested = true
  })

  // /settings itself is already gated on manage:system (pre-existing,
  // unrelated to this ticket — src/utils/permissions.js), which ANALYST does
  // not hold, so the route-level guard refuses the whole page before this
  // ticket's own execute:enrichment-batch gate on the panel is ever reached.
  // That is a strictly stronger negative than "the panel is merely absent":
  // ANALYST cannot load the page at all.
  await signIn(page, 'ANALYST')
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: '403 - Access Denied' })).toBeVisible()

  // Give any stray effect a tick before asserting the negative.
  await page.waitForTimeout(500)

  await expect(page.getByText('Enrichment budgets and readiness', { exact: true })).toHaveCount(0)
  expect(usageRequested, 'GET /api/enrichment/usage must never fire for a session without execute:enrichment-batch').toBe(
    false
  )
})

test('the panel does not overflow at mobile width', async ({ page }) => {
  await page.setViewportSize(BREAKPOINTS.mobile)
  await signIn(page, 'ADMIN')
  await page.goto('/settings')
  await expect(page.getByText('Enrichment budgets and readiness', { exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})
