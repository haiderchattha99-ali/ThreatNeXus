// Role composition: what each of the four roles actually sees on the dashboard.
//
// The claim under test is not "the page renders". It is that the SERVER-resolved
// role decides the composition, and that a section a role may not read is shown
// as restricted with a reason — never as an empty chart and never as a zero.

import { test, expect } from '@playwright/test'
import { ROLES, signIn, collectConsoleProblems } from './support.js'

for (const role of ROLES) {
  test(`${role} signs in and gets a composed, provenance-carrying dashboard`, async ({ page }) => {
    const problems = collectConsoleProblems(page)
    await signIn(page, role)

    // The header states the role the SNAPSHOT was gated against, which is the
    // server's answer — not a locally stored one.
    await expect(page.getByText(`${role} view`)).toBeVisible()

    // A snapshot timestamp is always present: every figure on the page is
    // anchored to one evaluation instant.
    await expect(page.getByTestId('dashboard-snapshot')).toBeVisible()

    // The dataset scope disclaimer must always render. These figures describe
    // the loaded dataset, never national exposure.
    await expect(page.getByText(/Loaded dataset only/)).toBeVisible()

    // Four KPI tiles, each a link to the records behind it.
    const kpis = page.locator('[data-kpi]')
    await expect(kpis).toHaveCount(4)

    // The one new Phase 6.2 visualization is readable by every role, because it
    // rides on read:findings which all four hold.
    await expect(page.getByRole('heading', { name: 'What is driving current risk' })).toBeVisible()

    expect(problems(), `console problems for ${role}`).toEqual([])
  })
}

test('each role gets its own primary queue and primary action', async ({ page }) => {
  const expected = {
    ADMIN: { queue: /Unresolved risk requiring attention/, action: 'Organizations' },
    ANALYST: { queue: /Findings awaiting triage/, action: 'Triage findings' },
    REVIEWER: { queue: /Oldest closure requests/, action: 'Review closures' },
    VIEWER: { queue: /Highest current Risk v1/, action: 'Browse findings' },
  }

  for (const role of ROLES) {
    await signIn(page, role)
    await expect(page.getByRole('heading', { name: expected[role].queue })).toBeVisible()
    await expect(page.getByRole('link', { name: expected[role].action })).toBeVisible()
    await page.evaluate(() => window.localStorage.clear())
  }
})

test('VIEWER is refused notification data as RESTRICTED, never as a zero', async ({ page }) => {
  await signIn(page, 'VIEWER')

  // On the dashboard, the workflow panel says restricted rather than showing 0.
  await expect(page.getByText('Restricted for this role')).toBeVisible()

  // The notifications nav entry is not offered at all.
  await expect(page.getByRole('button', { name: 'Notifications' })).toHaveCount(0)

  // And on Analysis, the two notification panels state a reason instead of
  // drawing empty bars.
  await page.goto('/analytics')
  await expect(page.getByRole('heading', { name: 'Notification review state' })).toBeVisible()
  const restricted = page.getByText(/requires read:notifications/i)
  await expect(restricted.first()).toBeVisible()

  // The decisive assertion: no notification panel shows a counted zero.
  const panel = page.locator('section, div').filter({ hasText: 'Notification review state' }).last()
  await expect(panel).not.toContainText('No records yet')
})

test('an authorized role DOES get notification data, proving the restriction is real gating', async ({ page }) => {
  await signIn(page, 'REVIEWER')
  await page.goto('/analytics')
  await expect(page.getByRole('heading', { name: 'Notification review state' })).toBeVisible()
  // Reviewer sees actual lifecycle buckets rather than a refusal.
  await expect(page.getByText('Pending review').first()).toBeVisible()
  await expect(page.getByText(/requires read:notifications/i)).toHaveCount(0)
})
