# Presentation Style Guide

Rules for anyone editing the deck, speaker notes, or demo materials in this folder. The goal is a
PKCERT-facing technical presentation that reads as credible because it's precise, not because it's
polished — precision is the actual credibility signal for this audience.

## Phase 9B.1 — premium redesign (read this section first)

Phase 9B shipped a correct but plain deck — a documentation export in slide form. Phase 9B.1 keeps
every fact and every wording rule below (nothing here was loosened) and rebuilds the deck's visual
system and slide structure around them: a 17-slide structure matching the required PKCERT-review
topic list exactly (added a "Live product surface" slide and a "Meet the team" slide; folded the old
standalone "Role model" slide's one load-bearing point — no role inherits another's authority — into
the Security Controls slide, since the deck no longer needs a dedicated slide to make that point).

### Research pass (structure only — nothing copied)

A second short, real research pass ran before touching slide content, on top of Phase 9B's original
one (Falco README structure, general pitch-deck framing — both still recorded below, unchanged):

- **WebSearch — cybersecurity/SOC product pitch-deck structure (2025 conventions)**: confirmed the
  dark, clean, low-clutter visual direction already chosen in Phase 9B, and the pattern of a
  product/workflow slide using a diagram instead of a paragraph. **Not applied**: TAM/SAM/SOM market
  sizing, a competitive 2×2 matrix, social proof/testimonials, and a fundraising close — all standard
  for an *investor* deck, none of it fits a PKCERT technical-review audience, and Phase 9B's own style
  guide already ruled this out explicitly.
- **WebSearch — pitch-deck typography and visual-hierarchy conventions**: the concrete, reusable rule
  taken from this pass is a **locked three-tier type system** (one typeface family, at most two
  weights, three size tiers used consistently across every slide) so a reader's eye never has to
  re-learn what a headline vs. a supporting line looks like slide to slide. Applied directly in
  "Typography v2" below.
- **`pptx` skill's own design guidance** (consulted as a legitimate internal reference, not an external
  source to cite): "one color should dominate, 1–2 supporting tones, one sharp accent" and "commit to
  one repeated visual motif" — both applied in "Visual system v2" below. Its explicit **don'ts** are
  now hard rules for this deck: no accent line/stripe under any title, no decorative color bar or
  vertical sidebar stripe anywhere, no cream/beige background.
- Nothing — no wording, layout, asset, or diagram — was copied from any source consulted in either
  research pass.

### Visual system v2

- **Dark throughout, not a light/dark sandwich.** Phase 9B alternated dark title/close slides with
  light body slides. Phase 9B.1 commits to the near-black canvas (`0A1210`) on **every** slide,
  including body content — this is a deliberate premium-feel choice (per the `pptx` skill's own
  "commit to dark throughout" option) and it makes the deck look like it belongs to the product itself,
  which is already a near-black interface end to end. Card surfaces use a slightly lighter panel tone
  (`0F1A16`) for depth, never a hard color change.
- **One dominant color, one sharp accent** — the near-black canvas is ~70% of every slide's visual
  weight; government-green (`35C477`) is used sparingly and only where it does real work: the small
  kicker label above each title, stat-callout numbers, and status/accent icons. It never fills a
  background or a large shape.
- **One repeated motif**: a small uppercase kicker line ("PROBLEM", "WORKFLOW", "EVIDENCE", …) in
  green, directly above every content slide's title — this is text, not a colored bar or stripe, and
  it is the one element every slide shares. Rounded-rectangle cards (provider grid, security controls,
  team) share one consistent corner radius and shadow treatment as the deck's second consistent
  element.
- **No accent line under any title, no color bar, no sidebar stripe, no cream/beige background** —
  carried over from Phase 9B's existing "no decorative accent stripes" rule and reinforced by the
  `pptx` skill's own explicit anti-pattern list; this is now a hard rule with no ambiguity about what
  counts.

### Typography v2

Locked three-tier system, one family, at most two weights:

| Tier | Use | Size | Weight |
|---|---|---|---|
| Kicker | Small label above a title | 12–13pt, letter-spaced | Bold, green |
| Title | Slide headline | 34–40pt | Bold, light text |
| Body | Bullets, captions, card text | 15–18pt (12pt for captions) | Regular, light or muted text |

**Font: Calibri**, not the product's own IBM Plex — a deliberate, documented trade-off. Brand
consistency with the running application comes from reusing its exact color tokens (below), which
carries the visual identity; the typeface choice instead optimizes for **portability**, since this
deck may be opened on a PKCERT reviewer's own machine, which cannot be assumed to have IBM Plex
installed. Calibri ships with every current Office install and renders identically wherever it's
opened, so the deck looks the same as authored rather than silently substituting.

