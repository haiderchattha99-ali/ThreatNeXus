# Handoff: TNX-P10C1-TRUTHFUL-TERMINAL-STATES

- From: claude
- Branch: `feat/phase-10c1-truthful-terminal-states`
- Worktree: `F:\AI-Worktrees\ThreatNeXus\phase-10c1`
- Starting commit: `13f7e24` (origin/main — Phase 10B merge, PR #22)
- Updated: 2026-08-16
- Status: **ready_for_pr — Tier-2 verification/delivery stage complete**

## What this delivers

`GET /api/findings/:id/enrichment/summary` previously collapsed materially
different provider truths into the same look. This ticket makes the six
defects the design gate found truthful, using only data the service already
reads — zero new write sites:

- A positive result (`SUCCEEDED` / IOC `SUCCESS`) is now distinct from
  "queried, nothing on file" (new `NO_RECORD` status; was collapsed into
  `COMPLETED`).
- A recognized rate limit (`errorCode === "PROVIDER_RATE_LIMITED"`) and a
  post-contact ambiguity (`terminalReasonCode === "AMBIGUOUS_AFTER_CONTACT"`)
  are now distinct from a generic technical failure (new `RATE_LIMITED` /
  `AMBIGUOUS` statuses; both were collapsed into `UNAVAILABLE`).
- A terminal Phase-10 job (e.g. dead-lettered on ambiguity) can no longer read
  `PENDING` forever just because its linked delegate row was deliberately left
  `PENDING` by the runner (which still holds the live claim). `source` reports
  `ORCHESTRATION_JOB` when this precedence applies.
- Every skipped row now carries a truthful, closed-vocabulary `skipReason` —
  including the four execution-time causes and the two IOC-derived ones that
  previously rendered `null`.
- `evidenceAvailable` is unconditionally `false` on a `VULNERABILITY_ENRICHMENT`
  row: this layer never reads `VulnerabilityProviderStatus` or its freshness
  horizon, so orchestration-job completion alone can never prove per-source
  positive evidence exists.
- `rollUp`'s precedence array is now proven complete (covers every
  `SUMMARY_STATUSES` value) with a safe most-unsettled fallback, replacing the
  old `|| statuses[0]` fail-open behavior.

Frontend: `FindingEnrichmentPanel.jsx`'s stale notice no longer requires
`status === 'COMPLETED'` (a stale `NO_RECORD` row now shows it too), and
`findingEnrichment.js` gained labels for the new statuses/skip reasons.

## Design gate (prior session, not repeated here)

`backend-logic-reviewer` found 6 P1s on the original draft. All closed in v3.
A surgical re-check found one remaining P1 (P1-1: `VULNERABILITY_ENRICHMENT`
`evidenceAvailable` scope) and one non-blocking P2 (provenance on terminal-job
precedence). Both closed in v4. Final narrow closure check: **READY**. Full
history and the binding contract text live in
`docs/ai/PHASE-10C1-TRUTHFUL-TERMINAL-STATES-CONTRACT.md` — read that before
touching this surface again, not this file.

## Implementation checkpoint (prior stage, not repeated here)

Committed `9ac0ec7`: the full backend read-model split plus the two bounded
frontend fixes. 44/44 focused tests green at that point. Full detail in the
commit message and the contract's "Implementation record" section.

## Verification/delivery stage (this session)

- **Full backend suite against real PostgreSQL**, CI-equivalent env, 25
  migrations from empty: 2900 passed in the parallel run, 613 skipped, 7 files
  timed out on `beforeAll` hooks under local parallel-file CPU contention (a
  documented trap — many files' `bcrypt.hash()` calls in `beforeAll` exceeding
  the 10s hook timeout when several run concurrently on a loaded dev box, not
  a regression). Reran those 7 in isolation (`--fileParallelism=false`): all
  green, 374/374, including `phase10a1RouteAuthorization.test.js` (52/52) —
  the file closest to the changed surface. **Net: 3274 passed, 613 skipped, 0
  failed.**
