# Phase 10A-2 — binding targeted enrichment-runner contract (v2)

Ticket: `TNX-P10A2-LIVE-ENRICHMENT-EXECUTION`
Status: BINDING, revised after the internal independent Codex design review returned
**NOT READY** with 12×P1, 1×P2, 1×P3. Every finding was verified against the repository and every
one was substantiated; §18 records the resolution of each.

Extends `docs/ai/PHASE-10A1-API-CONTRACT.md`, which stays binding for every surface it names except
the amendment in §14.

Every file path, function name, line number and column named below was read in the working tree at
`4879097282b046dc3eafdad612fccb87262a7f14`. Nothing is reconstructed from memory.

---

## 1. What Phase 10A-2 is

Phase 10A-1 records **intent** and executes nothing. Phase 10A-2 makes that intent executable,
behind a default-off switch, for five of the six providers.

| Provider | Subject | Execution | Mechanism |
|---|---|---|---|
| `censys` `greynoise` `shodan` `netlas` | IPV4 | **Direct** | the Phase-10 worker leases the `ProviderLookupJob` and calls the existing provider |
| `abuseipdb` | IPV4 | **Targeted delegate** | the worker claims the *linked* `IocEnrichment` row and drives the existing IOC runner through a new targeted entry point |
| `nvd` | CVE | **Not executed** | stays on the pre-existing ADMIN vulnerability batch |

The ordinary ADMIN IOC batch keeps its exact candidate query, outcomes, audit payload and
`recalculateAfterEnrichment` follow-up. `VulnerabilityEnrichmentJob` is **not** made worker-eligible.
No new HTTP route, no frontend change, no Risk v1 change. No second HTTP adapter, registry, result
table, cache rule, audit system or rate limiter is created.

---

## 2. Grounding

### 2.1 Symbols reused unchanged

| Symbol | File:line | Role |
|---|---|---|
| `claimPendingJob(id, {client, now, leaseMs})` | `iocEnrichmentRepository.js:264` | **the single-owner mechanism for AbuseIPDB.** Guarded `updateMany` on `(id, status=PENDING, attemptCount<maxAttempts, lease-free, nextAttemptAt gate)`; increments `attemptCount` atomically |
| `releaseClaimedJob(...)` / `completeClaimedJob(...)` / `deadLetterClaimedJob(...)` / `deadLetterExhaustedJob(...)` | `iocEnrichmentRepository.js:447 / 377 / 496 / 540` | all claim-token guarded |
| `runEnrichmentBatch(options)` | `enrichmentRunner.js:367` | ADMIN batch — **body unchanged**, per-candidate work extracted (§5.4) |
| `buildEnrichmentRuntime(overrides)` | `enrichmentRuntime.js:110` | composition root |
| `resolveEnrichmentTtl` | `enrichmentTtlPolicy.js` | TTL for every terminal result, direct and targeted |
| `recalculateAfterEnrichment(...)` | via `enrichmentExecutionService.js:245-274` | the Risk v1 boundary the ADMIN path already uses |
| `buildProvider` / `toPersistedRow` / `serializeRecord` | `censysExecutionService.js`, `shodanExecutionService.js`, `netlasExecutionService.js`, `greyNoiseExecutionService.js` — all four export exactly these | direct execution and allow-listed persistence |
| `refreshRunState(client, runId, now)` | `enrichmentRunService.js:348` | re-derives run state from items |

`execute<Provider>Lookup(findingId, …)` is deliberately **not** called: it is Finding-scoped and
synchronous, while a `ProviderLookupJob` is subject-scoped and may be shared by many Findings.

### 2.2 Facts that shaped v2, each verified

* `iocEnrichmentCacheRules.js:57` — `TERMINAL_STATUSES` is **every** status except `PENDING`.
  `RATE_LIMITED` and `TIMEOUT` are therefore **terminal**, not in-progress.
* `enrichmentRetryPolicy.js:262-276` — `EXPECTED_PROVIDER_RESULT` returns `COMPLETE` for **every**
  terminal status, including the negative ones, because a cached negative is real evidence governed
  by the TTL policy. **This is the product's existing semantics and v2 adopts it rather than
  fighting it.**
* `enrichmentReconciliationService.js:38-46` — `IOC_STATUS_TO_JOB_STATE` **omits `RATE_LIMITED` and
  `DEAD_LETTER`**, and `reconcileDelegatedJobs` (lines 91-115) never calls `refreshRunState` and
  uses the unguarded `updateJob`.
* `PROVIDER_ERROR_CODES.PROVIDER_REJECTED` exists in every provider's types module
  (`iocEnrichmentTypes.js:55`, `censysTypes.js:45`, and the netlas/shodan/greynoise equivalents) and
  is emitted for non-auth 4xx. `AttemptOutcome` has no matching value.
* `enrichmentOrchestrationConfig.js:115-118` — `parseDefaultOffSwitch` **trims and lowercases**;
  `tests/unit/enrichmentOrchestrationConfig.test.js:66-67` pins `"  TRUE  "` as enabled.
* `ProviderLookupJob` already carries a full lease and all six typed result FKs
  (`schema.prisma:3339-3433`). `ProviderLookupAttempt` has `@@unique([lookupJobId, attemptNumber])`
  and `schema.prisma:3196-3198` states the attempt is created `RESERVED` **inside the reservation
  transaction**.

---

## 3. The seven binding guarantees, traced

| # | Guarantee | Mechanism | Test |
|---|---|---|---|
| 1 | Only canonical IOC records linked to the specific Phase-10 job are considered | targeted path takes an explicit `iocEnrichmentId` from the job and calls `claimPendingJob(thatId)`; never `listPendingCandidates`. CHECK constraint (§9) makes an unlinked `RUN_DELEGATED` job impossible | T-05, T-28 |
| 2 | Reservation after the claim, before `lookup()` | fixed order §5.5, enforced by an ordering spy | T-07, T-10 |
| 3 | Attempt `IN_FLIGHT` immediately before the call | `hooks.beforeLookup()` runs on the statement preceding `provider.lookup(...)` | T-09 |
| 4 | Quota refusal makes **no `lookup()` call** and safely releases/refunds the claim | `hooks.authorize()` refusal short-circuits before the provider is constructed *and* before `lookup`; release carries `refundAttempt:true` | T-08 |
| 5 | Exactly-once database finalization | guarded `updateMany` on `state IN (RESERVED, IN_FLIGHT)`, inside the post-call transaction (§5.6) | T-25 |
| 6 | ADMIN batch behaviour retained | `runEnrichmentBatch` signature, candidate query, outcomes, summary and audit unchanged; `claimPendingJob` **not modified** | T-06 |
| 7 | No provider call executed or charged twice | both paths contend on the same `claimPendingJob` CAS; **and** the contact guard (§5.7) blocks any reclaim of a contacted row until its ambiguity is resolved | T-03, T-04, T-07, T-34 |

---

## 4. Worker activation and lifecycle

### 4.1 Activation

`ENRICHMENT_WORKER_ENABLED`, parsed by the existing `parseDefaultOffSwitch`: **trimmed and
case-insensitive `"true"`**, with no `1`/`yes`/`on` synonyms. Default **false**. *(v2 correction —
the v1 wording "only the exact string" contradicted the code and its pinned test.)*

