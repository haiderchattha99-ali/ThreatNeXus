# Handoff: TNX-P10C4-CONTROLLED-LIVE-ENRICHMENT-GO-LIVE

- From: claude
- Branch: `feat/phase-10c4-controlled-live-enrichment`
- Worktree: `F:\AI-Worktrees\ThreatNeXus\phase-10c4`
- Base: `origin/main` @ `0f81835` (merge of PR #25, TNX-P10C3)
- Updated: 2026-08-17
- Status: **pre_live_ready** — Tier 3. Implementation checkpoint `3bb2004` independently re-verified, its
  own implementation-delta review is closed (0 P0/P1), and a real disposable-stack dry run proved the
  environment fails closed for the correct reason. **READY FOR HUMAN CANARY AUTHORIZATION.**

**The design/contract gate below (design_frozen, verdict READY) is unchanged and still authoritative.
The IMPLEMENTATION checkpoint (`3bb2004`: the P1-P17 preflight script, its unit tests, one
package.json entry, and the two operator docs contract §14 specified) is unchanged from the prior
update. This update adds the PRE-LIVE gate on top of both: one bounded read-only implementation-delta
review, and a real (non-live) dry run of the preflight against a genuinely disposable local stack.
No provider was contacted. No secret was read, printed, or requested. No worker was enabled. 10C-5 was
not started. The live canary (§13, C1-C10) was NOT executed — it remains a later, separate,
human-operator-authorized boundary.**

- Contract: `docs/ai/PHASE-10C4-CONTROLLED-LIVE-ENRICHMENT-CONTRACT.md` (**revision 2**, frozen)
- Decision: `D-P10C4-01`

## Pre-live readiness (this update)

**Implementation-delta review — CLEAR.** One `security-reviewer` pass (not the full 3-reviewer
contract panel — TEAM-WORKFLOW.md's review contract calls for one specialist matched to the changed
surface at this boundary) read `c92cf86..3bb2004` in full against the 12 binding safety questions
(provider/network contact, state mutation, secret leakage, budget correctness, NVD exemption,
worker-environment binding, legacy-route honesty). **Verdict: 0 P0, 0 P1.** Two non-blocking P2 notes
are recorded in `STATE.yaml`'s `known_issues`.

**Dry run — fails closed for the right reason.** Stood up an isolated, disposable Docker Compose stack
(`tnx-p10c4-canary` project, Postgres on host port 15432, database `threatnexus_canary`), applied the
real migrations, seeded exactly one `Finding` (`1.1.1.1`), and ran the real `npm run preflight:canary`
**inside the backend container** with every contract-approved bound set (`GREYNOISE_MANUAL_DAILY_BUDGET=1`,
every other budget `0`, batch size `1`, worker and AUTOMATIC lane off) **except** `GREYNOISE_API_KEY`,
left deliberately unset. Result: **15/17 PASS**, only **P3** (credential not configured) and **P12**
(readiness resolves to `NOT_CONFIGURED`, not even reaching `EXECUTION_PAUSED`) fail — exactly the
expected, closed reason. A direct post-run query confirmed zero rows in `ProviderLookupJob`,
`ProviderLookupAttempt`, `ProviderDailyUsage`, `GreyNoiseEnrichment`, and `AuditLog`. The stack was
torn down with `docker compose down -v` and confirmed removed.

**No credential was requested, read, printed, or committed at any point.** The Compose overlay used
for the dry run lives only in the session scratchpad, never in the repository.

## What this gate decided

**Go-live is defined narrowly and bindingly:** one operator-authorized, MANUAL-lane enrichment run,
one provider, one benign subject, a budget of **exactly one reservation**, in a **disposable local
stack**, with durable ledger evidence and a verified return to default-off. Not a deployment, not a
continuously-running worker, not AUTOMATIC-lane execution.

**Provider: `greynoise` only.** Free Community API, one `GET`, one header, `404 → NOT_FOUND` as a
first-class answer. It is a DIRECT provider, so one canary exercises the whole shared **direct-lane**
path. `shodan`/`netlas`/`censys` excluded as paid or credential-complex with no extra coverage;
`abuseipdb` excluded because it is the *delegated* lane and deliberately not the first canary; `nvd`
is structurally `DELEGATED_BATCH_REQUIRED` and can never be a direct canary.

**Subject: `1.1.1.1`** — reusing the already-approved in-repo Phase-8D smoke subject rather than
introducing new third-party exposure.

**10C-5 does not block 10C-4**, and 10C-4 does not close it. It remains required before any
unattended/production enablement, batch size > 1, or any provider with large responses.

## The three facts that shaped the design

1. **A blank `*_MANUAL_DAILY_BUDGET` means UNLIMITED, not zero.** `DEFAULT_MANUAL_DAILY_BUDGET` is
   `null` (`enrichmentOrchestrationConfig.js:39-40`) and `reserveProviderQuota`'s `null` branch
   increments without ever refusing (`:227-232`). Every analyst-triggered run is MANUAL lane
   (`enrichmentRunService.js:701`). This is the entire reason the ticket has an implementation
   surface at all: a deterministic preflight that refuses unless the budget resolves to **exactly
   `1`**.
2. **The existing `npm run smoke:*` scripts prove the provider ADAPTER only.** They create no job,
   reserve no quota, write no attempt row, and never touch the worker. Closing *that* gap is the
   whole point of 10C-4.
3. **The legacy synchronous provider routes are an off-ledger contact path** — see below.

## The correction that matters most (contract §3.2)

`POST /api/findings/:id/enrichment/greynoise` (`greyNoiseEnrichmentRoutes.js:37-42` →
`greyNoiseExecutionService.js:168-171`) calls `provider.lookup()` **directly**: no
`ProviderLookupJob`, no `reserveProviderQuota`, no `ProviderLookupAttempt`, no `lookupWithBound`.
It never consults `ENRICHMENT_WORKER_ENABLED` and **goes live the moment the credential is set** —
i.e. for the whole canary window. Its only bound is `providerRateLimiter` (60 / 15 min).

Two binding consequences, now written into the contract:

- "Credential presence alone cannot cause provider contact" is **path-scoped to the Phase-10
  orchestration path, not system-wide** (invariant I-02).
- A `ProviderLookupAttempt` count is **not** a sufficient no-second-contact proof. Detection is by
  `GreyNoiseEnrichment` row count (both paths write it) **plus** the `greynoise.lookup.%` audit
  signature (legacy path only). Invariant I-13.

No frontend code calls these routes, so reaching one requires a deliberate hand-made authenticated
request. They are **disclosed and detected here, not fixed** — their disposition is unowned.

## Review

Three read-only Tier-3 reviewers COMPLETED: `security-reviewer`, `backend-logic-reviewer`, and
`software-architect` (carrying the independent-gate scope).

**Codex FAILED — usage limit, resets 2026-08-21.** `TEAM-WORKFLOW.md` routes go-live to an
independent-provider gate, so this gap is material and is recorded rather than closed. It was not
faked and not silently substituted. A Codex pass before implementation would be strictly additive:
no P0 was found, and every P1 is closed.

**0 P0 · 6 P1 raw / 4 distinct (all closed) · 16 P2 (all closed) · 6 P3 (all closed).**

Two revision-1 claims were outright **false** and are corrected in place rather than quietly
deleted:

- **Preflight P4 was unsatisfiable.** `isProviderCredentialConfigured('nvd')` returns `true`
  unconditionally (`enrichmentOrchestrationConfig.js:314-315`), so "every provider except greynoise
  is `false`" could never pass — the preflight would have refused every canary. `nvd` is now
  exempted explicitly and contained by a zero budget instead.
- **Preflight P12 proved nothing about the budget.** `EXECUTION_PAUSED` is returned at ladder step 3
  (`enrichmentProviderReadiness.js:148`) and **masks** `BUDGET_ZERO` and `BUDGET_EXHAUSTED` below
  it, so P12 returns the same value whether the budget is `1`, `0`, or blank/unlimited. Revision 1
  called it "the sharpest single assertion" and claimed it proved the worker switch was the only
  remaining gate. That property is now carried by an explicit conjunction of nine assertions.

Every reviewer finding was verified against source before being accepted.

## Implementation checkpoint (this update)

Writer lease: the previous lease (`49c3e199`, PID 24828/powershell) was found genuinely dead by
process-identity evidence (not lease age) and recovered through the canonical
`continue-task.ps1 -RecoverDeadLease` path. New lease `f9b02d0a`.

**Files added/changed, exactly matching contract §14's file surface:**

- `backend/src/scripts/enrichmentCanaryPreflight.js` — **new**. Read-only. Implements all
  seventeen P1–P17 assertions as a pure `evaluateCanaryPreflight({config, dbFacts, rawEnv, now})`
  function (no I/O), a `gatherDbFacts(prisma, {now})` composition layer for the four DB-dependent
  assertions, and a `require.main`-guarded CLI entrypoint that loads `../config/env` and
  `../config/prisma` — the same objects the worker itself would use. Imports no provider or
  execution-service module anywhere in the file. Makes no provider call, creates no job, reserves
  no quota, enables nothing.
- `backend/tests/unit/enrichmentCanaryPreflight.test.js` — **new**. 63 deterministic tests, no
  real database, no network. Every one of P1–P17 has a green case and at least one red case.
- `backend/package.json` — one new script entry, `"preflight:canary"`, alongside the existing
  `smoke:*` entries. Not referenced by `npm test` or any CI workflow.
- `docs/OPERATIONS_RUNBOOK.md` — new "Controlled live canary (Phase 10C-4)" subsection under the
  existing "Enrichment worker" section.
- `docs/PROVIDER_GUIDE.md` — new "Phase 10C-4 — which provider is approved for live proof" section.

**A convention this checkpoint had to establish, not merely apply:** contract v2's P15 says "the
database name carries the required disposable-canary prefix" but no such prefix is defined
anywhere else in the repository or the contract. This session defined it: the resolved
`DATABASE_URL`'s database name must contain the literal substring `canary` (e.g.
`threatnexus_canary`), documented as an operator naming convention in
`docs/OPERATIONS_RUNBOOK.md` — a sanity check, not a cryptographic guarantee. This did not require
touching execution-path code, schema, or any default, so it did not rise to a "STOP and report a
contradiction" per the implementation boundary — but a reviewer should look at it.

