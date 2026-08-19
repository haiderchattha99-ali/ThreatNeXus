# ThreatNeXus — PKCERT demonstration readiness

Operational runbook for giving the live demonstration. Everything here is
demonstration-only; none of it changes the repository's shipped defaults.

**The problem this exists to solve.** A rehearsed Finding answers the analyst's
first *Request enrichment* click with **"Skipped — a fresh result already
exists."** That is correct production behaviour — freshness prevents paying a
provider twice for the same question — but it is an unacceptable *starting
state* for an official demonstration, because the audience never sees the
system do anything. The fix is not to weaken freshness. The fix is to start
from a database on which the question has genuinely never been asked, and to
have a check that refuses to let you walk into the room otherwise.

---

## 1. Production posture vs demonstration posture

| Control | Shipped default | Demonstration | Why |
|---|---|---|---|
| `AUTO_ENRICHMENT_ENABLED` | `false` | **`false`** (unchanged) | Ingestion must not enrich. This is what keeps the demo Findings untouched. |
| `ENRICHMENT_WORKER_ENABLED` | `false` | **`true`** | The only deliberate deviation. Without it nothing executes and the click records a request that never runs. |
| `*_AUTOMATIC_DAILY_BUDGET` | `0` | **`0`** (unchanged) | No automatic lane spend, ever. |
| `*_MANUAL_DAILY_BUDGET` | *(blank)* | **explicit small integer** | **A blank manual budget means UNLIMITED, not zero.** Never leave one blank for a demonstration. |
| Provider credentials | absent | only the demo set | An excluded provider with no credential cannot be reached by any path, including the legacy one. |
| `AI_ENABLED` | `false` | `false` | Every workflow completes with AI off. |

**After the demonstration, return to default-off** (§10). The demonstration
profile must never become the repository's default.

---

## 2. The demonstration provider set

| Provider | In the demo? | Why |
|---|---|---|
| **Censys** | ✅ primary | Proven contacted outcome (HTTP 200) against the demo subjects. |
| **Netlas** | ✅ secondary | Proven contacted outcome (HTTP 200). |
| **GreyNoise** | ✅ truth-state | Returns `404 → NO_RECORD` for the synthetic subjects. This is a **valid contacted outcome**, not a failure — it is the best demonstration of the system's honesty. |
| **NVD** | ❌ excluded | Conditional on a qualifying CVE subject. **The deterministic demo dataset contains zero `Vulnerability` and zero `FindingVulnerability` rows**, so no Finding has a CVE. No CVE was fabricated to enable it. See scenario **S8**. |
| **Shodan** | ❌ excluded | The available credential returned **HTTP 403 `INVALID_KEY`** during rehearsal. Supported by the product; not selected for this demonstration because credential readiness could not be verified. **This is not a product defect.** |
| **AbuseIPDB** | ❌ excluded | Supported and genuinely functional (see §3), but excluded to keep the demonstration provider set minimal and the legacy delegated lane inert. |

Excluded providers have their credentials **blanked** in the demo profile, which
is what makes the legacy unmetered path incapable of reaching them (§4).

---

## 3. The AbuseIPDB mock-vs-real question — resolved

An earlier rehearsal showed rows labelled `abuseipdb` while
`IOC_ENRICHMENT_PROVIDER=mock`, raising the question of whether mock output was
being persisted under a real provider's label. **It was not.** The evidence:

- `IocEnrichment` row for `192.0.2.40` recorded `usageType="Reserved"`,
  `isWhitelisted=true`, `totalReports=5`, `lastReportedAt=2026-07-24`.
  `mockIocEnrichmentProvider` **always** writes `usageType: null` and
  `isWhitelisted: false`, and its scenarios use `totalReports` of 0/2/20/150 —
  never 5. Only the real AbuseIPDB API knows `192.0.2.40` is a reserved range.
- `enrichmentRunner` resolves the adapter from the **stored row**
  (`providerRegistry.resolve(record.provider)`), and `enrichmentRunService`
  hardcodes `provider: "abuseipdb"` when establishing the delegate.
