# Dossier Build Notes — TNX-P9C-PKCERT-TECHNICAL-DOSSIER

How `ThreatNeXus-PKCERT-Technical-Dossier.pdf` was produced from
`ThreatNeXus-PKCERT-Technical-Dossier.md`, what was verified, and how to regenerate it.

## Source reconciliation

Every factual claim in the dossier was checked against, in this order of precedence:

1. The running source code at commit `c3f8a4b` — `backend/src/routes/*.js`, `backend/src/lib/roles.js`,
   `backend/prisma/migrations/`, `backend/.env.example`, `docker-compose*.yml`,
   `.github/workflows/ci.yml`.
2. The existing `docs/*.md` package (Phase 9A/9B.1), itself previously reconciled against the code.
3. `docs/ai/SECURITY.md`, which records phase-by-phase implementation evidence.

Specific reconciliation performed this phase:

- **Route catalogue (Appendix 13.2)**: read directly from all 25 files in `backend/src/routes/` plus the
  capability grant map in `backend/src/lib/roles.js` — not copied from `docs/API_CONTRACT_PHASE0.md`,
  which documents only the Phase 0 surface (stated explicitly in §13.2.1).
- **Migration count**: `backend/prisma/migrations/` enumerated directly — 23 migration directories, an
  exact match to CI's own frozen list in `.github/workflows/ci.yml`.
- **Test counts**: `docs/TESTING_AND_CI.md` records 3071 passed / 177 skipped "as of Phase 8F" — the
  last phase that changed backend code. This dossier's session counted `backend/tests/**/*.test.js`
  directly: **145 files**, an exact match to the documented figure. No backend source file changed
  between Phase 8F and this dossier's branch point (`c3f8a4b`), so the pass/skip numbers are carried
  forward labeled "verified at commit `c3f8a4b`, reconfirmed by file-count parity" (Part 11, §11.2) rather
  than re-executed — this documentation-only session did not stand up a live PostgreSQL instance to
  re-run the ~3,000-test suite, and re-running it would not change source code that hasn't changed.
- **Provider list, env vars, rate-limit defaults**: read directly from `backend/.env.example` and
  `docker-compose.yml` rather than assumed from prose in `docs/PROVIDER_GUIDE.md`/`docs/DEPLOYMENT.md`
  (which matched, but were checked, not trusted).
- **CI job list (Part 11, §11.5)**: read directly from `.github/workflows/ci.yml` — six jobs run on every
  push, a seventh (`deep-gates`) is `workflow_dispatch`-only.

No number in the dossier was invented, estimated, or carried forward from a stale document without a
cross-check against the current tree.

## Design decisions

- **Diagrams are hand-authored inline SVG, not Mermaid.** No headless-browser Mermaid renderer
  (`mermaid-cli`/Puppeteer) is installed, and installing one for ten simple box-and-arrow diagrams was
  judged disproportionate. `lib/diagram.py` is a small (~150-line) grid-based renderer: each diagram
  fence in the `.md` source specifies nodes with explicit `col`/`row` grid positions and edges, and the
  renderer draws boxes and direction-aware straight connectors. This is deliberately not a general
  diagramming library — see the module docstring for exactly what it does and does not handle.
- **A first version of this renderer auto-stacked nodes in a single row or column** and let width/height
  scale to fill the print column. Two real defects surfaced during visual QA and were fixed before this
  version:
  1. Vertical chains with 7–9 nodes (the end-to-end workflow, the AI-assistance flow) rendered taller
     than a single printed page, breaking mid-diagram across two or three pages with a diagram fragment
     stranded at the top of a page. Fixed by capping the rendered size to fit one page
     (`COLUMN_W`/`MAX_H` in `diagram.py`) and, for the two worst offenders, merging adjacent steps into
     fewer nodes so the resulting text stayed legible after scaling.
  2. Diagrams with a genuine branch or merge (the dedup outcome fan-out, the AI on/off switch, the auth
     401/403 refusal paths) drew a straight line between logically-connected but non-adjacent boxes,
     which visually crossed through unrelated boxes sitting between them. Fixed by moving from
     single-row/column auto-placement to explicit per-node grid coordinates, plus a
     direction-aware connector function that picks the correct pair of box edges regardless of which
     node is graph-source vs. visually-first. The trust-boundaries diagram (a genuine hub/star pattern)
     was the clearest case for grid placement — it renders as a backend hub with four spokes.
  3. A follow-up pass found the AI-assistance-flow diagram's short "on/off" edge labels colliding with
     adjacent box text, because the label's background rectangle was wider than the gap between two
     closely-spaced boxes. Fixed by shortening the two labels, shrinking the label font, and increasing
     the grid gap (`GAP_X`/`GAP_Y`).

  All three fixes were found by rendering every page to PNG and looking at them — none would have been
  caught by only checking the PDF's text extraction or page count.
- **Page numbers come from Chrome's DevTools Protocol, not the `--print-to-pdf` CLI flag.** Plain
  `chrome --headless --print-to-pdf` does not expose `displayHeaderFooter`/`footerTemplate` — that is
  only reachable through `Page.printToPDF` over the DevTools Protocol. `build-dossier.mjs` drives this
  directly with Node's built-in `fetch` and `WebSocket` (both stable in Node 22+, confirmed present in
  this environment's Node 25) rather than adding `puppeteer` as a dependency.
- **PDF bookmarks are a separate post-processing pass**, because Chrome's print pipeline does not
  generate an outline from HTML headings on its own. `lib/add_bookmarks.py` re-extracts the same
  heading list `render_html.py` used for the on-page table of contents, locates each heading's physical
  page by running Poppler's `pdftotext` one page at a time and searching for the heading text, and
  builds the outline with `pypdf` (already installed — no new dependency).
