# Handoff: TNX-P8B-CENSYS-PROVIDER

- From: claude
- Suggested next writer: unassigned
- Branch: feat/phase-8b-censys-provider
- Updated: 2026-08-07T00:00:00Z

## Goal

Build exactly one new live provider adapter, Censys, on top of the existing provider foundation and
NVD/AbuseIPDB patterns (already shipped in Phases 2/6/7, closed out by TNX-P8-PROVIDER-EVIDENCE-GAPFILL)
— without rebuilding or duplicating any of that foundation. No live calls in tests/CI, no secret
leakage, quota enforced through the existing shared budget, audit logged, docs updated. Shadowserver
and every other provider stay unintegrated.

## Start-gate finding, before any code was written

The mandatory start gate required verifying the prior `TNX-P8-PROVIDER-EVIDENCE-GAPFILL` branch was
merged into `main` before branching. It was not — no PR had been opened for it. Per the user's own
rule ("if not merged, stop and report; do not cherry-pick silently"), this was reported rather than
silently resolved. The user chose to open a PR (#9) and merge it immediately, so this ticket's branch
starts from an updated `main` (`4fb373c`) that already includes the gap-fill work.

## What this ticket added

Censys is the second live provider, after NVD. It returns internet-exposure/attack-surface data (open
services, AS ownership) — a materially different shape from AbuseIPDB's reputation score or NVD's CVE
metadata, so it gets its own module pair and its own Prisma table rather than being forced into either
existing registry:

1. **`CensysEnrichment`** (Prisma model + migration `20260807000000_add_phase8b_censys_exposure_enrichment`,
   additive-only, verified from zero on a disposable PostgreSQL container with zero drift). Deliberately
   NOT a queue — no PENDING/lease/retry/dead-letter — every row is written once, already terminal, by a
   synchronous human-triggered lookup. This phase's scope explicitly excludes queues/schedulers.
2. **`censysConfig.js` / `censysTypes.js` / `censysProvider.js`** — a self-contained adapter mirroring
   `abuseIpdbProvider.js`'s defensive HTTP shape (composed timeout+caller-signal, every expected outcome
   mapped to a normalized, deep-frozen result, never throws for an expected outcome). Basic Auth from
   `CENSYS_API_ID`+`CENSYS_API_SECRET`, both required together — one alone is `NOT_CONFIGURED`, never a
   half-configured state. Reuses the SAME closed error-code vocabulary
   (`PROVIDER_RATE_LIMITED`/`PROVIDER_INVALID_KEY`/`PROVIDER_TIMEOUT`/etc.) the IOC and vulnerability
   providers already speak.
3. **`censysExecutionService.js`** — resolves the Finding's indicator, calls the provider, persists one
   row, writes an attempted+outcome audit pair (5 actions: attempted/succeeded/failed/unavailable/
   rate_limited). No HTTP dependency, mirrors `enrichmentExecutionService.js`'s shape.
4. **`GET`/`POST /api/findings/:id/enrichment/censys`** — reuses the existing `read:findings` /
   `trigger:finding-enrichment` capabilities and the SAME `providerRateLimiter` budget every other
   provider-execution route already shares (proven: a caller cannot get a bigger effective budget by
   switching routes). `phase7RouteCensus.test.js`'s structural walk covers both routes automatically.
5. **Dashboard/Settings** — `sections.providers.exposure` (new array, parallel to `.ioc`/`.vulnerability`),
   rendered by the EXISTING Settings/DashboardSections components with zero new UI vocabulary
   (`CONFIGURED`/`NOT_CONFIGURED` already existed in `Settings.jsx`'s status dictionary).
6. **`backend/src/scripts/censysLiveSmoke.js`** (`npm run smoke:censys`) — opt-in via
   `LIVE_CENSYS_SMOKE=1`, one lookup against `1.1.1.1` (Cloudflare's public DNS resolver, permanent
   public infrastructure, never a customer/victim asset), never prints credentials, never runs in CI.
7. **41 new/updated tests**: `censysProvider.test.js` (15), `censysEnrichmentRouteAuthorization.test.js`
   (14 — full route→controller→service→provider chain with a faked `globalThis.fetch`),
   `censysLiveSmoke.test.js` (3), `phase8bCensysProviderEvidence.test.js` (7), plus 2 new
   `phase7RateLimiting.test.js` cases and a redaction-assertion extension in
   `operationalOverviewService.test.js`. Two pre-existing test mock clients needed a
   `censysEnrichment.aggregate` stub added — caught by running the full suite, not assumed.
8. Docs: README ("External providers" table gained a Censys row + the smoke command),
   `docs/ai/SECURITY.md` gained a "Censys — the second live provider (Phase 8B)" subsection,
   `backend/.env.example` gained the `CENSYS_*` block.
9. `.github/workflows/ci.yml` — the "migration count and order match the reviewed history" job pins
   an exact migration-directory list on purpose, specifically to catch a silent migration change; it
   correctly failed on the first push because this ticket's migration folder wasn't in that list yet.
   Fixed in the same PR (commit `fd297ef`), per the guard's own instruction.

## Validation

See `docs/ai/STATE.yaml` → `validation`. Backend: 2899 passed / 177 skipped (2858 baseline + exactly
41 new tests, no regressions). Frontend: 143/143 unchanged. Prisma: migrate-from-zero, validate, and
`--exit-code` drift check all pass against a real, disposable PostgreSQL 16 container. Pushed at
commit `fd297ef`; GitHub Actions run
[31155494175](https://github.com/haiderchattha99-ali/ThreatNeXus/actions/runs/31155494175) is green
(Secrets/artifact scan, Backend tests, Frontend lint/tests/build, Prisma schema/migration history,
Core evaluators, Browser suite Chromium; Mutation/concurrency gates remain manual by design).

## Honest gaps

- The manual Censys live smoke was **not executed** against the real Censys API this session (no
  authorization was given to do so); implemented and unit-tested with a mocked fetch only.
- Censys is Finding-scoped, synchronous, and human-triggered only — no batch/queue worker exists for
  it (matches this phase's explicit "no queues/schedulers" scope), so unlike IOC/vulnerability
  enrichment it cannot be bulk-run across many Findings in one call.
- `docs/codex/` remains untracked and untouched, per the one-writer boundary.

## Recommended next phase

A third live provider (Shodan/Netlas/GreyNoise/VirusTotal/OTX/MISP) following the same additive
pattern Censys just established, or resolving Shadowserver access/licensing terms before any
Shadowserver work is attempted. Neither is started here.

## Protected boundaries

- Do not redo completed work without evidence.
- Do not change architecture without updating `DECISIONS.md`.
- Do not expose secrets or absorb unrelated changes.
- `docs/codex/` is a foreign path this session did not touch — leave it alone unless its owner asks.
