# Handoff: TNX-P8-PROVIDER-EVIDENCE-GAPFILL

- From: claude
- Suggested next writer: unassigned
- Branch: feat/phase-8-provider-evidence-gapfill
- Updated: 2026-08-07T00:00:00Z

## Goal

The user asked for a "Phase 8A/8AB secure provider foundation + live NVD adapter": provider
registry, key-safety checks, health/status surfaces, audit logs, quotas, null/mock provider
behavior, tests, CI gates, docs.

## What actually happened this session

Before writing any code, the repository was inspected against that request. Every major deliverable
already existed:

- Two provider registries (`providerRegistry.js` for IOC, `vulnerabilityProviderRegistry.js` for
  vulnerability), each with frozen factory maps and mock/real providers — Phase 2.
- A live `NvdCveProvider`, optional key, safe 404/malformed/timeout/429/5xx handling — Phase 2 (§2B).
- A safe provider-status surface at `GET /api/dashboard/overview` → `sections.providers`, gated on
  `read:dashboard`, zero live calls, tested against this machine's real ambient keys for leakage —
  Phase 6.
- A frontend Settings panel rendering that status (icon+word+color, no fabricated coverage) — Phase 6.
- A shared `provider` rate-limit bucket covering every provider-execution route — Phase 7.
- Secret-hygiene sweeps (`redact.test.js`, `iocEnrichmentSecurity.test.js`,
  `phase7ReleaseSecurity.test.js`) and a DB-backed release gate (`eval:phase7`) that already proves
  no-key startup, zero outbound network calls, and keys unreachable from the frontend bundle.

Building a second, competing provider registry/adapter under a new "Phase 8" ticket would have
duplicated working, tested infrastructure — the exact thing `AGENTS.md` and the build-guard skill
warn against. This was surfaced to the user with file:line evidence before any code was written; the
user chose the smallest honest option: gap-fill only, no rebuild.

## What this ticket actually added

1. `backend/src/scripts/nvdLiveSmoke.js` (`npm run smoke:nvd`) — an opt-in manual NVD live-smoke
   command. Requires `LIVE_NVD_SMOKE=1` explicitly, performs exactly one lookup (CVE-2021-44228),
   never prints `NVD_API_KEY`, never runs in an automated test or CI job.
2. `backend/tests/unit/nvdLiveSmoke.test.js` — proves the opt-in guard rejects before any fetch is
   attempted, and that a successful (mocked) lookup returns only safe normalized fields.
3. `backend/tests/unit/phase8ProviderFoundationEvidence.test.js` — the compact, non-duplicative
   remainder: explicit named assertions that missing `NVD_API_KEY`/`ABUSEIPDB_API_KEY` never break
   startup while `JWT_SECRET` absence still fails fast, that both registries expose exactly their
   documented provider names, that the vulnerability error-code contract is closed and distinct, that
   a single positive provider rate-limit budget exists, and that the smoke script cannot run
   unattended. No new `eval/run_phase8_gate.js` was written — the DB-backed invariants it would have
   re-proven are already proven by `eval:phase7` and the existing unit suite; a new heavy gate would
   have been redundant, not stronger.
4. Docs: README ("External providers" section gained a pointer to the status surface and the smoke
   command), `docs/ai/SECURITY.md` gained a "Provider foundation (Phase 8 evidence)" section citing
   every claim above by file, `docs/ai/STATE.yaml` updated.

## Validation

See `docs/ai/STATE.yaml` → `validation` for the exact commands run and their results.

## Honest gaps

- No standalone `/api/providers/status` REST endpoint exists — status is only served embedded in
  `GET /api/dashboard/overview`. Not built this session; flagged as a possible future addition if a
  consumer other than the dashboard/Settings page needs it.
- The prompt's literal error-code names (`PROVIDER_NOT_CONFIGURED`, `PROVIDER_AUTH_FAILED`,
  `PROVIDER_BAD_RESPONSE`) don't exist verbatim; the existing closed set
  (`PROVIDER_DISABLED`/`PROVIDER_INVALID_KEY`/`PROVIDER_REJECTED`) covers the same cases under
  different names. Documented in SECURITY.md rather than renamed, to avoid unforced churn to a
  tested, working enum.
- The manual NVD live smoke was **not executed** against the real NVD API this session (no
  authorization was given to do so); it is implemented, unit-tested with a mocked fetch, and
  documented as available.
- `docs/codex/` remains untracked and untouched, per the one-writer boundary.

## Recommended next phase

A genuinely new "Phase 8" would be adding a **second** live provider behind the existing IOC or
vulnerability registry (the pattern already supports it additively — see `PROVIDER_FACTORIES` in
either registry file), or resolving Shadowserver access/licensing terms before any Shadowserver work
is attempted. Neither is started here.

## Protected boundaries

- Do not redo completed work without evidence.
- Do not change architecture without updating `DECISIONS.md`.
- Do not expose secrets or absorb unrelated changes.
- `docs/codex/` is a foreign path this session did not touch — leave it alone unless its owner asks.
