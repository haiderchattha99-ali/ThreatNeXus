# Handoff: TNX-P8D-GREYNOISE-PROVIDER

- From: claude
- Suggested next writer: claude (in progress)
- Branch: feat/phase-8d-greynoise-provider
- Updated: 2026-08-07T12:20:00Z

## Phase 8C.1 closure note

`feat/phase-8c1-ai-assistance-frontend` is merged into `main` via PR #13 (`88a2c48`). This ticket
branches from that updated tip.

## Goal

Add exactly one new live provider, GreyNoise, for IP noise/reputation/context using the existing
provider foundation and Censys/NVD patterns. No live calls in CI/tests, no secret leakage, provider
rate-limit/audit/status support, optional manual smoke, docs/ai handoff, and green CI.

## The one design decision that mattered most

GreyNoise's data (noise/classification/actor context) doesn't fit `IocEnrichment`'s AbuseIPDB-shaped
columns (`abuseConfidenceScore`, `totalReports`, `isWhitelisted`, ...) any more than Censys's
open-services/AS-ownership data did. So this ticket mirrors Censys exactly: its own table
(`GreyNoiseEnrichment`), its own module set (`services/reputation/`), no queue (synchronous,
human-triggered lookups only) — rather than forcing GreyNoise into AbuseIPDB's registry/table shape to
save a migration.

The dashboard status wiring got the same treatment: rather than folding GreyNoise into the existing
`sections.providers.exposure` array (the smaller diff), it's a new sibling array,
`sections.providers.reputation` — GreyNoise is neither exposure/attack-surface data nor the single
selected ioc-reputation slot (`sections.providers.ioc`, a config CHOICE between mock/abuseipdb, not an
additive list). This is the same per-domain-array pattern Censys itself established for `exposure`,
applied consistently. The frontend change to surface it was one line in each of `Settings.jsx` and
`DashboardSections.jsx` — both already render providers as a flattened list regardless of which backend
array they came from.

## What this ticket added

1. **`GreyNoiseEnrichment`** (Prisma model + enum, additive-only migration, verified via `prisma
   validate`/`prisma generate`).
2. **`backend/src/services/reputation/`** — `greyNoiseTypes.js`, `greyNoiseConfig.js`,
   `greyNoiseProvider.js` (Community API, `key` header auth — not Bearer, not Basic — IPv4 only since no
   IPv6 validator exists anywhere in this codebase to extend safely), `greyNoiseExecutionService.js`.
   All mirror `censysProvider.js`/`censysExecutionService.js`'s exact defensive shape.
3. **`GET`/`POST /api/findings/:id/enrichment/greynoise`** — reuses `read:findings` /
   `trigger:finding-enrichment` (no new capability) and the SAME `providerRateLimiter` budget every
   other provider-execution route shares.
4. **`backend/src/scripts/greyNoiseLiveSmoke.js`** (`npm run smoke:greynoise`), opt-in via
   `LIVE_GREYNOISE_SMOKE=1`. **Not executed this session** — not authorized.
5. **Dashboard**: new `sections.providers.reputation` array; `Settings.jsx`/`DashboardSections.jsx`
   updated with one line each.
6. **`docker-compose.yml`/`docker-compose.offline.yml`** updated for `GREYNOISE_API_KEY` passthrough and
   the offline blackhole host.
7. **40 new/updated tests** (see `docs/ai/STATE.yaml` `completed` for the breakdown). Full backend
   suite: **2990 passed / 177 skipped**, zero regressions from the 2950 baseline.

## Two real regressions this ticket's own tests caught (in existing tests, not new code)

Adding the `reputation` section to `buildProvidersSection`'s output broke two pre-existing tests:
- `operationalOverviewService.test.js`'s roll-up-total assertion (`summary.total`) didn't account for
  the new array — fixed by adding `+ reputation.length`.
- `riskFactorPressure.test.js` has its own separate Prisma fake, which was missing a
  `greyNoiseEnrichment.aggregate` stub entirely — the whole `providers` dashboard section failed with a
  `TypeError` as a result (caught gracefully by the Phase 6 availability contract, but the test still
  failed because `liveLookupPerformed` was undefined on a failed section). Fixed by adding the stub,
  mirroring the existing `censysEnrichment` one.

Both are exactly the kind of thing a full test-suite run before committing is for.

## Honest gaps

- **Manual live GreyNoise smoke was not run** — awaiting explicit user authorization, per instruction.
- `F-drive start-task.ps1` throws against this repo's `STATE.yaml` schema — worked around, not fixed,
  same known gap as Phases 8C/8C.1.
- `docs/codex/` remains untracked and untouched, per the one-writer boundary.

## Recommended next phase

Per this ticket's own instruction: Shodan or Netlas as the next live provider, following this exact
same pattern (own table, own module set, no queue, shared rate-limit budget, dashboard sibling array).

## Protected boundaries

- Do not redo completed work without evidence.
- Do not change architecture without updating `DECISIONS.md`.
- Do not expose secrets or absorb unrelated changes.
- `docs/codex/` is a foreign path this session did not touch — leave it alone unless its owner asks.
- `backend/.env` (and any non-`.env.example` env file) must never be read, printed, or committed.
- AbuseIPDB, NVD, and Censys are untouched and unaffected — verified by registry-isolation tests.
