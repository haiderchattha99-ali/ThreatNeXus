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
  CAPABILITIES.READ_CASES,
  CAPABILITIES.OVERRIDE_FINDING_OWNERSHIP,
  CAPABILITIES.TRIGGER_FINDING_ENRICHMENT,
  CAPABILITIES.RECALCULATE_FINDING_RISK,
  CAPABILITIES.MANAGE_FINDING_VULNERABILITIES,
  CAPABILITIES.TRIGGER_VULNERABILITY_ENRICHMENT,
  // Phase 4 — an analyst drafts, edits, submits, exports and records delivery.
  CAPABILITIES.READ_NOTIFICATIONS,
  CAPABILITIES.MANAGE_NOTIFICATIONS,
  CAPABILITIES.EXPORT_NOTIFICATIONS,
  CAPABILITIES.RECORD_NOTIFICATION_DELIVERY,
]
const REVIEWER_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
  // Phase 4 — a reviewer reads a notification in order to decide it.
  CAPABILITIES.READ_NOTIFICATIONS,
  CAPABILITIES.REVIEW_NOTIFICATIONS,
  CAPABILITIES.REVIEW_AI_SUGGESTIONS,
  CAPABILITIES.REVIEW_CASE_CLOSURE,
]
const VIEWER_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
]

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
    expect(canAccessPage([CAPABILITIES.READ_CASES], 'cases')).toBe(true)
  })

  // Phase 3 split the case group's reads from its writes. The PAGE gate is the
  // READ capability, because a reviewer must be able to open the case whose
  // closure they are deciding, and read-only oversight is a stated requirement.
  // Holding manage:cases alone no longer grants the page — read:cases does, and
  // every role holds it.
  it('admits REVIEWER and VIEWER to the case pages, on read:cases', () => {
    ;['cases', 'caseDetail'].forEach((page) => {
      expect(canAccessPage(REVIEWER_CAPABILITIES, page)).toBe(true)
      expect(canAccessPage(VIEWER_CAPABILITIES, page)).toBe(true)
      expect(canAccessPage(ANALYST_CAPABILITIES, page)).toBe(true)
    })
  })

  it('still denies VIEWER every mutation-capable page', () => {
    ;['upload', 'notifications', 'organizations', 'settings'].forEach((page) => {
      expect(canAccessPage(VIEWER_CAPABILITIES, page)).toBe(false)
    })
  })

  // Phase 4 — the notification page gate is the READ capability, so both
  // halves of the separation of duties reach the screen while holding disjoint
  // write grants.
  it('lets ANALYST and REVIEWER reach the notification screens, and VIEWER neither', () => {
    ;['notifications', 'notificationDetail'].forEach((page) => {
      expect(canAccessPage(ANALYST_CAPABILITIES, page)).toBe(true)
      expect(canAccessPage(REVIEWER_CAPABILITIES, page)).toBe(true)
      expect(canAccessPage(VIEWER_CAPABILITIES, page)).toBe(false)
    })
  })

  // Reaching the notification screen must never imply being able to act on it.
  it('never gives a notification reader the wrong half of the separation of duties', () => {
    // The analyst writes and exports but cannot approve.
    expect(hasCapability(ANALYST_CAPABILITIES, CAPABILITIES.MANAGE_NOTIFICATIONS)).toBe(true)
    expect(hasCapability(ANALYST_CAPABILITIES, CAPABILITIES.EXPORT_NOTIFICATIONS)).toBe(true)
    expect(hasCapability(ANALYST_CAPABILITIES, CAPABILITIES.REVIEW_NOTIFICATIONS)).toBe(false)

    // The reviewer approves but cannot write, export or record delivery.
    expect(hasCapability(REVIEWER_CAPABILITIES, CAPABILITIES.REVIEW_NOTIFICATIONS)).toBe(true)
    expect(hasCapability(REVIEWER_CAPABILITIES, CAPABILITIES.MANAGE_NOTIFICATIONS)).toBe(false)
    expect(hasCapability(REVIEWER_CAPABILITIES, CAPABILITIES.EXPORT_NOTIFICATIONS)).toBe(false)
    expect(
      hasCapability(REVIEWER_CAPABILITIES, CAPABILITIES.RECORD_NOTIFICATION_DELIVERY),
    ).toBe(false)

    // Nobody below ADMIN may override the self-approval prohibition.
    ;[ANALYST_CAPABILITIES, REVIEWER_CAPABILITIES, VIEWER_CAPABILITIES].forEach((caps) => {
      expect(hasCapability(caps, CAPABILITIES.OVERRIDE_NOTIFICATION_SELF_APPROVAL)).toBe(false)
    })
  })

  // Reaching the case screen must never imply being able to change anything on
  // it. The screen's own controls are gated on these, and the backend re-checks
  // them on every request.
  it('never gives a case reader the case write capabilities', () => {
    ;[VIEWER_CAPABILITIES, REVIEWER_CAPABILITIES].forEach((caps) => {
      expect(hasCapability(caps, CAPABILITIES.MANAGE_CASES)).toBe(false)
      expect(hasCapability(caps, CAPABILITIES.TRIAGE_FINDINGS)).toBe(false)
    })
    expect(hasCapability(REVIEWER_CAPABILITIES, CAPABILITIES.REVIEW_CASE_CLOSURE)).toBe(true)
    expect(hasCapability(VIEWER_CAPABILITIES, CAPABILITIES.REVIEW_CASE_CLOSURE)).toBe(false)
  })

  // The analyst who requests a closure can never approve one. Not their own,
  // and not anybody else's — they simply hold no closure-review capability.
  it('denies ANALYST the closure-review capabilities entirely', () => {
    expect(hasCapability(ANALYST_CAPABILITIES, CAPABILITIES.REVIEW_CASE_CLOSURE)).toBe(false)
    expect(hasCapability(ANALYST_CAPABILITIES, CAPABILITIES.OVERRIDE_CLOSURE_SELF_APPROVAL)).toBe(
      false,
    )
  })

  it('withholds the self-approval override from every non-ADMIN role', () => {
    ;[ANALYST_CAPABILITIES, REVIEWER_CAPABILITIES, VIEWER_CAPABILITIES].forEach((caps) => {
      expect(hasCapability(caps, CAPABILITIES.OVERRIDE_CLOSURE_SELF_APPROVAL)).toBe(false)
    })
  })
})
