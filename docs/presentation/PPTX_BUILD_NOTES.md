# PPTX Build Notes

How `ThreatNeXus-PKCERT-Deck.pptx` is generated, what was validated, and what could not be checked in
this environment. Phase 9B did not create this file (a real `.pptx` was generated successfully that
phase, so the file only needed to exist if generation hadn't been possible). Phase 9B.1 rebuilt the
deck's visual system from scratch and this file now exists as a required deliverable of that phase.

## Tooling

- **Generator**: `docs/presentation/build-deck.js`, a `pptxgenjs` (v4.0.1) script committed to this
  repo — not an ephemeral one-off. Regenerating the deck after an edit to
  `ThreatNeXus-PKCERT-Deck.md` means editing this script's matching slide block, not hand-editing the
  binary `.pptx`.
- **Why a script and not a template**: no existing ThreatNeXus template or prior premium deck existed
  to build from — Phase 9B's deck was itself the first version, and a from-scratch generator gives
  full control over the dark, grid-based visual system Phase 9B.1 needed (see
  `STYLE_GUIDE.md` → "Visual system v2").
- **`pptxgenjs` is not a project dependency.** It is not added to `backend/package.json` or
  `frontend/package.json` — this stays a documentation/assets change, not a code change. To
  regenerate:

  ```bash
  mkdir -p /tmp/tnx-deck-build && cd /tmp/tnx-deck-build
  npm install pptxgenjs
  cp <repo>/docs/presentation/build-deck.js .
  node build-deck.js ThreatNeXus-PKCERT-Deck.pptx
  cp ThreatNeXus-PKCERT-Deck.pptx <repo>/docs/presentation/
  ```

## What changed from Phase 9B

- **17 slides**, restructured to match the required PKCERT-review topic list exactly (added "Live
  product surface" and "Meet the team"; folded the old standalone "Role model" slide's one point into
  Security Controls — see `STYLE_GUIDE.md`'s Phase 9B.1 section for the full reasoning).
- **Dark-throughout visual system** instead of the alternating dark/light "sandwich" — near-black
  canvas (`0A1210`) on every slide, government-green (`35C477`) as the one sharp accent, panel cards
  (`0F1A16`) for depth. Same product design tokens as Phase 9B, applied more consistently.
- **Real diagrams instead of text**: a 7-step workflow chain with connecting arrows (Slide 5), a
  6-card provider grid (Slide 7), a 4-box architecture chain with a branching provider-adapter node
  (Slide 12), a numbered demo-beat list (Slide 13), and stat callouts (Slide 15) — all drawn as
  `pptxgenjs` shapes, not screenshots or embedded images.
- **Speaker notes embedded on every slide** via `slide.addNotes()`, condensed from
  `SPEAKER_NOTES.md`'s "Say" sections — same as Phase 9B's approach, carried forward.
- **`ANIMATION_CUE_SHEET.md`** (new this phase) documents manual PowerPoint animation instructions —
  see that file for why `pptxgenjs` itself was not used for animation (its installed version exposes
  no transition/entrance-animation API; confirmed against the type definitions before writing this
  note, not assumed).

## Validation performed

- **Schema/relationship/content-type validation** (`scripts/office/validate.py` from the `pptx`
  skill): `All validations PASSED!` on the final build. Required `PYTHONUTF8=1` to avoid a Windows
  console-encoding artifact when the validator prints its own summary — a console-display issue on
  this machine, not a defect in the generated file (same as Phase 9B).
- **Content QA**: `markitdown` text-and-notes dump cross-checked against `ThreatNeXus-PKCERT-Deck.md`
  — all 17 slides present, correct order, no placeholder/lorem/TODO text (checked with the skill's own
  grep pattern).
- **Banned-phrase / overclaim sweep**: grepped the rendered deck text and every presentation markdown
  file against `STYLE_GUIDE.md`'s banned-word list and the AI/provider/PKCERT phrasing guardrails. The
  only matches were the guardrail statements themselves (e.g. speaker notes instructing "never say 'AI
  decides'") — no actual violation found in visible or spoken content.
- **Manual coordinate-math check**: every shape and text box's `(x, y, w, h)` in `build-deck.js` was
  checked by hand against the 13.333"×7.5" canvas for boundary overflow and inter-element overlap
  (margins, chain-diagram widths, card grids, stat-callout spacing). One real issue was found this way
  — a 0.05" box-region overlap between a stat number and its label on Slide 15 — and fixed before the
  final build.

## What could not be validated in this environment

- **Visual (rendered-image) QA was not possible.** No LibreOffice (`soffice`) and no Microsoft
  Office/PowerPoint are installed on this Windows machine, and the `pptx` skill's own `soffice.py`
  wrapper and `thumbnail.py` script both require it — confirmed by checking for the binary directly,
  not assumed from documentation. This is the same honest gap Phase 9B recorded, and it recurred
  identically this phase because the environment did not change.
- **Recommended before the first real presentation**: open the `.pptx` in real PowerPoint (or upload
  to Google Slides) once, specifically to check text fit, spacing, and genuine visual polish that only
  a rendered view can catch. The manual coordinate-math check above catches boundary overflow but
  cannot catch font-substitution-driven text wrap on an unfamiliar machine — mitigated by choosing
  Calibri (ships with every current Office install) for all deck text, but not eliminated.
- **No independent review of this deck yet.** Per this project's own rule ("do not review your own
  final work as the only reviewer"), an independent pass is recommended before treating this
  deliverable as final.
