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
| `upload` | `POST /api/reports/upload` | 20 / 15 min |
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

### Censys — the second live provider (Phase 8B)

- **Targets Censys's current Platform API** (`api.platform.censys.io/v3`, Bearer Personal Access
  Token), not the legacy Search v2 API (`search.censys.io`, Basic Auth API ID + secret) — an earlier
  draft of this integration was built against Search v2 before a live-credential check surfaced that
  Censys now issues PATs, not ID/secret pairs, for new accounts. Corrected before merge.
- **New adapter, new table, no change to the existing two registries.** `censysProvider.js` (self-
  contained, mirrors `abuseIpdbProvider.js`'s defensive shape: composed timeout+caller-signal, every
  expected HTTP/transport outcome mapped to a normalized result, never throws for an expected
  outcome), `censysTypes.js` (own closed status/error taxonomy, reusing the same
  `PROVIDER_RATE_LIMITED`/`PROVIDER_INVALID_KEY`/`PROVIDER_TIMEOUT`/`PROVIDER_UNAVAILABLE`/
  `PROVIDER_UNREACHABLE`/`PROVIDER_MALFORMED_RESPONSE`/`PROVIDER_REJECTED`/`UNSUPPORTED_INDICATOR`/
  `ENRICHMENT_DISABLED` code vocabulary the rest of the app already speaks), `censysConfig.js` (bounds/
  defaults, mirrors `abuseIpdbConfig.js`). `CENSYS_PAT` is optional at startup — a missing token only
  disables the provider (`SKIPPED_DISABLED`), never blocks the app — and `CENSYS_ORG_ID` is optional
  even when a PAT is set, sent as `X-Organization-ID` only for accounts spanning more than one Censys
  organization. Neither value is ever logged, printed, or included in any error message. Requests also
  carry the versioned `Accept: application/vnd.censys.api.v3.host.v1+json` header the host-lookup
  endpoint documents.
- **Its own Prisma table (`CensysEnrichment`), not a bolt-on to `IocEnrichment`.** Censys returns
  exposure/attack-surface data (open services, AS ownership) — a materially different shape from
  AbuseIPDB's reputation score, the same reasoning that already keeps `VulnerabilityProviderResult`
  separate from IOC reputation. Additive-only migration
  (`20260807000000_add_phase8b_censys_exposure_enrichment`), one enum + one table, no existing column
  touched.
- **No queue.** Deliberately NOT modelled on `IocEnrichment`'s PENDING/lease/retry/dead-letter
  lifecycle — every row is written once, already terminal, by a synchronous, human-triggered lookup
  (`censysExecutionService.js`, `POST /api/findings/:id/enrichment/censys`). This phase's explicit
  scope excludes queues/schedulers.
