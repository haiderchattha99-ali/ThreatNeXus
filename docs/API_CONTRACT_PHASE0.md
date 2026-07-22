# ThreatNeXus API Contract — Phase 0

This documents the API surface that actually exists in the codebase at the end
of Phase 0. It is not a specification of what the API should eventually look
like — it is a description of current behavior, kept honest about known gaps
and limitations. Phase 1 will extend or replace parts of this (see
[Limitations](#limitations) below), and this document will need updating when
it does.

**Base URL:** `http://localhost:5000/api`
**Auth scheme:** `Authorization: Bearer <JWT>`

## Response conventions

Most endpoints return JSON of the shape:

```json
{ "success": true | false, "message": "...", "...": "endpoint-specific fields" }
```

- `success` and `message` are present on effectively every response.
- `requestId` is included in error bodies produced by the centralized error
  handler and by `authMiddleware`/authorization guards, whenever
  `req.context.requestId` is available (it always is in practice — it's set
  by `requestContext` middleware on every request, and echoed back as the
  `X-Request-Id` response header too). It is **not** included in every
  controller's own hand-written error branch (see below).
- **Not every error response goes through the shared `errorHandler`.**
  `authController.js` and `threatController.js` catch their own errors and
  write the JSON response directly, so their error bodies are `{success,
  message}` without a `requestId`, and their exact wording differs slightly
  from route to route (e.g. `"Server Error"` vs `"Server error."` vs `"An
  unexpected error occurred."`). This is existing, inconsistent behavior —
  documented as-is, not smoothed over.
- Unauthenticated (401) and unauthorized (403) responses from
  `authMiddleware` / `requireRole`-family guards use one fixed message per
  case (`"Authentication required."` / `"Forbidden."`) deliberately, to avoid
  leaking which check failed.

## Authorization

Every protected route runs `authenticate` first, then a `requireCapability`
guard. A caller with no valid token gets `401 Authentication required.`; a
caller who is authenticated but whose role lacks the required capability gets
`403 Forbidden.`

The 403 body is a fixed `{success, message, requestId}` — it never names the
missing capability or the caller's role, since that would tell an unauthorized
caller exactly what to acquire. The required capability *is* recorded in the
`AuditLog` row (`action: "authorization.denied"`, `outcome: DENIED`,
`entityType: "Authorization"`) for investigation.

An unrecognized role in a token resolves to no capabilities at all rather than
falling back to `VIEWER`, so it is denied everywhere — including read routes.

| Route | Capability | ADMIN | ANALYST | REVIEWER | VIEWER |
|---|---|:-:|:-:|:-:|:-:|
| `GET /dashboard/stats` | `read:dashboard` | ✅ | ✅ | ✅ | ✅ |
| `GET /dashboard/charts` | `read:dashboard` | ✅ | ✅ | ✅ | ✅ |
| `GET /threats` | `read:findings` | ✅ | ✅ | ✅ | ✅ |
| `GET /threats/search` | `read:findings` | ✅ | ✅ | ✅ | ✅ |
| `POST /threats/upload` | `ingest:reports` | ✅ | ✅ | ❌ | ❌ |
| `PATCH /threats/:id/status` | `triage:findings` | ✅ | ✅ | ❌ | ❌ |
| `DELETE /threats/:id` | `delete:records` | ✅ | ❌ | ❌ | ❌ |
| `GET /profile` | *(authentication only)* | ✅ | ✅ | ✅ | ✅ |

`ANALYST` and `REVIEWER` are deliberately **not** ranked relative to each
other: the analyst does the work (ingest, triage, cases) and the reviewer
approves it (`review:notifications`, `review:ai-suggestions`), and neither
inherits the other's authority. `delete:records`, `manage:users` and
`manage:system` are ADMIN-only.

On `POST /threats/upload`, the capability check runs **before** multer. A
denied caller therefore never causes a temp file to be written at all, so an
unauthorized upload cannot consume disk.

## Auth endpoints

### `POST /auth/register`
- **Auth required:** No.
- **Body:** `{ "name": string, "email": string, "password": string }`
- **Validation:** `name` non-blank; `email` normalized (trim + lowercase) and
  format-checked; `password` 8–72 characters (bcrypt truncates beyond 72, so
  longer values are rejected rather than silently cut).
- **Security behavior:** A `role` field in the body is **ignored** — public
  registration always creates a `VIEWER`. Duplicate email returns a generic
  controlled error, including on a race with the unique constraint (Prisma
  `P2002`). The password is bcrypt-hashed (10 rounds) and never returned; the
  response uses an explicit Prisma `select` so the hash can't leak even by
  accident. The attempt is audited (`auth.register`, `SUCCESS`/`FAILURE`) via
  `safeLogAuditEvent` — audit failure never blocks the response.
- **Success (201):**
  ```json
  {
    "success": true,
    "message": "User registered successfully",
    "user": { "id": 1, "name": "...", "email": "...", "role": "VIEWER", "createdAt": "..." }
  }
  ```
- **Errors:** `400` invalid fields (body includes a `fields` array naming
  which ones) or duplicate email; `500` unexpected server error.

### `POST /auth/login`
- **Auth required:** No.
- **Body:** `{ "email": string, "password": string }`
- **Security behavior:** Email is normalized the same way as registration. An
  unknown email and a wrong password for a known email return the **exact
  same** `401` body (`"Invalid credentials."`) — a bcrypt comparison against a
  per-process dummy hash runs even when no user matches, so response timing
  doesn't distinguish the two cases either. The issued JWT payload contains
  only `{ id, email, role }` — role is passed through `normalizeRole()`, so a
  legacy lowercase role in the database (e.g. `"analyst"`) becomes the
  canonical enum value (`ANALYST`) in the token; an unrecognized role value
  becomes `VIEWER`, never anything privileged. The attempt is audited
  (`auth.login`) with an identical failure `reason` regardless of whether the
  account exists.
- **Success (200):**
  ```json
  {
    "success": true,
    "message": "Login successful",
    "token": "<JWT>",
    "user": { "id": 1, "name": "...", "email": "...", "role": "ANALYST" }
  }
  ```
- **Errors:** `400` missing/malformed credentials; `401` invalid credentials
  (generic, see above); `500` unexpected server error.

### `GET /profile`
- **Auth required:** Yes (`Authorization: Bearer <JWT>`).
- **Behavior:** Echoes back the authenticated identity. `authMiddleware`
  rebuilds `req.user` as exactly `{ id, email, role }` from the verified JWT
  — it does not include `iat`/`exp`, and does not perform a database lookup
  (so a role change doesn't take effect until the token expires,
  `JWT_EXPIRES_IN`, default 24h).
- **Success (200):**
  ```json
  { "success": true, "message": "Welcome to ThreatNeXus", "loggedInUser": { "id": 1, "email": "...", "role": "..." } }
  ```
- **Errors:** `401` if the token is missing, malformed, invalid, expired, or
  signed with the wrong secret — all four cases return the identical
  `"Authentication required."` message, deliberately, so a caller can't use
  the response to distinguish them.

## Threat endpoints

The underlying `Threat` model is a **generic IOC record** (`ip`, `domain`,
`hash`, `severity`, `source`, `riskScore`, `status`, `iocType`) that predates
Phase 0's audit/role work. It is not the Shadowserver-specific finding model
described in the Phase 1 plan — see [Limitations](#limitations).

All five routes below require `Authorization: Bearer <JWT>` via
`authMiddleware`, **and each additionally requires a capability** enforced by
`requireCapability` (see [Authorization](#authorization)). An authenticated
caller whose role lacks the capability receives `403 Forbidden.`

### `GET /threats`
- **Capability:** `read:findings`
- **Query params:** `page` (default 1), `limit` (default 10), `sort` (default
  `createdAt`), `order` (`asc`|`desc`, default `desc`).
- **Success (200):**
  ```json
  { "success": true, "page": 1, "limit": 10, "totalRecords": 0, "totalPages": 0, "data": [] }
  ```
- **Errors:** `500` on unexpected failure.

### `GET /threats/search`
- **Capability:** `read:findings`
- **Query params (all optional):** `ip`, `domain`, `hash` (case-insensitive
  substring match), `severity`, `status`, `iocType` (exact match), `source`
  (case-insensitive substring match).
- **Success (200):** `{ "success": true, "total": 0, "data": [] }`
- **Errors:** `500` on unexpected failure.

### `PATCH /threats/:id/status`
- **Capability:** `triage:findings` (ADMIN, ANALYST)
- **Body:** `{ "status": string }` — one of `New`, `Investigating`,
  `Mitigated`, `Resolved`, `False Positive`.
- **Behavior:** Audited as `threat.update` (`SUCCESS`/`FAILURE`) with small
  sanitized `before`/`after` summaries (`{id, status, severity, iocType}`
  only) — never the indicator value (`ip`/`domain`/`hash`).
- **Success (200):** `{ "success": true, "message": "Threat status updated successfully.", "data": { ...threat } }`
- **Errors:** `400` invalid status; `404` threat not found; `500` unexpected
  failure.

### `DELETE /threats/:id`
- **Capability:** `delete:records` (ADMIN only)
- **Behavior:** Audited as `threat.delete` with a `before` summary only (the
  row no longer exists for an `after`).
- **Success (200):** `{ "success": true, "message": "Threat deleted successfully." }`
- **Errors:** `404` threat not found; `500` unexpected failure.

### `POST /threats/upload`
- **Capability:** `ingest:reports` (ADMIN, ANALYST) — checked before multer,
  so a denied caller never causes a temp file to be written.
- **Body:** `multipart/form-data`, field name `file` — a CSV with columns
  `ip, domain, hash, severity, source` (any subset; missing columns default
  `severity` to `Low` and `source` to `CSV`).
- **Behavior:** This is the **existing generic CSV importer, not the Phase 1
  Shadowserver ingestion pipeline** — it has no report-type awareness, no
  dedup key of `(indicator_value, port, protocol, report_type)`, and no
  finding/case model. It deduplicates purely on an exact `(ip, domain, hash)`
  match already in the `Threat` table. The uploaded temp file is always
  removed after the response (success or failure) by the `cleanupUpload`
  middleware, which only ever deletes a path it verifies is inside the
  server's upload directory. Audited as `threat.import` with row/added/
  duplicate **counts only** — never the parsed rows, the raw CSV content, or
  the file path.
- **Success (200):**
  ```json
  { "success": true, "added": 2, "duplicates": 0, "message": "2 threat(s) added successfully. 0 duplicate(s) skipped." }
  ```
- **Errors:** `400` no file supplied, or the file could not be parsed as CSV;
  `500` a database error while persisting rows.

## Dashboard endpoints

Both require `Authorization: Bearer <JWT>` via `authMiddleware` plus the
`read:dashboard` capability, which every current role holds.

### `GET /dashboard/stats`
- **Capability:** `read:dashboard`
- **Success (200):**
  ```json
  {
    "success": true,
    "data": {
      "totalThreats": 0, "critical": 0, "high": 0, "medium": 0, "low": 0,
      "ipv4": 0, "ipv6": 0, "domain": 0, "md5": 0, "sha1": 0, "sha256": 0,
      "newThreats": 0
    }
  }
  ```
- **Errors:** `500` on unexpected failure.

### `GET /dashboard/charts`
- **Capability:** `read:dashboard`
- **Success (200):**
  ```json
  {
    "success": true,
    "data": {
      "severity": [{ "name": "Critical", "value": 0 }, "..."],
      "status": [{ "name": "New", "value": 0 }, "..."],
      "iocTypes": [{ "name": "IPv4", "value": 0 }, "..."]
    }
  }
  ```
- **Errors:** `500` on unexpected failure.

## Limitations

Being explicit about what this contract does **not** claim:

- **The `Threat` model is legacy/generic**, not the Shadowserver Accessible-RDP
  finding model the locked build plan describes. It has no `Finding`, `Case`,
  `RawReport`, `ReportType`, or `Notification` model — none of those exist yet.
- **CSV upload is a generic importer**, not the Phase 1 ingestion pipeline. It
  does not implement the `(indicator_value, port, protocol, report_type)`
  dedup key, persistence/recurrence semantics, or IOC/vulnerability
  enrichment.
- **Role authorization is enforced, but roles are only as current as the
  token.** Every route in the table above is capability-gated, but
  `authMiddleware` reads the role from the JWT without a database lookup, so a
  role change does not take effect until the existing token expires
  (`JWT_EXPIRES_IN`, default 24h). There is no token revocation or refresh
  mechanism in Phase 0.
- **Capabilities beyond the routes above are defined but unused.**
  `manage:cases`, `review:notifications`, `review:ai-suggestions`,
  `manage:users` and `manage:system` exist in the capability model and are
  granted to roles, but no route consumes them yet — the features they guard
  do not exist.
- **There is no way to obtain a privileged account through the API.** Public
  registration always creates a `VIEWER`, and no role-management endpoint
  exists. ADMIN/ANALYST/REVIEWER accounts come only from the local seed script
  (`npm run seed:users`) or a direct database change.
- **No IOC reputation or vulnerability enrichment** (AbuseIPDB, KEV, EPSS,
  NVD) is wired up. The env vars for it are declared and validated but
  unconsumed.
- **AI is not implemented** and remains disabled by default (`AI_ENABLED=false`).
- **No notification/export workflow** exists, so there is nothing yet to
  gate behind analyst approval.
- This document makes **no production-readiness or compliance claim**. It
  describes Phase 0 behavior only.
