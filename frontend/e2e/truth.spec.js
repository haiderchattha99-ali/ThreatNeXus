// The truth-cleanup regression gate.
//
// Every assertion here names a specific claim that WAS on this UI and was
// fabricated. These tests exist so that removing them is a deliberate act with
// a failing build attached, rather than something a future refactor can quietly
// undo.
//
// The negative assertions are the whole point. A test that only checks the
// replacement copy renders would pass just as happily if the fabricated text
// came back beside it.

import { test, expect } from '@playwright/test'
import { signIn, collectConsoleProblems } from './support.js'

test('Settings states real configuration and none of the fabricated claims', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  await signIn(page, 'ADMIN')
  await page.goto('/settings')

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Platform configuration' })).toBeVisible()

  const body = page.locator('body')

  // Widgets Phase 6 deleted, whose toggles wrote to localStorage and were read
  // by nothing.
  await expect(body).not.toContainText('Show Threat Map')
  await expect(body).not.toContainText('Show Live Threat Feed')
  await expect(body).not.toContainText('Show MITRE ATT&CK Matrix')

  // Scheduled ingestion is explicitly out of scope and does not exist.
  await expect(body).not.toContainText('Threat Feed Refresh')

  // Providers that are not implemented anywhere in this repository.
  await expect(body).not.toContainText('VirusTotal')
  await expect(body).not.toContainText('AlienVault OTX')
  await expect(body).not.toContainText('MISP')

  // An alerting subsystem that does not exist.
  await expect(body).not.toContainText('Critical Threat Alerts')
  await expect(body).not.toContainText('Malware Detection Alerts')

  // Hardcoded service-availability figures and blanket health claims.
  await expect(body).not.toContainText('System Health')
  await expect(body).not.toContainText('Service Availability')
  await expect(body).not.toContainText('All systems operational')

  // AI must report its REAL state. It is disabled by default.
  await expect(body).not.toContainText('AI Engine: Ready')
  await expect(page.getByRole('heading', { name: 'AI assistance' })).toBeVisible()
  await expect(page.getByText('Disabled', { exact: true })).toBeVisible()

  // And the page states what this instance genuinely does not have.
  await expect(page.getByText(/no scheduled ingestion, no alerting subsystem/i)).toBeVisible()

  expect(problems()).toEqual([])
})

test('Settings offers no HTTP switch for AI or for a provider key', async ({ page }) => {
  await signIn(page, 'ADMIN')
  await page.goto('/settings')

  // Exactly one control that changes anything, and it is the local motion
  // preference. No provider selector, no AI toggle, no key field.
  const selects = await page.locator('select, [role="combobox"]').count()
  expect(selects, 'Settings must expose no configuration selector').toBe(0)

  const passwordish = await page.locator('input[type="password"], input[name*="key" i], input[placeholder*="key" i]').count()
  expect(passwordish, 'Settings must expose no key field').toBe(0)

  const switches = page.locator('input[type="checkbox"]')
  await expect(switches).toHaveCount(1)
  await expect(page.getByTestId('reduced-motion-toggle')).toBeVisible()
})

test('Profile shows no fabricated last login, statistics or connection chips', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  await signIn(page, 'ANALYST')
  await page.goto('/profile')

  await expect(page.getByRole('heading', { name: 'Account', exact: true, level: 1 })).toBeVisible()

  const body = page.locator('body')

  // The User model persists no login timestamp; the old page rendered the
  // current clock in its place.
  await expect(body).not.toContainText('Last Login')

  // Static chips that rendered green regardless of any real state.
  await expect(body).not.toContainText('Backend Connected')
  await expect(body).not.toContainText('Session Active')
  await expect(body).not.toContainText('Encrypted Session')

  // A hardcoded department, and four hardcoded-"0" statistics.
  await expect(body).not.toContainText('Threat Intelligence\n')
  await expect(body).not.toContainText('Analyst Statistics')
  await expect(body).not.toContainText('Threats Reviewed')
  await expect(body).not.toContainText('Cases Assigned')

  // No editable identity: the app exposes no authenticated account-update route.
  expect(await page.locator('input[type="text"], input:not([type])').count()).toBe(0)
  await expect(page.getByRole('button', { name: /Save Profile/i })).toHaveCount(0)

  // It names what is not recorded rather than inventing it.
  await expect(page.getByRole('heading', { name: 'Not recorded for this account' })).toBeVisible()
  await expect(page.getByText(/No login timestamp is persisted/i)).toBeVisible()

  // The real, server-returned identity IS shown.
  await expect(page.getByText('ANALYST').first()).toBeVisible()

  expect(problems()).toEqual([])
})

test('Organizations labels the hand-entered columns and publishes no posture aggregate', async ({ page }) => {
  const problems = collectConsoleProblems(page)
  await signIn(page, 'ADMIN')
  await page.goto('/organizations')

  await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible()

  const body = page.locator('body')

  // The two aggregates that turned hand-typed numbers into measurements — one
  // of them a national-looking headline.
  await expect(body).not.toContainText('Average Security Score')
  await expect(body).not.toContainText('Active Threats\n0')
  const headlineThreats = page.locator('h3, h4, [class*="metric"]').filter({ hasText: /^Active Threats$/ })
  await expect(headlineThreats).toHaveCount(0)

  // The columns survive, labelled for what they are.
  await expect(page.getByText('manually entered').first()).toBeVisible()
  await expect(page.getByText(/Not measured, not computed/i).first()).toBeVisible()

  // The one remaining aggregate is a row count, described as exactly that.
  await expect(page.getByText('constituent records loaded into this instance')).toBeVisible()

  expect(problems()).toEqual([])
})

test('Analysis labels framework figures as mapping counts, never coverage', async ({ page }) => {
  await signIn(page, 'ANALYST')
  await page.goto('/analytics')

  await expect(page.getByRole('heading', { name: 'Framework mappings by family' })).toBeVisible()

  const body = page.locator('body')
  // The metric the build guard forbids outright.
  await expect(body).not.toContainText('percentage mapped')
  await expect(body).not.toContainText('% coverage')
  await expect(body).not.toContainText('ATT&CK coverage')

  await expect(page.getByText(/Not coverage, not compliance, not maturity/i)).toBeVisible()

  // And no ATT&CK tactic matrix: the current references are not catalogue-validated.
  await expect(page.getByText(/no ATT&CK tactic matrix/i)).toBeVisible()
})

test('every chart on Analysis carries a table alternative', async ({ page }) => {
  await signIn(page, 'ADMIN')
  await page.goto('/analytics')

  const disclosures = page.getByText('Show these figures as a table', { exact: true })
  await expect(disclosures.first()).toBeVisible()
  const count = await disclosures.count()
  expect(count, 'each distribution panel offers its figures as a table').toBeGreaterThanOrEqual(6)

  // Opening one yields a real table with a caption stating the denominator.
  await disclosures.first().click()
  const table = page.locator('table').first()
  await expect(table).toBeVisible()
  await expect(table.locator('caption')).toContainText(/Out of|records counted/)
})