- **Same authorization and quota as every other provider route.** `GET .../enrichment/censys` reuses
  `read:findings`; `POST .../enrichment/censys` reuses `trigger:finding-enrichment` (ADMIN/ANALYST
  only) and the SAME `providerRateLimiter` budget IOC/CVE enrichment and the batch workers already
  share — proven in `phase7RateLimiting.test.js` ("Phase 8B — counts the Censys route in the SAME
  budget, not a fresh one"). `phase7RouteCensus.test.js` (the structural route-authorization walk)
  covers both new routes automatically.
- **Audit events**: `censys.lookup.attempted`, `.succeeded`, `.failed`, `.unavailable`,
  `.rate_limited` — actor/role (from `buildAuditContext`), provider id, terminal status, and the
  closed `errorCode` only, never a raw upstream body or the credentials.
- **Dashboard/Settings.** `sections.providers.exposure` (new array, parallel to `.ioc`/`.vulnerability`)
  reports `CONFIGURED`/`NOT_CONFIGURED` plus freshness from `CensysEnrichment`, zero live calls,
  rendered by the existing Settings panel and dashboard `ProviderFreshness` component — no new UI
  component, no new status vocabulary (`CONFIGURED`/`NOT_CONFIGURED` already existed in
  `Settings.jsx`'s `CONFIG_STATE` dictionary).
- **Manual live smoke**: `backend/src/scripts/censysLiveSmoke.js` (`npm run smoke:censys`), opt-in via
  `LIVE_CENSYS_SMOKE=1`, one lookup against `1.1.1.1` (Cloudflare's public DNS resolver — permanent
  public infrastructure, never a customer/victim asset), never prints credentials, never runs in CI.
  Not executed against the real Censys API this session (not authorized).
- Tests: `censysProvider.test.js` (15 — construction with no credentials, unsupported indicator,
  Bearer + versioned Accept header construction, optional X-Organization-ID, success normalization
  from `result.resource` + service-count bounding, 401/403/404/429/5xx/timeout/malformed/unreachable,
  credential redaction), `censysEnrichmentRouteAuthorization.test.js` (14 — full
  route→controller→service→provider chain
  with a faked `globalThis.fetch`, capability matrix, 404/401 handling, audit pair, redaction),
  `censysLiveSmoke.test.js` (3), `phase8bCensysProviderEvidence.test.js` (7 — startup safety, registry
  isolation, error-contract closure, shared-quota assertion, smoke-script guard), plus 2 new cases in
  `phase7RateLimiting.test.js` for the shared/own-budget proof and an `operationalOverviewService.js`
  redaction extension. Backend suite: 2899 passed / 177 skipped (up from the 2858 baseline by exactly
  the 41 new tests this ticket adds).

### GreyNoise — the third live provider (Phase 8D)

- **Targets GreyNoise's Community API** (`api.greynoise.io/v3/community`, a `key` header — not Bearer,
  not Basic), the free key-gated tier. `GREYNOISE_API_KEY` is optional at startup — a missing key only
  disables the provider (`SKIPPED_DISABLED`), never blocks the app. Never logged, printed, or included
  in any error message.
- **New adapter, no change to any existing provider or registry.** `greyNoiseProvider.js` (self-
  contained, mirrors `censysProvider.js`'s defensive shape: composed timeout+caller-signal, every
  expected HTTP/transport outcome mapped to a normalized result, never throws for an expected outcome),
  `greyNoiseTypes.js` (own closed status/error taxonomy, reusing the same
  `PROVIDER_RATE_LIMITED`/`PROVIDER_INVALID_KEY`/`PROVIDER_TIMEOUT`/`PROVIDER_UNAVAILABLE`/
  `PROVIDER_UNREACHABLE`/`PROVIDER_MALFORMED_RESPONSE`/`PROVIDER_REJECTED`/`UNSUPPORTED_INDICATOR`/
  `ENRICHMENT_DISABLED` code vocabulary the rest of the app already speaks, plus GreyNoise's own closed
  `classification` set — `benign`/`malicious`/`unknown`; anything else GreyNoise might ever send is
  normalized to `null`, never passed through as an invented fourth value), `greyNoiseConfig.js`
  (bounds/defaults, mirrors `censysConfig.js`). IPv4 only — this repository has no IPv6 indicator
  validator anywhere to extend safely, so none was added speculatively for this one provider.
- **Its own Prisma table (`GreyNoiseEnrichment`), not a bolt-on to `IocEnrichment`.** GreyNoise returns
  noise/classification/actor context — a materially different shape from AbuseIPDB's reputation score,
  the same reasoning that already keeps `CensysEnrichment` separate. Additive-only migration
  (`20260807110000_add_phase8d_greynoise_reputation_enrichment`), one enum + one table, no existing
  column touched.
- **No queue.** Deliberately NOT modelled on `IocEnrichment`'s PENDING/lease/retry/dead-letter
  lifecycle — every row is written once, already terminal, by a synchronous, human-triggered lookup
  (`greyNoiseExecutionService.js`, `POST /api/findings/:id/enrichment/greynoise`). This phase's explicit
  scope excludes queues/schedulers.
- **Same authorization and quota as every other provider route.** `GET .../enrichment/greynoise` reuses
  `read:findings`; `POST .../enrichment/greynoise` reuses `trigger:finding-enrichment` (ADMIN/ANALYST
  only) and the SAME `providerRateLimiter` budget IOC/CVE/Censys enrichment already share — proven in
  `phase7RateLimiting.test.js` ("Phase 8D — counts the GreyNoise route in the SAME budget, not a fresh
  one").
- **Audit events**: `greynoise.lookup.attempted`, `.succeeded`, `.failed`, `.unavailable`,
  `.rate_limited` — actor/role, provider id, terminal status, and the closed `errorCode` only, never a
  raw upstream body or the API key.
- **Dashboard/Settings.** A new sibling array, `sections.providers.reputation` (parallel to
  `.ioc`/`.vulnerability`/`.exposure` — not folded into `.exposure`, because GreyNoise is neither
  exposure/attack-surface data nor the single selected ioc-reputation slot), reports
  `CONFIGURED`/`NOT_CONFIGURED` plus freshness from `GreyNoiseEnrichment`, zero live calls. Rendered by
  the SAME existing `Settings.jsx`/`DashboardSections.jsx` flattened provider list (`ProviderFreshness`)
  — a one-line addition (`...(providers.reputation || [])`) in each, no new UI component, no new status
  vocabulary.
- **Manual live smoke**: `backend/src/scripts/greyNoiseLiveSmoke.js` (`npm run smoke:greynoise`), opt-in
  via `LIVE_GREYNOISE_SMOKE=1`, one lookup against `1.1.1.1` (Cloudflare's public DNS resolver —
  permanent public infrastructure, never a customer/victim asset), never prints credentials, never runs
  in CI. Not executed against the real GreyNoise API this session (not authorized).
- Tests: `greyNoiseProvider.test.js` (16 — construction with no credentials, unsupported indicator, key
  header construction, success normalization for a noisy/malicious IP, a RIOT/benign IP, and a
  not-observed IP without fabricating a classification, an out-of-vocabulary classification discarded,
  401/403/404/429/5xx/timeout/malformed/unreachable, credential redaction),
  `greyNoiseEnrichmentRouteAuthorization.test.js` (14 — full route→controller→service→provider chain
  with a faked `globalThis.fetch`, capability matrix, 404/401 handling, audit pair, redaction),
  `phase8dGreyNoiseProviderEvidence.test.js` (6 — startup safety, registry isolation, error-contract
  closure, closed classification vocabulary, shared-quota assertion, smoke-script guard), plus 2 new
  cases in `phase7RateLimiting.test.js` for the shared/own-budget proof and extensions to
  `operationalOverviewService.test.js`/`riskFactorPressure.test.js` for the new `reputation` section.
  Backend suite: 2990 passed / 177 skipped, zero regressions.

### Shodan — the fourth live provider (Phase 8E)

- **Targets Shodan's REST API** (`api.shodan.io`, host-lookup endpoint `GET /shodan/host/{ip}`), authenticated
  via a `key` query parameter — Shodan's own documented scheme, which has no header-based option (unlike
  Censys's Bearer PAT or GreyNoise's `key` header). `SHODAN_API_KEY` is optional at startup — a missing key
  only disables the provider (`SKIPPED_DISABLED`), never blocks the app. The request URL (which embeds the
  key once a lookup fires) is never logged, printed, or included in any error, audit row, or test assertion
  anywhere in this codebase — `shodanProvider.test.js` and `shodanEnrichmentRouteAuthorization.test.js` both
  prove this directly.
- **New adapter, no change to any existing provider or registry.** `shodanProvider.js` (self-contained,
  mirrors `censysProvider.js`'s/`greyNoiseProvider.js`'s exact defensive shape: composed timeout+caller-signal,
  every expected HTTP/transport outcome mapped to a normalized result, never throwing for an expected
  outcome), `shodanTypes.js` (own closed status/error taxonomy, reusing the same
  `PROVIDER_RATE_LIMITED`/`PROVIDER_INVALID_KEY`/`PROVIDER_TIMEOUT`/`PROVIDER_UNAVAILABLE`/
  `PROVIDER_UNREACHABLE`/`PROVIDER_MALFORMED_RESPONSE`/`PROVIDER_REJECTED`/`UNSUPPORTED_INDICATOR`/
  `ENRICHMENT_DISABLED` code vocabulary the rest of the app already speaks, plus a closed CVE-identifier
  format guard — a `vulns` entry that doesn't match Shodan's own `CVE-YYYY-NNNN+` shape is dropped, never
  passed through as an invented identifier), `shodanConfig.js` (bounds/defaults, mirrors
  `censysConfig.js`/`greyNoiseConfig.js`). IPv4 only — this repository has no IPv6 indicator validator
  anywhere to extend safely, so none was added speculatively for this one provider.
- **Its own Prisma table (`ShodanEnrichment`), not a bolt-on to `CensysEnrichment`.** Shodan returns
  hostnames, organization/ISP, geo, per-service product+version banners and CVE identifiers — a materially
  different shape from Censys's services/AS-ownership columns, the same reasoning that already keeps
  `GreyNoiseEnrichment` separate from both. Additive-only migration
  (`20260807120000_add_phase8e_shodan_exposure_enrichment`), one enum + one table, no existing column
  touched.
- **No queue.** Deliberately NOT modelled on `IocEnrichment`'s PENDING/lease/retry/dead-letter lifecycle —
  every row is written once, already terminal, by a synchronous, human-triggered lookup
  (`shodanExecutionService.js`, `POST /api/findings/:id/enrichment/shodan`). This phase's explicit scope
  excludes queues/schedulers.
- **Same authorization and quota as every other provider route.** `GET .../enrichment/shodan` reuses
  `read:findings`; `POST .../enrichment/shodan` reuses `trigger:finding-enrichment` (ADMIN/ANALYST only) and
  the SAME `providerRateLimiter` budget IOC/CVE/Censys/GreyNoise enrichment already share — proven in
  `phase7RateLimiting.test.js` ("Phase 8E — counts the Shodan route in the SAME budget, not a fresh one").
  `phase7RouteCensus.test.js` (the structural route-authorization walk) covers both new routes automatically.
- **Audit events**: `shodan.lookup.attempted`, `.succeeded`, `.failed`, `.unavailable`, `.rate_limited` —
  actor/role (from `buildAuditContext`), provider id, terminal status, and the closed `errorCode` only, never
  a raw upstream body, the API key, or the request URL.
- **Dashboard/Settings.** Shodan joins `sections.providers.exposure` as a SECOND entry alongside Censys,
  rather than getting its own sibling array the way GreyNoise did in Phase 8D: Shodan's data (exposed
  services, banners, open ports) IS the "internet exposure / attack surface" domain that array already
  represents, not a new one — `exposureProviders` was already an additive list (unlike `.ioc`, a config
  CHOICE between mock/abuseipdb), so a second provider in the same domain belongs inside it. This needed
  **zero frontend changes**: `Settings.jsx` and `DashboardSections.jsx`'s `ProviderFreshness` already spread
  `...(providers.exposure || [])` generically, so Shodan appears the moment the backend adds it.
