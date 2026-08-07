# Handoff: TNX-P8C1-AI-ASSISTANCE-FRONTEND

- From: claude
- Suggested next writer: unassigned
- Branch: feat/phase-8c1-ai-assistance-frontend
- Updated: 2026-08-07T11:40:00Z

## Phase 8C closure note

`feat/phase-8c-ai-assistance-mvp` (Finding-level AI assistance backend MVP) is merged into `main` via
PR #12 (`99c9743`). This ticket branches from that updated tip and touches **zero backend files** — it
is purely the frontend surface for the already-complete, already-CI-green backend.

## Goal

Make the Phase 8C backend AI finding-assistance MVP visible and usable in the frontend: a compact,
analyst-focused panel on Finding detail. No live AI provider. AI remains suggestion-only — a human
always accepts or rejects.

## What this ticket added

1. **`frontend/src/services/api.js`** — `aiFindingAssistService` (request/list/accept/reject), reusing
   the existing `aiMappingService.getConfig()` for availability rather than adding a second config call:
   the backend exposes ONE `AI_ENABLED`/`AI_PROVIDER` switch for both AI surfaces (Phase 5 mapping
   suggestions and Phase 8C finding drafts), so the same response is accurate for both.
2. **`frontend/src/constants/findingAiAssistance.js`** — presentation vocabulary mirroring
   `backend/src/services/aiAssist/aiAssistRules.js`: suggestion types, a `StatusBadge` dictionary for
   DRAFT/ACCEPTED/REJECTED/EXPIRED, reason-code sentences, evidence-reference labels, error mapping.
3. **`frontend/src/constants/capabilities.js`** — `READ_AI_FINDING_SUGGESTIONS` +
   `REQUEST_AI_FINDING_SUGGESTIONS` added, mirroring `backend/src/lib/roles.js` exactly. Deciding reuses
   the pre-existing `REVIEW_AI_SUGGESTIONS` constant, already present from Phase 4/5.
4. **`frontend/src/components/FindingAiAssistPanel.jsx`** — the panel. Built from the same Phase 6
   design-system idiom (`Panel`/`StatusBadge`/`States`/`AVAILABILITY`) `FindingDetail.jsx` already uses —
   NOT Phase 5's older ad-hoc `FrameworkMappingPanel.jsx` styling, since this panel mounts on
   `FindingDetail`. The *interaction* pattern (capability gating, request/decide flow, anti-automation-
   bias rules: no accept-all, no pre-selected decision, a rejection reason required before Reject enables,
   decided drafts stay visible, EXPIRED shown with its staleness reason) is mirrored from
   `FrameworkMappingPanel.jsx` deliberately — the same rules, a different visual shell.
5. Mounted on **`frontend/src/pages/FindingDetail.jsx`** as its own full-width `Panel` section.
6. **16 new component tests** (`FindingAiAssistPanel.test.jsx`) — capability gating, disabled/unavailable
   states, generate success/403/raw-error-never-shown, decide (reject-reason-required, accept), status
   rendering for all four states. All passed on the first real run.
7. **`frontend/e2e/findingAiAssistance.spec.js`** — 4 fixed scenarios plus a per-role loop (7 total):
   disabled-by-default rendering, VIEWER denial, REVIEWER read-only (no generate control), responsive
   layout, zero console errors per role. Authored and its assertions manually proven live this session
   (see below); the spec file itself was not executed locally — see honest gaps.
8. Docs: `README.md`, `docs/ai/SECURITY.md` (new "Frontend AI-assistance surface" subsection),
   `docs/ai/HANDOFF.md`, `docs/ai/STATE.yaml`.

## Genuine live browser verification this session

Docker's daemon (unavailable throughout Phase 8C) came up mid-session, surfacing a stale docker-compose
stack from an earlier session (Postgres/backend/frontend containers, images predating the Phase 8C
merge). Rather than disturb it, this session:

- Ran `prisma migrate deploy` against the real Postgres (applied the one pending Phase 8C migration —
  additive, already proven safe by CI — directly, a second independent proof it applies cleanly).
- Reseeded the four well-known demo accounts with a locally-chosen password (`seedUsers.js`, idempotent
  upsert — **note**: this changes those accounts' password on that specific stale local container; CI
  seeds its own fresh database and is unaffected, but the next person using that exact local Docker
  stack will need to re-run `seed:users` with their own password).
- Ran **this session's own backend code** (not the stale container) on a free port against that same
  database, and a frontend dev server pointed at it.
- Logged in for real as ANALYST, REVIEWER and VIEWER and opened a real seeded Finding:
  - The AI assistance panel renders correctly with real server-issued capabilities (not mocked).
  - VIEWER: `DeniedState` with the real capability name (`read:ai-finding-suggestions`) from the real
    403 response.
  - REVIEWER: panel visible (read access), correctly NO generate control (real capability data).
  - ANALYST: panel visible, correctly shows "Disabled" — `AI_ENABLED` is unset by default, the shipped
    reality — never a fabricated "AI online" state.
  - Zero console errors on any role. No horizontal overflow at 375px (mobile) or 768px (tablet).
  - The rest of the Finding-detail page (triage, risk explanation, ownership, timeline, cases) renders
    unaffected by mounting the new panel.
- Cleaned up every verification-only artifact afterward (temporary `frontend/.env.local`,
  `.claude/launch.json`, the local backend process, the browser preview server) — working tree confirmed
  clean before staging.

## Honest gaps

- **The populated-draft rendering cannot be observed through any live browser session, by design.**
  `aiAssistRuntime.js` never resolves the mock provider without a test-only flag no production HTTP path
  ever passes — the same boundary Phase 8C's backend documents, not a new gap introduced here. It is
  covered instead by `FindingAiAssistPanel.test.jsx`, which injects the mock provider response directly
  at the component level (16 tests: draft cards, evidence tags, accept/reject, all four statuses).
- **`frontend/e2e/findingAiAssistance.spec.js` was not run locally.** Running it would have required
  stopping the pre-existing stale Docker containers occupying the default ports this session was
  otherwise careful not to disturb. Its assertions were manually proven true in a live browser (see
  above); CI's "Browser suite (Chromium)" job is this spec's first real execution, against a freshly
  built, freshly seeded stack.
- Zero backend files touched — this ticket is frontend-only, by its own explicit scope.
- `docs/codex/` remains untracked and untouched, per the one-writer boundary.

## Recommended next phase

(1) Watch CI green, since the new Playwright spec is unverified in that environment specifically
(though its assertions were manually proven live); (2) in-app user management (`manage:users` still
unused, flagged since Phase 8B); (3) GreyNoise, Shodan, or Netlas as a fourth live provider, or resolve
Shadowserver licensing.

## Protected boundaries

- Do not redo completed work without evidence.
- Do not change architecture without updating `DECISIONS.md`.
- Do not expose secrets or absorb unrelated changes.
- `docs/codex/` is a foreign path this session did not touch — leave it alone unless its owner asks.
- `backend/.env` (and any non-`.env.example` env file) must never be read, printed, or committed.
- The Phase 8C backend is complete and untouched by this ticket; do not rewrite it.
