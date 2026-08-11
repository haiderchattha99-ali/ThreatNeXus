import axios from 'axios'

// Falls back to the local backend's mounted API prefix only when
// VITE_API_BASE_URL is not set (e.g. no .env in local development). The
// backend mounts every route under /api (see backend/src/app.js), so the
// default must include it too, not just the bare host.
const DEFAULT_API_BASE_URL = 'http://localhost:5000/api'

function resolveApiBaseUrl() {
  const configured = import.meta.env.VITE_API_BASE_URL
  const value =
    typeof configured === 'string' && configured.trim() !== ''
      ? configured.trim()
      : DEFAULT_API_BASE_URL

  // Strip trailing slashes so a base URL like ".../api/" doesn't combine with
  // a call site's leading "/" (e.g. apiClient.get('/threats')) into "//threats".
  return value.replace(/\/+$/, '')
}

export const API_BASE_URL = resolveApiBaseUrl()

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Add token to requests
apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
}, (error) => {
  return Promise.reject(error)
})

// Session expiry. A token that the backend rejects mid-session must not leave
// the user staring at silently empty screens: the app clears the session and
// returns to sign-in with an explanation.
//
// Two deliberate exclusions:
//   - /auth/login — a wrong password is a 401 and belongs inline on the form,
//     not as "your session expired".
//   - 403 — that is an authorization refusal, not an expiry. The user is
//     legitimately signed in and must stay signed in; the page renders its
//     denied state instead.
export const SESSION_EXPIRED_EVENT = 'tnx:session-expired'

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status
    const url = error?.config?.url || ''
    if (status === 401 && !url.includes('/auth/login')) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
    }
    return Promise.reject(error)
  }
)

export const authService = {
  login: (email, password) => apiClient.post('/auth/login', { email, password }),
  // Backend session-validation endpoint: confirms a stored token is still
  // valid and returns the server-derived role + capabilities for it. Used on
  // app initialization instead of trusting localStorage blindly.
  getCurrentUser: () => apiClient.get('/profile'),
}

// Phase 6 — the truthful operational overview.
//
// ONE bounded, read-only call. Every figure it returns arrives as
// { value, availability, source, asOf }, and a section the caller may not read
// comes back RESTRICTED rather than absent or zeroed. The frontend does no
// arithmetic on these and invents nothing: if the backend did not compute it,
// the screen shows that it did not.
//
// getStats/getCharts remain for the legacy Threat-table screens that predate
// the Finding lifecycle; nothing in the Phase 6 dashboard uses them.
export const dashboardService = {
  getOverview: () => apiClient.get('/dashboard/overview'),
  getStats: () => apiClient.get('/dashboard/stats'),
  getCharts: () => apiClient.get('/dashboard/charts'),
}

// Phase 6 — Findings as first-class, readable evidence.
//
// Before this, a Finding could only be seen through a case that already cited
// it, which made the triage step unreachable from the UI. Both calls are pure
// reads gated on read:findings; every mutation on a Finding continues to go
// through its own existing capability-guarded route.
export const findingService = {
  // Bounded and paged. Invalid filter values are REJECTED by the backend with
  // the field named, never silently ignored, so callers must not pre-clamp.
  getFindings: (params) => apiClient.get('/findings', { params }),

  // The full evidence view for one Finding: identity, lifecycle projection,
  // current ownership, current risk score with its factor contributions,
  // current IOC enrichment, active CVE associations and case links.
  getFinding: (id) => apiClient.get(`/findings/${id}`),
}