- **Manual live smoke**: `backend/src/scripts/shodanLiveSmoke.js` (`npm run smoke:shodan`), opt-in via
  `LIVE_SHODAN_SMOKE=1`, one lookup against `8.8.8.8` (Google Public DNS — permanent public infrastructure,
  never a customer/victim asset), never prints credentials or the request URL, never runs in CI. Not executed
  against the real Shodan API this session (not authorized).
- Tests: `shodanProvider.test.js` (17 — construction with no credentials, unsupported indicator, query-param
  key construction, success normalization including hostnames/org/isp/geo/services/CVEs, malformed-CVE
  rejection, empty-host normalization without fabrication, 401/403/404/429/5xx/timeout/malformed/unreachable,
  credential redaction), `shodanEnrichmentRouteAuthorization.test.js` (14 — full
  route→controller→service→provider chain with a faked `globalThis.fetch`, capability matrix, 404/401
  handling, audit pair, redaction), `phase8eShodanProviderEvidence.test.js` (8 — startup safety, registry
  isolation, error-contract closure, CVE-format closure, shared-quota assertion, query-param auth design
  pin, smoke-script guard), plus 2 new cases in `phase7RateLimiting.test.js` for the shared/own-budget proof
  and extensions to `operationalOverviewService.test.js`/`riskFactorPressure.test.js` for the new Shodan
  `shodanEnrichment.aggregate` stub.

