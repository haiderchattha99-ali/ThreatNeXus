# Architecture Decision Log

Use `F:\Ismail-AI-Dev-Team\handoffs\DECISION-TEMPLATE.md` for new decisions.

Product and architecture decisions for ThreatNeXus itself live in
`../../../ThreatNeXus-Planning/planning/DECISIONS.md`, which is authoritative and read-only from
this repository. This file records decisions about how the AI development team operates *on* this
repository.

| ID | Date | Status | Decision | Ticket |
|---|---|---|---|---|
| D-AI-001 | 2026-08-05 | Accepted | One-time dirty-worktree onboarding exception for the in-flight Phase 6.2 checkpoint | TNX-P6.2-FINALIZE |
| D-P10A2-01 | 2026-08-12 | Accepted | Promote "a RUN_DELEGATED job always carries a delegate FK" to a database CHECK constraint (25th migration) | TNX-P10A2-LIVE-ENRICHMENT-EXECUTION |
| D-P10A2-02 | 2026-08-12 | Accepted | Atomic daily quota reservation is a guarded `updateMany`, not raw `INSERT … ON CONFLICT` | TNX-P10A2-LIVE-ENRICHMENT-EXECUTION |
| D-P10A2-03 | 2026-08-12 | Accepted | Amend the Phase 10A-1 API contract: `executionState` value `NOT_IMPLEMENTED` is replaced by `ACTIVE` | TNX-P10A2-LIVE-ENRICHMENT-EXECUTION |
| D-P10A2-04 | 2026-08-12 | Accepted | An ambiguous crash after provider contact is terminal and manual-review only; it is never retried automatically | TNX-P10A2-LIVE-ENRICHMENT-EXECUTION |
| D-P10A2-05 | 2026-08-12 | Accepted | Targeted AbuseIPDB execution never leases the Phase-10 job; the canonical `IocEnrichment` claim is the only lease | TNX-P10A2-LIVE-ENRICHMENT-EXECUTION |
| D-P10A2-06 | 2026-08-12 | Accepted | A provider result is always terminal for a Phase-10 direct job; no automatic retry of a provider outcome | TNX-P10A2-LIVE-ENRICHMENT-EXECUTION |
| D-P10A2-07 | 2026-08-12 | Accepted | The contact guard: a contacted `IocEnrichment` row is made unclaimable via `nextAttemptAt` until its ambiguity is resolved | TNX-P10A2-LIVE-ENRICHMENT-EXECUTION |
| D-P10A2-08 | 2026-08-12 | Accepted | Amend `IOC_STATUS_TO_JOB_STATE` to map every terminal delegate status, and refresh run state after reconciliation | TNX-P10A2-LIVE-ENRICHMENT-EXECUTION |
| D-P10A2-09 | 2026-08-12 | Accepted | The Phase-10 worker imposes its own end-to-end bound on `lookup()`; the five shared provider modules are left unchanged | TNX-P10A2-LIVE-ENRICHMENT-EXECUTION |
| D-P10B-01 | 2026-08-13 | Accepted | Phase 10B V1 scope frozen: analyst enrichment visibility on the existing Phase 10 read model, additive-only, no backend/execution/Risk-v1 change | TNX-P10B-ENRICHMENT-VISIBILITY |

> **Revision note (2026-08-12).** The internal independent Codex design review returned
> **NOT READY** (12×P1, 1×P2, 1×P3, no P0) against contract v1. All fourteen findings were verified
> against the repository and **all were substantiated and accepted; none was rejected as invented.**
> D-P10A2-01 and D-P10A2-04 were amended as a result, and D-P10A2-06..08 were added. Full
> finding-by-finding resolution is in `PHASE-10A2-RUNNER-CONTRACT.md` §18.
>
> - **D-P10A2-01 amended.** The migration can no longer be "exactly one CHECK and nothing else": the
>   providers emit `PROVIDER_REJECTED` for non-auth 3xx/4xx (`iocEnrichmentTypes.js:55`,
>   `censysTypes.js:45`, and the netlas/shodan/greynoise equivalents) and `AttemptOutcome` has no
>   value for it, so a Censys HTTP 400 could only be finalized as `SERVER_ERROR` or
>   `TRANSPORT_ERROR`, both false. The same additive migration therefore adds the enum value first
>   (`ALTER TYPE … ADD VALUE` cannot run inside a transaction block) and the CHECK second.
> - **D-P10A2-04 amended.** Recording ambiguity honestly is necessary but was not sufficient. The
>   120-second IOC lease expires long before a 900-second sweep, so the ADMIN batch could reclaim and
>   re-call a row whose first request was still unresolved — a duplicate charge the "no auto-retry"
>   rule alone did not prevent. D-P10A2-07 closes that window.

