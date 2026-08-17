# Handoff: TNX-P10C5-BOUNDED-PROVIDER-RESPONSE-BODIES

- From: claude
- Branch: `feat/phase-10c5-bounded-provider-response-bodies`
- Worktree: `F:\AI-Worktrees\ThreatNeXus\phase-10c5`
- Base: `origin/main` @ `c683cae` (merge of PR #26, TNX-P10C4)
- Updated: 2026-08-18
- Status: **ready_for_pr** — Tier 3. Implementation, focused evidence, regression evidence, and one
  targeted review are all complete and green. **Remaining: stage/commit, push, CI, open PR (no
  merge).** This is the LAST currently-recorded 10C engineering ticket — next action after the PR is
  functional project closure, not a new phase.

- Decision: `docs/ai/DECISIONS.md` → `D-P10C5-01`

## What this ticket closes

10C-4's own decision record (`D-P10C4-01`) disclosed the residual explicitly: the worker's
`lookupWithBound` races `provider.lookup()` against a timeout but never cancels the underlying fetch
if it loses that race, and no provider bounded how many bytes of a response body it would ever read
into memory before parsing. This ticket closes that gap.

## The grounded defect (not assumed from the ticket's own summary sentence)

All five real provider adapters — `greynoise`, `censys`, `shodan`, `netlas`, `abuseipdb` — each
independently called `body = await response.json()` on a successful response, with their own
copy-pasted `createComposedController` timeout/AbortController helper. No shared HTTP client existed.
`response.json()` materializes the entire body with no upper bound before parsing a single byte — a
misbehaving or compromised provider endpoint could exhaust process memory with an arbitrarily large or
infinite chunked response.

Every legacy synchronous route (`greyNoiseExecutionService.js` and its four siblings) calls the
identical `provider.lookup()` as the Phase-10 worker does — confirmed by reading the actual call
sites, not assumed. That meant fixing the read **inside the provider module** protects both paths
from one change, with **zero** execution-service or route-file edits required.

## The fix — one shared seam, not five duplicated policies

**New:** `backend/src/services/shared/boundedResponseBody.js`, exporting
`readBoundedResponseText(response, {maxBytes})`.

- Enforcement is on **actual bytes received from the stream** (`response.body.getReader()`, summing
  each chunk's real `byteLength`) — never on `Content-Length` alone. A present, over-limit
  `Content-Length` is used only as an **early refusal** before any byte is read; a missing
  (chunked-transfer), spoofed, or understated `Content-Length` cannot bypass the real byte-counting
  loop.
- `DEFAULT_MAX_RESPONSE_BYTES = 2 MiB` — one shared constant. None of the five providers' documented
  response shapes come close to it, so a single limit is simpler and no less safe than five
  per-provider policies.
- On overflow: the reader (and the underlying connection) is cancelled where the runtime supports it,
  and a distinguishable `ResponseTooLargeError` is thrown **before any text is ever returned** — a
  partial oversized body can never be parsed as valid evidence.
- Runtime fact checked before designing this, not assumed: the backend runs Node 22 (native
  `fetch`/undici — `backend/Dockerfile:7` pins `node:22-bookworm-slim`), so `response.body` is a real
  Web Streams `ReadableStream` supporting `.getReader()`/`.cancel()`.

**Wiring (all 5 providers, same shape):** the existing 2xx branch's `response.json()` call became
`readBoundedResponseText(response)` → `JSON.parse(text)`, inside the *exact same* try/catch each
provider already had. `ResponseTooLargeError` maps to a new, additive, per-provider closed error code
— `PROVIDER_RESPONSE_TOO_LARGE` — classified into the existing `ENRICHMENT_STATUS.FAILED` bucket, the
same bucket `PROVIDER_MALFORMED_RESPONSE` already uses. Nothing about status-code handling, timeout
behavior, `NOT_FOUND`/`RATE_LIMITED` semantics, or the Phase-10 attempt/quota/ledger model changed.

**Contact truth preserved.** An oversized body is only ever discovered *after* the fetch already
returned a response object (status/headers known) — i.e. after `contactedProvider` is already true.
It is a normal post-contact `FAILED` outcome in the existing closed vocabulary, never a fabricated
`REFUSED_BEFORE_LOOKUP`.

## Deliberately out of scope (recorded in D-P10C5-01, not silently dropped)

- `backend/src/services/vulnerability/vulnerabilityHttp.js` (NVD/KEV/EPSS's own `response.text()`
  path) — a structurally separate system per this project's own IOC-vs-vulnerability architecture
  boundary. Not touched. A distinct future ticket if the same bound is ever wanted there.
- `lookupWithBound`'s outer `Promise.race` (`enrichmentDirectExecutionService.js:161`) — a *timeout*
  safety property, not a *body-size* one. Left exactly as-is. The body bound now achieved inside each
  provider (reader/connection cancellation on overflow) already removes the unbounded-memory risk
  that made the outer race's non-cancellation material.

## A real pre-existing test-double bug found and fixed along the way

`phase10a2Execution.test.js`'s `fakeFetch` had **divergent** `.json()` and `.text()` defaults: the
`.json()` default (used until now) was a valid Censys success shape; the dormant `.text()` default —
never exercised because production never called `.text()` before — was just `"{}"`. Updating mocks to
expose `.text()`/`.body` (since production no longer calls `.json()`) would have silently flipped a
`SUCCEEDED`-outcome test to a `FAILED`/malformed-response outcome. Fixed by giving both paths the
identical single default body.

## Testing

- **New:** `boundedResponseBody.test.js` — 17 tests: small/multi-chunk normal responses,
  exactly-at-limit, one-byte-over, no-Content-Length, understated/malformed Content-Length, early
  refusal on an accurate over-limit Content-Length (proving zero streaming ever starts), multibyte
  byte-vs-character-length, partial-body-never-exposed, the `.text()` fallback for a non-streaming
  Response.
- **Updated:** all 5 provider unit test files' shared response-mock helpers now expose
  `.text()`/`.body` streaming; one new `PROVIDER_RESPONSE_TOO_LARGE`-mapping test added per provider
  (6 total across the 5 files + `abuseIpdbProvider.test.js`'s own dedicated case). Also updated:
  `abuseIpdbProviderSecurity.test.js`, `censysLiveSmoke.test.js`, `enrichmentRunner.test.js`, and the
  4 legacy-route authorization integration tests — every mock that previously only exposed `.json()`.
- **Real-Postgres:** stood up a disposable local Postgres (25 migrations applied, `TEST_DATABASE_URL`
  set), ran `tests/integration/phase10a2Execution.test.js` — 34/34, proving Phase-10
  attempt/quota/reservation/contact truth is unchanged end-to-end through the real worker path.
- **Full suite:** `npm test` with `TEST_DATABASE_URL` active — first run 3640/3642 passed (162/163
  files, 2 pre-existing skips). A second run showed 6 failures, all isolated to
  `riskScoringConcurrency.test.js`/`vulnerabilityReleaseWorkflow.test.js` — files this ticket never
  touched, with write-conflict/deadlock-shaped errors matching this project's own documented local
  full-suite contention flakiness (not a regression; CI runs isolated and is the authoritative gate).
- No backend lint script exists in this repo (only the frontend CI job lints); confirmed, not a gap.
- Zero live provider contact anywhere — every fixture is deterministic and local.

## Review

One bounded read-only pass, `security-reviewer`, 9 binding questions (bypass via Content-Length,
partial-data exposure, contact-truth misreporting, cancellation safety, provider-semantics
regression, legacy-route coverage, secret/body leakage). **0 P0/P1 — CLEAR.**

Two P2 notes: (1) a recommendation to live/manual-smoke-test undici's `reader.cancel()` behavior
before unattended/production reliance — explicitly **not** performed this ticket, per the absolute
no-live-provider-testing rule; recorded for a future operator decision. (2) A duplicated trailing
sentence in `docs/ai/DECISIONS.md` (my own copy-paste artifact while writing D-P10C5-01) — fixed, a
trivial zero-risk 1-line doc correction.

## Next action

Isolate and stage the exact ticket-owned paths, validate the staged index, create one bounded
implementation commit, push, obtain green CI at the exact final SHA, open the PR against `main`, and
**STOP without merging**.

**This was the last currently-recorded 10C engineering ticket.** The action after this PR is
functional project closure — not 10C-5's own successor, not a pentest phase, not frontend polish, not
a documentation overhaul, unless explicitly requested in a future ticket.
