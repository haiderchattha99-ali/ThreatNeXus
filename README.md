# ThreatNeXus

**Connecting Intelligence with Action**

A defensible CERT triage and constituent-notification workflow: ingest a
Shadowserver-style exposure report, deduplicate it into persistent findings,
attribute each one to a constituent organization, enrich and score it
deterministically, work it through an analyst case, notify the affected
organization with reviewer approval, and record what came back — with a
complete audit trail behind every step.

## What this is, and what it is not

ThreatNeXus is a **defensive cybersecurity research prototype developed during
an internship with PKCERT/NCERT**. It is **not an official PKCERT/NCERT
production platform**, and no national deployment is claimed or implied. It has
not been security-audited, has no high-availability or disaster-recovery story,
ships with local development defaults, and has never processed real constituent
data.

Three phrases in this document are load-bearing and are used literally:

- **Export is not delivery.** Exporting an approved notification produces a file
  on the analyst's machine. Whether it ever reached anyone is a separate,
  separately recorded human act.
- **A remediation proxy is not verified remediation.** When an organization
  replies that it has fixed something, the system records *that they said so*.
  It never confirms it.
- **Provider evidence is supporting context, never proof.** A reputation score
  or an EPSS percentile informs an analyst; it does not decide anything.

Every dashboard figure describes **the loaded dataset only** — never a national,
Internet-wide, uptime, maturity or coverage claim. Inputs are synthetic or
explicitly authorized.

Everything in it is designed so a human stays accountable for every decision
that leaves the system:

- **It never sends anything.** There is no SMTP client, no webhook client, and
  no outbound message transport anywhere in the repository — not even a
  disabled one. Approved notifications are *exported to a file* that a human
  sends by hand. The absence of the code is the guarantee.
- **It never remediates.** Nothing here changes a constituent's systems, opens
  a connection to them, or verifies a fix on its own.
- **It never scans.** Findings come from an uploaded report file. There is no
  scanner, no probe and no active reconnaissance of any kind.
