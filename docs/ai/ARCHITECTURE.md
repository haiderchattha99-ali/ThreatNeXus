# Architecture

This file is the AI team's orientation note. It is **not** the architecture of record: the
authoritative specification is `../../../ThreatNeXus-Planning/planning/BUILD_PLAN.md` and the locked
decisions in the sibling `DECISIONS.md` there. Where they disagree with this file, they win.

## System context

ThreatNeXus is a defensive cyber-threat-intelligence orchestration and incident-response **research
prototype** built for PKCERT. It ingests Shadowserver-style exposure reports (Accessible RDP first
and, so far, only), deduplicates them into a persistent `Finding` lifecycle, enriches them, scores
them deterministically, drives an analyst case workflow, and produces reviewer-approved constituent
notifications that a human exports and sends manually. It has never been deployed and has never held
real constituent data.

## Components and ownership

| Component | Path | Notes |
|---|---|---|
| REST API | `backend/src/routes`, `backend/src/controllers` | Everything mounted under `/api` |
| Domain services | `backend/src/services` | Ingestion, dedup, enrichment, risk, workflow, notification, mapping |
| Persistence | `backend/prisma` | Prisma + PostgreSQL. **18 migrations, all additive** |
| Evaluation harness | `eval/` | Drives the real services against a disposable database and hand-authored ground truth |
| Analyst UI | `frontend/src` | React 19 · Vite 8 (rolldown/oxc) · MUI v9 · React Router 7 · GSAP. No charting library |
| Browser exit gate | `frontend/e2e` | Playwright, Chromium only, against the real stack |

## Data flow

Report upload → validation → dedup on `(indicator_value, port, protocol, report_type)` → `Finding`
created, or an existing one bumped (persistence) or reopened (recurrence) → IOC reputation
enrichment and, separately, vulnerability enrichment → deterministic Risk v1 score with stored
per-factor contributions → analyst triage → org-bound `Case` → reviewer-approved closure →
notification draft → immutable revision → reviewer approval bound to that exact revision → manual
`.eml` export → manually recorded delivery observation.

The dashboard reads **one** bounded, read-only snapshot (`GET /api/dashboard/overview`) and performs
no provider lookup of its own.

Phase 6.3 adds a local, build-time-pinned Enterprise ATT&CK 19.1 catalogue. The runtime never fetches
MITRE data: `backend/scripts/buildAttackCatalogue.js` produces the reduced catalogue and manifest,
`attack:verify` checks their SHA-256 integrity, and the API serves one bounded, read-only navigator
snapshot. Manual and AI-suggested mappings share the same catalogue and evidence validation. A
mapping cites a verbatim stored quote and carries separate evidence and mapping confidence; an
analyst may instead record an explicit, reasoned no-applicable determination. Historical mappings
remain readable even if a future catalogue no longer contains their reference.

## Trust boundaries

The **backend is the only authorization boundary.** Frontend permission checks are presentation
only; hiding a control grants and denies nothing. Every route enforces its own capability check
server-side and fails closed.

## APIs and contracts

`docs/API_CONTRACT_PHASE0.md` plus the route files under `backend/src/routes/`. Every dashboard
figure is returned as `{ value, availability, source, asOf }`.

The ATT&CK navigator exposes raw mapping counts only. It does not calculate or display a coverage
percentage because the system has no truthful denominator for which techniques should apply.

## Data model

See `backend/prisma/schema.prisma`. The dedup key above and the `Finding` → `Case` → `Notification`
chain are the load-bearing relationships; getting dedup wrong silently corrupts every downstream
metric.

## Failure handling

Enrichment failure **never** blocks ingestion — the finding is still created and the enrichment row
records `FAILED` or `RATE_LIMITED`. A section the caller may not read is returned `RESTRICTED`; one
whose query threw is returned `UNAVAILABLE`. Neither is ever rendered as a zero.

## Deployment

`docker-compose.yml` brings up PostgreSQL, backend and frontend. It fails fast without `JWT_SECRET`.
There is no deployed environment.

## Constraints

Architecture changes require an entry in `DECISIONS.md` — and, if they touch the locked plan, in the
planning folder first.
