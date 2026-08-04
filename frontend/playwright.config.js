// Playwright — the Phase 6.2 browser exit gate.
//
// Chromium only, deliberately. This suite exists to prove behaviour that unit
// tests structurally cannot (real navigation, real focus, real layout, real
// console output, real reduced-motion media state), not to survey rendering
// engines. Adding Firefox and WebKit would triple the runtime for a claim this
// project never makes.
//
// It drives the REAL stack: a real backend against a real PostgreSQL database
// with real REST routes and real JWTs. Nothing is stubbed. That is the point —
// a mocked E2E suite would have passed against the fabricated dashboard too.
//
// CREDENTIALS come from environment variables and are never committed. The four
// account EMAILS are well-known local infrastructure identifiers, already
// documented in backend/src/scripts/seedUsers.js and carrying no secret; the
// PASSWORD has no default and the suite refuses to start without it.
//
//   E2E_PASSWORD       required — the password the four accounts were seeded with
//   E2E_BASE_URL       optional — defaults to the dev server below
//   E2E_SKIP_WEBSERVER optional — set when servers are already running

import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:4173'

export default defineConfig({
  testDir: './e2e',
  // Determinism over speed. These tests read a SHARED database: two workers
  // signing in as different roles and asserting counts against the same rows
  // would race each other, and a flaky exit gate is not a gate.
  workers: 1,
  fullyParallel: false,
  // A retry would mask exactly the intermittent failure this gate should catch.
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    // 1440x900 is the desktop review size; individual tests resize themselves
    // for the tablet and mobile assertions.
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Serves the production build rather than the dev server: an exit gate should
  // exercise the artifact that ships, including its chunking and minification.
  webServer: process.env.E2E_SKIP_WEBSERVER
    ? undefined
    : {
        command: 'npm run preview -- --port 4173 --strictPort',
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
})
