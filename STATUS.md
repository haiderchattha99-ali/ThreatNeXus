# ThreatNeXus — Build Status

_Operational status / handoff note. Authoritative plan lives in
`../ThreatNeXus-Planning/` (read-only). This file is not a planning document._

## Current

- **Branch:** `feat/phase-5-framework-ai-assistance` — pushed, no PR opened (not requested). Built on
  `f894894`, which is Phase 4 merged into `main` via PR #5.
- **Phases 0 through 5 are COMPLETE and gate-verified.** 17 migrations, all additive. Nine
  evaluators all pass. Exact next task is **Phase 6 — dedicated professional frontend and
  demonstration readiness** (premium SOC/CERT interface, authorized subtle PKCERT watermark,
  real backend-derived metrics only, accessibility and responsiveness, and final security, Docker,
  CI, end-to-end test, documentation and demo hardening).

_The per-phase notes below are append-only and are kept in reverse-chronological order. Lines
further down describe the state at the time they were written and are not re-edited; the entry
nearest the top is the current one._

### Historical — Phase 2 era

- **Branch (at the time):** `feat/phase-2-enrichment-risk` — pushed, not yet merged (no PR opened per
  the P2-T1 task scope; Phase 1 was merged into `main`, see "Phase 1 release audit" below).
- **Phase:** Phase 1 (Ingest → Finding) is **complete, gate-complete, audited and merged**. Phase 2's
  first task, **P2-T1 (ownership mapping)**, is **complete** — see "Completed — P2-T1" below.
  **P2-H1 (ownership correctness + test hardening)** is also **complete** — see "Completed — P2-H1"
  below. **P2-T2a (IOC enrichment provider contract + MockProvider)** is **complete** — see
  "Completed — P2-T2a" below. **P2-T2b (`IocEnrichment` schema, migration, durable cache/queue)** is
  also **complete** — see "Completed — P2-T2b" below. **P2-T2c (real `AbuseIPDBProvider` + TTL
  policy)** is also **complete** — see "Completed — P2-T2c" below. **P2-T2d (bounded enrichment
  runner + queue completion integration)** is also **complete** — see "Completed — P2-T2d" below.
  **P2-T2e-1 (retry/dead-letter safety, runner hardening, production composition root, audited
  execution service)** is also **complete** — see "Completed — P2-T2e-1" below. **P2-T2e-2 (ingestion
  scheduling, safe enrichment reads, manual/forced scheduling, administrator bounded-batch execution,
  RBAC, audits)** is also **complete** — see "Completed — P2-T2e-2" below. The IOC enrichment workflow
  is now reachable end to end: ingestion → durable scheduling → analyst reads → manual/forced
  re-enrichment → administrator batch execution.
- **P2-T3 (deterministic, explainable risk scoring) is complete** — see "Completed — P2-T3" below.
  The numeric contract is **locked and architect-approved**; "Locked Risk v1 numeric contract"
  immediately below is the versioned decision record for it. Findings are now scored automatically
  at ingestion, on enrichment completion and on ownership change, and analysts can read a score with
  its stored explanation or trigger a manual recalculation.
- **BUILD_PLAN §2B — vulnerability enrichment (CISA KEV, FIRST EPSS, NVD/CVE): COMPLETE AND
  RELEASE-GATED.** Packets A, B and C have all landed; see "Phase 2 §2B COMPLETE AND RELEASE-GATED"
  immediately below. It is a **separate path** from IOC reputation enrichment; neither substitutes
  for the other. **No CVE is ever inferred from an exposed RDP port, banner, hostname, CPE or OS
  guess** — the only source of a CVE association is an explicit analyst assertion.
- **Phase 2 gate status:** the §2C half is met — the rendered explanation reconstructs exactly from
  stored factor rows (proven in `riskScoringConcurrency.test.js` case 13), and score ordering matches
  hand-recomputation on a 19-scenario manually authored sample (`npm run eval:risk`). The §2A half
  was met in P2-T2c/P2-T2e-1. The §2B half is now met by `npm run eval:vulnerability` (41 scenarios,
  992 hand-authored assertions) and `npm run eval:vulnerability:mutation` (12/12 contract mutations
  detected).
- **Ali Haider Chattha's frontend RBAC commit (`4032868`) is merged from `origin/main`** and aligned
  to backend capability enforcement — see "Frontend RBAC integration" immediately below. This is a
  frontend/integration packet only: no schema change, no migration, no Risk v1 or vulnerability-
  intelligence logic touched, and Phase 2 §2B remains release-gated as recorded above.
- **PHASE 2 — COMPLETE AND COMBINED-GATE VERIFIED.** The closing packet landed ownership
  re-resolution, PostgreSQL candidate pushdown, safe sector exposure, ownership consistency
  detection, the combined `eval:phase2` integration gate and its mutation gate — see "Phase 2
  COMPLETE AND COMBINED-GATE VERIFIED" below. **Migration count reached 14 there and
  `backend/prisma/` was byte-identical to its §2B state.**
- **PHASE 3 — COMPLETE. The defensible analyst workflow is delivered end to end**: Finding triage →
  organization-bound case → `CaseFinding` evidence linkage → case lifecycle → organization-response
  tracking → reviewer-approved closure → recurrence-driven reopening, with backend APIs, capability
  RBAC, cross-cutting audits, functional frontend screens and the `eval:phase3` evaluator. See
  "Phase 3 COMPLETE" below. **Exactly one additive migration; migration count 14 → 15.**
- **PHASE 4 — COMPLETE. The notification workflow is delivered end to end**: notification drafting
  from case evidence → immutable revisions → analyst editing → reviewer approval/rejection →
  approved-revision-only manual export → delivery tracking → `CaseOrganizationResponse` integration,
  with backend APIs, capability RBAC, cross-cutting audits, functional frontend screens and the
  `eval:phase4` evaluator. See "Phase 4 COMPLETE" below. **Exactly one additive
  migration; migration count 15 → 16.** Branch `feat/phase-4-notification-workflow`, merged into
  `main` via PR #5.
- **PHASE 5 — COMPLETE. Framework mapping and guarded, optional AI assistance are delivered end to
  end**: append-only MITRE ATT&CK / NIST CSF 2.0 / CIS Controls v8 mappings on organization-bound
  cases → a server-enforced ATT&CK observed-behaviour evidence rule → optional AI mapping
  suggestions, disabled by default → immutable PENDING suggestions → human approve/reject with a
  staleness guard → promotion through the SAME manual mapping service, recording the human as the
  actor, with backend APIs, capability RBAC, cross-cutting audits, a functional frontend workspace
  and the `eval:phase5` evaluator. See "Phase 5 COMPLETE" immediately below. **Exactly one additive
  migration; migration count 16 → 17.** Branch `feat/phase-5-framework-ai-assistance`. Exact next
  task is **Phase 6 — dedicated professional frontend and demonstration readiness**.

## Phase 5 COMPLETE — framework mapping and guarded optional AI assistance (2026-08-05)

