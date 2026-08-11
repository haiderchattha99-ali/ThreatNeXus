# Provider Guide

ThreatNeXus integrates six live third-party intelligence providers, all optional, all off by default in
the sense that a missing key never blocks the application — it only leaves that one provider disabled.
This guide covers what each provider does, how to configure it, how it fails, and — the point that
matters most for anyone using the output — what its evidence actually means.

**Every provider result is supporting context, never proof.** A high AbuseIPDB confidence score, a
GreyNoise `malicious` classification, an open Shodan port — none of these close a case, change a role's
authority, or trigger a notification by themselves. An analyst reads the evidence and decides. See
`docs/AI_GOVERNANCE.md` for the equivalent statement about AI-generated suggestions, which follows the
same rule.

## How to read this guide

Each provider section covers: purpose, environment variables (placeholders only — see
`backend/.env.example`, never a real key), what happens in CI/tests, the normalized evidence fields, how
failure is handled, and the security boundary around its credential. The architectural pattern all six
adapters share is in `docs/ARCHITECTURE.md` → "Provider adapter pattern"; this guide does not repeat
that shape per provider, only what differs.

**No automated test or CI job ever makes a live call to any of these six providers.** Every test injects
its own fake HTTP transport; live verification is opt-in only, through a manual smoke script, and was
not run for any provider as part of this delivery (see each provider's "Live smoke" line and
`docs/TESTING_AND_CI.md`).

---

## AbuseIPDB — IP reputation (the required first provider)

| | |
|---|---|
| **Purpose** | Confidence score, report count, and whitelist status for an IPv4 indicator |
| **Domain** | IOC reputation |
| **Env vars** | `IOC_ENRICHMENT_PROVIDER` (`mock` or `abuseipdb`), `ABUSEIPDB_API_KEY`, `ABUSEIPDB_BASE_URL`, `ABUSEIPDB_TIMEOUT_MS`, `ABUSEIPDB_MAX_AGE_DAYS`, `ABUSEIPDB_CACHE_TTL_HOURS` |
| **Auth** | API key header |
| **Storage** | `IocEnrichment` — the only provider table modelled as a queue (PENDING/lease/retry/dead-letter), because it is the one provider wired into automatic post-ingestion enrichment |
| **Live smoke** | None shipped for this provider specifically — it is exercised through the automated test/evaluator suite via `MockProvider`, never live |

`IOC_ENRICHMENT_PROVIDER=mock` is the default and requires no key — `MockProvider` returns a
deterministic result and is what every automated test and evaluator uses. Set it to `abuseipdb` with a
real key to enrich against the live API; every core workflow (ingestion, triage, cases, notifications)
completes identically either way. **Enrichment failure never blocks ingestion** — the finding is still
created, and the `IocEnrichment` row records `FAILED` or `RATE_LIMITED` instead of a score.

## NVD (with CISA KEV and FIRST EPSS) — vulnerability metadata

| | |
|---|---|
| **Purpose** | CVE metadata (NVD), known-exploited status (KEV), exploit-prediction score (EPSS) |
| **Domain** | Vulnerability enrichment — a separate path from IOC reputation; neither substitutes for the other |
| **Env vars** | `NVD_API_KEY` (optional), `NVD_BASE_URL`, `NVD_TIMEOUT_MS` |
| **Auth** | API key, optional — NVD works keyless at a lower public rate limit |
| **Storage** | `VulnerabilityProviderResult`, one row per `(provider, identifier)` |
| **Live smoke** | `LIVE_NVD_SMOKE=1 npm run smoke:nvd --prefix backend` — one lookup against a permanently published CVE. Not run this delivery. |

KEV and CISA EPSS require no key at all (public catalogues). A missing `NVD_API_KEY` is reported as
`KEYLESS_PUBLIC_RATE_LIMIT`, not `NOT_CONFIGURED` — a key-optional provider is a genuinely different,
still-valid mode from a key-required one, and the dashboard says so rather than treating "no key" as a
single undifferentiated state. This product uses the NVD API but is not endorsed or certified by NVD.

## Censys — internet exposure / attack surface (Phase 8B)

| | |
|---|---|
| **Purpose** | Open services and autonomous-system ownership for an IPv4 indicator |
| **Domain** | Exposure / attack surface |
| **Env vars** | `CENSYS_PAT` (Personal Access Token), `CENSYS_ORG_ID` (optional, for multi-org accounts), `CENSYS_BASE_URL`, `CENSYS_TIMEOUT_MS` |
| **Auth** | `Authorization: Bearer <PAT>` against Censys's current Platform API (`api.platform.censys.io`) — not the legacy Search v2 API |
| **Storage** | `CensysEnrichment` |
| **Route** | `GET`/`POST /api/findings/:id/enrichment/censys` |
| **Live smoke** | `LIVE_CENSYS_SMOKE=1 npm run smoke:censys --prefix backend` against `1.1.1.1`. Not run this delivery. |

