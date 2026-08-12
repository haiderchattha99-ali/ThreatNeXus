# Phase 10A-1 — binding enrichment-orchestration API contract

Ticket: `TNX-P10A1-ENRICHMENT-ORCHESTRATION-FOUNDATION`
Status: BINDING. This file is the contract. Code, tests and reviews defer to it.

It exists because the Phase 10 Plan v2/v2.1 documents are on no disk in this project (see
`STATE.yaml` known_issues), so two sessions previously reconstructed the surface differently. If
this file and the code disagree, the code is wrong. Amending this file requires explicit approval
and must be recorded in `DECISIONS.md`.

Milestone rule that outranks every field below: **Phase 10A-1 executes nothing.** No provider is
constructed or called, no quota is reserved, no `ProviderLookupAttempt` or `ProviderDailyUsage`
row is written, no worker exists.

---

## 1. Surface

Exactly three Finding-scoped routes, plus the pre-existing ADMIN usage route.

| Method | Path | Capability |
|---|---|---|
| POST | `/api/findings/:id/enrichment/runs` | `trigger:finding-enrichment` |
| GET | `/api/findings/:id/enrichment/runs/:runId` | `read:findings` |
| GET | `/api/findings/:id/enrichment/summary` | `read:findings` |
| GET | `/api/enrichment/usage` | `execute:enrichment-batch` (ADMIN) |

There is **no** `GET /api/findings/:id/enrichment/runs` list. It was never part of the contract; a
run-history browser is not a Phase 10A-1 requirement and the summary endpoint answers the question
an analyst actually has ("what is known about this Finding?"). It is removed.

There is no `/:id/enrichment-runs` hyphenated alias. It was never released.

`403` is never downgraded to `401`. A run belonging to another Finding is `404`, never `403`.

---

## 2. `POST /api/findings/:id/enrichment/runs`

### Request

```json
{
  "providers": ["optional", "allow-listed"],
  "force": false,
  "justification": "optional bounded analyst reason"
}
```

* `providers` — omitted/null means every known provider. Supplied must be a non-empty array of
  known identifiers (`abuseipdb`, `censys`, `greynoise`, `netlas`, `nvd`, `shodan`). Any unknown
  entry is **400**, never a silent drop.
* `force` — boolean. Bypasses freshness only. Never bypasses configuration, budget, subject
  compatibility, or `activeLookupKey` uniqueness.
* `justification` — trimmed, 1–1000 characters, the same rule
  `findingEnrichmentScheduleService.normalizeJustification` already enforces.
  **Required when `force=true`** (400 otherwise). Optional and bounded otherwise.
  Never echoed in a response. Reaches audit only as a ≤200-character preview, the existing
  convention.
* `Idempotency-Key` header — optional, ≤128 UTF-8 bytes, no control characters. Hashed before use;
  the raw value is never persisted, logged, audited or returned.

### Response

| Outcome | Status | Meaning |
|---|---|---|
| `CREATED` | **202** | A new run was recorded AND it has eligible work. Recorded, not executed. |
| `ALREADY_RUNNING` | **200** | Idempotent replay, or the loser of a concurrent race. The **existing** run is returned. |
| `SKIPPED` | **200** | A new run was recorded and every target was refused by policy. |

`Location: /api/findings/:id/enrichment/runs/:runId` is set for the resulting run on all three
outcomes.

Body — top-level keys exactly `success`, `outcome`, `executionState`, `run`, `items`:

```json
{
  "success": true,
  "outcome": "CREATED",
  "executionState": "PAUSED_WORKER_DISABLED",
  "run": {
    "id": 1, "findingId": 1, "trigger": "MANUAL", "state": "PENDING", "force": false,
    "requestedAt": "…", "completedAt": null, "itemCount": 1,
    "decisionCounts": { "ELIGIBLE": 1 },
    "consideredProviders": { "noSubject": ["nvd"] }
  },
  "items": [
    {
      "provider": "censys", "subjectType": "IPV4", "subjectValue": "…",
      "decision": "ELIGIBLE", "skipReason": null,
      "lookupState": "PENDING", "contacted": false
    }
  ]
}
```

`success: true` is the repository-wide envelope and carries no meaning of its own. `outcome`,
`executionState`, `run` and `items` are the binding fields. The run is **not** flattened into a
generic `data` object.

`executionState` is a closed vocabulary:

* `PAUSED_WORKER_DISABLED` — `ENRICHMENT_WORKER_ENABLED=false` (the default).
* `NOT_IMPLEMENTED` — the switch is on, but Phase 10A-1 ships no worker, so nothing will run.

### `consideredProviders.noSubject` is durably recorded

A provider that was in scope but had no subject of its required type on this Finding (`nvd` with no
ACTIVE, ANALYST_VERIFIED CVE association) produces **no run item** — `subjectValue` is NOT NULL and
a CHECK constraint forbids an IP becoming an NVD subject.

That fact is persisted at request time on `FindingEnrichmentRun.noSubjectProviders` (a sorted,
comma-joined list of allow-listed identifiers). Consequences, all binding:

