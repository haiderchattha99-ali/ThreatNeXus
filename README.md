# ThreatNeXus

**Connecting Intelligence with Action**

## Status: Phase 0

This repository is being built in phase-gated increments. **Phase 0** covers
the foundation only: secure environment/config handling, audit logging,
role/capability authorization enforced on every protected route (see the
authorization matrix in
[`docs/API_CONTRACT_PHASE0.md`](docs/API_CONTRACT_PHASE0.md)),
hardened auth, upload cleanup, and this local dev setup. It does **not**
include the Shadowserver ingestion pipeline, the Finding/RawReport model,
IOC/vulnerability enrichment, or AI assistance — those are later phases in
`../ThreatNeXus-Planning/planning/BUILD_PLAN.md`.

Three CRUD groups added by parallel UI work — `/api/cases`,
`/api/notifications`, `/api/organizations` — are also present. They now sit
behind the same authenticate + capability guard as everything else
(`manage:cases`, `review:notifications` and `manage:system` respectively), with
audit logging and input validation on every write. They are **flat CRUD tables
backing the UI, not the Phase 1 workflow**: a case is not linked to a finding,
and a notification has no approval state and is never sent anywhere.

There is still **no Shadowserver ingestion** — that is Phase 1 and has not
started.

Build outputs are not committed: `frontend/dist` is ignored and untracked, so
`npm run build` produces no tracked diffs.

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
- Write actions (auth, threat create/update/delete/import, and case /
  notification / organization create/update/delete) are recorded to the
  `AuditLog` table via `safeLogAuditEvent`; an audit write failure never
  blocks the underlying request. Audit rows carry small allow-listed summaries
  only — never the raw request body, headers, cookies, bearer token or query
  string.
- Every protected route is capability-gated via `requireCapability`
  (`requireRole.js`, `roles.js`): reads need `read:dashboard`/`read:findings`,
  import needs `ingest:reports`, status updates need `triage:findings`, and
  deletes need `delete:records` (ADMIN only). The three resource groups need
  `manage:cases` (`/api/cases`), `review:notifications`
  (`/api/notifications`) and `manage:system` (`/api/organizations`) — applied
  at router level so a route added later cannot be left unguarded. Denials
  return a generic `403` that never names the missing capability, and are
  audited. See the authorization matrix in `docs/API_CONTRACT_PHASE0.md`.
- Build artifacts are not tracked. `frontend/dist` is gitignored and untracked,
  so a local `npm run build` cannot introduce a tracked diff or ship a stale
  bundle from the repository.
- AI assistance is unimplemented and disabled by default (`AI_ENABLED=false`).
  Live Shadowserver ingestion, automatic notification sending, and automatic
  remediation verification are all out of scope for the entire project, not
  just Phase 0.

## Phase 1 gate — synthetic evaluation (P1-GATE)

`eval/run_phase1_gate.js` is an executable check that ingests the synthetic
fixtures in `data/synthetic/accessible-rdp/*.csv` through the real ingestion
service and compares the resulting database state against the manually
authored `data/synthetic/ground_truth.yaml`. It is **not part of the running
application** and never touches the development database.

**These are synthetic development/evaluation fixtures only** — RFC 5737
documentation IP ranges, deterministic hand-chosen timestamps, no real
organization or Shadowserver data. See `data/synthetic/README.md` for the
full disclaimer. `accessible-rdp.synthetic.v1` is not an official
Shadowserver schema.

### Set up a dedicated, disposable evaluation database

Never point this at your dev database. Using the same local Docker Postgres
service as the rest of this README:

```
docker exec threatnexus-postgres psql -U threatnexus -c "CREATE DATABASE threatnexus_eval;" postgres

cd backend
DATABASE_URL="postgresql://threatnexus:<your-postgres-password>@localhost:5432/threatnexus_eval" \
  npx prisma migrate deploy
```

`migrate deploy` only applies the migrations already committed to
`backend/prisma/migrations/` — it never generates one.

### Run the gate

```
cd backend
EVAL_DATABASE_URL="postgresql://threatnexus:<your-postgres-password>@localhost:5432/threatnexus_eval" \
  npm run eval:phase1
```

`EVAL_DATABASE_URL` is **required** — the gate refuses to run without it, and
refuses to run if it's equal to `DATABASE_URL` (a safeguard against
accidentally targeting the development database). It never reads
`DATABASE_URL` for its own connection. Exit code `0` means every scenario
matched `ground_truth.yaml` exactly; non-zero means at least one mismatch (see
the printed expected-vs-actual diff) or an unsafe/invalid configuration.

The gate is rerunnable: it cleans up its own, exactly-scoped evaluation-owned
records (derived from this run's own `RawReport`/`FindingOccurrence` evidence
chain, never a broad table reset) before each run.

## Docker cleanup

```
docker compose down       # stop and remove the postgres container, keep data
docker compose down -v    # ALSO deletes the named volume — every local row is gone
```