Checked **once at startup in `server.js`**. Disabled means no worker object exists in the process at
all: no timer, no poll, no claim, no provider module constructed.

### 4.2 Startup and clock

`startEnrichmentWorker({ prisma, workerId, nowFn, ... })` in
`backend/src/services/enrichmentOrchestration/enrichmentWorker.js`, returning `{ stop(), describe() }`.
Importing the module starts nothing.

**`nowFn` is injected and called freshly immediately before every claim, every reservation and every
terminal write** — never once per tick. A sequential tick can outlive a lease or cross UTC midnight,
which would otherwise mint an already-expired lease or charge a call to the wrong `usageDate`.
*(v2 correction, F9.)*

`workerId` is `${hostname}:${pid}:${randomUUID()}`, used in audit payloads only. **It is never a
claim credential** — the credential is always a database-minted `claimToken`.

### 4.3 One tick

Sequential, non-overlapping (`setTimeout` after settle, never `setInterval`), every
`ENRICHMENT_WORKER_POLL_INTERVAL_MS`:

1. stale-claim recovery (§10.2)
2. **delegate reconciliation (§6.3)** — deliberately **before** the stale-attempt sweep, so a
   delegate that already reached a terminal state rolls its job forward instead of being swept as
   ambiguous *(v3 correction, F2)*; also removes resolved delegates from the targeted candidate set
3. stale-attempt sweep and ambiguity resolution (§10.3)
4. run-state reconciliation (§10.4)
5. direct pass — up to `ENRICHMENT_WORKER_BATCH_SIZE` **successful claims**
6. targeted AbuseIPDB pass — same bound

A tick that throws is caught, audited once, and the loop continues. One provider call in flight per
worker process; horizontal scale is more processes, which the database-backed claim already makes
safe. There is no push wakeup.

### 4.4 Shutdown

`stop()` sets a stop flag and awaits the current tick. It **aborts nothing that has already
contacted a provider**: the targeted path passes **no `AbortSignal`** into the runner, precisely so
that `enrichmentRunner.js:266-268`'s post-lookup cancellation re-check — which releases *and
refunds* a claim whose provider call already happened — can never fire on a contacted row.
*(v2 correction, F1.)* The tick's own stop flag only prevents *starting* further jobs.

---

## 5. Selection, claiming, dispatch

### 5.1 Direct candidates

`trigger = RUN_DIRECT`, `provider ∈ {censys, greynoise, shodan, netlas}`, `state = PENDING`,
lease-free (`claimToken IS NULL OR leaseExpiresAt <= now`), `attemptCount < maxAttempts`.
Ordered `requestedAt ASC, id ASC`. Index `@@index([state, nextAttemptAt, requestedAt])`.

`RETRY_WAIT` is **not** a Phase-10A-2 direct candidate state, because no provider result produces it
(§6.1). It remains in the enum, unused by this milestone.

### 5.2 Targeted candidates

`trigger = RUN_DELEGATED`, `provider = 'abuseipdb'` (positive equality — a negative filter would
silently admit any provider added later, which is what structurally excludes NVD),
`state = WAITING_ON_DELEGATE`, `iocEnrichmentId IS NOT NULL`, and a relation filter on the linked
row expressing **every gate `claimPendingJob` will apply**:

```
iocEnrichment: { is: { status: 'PENDING',
                       AND: [ { OR: [{claimToken: null}, {leaseExpiresAt: {lte: now}}] },
                              { OR: [{nextAttemptAt: null}, {nextAttemptAt: {lte: now}}] } ] } }
```

**Selection paginates** — it keeps scanning, `id ASC`, until `batchSize` claims succeed or
`MAX_SCAN = 5 × batchSize` rows have been examined. Without both the filter and the pagination, five
head-of-queue jobs whose delegates are leased, retry-gated or exhausted are re-selected every tick,
every claim loses, and later eligible work is never reached. *(v2 correction, F8.)*

A linked row with `attemptCount >= maxAttempts` is retired through the **existing**
`deadLetterExhaustedJob`, and the resulting `DEAD_LETTER` is mapped by the corrected reconciliation
(§6.3) rather than stranding the Phase-10 job.

`MANUAL_DIRECT` is excluded from both sets: that trigger describes a synchronous endpoint that
performs its own lookup inline.

### 5.3 Direct claiming

`enrichmentOrchestrationRepository.claimLookupJob(client, id, {now, leaseMs})` — the same
compare-and-swap shape `claimPendingJob` uses, guarded on
`(id, state=PENDING, attemptCount < maxAttempts, lease-free)`, setting `state=LEASED`, `claimToken`,
`claimedAt`, `leaseExpiresAt`, `lastAttemptAt` and `attemptCount: {increment: 1}` in **one**
statement. `count===1` wins; `count===0` records nothing at all. `claimToken` is the only completion
credential; `updatedAt` is never a version token.

### 5.4 The runner change — extraction, not rewrite

`enrichmentRunner.js` gains **one** exported function; the existing per-candidate body becomes a
private helper both entry points call. `runEnrichmentBatch`'s signature, candidate query, ordering,
outcomes, summary and cancellation semantics are unchanged, with the existing runner suite as the
regression proof. **`claimPendingJob` is not modified** — guarantee 6 depends on that.

```
runTargetedEnrichmentJob({ prisma, providerRegistry, now, ttlPolicy, retryPolicy,
                           leaseDurationSeconds, enrichmentId, hooks }) -> jobResult
```

Two hooks, and the ordering was corrected in v2 (F6):

| Hook | Called | Contract |
|---|---|---|
| `hooks.authorize({record, claimToken, providerDescriptor})` | after the claim, **after a side-effect-free provider descriptor is resolved**, before the provider is constructed and before `lookup` | `{proceed:true, context}` or `{proceed:false, reasonCode}`. On refusal: `releaseClaimedJob({refundAttempt:true})` and outcome `REFUSED_BEFORE_LOOKUP`. **Zero `lookup()` calls.** |
| `hooks.beforeLookup({record, context})` | on the statement immediately preceding `provider.lookup(...)` | performs `RESERVED → IN_FLIGHT` **and** sets the contact guard (§5.7). Throwing is treated as `PROVIDER_PROGRAMMER_ERROR`; the provider is not called |

Resolving the *descriptor* (does this provider name resolve? is it configured?) before `authorize`
is what lets an unknown or unconfigured provider be discovered **without spending quota**, while
still honouring guarantee 4. Guarantee 4 is therefore stated as **"no `lookup()` call"** rather than
"no provider constructed" — the v1 phrasing was self-contradictory. *(F6.)*

New additive `RUNNER_OUTCOME` values: `REFUSED_BEFORE_LOOKUP`, `TARGET_NOT_CLAIMABLE`.
`buildBatchSummary` counts them only when present, so ADMIN counters are unchanged.

### 5.5 The fixed execution order

