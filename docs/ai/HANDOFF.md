# Handoff: TNX-P10A1-ENRICHMENT-ORCHESTRATION-FOUNDATION

- From: claude
- Suggested next writer: **codex (SECOND independent review)** — do not start 10A-2 before that review
- Branch: `feat/phase-10a1-enrichment-orchestration-foundation` (from `origin/main` @ `3638a39`, the PR #19 merge)
- Worktree: `F:\AI-Worktrees\ThreatNeXus\phase-10a1` (isolated — the primary checkout, which carries
  unrelated uncommitted presentation work on `docs/phase-9c-pkcert-technical-dossier`, was never
  touched, never switched, never stashed)
- Writer lock: **released** (`handoff-task.ps1`, `claude` -> `codex`)
- Verified code checkpoint: `11b0f4a` (CI green); handoff commit `2990ee2`
- Updated: 2026-08-12T04:50:00Z (correction pass after Codex review 1)

> `handoff-task.ps1` overwrote this file with its five-line template on release, as it always does.
> The detail below was restored from `11b0f4a` immediately afterwards. Any future writer running that
> script must do the same.

**Status: complete and inert, first Codex review resolved, awaiting SECOND Codex review.** Phase
10A-1 records enrichment orchestration INTENT and executes nothing. No PR opened, `main` not merged,
10A-2 not started — per instruction.

## Codex review pass 1 — every finding resolved

The first independent review returned **NOT READY** with six blockers. All six are fixed on this
branch; each has a regression test that fails against the pre-correction code.

| # | Finding | Correction |
|---|---|---|
| 1 | Invented hyphenated route; `created: false` under 202 | Routes are now `POST/GET /api/findings/:id/enrichment/runs` and `GET …/runs/:runId`. **No alias retained** — the surface is unmerged, so the old spelling now 404s. The response carries a closed `outcome`: `CREATED` → **202**, `ALREADY_RUNNING` → **200** (existing run returned), `SKIPPED` → **200**. The body shape is pinned field-by-field in the HTTP suite. |
| 2 | Upload block named `autoEnrichment`, no state | Renamed to `enrichment` with a closed `state`: `AUTOMATIC_DISABLED` (default), `NO_FINDINGS`, `RECORDED`, `PARTIAL`. `executed` stays `false`. The block was **never surfaced over HTTP at all** — the upload controller returned only `success/message/report/findingCounts` — so it is now added there, additively, on the same outcome as `findingCounts`. Every pre-existing field is byte-identical. |
| 3 | `items.length === 0` guard lost targets after a partial write | Convergent materialization (see below), with a real-PG crash-recovery test and a concurrent-replay test. |
| 4 | `RUN_DELEGATED` + `PENDING` + no delegate FK was creatable | Delegates are created-or-found through the canonical queue services and linked; when one cannot be established the item records `SKIPPED_EXECUTION_UNAVAILABLE` and **no job** is created. |
| 5 | No real HTTP/RBAC contract tests | `tests/integration/phase10a1RouteAuthorization.test.js` — 37 cases over the mounted app. |
| 6 | `STATE.yaml` carried unrelated prior-ticket prose | Rewritten to the current ticket only. |

One extra real defect was found and fixed while proving #3/#4: `phase10a1Orchestration.test.js`
deleted `RawReport WHERE sourceFileName LIKE 'p10a1-%'`, which also matched
`phase10a1IngestionDefaultOff.test.js`'s reports and failed on their child foreign keys whenever the
two files ran concurrently. Each suite now deletes only what it created.

> Note for any future writer: `handoff-task.ps1` overwrites this file with a five-line template on
> every run. If you run it, restore the detail below from the prior commit afterwards.

---

## ⛔ MANDATORY BLOCKER BEFORE PHASE 10A-2

**Do not implement 10A-2 execution until this is designed and independently reviewed.**

The existing IOC runner (`backend/src/services/enrichment/enrichmentRunner.js`) currently owns
`claimPendingJob` and calls `provider.lookup()` internally. Phase 10A-2 cannot simply "turn on a
worker" against it. Before writing any 10A-2 execution code, define — and have independently
reviewed — a **targeted runner/hook contract** that guarantees all of the following:

1. **Only Phase-10-linked IOC ids are considered.** The targeted path must not widen into the
   ordinary batch's candidate set.
2. **Quota reservation happens AFTER the IOC claim succeeds but BEFORE `lookup()`.** Reserving
   before the claim leaks budget on a lost claim race; reserving after the call cannot refuse one.
3. **The attempt becomes `IN_FLIGHT` immediately before `provider.lookup()`**, so a crash between
   reservation and fetch is distinguishable from a crash during one.
4. **A quota refusal performs no provider call and safely releases/refunds the IOC claim attempt.**
   A refused reservation must not leave an IOC job leased and stranded.
5. **The normalized result or failure finalizes the corresponding Phase-10 attempt EXACTLY ONCE.**
6. **The ordinary ADMIN IOC batch retains its existing behaviour**, unchanged and untargeted.
7. **No provider call is double-counted or executed twice** across the two paths.

Related, and deliberately still open: `VulnerabilityEnrichmentJob` is **not** made worker-eligible in
10A-2 either. Its runner calls three providers per job plus a per-batch KEV catalogue fetch, which
needs its own hook design. NVD delegates therefore continue to require the existing ADMIN
vulnerability batch, and that limitation is documented in the README, the provider guide and the run
API's own `SKIPPED_*` vocabulary rather than hidden.

---

## What Phase 10A-1 delivered

One additive migration `20260811162611_add_phase10a1_enrichment_orchestration` (**24 migrations
total**, CI's frozen list updated in the same commit), adding:

- **5 tables** — `FindingEnrichmentRun`, `FindingEnrichmentRunItem`, `ProviderLookupJob`,
  `ProviderLookupAttempt`, `ProviderDailyUsage`.
- **9 enums** — `EnrichmentSubjectType`, `EnrichmentRunTrigger`, `EnrichmentRunState`,
  `RunItemDecision` (8 values), `LookupJobTrigger`, `ProviderLookupJobState` (12 values, including
  the corrected `SKIPPED_BUDGET`), `QuotaLane`, `AttemptState`, `AttemptOutcome`.
- **7 CHECK constraints**, hand-written into the migration because Prisma cannot model them.

Application code, all under `backend/src/services/enrichmentOrchestration/` (10 modules):
`enrichmentSubject`, `enrichmentDecisionCodes`, `enrichmentIdentity`,
`enrichmentOrchestrationConfig`, `enrichmentApplicabilityRouter`,
`enrichmentOrchestrationRepository`, `enrichmentRunService`, `enrichmentRunReadService`,
`enrichmentReconciliationService`, `enrichmentUsageService`. Plus one controller, two routers,
`env.js` wiring, `.env.example`, and the ingestion call site.

## The design decisions worth carrying forward

**Request identity and work identity are SEPARATE, and must stay separate.**
`idempotencyKey` (unique per run) deduplicates *the same ask*; `activeLookupKey` (unique per job,
held only while non-terminal) deduplicates *outbound work*. Collapsing them is precisely the defect
the v2.1 correction addendum exists to fix — it let an active AbuseIPDB run silently suppress a
later Censys request. Three consequences are simultaneously true and each has a test: concurrent
identical requests collapse to one run; an AbuseIPDB-scoped run does not suppress a Censys-scoped
run; two Findings on one IP share one job.

**Routing-time budget refusal ≠ execution-time budget refusal.** A known-zero budget at routing time
is `RunItem.decision = SKIPPED_BUDGET` with **no job and no reservation**. A refused atomic
reservation at execution time (10A-2) is `job.state = SKIPPED_BUDGET` while the run item stays
`ELIGIBLE` and linked. Run aggregation handles both, so "we never asked" is never reported as "we
asked and were refused".

**Router precedence is deliberate**, not incidental: subject compatibility → credential configured →
freshness → lane budget → eligible. `force` bypasses freshness *only*. Reporting a budget refusal
for a subject that already had a fresh answer would be true but misleading.

**Serializers publish job STATE, never job IDENTITY.** A shared job's id (or any of its hashes) would
let a holder of Finding A's summary correlate it with every other Finding pointing at the same job.
A run belonging to another Finding is 404, not 403.

**A delegated job is established through the CANONICAL queue service, and never exists unlinked.**
(Corrected in the review pass — see below.) `enrichmentRunService.establishDelegate` calls
`enrichmentQueueService.scheduleEnrichment(Forced)` for AbuseIPDB and
`vulnerabilityQueueService.scheduleVulnerabilityEnrichment(Forced)` for NVD, and links whatever row
they return. Phase 10 owns no second copy of active-job uniqueness, no second cache-identity
construction and no second P2002 loop, so the two can never drift apart. `force` is passed through to
the service's own forced variant, keeping one definition of "force ignores the cache, never the
queue". Neither service performs I/O beyond the database, so the package stays inert.

Three outcomes, and only the first creates a job:
`LINKED` → `RUN_DELEGATED` + `WAITING_ON_DELEGATE` + exactly one delegate FK;
`FRESH` (the canonical service reports a fresh answer) → item `SKIPPED_CACHED`, **no job**;
refusal/failure → item `SKIPPED_EXECUTION_UNAVAILABLE` + `DELEGATE_UNAVAILABLE`, **no job**.
A `RUN_DELEGATED` job with no delegate could never reach a terminal state and would hold
`activeLookupKey` against every future ask about that subject. The ADMIN batches still execute the
work; their behaviour is unchanged.

**Materialization is CONVERGENT, never "only when the run is empty".** Every idempotent replay
attempts the complete expected routed-target set, skips what is already present, and lets the
`(runId, provider, subjectType, subjectValue)` unique absorb a concurrent racer. Nothing is ever
updated, so a replay can add a missing item but can never rewrite a decision that was already
recorded. The previous "materialize only when `items.length === 0`" guard permanently lost every
target a crash left unwritten.

## Evidence

| Gate | Result |
|---|---|
| `prisma format` / `validate` | pass |
| `migrate deploy` from zero (fresh DB) | **24/24 applied** |
| `migrate diff --exit-code` | **no difference detected** (exit 0) |
| CI frozen migration list | updated to 24 in the same commit |
| 5 tables / 9 enums / 7 constraints in live schema | verified by direct `pg_catalog` query, alongside **0 attempt rows, 0 usage rows, 0 unlinked `RUN_DELEGATED` jobs** |
| Real-PG constraint suite | **9 tests, 8 independent rejections across the 7 constraints** |
| Real-PG orchestration suite | 9 tests (T-23, concurrent collapse, scope separation, shared job, policy skips, 3×CVE, provider-text exclusion, audit safety) |
| Real-PG default-off suite | 3 tests (off = zero Phase-10 rows; on = records but no lookup; idempotent re-upload) |
| **Real-PG delegate/recovery suite (new)** | **9 tests** — crash recovery, concurrent replay convergence, IOC delegate created / reused / past-terminal, scheduling refusal, NVD delegate, 3×CVE distinct delegates, ADMIN-batch uniqueness respected. Every case re-asserts zero attempts, zero usage, nothing queried, and exactly one delegate FK per `RUN_DELEGATED` job. |
| **HTTP/RBAC contract suite (new)** | **37 Supertest tests** over the mounted app — full role matrix, 401 vs 403, slash paths vs 404 on the hyphenated ones, 202/200 outcomes, 400 validation, cross-Finding 404, leak checks |
| Upload HTTP contract | `enrichment.state === AUTOMATIC_DISABLED` proven over real HTTP; the response allow-list test extended (not relaxed) to pin the block's own keys |
| Pure unit suites | 101 tests across 6 files, incl. the static inertness gate — still green with the two new canonical-queue imports |
| **Full backend suite** | **3415 passed, 2 skipped, 0 failed** (156 files, fresh DB, `--maxWorkers=3`) |
| Evaluators | `eval:phase1`, `eval:risk` (19/19), `eval:phase2` (22/112), `eval:phase3` (12/151), `eval:vulnerability` (41/992), `eval:phase4` (14/151), `eval:phase5` (14/150), `eval:phase6.3` (13/108), `eval:phase7` (8/35) — **all PASS** |
| Risk v1 config version / fingerprint | unchanged (`v1.0.0`, `risk-additive-bucketed-v1`); risk modules untouched per `git status` |
| Secret scan | CI's own pattern set, repo-wide: clean. No tracked `.env`. |
| Frontend | untouched (`git status frontend/` empty) |
| `backend/.env` | never opened, read, printed or referenced — only `.env.example` |
| Primary checkout | untouched — `C:\Users\LENOVO\Desktop\ThreatNeXus` stayed on `docs/phase-9c-pkcert-technical-dossier` with its unrelated Phase 9 work intact |
| **CI** | **green on the first push of `4fa62e6`** — [run 31546832118](https://github.com/haiderchattha99-ali/ThreatNeXus/actions/runs/31546832118). All six required jobs success; the manual-dispatch-only seventh correctly skipped. |

**Local full-suite flakiness (not a regression).** Running all 154 files at default parallelism on
this machine produces 5s-timeout failures in unrelated pre-existing suites
(`caseWorkflowConcurrency`, `vulnerabilityPacketBApplication`, `vulnerabilityReleaseWorkflow`). Proven
unrelated: those files import only workflow/vulnerability services, they pass in isolation, and the
same failures still occur with **every Phase-10 file excluded**. A fresh database at
`--maxWorkers=3` is fully green. The suite has no explicit `testTimeout`, so vitest's 5s default
applies; the contention is local, not in CI.

## Honest gaps

- **`MANUAL_DIRECT` is defined but unused in 10A-1.** It exists so the vocabulary and constraints are
  complete and provable before 10A-2 writes the code that uses it. `ProviderLookupAttempt` and
  `ProviderDailyUsage` likewise have zero rows by design. (`SKIPPED_EXECUTION_UNAVAILABLE` is no
  longer in this list — the review-pass delegate work made it a live, tested decision.)
- **A `RUN_DELEGATED` job without a delegate FK is prevented in CODE, not by a CHECK constraint.**
  Adding an eighth constraint would mean a 25th migration and a change to CI's frozen list, which the
  correction pass was scoped out of. The invariant is asserted on every job in the new real-PG suite.
  Consider promoting it to a constraint when 10A-2 next touches the migration set.
- **`ENRICHMENT_WORKER_ENABLED` is declared and validated but consumed by nothing.** There is no
  worker to enable.
- **Freshness is read one query per target** (bounded by the provider scope plus one per verified
  CVE). Marked with a `ponytail:` comment; batch into a single `IN` query if a Finding ever carries
  enough verified CVEs for it to matter.
- **The v2 / v2.1 plan documents are still not available on disk.** The route paths, the
  `CREATED` / `ALREADY_RUNNING` / `SKIPPED` outcome vocabulary and the `enrichment.state` codes in
  this pass come from the **Codex review's explicit restatement of the approved contract**, not from
  a file. If the v2.1 document names anything differently, reconcile the NAMES — the behaviour and
  status codes now match what the review specified.
- **One review item is proven in an adjacent file rather than the new one.** "Default-off upload
  returns `enrichment.state === AUTOMATIC_DISABLED`" is asserted in
  `tests/integration/reportUploadRoute.test.js`, which already carries the complete upload stub and
  drives the real `POST /api/reports/upload` over Supertest. Duplicating ~200 lines of that stub into
  the new suite would have added no coverage. The same file's response allow-list test was extended
  (not relaxed) to pin the new block's own keys.
- **Second independent review not yet done.** Per `CLAUDE.md`, do not treat this as final.

## Next action

**Codex second independent review** of this branch, against the six findings above. Do NOT open a PR,
do NOT merge `main`, do NOT begin 10A-2. After that review passes, design the runner/hook contract in
the blocker section above and have *that* design reviewed before any 10A-2 execution code is written.
