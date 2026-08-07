# Handoff: TNX-P8C-AI-ASSISTANCE-MVP

- From: claude
- Suggested next writer: unassigned
- Branch: feat/phase-8c-ai-assistance-mvp
- Updated: 2026-08-07T11:15:00Z

## Phase 8B closure note

`feat/phase-8b-censys-provider` (Censys Platform API integration) is merged into `main` via PR #11
(`19bf6e6`), on top of PR #10. This ticket fast-forwarded local `main` (which was 6 commits stale) and
branched from the updated tip.

## Goal

Build analyst-assist AI suggestions (finding summary draft, analyst explanation draft) that are
disabled by default and human-approved only. AI must never make final decisions, never automatically
close findings, never approve mappings, never notify organizations, and never mutate authoritative
security state without explicit analyst action.

## The most important decision in this ticket: what NOT to build

Before writing anything, this session read the **existing** Phase 5 AI foundation in full
(`services/ai/`: provider registry, runtime, mapping provider, mock provider, suggestion service, rules,
decision service, evidence snapshot) and its routes. Phase 5 already shipped disabled-by-default,
human-approved AI mapping suggestions with a fully worked-out safety architecture: a one-method provider
contract that returns data only, a bounded/allow-listed evidence snapshot built by construction (not
redaction), untrusted-provider-output validation through the same rules a human's input clears, and a
staleness-fingerprint guard on approval.

