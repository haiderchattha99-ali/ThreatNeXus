# Delivery Package — Phase 9A

This is the index for ThreatNeXus's professional documentation package, produced after all six planned
live providers (NVD, AbuseIPDB, Censys, GreyNoise, Shodan, Netlas) were integrated and their evaluation
gates were green. Read `docs/PROJECT_PLAYBOOK.md` first if you're new to the project — it's the one
document written to stand alone. Everything else here goes deeper on one topic.

## What's in this package

| Document | Covers |
|---|---|
| [`PROJECT_PLAYBOOK.md`](PROJECT_PLAYBOOK.md) | The single-document overview: identity, scope, roles, workflows, security, roadmap, known gaps |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Technical architecture: components, data flow, provider adapter pattern, trust boundaries, data model |
| [`PROVIDER_GUIDE.md`](PROVIDER_GUIDE.md) | Every live provider (and the ones not integrated): purpose, config, failure behavior, evidence semantics |
| [`AI_GOVERNANCE.md`](AI_GOVERNANCE.md) | AI assistance governance: disabled by default, no live provider, human approval, structural limits |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | How to run ThreatNeXus: prerequisites, environment variables, Docker Compose, migrations, backup/restore |
| [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) | Day-to-day operational commands, rate limits, recovery, known flake classes |
| [`TESTING_AND_CI.md`](TESTING_AND_CI.md) | Test suites, evaluators, CI pipeline, migration guard, secrets scan |
| [`USER_GUIDE.md`](USER_GUIDE.md) | Role-specific usage: dashboard, findings, upload, cases, notifications, AI panel |
| [`ADMIN_GUIDE.md`](ADMIN_GUIDE.md) | Role/capability matrix, provider config, audit logs, admin limitations |
| [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md) | Presentation cue card, timing, backup path if offline |
| [`DEMO_RUNBOOK.md`](DEMO_RUNBOOK.md) | Full walkthrough with every talking point (pre-existing, unchanged this phase) |
| [`API_CONTRACT_PHASE0.md`](API_CONTRACT_PHASE0.md) | Phase 0's API surface, still accurate for what it documents (pre-existing) |

Internal AI-development-team process records (`docs/ai/`) are a separate concern from this package —
they document how the codebase was built session-to-session, not how to run or use it. `docs/ai/STATE.yaml`
and `docs/ai/HANDOFF.md` are updated as part of this delivery to close out Phase 9A itself.

## Feature status at time of delivery

- **6 live providers integrated**: NVD (+ CISA KEV, FIRST EPSS), AbuseIPDB, Censys, GreyNoise, Shodan,
  Netlas. All optional, all fail-safe, none required for the application to start or any core workflow
  to complete.
- **2 independent AI assistance surfaces**, both disabled by default, no live AI provider shipped.
- **145 backend test files, 9 Chromium e2e specs, 9 evaluator gates** (plus 2 manual mutation/concurrency
  gates), all green as of the last CI run on `main` prior to this phase.
- **23 additive-only Prisma migrations.**
- **No production deployment.** This remains a research prototype.

## Validation performed for this documentation phase

- `git status` checked before and after every file change; only explicit paths staged (no `git add -A`
  used anywhere in this phase).
- Every command, file path, and environment variable name referenced in this package was verified
  against the actual codebase (route files, `env.js`, `package.json` scripts, `docker-compose.yml`,
  `.github/workflows/ci.yml`) rather than assumed or recalled from memory.
- No real secret, API key, or `.env` file was read, printed, or committed — only `backend/.env.example`
  was consulted, and only placeholders appear anywhere in this package.
- Any tiny factual bug this pass surfaced in existing docs, README links, or command names was corrected
  in the same commit — see `docs/ai/HANDOFF.md` for the specific list, if any.
- No product feature was added. This phase is documentation, packaging, verification, and small
  correction only.

## Honest gaps in this delivery

See `docs/PROJECT_PLAYBOOK.md` → "Known gaps" for the full list (no in-app user management, Finding
closure has no production write path, no live AI provider, etc.) — this package documents those gaps
rather than hiding them, per the project's own "unknown is never zero" rule applied to its own
documentation.

## Recommended next phase

**Phase 9B** — presentation assets: a slide deck and, if wanted, a documentation-only placeholder for a
showcase/landing page (no implementation in that scope unless separately authorized).
