# Handoff: TNX-P8F-NETLAS-PROVIDER

- From: claude
- Suggested next writer: claude (in progress)
- Branch: feat/phase-8f-netlas-provider
- Updated: 2026-08-09T19:10:00Z

## Phase 8E closure note

`feat/phase-8e-shodan-provider` is merged into `main` via PR #15 (`0a29ab6`, containing checkpoint
`0711c63`). This ticket branches from that updated tip.

## Goal

Add exactly one new live provider, Netlas, for cross-source attack-surface/DNS/certificate/service
intelligence, using the existing provider foundation and Censys/GreyNoise/Shodan patterns. No live calls
in CI/tests, no secret leakage, provider rate-limit/audit/status support, optional manual smoke, docs/ai
handoff, and green CI.

## Verified the real API before writing the adapter

Rather than guessing a plausible-looking response schema, this session looked up Netlas's actual
documentation (`docs.netlas.io/api-reference/`) first:

- **Auth**: `Authorization: Bearer <key>` (RFC 6750) — Netlas's *current* documented scheme. Its older
  `X-Api-Key` header still works but is documented as deprecated, so this adapter does not use it.
- **Endpoint**: `GET https://app.netlas.io/api/host/{ip}/`.
- **Response fields used**: `ip`, `ptr` (reverse DNS), `domains`, `organization`, `geo.country`,
  `ports[]` (`port`/`prot4`/`prot7`), `software[]` (`product`/`version`), `certificate.subject.common_name`,
  `certificate.issuer_dn`, `certificate.names` (SAN), `whois.asn.number`/`.name`, `lseen`/`fseen`.
- **Status codes**: `400` bad params, `401`/`403` auth/permission, `404` not found, `402` "out of
  subscription plan limits" (Netlas's own quota-exhaustion signal — mapped to `RATE_LIMITED` alongside
  `429`, since this app's closed status vocabulary has no separate quota state), `429` rate limited with
  `Retry-After`, `500`/`504` server errors.

## The one design decision that mattered most

Netlas's data (open ports, DNS/certificate context, ASN ownership) **is** the same "internet exposure /
attack surface" domain `sections.providers.exposure` already represents for Censys and Shodan — so
Netlas joins that array as a **third entry**, not a new one, the same call Shodan made in Phase 8E. Zero
frontend changes needed: `Settings.jsx`/`DashboardSections.jsx` already spread
`...(providers.exposure || [])` generically.

`NetlasEnrichment` still gets its own table (not a bolt-on to `CensysEnrichment` or `ShodanEnrichment`):
Netlas's single response combines reverse-DNS names, WHOIS/ASN ownership, open ports, per-service
software banners, AND certificate subject/issuer/SAN — a shape neither existing exposure table carries.
Inside that table, `services[]` (ports) and `products[]` (software) are stored as two separate arrays
rather than merged into one `{port, product, version}` shape the way Shodan's are: Netlas's documented
response has no positional/key correlation between `ports[]` and `software[]`, and inventing one would be
a fabricated join, not real evidence.

## What this ticket added

1. **`NetlasEnrichment`** (Prisma model + enum, additive-only migration
   `20260807130000_add_phase8f_netlas_exposure_enrichment`, generated via `prisma migrate dev
   --create-only` against the real schema and verified via `prisma validate`/`format`/`migrate
   deploy`/`migrate diff --exit-code`).
2. **`backend/src/services/exposure/`** — `netlasTypes.js`, `netlasConfig.js`, `netlasProvider.js`
   (Bearer-header auth, IPv4 only — Netlas's endpoint also accepts a domain name, but this codebase has
   no domain/hostname indicator model to extend safely, the same reasoning that already keeps every
   exposure provider here IPv4-only), `netlasExecutionService.js`. All mirror
   `censysProvider.js`'s/`shodanProvider.js`'s exact defensive shape.
3. **`GET`/`POST /api/findings/:id/enrichment/netlas`** — reuses `read:findings` /
   `trigger:finding-enrichment` (no new capability) and the SAME `providerRateLimiter` budget every other
   provider-execution route shares.
4. **`backend/src/scripts/netlasLiveSmoke.js`** (`npm run smoke:netlas`), opt-in via
   `LIVE_NETLAS_SMOKE=1`, against `8.8.8.8`. **Not executed this session** — not authorized.
5. **Dashboard**: Netlas joins `sections.providers.exposure` as a third entry. Zero frontend diff.
6. **`docker-compose.yml`/`docker-compose.offline.yml`** updated for `NETLAS_API_KEY` passthrough and the
   offline blackhole host (`app.netlas.io`).
7. **41 new/updated tests** (see `docs/ai/STATE.yaml` `completed` for the breakdown). Full backend suite:
   **3071 passed / 177 skipped**, zero regressions from the 3030 baseline.

## Verification this session actually ran

- `prisma format`, `prisma validate`, `prisma migrate deploy` against the local dev Postgres (applied
  cleanly), `prisma migrate diff --exit-code` (zero drift), `prisma generate` — all clean.
- Netlas-specific suite run in isolation first: 64/64 passed.
- Full backend suite: 3071 passed / 177 skipped. One transient `beforeAll` hook-timeout flake surfaced on
  a mixed-file run (the same class of CPU-contention flake documented in the Phase 8E handoff, not a real
  failure) — confirmed by rerunning the same two files alone (38/38 passed), and a subsequent full-suite
  run then completed clean in a single pass with zero flakes.

## CI result

Committed `2d9886f`, pushed. Run [31317791814](https://github.com/haiderchattha99-ali/ThreatNeXus/actions/runs/31317791814)
— **all required jobs green on the first push, no rerun needed**: frontend lint/tests/build, secrets
scan, schema/migration (including `migrate deploy from an empty database` and `No drift between schema
and applied migrations`), core evaluators, backend tests against real PostgreSQL, and the Chromium
browser suite. "Mutation and concurrency gates" is manual-trigger-only and was not run — not required for
this ticket.

## Honest gaps

- **Manual live Netlas smoke was not run** — awaiting explicit user authorization, per instruction.
- `F-drive start-task.ps1` throws against this repo's `STATE.yaml` schema; no working
  `.ai-team/WRITER_LOCK.json` mechanism exists for this repo — worked around, not fixed, same known gap
  as every phase since 8B.
- `docs/codex/` remains untracked and untouched, per the one-writer boundary.
- Netlas's response schema was verified against public documentation, not a live call (none authorized).
  If Netlas's actual response differs from documented shape at the edges, the adapter's allow-listed
  extraction fails safe (null/empty for that field, same posture as every other provider) — worth
  confirming on the first authorized live smoke.
- **No independent review yet.** Per this project's own rule ("do not review your own final work as the
  only reviewer"), an independent pass (Codex or otherwise) is recommended before this ticket is merged.

## Recommended next phase

Per the user's own instruction for this ticket: Phase 9, professional delivery package.

## Protected boundaries

- Do not redo completed work without evidence.
- Do not change architecture without updating `DECISIONS.md`.
- Do not expose secrets or absorb unrelated changes.
- `docs/codex/` is a foreign path this session did not touch — leave it alone unless its owner asks.
- `backend/.env` (and any non-`.env.example` env file) must never be read, printed, or committed.
- AbuseIPDB, NVD, Censys, GreyNoise, and Shodan are untouched and unaffected — verified by
  registry-isolation tests.
