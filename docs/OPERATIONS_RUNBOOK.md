# Operations Runbook

Day-to-day commands for running, checking, and recovering a ThreatNeXus Compose stack or a local
development checkout. Paired with `docs/DEPLOYMENT.md` (first-time setup) and
`docs/TESTING_AND_CI.md` (test/evaluator detail).

## Start / stop / restart

```bash
# Start (builds images if needed, applies migrations, starts all three services)
JWT_SECRET="$(openssl rand -base64 48)" docker compose up --build

# Start in the background
JWT_SECRET="$(openssl rand -base64 48)" docker compose up -d --build

# Stop (containers removed, named volume kept)
docker compose down

# Stop AND delete all data (fresh-start reset)
docker compose down -v

# Restart one service without rebuilding
docker compose restart backend
```

`docker compose up` (without `-d`) attaches to the log stream of all three services — useful for a first
run or debugging; use `-d` plus `docker compose logs -f <service>` for normal operation.

## Checking logs

```bash
docker compose logs -f backend        # follow backend logs
docker compose logs -f postgres       # follow database logs
docker compose logs --tail=200 backend  # last 200 lines, no follow
```

The backend logs its own request context (`requestId`) on every request via `requestContext`
middleware, which is also echoed back as the `X-Request-Id` response header — useful for correlating a
frontend-reported error to a specific backend log line.

## Checking the database and migration state

```bash
# From inside the container
docker compose exec backend npx prisma migrate status

# Direct psql access
docker compose exec postgres psql -U threatnexus -d threatnexus

# Apply any pending migration manually (non-destructive)
docker compose exec backend npx prisma migrate deploy
```

`prisma migrate status` reports which of the 23 migrations are applied and whether any are pending or
have drifted from what's recorded — it never modifies anything.

## Running tests

```bash
# Backend (from backend/, against a real Postgres reachable via DATABASE_URL)
npm test                    # vitest run — full suite
npm run test:watch          # watch mode

# Frontend (from frontend/)
npm run lint                # oxlint
npm test                    # vitest run
npm run test:e2e            # Playwright, Chromium — needs a running backend + built frontend
```

See `docs/TESTING_AND_CI.md` for what each suite actually covers and current counts.

## Running evaluators

```bash
# From backend/, each against DATABASE_URL (a disposable database is recommended)
npm run eval:phase1        # ingestion, dedup, persistence, recurrence
npm run eval:risk          # Risk v1 determinism and explainability
npm run eval:phase2        # ownership resolution, enrichment, consistency
npm run eval:phase3        # analyst workflow, closure, recurrence reopening
npm run eval:phase4        # notification review, export, delivery
npm run eval:phase5        # framework mappings, guarded AI assistance
npm run eval:phase6.3      # ATT&CK catalogue and evidence integrity
npm run eval:vulnerability # CVE association, NVD/KEV/EPSS evidence
npm run eval:phase7        # no-key startup, offline operation, AI off

# Expensive — take minutes, not seconds. Run on demand, not per-push.
npm run eval:phase2:mutation
npm run eval:vulnerability:mutation
```

Every evaluator drives the real production services against real data and compares against
hand-authored ground truth — a failing evaluator means the system's actual behavior diverged from a
fact someone verified by hand, not that a mock's expectation changed.

## Provider status checks

```bash
# Requires a valid JWT for any role (every role holds read:dashboard)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/dashboard/overview \
  | jq '.data.sections.providers'
```

Returns configuration status (`CONFIGURED`/`NOT_CONFIGURED`/`KEYLESS_PUBLIC_RATE_LIMIT`/etc.) and
freshness (`FRESH`/`STALE`/`NO_SUCCESSFUL_LOOKUP_RECORDED`) for every provider, derived from stored rows
only — **this call makes zero live provider requests.** The same information is visible in the frontend
Settings screen. See `docs/PROVIDER_GUIDE.md` for what each status value means per provider.

To manually verify one *live* provider is actually reachable (never run in CI, never automated):

```bash
LIVE_CENSYS_SMOKE=1 npm run smoke:censys --prefix backend
LIVE_GREYNOISE_SMOKE=1 npm run smoke:greynoise --prefix backend
LIVE_SHODAN_SMOKE=1 npm run smoke:shodan --prefix backend
LIVE_NETLAS_SMOKE=1 npm run smoke:netlas --prefix backend
LIVE_NVD_SMOKE=1 npm run smoke:nvd --prefix backend
```

