# Speaker Notes

**Phase 9B.1 — premium redesign.** One section per slide in `ThreatNeXus-PKCERT-Deck.md` (17 slides).
Each covers what to say, what visual to show, what not to overclaim, a demo cue where relevant, and
the fallback if the network or a provider API is unavailable during the talk. Wording rules:
`STYLE_GUIDE.md`. Animation/build instructions for this slide: `ANIMATION_CUE_SHEET.md`.

---

## 1. Title

**Say**: Open with the positioning line before anything else — "ThreatNeXus is a research prototype,
built during a PKCERT/NCERT internship. It's not a deployed system, and I'm not claiming otherwise
today." Setting that expectation first makes every claim that follows easier to trust, not harder.

**Visual**: Title slide, near-black background, wordmark and tagline only, title-reveal build (see
cue sheet).

**Don't overclaim**: No "production-ready," no "deployed," no national-scale framing.

**Demo cue**: None yet.

**Fallback**: N/A.

---

## 2. A report comes back. Nobody can say if it's new.

**Say**: Be concrete, not abstract. Don't open with "cyberattacks are increasing" — open with the
exact failure: a CERT receives the same exposure report a second time, months later, and the process
has no way to connect it to the first one. It looks brand new. Nobody can say whether it was fixed,
whether it's recurring, or who's accountable for it.

**Visual**: The hook statement, large, on its own — no diagram needed, the sentence carries the slide.

**Don't overclaim**: This is a workflow problem, not a claim that any specific incident happened this
way — keep it generic and structural, not a fabricated case study.

**Demo cue**: None yet — this sets up the "why."

**Fallback**: N/A.

---

## 3. Why fragmented CTI slows response

**Say**: Walk through each bullet as a real behavior, not a hypothetical — provider portals genuinely
are separate systems with separate logins; evidence genuinely does get judged from memory under time
pressure; a notification genuinely can go out today without independent review, in a manual process.
This is the cost of fragmentation, stated plainly.

**Visual**: Four short bullets, generous whitespace — this is a pacing slide, not a data slide.

**Don't overclaim**: Don't imply every CERT works this exact way — frame it as the common failure mode
this project was built to close, not a universal indictment.

**Demo cue**: None yet.

**Fallback**: N/A.

---

## 4. What ThreatNeXus solves

**Say**: Say the bold line exactly as written, then pause. This is the one line the rest of the talk
supports — it's worth letting it land before moving on.

**Visual**: The one-sentence definition, large type, workflow arrow chain from Slide 5 visible faintly
beneath it if the layout allows — otherwise keep it clean and text-only.

**Don't overclaim**: "Persistent, deduplicated Finding" is a real, tested claim — don't extend it into
"never loses a report" or any absolute.

**Demo cue**: None yet.

**Fallback**: N/A.

---

## 5. The end-to-end workflow

**Say**: Walk the arrow chain left to right, once, slowly. Emphasize "every arrow writes its own audit
event" — that's not a summary claim, it's implemented at the service layer specifically so a missing
audit call fails a test rather than shipping silently.

**Visual**: The step-chain diagram as built — this is the one early slide where the diagram IS the
content.

**Don't overclaim**: The AI-draft step is optional and off by default — say that here, briefly, so it
isn't misread as a required step in the flow.

**Demo cue**: This is the map the live demo will walk physically — say so.

**Fallback**: N/A.

---

## 6. Live product surface

**Say**: This is the first look at the actual running application. Point at the four-part tuple on
every tile — value, availability, source, as-of — and say the sentence exactly: "nothing on this
screen is estimated, and a figure that can't be computed never renders as zero." That single habit is
what the rest of the deck is really about.

**Visual**: The dashboard screenshot (`SCREENSHOT_PLAN.md` slot P-01) inside a labeled device frame if
a real capture exists; otherwise the labeled placeholder box, captioned honestly as "screenshot
pending — see `SCREENSHOT_PLAN.md`."

**Don't overclaim**: Don't caption a placeholder as if it were a real screenshot — if it isn't
captured yet, say so out loud rather than letting the audience assume it's live.

**Demo cue**: If presenting live, this is the natural point to switch to the real application in a
browser instead of the slide.

**Fallback**: If no screenshot exists and no live demo is possible, describe the four-part tuple from
this slide's text alone — it's short enough to carry without a visual.

---

