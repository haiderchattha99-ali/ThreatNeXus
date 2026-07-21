# ThreatNeXus Agent Instructions

This is the implementation repository. Full specifications, the phased build plan, and the decision
record live in the sibling folder `../ThreatNeXus-Planning/` — treat it as **read-only**.

## Read first

- Planning source: `../ThreatNeXus-Planning/planning/BUILD_PLAN.md`
- Locked decisions: `../ThreatNeXus-Planning/planning/DECISIONS.md`
- Current next steps: `../ThreatNeXus-Planning/planning/NEXT_STEPS.md`
- Code invariants: `../ThreatNeXus-Planning/.claude/skills/threatnexus-build-guard/SKILL.md`

If this file and the planning folder disagree, the planning folder wins. If a rule here needs to
change, get explicit user approval and update the planning folder first.

## Stack

Node.js, Express, Prisma/PostgreSQL, React/Vite/MUI. This **preserves and refactors the existing
repository** — it is not a rewrite. The submitted proposal PDF describes a FastAPI/SQLAlchemy stack;
that is superseded per `DECISIONS.md` D-001. Do not "correct" the stack back toward FastAPI.

## Working rules

- **Phase-gated. One phase, one PR, at a time.** Phase 0 comes first. Do not start a later phase
  before the current phase's gate (defined in `BUILD_PLAN.md`) passes.
- **Audit logging is cross-cutting and begins in Phase 0.** Every write path added later must append
  its own `AuditLog` event in the same change — never retrofit it.
- **One Shadowserver-style report type first** (Accessible RDP exposure). Carry it to closure before
  starting a second type.
- **Deduplication, persistence, and recurrence are core invariants**, not implementation details.
  Dedup key: `(indicator_value, port, protocol, report_type)`. Existing finding + open case →
  persistence (bump occurrence, no new row). Existing finding + closed case → recurrence (reopen the
  case, audit it). Get this wrong and every downstream metric is silently corrupted.
- **AbuseIPDB is the required first real IOC enrichment provider**, behind a provider abstraction,
  with a `MockProvider` for all automated tests (tests must never consume live quota).
  **Enrichment failure must never block ingestion** — findings are still created; the enrichment row
  records `FAILED` or `RATE_LIMITED`. API keys come from environment variables only and must never
  appear in logs or error responses.
- **KEV, EPSS, and NVD are vulnerability enrichment** — a separate path from IOC reputation
  enrichment. Neither substitutes for the other.
- **Risk scoring is deterministic and explainable, never AI-decided.** Every score stores its factor
  contributions; the human-readable explanation is rendered from those stored values, not generated
  by a model.
- **Manual framework mapping must work before AI assistance is added.** AI mapping suggestions are
  additive on top of a working manual path, not a replacement for one.
- **AI is optional and disabled by default** (`AI_ENABLED=false`). AI cannot approve, send, score,
  close, resolve, or make final framework mappings — it drafts and suggests only, and every core
  workflow must complete correctly with AI off.
- **Analyst approval is required before notification export.** The export endpoint must refuse any
  notification whose status is not `Approved` or whose `approved_by` is null.
- **Out of scope:** live scheduled Shadowserver API ingestion, automatic notification sending (no
  SMTP/webhook client, not even a disabled one), automatic remediation verification, SIEM/EDR
  integration, threat-actor attribution, automatic compliance assessment.
- **No secrets or real victim data may ever be committed.** Only synthetic or sample data. API keys
  via environment variables only.

## Process rules

- Before claiming a task complete, **inspect the actual diff** and **run the available tests** —
  do not report success from intent alone.
- **Only one coding agent edits this repository at a time.** If you find uncommitted or unfamiliar
  changes, stop and review them before continuing — don't assume they're yours to overwrite.
- **Never edit `main` directly.** Work happens on a feature/chore branch per phase or task; `main`
  only receives reviewed merges.
- Do not create additional planning files in this repo. Planning lives in `ThreatNeXus-Planning/`.