### Netlas — the fifth live provider (Phase 8F)

- **Targets Netlas's Host Info endpoint** (`app.netlas.io`, `GET /api/host/{ip}/`), authenticated via an
  `Authorization: Bearer <key>` header — RFC 6750, Netlas's current documented scheme (its older `X-Api-Key`
  header is documented as deprecated, so this provider does not use it). `NETLAS_API_KEY` is optional at
  startup — a missing key only disables the provider (`SKIPPED_DISABLED`), never blocks the app. The
  Authorization header (which carries the key once a lookup fires) is never logged, printed, or included in
  any error, audit row, or test assertion anywhere in this codebase — `netlasProvider.test.js` and
  `netlasEnrichmentRouteAuthorization.test.js` both prove this directly.
- **New adapter, no change to any existing provider or registry.** `netlasProvider.js` (self-contained,
  mirrors `censysProvider.js`'s/`shodanProvider.js`'s exact defensive shape: composed timeout+caller-signal,
  every expected HTTP/transport outcome mapped to a normalized result, never throwing for an expected
  outcome — including Netlas's own `402` "out of subscription plan limits" response, mapped to
  `RATE_LIMITED` alongside `429` since this closed vocabulary has no separate quota status and "try again
  later" is the closer fit of the two), `netlasTypes.js` (own closed status/error taxonomy, reusing the same
  `PROVIDER_RATE_LIMITED`/`PROVIDER_INVALID_KEY`/`PROVIDER_TIMEOUT`/`PROVIDER_UNAVAILABLE`/
  `PROVIDER_UNREACHABLE`/`PROVIDER_MALFORMED_RESPONSE`/`PROVIDER_REJECTED`/`UNSUPPORTED_INDICATOR`/
  `ENRICHMENT_DISABLED` code vocabulary the rest of the app already speaks), `netlasConfig.js`
  (bounds/defaults, mirrors `censysConfig.js`/`shodanConfig.js`). IPv4 only — Netlas's Host Info endpoint
  also accepts a domain name, but this repository has no domain/hostname indicator validator or model
  anywhere to extend safely, the same reasoning that already keeps every exposure provider here IPv4-only
  rather than speculatively adding one (also no IPv6 validator, same as Censys/GreyNoise/Shodan).