```
1. select candidate                       (no lock, no side effect)
2. CLAIM                                  (direct: claimLookupJob; targeted: claimPendingJob)
   |- lost -> record nothing. No reservation, no attempt, no call.        [G1,G7]
3. RESOLVE PROVIDER DESCRIPTOR            (side-effect-free; unknown/unconfigured ->
                                           release WITH refund, terminalize, no charge)  [F6]
4. RESERVE QUOTA + INSERT ATTEMPT         (ONE interactive transaction, §8.3)             [F3]
   |- refused -> release WITH refund + terminal transition (§8.5). NO lookup().          [G4]
5. UPDATE attempt -> IN_FLIGHT, contactedProvider=true, AND set the contact sentinel (§5.7),
   AND audit `enrichment.lookup.contacted` — one durable transition, one audit row  [G3,F1,F12]
6. provider.lookup(...)  wrapped in the worker's OWN end-to-end bound (§5.8)
                                          (outside every transaction, no AbortSignal)
7. POST-CALL TRANSACTION (§5.6): persist evidence + finalize attempt + terminalize job    [G5,F2]
8. refreshRunState(...) for every run owning an item on this job (outside the transaction)
9. targeted AbuseIPDB only: recalculateAfterEnrichment(...) — the existing Risk v1 boundary [F11]
```

Step 3 sits between claim and reservation deliberately: a local fault must not spend quota.

### 5.6 The post-call transaction

**Direct providers.** Evidence insert (`<provider>Enrichment.create` via the reused
`toPersistedRow`), attempt finalization (guarded on `state IN (RESERVED, IN_FLIGHT)`), job
terminalization (guarded on `claimToken`), and the typed evidence FK linkage are **one
`prisma.$transaction`**. There is no unique-violation-prone insert inside it, so the aborted-
transaction trap does not apply.

This closes every boundary v1 left open: either all four writes commit, or none do and the attempt
stays `IN_FLIGHT`/`contactedProvider=true` and is resolved as ambiguous (§10.3). A `FINISHED`
attempt therefore **implies** a terminal job, so recovery can never requeue a job whose attempt
already finished. *(v2 correction, F2.)*

**Targeted AbuseIPDB.** The durable truth is the delegate row, written by the existing
`completeClaimedJob`. The Phase-10 attempt finalization is a separate guarded update, and the
Phase-10 job is terminalized by reconciliation (§6.3) reading the delegate. A crash between them
leaves the delegate terminal and the job `WAITING_ON_DELEGATE`, which the **next tick's
reconciliation** rolls forward — forward recovery, never a requeue.

### 5.7 The contact guard — how a contacted row cannot be re-called

The problem v1 missed: the IOC lease is 120s, the stale sweep 900s. A targeted call still in flight
past 120s leaves the row lease-free, and the ADMIN batch legitimately reclaims and calls the
provider a second time. *(F1.)*

The fix uses an **existing, unmodified guard**. `claimPendingJob` already refuses any row whose
`nextAttemptAt > now` (`iocEnrichmentRepository.js:286`). So the same statement that sets the
attempt `IN_FLIGHT` also sets, on the claimed `IocEnrichment` row and guarded by the claim token:

```
nextAttemptAt = CONTACT_SENTINEL   // 9999-12-31T00:00:00.000Z — a NON-EXPIRING hold
```

**v3 correction (F1).** v2 used `now + CONTACT_GUARD_SECONDS`, a duration. That was wrong: the
ordering `lease < stale < guard` bounds *durations*, not *recovery scheduling*. If no Phase-10 worker
runs for longer than the guard — the worker is disabled, or crashed and not restarted — the guard
lapses, the lease has long expired, and the ADMIN batch legitimately reclaims and re-calls the
provider. A duration cannot express "held until somebody establishes what happened".

The sentinel can only be cleared by a path that **knows** the outcome:

* `completeClaimedJob` clears `nextAttemptAt` on any terminal result (`iocEnrichmentRepository.js:412`)
  — the normal success path;
* the ambiguity sweep (§10.3) drives the row terminal, and a terminal row can never be claimed again.

While the sentinel stands, **no caller — the ADMIN batch, another Phase-10 worker, or any retry —
can claim the row**, whatever the lease says. `claimPendingJob` is not touched, and the ADMIN batch's
behaviour on every other row is byte-identical.

**Honest consequence, stated rather than hidden.** If a targeted worker dies after contact and no
Phase-10 worker ever runs again, that one `IocEnrichment` row stays held indefinitely and the ADMIN
batch will not process it. That is deliberate: we genuinely do not know whether the provider was
called and charged, and freezing one row is strictly safer than double-calling a paid third party.
The row is visible (its Phase-10 job is non-terminal, its attempt is `IN_FLIGHT` with
`contactedProvider = true`) and is resolved the moment a worker runs again. This is recorded as an
honest gap in §19.

### 5.8 The worker's own end-to-end lookup bound

**No provider's configured timeout actually bounds `lookup()`.** Verified in the source: every
provider clears its timeout handle as soon as `fetch()` resolves its *headers*, and then reads the
body afterwards — `censysProvider.js` clears at line 139 and reads at 182; `greyNoiseProvider.js`
clears at 117 and reads at 160; `abuseIpdbProvider.js` calls `composed.cleanup()` on the same
boundary. A response whose headers arrive instantly but whose body stalls therefore runs for an
unbounded time. *(v3 correction, F9.)*

That breaks the sweep's core safety property: §10.3 must never resolve an attempt that is **still
executing**, and it can only know that from a real upper bound.

The Phase-10 worker therefore imposes its **own** bound at its own call site:

```
await Promise.race([ provider.lookup(input), rejectAfter(ENRICHMENT_LOOKUP_MAX_MS) ])
```

A lost race is treated as **ambiguous** (`contactedProvider` is already `true`), not as a provider
`TIMEOUT`: the request was handed to the transport and we do not know what the provider did with it.

**Why not fix the five providers instead**, which is what the review proposed as the smallest
correction. Those modules are shared, unchanged, by the ADMIN IOC batch and by the four synchronous
analyst-facing expert endpoints. Moving the `clearTimeout` past body consumption changes the
observable behaviour of merged, working, tested code on paths Phase 10A-2 does not own, which is a
direct risk to binding guarantee 6. Bounding the call at the **one new call site that needs a bound**
achieves the property Phase 10A-2 requires and touches nothing else.

The pre-existing unbounded-body-read on the ADMIN and expert paths is **not fixed here** and is
recorded as an honest gap in §19 with a recommendation, rather than silently absorbed into this
milestone.

Cross-field validation (§15) is stated against this real bound:
`LOOKUP_MAX_MS + persistence margin < ATTEMPT_STALE_SECONDS`.

---

## 6. State transitions

### 6.1 Direct jobs — a provider result is always terminal

**v2 removes every automatic retry of a provider outcome.** `resolveEnrichmentRetry` completes every
terminal status including `RATE_LIMITED`/`TIMEOUT`/`FAILED`, because the product treats a negative
answer as real evidence governed by the TTL policy. v1 demanded `RETRY_WAIT` for exactly those
statuses, which the existing policy cannot produce and which could only have been achieved by
changing the branch the ADMIN batch shares. *(F7.)*

Adopting the existing semantics also deletes a whole class of retry-driven duplicate-call risk.
A stale answer is re-asked by creating a **new run** once `freshUntil` lapses, or immediately with
`force` plus a written justification — a human decision to spend quota.