## 7. A six-provider intelligence stack

**Say**: Name what each provider adds in one breath, without dwelling — the point of this slide is
breadth and uniformity, not depth on any one provider. Say explicitly: every one of these is optional,
and a missing key disables exactly one provider, never the whole application.

**Visual**: The six-provider grid as built (see cue sheet for the stagger), or the provider-status
panel from Settings if a screenshot exists (`SCREENSHOT_PLAN.md` slot P-05).

**Don't overclaim**: Never state or imply uptime, latency, or accuracy for any provider — none of that
is measured anywhere in the product.

**Demo cue**: The Settings/provider-status screen, if the demo environment has any providers
configured.

**Fallback**: If no provider key is configured for the demo environment, say so directly: "these are
shown as not-configured here deliberately — every one of them is optional, and the workflow completes
identically with all six off." That's a feature to point at, not something to apologize for.

---

## 8. Evidence, not proof

**Say**: This is a governance slide, not a features slide — slow down here. A high reputation score,
an open port, a suspicious classification: none of it closes a case or sends a notification by itself.
An analyst reads it and decides. Land the phrase "unknown is never zero" specifically — it's the rule
that makes every other number on the dashboard trustworthy.

**Visual**: The two governing statements, large type, generous whitespace — no chart needed.

**Don't overclaim**: Provider evidence "supports," "informs," never "proves," "confirms," or "detects."

**Demo cue**: The dashboard's own value/availability/source/asOf tuple on every tile — point at it
live if presenting from the running app.

**Fallback**: N/A.

---

## 9. AI assistance — drafts only

**Say**: Get ahead of the AI question before anyone asks it. The honest framing: AI here does less
than people expect, deliberately. It's off by default, and there's no live AI provider wired up in
this codebase at all today — turning the switch on activates a provider that safely resolves to
"disabled." When it is enabled, it drafts a suggestion; a human decides. It has no access to a
database connection, a transaction, or a capability token, so there's nothing for it to close, send,
or score even if you wanted it to.

**Visual**: The four bullets as written, with a simple "provider → suggestion → human decision" flow
shape, without implying any autonomy in the diagram itself.

**Don't overclaim**: Never say "AI decides," "AI approves," "AI helps close cases faster" — no such
measurement exists. Say what it removes (manual drafting effort) and stop there.

**Demo cue**: If AI is enabled in the demo environment, show a draft being generated and then accepted
by a Reviewer account, not an Analyst — the separation of duties is the point, not the draft's
content.

**Fallback**: If AI is off in the demo environment (the shipped default), say so and move on — "this
is disabled by default, which is what you're seeing" is itself the correct demonstration.

---

## 10. ATT&CK mapping and evidence integrity

**Say**: This is a specific, checkable claim, so make it specific: an ATT&CK mapping justified only by
"the host is exposed" or "the risk score is high" is refused by the server, not just discouraged in
the interface. It requires evidence of observed adversary behavior. The same rule applies whether the
mapping came from an analyst typing it in or from an accepted AI suggestion — there's no separate,
looser rule for the AI path.

**Visual**: A short "refused" example if a screenshot exists (`SCREENSHOT_PLAN.md` slot P-07);
otherwise the rule statement as written.

**Don't overclaim**: Don't claim full ATT&CK catalogue verification for NIST CSF/CIS mappings — those
two are format-checked, not existence-verified against a pinned catalogue the way ATT&CK is.

**Demo cue**: If time allows, show the actual refusal live — attempt a weak mapping and let the server
reject it.

**Fallback**: If not demoed live, describe the refusal mechanism as tested (server-side, not UI-only)
rather than performing it.

---

## 11. Security controls

**Say**: This is a checklist slide for anyone doing technical diligence — deliver it as a checklist,
not a story. Four controls, stated specifically: capability-based RBAC enforced server-side, with no
role inheriting another's authority (an analyst who drafts a notification structurally cannot also
approve it — that's a 403 the system returns, not a policy someone has to remember); every write
audited from the service layer; three independent rate-limit buckets; and secrets never reaching a
log line, a response, or the browser bundle, checked automatically on every CI push.

**Visual**: The four cards as built — no stock security imagery.

**Don't overclaim**: Don't say "enterprise-grade" or "bank-level" — name the mechanism instead. Don't
say "enterprise RBAC" either — name the actual mechanism (capability-based, non-hierarchical).

