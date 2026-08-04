// Responsive layout, the mobile drawer, and the keyboard path.
//
// These are the assertions that cannot be made from source: whether anything
// actually overflows, whether focus actually returns, and whether a keyboard
// user can actually see where they are.

import { test, expect } from '@playwright/test'
import { signIn, expectNoHorizontalOverflow, BREAKPOINTS, collectConsoleProblems } from './support.js'

const PAGES = ['/dashboard', '/analytics', '/findings', '/settings', '/profile', '/organizations']

for (const [name, size] of Object.entries(BREAKPOINTS)) {
  test(`no horizontal overflow at ${name} (${size.width}x${size.height})`, async ({ page }) => {
    await page.setViewportSize(size)
    const problems = collectConsoleProblems(page)
    await signIn(page, 'ADMIN')

    for (const path of PAGES) {
      await page.goto(path)
      // Wait for the page's own content, not a fixed timeout.
      await expect(page.locator('h1, [role="heading"]').first()).toBeVisible()
      await expectNoHorizontalOverflow(page)
    }

    expect(problems(), `console problems at ${name}`).toEqual([])
  })
}

test('the mobile drawer opens, closes, and returns focus to the control that opened it', async ({ page }) => {
  await page.setViewportSize(BREAKPOINTS.mobile)
  await signIn(page, 'ANALYST')

  const opener = page.getByRole('button', { name: 'Open navigation menu' })
  await expect(opener).toBeVisible()

  await opener.click()
  const drawerItem = page.getByRole('button', { name: 'Findings' })
  await expect(drawerItem).toBeVisible()

  // Escape closes it — the standard dismissal a keyboard user will reach for.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('presentation').filter({ hasText: 'Findings' })).toHaveCount(0, { timeout: 5000 })

  // THE ASSERTION: focus is back on the opener, not lost to <body>. A drawer
  // that drops focus leaves a keyboard user at the top of the document with no
  // indication of where they were.
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  expect(focused).toBe('Open navigation menu')
})

test('navigating from the mobile drawer closes it', async ({ page }) => {
  await page.setViewportSize(BREAKPOINTS.mobile)
  await signIn(page, 'ANALYST')

  await page.getByRole('button', { name: 'Open navigation menu' }).click()
  await page.getByRole('button', { name: 'Findings' }).click()

  await page.waitForURL('**/findings')
  // The drawer must not stay open over the page it just navigated to.
  await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test('the core keyboard path works and focus is always visible', async ({ page }) => {
  await signIn(page, 'ANALYST')

  // Tab into the page and confirm focus lands on something real, with a visible
  // indicator, at every step.
  const seen = []
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const style = getComputedStyle(el)
      return {
        tag: el.tagName,
        name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
        // Focus must be indicated by an outline or a ring, never by colour
        // alone and never by nothing at all.
        indicated:
          style.outlineStyle !== 'none' ||
          parseFloat(style.outlineWidth) > 0 ||
          style.boxShadow !== 'none',
      }
    })
    if (info) seen.push(info)
  }

  expect(seen.length, 'tabbing must reach focusable controls').toBeGreaterThan(3)
  const unindicated = seen.filter((s) => !s.indicated)
  expect(unindicated, 'every focused control must show a visible focus indicator').toEqual([])
})

test('a KPI tile is reachable by keyboard and navigates to its records', async ({ page }) => {
  await signIn(page, 'ANALYST')

  const firstKpi = page.locator('[data-kpi]').first()
  await firstKpi.focus()
  await expect(firstKpi).toBeFocused()
  await page.keyboard.press('Enter')

  // The tile is a real link to the records behind the number, not a dead panel.
  await page.waitForURL(/\/findings/)
  await expect(page).toHaveURL(/\/findings/)
})
