# Handoff: TNX-DEMO-INGESTION-REPAIR

- From: claude
- Suggested next writer: codex (independent review)
- Branch: `fix/analyst-report-ingestion-contract` (from `origin/main` @ `c3f8a4b`)
- Worktree: `F:\AI-Worktrees\ThreatNeXus\ingestion-repair` (isolated — the primary checkout was never touched)
- Updated: 2026-08-11T12:20:00Z

## Root cause

`frontend/src/pages/Upload.jsx` called `threatService.uploadCSV()`, which posts to the **legacy**
`POST /api/threats/upload`. That route runs `threatController.uploadThreatCSV` and writes standalone
`Threat` rows. It creates **no** `RawReport`, no `RawReportRow` evidence, no `Finding`, no
`FindingOccurrence`, no ownership resolution, no enrichment scheduling, no risk recalculation, and no
`report.ingestion.*` audit event. The page then rendered its "Report processed" heading from that
route's `"{added} threat(s) added successfully"` message — so an analyst got a success screen for an
upload the Findings workspace, the occurrence history and the operational overview never received.

One detail the ticket did not state, and which makes the diagnosis certain: **`Upload.jsx` already
read `result.findingCounts`** — a field only the *canonical* controller returns. The lifecycle chips
were dead code against the legacy response body. The page had been written for the right contract and
wired to the wrong one.

Two test layers should have caught this and structurally could not:

- `Upload.test.jsx` mocked `threatService.uploadCSV` and asserted it was called. A service-layer mock
  can only prove "the page called the function the test named" — it cannot notice that the function
  talks to the wrong backend route.
- `findingsUpload.spec.js` asserted that a heading reading "Report processed" appeared. Its own
  comment even quoted the legacy `"N threat(s) added…"` toast, so the wrong contract was visible in
  the test file and still read as green.

## What changed (7 files, frontend + docs only)

| File | Why |
|---|---|
| `frontend/src/services/api.js` | New `reportIngestionService.uploadReport()` → `POST /reports/upload`. `threatService.uploadCSV` left in place for the legacy Threat screens. |
| `frontend/src/constants/reportIngestion.js` *(new)* | The closed outcome vocabulary, mirroring the controller's `OUTCOME_RESPONSE` table — status→result classifier, badge dictionary, headlines, screen-owned prose, `safeReasonCode()`, `reportFacts()`. |
| `frontend/src/pages/Upload.jsx` | Renders the server-assigned outcome, the persisted report facts, and lifecycle counts **only** on a real 201. |
| `frontend/src/pages/Upload.test.jsx` | Rewritten to stub `axios`, not the service layer, so the literal URL is asserted. 14 tests. |
| `frontend/e2e/findingsUpload.spec.js` | Deepened from a heading assertion to the full evidence chain + an idempotency proof. 5 tests. |
| `docs/OPERATIONS_RUNBOOK.md`, `docs/ai/SECURITY.md` | Two lines corrected against `app.js` — see "Documentation corrections" below. |

**`git status --porcelain backend/` is empty.** No backend route, controller, service, middleware,
Prisma schema, migration, backend test or `package.json` anywhere in the repository was touched, and
no dependency was added.

## Final frontend→backend contract

```
POST /api/reports/upload
Content-Type: multipart/form-data
Body: exactly one field, "file"
```

`source` (`SYNTHETIC_UPLOAD`), `reportType` (`ACCESSIBLE_RDP`) and `schemaVersion`
(`accessible-rdp.synthetic.v1`) stay **server-decided** in `reportIngestionController.js` and are read
from no request field. The browser cannot claim a provider, report type or schema version it was not
given — asserted directly (`[...formData.keys()]` is exactly `['file']`).

### How the outcome is determined, and why it is not "any 2xx wins"

The controller does **not** put `outcome` in the response body. It does map each member of the closed
`INGESTION_OUTCOMES` set to exactly one distinct status, so the status *is* the outcome:

