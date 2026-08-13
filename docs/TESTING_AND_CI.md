# Testing and CI Guide

ThreatNeXus has four independent layers of verification, each catching a different class of problem:
unit/integration tests (does this function/route behave correctly), evaluators (does the real system
reproduce hand-authored ground truth end to end), the browser suite (does it actually work in a real
browser against a real backend), and CI's own hygiene checks (nothing secret or generated got
committed, the schema and migration history are intact).

## Backend tests

```bash
cd backend
npm test              # vitest run — the full suite
npm run test:watch    # watch mode for local development
```

145 test files across `backend/tests/{unit,integration,middleware}`, run against a real PostgreSQL
database (not an in-memory fake) — `DATABASE_URL` must point at one. Provider tests never touch the
network: every provider test injects its own fake `fetch`/`fetchImpl`, so the full suite runs with zero
provider keys and zero outbound requests, always. This is proven directly, not just asserted: some
integration tests explicitly set `ABUSEIPDB_API_KEY: ""`/`NVD_API_KEY: ""` in their environment *before*
`src/config/env` is first required, specifically so the suite's behavior does not depend on whether the
developer's own machine happens to have a real `.env` with live keys in it.

As of Phase 8F (the last live-provider phase), the backend suite reports **3071 passed / 177 skipped**,
zero failures on a clean run.

## Frontend tests

```bash
cd frontend
npm run lint    # oxlint
npm test        # vitest run
npm run build   # production build — also a correctness check, since CI scans the output
```

## Playwright / Chromium browser suite

```bash
cd frontend
npm run test:e2e
```

9 spec files (`frontend/e2e/*.spec.js`) covering the dashboard, findings/upload flow, role-based access,
the ATT&CK navigator, Finding-level AI assistance states, responsive breakpoints, motion/reduced-motion
behavior, and session handling. Requires a running backend and a built, served frontend — CI's own job
starts both against a disposable seeded database (see below); locally, follow
`docs/DEPLOYMENT.md`/`docs/DEMO_RUNBOOK.md` to bring up a stack first.

**Known trap**: `reuseExistingServer`-style Playwright configuration can silently attach to a leftover
preview server from a previous run and produce a false green (or false red) result. Always confirm you
are testing against the server you just started, on a dedicated port, not a stale one — see
`docs/ai/` phase-history notes if this needs deeper investigation.

## Evaluators

`eval/` — nine gates, each driving the real production services end to end against a disposable database
and comparing against hand-authored ground truth (not mocked expectations):

| Command | Covers |
|---|---|
| `npm run eval:phase1` | Ingestion, dedup, persistence, recurrence |
| `npm run eval:risk` | Risk v1 determinism and explainability |
| `npm run eval:phase2` | Ownership resolution, IOC enrichment, consistency detection |
| `npm run eval:phase3` | Analyst workflow, closure, recurrence reopening |
| `npm run eval:phase4` | Notification review, export, delivery tracking |
| `npm run eval:phase5` | Framework mappings, guarded AI assistance |
| `npm run eval:phase6.3` | ATT&CK catalogue and evidence integrity |
| `npm run eval:vulnerability` | CVE association, NVD/KEV/EPSS evidence |
| `npm run eval:phase7` | No-key startup, offline operation, AI off (replaces `fetch` with a throwing counter and asserts zero calls) |

Two additional gates exist but are **not** run on every push — they take minutes rather than seconds and
prove invariants under real database contention, which matters before a merge to `main`, not on every
feature-branch commit:

```bash
npm run eval:phase2:mutation
npm run eval:vulnerability:mutation
```

