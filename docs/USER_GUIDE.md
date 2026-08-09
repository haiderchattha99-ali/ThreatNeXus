# User Guide

This guide covers how to use ThreatNeXus day to day, by role. For what each role is actually permitted
to do at the API level, see `docs/ADMIN_GUIDE.md`'s role/capability matrix — this guide describes the UI
consequences of that matrix, not a separate policy.

## Signing in

Open the frontend (`http://localhost:5173` in a local Compose stack) and sign in with an email and
password. If you're using the local demo accounts (created by `npm run seed:users`, never present in a
real deployment):

| Role | Account |
|---|---|
| Administrator | `admin@threatnexus.local` |
| Analyst | `analyst@threatnexus.local` |
| Reviewer | `reviewer@threatnexus.local` |
| Viewer | `viewer@threatnexus.local` |

All four share whatever password was passed to `SEED_USER_PASSWORD` when the seed ran — that value is
never printed by the script and is not documented here because it isn't fixed; ask whoever ran the seed.

A session lasts as long as the issued JWT (`JWT_EXPIRES_IN`, 24h by default). There is no "remember me"
or refresh mechanism — signing out and back in issues a fresh token.

## Navigation and what each role sees

The sidebar shows only pages your role holds the capability for — this is a convenience, not the actual
security boundary (the backend re-checks independently on every request regardless of what the sidebar
shows). The pages:

| Page | Route | Who sees it |
|---|---|---|
| Operations overview (dashboard) | `/dashboard` | Everyone |
| Findings | `/findings`, `/findings/:id` | Everyone |
| Analytics | `/analytics` | Everyone (reads findings) |
| Upload | `/upload` | ADMIN, ANALYST |
| Cases | `/cases`, `/cases/:id` | Everyone (read); write actions vary — see below |
| ATT&CK navigator | `/attack` | Everyone who can read cases |
| Notifications | `/notifications`, `/notifications/:id` | ADMIN, ANALYST, REVIEWER — **not VIEWER** |
| Organizations | `/organizations` | ADMIN only |
| Settings | `/settings` | ADMIN only |
| Profile | `/profile` | Everyone (personal page, no capability check beyond being signed in) |

## Dashboard — the operations overview

Every figure on this page carries four things: **value · availability · source · asOf**. Hover or read
the caption under any tile and it names the actual database table/column behind the number and the
instant the snapshot was evaluated — this page is never guessing or estimating.

A few things that are true by design, not by accident:

- **"Loaded dataset only."** This is never presented as a national or internet-wide measurement.
- **Rendering this page makes zero live provider requests.** Provider status comes from configuration
  plus previously stored lookup rows.
- **A Finding with no current risk score is counted separately** — "Not yet scored" is never folded
  into the lowest risk band.
- **Framework mappings are analyst context, not a compliance claim.** There is no coverage percentage
  and no denominator over any catalogue, because the system has no truthful way to know which
  techniques *should* apply to your environment.
- **"Export is not delivery."** Producing a notification file is a different, separately-tracked event
  from actually sending it — this system has no SMTP or webhook client at all.
- **A section you may not read shows "Not available to your role" — never a zero.** Sign in as VIEWER
  and the notifications section demonstrates this directly.

## Findings

One row is one `(indicator, port, protocol, report type)` identity. Uploading the same host again does
not create a second row — it appends an occurrence and bumps `occurrenceCount`. Filters are validated
server-side: an invalid filter value is **rejected** by name, never silently ignored in favor of a
different result set.

Open a Finding to see:

- **Ownership** — how the owning organization was resolved and at what confidence. An
  ASN-based attribution is labeled low-confidence, because an autonomous system number identifies a
  network operator, not necessarily the affected constituent.
- **Risk v1 explanation** — rendered entirely from the stored factor-contribution rows, never
  recalculated for display. Each factor is `APPLIED` (scored, including a legitimate zero),
  `NOT_AVAILABLE` (could not be obtained — never shown as "clean"), or `NOT_APPLICABLE` (doesn't apply
  to this finding type).
- **Provider enrichment** — a per-provider panel (Censys, GreyNoise, Shodan, Netlas, AbuseIPDB,
  NVD/KEV/EPSS) showing the latest stored result and, if your role holds
  `trigger:finding-enrichment` (ADMIN/ANALYST), a button to request a fresh lookup. See
  `docs/PROVIDER_GUIDE.md` for what each provider's evidence means and does not mean.
- **AI assistance panel** (if `AI_ENABLED=true` and a provider is configured — off by default) — request
  a summary or explanation draft, and, if your role holds `review:ai-suggestions` (ADMIN/REVIEWER),
  accept or reject it. A draft is never presented as a finding fact: it always carries a status badge
  and a note that accepting only records a human decision. See `docs/AI_GOVERNANCE.md`.

## Upload (ADMIN, ANALYST)

Uploads a Shadowserver-style Accessible RDP exposure CSV. The system validates structure and each row,
deduplicates against existing findings on `(indicator_value, port, protocol, report_type)`, and reports
the outcome. An unauthorized caller's upload attempt never even writes a temp file — the capability
check runs before the file-parsing middleware.

## Triage (ADMIN, ANALYST)

From a Finding or the Findings list, an analyst can change triage status. This is the entry point into
the case workflow: triaging what needs a decision, then opening an organization-bound Case for it.

## Cases

Everyone can read a case (VIEWER included, for oversight); writing to one requires `manage:cases`
(ADMIN, ANALYST). A case's timeline shows creation, evidence linked, waiting-for-organization,
organization response.

**Separation of duties is enforced, not just documented**: the analyst who requests a case closure can
never approve their own request — a `403` is the actual, verified behavior, not a policy statement. Only
a REVIEWER (or an ADMIN, via an explicit override capability) can approve. A `REMEDIATED` closure
additionally requires the organization to have actually responded that it was remediated — requesting
one without that recorded response is refused with `REMEDIATED_RESPONSE_REQUIRED`.

## ATT&CK mapping

On a case's framework workspace, an analyst can record MITRE ATT&CK, NIST CSF, or CIS Controls mappings.
ATT&CK specifically requires **observed adversary behaviour** as evidence — a mapping justified only by
"the host is exposed" or "the risk score is high" is refused server-side, not just discouraged in the
UI. A mapping cites a verbatim stored quote as its evidence and carries its own confidence value,
separate from any other score. AI-suggested mappings (if enabled) go through the exact same rule and the
exact same write path as a manually entered one — see `docs/AI_GOVERNANCE.md`.

## Notifications (ADMIN, ANALYST draft/export; ADMIN, REVIEWER approve — not VIEWER at all)

An analyst drafts a notification from a case's evidence, edits it (each edit is an immutable new
revision — editing an approved draft invalidates that approval, always, by stored state), and submits it
for review. A reviewer approves or rejects the **exact revision** they read — approval never silently
carries forward to a later edit. An approved notification can be exported as an RFC 5322 `.eml` file for
the analyst to send by hand; delivery (what actually happened after sending) is a separately recorded
observation, never assumed from the export event.

## Denied and restricted states

Two distinct "no" states appear throughout the UI, and they mean different things:

- **Denied (403)**: your role does not hold the capability for this action. Shown inline where the
  action would have been, never as a silent disappearance.
- **Restricted**: on the dashboard specifically, a section your role cannot read at all shows
  "Not available to your role" rather than a zero — because a real zero and "I'm not allowed to see
  this" must never look the same.

Neither state is a bug to work around — both are the access-control model working as designed. See
`docs/ADMIN_GUIDE.md` for the full capability list if you believe a role is missing a grant it should
have.