- **Its own Prisma table (`NetlasEnrichment`), not a bolt-on to `CensysEnrichment` or `ShodanEnrichment`.**
  Netlas's response combines reverse-DNS/associated-domain names, WHOIS/ASN ownership, open ports,
  per-service software banners, AND certificate subject/issuer/SAN data in one payload — a materially
  different shape from either existing exposure table, the same reasoning that already keeps
  `CensysEnrichment`, `GreyNoiseEnrichment` and `ShodanEnrichment` separate from each other. `services[]`
  (ports) and `products[]` (software) are stored as two separate arrays rather than merged into one, because
  Netlas's documented response carries no positional/key correlation between them — merging would be a
  fabricated join, not real evidence. Additive-only migration
  (`20260807130000_add_phase8f_netlas_exposure_enrichment`), one enum + one table, no existing column
  touched.
- **No queue.** Deliberately NOT modelled on `IocEnrichment`'s PENDING/lease/retry/dead-letter lifecycle —
  every row is written once, already terminal, by a synchronous, human-triggered lookup
  (`netlasExecutionService.js`, `POST /api/findings/:id/enrichment/netlas`). This phase's explicit scope
  excludes queues/schedulers.
- **Same authorization and quota as every other provider route.** `GET .../enrichment/netlas` reuses
  `read:findings`; `POST .../enrichment/netlas` reuses `trigger:finding-enrichment` (ADMIN/ANALYST only) and
  the SAME `providerRateLimiter` budget IOC/CVE/Censys/GreyNoise/Shodan enrichment already share — proven in
  `phase7RateLimiting.test.js` ("Phase 8F — counts the Netlas route in the SAME budget, not a fresh one").
  `phase7RouteCensus.test.js` (the structural route-authorization walk) covers both new routes automatically.
