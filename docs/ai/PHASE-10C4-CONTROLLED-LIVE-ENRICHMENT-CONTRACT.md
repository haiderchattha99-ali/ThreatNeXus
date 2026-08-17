# Phase 10C-4 — Controlled Live Enrichment Go-Live Contract

**Ticket:** `TNX-P10C4-CONTROLLED-LIVE-ENRICHMENT-GO-LIVE`
**Tier:** 3 (external contact, real spend, go-live boundary)
**Status:** FROZEN — design/contract gate, **revision 2** (post-review). No implementation and no
live contact were performed in the session that produced this document.
**Revision 2 changes:** §3.2 (legacy synchronous contact path) is new and is the most important
correction; §12.2's preflight grew from 14 to 17 assertions and P4/P12's claims were corrected;
§13.2 gained a fifth state; §10, §11, §13.1, §15, §17.2 and §19 were corrected. Revision 1's false
claims are marked in place rather than deleted.
**Live base SHA:** `0f8183518c485cc3be5ee29b5a2ea5be7a37ca24` (`origin/main`, merge of PR #25,
`feat/phase-10c3-provider-credential-budget-operability`)
**Branch:** `feat/phase-10c4-controlled-live-enrichment`
**Worktree:** `F:\AI-Worktrees\ThreatNeXus\phase-10c4`
**Supersedes nothing.** Extends 10C-1/10C-2/10C-3 without changing any of their semantics.

---

## 1. The question this ticket answers

10C-3 established **configuration truth**: for each `(provider, lane)` the system reports one of
seven closed readiness values derived from deployment configuration and today's usage, without ever
calling a provider (`enrichmentProviderReadiness.js`).

10C-4 answers the next, strictly different question:

> Can the already-implemented enrichment execution stack contact a **real** provider **once**,
> under operator authorization, with bounded spend and durable evidence — and return to default-off
> afterwards — without weakening any existing default-off guarantee?

`provider configured` (10C-3) and `production enabled` (never) are both explicitly *not* what this
ticket delivers. This ticket delivers **one bounded execution proof**.

### 1.1 What this ticket refuses to be

Not a production rollout program. Not a new provider framework. Not a credential-management system.
Not an auto-scaling worker design. Not a deployment-platform migration. Not a broad observability
project. Not a hosting decision. See §16.

---

## 2. Grounded current reality (read from source at `0f81835`)

### 2.1 Providers in the Phase-10 execution path

| Provider | Path | Credential gate | Worker-eligible |
|---|---|---|---|
| `censys` | DIRECT (`../exposure/censysExecutionService`) | `CENSYS_PAT` | yes |
| `greynoise` | DIRECT (`../reputation/greyNoiseExecutionService`) | `GREYNOISE_API_KEY` | yes |
| `shodan` | DIRECT (`../exposure/shodanExecutionService`) | `SHODAN_API_KEY` | yes |
| `netlas` | DIRECT (`../exposure/netlasExecutionService`) | `NETLAS_API_KEY` | yes |
| `abuseipdb` | DELEGATED / targeted (`enrichmentTargetedIocService`, via `IocEnrichment`) | `ABUSEIPDB_API_KEY` | yes (targeted pass) |
| `nvd` | structurally delegated, `DELEGATED_BATCH_REQUIRED` | keyless (`isProviderCredentialConfigured` returns `true` unconditionally) | **no** |

Source: `enrichmentDirectExecutionService.js:46-53`, `enrichmentOrchestrationConfig.js:301-319`,
`enrichmentProviderReadiness.js:140-141`.

### 2.2 The execution ordering that a canary exercises

`enrichmentDirectExecutionService.executeDirectJob` (:184-399), driven by
`enrichmentWorker.runDirectPass` (:344-392):

1. **descriptor** — side-effect-free `resolveDescriptor(provider, appConfig)`; an unconfigured
   provider terminalizes `SKIPPED_NOT_CONFIGURED` with **no quota spent** and `contacted: false`.
2. **reserve + ledger** — `reserveProviderQuota` increments `ProviderDailyUsage.reservedCount`
   under a compare-and-swap (`reservedCount: { lt: limit }`) **and** inserts the
   `ProviderLookupAttempt` in **one transaction** (`enrichmentQuotaService.js:226-247`). A refusal
   rolls both back and terminalizes the job `SKIPPED_BUDGET`.
3. **IN_FLIGHT** — `markAttemptInFlight` sets `state=IN_FLIGHT`, `fetchStartedAt`, and
   `contactedProvider=true` **before** the request is issued (:278-289). This is the durable
   contact fact.
4. **the call** — `lookupWithBound(provider, input, lookupMaxMs)` races `lookup()` against the
   worker's own end-to-end bound (:161-173).
5. **one post-call transaction** — evidence row + `finalizeAttempt` + job transition commit
   together or not at all (:326-364); either guard mismatching throws `StaleClaimError` and rolls
   everything back.
6. **run refresh** — `refreshRunsForJob` settles every owning `EnrichmentRun`.

### 2.3 Attempt/job vocabulary already available as evidence

`ProviderLookupAttempt`: `state` ∈ {`RESERVED`,`IN_FLIGHT`,`FINISHED`}, `outcome` ∈ the 12-member
`ATTEMPT_OUTCOMES` set, `contactedProvider`, `httpStatus`, `errorCode`, `retryAfterSeconds`,
`startedAt`, `fetchStartedAt`, `finishedAt`, `usageDate`, `attemptNumber`, `lane`.

`ProviderLookupJob.state` ∈ `SUCCEEDED` | `NO_RECORD` | `FAILED` | `SKIPPED_NOT_CONFIGURED` |
`SKIPPED_BUDGET` | `SKIPPED_DISABLED` | `SKIPPED_UNSUPPORTED_SUBJECT` | `WAITING_ON_DELEGATE` |
`DEAD_LETTER` (+ `terminalReasonCode`, notably `AMBIGUOUS_AFTER_CONTACT`).

`ProviderDailyUsage(provider, usageDate, lane)`: `reservedCount`, `limitAtLastReservation`.
**There is no decrement and no refund** (`enrichmentQuotaService.js:36-43`) — accounting is
deliberately conservative and may over-count a reserved-but-unsent call, never under-count a sent
one.

### 2.4 Lane selection

`enrichmentRunService.js:701` — `lane = trigger === RUN_TRIGGERS.INGESTION ? AUTOMATIC : MANUAL`.
Any analyst/operator-triggered run is therefore **MANUAL lane**.

### 2.5 Force semantics (10C-2), re-verified in source

`enrichmentApplicabilityRouter.routeTarget` step 3: *"A fresh answer already exists. `force`
bypasses this and nothing else."* `force` is evaluated **only** against `hasFreshResult`. Credential
(step 2) and budget-zero (step 4) refusals are evaluated independently of `force`, and the atomic
reservation in step 2 of §2.2 has no force parameter at all. **Force cannot bypass any hard
configuration or budget control.** (`enrichmentApplicabilityRouter.js:118-141`,
`enrichmentRunService.js:376-377`, `D-P10C2-01`.)

### 2.6 Pre-existing live-call infrastructure (Phase 8D)

`backend/src/scripts/{censys,greyNoise,shodan,netlas,nvd}LiveSmoke.js`, exposed as
`npm run smoke:*`. Each is gated behind a per-provider opt-in variable (`LIVE_GREYNOISE_SMOKE=1`
etc.) that **nothing in the test suite, evaluators, or CI ever sets**, uses a fixed benign subject,
and prints only normalized safe fields.

**These prove the provider ADAPTER only.** They construct the provider directly and call `lookup()`.
They do not create a job, do not reserve quota, do not write a `ProviderLookupAttempt`, and do not
exercise the worker, the claim, the post-call transaction, or run/summary settlement. **That gap is
exactly what 10C-4 exists to close.**

### 2.7 Deployment / environment passthrough

`docker-compose.yml:91-136` passes every provider credential and every budget/switch through from
the host environment with safe defaults (`ENRICHMENT_WORKER_ENABLED:-false`,
`AUTO_ENRICHMENT_ENABLED:-false`, every `*_AUTOMATIC_DAILY_BUDGET:-0`, every
`*_MANUAL_DAILY_BUDGET:-` i.e. blank). `backend/.env.example` documents the same set. No credential
is committed; every value is empty in the example and in CI.

`docs/OPERATIONS_RUNBOOK.md` §"Enrichment worker (Phase 10A-2)" already documents *is it running*,
*how much quota has been spent*, *which providers are usable*, *why a job is stuck*,
*`AMBIGUOUS_AFTER_CONTACT`*, and *turning it off*.

Precisely on CI: the Browser-suite job blanks GreyNoise/Shodan/Netlas explicitly
(`.github/workflows/ci.yml:368-372`); other jobs blank `ABUSEIPDB_API_KEY` alone (`:463`, `:473`,
`:585`) and leave the rest **undefined**. Equivalent in effect — `env.js:546` coerces `undefined` to
`""` — but "CI sets every provider key to `''`" is not literally what the file says.

---

## 3. Grounded default-off model

A network contact from the Phase-10 path is possible **only** when **every** link below holds. Each
is independent; breaking any one of them refuses.

