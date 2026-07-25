# ThreatNeXus — Build Status

_Operational status / handoff note. Authoritative plan lives in
`../ThreatNeXus-Planning/` (read-only). This file is not a planning document._

## Current

- **Branch:** `feat/phase-1-ingestion`
- **Latest commit:** `4c4107d` — `feat(phase-1): add finding normalization/dedup/persistence/recurrence service (P1-T4)`
- **Phase:** 1 (Ingest → Finding). Phase 0 + pre-Phase-1 hardening are merged to `main` (PR #1, PR #2 / `87178cd`). No PR opened yet for this branch.

## Completed — P1-T4 (finding normalization, dedup, persistence, recurrence)

`backend/src/services/normalization/findingNormalizer.js` —
`normalizeAccessibleRdpFindingIdentity(validatorResult)`: pure function, takes
a VALID `accessibleRdpRowValidator` result and returns exactly
`{indicatorValue, port, protocol, reportType, observedAt}`. `observedAt`
comes from the row's own UTC-normalized timestamp (never upload time);
hostname/asn/as_name/country_code are deliberately excluded — never copied
onto a Finding. Throws `TypeError` for anything that isn't a VALID result.

`backend/src/services/normalization/dedupService.js` —
`recordFindingObservation({rawReportId, reportType, indicatorValue, port,
protocol, observedAt}, {client})`, run inside a single Prisma transaction:

- **Identity:** exactly `(indicatorValue, port, protocol, reportType)` — the
  schema's `finding_identity` composite unique constraint is the final
  concurrency authority.
- **New identity → CREATED**: Finding created OPEN, `firstSeen=lastSeen=
  observedAt`, `occurrenceCount=1`, `recurrenceCount=0`.
- **Existing OPEN, `observedAt >= lastSeen` → PERSISTED**: `lastSeen` and
  `firstSeen` move via MAX/MIN, `occurrenceCount += 1`, status/recurrence
  unchanged. Equal timestamp is **not** "before" — it is PERSISTED (documented
  tie-break).
- **Existing OPEN, `observedAt < lastSeen` → HISTORICAL**: out-of-order
  evidence; `firstSeen` may move backward via MIN, `lastSeen` never regresses
  (MAX), status stays OPEN, `occurrenceCount += 1`, `recurrenceCount`
  unchanged.
- **Existing CLOSED, `observedAt > closedThroughObservedAt` → RECURRED**:
  reopens — status → OPEN, `recurrenceCount += 1`, `occurrenceCount += 1`,
  `firstSeen`/`lastSeen` via MIN/MAX, and `closedAt`/`closedByUserId`/
  `closureReason`/`closedThroughObservedAt` are all cleared to `null` (see
  **Closure-field-clearing decision** below).
- **Existing CLOSED, `observedAt <= closedThroughObservedAt` → HISTORICAL**:
  does **not** reopen (equal timestamp included); `occurrenceCount += 1`,
  `firstSeen` may move backward, closure fields untouched.
- **CLOSED with no `closedThroughObservedAt`**: throws — a data-integrity
  violation, never guessed.
- **Occurrence semantics:** exactly one `FindingOccurrence` per
  `(findingId, rawReportId)` (`@@unique` is the authority). A second call
  for the same pair — duplicate rows in one report, a retried report, or a
  genuine idempotent replay — returns the existing occurrence unchanged with
  `idempotent: true` and **no** projection mutation (never a second
  `occurrenceCount`/`recurrenceCount` increment, never a second lifecycle
  action).
- **Concurrency:** Finding-create and FindingOccurrence-create races both
  resolve via catch-P2002-then-reload (same convention as
  `reportIdentityService.js`); a lost occurrence-create race never touches
  the projection a second time. `firstSeen`/`lastSeen` (no atomic MIN/MAX
  operator exists in Prisma) are updated via an optimistic-concurrency
  compare-and-swap on the existing `updatedAt` (`@updatedAt`) column through
  `updateMany({where:{id, updatedAt}})`, retried on a CAS miss — no schema
  change, no raw SQL, no advisory/application-global lock.
- Returns `{finding, occurrence, action, findingCreated, idempotent,
  recurrence, historical}`. No `AuditLog` writes here (no request/actor
  context) — the future ingestion-orchestration task uses this result to
  write aggregate events like `finding.reopened`.
- 26 unit tests across `findingNormalizer.test.js` (9) and
  `dedupService.test.js` (17, in-memory fake Prisma client — no real DB, no
  `backend/.env`), covering every lifecycle branch, idempotent replay,
  in-report duplicates, both P2002 races, the CAS-retry path, and input
  validation.

### Closure-field-clearing decision (durable)

On RECURRED, `closedAt`/`closedByUserId`/`closureReason`/
`closedThroughObservedAt` are all cleared to `null`. This was flagged by the
task packet as a design question ("stop if clearing would destroy the only
historical record of closure"). Resolution: no finding-close code path exists
yet anywhere in this repo (the status endpoint is future work), so these four
columns have never held anything but hypothetical state; per
`schema.prisma`'s own `FindingStatus` comment they describe *current* closure
state, evaluated only while a Finding is CLOSED. The permanent evidence of
record is (a) the immutable `FindingOccurrence` row this same call creates
(`action=RECURRED`, its `observedAt`), and (b) the `AuditLog` event the
future close-endpoint task will write at the moment of closing (with actor
context this module doesn't have). Clearing these four mutable projection
columns on reopen does not destroy either. Not re-litigated unless a
closure-history model is introduced later.

## Completed — P1-T2 (accessible-rdp.synthetic.v1 row validator)

`backend/src/services/ingestion/accessibleRdpRowValidator.js` — pure function,
no Prisma calls, no I/O. `validateAccessibleRdpRow(rawRow, rowNumber)` returns
`{ rowNumber, status, contractVersion, raw, normalized, errors }`; throws only
on caller contract violations (wrong types/shapes), never for expected
validation failures.

- **Required:** `timestamp` (RFC 3339, explicit UTC only — `Z` or `+00:00`;
  missing/wrong-offset tz → `TIMESTAMP_NOT_UTC`, unparseable/impossible
  calendar date → `INVALID_TIMESTAMP`; normalizes to canonical ISO), `ip`
  (strict IPv4, no leading-zero octets, rejects IPv6/CIDR/hostname/integer
  forms), `port` (1–65535, digits only, no sign/decimal/whitespace), `protocol`
  (case-insensitive `tcp` only, normalizes to `TransportProtocol.TCP`).
- **Optional:** `hostname` (trim, ≤253 chars, never identity), `asn` (plain or
  `AS`-prefixed integer, normalized to a plain integer, 0–4294967295, no
  leading zeros, never ownership truth), `as_name` (trim, ≤256 chars,
  non-authoritative), `country_code` (trim+uppercase, exactly 2 ASCII letters).
- **General safety (all fields):** null-byte rejection (`NULL_BYTE`), a 4096-char
  blanket length gate (`FIELD_TOO_LONG`) ahead of field-specific checks, no
  coercion/repair of a malformed field.
- **Stable error codes:** `REQUIRED_FIELD`, `INVALID_TIMESTAMP`,
  `TIMESTAMP_NOT_UTC`, `INVALID_IPV4`, `INVALID_PORT`, `INVALID_PROTOCOL`,
  `INVALID_ASN`, `INVALID_COUNTRY_CODE`, `FIELD_TOO_LONG`, `NULL_BYTE`.
- Five labelled synthetic fixtures in `backend/tests/fixtures/accessible-rdp/`
  (valid, mixed-validity, in-report duplicates, IPv4/port boundaries, one row
  per invalid case) — dev/test only, **not** the ground-truth dataset.
- 64 unit tests in `backend/tests/unit/accessibleRdpRowValidator.test.js`.

## Completed — P1-T3 (raw-report identity & retry classification)

`backend/src/services/ingestion/reportIdentityService.js`:

- `computeSourceFileSha256(buffer)` — lowercase hex SHA-256 of exact bytes
  only (Buffer required; throws `TypeError` otherwise); never hashes a
  filename or parsed row value.
- `classifyExistingRawReport(existingReport)` / `classifyRawReportStatus`
  map an existing `RawReport.status` (or absence) to one of `NEW_FILE`,
  `DUPLICATE_COMPLETED` (`COMPLETED` / `PARTIALLY_VALID` / `REJECTED` — all
  terminal and deterministic for identical bytes; **`REJECTED` is a
  no-op duplicate, not retryable**, since the same bytes would fail
  structurally again), `RETRYABLE_FAILED` (`FAILED`), `RETRYABLE_RECEIVED`
  (`RECEIVED`), `DUPLICATE_IN_PROGRESS` (`PROCESSING` — **stale-processing
  policy is explicitly deferred**; no approved timeout exists in this repo,
  so `PROCESSING` is never inferred retryable). Throws on an unrecognized
  status rather than guessing.
- `resolveRawReportIdentity(fileBytes, { client })` — read-only sha256 lookup
  + classification.
- `createRawReportRecordOrResolveExisting(createData, { client })` — the
  reusable P2002-race handler: the DB unique constraint on
  `sourceFileSha256` is the final concurrency authority; a conflicting
  create reloads and classifies the existing row instead of erroring or
  creating a second row. Never mutates the existing row. Non-P2002 failures
  and a P2002-with-no-row-on-reload both propagate rather than being
  swallowed.
- Deliberately **no HTTP route, no multer wiring, no CSV/ingestion
  orchestration** — this is the narrow identity/concurrency primitive a
  later ingestion task will call.
- **Audit logging deferred by design**: this is a context-free primitive
  (no `req`/actor), matching the existing convention that low-level
  service/lib helpers (e.g. `fileCleanup.js`) don't self-audit — the future
  ingestion-orchestration task adds the `AuditLog` event for the RawReport
  create path, using this service's classification as an input.
- 27 unit tests in `backend/tests/unit/reportIdentityService.test.js`, all
  against a stubbed Prisma client (no `backend/.env`, no real database).

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

P1-T1: `prisma format` · `prisma validate` · `prisma migrate status` (9
migrations, in sync) · migration applied to disposable local Postgres.

P1-T2 + P1-T3: `npx prisma validate` (schema untouched — no migration in this
task, as required) · full backend suite **576/576** (was 485; +91 new: 64
validator + 27 identity-service, run with `backend/.env` absent — see
blocker) · `git diff --cached --check` clean (only expected LF→CRLF autocrlf
notices, no real whitespace errors) · diffs reviewed.

P1-T4 (this round): `npx prisma validate` (schema untouched, no migration
generated) · full backend suite **602/602** (was 576; +26 new: 9 normalizer +
17 dedup-service, `backend/.env` absent) · `git diff --check` clean · diff
and status reviewed.

## Blocker / local-env note

`env.test.js` asserts `loadEnv()` throws on missing vars, which requires **no
`backend/.env` file on disk** — `dotenv.config()` reloads it otherwise and 2
tests fail. Keep the documented convention: **do not create `backend/.env`**;
export `DATABASE_URL` inline for prisma commands. The Vitest suite stubs Prisma
and needs no database. Local dev DB for P1-T1 was docker compose service
`threatnexus-postgres` (matches `.env.example` defaults); P1-T2/P1-T3 needed
no database at all (pure function + stubbed-Prisma unit tests only).

## Deferred decisions (not durable architecture decisions — flagged for review)

- **Stale `PROCESSING` policy**: no approved timeout/config exists yet, so
  `reportIdentityService` reports `DUPLICATE_IN_PROGRESS` rather than
  guessing a retry rule. A future task should define and configure one.
- **Audit logging for the RawReport create path**: not added to
  `createRawReportRecordOrResolveExisting` (it has no request/actor
  context). Belongs to the future ingestion-orchestration task, which will
  have that context — see the code comment in `reportIdentityService.js`.
- **Fixture location**: `backend/tests/fixtures/accessible-rdp/` (scoped to
  this backend's unit tests) rather than the top-level `data/synthetic/`
  target layout in `BUILD_PLAN.md`, which is reserved for the separate,
  critical-path ground-truth dataset deliverable — avoids collision with
  that teammate track.
- **ASN dual-form acceptance** (plain integer or `AS`-prefixed, normalized
  to a plain integer): no prior repo convention existed either way; chosen
  as the more permissive, still-conservative reading of the synthetic-v1
  contract's "if approved project conventions support both" clause.
- **Closure-field clearing on RECURRED** (P1-T4): `closedAt`,
  `closedByUserId`, `closureReason`, `closedThroughObservedAt` are all set to
  `null` when a CLOSED finding reopens. See "Closure-field-clearing decision"
  above — resolved, not blocked, but flagged here since it reads live Finding
  columns a not-yet-built close endpoint will also write.
- **`updatedAt`-based optimistic concurrency for `firstSeen`/`lastSeen`**
  (P1-T4): Prisma has no atomic MIN/MAX field operator, so concurrent updates
  to the same existing Finding's `firstSeen`/`lastSeen` from two different
  reports are serialized via a compare-and-swap on the existing `updatedAt`
  column (`updateMany({where:{id, updatedAt}})`, retried on a miss) rather
  than raw SQL or a new lock primitive. `occurrenceCount`/`recurrenceCount`
  double-increment for the *same* report is separately, and more simply,
  prevented by the `FindingOccurrence` unique constraint (P2002 → reload,
  never re-touch the projection) — that path needed no CAS.

## Exact next task — P1-T5

Parser/route wiring is still out of scope per the P1-T2/P1-T3/P1-T4 task
packets. The next task is the CSV parser/report ingestion orchestration that:
streams a report through `multer` + `csv-parser`, calls
`validateAccessibleRdpRow` per row, `createRawReportRecordOrResolveExisting`
for the file-identity step, `normalizeAccessibleRdpFindingIdentity` +
`recordFindingObservation` per valid row for dedup/persistence/recurrence,
and persists `RawReportRow` evidence (valid, invalid, and — pointing at the
resulting `FindingOccurrence` — duplicate-in-report rows). This is also where
the `AuditLog` events for the RawReport-create path and for
`finding.reopened` belong (both deferred above and in the P1-T4 section).
