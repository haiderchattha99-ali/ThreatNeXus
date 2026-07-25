# ThreatNeXus — Build Status

_Operational status / handoff note. Authoritative plan lives in
`../ThreatNeXus-Planning/` (read-only). This file is not a planning document._

## Current

- **Branch:** `feat/phase-1-ingestion`
- **Latest commit:** `3e2cef2` — `fix(phase-1): repair P1-T4 concurrency — serializable tx + whole-transaction retry` (P1-T4 itself: `4c4107d`)
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
- **Concurrency:** see **P1-T4 concurrency repair** below — the original
  approach was defective and has been replaced.
- **Input contract:** `reportType` and `protocol` are validated against
  `Object.values(ReportType)` / `Object.values(TransportProtocol)` (derived
  from the generated Prisma enums, so the allow-list cannot drift from the
  schema) **before** Prisma is touched. An out-of-contract value is a
  controlled `TypeError`, not a database enum error.
- Returns `{finding, occurrence, action, findingCreated, idempotent,
  recurrence, historical}`, where `finding` is the **actual committed
  post-update row**. No `AuditLog` writes here (no request/actor context) —
  the future ingestion-orchestration task uses this result to write aggregate
  events like `finding.reopened`.

## P1-T4 concurrency repair (supersedes the original P1-T4 concurrency design)

The first P1-T4 implementation shipped two concurrency defects that its
stubbed-Prisma unit tests could not detect. Both were reproduced against real
PostgreSQL 16 + Prisma 6.19.3 before being fixed, and the integration suite
below fails against the old implementation and passes against the new one.

### Defects (both empirically reproduced, not theoretical)

1. **P2002 caught inside an interactive transaction, then the same `tx`
   re-queried.** On PostgreSQL a constraint violation aborts the surrounding
   transaction; every later statement fails with SQLSTATE **25P02**
   (`current transaction is aborted, commands ignored until end of transaction
   block`). Prisma surfaces that as `PrismaClientUnknownRequestError` with
   **`code: undefined`**, so the old `catch (P2002) -> re-query` path did not
   merely fail to recover — it turned a recoverable race into an opaque error.
   The same pattern is safe in `reportIdentityService.js` (P1-T3) *only*
   because there is no enclosing transaction there; carrying the convention
   into a transaction inverted its correctness.
2. **`recurrenceCount` double-increment.** The old CAS retry reused the stale
   `RECURRED` action after reloading, so two concurrent reports observing one
   CLOSED Finding both applied a recurrence — observed as
   `recurrenceCount = 2` for a single CLOSED → OPEN transition.

Contributing: `updatedAt` is `TIMESTAMP(3)`, so it is not a safe version token
(equal-millisecond writes allow a lost update); the lifecycle action was not
recomputed on retry; the returned Finding carried a stale `updatedAt`; and the
CAS failed *open* if `updatedAt` was absent.

### Implemented strategy

- The whole read-decide-write runs in **one Prisma interactive transaction at
  `Serializable` isolation** (`$transaction(fn, {isolationLevel:
  "Serializable"})` — supported by Prisma 6.19.3, no schema change).
- **No error is ever caught inside the transaction.** Both former in-`tx`
  catch blocks are gone, so a query is never issued on an aborted transaction.
- **Whole-transaction retry:** a recognised concurrency error propagates out of
  the transaction and the **entire** transaction is re-run from the start, up
  to `MAX_TRANSACTION_ATTEMPTS = 5`. Every attempt reloads the Finding,
  re-checks for an existing occurrence, and **recomputes the lifecycle action
  from freshly committed state** — which is exactly what prevents defect 2: the
  loser of a recurrence race re-reads the now-OPEN Finding and reclassifies as
  PERSISTED/HISTORICAL instead of applying a second recurrence.
- **Retryable-error policy — exactly two codes:** `P2002` (uniqueness race;
  re-running makes the winning row visible to our own read) and `P2034`
  (write conflict / deadlock — verified to be what PostgreSQL `40001`
  serialization failures surface as via this Prisma version). Everything else
  propagates untouched and is **never** retried: validation/programmer
  `TypeError`s, the CLOSED-without-`closedThroughObservedAt` data-integrity
  error, connection failures, and notably any error with `code: undefined`
  (the 25P02 signature). If a retryable code still escapes, the bounded
  retries were exhausted and the original Prisma error is re-thrown unchanged.
- The `updatedAt` compare-and-swap loop is **removed**. Under SERIALIZABLE,
  PostgreSQL rejects a conflicting concurrent writer rather than letting a
  stale read-modify-write land, so a plain read plus a plain `update` is safe.
  No version column, no raw SQL, no advisory lock, no queue or global lock,
  and no sequential-only assumption.
- The projection update returns the **actual committed row**, so callers never
  see a stale projection or `updatedAt`.

### Tests

- **36 unit tests** (`findingNormalizer.test.js` 9, `dedupService.test.js` 27)
  against an in-memory fake that now models **rollback-on-throw**, so the
  whole-transaction retry path is exercised honestly. The file carries an
  explicit scope note: these prove decision logic, **not** PostgreSQL
  transaction semantics.