Each performs exactly one lookup against permanent public infrastructure (never a customer/victim
asset), and none was run as part of this documentation delivery — running one requires the relevant key
to be exported in your own shell first.

## Rate-limit behavior

Three independent buckets, all configurable via env vars (defaults shown):

| Bucket | Env var | Default | Applies to |
|---|---|---|---|
| Auth | `RATE_LIMIT_AUTH_MAX` / `RATE_LIMIT_AUTH_WINDOW_MS` | 30 / 15 min | `/api/auth/login`, `/api/auth/register` |
| Upload | `RATE_LIMIT_UPLOAD_MAX` | 20 | `POST /api/reports/upload` — the canonical ingestion route. The legacy `/api/threats/upload` route carries **no** limiter: `app.js` mounts `uploadRateLimiter` on `/api/reports` only |
| Provider execution | `RATE_LIMIT_PROVIDER_MAX` | 60 | Every `POST .../enrichment/*` route across all six providers, batch enrichment workers, and AI suggestion generation — one shared budget |

A rate-limited caller receives `429`. Reading data is never rate-limited — only causing new work
(a login attempt, an upload, a provider spend) is.

**Known legitimate override**: the Chromium browser suite signs in dozens of times across four roles and
several breakpoints in a few minutes, which the default auth budget correctly refuses as
credential-stuffing-shaped traffic. Raise the budget for that run specifically rather than weakening the
default for everyone:

```bash
RATE_LIMIT_AUTH_MAX=1000 docker compose up -d
```

CI's own browser-suite job sets this disposable override for its own throwaway backend only — see
`.github/workflows/ci.yml`.

## Offline rehearsal

```bash
JWT_SECRET="$(openssl rand -base64 48)" \
  docker compose -f docker-compose.yml -f docker-compose.offline.yml up -d
```

See `docs/DEPLOYMENT.md` → "Offline / demo-without-internet mode" for the full command sequence and
expected result. Run this before any live presentation with uncertain network — it is the only way to
know in private, rather than in front of an audience, whether something depends on the internet by
accident.

## Common failure modes and recovery

| Symptom | Likely cause | Recovery |
|---|---|---|
| `docker compose up` refuses to start | `JWT_SECRET` not exported | Export it and retry (see Start/stop above) |
| Port 5432 already in use | An old Postgres container is still bound | `docker stop threatnexus-phase0-postgres` (or find the offending container with `docker ps`) |
| Fresh Postgres gets an empty `NetworkSettings.Networks {}` | Stale Docker network reference | `docker compose down -v && docker network prune`, then bring the stack up from clean |
| `seed:demo` reports success but findings total is 0 | The `data/` fixture volume is not mounted, or the container predates that mount | Verify `./data:/app/data:ro` in `docker-compose.yml`, rebuild |
| Test suite reports `beforeAll` hook timeout on 5–10 unrelated files, others pass | CPU contention from cold-transforming the full ~145-file suite in parallel on a constrained machine — a documented flake, not a regression | Re-run the same failing files alone (`npx vitest run <file1> <file2>`); they pass in isolation. If a full clean single-pass run is needed for the record, re-run the whole suite once more — it typically passes clean on a warm cache. |
| A provider is stuck at `FAILED`/`INVALID_KEY` | Wrong key, expired key, or wrong header/query-param scheme for that provider | Check `docs/PROVIDER_GUIDE.md` for that provider's exact auth mechanism; re-check the key value (never logged, so it cannot be recovered from a log line) |
| Login works but a page renders "Not available to your role" | Correct behavior, not a bug — the account's role lacks the capability that page requires | Check `docs/ADMIN_GUIDE.md`'s role/capability matrix |

## Stale writer-lock handling (AI development workflow only)

This repository is developed using an internal AI-assisted workflow (`docs/ai/`) that is not part of
the shipped product. If you are continuing work under that workflow and find no
`.ai-team/WRITER_LOCK.json` file where one is expected, or the automation tooling errors trying to read
it: this is a known, already-documented gap in the tooling against this repository's `STATE.yaml`
schema, not a stale lock to force-clear. Read `docs/ai/STATE.yaml` and `docs/ai/HANDOFF.md` directly to
establish current state, and proceed under the same single-active-writer discipline by convention
(check `git status` and recent commits before editing) rather than trying to repair the lock file
mechanism. This has no effect on running or operating the deployed application.

