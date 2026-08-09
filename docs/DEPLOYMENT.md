# Deployment Guide

ThreatNeXus is a research prototype with one supported way to run it: Docker Compose, for a developer's
own machine or a demonstration. **There is no production compose file and no deployed environment.**
This guide covers what exists, honestly, rather than describing a production rollout the project has
never done.

## Prerequisites

- Docker and Docker Compose
- Git
- `openssl` (or any way to generate a random string) for `JWT_SECRET`
- Optional: API keys for any of the six live providers (`docs/PROVIDER_GUIDE.md`) — none is required to
  run the full application

## Repository clone and setup

```bash
git clone https://github.com/haiderchattha99-ali/ThreatNeXus.git
cd ThreatNeXus
```

No `.env` file is required to start the stack — `docker-compose.yml` reads everything from shell-exported
variables with safe defaults, except `JWT_SECRET`, which has **no default and is required**.

## Environment variables

`backend/.env.example` is the authoritative, always-current list, with placeholders only — **never a
real key is committed anywhere in this repository**, and CI enforces this on every push (see
`docs/TESTING_AND_CI.md`). The categories:

| Category | Variables | Required? |
|---|---|---|
| Core | `NODE_ENV`, `PORT`, `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `CORS_ORIGIN` | `JWT_SECRET` required, no default. Everything else has a working default. |
| Uploads | `UPLOAD_MAX_BYTES`, `REPORT_MAX_ROWS` | Defaulted |
| IOC reputation | `IOC_ENRICHMENT_PROVIDER` (`mock`/`abuseipdb`), `ABUSEIPDB_API_KEY`, `ABUSEIPDB_BASE_URL`, `ABUSEIPDB_TIMEOUT_MS`, `ABUSEIPDB_MAX_AGE_DAYS`, `ABUSEIPDB_CACHE_TTL_HOURS` | Optional — `mock` needs nothing |
| Vulnerability | `NVD_API_KEY`, `NVD_BASE_URL`, `NVD_TIMEOUT_MS` | Optional — NVD works keyless at a lower rate limit |
| Exposure | `CENSYS_PAT`, `CENSYS_ORG_ID`, `SHODAN_API_KEY`, `NETLAS_API_KEY` (+ each provider's `_BASE_URL`/`_TIMEOUT_MS`) | Optional |
| Reputation | `GREYNOISE_API_KEY` (+ `_BASE_URL`/`_TIMEOUT_MS`) | Optional |
| AI | `AI_ENABLED` (default `false`), `AI_PROVIDER` (default `null`) | Optional — see `docs/AI_GOVERNANCE.md` |
| Rate limiting | `RATE_LIMIT_ENABLED`, `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_AUTH_WINDOW_MS`, `RATE_LIMIT_UPLOAD_MAX`, `RATE_LIMIT_PROVIDER_MAX` | Defaulted |
| Demo/seed only | `SEED_USER_PASSWORD`, `DEMO_MODE`, `DEMO_USER_PASSWORD` | Never set outside a seed run |

**Never write a real key into `docker-compose.yml`, `docker-compose.offline.yml`, or any tracked file.**
Every provider key is passed through from the invoking shell (`${VAR:-}` syntax) — export it in your own
terminal, never commit it.

## Starting the stack

```bash
JWT_SECRET="$(openssl rand -base64 48)" docker compose up --build
```

This brings up three services:

- **postgres** — PostgreSQL 16, with a named volume (`threatnexus_postgres_data`) and a health check
  (`pg_isready`) the backend waits on before its own first migration runs.
- **backend** — applies every pending migration (`prisma migrate deploy`, non-destructive, additive-only)
  and then starts the API on port 5000.
- **frontend** — a production build served on port 5173, pointed at `VITE_API_BASE_URL` (baked in at
  build time, defaulting to `http://localhost:5000/api`).

Services are **not** given a pinned `container_name` deliberately — Compose derives
`<project>-<service>-1`, so two checkouts (or a `-p` project name) can coexist and a leftover container
from a previous session can never collide with a fresh `docker compose up --build`. Address services by
name (`docker compose exec postgres ...`), which is stable either way.

## Database migrations and Prisma generation