**Demo cue**: Flag that the live demo will show a role's request get refused, not just described.

**Fallback**: N/A.

---

## 12. Architecture

**Say**: Walk left to right once: frontend talks only to the REST API; the API talks to domain
services; services talk to Postgres and, only on a human-triggered request, to a provider. Land the
point that the frontend never reaches a provider or the database directly — the backend is the only
door in or out.

**Visual**: The architecture diagram as built (see cue sheet for the build-up sequence), reusing the
same shape as `docs/ARCHITECTURE.md`'s diagram rather than inventing a different one.

**Don't overclaim**: Don't describe this as microservices or distributed — it's a single Express
application with a modular service layer, described accurately as that.

**Demo cue**: None required.

**Fallback**: If the diagram build doesn't render as intended in a given viewer, the static final-state
image still carries the same information — narrate left to right regardless.

---

## 13. What a PKCERT reviewer will see in the demo

**Say**: Preview the exact sequence about to happen, so the audience knows what to watch for: the
dashboard's sourced figures, one Finding's full risk explanation, a closure request refused to the
person who made it, a weak ATT&CK justification refused, and the notification export/delivery
distinction.

**Visual**: The sequence as a short numbered list, matching the demo-path diagram from Slide 5's
shape.

**Don't overclaim**: Say "what you're about to see," not "what PKCERT will use in production."

**Demo cue**: This slide IS the demo cue — transition directly into the live walkthrough
(`DEMO_WALKTHROUGH.md`) from here.

**Fallback**: If live demo isn't possible at all (see `DEMO_WALKTHROUGH.md`'s offline/no-network
fallback), say so directly and continue narrating the sequence from static screenshots if any are
available, or from this slide's description alone if not.

---

## 14. Meet the team

**Say**: Keep this brief and factual — name, one-line role, move on. This slide exists so a PKCERT
reviewer knows who to ask a follow-up question, not to sell anything.

**Visual**: Four cards, one per person, name and role only — sourced directly from this README's own
Team section, not invented for this deck.

**Don't overclaim**: No titles beyond what's documented (`README.md`), no logos, no external company
affiliations stated.

**Demo cue**: None.

**Fallback**: N/A.

---

## 15. Validation proof

**Say**: Let the numbers breathe — don't over-narrate each one. The line worth adding out loud: the
evaluators are the actual bar this project holds itself to. A human wrote down the correct answer by
hand, and the real production code has to reproduce it exactly, not a mocked approximation of it.

**Visual**: Four stat callouts, large numbers, small labels — this is the one slide built entirely
from numbers, so let the numbers be the visual.

**Don't overclaim**: These are test/evaluator/CI counts, not a security-audit certification — don't
let the slide imply an external audit occurred, because none has.

**Demo cue**: If presenting near a computer, this is a good moment to show the actual green CI run in
a browser tab rather than only a badge image (`SCREENSHOT_PLAN.md` slot P-08).

**Fallback**: If no live CI view is available, the stat callouts stand on their own — they don't need
a live proof to be true, only to be stated accurately.

---

## 16. Honest limits and roadmap

**Say**: Do not rush or skip this slide. Say each limit plainly, without softening language. This is
the slide that makes every earlier claim believable — a project that only tells you what works hasn't
earned trust yet. The roadmap line that follows is not a promise, it's a stated intent.

**Visual**: The four limit bullets, followed by the roadmap line — no decoration, let the plainness of
the statement do the work.

**Don't overclaim**: Don't follow any of the four limits with "but we're fixing that soon" — the
roadmap line already covers direction; don't double up on false reassurance.

**Demo cue**: None — this is deliberately not demoed, since none of these are working paths to show.

**Fallback**: N/A.

---

## 17. Close

**Say**: Close on the same tagline the deck opened with — it's the product's actual line, not
something written for this deck. State the "ready for technical review" framing exactly as worded:
it's a specific claim (tested, audited, working) not a general one (finished, production-ready).
Invite questions and leave the slide up.

**Visual**: Same treatment as Slide 1 — wordmark, tagline, near-black background — to bookend the deck
visually.

**Don't overclaim**: "Ready for technical review" is the ceiling — do not extend it to "ready for
deployment" or "ready for adoption" in the room, even if asked directly; redirect to the honest-limits
slide if pressed.

**Demo cue**: None.

**Fallback**: N/A.
