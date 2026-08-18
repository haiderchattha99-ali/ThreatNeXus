# Handoff: TNX-FINAL-FRONTEND-POLISH

- From: claude
- Suggested next writer: unassigned — pass complete, PR open
- Branch: `polish/final-frontend-pass` (from `origin/main` @ `702afee`)
- Worktree: `F:\AI-Worktrees\ThreatNeXus\frontend-polish` (isolated — the primary checkout was never touched)
- Writer lock: **released**
- Updated: 2026-08-19

> Note for any future writer: `handoff-task.ps1` overwrites this file with a five-line template on
> every run. If you run it, restore the detail below from the prior commit afterwards — the template
> alone loses the root cause, the evidence and the traps.

**Status: complete.** One bounded pass implementing the five approved recommendations (R1–R5) from
the read-only rendered UI/UX audit performed at `702afee`. Per the brief there is **no second polish
cycle, no further audit, and no post-implementation design review**. The next phase after merge is
professional final documentation.

## What the audit found, and what shipped

The audit's verdict was that the deficits were about **order and language**, not missing evidence.
Everything the product knows was already on screen; it was arranged and worded as though nothing on
it mattered more than anything else.

### R1 — Finding detail, decision-first

`Record triage` was the **last** thing on a ~3,700px page, below a disabled AI panel and a provider
table that is empty in a fresh instance. Reading order is a claim about priority, and that order
claimed the opposite of the truth.

The page now answers, in order: what is this and how bad → what do I do about it → why is it scored
that way → what else is known → optional subsystems.

| Change | Detail |
|---|---|
| Decision summary strip | Five cells above everything: current risk (score at metric size, band beside it), exposure state, observation pressure, owning organization, triage + case linkage |
| Triage promoted | From last panel to **first**, wrapped in a titled Panel that states triage is separate from the OPEN/CLOSED exposure state |
| Section rail | Sticky under the app bar, one anchor per region, every target carrying a `scroll-margin-top` that clears the fixed bar |
| Progressive disclosure | Non-contributing risk factors, enrichment coverage and AI assistance fold into native `<details>` |

**Measured in the rendered app:** triage now sits at **474px on a 2,668px page**.

### R2 — the truth layer, in English (two shipped defects fixed)

**Defect 1 — a dead dictionary.** `FACTOR_LABEL` in `FindingDetail.jsx` was keyed on `EXPOSURE_BASE`,
`IOC_REPUTATION`, `EPSS_PROBABILITY`… while the engine stores `exposureCriticality`,
`iocReputationContext`, `epssScore`. **Not one key ever matched.** The dictionary was dead code and
every factor rendered as its raw camelCase storage key.

The correct dictionary already existed in `components/dashboard/dashboardModel.js`, so the repair is a
move to `constants/riskFactors.js` plus a re-export — one source, not a second copy. That module is
now the only place a stored identifier becomes words: the repaired factor names, ~60 explanation-code
sentences, and a de-casing fallback so a code the engine adds later is legible rather than invisible.

**The raw code is still rendered beside every sentence.** The words are for reading; the code is what
an analyst quotes in a case note. Provenance was added to, not traded away.

**Defect 2 — two refusal dialects.** `ProtectedRoute` rendered its own `403 - Access Denied` card,
bypassing the crafted, accessible `DeniedState` in `ui/States.jsx`. A route refusal and a panel
refusal said the same thing in two different visual and verbal languages. `DeniedState` gained two
optional props (`titleLevel`, `role`) so the route case keeps what was right about the old card — a
real `<h1>`, because it replaces a whole page, and `role="alert"`, because arriving somewhere
unreachable is an unexpected outcome of a deliberate navigation — without forking the component. The
status code survives as a stated fact in the body rather than as a shouted heading.

Also: ownership status and resolver reason codes read as English with their codes intact, and
`FindingTriagePanel` moved off five hardcoded hexes onto tokens — including `#75899E`, the exact
`textFaint` value Phase 6.2 **raised** for contrast and which this component had quietly kept.

### R3 — severity-first, and a row you can actually click

Rows were **not clickable at all** (measured: cursor auto, no handler). The risk band was the quietest
element while status and lifecycle chips shouted, and amber meant three unrelated things in one row.

- Risk v1 leads the row, behind a 3px band-coloured spine (transparent when unscored, so the column
  stays aligned).
- Non-severity badges render `quiet`: the semantic **fill** is dropped, the icon and the words stay.
  Severity is the only colour in a row now, and amber stops meaning three things. Colour was never
  allowed to be the only carrier, so nothing accessible was lost.
- The whole row navigates — and **stands aside twice**: when the click landed on the real link, and
  when text is being selected. An evidence table whose rows swallow a selection is a table you cannot
  copy an IP address out of. A stretched-anchor overlay would have been fewer lines and would have
  taken text selection with it.
- Exactly **one link per row** is preserved; the E2E suite locates a finding by it.
- The dashboard priority queue got the same spine and band-leading treatment.
- Row hover raised from a 4% tint (invisible on a near-black canvas) to 9%, plus a `focus-within`
  band so a keyboard user can see *which row* the focused link belongs to.

### R4 — below-fold dashboard hierarchy, tightly bounded

Two named bands with a hairline and a one-line note — **"Why the risk looks like this"** and
**"Work in flight"**. No panel moved between grids, nothing was re-laid-out or reordered.

### R5 — loading, continuity, and truthful pending state

- Skeletons shaped like the Finding detail and the dashboard they replace, instead of one generic
  three-bar skeleton that made every layout pop into place.
- Scroll resets on pathname change — **hash-aware**, so the R1 section rail still works — because
  opening a finding from halfway down the list used to drop you halfway down the finding.
