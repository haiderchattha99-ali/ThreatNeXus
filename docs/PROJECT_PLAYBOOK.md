# Project Playbook

The single document a new reviewer, teammate, or successor should read to understand ThreatNeXus end to
end. Everything here is grounded in what is actually built and tested — where a claim would go beyond
that, this document says so explicitly instead of implying more than exists.

## Identity and purpose

ThreatNeXus is a defensive cyber-threat-intelligence orchestration and incident-response **research
prototype**, built during an internship with PKCERT/NCERT. It has never been deployed and has never held
real constituent data. It is not an official PKCERT platform, not a national deployment, and not
certified, endorsed, or production-approved by PKCERT/NCERT.

**The problem it addresses**: a national CERT receives recurring third-party exposure reports
(Shadowserver-style) as flat files. Handled by hand, the same exposure gets re-reported, re-triaged, and
re-notified without anyone being able to say whether it was ever fixed, whether it came back, or which
constituent owns it.

**The value it delivers**: deduplicated, persistent findings with recurrence detection; a deterministic
and explainable risk score; an auditable case workflow with independent review; and constituent
notifications a human approves before anything leaves the building.

## What ThreatNeXus is — and is not

| Is | Is not |
|---|---|
| A defensive analyst workflow tool | An offensive scanning or reconnaissance tool |
| A file-upload ingestion pipeline for Shadowserver-style reports | A live, scheduled threat-feed subscriber |
| A deterministic, explainable risk-scoring engine | An AI-decided or opaque scoring system |
| An analyst-facing case and notification workflow with human approval gates | An automatic notification-sending system (no SMTP/webhook client exists anywhere in this codebase) |
| A system where AI is optional, off by default, and structurally unable to decide anything final | An "AI SOC analyst" or autonomous triage system |
| A research prototype, honestly labeled at every level (login page, dashboard, demo runbook) | A certified, endorsed, or production-deployed PKCERT system |

## Scope

**In scope, built and working**: one report type (Accessible RDP exposure) carried to closure; AbuseIPDB
as the first real IOC reputation provider, plus five more live providers added since (NVD/KEV/EPSS,
Censys, GreyNoise, Shodan, Netlas); manual framework mapping (ATT&CK/NIST CSF/CIS) before any AI
assistance; two independent, disabled-by-default AI assistance surfaces.

**Explicitly out of scope**: live scheduled Shadowserver ingestion; automatic notification sending;
automatic remediation verification; SIEM/EDR integration; threat-actor attribution; automatic compliance
assessment; a production deployment target.

## Team and role model (in-application roles)

Four roles, capability-based, deliberately not ranked as a hierarchy — see `docs/ADMIN_GUIDE.md` for the
full matrix:

- **ADMIN** — every capability, including the two self-approval override grants and system/user
  management.
- **ANALYST** — does the work: ingests, triages, builds cases, drafts notifications, requests provider
  enrichment and AI assistance.
- **REVIEWER** — approves the work: case closures, notification content, AI mapping-suggestion history,
  Finding-level AI drafts. Cannot do any of the ANALYST work.
- **VIEWER** — read-only oversight, deliberately excluded from notification visibility (constituent
  correspondence is narrower than the general threat feed).

**This document's own production team model** (the AI-assisted development workflow used to build this
codebase — ChatGPT plans, Gemini researches, Claude implements, Codex reviews, DeepSeek performs
security/logic review, Manus performs browser QA) is a separate concern from the in-application roles
above, recorded in `docs/ai/` for continuity between development sessions. It has no bearing on how the
shipped product works.

## Core workflows

1. **Ingest**: upload a CSV → structural + row validation → dedup on
   `(indicator_value, port, protocol, report_type)` → a Finding is created, bumped (persistence), or
   reopened (recurrence).
2. **Enrich**: automatic IOC reputation lookup (AbuseIPDB or mock) on ingestion; on-demand exposure and
   vulnerability enrichment from five more providers, analyst-triggered.
