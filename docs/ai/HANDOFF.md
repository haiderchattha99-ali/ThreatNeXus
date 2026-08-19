# Handoff: TNX-FINAL-DEMO-DOC-EVIDENCE

- From: claude
- Suggested next writer: unassigned — closure complete, PR open
- Branch: `docs/final-demo-evidence` (from `origin/main` @ `2bda0e5`)
- Worktree: `F:\AI-Worktrees\ThreatNeXus\final-demo-doc-evidence` (isolated — the primary checkout was never touched)
- Writer lock: **released**
- Updated: 2026-08-19
- Status: **demo_ready** — demonstration database reset, non-contact preflight **DEMO READY (16/16)**, execution posture back to default-off.

> Note for any future writer: `handoff-task.ps1` overwrites this file with a five-line template on
> every run. If you run it, restore the detail below from the prior commit afterwards — the template
> alone loses the root cause, the evidence and the traps.

No independent reviewer, Codex pass, or second polish cycle was requested or performed. This was a
bounded closure.

---

## What this closed

A rehearsed Finding answered the analyst's first *Request enrichment* click with
**"Skipped — a fresh result already exists."** Correct production behaviour; unacceptable as the
opening state of an official demonstration.

**The fix was never to weaken freshness.** It was to make the demonstration environment
deterministic and to add a check that refuses to let an operator walk into the room on a rehearsed
database.

## The three facts that shaped it

1. **Ingestion is what contaminated the Findings.** `seed:demo` ingests through the real pipeline,
   and `reportIngestionService` schedules AUTOMATIC-lane enrichment when `AUTO_ENRICHMENT_ENABLED`
   is true. The rehearsal ran with it on, so all 11 seeded Findings acquired INGESTION-trigger runs.
   That is why `demo:reset` **refuses** (guard G5) while automatic enrichment is on — a reset in
   that posture re-creates, during the seed itself, exactly what it exists to clear.
2. **Freshness is keyed on the SUBJECT, not the Finding.**
   `findFreshJobForSubject(provider, subjectType, subjectValue)`. So the preflight checks every
   (demo provider × demo subject) pair, and it calls *that* function rather than defining freshness
   a second time — a preflight with its own idea of freshness could pass while the product skips.
3. **A blank `*_MANUAL_DAILY_BUDGET` means UNLIMITED, not zero**
   (`DEFAULT_MANUAL_DAILY_BUDGET = null`), and every analyst-triggered run is MANUAL lane. Preflight
   **S4** therefore fails on a blank budget, not just a large one.

## The AbuseIPDB question, resolved from evidence

**Mock output is NOT being persisted under a provider label.** The stored `IocEnrichment` row for
`192.0.2.40` carried `usageType="Reserved"`, `isWhitelisted=true`, `totalReports=5`,
`lastReportedAt=2026-07-24`. `mockIocEnrichmentProvider` always writes `usageType: null` /
`isWhitelisted: false` and uses `totalReports` of 0/2/20/150 — never 5. Only the real API knows that
range is reserved. Structurally, too: `enrichmentRunner` resolves from `record.provider`,
`enrichmentBatchController` from `job.provider`, and `enrichmentRuntime` explicitly forbids a mock
fallback.

**The real defect was the inverse, and it is fixed.** `operationalOverviewService` read the vestigial
`IOC_ENRICHMENT_PROVIDER` (default `"mock"`) and reported `MOCK_PROVIDER` — rendered as "Mock
provider" by `Settings.jsx` — while a configured deployment contacted the real AbuseIPDB API and
spent its quota. **No execution path in this repository reads that variable.** The panel now reports
what the execution path actually asks.

**Red-checked:** both regression assertions fail against the old code with
`expected 'MOCK_PROVIDER' to be 'CONFIGURED'`.

## Demonstration set

| | |
|---|---|
| Primary **A** | Finding `7` — `203.0.113.11`, 3389/TCP |
| Backup **B** | Finding `5` — `198.51.100.21` |
| Backup **C** | Finding `8` — `203.0.113.12` |
| Providers | **Censys**, **Netlas**, **GreyNoise** |
| Excluded | **Shodan** (credential returned 403 `INVALID_KEY` — external readiness, not a product defect), **AbuseIPDB** (keeps the delegated lane inert), **NVD** (no qualifying CVE exists) |

**Zero `Vulnerability` and zero `FindingVulnerability` rows exist in the deterministic dataset**, so
no CVE-bearing Finding is available. No CVE association was fabricated; the honest S8 talking point
is used instead.

## Rehearsal

One bounded rehearsal covering **S1–S11 plus fresh-result prevention**. All passed. **6 real
external provider contacts** (censys 1, netlas 2, greynoise 3).

**One unintended contact is recorded honestly.** The first S10 outage attempt set `NETLAS_BASE_URL`
via `--env-file`, which only supplies compose *substitution* variables and does not inject them into
the container — so that attempt reached the real Netlas API instead of the intended unreachable
endpoint. `docker-compose.yml` now forwards provider base URLs explicitly, and the retry produced
the intended `FAILED` / `TIMEOUT` with no HTTP status.

## Post-rehearsal reset — the hard gate

Reset again, then preflight: **16/16, DEMO READY**. Verified in PostgreSQL that
`FindingEnrichmentRun`, `FindingEnrichmentRunItem`, `ProviderLookupJob`, `ProviderLookupAttempt`,
`ProviderDailyUsage` and every provider table are at **zero**, and that A/B/C are untouched.

