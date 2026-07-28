# ThreatNeXus — Build Status

_Operational status / handoff note. Authoritative plan lives in
`../ThreatNeXus-Planning/` (read-only). This file is not a planning document._

## Current

- **Branch:** `feat/phase-2-enrichment-risk` — pushed, not yet merged (no PR opened per the P2-T1 task
  scope; Phase 1 remains merged into `main`, see "Phase 1 release audit" below).
- **Phase:** Phase 1 (Ingest → Finding) is **complete, gate-complete, audited and merged**. Phase 2's
  first task, **P2-T1 (ownership mapping)**, is **complete** — see "Completed — P2-T1" below.
  **P2-H1 (ownership correctness + test hardening)** is also **complete** — see "Completed — P2-H1"
  below. **P2-T2a (IOC enrichment provider contract + MockProvider)** is **complete** — see
  "Completed — P2-T2a" below. **P2-T2b (`IocEnrichment` schema, migration, durable cache/queue)** is
  also **complete** — see "Completed — P2-T2b" below. **P2-T2c (real `AbuseIPDBProvider` + TTL
  policy)** is also **complete** — see "Completed — P2-T2c" below.
- **Next task: P2-T2d — bounded enrichment runner and queue completion integration.** The provider
  and the TTL policy now both exist as pure/injectable modules, but **nothing calls either of them
  from the queue layer yet**: no worker/runner claims a `PENDING` job, calls `AbuseIPDBProvider.lookup`
  outside a transaction, applies `resolveEnrichmentTtl` to the result, and completes the claim; no
  ingestion wiring, no routes/controllers/RBAC, and no audit events on any enrichment path. See
  "Completed — P2-T2c" for exactly what this packet did and did not build.

## Completed — P2-T1 (ownership mapping, deterministic resolution, analyst override)

Additive schema + full resolution pipeline for `AssetMapping` (the IP/CIDR/ASN → Organization
registry) and `FindingOwnership` (append-only per-Finding resolution history), wired into ingestion
and exposed through capability-guarded management APIs. Full decision record: `DECISIONS.md` D-006.

**Migration:** `20260727073537_add_phase2_ownership_mapping` — one additive migration (`CREATE
TYPE`/`ALTER TABLE ADD COLUMN`/`CREATE TABLE`/`CREATE INDEX`/`ADD FOREIGN KEY` only; no raw SQL, no
partial index, no destructive change). Adds `Organization.sector` (default `UNKNOWN`), `AssetMapping`,
`FindingOwnership`, and five new enums (`OrganizationSector`, `AssetMappingType`,
`AssetMappingSource`, `OwnershipConfidence`, `OwnershipResolutionStatus`).

**IPv4/CIDR arithmetic** (`backend/src/services/ownership/ipv4Cidr.js`, pure, no Prisma): strict
four-octet parsing (rejects leading zeros, signs, whitespace, hex, IPv6, CIDR-suffixed and hostname
forms), BigInt throughout so no signed-32-bit trap exists for addresses ≥ `128.0.0.0`, `cidrToRange`/
`rangeContains`/`canonicalizeCidr` for range math, `intToIpv4` as the one function every API response
path must go through so a raw BigInt can never reach a client. 33 unit tests.

**Ownership resolver** (`ownershipResolver.js`, pure, no Prisma): `resolveOwnership({indicatorValue,
asn, asOf}, {mappings, currentOverride})`. Fixed precedence — override → exact IP → longest-prefix
CIDR → ASN → unresolved (see D-006 for the exact ambiguity/confidence rules). 29 unit tests covering
precedence, longest-prefix tie-breaking, duplicate-mapping-is-not-ambiguity, the exact confidence
table, activity-window boundaries (validFrom inclusive / validUntil exclusive), and array-order
independence.

**AssetMapping registry** (`assetMappingService.js`): create/update/disable/list, with every
type-coherence rule (`EXACT_IP` requires exactly one strict IPv4; `CIDR` requires one canonical
CIDR + derived range; `ASN` requires one positive integer; irrelevant fields always null;
`validUntil` cannot precede `validFrom`) enforced at the service boundary — Prisma/Postgres cannot
express the underlying "exactly one of three field groups" rule as a portable CHECK without raw SQL.
Never hard-deletes; `disableAssetMapping` only flips `enabled`. 28 unit tests.

**FindingOwnership resolution + override service** (`findingOwnershipService.js`): `resolveOneFinding`,
`reResolveFindingsForMapping`, `applyOverride`, `clearOverride`, `getFindingOwnership`,
`calculateCoverage`. The current-row invariant uses `currentForFindingId Int? @unique` — Postgres
treats multiple NULLs in a unique column as distinct, so no raw SQL or partial index was needed (see
D-006). Supersede-then-insert runs inside one SERIALIZABLE transaction with bounded whole-transaction
retry on P2002/P2034, mirroring the P1-T4 dedup-service concurrency repair exactly, for the same
reason (a caught constraint violation leaves the surrounding transaction aborted on Postgres).
Re-resolving to an identical effective outcome writes nothing. `applyOverride`/`clearOverride` always
write a new row (an explicit analyst action with its own justification is never deduplicated against
the current outcome) and `clearOverride` reverts to whatever the automatic resolver currently produces
— never unconditionally back to `UNRESOLVED`. Coverage reports every category separately (resolved by
exact IP, by CIDR, by override, ISP/ASN attribution, ambiguous, unresolved, confirmed-mapping share)
— never one collapsed "percentage mapped" figure, per `BUILD_PLAN.md`. 20 unit tests.