## CI flake note

A single class of flake has recurred across several phases of this project's backend test suite: when
all ~145 backend test files run in parallel on a resource-constrained machine, a handful of unrelated
integration test files can hit a `beforeAll` hook timeout (10s) purely from cold module-transform
contention — not from any logic defect. It is confirmed non-systemic every time it has appeared: the
same files pass cleanly when re-run alone or in a smaller batch. CI's own GitHub Actions runners have not
exhibited this — it has only been observed on local developer-machine runs. If a CI run itself ever shows
this pattern, re-running the job is the correct first response before treating it as a regression.

## Enrichment worker (Phase 10A-2)

### Is it running?

```bash
docker compose logs backend | grep -i "enrichment worker"
```

Silence means it is **off**, which is the default and the correct state unless someone deliberately
enabled it. When on you will see `Enrichment worker started (ENRICHMENT_WORKER_ENABLED=true)`.

Per-tick activity is in the audit trail rather than the logs:

```sql
SELECT action, COUNT(*) FROM "AuditLog"
WHERE action LIKE 'enrichment.worker.%' OR action LIKE 'enrichment.lookup.%'
GROUP BY action ORDER BY 2 DESC;
```

### How much quota has been spent?

```sql
SELECT provider, lane, "usageDate", "reservedCount", "limitAtLastReservation"
FROM "ProviderDailyUsage" ORDER BY "usageDate" DESC, provider;
```

`reservedCount` counts **reservations**, which is deliberately conservative: a call reserved but
never sent is still counted, because there is no refund path and over-counting a paid budget is the
only safe direction. To see which reservations actually reached a provider:

```sql
SELECT provider, lane, outcome, "contactedProvider", COUNT(*)
FROM "ProviderLookupAttempt" GROUP BY 1,2,3,4 ORDER BY 5 DESC;
```

The ADMIN `GET /api/enrichment/usage` endpoint reports the same data with explicit scope metadata:
coverage is `PARTIAL`, because the synchronous expert endpoints and the two ADMIN batches are not
Phase-10 reservations and are not counted. No total provider-call figure is fabricated.

### A job is stuck and I want to know why

```sql
SELECT id, provider, state, "terminalReasonCode", "attemptCount", "activeLookupKey"
FROM "ProviderLookupJob" WHERE state NOT IN ('SUCCEEDED','NO_RECORD') ORDER BY id DESC LIMIT 20;
```

| What you see | What it means |
|---|---|
| `PENDING`, worker off | Correct. Nothing will run until the worker is enabled. |
| `SKIPPED_NOT_CONFIGURED` | The provider has no credential. **No quota was spent.** |
| `SKIPPED_BUDGET` | The daily budget refused it. **No provider was called.** |
| `WAITING_ON_DELEGATE` | AbuseIPDB/NVD. The ADMIN batch or the targeted pass still owns the work. |
| `DEAD_LETTER` + `AMBIGUOUS_AFTER_CONTACT` | **We do not know** whether the provider answered. See below. |

### `AMBIGUOUS_AFTER_CONTACT` — what to do

A worker died at or after handing a request to the transport. Whether the provider received,
processed and **charged** for that call is unknowable from inside this system, so the job is
terminal and is deliberately **not** retried.

For AbuseIPDB the linked `IocEnrichment` row is also driven terminal, which is what stops the
ordinary ADMIN batch from re-calling the same indicator later.

This is a human decision, not an automatic one. If you want the answer, create a **new run** with
`force` and a written justification — that is an explicit choice to spend quota again, and it is
recorded as one.

### A contacted row is held and no worker is running

If a worker died after contacting a provider and no worker has run since, that one `IocEnrichment`
row stays unclaimable (its `nextAttemptAt` carries a far-future sentinel) and the ADMIN batch will
skip it. **This is deliberate:** freezing one row is safer than double-calling a paid third party
when we cannot establish what happened. Starting a worker resolves it on the next tick.

To find them:

```sql
SELECT id, indicator, status, "nextAttemptAt" FROM "IocEnrichment"
WHERE "nextAttemptAt" > now() + interval '1 year';
```

### Turning it off

```bash
ENRICHMENT_WORKER_ENABLED=false docker compose up -d
```

No worker is constructed. In-flight leases expire on their own. Already-persisted evidence stays —
this stops future calls, it does not retract completed ones.
