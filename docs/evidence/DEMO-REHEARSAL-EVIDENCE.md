# Evidence — PKCERT demonstration rehearsal

One bounded rehearsal of the complete live walkthrough, executed **2026-08-19**
against a disposable local stack (`threatnexus_demo`, compose project
`tnxdemo2`) running current `origin/main` (`2bda0e5`) plus this branch.

**After the rehearsal the demonstration database was reset again**, so the state
described in §5 — not the rehearsed state — is what the presentation starts
from.

Every subject is an RFC 5737 / RFC 2544 reserved address. No real host was
implicated and **no positive intelligence was fabricated at any point**.

---

## 1. Configuration during the rehearsal

| Control | Value |
|---|---|
| `AUTO_ENRICHMENT_ENABLED` | `false` |
| `ENRICHMENT_WORKER_ENABLED` | `true` (deliberate, demo only) |
| All `*_AUTOMATIC_DAILY_BUDGET` | `0` |
| `CENSYS` / `NETLAS` / `GREYNOISE` `_MANUAL_DAILY_BUDGET` | `3` each |
| `ABUSEIPDB` / `SHODAN` / `NVD` `_MANUAL_DAILY_BUDGET` | `0` |
| `ABUSEIPDB_API_KEY`, `SHODAN_API_KEY` | **blanked** |
| `AI_ENABLED` | `false` |

## 2. Provider contact count

**7 attempt rows carry `contactedProvider=true`. 6 of them reached a real
external provider.**

| Provider | Real contacts | Outcomes |
|---|---|---|
| censys | 1 | `SUCCESS` (HTTP 200) |
| netlas | 2 | `SUCCESS` ×2 (HTTP 200) |
| greynoise | 3 | `NOT_FOUND` ×3 (HTTP 404) |
| netlas (outage test) | **0** | `TIMEOUT` — directed at an unroutable RFC 5737 address, so no real provider was reached |
| **Total real external contacts** | **6** | |

`contactedProvider=true` means **contact was initiated**, not that a provider
answered — the timeout row carries it with no HTTP status.

> **One unintended contact is recorded honestly here.** The first attempt at the
> S10 outage test set `NETLAS_BASE_URL` via `--env-file`, which only supplies
> compose *substitution* variables and does not inject them into the container.
> The override never reached the backend, so that attempt made a **real** netlas
> call (HTTP 200) instead of the intended unreachable one. It is included in the
> 6 above. The compose file now forwards provider base URLs explicitly so the
> fallback is genuinely rehearsable.

## 3. Scenario results