// The canonical, evidence-backed report-ingestion contract.
//
// POST /api/reports/upload is the ONLY route that runs the real pipeline:
// structural parsing, per-row validation, normalized file identity and
// idempotency, immutable RawReport/RawReportRow evidence, Finding
// dedup/persistence/recurrence, ownership resolution, enrichment scheduling,
// risk recalculation and the audit trail. Everything an analyst later sees in
// Findings, in a case, or in the operational overview exists because this
// route created it.
//
// threatService.uploadCSV below posts to the LEGACY /threats/upload route,
// which writes standalone Threat rows and creates no Finding, no RawReport,
// no occurrence history and no ingestion audit event. The analyst ingestion
// screen called it until this ticket, which is why an upload could report
// "Report processed" while producing nothing the Findings workspace could
// show. The legacy route is left mounted and untouched — this contract simply
// no longer routes the analyst workflow through it.
//
// `source`, `reportType` and `schemaVersion` are server-decided in the
// controller and read from no request field. Nothing is sent here beyond the
// file itself, so the browser cannot claim a provider, report type or schema
// version it was not given.
export const reportIngestionService = {
  uploadReport: (file) => {
    const formData = new FormData()
    formData.append('file', file)
    return apiClient.post('/reports/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    })
  },
}

export const threatService = {
  getThreats: (params) => apiClient.get('/threats', { params }),
  searchThreats: (query) => apiClient.get('/threats/search', { params: { q: query } }),
  updateThreatStatus: (id, status) => apiClient.patch(`/threats/${id}/status`, { status }),
  deleteThreat: (id) => apiClient.delete(`/threats/${id}`),
  uploadCSV: (file) => {
    const formData = new FormData()
    formData.append('file', file)
    return apiClient.post('/threats/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    })
  },
  
}
export const caseService = {
  getCases: () => apiClient.get('/cases'),

  getCase: (id) => apiClient.get(`/cases/${id}`),

  createCase: (data) => apiClient.post('/cases', data),

  updateCase: (id, data) => apiClient.put(`/cases/${id}`, data),
}

// Phase 3 — the defensible analyst workflow.
//
// Every mutation below returns the FULL refreshed workflow view for the case
// (the backend re-reads and re-serializes after each write), so a caller never
// has to reconcile a local guess against the server's state — it just replaces
// what it is holding. That is why none of these takes an optimistic-update
// callback.
//
// There is deliberately no deleteCase here. Cases are permanent records; the
// backend answers 409 on DELETE and removes nothing. A case that should no
// longer be worked is CLOSED through the review workflow.
export const caseWorkflowService = {
  getWorkflow: (id) => apiClient.get(`/cases/${id}/workflow`),

  linkFinding: (id, findingId, reason) =>
    apiClient.post(`/cases/${id}/findings`, reason ? { findingId, reason } : { findingId }),

  unlinkFinding: (id, findingId, reason) =>
    apiClient.post(`/cases/${id}/findings/${findingId}/unlink`, { reason }),

  changeState: (id, toState, note) =>
    apiClient.post(`/cases/${id}/state`, note ? { toState, note } : { toState }),

  recordResponse: (id, data) => apiClient.post(`/cases/${id}/responses`, data),

  requestClosure: (id, data) => apiClient.post(`/cases/${id}/closure-requests`, data),

  approveClosure: (id, requestId, reviewNote) =>
    apiClient.post(
      `/cases/${id}/closure-requests/${requestId}/approve`,
      reviewNote ? { reviewNote } : {},
    ),

  rejectClosure: (id, requestId, reviewNote) =>
    apiClient.post(`/cases/${id}/closure-requests/${requestId}/reject`, { reviewNote }),

  reopenCase: (id, reason) => apiClient.post(`/cases/${id}/reopen`, { reason }),
}

// Phase 5 — framework mapping and optional AI mapping assistance.
//
// There is deliberately no deleteMapping. A mapping's history is the record of
// what a named analyst associated with a case and when they withdrew it; the
// backend has no hard-delete route and withdrawal is an appended REMOVED row.
//
// There is also no "reactivate" call: re-adding a previously removed mapping is
// simply createMapping with the same framework, scope and reference, and the
// backend reports the outcome as REACTIVATED. One call site means the ATT&CK
// evidence rule and the organization binding cannot drift between two paths.
export const frameworkMappingService = {
  listMappings: (caseId) => apiClient.get(`/cases/${caseId}/framework-mappings`),

  getHistory: (caseId, params) =>
    apiClient.get(`/cases/${caseId}/framework-mappings/history`, { params }),

  // The body carries CONTENT only. actor, source, state, effectiveAt and every
  // internal key are server-decided; the backend rejects them by name rather
  // than dropping them, so sending one is a 400 and never a silent no-op.
  createMapping: (caseId, data) => apiClient.post(`/cases/${caseId}/framework-mappings`, data),

  removeMapping: (caseId, mappingId, reason) =>
    apiClient.post(`/cases/${caseId}/framework-mappings/${mappingId}/remove`, { reason }),

  // Phase 6.3 — the explicit "no reference in this framework applies to this
  // case" determination. A first-class recordable outcome, NOT the absence of a
  // mapping: the point is that "we looked and nothing applies" stops being
  // indistinguishable from "nobody has looked yet".
  listNoApplicable: (caseId) =>
    apiClient.get(`/cases/${caseId}/framework-mappings/no-applicable`),

  assertNoApplicable: (caseId, framework, rationale) =>
    apiClient.post(`/cases/${caseId}/framework-mappings/no-applicable`, { framework, rationale }),

  withdrawNoApplicable: (caseId, assertionId, reason) =>
    apiClient.post(`/cases/${caseId}/framework-mappings/no-applicable/${assertionId}/withdraw`, {
      reason,
    }),
}

// Phase 6.3 — the pinned MITRE ATT&CK catalogue and the navigator read model.
//
// Both are reads behind read:cases. Neither can be written over HTTP: the
// catalogue changes only when a human re-runs the build script and commits the
// result, and the navigator changes only as a consequence of mappings written
// through the case-scoped routes above.
export const attackService = {
  // Mappable techniques only by default — the picker must not offer a technique
  // the server will refuse. `retiredExcluded` reports how many were omitted, so
  // the omission is visible rather than silent.
  getCatalogue: (params) => apiClient.get('/attack/catalogue', { params }),

  // Raw counts only. There is no coverage percentage in this response, and no
  // denominator anywhere behind it.
  getNavigator: (params) => apiClient.get('/attack/navigator', { params }),
}

// AI assistance is OPTIONAL and disabled by default. Every call below is safe
// to make with AI off: the config endpoint reports the disabled state, and a
// suggestion request answers 200 with a recorded DISABLED run rather than an
// error. No screen needs to guess whether the feature exists.
export const aiMappingService = {
  getConfig: () => apiClient.get('/ai/config'),

  listSuggestions: (caseId, params) =>
    apiClient.get(`/cases/${caseId}/ai/mapping-suggestions`, { params }),

  requestSuggestions: (caseId, requestContext) =>
    apiClient.post(
      `/cases/${caseId}/ai/mapping-suggestions`,
      requestContext ? { requestContext } : {},
    ),

  approveSuggestion: (caseId, suggestionId, reason) =>
    apiClient.post(
      `/cases/${caseId}/ai/mapping-suggestions/${suggestionId}/approve`,
      reason ? { reason } : {},
    ),

  rejectSuggestion: (caseId, suggestionId, reason) =>
    apiClient.post(`/cases/${caseId}/ai/mapping-suggestions/${suggestionId}/reject`, { reason }),
}

// Phase 8C — Finding-level AI assistance (summary/explanation drafts).
//
// Shares aiMappingService.getConfig() rather than duplicating it: the backend
// exposes ONE AI_ENABLED/AI_PROVIDER switch for both suggestion domains, so
// the same /ai/config response (aiEnabled, assistanceAvailable, providerName,
// reasonCode) is accurate for this feature too. There is no separate config
// endpoint to call.
//
// Optional (never required to start the app, and disabled by default): every
// call below is safe with AI off. requestSuggestion answers 200 with a
// recorded DRAFT/AI_DISABLED row rather than an error.
export const aiFindingAssistService = {
  listSuggestions: (findingId) => apiClient.get(`/findings/${findingId}/ai-suggestions`),

  requestSuggestion: (findingId, suggestionType, requestContext) =>
    apiClient.post(`/findings/${findingId}/ai-suggestions`, {
      suggestionType,
      ...(requestContext ? { requestContext } : {}),
    }),

  acceptSuggestion: (findingId, suggestionId, reason) =>
    apiClient.post(
      `/findings/${findingId}/ai-suggestions/${suggestionId}/accept`,
      reason ? { reason } : {},
    ),

  rejectSuggestion: (findingId, suggestionId, reason) =>
    apiClient.post(`/findings/${findingId}/ai-suggestions/${suggestionId}/reject`, { reason }),
}

export const findingTriageService = {
  getTriage: (findingId) => apiClient.get(`/findings/${findingId}/triage`),

  // Only `decision` and `reason` are accepted. The backend REJECTS any other
  // key rather than dropping it, so this must never widen.
  updateTriage: (findingId, decision, reason) =>
    apiClient.put(`/findings/${findingId}/triage`, reason ? { decision, reason } : { decision }),
}
// Phase 4 — the notification workflow.
//
// Every mutation below returns the FULL refreshed notification detail (the
// backend re-reads and re-serializes after each write), so a caller never has
// to reconcile a local guess against the server's state — it just replaces
// what it is holding. Same contract as caseWorkflowService above.
//
// There is deliberately no deleteNotification. A notification's approval
// trail, export history and delivery claims are evidence that a constituent
// was contacted; the backend answers 409 on DELETE and removes nothing.
export const notificationService = {
  // Bounded and paged. `state` and `caseId` are optional filters; an invalid
  // value is REJECTED by the backend with the field named, never silently
  // ignored, so callers must not pre-clamp.
  getNotifications: (params) => apiClient.get("/notifications", { params }),

  getNotification: (id) => apiClient.get(`/notifications/${id}`),

  getHistory: (id) => apiClient.get(`/notifications/${id}/history`),

  // Drafts from a case. The backend builds the content from that case's
  // persisted evidence — no content crosses the wire here.
  createDraft: (caseId) => apiClient.post("/notifications", { caseId }),

  // Only the six content fields are accepted. The backend REJECTS any other
  // key rather than dropping it, so this must never widen to lifecycleState,
  // approvedByUserId, contentChecksum or revisionNumber.
  editRevision: (id, content) => apiClient.put(`/notifications/${id}`, content),

  submitForReview: (id) => apiClient.post(`/notifications/${id}/submit`, {}),

  approve: (id, reviewNote) =>
    apiClient.post(`/notifications/${id}/approve`, reviewNote ? { reviewNote } : {}),

  reject: (id, reason) => apiClient.post(`/notifications/${id}/reject`, { reason }),

  // Downloads the artifact as a blob. `responseType: 'blob'` matters: the
  // response is an RFC 5322 message, not JSON, and letting axios parse it as
  // text would corrupt the bytes whose checksum the backend recorded.
  exportNotification: (id, format) =>
    apiClient.get(`/notifications/${id}/export`, {
      params: format ? { format } : undefined,
      responseType: "blob",
    }),

  // occurredAt is REQUIRED and always analyst-supplied — the backend refuses
  // to default it, because a delivery timeline the server timestamps for you
  // is a fabricated timeline.
  recordDelivery: (id, data) => apiClient.post(`/notifications/${id}/deliveries`, data),

  // Records an organization response through the SHARED Phase 3 service. One
  // CaseOrganizationResponse row is written, on the notification's case, and
  // the case timeline shows the same row.
  recordResponse: (id, data) => apiClient.post(`/notifications/${id}/responses`, data),
};
export const organizationService = {

  getOrganizations: () =>
    apiClient.get("/organizations"),

  // Safe, bounded organization-options list for case creation. Gated on
  // manage:cases (ADMIN + ANALYST) rather than manage:system, so an ANALYST
  // can list it — unlike getOrganizations above. Returns only
  // organizationId/name/sector.
  getOrganizationOptions: (params) =>
    apiClient.get("/organizations/options", { params }),

  getOrganization: (id) =>
    apiClient.get(`/organizations/${id}`),

  createOrganization: (data) =>
    apiClient.post("/organizations", data),

  updateOrganization: (id, data) =>
    apiClient.put(`/organizations/${id}`, data),

  deleteOrganization: (id) =>
    apiClient.delete(`/organizations/${id}`),

};
export default apiClient
