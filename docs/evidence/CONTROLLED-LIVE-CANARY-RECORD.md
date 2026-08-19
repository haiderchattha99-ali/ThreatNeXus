# Controlled Live Provider Canary — Permanent Record

**Record type:** repository evidence, recovered from Git history into a current file.
**Ticket:** TNX-P10C4 (`TNX-P10C4-CONTROLLED-LIVE-ENRICHMENT-GO-LIVE`)
**Canary executed:** 2026-08-17
**Record created:** 2026-08-19
**Governing contract:** `docs/ai/PHASE-10C4-CONTROLLED-LIVE-ENRICHMENT-CONTRACT.md` (revision 2, frozen)
**Decision reference:** `D-P10C4-01`

**Canonical source:** this file is the single canonical record of the 10C-4 canary. A second,
independently-written record (`docs/evidence/CONTROLLED-LIVE-CANARY.md`, produced on the
`docs/final-demo-evidence` branch without knowledge of this file) was merged into it on
**2026-08-19** at commit `fbffbe3`. Every fact unique to that document — the port-mapping
observation in "Operational note" below — was carried forward before the duplicate was marked
superseded. Nothing in either source document was discarded.

## Why this record exists

The evidence below was written into `docs/ai/HANDOFF.md` and `docs/ai/STATE.yaml` at commit
`914d582` and merged to `main`. Both files are rolling working-state documents: each subsequent
ticket overwrites them. The 10C-4 canary evidence is therefore no longer present in the current
checkout of either file, and survives only in historical Git state.

This file restates that evidence as a permanent, current, citable record. **No provider was
contacted to produce it.** Every value below was transcribed from the two historical files named
above; nothing was re-run, re-measured, or reconstructed from inference.

**Source commits**

| Artefact | Commit | Path at that commit |
|---|---|---|
| Canary closure narrative and evidence table | `914d582` | `docs/ai/HANDOFF.md` |
| Structured validation entries | `914d582` | `docs/ai/STATE.yaml` |
| Preflight implementation checkpoint | `3bb2004` | `backend/src/scripts/enrichmentCanaryPreflight.js` |
| Frozen contract (revision 2) | `c92cf86` | `docs/ai/PHASE-10C4-CONTROLLED-LIVE-ENRICHMENT-CONTRACT.md` |

All four commits are ancestors of `main`. To read the originals directly:

```
git show 914d582:docs/ai/HANDOFF.md
git show 914d582:docs/ai/STATE.yaml
```

## What was authorised

One operator-authorised enrichment run: **one provider, one benign subject, one MANUAL-lane
request, a daily budget of exactly one reservation**, executed in a disposable local Docker stack
with a verified return to default-off afterwards.

This was explicitly **not** a deployment, not a continuously running worker, and not
AUTOMATIC-lane execution.

**Provider selection.** GreyNoise Community was chosen because it is a *direct-lane* provider —
one `GET`, one header, and `404 -> NOT_FOUND` as a first-class answer — so a single canary
exercises the whole shared direct-lane path. `shodan`, `netlas` and `censys` were excluded as paid
or credential-complex with no additional path coverage; `abuseipdb` was excluded because it is the
*delegated* lane and deliberately not the first canary; `nvd` is structurally
`DELEGATED_BATCH_REQUIRED` and can never be a direct canary.

**Subject selection.** `1.1.1.1` — the already-approved in-repo Phase-8D smoke subject, reused
rather than introducing new third-party exposure.

## Canary facts

| Fact | Value |
|---|---|
| Ticket | TNX-P10C4 |
| Provider | GreyNoise Community |
| Subject | `1.1.1.1` |
| Lane | MANUAL |
| Human authorisation | Explicitly granted |
| Pre-live preflight (worker off) | **17 / 17 PASS** |
| Run ID | 1 |
| Job ID | 1 |
| Attempt ID | 1 |
| Provider contacts | **Exactly one** |
| Outcome | `NOT_FOUND` |
| HTTP status | 404 |
| Job terminal state | `NO_RECORD` |
| Run terminal state | `SUCCEEDED` |
| Attempt terminal state | `FINISHED` / `NOT_FOUND` |
| `contactedProvider` | `true` |
| Daily reservation | 1 (`reservedCount=1`) |
| Budget limit at reservation | 1 (`limitAtLastReservation=1`) |
| Retry | None — confirmed |
| Rollback | Worker returned to OFF; readiness returned to `EXECUTION_PAUSED` |
| Disposable database and volume | Destroyed (`docker compose down -v`), removal confirmed |
| Secret exposure | None recorded |
| Second provider contact | None — confirmed |

