# ThreatNeXus — Final Application Security Assessment

| | |
|---|---|
| **Ticket** | `TNX-FINAL-SECURITY-PASS` |
| **Base commit** | `90bdb8b` (`origin/main`, after functional-closure PR #28) |
| **Branch** | `security/final-bounded-hardening` |
| **Date** | 2026-08-18 |
| **Assessor** | Claude Code (AI Dev Team writer lease `e03d29da`) |
| **Type** | Single bounded, authorized, non-destructive application-security review |

This is an internal engineering assessment. **It is not a certification, and it does not claim the
absence of vulnerabilities.** It records what was tested, what was found, what was fixed, and what
was deliberately left alone.

---

## 1. Scope

Authorized target: the ThreatNeXus application running as a **disposable local stack owned by this
project**. In scope: the Express API, the authentication and capability model, the React client and
its bundle, Prisma/PostgreSQL data access, CSV report ingestion, configuration and secret handling,
audit logging, rate/budget controls, the external enrichment-provider boundary, and the Docker
runtime.

Explicitly out of scope and **not performed**: any request to a third party, any live enrichment
provider call, any internet host scanning, any destructive or resource-exhaustion testing, and any
use of real victim data or third-party credentials.

Not assessed: production hosting, TLS termination, network perimeter, OS hardening, physical and
organizational controls. ThreatNeXus is a research prototype with no production deployment; there
is no production configuration to review.

## 2. Environment

A throwaway Docker stack built from the branch under test, on non-default ports
(PostgreSQL 15432, API 5300, web 5273), compose project `tnxsec`. `JWT_SECRET` was generated per
run. **Every provider credential was empty**, `IOC_ENRICHMENT_PROVIDER=mock`, `AI_ENABLED=false`,
`ENRICHMENT_WORKER_ENABLED=false`, `AUTO_ENRICHMENT_ENABLED=false` — verified inside the running
container, so no live provider contact was possible at any point. Data was the project's own
synthetic seed (4 role accounts, 11 findings, 3 cases, 1 notification). The stack was destroyed
after the assessment; the port override lived in a session scratchpad and was never committed.

## 3. Methodology

`recon → hypothesis set → read-only source audit → dynamic negative testing → manual verification
of every candidate → bounded remediation → targeted re-test → regression`.

Eleven hypotheses were chosen from the actual architecture rather than from a generic checklist.
One architectural fact reshaped the plan: **`User` carries no `organizationId`**. Organizations are
*constituents* (the notified parties), not tenants. ThreatNeXus is single-tenant, so cross-tenant
IDOR/BOLA is not a meaningful class here; effort went to **vertical** authorization, workflow
integrity, and the provider boundary instead.

**Scanner output alone was never treated as a finding.** Every issue below was reproduced by hand
against the running stack.

## 4. Tools and capabilities actually used

| Tool | Why it was chosen | What it produced |
|---|---|---|
| Manual source review | The authorization model is expressed in code comments and a capability table; no scanner reads intent | SEC-01, SEC-02, SEC-03 root causes |
| `curl` negative matrix (hand-built) | The question "may this role do this?" needs role-aware requests, which generic scanners do not construct | 23 negative probes across 4 roles + unauthenticated |
| Express router introspection (custom, read-only) | Independently re-derives the guard on every mounted route rather than trusting the project's own census test | 99 routes enumerated with their guards |
| `npm audit` (`--package-lock-only`, and `--omit=dev`) | Distinguishes runtime-reachable advisories from build-time-only ones | SEC-05 |
| Hand-built JWT forgery set (Python) | `alg:none`, wrong-key, expired, tampered-payload cannot be tested any other way | No finding — all rejected |
| Bounded hostile-CSV corpus (10 files) | Ingestion is the only untrusted-file path in the system | No finding — all controlled refusals |
| Chromium via the in-app browser | Confirms the header/CSP change does not break the real SPA, and proves framing is refused | SEC-02 remediation proof |
| `docker exec` / `psql` | Corroborates API responses against stored state instead of reading the screen | Provider and audit evidence |

**Deliberately not used.** No DAST scanner (ZAP/Nikto/Nuclei) was run: the surface is a JSON API
behind a bearer token with 99 enumerated routes, where a crawler adds noise rather than coverage,
and its findings would still have needed the manual verification performed here. No SAST engine was
added: the codebase has no raw SQL, no `eval`, no `child_process`, and no `dangerouslySetInnerHTML`
(each verified by search), which is most of what a generic JS SAST rule set looks for. Adding tools
to lengthen the tool list would not have improved evidence for this stack.

## 5. Findings

Severity: **P0** critical · **P1** must fix before delivery · **P2** meaningful hardening ·
**P3** advisory.

| ID | Severity | Surface | Status |
|---|---|---|---|
| SEC-01 | **P0** | `POST /api/auth/register` | **Fixed** |
| SEC-02 | **P1** | `frontend/nginx.conf` | **Fixed** |
| SEC-03 | **P2** | `lib/validation.js` → every entity-by-id route | **Fixed** |
| SEC-04 | P3 | `X-Powered-By` response header | Deferred |
| SEC-05 | P3 | `backend/package.json` dependency placement | Deferred |

---

### SEC-01 — Anonymous self-registration exposes all constituent data · P0 · CONFIRMED

**Surface.** `POST /api/auth/register` (unauthenticated), composed with the `VIEWER` capability set.

**Reproduction.**
```
POST /api/auth/register  {"name":"Outside Attacker","email":"attacker@evil.example","password":"..."}
POST /api/auth/login     {"email":"attacker@evil.example","password":"..."}
GET  /api/findings       Authorization: Bearer <token>
```

**Observed.** Account created (`201`, role `VIEWER`), login succeeded, and the account then read
**11/11 findings** — victim IPv4 addresses, ports, protocols, risk scores, triage decisions and
ownership attribution naming real constituent organizations ("Northport Water Authority",
"Meridian Health Trust", "Cedarline Telecom") — plus **all 3 cases** (including the assigned
analyst's email address) and the operational dashboard. Two unauthenticated requests, no user
interaction, no prior access.

**Impact.** Unauthorized disclosure of the exact asset `docs/ai/SECURITY.md` names first
("constituent exposure evidence, analyst decisions"), to any party who can reach the API. Case
records additionally disclose analyst email addresses, aiding credential attacks against the
platform itself.

**Likelihood.** Very high. Trivial, scriptable, requires no privilege.

**Root cause — two individually correct decisions.** `VIEWER` holds `read:dashboard`,
`read:findings` and `read:cases` because read-only oversight is a stated requirement; that is right
for an account the organization issued. Registration is unauthenticated because it cannot demand a
credential the caller lacks; that is right too. Neither is wrong alone. Together they made an
account anybody could mint carry organizational read authority. Notably, **the frontend never calls
this route** — there is no registration UI and `frontend/src/services/api.js` has no register
call — so the endpoint was unreachable through the product and reachable only directly.

**Remediation (applied).** `ALLOW_PUBLIC_REGISTRATION`, default **false in every environment,
tests included**. When closed the route answers `403` with a fixed message that does not name the
switch, and records an audited `auth.register` / `DENIED` event. The check runs **before** any
field parsing, user lookup or bcrypt work, so the closed door is neither an email-existence oracle
nor a way to make the server do work. The route stays mounted (the census exception stays true) and
reopening it is a deliberate operator act. Accounts are provisioned by `npm run seed:users`.

---

### SEC-02 — Every HTML document and asset served without security headers · P1 · CONFIRMED

**Surface.** `frontend/nginx.conf`, affecting every response the web tier serves.

**Root cause.** nginx does not merge `add_header` down a level: the directives are inherited *only
if the current level defines none of its own*. The file declared `X-Content-Type-Options`,
`X-Frame-Options` and `Referrer-Policy` at `server` level, then declared a `Cache-Control`
`add_header` inside both `location /assets/` and `location = /index.html` — so each of those blocks
silently discarded all three. Because `location /` serves the SPA via
`try_files $uri $uri/ /index.html`, and `try_files`' last argument is an *internal redirect*, the
request re-enters location matching and lands on `location = /index.html`. Every HTML document the
application ever served went through the one block that dropped the headers.

**Reproduction / observed (before).**
```
$ curl -sI http://localhost:5273/            # also /index.html, /findings, any client route
HTTP/1.1 200 OK
Cache-Control: no-store
        ← no X-Frame-Options, no X-Content-Type-Options, no Referrer-Policy
```
Hashed assets were equally bare, and carried a duplicated `Cache-Control` (from `expires` *and*
`add_header`). No `Content-Security-Policy` existed anywhere.

**Impact.** The analyst console was framable by any origin. ThreatNeXus sessions are bearer tokens
in `localStorage`, which a same-origin frame retains, so a framed console is a live console — and
the actions one click away include approving a case closure, approving a constituent notification,
and triggering provider spend. Secondarily: MIME sniffing on assets, and full-URL referrer leakage
to any external destination.

**Likelihood.** Medium. Clickjacking needs a targeted lure delivered to a signed-in analyst, but
needs nothing else — no XSS, no network position, no credential.

**Remediation (applied).** The cache policy became a `map` on `$uri`, which removes the competing
`add_header` levels entirely, leaving the `server` block as the **only** `add_header` level in the
file — so no future `location` can silently shadow a header again. A CSP was added with
`frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`. `default-src`,
`script-src` and `connect-src` were deliberately **omitted**: the API origin is chosen at build time
(`VITE_API_BASE_URL`) and is normally cross-origin, so a `connect-src` would have to be generated
per deployment, and a CSP that breaks a deployment gets switched off rather than fixed. The four
directives shipped need no deployment knowledge and break nothing.

---

### SEC-03 — Out-of-range resource ids return 500 on every entity-by-id route · P2 · CONFIRMED

**Surface.** `parseResourceId` in `backend/src/lib/validation.js` (19 calling modules) and a
duplicate local `parseId` in `controllers/findingReadController.js`.

**Root cause.** Both bounded ids with `Number.isSafeInteger` (max 2^53−1). Every id column in
`schema.prisma` is a Prisma `Int`, i.e. PostgreSQL `int4` (max 2^31−1). The validator therefore
asked "does JavaScript hold this exactly?" when the question was "can this be an id in this
database?". Every value in (2^31−1, 2^53−1] passed validation, reached Prisma, and was refused
there as an unhandled `PrismaClientUnknownRequestError`.

**Reproduction / observed (before).** `GET /api/findings/2147483648` → `500`, while the adjacent
`GET /api/findings/2147483647` → `404`. Confirmed on **13 routes**: findings, cases, notifications,
organizations and their sub-resources (`/triage`, `/risk`, `/ownership`, `/enrichments`,
`/vulnerabilities`, `/enrichment/summary`, `/workflow`, `/framework-mappings`, `/history`).

**Impact.** No data disclosure — the response body is the generic `"An unexpected error occurred."`
with no stack. The cost is server-side: each request writes a large Prisma error object, including
the full generated query, to the log. Any authenticated caller (the least-privileged `VIEWER`
suffices) can generate these cheaply, producing log growth and review noise. It also breaks the
project's own stated invariant that a malformed input is answered with a named 400.

**Likelihood.** Low as an attack, high as an accident — a client that computes an id badly hits it.

**Remediation (applied).** `MAX_RESOURCE_ID = 2147483647` now bounds `parseResourceId`, fixing all
19 call sites at the root. The duplicate parser in `findingReadController.js` was **deleted** rather
than patched — a second implementation of "is this a valid id?" is precisely how one of them ends up
missing a bound the other has, which is what happened.

---

### SEC-04 — `X-Powered-By: Express` disclosed · P3 · CONFIRMED · **Deferred**

Every API response advertises the framework. Minor reconnaissance value; no exploitability on its
own. One line (`app.disable("x-powered-by")`) would remove it. Deferred deliberately: this pass is
bounded to P0/P1 plus the single highest-value P2, and expanding it to cosmetic P3s is how a bounded
pass becomes another engineering phase. Recommended for the next routine change to `app.js`.

### SEC-05 — `prisma` CLI declared as a runtime dependency · P3 · CONFIRMED · **Deferred**

`npm audit --omit=dev` reports 3 high advisories (`deepmerge-ts` → `@prisma/config` → `prisma`) in
the backend's *production* tree. **None is runtime-reachable**: the server loads `@prisma/client`,
never the `prisma` CLI, which is used only for `migrate`/`generate`. The advisory is a manifest
placement issue, not an exposure. Moving `prisma` to `devDependencies` would clear it, but the
Docker image runs `npx prisma migrate deploy` at start, so the move needs its own verification of
the container start path — out of scope for a bounded security pass. Frontend production
dependencies: **0 vulnerabilities**. Remaining backend advisories (`brace-expansion`, `nanoid`,
`postcss`) are build-time only.

---

## 6. What was tested and found sound

These are recorded because "no finding" is only meaningful when the test is named.

- **Vertical authorization.** 23 negative probes across `VIEWER`, `REVIEWER`, `ANALYST`, a
  self-registered account, and unauthenticated. Every one refused correctly (`401`/`403`); positive
  controls returned `200`. No privilege escalation, no capability bypass, no frontend-only control.
- **Route guard coverage.** Independent introspection of the live router: **99 mounted routes**,
  exactly **3** without authentication (`GET /`, login, register) and exactly **1** authenticated
  but capability-free (`GET /api/profile`) — matching the documented exception lists exactly.
- **Privilege assignment.** `role` supplied in a registration body is ignored; the column default
  and the controller both force the least-privileged role.
- **Token handling.** `alg:none` (with and without a trailing signature), wrong-key HS256, expired,
  and a payload tampered to `role: ADMIN` on an otherwise valid token — all rejected with an
  identical generic `401`. No algorithm confusion.
- **Login.** Uniform message and status for unknown vs. wrong-password, with a constant-time dummy
  bcrypt comparison — no user-enumeration oracle.
- **Injection.** No raw SQL, no `eval`/`Function`, no `child_process`, no
  `dangerouslySetInnerHTML` anywhere. SQL/traversal/NUL payloads in path and query parameters
  produced controlled `400`s. Prototype-pollution and mass-assignment bodies (`__proto__`,
  `constructor.prototype`, forged `id`/`caseReference`/`lifecycleState`) were rejected by the
  `pickDefined` allowlist.
- **Ingestion (10 hostile CSVs).** CSV formula injection, XSS payloads, out-of-range port,
  20 000-character field, NUL byte, wrong schema, header-only, binary/invalid UTF-8, non-CSV
  extension, and a `../../../../tmp/pwned.csv` upload filename. Each produced a distinct controlled
  reason code; nothing was written outside the upload directory, and the staging directory was empty
  afterwards.
- **Pagination.** `pageSize` is bounded at 100 and *rejects* rather than silently clamps.
- **Rate limiting.** Proven live: the upload bucket refused at 20/15 min with `429`,
  `RateLimit-Limit/Remaining` and an actionable `Retry-After`. Refused registrations also consume
  the credential budget.
- **CORS.** A disallowed `Origin` receives no `Access-Control-Allow-Origin`. Authentication is a
  bearer token, not a cookie, so CORS is not a credential boundary and CSRF does not apply.
- **Error serialization.** 500s return a fixed message with a correlation id; no stack, no Prisma
  text, no query fragment reaches the client. The reflected `X-Request-Id` is pattern-restricted,
  so it cannot carry CRLF.
- **Notification `.eml` export.** Header injection is refused at both write time and build time,
  and the builder *throws* rather than sanitizing. There is no SMTP client anywhere in the tree.
- **Secrets.** No `.env` or key material tracked in Git. The served bundle contains no
  secret-shaped value (only provider display names and form labels). No password, token or bearer
  value appeared in server logs; 0 of 141 audit rows contained a secret-shaped value.
- **Provider boundary.** With no credentials configured, `force: true` did **not** bypass any
  control — AbuseIPDB stayed queued (`ALREADY_PENDING`) and GreyNoise returned
  `SKIPPED_DISABLED` / `ENRICHMENT_DISABLED`. The usage ledger truthfully reported
  `executionState: PAUSED_WORKER_DISABLED`. **No live provider was contacted at any point.**

## 7. Fixes applied

| File | Change |
|---|---|
| `backend/src/config/env.js` | `ALLOW_PUBLIC_REGISTRATION`, default false everywhere |
| `backend/src/controllers/authController.js` | Audited `403` refusal before any lookup or hashing |
| `backend/src/lib/validation.js` | `MAX_RESOURCE_ID` bound on `parseResourceId` |
| `backend/src/controllers/findingReadController.js` | Duplicate id parser deleted; delegates to the shared one |
| `frontend/nginx.conf` | Cache policy via `map`; single `add_header` level; CSP added |
| `backend/.env.example`, `docker-compose.yml` | New switch documented, safe default |
| `backend/tests/integration/publicRegistrationClosed.test.js` | New — 9 tests |
| `backend/tests/unit/resourceIdBounds.test.js` | New — 6 tests |
| `backend/tests/integration/auth.test.js` | Opens registration explicitly for its own cases |
| `docs/ai/SECURITY.md` | Correction recorded against the prior claim |

## 8. Validation

**Targeted re-test (post-fix, same stack).**
- SEC-01: anonymous registration → `403`; the never-created account cannot log in (`401`).
- SEC-02: `/`, `/index.html`, `/findings`, `/cases/1` and the hashed asset all carry
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and the CSP; cache policy still
  correct (`no-store` for documents, `immutable` for assets) and no longer duplicated. Framing the
  console is now refused by the browser: *"Framing 'http://localhost:5273/' violates the following
  Content Security Policy directive: frame-ancestors 'none'."*
- SEC-03: all 13 previously-500 routes now `400`. Controls intact — `2147483647` still `404`, real
  records still `200`.
- Signed in as `ANALYST` through the containerised UI: dashboard and Findings render live
  cross-origin API data with **zero console errors**, so the CSP breaks nothing.

**Regression.** Backend `npm test` — **3417 passed, 240 skipped, 0 failed**. Frontend lint clean
(6 pre-existing fast-refresh warnings, none in changed files); production build clean.

## 9. Residual risk

- **Existing self-registered accounts survive.** Closing registration is not retroactive. Any
  account created while it was open remains valid. Operators should audit the `User` table and the
  `auth.register` audit trail before relying on the fix.
- **No CSP `script-src`/`connect-src`.** XSS mitigation therefore rests on React's escaping and the
  absence of HTML sinks (verified) rather than on the CSP. A per-deployment CSP that pins the API
  origin would be stronger.
- **The rate limiter is in-process.** Correct for a single-process prototype; a scaled deployment
  needs a shared store.
- **Sessions are bearer tokens in `localStorage` with a 24 h default lifetime**, readable by any
  script that achieves execution, with no server-side revocation. This is a design property of the
  system, not a defect introduced or fixed here.
- **SEC-04 and SEC-05 remain open** by deliberate decision (§5).
- Legacy synchronous provider routes remain outside the Phase-10 usage ledger
  (`excludedPaths`), so an attempt-row count is not by itself a no-contact proof. The no-contact
  claim here rests on every credential being empty, which was verified in the container.

## 10. Testing limitations

This assessment is **time-boxed, single-pass, and bounded**. Specifically:

- One reviewer, one pass, no second audit cycle and no independent adversarial re-test of these
  findings by a different provider.
- Automated DAST and SAST were consciously not run (§4). Their absence is a coverage limitation as
  well as a deliberate choice.
- Testing was non-destructive by instruction: no resource-exhaustion, no concurrency/race
  exploitation, no fuzzing beyond the bounded corpus described.
- **No live provider integration was exercised**, so provider *response* handling was verified only
  against deterministic fixtures and the default-off controls, never against a real provider.
- Only the local Docker configuration was assessed. There is no production deployment, TLS
  configuration, or hosting environment in scope.
- Cryptographic primitives (bcrypt, `jsonwebtoken`) were tested behaviourally, not audited.
- Absence of a finding in this report is **not** proof of absence of a vulnerability.