**One real defect found and fixed while red-checking P5's `"unlimited"` case:**
`resolveProviderReadiness` throws (by design) on a non-null/non-integer `dailyBudget` rather than
returning a refusal value. P12 was passing `manualDailyBudgets.greynoise` straight through, so a
malformed budget value crashed the whole preflight instead of failing closed. Fixed by coercing any
non-null/non-integer value to `null` before the P12 call — P5 still independently reports the real
defect; P12 now degrades to a clean FAIL instead of throwing.

**Focused validation, all green:**

- `npx vitest run tests/unit/enrichmentCanaryPreflight.test.js` — 63/63
- `npx vitest run tests/unit/enrichmentOrchestrationConfig.test.js tests/unit/enrichmentProviderReadiness.test.js tests/unit/enrichmentOrchestrationInertness.test.js` — 57/57, zero regression
- `npx prisma validate` — schema valid, zero schema/migration change
- `git diff --check` — clean

**Deliberately not run this checkpoint:** a live invocation of `npm run preflight:canary` against a
real disposable Postgres. `gatherDbFacts`'s four database queries are proven deterministically
against a fake Prisma double in the new suite instead; standing up the actual disposable stack and
running the script against it is step C1 of the later, separate, operator-executed live-canary
boundary — not part of authoring the preflight itself.

## Next action

**STOP.** This implementation checkpoint is complete. Remaining before the live canary (§13,
C1–C10) can open:

1. An independent review pass of this new preflight/test/docs surface — Codex remains unavailable
   (usage limit, resets 2026-08-21); an internal fallback reviewer per `TEAM-WORKFLOW.md` is the
   alternative, same substitution the design gate already made once.
2. A human operator's explicit decision to authorize the canary.
3. Standing up the disposable local stack per `docs/OPERATIONS_RUNBOOK.md` → "Controlled live
   canary (Phase 10C-4)", then running `npm run preflight:canary` **inside that stack's own backend
   container** before any credential is ever set.

Do not contact any provider. Do not enable the worker. Do not run the live canary. Do not start
10C-5.