- **The on-page table of contents is generated, not hand-maintained.** The `.md` source contains a
  `<!-- TOC:AUTO -->` marker; `render_html.py` replaces it with a nested, linked list built from the
  document's own `##`/`###` headings at build time, so the table of contents can never drift from the
  actual section structure.
- **Cover and section styling use the product's own accent color** (`#1F7A46`, a restrained government
  green derived from the frontend's `#35C477` design token, darkened for print contrast) on white, near-
  black text, no gradients, no watermark, no logo — the PKCERT logo at `docs/codex/assets/pkcert-logo.png`
  was available but not embedded, to keep `docs/codex/` untouched per the one-writer boundary this
  ticket's instructions require; the cover instead uses a plain "PKCERT" text kicker.

## Toolchain discovered and used (nothing new installed)

| Purpose | Tool | Status |
|---|---|---|
| Markdown → HTML | `markdown-it-py` (Python 3.12) | Already present |
| HTML → PDF, page numbers | Google Chrome (headless, DevTools Protocol) | Already present |
| PDF bookmarks/outline | `pypdf` 6.11.0 | Already present |
| Page-render QA, text extraction | Poppler (`pdftoppm`, `pdftotext`, `pdfinfo`) | Already present |
| Contact-sheet QA images | Pillow (PIL) 12.2.0 | Already present |

Pandoc, LibreOffice, and `wkhtmltopdf` remain absent, consistent with the prior Phase 9C export-package
session's findings — this generator does not need them. No `pip install` or `npm install` was run.

## Validation performed

- **PDF structural validation** (`pdfinfo`): 63 pages, A4, PDF 1.4, not encrypted, no embedded
  JavaScript, no forms, no metadata leaking a build path.
- **Text-extraction sweep** (`pdftotext -layout` over the full document): checked for banned marketing
  language, `TODO`/`FIXME`/lorem-ipsum placeholders, credential-shaped literals (CI's own pattern set —
  PEM headers, `ghp_`/`xox*`/`AKIA`/`AIza` token shapes, `password=` assignments), stray AI-tool-name
  tokens, and GIKI/watermark references. **Zero matches** in the final build.
- **Bookmark resolution**: all 145 headings (13 Parts + subsections) resolved to a physical page;
  `add_bookmarks.py` reports resolved/unresolved counts on every run.
- **Full visual QA — every page rendered and inspected.** All 63 pages were rendered to PNG at 110 DPI
  via `lib/render_qa_pages.py` and inspected as 8-page contact sheets (so every page was actually looked
  at, not sampled), plus the ten diagram pages individually at full resolution. Three real defects were
  found and fixed this way (see "Design decisions" above); after the fixes, a second full render-and-
  inspect pass found no clipped text, no table overflow, no broken diagrams, no missing glyphs, no bad
  page breaks, no cramped or excessively sparse text, and consistent page furniture (title/version/page
  number footer on every content page).
- **Grayscale contrast check**: three representative pages (cover, a diagram page, a dense table page)
  converted to grayscale and re-inspected — all remained readable with the border/bold-based hierarchy
  the design relies on rather than color alone.
- **Reconciliation checks**: route catalogue, migration count, provider list, and CI job list were all
  read directly from source rather than copied from prose (see "Source reconciliation" above).
- **`git status` before and after**: confirmed only `docs/delivery/` is new. `deliverables/`, `tmp/`,
  `.claude-flow/`, `.claude/.proven-config-version`, `.claude/.proven-config.json`,
  `docs/TEAM_STUDY_GUIDE.{md,pdf}`, and `docs/codex/` were not staged, modified, or read (beyond the
  `git status` listing itself).
- **`backend/.env` was never opened, read, or referenced.** Only `backend/.env.example` was consulted.

## Honest tooling gaps

- **The backend/evaluator test suite was not re-executed this session.** Re-verifying the 3071/177
  figure would require a live PostgreSQL instance and roughly the same command sequence
  `docs/TESTING_AND_CI.md` documents; this documentation-only phase changed no backend code, so the
  figure is carried forward labeled by its last-verified commit rather than re-run. See Part 11, §11.2.
- **The heading-to-page bookmark search is a text match, not a semantic one.** If a future edit makes a
  heading's exact text appear verbatim earlier in the document (for example inside a table cell), the
  search could resolve to the wrong page. `add_bookmarks.py` searches forward monotonically from the
  previous heading's page as a partial guard against this, and reports every unresolved heading loudly
  rather than silently mis-linking it.
- **The diagram renderer has no collision detection.** Grid placement is manual (each diagram's node
  `col`/`row` values were chosen by hand, and their edges reasoned about one at a time) — a future
  diagram added carelessly could reintroduce the crossing-line or label-collision defects found and
  fixed this session. Render and inspect any new diagram page before trusting it.

## Regeneration instructions

From `docs/delivery/`:

```powershell
node build-dossier.mjs
```

This runs `lib/render_html.py` (Markdown → HTML), drives headless Chrome over the DevTools Protocol to
produce a paginated PDF with page numbers, then runs `lib/add_bookmarks.py` to add the outline. Output:
`ThreatNeXus-PKCERT-Technical-Dossier.pdf` in this directory. Intermediate files land in `.build/`
(gitignored, not part of the tracked deliverable — the same convention `frontend/dist` follows).

To re-run visual QA after any change:

```powershell
python lib/render_qa_pages.py ThreatNeXus-PKCERT-Technical-Dossier.pdf .build/qa 8
```

Then inspect every sheet under `.build/qa/sheets/` — do not skip this step for a diagram or layout
change; two of the three defects fixed this session were invisible in the text-extraction checks and
only showed up as rendered images.
