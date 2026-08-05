import { test, expect } from '@playwright/test'
import { collectConsoleProblems, ROLES, signIn } from './support.js'

for (const role of ROLES) {
  test(`${role} can read the truthful ATT&CK evidence navigator`, async ({ page }) => {
    const problems = collectConsoleProblems(page)
    await signIn(page, role)

    const requests = []
    page.on('request', (request) => requests.push(request.url()))
    await page.goto('/attack')

    await expect(page.getByRole('heading', { name: 'ATT&CK evidence navigator' })).toBeVisible()
    await expect(page.getByText(/No coverage percentage is shown/i)).toBeVisible()
    await expect(page.getByRole('region', { name: 'MITRE ATT&CK tactic matrix' })).toBeVisible()
    await expect(page.getByText(/Enterprise ATT&CK 19\.1/i).first()).toBeVisible()

    const pageText = await page.locator('main').innerText()
    expect(pageText).not.toMatch(/\d+\s*%/)
    expect(
      requests.filter((url) => url.includes('/api/attack/navigator')).length,
      'the navigator renders from one bounded snapshot request',
    ).toBe(1)
    expect(
      requests.filter((url) => /abuseipdb|censys|shadowserver|nvd\.nist/i.test(url)),
      'rendering the navigator must not contact an external provider',
    ).toEqual([])
    expect(problems(), `console problems for ${role}`).toEqual([])
  })
}

test('the matrix search and technique evidence panel remain keyboard-operable', async ({ page }) => {
  await signIn(page, 'ANALYST')
  await page.goto('/attack')

  const search = page.getByLabel('Search technique ID or name')
  await search.fill('T1021')
  const technique = page.getByRole('button', { name: /T1021/i }).first()
  await expect(technique).toBeVisible()
  await technique.focus()
  await expect(technique).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: /Remote Services/i })).toBeVisible()
  await expect(page.getByText(/No mappings in the loaded dataset|Evidence confidence/i).first()).toBeVisible()
})

test('reduced motion leaves every navigator section visible and usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await signIn(page, 'VIEWER')
  await page.goto('/attack')

  await expect(page.getByRole('heading', { name: 'ATT&CK evidence navigator' })).toBeVisible()
  const stranded = await page.locator('[data-attack-header], [data-attack-metric], [data-attack-workspace], [data-tactic-column]').evaluateAll((elements) =>
    elements.filter((element) => {
      const style = getComputedStyle(element)
      return style.visibility === 'hidden' || Number(style.opacity) === 0
    }).length,
  )
  expect(stranded).toBe(0)
})