- `enrichmentRuntime` explicitly forbids a mock fallback: an unregistered name
  reports `UNKNOWN_PROVIDER` rather than being quietly served by MockProvider.

**So mock results cannot be persisted under a provider-labelled orchestration
row.** `IOC_ENRICHMENT_PROVIDER` is read by **no execution path at all**.

**The real defect was the inverse, and it is fixed.** The operational overview
read that vestigial selector and reported the IOC reputation provider as
`MOCK_PROVIDER` ("Mock provider" in Settings) while a configured deployment was
contacting the real AbuseIPDB API and spending its quota. A mock label over real
third-party evidence is the same class of defect as a real label over mock
evidence. `operationalOverviewService` now reports the provider the execution
path actually asks (`abuseipdb`) and `CONFIGURED`/`NOT_CONFIGURED` by key
presence. Regression: `backend/tests/unit/operationalOverviewIocProviderTruth.test.js`.

---

## 4. What "the legacy unmetered path" means

`POST /api/findings/:id/enrichment/<provider>` calls `provider.lookup()`
**directly** — no `ProviderLookupJob`, no quota reservation, no
`ProviderLookupAttempt`. It never consults `ENRICHMENT_WORKER_ENABLED` and goes
live the moment a credential exists. Its only bound is `providerRateLimiter`.
No frontend code calls it, so reaching one takes a deliberate hand-made request.

Two consequences the runbook depends on:

- "Credential presence cannot cause contact" is **scoped to the Phase-10
  orchestration path**, not system-wide.
- A `ProviderLookupAttempt` count is **not** a sufficient no-contact proof.
  The legacy path's unique signature is an `AuditLog` action matching
  `<provider>.lookup.%` (the orchestration path uses `enrichment.lookup.%`).
  Preflight **S5** counts exactly that.

Additionally, report ingestion **always** enqueues a PENDING `abuseipdb`
`IocEnrichment` row per indicator, independent of `AUTO_ENRICHMENT_ENABLED`.
Nothing drains that legacy queue automatically, and with the AbuseIPDB
credential blank it cannot contact anything. Preflight **S7** enforces that.

---

## 5. The demonstration Findings

Selected from the deterministic `seed:demo` dataset on evidence, not preference.

| Role | id | Indicator | Port | Why |
|---|---|---|---|---|
| **A — primary** | `7` | `203.0.113.11` | 3389/TCP | Richest decision-first detail: highest risk score in band, owner *Meridian Health Trust* at **HIGH** ownership confidence, triage `ESCALATED`, **3 occurrences** (persistence), linked to a case. |
| **B — backup** | `5` | `198.51.100.21` | 3389/TCP | Equivalent depth under a different organization (*Northport Water Authority*), 3 occurrences, in a case. Distinct subject, so A's freshness never blocks it. |
| **C — backup** | `8` | `203.0.113.12` | 3389/TCP | Third distinct subject, 2 occurrences, in a case. |

All are `ACCESSIBLE_RDP` on 3389/TCP. Every address is an RFC 5737 / RFC 2544
reserved range — synthetic by construction, so no real host is implicated.

> Ids are stable because `demo:reset` drops the schema, which resets the
> sequences. Verify with preflight **B4** rather than assuming.

---

## 6. Reset and preflight

### Reset

```bash
docker compose exec \
  -e DEMO_RESET_CONFIRM=threatnexus_demo \
  -e DEMO_MODE=true \
  -e DEMO_USER_PASSWORD='<local demo password>' \
  -e SEED_USER_PASSWORD='<the same password>' \
  backend npm run demo:reset
```

Drops the schema, applies migrations, seeds users, seeds the demonstration
dataset. **It refuses unless all five guards pass:**

| Guard | Refuses when |
|---|---|
| G1 | `NODE_ENV=production` |
| G2 | the database name lacks the `demo` marker (e.g. `threatnexus_demo`) |
| G3 | the name is reserved/long-lived (`threatnexus`, `postgres`, `template1`) |
| G4 | `DEMO_RESET_CONFIRM` is not exactly the resolved database name |
| G5 | `AUTO_ENRICHMENT_ENABLED=true` |