`NOT_FOUND` is a **complete and valid success** under contract sections 12 and 15.1. Positive
intelligence was never a success criterion; the canary existed to prove the accounting and
execution path, not to discover anything about `1.1.1.1`.

### Ledger evidence (verified by direct database query, not from log output)

| Table / signal | Observed |
|---|---|
| `ProviderLookupAttempt` | Exactly 1 — `FINISHED`, `outcome=NOT_FOUND`, `httpStatus=404`, `contactedProvider=true` |
| `ProviderLookupJob` (greynoise) | Exactly 1 — `lane=MANUAL`, terminal `state=NO_RECORD` |
| `ProviderDailyUsage` | Exactly 1 row — current day, MANUAL, `reservedCount=1`, `limitAtLastReservation=1`, no other `usageDate` |
| `GreyNoiseEnrichment` | 1 row |
| `greynoise.lookup.%` audit rows | **0** — no legacy-path contact |
| Audit sequence | `claimed -> charged -> contacted -> finalized`, in order |
| `GET .../summary` | Agrees: `greynoise` status `NO_RECORD`, source `ORCHESTRATION_JOB`; every other provider `NOT_REQUESTED` / `NO_SUBJECT` |

### Path used

The canonical analyst path was used, not the adapter directly: authenticated as the seeded `admin`
account and called `POST /api/findings/1/enrichment/runs` with `{providers:["greynoise"]}`, no
force and no justification — the same endpoint an analyst uses. The worker, restarted with
`ENRICHMENT_WORKER_ENABLED=true` and confirmed active via the `enrichment.worker.started` audit row
and `READY` readiness, claimed the job on its own.

### Credential handling

The GreyNoise credential was supplied from the operator's own pre-existing `backend/.env` in the
primary checkout, referenced through `docker compose --env-file` so that the value was never read,
typed, displayed, or written anywhere new. Every other provider credential in that file
(`abuseipdb`, `censys`, `shodan`, `netlas`, `nvd`) was explicitly blanked in a scratchpad-only
overlay so that only `greynoise` could be armed — confirmed by preflight assertion **P4 PASS** (no
other provider credentialed).

**No API key value is recorded in this file, in the source files it was recovered from, or anywhere
else in this repository.** No credential was requested, read, printed, or committed at any point.

### Rollback, verified in order

1. Restarted with `ENRICHMENT_WORKER_ENABLED=false`.
2. Confirmed the worker was not running by positive process-level evidence — `docker compose ps`
   plus the absence of the worker-started line in the *new* container's own logs. The absence of a
   `stopped` audit row was explicitly **not** accepted as evidence, because the fire-and-forget
   audit write can silently fail (contract section 11, step 2).
3. Confirmed readiness returned to `EXECUTION_PAUSED`, with `reservedToday=1` and `remaining=0` —
   correctly reflecting the one spent reservation rather than being zeroed.
4. Confirmed attempt and job counts were unchanged after shutdown (1 / 1) — no post-rollback
   contact.
5. Destroyed the stack and its volume (`docker compose down -v`).
6. Confirmed the worktree had zero diff against HEAD and the primary checkout carried no
   10C-4-related change.

## Pre-live gate

Before the credential was ever supplied, the same preflight was run for real inside the backend
container against a disposable Postgres (`threatnexus_canary`, one seeded `Finding`) with
`GREYNOISE_API_KEY` deliberately unset. Result: **15 / 17 PASS**, with only P3 (credential not
configured) and P12 (readiness resolves to `NOT_CONFIGURED`) failing — the expected closed reason.
A post-run query confirmed zero rows in `ProviderLookupJob`, `ProviderLookupAttempt`,
`ProviderDailyUsage`, `GreyNoiseEnrichment` and `AuditLog`. That stack was torn down and confirmed
removed.