- **Audit events**: `netlas.lookup.attempted`, `.succeeded`, `.failed`, `.unavailable`, `.rate_limited` —
  actor/role (from `buildAuditContext`), provider id, terminal status, and the closed `errorCode` only, never
  a raw upstream body, the API key, or the Authorization header.
- **Dashboard/Settings.** Netlas joins `sections.providers.exposure` as a THIRD entry alongside Censys and
  Shodan, for the same reason Shodan joined in Phase 8E: open ports, DNS/certificate context, and ASN
  ownership ARE the "internet exposure / attack surface" domain that array already represents, not a new
  one. This needed **zero frontend changes**: `Settings.jsx` and `DashboardSections.jsx`'s
  `ProviderFreshness` already spread `...(providers.exposure || [])` generically, so Netlas appears the
  moment the backend adds it.
- **Manual live smoke**: `backend/src/scripts/netlasLiveSmoke.js` (`npm run smoke:netlas`), opt-in via
  `LIVE_NETLAS_SMOKE=1`, one lookup against `8.8.8.8` (Google Public DNS — permanent public infrastructure,
  never a customer/victim asset), never prints credentials or the Authorization header, never runs in CI.
  Not executed against the real Netlas API this session (not authorized).
- Tests: `netlasProvider.test.js` (17 — construction with no credentials, unsupported indicator, Bearer-header
  construction, success normalization including hostnames/domains/org/asn/country/services/products/
  certificate fields, empty-host normalization without fabrication, 400/401/403/404/429/402/5xx/504/timeout/
  malformed/unreachable, credential redaction), `netlasEnrichmentRouteAuthorization.test.js` (14 — full
  route→controller→service→provider chain with a faked `globalThis.fetch`, capability matrix, 404/401
  handling, audit pair, redaction), `phase8fNetlasProviderEvidence.test.js` (8 — startup safety, registry
  isolation, error-contract closure, shared-quota assertion, Bearer-header auth design pin, smoke-script
  guard), plus 2 new cases in `phase7RateLimiting.test.js` for the shared/own-budget proof and extensions to
  `operationalOverviewService.test.js`/`riskFactorPressure.test.js` for the new Netlas
  `netlasEnrichment.aggregate` stub.

### Finding-level AI assistance (Phase 8C)

- **A second, independent AI suggestion domain, alongside Phase 5's ATT&CK mapping suggestions.**
  Phase 5 already shipped disabled-by-default, human-approved AI mapping suggestions
  (`AiSuggestionRun`/`AiFrameworkMappingSuggestion`, `services/ai/`). This ticket did not touch that
  code. It adds `FindingAiSuggestion` (own table, own service module `services/aiAssist/`) for two
  new, smaller suggestion types a mapping candidate cannot express: a **SUMMARY** and an
  **EXPLANATION** draft for a single Finding.