| From | Event | To | Also written |
|---|---|---|---|
| `PENDING` | claim wins | `LEASED` | claim fields, `attemptCount+1` |
| `PENDING` | claim loses | *(unchanged)* | nothing |
| `LEASED` | descriptor unresolvable / unconfigured | `SKIPPED_NOT_CONFIGURED` | refund, `activeLookupKey=null`, `completedAt` |
| `LEASED` | quota refused | `SKIPPED_BUDGET` | §8.5, one guarded statement |
| `LEASED` | `SUCCESS` | `SUCCEEDED` | evidence FK, `queriedAt`, `freshUntil` (TTL policy), `activeLookupKey=null` |
| `LEASED` | `NOT_FOUND` | `NO_RECORD` | same |
| `LEASED` | `RATE_LIMITED` / `TIMEOUT` / `FAILED` / `INVALID_KEY` | `FAILED` | `httpStatus`, `errorCode`, `retryAfterSeconds`, `freshUntil`, `activeLookupKey=null` |
| `LEASED` | `SKIPPED_DISABLED` | `SKIPPED_DISABLED` | terminal |
| `LEASED` | `UNSUPPORTED_INDICATOR` | `SKIPPED_UNSUPPORTED_SUBJECT` | terminal |
| `LEASED` | lease expired, attempt never contacted | `PENDING` | claim cleared (§10.2) |
| `LEASED` | ambiguous crash after contact | `DEAD_LETTER` | `terminalReasonCode=AMBIGUOUS_AFTER_CONTACT` |
| any terminal | anything | *(unchanged)* | guard matches zero rows |

### 6.2 Targeted AbuseIPDB

The Phase-10 job stays `WAITING_ON_DELEGATE` throughout execution (D-P10A2-05). It leaves that state
only via reconciliation, quota refusal (§8.5), or ambiguity (§10.3).

### 6.3 Reconciliation — corrected, not "unchanged"

v1 wrongly claimed `enrichmentReconciliationService` needed no change. It omits two **terminal**
delegate statuses and never refreshes run state. *(F4.)* v2 amends it:

| Delegate `IocEnrichment.status` | Phase-10 job state |
|---|---|
| `SUCCESS` | `SUCCEEDED` |
| `NOT_FOUND` | `NO_RECORD` |
| `RATE_LIMITED` **(added)** | `FAILED` |
| `TIMEOUT` / `FAILED` / `INVALID_KEY` | `FAILED` |
| `DEAD_LETTER` **(added)** | `DEAD_LETTER` |
| `UNSUPPORTED_INDICATOR` | `SKIPPED_UNSUPPORTED_SUBJECT` |
| `SKIPPED_DISABLED` | `SKIPPED_DISABLED` |
| `PENDING` | *(no change — still working)* |

`RATE_LIMITED` maps to `FAILED` because `ProviderLookupJobState` deliberately has no `RATE_LIMITED`
and the honest meaning is "we have no answer". The transition becomes a **guarded** update (state
still `WAITING_ON_DELEGATE`), clears `activeLookupKey`, sets `completedAt`, and then calls
`refreshRunState` for **every distinct run** holding an item on that job.

Leaving this uncorrected is not a cosmetic gap: a rate-limited or dead-lettered delegate would hold
`activeLookupKey` forever, permanently blocking every future ask about that subject.

### 6.4 Attempts

| From | Event | To | Fields |
|---|---|---|---|
| — | reservation granted | `RESERVED` | `startedAt`, `attemptNumber`, `usageDate`, `lane`, `provider`, `contactedProvider=false` — **inserted in the reservation transaction** |
| `RESERVED` | immediately before lookup | `IN_FLIGHT` | `fetchStartedAt`, `contactedProvider=true`, contact guard set |
| `RESERVED`/`IN_FLIGHT` | observed result | `FINISHED` | `outcome`, `finishedAt`, `httpStatus`, `errorCode`, `retryAfterSeconds` |
| `RESERVED`/`IN_FLIGHT` | stale sweep | `FINISHED` | `outcome=ABANDONED`; `contactedProvider` preserved exactly |
| `FINISHED` | anything | *(unchanged)* | guard matches zero rows |

Provider status → `AttemptOutcome`:

| Provider status / error code | Outcome |
|---|---|
| `SUCCESS` | `SUCCESS` |
| `NOT_FOUND` | `NOT_FOUND` |
| `RATE_LIMITED` | `RATE_LIMITED` |
| `TIMEOUT` | `TIMEOUT` |
| `INVALID_KEY` | `INVALID_KEY` |
| `SKIPPED_DISABLED` | `DISABLED` |
| `UNSUPPORTED_INDICATOR` | `UNSUPPORTED_SUBJECT` |
| `FAILED` + `errorCode = PROVIDER_REJECTED` (non-auth 3xx/4xx) | **`PROVIDER_REJECTED`** *(new enum value, F10)* |
| `FAILED` + `httpStatus >= 500` | `SERVER_ERROR` |
| `FAILED`, transport/network/malformed body | `TRANSPORT_ERROR` |

Without `PROVIDER_REJECTED` a Censys HTTP 400 could only be finalized as `SERVER_ERROR` or
`TRANSPORT_ERROR`, both false.

---

## 7. Lease, ownership, recovery timing

* `ENRICHMENT_WORKER_LEASE_SECONDS` default **120**, bounds 30–3600.
* `ENRICHMENT_LOOKUP_MAX_MS` default **60000**, bounds 5000–600000 — the worker's own end-to-end
  bound on `lookup()` (§5.8), the only real upper bound that exists.
* `ENRICHMENT_ATTEMPT_STALE_SECONDS` default **600**, bounds 60–86400.
* The contact hold is a **non-expiring sentinel**, not a duration (§5.7), so there is no
  `CONTACT_GUARD_SECONDS` to tune or to get wrong.