With the credential configured and the worker still off, the preflight returned **17 / 17 PASS**.

## The design fact that made the preflight necessary

A blank `*_MANUAL_DAILY_BUDGET` resolves to **unlimited, not zero**. `DEFAULT_MANUAL_DAILY_BUDGET`
is `null`, and the `null` branch of `reserveProviderQuota` increments without ever refusing. Every
analyst-triggered run is MANUAL lane. A deterministic preflight that refuses unless the budget
resolves to exactly `1` is the entire reason this ticket had an implementation surface at all.

Three related facts were established at the same time and are recorded because they bound what this
canary proves:

- The pre-existing `npm run smoke:*` scripts prove the provider **adapter** only. They create no
  job, reserve no quota, write no attempt row, and never touch the worker.
- `isProviderCredentialConfigured('nvd')` returns `true` unconditionally, so a preflight assertion
  of the form "every provider except greynoise is uncredentialed" is unsatisfiable. `nvd` is
  exempted explicitly and contained by a zero budget instead.
- `EXECUTION_PAUSED` is returned at readiness ladder step 3 and **masks** `BUDGET_ZERO` and
  `BUDGET_EXHAUSTED` beneath it, so a readiness check alone cannot prove a budget is `1` rather
  than `0` or unlimited. That property is carried by an explicit conjunction of nine assertions
  instead.

## Scope limitation — what this canary does and does not prove

**It proves:** the approved GreyNoise direct-worker path, end to end, under real network conditions
— job creation, atomic quota reservation, worker claim, one bounded outbound request, durable
attempt and usage ledger rows, terminal-state agreement across run / job / attempt / summary, a
complete ordered audit trail, and a verified return to default-off.

**It does not prove:**

- Any other provider. Closing 10C-4 confers **no** live proof on `abuseipdb` or the
  targeted/delegated lane — against the clean database the preflight requires, those worker passes
  execute over zero rows, vacuously.
- The legacy synchronous provider routes. `POST /api/findings/:id/enrichment/{greynoise,censys,shodan,netlas}`
  call `provider.lookup()` directly: no `ProviderLookupJob`, no quota reservation, no
  `ProviderLookupAttempt`, no bounded lookup. They never consult `ENRICHMENT_WORKER_ENABLED`. The
  invariant "credential presence alone cannot cause provider contact" is therefore **path-scoped to
  the Phase-10 orchestration path, not system-wide**. No frontend code calls these routes, so
  reaching one requires a deliberate hand-made authenticated request. 10C-4 discloses and detects
  them; it does not disable or harden them.
- Any non-local environment. Credential delivery and egress outside a local stack, and
  provider-account-level behaviour (source-IP key binding, shared per-account rate accounting),
  cannot be established by a local-only canary.
- Unattended or production operation, batch size greater than 1, or any provider with large or
  variable responses.

**Residual closed subsequently.** Phase 10C-5 (bounded provider response bodies) addressed the
response-body size residual that 10C-4 left open. That work is merged to `main` (`c264775`).

## Review status at the time of the canary

Three read-only Tier-3 reviewers completed the contract gate (`security-reviewer`,
`backend-logic-reviewer`, `software-architect`): 0 P0; 6 P1 raw / 4 distinct, all closed; 16 P2, all
closed; 6 P3, all closed. A bounded `security-reviewer` implementation-delta pass over
`c92cf86..3bb2004` returned 0 P0 and 0 P1, with two non-blocking P2 notes.

The preferred independent cross-provider reviewer (Codex) was unavailable for the entire ticket due
to a usage limit resetting 2026-08-21. This is recorded rather than concealed: the internal
fallback reviewer carried that scope per the team workflow, the same substitution already used for
10C-3. Both gates closed 0 P0 / 0 P1 before the live call was authorised.

## Operational note recorded at the time (not a defect)

The compose overlay's `ports` list **concatenated** with the base file's rather than replacing it,
so the disposable backend was also briefly reachable on host port 5000 in addition to the intended
15000 during the canary. No collision occurred and nothing was contacted through the unintended
port. A dedicated compose file is preferable to `-f` layering if this procedure is repeated.