- **Real-Postgres round-trip proof**, deliberately going beyond the unit
  suite's fake client: directly seeded 5 representative terminal states via
  Prisma (not through a live provider) and called the real
  `getFindingEnrichmentSummary` against real Postgres:
  - `abuseipdb` (DEAD_LETTER job, delegate left `PENDING`) → `AMBIGUOUS`,
    `source: ORCHESTRATION_JOB` — the highest-risk new logic (defect 6 /
    provenance), proven against real Prisma object shapes, not a hand-built
    fake.
  - `censys` (job `NO_RECORD`) → `NO_RECORD`.
  - `greynoise` (job `FAILED` + `PROVIDER_RATE_LIMITED`) → `RATE_LIMITED`.
  - `netlas` (direct-path `DEAD_LETTER` + `AMBIGUOUS_AFTER_CONTACT`) →
    `AMBIGUOUS`.
  - `shodan` (`SUCCEEDED`, expired `freshUntil`) → `COMPLETED`,
    `isStale: true`, `evidenceAvailable: false`.
- **Real-browser proof** (Chromium via Playwright, against that same seeded
  stack): the panel rendered "Ambiguous — needs manual review" (×2, both the
  delegated and direct paths), "Nothing on file", "Rate limited", and "Lookup
  completed" with a visible stale notice — zero console errors. The
  pre-existing `findingEnrichment.spec.js` (8 tests, proves real integration
  wiring for the reachable default states) re-ran clean against the real
  stack unmodified. Both throwaway proof scripts (a Prisma seed script and a
  Playwright spec) were deleted before committing — nothing added to the repo
  beyond the ticket's own scope.
- **One bounded read-only implementation review** (`backend-logic-reviewer`),
  given the ticket objective, the approved v4 contract, the actual
  base(`13f7e24`)..head(`9ac0ec7`) diff, and the verification evidence above.
  Answered all 8 required review questions against the real source (not just
  the contract's claims). Found 0 P0/P1. One P2: the direct-job
  `RATE_LIMITED` path had a dedicated unit test, the delegated-IOC
  `RATE_LIMITED` path didn't (only indirect real-Postgres proof). Verdict:
  **SAFE TO COMMIT: YES**.
- Closed the one P2 immediately (smallest possible fix — one test case
  mirroring the existing direct-path pattern), reran the affected file, and
  made the smallest possible closure commit: `a455f38`.
- **CI**: pushed the branch, run `31943085758` at final SHA `a455f38`
  (verified against `git rev-parse HEAD`). First attempt: 5/6 jobs green; the
  Browser-suite (Chromium) job failed on one test in `attack.spec.js` (the
  MITRE ATT&CK navigator — unrelated to this ticket's changed surface), only
  the ADMIN role variant, from two transient `404` resource-load errors on
  the very first test of a 63-test run. All 8 `findingEnrichment.spec.js`
  tests in that same attempt passed clean. Reran the failed job only
  (`gh run rerun --failed`) at the identical SHA — green, confirming it was
  CI cold-start noise, not a regression. **Final state: 6/6 required jobs
  green at `a455f38`.**

## Honest gaps / backlog

- `docs/ai/DECISIONS.md` `D-P10C1-01` records the decision and the
  `PHASE-10A1-API-CONTRACT.md` §4 amendment it required.
- Per-source vulnerability outcomes (`VulnerabilityProviderStatus`) remain
  unreachable from this summary endpoint — deliberately out of scope per the
  contract's P1-1 scope boundary. A future ticket would need a repository
  addition plus a three-source roll-up to reach them.
- `force`/justification UI, run polling, and credential/budget UI are
  unchanged from Phase 10B — still backlog, a 10C-2 candidate, **not started
  this session** per explicit instruction.
- The `.ai-team/WRITER_LOCK.json` mechanism still does not exist in this
  repository (same pre-existing gap since Phase 8B) — single-writer
  discipline was manual and honest, not a working lease.

Full validation evidence is in `STATE.yaml`'s `validation` block. **Next
action**: a human opens the PR when ready. No PR was opened this session, and
10C-2 was not started, per explicit instruction.