### Team slide sourcing

The "Meet the team" slide (Slide 14) uses the four names and roles already documented in this
repository's `README.md` Team section (M. Ismail, Ali Haider, Aun Zulfiqar, Eshaal Khan) — real,
already-public information, not invented for this deck. No placeholder names were needed.

## Audience

Security reviewers at PKCERT/NCERT and similar CERT-operations stakeholders — people who will ask "how
do you know that" about every claim on screen. Not investors, not a general tech audience. No slide
should need a business-model or funding framing, because none applies.

**Framing note**: present this as a CERT operations tool built during a PKCERT/NCERT internship. Do not
mention GIKI, the university, or any academic-project framing anywhere in audience-facing material — the
deck, speaker notes, and demo walkthrough all address PKCERT/security-reviewer context only.

## Deck strategy (internal — decide this before writing slide content)

- **Core hook**: not "cyberattacks are increasing" — the concrete, specific pain of a CERT losing track
  of whether an exposure was ever actually fixed, because nothing ties today's report to last month's.
- **Main pain**: fragmented tooling and manual reasoning under uncertain evidence, with no durable record
  of who decided what. Analysts jump between provider portals, reason about ambiguous signals by memory,
  and the accountability trail doesn't survive the process.
- **Product promise**: one analyst-facing flow — ingest, triage, enrich, map to frameworks, optionally
  draft with AI, review, act — with every step audited and every number sourced.
- **Technical proof points**: 23 additive migrations, 145 backend test files, 9 evaluators reproducing
  hand-authored ground truth, CI on every push, 6 live providers behind one shared quota and error
  contract, human approval gates enforced as real `403`s not policy text.
- **Demo sequence**: dashboard integrity model → finding + risk explanation → case closure refused to
  its own requester → framework mapping refusing weak evidence → notification export vs. delivery.
- **What must not be overclaimed**: no national-scale claim, no production-deployment claim, no "AI
  decides" language, no PKCERT adoption/endorsement claim (say "PKCERT-focused" or "PKCERT-ready," never
  "adopted by" or "deployed at"), no coverage percentage for framework mappings, no uptime/latency claim
  for any provider.

## Inspiration notes (structure only — nothing here is copied wording, branding, or assets)

A short pass across established open-source security-tooling documentation and standard cybersecurity
pitch-deck structure, extracting narrative/structural patterns only:

**From security-tool README conventions** (pattern observed generally across projects like Falco,
Trivy, and Sigstore-family repos — structure only, not their wording):

- **Trust-building comes before feature tour.** Identity and credibility signals (what it is, what it
  is not, security/audit posture) are established before the deep walkthrough — never the reverse.
- **A dedicated security-and-disclosure section is standard**, not an afterthought appended at the end.
- **An FAQ-style section that pre-empts skepticism** ("why does it work this way") does real work — it's
  where a reader's doubt gets addressed directly instead of left to accumulate.
- **Architecture is shown as a map**, not a wall of prose — a reader should be able to see the shape of
  the system before reading how any one piece works.
- Applied here as: the "integrity model" slide (Slide 5) functions as ThreatNeXus's trust-building
  section — the differentiator claim goes early, immediately after the pain is established, not buried
  near the end.

**From cybersecurity pitch-deck structure** (general pattern, not audience-fit for us since this isn't
a funding pitch — extracted narrative pacing only):

- **Problem slides that cite a specific, concrete scenario outperform generic threat-landscape
  statistics.** Applied here: no "cyberattacks are rising" slide anywhere in this deck.
- **Solution slides lead with outcome, not mechanism** — say what changes for the analyst before
  explaining how.
- **Proof (tests, evidence, controls) is placed to support a claim already made, not to open the deck.**
  Applied here: proof-of-discipline (Slide 12/14) comes after the product has been explained, as
  evidence for what was already claimed, not as a cold open.
- Not applied: funding ask, market-sizing, team/traction slides — none of that fits a technical
  CERT-reviewer audience, and including it would read as misdirected, not thorough.

## Visual rules

- **Palette**: the product's own design tokens (`frontend/src/theme/tokens.js`) — near-black canvas
  (`#0A1210`/`#070C0A`), government-green accent (`#35C477`), light text (`#EAF1F9`), muted text
  (`#9DAFC2`), severity scale (critical `#F2617A`, high `#E8A33D`, medium `#65ADD0`, low `#35C477`).
  Reusing the product's actual palette rather than inventing a deck-only one is deliberate — the deck
  should feel like it belongs to the same product the audience is about to see live.
- **Superseded by "Visual system v2" above (Phase 9B.1)**: the deck is now dark-throughout rather than
  alternating dark/light — see that section for the current rule and its reasoning.
