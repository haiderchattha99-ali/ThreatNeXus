"use strict";

const ROLE_VALUES = Object.freeze(["ADMIN", "ANALYST", "REVIEWER", "VIEWER"]);

const DEFAULT_ROLE = "VIEWER";

// Legacy role strings that predate the Role enum. Anything not listed here —
// including null, undefined, non-strings and typos — falls back to
// DEFAULT_ROLE. The fallback is always the least-privileged role, never ADMIN.
const LEGACY_ROLE_ALIASES = Object.freeze({
  USER: "VIEWER",
  MEMBER: "VIEWER",
  BASIC: "VIEWER",
  UNKNOWN: "VIEWER",
});

// Phase 0 capability set. Authorization is expressed in terms of these rather
// than a role ranking, so no role can accidentally inherit another's authority.
const CAPABILITIES = Object.freeze({
  READ_DASHBOARD: "read:dashboard",
  READ_FINDINGS: "read:findings",
  INGEST_REPORTS: "ingest:reports",
  TRIAGE_FINDINGS: "triage:findings",
  MANAGE_CASES: "manage:cases",
  REVIEW_NOTIFICATIONS: "review:notifications",
  REVIEW_AI_SUGGESTIONS: "review:ai-suggestions",
  MANAGE_USERS: "manage:users",
  MANAGE_SYSTEM: "manage:system",
  DELETE_RECORDS: "delete:records",

  // Phase 2 (P2-T1) — ownership mapping. Additive, non-hierarchical: neither
  // grant is implied by an existing capability, matching this file's
  // explicit-grants-per-role convention.
  MANAGE_OWNERSHIP_MAPPINGS: "manage:ownership-mappings",
  OVERRIDE_FINDING_OWNERSHIP: "override:finding-ownership",

  // Phase 2 (P2-T2e-2) — IOC enrichment. Additive, non-hierarchical, same
  // convention as above. TRIGGER_FINDING_ENRICHMENT lets an analyst ask for a
  // fresh/forced lookup on one Finding; EXECUTE_ENRICHMENT_BATCH lets an admin
  // run the bounded worker against the durable queue. Enrichment reads reuse
  // READ_FINDINGS rather than a new capability — this table decides only
  // which roles may cause work or provider spend, not which may see results.
  TRIGGER_FINDING_ENRICHMENT: "trigger:finding-enrichment",
  EXECUTE_ENRICHMENT_BATCH: "execute:enrichment-batch",

  // Phase 2 (P2-T3) — deterministic risk scoring. Additive, non-hierarchical,
  // same convention. Reading a risk score reuses READ_FINDINGS (a score is
  // part of understanding a finding); only *causing* a recalculation needs
  // this grant. Nothing here lets a caller influence the formula — weights
  // are code constants and no endpoint accepts a weight, score or band.
  RECALCULATE_FINDING_RISK: "recalculate:finding-risk",

  // Phase 2 (§2B, Packet B) — vulnerability association/enrichment HTTP
  // surface. Additive, non-hierarchical, same convention as every other
  // grant in this table. Reads reuse READ_FINDINGS — this table decides only
  // which roles may assert/retract a CVE association, trigger a manual
  // enrichment lookup, or run the administrator batch worker, never which
  // roles may see the result.
  MANAGE_FINDING_VULNERABILITIES: "manage:finding-vulnerabilities",
  TRIGGER_VULNERABILITY_ENRICHMENT: "trigger:vulnerability-enrichment",
  EXECUTE_VULNERABILITY_ENRICHMENT_BATCH: "execute:vulnerability-enrichment-batch",

  // Phase 3 — defensible analyst workflow. Three additive, non-hierarchical
  // grants, same convention as every other capability in this table.
  //
  // READ_CASES exists because Phase 3 is the first time REVIEWER and VIEWER
  // legitimately need to SEE a case: a reviewer cannot approve a closure they
  // may not read, and read-only oversight is a stated Phase 3 requirement.
  // Before this, the whole /api/cases router sat behind MANAGE_CASES, which
  // gated reads and writes together. Splitting them is what lets REVIEWER read
  // and decide closures while still being unable to triage, link evidence,
  // record responses or perform any ordinary case mutation.
  READ_CASES: "read:cases",

  // The reviewer half of the separation of duties. Held by REVIEWER and ADMIN
  // only — deliberately NOT by ANALYST, which is what makes it impossible for
  // the role that requests closures to also grant them.
  REVIEW_CASE_CLOSURE: "review:case-closure",

  // Administrator-only escape hatch for the self-approval prohibition. A
  // dedicated capability rather than a role-name comparison, so the closure
  // service can enforce "the requester may not approve their own request
  // unless they are an administrator" without ever knowing what a role is —
  // see caseClosureService.assertNotSelfApproval.
  OVERRIDE_CLOSURE_SELF_APPROVAL: "override:closure-self-approval",

  // Phase 4 — notification drafting, review, manual export, delivery tracking.
  // Four additive, non-hierarchical grants plus the existing
  // REVIEW_NOTIFICATIONS, splitting read / write / review / export cleanly.
  //
  // READ_NOTIFICATIONS exists because Phase 4 is the first time ANALYST
  // legitimately needs to SEE a notification: an analyst who drafts, edits,
  // submits and exports one cannot do any of it through a surface they may not
  // read. Before this, the whole /api/notifications router sat behind
  // REVIEW_NOTIFICATIONS, which gated reads and writes together and therefore
  // denied ANALYST any access at all.
  //
  // It is deliberately NOT granted to VIEWER. The approved pre-Phase-4
  // notification-read policy excluded VIEWER (the router required
  // review:notifications, held only by REVIEWER and ADMIN), and Phase 4 widens
  // that policy only as far as the workflow actually requires — to the role
  // that does the drafting. A notification is constituent-addressed
  // correspondence carrying a recipient binding; read-only oversight of it was
  // never granted and is not granted here.
  READ_NOTIFICATIONS: "read:notifications",

  // The analyst half of the separation of duties: create a draft, edit a
  // revision, submit it for review. Held by ADMIN and ANALYST only —
  // deliberately NOT by REVIEWER, which is what makes it impossible for the
  // role that approves content to also author it.
  MANAGE_NOTIFICATIONS: "manage:notifications",

  // Producing the outbound artifact. Held by ADMIN and ANALYST, never by
  // REVIEWER: a reviewer decides whether something may leave, and does not
  // also perform the act of taking it out.
  EXPORT_NOTIFICATIONS: "export:notifications",

  // Recording what a human observed after sending the exported artifact by
  // hand. Same holders as export for the same reason — the person who sent it
  // is the only one who can honestly report what happened to it.
  RECORD_NOTIFICATION_DELIVERY: "record:notification-delivery",

  // Administrator-only escape hatch for the notification self-approval
  // prohibition, exactly parallel to OVERRIDE_CLOSURE_SELF_APPROVAL. A
  // dedicated capability rather than a role-name comparison, so the review
  // service can enforce "the author or submitter may not approve their own
  // revision unless they are an administrator" without ever knowing what a
  // role is — see notificationReviewService.assertNotSelfApproval.
  OVERRIDE_NOTIFICATION_SELF_APPROVAL: "override:notification-self-approval",

  // Phase 5 — framework mapping and guarded AI mapping assistance. Four
  // additive, non-hierarchical grants, same convention as every capability
  // above.
  //
  // There is deliberately NO new read capability for mappings. Reading which
  // controls an analyst associated with a case IS reading the case, so both
  // mapping read routes reuse READ_CASES — held by all four roles, exactly the
  // policy Phase 3 already approved for case context. Minting a parallel
  // read:framework-mappings granted to the same four roles would be capability
  // sprawl with no policy difference behind it. (Compare READ_NOTIFICATIONS,
  // which DID need to exist, because the notification read policy genuinely
  // differs by role.)
  //
  // Creating, removing and reactivating a mapping. ADMIN and ANALYST only —
  // this is the phase's core analyst act. REVIEWER and VIEWER hold it nowhere,
  // so neither can mutate a mapping through any route.
  MANAGE_FRAMEWORK_MAPPINGS: "manage:framework-mappings",

  // Reading AI suggestions and their decision history. ADMIN, ANALYST and
  // REVIEWER — deliberately NOT VIEWER.
  //
  // A suggestion is unreviewed machine output. VIEWER is a read-only oversight
  // role, and read-only oversight of what a model proposed but no human
  // accepted is not oversight of anything the organization did. VIEWER still
  // sees every ACTIVE mapping, including ones whose `source` is
  // AI_SUGGESTION_PROMOTED — which is the safe, approved, human-decided display
  // fact — and sees no prompt, snapshot, confidence or pending proposal.
  READ_AI_MAPPING_SUGGESTIONS: "read:ai-mapping-suggestions",

  // Causing a generation run (and therefore, once a live provider exists,
  // causing provider spend). ADMIN and ANALYST, mirroring how
  // TRIGGER_FINDING_ENRICHMENT gates the enrichment equivalent.
  REQUEST_AI_MAPPING_SUGGESTIONS: "request:ai-mapping-suggestions",

  // Approving or rejecting a suggestion. ADMIN and ANALYST — the SAME holders
  // as MANAGE_FRAMEWORK_MAPPINGS, and that identity is the point.
  //
  // Approving a suggestion creates a mapping. Anyone who may approve one must
  // therefore already be permitted to create the same mapping by hand, or the
  // AI path would be a way to obtain an authority the manual path denies. This
  // is why the pre-existing REVIEW_AI_SUGGESTIONS grant (REVIEWER + ADMIN,
  // declared in Phase 0 and never wired to a route) is NOT used here: it was
  // drafted on a review-of-somebody-else's-work model, and under it a REVIEWER
  // holding no mapping authority at all could have promoted machine output into
  // an active mapping. REVIEW_AI_SUGGESTIONS is left in place, still granted,
  // and still unused by any route.
  DECIDE_AI_MAPPING_SUGGESTIONS: "decide:ai-mapping-suggestions",
});

