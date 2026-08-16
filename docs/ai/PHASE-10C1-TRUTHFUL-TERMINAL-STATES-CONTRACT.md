# TNX-P10C1-TRUTHFUL-TERMINAL-STATES — binding implementation contract (v4, gate-corrected)

**Ticket:** `TNX-P10C1-TRUTHFUL-TERMINAL-STATES`. **Tier:** 2.
**Approved base:** `13f7e24` (`origin/main`, PR #22 — Phase 10B).
**Review closure:** `backend-logic-reviewer`, read-only. First pass — NOT READY, 6×P1/0×P0. All six
closed in v3. A surgical re-check of v3 found exactly one remaining P1 (P1-1) and one non-blocking
P2; v4 closes both. Final narrow closure check on the v4 delta: **READY**. No Codex review; none
required for this design gate.
Stop boundary: `ground → implement + focused tests → STOP`.
Amends: `docs/ai/PHASE-10A1-API-CONTRACT.md` §4 (its own rule requires explicit approval plus a
`DECISIONS.md` entry — see `D-P10C1-01`).

## Objective

`GET /api/findings/:id/enrichment/summary` collapses materially different provider truths into
shared statuses and reports refusals without a cause. This ticket makes the persistent summary
layer as truthful as the run-item layer, so Phase 10B consumes corrected semantics instead of
re-deriving them in the browser.

## Defects, with evidence

All in `backend/src/services/enrichmentOrchestration/enrichmentSummaryReadService.js` unless noted.

1. **`statusForJobState`** (`:125-133`): `SUCCESSFUL_JOB_STATES = [SUCCEEDED, NO_RECORD]` →
   `COMPLETED`. "Returned data" and "was asked, has nothing on file" become one look.
2. **`IOC_STATUS_TO_SUMMARY`** (`:98-111`): `SUCCESS` and `NOT_FOUND` → `COMPLETED`. Same collapse
   on the delegated AbuseIPDB path.
3. **`evidenceAvailable`** (`:224`) is `status === COMPLETED && !isStale`, so a fresh nothing-on-file
   answer reports `evidenceAvailable: true` — claiming evidence exists when the provider said it
   has none.
4. **Skips carry no reason.** `resolveSubjectState` (`:218`) returns `skipReason: null` for an
   `ELIGIBLE` item whose job reached `SKIPPED_DISABLED` / `SKIPPED_NOT_CONFIGURED` /
   `SKIPPED_UNSUPPORTED_SUBJECT` / `SKIPPED_BUDGET` — **and** for the two IOC-derived skips
   `UNSUPPORTED_INDICATOR` / `SKIPPED_DISABLED` (`:106-107`). Six causes render as "Skipped, reason
   unknown". The module is *right* to refuse inventing a routing-time reason from a job state; the
   fix is distinct execution-time reasons.
5. **`UNAVAILABLE` collapses four failures, including a paid one.** `RATE_LIMITED` / `INVALID_KEY` /
   `TIMEOUT` / `FAILED` / `DEAD_LETTER` all → `UNAVAILABLE`.
   `enrichmentDirectExecutionService.js:293-308` terminalizes `AMBIGUOUS_AFTER_CONTACT` to
   `DEAD_LETTER` with `charged: true`; per `D-P10A2-04`/`D-P10A2-07` it is manual-review-only and
   never auto-retried. There are **five** write sites: `enrichmentWorker.js:123, :223, :233, :262`
   and `enrichmentTargetedIocService.js:233`.
6. **A terminal job can currently read `PENDING`** — worse than defect 5.
   `enrichmentTargetedIocService.js:229-241` dead-letters the Phase-10 job while deliberately
   leaving the delegate `IocEnrichment` row `PENDING`. `resolveSubjectState:188` prefers
   `job.iocEnrichment` unconditionally, so a terminally dead-lettered, charged, manual-review job
   reports `PENDING`. This affects the one paid provider.

## Required semantic distinctions

Separable **from the summary response alone**, without a second endpoint and without browser
inference — on `source: ORCHESTRATION_JOB` and `source: IOC_ENRICHMENT`:

positive result with evidence · queried, nothing on file · never requested · no valid subject ·
queued/in-flight · technical failure · provider rate limit · contacted-but-ambiguous (charged,
manual review) · policy skip with a layer-correct cause (disabled / not configured / budget /
subject mismatch) · stale vs fresh.

**Scope boundary (gate P1-1):** on `source: VULNERABILITY_ENRICHMENT`, `COMPLETED` means "the
vulnerability batch finished this CVE". `VulnerabilityEnrichmentJob.status` is a three-value enum
(`schema.prisma:1496-1500`); per-source outcomes live in `VulnerabilityProviderStatus`
(`:1522-1531`) on a table this service never reads, and are served by the existing vulnerability
read surface. Reaching them needs a repository addition plus a three-source roll-up — **out of
scope**, mirroring the module's own boundary statement at `enrichmentSummaryReadService.js:43-51`.

**`evidenceAvailable` for `VULNERABILITY_ENRICHMENT` (gate P1-1, surgical re-check):**
orchestration-job completion alone is not proof of positive evidence. This service does not read
`VulnerabilityProviderStatus` rows or their freshness horizon, so it cannot truthfully infer
retrievable evidence from `VulnerabilityEnrichmentJob.status` alone — a job can be `COMPLETED`
while every underlying provider result is `NOT_FOUND`. On `source: VULNERABILITY_ENRICHMENT`,
`evidenceAvailable` is **`false` from this summary layer**, unconditionally, unless a future change
deliberately widens the read surface to consume that data (which 10C-1 does not do). Do not infer
it from `COMPLETED`, from provider contact, or from `NOT_FOUND`. Per-source vulnerability outcomes
stay exclusively on the existing vulnerability read surface, unchanged by this ticket.

Status names are not prescribed; repository convention (closed `SUMMARY_STATUSES` + closed
`SKIP_REASONS`) governs.

## Binding invariants

1. **One status, one truth**, on `ORCHESTRATION_JOB` and `IOC_ENRICHMENT` sources. Every semantic
   above is separable from the summary response alone. `VULNERABILITY_ENRICHMENT` is bounded by the
   scope note and its meaning is stated explicitly rather than left implied.
2. **A terminal Phase-10 job state outranks a non-terminal delegate status.** The delegate is
   authoritative only while the job is non-terminal, or when both are terminal. Closes defect 6.
   **Provenance (gate P2, surgical re-check):** when the terminal job wins on that basis, `source`
   is reported as `ORCHESTRATION_JOB` — the source that actually won precedence. The outranked
   non-terminal delegate is never reported as `source`, even though its status lost the comparison.
3. **`evidenceAvailable` means retrievable evidence exists and is currently fresh.** False for a
   nothing-on-file answer at any freshness, false for every failure / rate-limit / ambiguous state,
   false for every skip, false when stale. Asserted at the **service layer** — the field is
   currently unread by the panel (`FindingEnrichmentPanel.jsx:82-91`), so the UI cannot prove it.
   `VULNERABILITY_ENRICHMENT` follows the narrower rule in the P1-1 scope-boundary paragraph above,
   not this general one — this layer does not read the data needed to prove it there.
4. **Unknown is never zero; absence is never failure; failure is never absence.** Any unclassified
   or future state resolves to a not-known status — never a success-shaped one.
5. **Post-contact ambiguity is separable** from ordinary failure, across all five write sites. On
   the swept delegated path the authority is `job.iocEnrichment.terminalReasonCode`, already a
   closed vocabulary (`iocEnrichmentCacheRules.js:82-104`).
6. **Every skipped row names its cause, at the correct layer.** No `skipReason: null` on a skipped
   row, including the two IOC-derived skips. **Four new execution-time codes** are minted — reuse
   would make three of them indistinguishable from their routing-time twins, which invariant 6
   forbids (see `enrichmentDecisionCodes.js:208-211`). They live in a **sibling frozen object**,
   not appended to `SKIP_REASONS`, because `isKnownSkipReason` (`:238-240`) also filters run items
   (`enrichmentRunReadService.js:77`) and appending would widen what a run item may serialize.
7. **No unfiltered string column is ever serialized.** Any public field derived from
   `ProviderLookupJob.terminalReasonCode` or `errorCode` — both `String?` with no orchestration-side
   validator (`schema.prisma:3386`) — passes through a closed vocabulary first, exactly as
   `isKnownSkipReason` filters `skipReason` at `enrichmentSummaryReadService.js:161`. Direct-path
   rate-limit separation derives from `errorCode === 'PROVIDER_RATE_LIMITED'` (shared verbatim by
   all five provider type modules); every other `errorCode` resolves to the generic failure status.
8. **`rollUp` ranks every value of `SUMMARY_STATUSES`**, and its fallback is the *most*-unsettled
   entry, not `statuses[0]` (`:338` currently fails open — an unranked status is silently
   overridden by any ranked one, including `COMPLETED`; `NO_SUBJECT` is already unranked). One test
   asserts `Object.values(SUMMARY_STATUSES)` and the precedence array are the same set. The
   pessimistic NVD roll-up is preserved: least-settled-first, provider-level `evidenceAvailable`
   only when *every* subject has it.
9. **The endpoint remains a pure read.** Zero provider calls, zero writes — no run, item, job,
   `ProviderLookupAttempt` or `ProviderDailyUsage` row, no quota reservation, no worker start. The
   static inertness gate (`enrichmentOrchestrationInertness.test.js:50`) and the behavioural
   no-write test pass unchanged.
10. **Bounded blast radius.** `SUCCESSFUL_JOB_STATES` / `FAILED_JOB_STATES` / `SKIPPED_JOB_STATES`
    are **not modified** — `recomputeRunState` (`enrichmentRunService.js:332-335`) consumes them,
    and removing `NO_RECORD` would flip a nothing-on-file run from `SUCCEEDED` to `FAILED` in the
    **persisted** `EnrichmentRun.state`. `statusForJobState` branches on `JOB_STATES.NO_RECORD`
    directly instead. No migration (no summary status is a Prisma enum; `skipReason` and
    `terminalReasonCode` are `String?`). No auth, provider-adapter, worker, quota, retry,
    concurrency, credential or Risk v1 change; no live provider call. The summary adds **no**
    `contacted` field and infers none — the run-item derivation at `enrichmentRunReadService.js:83`
    (`Boolean(item.lookupJob && item.lookupJob.queriedAt)`) is untouched. The response still never
    contains a job id, delegate id, `queryIdentityHash`, `requestScopeHash`, `idempotencyKey`,
    `activeLookupKey`, a claim token, a credential, or another Finding's subject. The 10B dictionary
    ships in the same change; the §4 amendment is recorded in `DECISIONS.md`.

## Folded-in P2 corrections

- **P2-2 (must):** `FindingEnrichmentPanel.jsx:125` gates the stale notice on
  `row.status === 'COMPLETED' && row.isStale`. Once nothing-on-file is its own status, a stale
  nothing-on-file row silently loses its staleness signal. Gate on `row.isStale` alone.
- **P2-3:** `findingEnrichment.js:55-56` labels `AUTOMATIC_BUDGET_ZERO` "budget is exhausted"; it
  means *configured to zero*, never attempted. Relabel "set to zero"; reserve "exhausted" for the
  execution-time code. Applied symmetrically to `MANUAL_BUDGET_ZERO`, the same defect on its sibling
  lane.
- **P3-1 (backlog, not this ticket):** `flattenProviderRows` drops `evidenceAvailable` for
  non-subject rows.
- **P2-4 (surgical re-check, non-blocking):** when a terminal Phase-10 job outranks a non-terminal
  delegate (invariant 2), `source` must read `ORCHESTRATION_JOB` — the source whose state actually
  won precedence, never the outranked delegate.

## Explicitly out of scope

`force`/justification UI · run polling · credential or budget management UI · worker go-live · live
provider smoke tests · the shared-provider unbounded body read (10A-2 §19.2) · `RETRY_WAIT` cleanup ·
migrations · Risk v1 · per-source vulnerability outcomes (P1-1). Gate confirmed none is inseparable.
If implementation proves otherwise, that is a stop-and-report reclassification, never a silent
broadening.

## Implementation record (Tier 2, `feat/phase-10c1-truthful-terminal-states`)

New `SUMMARY_STATUSES` values: `NO_RECORD` (positive-vs-nothing-on-file split, defects 1/2),
`RATE_LIMITED`, `AMBIGUOUS` (defect 5 split, from `errorCode`/`terminalReasonCode` only — invariant
7). `SUMMARY_STATUS_PRECEDENCE` replaces `rollUp`'s inline precedence array and is proven to cover
the full `SUMMARY_STATUSES` set (invariant 8). A new sibling `EXECUTION_SKIP_REASONS` vocabulary
(`EXECUTION_DISABLED` / `EXECUTION_NOT_CONFIGURED` / `EXECUTION_UNSUPPORTED_SUBJECT` /
`EXECUTION_BUDGET_EXHAUSTED`) is minted in `enrichmentDecisionCodes.js`, never merged into
`SKIP_REASONS` (invariant 6). `resolveSubjectState` now reads whether the job is terminal and
whether a linked delegate is still `PENDING` to decide authority (invariant 2/defect 6), and reads
`job.terminalReasonCode`/`job.errorCode`/`delegate.terminalReasonCode` only against the closed
vocabularies above (invariant 7) — never touching the five existing write sites, which already
persist `terminalReasonCode: "AMBIGUOUS_AFTER_CONTACT"` verbatim. `evidenceAvailable` is forced
`false` whenever `source === VULNERABILITY_ENRICHMENT` (gate P1-1). Frontend:
`ENRICHMENT_SUMMARY_STATUS` gains `NO_RECORD`/`RATE_LIMITED`/`AMBIGUOUS` labels,
`SKIP_REASON_LABELS` gains the four execution-time labels and the P2-3 relabel, and
`FindingEnrichmentPanel.jsx`'s stale-notice gate drops its `status === 'COMPLETED'` condition
(P2-2). No backend write site, migration, route, or run-state constant changed.
