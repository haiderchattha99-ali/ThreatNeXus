# Project Security

Orientation note for the AI team. The binding rules are in `/AGENTS.md`, `/CLAUDE.md` and the
build-guard skill referenced there; where they disagree with this file, they win.

## Assets and sensitive data

Constituent exposure evidence (synthetic only — no real victim data has ever been held), analyst
decisions, the audit log, provider API keys, and JWT signing material. **No secret and no real
victim data may ever be committed.**

## Actors and roles

`ADMIN`, `ANALYST`, `REVIEWER`, `VIEWER`. Capabilities are server-derived and returned alongside the
profile; they are never inferred from anything the client stores.

## Trust boundaries

The backend is the sole authorization boundary. The frontend's route guards and hidden controls are
UX only and fail closed (a protected route with no declared capability and no explicit
`requireAuthOnly` opt-in is denied).

## Authentication

JWT bearer tokens. `JWT_SECRET` is required at startup, must be at least 32 characters, and is
rejected if it is a recognisable placeholder. **401 and 403 are treated as opposites**: a 401 on any
authenticated request clears the stored session and returns to sign-in with an explanation; a 403 is
a capability refusal, the session survives it, and the page renders its denied state. Both are now
covered by `frontend/e2e/session.spec.js`.

## Authorization and ownership

`requireCapability` / `requireRole` middleware on every route. Since Phase 7 this is a **structural
invariant rather than a convention**: `backend/tests/integration/phase7RouteCensus.test.js` walks
the live Express router tree and fails if any mounted route lacks authentication or a capability
guard. Exactly two exception lists exist, each entry carrying its reason:

- **Unauthenticated by necessity** — `POST /api/auth/login`, `POST /api/auth/register`, `GET /`.
  The first two cannot require a credential the caller does not yet have; the third is a fixed
  liveness banner that reads nothing.
- **Authenticated but capability-free** — `GET /api/profile` only. It echoes the caller's own
  token-derived identity and the capability list implied by their role. A capability answers "may
  this role reach other people's data?", which is not a meaningful question for an endpoint that
  can return no other subject's data.

A new route added tomorrow is covered the moment it is mounted. Cases are organization-bound. **Two
self-approval prohibitions hold and are proven by the demo seed and the evaluators**: the analyst
who requests a case closure cannot approve it, and the analyst who drafts a notification cannot
approve it. Notification approval binds to an exact immutable revision — editing invalidates it.

## Input and output validation

Every write path validates its input and names the offending field. Ingestion rejects structurally
invalid rows without failing the whole report. Error responses never echo secrets.

Enterprise ATT&CK mappings are validated against the pinned local catalogue and cannot accept an
invented or obsolete current reference. They must preserve a bounded verbatim quote from stored
case/finding evidence, its locator/source, and separate evidence and mapping confidence. AI output
passes through the same validation and remains only a suggestion; it cannot approve itself or
bypass the human mapping writer. Explicit no-applicable determinations are reasoned, auditable
analyst decisions, not inferred empty states.

## Secret handling

API keys come from environment variables only and never appear in logs, error responses, the browser
bundle, screenshots, fixtures, test reports or commits. `tests/setup.js` sets `TNX_SKIP_DOTENV=true`
so the suite never inherits a developer `.env`; the same variable is used for local gate runs.
`seedUsers.js` and `seedDemo.js` take their passwords from the environment, have no defaults, refuse
to run under `NODE_ENV=production`, and never print a password.

## Logging and audit

Audit logging is cross-cutting and began in Phase 0. **Every write path appends its own `AuditLog`
event in the same change** — never retrofitted. Audit failure must never turn a valid response into
an error.

## Abuse controls

**Correction (Phase 7).** This section previously claimed "rate limits and upload size limits on the
ingestion path". The upload size limit was real (`UPLOAD_MAX_BYTES`, plus `REPORT_MAX_ROWS`); the
rate limit was not. Before Phase 7 the application had no request rate limiting of any kind —
`app.js` mounted `cors`, `express.json` and the routers, and nothing counted requests. The claim is
now true, and it is stated precisely here so the gap is on the record rather than quietly closed.

Three independent fixed-window buckets (`src/middleware/rateLimit.js`, wired in
`src/config/rateLimiters.js`):

| Bucket | Covers | Default |
|---|---|---|
| `auth` | `POST /api/auth/login` and `/register`, counted together | 30 / 15 min |
| `upload` | `POST /api/reports/accessible-rdp` | 20 / 15 min |
| `provider` | IOC enrichment, CVE enrichment, both batch workers, and an AI suggestion generation run — one shared budget | 60 / 15 min |

- Authenticated callers are counted per user id, so one busy analyst cannot deny service to the
  team; unauthenticated callers per client address.
- `X-Forwarded-For` is **not** honoured. Express only populates `req.ip` from it when `trust proxy`
  is set, and the app never sets it — `phase7RouteCensus.test.js` asserts that. Enabling it without
  a trusted proxy in front would let any caller rotate their own limiter key by editing a header,
  which is worse than no limiter because it would still look like one.
- The limiter is **in-process**. Correct for a single-process prototype; a horizontally scaled
  deployment would need a shared store.