Branch `feat/phase-5-framework-ai-assistance`, built on `f894894` (Phase 4 merged via PR #5).
**Exactly one additive migration; migration count 16 → 17.**

    manual framework mapping (ATT&CK / NIST CSF / CIS Controls)
      → append-only history, one current row per (case, framework, scope, reference)
        → safe Case/Finding evidence linkage
          → optional AI mapping suggestions, DISABLED BY DEFAULT
            → immutable PENDING suggestions (inert; change nothing)
              → human APPROVE / REJECT, with a staleness guard
                → promotion through the SAME manual mapping service
                  → ACTIVE mapping, source AI_SUGGESTION_PROMOTED, human actor

### Migration

`20260803140000_add_phase5_framework_mapping_ai_assistance` — additive only: 8 `CREATE TYPE`,
4 `CREATE TABLE`, 12 `CREATE INDEX`, 2 `CREATE UNIQUE INDEX`, 14 `ADD FOREIGN KEY`. Zero
`ALTER COLUMN`, zero `DROP`, no raw SQL, no partial index. Deployed to `threatnexus`,
`threatnexus_test` and `threatnexus_eval`.

**The folder timestamp was hand-corrected.** `prisma migrate dev --create-only` generated
`20260803101835_…`, which sorts BEFORE the hand-named Phase 4 migration `20260803120000_…`. It was
renamed to `20260803140000_…` and the dev database's `_prisma_migrations.migration_name` updated to
match. **Any future phase migration must be checked for this**: Phase 3 and Phase 4 both used
hand-set round timestamps, so a generated one can easily land before them.

New models: `CaseFrameworkMapping`, `AiSuggestionRun`, `AiFrameworkMappingSuggestion`,
`AiSuggestionDecision`. New enums: `FrameworkFamily`, `FrameworkMappingScope`,
`FrameworkMappingState`, `FrameworkEvidenceBasis`, `FrameworkMappingSource`,
`AiSuggestionRunStatus`, `AiSuggestionState`, `AiSuggestionDecisionType`.

### Durable design decisions

- **D-P5-a — one writer, shared by both paths.** `frameworkMappingService.appendMappingWithinTransaction`
  is the ONLY function in the repository that writes a `CaseFrameworkMapping`. The AI promotion path
  calls it — not a copy of it, not a similar one — which is what makes "an approved suggestion is
  held to exactly the standard a hand-written mapping is held to" a structural fact rather than a
  claim. It re-normalizes content and re-checks every database-backed evidence obligation against
  its own `tx`, so no caller can hand it content that skipped a gate.
- **D-P5-b — creation and reactivation are ONE endpoint and ONE code path.** Re-adding a removed
  mapping is a create that happens to find a `REMOVED` current row; the outcome is reported as
  `REACTIVATED` so the story stays distinguishable from `CREATED`. A separate reactivate writer
  would have been a second place the ATT&CK rule and the organization binding could drift.
- **D-P5-c — `currentMappingKey` is `<caseId>:<framework>:<scope>:<referenceId>`, and
  `evidenceFindingId` is deliberately NOT in it.** Changing which Finding a mapping cites is a
  revision of the same mapping, not a second independent one. Scope IS in the key, so the same
  reference may legitimately be mapped once at case scope and once at finding scope.
- **D-P5-d — the ATT&CK rule is three structural gates plus one lexical backstop, and the
  documentation says exactly that.** Structural: `evidenceBasis` must be `OBSERVED_BEHAVIOR`; the
  rationale must reach a 60-character substance floor; evidence must be tied to the case or a
  currently-linked Finding. Lexical: at least one term from a closed behaviour vocabulary must
  appear, and the residual substance after stripping a closed exposure vocabulary must exceed a
  floor. **The lexical gate is documented as a bounded guard, never as comprehension** — it catches
  the overwhelmingly common "port 3389 is open, therefore T1021.001" mistake and cannot catch a
  fluent fabrication. It fails closed. *Measured during development: the exposure-only fixture sat
  exactly ON the residual threshold until bare `exposed`, `internet` and `score` were added to the
  exposure vocabulary — "exposed to the internet" is how such a rationale is actually written.*
- **D-P5-e — no catalogue is claimed, and every read path says so.** `referenceValidated: false` is
  emitted as a LITERAL on every mapping and every suggestion, and `CATALOGUE_DISCLAIMER` travels
  with every read. `T9999` passes the ATT&CK shape check and does not exist. Emitting the field
  (rather than omitting it) means a future pinned catalogue can flip it to `true` and every existing
  consumer already renders the distinction. `frameworkVersion` is REQUIRED and never defaulted.
- **D-P5-f — no denominator anywhere, therefore no percentage.** Group counts are labelled
  `MAPPING_COUNT_NOT_COVERAGE` in the payload itself, not just in a comment. A coverage figure would
  require knowing how many references SHOULD apply, which nobody knows, and printing one creates
  exactly the pressure to force weak mappings that `BUILD_PLAN.md` warns about.
- **D-P5-g — the AI prohibition is enforced by what the interface OMITS.** A provider is
  `{name, model, isEnabled, suggestMappings({snapshot, asOf, signal})}`. It receives no Prisma
  client, no transaction, no repository, no HTTP handle, no user, no capability, no audit logger and
  no file handle — so it cannot score, approve, close, reopen, export, notify, enrich, scan, attach
  a CVE or resolve ownership, because it is handed nothing to do any of it with. Providers are
  `Object.freeze`d, so nothing can graft a capability on at runtime either. *(That freezing is why
  `vi.spyOn` cannot patch a provider; tests inject their own runtime-shaped double instead.)*
- **D-P5-h — `aiEnabled` and `assistanceAvailable` are two different questions and are never
  collapsed.** The first is what the operator asked for; the second is what the system can actually
  do. They differ when `AI_ENABLED=true` but `AI_PROVIDER` names something unregistered — which,
  today, is every value except `disabled`. Reporting only one would show an operator a green light
  over a provider that does not exist.
- **D-P5-i — no silent fallback from production to mock, ever.** The registry returns the mock ONLY
  with an explicit `allowMockProvider: true`, and `aiRuntime` (the one production composition root)
  never passes it. An unavailable provider resolves to the disabled provider with reason code
  `AI_PROVIDER_NOT_AVAILABLE` — never to fabricated suggestions presented as a real assistant's.
- **D-P5-j — the staleness fingerprint covers evidence ONLY.** `requestContext` (what the analyst
  asked this time) is part of the snapshot sent to the provider but is excluded from the hash — it
  describes the question, not the case. It is attached AFTER the hash is computed, so it
  structurally cannot influence it. Linking a Finding, retriaging, rescoring, asserting a CVE or
  adding a mapping all move the fingerprint, and a stale suggestion is REFUSED rather than silently
  re-derived or approved as "close enough".
- **D-P5-k — a repeated decision is recorded, not swallowed.** Deciding an already-decided
  suggestion returns `ALREADY_DECIDED_UNCHANGED`, writes no mapping, does not overwrite the original
  decision, and STILL appends an `AiSuggestionDecision` row. `promotedMappingId` is `@unique`, so a
  second mapping is structurally impossible. Same reasoning as `CaseRecurrenceReopen` recording its
  `SKIPPED_*` evaluations.
- **D-P5-l — `DISABLED` is a recorded run, not an error.** Asking for suggestions while AI is off is
  a legitimate request with a legitimate answer, and the run is persisted so "somebody asked and the
  system was off" stays distinguishable from "nobody ever asked". The API answers 200, not 503: the
  shipped default is "off", not "broken".
- **D-P5-m — mapping reads reuse `read:cases`; no `read:framework-mappings` exists.** Reading which
  controls an analyst associated with a case IS reading the case, and the policy is identical for
  all four roles. Compare `READ_NOTIFICATIONS`, which DID need to exist because the notification
  read policy genuinely differs by role.
- **D-P5-n — the pre-existing `review:ai-suggestions` grant is deliberately left UNUSED.** It was
  declared in Phase 0 on a review-of-somebody-else's-work model (REVIEWER + ADMIN) and never wired
  to a route. Under it, a REVIEWER holding no mapping authority at all could have promoted machine
  output into an active mapping. Phase 5 instead grants `decide:ai-mapping-suggestions` to exactly
  the holders of `manage:framework-mappings`, so **approval authority never exceeds the authority to
  write the same mapping by hand**. `review:ai-suggestions` stays declared and granted; a
  `roles.test.js` case asserts it is not the same capability.
- **D-P5-o — VIEWER sees active mappings, never a machine proposal.** VIEWER holds `read:cases` (so
  the mapping list and history are visible, including that a mapping's `source` is
  `AI_SUGGESTION_PROMOTED` — an approved, human-decided display fact) and does NOT hold
  `read:ai-mapping-suggestions`. An undecided proposal is not oversight material. The frontend does
  not even issue the suggestion request for VIEWER, since a 403 toast on a screen the role is
  entitled to use would be a defect.
- **D-P5-p — audit payloads carry LENGTHS, not analyst prose.** `rationaleLength` and
  `decisionReasonLength` are recorded; the rationale and the rejection reason are not, in any form,
  not even truncated. `AuditLog` is read far more widely than a case is. Fingerprints, prompts,
  snapshots and provider output never reach it either — none of which is persisted anywhere to
  leak.

### Frontend

`components/FrameworkMappingPanel.jsx` + `constants/frameworkMapping.js`, embedded in Case Detail
after the evidence and response sections (a mapping is a judgement made ABOUT that evidence and
should be read after it). Anti-automation-bias controls, each asserted by a test: no accept-all and
no bulk control, one suggestion at a time with its own decision, nothing pre-selected, evidence
beside the buttons, a rejection reason required before Reject enables, decided suggestions kept
visible, and a stale suggestion shown as unapprovable with the reason rather than failing on click.
Provider confidence is rendered as "the model's own claim, not an assessment by this system". The
panel renders the SERVER's disclaimer verbatim rather than re-wording it, so the two cannot drift.

**Frontend gotcha, will recur: MUI v9 removed `inputProps`.** Labels now come from `label` alone —
and `required` appends the required marker to the label text, so `getByLabelText('Reference id')`
misses a required field. Use an anchored regex (`/^Reference id/`).

### Verification matrix at close

| Check | Result |
|---|---|
| Backend suite, real PostgreSQL, `--no-file-parallelism` | **2850 / 2850 across 115 files** (was 2650/108) |
| Phase 5 real-PG concurrency suite | **14 / 14**, separate pre-connected clients |
| Phase 5 route/RBAC suite | **53 / 53**, every denial proven to create no row |
| Phase 5 unit suites | 27 rules + 33 AI contract + 38 services + 15 serializer + 20 boundaries |
| Frontend suite | **129 / 129 across 9 files** (+30 panel tests → 159 after the ADMIN case) |
| Frontend production build | clean |
| `npm run lint` (oxlint) | 6 warnings, all pre-existing |
| `eval:phase1` | PASS |
| `eval:risk` | PASS — 19 scenarios |
| `eval:phase2` / `:mutation` | PASS — 22 scenarios / 112 assertions; 6 / 6 mutations detected |
| `eval:vulnerability` / `:mutation` | PASS — 41 scenarios / 992 assertions; 12 / 12 mutations detected |
| `eval:phase3` | PASS — 12 scenarios / 151 assertions |
| `eval:phase4` | PASS — 14 scenarios / 151 assertions |
| **`eval:phase5`** | **PASS — 14 scenarios / 148 assertions**, zero network attempts |
| `prisma validate` | clean |
| `migrate deploy` (test + eval databases) | applied, none pending |
| Migration count | **17** |
| `git diff --check` | clean |
| Secret / generated-artifact scan | clean |

`eval:phase5` safety guards verified directly: it refuses to run without `EVAL_DATABASE_URL`, and
refuses to run when `EVAL_DATABASE_URL` equals `DATABASE_URL`.

### Risk v1 and Phases 1–4 are unchanged

No file under `backend/src/services/risk/` was touched. `eval:risk` passes unchanged at 19
scenarios, and both `eval:phase5` scenario S13 and a real-PG test assert that a full
generate-and-approve cycle leaves the stored score, band, algorithm version, configuration version,
input fingerprint, current-row pointer and factor contributions numerically identical, with no new
score row appended. The only edits outside new Phase 5 files were additive: `schema.prisma`
back-relations, two route registrations in `app.js`, four capabilities in `roles.js`, the shared
test fake, and the frontend capability mirror.

### Known limitations carried forward

- No pinned framework catalogue — references are format-checked, never verified to exist.
- No live AI provider. The contract, the disabled provider and an offline mock exist.
- The ATT&CK lexical gate cannot detect a fluent, well-worded fabrication. The structural gates and
  the recorded human actor are what carry that weight.
- The frontend "reactivate" control pre-fills from history; the list of linkable Finding ids is not
  fetched separately, so a finding-scoped mapping needs the id typed. The server is the authority
  and refuses anything not currently linked.

## Phase 4 COMPLETE — notification drafting, review, manual export, delivery (2026-08-03)

Branch `feat/phase-4-notification-workflow`, built on `13d0b43` (Phase 3 merged via PR #4).
**Exactly one additive migration; migration count 15 → 16.**

    notification drafted from case evidence
      → immutable revisions (exactly one current)
        → analyst editing
          → reviewer approval bound to an exact revision
            → approved-revision-only manual export
              → delivery tracking (never inferred)
                → shared CaseOrganizationResponse timeline

### Schema and migration

`20260803120000_add_phase4_notification_workflow` — strictly additive: 4 `CREATE TYPE`, 4
`CREATE TABLE`, one `ALTER TABLE` adding only nullable or defaulted `Notification` columns, plus
indexes and foreign keys. No `DROP`, no column retype, no raw SQL, no partial index. Every
pre-existing `Notification` row stays valid.

**The existing `Notification` model is EXTENDED, never duplicated.** There is deliberately no second
notification entity: `notificationReference`, `caseId`/`organizationId`, `lifecycleState`,
`createdByUserId` and the approval projection (`approvedRevisionId`/`approvedByUserId`/`approvedAt`)
are all new nullable or defaulted columns on it. A row with a null `caseId` is a legacy Phase 0
notification — readable, excluded from every Phase 4 list, and refused by every workflow operation
(`assertWorkflowBound`), exactly as a legacy non-organization-bound `Case` is in Phase 3.

Four append-only models: `NotificationRevision`, `NotificationLifecycleEvent`,
`NotificationExport`, `NotificationDeliveryEvent`.

**Two invariants are database constraints, not checked-and-hoped-for properties.**
`NotificationRevision.currentForNotificationId` reuses the repository's established distinct-NULLs
mechanism (D-006/D-007) so at most one revision is current; the composite
`@@unique([notificationId, revisionNumber])` is what stops two concurrent edits both becoming
revision N+1. No raw SQL, no partial index.

Every FK onto `Notification` / `NotificationRevision` / `NotificationExport` / `Case` /
`Organization` is `Restrict` so an approval, an export or a delivery claim can never be orphaned;
every actor FK is `SetNull` so deleting a user nulls attribution without destroying the record that
justified an approval.

**The artifact bytes are deliberately not stored.** Persisting the generated message would put
constituent-addressed content and a recipient address into a second table with a different retention
story, for no gain: the revision is immutable, the builder is deterministic, and
`artifactChecksum` + `artifactByteLength` prove the bytes an analyst holds are the bytes we produced.

### Locked semantics, as implemented

- **Every meaningful edit creates an immutable revision; exactly one is current.** A prior row is
  touched only by the supersede stamp (`supersededAt` + `currentForNotificationId → null`), in the
  same transaction that inserts its replacement. Content is never rewritten.
- **An identical edit is UNCHANGED, not a new revision.** The comparison is made on normalized
  CONTENT (`contentEquals`), not on the stored checksum alone — a checksum collision must never read
  as identity, and a stale stored value must never read as a difference. UNCHANGED is audited and
  returned as a first-class outcome, so a UI can say "your edit changed nothing" rather than
  silently showing no new revision.
- **Editing destroys a standing approval, by stored state rather than by a comparison.** Creating
  any revision clears the whole approval projection and returns the notification to DRAFT *in the
  same statement as the state change*, so no reader can observe an APPROVED-looking projection
  against a newer revision. The approval EVENT survives in `NotificationLifecycleEvent`, which is
  never rewritten. **This includes a notes-only edit** — the exported artifact would be
  byte-identical, but the reviewer approved a record that has since changed, and treating that as
  still-approved is the wrong default for a system whose purpose is a defensible approval trail.
- **PENDING_REVIEW is not editable.** Editing while a reviewer is deciding would change the content
  out from under them — the same class of defect Phase 3 found when an analyst could withdraw a
  pending closure by posting a bare target state (D-P3-a). The recovery path is the reviewer's: they
  reject, and the analyst then edits into a new DRAFT.
- **The content checksum is computed from content alone.** Canonical, field-ordered, version-tagged,
  with an explicit length prefix on each value so text moved across a field boundary cannot produce
  the same digest. Deliberately excludes row ids, revision numbers, timestamps, actor identity,
  database row order, environment values, secrets and any error text — which is what makes it usable
  both as a no-op detector and as an integrity re-check at export time.
- **Approval names a revision, or it is not an approval.** The current revision is re-read INSIDE the
  transaction, so a concurrent edit cannot slip different content under a decision in flight: the
  edit moves the notification to DRAFT and the guarded `PENDING_REVIEW → APPROVED` transition then
  finds no row to update and fails with `CONCURRENT_STATE_CHANGE`.
- **The author or submitter may not approve their own revision** unless they hold the ADMIN-only
  `override:notification-self-approval`. Enforced in the service from a **capability-derived boolean
  supplied by the controller, never a role string**, so the service holds no role knowledge at all.
  The disqualified set is read from durable rows (the revision's `createdByUserId` and the actor on
  the most recent `SUBMITTED_FOR_REVIEW` event **for that exact revision**) — an earlier revision's
  submitter is not disqualified from reviewing a later one they had no hand in. An unattributed
  revision is not self-approval: `null === null` must not lock the review out.

### Manual export — nothing is sent, ever

There is no SMTP client, no webhook, no messaging SDK, no `mailto:` launch and no scheduler anywhere
in this system, by design. `notificationArtifactBuilder.js` requires exactly two modules — `crypto`
and the pure rules — and a test asserts that dependency list literally, so a future edit reaching for
`nodemailer`/`axios`/`node:net` fails the suite.

**THE guard** (`evaluateExportEligibility`, pure and unit-tested branch by branch) permits an export
only when: state is `APPROVED`; a current revision exists; an approval exists; it names the **exact**
current revision id; `approvedByUserId` is non-null (the AGENTS.md rule, enforced literally); the
stored checksum still matches the stored content; the revision still belongs to this notification;
and a valid recipient exists. It runs **inside** the transaction against re-read rows, and a refusal
throws before any row is written — proven by counting `NotificationExport` rows across the whole
refusal matrix. Refusals carry a closed `EXPORT_REFUSAL_CODES` value the UI renders as advice.

The artifact is an **RFC 5322 `.eml`**: CRLF throughout, RFC 2047 encoded-word for non-ASCII headers,
RFC 2045 quoted-printable body (chosen over base64 so an analyst can read what they are about to
send, and over raw 8-bit so it is 7-bit clean), correct `message/rfc822` content type, and a filename
sanitized to `[A-Za-z0-9._-]` with dot-runs collapsed. A `TXT` variant is offered for environments
where a `message/rfc822` attachment is unacceptable.

**Header injection is prevented twice.** `notificationRules` rejects control characters in every
single-line field at WRITE time, so a CR or LF cannot be stored at all; the builder re-checks and
**throws rather than sanitizing**, because a stored value that should have been impossible is an
alarm, not something to quietly clean up. The recipient pattern additionally rejects the RFC 5322
specials (comma, semicolon, angle brackets, colon, quotes, backslash, parentheses) that would change
a `To:` header's meaning.

Never in the artifact: Bcc or any second recipient, `analystNotes`, database ids, checksums, API
keys, filesystem paths, organization contact detail beyond the single approved recipient, **a
Message-ID** (this system does not send the message and has no authority to mint its identifier; a
fabricated one would be indexed by the recipient's mail system as though a real transmission
occurred), and **no real From address** — RFC 5322 requires the field, so it carries the RFC 2606
reserved `.invalid` TLD, which cannot resolve and cannot be replied to by accident.

Repeated exports are permitted and each creates its own immutable row and `EXPORTED` event. The
lifecycle state is deliberately unchanged by an export: exporting is a recorded act on an APPROVED
notification, not a transition.

### Delivery tracking — export is not delivery

`NotificationExport` and `NotificationDeliveryEvent` are two tables because exporting is something we
did and can prove, while delivery is something a human observed afterwards and must assert.

Nothing in the codebase writes a delivery row on its own — there is no call to the delivery service
from the export path, ingestion, a scheduler or any runner; it is reachable only from the HTTP route
an analyst posts to. `DELIVERED` is never inferred from an export, a download, elapsed time or the
absence of a bounce. `occurredAt` is **required and always caller-supplied** (defaulting it would
fabricate the one timestamp a delivery timeline exists to record accurately); `recordedAt` is
server-captured and the two are never conflated. No provider receipt or message identifier is ever
synthesized. Rows are append-only: a correction is a further event, so the original claim and the
correction both stay visible. A delivery claim is refused unless the notification has actually been
exported — this system's only outbound act — and a named `exportId` must belong to that notification.
A bounce does not un-approve anything.

### CaseOrganizationResponse reuse

There is **no** `NotificationResponse` table and no Phase 4 response service.
`POST /api/notifications/:id/responses` calls the Phase 3 `caseResponseService` directly against the
notification's bound case, so exactly one `CaseOrganizationResponse` row is written, carrying the
same validation, the same `case.response.recorded` audit event and the same failure-isolation
behaviour as the case route. The case timeline and the notification view render the same canonical
row **because there is only one row** — asserted by id equality in the evaluator and under real
PostgreSQL. It is gated on the existing `manage:cases` rather than a new capability: the authority to
record what an organization said is the same authority from either screen, and a second capability
would let the two drift. A response still closes nothing, and `REMEDIATED` remains only a Phase 3
closure precondition.

### APIs and RBAC

Five additive, non-hierarchical capabilities in `lib/roles.js`:

| Capability | ADMIN | ANALYST | REVIEWER | VIEWER |
| --- | --- | --- | --- | --- |
| `read:notifications` | yes | yes | yes | **no** |
| `manage:notifications` | yes | yes | no | no |
| `review:notifications` (existing) | yes | no | yes | no |
| `export:notifications` | yes | yes | no | no |
| `record:notification-delivery` | yes | yes | no | no |
| `override:notification-self-approval` | yes | no | no | no |

**VIEWER is deliberately excluded from notification reads.** The approved pre-Phase-4 policy gated
the whole router behind `review:notifications` (REVIEWER + ADMIN only), so VIEWER never had access;
Phase 4 widens that policy only as far as the workflow requires — to the drafting role.

`/api/notifications` moved from a single router-level `requireCapability(REVIEW_NOTIFICATIONS)` to
router-wide `authenticate` plus a per-route capability, the same split Phase 3 applied to
`/api/cases`.

    read:notifications            GET  /api/notifications   /:id   /:id/history
    manage:notifications          POST /api/notifications              (draft from case)
                                  PUT  /api/notifications/:id          (edit current revision)
                                  POST /api/notifications/:id/submit
                                  DELETE /api/notifications/:id        (409 tombstone)
    review:notifications          POST /api/notifications/:id/approve
                                  POST /api/notifications/:id/reject
    export:notifications          GET  /api/notifications/:id/export   (download artifact)
    record:notification-delivery  POST /api/notifications/:id/deliveries
    manage:cases                  POST /api/notifications/:id/responses

No role name appears in any Phase 4 controller. A denied request is answered by middleware before any
service is reached and **creates no rows** — asserted by counting durable rows across the whole
denied matrix. `DELETE` is a compatibility tombstone that always answers 409, deletes nothing, and
deliberately does not look the notification up first: answering 404 for an unknown id and 409 for a
known one would turn the endpoint into an existence oracle.

The legacy Phase 0 notification CRUD controller was **deleted** rather than kept as dead code beside
the workflow, matching how Phase 3 removed the unused `RoleGuard.jsx`.

`notificationSerializers.js` is the single allow-list choke point. It constructs fresh objects from
named fields rather than deleting keys from a row, so a future migration cannot silently start
leaking a column. Never emitted: `currentForNotificationId`, verbatim recipient addresses (masked to
`s**@domain`), organization contacts, artifact bytes, audit rows, filesystem paths, or the legacy
unversioned `title`/`message`/`severity`/`status`/`type` projection. **One deliberate exception is
documented in the module header and asserted by the evaluator:** `recipientName` is emitted in full
because it is the approved recipient of the message and a reviewer who cannot see who a notification
is addressed to cannot meaningfully approve it — it reaches only holders of `read:notifications`, the
address beside it is still masked, and the evaluator asserts the name appears nowhere else.

### Auditing

Bounded events on every write path, emitted by the services themselves (controllers pass
`auditContext` through and never audit twice): `notification.draft.created`,
`notification.revision.created` / `.unchanged`, `notification.review.submitted`,
`notification.approved`, `notification.rejected`, `notification.export.requested` / `.completed` /
`.refused` / `.failed`, `notification.delivery.recorded`. Recording an organization response emits
the shared Phase 3 `case.response.recorded`, never a Phase 4 duplicate.

Every payload is an explicit allow-list. The notification body, subject text, recipient address,
artifact bytes, full rejection reason and full response summary are reduced to booleans or lengths,
never copied — asserted by substring search over the whole audit trail. `Error.message`, stacks and
Prisma codes never reach `AuditLog`; failure reasons are closed vocabulary strings. A refused export
is audited `DENIED` with its closed refusal code. `notification.export.completed` records
`delivered: false` explicitly so nobody reading the trail can mistake an export for evidence that
anything was sent, and a `DELIVERED` claim is recorded as "claim recorded, not verified by this
system". Audit failure never rolls back a revision, an approval, export metadata, a delivery record
or an organization response.

### Frontend

Backend-connected workflow screens on the existing design system:

- `pages/Notifications.jsx` (rewritten) — reference, organization, subject, authoritative
  `lifecycleState`, current revision number, export and delivery counts, with state tiles counted off
  `lifecycleState` so they cannot disagree with the workflow. The **"Exportable" badge comes from the
  server's `exportEligible`**, never from the state alone — an APPROVED notification edited
  afterwards is not exportable and must not look like it is. The empty state directs the analyst to a
  case rather than offering a "New notification" button that could not work.
- `pages/NotificationDetail.jsx` (new) — draft editor, reviewer approval/rejection panel,
  approved-only export control with the server's refusal reason rendered as advice, export history
  with artifact fingerprints, append-only delivery timeline, the case's canonical organization-response
  timeline, immutable revision history and the full lifecycle/review history.
- `constants/notificationWorkflow.js` (new) — the presentation vocabulary plus
  `describeNotificationError` / `describeExportRefusal`, which render the backend's closed codes as
  advice an analyst can act on ("it was edited after it was approved, so the approval no longer
  covers the current revision") rather than an error code.
- `pages/CaseDetail.jsx` — a Notifications section listing the notifications drafted from that case,
  with a "Draft notification" control for holders of `manage:notifications` and navigation in both
  directions. The list load is deliberately non-fatal so the case screen stays usable for a caller
  who may read the case but not notifications.

Every control is rendered from the intersection of two independent facts: `permittedActions`, which
the backend derives from the notification's **durable state alone** and which says nothing about the
caller, and the caller's own capability list. **This is UX only** — the backend re-checks the
capability (route middleware) and the state (service) on every request regardless. A no-send banner
states the guarantee on the screen itself, and a test asserts no `mailto:` link or send control is
ever rendered.

### Verification (all re-run at commit time)

**204 new/changed backend tests.** Every one reads the database's durable rows rather than a service
return value, because the properties under test are about what was *written*.

| Suite | Tests | What it proves |
| --- | ---: | --- |
| `tests/unit/notificationRules.test.js` | 57 | the closed vocabularies, bounded text, the control-character guard, checksum determinism and field-boundary safety, the state guards, and THE export eligibility matrix branch by branch |
| `tests/unit/notificationArtifactBuilder.test.js` | 35 | RFC 5322 structure, CRLF, RFC 2047, quoted-printable (including trailing-whitespace and 76-column rules), filename sanitization, header-injection throws, and that no transport dependency exists |
| `tests/unit/notificationServices.test.js` | 58 | append-only revisions, one current revision, UNCHANGED, submission, approval bound to an exact revision, self-approval, the export guard, delivery, audit isolation and audit payload exclusion |
| `tests/unit/notificationSerializerSafety.test.js` | 28 | the exclusion proof the serializer's header promises, against contaminated real row shapes |
| `tests/integration/notificationRouteAuthorization.test.js` | 76 | the whole HTTP surface, the five-capability matrix, and that a denied request creates no rows |
| `tests/integration/notificationWorkflowConcurrency.test.js` | 12 | the same invariants against real PostgreSQL under genuine concurrency |

The real-PostgreSQL suite uses **separate pre-connected `PrismaClient` instances** throughout —
`Promise.all` over one shared client serializes enough to hide the race, the trap this repository has
already been bitten by twice.

Three existing suites were amended for the Phase 4 grants rather than worked around:
`tests/unit/roles.test.js` (capability count), `tests/integration/resourceRouteAuthorization.test.js`
(notifications removed from the generic id-CRUD matrix, since the surface is now a workflow with five
capabilities, a case-id create and a 409 delete), and the frontend `Sidebar` / `permissions` fixtures.

**Combined gate results:**

- Full backend suite with `TEST_DATABASE_URL` + `EVAL_DATABASE_URL` and `--no-file-parallelism`:
  **2650 passed / 2650, 108 files** (was 2404 before this phase).
- Phase 4 real-PostgreSQL concurrency suite: **12/12, stable across 3 consecutive runs.**
- Frontend: **100/100 across 8 files**, clean production build, `oxlint` clean of any new warning.
- `npm run eval:phase1` PASS · `eval:risk` 19/19 · `eval:phase2` 22 scenarios / 112 assertions ·
  `eval:phase2:mutation` 6/6 · `eval:vulnerability` 41 scenarios / 992 assertions ·
  `eval:vulnerability:mutation` 12/12 · `eval:phase3` 12 scenarios / 151 assertions ·
  **`eval:phase4` 14 scenarios / 151 assertions, rerunnable.**
- `npx prisma validate` clean; `migrate deploy` reports **16 migrations, none pending** on both
  `threatnexus_test` and `threatnexus_eval`; migration count is exactly **16**.
- `git diff --check` clean; no secret, credential or generated artifact in the diff; no `.eml` or
  `.txt` artifact written anywhere in the tree; no real network call anywhere in the suite or in any
  evaluator (the Phase 4 gate replaces `global.fetch` with a throwing stub and asserts zero attempts).

**Both environment rules from Phase 2/3 still apply and were followed:** never export `JWT_SECRET`
globally when running the backend suite, and real-PostgreSQL suites must run with
`--no-file-parallelism`.

### Two pre-existing defects fixed in passing (both outside Phase 4's scope)

1. **`evalRiskGate.test.js` had the documented CRLF gate-test bug.** Four tamper cases built their
   mutations from hardcoded LF-joined strings and `.replace()`d them against the raw file text; on a
   `core.autocrlf=true` checkout the working copy is CRLF, so every replace matched nothing, the
   "tampered" text was identical to the original, and the tests failed because there was never
   anything wrong with the input. This is the same defect class `evalGroundTruthLoader.test.js`
   already documents for the Phase 1 gate. Fixed by normalizing the ground-truth text to LF at read
   time (the loader itself is line-ending agnostic, proven in that block). Test-only change.
2. **`frontend` would not build**: `main.jsx` imports `leaflet/dist/leaflet.css` and `leaflet` was
   declared in `package.json` by the merged dashboard-redesign commit but not installed locally.
   Resolved by `npm install`; no code change.

### Accepted limitations

- **No paging controls on the notification list.** The API is bounded and paged (`page`/`limit`,
  max 50) and the screen requests the first page with a state filter; a page selector is not
  rendered, and the count line says so explicitly rather than implying the list is complete.
- **The recipient address is snapshotted at drafting time and is not re-synced** if the organization
  registry contact changes later. That is deliberate — a later registry edit must not silently
  re-target an approved notification — but it means correcting a recipient requires an edit, which
  creates a revision and invalidates a standing approval.
- **A notification cannot be drafted from a closed case** (`CASE_CLOSED`), by the same reasoning
  `caseResponseService` refuses responses there. Notifying about a concluded case requires reopening
  it first.
- **The export artifact is not retained.** Its checksum and byte length are, which supports a later
  integrity dispute but not reconstruction of the exact file if the analyst loses it. Re-exporting
  the same unedited revision reproduces byte-identical content apart from the `Date:` header.
- **No live mail-client integration and no delivery-receipt ingestion**, by design — both are the
  out-of-scope "automatic notification sending" the build plan forbids.

### Exact next task

**Phase 5 — framework mappings and guarded optional AI assistance.**

- **Manual framework mappings first.** A working manual mapping path is the deliverable; AI mapping
  suggestions are additive on top of one, never a replacement for one (AGENTS.md).
- **AI suggestions are off by default** (`AI_ENABLED=false`). Every core workflow must complete
  correctly with AI off — the same standard Phases 1–4 already meet, since no AI provider exists in
  the repository at all today.
- **Human approval is required** for any AI-produced suggestion to become a stored mapping.
- **AI cannot score, approve, send, close or resolve anything.** It cannot make a final framework
  mapping, cannot approve or export a notification, cannot decide a case closure, and cannot
  influence a Risk v1 number — risk scoring stays deterministic and explainable from stored factor
  contributions, never AI-decided.

## Phase 3 COMPLETE — defensible analyst workflow (2026-08-01)

Branch `feat/phase-3-analyst-workflow`, built on `8945ae6` (Phase 2 complete and combined-gate
verified). **Exactly one additive migration; migration count 14 → 15.**

    Finding triage
      → organization-bound case
        → CaseFinding evidence linkage
          → case lifecycle
            → organization-response tracking
              → reviewer-approved closure
                → recurrence-driven reopening

### Schema and migration

`20260731120000_add_phase3_analyst_workflow` — strictly additive: 10 `CREATE TYPE`, 6 `CREATE
TABLE`, one `ALTER TABLE` adding only nullable or defaulted `Case` columns, and indexes. No `DROP`,
no column retype, no raw SQL, no partial index. `Notification` is untouched and every pre-existing
`Case` row stays valid.

Six append-only models: `FindingTriage`, `CaseFinding`, `CaseLifecycleEvent`,
`CaseOrganizationResponse`, `CaseClosureRequest`, `CaseRecurrenceReopen`. The existing `Case` model
is **extended**, never duplicated — `caseReference`, `organizationId`/`ownerOrganization`,
`lifecycleState`, `createdByUserId`, the current-closure projection and the reopen projection are
all new nullable/defaulted columns. The legacy free-text `Case.organization` String column is
preserved verbatim, which is why the Phase 3 relation is named `ownerOrganization`.

**Three one-current-row invariants reuse the repository's established distinct-NULLs mechanism**
(D-006/D-007): `FindingTriage.currentForFindingId`, `CaseFinding.currentLinkKey`
(`"<caseId>:<findingId>"`) and `CaseClosureRequest.activeCaseId`. PostgreSQL treats multiple NULLs
in a unique index as distinct, so unlimited history rows coexist while at most one row is current —
no raw SQL, no partial index.

**`CaseRecurrenceReopen`'s composite unique `(findingOccurrenceId, caseId)` is the recurrence
idempotency key.** `FindingOccurrence`'s own identity is not sufficient: one recurrence fans out to
several linked cases, each of which needs its own decision recorded and each of which must be
re-runnable exactly once.

Every FK onto `Case` / `Finding` / `FindingOccurrence` / `Organization` is `Restrict` so evidence can
never be orphaned; every actor FK is `SetNull` so deleting a user nulls attribution without
destroying the record that justified a closure.

### Two real defects found while building (both fixed, both now covered by tests)

**D-P3-a — the analyst state endpoint could silently withdraw a pending closure.**
`changeCaseState` originally constrained only the TARGET state to `{OPEN, WAITING_FOR_ORG}`. But
`CLOSURE_PENDING → OPEN` is a legitimate transition — it is exactly how a REVIEWER *rejects* a
closure — so an analyst posting `{toState: "OPEN"}` on a `CLOSURE_PENDING` case moved it back to
OPEN without any reviewer decision, leaving an orphaned `PENDING` `CaseClosureRequest` still holding
its `activeCaseId`. Fixed by constraining the SOURCE as tightly as the target
(`ANALYST_SETTABLE_FROM_STATES` + `assertAnalystSettableFrom`), enforced both before and inside the
transaction, and by deriving `permittedActions.availableStates` from the same
`analystAvailableStates()` helper the service guards with — one rule, two consumers, so the UI can
neither offer a transition the service would refuse nor hide one it would accept.
`ANALYST_SETTABLE_FROM_STATES` is deliberately a separate constant from `ANALYST_SETTABLE_STATES`:
they answer different questions ("where may this end up" vs "where may this start").

**General lesson: when a state machine's transition table is shared by more than one actor,
restricting the target is not enough — restrict the source too.**

**D-P3-b — SERIALIZABLE was the wrong isolation level for case creation.** Six concurrent
`createCase` calls exhausted the bounded whole-transaction retry budget and surfaced a raw P2034,
with and without backoff. The creation transaction only INSERTs, and its `caseReference` is derived
from the primary key the database itself assigns, so no interleaving can produce a duplicate — but
SERIALIZABLE takes predicate locks on the `caseReference` unique index, making concurrent creations
conflict on index-page adjacency rather than on any data dependency. Fixed by adding `runAtomic`
(connection-default isolation, same bounded retry) alongside `runSerializable`, and using it for
creation only.

**The rule is now written into `workflowTransaction.js`: if the callback re-reads state and then
writes based on it, use `runSerializable`; if it only inserts, use `runAtomic`.** Bounded jittered
backoff (25 ms × attempt, capped at 200 ms, plus jitter) was added to both — retrying a serialization
failure instantly makes every loser wake at the same instant and re-collide in lockstep until the
budget is gone.

### Locked workflow semantics, as implemented

- **Triage is separate from exposure state.** Nothing in `findingTriageService` reads or writes
  `Finding.status`. `UNTRIAGED` is the *absence* of a `FindingTriage` row, never a stored enum value
  — an enum member would need a row, and writing one would give every Finding ever ingested triage
  history it never received. Append-only: the only mutation ever applied to a prior row is
  `supersededAt` + `currentForFindingId → null`, in the same transaction that inserts its
  replacement.
- **Workflow-driven escalation is guarded.** Linking evidence and a recurrence reopening a case both
  escalate a Finding, but only when `isEscalationMeaningful` — a re-link or a repeated recurrence on
  an already-`ESCALATED` Finding writes nothing. Without that guard, triage history would stop being
  a record of decisions and become a log of system activity.
- **The organization-matching rule is the load-bearing safety property.** A Finding may be linked
  only when its current ownership settled on exactly the case's organization by a mechanism that
  identifies the constituent (`RESOLVED` or `OVERRIDDEN`, and not ISP-attributed). Ambiguous,
  unresolved, ISP-attributed and mismatched ownership are all refused with a closed reason code
  telling the analyst to resolve ownership first. **ISP attribution is checked *before* the
  organization comparison** — an ISP row can name the right organization id and still be the wrong
  answer, and reporting "mismatch" there would send the analyst to fix the wrong thing. Ownership is
  re-read *inside* the transaction so a concurrent `clearOverride` cannot be raced past.
- **Linking copies nothing.** A `CaseFinding` row records only that a link exists (or existed) and
  the ownership basis on which it was accepted. Indicator, occurrences, ownership, enrichment and
  risk all stay in their own tables and are read from there.
- **A REMEDIATED organization response never closes anything.** It is a claim by the affected party,
  and `caseResponseService` performs no lifecycle transition of any kind. It becomes load-bearing
  only as a *precondition*: a REMEDIATED closure is refused without one, and the specific supporting
  row is persisted as `CaseClosureRequest.supportingResponseId` (Restrict), so the rule leaves
  durable evidence rather than merely having been true once.
- **Closure takes two authorities.** ADMIN/ANALYST request (`manage:cases`); REVIEWER/ADMIN decide
  (`review:case-closure`). The requester may not approve their own request unless they hold
  `override:closure-self-approval` (ADMIN only). The service enforces this from a **capability-derived
  boolean supplied by the controller, never a role string**, so the service holds no role knowledge
  at all. An unattributed request (`requestedByUserId` null) is not self-approval — the check
  requires a real integer on both sides, or deleting the requesting user would lock the review out.
- **Only a REMEDIATED closure is auto-reopened by a recurrence.** `FALSE_POSITIVE`, `ACCEPTED_RISK`,
  `DUPLICATE` and `OTHER` were all decided in full knowledge that the finding would keep being
  observed; reopening them on the next report would silently overturn a human decision on a
  schedule. **Every evaluation is ledgered, including the ones that decline** — that is what makes
  re-processing idempotent *and* leaves proof the rule was applied rather than silently skipped. The
  reopen lifecycle event carries `actorUserId: null` deliberately: it is a consequence of new
  evidence, not the uploading analyst's decision.
- **Recurrence reopening never touches ingestion.** `processRecurrenceReopensSafely` runs last in
  `ingestAccessibleRdpReport`, after every RawReport / RawReportRow / Finding / FindingOccurrence
  write has committed and outside every transaction the pipeline opened — the same isolation
  contract as ownership resolution, enrichment scheduling and risk scoring before it. It never
  throws: every failure is classified into a closed outcome vocabulary and reported in an aggregate.
  A total reopen failure leaves a fully valid ingested report with fully valid recurrence evidence
  and simply no reopen.
- **There is no hard-delete production route.** `DELETE /api/cases/:id` is a compatibility tombstone:
  it always answers `409` with `code: CASE_DELETION_NOT_SUPPORTED`, deletes nothing, and deliberately
  does **not** look the case up first — answering 404 for an unknown id and 409 for a known one would
  turn the endpoint into an existence oracle for any holder of `manage:cases`.

### APIs and RBAC

Three additive, non-hierarchical capabilities in `lib/roles.js`:

| Capability | ADMIN | ANALYST | REVIEWER | VIEWER |
| --- | --- | --- | --- | --- |
| `read:cases` | yes | yes | yes | yes |
| `manage:cases` (existing) | yes | yes | no | no |
| `triage:findings` (existing) | yes | yes | no | no |
| `review:case-closure` | yes | no | yes | no |
| `override:closure-self-approval` | yes | no | no | no |

`/api/cases` moved from a single router-level `requireCapability(MANAGE_CASES)` to router-wide
`authenticate` plus a per-route capability. That split is what lets a REVIEWER read the case whose
closure they are deciding, and gives VIEWER read-only oversight, while neither gains any case write.

    read:cases           GET  /api/cases   /:id   /:id/workflow
    manage:cases         POST /api/cases                      (create)
                         PUT  /api/cases/:id                  (legacy fields only)
                         POST /api/cases/:id/findings          (link evidence)
                         POST /api/cases/:id/findings/:fid/unlink
                         POST /api/cases/:id/state             (OPEN <-> WAITING_FOR_ORG)
                         POST /api/cases/:id/responses
                         POST /api/cases/:id/closure-requests
                         POST /api/cases/:id/reopen            (explicit manual reopen)
    review:case-closure  POST /api/cases/:id/closure-requests/:rid/approve
                         POST /api/cases/:id/closure-requests/:rid/reject
    read:findings        GET  /api/findings/:id/triage
    triage:findings      PUT  /api/findings/:id/triage

No role name appears in any Phase 3 controller. Authorization is entirely the routes'
`requireCapability` middleware, so **a denied request is answered before any service is reached and
creates no rows** — asserted directly by counting durable rows across the whole denied matrix.

`caseWorkflowSerializers.js` is the single allow-list choke point every Phase 3 row crosses. It
constructs fresh objects from named fields rather than deleting keys from a database row, so a
future migration that adds a column cannot silently start leaking it. Never emitted: current-row
keys (`currentForFindingId`, `currentLinkKey`, `activeCaseId`), the internal recurrence key
(`findingOccurrenceId`), organization contacts (`contactPerson`, `email`, `phone`, `industry`,
`location`), Phase 1/2 fingerprints, audit rows, or raw database errors.

### Auditing

Bounded events on every write path, emitted by the services themselves (controllers pass
`auditContext` through and never audit twice): `finding.triage.recorded`, `case.created`,
`case.finding.linked` / `.unlinked`, `case.state.changed`, `case.response.recorded`,
`case.closure.requested` / `.approved` / `.rejected`, `case.reopened`,
`case.recurrence.reopen.completed` / `.failed`.

Every payload is an explicit allow-list. Analyst free text (triage reason, closure justification,
review note, response summary) is reduced to a boolean or a length, never copied. `Error.message`,
stacks, raw requests and complete response text never reach `AuditLog` — failure reasons are closed
vocabulary strings, and a `CaseWorkflowStateError`'s own `code` is the only variable part. The
aggregate recurrence event carries **counts only**, no indicator, no Finding id, no occurrence id
and no case reference. Audit failure never rolls back domain state.

### Frontend

Backend-connected workflow screens on the existing design system:

- `pages/Cases.jsx` (rewritten) — reference, organization, priority, **authoritative
  `lifecycleState`** (not the legacy free-text `status`), linked-evidence count, analyst, and a
  recurrence-reopened badge. Status tiles are counted off `lifecycleState` so they cannot disagree
  with the workflow. No delete control for any role.
- `pages/CaseDetail.jsx` (new) — linked findings (expandable to the triage panel), lifecycle
  timeline, organization-response timeline, the closure workflow, the recurrence ledger including
  the evaluations that declined to reopen, and a recurrence-reopened indicator.
- `components/FindingTriagePanel.jsx` (new) — current triage decision, append-only history, current
  ownership, the cases the Finding is evidence in, and the permitted triage actions.
- `constants/caseWorkflow.js` (new) — the presentation vocabulary plus `describeWorkflowError`,
  which renders the backend's closed rejection codes as advice an analyst can act on
  ("resolve its ownership first") rather than an error code.

Every control is rendered from the intersection of two independent facts: `permittedActions`, which
the backend derives from the case's **durable state alone** and which says nothing about the caller,
and the caller's own capability list. **This is UX only** — the backend re-checks the capability
(route middleware) and the state (service) on every request regardless.

The page gate moved from `MANAGE_CASES` to `READ_CASES` so REVIEWER and VIEWER reach the screen.
Frontend `testTimeout` was raised to 20 s in `vite.config.js`: a single MUI Select interaction
through `userEvent` opens a portal, runs a transition and re-renders a full page, and several test
files run in parallel jsdom environments — the tests are fast, the environment is not.

### Verification (all re-run at commit time)

**222 new/changed backend tests.** Every one of them reads the database's durable rows rather than a
service return value, because the properties under test are about what was *written*: a test that
only inspected the return could not tell an UPDATE of a prior row from an INSERT of a new one.

| Suite | Tests | What it proves |
| --- | ---: | --- |
| `tests/unit/caseWorkflowRules.test.js` | 34 | the closed vocabularies, the complete transition table, `analystAvailableStates`, link eligibility including the ISP-before-mismatch ordering, bounded text, the case-reference format |
| `tests/unit/caseWorkflowServices.test.js` | 52 | creation, guarded transitions, the source-state guard, linking/unlinking, the organization-matching rule, responses, closure request/approve/reject, self-approval, manual reopen, audit isolation, transactional atomicity |
| `tests/unit/findingTriageService.test.js` | 20 | the append-only supersede chain, one current row, DISMISSED requiring a reason, meaningful-only workflow escalation, audit failure isolation |
| `tests/unit/caseRecurrenceReopenService.test.js` | 20 | only-REMEDIATED auto-reopen, ledgering of declined evaluations, idempotency, fan-out across linked cases, never throwing into ingestion |
| `tests/unit/caseWorkflowSerializerSafety.test.js` | 26 | the exclusion proof the serializer's own header promises, against contaminated real row shapes |
| `tests/unit/workflowTransaction.test.js` | 11 | retry classification, whole-transaction re-run, bounded budget, backoff, and the two isolation levels |
| `tests/unit/reportIngestionService.test.js` | +8 | the ingestion hook, its isolation contract and its idempotent replay |
| `tests/integration/caseWorkflowRouteAuthorization.test.js` | 34 | the whole HTTP surface end to end, and that a denied request creates no rows |
| `tests/integration/caseWorkflowConcurrency.test.js` | 17 | the same invariants against real PostgreSQL under genuine concurrency |

The real-PostgreSQL suite uses **separate pre-connected `PrismaClient` instances** throughout.
`Promise.all` over one shared client serializes enough to hide the race, so such a test passes even
against an implementation with no invariant at all — measured directly during P2-T2b and unchanged
here.

Three existing suites were amended for the Phase 3 grants rather than worked around:
`tests/integration/auth.test.js` and `tests/unit/roles.test.js` (VIEWER's read-only set now includes
`read:cases`), and `tests/integration/resourceRouteAuthorization.test.js` (the case group now
expresses the read/write split and the delete tombstone instead of a single capability).

**Combined gate results:**

- Full backend suite with `TEST_DATABASE_URL` + `EVAL_DATABASE_URL` and `--no-file-parallelism`:
  **2404 passed / 2404, 101 files** (was 2172 before this phase).
- Phase 3 real-PostgreSQL concurrency suite: **17/17, stable across repeated runs.**
- Frontend: **61/61 across 6 files**, clean production build, `oxlint` clean of any new warning.
- `npm run eval:phase1` PASS · `eval:risk` 19/19 · `eval:phase2` 22 scenarios / 112 assertions ·
  `eval:phase2:mutation` 6/6 · `eval:vulnerability` 41 scenarios / 992 assertions ·
  `eval:vulnerability:mutation` 12/12 · **`eval:phase3` 12 scenarios / 151 assertions, rerunnable.**
- `npx prisma validate` clean; `migrate deploy` reports **15 migrations, none pending** on both
  `threatnexus_test` and `threatnexus_eval`; migration count is exactly **15**.
- `git diff --check` clean; no secret, credential or generated artifact in the diff; no real network
  call anywhere in the suite or in any evaluator.

**Both environment rules from Phase 2 still apply and were followed:** never export `JWT_SECRET`
globally when running the backend suite (HTTP-token suites self-default their own signing secret and
an exported value makes every request 401), and real-PostgreSQL suites must run with
`--no-file-parallelism` (they share one database and parallel files steal each other's rows).

### Accepted limitations

- **No standalone Findings list screen.** No `GET /api/findings` list endpoint exists, and the
  locked Phase 3 API surface does not include one. Triage is therefore surfaced where findings
  actually appear — expandable per linked finding on the case detail — rather than inventing an
  endpoint outside the phase's scope.
- **A legacy `Case` row with a null `organizationId` cannot be bound to an organization through any
  endpoint.** Doing it safely needs a controlled migration that decides what the pre-existing
  free-text `organization` string actually referred to — a separate piece of work, deliberately not
  invented here. Such rows stay readable and every workflow operation refuses them with
  `CASE_NOT_ORGANIZATION_BOUND`.

### Phase 3 completeness patch (2026-08-01)

Two accepted limitations recorded above at Phase 3 close were resolved before the PR, without
touching lifecycle, closure, recurrence, triage or Risk semantics, and without a schema change.
**Migration count stays 15.**

**1. Reliable organization selection for case creation.** `GET /api/organizations/options`
(`organizationController.getOrganizationOptions`) is new, registered in `organizationRoutes.js`
*before* the router's `manage:system` gate so it runs on its own, narrower capability —
`manage:cases`, held by ADMIN and ANALYST — rather than the administrator-only registry grant.
REVIEWER and VIEWER hold neither and are denied by `requireCapability` before the organization table
is ever read. It returns only `organizationId`/`name`/`sector` (never contact detail, counters or
audit data), ordered deterministically (`name asc, id asc`), with a bounded case-insensitive
`search` (≤100 chars) and a `limit` capped at 50 (default 25) plus a `page` offset — invalid `limit`,
`page` or `search` are rejected with a 400 naming the field, never silently clamped or ignored, and
an empty or unmatched result is a safe empty list rather than a fabricated option. `Cases.jsx` now
sources its organization picker from this endpoint instead of the previous case-derived fallback
(which is removed), so an ANALYST can create the **first** organization-bound case even when zero
cases currently exist to derive an organization from — the whole reason the prior fallback was
insufficient.

**2. Organization-response `occurredAt` input.** The backend already accepted and strictly validated
a caller-supplied `occurredAt` (rejecting an unparseable value rather than defaulting it); only the
response form had no date control. `CaseDetail.jsx`'s response form now includes a
`datetime-local` field defaulting to the current local date/time, parsed client-side with the same
strictness as the server (invalid input disables the Record button and shows inline feedback rather
than round-tripping to find out), and submits the selected instant as an ISO timestamp. The client
never supplies actor identity or any other internal field — only `responseType`, `summary`,
`reference` and `occurredAt` cross the wire, matching the backend's existing allow-list.
`recordedAt` (when we wrote it down) stays server-captured and is never conflated with it.

Verification: 15 new/changed backend tests
(`tests/integration/organizationOptionsRouteAuthorization.test.js`) covering ADMIN/ANALYST read
access, REVIEWER/VIEWER denial before the table is read, the exact three-field serializer shape, PII
non-leakage, deterministic ordering, bounded search/limit/page validation and pagination; 6 new
frontend tests across `Cases.test.jsx` and `CaseDetail.test.jsx` covering first-case creation with
zero prior cases, the safe-API sourcing (and non-use of the ADMIN-only registry), the occurredAt
default/submission/invalid-value paths. Full frontend suite **65/65** across 6 files, clean
production build, `oxlint` clean of any new warning. Focused backend suites (case/organization RBAC,
case workflow services/rules/serializer safety, roles) all green; full no-DB backend suite
**2268 passed / 151 skipped**, consistent with the pre-patch skip set. `npx prisma validate` clean;
migration count confirmed at **15**, `backend/prisma/` otherwise untouched. `git diff --check`
clean; no secret, `.env` or Graphify artifact in the diff.

## Phase 2 COMPLETE AND COMBINED-GATE VERIFIED (2026-07-31)

The closing packet for Phase 2. It closed the last two deferred ownership items (C-1/C-2
re-resolution and the `reResolveFindingsForMapping` full-table scan), added the safe sector surface
and the consistency checker, and — most importantly — added the first gate that exercises Phase 2's
layers **composed** rather than in isolation.

**No schema change. Migration count remains 14. `backend/prisma/` is byte-identical to `fb253b4`.**

### Ingestion lifecycle (unchanged, re-proven in composition)

CSV → raw evidence (`RawReport`/`RawReportRow`, bytes preserved) → structural parse → row validation
→ dedup on the locked key `(indicator_value, port, protocol, report_type)` → persistence (bump
`occurrenceCount`, no new row) or recurrence (reopen a closed Finding, bump `recurrenceCount`) →
ownership resolution → IOC enrichment scheduling → deterministic Risk v1. Absence from a later
report never auto-closes a Finding; a newer occurrence against a closed Finding reopens it.

### Ownership precedence and ambiguity (unchanged, now mutation-proven)

1. explicit override → 2. exact IP → 3. longest matching CIDR → 4. ASN → 5. unresolved.
Equally specific matches for different organizations produce **AMBIGUOUS**, never a silent winner:
`organizationId` and `confidence` are both null and `candidateCount` records how many organizations
tied. ASN attribution is **LOW confidence and ISP-flagged**. **Ownership contributes zero Risk v1
basis points** — it is only the applicability gate for `sectorCriticality`.

### Mapping-change re-resolution (new)

`assetMappingService` previously committed a mapping mutation and stopped, so ownership went stale
until something else happened to re-resolve a Finding. Mapping mutations now trigger **one bounded
re-resolution batch, strictly after the mutation commits** — never inside it. No Finding query,
resolution loop, risk scoring, audit write or provider call runs inside a mapping transaction.

- Triggers: create, disable, and precedence-relevant updates only — `organizationId`, `validFrom`,
  `validUntil`. **Not** `confidence`/`source`/`provenanceNote`/`mappingConfirmed`, which the resolver
  never reads, so editing a provenance note cannot start a sweep.
- `mappingType`/`exactIp`/`cidr`/`asn` are not PATCHable by existing design (retargeting is
  disable+create), and `enabled` has no re-enable API path — so "IP/CIDR/ASN mapping change" reduces
  to create+disable. Recorded as an accepted limitation, not an omission.
- One Finding's failure increments `failedCount` and the loop continues; a re-resolution failure
  never rolls back the committed mapping; a risk failure never rolls back ownership history; an
  audit failure rolls back nothing.
- Identical ownership fingerprint → UNCHANGED → no new row, no audit, no risk churn.
- Summary reports `mappingId`, `mappingType`, `candidateCount`, `processedCount`, `changedCount`,
  `unchangedCount`, `ambiguousCount`, `unresolvedCount`, `overriddenPreservedCount`, `failedCount`,
  `riskChangedCount`, `riskUnchangedCount`, `riskFailedCount`, `truncated`, `acquisitionLimited`.
- **No daemon, no cron, no self-rescheduling.** Truncation is surfaced with an HMAC-signed
  continuation token and finished by an explicit ADMIN call, so a response can never imply full
  re-resolution when one batch ran.

### Bounded database candidate selection (new)

`Finding.indicatorValue` is a String with no integer or ASN column, so numeric `BETWEEN` is
unavailable and a lexical range would be **wrong** (`"10.0.0.9" > "10.0.0.10"` as text would silently
skip rows). A CIDR range is block-aligned, so it decomposes into octet-aligned `startsWith` prefixes:

| mapping prefix | filter granularity | predicate count | exact? |
|---|---|---|---|
| `p >= 24` | one `a.b.c.` | 1 | overshoots ≤ one /24 |
| `16 <= p < 24` | `a.b.c.` enumeration | `2^(24-p)` ≤ 256 | exact |
| `8 <= p < 16` | `a.b.` enumeration | `2^(16-p)` ≤ 256 | exact |
| `p < 8` | `a.` enumeration | `2^(8-p)` ≤ 256 | exact |

Never more than 256 OR'd predicates for any prefix length including `/0`. Every prefix ends in a
**dot**, so `"10.1."` cannot match `"10.10.5.1"` — the textual-prefix trap. The overshoot for `p > 24`
is narrowed by real BigInt containment, so **the ownership decision is never made by text matching**;
`startsWith` is only a bounded pre-filter. These predicates ride the existing `finding_identity`
index (which leads with `indicatorValue`), so **no index, no raw SQL and no migration** were needed.

Candidates also come from ownership rows that **name** a mapping (`matchedMappingId`), which is what
lets a disabled mapping release what it previously attributed. That narrows the ASN gap: an ASN
mapping can now **release** its prior attributions, though it still cannot **acquire** new ones
because Finding stores no ASN — reported explicitly as `acquisitionLimited: true`.

Pagination is a keyset cursor on Finding id, never OFFSET, so concurrent ownership writes cannot
shift the window; only `id`/`indicatorValue` are selected; no include tree, no N+1.

### Explicit override preservation

`resolveOneFinding` re-feeds an existing OVERRIDDEN row back to the resolver as `currentOverride`, so
the decision returns OVERRIDDEN and identical, which the effective-fields comparison classifies as
UNCHANGED. Automatic re-resolution can never discard an analyst's attribution — proven in the unit
suite, the combined gate (scenario 11), under real concurrency (property 4), and by mutation M04.

### Safe sector exposure (new)

`GET /api/findings/:id/ownership` now returns a `sectorContext` block: `organizationId`,
`organizationName`, `sector`, `ownershipStatus`, `ownershipConfidence`, `attributionType`,
`isIspAttribution`, `matchedMapping` (type/source/confirmed only), `resolvedAt`, `effectiveAt`, and
`sectorCriticalityApplicability`.

Applicability is **not recomputed** — it delegates to `riskInputSnapshot.loadOwnershipContext`, the
same gate the risk engine scores with. Seven distinct states are reported rather than one false:
`APPLICABLE`, `NOT_APPLICABLE_AMBIGUOUS`, `_UNRESOLVED`, `_NO_ORGANIZATION`, `_ISP_ATTRIBUTION`,
`_LOW_CONFIDENCE`, `_UNKNOWN_SECTOR`. ISP is reported ahead of confidence so the honest reason is
"this is the carrier, not the victim". **No basis points are computed in a serializer** — what a
sector is worth stays in the Risk v1 contribution/explanation surface. Never exposed: organization
contacts, `securityScore`, `activeThreats`, `ipStart`/`ipEnd`, `provenanceNote`,
`currentForFindingId`.

### Ownership consistency detection (new)

`POST /api/ownership/consistency-check` (ADMIN) reports, in bounded batches, eleven defect classes:
duplicate current row, RESOLVED without organization, AMBIGUOUS/UNRESOLVED carrying an organization,
OVERRIDDEN leaning on a mapping id, illegal status/confidence pairings, ISP attribution with
incompatible confidence, a current mapping that is missing or disabled, divergence from the
authoritative resolver, and sector-applicability mismatch.

**Detection only — it never writes.** Ownership history is append-only evidence; a checker that
silently repaired what it found would destroy the record showing something went wrong. Exact Finding
ids go to the ADMIN caller bounded by batch size; the audit event carries **counts only**, so an
`AuditLog` row cannot become a standing export of which hosts are affected. No indicator address
appears in any count, log or audit payload. No repair operation was needed — no stale rows were
demonstrated.

### Enrichment roles (unchanged)

**AbuseIPDB** is IOC reputation for the indicator, behind the provider abstraction, with
`MockProvider` in every automated test. **NVD/KEV/EPSS** are vulnerability intelligence about an
explicitly analyst-asserted CVE. They are separate paths and neither substitutes for the other; the
combined gate proves both stay independent (scenario 13). **No CVE is ever inferred** from port 3389
(scenario 14). Only `SUCCESS`/`NOT_FOUND` enrichment rows are reputation-bearing — `PENDING`,
`RATE_LIMITED`, `TIMEOUT` and `DEAD_LETTER` are never scored as evidence.

### APIs / RBAC / audit boundaries

- New: `POST /api/ownership/mappings/:id/re-resolve` and `POST /api/ownership/consistency-check`,
  both behind the existing **ADMIN-only** `manage:ownership-mappings`. **No new capability was
  added, so the frontend needs no change.**
- Both reject caller-supplied `actorUserId`, `asOf`, `afterId`/`cursor`, worker id, `riskScore`,
  `confidence`, `status`, `matchedMappingId` and any unissued continuation token — **rejected, not
  ignored**, since silently dropping a field a caller believed was applied is its own failure mode.
- New audit actions: `ownership.mapping.reresolution.requested|completed|partial|failed`,
  `ownership.consistency.check.requested|completed|failed`. Payloads carry the mapping id, mapping
  type, aggregate counts and closed flags — never a candidate list, a victim indicator, a cursor, a
  stack, an `Error.message` or a Prisma code. Per-Finding ownership audit is suppressed inside a
  batch in favour of one aggregate event; risk emits its own single aggregate event and is not
  duplicated here.

### Verification

| Gate | Result |
|---|---|
| `npx prisma validate` | valid; **14** migrations, none pending on `threatnexus_test`/`threatnexus_eval` |
| Backend suite, no DB vars | **2040 passed / 134 skipped** |
| Backend suite, `TEST_DATABASE_URL`, `--no-file-parallelism` | **2172 passed / 2 skipped** (93 files) |
| Concurrency suites × 3 consecutive runs | **81/81** each run (7 suites) |
| `npm run eval:phase1` | **9/9** |
| `npm run eval:risk` | **19/19** |
| `npm run eval:vulnerability` | **41 scenarios / 992 assertions** |
| `npm run eval:vulnerability:mutation` | **12/12** |
| `npm run eval:phase2` (new) | **22 scenarios / 112 assertions**, rerunnable |
| `npm run eval:phase2:mutation` (new) | **6/6** ownership rules detected by a named scenario |
| Frontend tests / production build | **25/25** / builds clean |

**Two reproducible environment rules** (both cost time this session):

1. **Never export `JWT_SECRET` globally** when running the backend suite. HTTP-token suites hardcode
   their own signing secret and only self-default it (`process.env.JWT_SECRET || LOCAL`), so an
   exported value makes the server verify with a different secret than the test signs with — every
   request returns 401 and ~9 tests fail in a way that looks like an authorization regression.
2. **Real-PG suites need `--no-file-parallelism`.** They share one `threatnexus_test` database, and
   parallel files steal each other's queued enrichment jobs; failures move between runs (10 → 9 → 4 →
   1), which reads like flakiness but is cross-suite interference. Sequentially: fully green.

### Mutation checks

`eval:phase2:mutation` re-runs the real gate in a child process with exactly one ownership rule
broken and requires the gate to fail **in the scenario that guards that rule** — not merely to fail.
All six detected: exact-IP precedence (04), longest-CIDR precedence (05), tied-specificity ambiguity
(06), override preservation (11), the sector applicability gate (12), unaffected-Finding exclusion
(08).

Worth recording: exclusion is guarded by scenario **08**, not 09. 08 asserts *which* Findings were
selected; 09 asserts an unrelated row was not *rewritten* — and 09 correctly still passes under that
mutation, because re-resolving an unrelated Finding with a still-correct resolver reaches the same
answer and writes nothing. Selecting too much work and corrupting an unrelated row are two different
failures with two different guards.

### Security review

Verified clean: no tracked `.env`/key material; no hardcoded API key in `src/`; no provider key in
logs, audits or errors; no raw provider response persisted; no inferred CVE; ownership never decided
by text matching; no unbounded database read remaining; no network call inside an ingestion or
mapping transaction; no `PENDING`/`DEAD_LETTER` evidence scored; backend capabilities remain the sole
authorization boundary; historical evidence never overwritten; no actor-controlled risk/ownership
field; no Graphify output tracked or untracked; no direct `main` change; no schema or migration
change.

**One defect found and fixed** (`df565cb`): the override apply/clear failure paths built their
`AuditLog.reason` by interpolating `error.message`. Nothing leaked — the three classes those catch
blocks handle all author their own bounded messages — but an audit reason assembled by interpolation
from an `Error` is one added error class away from carrying raw database or provider text into the
audit trail. Now records the closed error **name** plus the bounded field list.

### Accepted limitations

- **ASN acquisition.** An ASN mapping cannot retroactively claim Findings whose ASN was never stored;
  `Finding` has no `asn` column and adding one is a schema change. Release works, acquisition does
  not, and the asymmetry is reported as `acquisitionLimited` rather than hidden.
- **No `matchedMappingId` index.** Prior-attribution selection filters on an unindexed column, kept
  bounded by the batch limit and the `currentForFindingId` predicate. Adding the index is a migration
  and the count is locked at 14 for this packet.
- **Mapping retargeting and re-enable have no API path** (disable+create by existing design), so
  those re-resolution triggers are unreachable rather than unimplemented.
- **No live external provider smoke test yet.** Every automated test uses `MockProvider` and the
  gates forbid network access outright; a real AbuseIPDB/NVD call has still never been exercised in
  CI. Deliberate — tests must never consume live quota.
- **`EVAL_DATABASE_URL` safety is still raw string equality** (carried over from the Phase 1 audit):
  `postgres://` vs `postgresql://` spellings would not be caught.

## Frontend RBAC integration (2026-07-31)

Ali Haider Chattha's frontend RBAC commit (`4032868`, based on `main`'s actual tip `a6b2852`, not on
this branch) was merged via a normal merge commit (`git merge origin/main`, no rebase/cherry-pick),
preserving his original authorship in history. His commit introduced `ProtectedRoute` role checks,
`Sidebar` role-based nav, `RoleGuard.jsx`, `constants/roles.js` and `utils/permissions.js` — all
authored independently of `backend/src/lib/roles.js`'s capability table, and with defects: `Sidebar`
allowed `REVIEWER` to see Cases despite the backend never granting `REVIEWER` `manage:cases`,
`ProtectedRoute` failed **open** (rendered content) whenever `allowedRoles` was omitted or empty
instead of denying, `RoleGuard.jsx` was unused dead code, and there were no frontend RBAC tests.

**Backend capability enforcement remains the sole authorization boundary — unchanged.** No
`requireCapability`/`requireRole` middleware was touched. `POST /api/auth/login` and
`GET /api/profile` (the existing session-validation endpoint, previously unused by the frontend) now
additionally return a `capabilities` array — computed **only** from the verified role via
`ROLE_CAPABILITIES` in `backend/src/lib/roles.js`, never from anything a caller submits. Focused
backend tests (`backend/tests/integration/auth.test.js`) prove: the array matches
`ROLE_CAPABILITIES` exactly for all four roles, a client cannot override it by submitting its own
`capabilities`/`role` fields, an unrecognized/forged role yields `[]` rather than any grant, no
password/hash leaks, and the existing `loggedInUser` response shape is unchanged.

The frontend now mirrors that table (`frontend/src/constants/capabilities.js`,
`frontend/src/utils/permissions.js`'s `PAGE_CAPABILITIES` map) instead of an independently authored
role/page matrix, and is documented throughout as **UX only** — it decides what renders, never what
is permitted. `AuthContext` validates a stored token against `GET /api/profile` on every app
initialization instead of trusting `localStorage` blindly; a rejected/expired/forged token (or a
tampered `localStorage` role/capabilities entry) clears all stored session state rather than being
treated as valid. `logout()` clears token, user and capabilities together. `ProtectedRoute` now
**fails closed**: a route with no `requiredCapability` and no explicit `requireAuthOnly` opt-in is
denied by default; `requireAuthOnly` is reserved for the few routes that need only authentication
(currently just `/profile`, which has no backend capability route of its own). `Sidebar` and
`ProtectedRoute` read the same `PAGE_CAPABILITIES` map, so nav visibility and route access can never
disagree. `RoleGuard.jsx` was unused and is deleted rather than kept as dead duplicate authorization
code.

Resulting behavior: **ADMIN** sees every section, including the admin-only Organizations/Settings
pages (gated on `manage:system`, mirroring `organizationRoutes.js`). **ANALYST** gets
dashboard/threats/analytics (read capabilities), upload (`ingest:reports`) and Cases
(`manage:cases`), but no admin-only pages. **REVIEWER** gets read-only pages plus Notifications
(`review:notifications`) — and, fixing the known defect, **no longer sees Cases**, since the backend
never grants `REVIEWER` `manage:cases` (confirmed by `backend/src/routes/caseRoutes.js` gating the
entire router, including reads, behind that capability). **VIEWER** sees only
dashboard/threats/analytics and no mutation-capable page. Note: aligning Notifications to
`review:notifications` also removes it from ANALYST/VIEWER's nav — the previous frontend table
showed it to all four roles, but `backend/src/routes/notificationRoutes.js` gates the entire router
(including reads) behind `review:notifications`, so ANALYST/VIEWER would have hit a 403 from the
backend regardless; this alignment fixes a second, previously unrecorded frontend/backend mismatch,
not just the known Cases one. There is currently **no frontend UI for vulnerability batch
execution** (`execute:enrichment-batch` / `execute:vulnerability-enrichment-batch`) at all — nothing
to gate yet — but `permissions.test.js` asserts both capabilities resolve to `false` for every
non-ADMIN role, so a future batch-execution control wired through `PAGE_CAPABILITIES`/`hasCapability`
will be correctly ADMIN-only from day one.

Frontend RBAC test tooling did not exist; the minimal standard set (Vitest + React Testing Library +
jsdom) was added (`frontend/vite.config.js` `test` block, `frontend/src/test/setup.js`,
`npm test` in `frontend/package.json`). 25 tests across four files
(`utils/permissions.test.js`, `components/Sidebar.test.jsx`, `components/ProtectedRoute.test.jsx`,
`context/AuthContext.test.jsx`) cover the required navigation-visibility, route-protection,
fail-closed, shared-decision-source, tampered-localStorage, logout, and capability-drift scenarios —
all 25 pass. `npm run build` and `npm run lint` (oxlint) both pass with only pre-existing warnings
unrelated to this change.

The untracked `graphify-out/` and `backend/tests/graphify-out/` directories (Graphify tool output,
not part of this integration) had their `cache/` subdirectories removed; the non-cache report files
(`graph.html`, `GRAPH_REPORT.md`, `wiki/`, etc.) remain untracked and are not committed, per explicit
direction — future Graphify runs belong in the separate `ThreatNeXus-AliReview` checkout, not this
working tree.

**Exact next task: Phase 2 combined gate and ownership hardening.**

## Phase 2 §2B COMPLETE AND RELEASE-GATED — Packet C (2026-07-31)

Packet C adds no production feature. It adds the **evidence that §2B is correct**: a manually
authored executable ground truth, an evaluator that drives real services against real PostgreSQL, a
mutation gate that proves the evaluator would fail if the contract drifted, and an end-to-end release
proof over the real HTTP surface.

**Zero schema change.** `schema.prisma` is byte-identical to `54f8306`, the migration directory is
unchanged, and the count remains exactly **14**. Risk v1 remains `risk-additive-bucketed-v1` /
`v1.0.0`; no weight, cap, bucket, band or fingerprint was touched.

### The §2B contract, as gated

- **Explicit analyst-verified CVE association only.** `VulnerabilityEvidenceSource` has exactly one
  value, `ANALYST_VERIFIED`. There is no NVD-derived path, no CPE/product/vendor matching, and no
  inference from report type, port, protocol, banner, hostname or OS guess — proven by ground-truth
  scenario `A06` and mutation `M12`.
- **Append-only attach / remove / re-attach history.** Every transition appends a row and supersedes
  the previous current one in the same SERIALIZABLE transaction; `currentAssociationKey` makes "at
  most one current row per (Finding, CVE)" a database unique constraint. A duplicate attach writes
  nothing (`A03`). A removal retracts by appending, never by deleting (`A04`, `A05`).
- **NVD is normalized display metadata with no numeric role.** SUCCESS, `NOT_FOUND` and failure all
  leave every Risk v1 number unchanged, and NVD's opinion never retracts an analyst's assertion
  (`B07`–`B09`). A CVSS 9.8 CRITICAL contributes exactly zero (`B07`); new NVD metadata alone
  produces an identical input fingerprint and therefore **no new RiskScore row at all** (`F39`).
- **CISA KEV: listed versus not-listed versus unavailable are three different things.**
  `KEV_LISTED` → 800. `KEV_NOT_LISTED` → APPLIED at 0, permitted **only** when every active CVE was
  successfully checked and found absent (`C10`). One unchecked CVE makes the finding NOT_AVAILABLE,
  not "not listed" (`C12`, mutation `M08`). Any active CVE listed wins (`C13`, `M07`). A failed
  catalogue fetch stores `isKnownExploited: null` and can never read as `false` (`C15`).
- **FIRST EPSS: exact decimal-to-basis-points, bucketed.** Probability is normalized to an integer
  0–10000 at the input boundary; no float reaches scoring. A real score of **0 is APPLIED evidence**
  (`EPSS_LOW`), structurally distinct from unavailable (`D16` vs `D17`, mutation `M10`) — both
  contribute 0, only the applicability and code tell an analyst which they are reading.
- **Multi-CVE aggregation.** cvePresence: flat 300 if any active CVE exists, never scaled by count.
  KEV: any-listed → 800; all-checked-false → 0; otherwise unavailable. EPSS: the **maximum** fresh
  usable score across active CVEs (`D27`, mutation `M06`), tie-broken by canonically smallest `cveId`
  (`D28`), and requiring only that *some* CVE has a usable score (`D29`).
- **Durable queue semantics.** `PENDING` is work, not an answer (`E30`). `DEAD_LETTER` means "we gave
  up", never "this CVE is clean" — it writes no provider result and clears `activeJobKey`, so a later
  schedule is a brand-new job with a full budget, never a resurrection (`E31`). A COMPLETED job
  always carries exactly three provider results, written atomically (`E32`). Forced refresh bypasses
  the cache but never active-job uniqueness, and preserves all earlier jobs and results (`E33`).
  Freshness is the half-open window `[queriedAt, expiresAt)`: stale evidence does not score (`C14`,
  `D18`), a newer fresh result wins over an older stale one (`E34`), and a result queried in the
  future is not usable at an earlier instant (`E35`).
- **Provider calls happen only during explicit administrator batch execution.** Attaching, removing
  and scheduling perform no network I/O at all. `NVD_API_KEY` is optional (its absence only means the
  public rate limit) and is sent **only** in the `apiKey` request header, never in a URL, log, audit,
  error or `describe()`. KEV and EPSS need no key.
- **Risk history is append-only and explanations are stable.** Provider completion appends a new
  snapshot and supersedes the old one (`F36`); a later refresh leaves every older score row and every
  one of its contribution rows byte-identical (`F37`); an explanation rendered from a stored score
  stays field-for-field identical across later enrichment, CVE removal and re-attachment (`F38`).

### Landed in Packet C

- **`data/synthetic/vulnerability/ground_truth.yaml` + `README.md`** — 41 scenarios in seven groups,
  manually authored and versioned. It imports nothing, calls no production risk helper, and copies no
  observed database value into an expected field. The constants under `contract:` are transcribed by
  hand and are an *independent* statement of the approved contract, not a view onto it.
- **`eval/run_phase2_vulnerability_gate.js` + `eval/lib/vulnerabilityGroundTruthLoader.js`**
  (`npm run eval:vulnerability`) — drives the real association, scheduling, batch-runner, TTL,
  scoring and explanation services against real PostgreSQL and compares **persisted** state to the
  ground truth. **41 scenarios, 992 assertions, PASS.** Database safety: requires
  `EVAL_DATABASE_URL`, refuses to run when it equals `DATABASE_URL` under normalized comparison,
  prints only the database *name*, never resets/truncates/drops, and cleans up an exact evaluator-owned
  id set on success and on failure. Providers are the committed offline mock, and `global.fetch` is
  replaced by a throwing stub for the whole run.
- **`eval/run_phase2_vulnerability_mutation_gate.js`** (`npm run eval:vulnerability:mutation`) —
  proves the baseline passes and that **12/12** load-bearing contract mutations each cause a *named*
  assertion to fail. Mutations are applied to temporary copies under the OS temp directory; the
  working tree, schema and migrations are never touched.
- **`backend/tests/integration/vulnerabilityReleaseWorkflow.test.js`** — the end-to-end release proof
  over the real Express app and real PostgreSQL: baseline **2300 LOW** → ANALYST attaches a CVE over
  HTTP → **2600 LOW** → one bounded batch with injected NVD SUCCESS / KEV listed / EPSS 9000 →
  **3800 MEDIUM** → ANALYST removes the CVE over HTTP → back to **2300 LOW**, with all association,
  provider and risk history intact and the enriched explanation unchanged. 11 tests, stable across 3
  consecutive runs.

> **Note on the expected end-to-end total.** The Packet C task brief described the enriched score as
> "3800 LOW". Under the **locked** Risk v1 bands, LOW ends at 3499 and MEDIUM begins at 3500, so
> 2300 + 300 + 800 + 400 = 3800 is **MEDIUM**. The band follows from the score and is never assigned
> directly. The arithmetic in the brief is honoured exactly; only the band label differed, and the
> locked configuration was not changed to match it.

### Focused defects found and fixed

1. **Test-integrity defect (fixed).** `riskScoringConcurrency.test.js` case 3 — the required
   "RiskScore concurrent current-row uniqueness" proof — ran `Promise.all` over **one shared
   `PrismaClient`**. That is the exact trap this repository already documented in P2-T2b: a single
   client's pool serializes the calls enough to hide the race, so the test would pass even against an
   implementation with no invariant at all. Upgraded to **8 separate, pre-connected clients**. The
   invariant genuinely holds — it now passes for the right reason, stable across 3 consecutive runs.
   Test-only change; no production code touched.
2. **Evaluator harness defect (found and fixed during Packet C).** The first revision of the gate's
   fixture translation silently **dropped** a non-SUCCESS `CISA_KEV` provider spec, because KEV
   failure is catalogue-level and has no per-CVE form. Three scenarios consequently asserted
   "KEV checked and absent" while claiming to assert "KEV unavailable". Fixed by expressing KEV
   unavailability as a failed catalogue fetch, and the ground-truth loader now **rejects** the
   inexpressible form outright rather than reinterpreting it. A specification the harness cannot
   honour must fail loudly, never be quietly reinterpreted.

No production defect was found in §2B. Nothing was refactored opportunistically.

### Security and contract review (full §2B diff, `cc5aac8..HEAD`)

Clean: no committed key and no `backend/.env`; no secret-bearing fixture; the NVD key travels only in
the `apiKey` header and never reaches a URL, audit, log, error or `describe()`; no import-time or
startup fetch anywhere (every provider takes an injectable `fetchImpl`, and provider base URLs come
from validated deployment environment only — HTTPS or an explicit localhost test URL, never caller
input); `sourceReference` is stored, bounded and displayed but **never dereferenced**, so it cannot
become an SSRF vector; no raw provider response, body or header column exists on any §2B table; no
raw SQL and no partial index anywhere; evidence relations are `Restrict` and actor attributions are
`SetNull`, consistently and intentionally; no indicator or victim IP appears anywhere in the §2B
service, controller or audit layer; audit failure is swallowed and can never roll back domain state;
Packet A's `.attached`/`.removed`/`.unchanged` events are reused rather than duplicated by Packet B's
`.requested`/`.failed` bookends.

**Accepted limitation (documented, not a violation):** the association and manual-scheduling services
write a **bounded 200-character** `justificationPreview` / `sourceReferencePreview` into `AuditLog` on
the **failure** path only. These are analyst-authored fields, deliberately truncated, and carry no
provider data, credential or exception text. Recorded here because a justification is free text.

### Verification matrix

| Command | Environment | Files | Collected | Passed | Skipped | Failed |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `npx vitest run` | no database | 88 | 2082 | 1960 | 122 | 0 |
| `npx vitest run --no-file-parallelism` | `TEST_DATABASE_URL` + `EVAL_DATABASE_URL` | 88 | 2082 | 2082 | 0 | 0 |
| `npx vitest run tests/integration --no-file-parallelism` | `TEST_DATABASE_URL` | 22 | 535 | 533 | 2 | 0 |
| `npm run eval:phase1` | `EVAL_DATABASE_URL` | — | 9 | 9 | 0 | 0 |
| `npm run eval:risk` | none needed | — | 19 + contract | 19 + contract | 0 | 0 |
| `npm run eval:vulnerability` | `EVAL_DATABASE_URL` | — | 41 scenarios / 992 assertions | all | 0 | 0 |
| `npm run eval:vulnerability:mutation` | `EVAL_DATABASE_URL` | — | 1 baseline + 12 mutations | all detected | 0 | 0 |

The 122 skips are exactly the 12 database-gated files, and nothing else:
`dedupServiceConcurrency` 5, `enrichmentRetryDeadLetter` 8, `enrichmentRunner` 8,
`enrichmentWorkflowConcurrency` 10, `iocEnrichmentQueue` 14, `ownershipConcurrency` 11, `phase1Gate` 2,
`reportIngestionConcurrency` 9, `riskScoringConcurrency` 15, `vulnerabilityCoreConcurrency` 19,
`vulnerabilityPacketBApplication` 10, `vulnerabilityReleaseWorkflow` 11 — summing to exactly 122.

Repeated concurrency runs, each with **separate pre-connected `PrismaClient` instances**, 3 runs each,
all green: `vulnerabilityCoreConcurrency` + `vulnerabilityPacketBApplication` (29/29 ×3, covering the
association race, the scheduling race and the claim race), `riskScoringConcurrency` (15/15 ×3,
covering RiskScore current-row uniqueness), `vulnerabilityReleaseWorkflow` (11/11 ×3).

### Test-count reconciliation (Packet A 1974/2 vs Packet B 1960/111)

Neither number was wrong, and **no test was removed, renamed, consolidated or unintentionally
skipped**. The two reports used different commands at different commits:

- Packet A's **1974 passed / 2 skipped** = **1976 collected** at `5c1c242`, run **with**
  `TEST_DATABASE_URL` but **without** `EVAL_DATABASE_URL`. The only 2 skips are
  `phase1Gate.test.js`, which has exactly 2 tests and gates on `EVAL_DATABASE_URL` — verified
  directly.
- Packet B's **1960 passed / 111 skipped** = **2071 collected** at `54f8306`, run with **no** database
  environment at all, so all 11 database-gated files self-skipped.
- Packet B's separate "533/535" was `vitest run tests/integration` with `TEST_DATABASE_URL` — the
  whole integration directory, reproduced exactly.

The arithmetic closes: Packet B added 6 test files totalling exactly **95** tests
(`vulnerabilityPacketBApplication`, `vulnerabilityPacketBRouteAuthorization`,
`findingVulnerabilityReadService`, `vulnerabilityAssociationService`,
`vulnerabilityBatchExecutionService`, `vulnerabilityRuntime`), and **1976 + 95 = 2071**. Packet C adds
one file of 11 tests, giving the current **2082**.

### Accepted limitations

- **No live NVD / CISA KEV / FIRST EPSS smoke test has been performed.** Every automated test and both
  evaluators use the committed offline mock; no real provider quota has ever been consumed and no test
  depends on the internet.
- No automatic provider execution loop, daemon or timer: a batch runs only when an administrator asks.
- No automated CVE discovery and no product/CPE/version matching — association is analyst-only.
- CVSS is displayed as context only; it has no numeric role in Risk v1.
- External quotas and outages produce *unavailable* evidence, never a negative finding.
- Provider base URLs remain deployment-configuration controlled (HTTPS or explicit localhost only).
- No frontend for the vulnerability surface yet.
- Bounded analyst-authored previews in failure-path audit rows, as described above.

### Exact next task

**Phase 2 combined gate and ownership hardening:** bounded re-resolution after AssetMapping changes,
database query pushdown for `reResolveFindingsForMapping`, `Organization.sector` API exposure, the
deferred ownership consistency checks, and the final Phase 2 integration review.

## Phase 2 §2B Packet B complete — vulnerability application surface (2026-07-29)

**Honest scope statement: this closes the HTTP/application gap Packet A left open. §2B is still NOT
fully release-gated** — `eval:vulnerability`, mutation checks and the complete release verification
are Packet C.

Landed:

- **Production vulnerability runtime** (`vulnerabilityRuntime.js`, mirrors `enrichmentRuntime.js`).
  `buildVulnerabilityRuntime()` composes the real NVD/CISA_KEV/FIRST_EPSS providers from validated
  environment configuration (`vulnerabilityConfig.js` + `config/env.js`): `NVD_API_KEY` optional,
  `NVD_BASE_URL`/`NVD_TIMEOUT_MS`, `CISA_KEV_URL`/`CISA_KEV_TIMEOUT_MS`,
  `FIRST_EPSS_BASE_URL`/`FIRST_EPSS_TIMEOUT_MS`, and
  `VULNERABILITY_BATCH_SIZE`/`VULNERABILITY_LEASE_SECONDS`/`VULNERABILITY_MAX_ATTEMPTS`. Importing or
  building the runtime makes zero network calls; there is no `MockProvider` fallback in production;
  `describe()` exposes only `nvdApiKeyConfigured` (boolean), registered provider names, and safe
  numeric bounds — never a URL, a timeout, a key, a prefix, or a header.
- **Safe Finding-scoped vulnerability read service** (`findingVulnerabilityReadService.js`) —
  `GET /api/findings/:id/vulnerabilities`. Current ACTIVE associations (canonical `cveId` ascending),
  bounded paginated association history (`effectiveAt` desc, `id` desc), current enrichment context
  (latest provider result + latest job) per active CVE, and bounded provider-result history on
  request. Allow-list serializers structurally exclude `currentAssociationKey`, `claimToken`,
  `activeJobKey`, `claimedAt` and `leaseExpiresAt` — those fields are never even read off a row.
  `justificationPreview` is shown only when the caller holds `manage:finding-vulnerabilities`,
  decided once by the controller via `hasCapability`, never a role-name check.
- **Attach/remove HTTP surface** (`vulnerabilityAssociationService.js`,
  `findingVulnerabilityController.js`) — `POST /api/findings/:id/vulnerabilities` and
  `POST /api/findings/:id/vulnerabilities/:cveId/remove`. Wraps Packet A's `attachCve`/`removeCve`
  with the application-level `vulnerability.association.requested` / `.failed` audit bookends;
  Packet A's own `.attached` / `.removed` / `.unchanged` events are reused unchanged, never
  duplicated. No provider call, no network, no caller-defined score/band/actor/asOf.
- **Manual/forced enrichment scheduling** (`vulnerabilityEnrichmentScheduleService.js`,
  `vulnerabilityEnrichmentController.js`) — `POST /api/vulnerabilities/:cveId/enrichment`. Requires
  the canonical `Vulnerability` to already exist (attached/created) and returns a safe 404 rather
  than letting this endpoint create an unattached row; normal scheduling reuses
  `SCHEDULED`/`CACHE_HIT`/`ALREADY_PENDING`, forced requires a bounded justification and never
  bypasses active-job uniqueness.
- **Administrator bounded-batch execution** (`vulnerabilityBatchExecutionService.js`,
  `vulnerabilityEnrichmentBatchController.js`) — `POST /api/vulnerability-enrichment/batches/run`,
  ADMIN only. Server generates the `workerId`; caller-supplied `workerId`/claim token/provider
  list/URL/API key/runtime override are never read. Derives
  `claimedCount`/`releasedCount`/`deadLetteredCount`/`heldUnknownStateCount`/`staleCompletionCount`/
  `internalFailureCount` deterministically from the runner's outcome histogram — a documented,
  fixed mapping, not a re-run of runner logic.
- **RBAC** (`lib/roles.js`) — three additive, non-hierarchical capabilities:
  `manage:finding-vulnerabilities` and `trigger:vulnerability-enrichment` on ADMIN + ANALYST,
  `execute:vulnerability-enrichment-batch` on ADMIN only. Reads reuse `read:findings`. No role-name
  check exists in any controller or service; every guard runs before body processing or service
  access (proven by the RBAC route matrix).

### Accepted limitations (deliberate, recorded)

- No live provider smoke test was performed — `NVD_API_KEY` is optional and unverified against the
  real NVD API in this packet; CISA KEV/FIRST EPSS need no key at all.
- `eval:vulnerability`, mutation checks, and the complete §2B release gate are explicitly Packet C.
- Schema/migrations are untouched: **migration count remains exactly 14**; `prisma/schema.prisma`
  and `prisma/migrations/` are byte-identical to Packet A's `5c1c242`.

### Verification (2026-07-29)

- New unit suites: production runtime (zero network, no mock fallback, bounds, secret-safe
  `describe()`), read-service serializers/query logic, association-service audit bookends and
  failure isolation, batch aggregate outcome-histogram mapping.
- New integration suite (in-memory Prisma stub) `vulnerabilityPacketBRouteAuthorization.test.js`
  **44/44** — full RBAC matrix across all five routes, response-surface secret checks, audit
  sequencing.
- New focused real-PostgreSQL suite `vulnerabilityPacketBApplication.test.js` **10/10** — attach/
  remove persistence, repeated-attach idempotency, concurrent normal/forced scheduling, batch
  execution with injected providers writing three normalized results, application- and batch-level
  audit failure isolation (a broken audit write never rolls back a committed association, job, or
  provider result), safe-serializer proof, and no-orphan-row-on-rejection proof.
- Full backend suite **1960 passed / 111 skipped** (0 failed).
- Every real-PostgreSQL suite together (`--no-file-parallelism`, avoiding cross-file
  `SERIALIZABLE`-retry contention on the shared disposable database): **21 files, 533 passed / 2
  skipped**.
- `npm run eval:risk` **19/19**; `npm run eval:phase1` **9/9**.
- `npx prisma validate` clean; migration count **14**; `schema.prisma`/`prisma/migrations/`
  byte-identical to the starting `5c1c242`; `git diff --check` clean.
- No raw SQL, no partial index, no network access from any new module, no committed API key or
  `backend/.env`.

**Exact next task: §2B Packet C — manually authored vulnerability ground truth, `eval:vulnerability`,
mutation checks, complete §2B release verification, and final §2B documentation.**

## Phase 2 §2B Packet A complete — core vulnerability domain (2026-07-29)

**Honest scope statement: this is an intermediate milestone, not §2B completion.**

Previously landed (unchanged by this packet):

- `c39e795` — additive vulnerability-intelligence schema and migration
  `20260729111818_add_phase2_vulnerability_intelligence`.
- `4555031` — provider-neutral contracts plus the NVD, CISA KEV and FIRST EPSS adapters and a
  `MockVulnerabilityProvider`.

Completed by Packet A:

- **Analyst-verified CVE association domain** (`findingVulnerabilityService.js`). Append-only
  `FindingVulnerability` history; exactly one current row per `(Finding, CVE)` pair enforced by the
  `currentAssociationKey` unique column; attach/remove are SERIALIZABLE with bounded
  exponential-backoff retry on P2002/P2034; a repeat request returns `UNCHANGED` and writes no
  history. `sourceReference` is a stored note that is never fetched or dereferenced anywhere.
- **Vulnerability enrichment queue** (`vulnerabilityQueueService.js`, `vulnerabilityRepository.js`).
  Normal scheduling resolves `CACHE_HIT` / `ALREADY_PENDING` / `SCHEDULED`; the cache decision is
  all-or-nothing across NVD + CISA KEV + FIRST EPSS at an explicit `asOf`. Forced scheduling bypasses
  the cache but never active-job uniqueness, and preserves every completed and dead-lettered job.
- **Queue repository primitives** — candidate listing, atomic claim with the attempt increment in the
  same guarded statement, lease expiry and stale-token protection, release with `nextAttemptAt`,
  cancellation refund, atomic completion, dead-letter and the exhausted-job sweep.
- **Bounded runner** (`vulnerabilityRunner.js`). `runVulnerabilityEnrichmentBatch` processes 1–100
  jobs sequentially, fetches the CISA KEV catalogue **at most once per executed batch** and shares
  the immutable context, calls all three providers outside every transaction, and commits the
  COMPLETED transition plus all three provider-result rows in one transaction. A failed catalogue
  fetch produces controlled unavailable results and **never** `isKnownExploited: false`.
- **Risk v1 vulnerability activation** (`vulnerabilityRiskContext.js` + `riskInputSnapshot.js`).
  `loadVulnerabilityContext()` now reads real persisted evidence: current ACTIVE associations only,
  and only fresh SUCCESS results attached to COMPLETED jobs. Aggregation is exactly as approved —
  flat `cvePresence` 300; `kevStatus` 800 if ANY active CVE is listed, 0 only when EVERY active CVE
  has fresh usable `false`, otherwise `NOT_AVAILABLE`; `epssScore` from the maximum fresh probability
  with a canonical-cveId tie-break.
- **`EPSS_NOT_AVAILABLE` explanation code.** The unavailable EPSS path previously reported
  `EPSS_LOW`, which let "we could not check" read as "checked and negligible". A fresh score of 0
  remains `APPLIED` / 0 / `EPSS_LOW`; no usable score is now `NOT_AVAILABLE` / 0 /
  `EPSS_NOT_AVAILABLE`.

Unchanged and verified: `algorithmVersion` `risk-additive-bucketed-v1`, `configurationVersion`
`v1.0.0`, and `RISK_CONFIGURATION_FINGERPRINT` `660e7bbe…` — byte-identical before and after, because
the fingerprint covers `RISK_CONFIGURATION`, which contains no explanation-code vocabulary. No
weight, cap, bucket or band changed. **Migration count remains exactly 14**; `prisma/schema.prisma`
and `prisma/migrations/` are byte-identical to `eaa0232`.

`RiskScore.inputFingerprint` values DO change once, for every Finding, because the normalized input
set gained `activeCveIds`, `kevListedCveId` and `epssSelectedCveId`. That is an honest input-schema
change: the next rescore of an existing Finding appends one new snapshot with an identical score.

### Still pending — NOT delivered by Packet A

**Update (2026-07-29): everything below except the last two items was delivered by Packet B — see
"Phase 2 §2B Packet B complete" above.**

- ~~HTTP controllers and routes for CVE association, scheduling and batch execution~~ — Packet B
- ~~RBAC capability additions~~ — Packet B
- ~~API serializers and read services~~ — Packet B
- ~~the full audit action surface~~ — Packet B (requested/attached/removed/unchanged/failed for
  association; requested/completed/failed for scheduling; requested/completed/cancelled/failed for
  batch)
- ~~environment-variable composition and production HTTP wiring~~ — Packet B
- the `eval:vulnerability` ground-truth gate — still Packet C
- frontend — later phase

### Accepted limitations (deliberate, recorded)

- `RiskCalculationTrigger` is a PostgreSQL enum with no vulnerability-specific value, and this packet
  adds no migration. Association-triggered rescoring therefore uses `SYSTEM_RECALCULATION` and
  job-completion rescoring uses `ENRICHMENT_COMPLETED`. A dedicated trigger value is Packet B work.
- `vulnerabilityRiskContext` issues one bounded provider-result lookup per active CVE (three index
  hits each), inside the scoring transaction. `MAX_ACTIVE_CVES_PER_FINDING` (50) bounds the worst
  case; realistic findings carry one to three CVEs.
- The runner is invoked, never self-scheduling: there is no daemon, no cron and no internal loop
  beyond the single bounded call.

### Verification (all green, 2026-07-29)

- Full backend suite **1974 passed / 2 skipped**, with `TEST_DATABASE_URL` set so every
  real-PostgreSQL suite ran.
- New focused real-PostgreSQL suite `tests/integration/vulnerabilityCoreConcurrency.test.js`
  **19/19**, covering concurrent first attach, ordered history, concurrent opposing transitions,
  concurrent normal and forced scheduling, the claim-race attempt increment, completion atomicity,
  a forced provider-result insertion failure leaving no partial set, scheduling- and
  risk-failure isolation, NVD `NOT_FOUND`, KEV false vs catalogue failure, EPSS 0 vs unavailable,
  multi-CVE aggregation, final-CVE removal, append-only RiskScore history, and `onDelete: Restrict`.
  Cleanup deletes only exact collected ids — never an IP, CVE or provider prefix.
- `npm run eval:risk` **19/19**; `npm run eval:phase1` **9/9**.
- `npx prisma validate` clean; 14 migrations; `git diff --check` clean.
- No raw SQL, no network access from any new module, no committed key or `.env`.

**Superseded (2026-07-29): §2B Packet B has since shipped — see "Phase 2 §2B Packet B complete"
above. Exact next task is now §2B Packet C.**

## Locked Risk v1 numeric contract (P2-T3) — architect-approved 2026-07-29

**Status: LOCKED.** Approved by the architect as "APPROVED WITH REQUIRED AMENDMENTS" and recorded
here because `DECISIONS.md` lives in the read-only planning folder — this section is the versioned
decision location inside the repository. Every number below is authoritative. Changing any of them
requires bumping `RISK_CONFIGURATION_VERSION` and a new architect approval; it is never an
implementation-time judgement call.

The contract lives in **code**, not in the database and not in the environment:
`backend/src/services/risk/riskConfiguration.js` is a deeply frozen module with a load-time
coherence proof (`assertConfigurationCoherent`). This is the approved amendment to
`BUILD_PLAN.md` §2C's "versioned config row" wording (**D-T3-b**). Historical truth is preserved not
by keeping old config rows readable but by persisting `algorithmVersion`, `configurationVersion`,
`configurationFingerprint` **and every factor's own contribution** on each snapshot, so an old
explanation renders entirely from its own stored rows and never consults today's configuration.

### Identity and scale

| Item | Locked value |
| --- | --- |
| `algorithmVersion` | `risk-additive-bucketed-v1` |
| `configurationVersion` | `v1.0.0` |
| Score range | integer **0–10,000 basis points**; no floating point participates in scoring |
| Aggregation | **additive**, capped at 10,000 |
| `displayScore` | `floor(scoreBasisPoints / 100)` — derived at read time, never stored |

### Bands (inclusive, contiguous, tiling 0–10,000)

| Band | Basis points |
| --- | --- |
| `INFORMATIONAL` | 0 – 1,499 |
| `LOW` | 1,500 – 3,499 |
| `MEDIUM` | 3,500 – 5,999 |
| `HIGH` | 6,000 – 7,999 |
| `CRITICAL` | 8,000 – 10,000 |

A band is derived **only** from the final integer score. It is never assigned directly and never
AI-decided.

### Final locked factor caps (sum = 10,000 exactly)

| Factor | Cap |
| --- | --- |
| `sourceSeverity` | 800 |
| `exposureCriticality` | 1,500 |
| `persistence` | 1,200 |
| `recurrence` | 1,300 |
| `daysUnresolved` | 1,200 |
| `iocReputationContext` | 1,200 |
| `sectorCriticality` | 1,300 |
| `cvePresence` | 300 |
| `kevStatus` | 800 |
| `epssScore` | 400 |
| **Total** | **10,000** |

**Ownership is contextual, not a scored factor.** `FindingOwnership.status`, `confidence` and
`isIspAttribution` contribute **zero** basis points. Ownership only gates whether
`sectorCriticality` is attributable at all (amendment 2 below). This preserves `DECISIONS.md` D-003.

### Applicability vocabulary

Three states, never collapsed into each other, all of which store a contribution row:

- `APPLIED` — real evidence was scored. **May be a legitimate zero** (e.g. AbuseIPDB `SUCCESS` with
  `abuseConfidenceScore` 0 means "the provider looked and found nothing"). Only `APPLIED` may be
  non-zero.
- `NOT_AVAILABLE` — the evidence could not be obtained (failed/stale/absent enrichment, ownership too
  weak to attribute a sector). Must stay **visibly distinct** from clean evidence.
- `NOT_APPLICABLE` — the factor cannot apply to this kind of finding at all (CVE/KEV/EPSS on an
  exposure report that carries no CVE).

### Required amendment 1 — AbuseIPDB `NOT_FOUND`

A **fresh `NOT_FOUND`** is:

- applicability `NOT_AVAILABLE`
- contribution 0
- `explanationCode` `IOC_REPUTATION_NOT_FOUND`
- normalized input `null`

`SUCCESS` with `abuseConfidenceScore` 0 remains `APPLIED` / 0 / `IOC_REPUTATION_NONE` / normalized
input `0`. `NOT_FOUND` means no usable provider reputation record exists and must **not** share
`APPLIED` semantics with a confirmed zero-score reputation. All other IOC reputation buckets are as
drafted.

### Required amendment 2 — sector applicability confidence gate

`sectorCriticality` applies only when **either**:

- **A.** `FindingOwnership.status = OVERRIDDEN`, `organizationId` present, `isIspAttribution = false`; or
- **B.** `FindingOwnership.status = RESOLVED`, `organizationId` present, `isIspAttribution = false`,
  and `confidence` is exactly `HIGH` or `MEDIUM`. `CONFIRMED` is excluded from path B: it is
  unreachable there (`ownershipResolver.js` only assigns `CONFIRMED` to an `OVERRIDDEN` result, which
  takes path A unconditionally), and keeping it as a "defensive" extra value in path B was itself an
  unnecessary future formula-expansion risk.

It does **not** apply when: no ownership row · `AMBIGUOUS` · `UNRESOLVED` · `organizationId` absent ·
`isIspAttribution = true` · `RESOLVED` with `LOW` confidence · `Organization.sector = UNKNOWN`.

`RESOLVED` + `LOW` confidence emits the closed outcome `NOT_AVAILABLE` / 0 /
`SECTOR_NOT_AVAILABLE_LOW_CONFIDENCE`. This is an **applicability gate only** — ownership confidence
is not itself a scored factor and contributes no basis points.

### Required amendment 3 — current unresolved episode

`daysUnresolved` is measured from the start of the **current** unresolved episode, never from the
original `firstSeen` of a finding that was closed and later recurred:

1. `Finding.status = CLOSED` → `NOT_APPLICABLE` / 0 / `DAYS_UNRESOLVED_NOT_APPLICABLE_CLOSED`.
2. `OPEN` with no `RECURRED` occurrence at or before `asOf` → `unresolvedSince = firstSeen`.
3. `OPEN` with one or more `RECURRED` occurrences at or before `asOf` → `unresolvedSince =` the
   latest `RECURRED` `occurrence.observedAt` (the start of the current reopened episode).
4. `daysUnresolved = floor((asOf - unresolvedSince) / 86,400,000)`.
5. Normalized `daysUnresolved` is clamped to `[0, 3650]`.
6. `unresolvedSince` absent, invalid or later than `asOf` → `NOT_AVAILABLE` / 0 /
   `DAYS_UNRESOLVED_INVALID_TIMESTAMP`.

Contribution buckets (unchanged): 0–6 days → 0 · 7–29 → 400 · 30–89 → 800 · 90+ → 1,200.
**Time spent in `CLOSED` state is never counted as unresolved time after recurrence.**

### Resolution of draft items G1–G7

- **G1.** `sourceSeverity` 800 and `exposureCriticality` 1,500 both stand. The correlation is
  intentional: `sourceSeverity` is the accepted report class/source assertion; `exposureCriticality`
  is the technical value of the exposed TCP/3389 service.
- **G2.** `INFORMATIONAL` is **intentionally unreachable** for `ACCESSIBLE_RDP`. The fixed baseline is
  2,300 basis points (800 + 1,500), therefore `LOW`. An accessible RDP service must never be
  classified as merely informational.
- **G3.** Persistence remains **count-based**: the count of immutable `FindingOccurrence` rows with
  `observedAt <= asOf`. Time is represented separately by `daysUnresolved`.
- **G4.** For `ACCESSIBLE_RDP` without a CVE-bearing source, `cvePresence`, `kevStatus` and
  `epssScore` are all `NOT_APPLICABLE` / 0, and **all three still emit stored contribution rows**.
  The future CVE-bearing input model is explicitly deferred and was not invented here.
- **G5.** `HISTORICAL` occurrences **are** included in the persistence count — each is a distinct
  accepted report observation. Phase 1 already guarantees one occurrence per Finding/report, and
  duplicate rows do not create additional occurrences.
- **G6.** Uses the amended current-open-episode `daysUnresolved` rule above.
- **G7.** The 3,650-day normalized-input clamp is approved. The scoring cap is already reached at 90
  days; the clamp only bounds stored normalized evidence.

### Standing prohibitions (restated from the approval)

- Do **not** add ownership as a scored factor.
- Do **not** infer CVEs from Accessible RDP.
- Do **not** treat missing enrichment as confirmed score-zero reputation.
- Do **not** count time spent `CLOSED` as unresolved time.

## Completed — P2-T3 (deterministic, explainable, append-only risk scoring)

Implements the locked contract recorded above. Every number comes from that section; nothing here
re-decides any of it.

**Migration:** `20260728123013_add_phase2_risk_scoring` — one additive migration (`CREATE TYPE` /
`CREATE TABLE` / `CREATE INDEX` / `ADD FOREIGN KEY` only; no raw SQL, no partial index, no
destructive change, no column altered on any existing model). Adds `RiskScore`,
`RiskFactorContribution` and three enums (`RiskBand`, `RiskCalculationTrigger`,
`RiskFactorApplicability`). Migration count 12 → 13.

**D-T3-a — append-only with exactly one current row.** `RiskScore.currentForFindingId Int? @unique`
is the same mechanism as `FindingOwnership` (D-006) and `IocEnrichment.activeCacheKey` (D-007):
PostgreSQL treats multiple NULLs in a unique index as distinct, so any number of superseded rows
coexist while at most one row per Finding carries the pointer. Supersession sets `supersededAt` and
nulls the pointer; it never edits a score, a band, or any contribution.

**D-T3-b — the contract lives in code, not in a config row.** `BUILD_PLAN.md` §2C says "weights live
in a versioned config row, not code constants, so changing weights later does not retroactively
falsify old explanations." The *goal* is honoured; the *mechanism* is amended, with architect
approval. `riskConfiguration.js` is a deeply frozen module with a load-time coherence proof
(`assertConfigurationCoherent`, which fails `require()` if the caps stop summing to 10,000, a bucket
exceeds its cap, the bands stop tiling 0–10,000, or the vulnerability factors start to dominate).
Historical truth is preserved by persisting `algorithmVersion`, `configurationVersion`,
`configurationFingerprint` **and every factor's own contribution and cap** on each snapshot — so an
old explanation renders entirely from its own stored rows and never consults today's configuration.
A config *row* would have been strictly weaker: it is mutable at runtime with no code review, and it
still would not have made an old explanation self-contained.

**Pure engine** (`riskEngine.js`, no Prisma / filesystem / network / clock / randomness / AI):
`calculateRisk({configuration, inputSnapshot})` → frozen result. One explicit named evaluator per
factor rather than a generic rules interpreter. `finalizeFactor` is the structural choke point: a
non-`APPLIED` factor contributes exactly 0 whatever its evaluator said, nothing may exceed its own
cap or go negative, and every explanation code must be in the closed vocabulary. All ten factors
emit a contribution row on every run, including `NOT_AVAILABLE` and `NOT_APPLICABLE` ones — that is
what stops a stored explanation silently omitting missing context.

**Normalized input snapshot** (`riskInputSnapshot.js`): reads persistence and recurrence from
immutable `FindingOccurrence` evidence (never from the mutable `Finding.occurrenceCount` /
`recurrenceCount` projections, never from `updatedAt`), applies the amendment-3 current-episode rule,
applies the amendment-2 ownership gate, and resolves reputation freshness over the half-open window
`[queriedAt, expiresAt)` — matching `iocEnrichmentRepository.findFreshCachedResult` exactly. The
wall clock is never read: `asOf` is always supplied by the caller. Carries only bounded scalars — no
indicator, no cache key, no claim token, no provider payload, no actor name.

**Append-only persistence** (`riskScoringService.js`): the whole load → calculate → persist cycle runs
in ONE Prisma interactive transaction at `Serializable`, with the same retry discipline copied from
`findingOwnershipService.js` / `dedupService.js` — a recognised `P2002`/`P2034` re-runs the *entire*
transaction from scratch (never a catch inside the transaction, which would leave PostgreSQL aborted
at `25P02`). Idempotency: equal `inputFingerprint` + equal configuration/algorithm version returns
`UNCHANGED` and appends nothing, so re-uploading an identical report cannot flood risk history.
`asOf` is deliberately excluded from the fingerprint, but the elapsed-day *bucket* is inside it, so
genuine time-driven change still registers.

**Explanation** (`riskExplanation.js`): rendered exclusively from persisted rows. Never touches the
database, never re-reads live Finding/ownership/enrichment state, never consults today's
configuration, never calls a model. One fixed sentence per closed code, with only the row's own
stored `normalizedInputValue` interpolated. An unrecognised code (from a future configuration
version) degrades to a neutral sentence rather than throwing.

**Automatic rescoring** (`riskRecalculationService.js`), at three committed state-change boundaries:
ingestion (after all evidence commits), enrichment completion (after terminal results commit), and
ownership override apply/clear (after the ownership transaction commits). Two guarantees: **failure
isolation** — nothing here ever throws into its caller, failures come back as one of three closed
codes (`FINDING_NOT_FOUND` / `VALIDATION_ERROR` / `PERSISTENCE_ERROR`) and an exception message never
escapes; and **bounded audit** — one aggregate event per operation carrying counts only, never one
per factor and never one per finding. Bounded at 100 findings per trigger, with the remainder
reported as `skippedCount` rather than silently truncated. No daemon, no cron, no unbounded sweep.

**APIs, RBAC and audits.** `GET /api/findings/:id/risk` (`read:findings` — every role that can see a
finding can see why it was prioritised) and `POST /api/findings/:id/risk/recalculate`
(`recalculate:finding-risk`, ADMIN + ANALYST only; justification required). The request can
influence **when** a score is calculated and **why**, and nothing else: there is no way to supply a
weight, score, band, configuration version, trigger or `asOf` — the controller captures `now` itself
exactly once, the actor comes from the verified token, and the weights are frozen code constants.
Proven by an explicit adversarial test that posts every score-shaped field at once and asserts the
stored snapshot is unchanged.

**Ownership stays unscored.** Ownership status, confidence and `isIspAttribution` contribute zero
basis points (D-003 and `BUILD_PLAN.md` §2C both stand). Ownership only gates whether
`sectorCriticality` is attributable. An ownership change still triggers a rescore, because flipping
that gate genuinely changes the score.

**Tests: 1,745 passing, 2 skipped** (was 1,417 at P2-T2e-2). New:
- `riskConfiguration.test.js` (38) — the locked contract transcribed from the approval, not read back
  from the module; fingerprint determinism; deep-freeze immutability.
- `riskEngine.test.js` (83) — hand-derived scores; a `describe` block per amendment.
- `riskInputSnapshot.test.js` (44) — episode rule, ownership gate matrix, enrichment priority and
  freshness, fingerprint sensitivity.
- `riskScoringService.test.js` (25) — CREATED/UNCHANGED, supersession, retry classification, bounding.
- `riskExplanation.test.js` (19) — every closed code has a template and no template exists outside it.
- `findingRiskReadService.test.js` (19) — serializer allow-list, pagination, evidence bounding.
- `riskRecalculationService.test.js` (24) — never-throws, closed failure codes, aggregate-audit bounds.
- `evalRiskGate.test.js` (33) — proves the evaluator gate can actually fail, by tampering with
  in-memory copies of both the ground truth and the configuration.
- `riskRouteAuthorization.test.js` (27) — full RBAC matrix plus the adversarial request-surface test.
- `riskScoringConcurrency.test.js` (15, real PostgreSQL) — the `currentForFindingId` unique rule under
  8 concurrent rescorings, `Restrict` refusing to orphan history, the per-factor unique constraint,
  and all three amendments against actually stored rows.

**Executable manually authored ground truth:** `data/synthetic/risk_ground_truth.yaml` +
`eval/lib/riskGroundTruthLoader.js` + `eval/run_risk_v1_gate.js` (`npm run eval:risk`). 19 scenarios,
every expected value derived by hand from the locked contract rather than read back from the engine.
The gate checks three independent things: that the compiled configuration still matches a *second*,
hand-transcribed copy of the approved weights; that every hand-derived score, band, display value and
factor contribution matches; and that scoring is deterministic on replay. It needs no database, no
network and no clock — risk scoring is a total function of the snapshot, which is exactly what is
being pinned. The loader also rejects an internally incoherent expectation (a `displayScore` that
does not follow from its score, a band that does not follow from its score, a non-`APPLIED` factor
expecting basis points, a contribution above its declared cap).

**Gates run:** full suite 1,745/1,745 against real PostgreSQL · Phase 1 gate 9/9 (still passing with
risk scoring now wired into ingestion — direct evidence of failure isolation) · Risk v1 gate:
contract + 19/19.

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

## Completed — P2-T2d (bounded enrichment runner + queue completion integration)

The worker that finally connects the P2-T2b queue/cache primitives to a provider's `lookup()` and the
P2-T2c TTL policy. Before this packet nothing ever called a provider from the queue layer; this
packet is that one call site — and stops there. **No report-ingestion scheduling, no routes/
controllers/RBAC, no audit events, no daemon or cron process.** See "No ingestion or API integration"
below for the exact boundary.

### Files

New: `backend/src/services/enrichment/enrichmentRunnerTypes.js` (pure: outcome taxonomy, config
validation, per-job/batch-summary shape-building — no Prisma, no provider call, no wall clock) and
`enrichmentRunner.js` (orchestration: the one place that calls `listPendingCandidates`/
`claimPendingJob`/`completeClaimedJob`/`releaseClaimedJob` from P2-T2b, a caller-injected
`providerRegistry`/`ttlPolicy`, and nothing else). `backend/tests/unit/enrichmentRunnerTypes.test.js`,
`enrichmentRunner.test.js`, `backend/tests/integration/enrichmentRunner.test.js`. **Nothing else in
the repository was touched** — no `schema.prisma` change, no migration, no `env.js` change, no
ingestion wiring, no routes, no frontend. Mirrors the pure/orchestration split already used throughout
this directory (`iocEnrichmentCacheRules.js` / `iocEnrichmentRepository.js`).

### Runner API and execution bounds

`runEnrichmentBatch({prisma, providerRegistry, now, batchSize, leaseDurationSeconds, ttlPolicy,
workerId, signal})` — every field validated by `assertValidRunnerConfig` *before* any database or
provider call, so a malformed caller never partially processes work. `now` is explicit (no
`Date.now()` anywhere in a decision path); `batchSize` bounded `[1, 200]` (reuses P2-T2b's
`MAX_PENDING_BATCH_SIZE`, never silently clamped — out of range throws); `leaseDurationSeconds`
bounded `[1, 3600]` (derived from P2-T2b's own lease bounds); `workerId` a non-empty, trimmed,
control-character-free string ≤128 chars (validated but not yet consumed anywhere — no logger exists
in this repository to hand it to; a future caller's own logging convention would thread it through,
not this module); `signal` an optional `AbortSignal`. One invocation processes **at most
`batchSize` candidates, strictly sequentially, one provider call in flight at a time** — no
`Promise.all` over shared work, no concurrency invariant claimed beyond what P2-T2b's real-PostgreSQL
suite already proves for genuine concurrent *processes*. The runner itself creates no schedule, timer,
or daemon.

### Claim → provider → TTL → completion flow

Per candidate: `claimPendingJob` with the caller's explicit `now`/`leaseMs` (P2-T2b, unchanged) → on
a lost race, `SKIPPED_NOT_CLAIMED`, no provider call, continue. On a successful claim: the job's own
stored `provider` name is resolved through the **caller-injected** `providerRegistry.resolve(name)`
— never a second registry, never a fallback to `mock` for an unregistered name. The provider's
`lookup()` is built exclusively from allow-listed persisted fields
(`indicatorType`/`indicator`/`queryParams`, defensively shallow-copied) plus the explicit `now` and
`signal` — **never the claimed database row itself**, never `claimToken`/`cacheKey`/`activeCacheKey`/
`workerId`. Exactly one `lookup()` call per successfully claimed job, always **outside** any Prisma
transaction. Its terminal result (a `PENDING` result is rejected as a contract violation, not accepted)
goes through the caller-injected `ttlPolicy` (`resolveEnrichmentTtl` in production) to derive
`expiresAt`, then `completeClaimedJob` with the exact claimed `id`/`claimToken` — reusing every P2-T2b
guarantee unchanged (wrong/stale token cannot complete, a terminal row cannot be overwritten, no
`updatedAt` version token).

### Cancellation behavior

Checked at three points: before starting a new candidate (stops the loop, no partial job started),
immediately after a successful claim and before any provider call, and via the provider's own
`AbortError` (propagated verbatim by `abuseIpdbProvider.js` on genuine caller cancellation — never
guessed from error shape). In every case the held claim is released (`releaseClaimedJob`, the P2-T2b
abandon path — the job stays durably `PENDING`, immediately reclaimable, no invented terminal status)
and the outcome is the dedicated `RELEASED_AFTER_CANCELLATION` code — **never** `TIMEOUT` or any other
provider outcome. `summary.cancelled` is set once, at the batch level; already-completed earlier jobs
in the same batch are untouched.

### Unexpected internal-error behavior

A. **Expected provider outcome** (`TIMEOUT`/`RATE_LIMITED`/`FAILED`/etc.) — TTL applied, completed
normally, exactly like `SUCCESS`. B. **Caller cancellation** — see above. C. **Unexpected provider/
programmer exception** (a thrown `TypeError`, a malformed dependency, a corrupt provider result) — the
claim is released (`RELEASED_AFTER_INTERNAL_ERROR`), the job stays `PENDING` with **no** partial
terminal fields, and the batch continues to the next candidate; `err.message` is never copied into any
result, log, or the database — the closed outcome code is the only signal that ever leaves this
module. D. **Completion/release failure** (an unknown database error during the completion or release
write itself) — a safe closed outcome (`COMPLETION_FAILED`/`RELEASE_FAILED`), no blind retry, no
Prisma error text exposed, and every earlier successfully-completed job in the batch is preserved
untouched. An unregistered/unknown `provider` name never invents a terminal result on the provider's
behalf — the claim is released and reported as `UNKNOWN_PROVIDER`.

Closed outcome taxonomy (`RUNNER_OUTCOME`, `enrichmentRunnerTypes.js`): `COMPLETED ·
SKIPPED_NOT_CLAIMED · RELEASED_AFTER_INTERNAL_ERROR · RELEASED_AFTER_CANCELLATION ·
STALE_CLAIM_ON_COMPLETION · CLAIM_FAILED · COMPLETION_FAILED · RELEASE_FAILED · UNKNOWN_PROVIDER`.

### Batch summary design

`buildBatchSummary` derives every count from the `results` array itself — nothing is tracked
separately, so the summary can never drift from the per-job list it describes. Returned fields:
`requestedBatchSize, candidateCount, claimedCount, completedCount, statusCounts (by terminal status),
skippedNotClaimedCount, releasedCount, staleCompletionCount, internalFailureCount,
unknownProviderCount, cancelled, results`. Each per-job result carries only
`enrichmentId/provider/indicatorType/indicator/outcome/terminalStatus/queriedAt/expiresAt` — **never**
`claimToken`, `activeCacheKey`, an API key, a header, a raw provider payload, a raw `Error.message`, a
stack trace, or a full database row. The whole summary, its `results` array, every per-job result, and
`statusCounts` are all `Object.freeze`d, and every `Date` field is defensively cloned rather than
shared with the underlying database row.

### Transaction and concurrency guarantees

No provider call ever occurs inside a Prisma transaction. Every concurrency invariant the runner
depends on (`activeCacheKey` uniqueness, the guarded claim/complete `updateMany` compare-and-swap) is
the exact same one P2-T2b's real-PostgreSQL suite already proves under genuine concurrent
*processes* — this packet's own real-PostgreSQL suite proves the runner uses those primitives
correctly (two separate `PrismaClient`s racing for one job via `Promise.all` yield exactly one
provider call and one completion; a lease expiring mid-lookup lets a second worker reclaim while the
first worker's stale token is safely rejected; a forced completion-write failure leaves the row in its
prior valid `PENDING`+leased state with no partial terminal field, and that same lease still completes
correctly afterward).

### Tests

**42 new unit tests** against an in-memory fake Prisma client and fake/real providers (never a real
network call): `enrichmentRunnerTypes.test.js` (18 — config validation bounds, `buildJobResult`/
`buildBatchSummary` shape and immutability, exact count derivation). `enrichmentRunner.test.js` (24 —
happy path incl. score-0 persistence and an injected out-of-range TTL persisted verbatim; claim-safety
incl. a claim-token-never-leaks proof via a `crypto.randomUUID` spy; provider selection incl. the real
`createAbuseIpdbProvider` with no API key producing a `COMPLETED`/`SKIPPED_DISABLED` result, and an
unregistered provider never falling back to mock; TTL/completion incl. a rejected `PENDING` provider
result and a stale-claim-at-completion simulation; cancellation incl. the provider's own `AbortError`
never being misclassified as `TIMEOUT`; unexpected-exception handling incl. a thrown `TypeError`
leaking no raw text and the batch continuing to the next job; and a fake-AbuseIPDB-key-never-leaks
proof reusing the real provider with an injected `fetchImpl`).

**8 real-PostgreSQL tests** (`tests/integration/enrichmentRunner.test.js`, self-skips without
`TEST_DATABASE_URL`, dedicated marker `p2t2d-mock` + IP range `198.19.0.x` — distinct from P2-T2b's own
real-DB suite's `p2t2b-mock`/`198.18.0.x` so both can run together): (1) a claimed job completes with
terminal fields exact and lease metadata cleared; (2) two separate `PrismaClient`s racing for one job
via `Promise.all` produce exactly one provider call and one completion, the loser reporting
`SKIPPED_NOT_CLAIMED`; (3) a lease expiring mid-lookup lets a second worker reclaim and complete while
the first worker's now-stale token is safely rejected; (4) a forced completion-`updateMany` failure
leaves no partial terminal field and the row's live lease still completes correctly afterward; (5) a
mixed batch (success, `NOT_FOUND`, an unregistered provider, a thrown `TypeError`) completes
independently per job with exact row states; (6) a repeated invocation never reprocesses a terminal
row or re-calls the provider; (7) five pending rows with `batchSize: 3` processes exactly three, in
deterministic `requestedAt`/`id` order, leaving the rest untouched; (8) a job released after
cancellation is genuinely reclaimable via a fresh `claimPendingJob` call, with no partial result
fields. Run 4× back-to-back: 3 clean, 1 hit a one-off timing flake in test 4 under full-suite
contention that did not reproduce on retry (not a defect — the guarded `updateMany` semantics this
test depends on are otherwise proven stable).

### Verification

- Targeted P2-T2a/b/c/d unit suites together: **309/309 PASS**.
- Ownership regression (`findingOwnershipService`, `ownershipResolver`, `assetMappingService`, `roles`,
  `reportIngestionService`): **147/147 PASS**, unchanged — this packet touches no ownership code.
- Full backend suite (with `TEST_DATABASE_URL`/`EVAL_DATABASE_URL` set): **1243/1243** on 3 of 4 runs;
  the 4th run hit the enrichmentRunner real-DB flake above (retried clean) and, separately, the
  already-known pre-existing `cleanupUpload.test.js` timing flake (unrelated file, not touched by this
  packet, not new).
- All real-PostgreSQL suites (dedup + ingestion + phase1Gate + ownership + enrichment queue +
  enrichment runner) run together as part of the full suite above.
- Phase 1 evaluator: `npm run eval:phase1` — **9/9 PASS**.
- `npx prisma validate` clean · migration count unchanged at **11** · `schema.prisma` byte-identical
  (no diff) · no real network call anywhere in the suite (every provider is `MockProvider`-shaped or a
  real provider with an injected fake) · `git diff --check` clean (only benign CRLF-normalization
  notices on the new files).

### No ingestion or API integration (deliberately, this packet stops here)

The runner is never invoked automatically: no report-ingestion code path schedules or calls it, no
route exposes a "run worker" trigger or reads enrichment data, no capability/RBAC guard exists for
anything enrichment-related, and no `AuditLog` event is written on any enrichment path. Those are
**P2-T2e** — ingestion scheduling, enrichment read/trigger APIs, RBAC and audits.

## Completed — P2-T2e-1 (retry/dead-letter safety, runner hardening, composition root, audited execution)

Closes the two risks the P2-T2d release audit raised (verdict: *approved with non-blocking risks*)
and makes the runner production-*composable* — while deliberately leaving it production-*unreachable*.
**No ingestion scheduling, no routes/controllers, no RBAC capability, no daemon, cron or worker
loop.** See "Still no ingestion or API reachability" below for the exact boundary.

### Migration

`20260728071624_add_phase2_enrichment_retry_dead_letter` — the only migration in this packet, strictly
additive and non-destructive: one enum value (`IocEnrichmentStatus.DEAD_LETTER`), six nullable/defaulted
columns on `IocEnrichment` (`attemptCount` default 0, `maxAttempts` default 3, `nextAttemptAt`,
`lastAttemptAt`, `deadLetteredAt`, `terminalReasonCode`), and one index
`(status, nextAttemptAt, requestedAt)` for the retry-eligible pending lookup. No column dropped, no
type changed, no data rewritten, no raw SQL, no partial index. Migration count **11 → 12**. Applied
cleanly to both disposable databases (`threatnexus_test`, `threatnexus_eval`); the development
database was never touched.

### DEAD_LETTER is a queue state, never a reputation outcome

`DEAD_LETTER` was added to the Prisma `IocEnrichmentStatus` enum but **deliberately not** to
`iocEnrichmentTypes.ENRICHMENT_STATUS`, the provider-result taxonomy. Because `TERMINAL_STATUSES` is
derived from that provider taxonomy, three things are structurally true rather than merely documented:
`createEnrichmentResult` can never produce `DEAD_LETTER`, `buildTerminalFields` can never write one,
and `findFreshCachedResult` can never return one as a cache hit. "We stopped processing this job" is
therefore incapable of ever reading as "the address is clean" — the same invariant P2-T2b established
for cached failures, extended to the queue's own give-up state.

### Attempt budget, retry gate and dead-lettering

`attemptCount` is incremented by the **same guarded `updateMany` that establishes the lease**, never by
a follow-up write — so it counts real attempts and a consumer that loses the claim race increments
nothing. The budget guard compares the live `attemptCount` column against the row's own immutable
`maxAttempts` (read first, used as a constant in the WHERE clause), so PostgreSQL re-evaluates it at
update time against the winner's committed row. `maxAttempts` is persisted per job, bounded `[1, 10]`,
default 3, and out-of-range **throws rather than clamping**.

`nextAttemptAt` gates retry eligibility: null means "eligible now", a future value hides the row from
`listPendingCandidates`. The boundary is inclusive (`nextAttemptAt === now` is eligible) and matches
`isRetryEligibleRecord` exactly, so the pure rule and the query cannot disagree about the instant.

New primitives: `deadLetterClaimedJob` (claim-token-guarded, for a worker that has exhausted its
budget) and `deadLetterExhaustedJob` (no token, guarded instead on *already exhausted* **and** *no live
lease* — the sweep for a row stranded at its limit by a crashed worker, which `claimPendingJob` refuses
and which would otherwise sit `PENDING` and unclaimable forever). Both clear `activeCacheKey` and every
lease field, write only a closed `terminalReasonCode`, and cannot overwrite an already-terminal row.
Both **preserve** whatever normalized/provider evidence an earlier attempt recorded — the statement
touches lifecycle columns only.

A previously dead-lettered row never blocks a later *explicit* scheduling call: `activeCacheKey` is
cleared and `DEAD_LETTER` is not a cache hit, so `scheduleEnrichment` creates a fresh attempt row with
a full budget while the retired row stays as history. Re-scheduling is always a deliberate act, never
an automatic resurrection.

### Retry policy (pure)

`enrichmentRetryPolicy.js` — no Prisma, no provider, no wall clock (`now` is the only time input).
Closed failure classes → closed actions:

| Failure class | Action | Notes |
|---|---|---|
| `EXPECTED_PROVIDER_RESULT` | `COMPLETE` | every terminal provider status, incl. negatives; budget never applies |
| `CALLER_CANCELLATION` | `RELEASE_WITH_DELAY` | short delay, attempt **refunded**, **never** dead-letters at any count |
| `PROVIDER_PROGRAMMER_ERROR` | `RELEASE_WITH_DELAY` → `DEAD_LETTER` | 5m doubling, capped 1h; retires at budget |
| `UNKNOWN_PROVIDER` | `RELEASE_WITH_DELAY` → `DEAD_LETTER` | flat 1h (only an operator can change the outcome) |
| `COMPLETION_VALIDATION_ERROR` | `RELEASE_WITH_DELAY` → `DEAD_LETTER` | safe to act on: no write happened |
| `COMPLETION_DATABASE_ERROR` | `HOLD_UNKNOWN_STATE` | budget ignored deliberately |
| `RELEASE_DATABASE_ERROR` | `HOLD_UNKNOWN_STATE` | budget ignored deliberately |

Every delay is clamped into `[60s, 24h]`, so a zero-delay re-claim loop is structurally impossible and
no delay is infinite. A provider's `Retry-After` may only **extend** the policy's delay, never shorten
it, and is rounded up. Cancellation refunds exactly the one increment its own claim made — that is a
reversal, not a reset, and is safe because the release is claim-token-guarded, so no other worker can
be touching the row while we hold the lease.

### Runner audit fixes (P2-T2d findings M1–M4)

**A. Completion validation vs. unknown database state.** P2-T2d turned *every* `completeClaimedJob`
throw into `COMPLETION_FAILED` and held the lease. It now classifies on the **typed domain error**
(`IocEnrichmentValidationError` vs. anything else) — never by parsing `error.message`:

- rejected-before-write → `COMPLETION_VALIDATION_ERROR` → durable state known exactly → released with
  a delay, or dead-lettered once the budget is spent
- the write itself raised → `COMPLETION_DATABASE_ERROR` → the write may have committed → `HOLD_UNKNOWN_STATE`:
  nothing is released, nothing is dead-lettered, the lease is kept and **lease expiry is the recovery
  path**. Releasing here could hand a job that already completed to another worker; dead-lettering it
  could bury a good result.

**B. Cancellation re-check.** The `AbortSignal` is now re-checked *after* `provider.lookup()` returns
and *before* TTL/completion. A provider that returns normally while the signal fires — or that does not
honour the signal at all — no longer gets its job completed: the job is released under the cancellation
policy and the batch stops. Earlier completed jobs stay completed; later candidates never start.

**C. Release-failure provenance.** Every job result now carries a closed `failureClass`, so a
`RELEASE_FAILED` says *why* the release was attempted (cancellation / provider error / unknown provider
/ completion validation) without exposing any exception content. `buildJobResult` validates
`failureClass` and `terminalReasonCode` against their closed vocabularies, so a raw error string is
structurally unable to reach a caller through this shape.

**D. Missing-path tests** — all six now exist (see Tests).

New outcomes: `RELEASED_AFTER_COMPLETION_VALIDATION`, `DEAD_LETTERED`, `EXHAUSTED_DEAD_LETTERED`,
`EXHAUSTED_SWEEP_FAILED`. New summary counts: `deadLetteredCount`, `heldUnknownStateCount` (kept
separate from `internalFailureCount` so an operator can tell "we do not know" from "we know it broke").

### Production composition root

`enrichmentRuntime.js` — one function returning a frozen object. Not a DI framework, not a worker:
building a runtime starts no timer, loop or batch (proven with fake timers). Importing it makes no
network call and requires no API key; `config/env.js` is loaded lazily so a unit test needn't satisfy
the whole application's configuration. It binds the exact, case-sensitive provider registry, the real
TTL and retry policies, and bounded lease/batch/attempt defaults. **It never falls back to
MockProvider**: an unregistered name throws (the runner reports `UNKNOWN_PROVIDER`), and
`allowMockProvider: false` removes even an explicit `"mock"`. `describe()` reports *whether* an
AbuseIPDB key is configured — never the key, a prefix of it, or its length.

### Audited execution service

`enrichmentExecutionService.executeEnrichmentBatch({prisma, actorContext, now, batchSize, workerId,
signal, runtimeOverrides})` invokes `runEnrichmentBatch` **at most once** per call. It has actor/source
context but **no HTTP dependency** — no `req`, no Express import — so a system caller passes
`SYSTEM_ACTOR_CONTEXT` (actorUserId null: attributing system work to a real user would be a false
attribution) and a future route caller will pass `buildAuditContext(req)`.

Audit actions, following the existing dotted convention: `enrichment.batch.requested` (always, before
any work), then exactly one of `enrichment.batch.completed` / `.cancelled` / `.failed`. At most three
rows per call **whatever the batch size** — there is no per-job audit event by design. A per-job
failure is a count inside a *completed* batch, not a failed batch.

`buildBatchAuditPayload` is an **allow-list, not a redaction pass**: it names the aggregate fields it
copies, so a field added to the runner summary later cannot leak through it by default. Audited:
counts plus the terminal-status histogram. Never audited: `results[].indicator`, claim token, cache
key, `activeCacheKey`, API key, request headers, raw provider response, `Error.message`, stack, or a
row dump. The indicator exclusion is deliberate — per-job evidence already lives in `IocEnrichment`,
which is its correct queryable home; copying it into every batch's audit trail would both flood the
trail and duplicate victim-adjacent data. Audit failure cannot damage queue processing (`safeLogAuditEvent`
plus a local guard), and the runner itself stays audit-agnostic.

### Durable decisions recorded by this packet

Recorded here rather than in `DECISIONS.md`: that file lives in the **read-only** planning folder
(`../ThreatNeXus-Planning/`), which `AGENTS.md`/`CLAUDE.md` forbid editing and which is not under
version control, so an edit there would be unversioned and hard to reverse. Flagged for the owner to
port across if wanted.

- **D-T2e1-a — Bounded attempt budget.** `maxAttempts` is persisted per job, bounded `[1, 10]`,
  default 3. Persisted (not read from config at claim time) so a job's budget cannot change under it
  between attempts. Out-of-range throws rather than clamping.
- **D-T2e1-b — `nextAttemptAt` governs retry eligibility.** Inclusive boundary. A release always
  carries a bounded, non-zero delay, so an immediate re-claim loop is structurally impossible.
- **D-T2e1-c — `DEAD_LETTER` is a queue-lifecycle state, not a provider outcome.** It is absent from
  the provider result taxonomy, so it can never be produced by a provider or read as reputation
  evidence. Dead-lettering preserves prior evidence and clears `activeCacheKey`.
- **D-T2e1-d — An unknown completion database error holds the lease.** No release, no dead-letter, no
  blind retry; lease expiry is the recovery path. Distinguished from a local validation rejection by
  typed domain error, never by message parsing.
- **D-T2e1-e — Cancellation is not a failed attempt.** It refunds its own attempt increment and can
  never dead-letter a job at any attempt count.
- **D-T2e1-f — Audit belongs to the execution service.** The pure runner and the repository primitives
  stay audit-agnostic; they have no actor/request context. Batch audits are aggregate-only and never
  per-job.

### Tests

**110 new/updated tests**, none touching the real internet (every provider is a fake or a real provider
with an injected `fetchImpl`).

- `enrichmentRetryPolicy.test.js` (**33**) — every failure class; exact attempt boundaries (below /
  exactly at / past budget, and `maxAttempts: 1`); bounded, deterministic, non-zero delays; exponential
  growth capped; `Retry-After` extends but never shortens and rounds up; extreme values clamped;
  cancellation never dead-letters; `PENDING`/`DEAD_LETTER`/invalid inputs rejected; `nextAttemptAt`
  derived from the explicit `now` (asserted against a far-future date, so a wall-clock read would fail).
- `iocEnrichmentRetryQueue.test.js` (**24**) — pure predicates; default and explicit budget; exactly one
  increment per claim; a lost claim increments nothing; exhausted claims refused; release never resets
  and refunds exactly one; retry gate hides/admits at the exact boundary; dead-letter clears
  active/lease fields, requires the right token, cannot overwrite a terminal row, preserves prior
  evidence, rejects free-form reason text, is never listed and never a cache hit; sweep refuses a row
  with budget left or a live lease; re-scheduling after a dead letter creates a fresh row while
  active-job uniqueness still holds.
- `enrichmentRunner.test.js` (**+12**, 36 total) — pre-aborted signal makes **zero** database and
  provider calls (findMany/updateMany call counters, not just "no work"); `claimPendingJob` throws →
  `CLAIM_FAILED` and the batch continues; `releaseClaimedJob` throws → `RELEASE_FAILED` with closed
  provenance; local completion-validation error → released with a delay, no partial terminal fields;
  unknown completion DB error → lease **held**, nothing released or dead-lettered; cancellation after
  the provider returned → not completed, attempt refunded; unknown provider dead-letters after its
  budget and is never called again; a repeatedly failing provider costs exactly `maxAttempts` calls
  across eight batches; a poison job does not starve a healthy one beside it; exhausted candidate swept
  without a claim or provider call; retry boundary honoured end to end; no secret/stack/claim
  token/cache key in a dead-lettered summary.
- `enrichmentRuntime.test.js` (**16**) — builds with no key and no network; binds the real policies;
  starts no timer; exact case-sensitive resolution; **never** falls back to mock; mock disablable;
  config from env; `describe()` leaks no key, prefix or length; logs nothing.
- `enrichmentExecutionService.test.js` (**12**) — one requested/completed pair; cancellation audit;
  pre-processing failure audit + rethrow; 12 jobs still produce 2 audit rows; per-job failure counted
  not audited as a failed batch; payload key set asserted exactly; no indicator/cache key/hash/error
  text in any audit row; `buildBatchAuditPayload` ignores unknown future fields; audit outage does not
  alter a completed job; SYSTEM vs explicit actor context; input validation writes nothing; at most one
  runner invocation and no timer.
- `enrichmentRunnerTypes.test.js` (**+3**) — `retryPolicy` required; new closed fields in the job-result
  key set; closed-vocabulary rejection for `failureClass`/`terminalReasonCode`; dead-letter and
  held-unknown-state counts derived separately.

**8 real-PostgreSQL tests** (`tests/integration/enrichmentRetryDeadLetter.test.js`, self-skips without
`TEST_DATABASE_URL`, dedicated marker `p2t2e1-mock` + IP range `198.20.0.x`, distinct from P2-T2b's
`p2t2b-mock`/`198.18.0.x` and P2-T2d's `p2t2d-mock`/`198.19.0.x`): (1) two workers on separate
pre-connected `PrismaClient`s racing for one job produce **exactly one** attempt increment and one
provider call, the loser incrementing nothing; (2) retry eligibility boundary — not listed before
`nextAttemptAt`, listed at it exactly, honoured end to end by the runner; (3) dead-letter requires the
correct claim token, clears terminal/active/lease fields, and the row is never listed again; (4) a
repeatedly failing provider costs at most `maxAttempts` calls across eight batches, ends `DEAD_LETTER`
with no exception text on the row, and is not called again 30 days later; (5) a rejected completion
payload writes no terminal provider fields, releases with a gate, then dead-letters at the budget;
(6) an unknown completion database error holds the lease — no release, no dead-letter, no other worker
can even list the row while the lease is live — and recovers on lease expiry; (7) cancellation after the
provider returned does not complete the job, releases it with a gate, refunds the attempt, and a later
worker completes it normally; (8) a forced audit-write failure leaves the completed batch and its row
fully intact.

**Test-isolation fix (test-only).** A runner batch is a *global* queue consumer by design, and vitest
runs integration files in parallel against one database — so an unscoped batch in the P2-T2d/P2-T2e-1
suites would claim, delay and (now) dead-letter the rows belonging to `iocEnrichmentQueue.test.js`.
Both runner suites now pass the worker a thin delegate whose candidate **listing** is filtered to that
suite's own marker. Only the listing is scoped: the claim, completion, release and dead-letter
statements are the real, unscoped ones, so every concurrency guarantee under test is still the
production one. This was latent under P2-T2d (a release restored the row invisibly); the retry gate and
dead-letter made it visible.

### Verification

- All P2-T2a → P2-T2e-1 targeted unit suites together: **389/389 PASS**.
- Ownership regression (`findingOwnershipService`, `ownershipResolver`, `assetMappingService`, `roles`,
  `reportIngestionService`): **147/147 PASS**, unchanged — this packet touches no ownership code.
- Full backend suite, real databases configured: **1351/1351 PASS** (60 files), including all real-PostgreSQL
  suites (dedup + ingestion + phase1Gate + ownership + enrichment queue + enrichment runner + enrichment
  retry/dead-letter). No flake observed on this run — including the previously noted `cleanupUpload`
  timing flake, which is unrelated to this diff and not touched by it.
- Phase 1 evaluator: `npm run eval:phase1` — **9/9 PASS**, unchanged.
- `npx prisma validate` clean · `prisma migrate status` reports **12 migrations, up to date** on both
  `threatnexus_test` and `threatnexus_eval` · exactly **one** new migration · no raw SQL anywhere in
  `src/` or `tests/` · no real network access in any test · `git diff --check` clean (only benign
  CRLF-normalization notices).
- Note: the full suite requires `DATABASE_URL`/`JWT_SECRET`/`CORS_ORIGIN` to be set, because
  `reportIngestionService` imports `config/env.js`. Without them two `ownershipConcurrency` tests fail
  with `ConfigError` — a known environment gotcha, not a defect, and unrelated to this packet.

### Still no ingestion or API reachability (deliberately, this packet stops here)

`executeEnrichmentBatch` exists and is production-composable, but **nothing calls it**: no
report-ingestion code path schedules enrichment work or invokes a batch, no route exposes a manual
trigger or reads enrichment data, no capability/RBAC guard exists for anything enrichment-related, and
there is no daemon, cron process or worker loop anywhere in the repository. Those are **P2-T2e-2** —
schedule enrichment after ingestion, and add enrichment read/manual-trigger APIs with RBAC.

## Completed — P2-T2e-2 (ingestion scheduling, safe reads, manual/forced scheduling, administrator
batch execution, RBAC, audits)

Branch `feat/phase-2-enrichment-risk`. Closes the reachability gap P2-T2e-1 deliberately left open: the
durable queue, AbuseIPDB provider, TTL/retry policy, bounded runner, production runtime and audited
execution service all existed but nothing outside a unit test could reach them. This packet makes the
whole IOC enrichment workflow reachable end to end — `report ingestion → durable enrichment scheduling
→ analyst-safe enrichment reads → analyst manual scheduling/re-enrichment → administrator bounded batch
execution` — while touching **zero schema/migration** (12 migrations, unchanged; `schema.prisma`
byte-identical) and calling **no external provider anywhere in ingestion or scheduling**.

**Part 1 — Ingestion scheduling (`reportIngestionService.js`).** After each Finding group's
`recordFindingObservation`/`resolveOwnershipSafely` calls (both already committed/isolated), a new
`scheduleEnrichmentSafely` call schedules durable enrichment through the existing
`enrichmentQueueService.scheduleEnrichment` — once per distinct Finding group, never once per
duplicate CSV row, since it runs from the same per-group loop iteration ownership resolution already
uses. Provider is the fixed, non-configurable `"abuseipdb"`; `queryParams` carries only the normalized
`{maxAgeInDays: env.ABUSEIPDB_MAX_AGE_DAYS}` (the same default the batch runner's own provider uses, so
an ingestion-scheduled job and a later manually-scheduled job for the same indicator share one cache
identity rather than fragmenting it); `asOf` is one explicit `new Date()` captured once per ingestion
attempt (never a per-row `observedAt`, never read again inside any queue/cache decision function — those
still take only explicit `asOf`/`now`, unchanged). No provider call, no HTTP request, no runner
execution, and no `ABUSEIPDB_API_KEY` requirement anywhere in this path — `scheduleEnrichment` is a
database-only decision.

**Failure isolation mirrors `resolveOwnershipSafely` exactly.** `scheduleEnrichmentSafely` catches every
failure (a validation error classified as `UNSUPPORTED`, anything else as `FAILED`) and never rethrows —
ingestion continues regardless, exactly like ownership resolution. Verified structurally (a genuinely
broken `iocEnrichment.create` cannot roll back `RawReport`/`RawReportRow`/`Finding`/`FindingOccurrence`,
cannot convert a valid row to `INVALID`, and cannot mark the report `FAILED`) and by real-PostgreSQL
test (scenario 3 below).

**Ingestion audit — one bounded aggregate event per processed report, never one per Finding.**
`enrichment.ingestion.schedule.completed` (or `.failed` if summarizing the already-collected counts
itself misbehaves, a defensive branch distinct from any per-group failure) carries exactly
`{rawReportId via entityId, distinctFindingCount, scheduledCount, cacheHitCount, alreadyPendingCount,
unsupportedCount, failedCount, provider}` — never an indicator, cache key, claim token or raw exception
text. Emitted only in the success tail (a `DUPLICATE_COMPLETED`/`DUPLICATE_IN_PROGRESS` short-circuit
never reaches this code, matching the existing "report.ingestion.started" convention).

**Part 2 — Safe Finding-scoped read service (`findingEnrichmentReadService.js`, new).** Because
`IocEnrichment` is deliberately indicator-level with no `findingId` FK (D-007), this module loads the
Finding, takes its own canonical `indicatorValue`, and queries `IocEnrichment` by
`(provider, indicatorType, indicator)` only — never inventing a relational link. Three loaders:
`loadCurrent` (newest **fresh** terminal row — mirrors `findFreshCachedResult`'s half-open-window rule
but is broader than one exact cacheKey, since a read should surface the freshest evidence regardless of
which `queryParams` variant produced it), `loadActiveJob` (newest PENDING row, if any), `loadHistory`
(bounded, paginated, every non-PENDING row — which includes `DEAD_LETTER`, ordered by `requestedAt`
since dead-lettered rows never carry `queriedAt`). `serializeEnrichmentRecord` is the **one** allow-list
every row crosses before reaching an HTTP response — `cacheKey`, `queryParamsHash`, `activeCacheKey`,
`claimToken`, `claimedAt`, `leaseExpiresAt` and any provider payload are never even read off the row, so
a future column addition cannot leak through by default. `DEAD_LETTER` can never become `current`
(`loadCurrent` selects only from `TERMINAL_STATUSES`, which structurally excludes it) — a dead-lettered
job is visible only inside `history`, tagged with its own status, never presented as a clean result.

**Part 3 — `GET /api/findings/:id/enrichments`.** Reuses `read:findings` (ADMIN/ANALYST/REVIEWER/VIEWER,
the existing Finding-read matrix — no new capability for reads). Query params: `provider` (default
`abuseipdb`), `page`, `pageSize` (capped at 100), `includeHistory` (default true, skips the paginated
history query entirely when false). Unknown Finding → 404; invalid id/query → 400; response follows the
existing `{success, data}` envelope. Mounted as its own router file
(`findingEnrichmentRoutes.js`, at `/api/findings`) rather than growing
`findingOwnershipRoutes.js` beyond its documented ownership-only scope.

**Part 4 — `POST /api/findings/:id/enrichment` — manual normal/forced scheduling
(`findingEnrichmentScheduleService.js`, new).** New capability `trigger:finding-enrichment` (ADMIN +
ANALYST; REVIEWER/VIEWER denied). Body: `provider` (default `abuseipdb`), `maxAgeInDays` (optional,
bounded positive integer, defaults to the same `env.ABUSEIPDB_MAX_AGE_DAYS` ingestion uses), `force`
(default false), `justification` (**required**, 1-1000 chars, when `force=true`; optional otherwise).
`force=false` is exactly `scheduleEnrichment` (`CACHE_HIT`/`ALREADY_PENDING`/`SCHEDULED`).
`force=true` calls a new sibling, `scheduleEnrichmentForced` — added to `enrichmentQueueService.js` by
extracting the shared read-decide-write loop (`scheduleEnrichmentCore`) both functions now call, so the
cache-key construction and P2002 recovery loop are never duplicated. Forced scheduling **bypasses the
fresh-cache short-circuit** but **never** bypasses active-job uniqueness — an existing active PENDING job
still returns `ALREADY_PENDING` under force, and a forced `SCHEDULED` outcome only ever **inserts** a new
row (a terminal/dead-letter row's `activeCacheKey` is already null, so it can never collide), preserving
every prior history row untouched by construction, not by a separate check. `maxAttempts` is
`DEFAULT_MAX_ATTEMPTS` from `iocEnrichmentCacheRules.js` — the same constant the production runtime
itself defaults to.

Audit actions `enrichment.manual.schedule.{requested,completed,failed}`. Unlike ingestion's
must-never-fail contract, a genuine scheduling failure here **is** audited as `.failed` and then
**re-thrown** — there is no unrelated upload to protect, and the caller needs to know. Payload allow-list:
`findingId, provider, force, outcome, enrichmentId, justification` (bounded 200-char preview, same
`boundedJustificationPreview` convention as `findingOwnershipService.js`) — never the indicator, cache
key, claim token or raw error text; actor attribution comes from the standard `auditContext` columns, not
duplicated into the payload.

**Part 5 — `POST /api/enrichment/batches/run` — administrator bounded batch execution
(`enrichmentBatchController.js`, new).** New capability `execute:enrichment-batch` (ADMIN only). Thin by
design: the entire decision already lives in `enrichmentExecutionService.executeEnrichmentBatch` /
`enrichmentRunner.runEnrichmentBatch`. The controller bounds `batchSize` (integer, 1..
`MAX_PENDING_BATCH_SIZE`, defaulting to the runtime's own default when omitted), captures `now` once,
and **generates** a `workerId` (`http-batch-<uuid>`) — the request body is never read for `workerId`,
`provider`, an API key, a claim token or a cache key. `executeEnrichmentBatch` already owns aggregate
batch auditing; the route creates no duplicate audit event. Response is an explicit allow-list of
aggregate counts (`requestedBatchSize, candidateCount, claimedCount, completedCount, releasedCount,
deadLetteredCount, heldUnknownStateCount, internalFailureCount, staleCompletionCount,
unknownProviderCount, skippedNotClaimedCount, cancelled, statusCounts`) plus a per-job list limited to
`{enrichmentId, provider, outcome, terminalStatus, queriedAt, expiresAt, failureClass,
terminalReasonCode, attemptCount, maxAttempts}` — **no indicator, workerId, claim token, cacheKey,
activeCacheKey, header or provider payload anywhere in the response.**

**Part 6/7 — Configuration and RBAC.** No changes to `enrichmentRuntime.js`/`env.js`: ingestion and
manual scheduling never build a runtime or resolve a provider at all (pure database decisions), so
neither needs an API key. Batch execution uses the existing production runtime unmodified — the real
AbuseIPDB provider from validated env, no MockProvider fallback, tests inject
`runtimeOverrides.providerRegistry` or rely on the real provider's own "no key → `SKIPPED_DISABLED`,
zero fetch" contract (P2-T2c). Two new capabilities added to `lib/roles.js`, additive and
non-hierarchical per the file's existing convention: `trigger:finding-enrichment` (ADMIN, ANALYST) and
`execute:enrichment-batch` (ADMIN only); enrichment reads reuse `read:findings` unchanged. Every guard is
server-side `requireCapability`, runs before the controller (proved by route tests), and the existing
`authorization.denied` audit path is untouched.

### Verification

- **Unit** (fake Prisma clients, no DB): 9 new ingestion-scheduling tests in
  `reportIngestionService.test.js` (one-job-per-group, two-distinct-Findings, `CACHE_HIT`,
  `ALREADY_PENDING`, swallowed failure, idempotent duplicate upload, exact aggregate audit fields, no
  secret leakage, audit-failure isolation); 13 in `findingEnrichmentReadService.test.js` (not-found,
  invalid id, no-result vs SUCCESS-score-0 vs fresh-FAILED/RATE_LIMITED, active job separate from
  current, `DEAD_LETTER` never `current` but visible in history, deterministic pagination/ordering,
  `includeHistory=false`, full serializer allow-list, canonical indicator sourced from the Finding);
  10 in `findingEnrichmentScheduleService.test.js` (normal `CACHE_HIT`/`ALREADY_PENDING`/`SCHEDULED`,
  not-found, forced justification requirement, forced cache bypass preserving history, forced
  active-job uniqueness, requested/completed audit with bounded justification and no secrets,
  audited-and-rethrown failure, broken-audit-sink isolation).
- **Route/RBAC** (`enrichmentRouteAuthorization.test.js`, 21 tests, real routes/middleware/controllers
  against a stubbed Prisma): read route across all 4 roles + 401/404 + no-secret-leak; manual-schedule
  route ADMIN/ANALYST allowed, REVIEWER/VIEWER denied (403, nothing scheduled, `authorization.denied`
  audited), 401 unauthenticated, `force=true` without justification → 400, a denied caller's forced
  request never reaches the service; batch route ADMIN allowed (zero-candidate real execution, no
  workerId/cacheKey/claimToken leak), ANALYST/REVIEWER/VIEWER denied with no `enrichment.batch.requested`
  audit, 401 unauthenticated, batch-size upper-bound rejected before execution, a caller-supplied
  `workerId` is silently ignored.
- **Real PostgreSQL** (`enrichmentWorkflowConcurrency.test.js`, self-skips without `TEST_DATABASE_URL`,
  dedicated `198.21.0-2.x` range distinct from every other suite's marker/IP convention, separate
  pre-connected `PrismaClient`s for genuine concurrency, scoped batch listing by indicator prefix — the
  same isolation technique P2-T2e-1's suites use by provider marker, adapted here because ingestion and
  manual scheduling always use the real `"abuseipdb"` name, never a test marker): **10/10 scenarios**
  covering (1) one report with duplicate rows → exactly one active job, correct evidence/lifecycle;
  (2) a second report on the same Finding → no second active job; (3) an injected scheduling failure
  rolls back nothing; (4) concurrent normal scheduling → exactly one active PENDING row; (5) concurrent
  forced scheduling against an existing fresh terminal result → exactly one new active row, prior
  terminal row unchanged; (6) forced recovery of a dead-lettered indicator → history preserved, one new
  active attempt, no resurrection without the manual call; (7) batch claims and completes a scheduled
  job, execution audit carries aggregates only; (8) a missing API key yields `SKIPPED_DISABLED` with
  zero `fetch` calls (asserted via a throwing `global.fetch` stub), correctly readable as `current`
  (never confused with a clean score) through the Finding enrichment service; (9) a forced
  `auditLog.create` failure does not prevent manual scheduling or batch completion from persisting;
  (10) a fully idempotent duplicate report upload creates no new enrichment row and exactly one
  aggregate audit (for the original report, none for the duplicate). Stable across 3 repeated runs.
- All P2-T2a → P2-T2e-2 enrichment real-PostgreSQL suites together (queue, runner, retry/dead-letter,
  workflow, route authorization): **81/81 PASS**.
- Full backend suite, real databases configured: **1417/1417 PASS** (64 files); **1350/1417 PASS, 67
  skipped** with no database (bare checkout stays green). `roles.test.js` extended for the two new
  capabilities (capability count 10+2 → 10+2+2; new ANALYST/ADMIN grant-matrix assertions).
- Phase 1 evaluator: `npm run eval:phase1` — **9/9 PASS**, unchanged.
- `npx prisma validate` clean · **12 migrations, unchanged** · `schema.prisma` **byte-identical** (no
  diff) · no raw SQL anywhere in `src/`/`tests/` · no real network access in any test (the one place a
  real network call could occur — the missing-key batch scenario — is asserted via a throwing `fetch`
  stub, proving zero calls) · `git diff --check` clean (only a benign CRLF-normalization notice, the
  same pre-existing repo convention every other file already has).

### Accepted side effect (not a defect)

Because ingestion now unconditionally schedules `abuseipdb` enrichment work for every Finding group it
processes, older Phase-1-era real-PostgreSQL suites that ingest reports (e.g.
`reportIngestionConcurrency.test.js`) will now also leave a small number of `PENDING` `IocEnrichment`
rows in the test database — those suites predate enrichment and have no reason to clean up a table they
don't know about. This is harmless (no assertion anywhere depends on `IocEnrichment` row counts outside
this packet's own suite, and a stray `PENDING` row is inert until something claims it) and does not
affect any test outcome; flagged here rather than silently left for a future session to rediscover.

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

**Everything above this line is now historical.** P2-T2d, P2-T2e-1/2, P2-T3 and
§2B Packets A/B/C all landed, and the Phase 2 closing packet has since completed
ownership re-resolution, database candidate pushdown, safe sector exposure,
consistency detection and the combined integration gate.

**PHASE 2 IS COMPLETE AND COMBINED-GATE VERIFIED** — see "Phase 2 COMPLETE AND
COMBINED-GATE VERIFIED" near the top of this file for the full record, the
verification matrix and the accepted limitations.

**PHASE 3 IS COMPLETE** — see "Phase 3 COMPLETE — defensible analyst workflow"
near the top of this file for the full record, the verification matrix and the
accepted limitations. Finding triage, organization-bound cases, `CaseFinding`
evidence linkage, the case lifecycle, organization-response tracking,
reviewer-approved closure and recurrence-driven reopening are all implemented,
audited, tested against real PostgreSQL, gated by `eval:phase3`, and reachable
through functional frontend screens.

**Exact next task: Phase 4 — notification drafting, analyst approval/edit/reject,
manual export, and delivery/response tracking integration.**

    draft notification
      → analyst approval / edit / reject
        → manual export
          → delivery and response tracking

The `Notification` model is untouched by Phase 3 and still carries its Phase 0
shape. Carry every existing invariant in unchanged:

- **The export endpoint must refuse any notification whose status is not
  `Approved` or whose `approved_by` is null.** That is the single hardest
  requirement in the phase and the one a reviewer will check first.
- **There is no SMTP or webhook client at all, not even a disabled one.**
  Automatic notification sending is explicitly out of scope; export is manual.
- **AI stays off by default (`AI_ENABLED=false`) and cannot approve, send, score,
  close, resolve or finalize anything.** It may draft and suggest only, and every
  core workflow must complete correctly with AI off.
- Audit every write path in the same change, keep backend capabilities the sole
  authorization boundary, and keep every response through an allow-list
  serializer.
- **Delivery and response tracking integrates with Phase 3's
  `CaseOrganizationResponse` timeline rather than duplicating it.** A response
  recorded against a notification and a response recorded against a case must not
  become two competing records of the same conversation.

Non-blocking carry-overs from the Phase 1 audit (none gate Phase 2): add a
`RawReport.rawContent` byte-preservation test; fix the `cleanupUpload`
`close`-race; bound/redact file-derived text in `AuditLog.reason`; harden the
`EVAL_DATABASE_URL` equality check.

---

# PHASE 6 — ANALYST FRONTEND, TRUTHFUL DASHBOARDS, DOCKER AND CI — **COMPLETE**

**Branch:** `feat/phase-6-frontend-demo-hardening` · **Base:** `main` at `c4babc5`
**Prisma migrations: 17 — UNCHANGED. Phase 6 added no migration.**
Risk v1 (`risk-additive-bucketed-v1` / `v1.0.0`) is numerically and semantically
untouched: no weight, band, bucket, cap, version, fingerprint or aggregation rule
was modified, and no new code path can influence a score.

## What Phase 6 changed, and why

### 1. The fabricated dashboard was removed

The committed dashboard presented as operational data: a hardcoded **"78% ATT&CK
coverage"**, six invented service latencies with an "all systems operational"
claim, a five-row **live threat feed** of made-up indicators, a seven-day
**threat trend** built from a literal array, **per-country attack percentages**,
a **world map** of hardcoded coordinates, fabricated "response readiness"
percentages, four invented case rows with invented analyst names, and fabricated
version strings. None of it came from the database.

Deleted outright: `components/dashboard/{ThreatMap,MitreWidget,StatsCards,
ThreatSeverityChart,ResponseReadiness,DashboardHeader}.jsx` and `pages/Threats.jsx`.

### 2. One truthful snapshot replaced it

`GET /api/dashboard/overview` (`read:dashboard`, read-only, bounded, N+1-free).
Every figure is `{ value, availability, source, asOf }`.

- `RESTRICTED` for a section the caller's role may not read — **never zero**.
  VIEWER holds `read:dashboard` but not `read:notifications`, so the notification
  section is restricted rather than counted.
- `UNAVAILABLE` for a section whose query threw, with the other sections intact
  and no exception text crossing the boundary.
- Provider status derives from configuration flags plus persisted rows only;
  `liveLookupPerformed: false` is asserted by test. No key, base URL or latency
  is ever serialized.
- Geographic data reports `UNAVAILABLE` with the exact required sentence.
- Framework counts carry the label *Analyst-associated framework context* and a
  disclaimer; no percentage of any catalogue is emitted.

### 3. Findings became reachable

`GET /api/findings` and `GET /api/findings/:id` (both `read:findings` — no new
capability). Bounded pagination that refuses rather than clamps; filters rejected
by field name; the indicator filter is an anchored prefix over `[0-9.]` only.
The enrichment serializer is an allowlist that deliberately excludes
`errorMessage`, `httpStatus`, `errorCode`, `claimToken`, `queryParams`.

### 4. Real defects found and fixed

| Defect | Effect | Fix |
|---|---|---|
| `user?.capabilities` read in 4 components | Capabilities are a **sibling** of `loggedInUser` in `GET /api/profile`, so this was always `undefined` — **every analyst write control was permanently hidden** (triage, case creation, framework mapping). Tests passed because their mocks supplied capabilities *both* ways. | Read from the `AuthContext` field; the redundant mock field removed so the regression cannot be masked again. |
| Backend suite inherited the developer's `.env` | With a real `.env` present, three `env.test.js` cases asserting a *missing* required variable stopped failing correctly, and live provider keys leaked into every test process. The suite only passed on a machine with no `.env`. | `TNX_SKIP_DOTENV`, set by `tests/setup.js`. Production and local dev unaffected. |
| ScrollTrigger reveals | **Six of fourteen dashboard sections stranded at `opacity: 0`** — verified in a real browser. A decorative effect could hide operational evidence. | Replaced with a mount-time reveal, not coupled to scroll position. |
| `gsap.from` + `kill()` under StrictMode | The double-mount left elements stranded at `opacity: 0`. | `gsap.fromTo` with an explicit end state and `revert()` cleanup. |
| `Analytics.jsx` hardcoded `http://localhost:5000/api/threats` | Bypassed the API client entirely: no `Authorization` header, ignored `VITE_API_BASE_URL`. | Rewritten against the same provenance-carrying overview snapshot. |
| Login printed a demo credential | `DEMO // ali@example.com / password123` rendered in the UI. | Removed. |
| Bundle shipped unminified | `minify: false` shipped a 2,091 kB single chunk. | Minification on, vendor chunking added: **~298 kB gzip** across cacheable chunks. |

### 5. Dependency posture

`chart.js`, `react-chartjs-2`, `leaflet`, `react-leaflet`, `recharts` and `terser`
removed (49 packages). `gsap` + `@gsap/react` added for the opening timeline.
`react-router-dom` pinned to **7.18.2**: production advisories went **15 → 1**,
and the survivor (RSC-mode CSRF, fix ≥ 8.3.0 unpublished) is unreachable in a
client-only SPA. A downgrade to 7.11.0 was tested and **rejected** — it trades one
unreachable advisory for fourteen reachable ones including open redirect via
`<Link>`/`useNavigate`.

## Verification

| Gate | Result |
|---|---|
| `prisma validate` | pass |
| Migration count | **17**, no pending, `Database schema is up to date` |
| Backend suite | **2717 passed / 177 skipped, 102 files** |
| Frontend suite | **130 passed / 9 files** (serial; `fileParallelism: false`) |
| Frontend lint | clean |
| Frontend production build | pass |
| New Phase 6 backend tests | 13 dashboard-integrity + 16 finding-read + 15 route/RBAC |
| `docker compose config` | valid; fails fast without `JWT_SECRET` |
| Live browser review | login, dashboard, sidebar, provenance, restricted sections |
| `npm run seed:demo` | idempotent; both self-approval prohibitions refused with real 403s |

## Honest gaps carried forward

- **Finding closure has no production write path.** Nothing in `src/` writes
  `Finding.status = CLOSED`. Recurrence and recurrence-driven case reopening are
  proven by the evaluators but cannot be reached through the running application.
  Phase 6 did not add one: that is locked lifecycle semantics.
- **No committed Playwright suite.** Critical flows were verified interactively
  in a real browser and through the API-driven demo seed.
- **The demo does not include a recurrence-reopened case**, for the reason above.
