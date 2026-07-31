import { describe, it, expect } from 'vitest'
import { PAGE_CAPABILITIES, hasCapability, canAccessPage } from './permissions'
import { CAPABILITIES, CAPABILITY_VALUES } from '../constants/capabilities'

// Mirrors backend/src/lib/roles.js ROLE_CAPABILITIES so these tests fail if
// the frontend capability model drifts from what the backend actually
// grants. Kept local rather than imported (frontend/backend are separate
// runtimes) — deliberately duplicated so a change to either side without the
// other breaks a test.
const ANALYST_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.INGEST_REPORTS,
  CAPABILITIES.TRIAGE_FINDINGS,
  CAPABILITIES.MANAGE_CASES,
  CAPABILITIES.OVERRIDE_FINDING_OWNERSHIP,
  CAPABILITIES.TRIGGER_FINDING_ENRICHMENT,
  CAPABILITIES.RECALCULATE_FINDING_RISK,
  CAPABILITIES.MANAGE_FINDING_VULNERABILITIES,
  CAPABILITIES.TRIGGER_VULNERABILITY_ENRICHMENT,
]
const REVIEWER_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.REVIEW_NOTIFICATIONS,
  CAPABILITIES.REVIEW_AI_SUGGESTIONS,
]
const VIEWER_CAPABILITIES = [CAPABILITIES.READ_DASHBOARD, CAPABILITIES.READ_FINDINGS]

describe('PAGE_CAPABILITIES', () => {
  it('contains no unknown backend capability names', () => {
    Object.values(PAGE_CAPABILITIES).forEach((capability) => {
      if (capability === null) return
      expect(CAPABILITY_VALUES).toContain(capability)
    })
  })
})

describe('hasCapability', () => {
  it('fails closed for a non-array capability list', () => {
    expect(hasCapability(undefined, CAPABILITIES.READ_DASHBOARD)).toBe(false)
    expect(hasCapability(null, CAPABILITIES.READ_DASHBOARD)).toBe(false)
  })

  it('returns true only when the capability is present', () => {
    expect(hasCapability([CAPABILITIES.READ_DASHBOARD], CAPABILITIES.READ_DASHBOARD)).toBe(true)
    expect(hasCapability([CAPABILITIES.READ_DASHBOARD], CAPABILITIES.MANAGE_CASES)).toBe(false)
  })

  it('excludes the ADMIN-only vulnerability batch capabilities from every non-ADMIN role', () => {
    for (const caps of [ANALYST_CAPABILITIES, REVIEWER_CAPABILITIES, VIEWER_CAPABILITIES]) {
      expect(hasCapability(caps, CAPABILITIES.EXECUTE_ENRICHMENT_BATCH)).toBe(false)
      expect(hasCapability(caps, CAPABILITIES.EXECUTE_VULNERABILITY_ENRICHMENT_BATCH)).toBe(false)
    }
  })
})

describe('canAccessPage', () => {
  it('denies an unrecognized page name', () => {
    expect(canAccessPage([CAPABILITIES.READ_DASHBOARD], 'no-such-page')).toBe(false)
  })

  it('allows an authenticated-only page regardless of capabilities', () => {
    expect(canAccessPage([], 'profile')).toBe(true)
  })

  it('requires the mapped capability for a gated page', () => {
    expect(canAccessPage([], 'cases')).toBe(false)
    expect(canAccessPage([CAPABILITIES.MANAGE_CASES], 'cases')).toBe(true)
  })

  it('denies REVIEWER access to cases (no backend manage:cases grant)', () => {
    expect(canAccessPage(REVIEWER_CAPABILITIES, 'cases')).toBe(false)
  })

  it('denies VIEWER access to every mutation-capable page', () => {
    ;['upload', 'cases', 'notifications', 'organizations', 'settings'].forEach((page) => {
      expect(canAccessPage(VIEWER_CAPABILITIES, page)).toBe(false)
    })
  })
})
