// Mirrors backend/src/lib/roles.js CAPABILITIES verbatim. This list is UX
// metadata only — the backend's requireCapability/requireRole middleware is
// the sole authorization boundary. permissions.test.js asserts every value
// here is one the backend actually grants, so the two cannot silently drift.
export const CAPABILITIES = {
  READ_DASHBOARD: 'read:dashboard',
  READ_FINDINGS: 'read:findings',
  INGEST_REPORTS: 'ingest:reports',
  TRIAGE_FINDINGS: 'triage:findings',
  MANAGE_CASES: 'manage:cases',
  REVIEW_NOTIFICATIONS: 'review:notifications',
  REVIEW_AI_SUGGESTIONS: 'review:ai-suggestions',
  MANAGE_USERS: 'manage:users',
  MANAGE_SYSTEM: 'manage:system',
  DELETE_RECORDS: 'delete:records',
  MANAGE_OWNERSHIP_MAPPINGS: 'manage:ownership-mappings',
  OVERRIDE_FINDING_OWNERSHIP: 'override:finding-ownership',
  TRIGGER_FINDING_ENRICHMENT: 'trigger:finding-enrichment',
  EXECUTE_ENRICHMENT_BATCH: 'execute:enrichment-batch',
  RECALCULATE_FINDING_RISK: 'recalculate:finding-risk',
  MANAGE_FINDING_VULNERABILITIES: 'manage:finding-vulnerabilities',
  TRIGGER_VULNERABILITY_ENRICHMENT: 'trigger:vulnerability-enrichment',
  EXECUTE_VULNERABILITY_ENRICHMENT_BATCH: 'execute:vulnerability-enrichment-batch',
  // Phase 3 — defensible analyst workflow.
  // READ_CASES is a read-only grant held by EVERY role: a reviewer must be able
  // to read a case in order to decide its closure, and read-only oversight is a
  // stated Phase 3 requirement. REVIEW_CASE_CLOSURE is held by REVIEWER and
  // ADMIN only, which is what makes it impossible for the role that requests a
  // closure (ANALYST) to also grant one.
  READ_CASES: 'read:cases',
  REVIEW_CASE_CLOSURE: 'review:case-closure',
  OVERRIDE_CLOSURE_SELF_APPROVAL: 'override:closure-self-approval',
  // Phase 4 — notification drafting, review, manual export, delivery tracking.
  //
  // READ_NOTIFICATIONS is held by ADMIN, ANALYST and REVIEWER, and deliberately
  // NOT by VIEWER: the approved pre-Phase-4 read policy excluded VIEWER (the
  // whole router required review:notifications) and Phase 4 widens it only as
  // far as the workflow requires — to the role that does the drafting.
  //
  // MANAGE/EXPORT/RECORD_DELIVERY are held by ADMIN and ANALYST;
  // REVIEW_NOTIFICATIONS by ADMIN and REVIEWER. The two sets never overlap
  // below ADMIN, which is what makes it impossible for the role that writes a
  // notification to also approve one.
  READ_NOTIFICATIONS: 'read:notifications',
  MANAGE_NOTIFICATIONS: 'manage:notifications',
  EXPORT_NOTIFICATIONS: 'export:notifications',
  RECORD_NOTIFICATION_DELIVERY: 'record:notification-delivery',
  OVERRIDE_NOTIFICATION_SELF_APPROVAL: 'override:notification-self-approval',
  // Phase 5 — framework mapping and optional AI mapping assistance.
  //
  // There is deliberately NO read:framework-mappings. Reading which controls an
  // analyst associated with a case IS reading the case, so both mapping read
  // routes reuse READ_CASES — held by all four roles, which is why VIEWER and
  // REVIEWER both see active mappings and full history.
  //
  // MANAGE_FRAMEWORK_MAPPINGS and DECIDE_AI_MAPPING_SUGGESTIONS are held by the
  // SAME roles (ADMIN, ANALYST) on purpose: approving a suggestion creates a
  // mapping, so approval authority must never exceed the authority to write the
  // same mapping by hand.
  //
  // READ_AI_MAPPING_SUGGESTIONS is held by ADMIN, ANALYST and REVIEWER but NOT
  // VIEWER — an undecided machine proposal is not oversight material. VIEWER
  // still sees every ACTIVE mapping, including ones whose source is
  // AI_SUGGESTION_PROMOTED.
  MANAGE_FRAMEWORK_MAPPINGS: 'manage:framework-mappings',
  READ_AI_MAPPING_SUGGESTIONS: 'read:ai-mapping-suggestions',
  REQUEST_AI_MAPPING_SUGGESTIONS: 'request:ai-mapping-suggestions',
  DECIDE_AI_MAPPING_SUGGESTIONS: 'decide:ai-mapping-suggestions',
}

export const CAPABILITY_VALUES = Object.values(CAPABILITIES)