| Status | Result | Evidence recorded? |
|---|---|---|
| 201 | `PROCESSED` | yes — lifecycle counts rendered |
| 200 | `DUPLICATE_COMPLETED` | already on file — **nothing recorded again**, no counts shown |
| 409 | `DUPLICATE_IN_PROGRESS` | no |
| 400 | `REJECTED` | no |
| 422 | `UNPROCESSABLE_NO_VALID_ROWS` | no |
| 500 | `FAILED` | partial, kept as-is |
| 413 / 429 / 403 / no response | `TOO_LARGE` / `RATE_LIMITED` / `DENIED` / `UNAVAILABLE` | never entered the pipeline — named separately, on purpose |

That 200 row is the important one: under the legacy contract every 2xx rendered "Report processed".
A replay that recorded nothing now says **"Already ingested"** and shows no lifecycle counts, even if
a body carried some (there is an explicit test for that).

### Error safety

No server free text reaches the DOM. Every message is the screen's own copy, held in
`constants/reportIngestion.js`. The **only** server-supplied value rendered is the backend's bounded
`reason` CODE, and it is shape-checked (`/^[A-Z][A-Z0-9_]{0,63}$/`) before rendering — anything else is
dropped. A test drives a response body carrying a filesystem path, a stack frame, a provider key
fragment and an uploaded row's contents, and asserts none of it appears.

## Proof that a real Finding is created — and that a replay creates none

Read directly out of PostgreSQL after the browser run, not off the screen:

```
     sourceFileName      |     status      | read | accepted | rejected | attempts |   file_id
-------------------------+-----------------+------+----------+----------+----------+--------------
 demo_01_baseline.csv    | COMPLETED       |    9 |        9 |        0 |        1 | 635a91f44197
 demo_02_persistence.csv | COMPLETED       |    6 |        6 |        0 |        1 | ed67f5a6d4b7
 demo_03_latest.csv      | COMPLETED       |    5 |        5 |        0 |        1 | 617a4f99466d
 e2e-ingestion-probe.csv | PARTIALLY_VALID |    3 |        2 |        1 |        1 | d8e3cda7ef2d
 e2e-ingestion-probe.csv | PARTIALLY_VALID |    3 |        2 |        1 |        1 | dcc62a2790d1

 indicatorValue | port | protocol | status | occurrenceCount | recurrenceCount
----------------+------+----------+--------+-----------------+-----------------
 198.18.151.172 | 3389 | TCP      | OPEN   |               1 |               0
 198.18.151.52  | 3389 | TCP      | OPEN   |               1 |               0
 198.18.196.180 | 3389 | TCP      | OPEN   |               1 |               0
 198.18.196.60  | 3389 | TCP      | OPEN   |               1 |               0

              action              | outcome | count
----------------------------------+---------+-------
 report.ingestion.completed       | SUCCESS |     3
 report.ingestion.partially_valid | SUCCESS |     2
 report.ingestion.started         | SUCCESS |     5
```

**Idempotency**, three ways in one table: the probe file was uploaded twice and the demo fixture was
uploaded again on top of `seed:demo`'s own ingestion — yet there is exactly **one** `RawReport` per
sha256, `processingAttempts` is still **1** on every row, `occurrenceCount` is still 1, and there are
**five** `report.ingestion.started` events for five distinct files with **none** for any replay. The
duplicate short-circuits *before* the attempt increment.

`IocEnrichment` holds 15 rows, all `provider=abuseipdb status=PENDING` — scheduled durably by
ingestion, never executed. No provider was contacted.

## Test evidence

**Unit / component — `Upload.test.jsx`, 14 tests.** The seam moved from the service layer down to
`axios`, so `../services/api` is the *real* module and the assertions are made against the literal URL
that reaches the HTTP client.

> **Red-checked.** Before trusting it, `Upload.jsx` was temporarily re-pointed at
> `threatService.uploadCSV` and the contract test was confirmed to fail:
> `Expected: "/reports/upload", Received: "/threats/upload"`. Then restored, re-run green. A test that
> cannot fail on the regression it exists to catch would have repeated the original mistake.

Covered: canonical URL asserted / legacy URL never called · only `file` crosses the wire · PROCESSED
renders persisted facts and real lifecycle counts · DUPLICATE_COMPLETED is not a new import and never
shows counts (even when a body carries them) · IN_PROGRESS / REJECTED + bounded reason code / non-code
reason dropped / EMPTY / FAILED / transport-failure-is-not-success · 403 renders access-refused ·
and the **real** shared interceptor is exercised directly to prove 401 clears the session and 403 does
not.