G5 matters most: `seed:demo` ingests through the real pipeline, and ingestion
schedules AUTOMATIC-lane enrichment. Resetting with automatic enrichment on
re-creates, *during the seed itself*, the runs the reset exists to clear — a
reset that looks like it worked and did not.

> The reset also clears `ProviderDailyUsage`, so **manual budgets are restored**.
> The **provider's own external quota is not** — that is outside ThreatNeXus.

### Preflight (non-contact)

```bash
docker compose exec -e DEMO_FINDING_IDS="7,5,8" backend npm run demo:preflight
```

Makes **no** provider call. Prints `DEMO READY` (exit 0) or `DEMO NOT READY`
(exit 1) with exact reasons.

| | Checks |
|---|---|
| **B1–B4** | disposable demo database · no unfinished migrations · every migration applied · the three declared Findings exist |
| **D1–D2** | **hard gates** — no enrichment run of any kind on A/B/C · no fresh provider result for any (demo provider × demo subject), so the first click cannot be skipped |
| **S1–S7** | automatic enrichment off · every automatic budget `0` · worker state matches intent · manual budgets explicit and `1..5` (blank = unlimited is a failure) · no legacy `<provider>.lookup.*` audit rows · no live-smoke opt-in armed · excluded providers uncredentialed |
| **P1–P3** | providers supported · credential variables present · each resolves `READY` on the MANUAL lane |

**P2 reports credential *presence* only.** An environment variable existing is
never proof the credential is externally valid.

D2 uses the product's own freshness query (`findFreshJobForSubject`), not a
second definition — a preflight with its own idea of freshness could pass while
the product skips.

---

## 7. The live walkthrough

1. **Log in as the analyst. Open Findings.** Select Finding **A**
   (`203.0.113.11`, 3389/TCP).
   > *"The report tells ThreatNeXus that RDP was observed as accessible. It does
   > not prove compromise."*
2. **Show the decision-first detail** — risk, ownership and its confidence,
   triage state, evidence provenance, occurrence history.
3. **Open Enrichment coverage.** No fresh results exist, so the UI offers
   **Request enrichment** rather than the repeated-run path.
4. **Click Request enrichment.** This human action is the only thing that
   creates live work.
5. **Show the request recorded and the worker active.**
6. **Poll status.** Expect Censys and Netlas to answer, and GreyNoise to return
   `NO_RECORD`.
   > *"We successfully asked the provider; it has no matching record.
   > ThreatNeXus preserves that distinction rather than displaying a false green
   > result or pretending no call occurred."*
7. **Open one successful provider result** — source, as-of time, stored
   evidence, provider context.
   > Provider evidence is **context**. It never proves the Accessible-RDP
   > exposure and never confirms compromise.
8. *(Optional)* **Admin → provider readiness and budget**: manual allowance,
   reservation, remaining. Do not dwell on unselected providers.

---

## 8. Audience-interruption scenarios

All eleven were executed against a real stack. Results are in
`docs/evidence/DEMO-REHEARSAL-EVIDENCE.md`.