- **Reuses the SAME `AI_ENABLED`/`AI_PROVIDER` operator switch** Phase 5 declared — "AI is optional
  and disabled by default" is one decision, not a per-feature toggle. With `AI_ENABLED=false` (the
  shipped default), the disabled provider is resolved regardless of `AI_PROVIDER`, and no suggestion
  request ever reaches a provider call.
- **Its own small provider registry and contract** (`aiAssistProviderRegistry.js`,
  `generateSuggestion({snapshot, suggestionType, asOf, signal})` — a different shape from Phase 5's
  `suggestMappings`), not a modification of the Phase 5 registry. Consistent with this repository's
  existing convention of domain-separated provider registries (IOC / vulnerability / exposure, and now
  two independent AI ones) rather than one unified abstraction. `mock` is reachable only with an
  explicit test-only `allowMockProvider: true` that no production code path ever passes — the same "no
  silent fallback from production to mock" guarantee Phase 5 established. **There is still no live AI
  provider anywhere in this repository** (same boundary Phase 5 documented); adding one is a future
  decision for `DECISIONS.md`, not a config toggle.
- **A Finding-scoped, prompt-minimized snapshot** (`findingEvidenceSnapshot.js`), built by construction
  the same way `caseEvidenceSnapshot.js` is: named, explicitly `SELECT`ed columns only. Structurally
  excludes the Finding's indicator value, port and protocol, and any organization contact detail — a
  provider is handed report type, triage decision, the stored Risk v1 band/explanation, and
  analyst-verified CVE ids, nothing else.
- **Provider output is untrusted input**, validated by the same discipline as Phase 5: only `text` and
  `evidenceReferences` are ever read off a provider result (everything else is discarded by
  construction, not merely rejected), text is bounded, and `evidenceReferences` must name only fields
  present in the snapshot's own closed allow-list.
- **Generating a draft never mutates the Finding or anything else** — it writes exactly one
  `FindingAiSuggestion` row, always `DRAFT`. **Accepting one only flips its own review state** (there is
  no downstream authoritative record to promote into, unlike an ATT&CK mapping), so the safe-acceptance
  surface is deliberately smaller than Phase 5's.
- **Decide reuses the pre-existing `review:ai-suggestions` capability** (declared Phase 0, unused by any
  route until now) rather than a third new grant — ADMIN/REVIEWER accept or reject; ADMIN/ANALYST
  request/read (`request:ai-finding-suggestions`, `read:ai-finding-suggestions`); VIEWER holds neither.
  This is a genuine separation of duties: the role that drafts can never also decide.
- **Staleness on accept, never on reject.** If the Finding's evidence has changed since a draft was
  generated, an accept attempt transitions the `DRAFT` to `EXPIRED` and is refused — never silently
  re-derived. Rejecting is unconditional, the same reasoning Phase 5 applies to mapping-suggestion
  rejection.