const CAPABILITY_VALUES = Object.freeze(Object.values(CAPABILITIES));

// Held by every role, VIEWER included. READ_CASES joins this set in Phase 3:
// safe, serializer-filtered read-only access to cases and triage is an
// explicit Phase 3 requirement for VIEWER, and the case read paths expose no
// organization contact detail, no audit row and no internal key (see
// services/workflow/caseWorkflowSerializers.js).
const READ_ONLY_CAPABILITIES = [
  CAPABILITIES.READ_DASHBOARD,
  CAPABILITIES.READ_FINDINGS,
  CAPABILITIES.READ_CASES,
];

// Explicit grants per role — deliberately NOT a hierarchy. ANALYST does the
// work (ingest, triage, cases) and REVIEWER approves it (notifications, AI
// suggestions); neither inherits the other, which keeps separation of duties
// intact for the approval-before-export rule. Only ADMIN holds the
// user/system/delete capabilities.
const ROLE_CAPABILITIES = Object.freeze({
  VIEWER: Object.freeze([...READ_ONLY_CAPABILITIES]),
  REVIEWER: Object.freeze([
    ...READ_ONLY_CAPABILITIES,
    CAPABILITIES.REVIEW_NOTIFICATIONS,
    CAPABILITIES.REVIEW_AI_SUGGESTIONS,
    // Phase 4 — a reviewer may read a notification and its evidence in order
    // to decide it, and may approve or reject. They deliberately hold neither
    // MANAGE_NOTIFICATIONS, EXPORT_NOTIFICATIONS nor
    // RECORD_NOTIFICATION_DELIVERY, so they cannot draft, edit, submit,
    // export, record a delivery or record an organization response. Their only
    // writes in this phase are the review decision itself.
    CAPABILITIES.READ_NOTIFICATIONS,
    // Phase 3 — a reviewer may approve or reject a closure request and read
    // the case to decide. They deliberately hold neither TRIAGE_FINDINGS nor
    // MANAGE_CASES, so they cannot triage a Finding, link or unlink evidence,
    // record an organization response, change OPEN/WAITING_FOR_ORG, request a
    // closure, or reopen a case. Their only write in this phase is the review
    // decision itself.
    CAPABILITIES.REVIEW_CASE_CLOSURE,
    // Phase 5 — a reviewer may READ the AI suggestion history for a case they
    // can already read, because deciding a closure means understanding what was
    // proposed and what was refused. They hold neither
    // MANAGE_FRAMEWORK_MAPPINGS, REQUEST_AI_MAPPING_SUGGESTIONS nor
    // DECIDE_AI_MAPPING_SUGGESTIONS, so they cannot create, remove or
    // reactivate a mapping, cannot cause a generation run, and cannot approve
    // or reject a suggestion. Phase 5 adds no write of any kind to REVIEWER.
    CAPABILITIES.READ_AI_MAPPING_SUGGESTIONS,
  ]),
  ANALYST: Object.freeze([
    ...READ_ONLY_CAPABILITIES,
    CAPABILITIES.INGEST_REPORTS,
    // Phase 3 reuses these two existing grants rather than inventing parallel
    // ones: TRIAGE_FINDINGS gates the triage write path, MANAGE_CASES gates
    // case creation, evidence linking/unlinking, OPEN <-> WAITING_FOR_ORG
    // transitions, organization responses, closure REQUESTS and manual reopen.
    // ANALYST is deliberately NOT granted REVIEW_CASE_CLOSURE or
    // OVERRIDE_CLOSURE_SELF_APPROVAL, which is what makes it structurally
    // impossible for the role that requests a closure to also approve one —
    // their own or anybody else's.
    CAPABILITIES.TRIAGE_FINDINGS,
    CAPABILITIES.MANAGE_CASES,
    // P2-T1 — an analyst may correct ownership on a Finding they triage, but
    // may not touch the AssetMapping registry itself (that stays ADMIN-only
    // below, via CAPABILITY_VALUES).
    CAPABILITIES.OVERRIDE_FINDING_OWNERSHIP,
    // P2-T2e-2 — an analyst may request/force re-enrichment on a Finding they
    // triage, but may not run the administrator bounded-batch worker (that
    // stays ADMIN-only below, via CAPABILITY_VALUES).
    CAPABILITIES.TRIGGER_FINDING_ENRICHMENT,
    // P2-T3 — an analyst may recalculate risk on a Finding they triage.
    // REVIEWER and VIEWER may read scores but never cause a recalculation.
    CAPABILITIES.RECALCULATE_FINDING_RISK,
    // §2B Packet B — an analyst may assert/retract a CVE association and
    // request manual enrichment, but may not run the administrator bounded
    // batch worker (that stays ADMIN-only below, via CAPABILITY_VALUES).
    CAPABILITIES.MANAGE_FINDING_VULNERABILITIES,
    CAPABILITIES.TRIGGER_VULNERABILITY_ENRICHMENT,
    // Phase 4 — an analyst drafts, edits and submits a notification, exports
    // an APPROVED one, and records what happened to it afterwards. ANALYST is
    // deliberately NOT granted REVIEW_NOTIFICATIONS or
    // OVERRIDE_NOTIFICATION_SELF_APPROVAL, which is what makes it structurally
    // impossible for the role that writes a notification to also approve one —
    // their own or anybody else's. Recording an organization response from the
    // notification screen reuses MANAGE_CASES (granted above), because it is
    // the same act, on the same table, as recording one from the case screen.
    CAPABILITIES.READ_NOTIFICATIONS,
    CAPABILITIES.MANAGE_NOTIFICATIONS,
    CAPABILITIES.EXPORT_NOTIFICATIONS,
    CAPABILITIES.RECORD_NOTIFICATION_DELIVERY,
    // Phase 5 — an analyst associates frameworks with the cases they work,
    // asks the (optional, off-by-default) assistant for candidates, and decides
    // each one. MANAGE_FRAMEWORK_MAPPINGS and DECIDE_AI_MAPPING_SUGGESTIONS are
    // granted TOGETHER on purpose: approving a suggestion creates a mapping, so
    // the authority to approve must never exceed the authority to write the
    // same mapping by hand.
    CAPABILITIES.MANAGE_FRAMEWORK_MAPPINGS,
    CAPABILITIES.READ_AI_MAPPING_SUGGESTIONS,
    CAPABILITIES.REQUEST_AI_MAPPING_SUGGESTIONS,
    CAPABILITIES.DECIDE_AI_MAPPING_SUGGESTIONS,
  ]),
  ADMIN: Object.freeze([...CAPABILITY_VALUES]),
});

