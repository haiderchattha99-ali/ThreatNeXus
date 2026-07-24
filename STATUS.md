# ThreatNeXus — Build Status

_Operational status / handoff note. Authoritative plan lives in
`../ThreatNeXus-Planning/` (read-only). This file is not a planning document._

## Current

- **Branch:** `feat/phase-1-ingestion`
- **Latest commit:** `36bff37` — `feat(phase-1): add ingestion & finding-lifecycle schema foundation (P1-T1)`
- **Phase:** 1 (Ingest → Finding). Phase 0 + pre-Phase-1 hardening are merged to `main` (PR #1, PR #2 / `87178cd`).

## Completed — P1-T1 (schema & migration foundation only)

Additive Prisma schema for the Phase 1 ingestion spine. No routes, controllers,
parsers, or services (those are later Phase 1 tasks).

- **Enums:** `ReportType`, `TransportProtocol`, `RawReportStatus`,
  `RawReportRowStatus`, `FindingStatus`, `FindingOccurrenceAction`.
- **Models:** `RawReport`, `RawReportRow`, `Finding`, `FindingOccurrence`.
- **Finding identity:** composite unique `(indicatorValue, port, protocol, reportType)`.
- **Evidence safety:** `RawReport.sourceFileSha256` globally unique (idempotent
  retry / concurrent-duplicate protection); conservative FKs — `SetNull` on User
  actor refs, `Restrict` on all evidence relations (no cascade-delete of evidence).
- **Migration:** `20260724123330_add_phase1_ingestion_finding_lifecycle`
  (CREATE TYPE/TABLE/INDEX + ADD FOREIGN KEY only; no ALTER/DROP on existing
  tables, no data transformation).

## Checks (all passed)

`prisma format` · `prisma validate` · `prisma migrate status` (9 migrations, in
sync) · migration applied to disposable local Postgres · full backend suite
**485/485** (run with `backend/.env` absent — see blocker) · `git diff --check`
clean.

## Blocker / local-env note

`env.test.js` asserts `loadEnv()` throws on missing vars, which requires **no
`backend/.env` file on disk** — `dotenv.config()` reloads it otherwise and 2
tests fail. Keep the documented convention: **do not create `backend/.env`**;
export `DATABASE_URL` inline for prisma commands. The Vitest suite stubs Prisma
and needs no database. Local dev DB for this session: docker compose service
`threatnexus-postgres` (matches `.env.example` defaults), migration applied.

## Exact next task — P1-T2

Row validator implementing the synthetic Accessible-RDP contract
(`accessible-rdp.synthetic.v1`: IPv4-only, RFC 3339 UTC `timestamp`, `port`
1–65535, `protocol` tcp; required `timestamp,ip,port,protocol`; optional
`hostname,asn,as_name,country_code`) as a pure-function module, with unit tests
and synthetic fixtures. No parser wiring yet.
