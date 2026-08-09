# Demo Script

A presentation-ready script for demonstrating ThreatNeXus live. This is the condensed cue-card version —
`docs/DEMO_RUNBOOK.md` has the full twelve-minute walkthrough with every talking point spelled out in
detail; read that once before presenting, and use this page as the on-stage reference.

## Before the demo

**Do this the night before, not five minutes before:**

1. Rehearse the exact stack you'll present with, once, end to end. If the venue's internet is
   uncertain, rehearse the offline path too (see "Backup path" below) — the point of a rehearsal is to
   be surprised in private, not in front of an audience.
2. Confirm the four seeded accounts exist and you know the password (`npm run seed:users` +
   `npm run seed:demo` — see `docs/DEPLOYMENT.md`).
3. Have the browser open to the login page already, at a comfortable zoom level, before anyone is
   watching.
4. Know in advance which finding/case you'll open (`docs/DEMO_RUNBOOK.md` uses the seeded Meridian
   Health Trust case) — don't hunt for it live.
5. Turn off notifications/Slack popups on the presenting machine.

## Role sequence and timing (≈12 minutes)

| # | Segment | Role | Time | What to show |
|---|---|---|---|---|
| 1 | Sign in | Analyst | 1 min | The opening motion is a brand graphic only — never telemetry. Fields are usable before the animation finishes. |
| 2 | Dashboard | Analyst | 3 min | value/availability/source/asOf on every tile; "no provider request is made to render this page"; Scored vs Not-yet-scored; framework panel has no coverage %; "Export is not delivery" |
| 3 | Findings | Analyst | 3 min | Dedup identity, rejected invalid filters, ownership confidence labeling, the Risk v1 explanation table with APPLIED/NOT_AVAILABLE/NOT_APPLICABLE |
| 4 | Cases | — | 2 min | Case timeline; **the analyst's own closure self-approval attempt is refused with 403** (this happens live during the seed, not just asserted) |
| 5 | Framework mapping | — | 1 min | A control-gap NIST CSF mapping; an ATT&CK mapping justified only by exposure/risk-score is refused server-side |
| 6 | Notifications | — | 2 min | Immutable revisions, approval bound to the exact revision, `.eml` export, delivery as a separate recorded event |

Then, if time allows: sign in as **Viewer** and show the Notifications section rendering "Not available
to your role" — not zero. That one screen is the whole integrity model in one frame.

## Talking points to hit deliberately

- "This is a research prototype developed during a PKCERT/NCERT internship — not a national deployment,
  not certified or endorsed, and it performs no autonomous internet scanning, no automatic remediation,
  and no automatic email delivery."
- "Every number on this dashboard says where it came from and when it was true. Nothing here is
  estimated."
- "A blank or restricted section is never shown as a zero — that distinction matters because a zero
  looks like good news, and 'I can't tell you' should never look like good news."
- "The separation of duties you just saw refused isn't a policy on a slide — it's a 403 the system
  actually returned."

## Backup path — if internet or a provider API is unavailable

Run the offline rehearsal overlay ahead of time and know it works:

```bash
JWT_SECRET="$(openssl rand -base64 48)" \
  docker compose -f docker-compose.yml -f docker-compose.offline.yml up -d
```

This blackholes every provider host at the DNS level inside the container. The demo is **identical**
with it on — ingestion, cases, notifications, and export all complete; a provider panel simply shows
"unavailable" instead of a live result, which is itself a useful thing to point at: "the system doesn't
break when a third party is unreachable, it records that honestly." See `docs/DEPLOYMENT.md` → "Offline
/ demo-without-internet mode" for the full command sequence.

If you didn't rehearse offline mode and the venue's internet fails anyway: the seeded demo dataset
already contains completed enrichment results from a prior run, so Finding-detail pages still show
historical provider evidence even with no live connectivity — you just cannot trigger a *new* lookup
live. Say so plainly if asked, rather than pretending to trigger one that will hang.

## What this demo does not show, and why (say this if asked, don't wait to be caught)

| Not shown | Why |
|---|---|
| A live threat feed | No live ingestion exists — reports are uploaded files |
| A geographic map | No provenance-backed coordinate is persisted anywhere |
| An ATT&CK coverage percentage | Mappings are analyst context, not catalogue coverage |
| Provider latency/uptime | Never measured, so never displayed |
| A recurrence-reopened case through the UI | Finding closure has no production write path — proven only via `eval:phase1`/`eval:phase3` driving the services directly. This is a real, honest gap: the recurrence *engine* works and is tested; nothing in the UI can currently produce the "closed" state it reopens from. |

## After the demo

Sign out. If the machine will be reused, `docker compose down` (keeps data) or `docker compose down -v`
(wipes it) depending on whether you want the seeded state available for a follow-up question later.