| # | Gate | Source | Default |
|---|---|---|---|
| 1 | Process boot reads `ENRICHMENT_WORKER_ENABLED` **once** and only then `require`s the worker module and calls `startEnrichmentWorker` | `backend/server.js:17-25` (the sole call site in all of `backend/`; no `setInterval` or cron exists anywhere in `backend/src`) | `false` — module never loaded, no timer, no provider object in memory |
| 2 | A `ProviderLookupJob` must exist in a claimable state | `enrichmentRunService`, `listDirectCandidates` | none exist until a run is created |
| 3 | For an AUTOMATIC job to be *recorded* at all, `AUTO_ENRICHMENT_ENABLED` must be true | `enrichmentOrchestrationConfig.js:159`, `AUTOMATIC_DISABLED` skip reason | `false` |
| 4 | Provider credential must be non-blank (`nvd` excepted, keyless) | `isProviderCredentialConfigured` (:301-319) | all blank → `NOT_CONFIGURED` |
| 5 | Routing must not refuse: subject compatibility, credential, lane budget ≠ 0 | `enrichmentApplicabilityRouter.routeTarget` | AUTOMATIC budgets 0 → refuse |
| 6 | Descriptor re-check before any charge (defence in depth on #4) | `resolveDescriptor` (:120-127) | refuses `SKIPPED_NOT_CONFIGURED`, spends nothing |
| 7 | Atomic quota reservation must be GRANTED | `reserveProviderQuota` (:177-266) | `limit === 0` refuses without issuing a statement |
| 8 | `nvd` is structurally never worker-eligible | `subjectTypeForProvider === CVE` → `DELEGATED_BATCH_REQUIRED` | permanent |

**Two independent switches plus a zero budget, not one switch.** `AUTO_ENRICHMENT_ENABLED=false`
**and** `ENRICHMENT_WORKER_ENABLED=false` **and** every `*_AUTOMATIC_DAILY_BUDGET=0` **and** every
credential blank. A default deployment therefore cannot contact a provider even if one of these were
inverted by mistake.

**Scope of this table: the Phase-10 orchestration path only.** §3.2 names the paths it does *not*
cover.

Note on gate 3: `AUTO_ENRICHMENT_ENABLED` is **not** inherited from the boot-frozen config the way
gate 1 is. `reportIngestionService.js:932` calls `resolveOrchestrationConfig(process.env)` **per
ingestion**. The value is still default-false and still blocks, but it does not carry gate 1's
read-once-at-boot property and must not be described as if it does.

### 3.2 Contact paths OUTSIDE the Phase-10 gate table (armed by the credential alone)

**This is the most important correction in this contract.** Four legacy synchronous provider routes
reach a provider **without** touching a single gate in §3's table. For GreyNoise:

`POST /api/findings/:id/enrichment/greynoise`
(`greyNoiseEnrichmentRoutes.js:37-42`) → `greyNoiseEnrichmentController.js:58-62` →
`greyNoiseExecutionService.js:84-91,168-171`, which builds the provider straight from
`env.GREYNOISE_API_KEY` and calls `provider.lookup()` directly.

It does **not** consult `ENRICHMENT_WORKER_ENABLED`. It does **not** call `reserveProviderQuota`. It
writes **no** `ProviderLookupAttempt` and **no** `ProviderDailyUsage` row. It is not wrapped in
`lookupWithBound`, so §17's residual is unbounded in **both** dimensions on this path. Its only
bound is `providerRateLimiter` (`RATE_LIMIT_PROVIDER_MAX`, default 60 per 15 minutes,
`env.js:242-247`).

**It goes live the moment the operator sets `GREYNOISE_API_KEY` at C2 — for the entire canary
window.** The repository already knows this: `enrichmentUsageService.js:79-83` lists
`SYNCHRONOUS_DIRECT_PROVIDER_ROUTES` in `EXCLUDED_PATHS`, and its header (`:11-22`) states these
routes "still contact providers outside Phase-10 accounting."

Mitigating, and why this is a disclosed residual rather than a blocker on the canary: **no frontend
code calls it.** `FindingEnrichmentPanel.jsx:4,144-145` posts only to `.../enrichment/runs`, and a
grep of `frontend/src` for the legacy paths returns nothing. Reaching it requires a deliberate
hand-made authenticated request.

**Consequences this contract must honour, and does:**

- §10's "one outbound request" cap is enforced by configuration **on the Phase-10 path** and by
  operator discipline **on this path**. I-04 is qualified accordingly.
- A `ProviderLookupAttempt` count is therefore **not** a sufficient no-second-contact proof. §13.1
  adds two queries that discriminate regardless of which path produced a call.
- The same applies to `censys`, `shodan` and `netlas`, but their credentials stay blank throughout,
  so `isEnabled()` short-circuits before any fetch (`greyNoiseProvider.js:237-245` shape). GreyNoise
  is the only one armed during the canary.
- The legacy ADMIN IOC batch (`POST /api/enrichment/batches/run`, `enrichmentBatchRoutes.js:20-25`)
  is a second non-Phase-10 spender. It is blocked by `ABUSEIPDB_API_KEY` staying blank (preflight
  P4) and by `IOC_ENRICHMENT_PROVIDER=mock` (preflight P16).

### 3.3 The one asymmetry this contract must handle

`DEFAULT_MANUAL_DAILY_BUDGET = null`, and **`null` means UNLIMITED**
(`enrichmentOrchestrationConfig.js:39-40`, `reserveProviderQuota` :227-232 — an unlimited
reservation is counted but never refused). A blank `GREYNOISE_MANUAL_DAILY_BUDGET=` resolves to
`null`, not to `0`.

This is a deliberate, already-accepted design (an analyst pressing a button is an explicit human
decision, and the synchronous expert endpoints carry their own `RATE_LIMIT_PROVIDER_*` limiter). It
is **not** a defect and this ticket does not change it.

But it means: **a canary that relies on defaults for the MANUAL lane is unbounded.** The canary
budget must be set *explicitly and positively*, and a deterministic preflight must refuse to
authorize the run if it is not. This single fact is the reason §12's preflight exists.

---

## 4. Go-live definition (binding)

> **ThreatNeXus "go-live" for 10C-4 means exactly this and nothing more:**
>
> A **single**, **operator-authorized**, **MANUAL-lane** enrichment run, for **one** approved
> provider, against **one** approved benign subject, executed by a **real** enrichment worker
> process in a **disposable local stack**, under an **explicitly configured budget of exactly one
> reservation**, producing **durable ledger evidence** that distinguishes *refused before lookup*
> from *contact attempted* from *contact outcome known*, and followed by a **verified return to
> default-off** with **no second contact**.

Explicitly **not** included in that definition:

- any production or staging deployment, any hosting change, any new infrastructure;
- any continuously-running worker;
- any AUTOMATIC-lane execution;
- any assertion that the provider returned useful intelligence (see §9);
- any change to a default in `.env.example`, `docker-compose.yml`, or CI.

---

## 5. Split preflight

Independent high-risk surfaces counted: worker enablement · live credentials · real network
contact · spend/quota · subject selection · environment change · rollback/kill switch · live
evidence capture. **Eight named surfaces.**

**Decision: ONE ticket. No split.**

Rationale — the eight are not independently landable. They are eight *facets of one ceremony*, not
eight systems:

- a rollback plan with no canary to roll back is untestable;
- a budget cap with no contact is unproven;
- credential handling, subject selection, and worker enablement are *preconditions* of the same
  single run, not separate deliverables;
- evidence capture is a read of state the same run produces.

Splitting would produce tickets that cannot each close on their own evidence, which is the failure
mode the split preflight exists to prevent — and it would multiply the number of times the worker is
enabled against a live provider, which is the opposite of the safety goal.

Crucially, **no independent risky system is created**: §14 establishes that the implementation
surface adds no product code to the execution path. The bounded-implementation estimate is well
inside the 20–40 minute target.

Per `TEAM-WORKFLOW.md` — *"Split only if implementation would otherwise create multiple independent
risky systems"* — this does not meet the split bar. Splitting here would be ceremonial.

---

## 6. Live-proof provider selection

### 6.1 Chosen: `greynoise` — and only `greynoise`

| Criterion | GreyNoise Community API |
|---|---|
| Cost | **Free tier.** Community API, no paid credit consumed per lookup. |
| Credential complexity | **One variable**, `GREYNOISE_API_KEY`, sent as a single `key:` header (`greyNoiseProvider.js:258`). No org ID, no OAuth, no token exchange. |
| Request shape | **One `GET`**, `https://api.greynoise.io/v3/community/{ip}` (`greyNoiseConfig.js:13`). Read-only; no write, no scan, no side effect on any third party. |
| Rate-limit risk | One request. Community tier daily allowance is far above one. |
| ToS / legal ambiguity | Lowest of the five. A passive reputation lookup of a public IP against a vendor's own documented endpoint. No scanning, no probing of the subject itself. |
| Irreversible side effect | None. `GET` against a vendor's read API. |
| Environment complexity | Provider already fully implemented, already has a Phase-8D smoke script, already has an approved benign subject in-repo. |
| Response classification quality | Best of the five for proving truthfulness: `404 → NOT_FOUND` is a **first-class, expected** answer (`greyNoiseProvider.js:136-137`), which is precisely the "provider returned nothing, and that is still a success of the architecture" case §9 requires. |

### 6.2 What the `greynoise` canary proves

Because `greynoise` is a **DIRECT** provider, one canary exercises the **direct-lane shared
orchestration path** — the same code every other direct provider uses:

`enrichmentRunService` run creation → `enrichmentApplicabilityRouter` routing → job materialization
→ `enrichmentWorker.runDirectPass` candidate scan → `repository.claimLookupJob` (lease + claim
token) → `resolveDescriptor` → `reserveProviderQuota` (atomic CAS + attempt insert in one
transaction) → `markAttemptInFlight` (`contactedProvider=true`) → `lookupWithBound` → post-call
single transaction (evidence + `finalizeAttempt` + job transition) → `refreshRunsForJob` →
`enrichmentSummaryReadService` truthful terminal state → `enrichmentUsageService` readiness/usage
reporting.

Everything in that chain except `DIRECT_PROVIDERS[provider]` is provider-independent — the job is
parameterised only by `descriptor.entry`'s `modulePath` / `model` / `fk`. Proving it once with the
cheapest, safest provider is the highest-confidence-per-risk choice available.

It **also** live-proves, for the first time in this repository, the boot-time switch and worker
lifecycle (`backend/server.js:17-25`) against a real network.

**What it does NOT prove — named residual gaps, not silent ones:**

- **The targeted/delegated lane is not live-proven.** `runWorkerTick` also runs `recoverStaleClaims`,
  `sweepStaleAttempts`, `reconcileDelegatedJobs`, `retireExhaustedDirectJobs` and `runTargetedPass`
  every tick (`enrichmentWorker.js:496-516`), but against the clean database preflight P10/P11
  require, those execute over **zero rows** — vacuously. **Closing 10C-4 confers no live proof on
  `abuseipdb`, and it must remain not-live-proven in every environment until its own canary ticket.**
- The four legacy synchronous routes (§3.2) are not exercised and are not made safe by this ticket.

### 6.3 Providers explicitly EXCLUDED from live proof

| Provider | Reason for exclusion |
|---|---|
| `shodan` | Paid **query credits** are consumed per host lookup. Real, metered, irreversible spend for no additional architectural coverage over `greynoise`. |
| `netlas` | Paid request quota on a metered plan. Same reasoning. |
| `censys` | Platform API PAT plus optional organization ID; paid tier; highest credential and account-shape complexity of the four direct providers. No additional path coverage. |
| `abuseipdb` | **Different path, deliberately not first.** It is the DELEGATED/targeted lane (`enrichmentTargetedIocService`, `runTargetedPass`) and carries strictly more machinery: the linked `IocEnrichment` delegate, the non-expiring `CONTACT_SENTINEL` hold, `deadLetterUnleasedJob`, and `reconcileDelegatedJobs`. Proving the simpler direct path first is the correct ordering; a targeted-lane canary is a **candidate successor ticket**, not part of 10C-4. |
| `nvd` | **Structurally impossible.** `subjectTypeForProvider('nvd') === CVE` → `DELEGATED_BATCH_REQUIRED`; it is never worker-eligible and can never be the subject of a direct canary. |

### 6.4 What stays covered by deterministic tests instead

Every failure mode in §10 marked *deterministic*; all four excluded direct providers' adapters
(already covered by their existing focused unit suites with injected `fetchImpl`); the targeted/
delegated lane (already covered by the Phase-10A-2 real-PostgreSQL suites); every routing and
readiness refusal (10C-3 suites). **No live request is spent to test a failure a mock already
proves.**

---

## 7. Safe subject

**Permitted subject class:** a permanent, publicly-operated, non-victim internet infrastructure
address that is already an approved smoke subject in this repository.

**Approved subject for this canary: `1.1.1.1`** — Cloudflare's public DNS resolver.

Justification, and why no new decision is being made: `1.1.1.1` is *already* the in-repo approved
live subject, chosen and documented in Phase 8D
(`backend/src/scripts/greyNoiseLiveSmoke.js:8-10,22` — *"Cloudflare's public DNS resolver —
permanent public infrastructure, never a victim/customer asset"*). Reusing it means 10C-4 introduces
**no new third-party exposure** beyond what the repository already sanctions.

**Binding subject rules:**

- The canary subject MUST be `1.1.1.1`. Any other value fails preflight (§12).
- The subject is **looked up in a vendor's reputation database**. It is never scanned, probed,
  connected to, or contacted by ThreatNeXus.
- No customer, constituent, victim, or PK-CERT-reported address may ever be used as a canary
  subject.
- The canary Finding carrying this indicator MUST be a purpose-created fixture in a disposable
  database, never a real ingested Finding.

---

## 8. Credential boundary

Frozen exactly as 10C-3 left it. This ticket adds obligations; it removes none.

**Binding:**

1. Credentials are **deployment/environment-owned**. `GREYNOISE_API_KEY` is read once at process
   start by `backend/src/config/env.js` and frozen for the life of the process.
2. **No application persistence.** No database column, no cache, no file written by the application
   ever holds a credential value.
3. **No browser exposure.** No API response, no rendered DOM, no client bundle contains a credential
   value. (10C-3's Playwright spec already asserts this and must keep passing.)
4. **No logging.** No credential value in application logs, worker logs, or console output. The
   worker's audit payloads are allow-lists of named fields (`enrichmentWorker.js:63-89`).
5. **No audit secret value.** No `AuditLog` row may contain a credential value.
6. **No prompt/chat secret value.** The operator MUST NOT paste a key into any AI session. No agent
   in this workflow may request, read, echo, or reconstruct a key. Any evidence artifact containing
   one is invalid and must be destroyed rather than redacted.
7. **No committed `.env`.** `backend/.env.example` keeps every provider value blank. `.env` stays
   git-ignored. CI keeps every provider key `''`.
8. **No test fixture containing a real credential.** Fixtures use obviously-fake values (the 10C-3
   precedent: `fake-censys-pat-for-e2e-only`).
9. **No process-environment dump.** The plaintext value is retrievable from `docker inspect`,
   `docker compose config`, `printenv`, `/proc/<pid>/environ`, and shell history — because
   `docker-compose.yml:96` passes `GREYNOISE_API_KEY: ${GREYNOISE_API_KEY:-}` through from the
   environment. None of these may be captured into an evidence artifact, pasted into a chat, or
   attached to the ticket. §11 step 6 requires purging the shell-history entry.

**How the operator supplies it:** by exporting `GREYNOISE_API_KEY` into the shell that launches the
disposable canary stack, or by placing it in a git-ignored local `.env`, using the existing project
convention documented in `backend/.env.example` and `docs/PROVIDER_GUIDE.md`. No new mechanism is
introduced.

**How validation confirms "configured" without revealing the value:**

The repository already has exactly the right primitives and they are the only ones permitted:

- `isProviderCredentialConfigured('greynoise', config)` → `Boolean(config.GREYNOISE_API_KEY)`.
  Returns a **boolean**; never returns, compares, or logs the value
  (`enrichmentOrchestrationConfig.js:301-319`).
- `missingProviderCredentialVariables('greynoise', config)` → the **variable NAME only**, never its
  value (:356-359).
- `GET /api/enrichment/usage` → `readiness: "READY"` vs `"NOT_CONFIGURED"` plus
  `missingConfiguration: ["GREYNOISE_API_KEY"]`.

Preflight and evidence use **these**, and nothing else. Reading `process.env.GREYNOISE_API_KEY` for
any purpose other than a `Boolean()` coercion is forbidden by this contract.

---

## 9. Worker / execution enablement

**Minimum settings changed for the canary** (in the disposable stack only):

| Variable | Canary value | Default | Why |
|---|---|---|---|
| `ENRICHMENT_WORKER_ENABLED` | `true` | `false` | The only switch that starts a worker at all. |
| `GREYNOISE_API_KEY` | operator-supplied | blank | Gate #4. |
| `GREYNOISE_MANUAL_DAILY_BUDGET` | `1` | blank (= **unlimited**) | §3.1 — the hard cap. Must be positive and explicit. |
| `ENRICHMENT_WORKER_BATCH_SIZE` | `1` | `5` | Bounds the direct pass to one claim per tick. Note it also shrinks every recovery pass's `take` to 5 via `MAX_SCAN_MULTIPLIER` (`enrichmentWorker.js:462,470,478,482,492`) — harmless at one job, but it is not a global "one operation per tick" bound. |
| `AUTO_ENRICHMENT_ENABLED` | **stays `false`** | `false` | AUTOMATIC lane stays structurally dead. |
| every other `*_MANUAL_DAILY_BUDGET` | `0` | blank (= unlimited) | Defence in depth: even if another key leaked into the environment, its MANUAL lane is refused at routing time. |
| every `*_AUTOMATIC_DAILY_BUDGET` | `0` (unchanged) | `0` | Unchanged. |
| every other provider credential | blank (unchanged) | blank | Unchanged. |

**Restart semantics: a restart IS required, in both directions.** `backend/server.js:17-26` reads
the switch **once at process boot** and only then `require`s the worker module. There is no runtime
toggle and this contract forbids adding one (§16) — the read-once-at-boot property is precisely what
makes the default-off claim a property of the process rather than of a branch.

**Enabling the worker alone is NOT sufficient**, and this is a load-bearing property to demonstrate,
not merely to assert. With the worker on, contact still requires: a job to exist (gate 2), the
credential (gates 4 and 6), routing to pass (gate 5), and the atomic reservation to be GRANTED
(gate 7). The preflight in §12 proves each gate's state independently *before* the worker is started.

**How the operator proves the worker is actually active:**

1. `docker compose logs backend | grep -i "enrichment worker"` →
   `Enrichment worker started (ENRICHMENT_WORKER_ENABLED=true)`.
2. Authoritative, durable proof — an `AuditLog` row `action = 'enrichment.worker.started'`, and
   after the first poll interval, `enrichment.worker.tick.completed`
   (`enrichmentWorker.js:579,600`).

Log grep alone is **not** acceptable evidence (§13). The audit row is.

**Return to default-off:** §11.

---

## 10. Budget / contact cap

**Maximum permitted canary scope — binding:**

| Dimension | Cap |
|---|---|
| Providers contacted | **1** (`greynoise`) |
| Lanes | **1** (`MANUAL`) |
| Subjects | **1** (`1.1.1.1`) |
| Enrichment runs created | **1** |
| `ProviderLookupJob` rows in a claimable state | **1** |
| Quota reservations | **1** (`GREYNOISE_MANUAL_DAILY_BUDGET=1`) |
| `ProviderLookupAttempt` rows for `greynoise` | **1** |
| Outbound HTTPS requests to any provider host | **1** (see the qualification below) |

**Units are request counts, not currency.** The system has no monetary budget concept and this
contract does not invent one (`ProviderDailyUsage.reservedCount` is an integer count of
reservations).

**Qualification — this cap is enforced by configuration on the Phase-10 path, and by operator
discipline plus a detector on the legacy path (§3.2).** It is not enforced by configuration
system-wide, and this contract does not claim it is.

**Why the canary cannot silently expand into an unbounded run on the Phase-10 path:**

The **one** mechanism that bounds the greynoise MANUAL job itself:

1. `GREYNOISE_MANUAL_DAILY_BUDGET=1` → the second reservation attempt hits
   `updateMany({ where: { ..., reservedCount: { lt: 1 } } })`, matches zero rows, throws
   `QuotaRefusedSignal`, and the transaction rolls back → `REFUSED / BUDGET_EXHAUSTED` → job
   terminalizes `SKIPPED_BUDGET`, **no call made** (`enrichmentQuotaService.js:234-241`).

The mechanism that stops a **post-contact requeue** — the real second line of defence, and the one a
reviewer should be pointed at:

2. A contacted attempt is **never** returned to the queue. `recoverStaleClaims`
   (`enrichmentWorker.js:105-141`) leaves a contacted-but-unfinished attempt to the ambiguity sweep,
   and terminalizes a `FINISHED`+contacted attempt beside a still-`LEASED` job as
   `AMBIGUOUS_AFTER_CONTACT` rather than re-asking a question already paid for.

Mechanisms that bound **other providers and lanes** (they contribute nothing to bounding the
greynoise MANUAL job itself, and are listed as scope containment, not as its cap):

3. Every other *direct* provider is `NOT_CONFIGURED` → refused by `resolveDescriptor` **before**
   reservation, spending nothing. (`nvd` is not in `DIRECT_PROVIDERS` at all and
   `isProviderCredentialConfigured('nvd')` is unconditionally `true` — it is contained by
   `DELEGATED_BATCH_REQUIRED` and a zero budget, not by the credential check. `abuseipdb` is
   likewise not a direct provider.)
4. Every other MANUAL budget is explicitly `0` → refused at routing time (`MANUAL_BUDGET_ZERO`), no
   job created. This is what actually contains `nvd` and `abuseipdb`, on both the direct and the
   targeted pass (`enrichmentWorker.js:407-410`).
5. `AUTO_ENRICHMENT_ENABLED=false` + every AUTOMATIC budget `0` → the AUTOMATIC lane cannot record
   or execute anything.

**Sequences traced and confirmed bounded to ≤ 1 contact within a UTC day:** concurrent workers (CAS
row-locks, second grant impossible) · re-claimed lease after contact (never requeued) · re-claimed
lease without contact (requeued, then refused `BUDGET_EXHAUSTED` → terminal `SKIPPED_BUDGET`) ·
stale-attempt sweep, exhausted retirement, run reconciliation (finalize/terminalize only, no
`lookup()`) · a second run created by mistake (`SKIPPED_CACHED` if fresh, otherwise a new job whose
reservation is refused the same day).

**The cap is per UTC DAY, not per canary.** `ProviderDailyUsage` is keyed on `usageDate`
(`enrichmentQuotaService.js:132-135`). A canary that straddles UTC midnight — combined with any
uncontacted-lease recovery — gets a **fresh** `reservedCount = 0` bucket and a second GRANTED
reservation. Preflight P14 and the all-days evidence query in §13.1 exist for exactly this.

**No automatic retry can produce a second contact.** `STATUS_TO_JOB_STATE` maps *every* negative
provider status to a terminal state — `RATE_LIMITED`, `TIMEOUT`, `INVALID_KEY` and `FAILED` all map
to `JOB_STATES.FAILED`, never to a retry state (`enrichmentDirectExecutionService.js:61-70`,
D-P10A2-06). A post-contact ambiguity terminalizes `DEAD_LETTER / AMBIGUOUS_AFTER_CONTACT` and is
**never** retried (:273-309).

**Force cannot lift any of this.** §2.5. `force` is evaluated only against `hasFreshResult`. Using
`force` during the canary is **forbidden** regardless (§16) — a first run has no fresh result to
bypass.

---

## 11. Kill switch / rollback (return to safe state)

**Mandatory. The canary is not complete until this is executed and verified.**

**The ORDER below is binding, not indicative.** Steps 2, 3 and 4 require a *running* backend and a
*live* database; step 7 destroys both. Performing them out of order makes the evidence
unobtainable — and step 6 changes what step 3 reports.

| Step | Action | Verification |
|---|---|---|
| 1 | **Restart** the backend with `ENRICHMENT_WORKER_ENABLED=false`. Do **not** bring the stack down yet — steps 2–4 need it up. Leave `GREYNOISE_API_KEY` set for now (step 6 removes it). | **Restart required** — the switch is read once at boot. |
| 2 | Confirm no worker is constructed | **Positive** evidence: the process-level check `docker compose ps` plus the absence of the `Enrichment worker started` startup line (`server.js:24`). The audit-row check is a *supporting* signal only — `audit("enrichment.worker.started", …)` is fire-and-forget (`enrichmentWorker.js:600`, not awaited) and `buildAuditor` swallows every failure (`:84-88`), so **presence of the row is proof; absence is not.** |
| 3 | Confirm no further Phase-10 contact is possible | `GET /api/enrichment/usage` reports `greynoise` readiness `EXECUTION_PAUSED` on both lanes (ladder step 3 — it outranks budget state). Requires a caller holding `execute:enrichment-batch` (`enrichmentUsageRoutes.js:24`). |
| 4 | **Extract every §13.1 "after" evidence item now**, while the stack is up | All queries in §13.1 completed and recorded before proceeding. |
| 5 | Budgets | Nothing to restore. `ProviderDailyUsage` is append-only with **no decrement by design**; `reservedCount` for the canary day is permanent, truthful history and MUST NOT be edited or deleted. Budgets are environment values that vanish with the disposable stack. |
| 6 | Remove temporary credential/config | Unset `GREYNOISE_API_KEY` from the operator shell; delete any git-ignored local `.env` created for the canary; **purge the shell history entry** (`ConsoleHost_history.txt` on PowerShell, `~/.bash_history` on bash) — an `export GREYNOISE_API_KEY=…` line persists there. Verify `git status` shows no `.env`, no key, no new untracked file containing one. *After this step readiness reads `NOT_CONFIGURED`, not `EXECUTION_PAUSED` — which is why step 3 precedes it.* |
| 7 | Destroy temporary artifacts | Remove the disposable PostgreSQL container **and its volume** (`down -v`), the canary Finding fixture, and any raw provider response captured during the run. Destroying the volume is **mandatory, not tidy-up**: it is what forecloses the UTC-rollover requeue risk named in §10. Evidence retained is only the extracted safe fields of §13. |
| 8 | Confirm repository default-off is untouched | `git diff` against base shows **no** change to `backend/.env.example`, `docker-compose.yml`, or `.github/workflows/ci.yml` defaults. |

**The proof MUST end in the default-off state.** A successful canary is not a reason to leave a
worker running. There is no approved outcome of this ticket in which live provider execution remains
enabled.

**Abort at any point** — if any preflight assertion fails, or anything unexpected occurs mid-run —
executes this same procedure immediately, from whichever step is reachable.

---

## 12. Deterministic preflight (blocking)

**No live request may be authorized until every assertion below passes.** These are machine
assertions, not a human checklist. A single failure refuses the canary.

### 12.1 Deterministic test gates (must be green *before* the stack is credentialed)

| Gate | Command | Proves |
|---|---|---|
| Backend full suite | `npm test` (backend) | No regression at base. |
| Orchestration inertness | `backend/tests/unit/enrichmentOrchestrationInertness.test.js` | Default-off, and that **within the `src/services/enrichmentOrchestration` package** no module other than `enrichmentOrchestrationConfig.js` names a provider credential variable. The scan is directory-scoped (`:36`, `:271-287`); it says nothing about modules outside that package, and `greyNoiseExecutionService.js:87` legitimately names `env.GREYNOISE_API_KEY`. |
| Config bounds | `backend/tests/unit/enrichmentOrchestrationConfig.test.js` | Budget parsing, `null` = unlimited, default-off switch parsing. |
| Readiness ladder | `backend/tests/unit/enrichmentProviderReadiness.test.js` | The 7-value closed vocabulary and its precedence. |
| Quota atomicity | Phase-10 real-PostgreSQL suites (require `TEST_DATABASE_URL`) | Reservation CAS, exactly-once finalization, no half-reservation. |
| Usage/authorization | `enrichmentUsageService.test.js`, `phase10a1RouteAuthorization.test.js` | No secret serialization; capability gating. |
| Provider adapter | `greyNoiseProvider` focused unit tests (injected `fetchImpl`) | 404→`NOT_FOUND`, 401/403→`INVALID_KEY`, status mapping. |
| Prisma | `prisma validate`, `migrate diff --exit-code` | **Zero schema change** in this ticket. |

**`TEST_DATABASE_URL` must be verifiably set** — the real-PostgreSQL suites `describeOrSkip`
themselves without it and would report green while silently skipping. A skipped suite is not
evidence (carried forward from the 10C-3 P2 finding).

### 12.2 Live-canary preflight assertions (the new harness, §14)

Read-only. Makes **no** provider call. Refuses loudly on any failure.

**Execution binding (P0-level precondition).** The preflight MUST run **in the same process
environment and container that will boot the worker** — e.g.
`docker compose run --rm backend node src/scripts/enrichmentCanaryPreflight.js`. This is not a
convenience: `docker-compose.yml:78` hardcodes `DATABASE_URL` inside the service while every switch
and budget (`:118-136`) is resolved from the operator's shell, and `env.js:79-80` resolves `.env`
relative to `process.cwd()`. A host-run preflight and a container-run backend are two **different**
environment resolutions, and the dangerous direction is real: budget `1` asserted in one shell,
backend booted from another with the variable blank → `null` → **unlimited**. A preflight that
validates a different process than the one that spends is re-secured by operator discipline, which
is exactly what these assertions exist to replace.

| # | Assertion | Source of truth |
|---|---|---|
| P1 | `ENRICHMENT_WORKER_ENABLED === false` **at preflight time** | resolved config |
| P2 | `AUTO_ENRICHMENT_ENABLED === false` | resolved config |
| P3 | `isProviderCredentialConfigured('greynoise', config) === true` | boolean only, never the value |
| P4 | For every provider except `greynoise` **and `nvd`**: `isProviderCredentialConfigured(...) === false` | boolean only. **`nvd` MUST be exempted**: `enrichmentOrchestrationConfig.js:314-315` returns `true` unconditionally because NVD works keyless, so a naive iteration over `KNOWN_PROVIDERS` would make this assertion unsatisfiable and the preflight would refuse every canary. `nvd` is instead contained by P6 (`NVD_MANUAL_DAILY_BUDGET === 0`) and structurally by `DELEGATED_BATCH_REQUIRED` (`enrichmentProviderReadiness.js:140-141`). |
| P5 | `manualDailyBudgets.greynoise === 1` — **strictly `=== 1`**; blank/`null` (unlimited), the literal `"unlimited"`, and `0` all fail | resolved config |
| P6 | For every other provider (**including `nvd` and `abuseipdb`**): `manualDailyBudgets[p] === 0` | resolved config |
| P7 | For every provider: `automaticDailyBudgets[p] === 0` | resolved config |
| P8 | `ENRICHMENT_WORKER_BATCH_SIZE === 1` | resolved worker runtime config |
| P9 | `ProviderDailyUsage` has zero rows for `greynoise` across **every** `usageDate`, or all `reservedCount === 0` | database — *all days, not just today* (§10's UTC-rollover note) |
| P10 | **Zero** non-terminal `ProviderLookupJob` rows for any provider — explicitly the states `PENDING`, `LEASED`, `RETRY_WAIT`, `WAITING_ON_DELEGATE` (`schema.prisma:3160-3187`; `RETRY_WAIT` is unreachable by design but is still non-terminal in the enum) | database |
| P11 | Exactly **one** Finding exists in the database and its indicator is `1.1.1.1` | database |
| P12 | `resolveProviderReadiness({provider:'greynoise', lane:'MANUAL', …})` returns `EXECUTION_PAUSED` | `enrichmentProviderReadiness` |
| P13 | `count(*) FROM "GreyNoiseEnrichment") === 0` and zero `AuditLog` rows with `action LIKE 'greynoise.lookup.%'` — the legacy-path baseline (§3.2) | database |
| P14 | At least `ENRICHMENT_WORKER_LEASE_SECONDS + ENRICHMENT_WORKER_POLL_INTERVAL_MS + 10 min` remain before the next UTC midnight | clock — the budget bucket resets at midnight (§10) |
| P15 | The resolved `DATABASE_URL` and resolved orchestration config are those of the process that will boot the worker (see the execution binding above); the database name carries the required disposable-canary prefix | environment + database |
| P16 | `IOC_ENRICHMENT_PROVIDER === 'mock'` | resolved config — closes the legacy ADMIN IOC batch path (`enrichmentBatchRoutes.js:20-25`) |
| P17 | No `LIVE_*_SMOKE` opt-in variable is set, and no `enrichment.worker.started` audit row lacks a matching `enrichment.worker.stopped` | environment + database — belt-and-braces; the Phase-8D scripts are inert without an explicit `npm run smoke:*` (`greyNoiseLiveSmoke.js:65`) |

**What P12 does and does NOT prove — corrected.** `EXECUTION_PAUSED` is returned at ladder step 3
(`enrichmentProviderReadiness.js:148`) and **masks every budget state below it** — `BUDGET_ZERO` at
`:156` and `BUDGET_EXHAUSTED` at `:160` are never reached while the worker is off. So P12 returns
`EXECUTION_PAUSED` whether the budget is `1`, `0`, blank/unlimited, or already exhausted.

P12 is therefore **equivalent to (provider ≠ nvd) ∧ P1 ∧ P3** and proves *nothing* about the budget.
It is retained as a cheap consistency check on the readiness surface itself, **not** as evidence
that the worker switch is the only remaining gate. That property is established **only** by the
conjunction P1 ∧ P3 ∧ P5 ∧ P6 ∧ P7 ∧ P9 ∧ P10 ∧ P11 ∧ P15 — the budget bounds are load-bearing and
independent, and no single assertion substitutes for them.

*(An earlier revision of this contract called P12 "the sharpest single assertion" and claimed it
proved the worker switch was the only remaining gate. That was false, for the masking reason above,
and is corrected here.)*

---

## 13. Bounded live canary procedure

**Executed once, by a human operator, in a disposable local stack. Not in this design session.**

| Step | Action | Recorded |
|---|---|---|
| C1 | Stand up a disposable PostgreSQL, apply migrations, seed **one** Finding with indicator `1.1.1.1`. Worker off. | database URL (non-secret), Finding id |
| C2 | Operator exports `GREYNOISE_API_KEY` into the launching shell. Never shown to any agent. | *nothing* — boolean only, at C3 |
| C3 | Run the §12.2 preflight **inside the container/process that will boot the worker** (see §12.2's execution binding). **Any failure aborts** to §11. | full P1–P17 pass/fail table |
| C4 | Capture the **before** snapshot | `GET /api/enrichment/usage` → `greynoise` readiness both lanes (expect `EXECUTION_PAUSED`); `ProviderDailyUsage` rows across all days; `ProviderLookupAttempt` count; `GreyNoiseEnrichment` count; `greynoise.lookup.%` audit count. **The caller must hold `execute:enrichment-batch`** (`enrichmentUsageRoutes.js:24`) — confirm the operator account does before C5, or this snapshot is unobtainable. |
| C5 | Restart backend with `ENRICHMENT_WORKER_ENABLED=true` (all other §9 values as specified) | restart timestamp |
| C6 | Confirm the worker is genuinely active | `AuditLog` row `enrichment.worker.started`; readiness now `READY` on MANUAL |
| C7 | Create **one** run: `POST /api/findings/:id/enrichment/runs`, targeting `greynoise` only, **no `force`**, **no `justification`** | run id, HTTP status |
| C8 | Wait for at most **two** poll intervals. Do not create a second run. Do not retry. | elapsed time |
| C9 | Capture the **after** snapshot | §13.1 |
| C10 | Execute §11 rollback in full | verification of each step |

### 13.1 Evidence required for closure

Machine-verifiable facts, extracted by query — **not** console output, **not** UI appearance.

**Before:**
- `greynoise` readiness per lane (expected `EXECUTION_PAUSED` at C4, `READY` at C6)
- `ProviderDailyUsage` for `greynoise` across **all** `usageDate` values (expected absent or `0`)
- total `ProviderLookupAttempt` count (expected `0`)
- **`SELECT count(*) FROM "GreyNoiseEnrichment"` → expected `0`**
- **`SELECT count(*) FROM "AuditLog" WHERE action LIKE 'greynoise.lookup.%'` → expected `0`**
- P1–P17 preflight results

**During:**
- `FindingEnrichmentRun.id` and its `trigger` — the model is `FindingEnrichmentRun`
  (`schema.prisma:3238`) and it has **no `lane` column**; lane lives on `ProviderLookupJob`
- `ProviderLookupJob.id`, `provider='greynoise'`, `lane='MANUAL'`
- `ProviderLookupAttempt.id`, `attemptNumber`, `usageDate`
- the reservation transition: `reservedCount` `0 → 1`, `limitAtLastReservation = 1`
- the contact transition: `state=IN_FLIGHT`, `contactedProvider=true`, `fetchStartedAt` non-null

**After:**
- `ProviderLookupAttempt`: `state='FINISHED'`, `outcome`, `httpStatus`, `errorCode`,
  `retryAfterSeconds`, `finishedAt`, `contactedProvider`
- `ProviderLookupJob`: terminal `state`, `terminalReasonCode`, `queriedAt`, `freshUntil`
- `FindingEnrichmentRun` terminal state
- `GET /api/findings/:id/enrichment/summary` — the 10C-1 truthful terminal status
- `ProviderDailyUsage.reservedCount = 1` for the canary day, and **no row for any other day**
- `ProviderLookupAttempt` count for `greynoise` = exactly `1`
- **`SELECT count(*) FROM "GreyNoiseEnrichment"` → exactly `1`** on any known-outcome path, `0` on
  the ambiguous path
- **`SELECT count(*) FROM "AuditLog" WHERE action LIKE 'greynoise.lookup.%'` → still `0`**
- `AuditLog` action sequence: `enrichment.lookup.claimed` → `enrichment.lookup.charged` →
  `enrichment.lookup.contacted` → `enrichment.lookup.finalized`
- post-rollback (extracted at §11 step 4, before the volume is destroyed): readiness
  `EXECUTION_PAUSED`, no `enrichment.worker.tick.completed` after cutover, `reservedCount` still
  exactly `1`

**The last two "After" items are the real no-second-contact proof, and the `ProviderLookupAttempt`
count alone is NOT.** A legacy-route contact (§3.2) produces zero attempt rows and zero
`ProviderDailyUsage` change, so the Phase-10 ledger is structurally blind to it. Both channels write
`GreyNoiseEnrichment` (the Phase-10 path at `enrichmentDirectExecutionService.js:327`), and only the
legacy path emits `greynoise.lookup.*` audit actions (`greyNoiseExecutionService.js:24-30`). The two
queries together detect a contact from **either** path.

**Never recorded in any evidence artifact:** the credential value; the raw provider response body
beyond the fields `toPersistedRow`'s existing allow-list already persists; any PII; any header.
**Nor any of these, which hold the plaintext key even though they are not "the value" literally:**
`docker inspect <container>`, `docker compose config`, `printenv` / `env`, `/proc/<pid>/environ`, or
a shell-history excerpt. Any of them pasted into an evidence artifact violates §8 while technically
satisfying the list above.

### 13.2 The contact vocabulary (existing Phase-10 semantics, restated)

**Read in precedence order, top to bottom — this is a progression, not a partition.** "Contact
attempted" is *implied by* both "outcome known" and "post-contact ambiguity"; classify a run by the
**last** row it matches, not the first.

| # | State | Durable signature | Meaning |
|---|---|---|---|
| 1 | **REFUSED BEFORE LOOKUP** | job `SKIPPED_NOT_CONFIGURED` / `SKIPPED_BUDGET`; **no attempt row**; `reservedCount` unchanged | No request was issued. Nothing spent. |
| 2 | **RESERVED, NEVER CONTACTED** | attempt exists, `contactedProvider = false`, `outcome='ABANDONED'`; `reservedCount` **incremented** | Died between `reserveProviderQuota` and `markAttemptInFlight` (`enrichmentWorker.js:194-201`). **Budget was spent; no request was issued.** This is the conservative over-count the ledger header names (`enrichmentQuotaService.js:36-43`) — it is neither a refusal nor a contact, and the canary must not mistake it for either. |
| 3 | **PROVIDER CONTACT ATTEMPTED** | attempt `contactedProvider = true`, `fetchStartedAt` non-null, still unfinished | A request was handed to the transport. |
| 4 | **CONTACT OUTCOME KNOWN** | attempt `state='FINISHED'` with a definite `outcome`, and a job in a terminal non-`DEAD_LETTER` state | The provider answered and the answer is classified. `httpStatus` is **not** required to be non-null — `TRANSPORT_ERROR` and `TIMEOUT` legitimately persist `httpStatus: null` (`enrichmentDirectExecutionService.js:109-112,336`). |
| 5 | **POST-CONTACT AMBIGUITY** | attempt `outcome='ABANDONED'` **with `contactedProvider=true`**; job `DEAD_LETTER` + `terminalReasonCode='AMBIGUOUS_AFTER_CONTACT'` | Unknowable whether the provider answered or charged. Terminal. Never retried. |

States 2 and 5 share `outcome='ABANDONED'` and are distinguished **only** by `contactedProvider` —
which is precisely why that column is written *before* the call rather than after
(`enrichmentQuotaService.js:278-289`).

---

## 14. Implementation surface

**Shape A — procedure and evidence. No product code.**

The grounding establishes that every safety property the canary needs **already exists**: the
switch (`server.js`), the credential gate (`isProviderCredentialConfigured`), the routing refusals
(`enrichmentApplicabilityRouter`), the atomic bounded reservation (`reserveProviderQuota`), the
contact fact (`markAttemptInFlight`), the terminal-state truth (10C-1), the readiness truth (10C-3),
the no-retry rule (`STATUS_TO_JOB_STATE`), and the operator runbook.

The **one** genuine gap is §3.1: nothing today asserts that a canary environment is correctly
bounded *before* the worker is switched on, and a blank `GREYNOISE_MANUAL_DAILY_BUDGET` silently
means **unlimited**. That gap is closed by a preflight, not by changing the execution path.

**Expected files:**

| File | Change | Note |
|---|---|---|
| `backend/src/scripts/enrichmentCanaryPreflight.js` | **new** | Read-only. Implements P1–P14. Makes **no** provider call. Composes the existing `resolveOrchestrationConfig` / `resolveWorkerRuntimeConfig` / `isProviderCredentialConfigured` / `resolveProviderReadiness` — reimplements none of them. Exits non-zero on any failure. |
| `backend/package.json` | one script entry | `"preflight:canary"`, alongside the existing `smoke:*` entries. |
| `backend/tests/unit/enrichmentCanaryPreflight.test.js` | **new** | Deterministic. Each of P1–P17 red-checked: an environment violating one assertion must be **refused**. Load-bearing cases: **P5** — a blank/`null`/`"unlimited"` MANUAL budget must FAIL, not pass; **P4** — a correctly-configured canary environment must PASS, proving `nvd` is exempted and the assertion is satisfiable at all; **P13** — a pre-existing `GreyNoiseEnrichment` row or `greynoise.lookup.%` audit row must refuse; **P14** — an environment too close to UTC midnight must refuse. |
| `docs/OPERATIONS_RUNBOOK.md` | new subsection | "Controlled live canary (Phase 10C-4)" — §13 procedure and §11 rollback, under the existing "Enrichment worker" section. |
| `docs/PROVIDER_GUIDE.md` | small addition | Which provider is approved for live proof and why the other five are not. |
| `docs/ai/DECISIONS.md` | `D-P10C4-01` | The go-live definition, provider selection, and the 10C-5 sequencing decision. |
| `docs/ai/STATE.yaml`, `docs/ai/HANDOFF.md` | state | Normal ticket bookkeeping. |

**Explicitly NOT touched:** `backend/prisma/**` (zero schema change) · `enrichmentWorker.js` ·
every `*ExecutionService.js` · every `*Provider.js` · `enrichmentQuotaService.js` ·
`enrichmentRunService.js` · `enrichmentApplicabilityRouter.js` · `enrichmentProviderReadiness.js` ·
`roles.js` / `capabilities.js` · any route or controller · any frontend file ·
`backend/.env.example` defaults · `docker-compose.yml` defaults · `.github/workflows/ci.yml`
defaults.

**The preflight script must never be wired into CI, into `npm test`, or into any automatic path.**
Like the Phase-8D smoke scripts, it is a manual operator entry point.

---

## 15. Success, failure, and abort criteria

### 15.1 Success (all must hold)

1. All §12.1 deterministic gates green, with the real-PostgreSQL suites verifiably **not skipped**.
2. All seventeen §12.2 preflight assertions pass, run in the worker's own process environment.
3. The worker started, evidenced by an `enrichment.worker.started` audit row.
4. Exactly **one** `ProviderLookupAttempt` row for `greynoise` exists at the end.
5. That attempt reached `contactedProvider = true` — contact was intentional and recorded.
6. `ProviderDailyUsage(greynoise, today, MANUAL).reservedCount === 1`,
   `limitAtLastReservation === 1`, and **no `greynoise` usage row for any other `usageDate`**.
6a. `GreyNoiseEnrichment` row count is exactly `1` (or `0` on the ambiguous path), and the
   `greynoise.lookup.%` audit count is still `0` — no legacy-path contact occurred (§3.2).
7. The attempt is `FINISHED` with an outcome drawn from the closed `ATTEMPT_OUTCOMES` vocabulary,
   and its `httpStatus` / `errorCode` are consistent with that outcome.
8. The job reached a terminal state; the run reached a terminal state; the Finding summary reports
   the 10C-1 truthful status matching them.
9. The audit sequence `claimed → charged → contacted → finalized` is present exactly once.
10. Rollback executed; readiness back to `EXECUTION_PAUSED`; no worker tick after cutover; no second
    attempt row; `reservedCount` still exactly `1`.
11. `git diff` shows no change to any default (`.env.example`, `docker-compose.yml`, CI).

### 15.2 A successful canary does NOT require the provider to find anything

`outcome = NOT_FOUND` with `httpStatus = 404` — GreyNoise has nothing on file for `1.1.1.1` — is a
**complete success**. So is `SUCCESS`. The architecture claim under test is *"the execution path
contacts a real provider, accounts for it atomically, classifies the answer truthfully, and reaches
a valid terminal state"* — not *"the provider returned intelligence"*. Conflating the two would
make the proof depend on a third party's data holdings rather than on this system's correctness.

Also acceptable as a *successful proof of truthful classification*, provided accounting is correct
and no retry occurs: `INVALID_KEY` (401/403), `RATE_LIMITED` (429), `SERVER_ERROR` (5xx). These
prove the negative-path classification is real rather than mocked.

### 15.3 Failure (the canary FAILS and the ticket cannot close)

- More than one `ProviderLookupAttempt` row; **or** more than one `GreyNoiseEnrichment` row; **or**
  any `greynoise.lookup.%` audit row — **any** unintended second contact, on either path (§3.2).
- `reservedCount` ≠ 1, or a reservation with no corresponding attempt row (unaccountable spend), or
  an attempt row with no reservation.
- `contactedProvider = true` on an attempt whose job reports a *refused-before-lookup* state, or the
  reverse — the two disagreeing.
- The summary/readiness surfaces reporting something the ledger contradicts (a 10C-1/10C-3
  regression).
- A credential value appearing anywhere: response, DOM, log, audit row, evidence artifact, or chat.
- The worker still running, or still able to run, after rollback.
- Any preflight assertion having been overridden or skipped to make the run proceed.

### 15.4 Abort (stop immediately, execute §11)

Any preflight failure · a second job or attempt row appearing unexpectedly · **any
`greynoise.lookup.%` audit row appearing during the canary window** (the legacy path's own
signature, §3.2) · an unexpected `DEAD_LETTER` before C7 · any credential exposure · loss of
confidence that the environment is the disposable one · UTC midnight approaching within the P14
margin before the run has reached a terminal state.

*Not an abort trigger, because nothing in §13.1 can observe it:* "a provider host other than
`api.greynoise.io` was contacted". `ProviderLookupAttempt` has no host column
(`schema.prisma:3451-3497`) and the canary captures no network trace. The static proof stands
instead: `greyNoiseConfig.js:13` fixes the base URL and `:37-44` requires HTTPS or an explicit
localhost override, and preflight P15 pins the config to the executing process.

`AMBIGUOUS_AFTER_CONTACT` on the canary attempt itself is **not** an abort — it is a valid terminal
outcome that proves the ambiguity machinery works. Record it as such and **do not re-run**.

---

## 16. Failure modes: live vs deterministic

| Failure mode | Where proven | Why |
|---|---|---|
| Credential absent | **Deterministic** | `resolveDescriptor` → `SKIPPED_NOT_CONFIGURED`, no spend. Already covered; a live request would prove nothing extra. |
| Worker disabled | **Deterministic** + observed at C4 | Readiness `EXECUTION_PAUSED`; inertness test. |
| Budget zero | **Deterministic** | `reserveProviderQuota` refuses `limit === 0` without issuing a statement. |
| Budget exhausted | **Deterministic** | CAS matches zero rows → rollback → `SKIPPED_BUDGET`. |
| Provider rate limited (429) | **Deterministic** (injected `fetchImpl`) | Deliberately burning live requests to induce a 429 is exactly what §16 forbids. |
| Provider auth failure (401/403) | **Deterministic**; acceptable live incidentally | Never induced on purpose. |
| Network failure | **Deterministic** | Injected transport error. |
| Malformed provider response | **Deterministic** | Injected body; `TRANSPORT_ERROR` classification. |
| Post-contact ambiguity | **Deterministic** (existing Phase-10A-2 real-PG suites) | Cannot be induced live without wasting a paid contact and leaving a terminal dead-letter. |
| **Successful real contact + truthful classification + atomic accounting** | **LIVE — this is the only thing the canary is for** | The one property no mock can establish. |

**Binding: no live request may be spent to induce a failure a deterministic test already proves.**

---

## 17. 10C-5 sequencing decision (explicit)

**Decision: 10C-4 MAY proceed first. 10C-5 is NOT a blocker for this bounded canary, and REMAINS a
blocker for anything beyond it.**

### 17.1 What 10C-5 is, grounded

Every provider clears its abort timer as soon as `fetch()` resolves its **headers**, then reads the
body afterwards — `greyNoiseProvider.js:117` (`clearTimeout`) followed by `:160`
(`body = await response.json()`); the identical pattern at `censysProvider.js:139`/`:182`. The
provider's own `timeoutMs` therefore does **not** bound the body read. This is documented in-repo at
`enrichmentDirectExecutionService.js:147-159` and `D-P10A2-09`.

### 17.2 Why it does not block this canary

1. **The worker's *decision* is bounded on the worker path.** `lookupWithBound` races the whole of
   `lookup()` — headers *and* body — against `ENRICHMENT_LOOKUP_MAX_MS`
   (`enrichmentDirectExecutionService.js:161-173`, applied at `:268`, default 60s). After 60s the
   worker stops waiting and classifies the attempt as a post-contact ambiguity.

   **Precisely: the read itself is NOT terminated.** `Promise.race` cancels nothing. No `signal` is
   passed into `lookup()` at `:268-272` (so `greyNoiseProvider.js:234` defaults `signal = null`),
   and the provider's own `AbortController` was already cleaned up at `:290` before the body read at
   `:160`. The losing body read continues to consume a socket and memory for the life of the
   process. What is bounded is the worker's decision and the ledger's truthfulness — **not** the
   resource consumption. Anyone reading §17.3 as "time is handled, only size is left" must read it
   as "the *worker* is handled; both time and size remain unbounded in the *transport*."
2. **The residual is the size dimension** — `response.json()` has no byte cap, so a hostile or
   malfunctioning provider could return an enormous body and pressure process memory before the
   time bound fires.
3. **The canary's exposure to that residual is one request**, `GET https://api.greynoise.io/v3/
   community/1.1.1.1`, over TLS, to a first-party vendor endpoint, returning a small fixed-shape
   JSON object, in a **disposable local stack** where a memory exhaustion has no production blast
   radius and the operator is present throughout.
4. The canary therefore does not *rely on* the unbounded read being safe; it bounds the surrounding
   conditions so tightly that the unbounded read cannot become the failure that matters.

### 17.3 What remains blocked on 10C-5

10C-5 is recorded as **required hardening before any unattended or production-facing enablement** of
the enrichment worker. Specifically, the following remain out of reach until bounded body reads
land: a continuously-running worker; any worker on shared or production infrastructure; any batch
size greater than 1; and any provider whose responses are not small and fixed-shape.

This contract does **not** absorb 10C-5. It is a separate ticket, and 10C-4 closing does not close
it.

**The legacy synchronous routes (§3.2) are the sharpest case for 10C-5**, and this contract records
it rather than leaving it implicit: that path has **no `lookupWithBound` at all**, so neither the
time nor the size dimension is bounded on it, and it is armed by the credential alone. The argument
in §17.2 covers only the worker path.

### 17.4 Residual gaps carried forward (nothing here is closed by 10C-4)

Recorded so that no later reader mistakes a green 10C-4 for broader readiness:

1. **Provider response-body size bounding** — 10C-5. Blocks unattended/production enablement, batch
   size > 1, and any provider with large or variable responses.
2. **Credential delivery and egress in any non-local environment.** Every §8 binding is verified
   against an operator shell in a disposable stack. Nothing in this canary touches how a key reaches
   a *hosted* process — orchestrator env injection, image layers, platform log capture, or an
   intercepting egress proxy that would observe the `key:` header (`greyNoiseProvider.js:258`).
   §21 excludes credential management, so **no current ticket owns this**; it is a prerequisite of
   any deployment ticket.
3. **Provider-account-level behaviour** — source-IP binding of the key, and per-account rate
   accounting shared with other consumers of the same key. A local canary cannot observe either.
4. **The targeted/delegated lane (`abuseipdb`) remains not-live-proven** in every environment
   (§6.2).
5. **The four legacy synchronous provider routes remain unbounded and unaccounted** (§3.2). Their
   retirement or hardening is not owned by any current ticket.

---

## 18. Deployment / environment scope

**Chosen environment: a disposable LOCAL stack. Nothing else.**

Either the project's own `docker compose` stack with the §9 environment values supplied from the
operator shell, or a natively-run backend against a disposable PostgreSQL container — whichever the
operator already has working. The 10C-3 session established both are viable.

**Sufficiency:** local controlled live execution **is** sufficient to establish project readiness
for this milestone. The property under test is *"this codebase's execution path can contact a real
provider correctly and account for it"* — a property of the code and its ledger, not of a hosting
environment. Running the same code on a cloud host would test the host, not the claim, at strictly
higher cost and risk.

**No staging deployment, no cloud infrastructure, no hosting migration, no CI integration** is
created by this ticket. Turning 10C-4 into a deployment programme is explicitly refused.

**What local-only CANNOT establish, disclosed rather than glossed:** items 2 and 3 of §17.4 —
credential delivery/egress in a hosted environment, and provider-account-level behaviour. Closing
10C-4 establishes readiness of **the execution path**, not of a deployment. Those two remain
unproven and are prerequisites of any future deployment ticket.

---

## 19. Binding invariants

Fourteen load-bearing guarantees. Every one must hold at ticket closure, and each is asserted by a
named gate. I-02 and I-04 are deliberately **path-scoped** rather than system-wide — see §3.2; a
system-wide claim there would be false.

| # | Invariant | Asserted by |
|---|---|---|
| **I-01** | A default deployment cannot contact any enrichment provider. Both switches false, every AUTOMATIC budget 0, every credential blank; with the worker off the module is never `require`d and no worker object, timer, or provider instance exists in the process. | `enrichmentOrchestrationInertness.test.js`; `server.js:17-26`; §12.1 |
| **I-02** | **On the Phase-10 orchestration path**, credential presence alone cannot cause provider contact: a credentialed provider with the worker off is `EXECUTION_PAUSED` and no worker exists to claim its job. **This does NOT hold system-wide** — the legacy synchronous routes of §3.2 are armed by the credential alone and consult no switch. The invariant is therefore path-scoped, and the gap is disclosed, detected (I-13), and out of scope to fix here. | §3 table; preflight P1+P3; readiness ladder step 3; **§3.2** |
| **I-03** | Live Phase-10 contact requires **all** eight gates of §3 — worker switch, job existence, credential (twice: routing and descriptor), routing, positive lane budget, and a GRANTED atomic reservation. No single flag is sufficient. Established by the conjunction P1 ∧ P3 ∧ P5 ∧ P6 ∧ P7 ∧ P9 ∧ P10 ∧ P11 ∧ P15 — **not** by P12, which masks budget state (§12.2). | §3 table; the named preflight conjunction |
| **I-04** | Canary contact is bounded to exactly one provider, one lane, one subject, one reservation, one attempt, one outbound request. **On the Phase-10 path this is enforced by configuration; on the legacy path (§3.2) it is enforced by operator discipline plus the I-13 detector.** The cap is additionally **per UTC day**, which P14 bounds. | Preflight P5–P11, P14; success criteria 4, 6, 6a |
| **I-05** | Only `greynoise` and only `1.1.1.1` may participate. Every other provider is `NOT_CONFIGURED` **and** MANUAL-budget-0; no other Finding exists in the canary database. | Preflight P4, P6, P11 |
| **I-06** | Every attempted contact has durable, atomic quota and attempt evidence. Reservation and ledger insert are one transaction; there is no path to a charge without a row, or a row without a charge. | `enrichmentQuotaService.js:226-247`; real-PG quota suites; success criterion 6 |
| **I-07** | A provider returning nothing on file (`NOT_FOUND`/404) is durably distinguishable from an execution failure, and both from a post-contact ambiguity. | §13.2 four-state vocabulary; 10C-1 summary semantics; success criterion 7 |
| **I-08** | `force` cannot bypass any hard readiness, credential, subject, or budget control — it bypasses freshness and nothing else. Force is forbidden during the canary regardless. | `enrichmentApplicabilityRouter.js:118-141`; D-P10C2-01; §10 |
| **I-09** | No credential value ever enters an API response, the DOM, a log line, an `AuditLog` row, a test fixture, a committed file, an evidence artifact, or an AI prompt — **including the process-environment surfaces named in §13.1** (`docker inspect`, `docker compose config`, `printenv`, `/proc/<pid>/environ`, shell history). Configuration status is expressed as a boolean and a variable **name** only. | §8; `enrichmentUsageService` no-secret-serialization tests; 10C-3 Playwright DOM assertions; the **per-call-site** audit allow-lists at `enrichmentDirectExecutionService.js:201-205, 241-246, 253-258, 301-306, 377-382, 386-393` — **not** `buildAuditor`, which spreads its payload (`enrichmentWorker.js:80`) and enforces nothing |
| **I-10** | The proof ends with provider execution disabled and the repository's default-off configuration unchanged. | §11 steps 1–7; success criteria 10 and 11 |
| **I-11** | No unintended retry or second contact occurs. Every negative provider status is terminal; a post-contact ambiguity is terminal and never retried; a second reservation is refused by the budget CAS. | `STATUS_TO_JOB_STATE` (:61-70); D-P10A2-06; success criterion 4 |
| **I-12** | The 10C-1 (truthful terminal states), 10C-2 (force/justification), and 10C-3 (readiness/usage) surfaces remain accurate and unmodified. Zero schema change. | Full backend suite; `prisma validate` + `migrate diff --exit-code`; §14 not-touched list |
| **I-13** | Any provider contact during the canary window is **detectable regardless of which code path produced it**. The Phase-10 ledger alone is insufficient — the legacy path writes no attempt row and no usage row. Detection is by `GreyNoiseEnrichment` row count (both paths write it) plus the `greynoise.lookup.%` audit signature (legacy path only). | Preflight P13; §13.1 before/after queries; success criterion 6a; §15.3; §15.4 |
| **I-14** | Budget accounting is understood as **conservative**: a reserved-but-uncontacted attempt spends budget without contacting anyone, and is a distinct, recognised state — never reported as a refusal and never as a contact. | §13.2 state 2; `enrichmentQuotaService.js:36-43`, `:278-289` |

---

## 20. Validation plan

Three separated phases. **They must not be interleaved.**

**Phase 1 — DETERMINISTIC PRE-LIVE GATES.** §12.1 in full, plus the new preflight's own unit tests,
plus `prisma validate` / `migrate diff --exit-code` proving zero schema change, plus changed-file
lint. All green before a credential is placed anywhere. Real-PostgreSQL suites verified *not
skipped*.

**Phase 2 — ONE CONTROLLED LIVE CANARY.** §13, steps C1–C9. Exactly one outbound request.
**Not performed in the design session that produced this contract.**

**Phase 3 — POST-LIVE SAFETY PROOF.** §11 rollback in full, plus re-verification that readiness is
`EXECUTION_PAUSED`, that no worker tick occurred after cutover, that the attempt count is still
exactly one, and that no repository default changed.

**Closure requires all three phases evidenced, plus zero unresolved P0/P1 from review.**

---

## 21. Exclusions

Out of scope for 10C-4:

Production or staging deployment of any kind · new cloud infrastructure · hosting migration ·
a continuously-running worker · any runtime worker-control UI or API (the read-once-at-boot switch
is deliberate and stays) · credential-management systems, secret managers, rotation, or automatic
secret discovery · billing, currency, or subscription semantics · live proof for `censys`,
`shodan`, `netlas`, or `abuseipdb` · any `nvd` execution (structurally impossible) · the targeted/
delegated-lane canary (candidate successor ticket) · AUTOMATIC-lane execution · provider
response-body size hardening (**10C-5**, see §17) · retry redesign · concurrency redesign · any
change to atomic attempt reservation · changes to `force` behaviour · unifying the legacy
`IOC_ENRICHMENT_PROVIDER` selector with the Phase-10 path · `RETRY_WAIT` cleanup · retirement of the
legacy synchronous direct-provider routes · Phase 11 · any unrelated polish.

**Not fixed, and explicitly still armed during the canary:** the four legacy synchronous provider
routes (§3.2). This ticket **discloses and detects** them; it does not disable, retire, or harden
them. Their disposition is unowned and belongs to a future ticket (§17.4 item 5).

**Absolute refusals for the implementation session as well as this one:** do not enable production
execution · do not make a live provider call outside the single authorized C7 canary · do not call
the legacy synchronous routes at any point · do not request, read, print, or reconstruct a secret
value · do not commit a `.env` · do not change a default-off default · do not start 10C-5.

---

## 22. Review record

**Reviewers (Tier-3, read-only, dispatched against revision 1):**

| Reviewer | Scope | Verdict on rev 1 | Disposition |
|---|---|---|---|
| `security-reviewer` | unintended contact · secret exposure · worker enablement · kill switch · credential boundary | NOT SAFE — 1 P1, 6 P2, 2 P3 | All fixed in rev 2 |
| `backend-logic-reviewer` | unbounded spend · retry multiplicity · evidence sufficiency · preflight correctness | NOT SAFE — 4 P1, 7 P2, 3 P3 | All fixed in rev 2 |
| `software-architect` *(independent-gate substitute)* | 10C-5 sequencing · go-live definition sufficiency · provider selection | NOT SAFE — 1 P1 (same finding), 3 P2, 1 P3 | All fixed in rev 2 |
| **Codex** *(preferred independent cross-provider gate)* | — | **FAILED — usage limit reached, resets 2026-08-21** | Gap recorded, not silently substituted |

**Codex was not available and was not faked.** `TEAM-WORKFLOW.md` routes go-live to an
independent-provider gate, so the gap is material and is recorded as an explicit pending item rather
than closed. `software-architect` carried that scope as the canonical internal fallback — the same
substitution 10C-3 made for the same reason. **A Codex pass before implementation begins would be
strictly additive confirmation**, not a reopening: no P0 was found by any reviewer, and every P1 is
closed.

**Findings by severity across all three reviewers:** 0 × P0 · 6 × P1 (all closed) · 16 × P2 (all
closed) · 6 × P3 (all closed). The P1 count is 6 raw / **4 distinct** — the legacy synchronous route
was found independently by all three reviewers and is counted once as the single most important
correction.

**The four distinct P1s:**

1. **The legacy synchronous provider route is an off-ledger contact path** armed by the credential
   alone, which rev 1's cap claimed to bound and whose evidence set could not detect. → §3.2 (new),
   §13.1 detectors, I-04, I-13.
2. **Preflight P4 was unsatisfiable** — `isProviderCredentialConfigured('nvd')` returns `true`
   unconditionally, so "every provider except greynoise is false" could never pass and the preflight
   would have refused every canary. → §12.2 P4 exempts `nvd` explicitly.
3. **Preflight P12 did not prove what rev 1 claimed** — `EXECUTION_PAUSED` masks every budget state
   below it, so P12 was blind to a blank/unlimited budget while rev 1 called it "the sharpest single
   assertion". → §12.2 corrected in place; the property is now carried by an explicit conjunction.
4. **Nothing bound the preflight to the worker's own process environment** — a host-run preflight
   could validate a different config than the container that boots the worker. → §12.2 execution
   binding + P15.

Full disposition is recorded in `docs/ai/STATE.yaml`.

---

## 23. Next boundary

`design/contract -> **STOP** (here)` → `implement preflight + docs + focused tests -> STOP` →
`operator-executed live canary + full verification -> final review -> deliver -> STOP`.

Per `TEAM-WORKFLOW.md` Tier-3 stop boundaries. Same ticket, same branch, same worktree, same lease.
