# Production Sizing — Measurement Record

**Measured:** 2026-08-19
**Commit under measurement:** `2bda0e551bb28af68975e198e21927baba12628e` (`origin/main`, merge of PR #30)
**Method:** one bounded measurement session against a disposable local stack, created from zero and
destroyed afterwards.

**Canonical source:** this file is the single canonical record of production sizing. A second,
independently-written measurement session (`docs/evidence/PRODUCTION-SIZING.md`, produced on the
`docs/final-demo-evidence` branch at commit `2612cbc`, four commits ahead of the `2bda0e5` base
measured here) was merged into it on **2026-08-19** at commit `fbffbe3`. Every measurement unique to
that session — a second same-day data point on later code — is carried forward in the **Appendix**
at the end of this file rather than interleaved into M1–M10, so the M1–M10 protocol below remains
one internally consistent measurement session. The M8 authoritative-baseline distinction required by
both sessions is resolved explicitly in M8 below.

## Reading this document

Every figure carries exactly one classification. They are not interchangeable, and a figure without
one of these labels does not appear in this document.

| Label | Meaning |
|---|---|
| **MEASURED** | A direct observation from the M1–M10 protocol below, on the host described in M1. Nothing else may use this word. |
| **REASONED RECOMMENDATION** | Derived from a measured footprint plus a stated assumption and a stated headroom factor. Not benchmarked. |
| **NOT LOAD-TESTED / SCALE ASSUMPTION** | An engineering assumption about behaviour under load or scale. **No concurrency or load test was performed in this session and none is authorised.** |
| **NOT MEASURED** | Attempted or considered, and not reliably obtained. Recorded as such rather than inferred. |

### Conditions common to every measurement

- Providers: **off** — no credential configured for any provider.
- Enrichment worker: **off**.
- Automatic enrichment: **off**.
- AI: **off** (`AI_ENABLED=false`, `AI_PROVIDER=null`).
- Data: synthetic / demonstration only.
- **No external provider was contacted at any point during this session.**

### Honest limits of this session

- **One machine, one operating system, one run of each measurement.** Every number is a local
  developer-hardware observation, not a production service level.
- **The host was not otherwise idle.** Unrelated containers belonging to other projects were running
  throughout. Per-container CPU and memory readings are unaffected by this, but every *elapsed time*
  below (M6, M7, M8, M10) was taken on a contended machine and should be read as an upper-ish bound
  rather than a best case.
- **Container CPU percentages are relative to a single core.** Docker reports `212%` to mean roughly
  2.1 cores, not 212% of the machine.
- **Container memory is bounded by the Docker Desktop VM, not by host RAM** — the ceiling visible to
  the containers was 11.54 GiB against 23.72 GiB of host memory.

---

## M1 — Host specification (MEASURED)

| Property | Value |
|---|---|
| CPU | Intel Core i5-8365U @ 1.60 GHz base (reported max 1896 MHz) |
| Physical cores | 4 |
| Logical processors | 8 |
| RAM | 25,467,772,928 bytes (23.72 GiB) |
| Disk | Samsung SSD 970 EVO 500 GB, NVMe, SSD |
| Operating system | Windows 11 Enterprise 10.0.26200 (build 26200), 64-bit |
| Docker Engine | 29.6.2 |
| Docker Compose | v5.3.1 |
| Container memory ceiling | 11.54 GiB (Docker Desktop VM allocation) |
| PostgreSQL | 16 (official `postgres:16` image) |

This is a 2019-class mobile ultrabook CPU. It matters when reading the timings: every elapsed figure
below was produced on low-power laptop silicon under concurrent load, not on server hardware.

---

## M2 — Idle resource floor (MEASURED)

Three `docker stats --no-stream` samples taken across approximately ten minutes, beginning 90
seconds after a healthy start and a completed demonstration seed. Nothing touched the stack between
samples.

| Container | Sample 1 (07:49:21Z) | Sample 2 (07:54:29Z) | Sample 3 (07:59:36Z) |
|---|---|---|---|
| `postgres` CPU | 0.00 % | 3.57 % | 0.01 % |
| `postgres` memory | 39.77 MiB | 40.71 MiB | 40.47 MiB |
| `backend` CPU | 0.00 % | 0.00 % | 0.00 % |
| `backend` memory | 35.77 MiB | 36.89 MiB | 37.39 MiB |
| `frontend` (nginx) CPU | 0.00 % | 0.00 % | 0.00 % |
| `frontend` memory | 6.969 MiB | 6.969 MiB | 6.969 MiB |

**Total idle memory across all three containers: ≈ 82.5 – 84.8 MiB.** Idle CPU is effectively zero;
the single 3.57 % reading on PostgreSQL is a routine background maintenance tick, not application
work — no request was made against the stack during the window.

Network and block I/O were flat between samples on the backend and frontend, confirming the stack
was genuinely idle rather than quietly serving something.

**Three samples of an idle stack are not a load test.** They establish a floor — what the system
costs when nobody is using it — and nothing more.

---

## M3 — Startup peak (MEASURED, coarse resolution)

Sampled continuously during `prisma migrate deploy` (25 migrations from an empty database), then
`seed:users`, then `seed:demo`. Sampling resolution was approximately 2–3 seconds per sample, which
is the cost of `docker stats --no-stream` itself; a peak shorter than that interval would be missed.

| Container | Peak CPU (single-core basis) | Peak memory |
|---|---|---|
| `backend` | 212.32 % (≈ 2.1 cores) | 167.9 MiB |
| `postgres` | 112.20 % (≈ 1.1 cores) | 54.5 MiB |
| `frontend` (nginx) | 0.00 % | 7.2 MiB |

The backend is the peak consumer, and its peak is transient — migration and seeding, not steady
state. The nginx container never registered measurable CPU: it serves a static bundle.

---

## M4 — Image and disk footprint (MEASURED, with a reporting discrepancy recorded)

Two Docker reporting surfaces disagree on image size on this host, and the disagreement is recorded
rather than resolved by picking the more flattering number.

| Image | `docker images` SIZE | `docker ps -s` virtual size |
|---|---|---|
| `tnxmeasure-backend` (project backend) | 1.07 GB | 781 MB |
| `tnxmeasure-frontend` (project frontend, nginx + static bundle) | 75.3 MB | 54 MB |
| `postgres:16` (upstream) | 642 MB | 476 MB |

The `docker images` column reports the containerd image-store content, which on this host includes
multi-platform manifest content; `docker ps -s` virtual size reports the unpacked, platform-specific
layers actually backing the running container. **For planning disk on a single-architecture host,
the `docker ps -s` column is the applicable one.**

Container writable layers, steady state:

| Container | Writable layer |
|---|---|
| `backend` | 86 kB |
| `frontend` | 81.9 kB |
| `postgres` | 20.5 kB |

Writable layers are negligible; all durable state lives in the PostgreSQL volume.

**Approximate total for one deployment of all three images (unpacked, single architecture):**
≈ 1.31 GB — **MEASURED** as the sum of the three virtual sizes above.

---

## M5 — Database size at demonstration scale (MEASURED)

Immediately after 25 migrations from zero, `seed:users`, and `seed:demo`.

| | Value |
|---|---|
| `pg_database_size('threatnexus')` | **12,499,991 bytes** (11.92 MiB) |

The denominator, without which that number means nothing:

| Table | Rows |
|---|---|
| `Finding` | 11 |
| `FindingOccurrence` | 20 |
| `RawReport` | 3 |
| `RawReportRow` | 20 |
| `RiskScore` | 20 |
| `RiskFactorContribution` | 200 |
| `FindingOwnership` | 11 |
| `FindingTriage` | 8 |
| `IocEnrichment` | 11 |
| `Case` | 3 |
| `CaseFinding` | 6 |
| `CaseLifecycleEvent` | 6 |
| `CaseOrganizationResponse` | 2 |
| `CaseClosureRequest` | 1 |
| `CaseFrameworkMapping` | 1 |
| `CaseFrameworkNoMappingAssertion` | 1 |
| `Notification` | 1 |
| `NotificationRevision` | 1 |
| `NotificationExport` | 1 |
| `NotificationDeliveryEvent` | 1 |
| `NotificationLifecycleEvent` | 5 |
| `Organization` | 3 |
| `AssetMapping` | 3 |
| `User` | 4 |
| `AuditLog` | 77 |
| `_prisma_migrations` | 25 |

**Almost none of that 11.92 MiB is data.** A `pg_dump` of the same database is 282 KB (M10). The
difference is the PostgreSQL catalog, index structures, and pre-allocated pages that a schema of
this size carries whether or not any rows exist. **Do not treat 11.92 MiB as the cost of 11
findings.**

---

## M6 — Database growth under ingestion (MEASURED)

Growth was measured against a deterministic synthetic report of **500 fresh indicators** in
`198.18.200.0/24` and `198.18.201.0/24` (benchmark-reserved ranges), ingested through the real
`POST /api/reports/upload` endpoint as the seeded analyst, three times with successive timestamps.

An earlier attempt using the committed historical fixtures is reported here too, because its result
is instructive.

### First attempt — historical fixtures

Ingesting `data/synthetic/accessible-rdp/{01_baseline,02_persistence,05_recurrence}.csv` produced
outcome `HISTORICAL` in all three cases and created **no new Findings**: those indicators already
exist from the demonstration seed, and the fixture timestamps predate the seeded observations. Three
of the four resulting `pg_database_size` readings moved by **exactly zero bytes**, and the fourth by
24,576 bytes — because PostgreSQL allocates in 8 KiB pages and extends in chunks.

That is the clearest possible evidence that a per-finding byte constant would be fiction, so it is
recorded rather than discarded.

### Second attempt — 500 new indicators, real denominator

| Round | Outcome | Findings | Occurrences | Raw rows | Audit rows | `pg_database_size` delta | Ingest wall time |
|---|---|---|---|---|---|---|---|
| Day 1 | `CREATED` × 500 | +500 | +500 | +500 | +504 | **+2,457,600 bytes** (2.34 MiB) | 41.4 s |
| Day 2 | `PERSISTED` × 500 | +0 | +500 | +500 | +4 | **+598,016 bytes** (0.57 MiB) | 56.9 s |
| Day 3 | `PERSISTED` × 500 | +0 | +500 | +500 | +4 | **+606,208 bytes** (0.58 MiB) | 49.4 s |

Two behaviours are confirmed by these numbers rather than asserted:

- **Deduplication works.** 1,500 ingested rows produced 500 Findings, not 1,500. Rounds 2 and 3
  created no new Finding at all.
- **Persistence is much cheaper than creation.** A recurring observation on an existing Finding cost
  roughly a quarter of what a new Finding cost, because it adds an occurrence and a raw row but no
  Finding, ownership, enrichment record, or audit event chain.

Derived planning figures — **REASONED RECOMMENDATION**, not measured constants:

- **≈ 4.9 KB per newly created Finding**, all-in (Finding + occurrence + raw row + ownership +
  enrichment placeholder + audit trail + index overhead). Derived from 2,457,600 ÷ 500.
- **≈ 1.2 KB per subsequent observation of an existing Finding.** Derived from the mean of rounds 2
  and 3, 602,112 ÷ 500.

Both figures are approximate by construction. Index growth is not linear, PostgreSQL allocates in
pages, and autovacuum reclaims space asynchronously. Use them to size an order of magnitude, never
to predict an exact disk figure.

---

## M7 — Cold start to healthy (MEASURED)

From `docker compose up -d` on a destroyed volume to the backend health probe reporting healthy.
Images pre-built; the measurement excludes image build time and includes applying all 25 migrations
from an empty database.

| Run | PostgreSQL healthy | Backend healthy |
|---|---|---|
| 1 | 13.9 s | 29.3 s |
| 2 | 12.4 s | 27.3 s |
| 3 | 21.6 s | 41.4 s |

**Median backend-healthy: 29.3 s. Range: 27.3 – 41.4 s.**

Method caveat: the health probe interval is 5 seconds, so these values quantise at 5-second
granularity and slightly overstate true readiness. Run 3's outlier reflects host contention, not a
different code path.

**This is a local cold-start observation on one laptop. It is not a production start-up SLA.**

---

## M8 — Development and CI resource cost (MEASURED, partially)

**This section distinguishes two different things that must never be conflated: the authoritative
backend validation baseline, and one sizing session's local resource-contention observation. The
contention run below is evidence about wall-clock cost under load on one laptop. It is never the
validation baseline, and does not replace it.**

### The authoritative backend validation baseline

The pass/fail baseline for this repository is whatever the CI `Backend tests` job reports at a given
commit — CI runs on dedicated, uncontended infrastructure and is the signal this project treats as
authoritative for correctness. Two dated snapshots of that baseline are on record:

| Commit | Ticket | Passed | Skipped | Failed | Source |
|---|---|---|---|---|---|
| `ee1146b` | Final security pass (PR #29) | **3,417** | 240 | **0** | `docs/security/FINAL-SECURITY-ASSESSMENT.md` §8 |
| `2612cbc` | Final demo-readiness (PR #32) | **3,460** | 240 | **0** | `docs/ai/STATE.yaml` (168 files, 100.33 s, local `npx vitest run`) |

The difference — 43 tests — is exactly the count of new targeted tests the demo-readiness ticket
added (`demoReset` 16, `demoPreflight` 27), confirmed against that ticket's own validation record.
**`3,460 passed / 240 skipped / 0 failed` is therefore the current baseline** as of the latest commit
under measurement in this document (`fbffbe3`, which contains both PR #29 and PR #32); `3,417` is
the dated baseline immediately before PR #32's tests were added, retained here for traceability, not
as a competing current figure.

### This session's local resource-contention observation (a separate, non-authoritative measurement)

The complete backend verification suite, run on the host against a dedicated PostgreSQL database on
the disposable stack, for the sole purpose of measuring wall-clock and file count — not to
re-establish correctness, which CI already governs.

| | Value |
|---|---|
| Commit measured | `2bda0e5` (this session's base) |
| Test files | 165 |
| Tests passed | 3,384 |
| Tests skipped | 273 |
| Suite duration (vitest-reported) | 180.15 s |
| Wall clock including start-up | 209 s |

Five test files failed on 10-second hook timeouts during this run. That is the documented local
contention pattern on this machine, not a regression: the failures are timeouts in `beforeAll`
hooks, they differ between runs, and the authoritative signal for this repository is CI, which was
green at this commit. **The lower pass count and higher skip count here reflect a different, earlier
commit (`2bda0e5`) than the baseline table above (`ee1146b`/`2612cbc`), not a discrepancy in the same
codebase** — this measurement predates the additional tests added by PR #32. They are recorded
rather than omitted, strictly as evidence of contended-machine wall-clock behaviour.

**Peak memory during the suite: NOT MEASURED.** The host process sampler failed on a path-conversion
error and the run was not repeated. Container-side samples collected during the same window could
not be cleanly attributed to the suite, so they are discarded rather than reported.

**This figure informs developer and CI machine guidance only.** It says nothing about analyst-facing
production capacity, and it must never be quoted as the repository's test-pass baseline — use the
authoritative baseline table above for that.

---

## M9 — Frontend bundle size (MEASURED)

Extracted from the built production image; no bundle-analysis dependency was introduced. Transfer
sizes were measured over HTTP against the shipped nginx configuration, which has `gzip on` for
`text/css`, `application/javascript`, `application/json` and `image/svg+xml`.

| | Value |
|---|---|
| Total `dist/` on disk | **1,202,807 bytes** (1.15 MiB) |
| JavaScript, 6 files | 1,062,586 bytes raw |
| JavaScript, gzip on the wire | **385,999 bytes** (377 KiB) |
| CSS, 1 file | 1,497 bytes raw / 819 bytes gzip |
| Images (PNG logo) | 122,545 bytes (not gzipped — already compressed) |
| SVG, 2 files | 14,577 bytes |
| Pre-compressed `.gz` / `.br` assets emitted by the build | **None** |

Largest chunks:

| Chunk | Raw | Gzip on the wire |
|---|---|---|
| `assets/mui-*.js` | 351,919 B | **126,755 B** |
| `assets/index-*.js` | 291,663 B | 95,538 B |
| `assets/react-*.js` | 221,073 B | 82,418 B |
| `assets/motion-*.js` | 121,114 B | 53,267 B |
| `assets/vendor-*.js` | 76,123 B | 28,021 B |

The bundle is vendor-dominated and already split by vendor. Roughly 500 KB transfers on a cold load
including the logo; every subsequent load is cache-served.

---

## M10 — Backup (MEASURED)

`pg_dump` against the disposable demonstration database.

| Method | Size | Duration |
|---|---|---|
| Plain SQL, run 1 | 282,176 B | 2.80 s |
| Plain SQL, run 2 | 282,176 B | 4.10 s |
| Plain SQL, run 3 | 282,176 B | 2.43 s |
| Custom format (`-Fc`, compressed) | 263,548 B | 2.88 s |
| Plain SQL, gzipped | **36,163 B** | — |

Denominator: `pg_database_size` = 12,499,991 bytes, 11 Findings, 20 occurrences, 3 cases, 1
notification, 77 audit rows, 25 applied migrations.

**Demonstration-scale evidence only.** Backup duration at any realistic data volume is unmeasured.
The useful ratio here is not the absolute size but the shape: the logical dump is ~2 % of the
physical database size at this scale, because the database is mostly schema.

---

## Production sizing guidance

Every figure below states its classification. Where the evidence does not support a number, the
entry says **NOT MEASURED** — which is an acceptable answer.

### A. Development / demonstration

| Resource | Value | Classification | Basis |
|---|---|---|---|
| vCPU | 2 | REASONED RECOMMENDATION | Measured startup peak was ≈ 2.1 cores on the backend (M3), transient and concurrent with PostgreSQL's ≈ 1.1. Two cores complete a cold start in the measured 27–41 s; fewer would extend it. |
| RAM | 4 GB | REASONED RECOMMENDATION | Measured idle floor is well under 100 MiB across all three containers (M2) and measured startup peak is 167.9 MiB (M3). 4 GB is dominated by the container runtime and the OS, not by ThreatNeXus. |
| Storage | 20 GB SSD | REASONED RECOMMENDATION | ≈ 1.31 GB of images (M4) + 11.92 MiB database at demo scale (M5) + build cache and logs. The remainder is headroom, not a measured requirement. |
| Database placement | Same host, Docker volume | MEASURED (this is the shipped topology) | `docker-compose.yml` |
| Backup | `pg_dump`, manual | MEASURED at demo scale (M10) | |
| Network / TLS | None; `http://localhost` | MEASURED (this is what ships) | No TLS terminator exists in the repository. |
| Provider egress | None required | MEASURED | Every provider is off by default and the system starts and completes every core workflow with no outbound access. |

### B. PKCERT pilot / small team

| Resource | Value | Classification | Basis |
|---|---|---|---|
| vCPU | 4 | REASONED RECOMMENDATION | Measured peak concurrent demand during migrate + seed was ≈ 3.2 cores across backend and PostgreSQL (M3). 4 vCPU covers that peak without the two services contending. **Assumption:** a small analyst team generates request load below the measured startup peak. This assumption is **NOT LOAD-TESTED.** |
| RAM | 8 GB | REASONED RECOMMENDATION | Measured peak 167.9 MiB backend + 54.5 MiB PostgreSQL (M3) ≈ 223 MiB of application demand. The recommendation is dominated by PostgreSQL's own working memory and OS page cache, with roughly 30× headroom over the measured application peak. |
| Storage | 100 GB SSD | REASONED RECOMMENDATION | Images ≈ 1.31 GB (M4). Data derived from M6 at ≈ 4.9 KB per new Finding and ≈ 1.2 KB per subsequent observation: 100,000 Findings each observed 50 times ≈ 0.5 GB + 6 GB ≈ 6.5 GB before indexes and WAL. The 100 GB figure is headroom for WAL, backups retained on host, and logs — not a measured requirement. |
| Database placement | Same host, dedicated volume, or a managed PostgreSQL 16 instance | REASONED RECOMMENDATION | Nothing in the schema requires co-location. Not measured against a remote database — network latency between backend and database is **NOT MEASURED.** |
| Backup storage | 10× the working database size | REASONED RECOMMENDATION | Compressed dumps are ~13 % of plain SQL (M10). Sized for retention of many dumps, not for one. |
| Network | Private network or VPN | REASONED RECOMMENDATION | The application holds constituent exposure data; a VIEWER account can read every finding and case. |
| TLS | Required, terminated by a reverse proxy in front of the frontend container | **REASONED RECOMMENDATION — not implemented.** | No TLS terminator, certificate handling, or HTTPS configuration exists in this repository. This is a deployment prerequisite, not a shipped feature. |
| Secret management | `JWT_SECRET` and any provider key injected from the environment; never committed | MEASURED (this is enforced) | The backend refuses to start without `JWT_SECRET` and has no default. CI fails the build if a secret-shaped value reaches the bundle. |
| Logging / monitoring | Container stdout plus the in-application `AuditLog` | MEASURED (this is what exists) | There is **no** alerting subsystem, no metrics endpoint, and no service-availability measurement in this repository. Any monitoring is external and unbuilt. |
| Provider egress | Outbound HTTPS to the specific provider endpoints, only if a provider is deliberately enabled | MEASURED | Default is off. One live GreyNoise request has ever been made; see the canary record. |
| Retention | Not implemented | **NOT MEASURED / not built** | There is no retention policy, no data-expiry job, and no archival path. Findings, occurrences and audit rows accumulate indefinitely. This is a gap a pilot must decide on, not a setting to configure. |

### C. Recommended production baseline

| Resource | Value | Classification |
|---|---|---|
| vCPU | 4 | REASONED RECOMMENDATION — same basis as the pilot; **no load test supports a higher or lower number.** |
| RAM | 8–16 GB | REASONED RECOMMENDATION — the range reflects PostgreSQL tuning latitude, not a measured difference. |
| Storage | 250 GB SSD, growable | REASONED RECOMMENDATION — from the M6 per-Finding and per-observation figures plus WAL and backup headroom. |
| Database | Dedicated PostgreSQL 16, own storage, own backup schedule | REASONED RECOMMENDATION |
| Concurrent analysts supported | **NOT LOAD-TESTED / SCALE ASSUMPTION.** No figure is offered. | |
| Requests per second | **NOT LOAD-TESTED / SCALE ASSUMPTION.** No figure is offered. | |
| Ingestion throughput | 500 rows in 41–57 s single-request (M6) is **MEASURED**. Sustained or concurrent ingestion throughput is **NOT LOAD-TESTED.** | |
| Uptime / availability target | **NOT MEASURED.** No availability measurement exists in this system. | |

### D. Future / high-availability direction

**Everything in this section is proposed and unimplemented.** No part of it exists in the repository
today, and no document may draw it as current architecture.

| Item | Classification |
|---|---|
| Multiple backend replicas behind a load balancer | NOT LOAD-TESTED / SCALE ASSUMPTION — the enrichment worker's leasing model would need review before more than one worker runs. |
| PostgreSQL replication or managed HA | NOT LOAD-TESTED / SCALE ASSUMPTION |
| Horizontal ingestion scaling | NOT LOAD-TESTED / SCALE ASSUMPTION |
| National-scale deployment capacity | NOT LOAD-TESTED / SCALE ASSUMPTION — no evidence in this repository supports any national-scale figure. |
| Centralised log aggregation and alerting | Not built |
| Automated backup and restore verification | Not built — restore has never been tested. |

---

## Figures this session deliberately does not provide

- Concurrent-analyst capacity.
- Requests per second, at any percentile.
- Sustained ingestion throughput.
- Large-dataset behaviour beyond the 1,500 rows ingested here.
- High-availability capacity of any kind.
- Restore duration — `pg_dump` was measured; restore was not.
- Peak memory during the verification suite (M8).
- Behaviour on server-class hardware, on Linux, or with a remote database.

No concurrency or load test was authorised for this session, and none was performed. Any future
document that needs one of the figures above must run the test rather than interpolate from this
record.

---

## Appendix — corroborating same-day measurement (commit `2612cbc`, `docs/final-demo-evidence` branch)

A second, independent sizing session was run the same day (2026-08-19) on the same host, four
commits ahead of the base measured above. Its conclusions agreed with M1–M10 in every case (idle
memory well under 130 MiB, cold start in the low tens of seconds, no dependency changes). The
handful of data points below were captured with a different method than the corresponding M-section
above and are preserved here rather than discarded, without duplicating the full protocol a second
time.

| Corresponds to | Method difference | Value |
|---|---|---|
| M2 (idle floor) | Single `docker stats` snapshot, not three samples over ten minutes | ≈ 93.6 MiB total (postgres 48.3 MiB, backend 38.4 MiB, frontend 6.9 MiB) — consistent with, and inside, the M2 floor above |
| M3 (startup peak) | Node process RSS inside the backend container, not Docker container-level memory | Peak **98.57 MiB**, settled **43.73 MiB** (≈ 2.3× ratio). This is a different metric from M3's container-level 167.9 MiB Docker figure — process RSS versus whole-container memory — and the two are not directly comparable, only both MEASURED. |
| M7 (cold start) | Timed to first `GET /` returning HTTP 200, not to the Docker health probe reporting healthy | **12,286 ms (≈ 12.3 s)** on an already-migrated database (no-op `migrate deploy`) — faster than M7's health-probe timings above because it measures an earlier readiness point and a warm-migration case, not a conflicting result |
| M8 | See the authoritative-baseline table above — this is where that session's validation figure (3,460 passed / 240 skipped / 0 failed) is reconciled with this session's contention observation |

No new conclusion follows from this appendix; it exists so that two real, differently-scoped
measurements are both on record rather than one being silently discarded because the other document
it lived in was superseded.
