# Handoff: TNX-P9B1-PREMIUM-PRESENTATION-REDESIGN

- From: claude
- Suggested next writer: claude (in progress)
- Branch: feat/phase-9b1-premium-presentation-redesign
- Updated: 2026-08-09T22:11:27Z

## Start-gate state — read this first

The user's own instruction assumed PR #17 (Phase 9A) might still be pending and told this ticket to
stop and report if Phase 9A/9B branches weren't merged correctly. By the time this ticket started, PR
#17 had already merged into `main`. `feat/phase-9b-presentation-assets` (the Phase 9B ticket) had **no
PR opened** and was still based on the pre-merge Phase 9A tip — exactly the state its own handoff had
predicted and asked for. This ticket completed that pending rebase (clean, no conflicts, force-pushed)
before branching off it, so Phase 9B.1 sits on current `main` + Phase 9B's content. Phase 9B's PR is
still not opened — that remains open work for whoever merges next, not something this ticket did.

## A mid-session recovery worth knowing about

The first rebase attempt on `feat/phase-9b-presentation-assets` failed because the Phase 9B `.pptx` was
open in PowerPoint at the time (Windows file lock) — `git rebase --abort` then failed for the same
reason, and briefly left the working tree with `docs/presentation/` fully untracked. Asked the user to
close the file, then manually restored the tracked blob (`git checkout HEAD -- <path>`) before
retrying. No commits or content were lost; documented here so the pattern is recognizable if it
recurs — "rebase/abort both fail claiming an untracked file would be overwritten" almost always means
something on the host still has that exact path open.

A second, unrelated tooling mistake happened later: an `npm install pptxgenjs` meant for the session
scratchpad ran against the repo root instead (a Bash-tool working-directory persistence quirk),
leaving an untracked `node_modules/`, `package.json`, and `package-lock.json` at the repo root, plus
two stray `markitdown`-dump text files. All were confirmed untracked (`git ls-files` on each returned
nothing) before deletion — nothing was ever staged or committed. Worth a beat of caution: after any
`cd <scratch-dir> && npm install ...` compound command in this tool, verify `git status` shows nothing
new at the repo root before trusting the next command's working directory.

## Goal

Redesign the Phase 9B presentation package — a correct but plain, documentation-export-style deck —
into a polished, modern, PKCERT-ready 17-slide deck: dark visual system, real diagrams instead of text
walls, an animation cue sheet, and a "Meet the team" slide. Presentation assets only, no product
features, no code changes.

## What this ticket changed

`docs/presentation/`:

1. **`ThreatNeXus-PKCERT-Deck.md`** — restructured to the exact 17-slide topic list the instruction
   specified (added "Live product surface" and "Meet the team"; folded the old standalone "Role model"
   slide's one point — no role inherits another's authority — into the Security Controls slide, since
   a dedicated slide for it was no longer in the required list). Every fact still traces to
   already-documented repo content; nothing new was invented.
2. **`ThreatNeXus-PKCERT-Deck.pptx`** — fully regenerated. Dark, near-black canvas (`#0A1210`)
   throughout rather than Phase 9B's alternating dark/light sandwich; government-green (`#35C477`) as
   the one sharp accent; real diagrams built as shapes — a 7-step workflow chain, a 6-card provider
   grid, a 4-box architecture chain with a branching provider-adapter node, a numbered demo-beat list,
   stat callouts. Speaker notes embedded on every slide.
