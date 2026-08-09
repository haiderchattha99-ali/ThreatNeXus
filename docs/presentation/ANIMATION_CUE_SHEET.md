# Animation Cue Sheet

`pptxgenjs` (the tool that generates `ThreatNeXus-PKCERT-Deck.pptx`) has no API for PowerPoint
entrance animations or slide transitions — confirmed against the installed version (4.0.1)'s type
definitions before writing this document, rather than assumed. Baking in a fake or partial animation
would silently fail or corrupt the file. Instead, this sheet gives the exact, manual PowerPoint
instructions for a presenter (or whoever does a final polish pass in real PowerPoint or Canva) to add
before the first live presentation. The generated `.pptx` ships fully readable and correct with none
of these applied — they are a polish layer, never a content dependency.

**Principle**: fade, wipe, morph, zoom, and stagger only. No bounce, spin, fly-in-with-sound, or any
"cartoon" entrance/exit effect — this is a CERT technical review, not a product launch video.

---

## 1. Title slide — title reveal

- Select the wordmark ("ThreatNeXus") → **Animations → Fade** (Duration 0.6s, Start: On Click).
- Select the tagline ("Connecting Intelligence with Action") → **Fade**, Start: **After Previous**,
  Delay 0.3s.
- Select the two smaller lines (prototype framing) → **Fade**, Start: **After Previous**, Delay 0.2s.
- Net effect: three short fades in sequence, not one block appearing at once. Total build time under
  2 seconds — this should never feel like a countdown.

## 2. Provider stack slide (Slide 7) — stagger

- Select all six provider cards → **Animations → Fade** → open the **Animation Pane** → set
  **Effect Options → Sequence: One by One**, or apply **Stagger** directly if using PowerPoint 365's
  built-in stagger control on a grouped object.
- Order: left-to-right, top-to-bottom (matches natural reading order of the 3×2 grid).
- Delay between cards: 0.15s. Keep the whole stagger under 1.5s total — six cards should read as one
  breath, not six separate beats.

## 3. Workflow path slide (Slide 5) — step reveal

- Select the seven workflow-step boxes (Upload, Triage, Enrich, Map, AI draft, Review, Act) plus
  their connecting arrows.
- Apply **Wipe** (direction: left-to-right) to each box+arrow pair, **Start: On Click** for the first
  step, **After Previous** for the rest, 0.4s each.
- This lets the presenter click through the chain at their own talking pace rather than the whole
  diagram appearing at once — matches the speaker note's "walk the arrow chain left to right, once,
  slowly."

## 4. Architecture build-up (Slide 12)

- Reveal in dependency order, not left-to-right: **Frontend box** → **API box** → **Services box** →
  **Database box** → **Provider adapters box** (the last one, since it's the exception path, only
  reached on a human-triggered lookup).
- Each box: **Fade**, 0.4s, **On Click**. Each connecting arrow: **Fade**, 0.2s, **After Previous**,
  appearing immediately after the box it points into.
- This mirrors the speaker note's walk order exactly — do not reorder the animation without also
  updating `SPEAKER_NOTES.md` Slide 12.

## 5. Demo-sequence transitions (Slide 13 → live demo)

- No PowerPoint animation on Slide 13 itself beyond the numbered-list stagger below — its job is to
  hand off to the live application, not to entertain on its own.
- Numbered list items (the five demo beats): **Fade**, **On Click**, one per click, so the presenter
  reveals each beat exactly when they say it, not before.
- **Slide transition into Slide 13** (the transition *between* Slide 12 and Slide 13, not element
  animation): **Morph**, 0.8s, if the presenter is using PowerPoint 365 (Morph requires two
  consecutive slides sharing named objects — skip if using an older PowerPoint version or Google
  Slides/LibreOffice; fall back to a plain **Fade** slide transition instead, which every version
  supports).

## 6. Team slide entrance (Slide 14)

- Select the four team cards → **Fade**, **Sequence: One by One**, delay 0.15s each, same stagger
  pattern as the provider grid (Section 2) for visual consistency across the deck.
- Do not use **Fly In** or any directional entrance — this is a factual credits slide, not a highlight
  reel.

## 7. Closing slide emphasis (Slide 17)

- The closing statement ("ThreatNeXus is ready for technical review...") → **Fade**, 0.6s, **On
  Click**, mirroring the title-slide reveal in Section 1 to bookend the deck.
- No zoom, no emphasis pulse, no color flash — let the sentence hold the room in silence for a beat
  before "Questions."

---

## Slide transitions (between-slide, not element animation)

Apply **one** of the following consistently across the whole deck — do not mix multiple transition
styles slide-to-slide, which reads as unintentional rather than designed:

- **Recommended**: plain **Fade**, 0.5s, on every slide-to-slide transition. Universally supported
  (PowerPoint, Google Slides, LibreOffice, Keynote import), never distracting, and matches the deck's
  restrained visual language.
- **Optional, PowerPoint 365 only**: **Morph** between Slides 12 and 13 specifically (see Section 5) —
  skip entirely if the presenting machine's PowerPoint version or the venue's software is unknown or
  older. A missing Morph support silently falls back to a hard cut, which is safe but not what's
  intended — test it once on the actual presenting machine before relying on it.

## Reduced-motion / static fallback

Every cue in this sheet is optional polish, not a content dependency — the deck is complete and fully
readable with **zero** animation applied, exactly as `pptxgenjs` generates it. If presenting on
unfamiliar hardware, an older PowerPoint version, Google Slides, or any viewer where an unfamiliar
animation risks behaving unpredictably live: **skip this entire sheet** and present the deck as
generated. Nothing here is required to make a claim, complete a demo cue, or convey the content of any
slide — every animation described is reveal pacing, never information carried only by motion.
