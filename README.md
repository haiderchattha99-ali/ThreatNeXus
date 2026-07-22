# ThreatNeXus

**Connecting Intelligence with Action**

## Status: Phase 0

This repository is being built in phase-gated increments. **Phase 0** covers
the foundation only: secure environment/config handling, audit logging,
role/capability authorization (implemented but not yet enforced on every
route — see [`docs/API_CONTRACT_PHASE0.md`](docs/API_CONTRACT_PHASE0.md)),
hardened auth, upload cleanup, and this local dev setup. It does **not**
include the Shadowserver ingestion pipeline, the Finding/Case/Notification
model, IOC/vulnerability enrichment, or AI assistance — those are later
phases in `../ThreatNeXus-Planning/planning/BUILD_PLAN.md`.

See [`docs/API_CONTRACT_PHASE0.md`](docs/API_CONTRACT_PHASE0.md) for exactly
which endpoints exist today and their known limitations.

## Stack

- **Backend:** Node.js, Express
- **Database:** PostgreSQL via Prisma
- **Frontend:** React, Vite, MUI
- **Tests:** Vitest, Supertest (backend); oxlint (frontend)
- **Local database:** Docker Compose (PostgreSQL only)

The original submitted proposal sketched a FastAPI/SQLAlchemy backend. That
was superseded early on (see `../ThreatNeXus-Planning/planning/DECISIONS.md`,
decision D-001) — this repository preserves and refactors the existing
Node/Express/Prisma codebase rather than rewriting it in Python.

## Local setup

### 1. Install dependencies

```
cd backend
npm install

cd ../frontend
npm install
```

### 2. Copy environment examples

```
cd backend
cp .env.example .env
cp .env.test.example .env.test
```

```
cd ../frontend
cp .env.example .env
```

Fill in a real `JWT_SECRET` in `backend/.env` (32+ characters — the example
value is a local-only placeholder, not something to run with as-is). Never
commit `.env` or `.env.test` — they're gitignored.

### 3. Start PostgreSQL

```
docker compose up -d
```

This starts a `postgres:16` container (service `postgres`, db/user
`threatnexus`) matching the default `DATABASE_URL` in `backend/.env.example`,
with a named volume for persistence and a healthcheck.

> **Port conflict note:** if you already have the T4-era disposable container
> `threatnexus-phase0-postgres` running, it holds port 5432 and this compose
> file's `postgres` service will fail to start. Stop the disposable one first:
> `docker stop threatnexus-phase0-postgres`.

### 4. Run database migrations

```
cd backend
npx prisma migrate deploy
```

(Use `npx prisma migrate dev` instead if you're actively developing schema
changes — `migrate deploy` just applies what's already committed.)

### 5. (Optional) Seed local role-testing users

```
SEED_USER_PASSWORD=<a-strong-local-only-password> npm run seed:users
```

Creates/updates four demo accounts for testing each role:
`admin@threatnexus.local`, `analyst@threatnexus.local`,
`reviewer@threatnexus.local`, `viewer@threatnexus.local` — all with the
password you provide. Idempotent (safe to re-run), refuses to run in
production, and never prints the password. See
`backend/src/scripts/seedUsers.js`.

### 6. Run the backend

```
cd backend
npm run test:watch   # or: node index.js / your usual dev command
```

Backend listens on **http://localhost:5000** by default (`PORT` in `.env`).

### 7. Run the frontend

```
cd frontend
npm run dev
```

Frontend dev server runs on **http://localhost:5173** by default and talks to
the backend via `VITE_API_BASE_URL` (see `frontend/.env.example`).

## Useful commands

**Backend** (from `backend/`):
```
npm test                    # run the full backend test suite
npx prisma validate         # validate the Prisma schema
npx prisma migrate status   # check pending/applied migrations
npm run seed:users          # seed the four local demo role accounts
```

**Frontend** (from `frontend/`):
```
npm run lint
npm run build
```

## Security notes

- No real secrets are committed anywhere in this repository. `.env` and
  `.env.*` are gitignored except the `.env.example`/`.env.test.example`
  templates, which contain placeholder values only.
- Public registration (`POST /api/auth/register`) always creates a `VIEWER`
  account — a `role` field in the request body is ignored, not honored.
- Write actions (auth, threat create/update/delete/import) are recorded to
  the `AuditLog` table via `safeLogAuditEvent`; an audit write failure never
  blocks the underlying request.
- Role/capability authorization middleware exists (`requireRole.js`,
  `roles.js`) but is **not yet wired into every route** — see the limitations
  section of `docs/API_CONTRACT_PHASE0.md`.
- AI assistance is unimplemented and disabled by default (`AI_ENABLED=false`).
  Live Shadowserver ingestion, automatic notification sending, and automatic
  remediation verification are all out of scope for the entire project, not
  just Phase 0.

## Docker cleanup

```
docker compose down       # stop and remove the postgres container, keep data
docker compose down -v    # ALSO deletes the named volume — every local row is gone
```
