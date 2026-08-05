# API Integration Guide

This document provides the API endpoints, request/response formats, and integration details for the ThreatNeXus frontend.

## Base URL

```
http://localhost:5000/api
```

## Authentication

All requests (except login) require a Bearer token in the Authorization header:

```
Authorization: Bearer <JWT_TOKEN>
```

The token is automatically injected by the Axios interceptor in `src/services/api.js`.

## Endpoints

### 1. Authentication

#### POST `/auth/login`

**Request:**
```json
{
  "email": "ali@example.com",
  "password": "password123"
}
```

**Response (Success - 200):**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "name": "Ali",
    "email": "ali@example.com",
    "role": "ADMIN"
  }
}
```

**Response (Error - 401):**
```json
{
  "success": false,
  "message": "Invalid email or password"
}
```

**Frontend Usage:**
```javascript
const response = await authService.login(email, password)
const { token, user } = response.data
login(token, user) // Store in auth context
```

---

### 2. Dashboard

#### GET `/dashboard/stats`

**Response (200):**
```json
{
  "totalThreats": 1247,
  "critical": 23,
  "high": 156,
  "medium": 487,
  "low": 581,
  "newThreats": 42,
  "iocCount": 3241
}
```

**Frontend Usage:**
```javascript
const response = await dashboardService.getStats()
const stats = response.data
// { totalThreats: 1247, critical: 23, ... }
```

---

#### GET `/dashboard/charts`

**Response (200):**
```json
{
  "severityChart": [
    { "name": "Critical", "value": 23 },
    { "name": "High", "value": 156 },
    { "name": "Medium", "value": 487 },
    { "name": "Low", "value": 581 }
  ],
  "statusChart": [
    { "name": "New", "count": 42 },
    { "name": "Analyzing", "count": 128 },
    { "name": "Resolved", "count": 1001 },
    { "name": "Dismissed", "count": 76 }
  ],
  "iocTypeChart": [
    { "type": "IP Address", "count": 1203 },
    { "type": "Domain", "count": 1420 },
    { "type": "URL", "count": 523 },
    { "type": "Hash", "count": 95 }
  ]
}
```

**Frontend Usage:**
```javascript
const response = await dashboardService.getCharts()
const { severityChart, statusChart, iocTypeChart } = response.data
// Use with Recharts PieChart and BarChart
```

---

### 3. Threats

#### GET `/threats`

**Query Parameters:**
```
page: number (default: 0)
limit: number (default: 10)
sort: string (default: 'id')
order: 'asc' | 'desc' (default: 'desc')
```

**Request Example:**
```
GET /threats?page=0&limit=10
```

**Response (200):**
```json
{
  "success": true,
  "threats": [
    {
      "id": 1,
      "name": "Malware Campaign XYZ",
      "severity": "Critical",
      "status": "Analyzing",
      "riskScore": 95,
      "iocCount": 23,
      "description": "Large-scale malware campaign detected",
      "createdAt": "2024-07-19T10:30:00Z"
    },
    {
      "id": 2,
      "name": "Phishing Attack Wave",
      "severity": "High",
      "status": "New",
      "riskScore": 78,
      "iocCount": 15,
      "description": "Targeted phishing emails detected",
      "createdAt": "2024-07-19T09:15:00Z"
    }
  ],
  "total": 1247,
  "page": 0,
  "limit": 10
}
```

**Frontend Usage:**
```javascript
const response = await threatService.getThreats({ page: 0, limit: 10 })
const { threats, total } = response.data
// Populate MUI DataGrid
```

---

#### GET `/threats/search`

**Query Parameters:**
```
q: string (search query)
```

**Request Example:**
```
GET /threats/search?q=malware
```

**Response (200):**
```json
{
  "success": true,
  "threats": [
    {
      "id": 1,
      "name": "Malware Campaign XYZ",
      "severity": "Critical",
      "status": "Analyzing",
      "riskScore": 95,
      "iocCount": 23
    }
  ],
  "total": 5
}
```

**Frontend Usage:**
```javascript
const response = await threatService.searchThreats('malware')
const { threats } = response.data
// Update table with search results
```

---

#### PATCH `/threats/:id/status`

**Request:**
```json
{
  "status": "Resolved"
}
```

**Valid Status Values:**
- `"New"`
- `"Analyzing"`
- `"Resolved"`
- `"Dismissed"`

**Response (200):**
```json
{
  "success": true,
  "message": "Threat status updated",
  "threat": {
    "id": 1,
    "name": "Malware Campaign XYZ",
    "status": "Resolved",
    "updatedAt": "2024-07-19T11:45:00Z"
  }
}
```

**Frontend Usage:**
```javascript
await threatService.updateThreatStatus(threatId, 'Resolved')
// Refresh threats list
```

---

#### DELETE `/threats/:id`

**Response (200):**
```json
{
  "success": true,
  "message": "Threat deleted successfully"
}
```

**Response (404):**
```json
{
  "success": false,
  "message": "Threat not found"
}
```

**Frontend Usage:**
```javascript
await threatService.deleteThreat(threatId)
// Refresh threats list
```

---

#### POST `/threats/upload`

**Request (multipart/form-data):**
- `file`: CSV file

**CSV Format:**
```
id,name,severity,status,riskScore,iocCount,description
1,Malware XYZ,Critical,New,95,23,Large malware campaign
2,Phishing Wave,High,Analyzing,78,15,Targeted emails
```

**Response (200):**
```json
{
  "success": true,
  "message": "CSV file imported successfully",
  "imported": 45,
  "skipped": 0,
  "errors": []
}
```

**Response (400):**
```json
{
  "success": false,
  "message": "Invalid CSV format",
  "errors": [
    "Row 5: Invalid severity value",
    "Row 8: Risk score must be a number"
  ]
}
```

**Frontend Usage:**
```javascript
const response = await threatService.uploadCSV(file)
const { imported, skipped, errors } = response.data
// Show results to user
```

---

## Error Handling

### Global Error Response Format

**All Error Responses:**
```json
{
  "success": false,
  "message": "Error description",
  "errors": {
    "fieldName": "Field-specific error"
  }
}
```

### HTTP Status Codes

- `200` - Success
- `400` - Bad Request (validation error)
- `401` - Unauthorized (invalid/missing token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `500` - Server Error

### Frontend Error Handling

All errors are caught and displayed via toast notifications:

```javascript
try {
  const response = await threatService.getThreats()
  // Handle success
} catch (error) {
  const message = error.response?.data?.message || 'An error occurred'
  toast.error(message)
}
```

---

## Request/Response Examples

### Complete Login Flow

**Step 1: Login Request**
```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "ali@example.com",
    "password": "password123"
  }'
