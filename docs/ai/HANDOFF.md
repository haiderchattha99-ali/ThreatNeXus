# Handoff: TNX-P8E-SHODAN-PROVIDER

- From: claude
- Suggested next writer: claude (in progress)
- Branch: feat/phase-8e-shodan-provider
- Updated: 2026-08-09T12:50:00Z

## Phase 8D closure note

`feat/phase-8d-greynoise-provider` is merged into `main` via PR #14 (`b1a3602`). This ticket branches
from that updated tip.

## Goal

Add exactly one new live provider, Shodan, for exposed-service/banner/port intelligence, using the
existing provider foundation and Censys/GreyNoise patterns. No live calls in CI/tests, no secret
leakage, provider rate-limit/audit/status support, optional manual smoke, docs/ai handoff, and green CI.

## This session resumed an interrupted one

The previous session hit its usage limit mid-ticket. It left substantial, largely correct work on disk
uncommitted: the full backend surface, Prisma model + migration, docker-compose/CI/README/
`.env.example`/`SECURITY.md` already written, dashboard wiring done, ~40 tests already written. This
session's job was to verify it, not redo it.

**What it also left behind: leftover debug instrumentation**, mid-investigation of a real question (why
did `buildProviderConfig` see a live-length `ABUSEIPDB_API_KEY` with no `fetchImpl`?). Five files had raw
`require("fs").appendFileSync(...)` calls writing to `C:/Users/LENOVO/Desktop/debug-envload.log` and
`debug-summary.log` — **both outside the repo** — in `backend/src/config/env.js` (two spots),
`backend/tests/setup.js`, `backend/src/services/enrichment/enrichmentRuntime.js`, and
`backend/src/services/enrichment/enrichmentExecutionService.js`. All five removed, both stray log files
deleted.

The question itself resolved cleanly: `backend/.env` on this machine carries the developer's real
AbuseIPDB/NVD keys (already-documented gotcha — see `phase6ReadRouteAuthorization.test.js`'s own
comment on the same fact). The debug trail's stack pointed at a plain `require`/manual-script path, not
a Vitest suite — every actual test file already stubs Prisma/fetch and sets `TNX_SKIP_DOTENV` correctly.
Not a test-harness bug; nothing in the Shodan test suite was affected.

## The one design decision that mattered most

Shodan's data (exposed services, banners, open ports) **is** the same "internet exposure / attack
surface" domain `sections.providers.exposure` already represents for Censys — unlike GreyNoise, which
got its own sibling array in Phase 8D because reputation/noise context is a different domain. So Shodan
joins `exposureProviders` as a **second entry**, not a new array. This needed zero frontend changes:
`Settings.jsx`/`DashboardSections.jsx` already spread `...(providers.exposure || [])` generically.

`ShodanEnrichment` still gets its own table (not a bolt-on to `CensysEnrichment`): Shodan's
hostnames/organization/isp/geo/per-service banners/CVE-id shape is materially different from Censys's
services/AS-ownership columns — same reasoning that already keeps `GreyNoiseEnrichment` separate from
both.

## What this ticket added

1. **`ShodanEnrichment`** (Prisma model + enum, additive-only migration, verified via `prisma
   validate`/`prisma format`/`prisma migrate deploy`/`prisma migrate diff --exit-code` — no drift).
2. **`backend/src/services/exposure/`** — `shodanTypes.js`, `shodanConfig.js`, `shodanProvider.js`
   (Shodan REST API, `key` **query-parameter** auth — its own documented scheme, no header option — IPv4
   only, closed CVE-id format guard), `shodanExecutionService.js`. All mirror
   `censysProvider.js`/`censysExecutionService.js`'s exact defensive shape.
3. **`GET`/`POST /api/findings/:id/enrichment/shodan`** — reuses `read:findings` /
   `trigger:finding-enrichment` (no new capability) and the SAME `providerRateLimiter` budget every other
   provider-execution route shares.
4. **`backend/src/scripts/shodanLiveSmoke.js`** (`npm run smoke:shodan`), opt-in via
   `LIVE_SHODAN_SMOKE=1`, against `8.8.8.8`. **Not executed this session** — not authorized.
5. **Dashboard**: Shodan joins `sections.providers.exposure` as a second entry. Zero frontend diff.
6. **`docker-compose.yml`/`docker-compose.offline.yml`** updated for `SHODAN_API_KEY` passthrough and the
   offline blackhole host.
7. **~40 new/updated tests** (see `docs/ai/STATE.yaml` `completed` for the breakdown). Full backend
   suite: **3030 passed / 177 skipped**, zero regressions from the 2990 baseline.

## Verification this session actually ran

- `prisma format` (fixed one field-alignment issue on the new model), `prisma validate` — clean.
- `prisma migrate deploy` against the local dev Postgres (was 2 migrations behind — 8D and 8E both
  applied cleanly), `prisma migrate diff --exit-code` — zero drift, `prisma generate` — clean.
- Full backend suite. First run showed 7 unrelated integration files failing on a `beforeAll` hook
  timeout (`auth.test.js`, `attackNavigatorRouteAuthorization`, `caseWorkflowRouteAuthorization`,
  `notificationRouteAuthorization`, `ownershipRouteAuthorization`, `resourceRouteAuthorization`,
  `vulnerabilityPacketBRouteAuthorization`) — reproduced as pure CPU contention from cold-transforming
  all 142 files in parallel on this machine, not a regression: all 7 pass clean in isolation (370
  tests). None touch Shodan.
- The Shodan-specific suite run directly and in isolation: 99/99 passed.

## CI result

Not yet pushed as of this checkpoint — see `docs/ai/STATE.yaml` `next_action`. The prior session never
committed; this session cleaned the diff and verified it locally but has not yet pushed/watched CI.

## Honest gaps

- **Manual live Shodan smoke was not run** — awaiting explicit user authorization, per instruction.
- `F-drive start-task.ps1` throws against this repo's `STATE.yaml` schema — worked around, not fixed,
  same known gap as Phases 8B/8C/8C.1/8D.
- `docs/codex/` remains untracked and untouched, per the one-writer boundary.
- CI has not yet been run against this push — do not treat this ticket as closed until it's green.

## Recommended next phase

Netlas, following this exact same pattern (own table if the data shape doesn't fit, own module set, no
queue, shared rate-limit budget, dashboard array placed by data-domain not by habit).

## Protected boundaries

- Do not redo completed work without evidence.
- Do not change architecture without updating `DECISIONS.md`.
- Do not expose secrets or absorb unrelated changes.
- `docs/codex/` is a foreign path this session did not touch — leave it alone unless its owner asks.
- `backend/.env` (and any non-`.env.example` env file) must never be read, printed, or committed.
- AbuseIPDB, NVD, Censys, and GreyNoise are untouched and unaffected — verified by registry-isolation
  tests.