`IocEnrichment` legitimately holds **11 PENDING** `abuseipdb` rows — ingestion enqueues one per
indicator regardless of `AUTO_ENRICHMENT_ENABLED`. Nothing drains that queue automatically,
`queriedAt` is null on every one (no contact), the credential is blank and its budgets are 0.
Preflight **S7** enforces the credential's absence.

## Default-off restored

Restarted with `ENRICHMENT_WORKER_ENABLED=false`, confirmed by the **absence of the worker-started
line in the new container's own logs** — a positive process-level check. (Per the 10C-4 contract the
absence of a `stopped` audit row is explicitly *not* accepted as evidence, since that
fire-and-forget write can fail silently.)

The disposable stack is left up with the **verified DEMO READY data state** and **execution
default-off**. Before presenting: flip the worker on, re-run `demo:preflight`, confirm `DEMO READY`.

## Traps worth carrying forward

- **`--env-file` is compose substitution only.** A variable not named in the service's
  `environment:` block never reaches the container. This silently cost one real provider call.
- **`docker exec` needs `MSYS_NO_PATHCONV=1`** in Git Bash, or `/app/x.js` becomes `F:/Git/app/x.js`.
- **A FAILED lookup gets a ~5 minute freshness window**, not the 24 h a success gets — so a failed
  provider can simply be retried shortly after, or forced with a justification.
- **`contactedProvider=true` means contact was *initiated*,** not that a provider answered. The
  timeout row carries it with no HTTP status.
- **`isProviderCredentialConfigured('nvd')` is unconditionally true**, so an NVD credential
  assertion is vacuous. Excluded from P2 on purpose.
- **`EXECUTION_PAUSED` is evaluated before any budget state** and masks
  `BUDGET_ZERO`/`BUDGET_EXHAUSTED`, which is why S4 reads budgets directly rather than inferring
  them from readiness.
- **The legacy path's only unique signature is a `<provider>.lookup.*` audit action.** A
  provider-table row count proves nothing, because the orchestration path writes those same tables.

## Where the evidence lives

| | |
|---|---|
| Operator runbook | `docs/demo/DEMO-READINESS.md` |
| Rehearsal, S1–S11, contact count | `docs/evidence/DEMO-REHEARSAL-EVIDENCE.md` |
| Phase-10C4 canary (rescued from `914d582`, not re-run) | `docs/evidence/CONTROLLED-LIVE-CANARY.md` |
| Shadowserver / Rapid7 chronology | `docs/evidence/EXTERNAL-DATA-ACCESS.md` |
| M1–M10 sizing, every figure classified | `docs/evidence/PRODUCTION-SIZING.md` |
| Final screenshots | `docs/evidence/screenshots/` |

## Next

**MASTER OFFICIAL SYSTEM & HANDOVER DOCUMENT.** Not started — deliberately out of scope here, along
with the README rewrite and the Playbook/Handbook drafting.

**CI: green on the first push**, at the exact PR tip `2612cbc` —
[run 32239329856](https://github.com/haiderchattha99-ali/ThreatNeXus/actions/runs/32239329856)
(push) and
[run 32239427198](https://github.com/haiderchattha99-ali/ThreatNeXus/actions/runs/32239427198)
(pull_request). All six required jobs succeeded on both: Secrets and generated artifacts, Prisma
schema and migration history, Backend tests, Frontend lint/tests/build, Browser suite (Chromium),
Core evaluators. "Mutation and concurrency gates" is manual-trigger-only and correctly skipped.

PR: <https://github.com/haiderchattha99-ali/ThreatNeXus/pull/32> — **open, not merged.**

## Post-CI re-verification (no provider call)

Re-run after CI went green, to confirm the demonstration state survived the rehearsal and the
rollback rather than assuming it did.

`demo:preflight`, executed inside the **serving** demonstration container, returned **14/16 —
DEMO NOT READY**. That is the **correct** result for the state the stack is deliberately left in,
and it reproduces recorded scenario **S7a** character for character:

| | |
|---|---|
| **S3** | `ENRICHMENT_WORKER_ENABLED=false, expected=true` |
| **P3** | `censys=EXECUTION_PAUSED, netlas=EXECUTION_PAUSED, greynoise=EXECUTION_PAUSED` |

Both are consequences of the *single* variable that §10 rollback step 1 turns off. There is no way
to reach 16/16 with the worker off — `DEMO_EXPECT_WORKER=false` would satisfy S3, but P3 still
resolves `EXECUTION_PAUSED`, because readiness evaluates the worker before any budget state.

**Every data gate passed**, which is what actually had to be proved:

- **B1–B4** — disposable `threatnexus_demo`, 25/25 migrations applied, Findings `[5,7,8]` present
- **D1** — `FindingEnrichmentRun` rows on the demo Findings: **0**
- **D2** — no fresh provider result for any (demo provider × demo subject); the first click cannot
  be answered "a fresh result already exists"
- **S1, S2, S4, S5, S6, S7** — automatic enrichment off, automatic budgets 0, manual budgets
  explicit at 3, **0** legacy `<provider>.lookup.*` audit rows, no live-smoke opt-in, excluded
  providers uncredentialed

Confirmed independently in PostgreSQL: `FindingEnrichmentRun` **0**, `ProviderLookupJob` **0**,
`ProviderLookupAttempt` **0**, `ProviderDailyUsage` **0**, `Finding` **11**,
`Vulnerability` **0**. The demonstration dataset is reset and untouched.

**No provider was contacted by this verification.** `demo:preflight` imports no provider, adapter
or execution-service module, and the worker was never started.

To present: bring the stack up with the §1 demonstration profile
(`ENRICHMENT_WORKER_ENABLED=true`), re-run `demo:preflight`, and require **DEMO READY**.