- **5 real-PostgreSQL integration tests** —
  `backend/tests/integration/dedupServiceConcurrency.test.js`: concurrent
  new-Finding race; concurrent recurrence race; same-report occurrence race;
  rollback integrity (real transaction, projection update forced to throw
  after the occurrence INSERT); out-of-order concurrency. They **self-skip**
  unless `TEST_DATABASE_URL` is set, so the default `vitest run` stays green
  with no database and no `backend/.env`. Rows are scoped by a marker and
  cleaned up deterministically (occurrences → findings → raw reports, honoring
  the `Restrict` FKs); addresses are RFC 5737 TEST-NET-2. The connection URL
  comes from the environment and is never committed or echoed.

### Remaining limitation

Retries are bounded at 5 with **no backoff** — adequate here because each
retry re-reads committed state, and verified to converge under the concurrent
scenarios above, but sustained heavy contention on one Finding could exhaust
the budget and surface `P2034` to the caller. P1-T5 should treat a `P2034`
escaping this service as a per-row ingestion failure (the row is recorded as
evidence; the transaction committed nothing), not as a crash.

### BINDING future requirement — manual Finding close endpoint

When the manual Finding close endpoint is implemented, it **must** write an
`AuditLog` event preserving the prior closure state (actor, time, reason)
before recurrence is ever able to clear those active closure fields.
`AuditLog.before`/`after` (Json) already exist for exactly this. Recurrence
clears `closedAt`/`closedByUserId`/`closureReason`/`closedThroughObservedAt`,
so without that audit event the closure would leave no durable record. This is
a hard precondition on the close-endpoint task, not a suggestion.

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

**This decision is conditional**, and the condition is now recorded as a
binding requirement — see *BINDING future requirement — manual Finding close
endpoint* above. (b) does not exist yet; if the close endpoint ships without
that `AuditLog` event, this decision becomes retroactive evidence loss.

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

P1-T4: `npx prisma validate` (schema untouched, no migration generated) · full
backend suite **602/602** (was 576; +26 new) · `git diff --check` clean · diff
and status reviewed.

P1-T4 concurrency repair (this round): `npx prisma validate` clean · **no
migration generated** (`backend/prisma` untouched) · full backend suite
**612 passed, 5 skipped** with no database (integration self-skips;
`backend/.env` absent) · targeted unit + integration run against a disposable
PostgreSQL: **41/41** (36 unit + 5 real-DB) · **regression proof:** the 5
integration tests were run against the pre-repair implementation and all 5
failed — three with the live `25P02 current transaction is aborted` error and
one with `recurrenceCount expected 2 to be 1` — confirming the tests detect
both original defects rather than merely passing · `git diff --check` clean
(only expected LF→CRLF autocrlf notices) · diff and status reviewed.

## Blocker / local-env note

`env.test.js` asserts `loadEnv()` throws on missing vars, which requires **no
`backend/.env` file on disk** — `dotenv.config()` reloads it otherwise and 2
tests fail. Keep the documented convention: **do not create `backend/.env`**;
export `DATABASE_URL` inline for prisma commands. The Vitest suite stubs Prisma
and needs no database. Local dev DB for P1-T1 was docker compose service
`threatnexus-postgres` (matches `.env.example` defaults); P1-T2/P1-T3 needed
no database at all (pure function + stubbed-Prisma unit tests only).

**Real-database tests (added by the P1-T4 concurrency repair).** The
concurrency integration suite needs a live PostgreSQL and self-skips without
one, so `npm test` still passes on a bare checkout. To run it, start the
compose `postgres` service and use a **dedicated disposable database**
(`threatnexus_test`, created alongside the dev `threatnexus` database, which is
never reset by these tests), apply the existing migrations to it with
`prisma migrate deploy` (applies only — never generates), and pass the URL
inline as `TEST_DATABASE_URL` for the vitest invocation. The URL is supplied by
the environment only: it is not committed, not written into any repo file, and
not echoed by the tests. Still **no `backend/.env`**.

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
- ~~**`updatedAt`-based optimistic concurrency for `firstSeen`/`lastSeen`**~~
  — **withdrawn.** `updatedAt` is `TIMESTAMP(3)` and is not a safe version
  token. Replaced by SERIALIZABLE isolation + whole-transaction retry; see
  *P1-T4 concurrency repair*.
- **No-backoff bounded retry** (P1-T4 repair): 5 whole-transaction attempts,
  no delay between them. Verified to converge under the tested concurrent
  scenarios; sustained contention on a single Finding could still exhaust the
  budget and surface `P2034`. P1-T5 must treat that as a per-row ingestion
  failure rather than a crash.
- **`FindingOccurrence.observedAt` source**: currently the row's own
  timestamp, while `RawReport.observationDate` exists separately. P1-T5 should
  state which is authoritative and keep the two consistent.

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