* **Cross-field validation at configuration load:** `lease >= LOOKUP_MAX_MS + 30s` and
  `ATTEMPT_STALE_SECONDS >= LOOKUP_MAX_MS + 60s`. v1's independent bounds allowed `lease=3600,
  stale=60`, which sweeps a live attempt after one minute; v2 validated against the *provider*
  timeout, which §5.8 proves does not bound the call at all.
* Ownership is the `claimToken`, never the `workerId`. Every mutating statement carries it.

---

## 8. Quota

### 8.1 Lanes

Fixed at job creation from the run trigger and never recomputed at execution time.
`ProviderDailyUsage` is keyed `(provider, usageDate, lane)`, so the lanes are separate buckets.

### 8.2 `usageDate`

The UTC calendar day of a **freshly read** `nowFn()` taken immediately before the reservation — not a
per-tick timestamp, which could charge a long tick's later calls to the previous day.

### 8.3 Atomic reservation **and ledger creation**

`enrichmentQuotaService.reserveProviderQuota({client, provider, lane, usageDate, limit, attempt})`.

1. **Outside** any transaction: `upsert` the bucket row with `create: {reservedCount: 0}, update: {}`.
   A concurrent creator's `P2002` is caught here and retried once.
2. **One interactive `$transaction`**:
   * guarded increment
     `updateMany({where:{provider, usageDate, lane, reservedCount:{lt: limit}}, data:{reservedCount:{increment:1}, limitAtLastReservation: limit}})`;
   * `count === 0` → throw a sentinel, the transaction rolls back, result **REFUSED**;
   * `count === 1` → insert `ProviderLookupAttempt` `state=RESERVED`, `contactedProvider=false`.
     If that insert fails (including on `@@unique([lookupJobId, attemptNumber])`), the transaction
     rolls back **and the quota increment is reversed with it**.

v1 left these as two independent statements, so a crash between them charged quota with no ledger
row — a state its own crash table did not cover, and a direct contradiction of
`schema.prisma:3196-3198`. *(F3.)*

`limit === null` (unlimited): unconditional increment plus the attempt insert, same transaction,
always granted. `limit === 0`: refused with **no statement issued**.

The guard always compares against the **live configured limit**, never `limitAtLastReservation`, so
a mid-day configuration change takes effect immediately.

### 8.4 What is charged, retained or refunded

There is **no quota decrement and no refund path** (schema, by design). Accounting is deliberately
conservative: it may over-count a call reserved but never sent; it can never under-count a call that
was sent. `contactedProvider` keeps the ledger honest about which a row is.

| Scenario | Claim | Quota | Attempt | `contactedProvider` | Outcome | Job |
|---|---|---|---|---|---|---|
| Lost claim race | lost | no | none | – | – | untouched |
| Descriptor unresolvable/unconfigured | released, refunded | no | none | – | – | `SKIPPED_NOT_CONFIGURED` |
| Quota refused | released, refunded | no | none | – | – | `SKIPPED_BUDGET` (§8.5) |
| Reservation txn rolled back | released, refunded | **no** | **none** | – | – | returns to queue |
| `SUCCESS` / `NOT_FOUND` | terminal | yes | yes | true | `SUCCESS`/`NOT_FOUND` | `SUCCEEDED`/`NO_RECORD` |
| `401`/`403` | terminal | yes | yes | true | `INVALID_KEY` | `FAILED` |
| non-auth `3xx`/`4xx` | terminal | yes | yes | true | `PROVIDER_REJECTED` | `FAILED` |
| `429` / `5xx` / timeout / malformed / network | terminal | yes | yes | true | `RATE_LIMITED`/`SERVER_ERROR`/`TIMEOUT`/`TRANSPORT_ERROR` | `FAILED` |
| Crash **before** lookup, after reservation | lease expires | yes | yes | **false** | `ABANDONED` | safely re-queued |
| Crash **during/after** lookup | guard held | yes | yes | **true** | `ABANDONED` | `DEAD_LETTER` / `AMBIGUOUS_AFTER_CONTACT`, no auto-retry |

"Refunded" always means `refundAttempt: true` on the claim — never a quota decrement.

### 8.5 Quota-refusal transitions — defined for both paths

*(v2, F5. v1 defined neither safely.)*

**Direct.** ONE claim-token-guarded statement does everything at once: `state=SKIPPED_BUDGET`,
`attemptCount: {decrement: 1}`, `claimToken/claimedAt/leaseExpiresAt = null`, `activeLookupKey=null`,
`completedAt`. v1's "release with refund first, then terminalize" left a window in which another
worker could claim the released job and call the provider.

**Targeted.** The IOC claim is released with refund, and the Phase-10 job is transitioned
`WAITING_ON_DELEGATE → SKIPPED_BUDGET` with `activeLookupKey=null` and `completedAt`, guarded on its
current state. Without this the job stays `WAITING_ON_DELEGATE` forever and is re-selected every
tick. The delegate row remains `PENDING` and the ADMIN batch may still process it under its own
policy — that is existing behaviour and is stated here rather than left implicit.

Both are followed by `refreshRunState`.

---

## 9. Migration

**One additive migration**, 24 → **25**, with CI's frozen `expected_migrations` list updated in the
same commit. It contains **two** changes (v1 said "exactly one CHECK and nothing else", which F10
disproved):

```sql
ALTER TYPE "AttemptOutcome" ADD VALUE 'PROVIDER_REJECTED';

ALTER TABLE "ProviderLookupJob"
  ADD CONSTRAINT "provider_lookup_job_delegated_requires_delegate"
  CHECK ("trigger" <> 'RUN_DELEGATED'
         OR "iocEnrichmentId" IS NOT NULL
         OR "vulnerabilityEnrichmentJobId" IS NOT NULL);
