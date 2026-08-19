# Handoff — TNX-FINAL-EVIDENCE-CONSOLIDATION

**Status: docs-only consolidation, PR open, not merged.** Branch `docs/evidence-consolidation`,
worktree `F:\AI-Worktrees\ThreatNeXus\evidence-consolidation`, base `fbffbe3` (main, after PR #32
merged).

## Why this ticket exists

PR #31 (`TNX-DOC-EVIDENCE-PREP`) and PR #32 (`TNX-FINAL-DEMO-DOC-EVIDENCE`) branched from a common
ancestor and were developed concurrently, each without visibility into the other's work. Both
independently wrote evidence documents covering the same three subjects — the Phase-10C4 controlled
live canary, external data access chronology, and production sizing — under different filenames, and
both independently captured demonstration screenshots into different directories. Both merged
cleanly to `main`. The duplication surfaced only on inspection after both were merged.

## What this closes

Engineering, security, frontend and demo-readiness work are all already closed (PR #29, #30, #32).
This ticket is documentation-evidence consolidation only: leave exactly one canonical source per
subject before Master document drafting begins.

## The three document pairs

For each, both files were read in full and compared concept by concept before any decision — not
"the longer one wins."

### 1. Controlled live canary

**Canonical: `docs/evidence/CONTROLLED-LIVE-CANARY-RECORD.md`.** Kept because it has the stronger
provenance: a four-entry source-commit table with `git show` reproduction commands, the Tier-3
reviewer-status record (0 P0, 6 P1 raw / 4 distinct all closed, 16 P2 all closed, 6 P3 all closed;
Codex unavailability disclosed), and an explicit "proves / does not prove" scope section. Its one gap
against the shorter file — the compose overlay's `ports` list concatenating rather than replacing,
briefly exposing host port 5000 alongside 15000 — is now folded in as "Operational note recorded at
the time."

`docs/evidence/CONTROLLED-LIVE-CANARY.md` is now a supersession stub.

### 2. External data access

**Canonical: `docs/evidence/EXTERNAL-DATA-ACCESS-RECORD.md`.** Kept because it structures every claim
into REPOSITORY-DOCUMENTED FACT / PROJECT-TEAM ATTESTATION / CURRENT STATUS, and carries the
repository ticket `#7ibziiin` that the shorter file omitted entirely. Its one gap — the "no claim may
present dashboards or counts as national cyber exposure statistics" caution — is now §5.

`docs/evidence/EXTERNAL-DATA-ACCESS.md` is now a supersession stub.

### 3. Production sizing

**Canonical: `docs/evidence/PRODUCTION-SIZING-MEASUREMENTS.md`.** Kept because its M1–M10 protocol is
materially more rigorous: three-sample M2 instead of one, CPU model/core-count identity, an M4
image-size reporting-discrepancy disclosure, a real-denominator M6 ingestion-growth test (500 fresh
indicators through the actual upload endpoint, not an estimate), and full A/B/C/D sizing tiers with
TLS/retention/HA explicitly marked proposed-and-unimplemented.

**The M8 conflict, resolved explicitly** (this was the one place the two files actually disagreed on
a number, not just on detail level). Three distinct backend-suite figures exist and are now clearly
labelled rather than one silently overwriting another:

| Figure | Commit | What it is |
|---|---|---|
| **3,417 passed / 240 skipped / 0 failed** | `ee1146b` | Dated CI-backed baseline, final security pass, before PR #32's new tests |
| **3,460 passed / 240 skipped / 0 failed** | `2612cbc` | **Current authoritative baseline** — the dated figure above plus exactly the 43 tests PR #32 added |
| 3,384 passed / 273 skipped / **5 timeout-affected files** | `2bda0e5` | This sizing session's own local resource-contention observation — a wall-clock measurement on a contended machine, **not** a validation result, and does not replace either baseline above |

The canonical file's M8 section now states this table directly, per the ticket brief's explicit
instruction not to let the contention run stand in for the validation baseline.

An **Appendix** at the end of the canonical file preserves the shorter session's genuinely additional
same-day data points (backend process RSS during startup, a single-sample idle spot check, an
alternate cold-start timing definition) without duplicating the full ten-section protocol a second
time.

`docs/evidence/PRODUCTION-SIZING.md` is now a supersession stub.

## Screenshots

**Canonical: `docs/assets/screenshots/final/`** (41 files including its `README.md`) — broader
coverage across master/playbook/supporting captures and every role, a fuller capture-conditions
record, produced from the final frontend build.

Compared `docs/evidence/screenshots/` (4 images) by content, not just count:

- `01-dashboard.png` and `02-findings.png` were fully redundant with the final library's own
  dashboard and findings captures — **removed**.
- `03-finding-detail-decision-first.png` and `04-enrichment-coverage-before-request.png` proved a
  fact the final library did not capture: the exact pre-request enrichment state of the *specific
  primary demonstration Finding* (`A`, `203.0.113.11`) that `docs/demo/DEMO-READINESS.md` selects for
  the live PKCERT demonstration — as opposed to the unrelated Finding 3 used in the final library's
  own decision-first captures. **Moved**, pixels unaltered, to
  `docs/assets/screenshots/final/demo-readiness-finding-a-decision-first.png` and
  `demo-readiness-enrichment-before-request.png`, documented under a new "Demo-readiness supporting
  captures" section in that directory's `README.md`.

`docs/evidence/screenshots/README.md` is now a supersession stub pointing to the canonical
directory.

## Superseded-file convention

Every retired file was reduced to a short stub (`# Superseded — see <canonical>.md`) carrying:
superseded-by path, consolidation date, consolidation source commit, and the commit its original
content was authored at. Nothing was deleted — every superseded file's full original text remains
recoverable from Git history at the commit named in its stub, and `git log --follow` on the canonical
files reaches the same history.

## Cross-references fixed

`grep`-verified every reference to the six retired-or-canonical paths across the whole repository
before editing anything. Found and fixed exactly one live stale reference:
`docs/demo/DEMO-READINESS.md` line 227 pointed at `CONTROLLED-LIVE-CANARY.md`; now points at
`CONTROLLED-LIVE-CANARY-RECORD.md`. No test, evaluator, or product-code file referenced any of the
retired paths.

## Validation

- `git diff --check` clean.
- `git diff --stat` confirms **zero** files under `backend/src`, `backend/tests`, `frontend/`,
  `package.json`, or any lockfile — docs-only, as scoped.
- **Zero provider calls.** No stack was started for this ticket; every canonical figure is
  transcribed from an existing dated source, never re-measured.
- Screenshot index in the canonical `README.md` verified to resolve to real files on disk after the
  `git mv`.
- Exactly one canonical `.md` source per subject remains citable; all three supersession stubs carry
  the required header.

## Traps carried forward

- **STATE.yaml/HANDOFF.md are rolling single-ticket files.** This commit overwrites
  `TNX-FINAL-DEMO-DOC-EVIDENCE`'s entries entirely, per the established convention — its outcome (PR
  #32 merged at `fbffbe3`) survives in Git history and in this file's own narrative, not in the
  rolling files.
- **STATE.yaml is JSON-in-a-`.yaml` with a UTF-8 BOM and CRLF line endings.** Write it with a small
  Node script that preserves both and re-`JSON.parse`s before writing — never hand-edit or
  reserialize with a generic tool.
- **Git Bash `<<'EOF'` heredocs containing apostrophes can break bash's own quote-balance scan**
  before the heredoc content is even reached, distinct from the previously-known `\\`-collapsing
  trap. Write generator scripts with the Write tool instead of a heredoc when the content has
  contractions or possessives.

## Where the canonical evidence lives

| Subject | Canonical file |
|---|---|
| Controlled live canary | `docs/evidence/CONTROLLED-LIVE-CANARY-RECORD.md` |
| External data access | `docs/evidence/EXTERNAL-DATA-ACCESS-RECORD.md` |
| Production sizing | `docs/evidence/PRODUCTION-SIZING-MEASUREMENTS.md` |
| Demo rehearsal (unchanged, no duplicate existed) | `docs/evidence/DEMO-REHEARSAL-EVIDENCE.md` |
| Screenshots | `docs/assets/screenshots/final/` |

## Next

**MASTER OFFICIAL SYSTEM & HANDOVER DOCUMENT.** Not started — deliberately out of scope here, along
with the README rewrite and the Playbook/Handbook drafting.

Awaiting CI on `docs/evidence-consolidation` and PR review. **Not merged.**
