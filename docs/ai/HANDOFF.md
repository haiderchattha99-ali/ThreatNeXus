# Handoff: TNX-P9B-PRESENTATION-ASSETS

- From: claude
- Suggested next writer: claude (in progress)
- Branch: feat/phase-9b-presentation-assets
- Updated: 2026-08-09T21:30:00Z

## Start-gate discrepancy — read this first

The mandatory start gate for this ticket assumed **PR #17 (Phase 9A) was already merged into main**.
It was not: `gh pr list` showed it `OPEN` at the start of this session. Rather than block entirely or
proceed as if a merge had happened, this ticket branched `feat/phase-9b-presentation-assets` from the
tip of `feat/phase-9a-professional-docs` (`f220351`) — the exact same commit content PR #17 will merge,
just not yet on `main`. **This branch needs a rebase onto `main` once PR #17 actually merges**, before
its own PR is opened. Nothing about the actual deliverable content depends on which branch it's based
on; only the eventual PR's base commit does.

## Goal

Create a professional PKCERT-ready presentation package: a 16-slide deck with speaker notes, a detailed
demo walkthrough, a screenshot capture plan, a style guide (including a real research pass and an
internal deck strategy), and a landing-page plan (planning only, not built). Presentation and demo
assets only — no product features, no code changes beyond two small documentation cross-links.

## What this ticket added

`docs/presentation/`:

1. **`ThreatNeXus-PKCERT-Deck.md`** — 16-slide deck source, short slide text by design (detailed
   language lives in the notes file).
2. **`ThreatNeXus-PKCERT-Deck.pptx`** — the generated deck. Built with `pptxgenjs`, using the product's
   own real design tokens (`frontend/src/theme/tokens.js`: near-black canvas `#0A1210`, government-green
   accent `#35C477`) as the palette rather than an invented one. Speaker notes embedded on every slide.
   Passed the pptx skill's schema/relationship/content-type validator clean.
3. **`SPEAKER_NOTES.md`** — one section per slide: what to say, what visual/screenshot to show, what
   not to overclaim, a demo cue where relevant, and the fallback if a provider API or the network is
   unavailable during the talk.
4. **`DEMO_WALKTHROUGH.md`** — the detailed PKCERT-facing version of the demo, adding what
   `docs/DEMO_SCRIPT.md` doesn't cover: a pre-demo checklist, dedicated provider-enrichment /
   AI-assistance / ATT&CK-mapping walkthrough sections, and explicit recovery steps if a provider API
   goes down mid-demo.
5. **`SCREENSHOT_PLAN.md`** — 9 exact screenshot slots (dashboard, findings list, finding detail,
   provider evidence, provider matrix, AI panel ×2 states, ATT&CK refusal, CI-green proof, architecture
   diagram), each with an exact filename, the role to sign in as, and capture instructions. **None were
   captured this phase** — see "Screenshots were not captured" below.
6. **`STYLE_GUIDE.md`** — the internal deck strategy (audience/hook/pain/promise/proof-points/demo
   sequence/what-must-not-be-overclaimed), a real inspiration-notes section from an actual research
   pass, visual rules, the full banned-overclaim-word list, and phrasing guardrails for AI governance,
   provider evidence, security claims, demo wording, and PKCERT-only audience framing.
7. **`LANDING_PAGE_PLAN.md`** — planning only, explicitly not built: whether it's worth building, what
   problem it solves, where it would live, what sections/screenshots it needs, and the specific trigger
   condition to revisit building it.

`docs/DEMO_SCRIPT.md` — one cross-link added to `DEMO_WALKTHROUGH.md`, nothing else changed.

`README.md` — a Phase 9B status-table row, two new Documentation-table links (deck + walkthrough), the
old vague "Phase 9B addition" screenshot placeholder replaced with a real link to `SCREENSHOT_PLAN.md`,
the Roadmap section updated (landing page + real screenshots are now the stated next items), and the
"Current status" heading (plus its self-referencing anchor) updated to Phase 9B.

## The research pass (real, not fabricated)

Per instruction, a short research pass ran before any slide content was written:

- **WebSearch**: open-source security-tool README documentation structure and trust-building patterns;
  cybersecurity product pitch-deck slide structure.
- **WebFetch**: `github.com/falcosecurity/falco`, asking explicitly for structure only (section order
  and purpose), not wording — the response is recorded in `STYLE_GUIDE.md`'s inspiration-notes section,
  citing the real project by name. **No star counts are stated anywhere** — none were verified live, so
  per instruction none were mentioned.