- One visual idea per slide — a diagram, a stat callout, a table, or a labeled screenshot placeholder.
  No slide is bullets on a blank background.
- No emoji anywhere in slide content. No gradients, no loud color transitions, no decorative accent
  stripes, color bars, sidebar stripes, or underlines beneath titles — see "Visual system v2" for the
  full, now-explicit list.
- Slide-build and transition animation is optional polish, documented separately in
  `ANIMATION_CUE_SHEET.md`, and never a content dependency — the generated `.pptx` carries none of it
  by default (`pptxgenjs` has no reliable API for it; see that document's own note).
- Screenshot-first where a real screenshot exists; a clearly labeled placeholder box where it doesn't
  (see `SCREENSHOT_PLAN.md` — still none captured as of Phase 9B.1, so every screenshot slot in this
  deck is a labeled placeholder with exact capture instructions, not a fabricated image).

## Typography

Slide titles: bold, 36–40pt. Body: 16–20pt, left-aligned, short lines — a slide is a prompt for the
speaker, not a document. Captions/sources: 11–12pt, muted color.

## Banned overclaim patterns

Do not use, anywhere in deck, speaker notes, or demo materials, unless directly quoting a named source:

`transformative` · `pivotal` · `crucial` · `ever-evolving landscape` · `furthermore` · `moreover` ·
`in conclusion` · `it is important to note` · `seamless` · `robust` (unless naming the specific control
that makes it true) · `cutting-edge` (unless quoting a real external source) · `revolutionize` ·
`unlock` · `empower` · `leverage synergies` · `game-changer` · `state-of-the-art` · `next-generation`

Also avoid: canned transition phrases ("Let's dive in," "Without further ado"), repetitive sentence
rhythm across slides, invented personal anecdotes, and a filler closing line that doesn't say anything
new. This list is a quality checklist for avoiding generic, inflated prose — it exists to make the
writing sound like a person who knows the system, not to defeat any detection tool.

## AI-governance phrasing

- Never write "AI decides," "AI approves," "AI closes," or any phrasing implying autonomy over an
  outcome. AI **drafts** and **suggests**; a human **decides**.
- Always pair "disabled by default" with the fact that no live AI provider ships at all — the two facts
  together, not one alone, are what make the claim complete.
- Never claim AI improves accuracy, speed, or coverage as a measured result — no such measurement exists
  in this project. It removes some manual drafting effort; it does not claim more than that.

## Provider-evidence phrasing

- A provider result "supports," "informs," or "adds context to" an analyst decision. It never "proves,"
  "confirms," "verifies," or "detects" on its own.
- Never state or imply uptime, latency, or reliability for any of the six providers — none is measured
  or displayed anywhere in the product, so none may appear in the deck either.

## Security-proof phrasing

- State controls specifically (capability-based RBAC, audited writes, rate limiting, secret redaction)
  rather than using an unqualified "secure" or "enterprise-grade."
- Every security claim in the deck must trace to something documented in `docs/ai/SECURITY.md`,
  `docs/ARCHITECTURE.md`, or `docs/ADMIN_GUIDE.md` — if it isn't written down there, it doesn't go on a
  slide.

## Demo wording

- "Live walkthrough of the running application," never "live attack simulation" or anything implying
  offensive activity — this product has no scanning or offensive capability of any kind.
- State the offline fallback plan before it's needed, not as an apology if something breaks mid-demo.

## PKCERT-only audience framing checklist

- [ ] No mention of GIKI, coursework, grading, or academic-project framing anywhere in audience-facing
      material
- [ ] "PKCERT-focused" or "PKCERT-ready," never "adopted by PKCERT" or "deployed at PKCERT" — this
      remains a research prototype, not a fielded system
- [ ] Every claim of adoption, deployment, or endorsement is either sourced from `docs/PROJECT_PLAYBOOK.md`
      or removed

## No-generic-AI-writing checklist (quality bar, not detector evasion)

Before finalizing any slide or note, check for the patterns commonly associated with generic
AI-generated prose (used here purely as a self-editing quality bar):

- [ ] No sentence could be dropped into an unrelated deck and still make sense — every line is specific
      to ThreatNeXus
- [ ] No three-items-in-a-row rhetorical pattern used more than once or twice across the whole deck
- [ ] No unearned superlative ("the most," "the best," "unparalleled") anywhere
- [ ] No claim stated twice in different words for emphasis — say it once, well
- [ ] Every number is real and traceable to a document in this repository
- [ ] Read every slide out loud — if it sounds like something a person would actually say in front of a
      technical audience, it stays; if it sounds like a marketing template, rewrite it