**Real-stack Chromium — `findingsUpload.spec.js`, 5 tests**, driving the production build against a
real backend and a real PostgreSQL:

1. upload → **request URL asserted on the wire** (`/api/reports/upload`, never `/threats/`)
2. → 201 `PROCESSED`
3. → persisted counters: rows read 3, accepted 2, rejected 1, status `PARTIALLY_VALID`, a report
   reference, a 12-hex file identity
4. → `New findings created: 2`
5. → **the Finding itself**, found by the exact indicator that upload introduced, showing
   `Times observed = 1`, `Recurrences after closure = 0`
6. → Operations overview refreshed, `Open findings` up by exactly 2
7. **idempotency**: identical bytes re-uploaded → "Already ingested", no lifecycle counts, **same
   report reference**, still exactly one Finding row, still one observation
8. the demo fixture replays as a duplicate rather than double-counting
9. VIEWER: denied in place, **no upload request leaves the browser at all**, session survives

## A real defect found in the test harness during the live run

The first live run failed with `Expected: 13, Received: 10` on the dashboard delta. That was neither a
product bug nor a reason to relax the assertion: `components/ui/Metric.jsx` animates a KPI with a GSAP
count-up, and `innerText` was read while the digits were still climbing. The authoritative figure is
the **`data-count-to`** attribute, written straight from `metric.value`, and it is present *only* when
the figure is a real counted number — so reading it also yields a correct `null` for
`RESTRICTED`/`UNAVAILABLE` tiles instead of a coerced zero.

**Any future E2E that reads a dashboard metric must read `data-count-to`, never the rendered text.**

## The F-drive writer-lock gap is fixed, not worked around

Every handoff since Phase 8B recorded that `start-task.ps1` "throws against this repo's STATE.yaml
schema" and that "no working `.ai-team/WRITER_LOCK.json` mechanism exists for this repo". The cause is
small: the scripts assign `$state.current_work`, `$state.files_changed`, `$state.validation.passing`
and `$state.validation.failing`, and none of those keys existed here.

Commit `4c60ed0` adds the four keys (empty values, nothing else changed). It had to be committed
*alone and first*, because `Assert-TeamClean` refuses a dirty tree — and fixing the schema is what
makes the tree dirty. After that, `start-task.ps1` succeeded and this repository held a real
`.ai-team/WRITER_LOCK.json` for the first time. `checkpoint-task.ps1` should now work too.

## Local verification stack (all in the session scratchpad, nothing committed)

Compose project `tnx-ingestion`, conflict-free ports: postgres `55432`, backend `5100`, Playwright
preview `4273`. 23 migrations applied from zero; seeded with `npm run seed:users` + `npm run seed:demo`
(11 findings). `JWT_SECRET` freshly generated per run; **every provider key resolved empty**,
`IOC_ENRICHMENT_PROVIDER=mock`, `AI_ENABLED=false`.

Two traps this repository has recorded before, both avoided deliberately:

- Playwright's `reuseExistingServer: true` can silently attach to a leftover preview and fake the
  gate. Ran with `E2E_SKIP_WEBSERVER=1` against a dedicated port instead.
- `docker compose down -v` **fails without `JWT_SECRET` set** — the interpolation guard runs even on
  teardown. The first teardown attempt therefore left the volume in place and re-seeded on top of old
  data (19 findings instead of 11), which was caught and redone properly. The full browser suite was
  then run against a genuinely pristine database.

## Gates

