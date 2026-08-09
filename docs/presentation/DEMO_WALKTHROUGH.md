# Demo Walkthrough (PKCERT Presentation)

The detailed, presentation-facing version of the live demo. `docs/DEMO_SCRIPT.md` is the condensed
on-stage cue card; `docs/DEMO_RUNBOOK.md` is the original full talkthrough this project has used since
Phase 6. This document is the PKCERT-reviewer-specific version, adding what those two don't cover:
providers, AI assistance, and ATT&CK mapping as their own dedicated walkthrough sections, plus explicit
recovery steps if a provider API is unreachable mid-demo.

## Pre-demo checklist

- [ ] Stack rehearsed end to end at least once in the last 24 hours, on the exact machine that will
      present
- [ ] Four seeded accounts confirmed working (`admin@threatnexus.local`, `analyst@threatnexus.local`,
      `reviewer@threatnexus.local`, `viewer@threatnexus.local`) — see `docs/DEPLOYMENT.md`
- [ ] Offline overlay rehearsed too if the venue's network is uncertain (see "Offline fallback" below)
- [ ] Browser open to the login page, at presentation zoom level, before anyone is watching
- [ ] The specific Finding/Case you'll open is known in advance (the seeded Meridian Health Trust case,
      per `docs/DEMO_RUNBOOK.md`) — don't search for it live
- [ ] Notifications/Slack/OS popups disabled on the presenting machine
- [ ] Know which providers (if any) have a live key configured for this specific demo run, so Slide 7's
      talking point matches what's actually on screen

## Local stack preparation

```bash
JWT_SECRET="$(openssl rand -base64 48)" docker compose up --build
docker compose exec -e SEED_USER_PASSWORD='<a-strong-local-password>' backend npm run seed:users
docker compose exec -e DEMO_MODE=true -e DEMO_USER_PASSWORD='<same password>' backend npm run seed:demo
```

Full detail: `docs/DEPLOYMENT.md`. This walkthrough assumes the stack is already running and seeded
before the audience is watching — never run the seed live.

## Role login order

1. **Analyst** first — this is the "doing the work" perspective and covers the most ground: dashboard,
   findings, upload, triage, provider enrichment, AI drafting.
2. **Reviewer** second — approves what the analyst produced (closure, notification, AI suggestion).
3. **Viewer** last, briefly — to show the "Not available to your role" restriction, which is the
   clearest single frame for the integrity model.
4. **Admin** only if a question about configuration or organizations comes up — not part of the core
   sequence.

## Dashboard walkthrough

Sign in as Analyst. Land on the operations overview and point at the caption under any tile — it names
the actual database table/column and the timestamp the snapshot was evaluated. Say explicitly:
"rendering this page makes zero live provider requests — this is all read from what's already stored."
Show "Scored" vs. "Not yet scored" as separately counted, and the framework-mapping panel's lack of a
coverage percentage.

## Findings workflow

Open **Findings**. Show that filters are validated server-side (an invalid value is rejected by name,
not silently ignored). Open one Finding and walk its Risk v1 explanation table — point at a factor in
each of the three states if the seeded data has one (`Applied`, `Not available`, `Not applicable`).

## Provider enrichment walkthrough

On the same Finding, open the provider-evidence panel. Two paths depending on what's configured for this
demo run:

- **If a provider has a real key configured**: trigger a fresh lookup (ADMIN/ANALYST only) and show the
  result land with its own status and timestamp. Say plainly: "this is one piece of context, not a
  verdict — the analyst still decides."
- **If no provider key is configured** (the default, safest choice for a public demo): show the panel's
  `NOT_CONFIGURED`/`SKIPPED_DISABLED` state instead, and say why that's the correct behavior, not a
  broken one — "every one of these six providers is optional, and the workflow doesn't care whether
  they're on."

Either way, do **not** trigger a live lookup against a provider you haven't already rehearsed — an
unfamiliar live response (a 429, a timeout) live on stage is a worse outcome than a calm, planned
`NOT_CONFIGURED` state.

## AI assistance walkthrough

Only if `AI_ENABLED=true` in the demo environment (it is not, by default). If enabled:

1. On the Finding, request a summary or explanation draft (Analyst).
2. Show the draft rendered with its status badge (`DRAFT`) and the advisory note that accepting only
   records a human decision.
3. Sign in as Reviewer and accept or reject it — this is the moment to say "the role that requested the
   draft cannot also decide it."

If AI is disabled (the shipped default): open the AI panel anyway and show the disabled state directly —
"this is off by default, and there is no live AI provider in this codebase at all right now — this
screen is showing you the honest, current state, not a limitation being hidden."

## ATT&CK mapping walkthrough

On the case (not the Finding), open the framework mapping workspace. Show an existing NIST CSF mapping
(control-gap basis). Then attempt to add an ATT&CK mapping justified only by "the host exposes RDP and
has a high risk score" — the server refuses it. This is the single most concrete "evidence, not proof"
moment in the whole demo; give it room.

## Offline fallback

Rehearse this ahead of time, don't discover it live:

```bash
JWT_SECRET="$(openssl rand -base64 48)" \
  docker compose -f docker-compose.yml -f docker-compose.offline.yml up -d
```

This blackholes every provider host at the DNS level inside the container. The demo is otherwise
identical — ingestion, cases, notifications, and export all complete; a provider panel simply shows
"unavailable." See `docs/DEPLOYMENT.md` → "Offline / demo-without-internet mode."

If offline mode wasn't rehearsed and the venue's network fails anyway: the seeded dataset already
contains completed enrichment results from the last rehearsal, so Finding-detail pages still show
historical provider evidence — you just cannot trigger a *new* live lookup. Say so plainly if asked.

## Recovery if a provider API is unavailable mid-demo

- A single provider timing out or rate-limiting is not a demo failure — it's the exact "evidence, not
  proof, and failure never blocks the workflow" claim happening live. Say that out loud, calmly, and
  move on: "that's the provider being unavailable, and you can see the finding is still fully usable."
- If it happens on a provider you were about to demonstrate live, fall back to the `NOT_CONFIGURED` /
  historical-result framing from "Provider enrichment walkthrough" above instead of retrying live.
- Never re-trigger the same lookup repeatedly on stage trying to get a different result — one attempt,
  narrate whatever it returns, move to the next section.

## Closing talking points

- Restate the tagline: "Connecting Intelligence with Action."
- "Ready for technical review" — not "ready for deployment." Redirect any adoption question to the
  honest-limits section (Slide 15) rather than answering optimistically.
- Invite the audience to read `docs/PROJECT_PLAYBOOK.md` afterward if they want the single-document
  version of everything just walked through.