**Ingestion integration** (`reportIngestionService.js`): after each Finding group's
`recordFindingObservation` call commits (dedupService's own transaction has already closed by then),
`resolveOwnershipSafely` runs sequentially, passing the canonical row's own observed ASN. Any failure
is caught and never reaches the ingestion pipeline's own try/catch — `resolveOneFinding` already
writes its own `ownership.resolution.failed` audit event before rethrowing; this second catch exists
purely so that rethrow can never misclassify a pure ownership failure as a report-level `FAILED`
outcome. Idempotent report replay creates no duplicate ownership history (proven against real
PostgreSQL — see below).

**APIs** (capability-guarded, router-level, mounted at `/api/ownership` and `/api/findings`):
`GET/POST /api/ownership/mappings`, `PATCH /api/ownership/mappings/:id`,
`POST /api/ownership/mappings/:id/disable`, `GET /api/ownership/coverage`,
`GET /api/findings/:id/ownership`, `PUT/DELETE /api/findings/:id/ownership/override`. No hard DELETE
route exists. Mapping lists are paginated (`page`/`pageSize`, capped at 100). Every response goes
through a serializer that never emits a raw `ipStart`/`ipEnd` BigInt.

**Capabilities** (`lib/roles.js`, additive, non-hierarchical): `manage:ownership-mappings` (ADMIN
only — mapping registry mutations) and `override:finding-ownership` (ADMIN + ANALYST — Finding
override apply/clear). Reads (mapping list, coverage, finding ownership) reuse `read:findings`, held
by all four roles, matching the existing Phase 0/1 convention that reads are broad and writes are
capability-scoped.

**Audits:** `ownership.mapping.created/updated/disabled` (written by the controller, mirroring
`organizationController`'s pattern — `assetMappingService` itself has no audit side effects);
`ownership.override.applied/cleared` and `ownership.resolution.changed/failed` (written by
`findingOwnershipService` itself, since both the ingestion path and the manual API path need the same
audit behaviour on both success and failure). All payloads are ids/codes/counts/bounded previews only
— never a BigInt, never the full mapping registry, never raw evidence.

**Accepted limitation:** ASN is not persisted on `Finding` or `FindingOwnership` (Phase 1's `asn` was
already deliberately non-authoritative). ASN-tier resolution is only exercised at ingestion time, when
the row's ASN is still in memory; `reResolveFindingsForMapping` skips ASN-type mapping changes
explicitly (`skipped: true, reason: "ASN_NOT_PERSISTED_ON_FINDING"`) rather than silently doing
nothing. See D-006.

**Real-database regression found and fixed (pre-existing Phase 1 test infrastructure, not production
code):** `reportIngestionConcurrency.test.js` and `eval/run_phase1_gate.js` both clean up their real-DB
test state by deleting `Finding` rows directly. Once ingestion started writing `FindingOwnership` rows
(`onDelete: Restrict` on `findingId`), those two cleanups began failing with a foreign-key violation,
which — because the failure happened mid-cleanup, after `FindingOccurrence`/`RawReportRow` deletion but
before `Finding` deletion — silently left orphaned `Finding` rows across repeated local runs (caught by
noticing `occurrenceCount` on a fixed synthetic IP had drifted to match the exact number of times the
suite had been re-run). Fixed by adding one additive `findingOwnership.deleteMany` line to each
cleanup, in the same scoped-id-set style already used for every other model there. Confirmed the fix:
stale rows manually cleared, both suites re-run together 3× with no recurrence.

### Tests

- **145 new unit tests**: 33 (`ipv4Cidr.test.js`) + 29 (`ownershipResolver.test.js`) + 28
  (`assetMappingService.test.js`) + 20 (`findingOwnershipService.test.js`) + 2 new + 3 amended
  (`roles.test.js`, P2-T1 capability grants) + existing-file coverage. All against pure functions or
  an in-memory fake Prisma client — see each file's scope note for what they do and do not prove.
- **37 route/RBAC tests** (`ownershipRouteAuthorization.test.js`): the full read/write matrix across
  ADMIN/ANALYST/REVIEWER/VIEWER for every ownership endpoint; unauthenticated → 401; denied → 403
  before any mutation with an `authorization.denied` audit and no capability name leaked in the
  response; invalid mapping payloads rejected with 400 and no row created; no hard DELETE route;
  pagination bounded even when a huge `pageSize` is requested; no BigInt ever reaches a JSON response.
- **10 real-PostgreSQL tests** (`ownershipConcurrency.test.js`, self-skips without
  `TEST_DATABASE_URL`): append-only supersede (superseded row's substantive fields untouched);
  identical re-resolution writes nothing; three concurrent `resolveOneFinding` calls leave exactly one
  current row; `AssetMapping`/`Organization` FK `Restrict` enforcement; override apply/clear real
  history; re-resolution after a real mapping-validity change; CIDR longest-prefix match via actual
  Postgres `bigint` columns (not the in-memory fake); full ingestion integration; idempotent report
  replay writes no duplicate history. Run 3× back-to-back with no flakiness, both alone and combined
  with the existing P1-T4/P1-T5 real-DB suites.
- **Full backend suite:** **893 passed / 26 skipped** with no database (stable across 2 runs); **917
  passed / 2 skipped** (only `phase1Gate.test.js`, which needs `EVAL_DATABASE_URL` specifically) with
  `TEST_DATABASE_URL` set, run 4× — 3 clean, 1 run hit the single already-documented pre-existing
  `dedupServiceConcurrency` out-of-order flake under heavy combined real-DB load (STATUS.md's own
  "no-backoff bounded retry" limitation from the P1-T4 concurrency repair — reproduced standalone as
  1/1 passing, confirming it is that known class of flake, not a P2-T1 regression, and `dedupService.js`
  is untouched by this task).
- **Phase 1 evaluator:** `npm run eval:phase1` — **9/9 PASS**, unchanged, confirming P2-T1 introduced
  no Phase 1 lifecycle regression.

## Completed — P2-H1 (ownership correctness + test hardening)

Small corrective packet, prompted by the P2-T1 audit's non-blocking risks, before starting P2-T2a.
No schema/migration change, no frontend change, no re-resolution/precedence redesign.

**Coverage classification bug fixed** (`findingOwnershipService.js`'s `calculateCoverage`): the
category ladder checked `row.isIspAttribution` before `row.status`, so a `FindingOwnership` row that
was both `AMBIGUOUS` *and* `isIspAttribution: true` — the real state produced when two organizations
map to the same ASN (`ownershipResolver.js`'s `decideAtTier` ASN tier) — was counted as a settled ISP
attribution instead of ambiguous. Fixed by reordering the ladder to check status first
(`OVERRIDDEN` → `AMBIGUOUS` → `UNRESOLVED` → then, only for `RESOLVED`, `isIspAttribution` → exact-IP
→ CIDR), and added an explicit `unknown` bucket (additive field, always `0` today) so any future
unrecognised state fails closed into a visible count rather than silently vanishing from the totals.
New regression test in `findingOwnershipService.test.js` seeds two organizations on one ASN and
asserts `coverage.ambiguous === 1`, `coverage.ispAttribution === 0`, `coverage.unknown === 0`.

**PostgreSQL FK `Restrict` test repaired** (`ownershipConcurrency.test.js` test 5): the old test's
comment claimed the mapping was "disabled" before the second delete attempt but never disabled or
removed it, so both delete attempts failed for the same reason (`AssetMapping.organizationId`
Restrict) and the test never actually exercised `FindingOwnership.organizationId`'s own Restrict
relation. Split into two independent tests: **5a** creates only an `AssetMapping` (no Finding/
ownership at all) and proves `AssetMapping.organizationId Restrict` alone blocks Organization
deletion; **5b** hard-deletes an unresolved, never-referenced `AssetMapping` (proving `AssetMapping`
no longer blocks anything for that org), then writes a `FindingOwnership` row via `applyOverride`
(`matchedMappingId` null — no `AssetMapping` involved) and proves `FindingOwnership.organizationId
Restrict` alone still blocks deletion. Each test fails if its respective FK is removed.

**CIDR confidence-table tests repaired** (`ownershipResolver.test.js`): several `it.each` rows used a
fixed indicator (`203.0.113.10`) against a CIDR that didn't actually contain it (e.g. `203.0.0.0/23`,
`128.0.0.0/15`), so `resolveOwnership` returned `UNRESOLVED`, the test's early-return guard fired, and
the row asserted nothing while still reporting PASS. Replaced with six indicator/CIDR pairs, each
chosen so the indicator genuinely falls inside the CIDR, covering the required boundaries (`/32`,
`/24` → HIGH; `/23`, `/16` → MEDIUM; `/15`, `/0` → LOW); every row now asserts `status`,
`organizationId`, `confidence`, `matchedPrefixLength`, and `isIspAttribution === false`.

**Ingestion ownership-failure isolation proven** (`reportIngestionService.test.js`, two new unit
tests): inject a failure into the `findingOwnership` model *after* the Finding-lifecycle transaction
has already committed (mirroring `resolveOwnershipSafely`'s real call site). Both a fully-valid and a
partially-valid report still reach `PROCESSED`/`COMPLETED`/`PARTIALLY_VALID` as appropriate, every
already-written `RawReportRow`/`Finding`/`FindingOccurrence` survives untouched and the valid row is
never reclassified as `INVALID`, `findingOwnership.create` is never called (no partially-written
history), the designed `ownership.resolution.failed` audit event fires exactly once, and the raw
injected error text never appears anywhere in the audit log.

### Deferred (non-blocking, tracked for a future Opus-supervised packet — not part of this gate)

- Automatic re-resolution after an `AssetMapping` create/update/disable (C-1/C-2 from the P2-T1 audit).
- Query pushdown for selecting affected Findings on a mapping change (currently full-table scan +
  in-memory filter in `reResolveFindingsForMapping`).
- `Organization.sector` API exposure.
- Retry backoff for the bounded whole-transaction retry (still no-backoff, same as P1-T4's dedup
  service).
- Removal of `AssetMappingSource.ANALYST_OVERRIDE`.

### Verification

- Targeted: `findingOwnershipService.test.js`, `ownershipResolver.test.js`, `reportIngestionService.test.js` — all pass.
- Real PostgreSQL: `ownershipConcurrency.test.js` — **11/11 PASS** (was 10; test 5 split into 5a/5b).
- Full backend suite (with `TEST_DATABASE_URL` set): **920 passed / 2 skipped** (the 2 skips are
  `phase1Gate.test.js`, which needs `EVAL_DATABASE_URL` specifically).
- Phase 1 evaluator: `npm run eval:phase1` — **9/9 PASS**, unchanged.
- `npx prisma validate` — clean. Migration count unchanged at 10 (no migration generated).
- `git diff --check` — clean (only benign CRLF-normalization notices, no real whitespace/conflict issues).

## Completed — P2-T2a (IOC enrichment provider contract + MockProvider)

Establishes a stable, provider-neutral boundary for IOC reputation enrichment (`backend/src/services/
enrichment/`) and a deterministic offline `MockProvider`. **No persistence, no HTTP calls, no cache,
no ingestion wiring, no migration** — this packet is the interface AbuseIPDB will implement against in
a future packet (P2-T2b builds the durable `IocEnrichment` schema/queue/cache first). Decision record:
`DECISIONS.md` D-002 (unchanged — this packet implements what D-002 already approved, no new decision).

**Files:**
- `iocEnrichmentTypes.js` — pure status/error taxonomy plus `createEnrichmentResult`, the single choke
  point every provider result passes through. Validates every invariant (score/report-count bounds,
  closed error code/message map, status/data/errorInfo consistency, bounded text fields, retryAfterSeconds
  bounds, httpStatus bounds, a `maxAgeInDays`-only queryParams allow-list) and returns a deep-frozen,
  defensively-copied result. Throws `TypeError` on any contract violation.
- `iocEnrichmentProvider.js` — documents the `{name, supports(), lookup()}` contract every provider
  must implement, `isSupportedIocIndicator` (reuses `ownership/ipv4Cidr.js`'s strict IPv4 parser —
  no second, weaker implementation), and `assertImplementsIocEnrichmentProvider` (a minimal runtime
  shape check the registry uses before trusting a provider).
- `mockIocEnrichmentProvider.js` — deterministic, offline, zero network access. Fixture-configured per
  indicator; `asOf` (always explicit, caller-supplied) is the only source of `queriedAt` — no wall-clock
  read anywhere. An unknown, otherwise-valid IPv4 defaults to `NOT_FOUND` (configurable).
- `providerRegistry.js` — small immutable code-level registry mirroring `reportSourceRegistry.js`'s
  pattern (no DB-backed registry, no plugin framework, no DI container). Registers only `mock`; the
  underlying factory map is never exported, so a consumer has no reference to mutate. Registering
  `AbuseIPDBProvider` later is one additive entry, not a rewrite.

**Status taxonomy:** `PENDING · SUCCESS · NOT_FOUND · RATE_LIMITED · INVALID_KEY · TIMEOUT · FAILED ·
UNSUPPORTED_INDICATOR · SKIPPED_DISABLED`. **Error codes (closed, frozen map):**
`PROVIDER_RATE_LIMITED · PROVIDER_INVALID_KEY · PROVIDER_TIMEOUT · PROVIDER_UNAVAILABLE ·
PROVIDER_UNREACHABLE · PROVIDER_MALFORMED_RESPONSE · PROVIDER_REJECTED · UNSUPPORTED_INDICATOR ·
ENRICHMENT_DISABLED`. `errorInfo.message` is always derived from this map by `code` alone — a
caller-supplied message (e.g. a caught error's raw `.message`) is never read, even if present on the
input object. This is a structural guarantee, not a convention: `createEnrichmentResult` ignores it.

**MockProvider scenarios:** `SUCCESS_LOW/MEDIUM/HIGH/ZERO_CONFIDENCE`, `NOT_FOUND`, `RATE_LIMITED`
(bounded `retryAfterSeconds`), `INVALID_KEY`, `TIMEOUT`, `FAILED_UNAVAILABLE`, `FAILED_UNREACHABLE`,
`FAILED_MALFORMED_RESPONSE` (three distinct `FAILED`-status error codes) — plus the structural
(non-fixture) behaviors `UNSUPPORTED_INDICATOR` (any non-IPv4/malformed/leading-zero/whitespace
indicator) and `SKIPPED_DISABLED` (provider constructed with `enabled: false`).

**Security boundary (dedicated tests in `iocEnrichmentSecurity.test.js`):** a distinctive fake secret
placed in `queryParams`, in an unrecognised fixture field, or inside an unrelated `Error` object never
reaches a normalized result, its JSON serialization, or the console — proven for every path, not just
asserted. `queryParams` is allow-listed (`maxAgeInDays` only) into the result; every other key is
silently dropped, never echoed back.

**Accepted limitation carried forward from D-002/`BUILD_PLAN.md` 2A, deliberately not built here:**
caching/TTL, HTTP calls, persistence (`IocEnrichment` row), and ingestion-pipeline wiring all require
the schema P2-T2b introduces — building any of them against no schema would mean redoing the storage
shape twice. `queryStatus` (the `IocEnrichment` entity's persisted field per `BUILD_PLAN.md`) is a
distinct concept from this packet's `status` (the provider result's own field); P2-T2b maps one to the
other, this packet does not conflate them.

### Tests

- **85 new unit tests**, all against pure functions / the in-memory `MockProvider` — no database, no
  environment API key, no network. `iocEnrichmentTypes.test.js` (result-shape validation, boundaries,
  closed error-code mapping, queryParams allow-list, immutability), `iocEnrichmentProvider.test.js`
  (contract helpers, indicator support), `mockIocEnrichmentProvider.test.js` (every scenario,
  determinism, call-count isolation, no-fetch/no-clock/no-console, fixture-mutation isolation),
  `providerRegistry.test.js` (resolution, case sensitivity, prototype-pollution guard, immutability),
  `iocEnrichmentSecurity.test.js` (the security boundary above).
- **Targeted + ownership regression:** all pass.
- **Full backend suite:** **1005 passed / 2 skipped** with `TEST_DATABASE_URL` set (the 2 skips are
  `phase1Gate.test.js`, needing `EVAL_DATABASE_URL` specifically) — was 920/2, +85 from this packet.
- **Phase 1 evaluator:** `npm run eval:phase1` — **9/9 PASS**, unchanged.
- `npx prisma validate` clean; migration count unchanged at 10; `schema.prisma` untouched; `git diff
  --check` clean.

## Completed — P2-T2b (`IocEnrichment` schema, migration, durable cache/queue)

The persistence layer for IOC reputation enrichment: an indicator-level result cache and a durable,
leased work queue that a later packet's `AbuseIPDBProvider` plugs into. **No provider is called
anywhere in this packet** — not even `MockProvider` — and no network code exists. Full decision
record: `DECISIONS.md` D-007.

**Migration:** `20260727210128_add_phase2_ioc_enrichment_cache_queue` — exactly one additive
migration (two `CREATE TYPE`, one `CREATE TABLE`, five `CREATE INDEX`; no `ALTER`, no `DROP`, no
foreign key, no partial index, no raw SQL). Migration count 10 → 11.

### Schema and cache identity

`IocEnrichment` plus enums `IocIndicatorType {IPV4}` and `IocEnrichmentStatus` (the nine P2-T2a
statuses; `PENDING` is the only non-terminal one). Cache identity is
`(provider, indicatorType, canonical indicator, normalized queryParams)` — **indicator-level, never
Finding-level**: ten Findings on one IP share one lookup, one row and one TTL.

`enrichmentCacheKey.js` is pure (no Prisma, no clock, no filesystem, no randomness). It reuses
P2-T2a's `sanitizeQueryParams` allow-list and `ipv4Cidr.isValidIpv4`, hashes a **key-sorted
`[key, value]` pair array** (object insertion order is explicitly not the contract) into
`queryParamsHash`, then hashes `provider|indicatorType|indicator|queryParamsHash` into `cacheKey`.
Provider comparison is case-sensitive — `"AbuseIPDB"` is rejected, never folded. An unknown
parameter (an accidental API key, a nonce) is dropped before it can reach the hash input, the stored
column, or the key.

**No `rawResponse` column, no credential column.** Only the allow-listed normalized P2-T2a fields
are persisted, and `errorMessage` is re-derived from `errorInfo.code` through the closed
`PROVIDER_ERROR_MESSAGES` map at write time — a caught `Error.message`, a response fragment, or a
URL carrying a key cannot reach the table even from a malformed provider. This is `BUILD_PLAN.md`
§2A's "or a safely stored normalized subset" branch, taken deliberately.

**Finding FK decision: none, deliberately.** `IocEnrichment` references no other model. A `findingId`
FK would force one cache row per Finding and re-query the provider per Finding, burning the exact
quota the cache protects. Because no `Restrict` FK is introduced, **no existing real-database
cleanup path changed** — `reportIngestionConcurrency.test.js` and `eval/run_phase1_gate.js` are
untouched, and the durable risk the P2-T1 audit flagged does not arise. Verified empirically: after
repeated real-DB and evaluator runs, both disposable databases hold zero `IocEnrichment` rows.

### Active-job uniqueness and lease semantics

`activeCacheKey String? @unique` carries `cacheKey` while PENDING and `null` once terminal — the same
mechanism as D-006's `currentForFindingId`, relying on PostgreSQL treating multiple NULLs in a unique
index as distinct. **No raw SQL, no partial index.** Terminal rows coexist freely for one `cacheKey`,
which is what preserves lookup history: an attempt after TTL expiry inserts a *new* row and the prior
result stays readable.

`scheduleEnrichment` returns an explicit `CACHE_HIT` / `SCHEDULED` / `ALREADY_PENDING`. It never
calls a provider, never audits, and never throws for a safely-resolvable uniqueness race: a losing
racer's `P2002` is recovered **outside any transaction** by re-reading committed state (bounded to 5
attempts). That placement is the point — a constraint violation caught inside an open PostgreSQL
transaction leaves it aborted (25P02) and every later statement fails opaquely, the defect already
recorded for P1-T4.

Claiming is one guarded `updateMany` whose WHERE names the expected lease state
`(status, claimToken, leaseExpiresAt)`; PostgreSQL row-locks and re-evaluates it, so exactly one
consumer wins and the rest match zero rows. `updatedAt` is **never** used as a version token.
Completion requires the correct claim token, is guarded on `status: PENDING`, clears
`activeCacheKey`/lease metadata, and sets `queriedAt`/`expiresAt` explicitly — so it cannot run
twice, cannot overwrite an existing terminal result, and an expired-lease reclaim (which mints a new
token) structurally invalidates the previous holder. `releaseClaimedJob` is the narrow abandon path
for a worker that failed before making any provider call: the job stays durably PENDING with no
invented result. **No retry loop and no daemon ship in this packet.**

### Cache semantics

Positive (`SUCCESS`) and negative (`NOT_FOUND`, `RATE_LIMITED`, `INVALID_KEY`, `TIMEOUT`, `FAILED`,
`UNSUPPORTED_INDICATOR`, `SKIPPED_DISABLED`) results are both cached, each with its own explicit
`expiresAt`. Caching failures is deliberate — re-hammering a provider that just returned 429 is how
remaining quota gets burned. Freshness is the half-open window `[queriedAt, expiresAt)`; a null or
already-past `expiresAt` means not fresh. **A cached failure is never a clean address**: the stored
status is returned exactly, so later risk scoring can always distinguish `SUCCESS` with
`abuseConfidenceScore: 0` (the provider looked and found nothing — real evidence) from
`TIMEOUT`/`FAILED`/`RATE_LIMITED` (no context exists — absence of data, not evidence of safety). A
PENDING row is never returned as cached evidence. TTL *policy* is not decided here; every TTL is
passed in explicitly, and no provider-specific environment default was added.

**No wall-clock reads anywhere in the decision path** — every time-sensitive function takes an
explicit `now`/`asOf`, which is what makes the expiry-boundary tests exact rather than approximate.

### Files

`backend/prisma/schema.prisma` (+144, purely additive — zero deletions) · new migration ·
`src/services/enrichment/enrichmentCacheKey.js` (pure identity/hashing) ·
`iocEnrichmentCacheRules.js` (pure freshness/claimability/field-projection rules) ·
`iocEnrichmentRepository.js` (all Prisma access) · `enrichmentQueueService.js` (scheduling
orchestration). Nothing else in the repository was touched: no routes, no controllers, no
capabilities, no audit events, no `env.js` change, no ingestion wiring, no frontend.

### Tests

- **98 new tests.** `enrichmentCacheKey.test.js` (16 — determinism, key-order stability, provider/
  indicator/`maxAgeInDays` separation, unknown-param dropping, secret-absent-from-hash-input, strict
  IPv4 and indicator-type validation), `iocEnrichmentCacheRules.test.js` (22 — terminal taxonomy,
  exact freshness boundaries, claimability, allow-listed field projection, `errorMessage`
  re-derivation, no-partial-data-on-failure), `iocEnrichmentRepository.test.js` (46 — in-memory fake
  Prisma: cache hit/miss, exact-status passthrough, deterministic newest-result selection, schedule
  outcomes, `P2002` recovery, claim-token enforcement, terminal immutability, release semantics),
  `tests/integration/iocEnrichmentQueue.test.js` (14 — real PostgreSQL).
- **Real-PostgreSQL suite has proven teeth.** The concurrency tests use **separate `PrismaClient`
  instances** (independent connection pools), because `Promise.all` over one shared client serializes
  enough to hide the race entirely — measured directly: with the unique index dropped, six schedulers
  on one client still produced exactly one row, while six separate clients produced six. Verified by
  mutation: dropping `IocEnrichment_activeCacheKey_key` fails tests 1 and 1b; removing `claimToken`
  from the completion guard fails real tests 4 and 4b plus 2 unit tests. Both mutations were reverted
  and the suite re-verified green.
- **Full backend suite: 1105 passed / 0 skipped** (49 files) with `TEST_DATABASE_URL`,
  `EVAL_DATABASE_URL` and the app env vars supplied — was 1007 total, +98 from this packet. Without a
  database: 1064 passed / 41 skipped, so `npm test` still passes on a bare checkout.
- **All real-PostgreSQL suites together (dedup + ingestion + phase1Gate + ownership + enrichment):
  41/41.**
- **Phase 1 evaluator: 9/9 PASS**, run twice, unchanged.
- `npx prisma validate` clean · migration applied to both disposable databases with `migrate deploy`
  (never generated against them) · exactly one migration added (10 → 11) · no raw SQL anywhere in
  `src/`, `tests/` or the migration · `git diff --check` clean.

### Not built here (P2-T2c and later)

No `AbuseIPDBProvider`, no HTTP client, no network call of any kind · nothing calls `MockProvider`
from the queue layer · no TTL policy defaults or provider-specific env additions · no ingestion
wiring · no routes, controllers, capabilities or RBAC · no audit events · no enrichment data exposed
through any Finding API · no automatic retry loop or daemon.

## Completed — P2-T2c (real `AbuseIPDBProvider` + explicit TTL policy)

The real IOC reputation provider behind the P2-T2a `IocEnrichmentProvider` contract, and the pure TTL
policy a future worker applies to its results. **Still nothing wires either into the queue, ingestion,
routes, or audit log** — see "Not built here" below.

### `AbuseIPDBProvider`

`src/services/enrichment/abuseIpdbProvider.js` implements the AbuseIPDB v2 `/check` endpoint behind
`createAbuseIpdbProvider(config)`, registered in `providerRegistry.js` under the exact lowercase name
`abuseipdb` (case-sensitive, per D-007 — `"AbuseIPDB"`/`"ABUSEIPDB"` are unknown). The registry and the
provider module both import cleanly and construct with **zero configuration and no API key** — a
missing key never blocks startup, it only means every `lookup()` call short-circuits to
`SKIPPED_DISABLED` / `ENRICHMENT_DISABLED` before touching the network, exactly like a disabled
`MockProvider`.

**Request:** one `GET {baseUrl}/check?ipAddress=<canonical IPv4>&maxAgeInDays=<n>` per lookup, no
retry. The key travels only in the `Key` header (never the query string), `Accept: application/json`
is always sent, and no other query parameter is ever added. `maxAgeInDays` comes from the caller's
sanitized `queryParams` when present (validated against `[1, 365]`, throwing `TypeError` — a contract
violation, not an expected outcome — for anything else) or the provider's configured default
otherwise. An `AbortController` composes an internal timeout with an optional caller `AbortSignal`
without relying on `AbortSignal.any` (not assumed available); the timeout handle is always cleared,
success or failure. Caller cancellation propagates the `AbortError` verbatim rather than being folded
into `TIMEOUT` — the two are structurally distinguished by which side triggered the abort, never
guessed from the error shape.

**Outcome mapping (all closed, all normalized through `createEnrichmentResult` — never a thrown
provider outcome):** `400` → `FAILED`/`PROVIDER_REJECTED` · `401`/`403` → `INVALID_KEY`/
`PROVIDER_INVALID_KEY` · `404` → `NOT_FOUND` · `429` → `RATE_LIMITED`/`PROVIDER_RATE_LIMITED` with
`Retry-After` parsed as delta-seconds only (an HTTP-date or any non-numeric value becomes `null`, never
an exception) and clamped to the same `MAX_RETRY_AFTER_SECONDS` bound `createEnrichmentResult` itself
enforces · `5xx` → `FAILED`/`PROVIDER_UNAVAILABLE` · a timed-out internal `AbortController` →
`TIMEOUT`/`PROVIDER_TIMEOUT` · a DNS/connect/socket/fetch-level failure → `FAILED`/
`PROVIDER_UNREACHABLE` · malformed JSON, a non-object body, or `data` present but the wrong shape →
`FAILED`/`PROVIDER_MALFORMED_RESPONSE` · `data: null`/`undefined` on a 2xx → `NOT_FOUND`, not
malformed. Every field pulled from the response body is individually type/range-checked *before* it
reaches `createEnrichmentResult` — a bad `abuseConfidenceScore` or `totalReports` becomes
`PROVIDER_MALFORMED_RESPONSE` rather than an uncaught `TypeError` from `createEnrichmentResult`'s own
stricter validation, and an invalid `countryCode`/`lastReportedAt`/etc. becomes `null` rather than
throwing. Only `abuseConfidenceScore`, `totalReports`, `countryCode`, `isp`, `domain`, `usageType`,
`isWhitelisted`, and `lastReportedAt` are ever read from the response — `hostnames`,
`numDistinctUsers`, and everything else are ignored. **No raw response body, header, or `Error.message`
is ever copied into a result** — only the fixed, closed `PROVIDER_ERROR_MESSAGES` map (already enforced
by P2-T2a) reaches `errorInfo.message`.

A genuine programmer/contract violation (missing `asOf`, an invalid `queryParams.maxAgeInDays`) still
throws `TypeError` rather than being flattened into a provider outcome — narrowly guarding only the
`fetchImpl` call and JSON parse means a bug anywhere else in this module propagates as a real exception
instead of silently becoming `FAILED`.

### Configuration (`env.js` / `abuseIpdbConfig.js`)

New shared pure module `abuseIpdbConfig.js` holds the bounds/defaults both `env.js` and
`abuseIpdbProvider.js` validate against, so the two can never drift apart: `ABUSEIPDB_TIMEOUT_MS`
(default 8000ms, bounded `[1000, 30000]`), `ABUSEIPDB_MAX_AGE_DAYS` (new variable; default 90, bounded
`[1, 365]`), `ABUSEIPDB_BASE_URL` (default `https://api.abuseipdb.com/api/v2`; must be HTTPS, or an
explicit `http://localhost`/`http://127.0.0.1` test URL — never a blanket HTTP allowance). Unlike
P2-T2a/b's lenient placeholder values, these are now **real request parameters sent to a live third
party**, so an invalid value (non-numeric, out of bounds, non-HTTPS) fails configuration validation at
startup instead of silently substituting a default — matching how `PORT`/`UPLOAD_MAX_BYTES` already
behave. `ABUSEIPDB_API_KEY` stays optional at startup (never required to start the app) and is never
interpolated into any error message this module throws. `ABUSEIPDB_CACHE_TTL_HOURS` is left as-is,
still declared and still unread by anything — TTL is a pure policy input (below), never sourced from
the environment.

### `enrichmentTtlPolicy.js` — pure TTL policy

`resolveEnrichmentTtl({status, queriedAt, retryAfterSeconds, policyOverrides})` returns
`{expiresAt, ttlSeconds, policyReason}`. No wall-clock read anywhere — `expiresAt` is always exactly
`queriedAt + ttlSeconds`. Defaults: `SUCCESS` 24h · `NOT_FOUND` 6h · `INVALID_KEY`/`SKIPPED_DISABLED`
15min · `TIMEOUT`/`FAILED` 5min · `UNSUPPORTED_INDICATOR` 24h · `RATE_LIMITED`
`max(retryAfterSeconds, 15min)` capped at 24h (a `null`/absent `Retry-After` uses the 15min floor).
`PENDING` is rejected (`EnrichmentTtlPolicyError`) — it is not a terminal result and has no policy.
Every default and every override is clamped to `[60s, 24h]` before being returned, so no status —
default or overridden — can ever receive an unbounded or accidentally-infinite cache duration. Overrides
are explicit function input (`policyOverrides`), never environment-sourced, matching the "TTL policy is
not decided by the provider" boundary D-007 already established. **The provider itself always leaves
`expiresAt` null** — this module only decides the policy; P2-T2d's worker is what calls it and writes
the result.

### Security guarantees

A dedicated `abuseIpdbProviderSecurity.test.js` (mirroring `iocEnrichmentSecurity.test.js`'s approach)
proves a distinctive fake key appears **only** in the captured `Key` request header a fake `fetch`
records for the test's own assertions — never in the request URL, the normalized result, `errorInfo`,
a propagated `AbortError`, JSON serialization, console output (`log`/`warn`/`error` all spied), or the
provider's own `name`/`describe()` representation. `env.test.js` proves the same for a configuration
failure: an invalid `ABUSEIPDB_TIMEOUT_MS` with a fake key present throws `ConfigError` naming the
variable, never the key value.

### Files

New: `src/services/enrichment/abuseIpdbConfig.js`, `abuseIpdbProvider.js`, `enrichmentTtlPolicy.js` ·
`tests/unit/abuseIpdbProvider.test.js`, `abuseIpdbProviderSecurity.test.js`, `enrichmentTtlPolicy.test.js`.
Modified: `src/config/env.js` (strict AbuseIPDB validation, `ABUSEIPDB_MAX_AGE_DAYS` added) ·
`src/services/enrichment/providerRegistry.js` (`abuseipdb` entry) · `.env.example` / `.env.test.example`
(new variable, updated default/comments) · `tests/unit/env.test.js` (strict-validation coverage) ·
`tests/unit/providerRegistry.test.js` (registered-provider coverage). **No `schema.prisma` change, no
migration, no route/controller/RBAC change, no audit event, no ingestion wiring, no frontend change.**

### Tests

- **88 net new/changed tests.** `abuseIpdbProvider.test.js` (47 — configuration, request shape,
  successful normalization incl. malformed-field safety, every HTTP/network outcome mapping, timeout-
  handle cleanup via fake timers, no-retry), `abuseIpdbProviderSecurity.test.js` (6 — key non-leakage
  across success/failure/cancellation/config/console), `enrichmentTtlPolicy.test.js` (24 — every
  terminal status, exact expiry arithmetic, `RATE_LIMITED` floor/cap, `PENDING` rejection, override
  bounds, determinism, no-wall-clock), `env.test.js` (+10 net — strict bounds for
  `ABUSEIPDB_TIMEOUT_MS`/`ABUSEIPDB_MAX_AGE_DAYS`/`ABUSEIPDB_BASE_URL`, key non-leakage in errors),
  `providerRegistry.test.js` (+1 net — `abuseipdb` now resolves; exact-case rejection extended to it).
- **Full backend suite: 1193 passed / 0 skipped** (52 files) with `TEST_DATABASE_URL`,
  `EVAL_DATABASE_URL` and the app env vars supplied — was 1105, +88 from this packet. Without a
  database: 1152 passed / 41 skipped, so `npm test` still passes on a bare checkout.
- **All real-PostgreSQL suites together (dedup + ingestion + phase1Gate + ownership + enrichment):
  41/41**, unchanged — this packet touches no database code.
- **Phase 1 evaluator: 9/9 PASS.**
- `npx prisma validate` clean · migration count unchanged at 11 · `schema.prisma` byte-identical (no
  diff) · no real network call anywhere in the suite (every test injects a fake `fetchImpl`) ·
  `git diff --check` clean.

### Not built here (P2-T2d and later)

No worker/runner claims a queued job, calls the provider, or completes the claim · nothing calls
`resolveEnrichmentTtl` from any live code path · no ingestion wiring · no routes, controllers,
capabilities or RBAC · no audit events · no enrichment data exposed through any Finding API · no
automatic retry loop or daemon.

## Phase 1 release audit

**Verdict: APPROVED WITH NON-BLOCKING RISKS.** No pre-merge fixes were
required. No critical findings. Raw-evidence integrity, report identity and
retry behaviour, trusted-source validation, the Finding lifecycle rules,
PostgreSQL concurrency handling, upload security ordering, and audit
behaviour were all reviewed and found correct.

### Verification at the audited commit

- **Phase 1 gate:** 9/9 scenarios PASS (`npm run eval:phase1`).
- **Backend suite:** 740 passed / 16 skipped.
- **Real PostgreSQL:** 16/16 (P1-T4 + P1-T5 + P1-GATE suites together).
- Tampered-ground-truth proof fails correctly, and the committed
  `ground_truth.yaml` is verified byte-identical afterwards.

### Non-blocking risks recorded by the audit

1. **`cleanupUpload`'s `close` listener can unlink a temp file while the
   handler is still reading it.** `res.on("close")` fires on client
   disconnect, so cleanup can race a handler's `fs.readFile`. This is the
   real root cause of the `routeAuthorization.test.js` ENOENT previously
   described here as a shared-directory flake — a genuine race, not a test
   artifact. `cleanupUpload.js` is Phase 0 code (not in the Phase 1 diff), so
   Phase 1 inherits rather than introduces it. **Fails safe:** the error
   reaches `errorHandler`, no `RawReport` is created, no partial evidence is
   written.
2. **File-derived text reaches `AuditLog.reason`, unbounded.** On the
   `DUPLICATE_HEADER` rejection path the parser message embeds header names
   taken verbatim from the uploaded file, and `auditService` applies
   `redact()` only to `before`/`after` — never to `reason` — with no length
   cap on an unbounded `TEXT` column. API responses are unaffected (fixed
   message plus a bounded reason *code*). Every other rejection message is
   server-constructed.
3. **`EVAL_DATABASE_URL` safety is a raw string-equality check.** Trivially
   different spellings of the same target (`postgres://` vs `postgresql://`,
   `localhost` vs `127.0.0.1`, an appended `?schema=public`) bypass the
   "must not equal `DATABASE_URL`" guard. Blast radius is bounded to
   `phase1-gate`-prefixed reports and Findings at the four ground-truth
   documentation IPs.
4. **A crashed ingestion leaves a report permanently unretryable.**
   `PROCESSING` classifies as `DUPLICATE_IN_PROGRESS` with no timeout, so a
   process that dies mid-ingestion strands the report until manual database
   intervention. Correctly documented as a deliberate deferral and never
   claimed as implemented.
5. **`RawReport.rawContent` byte-preservation has no automated test.** The
   audit verified it empirically (all persisted reports round-trip
   byte-exactly, `sha256(rawContent) === sourceFileSha256` for every row),
   but a regression would pass both the suite and the gate.
6. **The comparator silently skips omitted expectations.** A future scenario
   authored without a `rows:`/`findings:` block asserts nothing about them
   and still reports PASS; the loader enforces only the four count deltas and
   `outcome`.

Recommended order if addressed: (5), (1), (2), (3). None gate Phase 2.

### Standing limitations reconfirmed by the audit

- **`RawReport.observationDate` NOT NULL** still prevents creating an
  evidence row for report-level rejection / zero-valid-row uploads. Approved,
  documented, consistently enforced (both paths return `report: null`), and
  acceptable for Phase 1.
- **The production manual Finding-close endpoint remains unimplemented.** The
  only closure path in the repository is the evaluation-only fixture under
  `eval/lib/evalClosureFixture.js`, which is not a route and is not imported
  by any `src/` code.

### External dependency

- **Shadowserver test-access request is pending under ticket `#7ibziiin`.**
  Live/scheduled Shadowserver ingestion remains out of scope regardless; all
  Phase 1 data is synthetic (`data/synthetic/`, `accessible-rdp.synthetic.v1`
  — not an official Shadowserver schema).

## Completed — P1-GATE (executable Phase 1 gate)

Closes the gap left after P1-T6a: `BUILD_PLAN.md`'s Phase 1 gate — *"ingest
days 1→N of the synthetic dataset; dedup, persistence, and recurrence counts
match `data/synthetic/ground_truth.yaml` exactly, compared by `eval/`, not by
eye"* — previously had neither a dataset nor an evaluation harness. Team
authorized building both directly in this task rather than waiting on the
external teammate deliverable.

**Synthetic dataset** (`data/synthetic/`): 7 hand-authored
`accessible-rdp.synthetic.v1` CSV fixtures (`accessible-rdp/01_baseline.csv`
through `07_structural_rejection.csv`), all RFC 5737 `203.0.113.0/24`
addresses, all deterministic explicit-UTC timestamps chosen by hand — nothing
generated or randomized. `README.md` in that directory carries the required
synthetic/non-operational disclaimer. `01_baseline.csv` is reused byte-for-byte
for two further scenarios (identical re-upload, untrusted-source rejection)
that don't need their own file.

**`ground_truth.yaml`**: manually authored from the approved, documented
lifecycle rules (P1-T4/P1-T5/P1-T6a) and the exact fixture contents — **never**
generated by running the program and copying its output back in. Nine
scenarios, run in a fixed declared order, each recording: outcome, report
status/row counts, RawReport/RawReportRow/Finding/FindingOccurrence count
deltas, occurrence action counts (CREATED/PERSISTED/HISTORICAL/RECURRED), the
canonical/duplicate/error-code shape of every row, exact Finding projections
(status, firstSeen, lastSeen, occurrenceCount, recurrenceCount,
closedThroughObservedAt), and — for the two rejection scenarios — the
stable reason code and aggregate audit count.

**Scenario coverage** (`01`–`09`, in order): baseline ingestion (two distinct
Finding identities, one duplicated within the report — canonical row is the
**maximum** duplicate-row timestamp, so the earlier duplicate row never
touches `firstSeen`/`lastSeen`) → identical re-upload (file-level idempotency;
zero new evidence; existing `FindingOccurrence` rows proven byte-identical
before/after) → persistence (in-order observation, existing Finding moves
forward, plus a brand-new Finding) → historical (out-of-order observation;
`lastSeen` does not regress; no false recurrence) → controlled CLOSED-boundary
(eval-only closure fixture, then an observation exactly at
`closedThroughObservedAt` — HISTORICAL, not RECURRED, per the documented
CLOSED tie-break) → recurrence (observation strictly after the boundary —
RECURRED, `recurrenceCount` +1 exactly once, closure fields cleared per the
existing P1-T4 decision) → mixed validity (valid + invalid rows, every row
preserved, invalid rows never linked to an occurrence, exact error codes
compared) → structural rejection (missing required header; no `RawReport` row
under the existing observationDate NOT-NULL workaround) → untrusted source
(P1-T6a's registry rejects a well-formed upload purely on `source`, before any
parsing).

**Recurrence evaluation setup — explicitly not a production endpoint.**
`eval/lib/evalClosureFixture.js` directly transitions an existing Finding to
`CLOSED` via a plain `prisma.finding.update`, honestly using the schema's
existing closure columns (`closedAt`, `closedByUserId` left `null`,
`closureReason`, `closedThroughObservedAt`). It is not mounted as a route, not
imported by any `src/` production code, lives only under `eval/lib/`, and
**fails closed if its `closureReason` doesn't literally contain
`EVALUATION_FIXTURE_CLOSURE`** — so a closure this fixture creates can never
be silently mistaken for a genuine analyst action if the database were
inspected directly. No dedicated evaluation `User` row was needed —
`closedByUserId` is nullable and closing without an actor is honest, not
invented. **The production manual-close endpoint remains unimplemented** —
this task did not add one and did not claim to.

**Evaluator architecture** (`eval/run_phase1_gate.js` + `eval/lib/`):
`groundTruthLoader.js` (parses via the `yaml` package — added as the one new
dependency, per package.json/package-lock.json — and structurally validates
the document, rejecting unknown occurrence actions, duplicate scenario ids,
non-UTC-explicit timestamps, and missing required sections with a controlled
`GroundTruthValidationError`; timestamps stay plain strings until the
comparator explicitly parses them) → `phase1Comparator.js` (pure, sorts every
array by an explicit canonical key — row number, Finding identity, occurrence
id — before comparing, so result order from the database never affects the
outcome; produces a path/expected/actual diff list) → `run_phase1_gate.js`
(loads + validates ground truth and verifies every fixture file exists
*before* even requiring the production ingestion service; cleans
evaluation-owned state via an id set derived from this run's own
`RawReport`→`FindingOccurrence`→`Finding` chain, same lesson as P1-T5/T6a's
test-isolation fixes — never a loose IP-prefix or filename-substring guess;
calls the real `ingestAccessibleRdpReport` for every scenario, always with
`source: "SYNTHETIC_UPLOAD"` for valid scenarios; verifies row-to-occurrence
relationships, not just aggregate counts). `backend/src/config/prismaFactory.js`
(new, five lines) lets `eval/` — a sibling of `backend/`, not a descendant —
construct a real `PrismaClient` pointed at an explicit URL without ever
touching `DATABASE_URL` or resolving `@prisma/client` through a fragile
cross-directory `require`.

**Database safety**: `EVAL_DATABASE_URL` is required and refused if absent or
equal to `DATABASE_URL`; `DATABASE_URL` itself is never read for the
connection, only for that one equality check, captured before any env
staging. `config/env.js`'s unconditional validation (needed transitively
because `reportIngestionService.js` requires it) is satisfied with
placeholders that are staged **after** the safety check and **only for
variables not already set** — never overwriting a real value, and never
touching `backend/.env`. Migrations are applied to the disposable
`threatnexus_eval` database with `prisma migrate deploy` only (documented as
a manual setup step, same convention as `TEST_DATABASE_URL`); the evaluator
itself never runs a migration command.

**Two real defects were found and fixed — both in the evaluator, not
production code**: (1) occurrence-action counting for a scenario that reuses
an existing `RawReport` id (the identical-re-upload scenario) initially
counted *every* occurrence ever linked to that report, not just ones created
during the current scenario — fixed by tracking a per-scenario
"occurrence id high-water mark" and counting only occurrences created after
it, mirroring the existing audit-event-counting technique. (2) the per-scenario
fixture-file read resolved paths relative to the ground-truth file's own
directory instead of the explicitly passed `fixturesRoot` — invisible when
both live in `data/synthetic/` together, but broke the mandatory
tampered-ground-truth test, which deliberately loads ground truth from a temp
directory while fixtures stay in the real location. Both fixed; ground truth
was never adjusted to paper over either issue.

### Tests

- **16 ground-truth loader unit tests**: the real committed
  `ground_truth.yaml` loads cleanly and keeps timestamps as strings; a
  minimal valid document is accepted; missing `scenarios`/`findingIdentities`
  rejected; malformed YAML rejected; duplicate scenario id rejected; unknown
  occurrence action rejected; negative/non-integer expected counts rejected;
  invalid row status, undeclared finding-identity reference, non-UTC-explicit
  timestamp, and unknown preStep type all rejected; nonexistent file path and
  non-string `filePath` (contract violation) both rejected.
- **14 comparator unit tests**: exact match passes; count/occurrence-action/
  Finding-projection/row-relation mismatches each fail with a scoped diff;
  a missing or extra Finding fails; equivalent results supplied in reversed
  order pass after canonical sorting; a timestamp mismatch fails even when
  both sides are Date-shaped; `reportIdMatchesScenario` and
  `occurrencesUnchangedSinceScenario` cross-scenario checks both fail
  correctly when tampered; the diff formatter never omits expected/actual
  values.
- **9 evaluator-safety unit tests**: missing/empty `EVAL_DATABASE_URL`
  rejected; `EVAL_DATABASE_URL` equal to `DATABASE_URL` rejected (and accepted
  when merely similar-but-distinct, or when `DATABASE_URL` is entirely
  unset); the credential-bearing URL is never echoed in a refusal message; a
  scenario referencing a missing fixture file is rejected via a
  `Proxy`-wrapped Prisma stub that throws on any access, proving the
  rejection genuinely happens *before* the database is ever touched; a
  static-analysis check over `eval/run_phase1_gate.js`'s own source
  confirms every `deleteMany` on `Finding`/`RawReportRow`/`FindingOccurrence`/
  `RawReport` is scoped by an `{in: ...}` id set (never `startsWith`/
  `contains`), and that no unconditional `deleteMany()`, `TRUNCATE`, or
  `DROP TABLE/DATABASE` appears anywhere in the file.
- **2 real-PostgreSQL tests** (`backend/tests/integration/phase1Gate.test.js`,
  self-skips without `EVAL_DATABASE_URL`): (1) the full gate passes end-to-end
  against the committed fixtures and ground truth; (2) **the mandatory
  tampered-expectation proof** — a deliberately wrong value (`FINDING_A`'s
  `occurrenceCount` after `03_persistence`, genuinely `2`, bumped to `999`)
  is written to a temp file only (the committed `ground_truth.yaml` is
  read back byte-for-byte identical at the end of the test, proving it was
  never touched), the full gate is re-run against that tampered copy, and
  the run is asserted to fail with the exact mismatch identified.
- Targeted eval tests run together: **39/39** (16 + 14 + 9), plus the 2
  real-DB tests, stable across 3 repeated runs. Full backend suite: **740
  passed / 16 skipped**, run twice (a first run surfaced one failure in
  `routeAuthorization.test.js`'s `/api/threats/upload` test — reproduced
  standalone as passing 3/3, confirming it's the same pre-existing
  shared-`uploads/`-directory cross-file race already documented for P1-T5's
  `reportUploadRoute.test.js`, in a file this task did not touch and was not
  scoped to fix; the second full run was clean).

### Gate result

```
Phase 1 Gate
PASS  01_baseline
PASS  02_identical_reupload
PASS  03_persistence
PASS  04_historical
PASS  05_closed_boundary
PASS  06_recurrence
PASS  07_mixed_validity
PASS  08_structural_rejection
PASS  09_untrusted_source

Final:
PASS — expected and actual Phase 1 results match exactly
```

Run via `npm run eval:phase1` (from `backend/`) against a disposable
`threatnexus_eval` database — see the root `README.md`'s new "Phase 1 gate"
section for exact setup steps. Rerunnable: cleanup derives its exact
evaluation-owned id set from this run's own evidence chain, so a repeat run
starts clean without needing the database dropped and recreated.

### No genuine production defect found

Every hand-derived ground-truth value matched actual behavior on the first
gate run except the two evaluator bugs described above (both fixed in
`eval/`, zero production code changed). This is a meaningful, if informal,
confirmation that P1-T4/P1-T5/P1-T6a's dedup/persistence/recurrence/
source-validation logic behaves exactly as documented for every lifecycle
transition this gate exercises.

**Internal task definition**: `BUILD_PLAN.md` has no literal "P1-T6" section —
`P1-T6a` is this repo's own name for the one remaining unimplemented row in
Phase 1's task table: *"Source validation — is this `source` + `reportType` a
known/trusted combination? Distinct from schema validation."* `schema.prisma`
had already flagged this as deferred at P1-T1 ("a ReportSchema/registry model
is deliberately NOT introduced yet — it is premature for a single type").

- **Registry** (`backend/src/services/ingestion/reportSourceRegistry.js`,
  new): a small, code-level, additive-only trusted-contract registry — no
  `ReportSchema` Prisma model, no migration, no database-configured registry.
  Exports a frozen `REPORT_SOURCES` identifier collection (`SYNTHETIC_UPLOAD`
  only), a frozen `TRUSTED_REPORT_CONTRACTS` array of frozen tuples, and
  `validateReportSource({source, reportType, schemaVersion})` — a pure
  function (no Prisma, no filesystem access) doing exact, case-sensitive,
  no-coercion matching of the complete 3-field tuple; a match on one or two
  fields is not sufficient. Returns `{ok:true}` or `{ok:false, code:
  "UNTRUSTED_SOURCE_REPORT_COMBINATION", message}` — mirroring the existing
  `{ok, code, message}` shape `accessibleRdpCsvParser.js` already uses for
  expected (non-exceptional) rejections. `reportType`/`schemaVersion` in the
  one trusted tuple are sourced from the generated `ReportType` Prisma enum
  and `accessibleRdpRowValidator.js`'s `CONTRACT_VERSION` constant, not
  re-typed as string literals, so the registry cannot silently drift from
  either.
- **Trusted tuple (the only one, MVP)**: `source: SYNTHETIC_UPLOAD`,
  `reportType: ACCESSIBLE_RDP`, `schemaVersion: accessible-rdp.synthetic.v1`.
- **Server-controlled source — enforced, not just documented**:
  `reportIngestionController.js` assigns `source: REPORT_SOURCES.SYNTHETIC_UPLOAD`
  itself and passes it explicitly into `ingestAccessibleRdpReport`; nothing in
  the controller reads `req.body`/a multipart text field/the filename/a
  header as a source claim. `ingestAccessibleRdpReport`'s `assertValidInput`
  now requires `input.source` to be an explicit non-empty string with **no
  implicit default** — a caller that forgets to pass it gets a `TypeError`,
  not a silently-assumed value, so a future call site can never accidentally
  skip considering it.
- **Pipeline placement**: validation is step 0 of `ingestAccessibleRdpReport`
  — before CSV structural parsing, before row validation, before any
  `RawReport`/`RawReportRow`/`Finding`/`FindingOccurrence` access. An
  untrusted tuple returns `INGESTION_OUTCOMES.REJECTED` immediately; the
  existing structural-parse-rejection code path (and its 400 HTTP mapping)
  is reused as-is — no new outcome or status code was needed.
- **The binding P1-T5 observationDate decision is unchanged**: an untrusted
  tuple, like a structural rejection or an all-invalid-rows upload, creates
  **no `RawReport` row** (`report: null` in the response) — not a new
  decision, the existing one already covers this case since there is still
  no valid row timestamp to store. No schema change in this task.
- **Rejection/audit behavior**: one aggregate `report.ingestion.rejected`
  `AuditLog` event (never per-row), `after` populated with only
  `reasonCode`, `requestedReportType`, `requestedSchemaVersion`, and the
  rejected `source` value — never raw bytes, CSV rows, the full registry
  contents, a stack trace, or a filesystem path. The safe public message
  (`"This report source, type, or schema version is not trusted for
  ingestion."`) is fixed and never echoes the caller's input.
- **Client-override protection**: verified behaviorally, not just by code
  inspection — sending multipart `source=SHADOWSERVER`,
  `reportType=SOMETHING_ELSE`, or `schemaVersion=bogus-version` alongside a
  valid file still returns 201 (the values are never read), since if the
  controller had consumed any of them the request would instead be rejected
  (`SHADOWSERVER` etc. are not in the trusted registry). Route middleware
  never parses these as trusted metadata; the route ordering
  (`authenticate -> requireCapability -> cleanupUpload -> multer ->
  controller`) and temp-file cleanup are both unchanged and re-verified with
  override attempts present.
- **Valid-tuple behavior is unchanged**: every existing P1-T5 unit/route/
  real-DB test continues to pass with the server-assigned `SYNTHETIC_UPLOAD`
  source flowing through unmodified; one explicit regression test asserts a
  valid tuple still produces `PROCESSED`/`COMPLETED` with a `RawReport`,
  `RawReportRow`, `Finding`, and `FindingOccurrence` each created exactly
  once, matching pre-P1-T6a behavior.

### Tests

- **18 new unit tests** (`reportSourceRegistry.test.js`): approved tuple
  accepted; unknown source rejected; case-sensitivity on all three fields
  independently; no trimming of whitespace-padded values; wrong reportType
  alone rejected; wrong schemaVersion alone rejected; two different
  partial-match shapes rejected; each field missing individually rejected;
  null/undefined fields rejected without throwing; a non-object argument
  throws `TypeError` (contract violation, not a data condition); stable
  reason code and a safe message that echoes neither the caller's input nor
  the registry's actual contents; `REPORT_SOURCES`/`TRUSTED_REPORT_CONTRACTS`/
  `REASON_CODES` all frozen and resistant to normal mutation attempts (the
  mutation-attempt tests swallow the possible `TypeError` a frozen-object
  assignment throws under this test file's own ES-module strict mode, then
  assert the underlying value never changed either way).
- **7 new orchestrator tests** (`reportIngestionService.test.js`): source
  validation runs before the parser/any DB access is touched (asserted via
  `client.rawReport.findUnique`/`create` never being called); an untrusted
  tuple creates no `RawReport`, no `RawReportRow`, no `Finding`/
  `FindingOccurrence`; exactly one safe aggregate rejection audit (never
  per-row); a valid tuple leaves all existing P1-T5 behavior unchanged;
  omitting `source` (or passing an empty string) throws `TypeError`.
- **5 new route tests** (`reportUploadRoute.test.js`): a normal analyst
  upload succeeds under the server-assigned source; a client-supplied
  `source` field cannot override it; client-supplied `reportType`/
  `schemaVersion` fields cannot override the fixed contract either; the
  existing authenticate/capability-before-multer ordering and temp-file
  cleanup both still hold when override attempts are present on the request.
- **1 new real-PostgreSQL test** added to `reportIngestionConcurrency.test.js`
  (test 9): an untrusted tuple against the real database writes zero
  `RawReport`, `RawReportRow`, `Finding`, or `FindingOccurrence` rows. Suite
  self-skips without `TEST_DATABASE_URL` exactly as before (now 14 skipped,
  was 13).
- Full backend suite: **701 passed / 14 skipped** (was 671/13; +30 new: 18 +
  7 + 5). Real PostgreSQL P1-T4 + P1-T5 + P1-T6a together: **14/14**, stable
  across 3 repeated runs against the disposable `threatnexus_test` database.

## Completed — P1-T5 (end-to-end ingestion orchestration)

`POST /api/reports/upload` — the full CSV-upload-to-Finding-lifecycle pipeline.

- **Route/middleware ordering** (`backend/src/routes/reportRoutes.js`):
  `authenticate -> requireCapability(INGEST_REPORTS) -> cleanupUpload ->
  reportUpload.single("file") -> uploadAccessibleRdpReport`. A denied caller
  never reaches multer, so a denied request cannot create a temp file at all
  (proven in tests via an `fs.createWriteStream` spy, not a directory
  listing). `cleanupUpload` is armed before multer runs but reads `req.file`
  lazily at response-finish/close time, so it still unlinks whatever multer
  wrote regardless of the outcome (success, validation rejection, duplicate,
  or an uncaught 500).
- **Upload middleware** (`backend/src/upload/reportUpload.js`): dedicated
  multer instance reusing the shared disk storage (safe generated filenames,
  traversal-proof), a `.csv`-extension-only `fileFilter` that skips (not
  errors) non-CSV files before any write, and `limits.fileSize` from
  `env.UPLOAD_MAX_BYTES`. A `normalizeMulterError` middleware maps
  `LIMIT_FILE_SIZE` to 413 and any other Multer error to 400 ahead of the
  shared `errorHandler`.
- **Structural CSV parser** (`backend/src/services/ingestion/accessibleRdpCsvParser.js`):
  a separate stage from row validation (P1-T2) — proves the file is
  well-formed CSV with the required header set before any row is validated.
  Rejection codes: `INVALID_UTF8, EMPTY_FILE, HEADER_ONLY,
  MISSING_REQUIRED_HEADERS, DUPLICATE_HEADER, NULL_BYTE_IN_HEADER,
  MALFORMED_CSV, ROW_LIMIT_EXCEEDED` (row cap from the new
  `env.REPORT_MAX_ROWS`, default 5000). Short rows only get keys for columns
  that actually exist in the record — an earlier version assigned an
  explicit `undefined` for missing trailing columns, which `Object.keys`
  sees but Postgres JSONB round-tripping silently drops, causing spurious
  row-evidence-integrity conflicts on retry.
- **Orchestrator** (`backend/src/services/ingestion/reportIngestionService.js`,
  `ingestAccessibleRdpReport`): parse -> validate every row (P1-T2, pure,
  in-memory) -> compute `observationDate` as the **earliest valid row
  timestamp** -> `resolveRawReportIdentity`/`createRawReportRecordOrResolveExisting`
  (P1-T3) -> transition to `PROCESSING` -> persist invalid rows -> group
  valid rows by exact Finding identity -> per group: pre-flight row-evidence
  check, then `recordFindingObservation` (P1-T4), then link/persist every row
  in the group -> transition to a terminal status -> aggregate audits.
- **observationDate — approved, documented design gap.** `RawReport.observationDate`
  is `TIMESTAMP(3) NOT NULL` with no default, but a structurally-rejected
  upload or an all-invalid-rows upload has no valid timestamp to put there.
  Escalated to the user before writing any code; **approved resolution: no
  `RawReport` row is created for either case** — the upload is rejected with
  a safe response (`REJECTED` / `UNPROCESSABLE_NO_VALID_ROWS`, `report: null`,
  never a falsely-referenced report id) and nothing is persisted. Real,
  accepted tradeoff: raw bytes of a rejected/all-invalid upload are not kept
  as evidence, and re-uploading the same bad bytes is independently rejected
  each time (no sha256 row to classify against, since none was created). A
  future task should make the column nullable if evidence preservation for
  these cases becomes a requirement.
- **Within-report duplicates**: rows are grouped by exact Finding identity
  `(indicatorValue, port, protocol, reportType)`; the **canonical row is the
  one with the maximum `observedAt`** in the group (tie-broken by the lowest
  row number), independent of CSV row order. Exactly one
  `recordFindingObservation` call per group, using the canonical row's
  timestamp; every row in the group — canonical and duplicate alike — links
  to the same `FindingOccurrence`; non-canonical rows are flagged
  `duplicateInReport: true`.
- **Row evidence**: `RawReportRow` is immutable. `persistRowIdempotently`
  creates-if-absent; if a row number already has evidence, the freshly parsed
  payload must match it exactly (order-independent JSON equality, since
  JSONB does not preserve key order) or it throws
  `RowEvidenceIntegrityError` — never overwrites, never silently keeps stale
  evidence. A read-only `assertRowEvidenceCompatible` pre-flight check runs
  over every row in a group **before** `recordFindingObservation` is called,
  so a Finding/FindingOccurrence is never created for a group already known
  to conflict on retry.
- **Retry/idempotency**: `RETRYABLE_FAILED`/`RETRYABLE_RECEIVED` reuse the
  existing `RawReport` row (never a second row for the same
  `sourceFileSha256`); `DUPLICATE_COMPLETED`/`DUPLICATE_IN_PROGRESS` short-circuit
  with no processing. Any failure during row/group processing — including a
  P1-T4 whole-transaction retry exhaustion (`P2002`/`P2034` escaping
  `recordFindingObservation`) or a `RowEvidenceIntegrityError` — is caught
  once around the whole processing block and marks the **report** `FAILED`;
  it is never misclassified as a per-row `INVALID` result, and nothing
  already persisted is deleted or rolled back, so a later retry can resume
  idempotently.
- **Report status semantics**: `RECEIVED` -> `PROCESSING` -> `COMPLETED` (no
  invalid rows) or `PARTIALLY_VALID` (some invalid rows) on success, `FAILED`
  on an uncaught processing error. `REJECTED` never gets a persisted row (see
  observationDate gap above).
- **Audits** (aggregate, not per-row): `report.ingestion.rejected` (structural
  or zero-valid-row rejection), `report.ingestion.started`,
  `report.ingestion.completed` / `report.ingestion.partially_valid`,
  `report.ingestion.failed`, and one `finding.reopened` per actual `RECURRED`
  result (an analyst-visible lifecycle change, not routine per-occurrence
  noise). All wrapped in a non-throwing `audit()` helper so a broken logger
  can never turn a decided outcome into an unhandled rejection.
- **Response/audit safety**: response bodies use fixed allow-listed fields
  only (`reportSummary`/`findingSummary`) — never raw bytes, file paths,
  stack traces, or `error.message` text; `buildSafeErrorSummary` uses one of
  two fixed messages plus a regex-validated Prisma error code, never the raw
  error. Verified by dedicated response-safety tests (no Windows path, no
  `uploads` path segment, no `rawContent`, no `stack` key, exact field-set
  check).
- **HTTP contract**: `PROCESSED` -> 201, `DUPLICATE_COMPLETED` -> 200,
  `DUPLICATE_IN_PROGRESS` -> 409, `REJECTED` -> 400,
  `UNPROCESSABLE_NO_VALID_ROWS` -> 422, `FAILED` -> 500.

### Tests

- 21 unit tests for the CSV parser, 20 for the orchestrator (in-memory fake
  Prisma client covering rawReport/rawReportRow/finding/findingOccurrence/
  auditLog + `$transaction` pass-through), 3 for `normalizeMulterError`, 15
  route/security/cleanup tests (`reportUploadRoute.test.js`) — **59 new
  tests**, full suite **671 passed / 13 skipped** with no database (was
  612/5; the extra 8 skipped are the new real-DB P1-T5 suite below).
- **8 real-PostgreSQL integration tests**
  (`backend/tests/integration/reportIngestionConcurrency.test.js`): fully
  valid fixture, mixed-validity fixture, in-report duplicates (canonical =
  max `observedAt`), identical-file idempotent replay, interrupted-attempt
  retry (reuses the seeded `RawReport` row), concurrent overlapping reports
  on one Finding, a forced system failure (report `FAILED`, no orphaned
  Finding/rows), and full FK/evidence-chain resolution. Self-skips without
  `TEST_DATABASE_URL`. Ran together with the existing 5 P1-T4 tests: **13/13**.
- **Route-test flakiness fixed** (`reportUploadRoute.test.js`): the file-handling
  tests originally compared a full `uploads/` directory listing before/after
  each request. That directory is shared with other test files
  (`cleanupUpload.test.js`, threat-upload route tests) that Vitest runs
  concurrently in separate workers, so the comparison intermittently failed
  on files this route never touched — reproduced directly (a stray
  `cleanupUpload.test.js` fixture appeared mid-assertion). Replaced with an
  `fs.createWriteStream` spy: multer's disk storage engine calls
  `createWriteStream` exactly once per accepted file
  (`node_modules/multer/storage/disk.js`), so each test now asserts against
  *its own request's* write (or its absence, for filter-rejected requests),
  independent of anything else touching the shared directory. Full backend
  suite run **11 times** during this stabilization; the only failures seen
  were this exact flaky assertion — no evidence of the previously-suspected
  intermittent 500.
- **Real-DB test-isolation bug fixed** (`reportIngestionConcurrency.test.js`):
  its cleanup deleted `Finding` rows by `indicatorValue: { startsWith:
  "198.51.100." }` — a prefix that also matches
  `dedupServiceConcurrency.test.js`'s own TEST-NET-2 range
  (`198.51.100.11`-`.15`, which also starts with `"198.51.100."`). Running
  both real-DB suites together raced: whichever file's cleanup ran while the
  other's data was still live hit `FindingOccurrence_findingId_fkey`.
  Reproduced directly. Fixed by deriving the exact Finding-id set to delete
  from this file's *own* `RawReport` evidence (via its `FindingOccurrence`
  rows) instead of guessing by IP prefix — self-contained regardless of what
  IP range any other file picks. Re-ran the combined real-DB suite 5 times
  after the fix with no recurrence.

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

P1-T5: `npx prisma validate` clean (`DATABASE_URL` supplied inline, no
`backend/.env`) · **no migration generated** (`backend/prisma` untouched) ·
targeted P1-T5 tests (parser + orchestrator + middleware + route) run 5x
back-to-back with no flakiness · full backend suite **671 passed, 13
skipped**, run once clean (no repeat needed — first run showed no
flakiness) · real-PostgreSQL P1-T4 + P1-T5 suites together **13/13**, run 5x
back-to-back with no flakiness (against a disposable `threatnexus_test`
database via the existing `docker-compose.yml` `postgres` service, migrations
already in sync, no `backend/.env`) · `git diff --check` clean · diff and
status reviewed · implementation-risk checklist reviewed directly against the
orchestrator/controller source: REJECTED/zero-valid-row responses carry
`report: null` (never a falsely-referenced report id); retries never
overwrite `RawReportRow` evidence (`persistRowIdempotently` throws on
mismatch); no raw bytes/hashes/paths/stack traces in any response or audit
payload (allow-listed summaries only); P2034/P2002 exhaustion from
`recordFindingObservation` is caught once around the whole processing block
and marks the report `FAILED`, never a per-row `INVALID`; duplicate valid
rows in one report link to exactly one `FindingOccurrence` and use the
deterministic max-`observedAt` canonical row.

P1-T6a: `npx prisma validate` clean (`DATABASE_URL` supplied inline, no
`backend/.env`) · **no migration generated** (`backend/prisma` untouched,
confirmed via `git status`) · targeted tests (registry + orchestrator + route
+ real-DB) run individually and together, stable · full backend suite
**701 passed, 14 skipped**, run once clean (no repeat needed) · real
PostgreSQL P1-T4 + P1-T5 + P1-T6a together **14/14**, run 3x back-to-back
with no flakiness · `git diff --check` clean · diff (5 files modified, 2
files added, 271 insertions) and `git status` reviewed — matches exactly the
approved scope, nothing unrelated touched.

P1-GATE: `npx prisma validate` clean (`DATABASE_URL` supplied inline, no
`backend/.env`) · **no migration generated** · targeted eval tests (loader +
comparator + safety) **39/39**, real-DB gate test (genuine pass + tampered-proof)
**2/2**, all real-PostgreSQL suites together (P1-T4 + P1-T5 + P1-GATE)
**16/16** · full backend suite run twice: first run **1 failed / 739 passed /
16 skipped** (pre-existing `routeAuthorization.test.js` shared-`uploads/`-
directory flake, reproduced standalone as 3/3 passing, confirmed unrelated to
any file this task touched), second run clean **740 passed / 16 skipped** ·
`npm run eval:phase1` against the disposable `threatnexus_eval` database:
**PASS** (all 9 scenarios), reproduced clean across 3 runs · `git diff --check`
clean · diff and `git status` reviewed — 2 files modified (`backend/package.json`,
`backend/package-lock.json`, the one new `yaml` dependency), 5 new files under
`backend/` (`src/config/prismaFactory.js` + 4 test files), all of `data/` and
`eval/` new — matches exactly the approved scope.

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
- **`FindingOccurrence.observedAt` source — resolved in P1-T5**: the row's
  own (canonical, for within-report duplicates) timestamp is authoritative
  for `FindingOccurrence`/`Finding` lifecycle. `RawReport.observationDate` is
  separate, report-level summary metadata only (earliest valid row
  timestamp in the report) — never read back for lifecycle decisions. The
  two are computed from the same source data and cannot drift, but they
  answer different questions (one occurrence's time vs. one report's
  earliest valid time).
- **`RawReport.observationDate` NOT NULL schema gap (P1-T5, approved,
  deferred)**: no valid timestamp exists for a structurally-rejected or
  all-invalid-rows upload. Escalated to the user before implementation;
  approved resolution is to create no `RawReport` row for those two cases
  (see the P1-T5 section above for the full tradeoff). A future task should
  make the column nullable if raw-byte evidence preservation for
  rejected/all-invalid uploads becomes a requirement.
- **`RawReport.observationDate` NOT NULL schema gap — still the one known
  Phase 1 limitation.** Unchanged by P1-GATE: a structurally-rejected or
  all-invalid-rows upload still creates no `RawReport` row (scenarios
  `08_structural_rejection` and `09_untrusted_source` both exercise and
  confirm this). Not revisited in this task per its own decision gate ("do
  not change the schema").
- **Pre-existing, out-of-scope test flake noticed while running the full
  suite (not fixed here)**: `routeAuthorization.test.js`'s `/api/threats/upload`
  test occasionally hits an `ENOENT` reading its own multer temp file — the
  same shared-`uploads/`-directory cross-file-concurrency class already
  root-caused and fixed for `reportUploadRoute.test.js` during P1-T5, now
  observed in a sibling file this task did not touch (`threatRoutes.js`, not
  `reportRoutes.js`) and was not scoped to fix. Reproduced standalone as 3/3
  passing, confirming it's the known class of flake, not a P1-GATE
  regression. A future task should apply the same `fs.createWriteStream`-spy
  fix there.

## Exact next task

**Phase 1 is now gate-complete.** P1-T1 through P1-T6a implemented every row
of `BUILD_PLAN.md`'s Phase 1 task table, and P1-GATE has proven — with a
hand-authored, code-independent ground truth, not by eye — that dedup,
persistence, historical handling, closed-boundary protection, recurrence,
mixed-validity handling, structural rejection, and trusted-source rejection
all behave exactly as documented. `npm run eval:phase1` is the durable,
rerunnable regression check for this phase going forward.

Phase 1 has since been audited (**APPROVED WITH NON-BLOCKING RISKS**) and
merged into `main`. Work continues on `feat/phase-2-enrichment-risk`.

**Phase 2's first task, P2-T1 (ownership mapping), is now complete** — see
"Completed — P2-T1" above and `DECISIONS.md` D-006 for the full record.

**P2-H1 (ownership correctness + test hardening) is now complete** — see
"Completed — P2-H1" above. Coverage classification, the PostgreSQL FK Restrict
proof, and the CIDR confidence-table tests are fixed; ingestion
ownership-failure isolation is now proven by an explicit test. Automatic
re-resolution after a mapping change (C-1/C-2) remains deferred to a future
Opus-supervised packet and does not gate Phase 2.

**P2-T2a (IOC enrichment provider contract + MockProvider) is now complete** —
see "Completed — P2-T2a" above. The `IocEnrichmentProvider` contract,
`createEnrichmentResult` normalized-result validator, `MockProvider`, and the
provider registry all exist and are fully tested; no `AbuseIPDBProvider`, no
persistence, no caching, and no ingestion wiring exist yet — those are
P2-T2b/T2c's job.

**P2-T2b (`IocEnrichment` schema, migration, durable cache/queue) is now
complete** — see "Completed — P2-T2b" above and `DECISIONS.md` D-007. The
indicator-level cache, the `activeCacheKey`-enforced single-active-job rule,
claim-token leasing, terminal-result immutability and history preservation all
exist and are proven against real PostgreSQL. **Nothing calls a provider yet.**

**P2-T2c (real `AbuseIPDBProvider` + explicit TTL policy) is now complete** —
see "Completed — P2-T2c" above. The real HTTP provider (timeouts, HTTP 429/
quota exhaustion, invalid keys and provider outages all mapped onto the
existing P2-T2a status/error taxonomy, never thrown) and the pure
`resolveEnrichmentTtl` policy both exist and are fully tested offline; the
provider registers under the exact lowercase name `abuseipdb` and requires no
API key to construct or import. **Still nothing calls either of them from the
queue layer.**

**Exact next task: P2-T2d — bounded enrichment runner and queue completion
integration.** That packet owns: the consumer that claims queued work via
`enrichmentQueueService.js`, calls `AbuseIPDBProvider.lookup` **outside** any
database transaction, applies `resolveEnrichmentTtl` to the result, and
completes the claim; and the ingestion wiring that schedules enrichment for a
Finding's IPv4 indicator. **Enrichment failure must never block ingestion** —
findings are still created and the `IocEnrichment` row records
`FAILED`/`RATE_LIMITED` instead. API keys from environment variables only,
redacted from all logs and error responses (already proven for the provider
and for `env.js` in P2-T2c). This is a separate path from the existing
KEV/EPSS/NVD vulnerability enrichment design (unchanged, not started) and from
ownership mapping (P2-T1/P2-H1, done) — neither substitutes for either of the
others.

Non-blocking carry-overs from the Phase 1 audit (none gate Phase 2): add a
`RawReport.rawContent` byte-preservation test; fix the `cleanupUpload`
`close`-race; bound/redact file-derived text in `AuditLog.reason`; harden the
`EVAL_DATABASE_URL` equality check.
