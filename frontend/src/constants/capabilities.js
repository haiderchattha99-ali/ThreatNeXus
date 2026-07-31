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
}

export const CAPABILITY_VALUES = Object.values(CAPABILITIES)
