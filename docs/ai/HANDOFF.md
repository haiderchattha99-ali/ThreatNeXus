# Handoff: TNX-P10C4-CONTROLLED-LIVE-ENRICHMENT-GO-LIVE

- From: claude
- Branch: `feat/phase-10c4-controlled-live-enrichment`
- Worktree: `F:\AI-Worktrees\ThreatNeXus\phase-10c4`
- Base: `origin/main` @ `0f81835` (merge of PR #25, TNX-P10C3)
- Updated: 2026-08-17
- Status: **design_frozen** — Tier 3 design/contract gate, verdict **READY**

**Nothing was implemented. No provider was contacted. No secret was read, printed, or requested.
10C-5 was not started.** Four documentation files changed; zero product code.

- Contract: `docs/ai/PHASE-10C4-CONTROLLED-LIVE-ENRICHMENT-CONTRACT.md` (**revision 2**, frozen)
- Decision: `D-P10C4-01`

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

## Next action

**STOP.** Awaiting the user's decision to open the **implementation boundary**, whose scope is fixed
by contract §14:

- `backend/src/scripts/enrichmentCanaryPreflight.js` (new, read-only, implements P1–P17, makes no
  provider call, composes the existing resolvers rather than reimplementing them)
- one `package.json` script entry (`preflight:canary`) — **never** wired into CI or `npm test`
- `backend/tests/unit/enrichmentCanaryPreflight.test.js` red-checking each assertion, especially P5
  (blank/`null`/`"unlimited"` must FAIL) and P4 (a correct environment must PASS)
- `docs/OPERATIONS_RUNBOOK.md` and `docs/PROVIDER_GUIDE.md` additions

No product code in the execution path. Zero schema change.

**The live canary itself is a LATER, separate, operator-executed boundary** — not part of the
implementation ticket.

Do not implement. Do not contact any provider. Do not start 10C-5.
