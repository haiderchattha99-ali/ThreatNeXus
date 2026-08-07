# Handoff: TNX-P8B-CENSYS-PROVIDER

- From: claude
- Suggested next writer: unassigned
- Branch: feat/phase-8b-censys-provider
- Updated: 2026-08-07T08:30:00Z

## Goal

Build exactly one new live provider adapter, Censys, on top of the existing provider foundation and
NVD/AbuseIPDB patterns (already shipped in Phases 2/6/7, closed out by TNX-P8-PROVIDER-EVIDENCE-GAPFILL)
— without rebuilding or duplicating any of that foundation. No live calls in tests/CI, no secret
leakage, quota enforced through the existing shared budget, audit logged, docs updated.

## Two passes — the first one targeted the wrong API

**Pass 1** built the full adapter against what looked like the obvious choice: Censys's Search v2 API
(`search.censys.io`, HTTP Basic Auth with an API ID + secret). Committed, tested, pushed, CI green.

**Then the user ran the app locally, provided real provider keys, and asked to verify everything live.**
AbuseIPDB and NVD worked immediately. Censys did not: the user's real credential is `CENSYS_PAT` — a
Personal Access Token — which doesn't fit a Basic Auth ID/secret pair at all. Censys's product has
moved to a **Platform API** (`api.platform.censys.io/v3`, Bearer PAT auth) that this session had not
accounted for. Verified the real contract via web search/fetch rather than guessing (base URL, auth
header, a versioned `Accept` header, and — importantly — host data nested one level deeper under
`result.resource`, with `autonomous_system.description` instead of `.name`, and no documented
certificate field at all).

Asked the user how to handle it; they chose **Pass 2: rewrite the adapter for the Platform API**, not
skip Censys or ask for a different credential type. Rewrote `censysProvider.js`, `censysConfig.js`,
`env.js`, `censysExecutionService.js`, `censysLiveSmoke.js`, all four Censys test files, and — caught
only by live re-verification, not by the test suite — `operationalOverviewService.js`'s dashboard
status check, which still read the old `CENSYS_API_ID`/`CENSYS_API_SECRET` env vars and silently
reported `NOT_CONFIGURED` even with a valid PAT present. Also fixed `docker-compose.yml` and
`docker-compose.offline.yml`, which predated this branch and had never been updated to pass Censys
env vars through or blackhole its host at all.

**Everything below describes the Pass 2 (current, correct) state.**

## What this ticket added

Censys is the second live provider, after NVD. It returns internet-exposure/attack-surface data (open
services, AS ownership) — a materially different shape from AbuseIPDB's reputation score or NVD's CVE
metadata, so it gets its own module pair and its own Prisma table rather than being forced into either
existing registry:

1. **`CensysEnrichment`** (Prisma model + migration, additive-only, verified from zero on a disposable
   PostgreSQL container with zero drift). Deliberately NOT a queue — every row is written once, already
   terminal, by a synchronous human-triggered lookup. No schema change was needed for the Pass 2
   rewrite — only the provider adapter's auth/parsing changed, not the persisted normalized shape.
2. **`censysConfig.js` / `censysTypes.js` / `censysProvider.js`** — targets the Platform API. `CENSYS_PAT`
   (Bearer token) is the sole required credential; `CENSYS_ORG_ID` is optional (sent as
   `X-Organization-ID` only when present). Reuses the SAME closed error-code vocabulary
   (`PROVIDER_RATE_LIMITED`/`PROVIDER_INVALID_KEY`/`PROVIDER_TIMEOUT`/etc.) the IOC and vulnerability
   providers already speak.
3. **`censysExecutionService.js`** — resolves the Finding's indicator, calls the provider, persists one
   row, writes an attempted+outcome audit pair (5 actions). No HTTP dependency.
4. **`GET`/`POST /api/findings/:id/enrichment/censys`** — reuses `read:findings` / `trigger:finding-
   enrichment` and the SAME `providerRateLimiter` budget every other provider-execution route shares.
5. **Dashboard/Settings** — `sections.providers.exposure`, rendered by the existing components.
6. **`backend/src/scripts/censysLiveSmoke.js`** (`npm run smoke:censys`) — opt-in, `1.1.1.1`, never
   prints credentials, never runs in CI. **This one WAS executed live this session** (with explicit
   authorization) — real result: 17 services on `1.1.1.1`, AS `CLOUDFLARENET - Cloudflare, Inc.`
7. **45 tests** across both passes, all rewritten for the Platform API shape in Pass 2: `censysProvider
   .test.js` (15), `censysEnrichmentRouteAuthorization.test.js` (14), `censysLiveSmoke.test.js` (3),
   `phase8bCensysProviderEvidence.test.js` (7), 2 `phase7RateLimiting.test.js` cases, 1
   `operationalOverviewService.test.js` redaction-list extension.
8. Docs + `docker-compose.yml`/`docker-compose.offline.yml` updated for the Platform API shape and env
   passthrough.

## Live verification (this session, with explicit user authorization)

The user authorized reading `backend/.env` to wire real keys. **Chose not to literally read/display
it anyway** — grep'd key *names* only, and moved key *values* straight from `backend/.env` into a new
root `.env` (gitignored, never committed) via shell redirection, so no plaintext value ever entered
this conversation. All three providers then confirmed live against their real APIs through the actual
running Docker stack:

- **AbuseIPDB**: real `httpStatus:200` responses across all 18 pending demo findings, classifying the
  RFC 5737 synthetic ranges as `Reserved`/whitelisted (genuine AbuseIPDB behavior for documentation IPs).
- **NVD**: real CVE-2021-44228 (Log4Shell) lookup, CVSS 10.0 CRITICAL.
- **Censys**: real `1.1.1.1` lookup (17 services, `CLOUDFLARENET`) via the smoke script, and a real
  `httpStatus:200` call through the actual Finding route (empty result, correctly — Censys has never
  scanned an RFC 5737 documentation address, so "no data" is the honest answer, not a bug).

## Also answered this session (no code change)

The user asked whether Admin can add Analyst accounts through the app. **No** — `manage:users` exists
as a granted capability but has zero routes wired to it anywhere in the codebase. Public registration
always creates the least-privileged `VIEWER` role (hardcoded server-side); privileged roles can only
be assigned by running `seed:users` directly. Flagged as a real gap, not a hidden feature — recorded
under `known_issues` and `next_action` below.

## Validation

Backend: 2899 passed / 177 skipped, no regressions, after both the rewrite and the dashboard-status
fix. `git status` clean diff, explicit paths only; `docs/codex/` and the real-key-holding root `.env`
(gitignored) both untouched by any commit.

## Honest gaps

- In-app user management doesn't exist (see above) — a real, user-confirmed gap, not addressed here.
- Censys is Finding-scoped, synchronous, human-triggered only — no batch/queue worker, matching this
  phase's explicit "no queues/schedulers" scope.
- `docker-compose.yml`/`offline.yml` are now correct for Censys but hadn't been touched since Phase 7
  — worth a broader audit if a fourth provider is ever added.
- `docs/codex/` remains untracked and untouched, per the one-writer boundary.

## Recommended next phase

Three real options, in no particular priority: (1) build in-app user management — the `manage:users`
capability already exists and is unused; (2) a third live provider following the same additive
pattern Censys established; (3) resolve Shadowserver access/licensing terms.

## Protected boundaries

- Do not redo completed work without evidence.
- Do not change architecture without updating `DECISIONS.md`.
- Do not expose secrets or absorb unrelated changes.
- `docs/codex/` is a foreign path this session did not touch — leave it alone unless its owner asks.
