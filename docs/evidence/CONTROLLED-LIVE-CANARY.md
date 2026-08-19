# Evidence — the controlled live enrichment canary (Phase 10C-4)

**Status: historical record. Rescued, not re-run.**

This is the permanent record of the single authorized live provider contact
ThreatNeXus has ever made through its Phase-10 orchestration path. It was
executed on **2026-08-17** under explicit human authorization, exactly once.

It previously existed only in `docs/ai/HANDOFF.md` at commit `914d582`, a file
every subsequent handoff overwrites. This file is that evidence made permanent.
**The canary was not repeated to produce this document.**

- Ticket: `TNX-P10C4-CONTROLLED-LIVE-ENRICHMENT-GO-LIVE`
- Contract: `docs/ai/PHASE-10C4-CONTROLLED-LIVE-ENRICHMENT-CONTRACT.md` (rev. 2)
- Decision: `D-P10C4-01`
- Source commit: `914d582`

---

## 1. What "go-live" was defined to mean

Narrowly and bindingly: **one** operator-authorized, MANUAL-lane enrichment run,
**one** provider, **one** benign subject, a budget of **exactly one
reservation**, in a **disposable local stack**, with durable ledger evidence and
a verified return to default-off.

It was **not** a deployment, **not** a continuously running worker, and **not**
AUTOMATIC-lane execution.

## 2. Why GreyNoise, and why `1.1.1.1`

- **GreyNoise** — free Community API, one `GET`, one header, and `404 →
  NO_RECORD` as a first-class answer. It is a DIRECT provider, so one canary
  exercises the whole shared direct-lane path.
- `shodan` / `netlas` / `censys` were excluded as paid or credential-complex
  with no extra path coverage.
- `abuseipdb` was excluded because it is the *delegated* lane and deliberately
  not the first canary.
- `nvd` is structurally `DELEGATED_BATCH_REQUIRED` and can never be a direct
  canary.
- **`1.1.1.1`** reused the already-approved in-repo Phase-8D smoke subject
  rather than introducing new third-party exposure. It is a benign, well-known
  public resolver.

## 3. Credential handling

The real `GREYNOISE_API_KEY` came from the operator's own pre-existing
`backend/.env` in the **primary checkout**, referenced via
`docker compose --env-file` so no agent ever read, typed, or displayed the
value. Every other provider credential in that file (`abuseipdb`, `censys`,
`shodan`, `netlas`, `nvd`) was explicitly **blanked** in a scratchpad-only
overlay, so only GreyNoise could be armed — confirmed by preflight **P4**
(no other provider credentialed).

**No credential was requested, read, printed, or committed at any point.**

## 4. Preflight

- **Dry run, credential deliberately absent: 15/17 PASS.** Only P3 (credential
  not configured) and P12 (readiness resolves to `NOT_CONFIGURED`) failed —
  exactly the expected closed reason. A post-run query confirmed **zero** rows
  in `ProviderLookupJob`, `ProviderLookupAttempt`, `ProviderDailyUsage`,
  `GreyNoiseEnrichment` and `AuditLog`.
- **Live preflight, worker off: 17/17 PASS.**

## 5. The run

The **canonical analyst flow** was used, not the adapter directly: signed in as
the seeded `admin` account and called
`POST /api/findings/1/enrichment/runs` with `{providers:["greynoise"]}`, no
force, no justification. The worker — started with
`ENRICHMENT_WORKER_ENABLED=true`, confirmed active via the
`enrichment.worker.started` audit row and `READY` readiness — picked the job up
on its own.

## 6. Result: one clean contact, `NOT_FOUND` (HTTP 404)

Per contract §12/§15.1 this is a **complete and valid success**. Positive
intelligence was never required. All evidence below was verified **in the
database**, not read from log output.

| Fact | Value |
|---|---|
| `ProviderLookupAttempt` | exactly **1** — `FINISHED`, `outcome=NOT_FOUND`, `httpStatus=404`, `contactedProvider=true` |
| `ProviderLookupJob` (greynoise) | exactly **1** — `lane=MANUAL`, terminal `state=NO_RECORD` |
| `ProviderDailyUsage` | exactly **1** row — today, MANUAL, `reservedCount=1`, `limitAtLastReservation=1`, no other day |
| `GreyNoiseEnrichment` | 1 (the known-outcome path) |
| `greynoise.lookup.%` audit rows | still **0** — no legacy-path contact |
| Audit sequence | `claimed → charged → contacted → finalized`, in order |
| `GET .../summary` | agrees: `greynoise` = `NO_RECORD`, source `ORCHESTRATION_JOB`; every other provider `NOT_REQUESTED` / `NO_SUBJECT` |

**No retry occurred.** One attempt, one contact, one terminal state.

## 7. Rollback, executed and verified in order

1. Restarted with `ENRICHMENT_WORKER_ENABLED=false`.
2. Confirmed via `docker compose ps` **and the absence of the worker-started
   line in the new container's own logs**. The *absence* of a `stopped` audit
   row is explicitly **not** accepted as evidence (the fire-and-forget audit
   call can silently fail), so a positive process-level check was used instead.
3. Confirmed readiness back to `EXECUTION_PAUSED` (`reservedToday=1`,
   `remaining=0` — correctly reflecting the one spent reservation, not zeroed).
4. Confirmed attempt/job counts **unchanged** after shutdown — no
   post-rollback contact.
5. Destroyed the stack and its volume (`docker compose down -v`).
6. Confirmed the worktree had **zero** diff against HEAD.

Nothing was ever written that could hold the credential, so there was nothing to
purge.

---

## 8. Scope limitations — what this does NOT establish

- It is **one** contact, to **one** provider, for **one** subject. It is not a
  load test, a reliability measurement, or a rate-limit characterisation.
- It exercises the **direct** lane. The **delegated** lane (`abuseipdb`) and the
  **batch** lane (`nvd`) were not covered by this canary.
- It says nothing about provider data quality or coverage. `NOT_FOUND` means
  GreyNoise held no record for `1.1.1.1` at that moment — nothing more.
- It was performed in a **disposable local stack**, not a deployment. There is
  no production deployment of ThreatNeXus.
- Phase **10C-5** (provider response-body size hardening) remained required
  before any unattended, production, or batch-size > 1 enablement, and was not
  started at the time of this canary.

## 9. Operational note recorded at the time (not a defect)

The compose overlay's `ports` list **concatenated** with the base file's rather
than replacing it, so the disposable backend was also briefly reachable on host
port 5000 in addition to the intended 15000. No collision occurred. A dedicated
compose file is preferable to `-f` layering if the procedure is repeated.
