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

  deleteCase: (id) => apiClient.delete(`/cases/${id}`),
}
export const notificationService = {

  getNotifications: () =>
    apiClient.get("/notifications"),

  getNotification: (id) =>
    apiClient.get(`/notifications/${id}`),

  createNotification: (data) =>
    apiClient.post("/notifications", data),

  updateNotification: (id, data) =>
    apiClient.put(`/notifications/${id}`, data),

  deleteNotification: (id) =>
    apiClient.delete(`/notifications/${id}`),

};
export const organizationService = {

  getOrganizations: () =>
    apiClient.get("/organizations"),

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