| Gate | Result |
|---|---|
| frontend lint | clean (6 pre-existing warnings, none in changed files) |
| frontend unit | **169 passed**, 13 files |
| frontend build | clean |
| Chromium Playwright | **55 / 55 passed** |
| prisma validate | valid |
| prisma migrate deploy | 23 migrations from zero |
| prisma migrate diff | **exit 0 — no drift** |
| focused ingestion tests | **65 passed** |
| complete backend suite | **3071 passed / 177 skipped** — the documented Phase 8F baseline, unchanged |
| secret scan (CI's own patterns) | clean — no `.env`, no credential literals, no tracked `dist`, nothing secret-shaped in the bundle |

**CI: green on the first push** —
[run 31491172952](https://github.com/haiderchattha99-ali/ThreatNeXus/actions/runs/31491172952). All six
required jobs succeeded: Secrets and generated artifacts, Prisma schema and migration history, Backend
tests, Frontend lint/tests/build, Browser suite (Chromium), Core evaluators. "Mutation and concurrency
gates" is manual-trigger-only and correctly skipped.

`prisma format` rewrote `backend/prisma/schema.prisma`'s line endings (CRLF→LF, **zero** content
change); that was reverted so this ticket touches no backend file at all.

## Documentation corrections

Two lines described the ingestion route incorrectly and were corrected against `app.js`:

- `docs/ai/SECURITY.md` — the `upload` rate-limit bucket covers `POST /api/reports/upload`, not
  `POST /api/reports/accessible-rdp` (which does not exist).
- `docs/OPERATIONS_RUNBOOK.md` — it listed the upload bucket as applying to
  "`POST /api/reports` (or `/api/threats/upload`)". The legacy route carries **no** limiter:
  `app.js` mounts `uploadRateLimiter` on `/api/reports` only. Security-relevant, so it is stated
  plainly rather than left implied.

`docs/API_CONTRACT_PHASE0.md` was left alone — it documents `/threats/upload` as a Phase 0 route,
which is still accurate, and never claimed the analyst screen used it. `docs/USER_GUIDE.md` already
described the canonical behaviour; it is simply true now.

## Honest gaps

- **No manual pass in the user's own Chrome.** The `claude-in-chrome` extension refused to connect
  (its OAuth token belongs to a different claude.ai account than Claude Code is signed into). The live
  verification was real Chromium via Playwright driving the production build, asserting the wire URL,
  zero console errors *and* warnings, and the rendered evidence — then corroborated in PostgreSQL.
  Substantively equivalent, but it is a Playwright-driven browser, not a hand-driven one.
- **The E2E probe mints indicators from the run clock** (`198.18.<100-199>.<20-99>` plus a `+120`
  sibling) to avoid colliding with the demo seed *and* with a previous run against the same database.
  A collision is very unlikely, and would fail loudly (`PERSISTED` instead of `CREATED`) rather than
  pass silently. CI runs against a fresh database, so it cannot occur there.
- **The dashboard delta assertion is skipped, not failed, when the tile is RESTRICTED/UNAVAILABLE.**
  For ANALYST against the demo seed it always runs, but a future permission change could quietly
  reduce it to a no-op.
- **The frontend infers the outcome from the HTTP status** because the controller returns no
  `outcome` field. That is exact today (1:1 with the closed set), but if two outcomes ever shared a
  status, `constants/reportIngestion.js` would mis-label one. A backend `outcome` field would remove
  the coupling; adding one was out of scope here.
- **The legacy `/api/threats/upload` route is still mounted, still writes `Threat` rows, and still has
  no rate limiter.** Nothing in the analyst workflow reaches it any more. Whether the whole legacy
  Threat surface can be retired was not investigated — that is a separate decision with its own
  evidence requirement.
- **No independent review yet.** Per CLAUDE.md's own rule, this should not be merged on my review
  alone.

## Demo note worth carrying forward

The analyst upload path now enforces the canonical schema (`timestamp,ip,port,protocol` required
headers). A looser CSV that the legacy route used to swallow will now be **REJECTED** with a bounded
reason code. That is the correct behaviour, but it will look like a regression to anyone who
demonstrated with an ad-hoc CSV before.

## Protected boundaries honoured

- The primary checkout `C:\Users\LENOVO\Desktop\ThreatNeXus` was **never modified** — its six changed
  tracked files and ~35 untracked Phase 9C paths are exactly as found. All work happened in an
  isolated worktree.
- `docs/codex/`, `deliverables/`, `tmp/` — never read, staged or modified.
- `backend/.env` — never opened, read, printed or referenced.
- No `git add -A` at any point; every commit staged explicit paths after a `git add --dry-run` review.