* the immediate POST and any later GET of the same run return the **identical** list;
* associating a verified CVE afterwards does **not** change a historical run's response;
* T-09 holds: no NVD run item exists when no active analyst-verified CVE existed;
* the requested provider scope is never recovered by reversing `requestScopeHash`.

---

## 3. `GET /api/findings/:id/enrichment/runs/:runId`

Body — `success`, `executionState`, `run`, `items`, with `run` and `items` byte-identical in shape
to the POST response. No `outcome` (nothing was requested).

---

## 4. `GET /api/findings/:id/enrichment/summary`

Capability `read:findings`, so all four roles can read it. It makes **zero** provider calls, creates
no attempt row, reserves no quota, writes nothing at all, and starts no worker. It is a pure read.

Body:

```json
{
  "success": true,
  "data": {
    "findingId": 1,
    "asOf": "2026-08-12T00:00:00.000Z",
    "executionState": "PAUSED_WORKER_DISABLED",
    "providers": [ /* one row per known provider, provider-sorted */ ]
  }
}
```

One row per known provider, always all six, always in the same order. Each row:

| Field | Meaning |
|---|---|
| `provider` | lowercase allow-listed identifier |
| `purpose` | `IOC_REPUTATION` \| `EXPOSURE` \| `VULNERABILITY` — closed |
| `status` | closed, see below |
| `skipReason` | closed `SKIP_REASONS` code, or null |
| `source` | `NONE` \| `ORCHESTRATION_JOB` \| `IOC_ENRICHMENT` \| `VULNERABILITY_ENRICHMENT` |
| `asOf` | the evaluation instant this row was resolved at |
| `freshUntil` | when the resolved answer stops being fresh, or null |
| `isStale` | `freshUntil !== null && freshUntil <= asOf` |
| `evidenceAvailable` | a terminal successful answer exists and is still fresh |

`status` vocabulary:

* `NO_SUBJECT` — considered, but this Finding carries no subject of the provider's type. This is
  the required NVD-without-a-verified-CVE answer, and it creates **no** NVD item.
* `NOT_REQUESTED` — a subject exists, but no orchestration item has ever been recorded.
* `PENDING` — an item exists and its work is non-terminal.
* `COMPLETED` — the work reached a real answer (`SUCCEEDED` / `NO_RECORD`).
* `UNAVAILABLE` — the work reached a terminal failure.
* `SKIPPED` — the item was refused by policy, or the job was refused before it could be attempted.

NVD may carry `subjects` — one sub-row per verified CVE, each with `subjectValue`, `status`,
`skipReason`, `source`, `freshUntil`, `isStale`, `evidenceAvailable`. Every other provider carries
no `subjects` key. **An IP is never an NVD subject**, in this response or anywhere else.

Delegated providers (`abuseipdb`, `nvd`) resolve their state through the delegate row the canonical
queue services own, and say so via `source`. Direct providers resolve from the Phase-10 job.

The response **never** contains: a job id, a delegate id, `queryIdentityHash`, `requestScopeHash`,
`idempotencyKey`, `activeLookupKey`, a claim token, an active credential, or any subject belonging
to another Finding.

---

## 5. Report-upload response — the additive `enrichment` block

`POST /api/reports/upload` gains exactly one additive key. Every pre-Phase-10 field is unchanged.

With `AUTO_ENRICHMENT_ENABLED=false` (the shipped default) the block is **exactly**:

```json
{
  "state": "AUTOMATIC_DISABLED",
  "runsCreated": 0,
  "itemsCreated": 0,
  "jobsCreated": 0,
  "jobsShared": 0,
  "skipped": 0
}
```

Those six keys, no more, in every state. When enabled they are populated truthfully:

| Field | Definition |
|---|---|
| `runsCreated` | runs newly inserted by this upload |
| `itemsCreated` | run items newly inserted by this upload |
| `jobsCreated` | Phase-10 `ProviderLookupJob` rows newly inserted by this upload |
| `jobsShared` | items attached to an already-existing or race-winning shared job |
| `skipped` | policy-skipped items written by this upload |

`state` is closed: `AUTOMATIC_DISABLED` \| `NO_FINDINGS` \| `RECORDED` \| `PARTIAL`.
`PARTIAL` means at least one Finding failed to record; ingestion still succeeded, because
orchestration never blocks it.

Deliberately **absent** from this public block: `enabled` (implied by `state`),
`runsDeduplicated`, `failedCount` (folded into `PARTIAL`), `executed`, and every internal id or
hash. Adding one requires amending this file.

---

## 6. Invariants this contract inherits

* Enrichment failure never blocks ingestion.
* API keys come from environment variables only; only their presence is ever read.
* Every write path appends its own `AuditLog` event, carrying counts and closed codes only — never
  a subject value, a hash, an idempotency key or an internal id.
* Reputation is supporting context, never proof.
* No committed JavaScript in `src/services/enrichmentOrchestration/` contains a literal NUL byte.
