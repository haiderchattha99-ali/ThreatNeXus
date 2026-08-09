# Landing/Showcase Page Plan

**Planning only — no landing page is built in Phase 9B.** This document exists so a future session can
implement one without re-deriving the reasoning, not as a commitment that one will be built.

## Is it worth building?

**Conditionally, not urgently.** ThreatNeXus already has a strong text-first entry point
(`README.md` → `docs/DELIVERY.md` → `docs/PROJECT_PLAYBOOK.md`), and the presentation deck
(`docs/presentation/`) covers the same ground for a live audience. A landing page would add value only
in one specific scenario: sharing a single link with someone who will not clone the repository or sit
through a live demo — a reviewer skimming before a meeting, or a link included in a written
recommendation. If that scenario doesn't come up, the existing docs and deck cover it, and a landing
page would be effort spent on an audience that doesn't exist yet.

## What problem it would solve

A GitHub README is dense and code-adjacent by nature — right for an engineer deciding whether to run the
project, wrong for a 90-second skim by someone deciding whether to take a meeting. A landing page's job
would be exactly that 90-second skim: the hook, the one-sentence description, three or four proof
points, and a clear path to "read more" (the docs) or "see it" (the deck/demo) — nothing the README
doesn't already say, just paced for a much shorter attention span.

## Where it would live

A static site, generated from content that already exists rather than duplicating it — options in order
of preference:

1. **A single static HTML page** built from `README.md` + `docs/PROJECT_PLAYBOOK.md` content, hosted via
   GitHub Pages from a `docs/` or `gh-pages` branch subfolder. No build tooling, no framework, lowest
   maintenance burden.
2. **A route inside the existing `frontend/` app** (e.g., `/about` or a public marketing route ahead of
   the login wall) — higher effort, and it would mean touching the product's own frontend for
   documentation purposes, which this project has deliberately avoided doing (see
   `docs/PROJECT_PLAYBOOK.md`'s scope discipline).

Option 1 is the recommended path if this is ever built — it keeps the "documentation and demo assets are
separate from the product" boundary this project has maintained since Phase 9A.

## What sections it would include

1. Hook — the same specific pain from Deck Slide 2, not a generic security tagline
2. One-sentence description — the same line as Deck Slide 4 and this project's README
3. Three or four proof points as stat callouts — providers, tests, evaluators, migrations (Deck Slide 14
   content, reused verbatim, not reinvented)
4. A single architecture visual (`docs/ARCHITECTURE.md`'s diagram)
5. An honest-limits section — non-negotiable if this page exists at all; a marketing page for a research
   prototype that omits its own limitations would misrepresent the project, which no version of this
   page may do
6. Links out: the GitHub repository, `docs/PROJECT_PLAYBOOK.md`, and (if presenting) the deck

## What screenshots it would need

The same P-01, P-03, P-05, and P-09 slots from `docs/presentation/SCREENSHOT_PLAN.md` — dashboard,
finding risk explanation, provider matrix, and the architecture diagram cover the "what does it actually
look like" question a landing page exists to answer. No new screenshot slots beyond what the deck
already needs.

## Why it remains optional

- No current audience need has been identified for it beyond the deck and existing docs.
- It would need real screenshots to be worth building at all (a landing page with placeholder boxes is
  worse than no landing page), and no screenshots exist yet — see `SCREENSHOT_PLAN.md`.
- Building it now, before Phase 9B's other deliverables are used at least once in a real presentation,
  risks designing it around assumptions about what a reviewer wants to see rather than what one actually
  asked for.

**Recommended trigger to revisit this**: after the first real PKCERT presentation, if a reviewer asks
for something to forward to a colleague who won't read the full repository.