function isValidRole(role) {
  return typeof role === "string" && ROLE_VALUES.includes(role);
}

function isValidCapability(capability) {
  return (
    typeof capability === "string" && CAPABILITY_VALUES.includes(capability)
  );
}

// Fails safe rather than throwing: callers normalizing untrusted input (legacy
// JWT payloads, request bodies) get VIEWER instead of an error or elevation.
function normalizeRole(role) {
  if (typeof role !== "string") return DEFAULT_ROLE;

  const candidate = role.trim().toUpperCase();
  if (candidate === "") return DEFAULT_ROLE;

  if (ROLE_VALUES.includes(candidate)) return candidate;
  if (Object.prototype.hasOwnProperty.call(LEGACY_ROLE_ALIASES, candidate)) {
    return LEGACY_ROLE_ALIASES[candidate];
  }

  return DEFAULT_ROLE;
}

// Authorization resolution is deliberately STRICTER than normalizeRole.
// normalizeRole answers "what role should we store/display?" and falls back to
// VIEWER, which is right for persistence but wrong for access control: an
// unrecognised role such as "superuser" would silently acquire VIEWER's read
// capabilities. Here anything not explicitly recognised resolves to null and
// therefore holds no capability at all — unknown roles fail closed.
// Known legacy spellings ("analyst", "  Admin  ") still resolve, so JWTs
// issued before the Role enum keep working.
function resolveAuthorizationRole(role) {
  if (typeof role !== "string") return null;

  const candidate = role.trim().toUpperCase();
  if (candidate === "") return null;

  if (ROLE_VALUES.includes(candidate)) return candidate;
  if (Object.prototype.hasOwnProperty.call(LEGACY_ROLE_ALIASES, candidate)) {
    return LEGACY_ROLE_ALIASES[candidate];
  }

  return null;
}