Migrations apply automatically on container start (`npx prisma migrate deploy && node server.js`, baked
into the backend service's `command`). There are **23 migrations, all additive** — none in this
project's history has ever altered or dropped a column. To apply migrations manually against a running
database:

```bash
docker compose exec backend npx prisma migrate deploy
```

The Prisma client is generated at image build time (part of `npm ci`/`npm run build` in the backend
Dockerfile); it does not need a separate manual step in normal use. If you change `schema.prisma`
locally and want the client regenerated without a full rebuild:

```bash
docker compose exec backend npx prisma generate
```

## Health checks

- **postgres**: `pg_isready -U threatnexus -d threatnexus`, checked every 5s, 10 retries.
- **backend**: an HTTP probe against the root path, checked every 10s with a 30s start period (long
  enough for the migration step to finish before the health check starts failing it).
- **frontend**: depends on `backend: service_started` (not `service_healthy` — the frontend is a static
  build server and does not need the API to be fully warmed to start).

## Seed data and demo mode

Two seed scripts, both explicitly opt-in and both refuse to run against `NODE_ENV=production` without an
awkward, deliberately-named override:

```bash
# 1. Create the four local role accounts (once).
docker compose exec -e SEED_USER_PASSWORD='<a-strong-local-password>' \
  backend npm run seed:users

# 2. Optionally load the deterministic demonstration dataset.
docker compose exec -e DEMO_MODE=true -e DEMO_USER_PASSWORD='<same password>' \
  backend npm run seed:demo
```

`seed:users` creates exactly four accounts (`admin@threatnexus.local`, `analyst@threatnexus.local`,
`reviewer@threatnexus.local`, `viewer@threatnexus.local`) and touches no other row. `seed:demo` drives
the application's own REST API (not raw Prisma writes) with real JWTs for each role, so the demonstration
proves separation-of-duties rather than asserting it — the analyst's own self-approval attempt on a case
closure is issued and refused with `403` during the seed run itself. It never prints the password, never
truncates or resets anything, and is idempotent (re-running detects what already exists and skips it).

Full walkthrough: `docs/DEMO_SCRIPT.md` and `docs/DEMO_RUNBOOK.md`.

## Offline / demo-without-internet mode

`docker-compose.offline.yml` is a rehearsal overlay that blackholes every one of the eight external
hosts the backend could ever reach (all six providers plus NVD/KEV/EPSS's underlying hosts) by resolving
them to `0.0.0.0` inside the container:

```bash
JWT_SECRET="$(openssl rand -base64 48)" \
  docker compose -f docker-compose.yml -f docker-compose.offline.yml up -d
docker compose -f docker-compose.yml -f docker-compose.offline.yml \
  exec -e DEMO_MODE=true -e DEMO_USER_PASSWORD='<password>' backend npm run seed:demo
```

Every provider key is stated as an explicit empty string in this overlay (never inherited from the
shell), so the rehearsal cannot accidentally run with a key a terminal happens to have exported. Expected
result: **identical to the online run.** Ingestion, ownership, risk, cases, notifications, approval and
export all complete; enrichment simply records that the provider was unavailable, and nothing blocks.

## Provider key setup

See `docs/PROVIDER_GUIDE.md` for the full list. Pattern for any provider:

```bash
CENSYS_PAT='<your-pat>' JWT_SECRET="$(openssl rand -base64 48)" docker compose up -d
```

A provider with no key is not an error state — it is `NOT_CONFIGURED` / `SKIPPED_DISABLED`, a normal,
persisted, honestly-labeled outcome. Nothing in this application requires a provider key to function.

## AI: disabled by default

`AI_ENABLED` defaults to `false` and there is no live AI provider in this repository — see
`docs/AI_GOVERNANCE.md`. No action is needed to run ThreatNeXus with AI off; it is the shipped
configuration.

## CI/CD overview

There is no automated deployment pipeline — CI (`.github/workflows/ci.yml`) validates every push and
pull request but does not deploy anything. See `docs/TESTING_AND_CI.md` for the full breakdown of what
runs.

## Backup and restore (basics)

There is no automated backup mechanism shipped with this project. For a local Compose deployment:

- **Backup**: `docker compose exec postgres pg_dump -U threatnexus threatnexus > backup.sql`
- **Restore into a fresh volume**: `docker compose down -v` (removes the named volume — this deletes all
  data), bring the stack back up, then `docker compose exec -T postgres psql -U threatnexus threatnexus <
  backup.sql`
- **To start completely clean** without restoring anything: `docker compose down -v`, then
  `docker compose up --build` again — migrations reapply from zero.

`docker compose down` (without `-v`) never touches the named volume; only an explicit `-v` does.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `docker compose up` exits immediately citing `JWT_SECRET` | The variable was not exported | `JWT_SECRET="$(openssl rand -base64 48)" docker compose up --build` |
| `Bind for 0.0.0.0:5432 failed: port is already allocated` | An older container is still holding the port | `docker stop threatnexus-phase0-postgres` (or whatever old container owns it), or stop the conflicting local Postgres |
| Fresh Postgres container reports an empty `NetworkSettings.Networks {}}` | A stale Docker network reference from a previous `down`/`up` cycle | `docker compose down -v && docker network prune`, then bring the stack up again |
| `seed:demo` reports `findings total=0` with exit code 0 | The `./data:/app/data:ro` fixture mount is missing or the container was built before that mount existed | Confirm the volume mount in `docker-compose.yml` and rebuild |
| Backend never becomes healthy | Migrations are taking longer than the 30s start period, or Postgres never became healthy | `docker compose logs backend` and `docker compose logs postgres` |
| A provider row is always `FAILED`/`SKIPPED_DISABLED` | No key configured, or the key was rejected (`INVALID_KEY`) | Check `GET /api/dashboard/overview` → `sections.providers`, or `docs/PROVIDER_GUIDE.md` for that provider's exact env var names |

## What not to commit

- Any `.env` file other than `backend/.env.example` (CI fails the build if one is found — see
  `docs/TESTING_AND_CI.md`)
- Any real provider API key, JWT secret, or database password, anywhere — in code, in a compose file, in
  a commit message, or in a comment
- `frontend/dist` or any build output — it is generated at build time and gitignored; a previously
  committed copy was removed from the index specifically so `npm run build` no longer dirties tracked
  files
- `node_modules` in either `backend/` or `frontend/`

See `docs/ai/SECURITY.md` for the full secret-handling policy and `docs/TESTING_AND_CI.md` for how CI
enforces it automatically.