| | Scenario | Result | Evidence |
|---|---|---|---|
| **S1** | First click | **PASS** | Run 1 created, 3 items `ELIGIBLE`; jobs 1/3/4 terminal; 3 contacts, one per provider. Not skipped for freshness. |
| **S2a** | Force without justification | **PASS** | `HTTP 400 — justification is required and must be 1-1000 characters when force=true`. **0 contacts.** |
| **S2b** | Force with justification | **PASS** | Run 4, `force=true`, `SUCCEEDED`, 1 contact. Audit row `enrichment.orchestration.run.created` stores `"justification": "Panel-requested live recheck during PKCERT demonstration."` |
| **S3** | Another Finding (B) | **PASS** | Run 5 on Finding 5 `SUCCEEDED` independently, 1 contact. |
| **S4** | `NO_RECORD` | **PASS** | greynoise jobs terminal `NO_RECORD`, `httpStatus=404`, `contactedProvider=true`. A contacted, terminal, honest "nothing on file". |
| **S5** | 401/403 | **PASS (historical)** | Observed in the earlier rehearsal that prompted this work: 9 shodan jobs `FAILED` with `httpStatus=403` / `INVALID_KEY`, alongside 2 `NO_RECORD` (404). **Not re-run** — re-proving a known-invalid credential would spend quota for no new information. This is why Shodan is excluded. |
| **S6** | Quota refusal | **PASS** | With greynoise at 3/3, job 8 went terminal `SKIPPED_BUDGET` with **no HTTP status**, and the contact count stayed at 5 rather than 6. The budget refused the call before it was made. |
| **S7a** | Worker off — preflight | **PASS** | Preflight `DEMO NOT READY`; **S3** fails (`ENRICHMENT_WORKER_ENABLED=false, expected=true`), **P3** fails (`EXECUTION_PAUSED`). |
| **S7b** | Worker off — request | **PASS** | `HTTP 202`, `executionState: "PAUSED_WORKER_DISABLED"`. Attempt count unchanged. **0 contacts.** |
| **S8** | No CVE subject | **PASS** | `nvd` on Finding 7 → `outcome: SKIPPED`, `itemCount: 0`, `consideredProviders.noSubject: ["nvd"]`. **No CVE was fabricated.** |
| **S9** | Double click | **PASS** | Two genuinely concurrent POSTs both returned **run id 1**; the second reported `outcome: ALREADY_RUNNING`. 3 items, not 6. One reservation per provider. Audited as `enrichment.orchestration.run.deduplicated`. |
| **S10** | Provider outage | **PASS** | With netlas pointed at an unroutable address: run `FAILED`, job 10 `FAILED` with **no** `httpStatus`, attempt outcome `TIMEOUT`. **Never reported as success.** |
| **S11** | Rehearsed earlier | **PASS** | Preflight went red on **D1** (8 runs on demo Findings) and **D2**, naming every blocking pair, e.g. `finding 7/censys blocked by job 1`. |
| — | Fresh-result prevention | **PASS** | Immediate un-forced re-request → run 3 `SKIPPED`, all 3 items `SKIPPED_CACHED / FRESH_RESULT_EXISTS`. **This is the exact state the demonstration must not start from.** |

## 4. Ledger at the end of the rehearsal

```
enrichment.lookup.charged      4      enrichment.orchestration.run.created       3
enrichment.lookup.claimed      4      enrichment.orchestration.run.deduplicated  1
enrichment.lookup.contacted    4      enrichment.ingestion.schedule.completed    3
enrichment.lookup.finalized    4      <provider>.lookup.*  (legacy path)         0
```

**Zero legacy `<provider>.lookup.*` audit rows** — the unmetered synchronous
path was never used.

Budgets consumed: censys 1/3, netlas 2/3 (3/3 after the outage test),
greynoise 3/3.

## 5. Post-rehearsal reset — the hard gate

`npm run demo:reset` was run again against `threatnexus_demo`, then the
non-contact preflight:

```
16/16 assertions passed

DEMO READY
```

Verified directly in the database afterwards:

| Table | Rows |
|---|---|
| `FindingEnrichmentRun` | **0** |
| `FindingEnrichmentRunItem` | **0** |
| `ProviderLookupJob` | **0** |
| `ProviderLookupAttempt` | **0** |
| `ProviderDailyUsage` | **0** (manual budgets restored) |
| `CensysEnrichment` / `GreyNoiseEnrichment` / `NetlasEnrichment` | **0** |
| legacy `<provider>.lookup.*` audit rows | **0** |

Findings **A (7 → 203.0.113.11)**, **B (5 → 198.51.100.21)** and
**C (8 → 203.0.113.12)** are untouched, and **D2 confirms no fresh provider
result exists for any of them**, so the first analyst click cannot be answered
with "a fresh result already exists".

`IocEnrichment` legitimately holds **11 PENDING** `abuseipdb` rows: report
ingestion enqueues one per indicator regardless of `AUTO_ENRICHMENT_ENABLED`.
Nothing drains that legacy queue automatically, the AbuseIPDB credential is
blank, and its budgets are `0` — preflight **S7** enforces the credential's
absence. `queriedAt` is null on every one: **no contact has occurred.**

## 6. Secrets

No credential value was read, printed, logged, committed, or included in any
screenshot or document. Provider keys were supplied to the container by
`docker compose --env-file` pointing at the operator's own gitignored
`backend/.env`; only variable **names** were ever inspected. The demonstration
profile lives in the session scratchpad and is **not** in the repository.