## GreyNoise — internet noise / scanning context (Phase 8D)

| | |
|---|---|
| **Purpose** | Whether an IPv4 address is known internet background noise, and a `benign`/`malicious`/`unknown` classification |
| **Domain** | Reputation — its own array on the dashboard, distinct from exposure, because noise/scanning context is not attack-surface data and not the single IOC-reputation slot |
| **Env vars** | `GREYNOISE_API_KEY`, `GREYNOISE_BASE_URL`, `GREYNOISE_TIMEOUT_MS` |
| **Auth** | `key` header (Community API tier) |
| **Storage** | `GreyNoiseEnrichment` |
| **Route** | `GET`/`POST /api/findings/:id/enrichment/greynoise` |
| **Live smoke** | `LIVE_GREYNOISE_SMOKE=1 npm run smoke:greynoise --prefix backend` against `1.1.1.1`. Not run this delivery. |

GreyNoise's classification is its own closed vocabulary (`benign`/`malicious`/`unknown`); anything
outside that set is normalized to `null`, never passed through as an invented fourth value.

## Shodan — exposed service / banner / port intelligence (Phase 8E)

| | |
|---|---|
| **Purpose** | Hostnames, organization/ISP, geo, per-service product+version banners, and CVE identifiers for an IPv4 indicator |
| **Domain** | Exposure / attack surface — joins the same dashboard array as Censys |
| **Env vars** | `SHODAN_API_KEY`, `SHODAN_BASE_URL`, `SHODAN_TIMEOUT_MS` |
| **Auth** | `key` query parameter — Shodan's own documented scheme; no header option |
| **Storage** | `ShodanEnrichment` |
| **Route** | `GET`/`POST /api/findings/:id/enrichment/shodan` |
| **Live smoke** | `LIVE_SHODAN_SMOKE=1 npm run smoke:shodan --prefix backend` against `8.8.8.8`. Not run this delivery. |

A `vulns` entry that doesn't match Shodan's own `CVE-YYYY-NNNN+` format is dropped, never passed through
as an invented CVE.

## Netlas — cross-source attack-surface / DNS / certificate intelligence (Phase 8F)

| | |
|---|---|
| **Purpose** | Reverse DNS, associated domains, ASN/organization ownership, open ports, per-service software banners, and TLS certificate subject/issuer/SAN for an IPv4 indicator |
| **Domain** | Exposure / attack surface — the third entry in the same dashboard array as Censys and Shodan |
| **Env vars** | `NETLAS_API_KEY`, `NETLAS_BASE_URL`, `NETLAS_TIMEOUT_MS` |
| **Auth** | `Authorization: Bearer <key>` (RFC 6750) — Netlas's current documented scheme; its older `X-Api-Key` header is deprecated and not used here |
| **Storage** | `NetlasEnrichment` |
| **Route** | `GET`/`POST /api/findings/:id/enrichment/netlas` |
| **Live smoke** | `LIVE_NETLAS_SMOKE=1 npm run smoke:netlas --prefix backend` against `8.8.8.8`. Not run this delivery. |

Netlas's `ports[]` (open services) and `software[]` (product/version banners) are stored as two separate
arrays rather than merged, because Netlas's documented response has no positional/key correlation
between them — merging would fabricate a join the evidence doesn't support. Netlas's own `402` response
("out of subscription plan limits") is treated as rate-limited, alongside `429`.

---

## Shared behavior across all six

- **Failure never blocks ingestion or the workflow it's attached to.** Every provider adapter maps every
  expected failure (disabled, invalid key, rate-limited, timeout, unreachable, malformed response,
  not-found) to a normalized, persisted terminal result — never an unhandled exception, never a retry
  loop, never a fabricated success.
- **A missing key only disables that one provider** (`SKIPPED_DISABLED`); the application starts and
  every core workflow completes with zero keys configured. This is proven in CI (`eval:phase7`, which
  replaces `fetch` with a throwing counter and asserts it is never called) and in the offline demo
  rehearsal (`docker-compose.offline.yml`, which blackholes every provider host at the DNS level).
- **One shared rate-limit budget.** All six providers' execution routes (the `POST .../enrichment/*`
  endpoints) draw on the same `providerRateLimiter` bucket (`RATE_LIMIT_PROVIDER_MAX`, default 60 per
  window) — a caller cannot get a bigger effective quota by switching providers. Reading stored results
  (`GET`) is never rate-limited; only causing new provider spend is.