// Configuration guards. These throw because a bad required role/capability is
// a programming error in route setup, not untrusted runtime input — it must
// surface at boot rather than silently guarding nothing.
function assertValidRequiredRole(role) {
  if (!isValidRole(role)) {
    throw new Error(
      `roles: invalid required role (expected one of ${ROLE_VALUES.join(", ")})`
    );
  }
  return role;
}

function assertValidCapability(capability) {
  if (!isValidCapability(capability)) {
    throw new Error(
      `roles: invalid capability (expected one of ${CAPABILITY_VALUES.join(", ")})`
    );
  }
  return capability;
}

function assertNonEmptyList(list, label) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`roles: ${label} must be a non-empty array`);
  }
  return list;
}

// Exact match, never a ranking: requireRole("ANALYST") does not admit ADMIN.
// Use requireAnyRole([...]) or a capability when several roles should pass.
function hasRole(userRole, requiredRole) {
  assertValidRequiredRole(requiredRole);
  return resolveAuthorizationRole(userRole) === requiredRole;
}

function hasAnyRole(userRole, requiredRoles) {
  assertNonEmptyList(requiredRoles, "requiredRoles");
  requiredRoles.forEach(assertValidRequiredRole);

  const resolved = resolveAuthorizationRole(userRole);
  if (resolved === null) return false;
  return requiredRoles.includes(resolved);
}

function hasCapability(userRole, capability) {
  assertValidCapability(capability);

  const resolved = resolveAuthorizationRole(userRole);
  if (resolved === null) return false;

  const granted = ROLE_CAPABILITIES[resolved];
  return Array.isArray(granted) && granted.includes(capability);
}

function hasAnyCapability(userRole, capabilities) {
  assertNonEmptyList(capabilities, "capabilities");
  capabilities.forEach(assertValidCapability);
  return capabilities.some((capability) => hasCapability(userRole, capability));
}

module.exports = {
  ROLE_VALUES,
  DEFAULT_ROLE,
  CAPABILITIES,
  CAPABILITY_VALUES,
  ROLE_CAPABILITIES,
  isValidRole,
  isValidCapability,
  normalizeRole,
  resolveAuthorizationRole,
  assertValidRequiredRole,
  assertValidCapability,
  hasRole,
  hasAnyRole,
  hasCapability,
  hasAnyCapability,
};
