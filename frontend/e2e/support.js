// Shared helpers for the Phase 6.2 browser exit gate.
//
// Everything role-related routes through here so a test never hardcodes a
// credential and never re-implements sign-in.

import { expect } from '@playwright/test'

export const ROLES = ['ADMIN', 'ANALYST', 'REVIEWER', 'VIEWER']

// Well-known local account emails, matching backend/src/scripts/seedUsers.js.
// These are infrastructure identifiers, not secrets. The PASSWORD is not here
// and has no default.
const EMAILS = {
  ADMIN: 'admin@threatnexus.local',
  ANALYST: 'analyst@threatnexus.local',
  REVIEWER: 'reviewer@threatnexus.local',
  VIEWER: 'viewer@threatnexus.local',
}

export function password() {
  const value = process.env.E2E_PASSWORD
  if (!value) {
    throw new Error(
      'E2E_PASSWORD is required and has no default. Set it to the password the four local accounts were seeded with, e.g.\n' +
        '  E2E_PASSWORD=<the-seeded-local-password> npm run test:e2e'
    )
  }
  return value
}

export function emailFor(role) {
  const email = process.env[`E2E_${role}_EMAIL`] || EMAILS[role]
  if (!email) throw new Error(`No email configured for role ${role}`)
  return email
}

/**
 * Signs in through the real form and the real POST /api/auth/login.
 *
 * Deliberately does NOT inject a token into localStorage: that shortcut would
 * skip the very route chain and the very opening behaviour this suite is here
 * to check.
 */
export async function signIn(page, role) {
  await page.goto('/login')
  // Targeted by the explicit ids Login.jsx sets, not by label text. MUI renders
  // a required field's label as "Password *", so an exact label match never
  // resolves and a loose one also matches the "Show password" toggle.
  await page.locator('#login-email').fill(emailFor(role))
  await page.locator('#login-password').fill(password())
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard', { timeout: 20_000 })
  await expect(page.getByRole('button', { name: /Refresh|Updating/ })).toBeVisible()
}

/**
 * Collects console errors and page exceptions for the lifetime of a page.
 *
 * Returns a getter rather than an array so a test reads the state at assertion
 * time. Vite's own dev banners are not filtered because this suite runs against
 * the production preview build, which emits none.
 */
export function collectConsoleProblems(page) {
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => {
    problems.push(`pageerror: ${error.message}`)
  })
  return () => problems
}

/**
 * Fails if the document scrolls horizontally.
 *
 * Compares scrollWidth against the viewport rather than against clientWidth, so
 * a vertical scrollbar cannot mask a genuine overflow.
 */
export async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    // The widest offending element, to make a failure diagnosable rather than
    // just red.
    widest: Array.from(document.querySelectorAll('body *'))
      .map((el) => {
        const rect = el.getBoundingClientRect()
        return {
          tag: el.tagName,
          cls: String(el.className).slice(0, 60),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          text: (el.textContent || '').trim().slice(0, 80),
          html: el.outerHTML.slice(0, 240),
        }
      })
      .filter((e) => e.right > window.innerWidth + 1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 3),
  }))
  expect(
    overflow.scrollWidth,
    `Document scrolls horizontally at ${page.url()}. Widest offenders: ${JSON.stringify(overflow.widest)}`
  ).toBeLessThanOrEqual(overflow.innerWidth + 1)
}

export const BREAKPOINTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
}