3. **Score**: deterministic Risk v1, with every factor's contribution stored, never recalculated
   silently for display.
4. **Triage → Case**: an analyst decides what needs a case, opens one bound to an organization, gathers
   evidence, requests closure.
5. **Review**: a different person (never the requester, except an explicit ADMIN override) approves or
   rejects the closure.
6. **Map**: framework context (ATT&CK/CSF/CIS) recorded against the case, manually or via a
   human-approved AI suggestion — same rule, same write path either way.
7. **Notify**: a draft is written from case evidence, revised (each edit immutable and un-approving),
   reviewed by a different person, exported as `.eml`, and its delivery recorded as a separate,
   human-observed fact.

## Data semantics — the rules that keep the numbers honest

- **Unknown is never zero.** A figure that could not be computed is `UNAVAILABLE`; a figure the caller
  may not see is `RESTRICTED`. Neither renders as a real zero anywhere in this system.
- **Persistence vs. recurrence.** The same finding seen again while still open is persistence
  (occurrence count bumps); seen again after closure is recurrence (the case reopens, and the reopening
  is audited).
- **A provider result is evidence, not proof, and evidence is either fresh, stale, or absent — never
  "probably fine."**
- **Applicability has three states, not two.** `APPLIED` / `NOT_AVAILABLE` / `NOT_APPLICABLE` for every
  risk factor — "could not check" is never rendered as "clean."
- **Export ≠ delivery.** Producing an artifact and sending it are different, separately tracked events.

## Security principles

- The backend is the only authorization boundary; the frontend's checks are UX convenience, kept honest
  against the backend by a dedicated test, never trusted as the actual control.
- Every write is audited, from the service layer (not the controller layer), so an omitted audit call
  fails a test rather than silently happening.
- Rate limiting on auth, upload, and provider execution — all six live providers share one
  provider-execution budget.
- No secret is ever logged, returned to the client, or reaches the frontend bundle — enforced by
  per-provider redaction tests and a CI bundle scan.
- Full detail: `docs/ai/SECURITY.md` and `docs/ADMIN_GUIDE.md`.

## Provider stack

Six live providers across three domains (IOC reputation, vulnerability metadata, internet
exposure/reputation), each its own adapter, its own table, its own tests, sharing one rate-limit budget
and one closed error-code vocabulary. Full detail: `docs/PROVIDER_GUIDE.md`.

## AI governance

Two independent, disabled-by-default AI surfaces (case-level mapping suggestions, Finding-level
narrative drafts). No live AI provider ships. AI output is treated as untrusted input, validated by the
same rules a human's input clears, and structurally unable to write anything beyond its own suggestion
row. Full detail: `docs/AI_GOVERNANCE.md`.

## Deployment and operations

Docker Compose only; no production target exists. `docs/DEPLOYMENT.md` (first run),
`docs/OPERATIONS_RUNBOOK.md` (day-to-day commands and recovery).

## Demo flow

`docs/DEMO_SCRIPT.md` (presentation cue card) and `docs/DEMO_RUNBOOK.md` (full walkthrough with every
talking point).

## Testing and CI

145 backend test files, a 9-spec Chromium browser suite, 9 evaluator gates against hand-authored ground
truth, and a CI pipeline that checks secrets hygiene, migration integrity, and no live provider calls on
every push. Full detail: `docs/TESTING_AND_CI.md`.

## Maintenance notes

- **23 additive-only Prisma migrations.** No migration in this project's history has ever altered or
  dropped a column — a schema change is always a new, forward-only migration.
- **Domain-separated provider/AI registries by design**, not an oversight to eventually unify. Each
  registry is small, frozen, and specific to its domain (IOC reputation, vulnerability, exposure/
  reputation, two independent AI surfaces) — see `docs/ARCHITECTURE.md` for why this was chosen
  repeatedly over one generic abstraction.