- Enabled by default everywhere except `NODE_ENV=test`. `phase7RateLimiting.test.js` turns each
  bucket on explicitly, drives it past its limit, and asserts that default resolution, so "off in
  tests" cannot be read as "off in production".

Providers are behind an abstraction with a `MockProvider` used by every automated test, so no test
consumes live quota. Enrichment failure never blocks ingestion — proven end to end by
`eval:phase7`.

## Provider foundation (Phase 8 evidence)

A "Phase 8 provider foundation" request was investigated before any code was written and found
already shipped, spread across Phases 2, 6 and 7, not a Phase 8 build. This section is the honest
record of what exists and where.

- **Two provider registries**, one per domain, deliberately not unified into one abstraction:
  `backend/src/services/enrichment/providerRegistry.js` (IOC reputation: `mock`, `abuseipdb`) and
  `backend/src/services/vulnerability/providers/vulnerabilityProviderRegistry.js` (vulnerability
  metadata: `NVD`, `CISA_KEV`, `FIRST_EPSS`). Each factory map is frozen and never exported directly;
  callers get only `resolve`/`list` functions.
- **NVD is a live provider today**, not mocked-only — `nvdCveProvider.js`, wired into vulnerability
  enrichment since Phase 2 (§2B). `NVD_API_KEY` is optional and never required to start the app; its
  absence only drops the caller to NVD's public rate limit (`KEYLESS_PUBLIC_RATE_LIMIT`, not
  `NOT_CONFIGURED` — a key-optional provider is a different, still-valid mode from a key-required
  one). 404/malformed/timeout/429/5xx are all closed, typed outcomes — see the error contract below.
- **Safe provider status is already exposed** at `GET /api/dashboard/overview` → `sections.providers`,
  gated on the existing `read:dashboard` capability (`operationalOverviewService.js`). It reports
  configuration presence only (`CONFIGURED` / `NOT_CONFIGURED` / `CONFIGURED_WITH_KEY` /
  `KEYLESS_PUBLIC_RATE_LIMIT` / `NO_KEY_REQUIRED` / `MOCK_PROVIDER` / `ENABLED` / `DISABLED`) plus
  freshness derived from stored lookup rows (`FRESH` / `STALE` / `NO_SUCCESSFUL_LOOKUP_RECORDED`).
  It performs zero live provider requests and never returns a key, a key fragment, a base URL, a raw
  upstream body, or a latency figure — proven against this machine's real ambient keys by
  `operationalOverviewService.test.js` ("no live provider traffic" describe block). The frontend
  already renders this (`frontend/src/pages/Settings.jsx`): icon+word+color status badges, source
  citation, no fabricated coverage, unavailable never shown as zero.
- **Provider error contract.** `VULNERABILITY_ERROR_CODES` (`vulnerabilityTypes.js`) is the closed set:
  `PROVIDER_RATE_LIMITED`, `PROVIDER_INVALID_KEY`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`,
  `PROVIDER_UNREACHABLE`, `PROVIDER_MALFORMED_RESPONSE`, `PROVIDER_REJECTED`, `PROVIDER_DISABLED`,
  `UNSUPPORTED_IDENTIFIER`, `CATALOG_UNAVAILABLE`. No raw upstream body or header ever reaches a
  caller, a log line, or an audit row.
- **Quota is already shared.** The `provider` rate-limit bucket documented above already covers every
  provider-execution route (IOC enrichment, CVE enrichment, both batch workers, AI suggestion
  generation) through one budget; a future provider route joins that same bucket rather than getting
  its own.
- **New in this ticket**: an opt-in manual NVD live-smoke script,
  `backend/src/scripts/nvdLiveSmoke.js` (`npm run smoke:nvd`). It requires `LIVE_NVD_SMOKE=1` to be
  set explicitly, performs exactly one lookup against a permanently published CVE, never prints
  `NVD_API_KEY`, and is never invoked by any test, evaluator, or CI job.
  `backend/tests/unit/phase8ProviderFoundationEvidence.test.js` collects the explicit, named
  assertions for this whole claim set in one place (missing optional keys don't block startup,
  registries expose exactly the documented provider names, the error contract is closed and
  distinct, the provider rate-limit budget is a single positive pair, the smoke script cannot run
  unattended).

## Security tests

`backend/tests/` (unit, middleware, integration, including real-PostgreSQL concurrency),
`eval/run_*_gate.js`, and `frontend/e2e/`. CI additionally scans for committed `.env` files,
credential-shaped literals, generated artifacts, and secret-shaped literals in the production bundle.
It also verifies the pinned ATT&CK catalogue checksum and runs the Phase 6.3 evidence-integrity gate.

## Known risks and accepted exceptions

- **`react-router-dom` is pinned to 7.18.2.** One advisory remains open; it is RSC-mode-only and
  unreachable in a client-only SPA. A 7.11.0 downgrade was tested and rejected — it trades one
  unreachable advisory for fourteen reachable ones.
- **AI is disabled by default (`AI_ENABLED=false`)** and cannot approve, send, score, close, resolve
  or make a final framework mapping. Every core workflow must complete with AI off.
- **No SMTP or webhook client exists**, not even a disabled one. Export is not delivery.
- **`backend/.env` on the development machine holds live provider keys.** It is correctly gitignored,
  has never been tracked, and is absent from history. It must never be read, printed, copied,
  transmitted or modified by an agent.
