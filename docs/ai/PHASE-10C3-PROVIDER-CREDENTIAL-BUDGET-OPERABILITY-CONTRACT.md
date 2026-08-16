# Phase 10C-3 — Provider credential / budget operability contract

**Ticket:** `TNX-P10C3-PROVIDER-CREDENTIAL-BUDGET-OPERABILITY`
**Tier:** 3 (design/contract gate only — no product code in the run that produced this document)
**Live base:** `origin/main` @ `3f5c7ea71446b287d10b9229fa103b7823e702ba` (merge of PR #24, `TNX-P10C2`)
**Branch:** `feat/phase-10c3-provider-credential-budget-operability`
**Worktree:** `F:\AI-Worktrees\ThreatNeXus\phase-10c3`
**Revision:** **v3** — amended after matched read-only review and one surgical re-check; see §18
**Status:** **READY** — closed after an independent bounded closure check on the v3 correction; see §19

---

## 1. What this contract is for, and what it refuses to be

`docs/ai/DECISIONS.md` D-P10B-01 records one deferred item as
"**No provider-configuration UI (credentials, budgets)**". That sentence is a *backlog note*, not an
approved design, and taken literally it points at the wrong solution. Grounding the repository at
`3f5c7ea` shows that a provider-*credential* status surface already exists and has since Phase 6, and
that a provider-*budget* surface already exists and has since Phase 10A-1. Neither is missing.

What is actually missing is smaller and sharper than "a configuration UI":

1. The two existing surfaces answer **different halves** of the operator's question, are gated on
   **different capabilities**, and are **never joined**. Nothing in the system answers
   *"can this provider execute right now, and if not, exactly what is missing?"*
2. The budget surface **still describes Phase 10A-1** and is now materially untruthful after 10A-2
   made reservations live (§3.6, defect **A**).
3. The budget surface's `reservedToday` field **reports the wrong day** once more than one day of
   usage exists (§3.6, defect **B**).

So 10C-3 is a **truthfulness and derivation** ticket, not a secret-management ticket. It writes no
credential, persists no secret, adds no mutation path, and turns nothing on.

**Binding refusals.** This contract explicitly refuses, on grounded evidence rather than caution:

- No database storage of provider credentials.
- No web form, field, or endpoint that accepts a credential value.
- No secret-manager integration and no secret-rotation surface.
- No new provider enablement mechanism (§3.4 shows one already exists and is not
  credential-independent).
- No runtime mutation of provider configuration of any kind.
- No new capability, no new role, no new migration.
- No change to execution, reservation, retry, concurrency, or freshness semantics.

---

## 2. Method

Every statement in §3 was read out of source in the `3f5c7ea` worktree. Nothing is carried over from
`STATE.yaml`, `HANDOFF.md`, prior-session memory, or the ticket prompt without independent
confirmation in code. Where canonical documentation and source disagreed, **source won and the
disagreement is recorded as a defect** (§3.6).

No provider was contacted. No `.env` was opened, read, printed, or referenced. No credential value
appears anywhere in this document, and none was requested from the user.

---

## 3. Grounded current state

### 3.1 Where provider credentials live

Environment variables only, resolved once at process start by
`backend/src/config/env.js` (`module.exports = buildConfig()` — evaluated at first `require`, and the
returned object is `Object.freeze`d).

| Provider | Credential variable(s) | Required to boot? | Effect when blank |
|---|---|---|---|
| `abuseipdb` | `ABUSEIPDB_API_KEY` | no | every lookup returns `SKIPPED_DISABLED` |
| `censys` | `CENSYS_PAT` (+ optional `CENSYS_ORG_ID`) | no | provider not callable |
| `greynoise` | `GREYNOISE_API_KEY` | no | provider not callable |
| `shodan` | `SHODAN_API_KEY` | no | provider not callable |
| `netlas` | `NETLAS_API_KEY` | no | provider not callable |
| `nvd` | `NVD_API_KEY` | no | **still usable** — NVD works keyless at a lower public rate limit |

`backend/src/services/enrichmentOrchestration/enrichmentOrchestrationConfig.js`
`isProviderCredentialConfigured(provider, config)` is the single derivation. It coerces to `Boolean`,
returns `true` unconditionally for `nvd`, and its `default:` branch returns `false` for an unknown
provider.

**The static credential gate, stated accurately.**
`backend/tests/unit/enrichmentOrchestrationInertness.test.js:270-286` asserts that no file **inside
the `enrichmentOrchestration` package**, other than `enrichmentOrchestrationConfig.js`, contains any
of the six credential variable names. It is a **package-scoped** gate, not a repository-wide one:
`config/env.js`, `enrichment/enrichmentRuntime.js`, `dashboard/operationalOverviewService.js`, the
four `*ExecutionService.js` modules and the four live-smoke scripts all name key variables
legitimately. `docs/ai/SECURITY.md:496-497` and `:571-572` overstate the gate as repository-wide and
are corrected by this ticket's documentation edit. See **I-16**.

Non-credential provider settings (`*_BASE_URL`, `*_TIMEOUT_MS`, `ABUSEIPDB_MAX_AGE_DAYS`) are
validated **strictly** at startup: an out-of-range or non-numeric value throws `ConfigError` and the
process does not boot. Config-validation messages name the variable and its bounds and **never**
interpolate the value.

`docker-compose.yml` passes every credential through from the host environment with a
`${VAR:-}` empty default (lines 91–98) and every orchestration switch/budget with its safe default
(lines 118–136). `backend/.env.example` documents all of them with blank credential values.

### 3.2 Configuration authority — and one real divergence

There are **two** read paths for the same orchestration values, and they are not equivalent:

| Path | Read semantics | Used by |
|---|---|---|
| `require("../../config/env")` | parsed **once**, frozen at boot | `enrichmentWorker.js:544`, `enrichmentRunService.js:103` (`appEnv()`), `enrichmentDirectExecutionService`, `enrichmentTargetedIocService` |
| `resolveOrchestrationConfig(process.env)` | re-parsed on **every call** | `enrichmentRunService.js:708` (routing budgets), `enrichmentUsageService.js:66` (reported budgets), `enrichmentRunReadService.js:54` (`executionState`), `reportIngestionService.js:932` (`AUTO_ENRICHMENT_ENABLED`) |

In production they agree, because nothing mutates `process.env` after boot. They can diverge under
test, and — more importantly — they mean the **reported** budget and the **spent** budget are read
through different code. The value that actually authorizes spend is the frozen one:
`enrichmentWorker.js:372-375` selects `appConfig.ENRICHMENT_AUTOMATIC_DAILY_BUDGETS` /
`ENRICHMENT_MANUAL_DAILY_BUDGETS` from `config/env` and passes it to `executeDirectJob({ limit })`.

**Three consequences this contract must state rather than leave implied:**

1. The operability surface reads from `config/env` — the same object that authorizes spend — or it
   can truthfully report a number the worker will not honour. This is **I-10**.
2. **I-10 rests on `process.env` being immutable after boot.** Any future code that mutates
   `process.env` at runtime voids I-10, `BUDGET_ZERO` and `READY` simultaneously, because the
   reported budget would then be the boot value while routing reads the mutated one.
3. `BUDGET_ZERO` describes a **routing-time** refusal (`enrichmentRunService.js:708`, live parse)
   while `BUDGET_EXHAUSTED` describes a **spend-time** refusal (frozen object). Both are reported
   from the frozen object under I-10. They are provably identical in production and could differ only
   under the condition in (2). A later reader must not treat the two as one authority.

4. **`executionState` is deliberately exempt from I-10, and is read through the existing live-parse
   function.** `resolveExecutionState` is **exported** (`enrichmentRunReadService.js:159`) and has
   three production call sites that all pass `process.env` explicitly:
   `enrichmentOrchestrationController.js:134` and `:170`, and — on the **analyst-visible** Finding
   summary — `enrichmentSummaryReadService.js:411`. The usage endpoint therefore **calls that
   function as it is**, rather than re-deriving the field from the frozen object. This keeps exactly
   one derivation of `executionState` in the system and touches no existing call site.

   v2 of this contract proposed the opposite — changing the function to read the frozen config — and
   both reviewers independently showed that to be a **fail-open**: with the signature changed to take
   a resolved config, any call site still passing `process.env` yields
   `config.ENRICHMENT_WORKER_ENABLED === "false"`, a **truthy string**, so a default deployment with
   the worker off would report `ACTIVE` on the one field whose purpose is to stop a recorded request
   being read as an executed one. Reusing the existing function removes that hazard instead of
   managing it.

   Residual, and bounded by consequence 2: within one response, `reservationsActive` (frozen, per
   I-10) and `executionState` (live parse) could disagree only if `process.env` were mutated at
   runtime — the same void condition that already invalidates I-10, `BUDGET_ZERO` and `READY`.
   Nothing mutates it today, and `parseDefaultOffSwitch` makes the live parse correct by
   construction for a boolean switch, which is why the budget argument for I-10 does not extend to
   this field.

`enrichmentRunService.js` is already internally split in exactly this way: it reads the budget from
the live parse at `:708` and the credential from the frozen `appEnv()` at `:746`, in the same loop.

### 3.3 Budget semantics as actually implemented

- **Unit: request counts.** One reservation = one intended provider call. There is no currency,
  no price, and no monetary field anywhere. Nothing in this contract may introduce one.
- **Granularity:** per `(provider, UTC calendar day, lane)`. Lane is `AUTOMATIC` (ingestion-triggered)
  or `MANUAL` (an analyst asked). `ProviderDailyUsage` is keyed by a composite primary key
  `@@id([provider, usageDate, lane])` (Prisma accessor `provider_usageDate_lane`). That key leads on
  `provider`, so it does **not** serve a single-day scan; the separate `@@index([usageDate, lane])`
  does.
- **Configured limit:** `<PREFIX>_AUTOMATIC_DAILY_BUDGET` and `<PREFIX>_MANUAL_DAILY_BUDGET`, prefix
  from `PROVIDER_ENV_PREFIX`. Accepted values: plain decimal integer `0..1000000`, or (MANUAL only)
  the literal `unlimited`. Surrounding whitespace is trimmed first and leading zeros are accepted
  (`" 05 "` resolves to `5`); exponent notation, `0x` forms and signed forms are rejected **before**
  `Number()` is called, on purpose.
- **Defaults:** every AUTOMATIC budget defaults to `0`. Every MANUAL budget defaults to `null`.
- **`0` means refuse, `null` means unlimited.** These are different values and must never be
  collapsed. `null` is still counted (`reservedCount` increments) so usage stays measurable.
- **Enforcement is atomic, at execution time, not at routing time.** `enrichmentQuotaService.js`
  `reserveProviderQuota` performs a guarded compare-and-swap (`updateMany` with
  `reservedCount: { lt: limit }`) **in the same transaction** that inserts the
  `ProviderLookupAttempt` ledger row. A refusal rolls the increment back. `limit === 0` refuses
  without issuing a statement at all (`:201-208`) — **before** `ensureUsageBucket` runs (`:210`).
- **The guard always compares against the live configured limit**, never against the stored
  `limitAtLastReservation` (that column is history, not policy). A budget lowered mid-day therefore
  takes effect on the next reservation, and can leave `reservedCount > limit`.
- **There is no refund and no decrement.** Accounting is deliberately conservative: it may over-count
  a reserved-but-unsent call; it can never under-count a sent one.
- **There is no reset job.** "Reset" is purely the UTC day rolling over, because the key includes
  `usageDate`. Nothing schedules anything.
- **The reservation day is `utcUsageDate(now)`** — `new Date(Date.UTC(y, m, d))`, midnight UTC,
  matching the `@db.Date` column (`enrichmentQuotaService.js:132-135`). This is the **only** correct
  derivation of the day, and §7 binds the reporting path to it by name.
- **Routing-time budget check is a separate, weaker control.** `enrichmentApplicabilityRouter.js`
  step 4 refuses only a **known-zero** lane budget (`SKIPPED_BUDGET` + `AUTOMATIC_BUDGET_ZERO` /
  `MANUAL_BUDGET_ZERO`) and creates no job. A positive budget produces an `ELIGIBLE` item whose job
  may still be refused later at reservation time (`EXECUTION_BUDGET_EXHAUSTED`).
- **`force` bypasses freshness and nothing else** (router step 3 only; D-P10C2-01).

### 3.4 Provider enablement — one authority inside Phase 10, a second one beside it

Grounded answer to the enablement question: **inside Phase 10, provider enablement is not independent
of credentials, and no per-provider env enable switch exists.**

`abuseIpdbProvider.js:295-297` — `isEnabled() { return !explicitlyDisabled && apiKey !== "" }`, where
`explicitlyDisabled` comes from a **constructor argument** (`config.enabled === false`) that no
production call site ever passes; `enrichmentRuntime.js:81-92 buildProviderConfig()` supplies only
`apiKey/baseUrl/timeoutMs/maxAgeInDays`. The same shape holds for the Censys, GreyNoise, Shodan and
Netlas providers, and the direct path refuses on credential alone before any reservation
(`enrichmentDirectExecutionService.js:120-127`). So within Phase 10:

> **credential present ⇔ provider enabled.**

`RUN_ITEM_DECISIONS.SKIPPED_DISABLED`, `JOB_STATES.SKIPPED_DISABLED`,
`SKIP_REASONS.PROVIDER_DISABLED` and `EXECUTION_SKIP_REASONS.EXECUTION_DISABLED` exist in the closed
vocabularies and are reachable only from a provider result, never from a deployment switch.
**This contract therefore adds no enablement mechanism.**

**But a second activation authority does exist, outside Phase 10, and it is what the existing screen
already reports.** `IOC_ENRICHMENT_PROVIDER` (`config/env.js:514`, default `"mock"`) selects which
provider the **legacy** IOC path resolves. `operationalOverviewService.js:450,461-466` reports the
`ioc-reputation` row as `MOCK_PROVIDER` whenever that selector is `mock` — **regardless of whether
`ABUSEIPDB_API_KEY` is present**. The Phase-10 delegate ignores the selector entirely and hardcodes
`provider: "abuseipdb"` (`enrichmentRunService.js:390-395`).

Consequence, and it is a rendering hazard rather than a security one: on a deployment with a real
AbuseIPDB key and the default `IOC_ENRICHMENT_PROVIDER=mock`, `Settings.jsx` would show
"IP reputation — Mock provider" in one panel and "abuseipdb — READY" in the panel directly below.
Both are true **of different execution paths**, and an operator has nothing on screen to tell them
apart. `IOC_ENRICHMENT_PROVIDER` is therefore deliberately **not** an input to readiness (§8), and the
UI must state the boundary (§13, and a browser assertion in §15).

### 3.5 Execution eligibility, end to end

The complete conjunction that must hold before a Phase-10 provider call happens:

```
ENRICHMENT_WORKER_ENABLED = true          deployment  — server.js:18 gates the require itself
  AND provider credential configured      deployment  — router step 2 / resolveDescriptor
  AND lane daily budget != 0              deployment  — router step 4 (known-zero, no job created)
  AND reservedCount < limit               runtime     — atomic CAS at reservation
  AND subject compatible with provider    per-Finding — router step 1
  AND (no fresh result OR force)          per-Finding — router step 3
  AND caller holds trigger:finding-enrichment (MANUAL) / ingestion path (AUTOMATIC)
```

**and, for the AUTOMATIC lane only, one further deployment gate:**

```
  AND AUTO_ENRICHMENT_ENABLED = true      deployment  — reportIngestionService.js:931-932
```

`AUTO_ENRICHMENT_ENABLED` decides whether ingestion **records an orchestration run at all**. The lane
is fixed from the trigger (`enrichmentRunService.js:701`, `INGESTION → AUTOMATIC`). With it `false`
— the shipped default (`config/env.js:574`) — no AUTOMATIC job can ever exist, so nothing on that
lane can ever execute or spend, no matter how the credential, worker and budget are set. This is why
the readiness ladder is **lane-aware** (§8.2 step 4).

Three distinct execution paths, which the operability surface must distinguish:

| Path | Providers | Mechanism |
|---|---|---|
| `WORKER_DIRECT` | `censys`, `greynoise`, `shodan`, `netlas` | `enrichmentWorker` → `enrichmentDirectExecutionService.executeDirectJob` |
| `WORKER_DELEGATED_IOC` | `abuseipdb` | `enrichmentWorker` → `enrichmentTargetedIocService` → canonical IOC queue |
| `ADMIN_VULNERABILITY_BATCH` | `nvd` | **never worker-eligible** — `SKIP_REASONS.DELEGATE_BATCH_REQUIRED`; runs only via the existing ADMIN vulnerability batch |

`reserveProviderQuota` is called from exactly two sites — `enrichmentDirectExecutionService.js:214`
and `enrichmentTargetedIocService.js:126` — **both worker-driven**. That is what makes §3.6's fix A
(`reservationsActive` ← `ENRICHMENT_WORKER_ENABLED`) truthful, and it is **topology-dependent**:
`server.js:18` starts the worker in-process and there is no separate worker entrypoint. A future
split-process deployment would make `reservationsActive` report the API process's switch while a
worker process spends. Recorded here so that change cannot be made silently.

### 3.6 The two existing surfaces, and the three defects in them

**Surface 1 — `GET /api/dashboard/overview` → `sections.providers`.**
`operationalOverviewService.js:1246` mounts it with `capability = null`, i.e. it rides on
`read:dashboard` and is visible to **every role including VIEWER**. Per provider it emits a
non-secret `status` (`MOCK_PROVIDER` / `CONFIGURED` / `NOT_CONFIGURED`), a freshness block derived
from the last stored `SUCCESS`, and a `source` string. It emits **no budget, no worker state, and no
execution eligibility**. `frontend/src/pages/Settings.jsx` renders it under "Platform configuration"
and already states, in the file header, that the page is deliberately *not* an HTTP switch for a
provider selection or an API key — "those are environment configuration … exposing them here would
turn a deployment decision into a request body."

**Surface 2 — `GET /api/enrichment/usage`.** Mounted at `app.js:102`, gated on
`CAPABILITIES.EXECUTE_ENRICHMENT_BATCH`, which `roles.js` grants to **ADMIN only**. It emits
configured budgets and reservation counts per provider per lane. It emits **no credential state, no
worker state, and no readiness**. It has **no frontend caller** (verified: no match for `/usage` under
`frontend/src`), which is what makes the corrections below safe to land.

Three defects, all in `enrichmentUsageService.js`. Both reviewers independently confirmed A and B.

- **Defect A — `reservationsActive` is a hardcoded `false` (line 106).** Written for 10A-1, when
  nothing reserved. Since 10A-2 the worker reserves on every direct and targeted execution. With
  `ENRICHMENT_WORKER_ENABLED=true` this field is simply false. `docs/ai/SECURITY.md:515-519` repeats
  the stale claim **and adds a second one** — "returns zeros in this milestone" — which is likewise
  no longer true. **Severity: P1 — an operator reading this cannot tell whether spend is live.**
- **Defect B — `reservedToday` reports the wrong day.** The controller
  (`enrichmentOrchestrationController.js:210`) calls `getProviderUsage({ client: prisma })` with no
  `usageDate`; the service forwards `null` (`:67-69`); the repository then runs `where: {}` ordered
  `usageDate DESC` (`enrichmentOrchestrationRepository.js:590-595`), returning **every** day. The
  indexing loop (`:74-77`) overwrites unconditionally, so the value that survives per
  `(provider, lane)` is the **last row iterated — the oldest day** — published under the name
  `reservedToday`. Invisible in 10A-1 (the table was always empty) and in any single-day environment;
  wrong from the second day of real usage onward. **Severity: P1 — the number an operator would use
  to decide whether budget remains is not today's number.**
- **Defect C — stale scope prose.** `note` (`:110-114`) asserts "Phase 10A-1 performs no provider
  calls and creates no reservations, so every count is zero", and `EXCLUDED_PATHS[2]` (`:53`) is
  `PRE_10A2_SYNCHRONOUS_DIRECT_PROVIDER_ROUTES`, whose name implies those routes were removed in
  10A-2. They are still mounted (`app.js:86-89`) and still contact providers outside Phase-10
  accounting. **Severity: P2 — misleading, not wrong in substance.** `coverage: PARTIAL` remains
  correct and stays.

### 3.7 Security, audit and deployment conventions this contract inherits

- API keys come from environment variables only and never appear in logs, error responses, the
  browser bundle, screenshots, fixtures, test reports or commits (`SECURITY.md` §"Secret handling").
- Audit is an **allow-list, never a redaction pass**: every payload names the fields it copies.
  Never audited or returned on any path: an API key or any prefix or length of one; a raw provider
  body; any header; an exception `message` or `stack`; `claimToken`, `queryIdentityHash`,
  `activeLookupKey`, `requestScopeHash`, `idempotencyKey`.
- `ProviderLookupJob` deliberately has no `errorMessage` and no raw-body column.
- No configuration of any kind is mutable at runtime anywhere in this repository today. There is no
  admin-settings write pattern to follow, because none exists.
- A configuration change requires editing the deployment environment and **restarting the process**.
  `SECURITY.md`'s "a mid-day budget change takes effect immediately" refers to the CAS guard reading
  the live *configured* limit rather than `limitAtLastReservation`; it does **not** mean the process
  re-reads its environment. This contract states the restart requirement explicitly because the
  existing wording can be misread.
- `enrichmentOrchestrationConfig.js` is **on the boot path** — imported by `config/env.js:64` — so
  anything added to it that can throw becomes a boot failure. §13 constrains the addition to pure
  data plus one pure total function for exactly this reason.

---

## 4. Split preflight

Independent high-risk surfaces the ticket could touch, scored against what §3 actually found:

| # | Candidate surface | In scope? | Why |
|---|---|---|---|
| 1 | Secret storage / retrieval | **No** | Credentials stay environment-owned and are never read as values (§3.1). Nothing to build. |
| 2 | Provider enablement | **No** | Already exists as credential presence (§3.4). Adding a second authority is a net loss. |
| 3 | Budget / spend authority | **Yes (read-only)** | Reporting + two truthfulness fixes. No change to how spend is authorized. |
| 4 | Admin API | **Yes (additive read)** | One existing endpoint, additive fields, existing capability, no new route. |
| 5 | Admin UI | **Yes (small)** | One capability-gated section on an existing page that already owns this subject. |
| 6 | Deployment configuration | **Docs only** | `.env.example` already carries every variable; the operator runbook does not explain readiness. |
| 7 | Audit / security logging | **No** | No mutation is introduced, so there is no event to record (§12). |
| 8 | Runtime reload / restart | **Documented, not built** | Restart-required is stated, not changed. |

**Verdict: 10C-3 remains ONE bounded implementation ticket. No split.**

Three surfaces are live (3, 4, 5) and they are not independent — they are one read path from one
configuration object, through one endpoint, to one panel. Splitting them would produce an endpoint
with no reader and a panel with no data. The `>= 3 independent surfaces` heuristic in
`TEAM-WORKFLOW.md` is explicitly conditioned on *independent*; these are the same surface at three
altitudes. A ceremonial 10C-3A/10C-3B split is refused.

---

## 5. Chosen operability model — **Outcome A, read-only**

> **Credentials and budgets remain environment/deployment-owned and are never editable through the
> application. ThreatNeXus reports, server-side and non-secretly, whether each provider is usable —
> and when it is not, names the exact configuration identifier that is missing.**

Concretely, and this is the whole of the implementation:

1. A **pure derivation function** that turns the canonical server configuration plus today's usage
   row into one closed readiness value per `(provider, lane)`, plus the non-secret facts needed to
   act on it.
2. **Additive** extension of the existing ADMIN-gated `GET /api/enrichment/usage` response, plus the
   three corrections in §3.6.
3. One **capability-gated section** on the existing Settings page, carrying an explicit note about
   the §3.4 path boundary.
4. Documentation: `.env.example`, `docs/PROVIDER_GUIDE.md`, `docs/OPERATIONS_RUNBOOK.md`,
   `docs/ai/SECURITY.md`.

Outcome B (persisted non-secret budgets + admin mutation API) is **rejected on evidence**: it would
introduce this repository's first runtime-mutable configuration, a new write authority over spend, a
migration, an audit vocabulary, and a precedence rule between a database value and an environment
value — to replace an `.env` edit plus a restart that an operator with deploy access already performs
for every other setting in the system. It would also void I-10 (§3.2 consequence 2). Outcome C
(split) is rejected in §4.

---

## 6. Secret boundary — the ten required answers

| # | Question | Binding answer |
|---|---|---|
| 1 | Where do provider credentials live? | Process environment variables only, read once at boot into the frozen `config/env.js` object. Supplied by the deployment (`docker-compose.yml` passthrough, or the host env). |
| 2 | Does ThreatNeXus persist them? | **No.** No table, column, cache, or file. This contract adds none. |
| 3 | Can the browser ever receive them? | **No.** No credential value, prefix, suffix, length, hash, or fingerprint crosses the API boundary. Only a `boolean` and a **variable name**. |
| 4 | Can API responses reveal them? | **No.** The response schema in §8.4 is a closed allow-list of booleans, integers, `null`, closed-vocabulary strings, fixed variable-name strings, one date, and one fixed prose `note`. |
| 5 | Can logs reveal them? | **No.** Unchanged from today: nothing reads a key value, and I-16 keeps the package-scoped gate intact. |
| 6 | Can audit events contain them? | **No** — and this ticket emits no new audit event at all (§12). |
| 7 | Can the UI edit them? | **No.** No input, no form, no mutating request. The UI is strictly a renderer of the server's derivation. |
| 8 | Who may view configuration **status**? | Two tiers, both pre-existing. Coarse credential-configured status stays on `read:dashboard` (all roles, unchanged). Budget, usage, worker state and readiness require `execute:enrichment-batch` — **ADMIN only**. |
| 9 | Who may mutate non-secret provider configuration? | **Nobody, through the application.** There is no mutation surface. Configuration changes only through the deployment environment. |
| 10 | Is a restart/redeploy required after a credential change? | **Yes**, and the surface must say so. `config/env.js` is evaluated once at first `require` and frozen; `server.js:18` gates the worker `require` itself on the boot-time switch value, so even toggling `ENRICHMENT_WORKER_ENABLED` cannot take effect without a restart. |

**Naming a missing variable is not a secret disclosure.** The identifiers exposed
(`CENSYS_PAT`, `SHODAN_API_KEY`, …) are already published verbatim in `backend/.env.example`,
`docker-compose.yml:91-98`, `docs/DEPLOYMENT.md` and `docs/PROVIDER_GUIDE.md`. They are public
configuration *schema*; the secret is the *value*, and `missingConfiguration` is emitted **only**
when there is no value, **only** to a caller holding `execute:enrichment-batch`, and never alongside
any property of a value.

**One structural exposure is created by I-10 and is closed by it.** Reading `config/env` instead of
`resolveOrchestrationConfig(...)` puts a module that serializes to HTTP within reach of an object
that also carries `JWT_SECRET`, `DATABASE_URL` and all six credential values. I-10 therefore requires
a **narrowing projection at the module boundary** (§13), and §15 extends the sentinel test to
`JWT_SECRET` and `DATABASE_URL`, not only provider keys.

---

## 7. Budget authority

**Current, and unchanged by this ticket:**

- Server-side and deployment-owned. The frozen `config/env.js` values
  `ENRICHMENT_AUTOMATIC_DAILY_BUDGETS` / `ENRICHMENT_MANUAL_DAILY_BUDGETS` are the sole spend
  authority (`enrichmentWorker.js:372-375` → `executeDirectJob({ limit })`).
- Enforced atomically at reservation, in the same transaction as the ledger insert.
- Request counts, never currency. Per provider, per lane, per UTC day. No refund, no decrement, no
  reset job.
- No request field, header, or body anywhere in the system can raise, lower, or bypass a budget.
  `force` bypasses freshness only (D-P10C2-01).

**Proposed by this ticket:** reporting only.

- `dailyBudget` — the configured integer, or `null` for unlimited. **Never coerced.**
- `reservedToday` — `reservedCount` for **today's UTC `usageDate`**, where that date is derived by
  calling **`enrichmentQuotaService.utcUsageDate(now)`** — the same function reservations key on.
  This binding is mandatory (**I-11**): a date carrying a time component, or a local-midnight date,
  matches zero rows and would report a genuinely exhausted provider as `READY`.
- **`usageDate` is computed once** from the controller-supplied `now`, and the value published in the
  response is byte-identical to the value used in the `WHERE` clause. Computing it twice can straddle
  UTC midnight and publish a date that does not match the counts.
- **An absent bucket means `0`, and that is a true measurement rather than a placeholder** — but only
  *because* of the binding above. `ensureUsageBucket` is called solely from `reserveProviderQuota`
  (`:210`) and only **after** the `limit === 0` short-circuit (`:201-208`), so a missing row provably
  means zero reservations for that exact `(provider, usageDate, lane)`. Without the `utcUsageDate`
  binding this same rule fails open, which is why §7 and I-15 are reconciled here explicitly rather
  than left to state opposite things about the same input.
- `remaining` — `dailyBudget === null ? null : Math.max(0, dailyBudget - reservedToday)`.
  `null` means unlimited and must never render as a number. **`remaining` is an upper bound at read
  time** and may already be lower by the time it is read. The `Math.max(0, …)` clamp is load-bearing,
  not cosmetic: lowering a budget mid-day can leave `reservedToday > dailyBudget`, because the CAS
  compares the live limit and never decrements.

The reporting path **must** read the same frozen object the worker reads (I-10). A second parse of
`process.env` for a displayed budget would let the surface promise capacity the worker will refuse.

---

## 8. Readiness model

### 8.1 The closed vocabulary

**Seven** values. Derived **entirely server-side**, from canonical configuration plus today's usage
row. No provider is contacted to compute one, and no frontend may derive one.

| Value | Meaning | Operator action |
|---|---|---|
| `READY` | Every deployment-level control passes for this provider **and this lane**. Recorded work will be picked up and may spend. | none |
| `NOT_CONFIGURED` | No credential. The provider cannot be called at all. | set the variable named in `missingConfiguration`, restart |
| `EXECUTION_PAUSED` | Credential present, but `ENRICHMENT_WORKER_ENABLED=false`. Work is recorded and never executed. Affects **both** lanes. | set `ENRICHMENT_WORKER_ENABLED=true`, restart |
| `AUTOMATIC_INGESTION_DISABLED` | **AUTOMATIC lane only.** `AUTO_ENRICHMENT_ENABLED=false`, so ingestion records no run and no automatic job can ever exist. | set `AUTO_ENRICHMENT_ENABLED=true`, restart |
| `BUDGET_ZERO` | This lane's configured daily budget is `0`. Refused at routing time; no job is created. | raise `<PREFIX>_<LANE>_DAILY_BUDGET`, restart |
| `BUDGET_EXHAUSTED` | Positive budget, but today's `reservedToday >= dailyBudget`. | wait for UTC midnight, or raise the budget and restart |
| `DELEGATED_BATCH_REQUIRED` | `nvd` only. Structurally not worker-eligible; execution is the existing ADMIN vulnerability batch. | run the ADMIN vulnerability batch |

### 8.2 Precedence (first match wins, evaluated in this order)

```
0. ASSERT      provider ∈ KNOWN_PROVIDERS, lane ∈ QUOTA_LANES, credentialConfigured and
               workerEnabled and automaticIngestionEnabled are booleans, dailyBudget is
               number|null, reservedToday is a non-negative integer.
               Otherwise THROW TypeError. See §8.3.
1. DELEGATED_BATCH_REQUIRED     provider is nvd — true in every deployment, independent of all config
2. NOT_CONFIGURED               credentialConfigured === false
3. EXECUTION_PAUSED             workerEnabled === false
4. AUTOMATIC_INGESTION_DISABLED lane === AUTOMATIC && automaticIngestionEnabled === false
5. BUDGET_ZERO                  dailyBudget === 0
6. BUDGET_EXHAUSTED             dailyBudget !== null && reservedToday >= dailyBudget
7. READY                        otherwise
```

Rule 2 precedes rule 3 for the same reason `enrichmentApplicabilityRouter` puts credential before
budget: "we cannot call this provider at all" is the more durable and more actionable fact than
"nothing is running right now". Rule 3 precedes rule 4 because the worker switch blocks both lanes
while ingestion blocks only one — the broader refusal is reported first. Rule 5 precedes rule 6
because `0` never resets at midnight and exhaustion always does; collapsing them would tell an
operator to wait for a rollover that changes nothing.

**`READY` is a complete answer for both lanes by construction.** It already accounts for the worker
switch and, on the AUTOMATIC lane, for `AUTO_ENRICHMENT_ENABLED`, so a consumer never has to AND it
with another top-level field. `automaticIngestionEnabled` and `executionState` remain in the response
as *context*, never as a correction the reader must apply. This is deliberate: Phase 10C-1's finding
was that consumers asked to compose truth themselves get it wrong, and v1 of this contract reproduced
exactly that defect on the AUTOMATIC lane — both reviewers caught it independently.

### 8.3 Malformed input throws; it does not resolve

Step 0 **throws `TypeError`** rather than returning a refusal value. This follows
`enrichmentApplicabilityRouter.routeTarget`'s own established rule: an unroutable *data* condition is
a decision, but a malformed *context* is a programming error and must surface loudly. Here the
provider list is closed and server-controlled — the caller iterates `KNOWN_PROVIDERS` — so an unknown
provider or a wrong-shaped budget can only arise from a coding defect such as passing a raw
environment map where a resolved config was expected. Silently rendering that as `NOT_CONFIGURED`
would hide a bug behind a plausible-looking screen; throwing fails the request closed, emits no
`READY`, and is caught by §15's tests.

### 8.4 Values deliberately excluded, with reasons

- **`UNSUPPORTED`** — the provider set is closed (`KNOWN_PROVIDERS`), so there is no unknown provider
  to report at deployment level. Provider/subject compatibility is a **per-Finding** fact already
  carried by `SKIP_REASONS.PROVIDER_SUBJECT_MISMATCH` and `SUMMARY_STATUSES.NO_SUBJECT`. Reporting
  it here would duplicate an existing vocabulary at the wrong altitude.
- **`CONFIG_INVALID`** — unreachable. An invalid provider setting throws `ConfigError` in
  `buildConfig()` and the process does not start, so no running instance can ever be in this state.
  Including it would put a permanently unreturnable value in a closed vocabulary — exactly the defect
  D-P10A2-03 retired `NOT_IMPLEMENTED` for.
- **`DISABLED`** — would imply a Phase-10 enablement switch independent of credentials. §3.4 proves
  none exists; `NOT_CONFIGURED` is the truthful name for the same state.
- **`MOCK_PROVIDER`** — belongs to the legacy IOC path's selector (§3.4), which is deliberately not an
  input here. Admitting it would make this vocabulary describe two different execution paths at once.

### 8.5 Response shape

Additive to the existing `GET /api/enrichment/usage`. Every field present today is **preserved with
its current name and meaning** except the three §3.6 corrections.

```jsonc
{
  "accountingScope": "PHASE_10_RESERVATIONS",   // unchanged
  "coverage": "PARTIAL",                        // unchanged — still true
  "reservationsActive": true,                   // FIX A: derived from ENRICHMENT_WORKER_ENABLED
  "executionState": "ACTIVE",                   // new FIELD, existing DERIVATION — calls the exported
                                                //   resolveExecutionState(process.env) unmodified (§3.2 c.4)
  "automaticIngestionEnabled": false,           // new; AUTO_ENRICHMENT_ENABLED — context, not a correction
  "configurationSource": "ENVIRONMENT",         // new; constant — states where authority lives
  "configurationMutable": false,                // new; constant — states that no API can change it
  "restartRequiredForChanges": true,            // new; constant — §6 answer 10, made machine-readable
  "usageDate": "2026-08-17",                    // new; UTC day, serialized YYYY-MM-DD (see below)
  "excludedPaths": [                            // FIX C: third entry renamed
    "LEGACY_ADMIN_IOC_BATCH",
    "ADMIN_VULNERABILITY_BATCH",
    "SYNCHRONOUS_DIRECT_PROVIDER_ROUTES"
  ],
  "note": "…",                                  // FIX C: rewritten for post-10A-2 truth
  "providers": [
    {
      "provider": "censys",                     // unchanged
      "subjectType": "IPV4",                    // new
      "executionPath": "WORKER_DIRECT",         // new; closed set, §3.5
      "credentialConfigured": false,            // new; boolean ONLY
      "missingConfiguration": ["CENSYS_PAT"],   // new; variable NAMES only, [] when configured
      "automatic": {
        "dailyBudget": 0,                       // unchanged
        "reservedToday": 0,                     // FIX B: now genuinely today
        "remaining": 0,                         // new; upper bound, see §7
        "readiness": "NOT_CONFIGURED"           // new
      },
      "manual": {
        "dailyBudget": null,
        "reservedToday": 0,
        "remaining": null,
        "readiness": "NOT_CONFIGURED"
      }
    }
    // … all six KNOWN_PROVIDERS, always, in KNOWN_PROVIDERS order
  ]
}
```

**`usageDate` is serialized as `YYYY-MM-DD` (UTC) and must be formatted explicitly.** The column is
`@db.Date`, Prisma returns a `Date`, and `JSON.stringify` would emit
`"2026-08-17T00:00:00.000Z"` — implying a time-of-day precision the column does not carry.

All six providers are always represented, exactly as the Finding enrichment summary always represents
all six. An absent provider row would be indistinguishable from a provider that does not exist.

---

## 9. Authorization

| Surface | Capability | Roles | Change |
|---|---|---|---|
| `GET /api/dashboard/overview` → `sections.providers` | `read:dashboard` | ADMIN, ANALYST, REVIEWER, VIEWER | **none** |
| `GET /api/enrichment/usage` (extended) | `execute:enrichment-batch` | **ADMIN only** | **none** — existing route, existing guard |
| Settings → new operability section | UI gated on the session advertising `execute:enrichment-batch` | ADMIN only in practice | UX gating only |

**No new capability is minted.** The pre-existing decision is already recorded at
`backend/src/routes/enrichmentUsageRoutes.js:5-7`: this data is
*"operational data about third-party quota policy and Phase-10 reservations, so it is gated on the
ADMIN-held `EXECUTE_ENRICHMENT_BATCH` rather than on a Finding read: budgets are a deployment
concern, not finding evidence."* That is the correct authority and this ticket simply keeps it.

> Note for accuracy: `roles.js:49-51` says the enrichment capability table "decides only which roles
> may cause work or provider spend, **not which may see results**". That comment concerns *enrichment
> result reads*, which reuse `READ_FINDINGS`; it is not an argument for putting deployment budget
> policy on a findings capability. v1 of this contract cited it in a way that inverted its meaning.

The two-tier split is load-bearing and depends on §13 leaving `operationalOverviewService.js`
**explicitly untouched**: the `capability: null` panel visible to VIEWER gains no budget, worker-state
or readiness field. Coarse "is a key present" is legitimate context for interpreting a risk score;
spend policy is not.

Analysts need none of this. An analyst already receives the truthful per-Finding consequence —
`SKIPPED_NOT_CONFIGURED`, `SKIPPED_BUDGET`, `executionState` — through the Phase-10C1 summary
vocabulary on the Finding panel.

**Frontend authorization is UX only.** The capability check in the UI decides whether to *render*;
the server independently refuses. Negative authorization cases are mandatory test coverage (§15):
ANALYST, REVIEWER and VIEWER must each receive `403` with **no response body field derived from
configuration**, and an unauthenticated caller must receive `401`.

---

## 10. Mutation semantics

**None.** This ticket introduces no `POST`, `PUT`, `PATCH` or `DELETE`, and no request body.
`GET /api/enrichment/usage` remains a pure read that writes nothing — including no
`ProviderDailyUsage` bucket. The reporting path uses a read-only `findMany` scoped to an explicit
`usageDate` and must never call `ensureUsageBucket`, because creating a bucket as a side effect of
*looking* would make an observer's read indistinguishable from activity.

**The reported day is not request-selectable.** `getProviderUsage` already accepts an
`options.usageDate`; the HTTP layer must never populate it from a query parameter, header, or body.
A `?usageDate=` would let an ADMIN — or a copied/bookmarked URL — read a quiet day's zeros as today's
headroom, reproducing defect B by request. See **I-11**.

---

## 11. Migration

**Not required.** Every input already exists:

- Credentials, switches and budgets: environment → `config/env.js` (no schema).
- Usage counts: the existing `ProviderDailyUsage` table. `@@id([provider, usageDate, lane])` gives
  the bucket its identity and guarantees **at most one row per `(provider, lane)` for a given date** —
  which is what makes defect B's fix complete, since the indexing loop becomes harmless once the
  query is date-scoped. `@@index([usageDate, lane])` serves that query directly. No new column, no
  new index.
- Readiness: derived, never persisted. Persisting it would create a value that can silently disagree
  with the configuration it was derived from.

A migration in this ticket would be evidence the design drifted into Outcome B.

---

## 12. Audit semantics

**No new audit event.** `AGENTS.md`'s cross-cutting rule is that *every write path* appends its own
`AuditLog` event in the same change. This ticket adds no write path, so there is nothing to record.
Emitting an event for a read would (a) contradict the existing convention, (b) make an ADMIN opening
a settings page indistinguishable from an ADMIN changing something, and (c) grow the audit table on a
page refresh.

If a future ticket ever introduces operator-mutable non-secret configuration, its audit payload must
be an allow-list of `actor`, `provider`, `setting identifier`, `old`/`new` **non-secret** value, and
`timestamp` — and must never carry a credential value, prefix, length, or any property of one. That
is a note for a successor, not a licence for this ticket.

---

## 13. Implementation surface

Exact expected files. Anything outside this list is scope creep.

### Backend (6 files, 1 new)

| File | Change |
|---|---|
| `backend/src/services/enrichmentOrchestration/enrichmentOrchestrationConfig.js` | Add `PROVIDER_CREDENTIAL_VARIABLES` (provider → frozen array of required variable names; `nvd` → `[]`) and the total function `missingProviderCredentialVariables(provider, config)`. **Must live here** — I-16's package-scoped gate keeps the names out of every other module in the package. **Pure data plus one pure function only**: this file is on the boot path (`config/env.js:64`), so anything that can throw here becomes a boot failure. Existing exports unchanged. |
| `backend/src/services/enrichmentOrchestration/enrichmentProviderReadiness.js` *(new)* | Pure. No Prisma, no network, no wall clock, no `process.env`. Exports the frozen `PROVIDER_READINESS` vocabulary, its precedence array, `resolveExecutionState(config)`, and `resolveProviderReadiness({ provider, lane, credentialConfigured, workerEnabled, automaticIngestionEnabled, dailyBudget, reservedToday })` implementing §8.2 including step 0's `TypeError`. Mirrors `enrichmentApplicabilityRouter.js`'s shape so it is testable without a database. |
| `backend/src/services/enrichmentOrchestration/enrichmentUsageService.js` | Query **today's** `usageDate`, derived by `enrichmentQuotaService.utcUsageDate(now)` and computed once (fix B, I-11). Derive `reservationsActive` and `executionState` (fix A). Rewrite `note`, rename `EXCLUDED_PATHS[2]` (fix C). Add the new fields in §8.5. **Under I-10 the config seam changes shape**: the old `options.env` raw-environment-map parameter (fed to `resolveOrchestrationConfig`) is **removed**, not left as a second ambiguous path, and replaced by an injectable already-resolved `config/env`-shaped object. The service **projects that object into a named local shape** (`{ workerEnabled, autoEnabled, automaticBudgets, manualBudgets, credentialFlags, missingVariables }`) at the module boundary and never holds or passes the full env object into the response builder (§6). |
| `backend/src/services/enrichmentOrchestration/enrichmentRunReadService.js` | **No change — see §3.2 consequence 4.** The usage endpoint calls the **existing exported** `resolveExecutionState(process.env)` unmodified, so the system keeps exactly **one** derivation of `executionState` and this ticket touches none of its three existing call sites. |
| `backend/src/services/enrichmentOrchestration/enrichmentOrchestrationRepository.js` | Expected: **no change.** `listDailyUsage(client, { usageDate })` already supports an explicit date and is a pure `findMany`. Confirmed sufficient by review. |
| `backend/src/controllers/enrichmentOrchestrationController.js` | `getEnrichmentUsage` supplies an explicit `now`. No route, guard, or status-code change, and it must not read a date from the request (§10). |

### Backend tests that fixes A and C necessarily break (must be updated in the same change)

| File | Why |
|---|---|
| `backend/tests/unit/enrichmentRunServices.test.js` | `:357` asserts `reservationsActive === false`; `:365` asserts `excludedPaths` contains `PRE_10A2_SYNCHRONOUS_DIRECT_PROVIDER_ROUTES`; `:374` asserts the current `note`; `:354/:361/:369/:378/:386` call `getProviderUsage({ client, env: {} })` with a **raw environment map**, which the I-10 seam change replaces. Left unlisted, §15's zero-regression gate is unsatisfiable. |
| `backend/tests/integration/phase10a1RouteAuthorization.test.js` | `:775` asserts `res.body.data.reservationsActive === false`. |

### Frontend (3 files)

| File | Change |
|---|---|
| `frontend/src/services/api.js` | One `GET /enrichment/usage` reader on the existing axios instance. No new client, no interceptor change. |
| `frontend/src/pages/Settings.jsx` | One new section, "Enrichment budgets and readiness", rendered only when the session advertises `execute:enrichment-batch`. Renders `readiness` through a `StatusBadge` dictionary, `missingConfiguration` as literal variable names, a fixed screen-owned line stating that configuration is deployment-owned and requires a restart, and — **required** — a `ScopeNote` stating that this section describes the **Phase-10 orchestration path only**, and that the `MOCK_PROVIDER` status in the panel above refers to the legacy IOC path's `IOC_ENRICHMENT_PROVIDER` selector (§3.4). Reuses `Panel` / `Field` / `StatusBadge` / `Provenance` / `ScopeNote`. No server free text reaches the DOM. |
| `frontend/src/pages/Settings.test.jsx` *(new or extended)* | Component tests per §15. |

### Documentation (4 files)

`backend/.env.example` (a readiness/restart paragraph in the Phase-10 block) ·
`docs/PROVIDER_GUIDE.md` (per-provider variable → readiness table) ·
`docs/OPERATIONS_RUNBOOK.md` (a "which providers are usable?" procedure) ·
`docs/ai/SECURITY.md` — correct **three** stale claims: the §"Truthful usage reporting" paragraph
(`:515-519`, both `reservationsActive: false` and "returns zeros in this milestone"), and the
repository-wide overstatement of the credential gate at `:496-497` and `:571-572` (§3.1). Record this
ticket's secret boundary.

### Explicitly untouched

`backend/prisma/schema.prisma` and every migration · `roles.js` · every route file (`app.js`
included) · `enrichmentWorker.js` · `enrichmentDirectExecutionService.js` ·
`enrichmentQuotaService.js` · `enrichmentApplicabilityRouter.js` · `enrichmentRunService.js` ·
`operationalOverviewService.js` (load-bearing for §9's two-tier split) · every provider module ·
`config/env.js` · `package.json` / lockfiles anywhere ·
**`enrichmentRunReadService.js`, `enrichmentSummaryReadService.js`, and the two
`resolveExecutionState(process.env)` call sites in `enrichmentOrchestrationController.js` (`:134`,
`:170`)** — see §3.2 consequence 4. `resolveExecutionState` keeps its current signature (raw
environment map in) and all three existing call sites are untouched.

---

## 14. Binding invariants

| # | Invariant |
|---|---|
| **I-01** | No provider credential value — nor any prefix, suffix, length, hash, or fingerprint of one — is returned by any API, rendered in any UI, written to any log, or placed in any audit event. Credential state is exposed **only** as a boolean plus, when absent, the variable name. |
| **I-02** | Provider credentials are never persisted by ThreatNeXus in any table, column, cache, or file, and no endpoint accepts a credential value in any request. |
| **I-03** | No provider configuration is mutable through the application. `GET /api/enrichment/usage` writes nothing — including no `ProviderDailyUsage` bucket. |
| **I-04** | Provider readiness is derived **server-side only**. The frontend renders a value it received and can never compute, infer, or override one. |
| **I-05** | The readiness vocabulary is closed (seven values, §8.1). No free text, exception message, provider string, or upstream error body can reach a readiness field. Any value outside the closed set is suppressed at serialization. |
| **I-06** | Budget authority remains server-side and deployment-owned. No request field, header, or body can raise, lower, or bypass a budget. |
| **I-07** | `force` bypasses freshness only. It does not bypass credential, budget, subject, capability, or active-work controls — unchanged from D-P10C2-01. |
| **I-08** | A `NOT_CONFIGURED`, `BUDGET_ZERO`, `BUDGET_EXHAUSTED`, `EXECUTION_PAUSED` or `AUTOMATIC_INGESTION_DISABLED` provider remains non-executable. This ticket changes no execution, reservation, retry, or concurrency semantics. |
| **I-09** | 10C-3 enables no worker, no provider, and no live execution. Every default stays off: `AUTO_ENRICHMENT_ENABLED=false`, `ENRICHMENT_WORKER_ENABLED=false`, every AUTOMATIC budget `0`. Reading this surface performs no provider request. |
| **I-10** | Every reported **budget and credential** fact is read from the **same** `config/env.js` object that authorizes spend — never from an independent `resolveOrchestrationConfig(process.env)` parse — and is **projected into a narrow named shape at the module boundary** so no module serializing to HTTP holds an object carrying `JWT_SECRET`, `DATABASE_URL` or a credential value. **One explicit exemption:** `executionState` is produced by calling the existing exported `resolveExecutionState(process.env)` unmodified, so the system keeps a single derivation of that field and no existing call site changes (§3.2 consequence 4). I-10 rests on `process.env` being immutable after boot; any code introducing a runtime mutation voids I-10, `BUDGET_ZERO` and `READY` together. |
| **I-11** | `reservedToday` counts **today's UTC `usageDate` only**, where the date is derived by `enrichmentQuotaService.utcUsageDate(now)`, computed **once**, published byte-identically to the value used in the `WHERE` clause, and **never** read from a query parameter, header, or body. |
| **I-12** | `dailyBudget: null` means unlimited and is never coerced to a number; `remaining: null` likewise. `0` and `null` are never collapsed. `remaining` is an upper bound and is clamped at `0`. |
| **I-13** | Every one of the six `KNOWN_PROVIDERS` is always represented in the response, in `KNOWN_PROVIDERS` order. Absence is never used to convey a state. |
| **I-14** | Only `execute:enrichment-batch` grants access to budget, usage, worker state, and readiness. The coarse credential-configured status on `read:dashboard` is unchanged in shape, gating, and audience. |
| **I-15** | Defaults fail closed. Specifically: an absent usage bucket yields `0` **only** under I-11's date binding; a malformed context or unknown provider **throws** (§8.3) rather than resolving; and no path yields `READY` for a provider or lane that cannot execute. |
| **I-16** | No module inside the `enrichmentOrchestration` package other than `enrichmentOrchestrationConfig.js` names a provider credential environment variable. This is the existing package-scoped gate and it must continue to pass **unchanged**. |
| **I-17** | `IOC_ENRICHMENT_PROVIDER` is not an input to readiness. The operability surface describes the Phase-10 orchestration path only, and says so on screen. |

---

## 15. Test / evidence contract

Smallest suite that proves the seventeen invariants. Guarantees, not counts.

**Pure unit — `enrichmentProviderReadiness.test.js`** *(proves I-04, I-05, I-08, I-15)*
Table-driven over the precedence ladder: each of the seven values reached; each precedence boundary
asserted in both directions (`NOT_CONFIGURED` beats `EXECUTION_PAUSED` beats
`AUTOMATIC_INGESTION_DISABLED` beats `BUDGET_ZERO` beats `BUDGET_EXHAUSTED`);
**`AUTOMATIC_INGESTION_DISABLED` fires on the AUTOMATIC lane and never on MANUAL, with a fully
configured, funded, worker-active deployment** — the v1 defect, asserted directly; `nvd` is
`DELEGATED_BATCH_REQUIRED` under every configuration; `dailyBudget: null` never yields `BUDGET_ZERO`
or `BUDGET_EXHAUSTED`; `reservedToday === dailyBudget` is `BUDGET_EXHAUSTED` and `dailyBudget - 1` is
`READY` (boundary); **step 0 throws** for an unknown provider, a non-boolean flag, and an `undefined`
budget; **set equality between the vocabulary and the precedence array**, the same guard
`SUMMARY_STATUS_PRECEDENCE` already carries.

**Configuration — `enrichmentOrchestrationConfig.test.js` (extended)** *(proves I-01, I-16)*
`missingProviderCredentialVariables` returns names for each unconfigured provider, `[]` when
configured, `[]` for `nvd` always; every returned name is present in `.env.example`; **red-check**
that a value planted in the config never appears in the output.

**Service — `enrichmentUsageService.test.js` (extended)** *(proves I-03, I-10, I-11, I-12, I-13)*
Two days of usage rows present ⇒ `reservedToday` is **today's**, not the oldest — this test must be
**red-checked against the current implementation** and confirmed to fail, or it does not prove the
fix. A **round-trip** test: a row written by `reserveProviderQuota` is read back by `getProviderUsage`
in the same process, so the two date derivations are proven identical rather than two hand-built
dates being wrong together. `reservationsActive` and `executionState` track `ENRICHMENT_WORKER_ENABLED`
in both directions; all six providers always present, in order; `null` budgets survive as `null` in
both `dailyBudget` and `remaining`; `reservedToday > dailyBudget` clamps `remaining` to `0`;
`usageDate` serializes as `YYYY-MM-DD`; no Prisma write method is invoked (assert on a client whose
write methods throw); a `usageDate` supplied in a request-shaped input is ignored.

**No-secret serialization — `phase10c3NoSecretSerialization.test.js` (new)** *(proves I-01, I-02, I-05, I-10)*
Build the full response with **every** provider credential **plus `JWT_SECRET` and `DATABASE_URL`**
set to distinctive sentinels; assert no sentinel, and no substring of one of length ≥ 4, appears
anywhere in `JSON.stringify(response)`. Assert every string leaf is a member of a closed vocabulary,
a known variable name, or a known provider/subject/path identifier — **with exactly two named
exemptions, `note` and `usageDate`**, which are fixed screen prose and a formatted date respectively.
The existing package-scoped credential gate
(`enrichmentOrchestrationInertness.test.js:270-286`) must still pass **unchanged**; both new/touched
modules sit inside the scanned package and neither names a variable.

**Route authorization — `phase10c3UsageRouteAuthorization.test.js` (new, real HTTP, Prisma stubbed)**
*(proves I-14)*
ADMIN `200`; ANALYST, REVIEWER, VIEWER each `403` **with no configuration-derived field in the body**;
unauthenticated `401`; asserts no new route was mounted and the existing guard is unchanged.

**Frontend component — `Settings.test.jsx`** *(proves I-04, I-14, I-17 at the UX layer)*
Section renders for a session advertising `execute:enrichment-batch` and is **absent** otherwise;
readiness labels come from the screen's own dictionary, never from server text; a server-supplied
readiness value outside the closed set renders a safe fallback rather than raw text; the
deployment-owned/restart-required line and the §3.4 path-boundary `ScopeNote` are both present; no
input, form, or mutating control exists anywhere in the section.

**Browser evidence (Playwright, real stack)** *(proves the operator can actually answer §5)*
Signed in as ADMIN against a stack with **all provider keys empty** — the true state of every
ThreatNeXus environment — the section renders six providers, each `NOT_CONFIGURED` (except `nvd`,
`DELEGATED_BATCH_REQUIRED`), each naming its missing variable; **the path-boundary note is asserted
present**; zero console errors **and** warnings; no request to any provider host on the wire. Signed
in as ANALYST, the section is absent and no request to `/api/enrichment/usage` leaves the browser.

**Environment / CI** *(proves I-09)*
Existing CI defaults (every provider key `''`, `AI_ENABLED=false`, both switches false) require **no**
change; a test asserts the endpoint answers truthfully under exactly those defaults. CI's existing
secret scans must stay clean.

**Regression gate at closure:** backend full suite at its current baseline with zero regressions
(including the two files listed in §13); `prisma validate` + `migrate diff --exit-code` proving **no
schema change**; frontend lint, unit, production build; the full Chromium suite; `git diff --stat`
against `3f5c7ea` showing an empty diff under `backend/prisma/`.

**Not required here:** any live provider call, any real quota spend, any go-live proof. Those belong
to 10C-4.

---

## 16. Exclusions

Out of scope for 10C-3, in addition to §1's refusals:

live provider lookups · enabling the production worker · deployment or go-live · provider
response-body hardening · retry redesign · concurrency redesign · any change to atomic attempt
reservation · analyst `force` behaviour · secret rotation · cloud secret-manager integration ·
automatic secret discovery · billing or currency semantics · provider subscription purchasing ·
`RETRY_WAIT` cleanup · retirement of the legacy synchronous direct-provider routes or the legacy
`/api/threats/upload` surface · unifying the legacy `IOC_ENRICHMENT_PROVIDER` selector with the
Phase-10 path (§3.4 documents the boundary; merging them is a separate decision) · 10C-4 · 10C-5 ·
Phase 11 · any unrelated polish.

The `SKIPPED_DISABLED` / `PROVIDER_DISABLED` / `EXECUTION_DISABLED` vocabulary members stay as they
are. This ticket does not make them reachable from a deployment switch (§3.4).

---

## 17. Escalation / split decision

**One ticket. No split.** (§4.)

**Codex independent review: not invoked.** `TEAM-WORKFLOW.md` makes cross-provider review
exception-based — auth/authz, security boundaries, transaction and data integrity, concurrency,
destructive migrations, major architecture, infrastructure/deployment, go-live. The chosen design
introduces **none** of the triggers this ticket's own routing policy names: no application-managed
secret storage, no new admin write API, no persisted budget/spend authority, no migration carrying
configuration authority, and no provider-activation mutation. It is a read-only derivation over
configuration that already exists, behind a guard that already exists, on a route that already
exists. Both matched internal specialists independently reached the same conclusion on this point,
and the risk that was actually present — design correctness of a derivation ladder — is precisely
what they caught (§18). Manufacturing a third review would not have surfaced a different class of
finding.

**Void conditions.** This decision is void, and a bounded Codex read-only contract review becomes
mandatory before READY, if implementation introduces any of: application-managed secret storage; a
new admin write API; persisted budget or spend authority; a migration carrying configuration
authority; provider-activation mutation; **or a readiness value whose input is anything other than
the five now named in §8.2** (`credentialConfigured`, `workerEnabled`, `automaticIngestionEnabled`,
`dailyBudget`, `reservedToday`) — because widening the ladder's input set is what produced the
v1 defect.

---

## 18. Review record

Two matched read-only specialists, dispatched against contract v1 at base `3f5c7ea` with the ticket
objective, grounded source list, invariants and exclusions. No product code existed; both reviewed
contract text against repository source.

| Reviewer | Verdict on v1 | Findings |
|---|---|---|
| `security-reviewer` | NOT SAFE TO FREEZE | 3 × P1, 5 × P2, 2 × P3, **0 × P0** |
| `backend-logic-reviewer` | CONTRACT NOT SOUND | 4 × P1, 4 × P2, 2 × P3 |

Both independently confirmed defects **A** and **B** against source, and both independently
identified the same top defect. Every P1 and P2 is dispositioned below; none was deferred.

| Finding | Disposition in v2 |
|---|---|
| **P1 (both, independently) — `READY` incomplete on the AUTOMATIC lane.** With `AUTO_ENRICHMENT_ENABLED=false` — the shipped default — plus credential, worker and budget, v1 returned `READY` for a lane on which no job can ever exist, then handed the operator a separate top-level field to AND in themselves. Exactly the defect §1 says the ticket exists to remove. | **Accepted in full.** Seventh value `AUTOMATIC_INGESTION_DISABLED` added (§8.1), ladder step 4 added (§8.2), `AUTO_ENRICHMENT_ENABLED` added to §3.5's conjunction, I-08 and §15's boundary test updated. §8.2's "complete answer" claim is now true rather than deleted. |
| **P1 (security) — `usageDate` derivation unbound; fails OPEN to `READY`.** An unmatched date matches zero rows ⇒ `reservedToday: 0` ⇒ an exhausted provider reports `READY`. §7 ("absent bucket ⇒ 0, a true measurement") and I-15 ("absent bucket ⇒ most restrictive") specified opposite behaviour for the same input. | **Accepted in full.** §7 binds the derivation to `enrichmentQuotaService.utcUsageDate(now)` by name, requires it computed once and published byte-identically, and reconciles the §7/I-15 collision explicitly. I-11 rewritten. §15 now requires a **round-trip** test rather than two hand-built dates. |
| **P1 (security) — the new section would contradict the panel above it.** `IOC_ENRICHMENT_PROVIDER` (default `mock`) is a second activation authority for the legacy IOC path and is what the existing `read:dashboard` panel reports; Phase 10 ignores it. A keyed deployment would show "Mock provider" and "abuseipdb — READY" adjacently. | **Accepted in full.** §3.4 rewritten to record both authorities and the boundary; §13 requires a `ScopeNote` on the new section; §15 adds a browser assertion; **I-17** added; §16 records that unifying the two paths is a separate decision. |
| **P1 (backend) — §13 omitted the tests fixes A and C break.** Four assertions across two files, while §15 demanded zero regressions and §13 declared anything unlisted to be scope creep. | **Accepted in full.** Both files listed in §13 with their exact line citations and the reason each breaks, including the `env: {}` raw-map seam that I-10 changes. Independently verified against source before acceptance. |
| **P1 (backend) — I-10 creates a second derivation of `executionState`, and rests on an unstated premise.** `enrichmentRunReadService.js:54` already derives that field from the live parse; §8.5 added a field of the same name from the frozen object. | **Accepted in full.** §13 adds `enrichmentRunReadService.js` as a one-line source change so both callers share `resolveExecutionState` on the frozen object — which also corrects a pre-existing latent inaccuracy, since `server.js:18` gates the worker `require` on the boot value. §3.2 now states the `process.env`-immutability premise and the `BUDGET_ZERO`-vs-routing-parse nuance as numbered consequences. |
| **P2 (security) — I-10 widens the secret blast radius.** `config/env` carries `JWT_SECRET`, `DATABASE_URL` and six credentials into a module that serializes to HTTP; §15's sentinel covered only provider keys. | **Accepted.** I-10 gains a mandatory narrowing projection at the module boundary (§13); §6 states the exposure and its closure; §15's sentinel extended to `JWT_SECRET` and `DATABASE_URL`. |
| **P2 (security) — I-16 and §3.1 overstated the static gate.** It is package-scoped, not repository-wide; §15's "extend the gate" task was a no-op. | **Accepted.** Verified directly at `enrichmentOrchestrationInertness.test.js:270-286`. §3.1 restates the gate accurately, I-16 narrowed to the package, §15 now requires the gate to pass **unchanged**, and §13 adds the `SECURITY.md:496-497`/`:571-572` correction. |
| **P2 (both) — schema constraint misnamed.** `@@id([provider, usageDate, lane])`, not `@@unique`; the composite PK leads on `provider` and does not serve a single-day scan — `@@index([usageDate, lane])` does. | **Accepted.** Corrected in §3.3 and §11. The "no migration" conclusion is unchanged and now correctly justified. |
| **P2 (backend) — `usageDate` wire format.** Prisma returns a `Date`; `JSON.stringify` emits a full ISO datetime, implying precision `@db.Date` does not carry. | **Accepted.** §8.5 requires explicit `YYYY-MM-DD` formatting; §15 asserts it. |
| **P2 (backend) — `remaining` presented as exact; clamp unjustified; midnight straddle unaddressed.** | **Accepted.** §7 states `remaining` is an upper bound, justifies the clamp against mid-day budget reduction, and requires the once-only `usageDate` computation. I-12 updated. |
| **P2 (backend) — §3.3 overstated input rejection** ("padded forms" — trim runs first, `/^\d+$/` accepts `"05"`). | **Accepted.** §3.3 restated precisely. |
| **P2 (security) — §9's `roles.js` quote inverted its meaning.** | **Accepted.** §9 now cites `enrichmentUsageRoutes.js:5-7`, the actual pre-existing decision, and records the misquote explicitly rather than silently dropping it. |
| **P2 (security) — `usageDate` left request-selectable.** §10 forbade only parameters influencing stored values; a reported date is neither. | **Accepted.** §10 and I-11 forbid populating it from any request input. |
| **P3 (security) — §15's "closed string leaf" assertion contradicts `note` and `usageDate`.** | **Accepted.** Both named as explicit exemptions in §15. |
| **P3 (backend) — single-process topology dependency of fix A.** | **Accepted.** Recorded in §3.5 so a split-process deployment cannot be introduced silently. |
| **P3 (backend) — `enrichmentOrchestrationConfig.js` is on the boot path.** | **Accepted.** Stated in §3.7 and constrained in §13. |
| **P3 (backend) — reported `BUDGET_ZERO` vs routing parse.** | **Accepted.** §3.2 consequence 3. |
| **Both — §17 (no Codex review) justified.** Security added a void-condition clause: re-review if the ladder gains a new input, since P1-1's fix adds one. | **Accepted.** §17's void conditions extended with the five-input clause. |

**Net effect on the design:** the chosen model (Outcome A, read-only, no migration, no new capability,
no mutation) survived both reviews unchanged. Every accepted finding corrected the *derivation* or the
*contract text*, not the architecture. The vocabulary grew from six values to seven; the invariant set
grew from sixteen to seventeen; the implementation surface grew by one one-line source change and two
test files.

### 18.1 Surgical re-check against v2 — one round, both reviewers

| Reviewer | Verdict on v2 | Result |
|---|---|---|
| `security-reviewer` | NOT SAFE TO FREEZE | **All 8 v1 findings CLOSED.** One **new P1**, introduced by v2. |
| `backend-logic-reviewer` | CONTRACT NOT SOUND | Items 1, 2, 3, 5 **CLOSED**. Item 4's amendment **factually wrong** — same new P1. |

Both explicitly accepted the `TypeError` in §8.3 over their originally-proposed refusal value, on the
`routeTarget` precedent. The backend reviewer additionally confirmed that
`enrichmentOrchestrationController.js:212-214` already catches into `serverError`, so the throw fails
the request closed rather than crashing the process.

**New P1 (found independently by both) — v2's `enrichmentRunReadService.js` amendment was wrong.**
v2 described it as a "one-line source change". It is not: `resolveExecutionState` is **exported**
(`enrichmentRunReadService.js:159`) with three production call sites outside that file, all passing
`process.env` explicitly — `enrichmentOrchestrationController.js:134`, `:170`, and
`enrichmentSummaryReadService.js:411`. The last of these is the **analyst-visible** Finding
enrichment summary and appeared nowhere in v2's §13, neither as a touched file nor as an untouched
one. Changing the parameter's meaning to "resolved config" while leaving any call site passing
`process.env` returns `ACTIVE` on a default deployment, because `"false"` is a truthy string — a
**fail-open on the exact field that exists to stop a recorded request being read as an executed
one**, and the same defect class as v1's P1-2. Two unit assertions
(`enrichmentRunServices.test.js:255`, `:259`) pass raw maps with string values and would also break.

**Disposition — accepted, and corrected by removal rather than by expansion (v3).** Every citation
was independently verified against source before acceptance. Rather than change the signature and
chase three call sites plus two tests (both reviewers' proposed minimal correction), the usage
endpoint now **calls the existing exported `resolveExecutionState(process.env)` unmodified**. This
achieves v2's actual goal — one derivation of `executionState` in the system — with a strictly
smaller surface: no signature change, no call-site changes, no new test breakage, and no extension
of I-10's secret-adjacent reach to an ANALYST-visible module. §3.2 gains consequence 4, I-10 gains
an explicit narrow exemption, §13 moves the three files to "Explicitly untouched", and §8.5 records
that `executionState` is a new *field* with an existing *derivation*.

**This v3 correction is itself unreviewed.** It was made after the single permitted re-check round
and is the only open item at §19.

---

## 19. Status — **READY**

**Both the design and the document are cleared to freeze.**

Everything material is closed. The architecture (Outcome A: read-only, environment-owned, no
migration, no new capability, no mutation) survived two independent reviews and one re-check
unchanged. Every finding across both rounds — 7 P1, 9 P2, 4 P3 — is dispositioned in §18, none
deferred.

**The one open item — the unreviewed v3 correction in §3.2 consequence 4 — is now closed.** A
third, narrowly bounded closure check (`backend-logic-reviewer`, read-only, scoped to exactly this
correction and nothing else) independently verified all three points against source:

1. `resolveExecutionState(source)` (`enrichmentRunReadService.js:53-61`) keeps its existing
   signature — a raw environment-shaped object, defaulting to `process.env` — and all three
   production call sites remain unmodified and valid:
   `enrichmentOrchestrationController.js:134` and `:170`, and
   `enrichmentSummaryReadService.js:411` (the analyst-visible Finding summary). No fourth call site
   exists yet because the new usage-endpoint handler is pre-implementation, consistent with the
   contract adding a new caller of the existing function rather than a new derivation.
2. The I-10 `executionState` exemption introduces no new inconsistency: the function returns only
   one of the two closed `EXECUTION_STATES` values, never a value that can carry a secret; it is a
   field distinct from the closed readiness vocabulary in §8, never conflated with or able to
   override it; and `enrichmentSummaryReadService.js` is untouched by this ticket, so nothing about
   the Finding summary's existing behavior changes.
3. No breakage beyond §13's declared list. The two assertions at
   `enrichmentRunServices.test.js:255,259` pass raw objects directly to the untouched function and
   remain correct — they were never part of the I-10 seam change, which affects only
   `getProviderUsage`'s separate `env` parameter. No other file imports or asserts on
   `resolveExecutionState`.

**Verdict: READY.** No P0/P1 remains. The design checkpoint below reflects contract v3 exactly as
written, with no further architectural change.