- Extracted patterns only: trust-building before feature tour, a dedicated security/disclosure section,
  an FAQ-style section that pre-empts skepticism, architecture shown as a map not prose (from the
  README research); concrete-pain problem framing, outcome-before-mechanism solution framing, proof
  placed to support an already-made claim rather than opening the deck (from the pitch-deck research,
  explicitly noting funding/market/team slides don't fit this audience and were not adopted).
- Nothing — no wording, branding, asset, screenshot, or diagram — was copied from any source inspected.

## Screenshots were not captured

Docker's daemon was unreachable in this environment (`npipe` connection failed) and Docker Desktop's
executable was not found at its standard install path — confirmed with two quick checks, not escalated
into a longer debug session, per the explicit instruction not to do that without approval. Every
screenshot slot in `SCREENSHOT_PLAN.md` is a real, exact, capturable placeholder with instructions —
none of the deck's content depends on a screenshot existing; the deck's placeholder framing (in
speaker notes) explicitly tells the presenter what to say if a slot is still unfilled.

## PPTX generation and validation — what could and couldn't run here

`pptxgenjs` was not actually preinstalled on this Windows machine, despite the pptx skill documenting it
as preinstalled (that assumption evidently holds for a different, Linux-sandboxed execution context) —
installed it locally in the session scratchpad per the skill's own documented fallback
(`npm install pptxgenjs`), not inside this repository.

- **Schema/relationship/content-type validation** (`scripts/office/validate.py`): ran clean —
  `All validations PASSED!` — after working around a Windows console-encoding issue
  (`PYTHONUTF8=1` was needed for two slides' unicode punctuation; this was the validator's own console
  handling on Windows, not a defect in the generated file).
- **Content QA**: performed via a direct `python-pptx` text-and-notes dump, cross-checked against the
  deck source markdown — all 16 slides present, correct order, no placeholder/lorem/TODO text.
- **Visual (rendered-image) QA — could NOT be performed.** No LibreOffice is installed on this machine
  (`soffice` not found anywhere), no Microsoft Office/PowerPoint is installed either, and the pptx
  skill's own `soffice.py` wrapper assumes a Linux sandbox (`socket.AF_UNIX`, which doesn't exist on
  native Windows) so it could not run here even if LibreOffice were present. This is stated as an honest
  tooling limitation, not silently skipped. In its place: every slide's shape coordinates were manually
  checked against the 13.333"×7.5" canvas for overflow/overlap risk (documented reasoning kept in this
  session's working notes, not repeated here) — but nobody has looked at an actual rendered image of
  this deck yet.

**Recommended before the first real presentation**: open the `.pptx` in real PowerPoint (or upload to
Google Slides) once, specifically to catch anything the schema validator and manual math check can't —
text overflow, spacing, and genuine visual polish.

## Validation this session ran

- `git status` checked before (clean) and after (`docs/presentation/` new, `README.md` and
  `docs/DEMO_SCRIPT.md` modified — nothing else touched, `docs/codex/` untouched).
- A git-grep secret-pattern sweep using CI's own patterns, across every new/changed file including the
  binary `.pptx` — clean.
- A relative-link resolution check across every markdown cross-link added this phase — all resolve.
- No backend or frontend code was changed (only two documentation cross-link edits), so no test/evaluator
  run was required or performed.
- `backend/.env` (or any real `.env`) was never read, printed, or referenced.

## CI result

See `docs/ai/STATE.yaml` `validation.ci` for current status — update this section once the push has been
watched to a terminal result.

## Honest gaps

- **PR #17 (Phase 9A) is not yet merged** — this branch will need a rebase onto `main` once it is,
  before this ticket's own PR is opened. See the discrepancy note at the top of this document.
- **No screenshots captured** — `SCREENSHOT_PLAN.md` is ready for the next session that has a running
  local stack.
- **No visual (rendered-image) QA was possible in this environment** — the deck passed every automated
  check available here, but a human should open it in real PowerPoint once before presenting.
- **No independent review yet.** Per this project's own rule ("do not review your own final work as the
  only reviewer"), an independent pass is recommended before treating this deliverable as final — and is
  especially valuable given the visual-QA gap above.
- No landing/showcase page was built — `LANDING_PAGE_PLAN.md` explains why and what would trigger
  building one.

## Recommended next phase

Per the user's own instruction for this ticket: merge Phase 9A (PR #17), then this ticket (once rebased),
then a Codex/independent pass and a manual open-in-PowerPoint visual check, then a final rehearsal ahead
of the actual PKCERT presentation.

## Protected boundaries

- Do not redo completed work without evidence.
- Do not change architecture without updating `DECISIONS.md`.
- Do not expose secrets or absorb unrelated changes.
- `docs/codex/` is a foreign path this session did not touch — leave it alone unless its owner asks.
- `backend/.env` (and any non-`.env.example` env file) must never be read, printed, or committed.
- No product feature was added this phase.
