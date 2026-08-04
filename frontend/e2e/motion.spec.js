// Motion behaviour, checked in a real browser because none of it is provable
// from source: once-per-session, skip, replay, and the reduced-motion path.
//
// The standing rule this suite enforces: motion may never leave operational
// content invisible, and may never sit between an analyst and a control.

import { test, expect } from '@playwright/test'
import { signIn, collectConsoleProblems } from './support.js'

test('the opening plays on first visit and not on the second', async ({ page }) => {
  await page.goto('/login')

  // First visit in this session: Skip is offered, which is only rendered while
  // the opening is actually running.
  await expect(page.getByTestId('skip-intro')).toBeVisible()

  // Reload within the same session — sessionStorage persists, so it must not
  // replay.
  await page.reload()
  await expect(page.getByTestId('skip-intro')).toHaveCount(0)
  // The brand story is fully rendered anyway.
  await expect(page.getByText('Connecting Intelligence with Action')).toBeVisible()
})

test('the sign-in form is usable while the opening is still running', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByTestId('skip-intro')).toBeVisible()

  // No waiting: type immediately, into a form that shares the screen with a
  // running animation.
  await page.locator('#login-email').fill('someone@threatnexus.local')
  await expect(page.locator('#login-email')).toHaveValue('someone@threatnexus.local')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled()
})

test('Skip lands the opening on its final frame, not a half-played one', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('skip-intro').click()

  // The control removes itself, and every staged element is fully opaque.
  await expect(page.getByTestId('skip-intro')).toHaveCount(0)

  const faded = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-open-step]'))
      .map((el) => ({ step: el.getAttribute('data-open-step'), opacity: getComputedStyle(el).opacity }))
      .filter((row) => Number(row.opacity) < 0.99)
  )
  expect(faded, 'skipping must not strand any opening element mid-fade').toEqual([])

  // The motif's own artwork is at its end state too — no half-drawn strokes.
  const hiddenNodes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tnx-node'))
      .filter((el) => Number(getComputedStyle(el).opacity) < 0.99).length
  )
  expect(hiddenNodes).toBe(0)
})

test('reduced motion renders the complete final state immediately and builds no timeline', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = await context.newPage()
  const problems = collectConsoleProblems(page)

  await page.goto('/login')
  // No opening, so no Skip control.
  await expect(page.getByTestId('skip-intro')).toHaveCount(0)
  await expect(page.getByText('Connecting Intelligence with Action')).toBeVisible()

  await signIn(page, 'ANALYST')

  // Everything is final immediately — no element is waiting on a tween.
  const invisible = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-kpi], [data-primary-panel], [data-queue-row], [data-secondary-section]'))
      .filter((el) => Number(getComputedStyle(el).opacity) < 0.99)
      .map((el) => el.getAttribute('data-kpi') !== null ? 'kpi' : el.className)
  )
  expect(invisible, 'reduced motion must render the final state at once').toEqual([])

  // The refresh spinner is suppressed rather than merely slowed.
  await page.getByRole('button', { name: 'Refresh' }).click()
  const spinAnimation = await page.evaluate(() => {
    const icon = document.querySelector('.tnx-spin')
    return icon ? getComputedStyle(icon).animationName : 'no-spinner'
  })
  expect(['none', 'no-spinner']).toContain(spinAnimation)

  expect(problems()).toEqual([])
  await context.close()
})

test('the in-app motion preference suppresses motion on its own', async ({ page }) => {
  await signIn(page, 'ADMIN')
  await page.goto('/settings')

  await page.getByTestId('reduced-motion-toggle').click()
  await page.goto('/dashboard')

  const invisible = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-kpi], [data-primary-panel]'))
      .filter((el) => Number(getComputedStyle(el).opacity) < 0.99).length
  )
  expect(invisible).toBe(0)

  await page.getByRole('button', { name: 'Refresh' }).click()
  const spinAnimation = await page.evaluate(() => {
    const icon = document.querySelector('.tnx-spin')
    return icon ? getComputedStyle(icon).animationName : 'no-spinner'
  })
  expect(['none', 'no-spinner']).toContain(spinAnimation)

  // Restore, so the shared browser state does not leak into another test.
  await page.goto('/settings')
  await page.getByTestId('reduced-motion-toggle').click()
})

test('Replay product intro is safe: it plays, and it signs nobody out', async ({ page }) => {
  await signIn(page, 'ADMIN')
  await page.goto('/settings')

  const tokenBefore = await page.evaluate(() => window.localStorage.getItem('token'))
  const openingSeenBefore = await page.evaluate(() => window.sessionStorage.getItem('tnx.opening.seen'))

  await page.getByTestId('replay-intro').click()
  await expect(page.getByTestId('intro-replay-stage')).toBeVisible()

  // The decisive assertions: auth is untouched and the session marker is not
  // manipulated, so replaying cannot log anybody out or re-arm the login
  // opening behind their back.
  expect(await page.evaluate(() => window.localStorage.getItem('token'))).toBe(tokenBefore)
  expect(await page.evaluate(() => window.sessionStorage.getItem('tnx.opening.seen'))).toBe(openingSeenBefore)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
})

test('no secondary section is ever stranded invisible waiting for a scroll trigger', async ({ page }) => {
  await signIn(page, 'ADMIN')

  // Without scrolling at all, every below-the-fold section is already visible.
  // Only transform may be animated on scroll — never opacity.
  const stranded = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-secondary-section]'))
      .map((el, index) => ({ index, opacity: Number(getComputedStyle(el).opacity), visibility: getComputedStyle(el).visibility }))
      .filter((row) => row.opacity < 0.99 || row.visibility === 'hidden')
  )
  expect(stranded, 'a trigger that never fires must not hide operational evidence').toEqual([])
})