| | Scenario | What happens | Talk track |
|---|---|---|---|
| **S1** | "Click it now" | Run created, 3 items `ELIGIBLE`, one contact per provider. | The first click does real work. |
| **S2** | "Run it again" | Un-forced → every item `SKIPPED_CACHED / FRESH_RESULT_EXISTS`. Forced without justification → **HTTP 400**. Forced with justification → runs, and the justification is stored in the audit row. | *"ThreatNeXus allows a deliberate re-check, but it records why quota was spent again."* |
| **S3** | "Do another one" | Use **B**, then **C**. Distinct subjects, unaffected by A. | Don't burn quota on one Finding. |
| **S4** | `NO_RECORD` | Job terminal `NO_RECORD`, HTTP 404, `contactedProvider=true`. | Do **not** apologise. This is the honesty story. |
| **S5** | 401/403 | Job `FAILED`, HTTP 403, `INVALID_KEY`. | Credential readiness is external to ThreatNeXus. Show the closed failure state, move to a verified provider. |
| **S6** | Rate limit / quota | Job terminal `SKIPPED_BUDGET`, **no HTTP status, no contact**. | The budget refused the call before it was made. Never create another key to evade an external quota. |
| **S7** | Worker off | Preflight fails **S3**; a request returns `executionState: PAUSED_WORKER_DISABLED` and contacts nothing. | Recorded, not executed — and it says so. |
| **S8** | No CVE subject | `noSubject: ["nvd"]`, zero items. | *"No qualifying CVE exists on this Finding, so ThreatNeXus does not invent one merely to call NVD."* |
| **S9** | Double click | Both requests return the **same run id**; the second reports `ALREADY_RUNNING`. 3 items, not 6. One reservation per provider. | A double click cannot multiply paid work. |
| **S10** | Provider/internet outage | Job `FAILED` with **no HTTP status**; attempt outcome `TIMEOUT`. Never a fake success. | Switch to another provider, or show the historical canary evidence. |
| **S11** | "It was rehearsed earlier" | Preflight goes red on **D1/D2**, naming each blocking Finding, provider and job id. | Reset, then re-run preflight. |

**Fallback order if a provider misbehaves live:** GreyNoise (`NO_RECORD` is
still a win) → Censys → Netlas → show
`docs/evidence/CONTROLLED-LIVE-CANARY-RECORD.md` → explain the closed failure state.
Never fabricate a result.

> **A failed lookup gets a short (~5 min) freshness window**, not the 24 h a
> success gets. So after a provider failure you can simply retry a few minutes
> later, or use *Run again* with a justification.

> `contactedProvider=true` means **contact was initiated**, not that a provider
> answered. The S10 timeout carries `contactedProvider=true` with no HTTP
> status. Do not describe it as a successful conversation.

---

## 9. Before the demonstration — checklist

1. `docker compose ... up -d` the disposable stack **with the §1 demonstration
   profile** — the database name **must** contain `demo`, and
   `ENRICHMENT_WORKER_ENABLED=true` is the single deliberate deviation. Omit it
   and preflight fails **S3** and **P3** (`EXECUTION_PAUSED`); the stack holds a
   correct data state but cannot execute.
2. `npm run demo:reset`.
3. `npm run demo:preflight` → **must print `DEMO READY`**.
4. Do **not** click Request enrichment again before the audience arrives. Any
   rehearsal click consumes the first-click state — reset again if you do.

## 10. After the demonstration — rollback

1. Restart the stack with `ENRICHMENT_WORKER_ENABLED=false`.
2. Confirm provider readiness returns to `EXECUTION_PAUSED`. `demo:preflight` now
   reports **DEMO NOT READY** at **14/16**, failing **S3** and **P3** only — that is
   the *correct* resting result, not a fault. Every data gate (B1–B4, D1, D2, S5)
   must still pass.
3. `docker compose -p <project> down -v` to destroy the disposable stack and its
   volume.
4. Confirm the repository still holds no credential and no demo profile file.

The demonstration profile lives in the operator's own environment, never in the
repository.

---

## 11. Ingestion scope (for the final documentation)

**Implemented today: the Accessible-RDP reference report family only.**

RDP is the Remote Desktop Protocol, typically TCP/3389, used for remote
graphical administration of Windows environments. **Accessible RDP does not mean
compromised, exploitable, malicious, or weakly credentialed.** It means a
scan observed the service reachable from the internet.

**ThreatNeXus does not scan the internet for RDP.** It consumes exposure
evidence produced elsewhere and manages its lifecycle.

Future scope must define each additional ingestion family independently — SSH,
SMB, VNC, FTP/Telnet, WinRM, VPN and admin interfaces, database services, and
other internet-exposed services. **None of these exist today**, and none should
be forced into the RDP schema.
