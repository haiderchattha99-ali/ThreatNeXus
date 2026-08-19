# Handoff: TNX-DOC-EVIDENCE-PREP

- From: claude
- Suggested next writer: unassigned — evidence base complete, PR open
- Branch: `docs/final-evidence-prep` (from `origin/main` @ `2bda0e5`, the merge of PR #30)
- Worktree: `F:\AI-Worktrees\ThreatNeXus\final-doc-evidence` (isolated — the primary checkout was never touched)
- Writer lease: `d3de04ef-2322-42f5-9d38-48752443e3aa`
- Updated: 2026-08-19

> Note for any future writer: `handoff-task.ps1` overwrites this file with a short template on every
> run. If you run it, restore the detail below from the prior commit afterwards — the template alone
> loses the evidence and the traps.
>
> The previous ticket's handoff (TNX-FINAL-FRONTEND-POLISH, PR #30) remains recoverable in full with
> `git show 2bda0e5:docs/ai/HANDOFF.md`.

**Status: complete.** This ticket wrote **no final document, deleted nothing, reviewed nothing, and
contacted no provider.** It exists only to close the factual blockers that stood between the merged
product and the official documentation set.

## What this ticket produced

### 1. `docs/evidence/CONTROLLED-LIVE-CANARY-RECORD.md`

The TNX-P10C4 controlled live GreyNoise canary, rescued out of Git history into a permanent current
file.

**The problem it fixes is structural, and it will recur.** `docs/ai/HANDOFF.md` and
`docs/ai/STATE.yaml` are *rolling* documents — every ticket overwrites them. The canary evidence was
merged to `main` at `914d582` and is still in Git, but it is no longer in either file's current
checkout. The strongest live-provider evidence this project has was one `git log` away from being
effectively lost.

Everything required is preserved: ticket, provider, subject `1.1.1.1`, MANUAL lane, explicit human
authorisation, 17/17 pre-live preflight, run/job/attempt IDs all `1`, exactly one contact,
`NOT_FOUND` / HTTP 404, job `NO_RECORD`, run `SUCCEEDED`, attempt `FINISHED`/`NOT_FOUND`,
`contactedProvider=true`, reservation 1 against a budget of 1, no retry, verified rollback to
worker-off and `EXECUTION_PAUSED`, disposable volume destroyed, no secret exposure, no second
contact, and 10C-5 closing the response-body residual afterwards.

**No provider was contacted to produce this record and no API key value appears in it.**

The scope limitation is stated as prominently as the success: the canary proves the approved
GreyNoise *direct-worker* path, and confers no live proof on `abuseipdb`, on the delegated lane, on
the four legacy synchronous provider routes, or on any non-local environment.

### 2. `docs/evidence/EXTERNAL-DATA-ACCESS-RECORD.md`

Three classes that are never blurred: **REPOSITORY-DOCUMENTED FACT**, **PROJECT-TEAM ATTESTATION**,
**CURRENT STATUS**.

Every repository claim was verified against the file it cites before being written — `STATUS.md` for
Shadowserver ticket `#7ibziiin`, `PROJECT_PLAYBOOK.md` and `PROVIDER_GUIDE.md` for live scheduled
ingestion being out of scope, `data/synthetic/README.md` for `accessible-rdp.synthetic.v1` not being
an official Shadowserver schema, `README.md` for a real report being requested and not received, and
a direct scan of every address in `data/synthetic` and `data/demo` confirming they all fall inside
`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` or `198.18.0.0/15`.

The attestation is recorded in neutral professional language, with no blame, no speculation about
reasons, and no implication that the software failed or that Shadowserver data was received.

Both Shadowserver and Rapid7 are classified as **external-data / access dependencies**, never as
software limitations. The record also preserves the category rule that must never be violated:
**scanner-source IP addresses are not exposed-RDP destination hosts.**

### 3. `docs/evidence/PRODUCTION-SIZING-MEASUREMENTS.md`

The audit was right that no measured hardware evidence existed. It does now, and none of it was
invented.

Every figure carries exactly one of **MEASURED**, **REASONED RECOMMENDATION**,
**NOT LOAD-TESTED / SCALE ASSUMPTION**, or **NOT MEASURED**. Where the evidence did not support a
number, the document says NOT MEASURED rather than interpolating.

**No concurrency or load test was performed. No concurrent-analyst count, requests-per-second
figure, throughput rate or HA capacity appears anywhere in it.**

Two results are worth carrying forward:

- **A per-finding byte constant would be fiction, and the measurement proves it.** The first M6
  attempt used the committed historical fixtures; they produced `HISTORICAL` outcomes, created no
  new Findings, and moved `pg_database_size` by *exactly zero bytes* three times out of four,
  because PostgreSQL allocates in 8 KiB pages. A deterministic 500-new-indicator report was then
  ingested three times to get a real denominator: ≈ 4.9 KB per newly created Finding, ≈ 1.2 KB per
  subsequent observation — both explicitly labelled REASONED RECOMMENDATION, not constants.
- **The demo database is 11.92 MiB and its `pg_dump` is 282 KB.** Almost none of that 11.92 MiB is
  data; it is catalog, indexes and pre-allocated pages. Quoting the database size as the cost of 11
  findings would overstate it by roughly 40×.

### 4. `docs/assets/screenshots/final/` — 41 masters plus an index

Captured from the **production build at this exact commit**, against a database created from zero
and seeded deterministically, with providers, worker, automatic enrichment and AI all off. 1440×900
at device pixel ratio 2, dark scheme, clean Chromium profile, animations frozen, **zero console
errors across every capture.**

Both Master screenshots and all 18 Playbook captures are present. The index records route, role,
state, viewport, capture date and source commit for each, and names no AI or tool as author.

### 5. Canonical state reconciled

`docs/ai/STATE.yaml` now carries a `program_status` block recording core engineering **closed**,
security pass **closed** (PR #29), frontend polish **closed / merged** (PR #30), documentation
blueprint **approved**, documentation evidence preparation **completed**, and next stage **MASTER
OFFICIAL DOCUMENT DRAFTING**.

It also carries two new blocks the next writer needs: `documentation_fact_corrections` (the exact
figures and wording corrections the final documents must apply) and `prior_ticket_evidence` (the
commits where each previous ticket's evidence remains recoverable — the habit this ticket exists to
establish).

## Things that were done honestly rather than smoothly

- **One state was created for capture, and it is disclosed.** The demo seed requests *and approves*
  a closure, so no pending closure request survives it and P-10/P-11 had nothing to photograph. A
  second closure request was created on case 1 through the real API and deliberately left pending.
  Its own justification text says why it exists. Nothing else was added and no image was edited.
- **A literal `RESTRICTED`/`UNAVAILABLE` dashboard KPI tile could not be captured** and is marked
  **NOT AVAILABLE FROM CURRENT DEMO DATA**. At demonstration scale every dashboard section resolves
  to a real value; forcing a degraded tile would have meant removing a capability or breaking a data
  source, i.e. staging a state the system is not in. The truthful distinctions that *are*
  reproducible were captured instead: the four risk-factor applicability states, the
  capability-restricted VIEWER section, and the unified route-level refusal.
- **M8 peak memory is NOT MEASURED.** The host sampler failed on a path conversion and the run was
  not repeated. Container samples from the same window could not be cleanly attributed, so they were
  discarded rather than reported as if they meant something.
- **Five backend test files failed locally on 10-second hook timeouts.** That is this machine's
  documented contention pattern, not a regression — the failures are `beforeAll` timeouts and differ
  between runs. Recorded rather than omitted; CI is the authoritative signal.
- **Docker reports two different sizes for the same image on this host.** Both readings are recorded
  with their method instead of quietly choosing the more convenient one.

## Traps worth carrying forward

- **A `-f` compose overlay concatenates its `ports` list with the base file's rather than replacing
  it** — the operational note 10C-4 left behind. This session used a dedicated compose file in the
  scratchpad with absolute build contexts, which avoids it entirely.
- **The backend image does not contain `tests/`**, so the verification suite cannot be run inside
  it. M8 has to run on the host.
- **The backend suite is hermetic by default** (`TNX_SKIP_DOTENV`), and its real-PostgreSQL
  integration tests gate on `TEST_DATABASE_URL`, not `DATABASE_URL`. Without it they self-skip and
  the suite still reports green — 273 tests were skipped even *with* it set.
- **Run `npx prisma generate` after `npm ci`.** A stale client is the documented cause of a large
  block of phantom failures.
- **`pg_database_size` moves in page-sized steps.** Any single before/after ingestion reading can
  legitimately be `+0`. Measure across a batch large enough to clear page granularity.
- **The dashboard KPI is a GSAP count-up.** Read `data-count-to`, never rendered text.

## Protected boundaries honoured

- The primary checkout `C:\Users\LENOVO\Desktop\ThreatNeXus` was **never modified** — its foreign
  presentation changes are exactly as found. All work happened in an isolated worktree.
- A separate `tnxdemo` stack was already running on the default ports and was **left untouched**;
  the measurement stack used isolated ports under its own compose project and was destroyed with
  `docker compose down -v`.
- No `git add -A`; every commit staged explicit paths.
- `backend/.env` was never opened, read, printed or referenced.
- No product source file, dependency, migration, schema or configuration was changed.

## Next action

**STOP.** Do not begin drafting in this session.

The next stage is the **ThreatNeXus Official System & Handover Document** (18-page target, 20-page
hard maximum), then the **Analyst & Operations Playbook**, then the **Knowledge & Defence
Handbook**, and **README last**. Old-document cleanup does not begin until the new set exists.

Before drafting, read `docs/ai/STATE.yaml` → `documentation_fact_corrections`. It carries the
current counts (25 migrations, 165 backend test files, 17 frontend test files, 11 Playwright specs),
the fact that a bounded security assessment *was* completed and that `README.md` currently contains
a false statement to the contrary, the required Finding-versus-Case wording correction, the
architecture-labelling rule, and the frozen document-control decisions on authorship, review status
and adoption language.