```

**Step 2: Login Response**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "name": "Ali",
    "email": "ali@example.com",
    "role": "ADMIN"
  }
}
```

**Step 3: Subsequent API Request**
```bash
curl -X GET http://localhost:5000/api/threats \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

---

## Integration Checklist

- [ ] Implement POST `/auth/login` endpoint
- [ ] Implement GET `/dashboard/stats` endpoint
- [ ] Implement GET `/dashboard/charts` endpoint
- [ ] Implement GET `/threats` with pagination
- [ ] Implement GET `/threats/search` endpoint
- [ ] Implement PATCH `/threats/:id/status` endpoint
- [ ] Implement DELETE `/threats/:id` endpoint
- [ ] Implement POST `/threats/upload` for CSV
- [ ] Return proper error messages
- [ ] Validate all inputs
- [ ] Add CORS headers if needed
- [ ] Implement JWT token validation
- [ ] Test all endpoints with frontend

---

## Testing Endpoints with cURL

### Test Login
```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ali@example.com","password":"password123"}'
```

### Test Dashboard Stats
```bash
curl -X GET http://localhost:5000/api/dashboard/stats \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test Threats List
```bash
curl -X GET "http://localhost:5000/api/threats?page=0&limit=10" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test Search
```bash
curl -X GET "http://localhost:5000/api/threats/search?q=malware" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Test Update Status
```bash
curl -X PATCH http://localhost:5000/api/threats/1/status \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"Resolved"}'
```

### Test Delete
```bash
curl -X DELETE http://localhost:5000/api/threats/1 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Notes for Backend Developer

1. **JWT Token**: Should be a valid JWT that can be decoded. Include `user` data in the token claims if needed.

2. **CORS**: Enable CORS for `http://localhost:5173` during development.

3. **Pagination**: Implement proper pagination for the threats endpoint to handle large datasets.

4. **CSV Upload**: 
   - Accept multipart/form-data
   - Validate CSV format
   - Return list of errors if validation fails
   - Return counts of imported/skipped rows

5. **Status Updates**: Only allow transitions between valid statuses.

6. **Search**: Implement full-text search across threat name and description.

7. **Error Messages**: Return user-friendly error messages for validation failures.

8. **Timestamps**: Use ISO 8601 format for all dates (e.g., `2024-07-19T10:30:00Z`).

---

## Next Steps

1. Implement the backend API according to this specification
2. Test all endpoints using provided cURL examples
3. Start the frontend: `npm run dev`
4. Test the complete flow in the browser
5. Debug any integration issues using browser DevTools

---

**API Integration Status**: Ready for backend implementation ✅
