import { CAPABILITIES } from '../constants/capabilities'

// Maps each navigable page/route to the single backend capability required to
// view it — mirroring backend/src/lib/roles.js's ROLE_CAPABILITIES grants and
// each route's own requireCapability middleware (see backend/src/routes/*).
// This is a UX convenience only, NOT an authorization boundary: the backend
// enforces its own guard on every route independently of anything here, and
// still refuses a request whether or not the frontend ever renders a link to
// it. permissions.test.js keeps this table honest against roles.js drift.
//
// `null` marks a page as authenticated-only — no additional capability is
// required beyond being logged in. Used sparingly, only for genuinely
// role-agnostic personal pages (Profile) that have no backend capability
// route of their own.
export const PAGE_CAPABILITIES = {
  dashboard: CAPABILITIES.READ_DASHBOARD,
  threats: CAPABILITIES.READ_FINDINGS,
  analytics: CAPABILITIES.READ_FINDINGS,
  upload: CAPABILITIES.INGEST_REPORTS,
  // Phase 3 split the case group's reads from its writes. The PAGE capability
  // is the READ one, because REVIEWER (who must read a case to decide its
  // closure) and VIEWER (read-only oversight) both need to reach the screen.
  // Every mutation control inside the screen is gated separately on
  // MANAGE_CASES or REVIEW_CASE_CLOSURE — and the backend re-checks both on
  // every request regardless of what this table says.
  cases: CAPABILITIES.READ_CASES,
  caseDetail: CAPABILITIES.READ_CASES,
  notifications: CAPABILITIES.REVIEW_NOTIFICATIONS,
  organizations: CAPABILITIES.MANAGE_SYSTEM,
  settings: CAPABILITIES.MANAGE_SYSTEM,
  profile: null,
}

// Fails closed: an unrecognized page name or a non-array capability list both
// resolve to false rather than granting access by omission.
export function hasCapability(capabilities, required) {
  if (!Array.isArray(capabilities)) return false
  return capabilities.includes(required)
}

export function canAccessPage(capabilities, page) {
  if (!Object.prototype.hasOwnProperty.call(PAGE_CAPABILITIES, page)) return false

  const required = PAGE_CAPABILITIES[page]
  if (required === null) return true

  return hasCapability(capabilities, required)
}
