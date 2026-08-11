# Handoff: TNX-P10A1-ENRICHMENT-ORCHESTRATION-FOUNDATION

- From: claude
- Suggested next writer: **codex (independent review)** — do not start 10A-2 before that review
- Branch: `feat/phase-10a1-enrichment-orchestration-foundation` (from `origin/main` @ `3638a39`, the PR #19 merge)
- Worktree: `F:\AI-Worktrees\ThreatNeXus\phase-10a1` (isolated — the primary checkout, which carries
  unrelated uncommitted presentation work on `docs/phase-9c-pkcert-technical-dossier`, was never
  touched, never switched, never stashed)
- Writer lock: held for this ticket, released on handoff
- Updated: 2026-08-12T02:55:00Z

**Status: complete and inert.** Phase 10A-1 records enrichment orchestration INTENT and executes
nothing. No PR opened, `main` not merged, 10A-2 not started — per instruction.

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

**Delegate links are read-only in 10A-1.** The Phase-10 job links an `IocEnrichment` /
`VulnerabilityEnrichmentJob` row that ingestion or the ADMIN batch already created. It never creates,
claims or mutates one — which is why those pipelines are provably unchanged.

## Evidence

| Gate | Result |
|---|---|
| `prisma format` / `validate` | pass |
| `migrate deploy` from zero (fresh DB) | **24/24 applied** |
| `migrate diff --exit-code` | **no difference detected** (exit 0) |
| CI frozen migration list | updated to 24 in the same commit |
| 5 tables / 9 enums / 7 constraints in live schema | verified by direct `pg_catalog` query |
| Real-PG constraint suite | **9 tests, 8 independent rejections across the 7 constraints** |
| Real-PG orchestration suite | 9 tests (T-23, concurrent collapse, scope separation, shared job, policy skips, 3×CVE, provider-text exclusion, audit safety) |
| Real-PG default-off suite | 3 tests (off = zero Phase-10 rows; on = records but no lookup; idempotent re-upload) |
| Pure unit suites | 101 tests across 6 files, incl. the static inertness gate |
| **Full backend suite** | **3368 passed, 2 skipped, 0 failed** (fresh DB, `--maxWorkers=3`) |
| Evaluators | `eval:phase1`, `eval:risk` (19/19), `eval:phase2` (22/112), `eval:phase3` (12/151), `eval:vulnerability` (41/992), `eval:phase4` (14/151), `eval:phase5` (14/150), `eval:phase6.3` (13/108), `eval:phase7` (8/35) — **all PASS** |
| Risk v1 config version / fingerprint | unchanged (`v1.0.0`, `risk-additive-bucketed-v1`); risk modules untouched per `git status` |
| Secret scan | CI's own pattern set, repo-wide: clean. No tracked `.env`. |
| Frontend | untouched (`git status frontend/` empty) |
| `backend/.env` | never opened, read, printed or referenced — only `.env.example` |

**Local full-suite flakiness (not a regression).** Running all 154 files at default parallelism on
this machine produces 5s-timeout failures in unrelated pre-existing suites
(`caseWorkflowConcurrency`, `vulnerabilityPacketBApplication`, `vulnerabilityReleaseWorkflow`). Proven
unrelated: those files import only workflow/vulnerability services, they pass in isolation, and the
same failures still occur with **every Phase-10 file excluded**. A fresh database at
`--maxWorkers=3` is fully green. The suite has no explicit `testTimeout`, so vitest's 5s default
applies; the contention is local, not in CI.

## Honest gaps

- **`SKIPPED_EXECUTION_UNAVAILABLE` and `MANUAL_DIRECT` are defined but unused in 10A-1.** They exist
  so the vocabulary and constraints are complete and provable before 10A-2 writes the code that uses
  them. `ProviderLookupAttempt` and `ProviderDailyUsage` likewise have zero rows by design.
- **`ENRICHMENT_WORKER_ENABLED` is declared and validated but consumed by nothing.** There is no
  worker to enable.
- **Freshness is read one query per target** (bounded by the provider scope plus one per verified
  CVE). Marked with a `ponytail:` comment; batch into a single `IN` query if a Finding ever carries
  enough verified CVEs for it to matter.
- **The v2 / v2.1 plan documents were not available in the implementing session.** The data model was
  recovered from the prior session's committed `schema.prisma` (which encodes it in detail), and the
  async run/summary API shape and the additive upload-response field names were **derived from repo
  conventions with the user's explicit approval**, not copied from the spec. If v2/v2.1 names those
  differently, reconcile the field names — the behaviour and contracts should already match.
- **No independent reviewer has seen this yet.** Per `CLAUDE.md`, do not treat it as final.

## Next action

Codex independent review of this branch. After it passes, design the runner/hook contract in the
blocker section above and have *that* reviewed before any 10A-2 code is written.