- **AI decides nothing.** It is off by default, and when on it only drafts and
  suggests — see [AI assistance](#ai-assistance-optional-off-by-default).

## Current status: Phase 7 — release candidate

| Phase | Delivered |
|---|---|
| **0 — Foundation** | Config validation, audit logging, role/capability authorization on every protected route, hardened auth, upload cleanup, Vitest + Supertest, local PostgreSQL via Docker Compose. |
| **1 — Ingestion** | Accessible-RDP CSV upload → `RawReport` → `RawReportRow` → deduplicated `Finding` → `FindingOccurrence`. Dedup key `(indicator, port, protocol, reportType)`; persistence bumps an occurrence, recurrence reopens. Idempotent replay. |
| **2 — Attribution, enrichment, risk** | Ownership resolution (exact IP → longest-prefix CIDR → ASN) with analyst override; AbuseIPDB IOC reputation behind a provider abstraction with a durable cache/queue, retry and dead-letter; CISA KEV, FIRST EPSS and NVD vulnerability enrichment on analyst-asserted CVEs; deterministic, explainable **Risk v1** scoring. |
| **3 — Analyst workflow** | Triage, organization-bound cases, `CaseFinding` evidence links, organization responses, reviewer-approved closure with separation of duties, recurrence-driven reopening. |
| **4 — Notifications** | Drafting from case evidence, immutable revisions, reviewer approval bound to an exact revision, approved-only manual `.eml` / `.txt` export, delivery tracking. |
| **5 — Framework mapping + AI assistance** | Append-only MITRE ATT&CK / NIST CSF 2.0 / CIS Controls v8 mappings on cases, with a server-enforced ATT&CK evidence rule; optional AI mapping suggestions, disabled by default, promoted only by a named human through the manual mapping service. |

| **6 — Analyst frontend, truthful dashboards, Docker, CI** | A single design system and primitive set; a provenance-carrying dashboard snapshot where unknown is never rendered as zero; a Chromium browser suite against the real stack; pinned MITRE Enterprise ATT&CK 19.1 with a SHA-256 integrity manifest, verbatim evidence gates, explicit "no reference applies" determinations, and a navigator that reports raw counts and **no coverage percentage**. |
| **7 — Release candidate** | Request rate limiting on authentication, upload and provider execution; a structural route census requiring every mounted route to authenticate and enforce a capability; release security assertions; a runnable offline release evaluator; clean-stack and network-unavailable rehearsals. |

## Phase 6 — analyst frontend, truthful dashboards, Docker and CI

Phase 6 rebuilt the presentation layer and the operational scaffolding around it.

**A premium, consistent frontend.** A single design system (`frontend/src/theme/`)
now owns colour, typography, spacing, radii, elevation, status semantics and
breakpoints, and a set of primitives in `frontend/src/components/ui/` owns the
panels, metrics, tables, timelines, badges and every non-happy state. The visual
direction — *Modern Government CERT Operations*, IBM Plex Sans/Mono on a
near-black navy foundation with a restrained teal accent — was chosen at a design
checkpoint by rendering three complete candidates in a real browser and comparing
them, not by reading descriptions.

**A truthful dashboard.** This is the substantive change. The previous dashboard
was largely fabricated: a hardcoded "78% ATT&CK coverage", invented service
latencies, a live feed of made-up indicators, a seven-day trend built from a
literal array, per-country attack percentages and a world map of invented
coordinates. None of it came from the database. All of it is gone.

Every figure now comes from one bounded, read-only, capability-guarded snapshot
(`GET /api/dashboard/overview`) and arrives as a four-part tuple:

```
{ value, availability, source, asOf }
```

The rules that replaced the fabrication:

- **Unknown is never zero.** A figure that could not be computed renders an em
  dash and a reason. A section the caller's role may not read comes back
  `RESTRICTED` — a VIEWER sees "Not available to your role" where notification
  counts would be, never `0`.
- **Every metric names its source.** The caption under each tile is the actual
  table and column it was counted from.
- **No live provider call.** Rendering the dashboard contacts nothing. Provider
  status is derived from configuration flags plus rows earlier phases persisted,
  and exposes no key, no base URL, no latency and no "all systems operational".
- **No percentage without a denominator**, and the denominator is returned too.
- **No map.** No provenance-backed coordinate is persisted anywhere, so the page
  says *"Verified geographic observations are not currently available."*
- **Framework counts are labelled "Analyst-associated framework context"** and
  are never called coverage, compliance, maturity or posture.
- **Export and delivery are counted separately** and never summed.

**Findings became reachable.** Before Phase 6 a Finding could only be seen
through a case that already cited it, which made triage unreachable from the UI.
`GET /api/findings` and `GET /api/findings/:id` are new, bounded, read-only and
gated on the existing `read:findings` capability — no new authority was created.
The Finding detail screen renders the Risk v1 explanation from the stored factor
contributions, keeping `APPLIED` / `NOT_AVAILABLE` / `NOT_APPLICABLE` distinct.

**Accessibility and responsiveness.** Semantic landmarks and headings, a
skip-to-content link, visible focus rings on every interactive element, status
communicated by icon *and* words as well as colour, table headers, dense evidence
that scrolls horizontally rather than being dropped, screen-reader announcements
for loading and error states, and `prefers-reduced-motion` honoured in CSS, in
the MUI theme and in JavaScript (`hooks/useReducedMotion.js`).

**Motion, deliberately restrained.** A GSAP opening timeline on the login screen
(~1.7s, once per session, interruptible, never blocking the form) and a short
mount-time entrance for summary panels. Nothing animates behind an evidence
table, nothing hijacks scrolling, and the ambient pulse pauses when the tab is
hidden or the element leaves the viewport.

**Docker, CI and a demonstration dataset.** `docker compose up` now runs
PostgreSQL, the backend and the frontend, applying all 17 migrations from zero
and refusing to start without a `JWT_SECRET`. A GitHub Actions pipeline
(`.github/workflows/ci.yml`) checks for committed secrets and build output,
validates the Prisma schema, applies migrations to an empty database, asserts the
migration count and order, runs the backend suite against real PostgreSQL, lints,
tests and builds the frontend, scans the built bundle for secret-shaped
literals, and runs the core evaluators. `npm run seed:demo` builds a
deterministic dataset by driving the application's own REST API with real
per-role tokens, so no fixture can bypass a capability check or a workflow rule.

Phase 6 added **no** Prisma migration. The count is still 17.

## The workflow, end to end

```
Shadowserver-style CSV
        │
        ▼
  RawReport ─► RawReportRow ─► Finding ─► FindingOccurrence
                                  │        (persistence / recurrence)
                                  ├─► FindingOwnership      which constituent owns this?
                                  ├─► IocEnrichment         AbuseIPDB reputation
                                  ├─► FindingVulnerability  analyst-asserted CVEs
                                  │      └─► KEV / EPSS / NVD metadata
                                  └─► RiskScore             deterministic, explainable
                                  │
                                  ▼
                          FindingTriage   (analyst decision)
                                  │
                                  ▼
                      Case ◄── CaseFinding (evidence links)
                       │
                       ├─► CaseFrameworkMapping    ATT&CK / CSF / CIS context
                       │      └─► AiSuggestionRun ─► suggestion ─► human decision
                       │
                       ├─► Notification ─► revision ─► reviewer approval
                       │      └─► export (sent by hand) ─► delivery record
                       │
                       ├─► CaseOrganizationResponse
                       │
                       └─► closure request ─► reviewer approval ─► CLOSED
                                                     │
                                        recurrence ──┘ reopens
```

Every write on that path appends its own `AuditLog` event in the same change.

## Framework mapping is not compliance

Phase 5 supports three framework families: **MITRE ATT&CK**, **NIST
Cybersecurity Framework 2.0**, and **CIS Controls v8**.

An active mapping means exactly one thing: *a named analyst associated a named
framework reference with this case, on a stated evidence basis, and wrote down
why.* It does **not** mean the control is implemented, audited, assessed or
compliant, and it is not a compliance determination of any kind. The API
carries that disclaimer on every read path, and the UI renders the server's own
wording rather than re-phrasing it.

There is deliberately **no "percentage mapped" metric**, no coverage gauge and
no maturity score anywhere in the system. Counts are counts of mappings and are
labelled as such — a denominator would require knowing how many references
*should* apply, which nobody knows, and printing one creates pressure to force
weak mappings.

Reference identifiers and titles are **analyst-entered and format-checked
only**. This repository pins no local framework catalogue, so no reference is
verified to exist; `T9999` passes the shape check and does not exist. Every
read path says so rather than implying a validation that did not happen.
`frameworkVersion` is required and never assumed.

### The MITRE ATT&CK evidence rule

An ATT&CK mapping asserts that adversary behaviour occurred, so it is held to a
stricter standard than the other two families. Enforced server-side, it
requires:

- evidence basis `OBSERVED_BEHAVIOR` (structural),
- a rationale that reaches a substance floor (structural),
- evidence tied to the case or to a currently-linked finding (structural), and
- a rationale that actually describes behaviour rather than restating exposure
  (a documented, bounded lexical guard that fails closed).

An ATT&CK mapping resting **only** on an exposed service, an open port, a CVE,
KEV membership, an EPSS score, an AbuseIPDB reputation result, the
organization's sector or the risk score is **refused**. A CVE may support an
investigation; it is not evidence that an adversary did anything.

NIST CSF and CIS Controls mappings may record a control gap or remediation
alignment. They assert analyst-associated context — never implementation, audit
status or compliance.

## AI assistance (optional, off by default)

`AI_ENABLED` defaults to `false`, and that is the shipped configuration. With it
off:

- the application starts normally and **no API key is required to start**,
- no external call is made and no provider is invoked at all,
- no timer, worker or background job exists,
- a suggestion request returns a controlled `DISABLED` result with a recorded
  run explaining why, and no suggestion row is fabricated,
- the UI says "AI assistance is disabled",
- **every workflow in Phases 0–5 completes normally.**

**No live AI provider ships in this milestone.** The repository contains a
provider *contract*, a disabled production provider, and a deterministic
offline mock used only by tests and the evaluator. The mock is reachable only
behind an explicit test opt-in; there is no configuration value that makes
production silently fall back to it.

When assistance is enabled, what it can do is bounded by what it is handed. A
provider gets one method, taking a **bounded, allow-listed case snapshot** and
returning data — no database client, no transaction, no repository, no user, no
capability and no logger. It therefore cannot:

> alter a risk score or its contributions · choose a risk band · approve its own
> suggestion · create an ownership mapping · attach a CVE · close, reopen or
> resolve a case · approve a closure · create, approve, export or deliver a
> notification · record an organization response · send email · run enrichment ·
> scan anything · create an active framework mapping

That prohibition is structural rather than a rule somebody remembered to write,
and a dedicated test suite drives a deliberately hostile provider end to end and
counts every table it must not touch.

The snapshot sent to a provider carries the case reference and title, lifecycle
state, coarse organization sector, and per linked finding: report type, triage
decision, the deterministic Risk v1 band with its stored explanation, and
analyst-asserted CVE ids. It **never** carries indicator values, ports, the
organization's name or contacts, notification bodies, audit rows, credentials,
internal fingerprints or raw database rows.

Provider output is treated as untrusted input: unknown fields are rejected
rather than dropped, every candidate must clear the same rules a hand-written
mapping clears, and failures are discarded and counted — never repaired. A
suggestion is **inert** until a named human approves it, and approval reloads
the case, recomputes the evidence fingerprint, **refuses a stale suggestion**,
re-validates, and promotes through the same service the analyst form uses,
recording the human as the mapping's actor.

## Roles and RBAC

Authorization is **capability-based and deliberately non-hierarchical** — no
role inherits another's authority. The backend middleware is the only boundary;
the frontend's capability checks are UX convenience and are re-checked on every
request regardless.

| | ADMIN | ANALYST | REVIEWER | VIEWER |
|---|---|---|---|---|
| Read dashboard, findings, cases | ✅ | ✅ | ✅ | ✅ |
| Upload reports, triage findings | ✅ | ✅ | — | — |
| Manage cases, link evidence, record responses | ✅ | ✅ | — | — |
| Override ownership, trigger enrichment, recalculate risk | ✅ | ✅ | — | — |
| Assert / retract CVE associations | ✅ | ✅ | — | — |
| Approve or reject a case closure | ✅ | — | ✅ | — |
| Draft, edit, submit, export notifications; record delivery | ✅ | ✅ | — | — |
| Approve or reject a notification | ✅ | — | ✅ | — |
| Create, remove, reactivate framework mappings | ✅ | ✅ | — | — |
| Read AI suggestion history | ✅ | ✅ | ✅ | — |
| Request AI suggestions; approve or reject them | ✅ | ✅ | — | — |
| Run batch enrichment workers; manage users and system | ✅ | — | — | — |

Two separations of duties are structural: the analyst who requests a closure can
never approve one, and the analyst who writes a notification can never approve
it. A third invariant is enforced in Phase 5 — approving an AI suggestion
creates a mapping, so **approval authority never exceeds the authority to write
that same mapping by hand**.

## Architecture and stack

- **Backend:** Node.js, Express 5
- **Database:** PostgreSQL 16 via Prisma (17 migrations, all additive)
- **Frontend:** React 19, Vite, MUI
- **Tests:** Vitest + Supertest (backend), Vitest + Testing Library (frontend),
  oxlint
- **Local database:** Docker Compose (PostgreSQL only)

The submitted proposal sketched a FastAPI/SQLAlchemy backend. That was
superseded early (see `../ThreatNeXus-Planning/planning/DECISIONS.md`, D-001):
this repository preserves and refactors the existing Node/Express/Prisma
codebase rather than rewriting it in Python.

Recurring design patterns worth knowing before reading the code:

- **Append-only history with a current-row pointer.** Triage decisions, case
  links, ownership, risk scores, CVE associations, notification revisions and
  framework mappings all supersede rather than update, using a nullable
  `@unique` column (PostgreSQL treats multiple NULLs as distinct) — no raw SQL
  and no partial indexes.
- **Closed vocabularies everywhere.** Reason codes, outcome codes and rejection
  codes are enumerated constants, never free text and never an exception
  message.
- **Construct-only serializers.** Every API response is built from named fields
  rather than by deleting keys from a database row, so a future migration cannot
  silently start leaking a column.
- **Provider abstractions with offline mocks.** Automated tests never consume a
  live third-party quota and never make a real network call.

## Local setup

### 1. Start PostgreSQL

```bash
docker compose up -d
```

### 2. Create the disposable test and evaluation databases

The dev database is created by Compose. The other two are separate on purpose —
the evaluators refuse to run against the development database.

```bash
# Addressed by SERVICE name, not container name — Compose derives container
# names from the project, and a leftover container from an earlier session must
# not be able to collide with this one.
docker compose exec postgres psql -U threatnexus -d threatnexus \
  -c "CREATE DATABASE threatnexus_test;"
docker compose exec postgres psql -U threatnexus -d threatnexus \
  -c "CREATE DATABASE threatnexus_eval;"
```

### 3. Configure the backend

```bash
cd backend
cp .env.example .env      # then edit: JWT_SECRET must be your own, 32+ chars
npm install
```

`AI_ENABLED=false` and `AI_PROVIDER=null` are the shipped defaults in
`.env.example`. No AI key is read anywhere, and none is required to start.

### 4. Apply migrations to all three databases

```bash
npx prisma migrate deploy                                   # dev database, from .env
DATABASE_URL="postgresql://threatnexus:threatnexus_local_dev_only@localhost:5432/threatnexus_test" \
  npx prisma migrate deploy
DATABASE_URL="postgresql://threatnexus:threatnexus_local_dev_only@localhost:5432/threatnexus_eval" \
  npx prisma migrate deploy
```

`migrate deploy` only applies migrations already committed to
`backend/prisma/migrations/` — it never generates one.

### 5. Seed the four local demo users

`SEED_USER_PASSWORD` is read only by the script, never by the running
application. Pass it as a one-off shell variable; never commit it.

```bash
SEED_USER_PASSWORD='<a-strong-local-only-password>' npm run seed:users
```

### 6. Run

```bash
cd backend  && npm run dev                    # http://localhost:5000
cd frontend && npm install && npm run dev     # http://localhost:5173
```

## Tests

```bash
cd backend
npm test                                      # unit suites; real-DB suites self-skip

# With the disposable test database. Real-PostgreSQL suites share one database,
# so they MUST run sequentially — in parallel they claim each other's queued
# jobs and fail in a way that reads like flakiness.
TEST_DATABASE_URL="postgresql://threatnexus:threatnexus_local_dev_only@localhost:5432/threatnexus_test" \
  npx vitest run --no-file-parallelism
```

Do **not** export `JWT_SECRET` when running the backend suite: several HTTP
suites sign their own tokens with a module-scoped secret and only self-default
it, so an exported value makes every request 401 in a way that looks exactly
like an authorization regression.

```bash
cd frontend
npm test
npm run lint
npm run build
```

## Evaluators

Each gate drives the **real production services** end to end against a
disposable database, and compares every result against expectations written out
by hand in the gate file. All of them refuse to run without an explicit
`EVAL_DATABASE_URL`, and refuse to run if it equals `DATABASE_URL`.

```bash
cd backend
export EVAL_DATABASE_URL="postgresql://threatnexus:threatnexus_local_dev_only@localhost:5432/threatnexus_eval"

npm run eval:phase1                 # ingestion, dedup, persistence, recurrence
npm run eval:risk                   # the locked Risk v1 numeric contract
npm run eval:phase2                 # ownership + IOC enrichment
npm run eval:phase2:mutation        # proves the ownership gate can actually fail
npm run eval:vulnerability          # KEV / EPSS / NVD
npm run eval:vulnerability:mutation # proves the vulnerability gate can actually fail
npm run eval:phase3                 # analyst workflow to closure and reopening
npm run eval:phase4                 # notification drafting to delivery
npm run eval:phase5                 # framework mapping + guarded AI assistance
npm run eval:phase6.3               # pinned ATT&CK catalogue + evidence integrity
npm run eval:phase7                 # no-key startup, offline operation, AI off
```

The two `:mutation` gates deliberately break a rule and assert that a named
scenario notices — a gate nobody has proven can fail is not a gate.

`eval:phase7` replaces `global.fetch` with a counter that throws for the whole
run and asserts the count is zero, so it cannot consume live provider quota even
if a key is present in the environment. It also reports the gold-standard
labelling dependency, which is a human deliverable and is never synthesized.

### Verifying a release candidate

The full sequence a release decision rests on, in the order a reviewer would
want it. Every value below is disposable and belongs to a throwaway database.

```bash
# 0. Disposable PostgreSQL, and two databases that are NOT each other.
docker run -d --name tnx-verify -e POSTGRES_USER=tnx -e POSTGRES_PASSWORD=disposable_only \
  -e POSTGRES_DB=tnx -p 5434:5432 postgres:16-alpine
docker exec tnx-verify psql -U tnx -d postgres -c "CREATE DATABASE tnx_eval;"

export DATABASE_URL="postgresql://tnx:disposable_only@localhost:5434/tnx?schema=public"
export TEST_DATABASE_URL="$DATABASE_URL"
export EVAL_DATABASE_URL="postgresql://tnx:disposable_only@localhost:5434/tnx_eval?schema=public"
export JWT_SECRET="verification-only-secret-value-at-least-32-chars"
export CORS_ORIGIN="http://localhost:5173"
export IOC_ENRICHMENT_PROVIDER=mock ABUSEIPDB_API_KEY='' NVD_API_KEY='' \
       AI_ENABLED=false AI_PROVIDER=null NODE_ENV=test

# 1. Migrations from zero, schema validity, and drift.
cd backend
npx prisma migrate deploy      # expect 18 migrations applied
npx prisma validate
npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma \
  --to-schema-datasource prisma/schema.prisma --exit-code   # expect "No difference"

# 2. Regenerate the client. Skipping this is the single most common cause of a
#    false failure: a client generated before the last migration reports a new
#    model as `undefined`, which looks like a code defect and is not one.
npx prisma generate

# 3. The pinned ATT&CK catalogue still matches its recorded checksum.
npm run attack:verify

# 4. The backend suite against real PostgreSQL. TEST_DATABASE_URL is what
#    enables the real-PostgreSQL suites — without it ~177 of them SKIP, and the
#    run looks green while proving considerably less. Serial file execution is
#    required: in parallel the concurrency suites claim each other's queued jobs.
npx vitest run --fileParallelism=false

# 5. Every evaluator (see the list above).
# 6. Frontend.
cd ../frontend && npm run lint && npm test && npm run build
```


The synthetic fixtures in `data/synthetic/` are **development and evaluation
data only**: RFC 5737 documentation IP ranges, deterministic hand-chosen
timestamps, and no real organization or Shadowserver data. See
`data/synthetic/README.md`. `accessible-rdp.synthetic.v1` is not an official
Shadowserver schema.

## External providers

| Provider | Used for | Key required | Notes |
|---|---|---|---|
| **AbuseIPDB** | IPv4 reputation enrichment | Optional (`ABUSEIPDB_API_KEY`) | Without a key the provider returns `SKIPPED_DISABLED`; ingestion is never blocked. |
| **CISA KEV** | Known-exploited status for analyst-asserted CVEs | No | Public catalogue. |
| **FIRST EPSS** | Exploit-prediction score | No | Public API. |
| **NVD** | CVE metadata | Optional (`NVD_API_KEY`) | Public rate limit applies without a key. |
| **AI mapping assistance** | Framework mapping suggestions | **No live provider ships** | Disabled by default; offline mock for tests only. |

> **NVD attribution.** This product uses the NVD API but is not endorsed or
> certified by the NVD.

Enrichment failure **never blocks ingestion** — the finding is still created and
the enrichment row records `FAILED` or `RATE_LIMITED`. API keys are read from
environment variables only, and never appear in a log line, an error response,
an audit record or a database column.

Provider status (configured/not-configured, freshness — never a live check) is visible at
`GET /api/dashboard/overview` → `sections.providers` and in the Settings screen, gated on
`read:dashboard`. See `docs/ai/SECURITY.md` → "Provider foundation" for the full contract. A manual,
opt-in NVD live-smoke command exists for local verification and never runs in CI:

```
LIVE_NVD_SMOKE=1 npm run smoke:nvd --prefix backend
```

## Known limitations

- **Single report type.** Only Shadowserver-style *Accessible RDP* is ingested.
- **Manual ingestion only.** No scheduled or live Shadowserver API pull; a human
  uploads a CSV.
- **No live AI provider.** The contract, the disabled provider and an offline
  mock exist; nothing calls a model.
- **Finding closure has no production write path.** The recurrence and reopen
  behaviour is real and is proven by `eval:phase1`, but it cannot be reached
  through the running UI, so a demonstration cannot show it end to end. It is
  listed here rather than staged in the interface, because seeding an
  unreachable final state to make a demo look complete would be a fabrication.
- **Chromium is the committed browser gate.** Firefox and WebKit are not run and
  are not claimed.
- **Only NIST CSF 2.0 and CIS ids are format-checked.** ATT&CK is fully
  catalogue-verified against the pinned Enterprise 19.1 extract; the other two
  frameworks are validated for shape, not existence.
- **The ATT&CK lexical guard is a backstop, not comprehension.** It reliably
  catches the common "port 3389 is open, therefore T1021.001" mistake. It cannot
  detect a fluent, well-worded fabrication — which is why the structural gates
  exist and why every mapping records a named human actor.
- **ASN-tier ownership cannot be re-resolved later.** ASN is not persisted on a
  finding, so that tier only fires at ingestion time.
- **No production deployment story.** The Docker Compose stack is for a
  developer's machine or a demonstration, not a deployment: no production image,
  no HA/DR, no secret manager, no external security audit. There *is* a CI
  pipeline (`.github/workflows/ci.yml`).
- **Rate limiting is in-process.** The limiter counts per Node process. It is
  the right control for a single-process prototype and the wrong one for a
  horizontally scaled deployment, which would need a shared store.
- **Synthetic data only.** No real constituent or victim data has ever been
  processed, and none may be committed.

## Roadmap

Phases 0–7 are delivered. What remains is deliberately *not* in this release:

- **A production write path for Finding closure**, so recurrence and reopening
  become reachable through the interface rather than only through the evaluator.
- **A second report type** carried all the way to closure.
- **Catalogue verification for NIST CSF and CIS**, matching what ATT&CK already
  has.
- **A live AI provider** behind the existing contract — if and only if it is
  approved in the decision record first.
- **The gold-standard answer key.** `eval/lib/goldStandardLoader.js` defines the
  schema and computes accept/edit/reject rates and inter-rater agreement, but the
  labels themselves are an outstanding *human* deliverable: two named team members
  labelling 50–100 findings independently. It must not be AI-generated, so the
  harness reports its absence as a dependency rather than producing a number.

## Team

| | |
|---|---|
| **M. Ismail** | Threat Intelligence and System Coordination |
| **Ali Haider** | Software Engineering and Backend Systems |
| **Aun Zulfiqar** | Frontend and UX |
| **Eshaal Khan** | Security Workflow and QA |

## Responsible use

ThreatNeXus is a **defensive** tool for a CERT acting on behalf of its
constituents. It ingests reports about exposures, helps an analyst decide what
to do about them, and helps them tell the affected organization.

It contains no offensive capability: no scanner, no exploit, no payload, no
credential testing, no active reconnaissance, and no transport that can reach a
third party's systems. It cannot send a message on its own, cannot change
anything outside its own database, and cannot make any decision that leaves the
system without a named human recorded against it.

Handle any data placed in it as you would handle real incident data. Only
synthetic or sample data belongs in this repository, and no secrets or real
victim data may ever be committed.

Planning documents, the phased build plan and the decision record live in the
sibling folder `../ThreatNeXus-Planning/`, which is read-only from here.

## Docker cleanup

```bash
docker compose down       # stop and remove the postgres container, keep data
docker compose down -v    # ALSO deletes the named volume — every local row is gone
```
