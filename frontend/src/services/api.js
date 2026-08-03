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

export const authService = {
  login: (email, password) => apiClient.post('/auth/login', { email, password }),
  // Backend session-validation endpoint: confirms a stored token is still
  // valid and returns the server-derived role + capabilities for it. Used on
  // app initialization instead of trusting localStorage blindly.
  getCurrentUser: () => apiClient.get('/profile'),
}

export const dashboardService = {
  getStats: () => apiClient.get('/dashboard/stats'),
  getCharts: () => apiClient.get('/dashboard/charts'),
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