---

## D-P10A2-09 — the worker bounds its own lookup; the shared providers are not touched

**Status:** Accepted. Ticket `TNX-P10A2-LIVE-ENRICHMENT-EXECUTION`.

### Context

The stale-attempt sweep must never resolve an attempt whose provider call is **still executing** —
otherwise it dead-letters live work and a valid result can never be recorded. That safety property
needs a real upper bound on `lookup()`.

**No provider's configured timeout provides one.** Verified in source: every provider clears its
timeout as soon as `fetch()` resolves its *headers*, and reads the body afterwards —
`censysProvider.js` clears at line 139 and reads at 182; `greyNoiseProvider.js` clears at 117 and
reads at 160; `abuseIpdbProvider.js` calls `composed.cleanup()` at the same boundary. A response
whose headers arrive instantly but whose body stalls runs unbounded.

The bounded re-check proposed the direct correction: make every provider's timeout cover the whole
lookup.

### Decision

Do **not** change the five provider modules. They are shared, unchanged, by the ordinary ADMIN IOC
batch and by the four synchronous analyst-facing expert endpoints. Moving `clearTimeout` past body
consumption alters the observable behaviour of merged, tested code on paths Phase 10A-2 does not own
— a direct risk to binding guarantee 6 ("the ordinary ADMIN IOC batch retains its existing
behaviour") for a rule only Phase 10 needs.

Instead the Phase-10 worker bounds the call at **its own call site**:

```
await Promise.race([ provider.lookup(input), rejectAfter(ENRICHMENT_LOOKUP_MAX_MS) ])
```

A lost race is **ambiguous**, not a provider `TIMEOUT`: `contactedProvider` is already true and we do
not know what the provider did with the request. Cross-field configuration validation is stated
against this real bound: `lease >= LOOKUP_MAX_MS + 30s` and `stale >= LOOKUP_MAX_MS + 60s`.

### Consequence

This is a **narrower** correction than the review proposed, and the divergence is recorded rather
than presented as compliance. The pre-existing unbounded body read still affects the ADMIN batch and
the expert endpoints; it is listed as an honest gap with a recommendation to fix it in its own
ticket, under its own review, because it changes shared merged code.

---

## D-P10A2-06 — a provider result is always terminal for a direct job

**Status:** Accepted. Ticket `TNX-P10A2-LIVE-ENRICHMENT-EXECUTION`. Supersedes contract v1 §6.1.

### Context

Contract v1 required a normalized `RATE_LIMITED`, `TIMEOUT` or `FAILED` from a direct provider to put
the Phase-10 job into `RETRY_WAIT`. The existing policy cannot produce that:
`resolveEnrichmentRetry` classifies all of those as `FAILURE_CLASS.EXPECTED_PROVIDER_RESULT` and
returns `RETRY_ACTION.COMPLETE` for **every** terminal status
(`enrichmentRetryPolicy.js:262-276`), with the stated reasoning that *"a cached
RATE_LIMITED/TIMEOUT is real evidence of 'no context available' and is governed by the TTL policy,
not by this retry budget."*

Reaching v1's behaviour would have required either a second parallel retry policy or a change to the
branch the ordinary ADMIN IOC batch shares. The latter regresses guarantee 6; the former duplicates
a vocabulary this repository deliberately keeps single-sourced.

### Decision

Adopt the existing semantics. A normalized terminal provider result terminalizes the Phase-10 direct
job — `SUCCESS → SUCCEEDED`, `NOT_FOUND → NO_RECORD`, every negative status → `FAILED` — carrying
`freshUntil` from the existing `resolveEnrichmentTtl`. **No provider outcome is ever retried
automatically.**

A stale answer is re-asked by creating a new run once `freshUntil` lapses, or immediately with
`force` plus a written justification, which is a human decision to spend quota.

`RETRY_WAIT` stays in `ProviderLookupJobState` and is unused by this milestone.

### Consequence

One retry policy, one definition of "a negative answer is evidence". It also deletes an entire class
of retry-driven duplicate-call risk, which is why the change simplifies §5, §8.5 and §10 rather than
only §6.

---

## D-P10A2-07 — the contact guard

**Status:** Accepted. Ticket `TNX-P10A2-LIVE-ENRICHMENT-EXECUTION`.

### Context

For AbuseIPDB the canonical `IocEnrichment` claim is the only lease (D-P10A2-05), and its default
duration is 120 seconds. The stale-attempt sweep runs at 900. A targeted lookup still in flight past
120 seconds therefore leaves the row lease-free, and the ordinary ADMIN batch legitimately reclaims
it through `claimPendingJob` and calls the provider a **second** time — a duplicate execution and a
duplicate charge, which binding guarantee 7 forbids.

The obvious correction — teach `claimPendingJob` to refuse rows with an unfinished Phase-10 attempt —
was rejected: it modifies the exact function the ADMIN batch depends on, putting guarantee 6 at risk
for a rule that only Phase 10 needs.

### Decision

Use the gate `claimPendingJob` **already** applies. It refuses any row whose `nextAttemptAt > now`
(`iocEnrichmentRepository.js:286`). So the same claim-token-guarded statement that moves the Phase-10
attempt to `IN_FLIGHT` also sets, on the claimed `IocEnrichment` row:

```
nextAttemptAt = CONTACT_SENTINEL   // 9999-12-31T00:00:00.000Z — a NON-EXPIRING hold
```

**Amended after the bounded re-check.** The first formulation used `now + CONTACT_GUARD_SECONDS`, a
duration, with the ordering `lease < stale < guard`. That is wrong, and the re-check was right to
reject it: an ordering of durations constrains how long things last, not **when recovery runs**. If
no Phase-10 worker runs for longer than the guard — the worker is disabled, or crashed and never
restarted — the guard lapses, the lease expired long ago, and the ADMIN batch legitimately reclaims
and re-calls the provider. A duration cannot express *"held until somebody establishes what
happened."*

A sentinel can. It is cleared only by a path that **knows** the outcome: `completeClaimedJob` clears
`nextAttemptAt` on any terminal result (`iocEnrichmentRepository.js:412`), or the ambiguity sweep
drives the row terminal, and a terminal row can never be claimed again. There is consequently no
`CONTACT_GUARD_SECONDS` to tune or to misconfigure.

While the sentinel stands, no caller — the ADMIN batch, another Phase-10 worker, or any retry — can
claim that row, whether or not the lease has expired. `claimPendingJob` is not touched and the ADMIN
batch's behaviour on every other row is byte-identical.

**Accepted consequence.** If a targeted worker dies after contact and no Phase-10 worker ever runs
again, that one row stays held indefinitely and the ADMIN batch will not process it. We genuinely do
not know whether the provider was called and charged, and freezing one row is strictly safer than
double-calling a paid third party. The state is visible and self-resolves when a worker next runs.

Relatedly, the targeted path passes **no `AbortSignal`** into the runner. `enrichmentRunner.js:266-268`
re-checks cancellation *after* the provider has returned and releases the claim with a refund — on a
contacted row that is precisely the duplicate this decision exists to prevent. Shutdown drains the
in-flight tick instead.

### Consequence

Single-owner execution is bounded by the contact guard rather than by the lease alone, which is what
makes guarantee 7 hold across a slow call, a crash, and a graceful shutdown.

---

## D-P10A2-08 — reconciliation must map every terminal delegate status

**Status:** Accepted. Ticket `TNX-P10A2-LIVE-ENRICHMENT-EXECUTION`.

### Context

Contract v1 claimed `enrichmentReconciliationService` needed no change. It does.

`IOC_STATUS_TO_JOB_STATE` (`enrichmentReconciliationService.js:38-46`) maps `SUCCESS`, `NOT_FOUND`,
`INVALID_KEY`, `TIMEOUT`, `FAILED`, `UNSUPPORTED_INDICATOR` and `SKIPPED_DISABLED`. It **omits
`RATE_LIMITED` and `DEAD_LETTER`**, on the stated belief that a rate-limited delegate is "still
working". That belief is false against the code: `TERMINAL_STATUSES` is every status except `PENDING`
(`iocEnrichmentCacheRules.js:57`), and the retry policy completes a rate-limited result as terminal
evidence.

So a rate-limited or dead-lettered delegate leaves `resolveDelegateState` returning `null`, the
Phase-10 job pinned in `WAITING_ON_DELEGATE`, and its `activeLookupKey` held **forever** — which
permanently blocks every future ask about that subject. Separately, `reconcileDelegatedJobs` updates
jobs through the unguarded `updateJob` and never calls `refreshRunState`, so even a successful
delegate leaves the stored run state stale.

This is a latent Phase 10A-1 defect. It is harmless only while nothing executes; enabling a worker is
what makes it reachable.

### Decision

Amend reconciliation in Phase 10A-2: map `RATE_LIMITED → FAILED` and `DEAD_LETTER → DEAD_LETTER`,
make the transition guarded on the job still being `WAITING_ON_DELEGATE`, clear `activeLookupKey`,
set `completedAt`, and call `refreshRunState` for every distinct run holding an item on that job.

`RATE_LIMITED` maps to `FAILED` because `ProviderLookupJobState` deliberately carries no
`RATE_LIMITED` value and the honest meaning is "we have no answer" — never `NO_RECORD`, which would
read as "nothing found".

### Consequence

Reconciliation is no longer "unchanged", and the contract says so. The mapping table is now
exhaustive over `QUEUE_STATUS`, so a status added later fails loudly rather than stranding a job.

---

## D-P10A2-01 — promote the delegate-linkage invariant to a CHECK constraint

**Status:** Accepted. Ticket `TNX-P10A2-LIVE-ENRICHMENT-EXECUTION`.

### Context

`STATE.yaml` records, as a known issue from Phase 10A-1, that *"a `RUN_DELEGATED` job without a
delegate FK is prevented in code and asserted per job in the real-PG suite, not by a database CHECK
constraint — promote it when 10A-2 next touches the migration set."*

Phase 10A-2's targeted AbuseIPDB path dereferences `ProviderLookupJob.iocEnrichmentId` to decide
which canonical `IocEnrichment` row to claim. A `RUN_DELEGATED` job with a null delegate would be a
job the worker can never execute, that `reconcileDelegatedJobs` can never finish, and that holds
`activeLookupKey` against every future ask about that subject — permanently. Binding guarantee 1
(*only canonical IOC records linked to the specific Phase-10 job are considered*) depends on the
link existing.

### Decision

Add one additive migration containing exactly one CHECK constraint,
`provider_lookup_job_delegated_requires_delegate`, taking the repository from 24 to 25 migrations
and updating CI's frozen `expected_migrations` list in the same commit.

`enrichmentRunService.resolveEligibleTarget` creates a `RUN_DELEGATED` job only on the
`delegate.status === "LINKED"` branch, which always sets exactly one delegate FK; every other branch
creates no job at all. No existing row on `main` or in any deployed database can violate the
constraint, so the migration is additive and non-destructive.

Migration `20260811162611_add_phase10a1_enrichment_orchestration` is merged history and is **never**
edited. The constraint is hand-written into the new migration and re-declared in the `schema.prisma`
comment block, following the convention that file already establishes for the seven Phase-10A-1
constraints Prisma cannot model.

### Consequence

`prisma migrate diff --exit-code` stays clean (Prisma cannot see CHECK constraints). A future
`prisma format` or regenerated migration must re-add the declaration; the schema comment says so.

---

## D-P10A2-02 — quota reservation is a guarded `updateMany`, not raw SQL

**Status:** Accepted. Ticket `TNX-P10A2-LIVE-ENRICHMENT-EXECUTION`.

### Context

`schema.prisma` describes `ProviderDailyUsage` reservation as *"a single INSERT … SELECT … WHERE …
ON CONFLICT DO UPDATE … WHERE statement, so concurrent workers cannot both take the last unit."*
Implemented literally that requires `$executeRaw`. The persistence layer of this repository
deliberately contains no raw SQL: `iocEnrichmentRepository.js`'s header names "any raw SQL" as
deliberately absent, and every concurrency guarantee in the codebase is instead expressed as a
guarded single-statement `updateMany` whose `WHERE` names the state it expects.

### Decision

`reserveProviderQuota` reserves with the same compare-and-swap idiom `claimPendingJob` uses:

```
updateMany({ where: { provider, usageDate, lane, reservedCount: { lt: limit } },
             data:  { reservedCount: { increment: 1 }, limitAtLastReservation: limit } })
```

`count === 1` is a grant; `count === 0` is a refusal. The bucket row is created beforehand by an
`upsert` whose `P2002` is caught **outside any transaction**, per the aborted-transaction rule both
`enrichmentQueueService.js` and `enrichmentOrchestrationRepository.js` document.

At READ COMMITTED, PostgreSQL row-locks the target for the duration of the `UPDATE` and re-evaluates
the `WHERE` against the winner's committed row, so N concurrent workers against a limit of L produce
exactly L grants. The guarantee is identical to the raw formulation; the mechanism is the one this
repository already proves under real-PostgreSQL contention.

The guard always compares against the **live configured limit**, never against the stored
`limitAtLastReservation`, so a mid-day configuration change takes effect immediately — which is what
that column's own schema comment requires.

### Consequence

The schema comment and the implementation now differ in wording. The comment is amended in the same
change to name this decision, so a future reader is not left to reconcile them.

---

## D-P10A2-03 — `executionState: ACTIVE` replaces `NOT_IMPLEMENTED`

**Status:** Accepted. Ticket `TNX-P10A2-LIVE-ENRICHMENT-EXECUTION`.

### Context

`docs/ai/PHASE-10A1-API-CONTRACT.md` is binding and states that amending it *"requires explicit
approval and must be recorded in `DECISIONS.md`"*. It defines `executionState` as a closed two-value
vocabulary: `PAUSED_WORKER_DISABLED` (the switch is off, the default) and `NOT_IMPLEMENTED` (the
switch is on, but Phase 10A-1 ships no worker, so nothing runs either way).

After Phase 10A-2, `NOT_IMPLEMENTED` is false: with the switch on, execution **is** implemented.
Continuing to return it would be exactly the kind of stale, untrue closed code this repository
refuses elsewhere.

### Decision

`enrichmentRunReadService.resolveExecutionState` returns `PAUSED_WORKER_DISABLED` when
`ENRICHMENT_WORKER_ENABLED` is false — unchanged, and still the default — and `ACTIVE` when it is
true. `NOT_IMPLEMENTED` is retired.

This is the **only** change to any Phase 10A-1 response field. Route paths, status codes, `outcome`,
`run`, `items`, the summary shape, and the report-upload block's exact six keys are unchanged, and a
regression test pins them.

NVD's continued non-execution is deliberately **not** expressed through `executionState`, which is a
deployment-level fact about whether a worker exists. It stays a per-provider fact carried by the
existing `SKIP_REASONS.DELEGATE_BATCH_REQUIRED` and the summary's
`source: VULNERABILITY_ENRICHMENT`.

### Consequence

`PHASE-10A1-API-CONTRACT.md` §2 is amended in the same change, with a pointer to this decision.

---

## D-P10A2-04 — an ambiguous crash after provider contact is terminal, never auto-retried

**Status:** Accepted. Ticket `TNX-P10A2-LIVE-ENRICHMENT-EXECUTION`.

### Context

No system with a non-transactional third party can provide exactly-once network delivery. A process
that dies at or after the moment a request is handed to the transport leaves a state in which it is
unknowable, from inside this system, whether the provider received, processed and charged for the
call.

The tempting behaviours are both wrong: retrying blindly can double-charge real third-party quota
and duplicate a side effect; recording a failure fabricates an outcome no provider gave.

### Decision

`ProviderLookupAttempt.contactedProvider` is set to `true` in the same statement that moves the
attempt to `IN_FLIGHT`, immediately before `provider.lookup()`. The stale-attempt sweep preserves
that flag exactly and splits on it:

- `contactedProvider = false` — the process died between reservation and the call; no request
  reached the provider. Retry is **demonstrably safe**, and the job returns to the queue.
- `contactedProvider = true` — ambiguous. The attempt is finalized `ABANDONED` and the owning job is
  driven to `DEAD_LETTER` with `terminalReasonCode = AMBIGUOUS_AFTER_CONTACT`. It is **not** retried
  automatically. An operator may re-ask explicitly with a new run and a written `justification`,
  which is a human decision to spend quota again.

The reservation is **retained** in both cases. `ProviderDailyUsage` has no decrement by design, so
accounting is deliberately conservative: it may over-count a call that was reserved but never sent;
it can never under-count a call that was sent. For a third-party budget that is the only safe
direction, and `contactedProvider` keeps the ledger honest about which case a row is.

### Consequence

`DEAD_LETTER` + `AMBIGUOUS_AFTER_CONTACT` is a queryable, audited terminal state meaning *"we do not
know"*. It is never rendered as a successful lookup, a failed lookup, or "no record found".

---

## D-P10A2-05 — targeted AbuseIPDB execution never leases the Phase-10 job

**Status:** Accepted. Ticket `TNX-P10A2-LIVE-ENRICHMENT-EXECUTION`.

### Context

For AbuseIPDB, two queues describe the same work: the canonical `IocEnrichment` row (which the
pre-existing ADMIN batch claims through `claimPendingJob`) and the Phase-10 `ProviderLookupJob` that
links it and waits in `WAITING_ON_DELEGATE`. Leasing both would create two mutual-exclusion
mechanisms for one unit of work, which can disagree.

### Decision

The targeted path claims **only** the linked `IocEnrichment` row, by explicit id, through the
existing `claimPendingJob`. The Phase-10 job stays `WAITING_ON_DELEGATE` for the entire execution.

Consequences, all deliberate:

- `reconcileDelegatedJobs` keeps working unchanged — it scans exactly that state;
- the ordinary ADMIN batch and the targeted path contend on the **same** compare-and-swap, which is
  what makes binding guarantee 7 (*no provider call executed or charged twice across the two paths*)
  structural rather than conventional;
- a crashed targeted worker leaves no orphaned Phase-10 lease to recover — only the delegate's,
  which the existing lease expiry already handles.

Quota is reserved only **after** that claim is won, so the loser of a race reserves nothing, writes
no attempt, and contacts nobody.

---

## D-AI-001 — one-time dirty-worktree onboarding exception

**Status:** Accepted, and spent. It applies to exactly one checkpoint and cannot be reused.

### Context

The AI-team framework (`docs/ai/`, `.cursor/rules/00-ai-team.mdc`, `GEMINI.md`, and the writer-lock
protocol) was initialized *after* the Phase 6.2 work was already underway and uncommitted. The
ordinary `start-task` and `continue-task` scripts refuse a dirty worktree by design — correctly, because
a writer that inherits unattributed changes cannot say what it is responsible for. Applying that
rule literally here would have left legitimate, already-verified work stranded: it could be neither
committed under the protocol nor discarded.

Three paths were available and two were rejected:

- **Weaken or bypass the scripts.** Rejected. The dirty-worktree refusal is the only thing standing
  between "one active writer" and two agents silently overwriting each other. A guard that is
  relaxed the first time it is inconvenient is not a guard.
- **Fabricate a `WRITER_LOCK.json` by hand.** Rejected. A lock that no script issued records
  ownership that was never negotiated, which is worse than no lock because it reads as authoritative.
- **Grandfather this one checkpoint under an explicit, recorded exception.** Accepted.

### Decision

For the `TNX-P6.2-FINALIZE` checkpoint only, Claude finished the already-started work in the dirty
worktree under explicit user authorization, subject to these constraints:

1. **No workflow script was overridden, weakened or edited.** `checkpoint-task.ps1` was deliberately
   *not* used, because it stages with `git add --all` and would have absorbed foreign paths.
   `handoff-task.ps1` was not used while foreign paths remained in the tree.
2. **No writer-lock file was invented.** `.ai-team/WRITER_LOCK.json` does not exist in this
   repository and was not created.
3. **Every commit stages explicit paths only.** No `git add -A`, no `git add .`.
4. **Two paths were treated as protected foreign work** and were not edited, staged, moved,
   restored, stashed, reset, cleaned or committed:
   - `backend/tests/integration/phase6ReadRouteAuthorization.test.js`
   - `docs/codex/`
   No destructive recovery command (`git reset --hard`, `git clean`, `git checkout` on a foreign
   path, or a broad stash) was run at any point.
5. **State and handoff were updated by hand**, accurately, rather than by a script that would have
   mis-attributed the tree.

### Consequence

This exception is now spent. **All future work on this repository must begin in a clean AI-team
worktree using the normal start / checkpoint / handoff writer-lock protocol.** A future agent that
finds a dirty tree must stop and review, not repeat this exception — the authorization was for one
named checkpoint, not a precedent.

---

## D-P10B-01 — Phase 10B V1 scope frozen

**Status:** Accepted. Ticket `TNX-P10B-ENRICHMENT-VISIBILITY`.

### Context

No canonical Phase 10B specification exists anywhere in this repository or in the sibling planning
repo: `docs/ai/DECISIONS.md`, `HANDOFF.md`, `STATE.yaml` and `PHASE-10A2-RUNNER-CONTRACT.md` all say
"Phase 10B not started" but define nothing, and the `phase-10-planning` worktree is detached at an
unrelated older commit. Rather than invent a specification from a chat prompt, this ticket derived
the smallest analyst-facing surface directly from the already-approved, binding
`PHASE-10A1-API-CONTRACT.md` read model and implemented it. This entry freezes exactly what was
built and verified, so a future session has one canonical place to check before assuming more (or
less) exists than actually does.

### Decision

Phase 10B V1 is, in full:

- A new `FindingEnrichmentPanel` on the Finding detail screen, reading
  `GET /api/findings/:id/enrichment/summary` — all six known providers always represented, the
  closed status vocabulary (`NO_SUBJECT` / `NOT_REQUESTED` / `PENDING` / `COMPLETED` /
  `UNAVAILABLE` / `SKIPPED`, each with its own label) never collapsed into a shared look, a stale
  `COMPLETED` answer visibly marked stale rather than shown as current, and NVD's verified-CVE
  subjects each rendered as their own row.
- The existing, capability-gated `POST /api/findings/:id/enrichment/runs` action ("Request
  enrichment"), gated in the UI on `trigger:finding-enrichment` — UX only. Verified against
  `backend/tests/integration/phase10a1RouteAuthorization.test.js` (real HTTP against the mounted
  app, only Prisma stubbed) that the server independently enforces the identical matrix: ADMIN/
  ANALYST allowed, REVIEWER/VIEWER refused 403 with nothing recorded, unauthenticated refused 401,
  `force=true` grants no bypass. This UI adds no new authorization surface — see `STATE.yaml`
  validation evidence for the run.
- A manual "Check status" action against `GET /api/findings/:id/enrichment/runs/:runId`. `contacted`
  is rendered directly from that response's own stored boolean, never inferred from any other field.
- `executionState` (`PAUSED_WORKER_DISABLED` / `ACTIVE`) shown beside the request control, so a
  recorded request is never presented as an executed one.

Explicitly, deliberately **not** in V1 (backlog if a future ticket needs them):

- No `force`/`justification` UI on the trigger action.
- No live polling of a run's progress — "Check status" is a single explicit action.
- No provider-configuration UI (credentials, budgets).
- No merge with, or removal of, the pre-existing legacy "IP reputation context" panel (the
  single-provider AbuseIPDB cache view) — both coexist; see the UI/UX review's finding on this.
- No backend route, controller, service, migration, or Risk v1 change of any kind — zero diff under
  `backend/`.

### Consequence

A future session extending enrichment visibility should treat this entry, not the mid-turn prompts
that produced it, as the record of what V1 actually is. Any of the deferred items above becomes its
own ticket rather than silent scope creep on this one.

---

## D-P10C1-01 — Truthful terminal summary states, and the §4 amendment they require

**Status:** Accepted. Ticket `TNX-P10C1-TRUTHFUL-TERMINAL-STATES`, Tier 2.

### Context

An independent `backend-logic-reviewer` design gate on `GET /api/findings/:id/enrichment/summary`
(base `13f7e24`) found six P1 defects: the summary's `status`/`evidenceAvailable`/`skipReason`
vocabulary collapsed materially different provider truths into the same look. Full findings, the
approved contract (v4, `READY`), and the implementation record live in
`docs/ai/PHASE-10C1-TRUTHFUL-TERMINAL-STATES-CONTRACT.md` — this entry records only the decision and
its consequence for `docs/ai/PHASE-10A1-API-CONTRACT.md` §4, whose own rule requires an explicit
approval plus this entry before that section may change.

### Decision

`docs/ai/PHASE-10A1-API-CONTRACT.md` §4's `status` vocabulary is amended: `COMPLETED` now means only
a positive answer with retrievable evidence; a new `NO_RECORD` status carries "queried, nothing on
file" (previously collapsed into `COMPLETED`); `RATE_LIMITED` and `AMBIGUOUS` are recovered out of
the previous single `UNAVAILABLE` bucket, exclusively from the closed `errorCode`/`terminalReasonCode`
diagnostics already persisted at the five existing write sites — no write site changed. Every
`SKIPPED` row now carries a non-null `skipReason`, drawn from `SKIP_REASONS` (routing-time) or a new
sibling `EXECUTION_SKIP_REASONS` vocabulary (execution-time), which is deliberately NOT merged into
`SKIP_REASONS` because `isKnownSkipReason` also filters a run item's own field. A terminal Phase-10
job now outranks a still-non-terminal delegate (closing the "terminally dead-lettered job reads
PENDING forever" defect), and `source` reports `ORCHESTRATION_JOB` when that precedence applies.
`evidenceAvailable` on a `VULNERABILITY_ENRICHMENT` row is now unconditionally `false`: this summary
layer does not read `VulnerabilityProviderStatus` or its freshness horizon, so orchestration-job
completion alone can never prove per-source positive evidence exists.

Explicitly unchanged: `SUCCESSFUL_JOB_STATES` / `FAILED_JOB_STATES` / `SKIPPED_JOB_STATES` (and
therefore `EnrichmentRun.state`'s persisted semantics), every backend write path, the endpoint's
pure-read/zero-write guarantee, and per-source vulnerability outcomes (still served only by the
existing vulnerability read surface).

### Consequence

A consumer of `GET /api/findings/:id/enrichment/summary` written against the pre-10C1 six-value
`status` vocabulary must be updated: `COMPLETED` no longer covers a nothing-on-file answer, and
`UNAVAILABLE` no longer covers a rate limit or a post-contact ambiguity. `FindingEnrichmentPanel.jsx`
was updated in the same change. A future session adding a `SUMMARY_STATUSES` value must add it to
`SUMMARY_STATUS_PRECEDENCE` in the same change — a test asserts the two sets stay equal precisely so
this cannot silently regress to the old fail-open fallback.

---

## D-P10C2-01 — Controlled force/justification and explicit run refresh UX

**Status:** Accepted. Ticket `TNX-P10C2-FORCE-JUSTIFICATION-REFRESH`, Tier 2. Base `6c9b19e`
(merged PR #23).

The existing `POST /api/findings/:id/enrichment/runs` contract is authoritative: a normal request
sends no force fields; a deliberate repeat sends `force: true` plus a trimmed 1–1000 character
`justification`. Force bypasses freshness only and never bypasses server-side capability,
configuration, budget, subject, or active-work controls. The reason remains plain request data and
is never echoed by the API.

The Finding panel exposes that repeat action only to callers whose current session advertises
`trigger:finding-enrichment` (UX gating only), blocks duplicate submissions in flight, and keeps the
ordinary request path unchanged. Run refresh remains one explicit click: it re-reads the known run
ID and then the canonical Finding summary, preserving the Phase-10C1 terminal vocabulary,
provenance, and stale markers. No polling, backend, migration, authorization, provider execution,
quota, credential, or deployment behavior changes in this ticket.
