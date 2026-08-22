# Final Screenshot Library

Canonical screenshot masters for the ThreatNeXus official documentation set. These supersede every
earlier screenshot in this repository: all previous captures predate the final frontend polish pass
(PR #30) and no longer show the shipped interface.

> **Two capture generations live in this directory.** The bulk of the library was captured at
> `2bda0e5`. The two files prefixed `final-` were captured at `fd804ea`, after UX Tickets A/B/C and
> the demonstration accounts merged, and are the only ones that show the current navigation grouping
> and the Provider Intelligence Evidence viewer. Each generation records its own capture conditions —
> see "Official System & Handover Document captures" below. Use the `final-` pair for any new
> document that describes the shipped interface.

**Do not edit these files.** Cropping, scaling and annotation belong to document production. Keeping
the masters unaltered is what allows any figure in the final documents to be traced back to a real
application state.

## Capture conditions

| Property | Value |
|---|---|
| Source commit | `2bda0e551bb28af68975e198e21927baba12628e` (`origin/main`, merge of PR #30) |
| Capture date | 2026-08-19 |
| Frontend | Production build (`npm run build`) served by nginx from the project image — not a dev server |
| Backend | Same commit, containerised, against PostgreSQL 16 |
| Database | Created from zero, 25 migrations applied, then `seed:users` + `seed:demo` |
| Data | Synthetic/demonstration only. Addresses come from ranges reserved for documentation and benchmarking (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `198.18.0.0/15`) |
| Accounts | The four seeded local accounts (`admin` / `analyst` / `reviewer` / `viewer` `@threatnexus.local`). Password supplied per-run from the environment; no credential appears in any capture |
| Providers | All off — no credential configured for any provider |
| Enrichment worker | Off |
| Automatic enrichment | Off |
| AI | Off (`AI_ENABLED=false`, `AI_PROVIDER=null`) |
| Browser | Chromium (Playwright 1.62.1), clean profile, no extensions, no bookmarks bar, no browser chrome in frame |
| Viewport | 1440 × 900 CSS pixels |
| Device pixel ratio | 2 (image files are 2880 × 1800 for viewport captures) |
| Colour scheme | Dark (the product's shipped default) |
| Motion | Animations and transitions frozen at capture time so frames are deterministic |
| Console errors | Zero across every capture in this library |

Captures marked *full page* extend beyond 1440 × 900 to the full scroll height of the document.

## Master document screenshots

| File | Route | Role | State | What it demonstrates |
|---|---|---|---|---|
| `master-dashboard-analyst.png` | `/dashboard` | ANALYST | Demo seed, 11 findings | **M-01.** The analyst operations overview: the day's work ordered by what needs a decision, with every figure carrying its own snapshot time and a "loaded dataset only" qualifier rather than implying national coverage. |
| `master-dashboard-risk-factor-truth-states.png` | `/dashboard` | ANALYST | Demo seed | **M-01 truth layer.** The four distinct states a Risk v1 factor can hold — *Contributing*, *Measured, no weight*, *No evidence read*, *Cannot apply* — each with its own denominator. This is the section where the product refuses to render an unknown as a zero. |
| `master-finding-detail-triage.png` | `/findings/3` | ANALYST | Finding 3, `198.18.7.10:3389`, OPEN, ESCALATED, 3 observations | **M-02.** The R1 decision-first Finding detail: the decision strip (current risk, exposure, observation pressure, owning organization, triage) at the top, section navigation beneath it, and the triage control immediately below — the change that moved "Record triage" off the bottom of a ~3,700px page. |

## Playbook screenshot set

| File | Route | Role | State | What it demonstrates |
|---|---|---|---|---|
| `playbook-01-login.png` | `/login` | unauthenticated | No session | **P-01.** Sign-in. |
| `playbook-02-dashboard.png` | `/dashboard` | ANALYST | Demo seed (full page) | **P-02.** The whole operations overview including the risk-factor breakdown, seven-day ingestion, finding age, workflow pressure and recent case activity. |
| `playbook-03-findings-filters.png` | `/findings` | ANALYST | 11 findings | **P-03.** Findings workspace with severity-first rows and the filter controls. |
| `playbook-04-finding-detail-sections.png` | `/findings/3` | ANALYST | Finding 3 (full page) | **P-04.** The complete Finding detail information architecture and its section navigation. |
| `playbook-05-risk-explanation.png` | `/findings/3` | ANALYST | Risk v1 section | **P-05.** The deterministic risk explanation: algorithm identity and version, per-factor stored input, applicability state, and points awarded out of the factor's cap. Rebuilt from stored contributions — nothing generated. |
| `playbook-06-ownership-confidence.png` | `/findings/3` | ANALYST | Identity and owner section | **P-06.** Identity, observation history, and ownership resolution with its confidence and the rule that produced it. |
| `playbook-07-triage.png` | `/findings/3` | ANALYST | Triage section | **P-07.** The triage decision control and its append-only history, with triage held explicitly separate from the OPEN/CLOSED exposure state. |
| `playbook-08-cases-list.png` | `/cases` | ANALYST | 3 demo cases | **P-08.** Case list. |
| `playbook-09-case-detail.png` | `/cases/1` | ANALYST | `TNX-2026-000001`, lifecycle `WAITING_FOR_ORG` | **P-09.** Case detail with linked findings as evidence. |
| `playbook-10-closure-request.png` | `/cases/1` | ANALYST | Lifecycle `CLOSURE_PENDING`, request `ACCEPTED_RISK`, state `PENDING` | **P-10.** A closure request awaiting review, from the requesting analyst's side. |
| `playbook-11-reviewer-approval.png` | `/cases/1` | REVIEWER | Same request, reviewer view | **P-11.** The closure review control — "Closing a case takes two people: an analyst requests, a reviewer decides. The requester may not approve their own request." Approve / reject with a review note required to reject. |
| `playbook-12-framework-mapping.png` | `/cases/1` | ANALYST | NIST CSF `PR.AA-05` mapped | **P-12.** Manual framework mapping, labelled as analyst-associated context and explicitly not a compliance determination. |
| `playbook-13-attack-constraint.png` | `/cases/1` | ANALYST | Explicit no-applicable ATT&CK determination recorded | **P-13.** The ATT&CK observed-behaviour constraint. An exposure-only case cannot be mapped to a technique; the recorded outcome is an explicit determination that none applies, not a silent absence. |
| `playbook-14-notification-draft.png` | `/notifications/1` | ANALYST | `TNX-NOT-2026-000001`, lifecycle `APPROVED` | **P-14.** Notification drafted from case evidence. |
| `playbook-15-revision-history.png` | `/notifications/1` | ANALYST | 1 revision | **P-15.** Immutable revision history. |
| `playbook-16-notification-approval.png` | `/notifications/1` | REVIEWER | Approved against revision 1 (full page) | **P-16.** Reviewer approval bound to an exact revision. |
| `playbook-17-export.png` | `/notifications/1` | ANALYST | 1 export recorded | **P-17.** Approved-revision `.eml` export. The screen states plainly that export is not delivery — ThreatNeXus never sends a notification. |
| `playbook-18-settings-providers.png` | `/settings` | ADMIN | Worker paused, automatic ingestion off, every provider `Not configured`, budgets `0 / 0 / 0` | **P-18.** Enrichment readiness and budgets, in the default-off state this instance actually runs in. |

## Supporting captures

Not part of the required sets, but truthful states the documentation may need.

| File | Route | Role | Demonstrates |
|---|---|---|---|
| `supporting-dashboard-viewer.png` | `/dashboard` | VIEWER | The read-only "Operational picture" — a different dashboard, not the analyst one with controls hidden. |
| `supporting-dashboard-viewer-restricted.png` | `/dashboard` | VIEWER | A capability-restricted section rendering *Restricted for this role* / *Not available to your role* rather than an empty or zeroed panel. |
| `supporting-dashboard-reviewer.png` | `/dashboard` | REVIEWER | Reviewer view. |
| `supporting-dashboard-admin.png` | `/dashboard` | ADMIN | Admin view. |
| `supporting-denied-state-analyst-settings.png` | `/settings` | ANALYST | The single unified route-level refusal state, stating that the server enforces the check independently and would refuse the underlying request with HTTP 403 regardless. |
| `supporting-findings-viewer-readonly.png` | `/findings` | VIEWER | Findings without write controls. |
| `supporting-finding-reputation-cves.png` | `/findings/3` | ANALYST | IOC reputation and vulnerability enrichment with no stored result — the truthful empty state. |
| `supporting-finding-enrichment-ai-disabled.png` | `/findings/3` | ANALYST | Provider enrichment panel and the AI assistance panel in its disabled default. |
| `supporting-case-detail-fullpage.png` | `/cases/1` | ANALYST | Case 1 end to end, closure pending. |
| `supporting-case-closed-fullpage.png` | `/cases/2` | ANALYST | `TNX-2026-000002`, lifecycle `CLOSED` after an approved closure request. |
| `supporting-case-reviewer-fullpage.png` | `/cases/1` | REVIEWER | Case 1 end to end from the reviewer's side. |
| `supporting-notifications-list.png` | `/notifications` | ANALYST | Notification list. |
| `supporting-notification-fullpage.png` | `/notifications/1` | ANALYST | Notification 1 end to end. |
| `supporting-report-ingestion.png` | `/upload` | ANALYST | Report ingestion screen, idle. |
| `supporting-attack-navigator.png` | `/attack` | ANALYST | ATT&CK navigator. |
| `supporting-analytics.png` | `/analytics` | ANALYST | Analytics. |
| `supporting-organizations-admin.png` | `/organizations` | ADMIN | Constituent organizations. |
| `supporting-settings-provider-evidence.png` | `/settings` | ADMIN | Stored provider evidence freshness and the disabled AI assistance block. |
| `supporting-settings-fullpage.png` | `/settings` | ADMIN | Settings end to end. |
| `supporting-findings-fullpage.png` | `/findings` | ANALYST | Findings workspace end to end. |

## Official System & Handover Document captures (`fd804ea`)

**These two, and only these two, are current for the shipped interface.** Every other capture in this
file was taken at `2bda0e5`, which predates UX Tickets A, B and C (PRs #35, #36, #39) and the
demonstration accounts (PR #38). The earlier captures remain valid evidence of the states they
recorded and are unaltered, but the navigation grouping, the decision-first Finding Detail layout and
the Provider Intelligence Evidence viewer that the current build has are not visible in them.

Capture conditions differ from the block at the top of this file in exactly two respects:

| Property | Value |
|---|---|
| Source commit | `fd804ea` (`origin/main`, after PRs #38 and #39) |
| Capture date | 2026-08-22 |
| Providers | **Live**, credentialed, MANUAL lane only — see below |
| Enrichment worker | On (MANUAL lane only); automatic enrichment off |
| Everything else | As the conditions block above: production nginx build, PostgreSQL 16, database from zero then `seed:users` + `seed:demo`, Chromium clean profile, 1440 × 900 at DPR 2, dark, motion frozen, **zero console errors** |

The provider departure is the point. The Provider Intelligence Evidence viewer cannot be shown
truthfully against a stack holding no provider evidence, so one MANUAL-lane enrichment run was
performed against the demonstration Finding using real credentials. **The evidence in
`final-provider-evidence-drawer.png` is a genuine provider answer, not a fixture:** AbuseIPDB returned
0 % abuse confidence over 9 reports for a reserved documentation address, which is the correct answer
for such an address. Nothing in either capture is fabricated beyond the synthetic dataset itself.

| File | Route | Role | What it demonstrates |
|---|---|---|---|
| `final-dashboard-analyst.png` | `/dashboard` | ANALYST | Figure 1 of the handover document. The shipped navigation grouping (Operations / Response / Insight / Administration) and the analyst operations overview, every figure carrying its own snapshot time and a "loaded dataset only" qualifier. |
| `final-provider-evidence-drawer.png` | `/findings/11` | ANALYST | Figure 2. The Provider Intelligence Evidence viewer open on a real AbuseIPDB result, showing the stored normalised evidence alongside the execution record — provider contacted, recorded via, retrieved, freshness. Demonstrates that the row summary is a preview and the drawer is the detail, and that the panel itself states raw upstream bodies are never retained. |

## Demo-readiness supporting captures

Preserved from a second, independently-captured screenshot set (`docs/evidence/screenshots/`,
`docs/final-demo-evidence` branch, commit `2612cbc`) at the same 2026-08-19 consolidation that merged
this file's own governing evidence documents. Two of that set's four images were fully redundant
with the master/playbook/supporting captures above and were not carried forward; these two prove a
fact nothing above proves — the exact pre-request state the PKCERT live demonstration begins from,
on the specific primary Finding (`A`) that `docs/demo/DEMO-READINESS.md` selects for it.

| File | Route | Role | State | What it demonstrates |
|---|---|---|---|---|
| `demo-readiness-finding-a-decision-first.png` | `/findings/7` | ANALYST | Finding **A** (`203.0.113.11`, 3389/TCP) — the primary demonstration Finding | Decision-first detail for the specific Finding the live demonstration runbook uses, distinct from Finding 3 in the master/playbook set above. |
| `demo-readiness-enrichment-before-request.png` | `/findings/7` | ANALYST | Same Finding, Enrichment coverage expanded, **pre-request** | Direct evidence that the demonstration's opening state is correct: every provider row reads "Not requested" (no fresh result exists, so the first analyst click cannot be skipped), the offered action is *Request enrichment* not a repeated-run path, NVD truthfully reports no qualifying subject, and AI assistance shows Disabled. Captured only *after* the bounded rehearsal, database reset and non-contact preflight returned `DEMO READY` (16/16) — it does not show a rehearsed or "skipped" state. |

Capture conditions for these two: 1600×1000 viewport at 2× device scale, full page, signed in as
`analyst@threatnexus.local`, 0 browser console errors, commit `2612cbc`. Differs from the capture
conditions table above (1440×900, dark scheme, commit `2bda0e5`) because it is a separate capture
session; neither invalidates the other.

## States created for capture

Every state in this library was produced by the application itself. One state was created
deliberately because the demonstration seed does not leave it behind:

- **A pending closure request (P-10, P-11).** The demo seed requests *and approves* a closure on
  case 2, so no request is left awaiting review. A second closure request was created on case 1
  through the real API (`POST /api/cases/1/closure-requests`, `ACCEPTED_RISK`) as the seeded analyst
  account, and deliberately **not** approved. Its justification text says in the record itself that
  it exists to illustrate the pending state.

Nothing else was added, and no screenshot was altered after capture.

## States that could not be captured

- **A literal `RESTRICTED` or `UNAVAILABLE` KPI tile on the analyst dashboard** —
  **NOT AVAILABLE FROM CURRENT DEMO DATA.** At demonstration scale every section the analyst
  dashboard reads resolves to a real value, so no tile degrades. Producing one would require either
  removing a capability from the analyst role or breaking a data source, both of which would stage a
  state the running system is not in. The equivalent truthful distinctions that *are* reproducible
  are captured instead: the four risk-factor applicability states
  (`master-dashboard-risk-factor-truth-states.png`), the capability-restricted VIEWER section
  (`supporting-dashboard-viewer-restricted.png`), and the route-level refusal
  (`supporting-denied-state-analyst-settings.png`).
- **A recurrence (reopened) case.** The demo seed reports `recurred=0`; no finding has recurred
  after closure, so no reopen badge exists to photograph.
- **Any live provider result.** Every provider is unconfigured in this instance, so every provider
  panel truthfully shows no stored success. The one live provider request this project has ever made
  is recorded in `docs/evidence/CONTROLLED-LIVE-CANARY-RECORD.md`; it was not repeated for
  screenshots.

## Reproducing

1. Check out `2bda0e5`.
2. Build and start the stack with providers, worker, automatic enrichment and AI all off.
3. Apply migrations from an empty database, then run `seed:users` and `seed:demo`.
4. Drive Chromium at 1440 × 900, device pixel ratio 2, dark colour scheme, against the production
   build.
5. For P-10 and P-11, create the pending closure request described above first.