- **No secret ever reaches a log line, an audit row, or the frontend.** Every provider's key is read only
  to build the outbound request and is never included in an error message, a persisted row, an audit
  event, or an HTTP response body — proven per provider by a dedicated redaction test.
- **Own Prisma table per provider**, not one shared "enrichment" table. Each provider returns a
  materially different response shape (a reputation score is not a certificate SAN list), and forcing
  them into one table would mean either losing fields or inventing nullable columns nobody's schema
  needs. See `docs/ai/SECURITY.md` for the reasoning recorded at the time each provider was added.
- **No queue for the five providers added after AbuseIPDB.** Censys, GreyNoise, Shodan and Netlas are all
  synchronous, human-triggered, single-attempt lookups — a human clicks "look up", one HTTP call happens,
  one row is persisted. Only AbuseIPDB has queue/lease/retry semantics, because it is the one provider
  wired into automatic post-ingestion enrichment.

## Providers not integrated

- **Shadowserver.** ThreatNeXus *consumes* Shadowserver-style report files as its input format
  (Accessible RDP exposure reports), but there is no live scheduled Shadowserver API ingestion — reports
  are uploaded as files. Integrating a live Shadowserver API feed is out of scope for this delivery and
  is pending API access/licensing arrangements the project does not currently hold.
- **VirusTotal, OTX, MISP.** Not integrated. No adapter, no env var, no code path references them.
  Recommended as the natural next live-provider phase if one is wanted (same pattern: own table, own
  module set, shared quota).

---

## Phase 10A-1 — enrichment orchestration (inert: records intent, executes nothing)

Phase 10A-1 introduces a layer *above* the individual providers documented on this page. It decides
and records **which provider should be asked about which subject for a Finding**. It does not call
anything. Every provider integration described above continues to behave exactly as documented.

### Subject compatibility

Orchestration is typed by *subject*, not by "indicator" — NVD's subject is a CVE identifier, which
is not an indicator of compromise.

| Provider | Subject type | Execution in Phase 10 |
|---|---|---|
| `abuseipdb` | IPv4 only | **Delegated** — links the existing `IocEnrichment` row created by ingestion; the ADMIN IOC batch still executes it. |
| `greynoise` | IPv4 only | Direct (Phase 10A-2). Job is created and left non-terminal in 10A-1. |
| `censys` | IPv4 only | Direct (Phase 10A-2). |
| `shodan` | IPv4 only | Direct (Phase 10A-2). |
| `netlas` | IPv4 only | Direct (Phase 10A-2). |
| `nvd` | CVE only | **Delegated** — links the existing `VulnerabilityEnrichmentJob`; NVD results still require the ADMIN vulnerability batch, which 10A-2 deliberately does not make worker-eligible. |

Subject values are canonicalized **before** any hashing or uniqueness decision: strict dotted-quad
IPv4 (leading zeros, CIDR suffixes, IPv6 and hostnames are rejected, never coerced) and canonical
uppercase `CVE-YYYY-NNNN…`. Skipping canonicalization would fragment the shared-work key into one
job per spelling.

A Finding's CVE subjects come **only** from `ACTIVE`, `ANALYST_VERIFIED` `FindingVulnerability`
associations. A CVE named in Shodan's exposure text is never promoted into a subject. Three verified
CVEs stay three separate NVD subjects.

### Budgets and lanes

Every outbound call is charged to one lane, fixed at job creation from the run's trigger:

- **AUTOMATIC** — ingestion-triggered. `<PROVIDER>_AUTOMATIC_DAILY_BUDGET`, **default `0`**.
- **MANUAL** — an analyst explicitly asking. `<PROVIDER>_MANUAL_DAILY_BUDGET`, default unlimited
  (blank or the literal `unlimited`), still parsed and validated.

Accepted values are a plain decimal integer `0..1000000`, or `unlimited` on the manual lane only.
Exponent notation, `0x` forms and signed values are rejected as configuration mistakes.

A **known-zero** budget is refused at routing time: the run item records `SKIPPED_BUDGET` and **no
job is created and no reservation is attempted**. That is structurally different from a job whose
execution-time reservation is refused (Phase 10A-2), which is recorded as
`ProviderLookupJobState.SKIPPED_BUDGET` on an already-created job while its run item stays
`ELIGIBLE`. Run aggregation distinguishes the two, so "we never asked" is never reported as "we
asked and were refused".

### Deduplication: two mechanisms, never conflated

- `idempotencyKey` (unique per run) deduplicates **the same ask**.
- `activeLookupKey` (unique per job, held only while non-terminal) deduplicates **outbound work**.

So: two concurrent identical requests collapse into one run; ten Findings on one IP share one job;
and an AbuseIPDB-scoped run does **not** suppress a later Censys-scoped run. Collapsing these two
into a single key is exactly the defect the v2.1 correction addendum exists to fix.