```

`ALTER TYPE … ADD VALUE` cannot run inside a transaction block on PostgreSQL, so it is the **first
statement of its own migration file** and the CHECK follows; Prisma's migration runner executes
migration SQL without wrapping it in an explicit transaction, and this ordering is verified by
`migrate deploy` from zero in CI.

The CHECK is safe: `enrichmentRunService.resolveEligibleTarget` creates a `RUN_DELEGATED` job only on
the `delegate.status === "LINKED"` branch, which always sets exactly one delegate FK.

Migration `20260811162611` is merged history and is **never** edited. No column, table or index is
added — `ProviderLookupJob` already carries a full lease.

---

## 10. Recovery

### 10.1 Principle

Recovery never invents an outcome. It writes either "back in the queue" or "terminal and uncertain",
never `SUCCEEDED`, `NO_RECORD` or a fabricated failure.

### 10.2 Stale direct claims

`state = LEASED AND leaseExpiresAt <= now`, bounded, index-served by `@@index([state, leaseExpiresAt])`.
Resolved **by the owning attempt**, not by the lease alone:

* no attempt, or attempt `RESERVED` with `contactedProvider=false` → back to `PENDING`,
  `attemptCount` **not** refunded (the attempt really happened);
* attempt `IN_FLIGHT`/`contactedProvider=true` → **not** requeued; handed to §10.3;
* attempt `FINISHED` → impossible for direct jobs, because §5.6 finalizes the attempt and the job in
  one transaction. Asserted defensively and audited if ever observed.
* `attemptCount >= maxAttempts` → `DEAD_LETTER`, `terminalReasonCode=MAX_ATTEMPTS_EXHAUSTED`.

### 10.3 Stale attempts and the ambiguity split

`state IN (RESERVED, IN_FLIGHT) AND startedAt <= now - ATTEMPT_STALE_SECONDS`, bounded, index-served
by `@@index([state, startedAt])`.

**The delegate is checked FIRST for a targeted attempt** *(v3 correction, F2)*. `completeClaimedJob`
writes the delegate's terminal result and clears its claim independently of the Phase-10 attempt
(`iocEnrichmentRepository.js:399-419`), so a crash in between leaves a **genuinely successful**
delegate next to an `IN_FLIGHT`, contacted attempt. Sweeping that as ambiguous would bury a real
provider answer under `DEAD_LETTER` — inventing "we do not know" when the row on disk knows exactly.

So, for an attempt whose job is a targeted delegate:

* delegate **terminal** → finalize the attempt from that durable result (the real outcome, never
  `ABANDONED`) and let reconciliation roll the job forward;
* delegate still `PENDING` → the ambiguity rules below apply.

Otherwise the attempt is finalized `FINISHED`/`ABANDONED`, **preserving `contactedProvider` exactly**,
and the owning job is resolved by that flag:

* **`false`** — died between reservation and the call; no request reached the provider. Retry is
  demonstrably safe; the job returns to the queue.
* **`true`** — ambiguous. The job goes `DEAD_LETTER` / `AMBIGUOUS_AFTER_CONTACT` and is **not**
  retried. For a targeted job the linked `IocEnrichment` row is *also* driven terminal, while its
  contact guard still holds, through a new narrowly-guarded
  `deadLetterUnleasedJob({id, reasonCode}, {client, now})` — guard `status=PENDING` and no live
  lease, mirroring `deadLetterExhaustedJob` with the budget condition replaced by an explicit id.
  A terminal row can never be claimed again, which is what makes the duplicate impossible **after**
  the guard lapses.

An operator may re-ask explicitly with a new run and a written justification.

### 10.4 Run-state reconciliation

Runs in a non-terminal state whose items' jobs are all terminal are refreshed via `refreshRunState`.
This covers a crash between the post-call transaction and step 8, which v1 left as a permanently
stale run. *(F2.)* Bounded per tick.

### 10.5 What is and is not guaranteed

1. **Exactly-once database finalization** — real, enforced by guarded updates and §5.6's transaction.
2. **Single-owner execution** — real. Bounded not by the lease alone but by the **contact guard**,
   which holds past lease expiry until the outcome is known.
3. **Ambiguous external-call recovery** — after a crash at or past transport hand-off the system
   records `ABANDONED` with `contactedProvider=true` and stops. It claims neither that the call
   happened nor that it did not.
4. **Uncertain/manual-review terminal handling** — `DEAD_LETTER` + `AMBIGUOUS_AFTER_CONTACT` is a
   terminal, queryable, audited "we do not know", never rendered as success, failure or "no record".

**Exactly-once network delivery is not provided and is not claimed.** No system with a
non-transactional third party can provide it.

---

## 11. Risk v1 boundary

After a **successful durable targeted AbuseIPDB completion**, the worker calls
`recalculateAfterEnrichment({findingIds, asOf, client, auditContext})` with the same
exact-canonical-indicator → Finding mapping and the same failure isolation
`enrichmentExecutionService.js:245-274` already uses. v1 omitted this, so targeted enrichment would
have changed the reputation evidence while leaving the stored Risk v1 result stale — and T-32 would
still have passed, because the algorithm fingerprint is unchanged. *(F11.)*

Direct providers do **not** trigger recalculation, matching the existing synchronous
`execute<Provider>Lookup` services, which do not either. Risk v1's inputs are unchanged.

---

## 12. Audit

Per `PHASE-10A1-API-CONTRACT.md:222-227`, **every write path appends its own event**. v1 covered only
reservation, refusal, finalization, ambiguity and aggregate ticks. *(F12.)* v2 adds an entity-scoped,
allow-listed action for every new durable transition:

| Action | Payload (allow-list) |
|---|---|
| `enrichment.worker.started` / `.stopped` | `workerId`, `pollIntervalMs`, `batchSize`, `leaseSeconds` / `ticksCompleted` |
| `enrichment.worker.tick.completed` / `.failed` | `workerId` + counts only |
| `enrichment.lookup.claimed` | `provider`, `lane`, `attemptNumber` |
| `enrichment.lookup.charged` | `provider`, `lane`, `usageDate`, `attemptNumber`, `limitAtLastReservation` |
| **`enrichment.lookup.contacted`** *(v3, F12)* | `provider`, `lane`, `attemptNumber`, `contactedProvider: true` — written **with** the `IN_FLIGHT` + contact-sentinel transition, because that is the durable fact governing ambiguity and forbidding retry. Without it a crash immediately after contact leaves a trail showing quota reserved and nothing else |
| `enrichment.lookup.refused` | `provider`, `lane`, `usageDate`, closed `reasonCode` |
| `enrichment.lookup.released` | `provider`, `lane`, closed `reasonCode`, `refunded` |
| `enrichment.lookup.finalized` | `provider`, `lane`, closed `outcome`, `httpStatus`, closed `errorCode`, `contactedProvider` |
| `enrichment.lookup.ambiguous` | `provider`, `lane`, `attemptNumber`, `contactedProvider: true` |
| `enrichment.job.terminalized` | `provider`, closed `state`, closed `terminalReasonCode` |
| `enrichment.job.recovered` | `provider`, closed `reasonCode` (stale claim / exhausted / ambiguous) |
| `enrichment.delegate.reconciled` | `provider`, closed delegate status, closed resulting `state` |
| `enrichment.run.refreshed` | `runId`, closed `state` |

`AuditLog.entityId` is a **String** column — every numeric id is cast with `String(id)`.

**Never audited, logged or returned:** an API key or any prefix/length of one; a raw provider body;
a header; an exception `message`/`stack`; a `claimToken`; `queryIdentityHash`, `activeLookupKey`,
`requestScopeHash` or `idempotencyKey`; a raw justification beyond the existing ≤200-char preview.
Allow-list, not redaction.

---

## 13. Operational surface and rollback

**No new route.** `GET /api/enrichment/usage` becomes truthful — `ACCOUNTING_SCOPES` gains
`PHASE_10_RESERVATIONS_ACTIVE`, coverage stays explicitly `PARTIAL`, and no total provider-call count
is fabricated. The run-detail and summary serializers need no change; they already read `job.state`,
`job.queriedAt` and `job.freshUntil`.

**Rollback** is `ENRICHMENT_WORKER_ENABLED=false` + restart: no worker is constructed, in-flight
leases expire, stale attempts stay visible rather than being silently swept, and every 10A-1 surface
behaves as before with `executionState = PAUSED_WORKER_DISABLED`. Persisted evidence stays —
rollback stops future calls, it does not retract completed ones. No migration rollback is needed.

---

## 14. The one amendment to the Phase 10A-1 API contract

`executionState` becomes `PAUSED_WORKER_DISABLED` (switch off, still the default) | **`ACTIVE`**
(switch on). `NOT_IMPLEMENTED` is retired, because with a worker it would be false.

v1 under-scoped this. *(F13.)* The amendment must land as **one** change across **all five** places:

1. `docs/ai/PHASE-10A1-API-CONTRACT.md` §2;
2. `EXECUTION_STATES` in `enrichmentDecisionCodes.js:119-122` and its explanatory comment;
3. `resolveExecutionState` in `enrichmentRunReadService.js:53-59`;
4. the pinned assertion at `tests/unit/enrichmentRunServices.test.js:257`;
5. a new assertion that `NOT_IMPLEMENTED` is absent from the exported closed vocabulary.

Changing only the read service would emit a value outside `EXECUTION_STATES`. This is the **only**
change to any Phase 10A-1 response field; routes, status codes, `outcome`, `run`, `items`, the
summary shape and the upload block's six keys are unchanged and pinned by T-31.

NVD's non-execution stays a per-provider fact (`SKIP_REASONS.DELEGATE_BATCH_REQUIRED`,
`source: VULNERABILITY_ENRICHMENT`), not a deployment-level one.

---

## 15. Configuration

| Variable | Default | Bounds | Meaning |
|---|---|---|---|
| `ENRICHMENT_WORKER_ENABLED` | `false` | trimmed, case-insensitive `true` | starts the worker |
| `ENRICHMENT_WORKER_POLL_INTERVAL_MS` | `15000` | 1000–3600000 | delay between ticks |
| `ENRICHMENT_WORKER_BATCH_SIZE` | `5` | 1–50 | successful claims per pass |
| `ENRICHMENT_WORKER_LEASE_SECONDS` | `120` | 30–3600 | direct-job lease |
| `ENRICHMENT_LOOKUP_MAX_MS` | `60000` | 5000–600000 | the worker's own end-to-end bound on `lookup()` (§5.8) |
| `ENRICHMENT_ATTEMPT_STALE_SECONDS` | `600` | 60–86400 | age at which an unfinished attempt is swept |
| `<PROVIDER>_AUTOMATIC_DAILY_BUDGET` | `0` | 0–1000000 | now genuinely enforced |
| `<PROVIDER>_MANUAL_DAILY_BUDGET` | unlimited | 0–1000000 or `unlimited` | now genuinely enforced |

**Cross-field validation, enforced at load:** `lease >= LOOKUP_MAX_MS + 30s` and
`ATTEMPT_STALE_SECONDS >= LOOKUP_MAX_MS + 60s`. A violating combination fails configuration
validation loudly, naming the variables and never their values.

`docker-compose.yml`'s backend passes all Phase-10A-2 controls and every provider budget through from
the operator environment, each defaulting to the safe value, so a plain `docker compose up` stays
default-off. No real value is committed and no tracked secret file is created.

---

## 16. Test matrix

Injected fake providers and fake `fetchImpl` only; **real PostgreSQL** for every concurrency, quota,
ordering and recovery case.

T-01 worker-disabled inertness · T-02 one direct job executes once · T-03 two workers race one direct
job · T-04 cross-Finding shared work executes once · T-05 targeted cannot claim an unrelated IOC id ·
T-06 ADMIN batch unchanged **(now also over the real ADMIN endpoint: candidate query, audit payload,
Risk v1 follow-up, real-PG concurrency)** · T-07 lost claim reserves zero quota · T-08 quota refusal
performs zero lookups **and** asserts claim-token removal, refund, terminal job, cleared
`activeLookupKey`, refreshed run, plus a two-worker refusal race · T-09 attempt is `IN_FLIGHT` at
lookup entry · T-10 lookup only after a grant · T-11 N concurrent reservations against limit L grant
exactly L · T-12 lanes independent · T-13 `SUCCESS` · T-14 `NOT_FOUND` never "clean" · T-15 401/403 ·
T-16 404 · T-17 429 · T-18 5xx · T-19 timeout · T-20 malformed · T-21 network failure · T-22 crash
before lookup → safe requeue · T-23 crash during/after lookup → ambiguous, never retried · T-24 stale
claim recovery · T-25 attempt finalizes once · T-26 evidence persists via `toPersistedRow`, all four
providers · T-27 summary truthful · T-28 NVD never claimed · T-29 no live provider reachable in CI ·
T-30 no key/body/header/token/hash leaks · T-31 10A-1 contract unchanged but for `executionState` ·
T-32 Risk v1 fingerprint unchanged · T-33 ingestion non-blocking.

**Added in v2, one per finding:**

| Test | Proves |
|---|---|
| T-34 | Blocked targeted lookup held past lease expiry, ADMIN batch racing it → **one** call, **one** charge; plus abort immediately after transport hand-off (F1) |
| T-34b | **Recovery never runs**: crash after contact, advance the clock arbitrarily far, run the ADMIN batch *first* with no Phase-10 worker → still **one** call and **one** charge, because the sentinel never expires (F1, v3) |
| T-35 | Fault injection after each of steps 6, 7, 8, 9 → no repeat lookup, no orphan evidence, terminal run (F2) |
| T-35b | **Targeted intra-step boundary**: crash after `completeClaimedJob` commits `SUCCESS` but before Phase-10 attempt finalization; restart past `ATTEMPT_STALE` → the attempt finalizes with the **provider-derived outcome**, never `ABANDONED`, and the job reaches `SUCCEEDED`, never `DEAD_LETTER` (F2, v3) |
| T-36 | Error injected after the usage increment but before the attempt insert → **neither** survives (F3) |
| T-37 | `RATE_LIMITED` and `DEAD_LETTER` delegates, and one success shared by two runs → terminal jobs, cleared keys, terminal stored run states (F4) |
| T-38 | Unknown/unconfigured provider after a successful claim → zero quota, no attempt, safe release, zero lookups (F6) |
| T-39 | The same normalized `RATE_LIMITED` yields ADMIN `COMPLETE` and Phase-10 direct terminal `FAILED`; the ADMIN policy branch is untouched (F7) |
| T-40 | Head-of-queue jobs with live-leased, retry-gated and exhausted delegates → later eligible work still executes; exhausted delegates terminate (F8) |
| T-41 | Unsafe `lease`/`stale`/`LOOKUP_MAX_MS` combinations rejected at load; slow multi-job tick crossing lease expiry and UTC midnight charges the correct day (F9) |
| T-41b | **Headers resolve immediately, body stalls** past `ATTEMPT_STALE`: the worker's own bound (§5.8) fires first, the attempt is resolved as **ambiguous** rather than as a provider `TIMEOUT`, and the sweep never resolves an attempt whose call is still executing (F9, v3) |
| T-42 | Non-auth 3xx/4xx for all four direct providers and AbuseIPDB → `PROVIDER_REJECTED` (F10) |
| T-43 | Stored risk result before targeted AbuseIPDB success → recalculated afterwards, fingerprint unchanged (F11) |
| T-44 | Failure after each durable transition but before tick completion → a durable audit row exists, carrying no subject, key, body, header, token or hash (F12) |
| T-44b | Crash **immediately after the contact transition** → the exact `enrichment.lookup.contacted` action is present. Finding merely "some earlier audit row" is explicitly insufficient (F12, v3) |
| T-45 | `resolveExecutionState` false→`PAUSED_WORKER_DISABLED`, true→`ACTIVE`; `NOT_IMPLEMENTED` absent from the exported vocabulary (F13) |

**Mutation checks** — each must fail the suite when applied: reservation before the claim (T-07);
`IN_FLIGHT` after the lookup (T-09); dropping the finalization guard (T-25); widening the targeted
selector to `listPendingCandidates` (T-05, T-28); auto-retrying `contactedProvider=true` (T-23);
removing the contact guard (T-34); splitting the reservation transaction (T-36); reverting
reconciliation's added statuses (T-37).

---

## 17. Phase exit criteria

1. Every guarantee in §3 has a passing test named in §16.
2. `prisma format`/`validate`/`generate`; `migrate deploy` from zero applies **25/25**;
   `migrate diff --exit-code` clean; CI's frozen list reads 25.
3. Full backend suite green against real PostgreSQL with every provider key empty.
4. All nine core evaluators PASS; `eval:risk` re-proves the Risk v1 fingerprint.
5. Frontend lint/tests/build and the Chromium suite green; `git status frontend/` empty.
6. Secret and generated-artifact scans clean; no real `.env` read at any point.
7. Fresh-stack rehearsals: worker disabled → zero provider calls; worker enabled with injected
   fake/local providers → work executes, quota charged once, evidence persists.
8. The final independent Codex implementation review's P0/P1 findings resolved.
9. `main` untouched, no PR opened, Phase 10B not started.

---

## 18. Response to the Codex design review

Verdict received: **NOT READY FOR PHASE 10A-2 IMPLEMENTATION** — 12×P1, 1×P2, 1×P3, no P0.
Every finding was checked against the repository. **All 14 were substantiated and accepted; none was
rejected as invented.** Four were verified by direct source inspection before acceptance:
`enrichmentRetryPolicy.js:262-276` (F7), `iocEnrichmentCacheRules.js:57` + the reconciliation map
(F4), `PROVIDER_REJECTED` across the provider type modules (F10), and the two pinned tests (F13,
F14).

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | P1 | Shared IOC lease permits a second call after contact | **Contact guard** (§5.7) sets `nextAttemptAt` past the ambiguity window in the same statement as `IN_FLIGHT`, reusing `claimPendingJob`'s existing gate with **no change to it**; targeted path passes **no `AbortSignal`** (§4.4) so post-contact cancellation cannot release a contacted claim |
| 2 | P1 | Unrecoverable post-call crash boundaries | **One post-call transaction** (§5.6) covering evidence + finalization + job transition + linkage; run-state reconciliation sweep (§10.4); a `FINISHED` attempt now implies a terminal job, so recovery rolls forward and never requeues |
| 3 | P1 | Reservation and attempt ledger not atomic | Both in **one interactive transaction** (§8.3); an attempt-insert failure rolls the increment back |
| 4 | P1 | Reconciliation cannot complete all outcomes | §6.3 **amends** it: `RATE_LIMITED → FAILED`, `DEAD_LETTER → DEAD_LETTER`, guarded transition, `activeLookupKey` cleared, `refreshRunState` for every linked run |
| 5 | P1 | Quota-refusal transitions undefined/racy | §8.5 defines both; direct refusal is **one** guarded statement, closing the release-then-terminalize window |
| 6 | P1 | Hook contract contradicts its own ordering | §5.4/§5.5: claim → **side-effect-free descriptor** → reserve → attempt → construct → lookup. Guarantee 4 restated as "no `lookup()` call" |
| 7 | P1 | Existing retry policy cannot produce the proposed states | §6.1 **adopts the existing semantics**: a provider result is always terminal; no automatic retry, no second policy, ADMIN branch untouched |
| 8 | P1 | Targeted selection can starve eligible work | §5.2 adds the full relation filter and **pagination to N successful claims**; exhausted delegates retired via the existing `deadLetterExhaustedJob` |
| 9 | P1 | Time/recovery configuration allows sweeping live work | §4.2 injects `nowFn` read fresh per claim/reservation/write; §7/§15 add **cross-field validation** `lease < stale < contactGuard` and a timeout margin |
| 10 | P1 | `AttemptOutcome` cannot represent a real rejection | **`PROVIDER_REJECTED` added** to the enum in the same migration (§9); mapping in §6.4 |
| 11 | P1 | Targeted completion omits the Risk v1 boundary | §11 reuses `recalculateAfterEnrichment` with the ADMIN path's mapping and isolation |
| 12 | P1 | New write paths not fully audit-covered | §12 adds entity-scoped actions for claim, release, terminalization, recovery, reconciliation and run refresh |
| 13 | P2 | D-P10A2-03 incomplete in the reviewed tree | §14 lists all **five** places the amendment must land together, including the pinned test |
| 14 | P3 | Activation-parser claim does not match code | §4.1 corrected to "trimmed, case-insensitive `true`" |

Test-matrix gaps the review identified are closed by T-34…T-45 and the extended T-06 and T-08.

### Second round — the bounded re-check

The single bounded re-check permitted by this ticket returned **NOT READY** again, with
**10 of 14 resolved** and four narrowed to specific, concrete corrections. Each was verified and
applied; **F9 was confirmed by direct source inspection** and is a genuine, previously unnoticed
property of the provider layer.

| # | Re-check result | v3 correction |
|---|---|---|
| F1 | Not resolved — a *duration* guard bounds durations, not recovery **scheduling**; with no worker running, the guard lapses and ADMIN reclaims | §5.7 replaces it with a **non-expiring sentinel** cleared only by known completion or ambiguity recovery. Simpler than a tuned duration and strictly safer. T-34b |
| F2 | Not fully resolved — targeted completion commits the delegate independently, so a crash between it and attempt finalization buries a real `SUCCESS` under `DEAD_LETTER` | §10.3 checks the **delegate first**; a terminal delegate finalizes the attempt from its durable result. §4.3 also reorders the tick so reconciliation precedes the sweep. T-35b |
| F9 | Not resolved — **no provider timeout actually bounds `lookup()`**: every provider clears its timeout when headers arrive and reads the body afterwards (`censysProvider.js:139/182`, `greyNoiseProvider.js:117/160`) | §5.8 adds the worker's **own end-to-end bound** at its own call site, rather than modifying five shared provider modules the ADMIN and expert paths depend on. Cross-field validation now references that real bound. T-41b |
| F12 | Not fully resolved — `RESERVED → IN_FLIGHT` + contact sentinel is a durable transition with no audit action | §12 adds `enrichment.lookup.contacted`, written with that transition. T-44b |

Codex confirmed **no new blockers introduced by v2** beyond these four, and confirmed guarantee 4
(extended T-08/T-38), guarantee 6 (extended T-06) and the T-32 gap (T-43) as closed.

**Review budget.** This ticket permits one design review plus one bounded re-check; both are spent.
Three of the four v3 corrections apply Codex's own stated *smallest correction* verbatim. One — F9 —
deliberately takes a **narrower** correction than proposed, for the reason given in §5.8: changing
the timeout semantics of five shared provider modules would alter merged, tested behaviour on the
ADMIN and analyst-facing paths, which is a direct risk to binding guarantee 6. That divergence is
recorded here rather than presented as compliance. The Stage 5 final implementation review examines
all four against real code.

---

## 19. Honest gaps

1. **A contacted row can be held indefinitely.** If a targeted worker dies after provider contact and
   no Phase-10 worker ever runs again, the sentinel (§5.7) keeps that one `IocEnrichment` row
   unclaimable, including by the ADMIN batch. Deliberate: freezing one row is safer than
   double-charging a paid third party when we cannot know whether the call happened. It is visible
   and self-resolves when a worker next runs.
2. **The pre-existing unbounded body read is not fixed.** `lookup()` is unbounded on the ADMIN batch
   and the four synchronous expert endpoints too, because every provider clears its timeout at the
   header boundary (§5.8). Phase 10A-2 bounds only its own call site. **Recommendation for a future
   ticket:** move each provider's `clearTimeout`/`cleanup` past body consumption and normalization,
   with its own review — that is a change to shared, merged code and does not belong in this
   milestone.
3. **`RETRY_WAIT` becomes an unused `ProviderLookupJobState` value** (D-P10A2-06). Kept rather than
   removed: removing an enum value is a destructive migration, and a future ticket may want it.
4. **No push wakeup.** Recorded work is discovered on the next poll, so worst-case latency is one
   `ENRICHMENT_WORKER_POLL_INTERVAL_MS`.
5. **One provider call in flight per worker process.** Throughput scales by running more processes,
   which the database-backed claim already makes safe; there is no in-process concurrency.
