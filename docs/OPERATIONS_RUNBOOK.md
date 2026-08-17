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

### Which providers are usable right now? (Phase 10C-3)

Read-only, no live call, no schema change. Sign in as ADMIN and either open Settings →
"Enrichment budgets and readiness", or:

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:5000/api/enrichment/usage \
  | jq '.data.providers[] | {provider, automatic: .automatic.readiness, manual: .manual.readiness, missing: .missingConfiguration}'
```

Each provider reports one of seven closed values (`READY`, `NOT_CONFIGURED`, `EXECUTION_PAUSED`,
`AUTOMATIC_INGESTION_DISABLED`, `BUDGET_ZERO`, `BUDGET_EXHAUSTED`, `DELEGATED_BATCH_REQUIRED`) per
lane — see `docs/PROVIDER_GUIDE.md` → "Phase 10C-3" for what each means and which environment
variable to set. **Every fix requires a restart** — nothing on this endpoint or screen can change a
credential, a budget, or a switch; they are all read from the environment at process start
(`backend/src/config/env.js`) and frozen for the life of the process. Set the variable named in
`missingConfiguration` (or raise the budget, or flip the switch), then:

```bash
docker compose restart backend
```

If two adjacent panels disagree about AbuseIPDB — the dashboard's "IP reputation" row says
"Mock provider" while this screen says `abuseipdb — READY` or `NOT_CONFIGURED` — that is not a bug.
They answer different questions: the dashboard panel reflects `IOC_ENRICHMENT_PROVIDER` (the legacy
IOC path's own selector, `mock` by default), and this screen reflects `ABUSEIPDB_API_KEY`'s presence
for the Phase-10 path. See `docs/PROVIDER_GUIDE.md`'s "legacy `IOC_ENRICHMENT_PROVIDER` selector"
note.

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

### Controlled live canary (Phase 10C-4)

**This section documents the preflight gate for a future, separate, operator-authorized live
canary. Running the preflight does NOT run the canary, and no canary has been executed by writing
this document.** The full definition, evidence set, and rollback procedure live in
`docs/ai/PHASE-10C4-CONTROLLED-LIVE-ENRICHMENT-CONTRACT.md` §4, §11, §13 — read it before ever
authorizing a live run. This section is the short operator-facing version.

**What the canary is, exactly:** one operator-authorized, MANUAL-lane enrichment run against
`greynoise` only, for the single approved benign subject `1.1.1.1` (Cloudflare's public DNS
resolver), in a **disposable local stack**, with `GREYNOISE_MANUAL_DAILY_BUDGET=1` — a budget of
**exactly one** reservation — followed by a mandatory, verified return to default-off.

#### Run the preflight

```bash
docker compose run --rm backend node src/scripts/enrichmentCanaryPreflight.js
# equivalently, from inside that same container/process:
npm run preflight:canary
```

**Must run inside the same container/process that will boot the worker.** The preflight reads
`backend/src/config/env.js` — the identical, once-resolved config object the worker itself
consumes — so a preflight run from a different shell validates a *different* environment and
proves nothing about the one that will actually spend quota.

#### What PASS means

Every one of the contract's seventeen assertions (P1-P17) held at the moment the preflight ran:
the worker switch and AUTOMATIC lane are off, only `greynoise` is credentialed, its MANUAL budget
is explicitly `1` (not blank — blank means **unlimited**, never zero), every other provider's
MANUAL budget is explicitly `0`, every AUTOMATIC budget is `0`, the worker batch size is `1`, the
database has zero prior greynoise reservations/jobs/enrichment rows on any day, exactly one
Finding exists and it is `1.1.1.1`, enough time remains before UTC midnight (the budget bucket
resets then), the resolved database is named as a disposable canary database, the legacy
IOC batch path is closed (`IOC_ENRICHMENT_PROVIDER=mock`), and no Phase-8D live-smoke opt-in is
armed.

#### What PASS does NOT mean

- It does **not** mean the canary has run, or that a provider has been contacted.
- It does **not** authorize the canary by itself — a human operator still decides to proceed.
- It does **not** prove the legacy synchronous provider routes (`POST
  /api/findings/:id/enrichment/{greynoise,censys,shodan,netlas}`) are safe or disabled — those
  routes are armed by the credential alone and consult no switch in this preflight or in the
  worker (contract §3.2). P13 only detects whether one has *already* fired before the canary
  starts; nothing in this repository currently prevents a deliberate hand-made request to one
  during the canary window. No frontend code calls them.
- It does **not** re-run automatically. Re-run it immediately before C5 (worker enablement) if any
  time has passed, especially near UTC midnight.

#### Safe environment preparation

1. Stand up a **disposable** local PostgreSQL, apply migrations, and seed exactly **one** Finding
   with indicator `1.1.1.1`. Name the database so it carries the string `canary` (e.g.
   `threatnexus_canary`) — the preflight's P15 checks for this naming convention as a sanity check
   against accidentally pointing the canary at a shared or long-lived database. This is a
   convention, not a cryptographic guarantee: it does not replace operator discipline about which
   database the disposable stack actually points at.
2. Export `GREYNOISE_API_KEY` into the shell that will launch the stack (or a git-ignored local
   `.env`). **Never** paste it into a chat, an agent session, or any file that gets committed.
3. Set `GREYNOISE_MANUAL_DAILY_BUDGET=1` explicitly. Set every other `*_MANUAL_DAILY_BUDGET=0`
   explicitly, including `NVD_MANUAL_DAILY_BUDGET=0` and `ABUSEIPDB_MANUAL_DAILY_BUDGET=0` — a
   blank value is **unlimited**, not disabled.
4. Leave `AUTO_ENRICHMENT_ENABLED=false` and `ENRICHMENT_WORKER_ENABLED=false` until the preflight
   passes. `ENRICHMENT_WORKER_ENABLED` is read once at process boot — enabling it later requires a
   **restart**.
5. Set `ENRICHMENT_WORKER_BATCH_SIZE=1` and leave every other worker-runtime variable at its
   default.
6. Leave `IOC_ENRICHMENT_PROVIDER=mock` (the default) and every `LIVE_*_SMOKE` variable unset.

#### One-call cap and GreyNoise-only constraint

The canary is bounded to **exactly one** outbound request, to **exactly one** provider
(`greynoise`), against **exactly one** subject (`1.1.1.1`) — see contract §10. `shodan`, `netlas`,
`censys`, `abuseipdb` and `nvd` are not part of this canary and must stay `NOT_CONFIGURED` /
budget-zero throughout (P4/P6). Do not set any other provider's credential during the canary
window.

#### No secret-printing rule

The preflight never reads, prints, compares, or serializes a credential **value** — only the
boolean "is it configured" fact via the existing `isProviderCredentialConfigured` seam, and (where
permitted) the variable **name**. It never dumps `process.env`. Neither should any evidence you
collect by hand: **never** capture `docker inspect`, `docker compose config`, `printenv`,
`/proc/<pid>/environ`, or a shell-history excerpt into any artifact, chat, or ticket — every one of
those holds the plaintext key even though none of them is "the value" literally.

#### Worker restart requirement

`ENRICHMENT_WORKER_ENABLED` is read **once**, at process boot, and there is no runtime toggle —
this is deliberate (contract §9, §16). Enabling the worker for the canary requires a restart;
returning to default-off afterward requires **another** restart. Confirm the worker is genuinely
active by the `enrichment.worker.started` `AuditLog` row, not by log output alone (the audit call
is fire-and-forget — its presence is proof, its absence is not, contract §11 step 2).

#### Legacy-route caveat

The four legacy synchronous provider routes (§3.2 of the contract) are **not** made safe by this
preflight or by this ticket. They bypass `ENRICHMENT_WORKER_ENABLED`, write no `ProviderLookupJob`
or `ProviderLookupAttempt` row, and are armed the moment a credential is set — for the entire
canary window. Their only bound is the provider rate limiter. No frontend code calls them, but a
deliberate hand-made authenticated request can. Preflight P13 and the after-canary evidence
queries (contract §13.1) detect a legacy-path contact by its distinct signature (a
`GreyNoiseEnrichment` row with no matching `ProviderLookupAttempt`, or a `greynoise.lookup.%`
audit row) — they do not prevent one.

#### Rollback / default-off requirement

**The canary is not complete until the environment is verified back to default-off.** Follow
contract §11 in the stated order: restart with `ENRICHMENT_WORKER_ENABLED=false`, confirm no
worker was constructed, confirm readiness reads `EXECUTION_PAUSED`, extract the "after" evidence
**before** tearing anything down, then remove the credential from the shell (and purge the
shell-history entry it left behind), then destroy the disposable database **and its volume**
(`docker compose down -v`) — the volume destruction is what forecloses a UTC-rollover requeue
risk, not tidiness. There is no approved outcome of the canary in which a worker is left running.

#### 10C-5 remains required before broader enablement

A green preflight and a successful canary establish readiness of **this exact bounded run** only.
They do **not** establish that a continuously-running worker, a batch size greater than 1, or any
provider with large/variable responses is safe — the provider response-body read has no size cap
on any path (contract §17). That hardening is Phase 10C-5, a separate ticket, and is required
before any unattended or production-facing enablement.