The six live-provider phases (8B Censys, 8D GreyNoise, 8E Shodan, 8F Netlas — AbuseIPDB and NVD predate
the evaluator/provider split) have **no dedicated phase evaluator**. Each is an isolated provider-adapter
addition rather than a cross-cutting workflow change, so it is proven by its own unit/integration test
suite (provider adapter tests, route-authorization tests, and a small "evidence" test file per provider
that pins the specific design claims — e.g. "the key never travels as a query parameter", "the provider
shares the existing rate-limit budget, not a new one") rather than a phase-numbered ground-truth gate.

## Mutation and manual gates

Beyond the two mutation evaluators above, `.github/workflows/ci.yml` has one job
(`deep-gates` / "Mutation and concurrency gates") that only runs on manual `workflow_dispatch`, never on
a push or pull request — deliberately, because it is expensive relative to the value of running it on
every commit. Trigger it manually from the Actions tab when validating a release candidate.

## Migration history guard

CI's `schema` job checks three things about the Prisma migration history on every push:

1. `prisma validate` — the schema itself is syntactically and referentially valid.
2. **Migration count and order match a frozen, reviewed list** hardcoded in `ci.yml` — a silent
   migration, rename, or reorder cannot slip through unnoticed; a deliberate migration change must
   update this list in the same commit.
3. `migrate deploy` succeeds **from an empty database** (not from a developer's already-drifted local
   one), and `prisma migrate diff --exit-code` confirms zero drift between the applied migrations and
   `schema.prisma` itself.

This is stricter than "the app happens to boot" — it proves the committed migration files, run in order
from nothing, reproduce the exact schema the code expects.

## Secrets and generated-artifact scan

CI's `hygiene` job runs on every push, before anything else, checking:

- No committed file matches `.env` or `.env.<anything>` except `.env.example` files.
- No credential-shaped literal anywhere in the tree (PEM private key headers, GitHub tokens, Slack
  tokens, AWS access key ids, Google API keys) — a deliberately narrow set of patterns that are almost
  never legitimate in source, rather than broad entropy scanning that produces noise nobody reads.
- No `frontend/dist` or `node_modules` under either `backend/` or `frontend/` is committed.
- No unresolved whitespace/conflict-marker issue across the full commit history.

The frontend build job separately scans the **production JS bundle** for provider-key-shaped strings
(`ABUSEIPDB_API_KEY`, `NVD_API_KEY`, PEM headers) — this specifically catches the mistake of putting a
secret behind a `VITE_`-prefixed environment variable, which Vite would otherwise inline directly into
shipped browser code.

## Provider no-live-call rule

Enforced at three independent layers, not just one:

1. **Unit tests**: every provider test injects its own fake transport.
2. **CI environment**: every job that runs backend code sets provider keys to an explicit empty string
   (`ABUSEIPDB_API_KEY: ''`, `NVD_API_KEY: ''`, etc.) rather than leaving them unset/inherited.
3. **`eval:phase7`**: replaces `global.fetch` with a function that throws if called, and asserts the
   count of calls is exactly zero across the whole gate — a structural proof, not a hope.

## Running local gates before pushing

Minimum recommended sequence, from `backend/`:

```bash
npx prisma validate
npx prisma migrate deploy       # against a disposable local database
npm test
npm run eval:phase1 && npm run eval:risk && npm run eval:phase2 && npm run eval:phase3 && \
  npm run eval:phase4 && npm run eval:phase5 && npm run eval:phase6.3 && \
  npm run eval:vulnerability && npm run eval:phase7
```

From `frontend/`:

```bash
npm run lint && npm test && npm run build
```

## Interpreting skipped tests

A skip in the backend suite is not a gap in coverage by default — most skips in this codebase are
deliberate `describe.skip`/conditional guards for a scenario that only applies under a specific
environment (e.g., a real-Postgres-only concurrency proof that a mocked Prisma client cannot exercise
meaningfully). The current skip count (177) has been stable across recent phases; a sudden large jump in
skips on a run is worth investigating — it can indicate a broad environment failure (e.g., no reachable
database) causing tests to bail out early rather than genuinely deciding to skip. See
`docs/OPERATIONS_RUNBOOK.md`'s flake note for the specific pattern where a `beforeAll` timeout on a few
files under contention gets mis-reported as a larger skip count in a parallel run — that is a run-level
artifact, not a real skip decision, and clears on a clean re-run.

## Known flake classes and rerun policy

**CPU-contention `beforeAll` timeout** (documented in `docs/OPERATIONS_RUNBOOK.md`): a handful of
integration test files can hit a 10-second hook timeout when the full ~145-file suite transforms cold
in parallel on a constrained machine. Confirmed non-systemic every time observed — the same files pass
cleanly in isolation. Policy: re-run the specific failing files alone before concluding there's a real
regression; if they pass alone, it was contention, not a defect.

**CI real-Postgres concurrency timing**: a real-database concurrency test can occasionally lose a race
under a shared CI runner's variable load (confirmed at least once in this project's history, on an
unrelated file the triggering change never touched). Policy: verify via `git diff` that the failing
test's file was not touched by the change under review, then re-run the CI job. If it passes clean on
rerun with zero code changes, it was a timing flake in the test's own concurrency assumptions, not a
regression — but if the SAME test fails on a second independent run, treat it as real and investigate.