**Phase 8C does not rebuild any of that.** It adds a second, smaller, parallel AI domain — Finding-level
narrative drafts (SUMMARY / EXPLANATION) — because a mapping candidate cannot express "draft me a
summary of this finding." It mirrors Phase 5's architecture closely (own registry, own provider
contract, own rules module) but is genuinely simpler where the domain allows: one request produces one
row (no separate "run" table, since a narrative draft isn't a batch of candidates), and accepting a
draft only flips its own review state (no "promotion" transaction, since there is no downstream
authoritative record — unlike an ATT&CK mapping becoming a `CaseFrameworkMapping`).

## What this ticket added

1. **`FindingAiSuggestion`** (Prisma model + 2 enums, additive-only migration
   `20260807100000_add_phase8c_finding_ai_suggestions`). Own table — no change to any Phase 5 AI table
   or any other existing column.
2. **`backend/src/services/aiAssist/`** — `aiAssistRules.js` (pure validation, closed vocabularies),
   `aiAssistProvider.js` (the contract + the disabled provider — one method,
   `generateSuggestion({snapshot, suggestionType, asOf, signal})`, returns data only), `mockAiAssistProvider.js`
   (deterministic, offline, includes deliberately-bad scenarios), `aiAssistProviderRegistry.js` (mock
   reachable only with an explicit test-only opt-in, exactly Phase 5's "no silent fallback to mock"
   guarantee), `aiAssistRuntime.js` (reuses `env.AI_ENABLED`/`env.AI_PROVIDER` — **one** operator switch
   covers both AI domains), `findingEvidenceSnapshot.js` (bounded per-Finding snapshot, reuses
   `caseEvidenceSnapshot.js`'s `canonicalize`/fingerprint helpers directly rather than reimplementing
   them), `findingAiSuggestionService.js` (request/list), `findingAiSuggestionDecisionService.js`
   (accept/reject; staleness detected on accept transitions the draft to `EXPIRED` and refuses — never
   on reject, matching Phase 5's own reasoning for why rejection needs no guard), `aiAssistSerializers.js`.
3. **`GET`/`POST /api/findings/:id/ai-suggestions`**, **`POST .../accept`**, **`POST .../reject`** —
   `backend/src/controllers/aiFindingSuggestionController.js` + `aiFindingSuggestionRoutes.js`, mounted
   in `app.js` before `findingReadRoutes` (same route-shadowing constraint as `censysEnrichmentRoutes`).
4. **Two new capabilities** (`read:ai-finding-suggestions`, `request:ai-finding-suggestions`: ADMIN +
   ANALYST) **and a reuse, not a third new one**: accept/reject is gated on the pre-existing
   `review:ai-suggestions` capability (declared Phase 0, granted to ADMIN + REVIEWER, unused by any
   route until this ticket). It fits here — and did not fit Phase 5's mapping-suggestion decide — because
   accepting a narrative draft creates no downstream authoritative record; it is a genuine review of
   someone else's output, not a grant of write authority over anything else. The result is real
   separation of duties: ANALYST drafts, REVIEWER/ADMIN decides, mirroring the notification workflow.
5. **Rate limiting**: the new POST route draws on the SAME `providerRateLimiter` budget IOC/CVE/Censys
   enrichment and AI mapping suggestions already share — proven in `phase7RateLimiting.test.js`.
6. **Audit events**: `ai.suggestion.requested`/`.generated`/`.failed`/`.accepted`/`.rejected`,
   `ai.unavailable` — provider name, closed reason code, text LENGTH only, never the proposed text, the
   snapshot, or the internal staleness fingerprint.
7. **51 new/updated tests** (see `docs/ai/STATE.yaml` `completed` for the exact breakdown). Full backend
   suite: **2950 passed / 177 skipped**, zero regressions from the 2899 baseline.

## Two real bugs this ticket's own tests caught (in the tests, not the implementation)

- A route-authorization test wrongly assumed setting `AI_PROVIDER=mock` in the environment would make
  the real HTTP path return mock-generated text. It does not, by design — the mock provider is reachable
  only with a test-only `allowMockProvider` flag no production caller ever passes. Fixed the test to
  assert the correct (and more important) property: **even with `AI_PROVIDER=mock` set, the real HTTP
  path still resolves to the disabled provider.**
- A safety-boundary test expected a hostile provider result carrying extra unexpected fields
  (`riskBand`, `closeFinding`, ...) to be explicitly REJECTED. The actual (correct) behaviour is that the
  service only ever reads `.text` and `.evidenceReferences` off a provider result — everything else is
  excluded **by construction**, never even passed to validation. This is the stronger safety property
  (the same "prompt minimization by construction, not redaction" philosophy `caseEvidenceSnapshot.js`
  documents), so the test was corrected to assert that instead.

## CI result

Pushed as `36a058e`. Run [31169482260](https://github.com/haiderchattha99-ali/ThreatNeXus/actions/runs/31169482260)
— **all jobs green**, including the two gates that could not run locally (Docker's daemon never came up
in this sandbox): the "Prisma schema and migration history" job's `migrate deploy from an empty database`
and `No drift between schema and applied migrations` steps, and the "Core evaluators" job's `eval:phase5`
and `eval:phase7`. Backend tests also ran and passed against real PostgreSQL in CI. "Mutation and
concurrency gates" is a manual-trigger-only job and was not run — not required for this ticket.

## Honest gaps

- No frontend surface — deferred to **Phase 8C.1** per this ticket's own explicit fallback clause.
  Backend/API/tests/docs shipped first.
- No live AI provider exists in this repository (same boundary Phase 5 documented) and therefore no live
  smoke script.
- `F:\Ismail-AI-Dev-Team\scripts\start-task.ps1` throws against this repo's `STATE.yaml` schema (assumes
  a `current_work` field this project doesn't have). Worked around, not fixed — out of this repo's scope.
- `docs/codex/` remains untracked and untouched, per the one-writer boundary.

## Recommended next phase

In order of what this ticket's own gaps suggest: (1) watch CI green, since the migration is unverified
against a real database locally; (2) Phase 8C.1 — the Finding-detail frontend surface for these
suggestions; (3) in-app user management (`manage:users` still unused, flagged since Phase 8B); (4) a
third live provider or Shadowserver licensing.

## Protected boundaries

- Do not redo completed work without evidence.
- Do not change architecture without updating `DECISIONS.md`.
- Do not expose secrets or absorb unrelated changes.
- `docs/codex/` is a foreign path this session did not touch — leave it alone unless its owner asks.
- `backend/.env` (and any non-`.env.example` env file) must never be read, printed, or committed.