- **CI's migration-history check is intentionally strict**: adding a migration requires updating the
  frozen list in `.github/workflows/ci.yml` in the same commit, so an accidental or silent migration
  reorder is caught immediately rather than discovered later.

## Phase history (as actually built, not as originally planned)

The original `../ThreatNeXus-Planning/planning/BUILD_PLAN.md` phase numbering was reorganized during
actual execution — this table reflects what was actually delivered, under the ticket/branch names used
at the time:

| Phase | Delivered |
|---|---|
| 0 | Foundation, audit spine, RBAC, API contract freeze |
| 1 | Shadowserver-style ingestion → Finding lifecycle (dedup/persistence/recurrence) |
| 2 | Ownership resolution, IOC + vulnerability enrichment, deterministic Risk v1 |
| 3 | Analyst workflow — cases, closure, separation of duties |
| 4 | Notification workflow — drafting, revisions, review, `.eml` export, delivery tracking |
| 5 | Framework mapping (manual first) + guarded, disabled-by-default AI mapping assistance |
| 6 (6.1–6.3) | Analyst frontend, dashboard integrity model, motion design, pinned ATT&CK catalogue |
| 7 | Evaluation harness completion, rate limiting, release-candidate hardening |
| 8 | Provider-evidence gap-fill (formalizing the provider foundation already in place) |
| 8B | Censys — internet exposure/attack surface |
| 8C / 8C.1 | Finding-level AI assistance (backend, then frontend) |
| 8D | GreyNoise — internet-noise/reputation |
| 8E | Shodan — exposed-service/banner/port intelligence |
| 8F | Netlas — cross-source attack-surface/DNS/certificate intelligence |
| 9A | This documentation and delivery package |

## Roadmap (recommended, not committed)

- **Phase 9B** — presentation assets (slide deck, optional showcase/landing page).
- **A seventh live provider** (VirusTotal, OTX, or MISP), following the exact same adapter pattern.
- **In-app user management**, closing the admin gap documented in `docs/ADMIN_GUIDE.md`.
- **A production write path for Finding closure**, if the recurrence chain needs to be demonstrable
  through the UI rather than only through the evaluators.
- **Shadowserver live ingestion**, pending API access/licensing.

## Known gaps (the honest list, consolidated)

- No in-app user management, no in-app audit-log viewer, no token revocation.
- Finding closure has no production write path — the recurrence engine is tested and correct; nothing
  reachable in the UI currently produces the state it reopens from.
- No live AI provider ships; enabling `AI_ENABLED` today activates a provider that safely resolves to
  "disabled."
- A generic legacy `Threat`/`/api/threats` surface still exists alongside the Finding model, predating
  Phase 1 — see `docs/API_CONTRACT_PHASE0.md`.
- No current API-contract document exists covering Phases 1 through 8F's routes as a single reference
  (`docs/API_CONTRACT_PHASE0.md` describes Phase 0 only, and remains accurate for what it covers) — the
  authoritative source for current route behavior is the route files themselves plus
  `docs/PROVIDER_GUIDE.md` for the provider-specific surface.
- No production deployment target.

## Decision rules (how this project decides things)

- **Every architecture decision is recorded.** Product/architecture decisions live in
  `../ThreatNeXus-Planning/planning/DECISIONS.md` (authoritative, read-only from this repository);
  decisions about how the development workflow itself operates live in `docs/ai/DECISIONS.md`.
- **Unknown stays unknown.** No screen, evaluator, or document in this project may assert a figure the
  database did not produce.
- **A materially different provider response shape gets its own table**, repeatedly, rather than a
  shared "enrichment" table with nullable columns nobody's provider needs.
- **AI can never obtain authority the manual path denies.** Every AI-decide capability is paired with
  the same grant a human would need to do the same thing by hand.
- **A phase is not closed until its evidence is checked**: tests pass, an evaluator (where one exists)
  reproduces ground truth, and CI is green — not until someone believes it works.
