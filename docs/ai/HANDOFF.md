# Handoff: TNX-P7-RELEASE-CANDIDATE

- From: claude
- Suggested next writer: unassigned
- Branch: feat/phase-7-release-candidate
- Verified code checkpoint: ea977459313c5c2e257a823441e303ee5fb45139
- Updated: 2026-08-06T09:45:00Z

## Goal

Continue ThreatNeXus Phase 7 from the paused Claude state and finish the release-candidate
hardening deliverable end to end: browser matrix, Docker/offline proof, CI, docs/ai handoff, final
checkpoint, and evidence report. Preserve all existing Phase 7 work.

## Completed and current state

Phase 7 was already substantially built before this session (rate limiting, route census, release
security tests, the Phase 7 evaluator, the three clean-stack Docker fixes) at checkpoint `8d8f535`.
This session's job was to close the one thing the paused session had identified but not yet fixed —
the Chromium browser matrix failing 12/42 against the new auth rate limiter — and then carry the
whole deliverable to a pushed, green CI run.

Root cause: the auth limiter's default budget (30 requests / 15 minutes) correctly refuses the
Chromium suite's dozens of real sign-ins across four roles inside a few minutes — that traffic shape
is indistinguishable from credential stuffing. Fix: a disposable `RATE_LIMIT_AUTH_MAX=1000` override
on the CI e2e job's backend-start step only, mirroring the override guidance docker-compose.yml
already documented for local runs. Production defaults were not touched.

Also closed two real coverage gaps the release checklist named and the existing 42-test suite did
not cover: Findings had appeared only in the responsive overflow sweep, and Upload had no coverage
at all. `frontend/e2e/findingsUpload.spec.js` adds three tests (browse to a Finding, submit a report
and see a truthful lifecycle result, VIEWER denied the route in place with session intact) — suite is
now 45/45.

Re-ran the full local gate (Prisma, migrate-from-zero + drift, ATT&CK catalogue, backend against real
PostgreSQL, all nine evaluators plus two mutation gates, frontend lint/test/build) and re-proved the
Docker clean-stack and offline-rehearsal claims from a fresh disposable worktree at this checkpoint,
including a live measurement of the default (unoverridden) rate limiter refusing at the 31st rapid
auth attempt. Pushed the branch and watched GitHub Actions run `31089169913` to a green conclusion.

Read Git history and the committed diff through `ea97745`. Validation recorded in `STATE.yaml` should
be rerun by an incoming writer before new edits if meaningful time has passed.

## Exact next action

None required to close this ticket — Phase 7 release-candidate hardening is complete, pushed, and
green in CI. No PR was opened and `main` was not touched, per the task boundary. If further work
begins (Phase 8, or additional Phase 7 follow-up), the next writer should start from a fresh
writer-lock acquisition against checkpoint `ea97745` on `feat/phase-7-release-candidate`.

## Protected boundaries

- Do not redo completed work without evidence.
- Do not change architecture without updating `DECISIONS.md`.
- Do not expose secrets or absorb unrelated changes.
- `docs/codex/` is a foreign path this session did not touch — leave it alone unless its owner asks.