- **Shares the SAME `providerRateLimiter` budget** every other provider-execution route draws on (IOC/CVE/Censys
  enrichment, AI mapping suggestions) — proven in `phase7RateLimiting.test.js` ("Phase 8C — counts the
  AI finding-suggestion route in the SAME budget, not a fresh one").
- **Audit events**: `ai.suggestion.requested`, `.generated`, `.failed`, `.accepted`, `.rejected`,
  `.unavailable` — actor/role, provider name, closed reason code only, never the proposed text, the
  snapshot, or the internal fingerprint.
- **Prompt-injection controls**: analyst-supplied `requestContext` and provider-returned text are plain
  string values on a data object; nothing in this codebase parses instructions out of either.
  `findingAiPromptInjection.test.js` drives an adversarial payload end to end and asserts no Finding
  mutation and no auto-acceptance.
- **No live smoke script.** Unlike NVD/Censys, there is no live AI provider to smoke-test in this
  milestone, so none was added.

### Frontend AI-assistance surface (Phase 8C.1)

- **`FindingAiAssistPanel.jsx`**, mounted on the Finding-detail page, is the ONLY frontend surface for
  this feature. It calls the four Phase 8C endpoints and the existing shared `/api/ai/config` (the same
  one Phase 5's AI mapping panel already used — one `AI_ENABLED`/`AI_PROVIDER` switch covers both
  frontend surfaces, so there is no second config call to keep in sync).
- **Role rendering is driven entirely by the capabilities the server returns at login**, never by a
  locally hardcoded role table — `hasCapability(capabilities, CAPABILITIES.READ_AI_FINDING_SUGGESTIONS)`
  etc. This is UX only: the backend re-checks every capability on every request regardless of what the
  panel renders, and a denied request creates no row. A 403 renders a `DeniedState` inline; nothing in
  this panel ever triggers a sign-out (only a 401 on a non-login route does, in the shared axios
  interceptor — untouched by this ticket).
- **Availability is mapped onto the SAME `AVAILABILITY` status vocabulary** the rest of the app already
  uses for "disabled" vs "unavailable" vs "available" (`theme/tokens.js`) — not a bespoke tone invented
  for this one panel, and never a fabricated "AI online" state when the backend reports otherwise.
- **A draft is never rendered as a finding fact.** Every draft carries its own `StatusBadge`
  (DRAFT/ACCEPTED/REJECTED/EXPIRED — label, icon and colour together, never colour alone), its evidence
  references as human-readable tags from a closed allow-list, and an advisory note that accepting only
  records a human reviewer's decision — it never closes, scores or reclassifies the Finding. No raw
  provider error, prompt, or backend exception text ever reaches the DOM: every error path renders
  through `describeAiAssistError`, which maps a closed set of backend codes to prose and falls back to a
  generic message for anything else.
- **No live-provider content is reachable through the browser.** Because `aiAssistRuntime.js` never
  resolves the mock provider without an explicit test-only flag no production HTTP path ever passes, the
  panel's only observable live state is "disabled" (the shipped default) or "no provider configured" —
  proven against a real backend and a real seeded Postgres database in this session (see
  `docs/ai/HANDOFF.md`). The populated-draft rendering (accept/reject, evidence tags, every status) is
  covered by `FindingAiAssistPanel.test.jsx`, which injects the mock provider response directly, and by
  `frontend/e2e/findingAiAssistance.spec.js` for the disabled/denied states CI's own seeded stack can
  reach.

## Security tests

`backend/tests/` (unit, middleware, integration, including real-PostgreSQL concurrency),
`eval/run_*_gate.js`, and `frontend/e2e/`. CI additionally scans for committed `.env` files,
credential-shaped literals, generated artifacts, and secret-shaped literals in the production bundle.
It also verifies the pinned ATT&CK catalogue checksum and runs the Phase 6.3 evidence-integrity gate.

## Known risks and accepted exceptions

- **`react-router-dom` is pinned to 7.18.2.** One advisory remains open; it is RSC-mode-only and
  unreachable in a client-only SPA. A 7.11.0 downgrade was tested and rejected — it trades one
  unreachable advisory for fourteen reachable ones.
- **AI is disabled by default (`AI_ENABLED=false`)**, covering BOTH suggestion domains (Phase 5 ATT&CK
  mapping suggestions and Phase 8C Finding summary/explanation drafts) under one switch, and cannot
  approve, send, score, close, resolve, or make a final framework mapping. Every core workflow must
  complete with AI off.
- **No SMTP or webhook client exists**, not even a disabled one. Export is not delivery.
- **`backend/.env` on the development machine holds live provider keys.** It is correctly gitignored,
  has never been tracked, and is absent from history. It must never be read, printed, copied,
  transmitted or modified by an agent.