- A 160ms opacity-only route-continuity animation keyed on pathname. Under reduced motion (OS setting
  or the in-app opt-out) it is **not declared at all**, rather than declared and zeroed.
- Pending is *stated*: `Refreshing` on the button, `aria-busy`, and an in-place status line saying the
  visible values are the last ones the server confirmed. A control that goes quiet without saying why
  reads as broken rather than busy.

## The one thing that must not be lost when a page gets shorter

Folding the non-contributing risk factors away could have quietly flattened the distinction the whole
risk section exists to preserve. So the disclosure **counts them by state in its own summary line**:

> 7 factors added no points — 2 measured and weighed nothing, 2 with no readable evidence, 3 that
> cannot apply here

"Measured and it added nothing", "we could not read the evidence" and "this cannot apply here" are
three different facts that all draw an empty bar. And when **no** factor contributed, nothing is
folded at all — each zero is then the entire answer.

## Gates

| Gate | Result |
|---|---|
| frontend lint | clean — exactly the 6 pre-existing fast-refresh warnings, none new |
| frontend unit | **218 passed**, 17 files (baseline 202/15; +16 new, zero regressions) |
| frontend build | clean |
| Chromium Playwright | **71 / 71**, real backend + real PostgreSQL, rebuilt-from-zero database |
| rendered overflow | **0px** at 390 / 768 / 1024 / 1366 / 1440 — collapsed **and** fully disclosed |
| rendered console | **0 errors, 0 warnings** across ADMIN / ANALYST / REVIEWER / VIEWER |
| backend | `git status --porcelain backend/` empty |
| dependencies | no `package.json` / lockfile change anywhere |

**CI: green on the first push**, at the exact PR tip `5097367` —
[run 32192035942](https://github.com/haiderchattha99-ali/ThreatNeXus/actions/runs/32192035942). All
six required jobs succeeded: Secrets and generated artifacts, Prisma schema and migration history,
Backend tests, Frontend lint/tests/build, Browser suite (Chromium), Core evaluators. "Mutation and
concurrency gates" is manual-trigger-only and correctly skipped.

PR: <https://github.com/haiderchattha99-ali/ThreatNeXus/pull/30>

### Red-check — and the one that initially failed to fail

The factor-label regression test **passed against the reintroduced defect** on the first attempt. The
de-casing fallback renders `exposureCriticality` as "Exposure criticality" either way, so the
assertion could not tell a working dictionary from a dead one. It was strengthened onto `epssScore`
and `kevStatus`, where the curated name ("EPSS probability", "KEV status") and the mechanical fallback
("Epss score", "Kev status") genuinely diverge, then confirmed failing against the broken keys and
restored green. The full-row navigation test was confirmed failing with the row handler removed.

## A real defect the browser suite caught that my own QA missed

With the enrichment disclosure **open** at 390px, the document scrolled **607px**. A `<details>` inside
a CSS grid is a grid item, and a grid item's default `min-width: auto` refuses to shrink below its
content's min-content width — so a wide evidence table pushed the *document* sideways instead of
scrolling inside its own already-correctly-configured `TableContainer`. One line (`minWidth: 0`) fixes
it. My QA script had only ever measured the **collapsed** page; it now opens every disclosure at every
viewport.

## Traps worth carrying forward

- **A closed `<details>` still reports non-zero bounding rects for its content in this Chromium.** The
  E2E overflow helper's "widest offenders" diagnostic therefore named an innocent collapsed table
  while the real overflow came from somewhere else. Trust `documentElement.scrollWidth`; treat the
  offender list as a hint, not an accusation.
- **A disclosure-heavy page needs its disclosures opened before a responsive check means anything.**
- **`enrichmentOperability.spec.js` needs CI's deliberately fake `CENSYS_PAT`.** Without it every
  provider is `NOT_CONFIGURED` and the `EXECUTION_PAUSED` readiness state is unreachable, so the spec
  fails for an environment reason. The local stack was corrected to mirror CI's job env — the
  assertion was **not** relaxed.
- Local stack recipe: project `tnxpolish`, postgres `15432`, backend `5100`, preview `4273`, per-run
  `JWT_SECRET`, `RATE_LIMIT_AUTH_MAX=1000`, `E2E_SKIP_WEBSERVER=1`. `docker compose down -v` still
  fails without `JWT_SECRET` exported.

## Honest gaps

- **No manual pass in the user's own Chrome.** The `claude-in-chrome` extension still refuses to
  connect (its OAuth token belongs to a different claude.ai account than Claude Code is signed into).
  Verification was real Chromium via Playwright driving the production build against a real stack —
  substantively equivalent, but a driven browser, not a hand-driven one.
- **The optional subsystems are collapsed by default on every visit.** They stay mounted and still
  fetch, so nothing is hidden from the network or from a denial, but an analyst who wants provider
  coverage on every finding now pays one click. That is the trade R1 asked for; worth revisiting if
  the demo audience reaches for that panel often.
- **The severity spine is not demonstrably discriminating in the demo dataset** — every seeded finding
  currently scores LOW, so the mechanism is visible but all one colour.
- **The Findings list still has no risk-band sort**, only a filter, because the backend exposes none.
  Severity leads the row visually; the default order remains `lastSeen`.
- **No independent review of this pass.** The brief explicitly excludes a post-implementation
  reviewer. That is a deliberate departure from `CLAUDE.md`'s "do not review your own final work as
  the only reviewer" rule, recorded here rather than quietly honoured.

## Protected boundaries honoured

- The primary checkout `C:\Users\LENOVO\Desktop\ThreatNeXus` was **never modified** — its foreign
  Phase 9C presentation changes are exactly as found. All work happened in an isolated worktree.
- No `git add -A`; every commit staged explicit paths.
- `backend/.env` was never opened, read, printed or referenced.
