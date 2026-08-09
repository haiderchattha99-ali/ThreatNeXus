# Presentation Style Guide

Rules for anyone editing the deck, speaker notes, or demo materials in this folder. The goal is a
PKCERT-facing technical presentation that reads as credible because it's precise, not because it's
polished — precision is the actual credibility signal for this audience.

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
- Dark backgrounds for the title/section/close slides, white/light for body content — the same
  sandwich structure the product's own frontend design system uses.
- One visual idea per slide — a diagram, a stat callout, a table, or a labeled screenshot placeholder.
  No slide is bullets on a blank background.
- No emoji anywhere in slide content. No gradients, no loud color transitions, no decorative accent
  stripes or underlines beneath titles.
- No animation beyond what PowerPoint/Slides applies by default on advance — nothing gimmicky.
- Screenshot-first where a real screenshot exists; a clearly labeled placeholder box where it doesn't
  (see `SCREENSHOT_PLAN.md` — none were captured this phase, so every screenshot slot in this deck is a
  labeled placeholder with exact capture instructions, not a fabricated image).

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