## What CI does NOT run automatically

- Any live provider smoke script (`smoke:*`) — always manual, always opt-in via an explicit
  `LIVE_*_SMOKE=1` variable, never in any CI job.
- The two mutation/concurrency evaluator gates — manual `workflow_dispatch` only.
- Any deployment step — CI validates; it does not deploy anything anywhere.

---

## Phase 10A-2 — execution tests

### No test may contact a live provider

The rule is unchanged and now has more surface to cover. Direct providers are exercised through an
**injected `fetchImpl`**, which runs the real provider parsing and the real normalized result model
while contacting nobody. Stubbing the provider itself would prove nothing about the code that runs
in production.

`eval:phase7` remains the backstop: it replaces `fetch` with a throwing counter and asserts the
count is zero across the whole pipeline. CI additionally sets every provider key to `''`.

### The tiered execution gate

`tests/unit/enrichmentOrchestrationInertness.test.js` no longer asserts that the whole
orchestration package is inert — Phase 10A-2's purpose is to execute. It is **tiered** instead, and
each module belongs to exactly one tier:

| Tier | Modules | May do |
|---|---|---|
| CORE | 11 | decide and persist orchestration state. No provider import, no outbound call, no attempt/usage write, no timer |
| LEDGER | `enrichmentQuotaService` | write attempt and usage rows. Still no provider |
| EXECUTION | `enrichmentDirectExecutionService`, `enrichmentTargetedIocService` | resolve and call providers |
| WORKER | `enrichmentWorker` | schedule |

The file list is **exact**, so a new module cannot appear in any tier without a deliberate edit to
the gate — and a `fetch(` added to any CORE module still fails, even if no test executes that line.
`setInterval` is forbidden everywhere, including the worker: ticks must not overlap.

### Real PostgreSQL is required for the execution suite

`tests/integration/phase10a2Execution.test.js` self-skips unless **`TEST_DATABASE_URL`** is set.

> **Trap worth knowing.** The real-PostgreSQL suites gate on `TEST_DATABASE_URL`, *not*
> `DATABASE_URL`. Set only the latter and roughly 200 tests silently skip while the run still
> reports green — you can "prove" the concurrency and quota guarantees with the concurrency and
> quota tests switched off. Always set both.

### Scope of the shipped suite

The execution suite covers the **seven binding guarantees** plus quota atomicity, claim races,
ordering, ambiguity and targeted selection — 21 real-PostgreSQL cases.

Deliberately **not** covered, by explicit decision: the per-status permutation matrix
(404 / 429 / 5xx / timeout / malformed body / network failure, for each of the five providers).
Status mapping is covered by unit-level assertions on `resolveAttemptOutcome` rather than by an
end-to-end case per status per provider. If a provider's normalization changes, that mapping is
where a regression would surface.