3. **`build-deck.js`** (new) — the `pptxgenjs` generator itself, committed to the repo rather than
   left as an ephemeral session script (Phase 9B's generator never made it into the repo). Editing the
   deck now means editing this script's matching slide block and regenerating, not hand-editing the
   binary or re-deriving the generator from scratch next time.
4. **`SPEAKER_NOTES.md`** — rewritten to match the 17-slide structure.
5. **`ANIMATION_CUE_SHEET.md`** (new) — exact manual PowerPoint animation instructions (title reveal,
   provider-stack stagger, workflow step reveal, architecture build-up, demo-sequence transition, team
   entrance, closing emphasis) plus a reduced-motion/static fallback note. **No animation is baked into
   the generator** — `pptxgenjs` 4.0.1's type definitions were checked directly and expose no
   transition/entrance-animation API, so faking one would have silently done nothing or corrupted the
   file. This matches the instruction's own explicit fallback rule.
6. **`SCREENSHOT_PLAN.md`** — slide-number references remapped to the new structure. Still zero
   screenshots captured — see "Screenshots still not captured" below.
7. **`STYLE_GUIDE.md`** — a second real research pass (2025 SOC/cybersecurity pitch-deck structure,
   pitch-deck typography/visual-hierarchy conventions, the `pptx` skill's own design guidance),
   recorded as inspiration notes; the dark-throughout visual-system decision and its reasoning; the
   deliberate Calibri-over-IBM-Plex typography trade-off (portability over brand-matching a font, since
   the reused color tokens already carry the brand link).
8. **`PPTX_BUILD_NOTES.md`** (new) — what changed from Phase 9B, tooling and why, what was validated,
   and the honest visual-QA gap.

`README.md` — status heading, the 9B table row, the roadmap line, and the slide count (16 → 17)
updated. No other section touched.

## The research pass (real, not fabricated)

On top of Phase 9B's own research (still recorded, unchanged): a `WebSearch` for 2025
cybersecurity/SOC product pitch-deck structure conventions, a `WebSearch` for pitch-deck typography and
visual-hierarchy conventions, and a read of the `pptx` skill's own design-guidance section (a
legitimate internal reference, not an external source). Extracted structural patterns only — a locked
three-tier typography system, "one dominant color / one sharp accent / one repeated motif," and an
explicit list of AI-slide anti-patterns (accent lines under titles, color bars, sidebar stripes) that
are now hard rules for this deck. Explicitly **not** applied: TAM/SAM/SOM market sizing, a competitive
2×2 matrix, social proof/testimonials, a fundraising close — all standard for an *investor* deck, none
of it fits a PKCERT technical-review audience, and this was already ruled out in Phase 9B's own style
guide. Nothing — no wording, layout, asset, or diagram — was copied from anything consulted.

## Screenshots still not captured

Same root cause as Phase 9B: no reachable Docker daemon in this environment, so no local stack to
capture from. Not escalated into a debug session, per the standing instruction not to do that without
approval. Every slot in `SCREENSHOT_PLAN.md` remains an exact, capturable placeholder with instructions
— the deck's own placeholder framing (Slide 6, and in speaker notes) tells the presenter exactly what
to say if a slot is still unfilled at presentation time.

## PPTX generation and validation — what could and couldn't run here

Same environment constraints as Phase 9B, confirmed fresh rather than assumed carried-over:

- **Schema/relationship/content-type validation** (`scripts/office/validate.py`): PASSED clean,
  requiring `PYTHONUTF8=1` for the same Windows console-encoding quirk Phase 9B hit (the validator's
  own console handling, not a file defect).
- **Content QA**: a direct `markitdown` text-and-notes dump cross-checked against the deck source
  markdown — all 17 slides present, correct order, no placeholder/lorem/TODO text.
- **Banned-phrase / overclaim sweep** (new this phase, not run explicitly in Phase 9B): grepped the
  rendered deck text and every changed presentation markdown file against `STYLE_GUIDE.md`'s banned
  words and phrasing guardrails. Every match was a guardrail statement itself (e.g. speaker notes
  telling the presenter what *not* to say) — no real violation in visible or spoken content.
- **Manual coordinate-math QA**: every shape/text-box `(x, y, w, h)` in `build-deck.js` checked by hand
  against the 13.333"×7.5" canvas. Found and fixed one real issue — a 0.05" box-region overlap between
  a stat number and its label on the Validation slide — before the final build.
- **Visual (rendered-image) QA — could NOT be performed**, confirmed directly: no `soffice` binary
  anywhere on this machine, no LibreOffice install directory, no Microsoft Office/PowerPoint found
  either. The `pptx` skill's own `thumbnail.py`/`soffice.py` both require LibreOffice, so they could
  not run regardless of the AF_UNIX-on-Windows issue Phase 9B also hit. Stated as an honest tooling
  limitation, not silently skipped — the manual coordinate-math pass above is the substitute, but
  nobody has looked at a rendered image of this deck yet.

**Recommended before the first real presentation**: open the `.pptx` in real PowerPoint (or upload to
Google Slides) once, specifically to catch text overflow, spacing, and genuine visual polish the schema
validator and manual math check can't see. Calibri was chosen specifically to minimize this risk (it
ships with every current Office install and won't silently substitute), but it doesn't eliminate the
need for one real look.

## Validation this session ran

- `git status` checked before (clean) and after (the nine files listed above — nothing else touched,
  `docs/codex/` untouched, no code file anywhere in the repo changed, no `package.json` anywhere in the
  repo touched).
- A git-grep secret-pattern sweep using CI's own patterns, across every new/changed file including the
  binary `.pptx` — clean.
- A relative-link resolution check across every markdown cross-link added or changed this phase — all
  resolve.
- `backend/.env` (or any real `.env`) was never read, printed, or referenced.
- Explicit paths staged for the commit — `git add -A` was never used.

## CI result

Committed `9f05ffd`, pushed. Run
[31338658950](https://github.com/haiderchattha99-ali/ThreatNeXus/actions/runs/31338658950) — **all
required jobs green on the first push**: frontend lint/tests/build, secrets scan, schema/migration,
core evaluators, backend tests against real PostgreSQL, and the Chromium browser suite. Expected for a
docs/assets-only change. "Mutation and concurrency gates" is manual-trigger-only and was not run — not
required for this ticket.

## Honest gaps

- **Phase 9B's own PR is still not opened.** Not this ticket's job to open it, but whoever merges next
  needs to account for both `feat/phase-9b-presentation-assets` and this branch.
- **No screenshots captured** — same as Phase 9B; `SCREENSHOT_PLAN.md` is ready for the next session
  that has a running local stack.
- **No visual (rendered-image) QA was possible in this environment** — the deck passed every automated
  and manual check available here, but a human should open it in real PowerPoint once before
  presenting.
- **No independent review yet.** Per this project's own rule ("do not review your own final work as
  the only reviewer"), an independent pass is recommended before treating this deliverable as final —
  and is especially valuable given the visual-QA gap above, on top of Phase 9B's own still-unreviewed
  status.

## Recommended next phase

Per the user's own instruction for this ticket: do not open a PR, do not merge to main. Recommended
next: a manual open-in-PowerPoint visual check, an independent reviewer pass covering both this deck
and the Phase 9B branch underneath it, then opening PRs for both (Phase 9B first, since this branch
depends on its content) ahead of the actual PKCERT presentation.

## Protected boundaries

- Do not redo completed work without evidence.
- Do not change architecture without updating `DECISIONS.md`.
- Do not expose secrets or absorb unrelated changes.
- `docs/codex/` is a foreign path this session did not touch — leave it alone unless its owner asks.
- `backend/.env` (and any non-`.env.example` env file) must never be read, printed, or committed.
- No product feature was added this phase. No `package.json` anywhere in the repo was touched.
