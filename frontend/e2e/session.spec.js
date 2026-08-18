// Session behaviour: what a 401 must do, and what a 403 must NOT do.
//
// These two statuses mean opposite things and the application has to treat them
// as opposites. A 401 says the credential is no longer good — the session ends.
// A 403 says the credential is fine and this particular thing is refused — the
// session survives. Collapsing the two is a real and common defect: signing a
// legitimately-authenticated analyst out because one panel they were never
// entitled to read answered 403 would look like a random logout, and there is no
// unit test that can prove the difference, because the behaviour lives in an
// axios interceptor, a context listener and a real browser navigation.

import { test, expect } from '@playwright/test'

import { signIn } from './support.js'

test('a real 401 from the backend ends the session and explains why', async ({ page }) => {
  await signIn(page, 'ANALYST')

  // Replace the stored token with one the backend cannot verify. This is the
  // same answer — 401 — that an expired or revoked token produces, and it comes
  // from the REAL backend rather than an intercepted response.
  await page.evaluate(() => {
    window.localStorage.setItem('token', 'eyJhbGciOiJIUzI1NiJ9.e30.not-a-valid-signature')
  })

  await page.getByRole('button', { name: 'Refresh' }).click()

  await page.waitForURL('**/login?reason=session-expired', { timeout: 20_000 })
  await expect(
    page.getByText('Your session ended and you were signed out. Sign in again to continue.')
  ).toBeVisible()

  // The stored session is actually cleared, not merely navigated away from.
  expect(await page.evaluate(() => window.localStorage.getItem('token'))).toBeNull()
})

test('a 403 refusal is surfaced in place and signs nobody out', async ({ page }) => {
  await signIn(page, 'ANALYST')
  const tokenBefore = await page.evaluate(() => window.localStorage.getItem('token'))

  // A capability refusal, shaped exactly as the backend's error envelope. It is
  // fulfilled rather than provoked because no route this role can reach through
  // the UI answers 403 — which is the point: the interceptor must handle the
  // status correctly even where the UI never normally produces it.
  await page.route('**/api/dashboard/overview', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Your role does not hold the required capability.' },
      }),
    })
  )

  await page.getByRole('button', { name: 'Refresh' }).click()

  // The refusal is reported as an explicit access refusal, not the generic
  // transport-failure wording, and the last good snapshot stays on screen.
  await expect(page.getByText(/^Access refused\./)).toBeVisible()
  await expect(page.getByText(/Refresh failed\./)).toHaveCount(0)
  await expect(page.locator('[data-kpi]')).toHaveCount(4)

  // THE ASSERTION: still signed in, still on the dashboard, same token.
  await expect(page).toHaveURL(/\/dashboard/)
  expect(await page.evaluate(() => window.localStorage.getItem('token'))).toBe(tokenBefore)
})

test('a capability-gated route denies in place and leaves the session intact', async ({ page }) => {
  await signIn(page, 'VIEWER')
  const tokenBefore = await page.evaluate(() => window.localStorage.getItem('token'))

  // VIEWER does not hold read:notifications. The route denies, and says the
  // server would refuse the underlying request regardless of what renders here.
  await page.goto('/notifications')
  // One refusal language product-wide: the same DeniedState a panel renders,
  // promoted to the page's <h1>. The status code stays a stated fact in the body.
  await expect(
    page.getByRole('heading', { name: 'You do not have access to this view' })
  ).toBeVisible()
  await expect(page.getByText(/The\s+server\s+enforces\s+this\s+independently/)).toBeVisible()
  await expect(page.getByText(/HTTP 403/)).toBeVisible()

  expect(await page.evaluate(() => window.localStorage.getItem('token'))).toBe(tokenBefore)

  // And the session still works everywhere it is entitled to.
  await page.goto('/dashboard')
  await expect(page.getByTestId('dashboard-snapshot')).toBeVisible()
})
