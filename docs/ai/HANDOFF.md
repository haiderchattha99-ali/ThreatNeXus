# Handoff: TNX-P9C-PKCERT-TECHNICAL-DOSSIER

- From: claude
- Suggested next writer: unassigned
- Branch: docs/phase-9c-pkcert-technical-dossier
- Updated: 2026-08-10T05:20:00Z

## Start-gate state — read this first

The user's own instruction assumed this ticket might need to stop if Phase 9B.1 wasn't actually merged,
another writer was active, or unfamiliar tracked changes existed. None of those blockers applied: local
`main` was already at `c3f8a4b`, exactly matching `origin/main`; the merge commit for PR #18 (Phase 9B.1)
was directly visible in `git log`; no `.ai-team/WRITER_LOCK.json` exists (no active writer); and every
tracked file was clean. The only untracked paths present were the ones the ticket explicitly named as
pre-existing and to be preserved (`deliverables/`, `tmp/`, `.claude-flow/`, `docs/TEAM_STUDY_GUIDE.*`,
`.claude/proven-config*`) — none of them were touched, staged, or read beyond `git status` itself.

## A tooling gap worth knowing about: the writer-lock script and the preserved untracked paths

`F:\Ismail-AI-Dev-Team\scripts\start-task.ps1` was attempted per the ticket's instruction. It refused
with "Working tree is not clean," listing exactly the untracked paths above. This is a *new* trigger for
an *already-documented* gap (every phase since 8B has recorded that this repository has no working
`.ai-team/WRITER_LOCK.json` mechanism against its current `STATE.yaml` schema) — this time the blocker
was `Assert-TeamClean`, not the schema mismatch itself. The ticket's own fallback instruction covers this
exactly: verify no active writer exists (confirmed — `.ai-team/` is empty) and proceed under manual
single-writer discipline. Forcing the script to pass would have meant staging or moving the very paths
this ticket was told to preserve, which was correctly not done.

## A real mistake this session made and corrected — read before trusting `git branch --show-current` blindly

After committing the dossier, `git branch --show-current` reported `main`, not
`docs/phase-9c-pkcert-technical-dossier`. `git reflog` showed an unexplained
`checkout: moving from docs/phase-9c-pkcert-technical-dossier to main` between the branch's creation and
the commit — the root cause was not identified with certainty; no destructive git command appears in the
session's own command history, so this may be worth watching for if it recurs. **This was caught before
any push**, and was corrected as a pure local ref move, not a content recovery:

```
git branch -f docs/phase-9c-pkcert-technical-dossier f1ba4d6   # move the commit onto the right branch
git checkout docs/phase-9c-pkcert-technical-dossier
git branch -f main c3f8a4b                                      # restore main to exactly origin/main
```

Verified after: `main` at `c3f8a4b` (byte-identical to `origin/main`), the feature branch at `f1ba4d6`
with the dossier commit, and `git status` clean. `origin/main` was never touched — only local refs moved,
and only before the first push of this session. A future writer in this repository should get in the
habit of checking `git branch --show-current` immediately before `git commit`, not only when something
already looks wrong.

## Goal

Produce **one synthesized, controlled, software-house-style technical dossier** for ThreatNeXus — not a
concatenation of the existing `docs/*.md` package or the Phase 9C export bundle in `deliverables/`.
Unified structure, reconciled facts, document control, an SRS, architecture with real diagrams,
deployment, operations, security, provider integration, AI governance, testing, an API catalogue, and a
truthful production-readiness gap analysis — for a PKCERT technical reviewer, print-ready.

## What this ticket changed

`docs/delivery/` (new):

1. **`ThreatNeXus-PKCERT-Technical-Dossier.md`** — the canonical editable source, ~1,950 lines / ~16,600
   words, 13 parts exactly matching the ticket's required structure. Every requirement uses a stable ID
   (`TNX-FR-*`, `TNX-NFR-*`, `TNX-SEC-*`, `TNX-AUD-*`, `TNX-ROLE-*`) and is labeled Implemented or
   Production requirement — never both, never guessed.
