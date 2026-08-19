# Evidence — production sizing measurements (M1–M10)

Bounded measurements taken on **2026-08-19** against the disposable
demonstration stack running current `origin/main` (`2bda0e5`) plus this
branch's changes.

**Every figure is classified.** Read the classification before quoting a number.

| Class | Meaning |
|---|---|
| **MEASURED** | Observed directly on the stack described in M1. Reproducible. |
| **REASONED RECOMMENDATION** | An engineering judgement derived from measured values. Not itself observed. |
| **NOT LOAD-TESTED / SCALE ASSUMPTION** | Stated so it is not mistaken for evidence. **ThreatNeXus has never been load-tested. No concurrency capacity is claimed anywhere in this document.** |

---

## M1 — Host specification · MEASURED

| | |
|---|---|
| Host OS | Microsoft Windows 11 Enterprise, build 26200, x64 |
| Host physical memory | 24,288 MB |
| Docker Engine | 29.6.2 (Docker Desktop) |
| Container arch | x86_64 |
| CPUs available to Docker | 8 |
| Memory available to Docker | 12,391,673,856 B (11.54 GiB) |

All later figures were taken on this host. A different host will differ.

## M2 — Idle resource usage · MEASURED

Steady state, stack up, seeded, no request in flight. Single `docker stats`
sample.

| Container | CPU | Memory | % of Docker memory |
|---|---|---|---|
| postgres | 18.69%¹ | 48.3 MiB | 0.41% |
| backend | 0.00% | 38.4 MiB | 0.32% |
| frontend (nginx) | 0.00% | 6.9 MiB | 0.06% |
| **Total** | — | **≈ 93.6 MiB** | ≈ 0.79% |

¹ A single instantaneous sample taken shortly after activity; not a sustained
idle CPU figure. Backend and frontend idle at 0.00%.

**The whole stack idles in well under 128 MiB of RAM.**

## M3 — Startup peak · MEASURED

| | |
|---|---|
| Backend peak RSS during startup | **98.57 MiB** |
| Backend settled RSS after startup | **43.73 MiB** |

Peak is roughly **2.3×** settled, driven by `prisma migrate deploy` and module
loading. A memory limit set at the settled figure would fail on boot.

## M4 — Image footprint · MEASURED

| Image | Size |
|---|---|
| backend | **1.07 GB** |
| frontend | **75.3 MB** |
| `postgres:16` (upstream) | 642 MB |
| **Total pull/build footprint** | **≈ 1.79 GB** |

The backend image is the dominant cost — it carries a full Node toolchain and
the Prisma engines. *REASONED RECOMMENDATION:* a multi-stage build that drops
dev dependencies and unused Prisma engine binaries is the obvious reduction if
image size ever matters. Not attempted here; it is not a demonstration blocker.

## M5 — Database size · MEASURED

Seeded demonstration dataset: 3 ingested reports, 11 Findings, 3 cases,
1 notification, 149 audit rows.

| | |
|---|---|
| `pg_database_size('threatnexus_demo')` | **13,933,591 B (13.3 MB)** |

Largest relations (total size incl. indexes):

| Table | Size | Live rows |
|---|---|---|
| `AuditLog` | 216 kB | 149 |
| `CaseFrameworkMapping` | 144 kB | 1 |
| `IocEnrichment` | 128 kB | 11 |
| `RiskFactorContribution` | 112 kB | 200 |
| `CaseFinding` | 96 kB | 6 |
| `RiskScore` | 96 kB | 20 |

At this scale **the schema dominates and the data is negligible** — most tables
sit at PostgreSQL's minimum allocation regardless of row count.

## M6 — Controlled database growth · MEASURED

Measured on a scratch database (`threatnexus_growth_demo`) created and dropped
for this purpose, so the demonstration database was never touched.

| Stage | Size | Delta |
|---|---|---|
| Fresh database, no schema | 7,765,015 B (7.4 MB) | — |
| After all 25 migrations, **zero rows** | 11,238,423 B (10.7 MB) | **+3.47 MB** (schema) |
| Seeded demonstration dataset | 13,933,591 B (13.3 MB) | **+2.57 MB** (users + demo data) |

So **ThreatNeXus's own footprint above a bare PostgreSQL database is ≈ 6.2 MB**
for schema plus the full demonstration dataset.

*REASONED RECOMMENDATION:* the 2.57 MB attributable to the seed covers 3
reports / 11 Findings / 3 cases / 1 notification / 149 audit rows, and a large
share of it is fixed per-table allocation rather than per-row cost. It therefore
**must not** be divided by 11 to obtain a per-Finding figure. Per-row growth at
realistic volumes is dominated by `AuditLog`, `FindingOccurrence`,
`RawReportRow` and `RiskFactorContribution`, all of which are append-only.

**NOT LOAD-TESTED / SCALE ASSUMPTION:** no dataset larger than 11 Findings has
ever been loaded. Any statement about behaviour at thousands of Findings is an
assumption, not a measurement.

## M7 — Cold start · MEASURED

Backend container stopped, then started; timed until `GET /` returned HTTP 200.

| | |
|---|---|
| Cold start to first HTTP 200 | **12,286 ms (≈ 12.3 s)** |

Includes `npx prisma migrate deploy` (a no-op on an up-to-date database) plus
Node and Prisma client initialisation. A first-ever start that actually applies
25 migrations is longer.

## M8 — Development / test resource observation · MEASURED

| | |
|---|---|
| Backend suite | **3,460 passed, 240 skipped, 0 failed** (168 files) |
| Wall-clock duration | **100.33 s** |

The 240 skipped tests are the real-PostgreSQL suites, which gate on
`TEST_DATABASE_URL` and skip when it is unset. That is the documented baseline,
not a regression — but note that a green local run with those skipped is **not**
equivalent to CI.

## M9 — Frontend size · MEASURED

Built production bundle as served by nginx.

| | |
|---|---|
| Total served directory | **1.2 MB** |

| Asset | Bytes |
|---|---|
| `mui-*.js` | 351,919 |
| `index-*.js` | 291,663 |
| `react-*.js` | 221,073 |
| `motion-*.js` | 121,114 |
| `vendor-*.js` | 76,123 |
| `index-*.css` | 1,497 |
| `rolldown-runtime-*.js` | 694 |

Uncompressed, pre-gzip. MUI is the single largest chunk.

## M10 — Backup size and duration · MEASURED

Of the seeded demonstration database (13.3 MB logical).

| Method | Output size | Duration |
|---|---|---|
| `pg_dump -Fc` (custom format) | **265,382 B (259 kB)** | **1,131 ms** |
| `pg_dump \| gzip` (plain SQL) | **37,427 B (36.5 kB)** | **950 ms** |

Both complete in about a second at this scale. The custom format is ~7× larger
than gzipped plain SQL here because its per-object framing dominates at small
data volumes; the ordering would reverse on a large database.

*REASONED RECOMMENDATION:* `pg_dump -Fc` remains the better default despite the
size at this scale, because it supports selective and parallel restore. Backup
duration is not a constraint for this system.

---

## What is deliberately absent

- **No concurrency capacity figure.** No load test has been run.
- **No requests-per-second, latency percentile, or throughput figure.**
- **No multi-user sizing.** Every measurement above is single-operator.
- **No production deployment figures.** There is no production deployment;
  ThreatNeXus is a research prototype with a local compose stack only.