2. **`ThreatNeXus-PKCERT-Technical-Dossier.pdf`** — 63 pages, A4, page numbers, a clickable generated
   table of contents, and PDF bookmarks for all 145 headings. Every page was rendered to PNG and visually
   inspected (see "Visual QA" below).
3. **`build-dossier.mjs` + `lib/{diagram.py,render_html.py,add_bookmarks.py,render_qa_pages.py}`** — the
   reproducible generator. Markdown → HTML (`markdown-it-py`) → PDF with page numbers (Chrome's DevTools
   Protocol, driven directly with Node's built-in `fetch`+`WebSocket` — no `puppeteer` dependency) → PDF
   bookmarks (`pypdf`, already installed). Isolated from `backend/`/`frontend/`; no application dependency
   was added.
4. **`DOSSIER_BUILD_NOTES.md`** — source reconciliation, design decisions (including the three real
   rendering defects found and fixed — see below), toolchain discovery, validation performed, honest
   tooling gaps, regeneration instructions.
5. **`.gitignore`** — excludes `.build/` (generated HTML/PDF/QA-render intermediates) and `__pycache__/`,
   the same convention `frontend/dist` already follows in this repository.

`README.md` and `docs/DELIVERY.md` — one row / one addendum section each, pointing at the new dossier. No
other section of either file was touched.

## Diagrams: three real defects found by actually rendering every page, not by reading text

The first build produced diagrams by auto-stacking nodes in a single row or column and letting the SVG
scale to fill the print column. Rendering every page to PNG and looking at them (not just extracting text
or checking page count) surfaced three real problems, in order of severity:

1. **Vertical chains with 7–9 nodes rendered taller than one printed page** and split mid-diagram across
   two or three pages, leaving a fragment stranded at the top of a page. Fixed by capping the rendered
   size to fit one page and, for the two worst diagrams, merging adjacent steps into fewer nodes.
2. **Branch/merge edges (a fan-out to three outcomes, an on/off switch, a 401/403 refusal path) drew
   straight lines through unrelated boxes** sitting between the logical source and target, because the
   layout only supported adjacent-index connections. Fixed by moving from auto-stacking to explicit
   per-node grid coordinates (`col`/`row` in each diagram's fence) plus a direction-aware connector that
   picks the correct box edges regardless of which node is graph-source vs. visually-first. The trust-
   boundaries diagram (a genuine hub pattern) is the clearest example — it now renders as a backend hub
   with four clean spokes.
3. **An edge label's background rectangle was wider than the gap between two closely-spaced boxes**,
   overlapping their text. Fixed by shortening the two worst labels, shrinking the label font, and
   widening the grid gap.

Full detail, including the exact before/after, is in `DOSSIER_BUILD_NOTES.md` under "Design decisions."
**Any future diagram edit should be rendered and inspected before being trusted** — none of these three
defects were visible in a text-extraction check.

## Fact reconciliation — what was checked against code, not prose

- **API route catalogue** (Appendix 13.2): read directly from all 25 files in `backend/src/routes/` plus
  the capability grant map in `backend/src/lib/roles.js` — not copied from `docs/API_CONTRACT_PHASE0.md`,
  which is explicitly labeled partial (Phase 0 surface only) in the dossier itself.
- **Migration count**: 23, counted directly from `backend/prisma/migrations/`, matching CI's own frozen
  list.
- **Backend test count**: `docs/TESTING_AND_CI.md`'s "3071 passed / 177 skipped, as of Phase 8F" figure
  was reconfirmed by exact file-count parity (145 files, counted directly) rather than re-executed — no
  backend code has changed since Phase 8F, and this documentation-only session did not stand up a live
  PostgreSQL instance. Labeled explicitly as "verified at commit `c3f8a4b`, reconfirmed by file-count
  parity" in Part 11, §11.2, per the ticket's own "label it, don't guess it" rule.
- **Env vars, provider list, rate-limit defaults, CI job list**: read directly from
  `backend/.env.example`, `docker-compose.yml`, and `.github/workflows/ci.yml`.

## Validation this session ran

- `pdfinfo`: 63 pages, A4, PDF 1.4, not encrypted, no JavaScript, no forms, clean metadata.
- `pdftotext -layout` sweep over the full document: zero matches for banned marketing language,
  TODO/FIXME/lorem-ipsum, CI's own credential-shaped-literal patterns, stray AI-tool-name tokens, or
  GIKI/watermark references.
- All 145 headings resolved to a bookmark page.
- **Every one of the 63 pages rendered to PNG and visually inspected** — two full cycles, because the
  first surfaced the three diagram defects above.
- Grayscale contrast check on three representative pages (cover, a diagram page, a dense table page).
- `git status` reviewed before and after; a dry-run `git add -n` reviewed before the real `git add`.
- Two stray artifacts were found inside `docs/delivery/` before staging and removed: a `.claude-flow/`
  telemetry write and a Python `__pycache__` directory — the same class of trap the prior Phase 9C
  export-package session documented for the same reason (background tooling in this environment writes
  into whatever directory is current). Confirmed absent from the final `git add --dry-run` output before
  the real add.
- `backend/.env` was never opened, read, printed, or referenced — only `backend/.env.example`.
- No product code, Prisma schema, migration, or `package.json` anywhere in the repo was touched.

## CI result

Committed `f1ba4d6` (after the branch correction above), pushed to
`docs/phase-9c-pkcert-technical-dossier`. Run
[31343446063](https://github.com/haiderchattha99-ali/ThreatNeXus/actions/runs/31343446063) — **all six
required jobs green on the first push**: hygiene, schema, backend tests against real PostgreSQL, frontend
lint/tests/build, the Chromium browser suite, and the core evaluators. "Mutation and concurrency gates" is
manual-trigger-only and correctly did not run.

## Honest gaps

- **No independent review yet.** Per this project's own rule ("do not review your own final work as the
  only reviewer"), an independent pass — ideally from Codex, per this repo's usual reviewer assignment —
  is recommended before this dossier is treated as final for an actual PKCERT review meeting.
- **The backend/evaluator test count was reconfirmed by file-count parity, not re-executed live** (see
  above) — stated in the dossier itself, not smoothed over.
- **The PKCERT logo was not embedded** on the cover, to avoid reading or staging anything under the
  protected `docs/codex/` path. The cover uses a plain text "PKCERT" kicker instead. If `docs/codex/`'s
  owner authorizes copying `assets/pkcert-logo.png` out to a location this ticket can read, a future
  session could embed the real mark.
- **The diagram renderer has no collision detection** — see "Diagrams" above. Treat it as a small,
  purpose-built tool for exactly these ten diagrams, not a general one.
- **The mid-session branch mix-up's root cause was not fully identified** — see the dedicated section
  above. No content was lost and nothing was ever pushed to the wrong branch, but it is recorded honestly
  rather than glossed over.

## Recommended next action

None required to close this ticket — CI is green, the branch is pushed, and every protected path
(`docs/codex/`, `deliverables/`, `tmp/`, `.claude-flow/`, `docs/TEAM_STUDY_GUIDE.*`) is untouched. Per the
ticket's own instruction: **do not open a pull request, do not merge to `main`.** Recommended before the
dossier is used in an actual PKCERT-facing meeting: an independent reviewer pass, and a decision on
whether to embed the real PKCERT logo.

## Protected boundaries

- `docs/codex/` is a foreign path this session did not touch (verified via `git status --porcelain
  docs/codex`, empty output) — leave it alone unless its owner asks.
- `backend/.env` (and any non-`.env.example` env file) must never be read, printed, or committed.
- `deliverables/`, `tmp/`, `.claude-flow/`, `docs/TEAM_STUDY_GUIDE.{md,pdf}`, and
  `.claude/proven-config*` are pre-existing, separately authorized artifacts this ticket was told to
  preserve — none were staged, modified, or deleted.
- No product feature was added this phase. No `package.json` anywhere in the repo was touched. No
  application runtime dependency was added — the dossier generator uses only already-installed tooling
  (`markdown-it-py`, `pypdf`, Pillow, Poppler, Chrome, Node's built-in `fetch`/`WebSocket`).
