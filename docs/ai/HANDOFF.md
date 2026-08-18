# Handoff: TNX-FINAL-SECURITY-PASS

- From: claude
- Suggested next writer: **codex** — independent review only, then the merge decision
- Branch: `security/final-bounded-hardening` (from `origin/main` @ `90bdb8b`)
- Worktree: `F:\AI-Worktrees\ThreatNeXus\final-security` (isolated — the primary checkout was never touched)
- Writer lock: **released**
- Updated: 2026-08-18
- Status: **review** — remediation applied and re-tested, awaiting independent review.

This was the single bounded authorized security pass — approved optional activity **(A)** from the
functional-closure record. **It is finished. Do not run a second audit cycle.**

> Note for any future writer: `handoff-task.ps1` overwrites this file with a five-line template on
> every run. If you run it, restore the detail below from the prior commit afterwards.

---

## What was found

Full report with reproductions, evidence and reasoning:
**`docs/security/FINAL-SECURITY-ASSESSMENT.md`**.

| ID | Sev | Summary | Status |
|---|---|---|---|
| SEC-01 | **P0** | Anonymous self-registration → full read of all constituent exposure data | **Fixed** |
| SEC-02 | **P1** | Every HTML document and asset served with no security headers (nginx `add_header` inheritance) | **Fixed** |
| SEC-03 | **P2** | Out-of-range resource ids → 500 on 13 entity-by-id routes | **Fixed** |
| SEC-04 | P3 | `X-Powered-By: Express` | Deferred, deliberate |
| SEC-05 | P3 | `prisma` CLI in runtime `dependencies` (advisories not runtime-reachable) | Deferred, deliberate |

**No authorization bypass was found.** 23 negative probes across four roles plus unauthenticated all
refused correctly, and independent introspection of the live router confirmed 99 mounted routes with
exactly the 3 unauthenticated and 1 capability-free exceptions the documentation already claimed.
The forged-JWT set, the hostile-CSV corpus, the injection battery and the provider-boundary probes
all came back clean. Those negatives are listed in §6 of the report so they are auditable rather
than merely implied.

## The three fixes, and why they are shaped this way

**SEC-01.** Two individually correct decisions composed into a critical one: registration is
unauthenticated because it must be, and `VIEWER` reads findings and cases because read-only
oversight is a stated requirement. The fix touches neither — it closes the *provisioning* path.
`ALLOW_PUBLIC_REGISTRATION` defaults **false in every environment, tests included**, because a
control whose default differs between test and production is a control no test observes. The route
stays mounted (so the census exception stays truthful), and the refusal happens *before* any field
parsing, user lookup or bcrypt work, so a closed door is not an email-existence oracle either.

**SEC-02.** nginx inherits `add_header` **only if the current level declares none of its own**.
Rather than repeat the headers in each `location` — which is the same drift that caused the bug —
the cache policy became a `map` on `$uri`, leaving the `server` block as the file's only
`add_header` level. No future `location` can silently shadow a header again. The CSP deliberately
omits `default-src`/`script-src`/`connect-src`: the API origin is a build-time value and normally
cross-origin, so those directives would have to be generated per deployment, and a CSP that breaks a
deployment gets switched off rather than fixed.

**SEC-03.** The bound was fixed in the shared `parseResourceId` (19 calling modules) and the
duplicate parser in `findingReadController.js` was **deleted** rather than patched — a second
implementation of "is this a valid id?" is exactly how one ends up missing a bound the other has.

## Evidence

- Backend `npm test`: **3417 passed / 240 skipped / 0 failed**
- New: `publicRegistrationClosed.test.js` 9/9, `resourceIdBounds.test.js` 6/6
- `auth.test.js`, `phase7RateLimiting.test.js`, `phase7RouteCensus.test.js` still green
- Frontend lint clean (6 pre-existing warnings, none in changed files); production build clean
- Targeted re-test: registration `403`; all 13 previously-500 routes `400` with `404`/`200` controls
  intact; all four headers present on every document class and on the hashed asset
- Real browser: framing refused (*"violates … frame-ancestors 'none'"*), and an `ANALYST` signed in
  through the containerised UI with the dashboard and Findings rendering live cross-origin data and
  **zero console errors** — so the CSP breaks nothing

**No live provider was contacted at any point.** Every provider credential was empty in the running
container, `IOC_ENRICHMENT_PROVIDER=mock`, `AI_ENABLED=false`, worker disabled — verified inside the
container, not assumed. No destructive testing, no third-party host touched.

## What the reviewer should look at hardest

1. **`ALLOW_PUBLIC_REGISTRATION` default-false is a behaviour change to a shipped endpoint.** It is
   the intended fix, but confirm nothing in the demo runbook, CI or the evaluators depends on open
   registration. Nothing found does: the frontend has no registration UI and `api.js` has no
   register call.
2. **The nginx `map` rewrite** — confirm the cache policy is genuinely equivalent for assets
   (`immutable` preserved) and documents (`no-store` preserved), and that the `map` sits in `http`
   context correctly. `nginx -t` passes and the served headers were measured, but this is the change
   with the least automated coverage: no test asserts response headers.
3. **Residual risk §9 of the report** — in particular that closing registration is *not*
   retroactive. If a deployed instance ever had it open, the `User` table needs an audit.

## Next action

Independent review by a provider other than the author, then the merge decision. **No second
pentest cycle.** The remaining approved optional activities are **(B)** the deep rendered
page-by-page frontend/UI-UX audit and **(C)** final documentation/diagram/demo-data finalization —
each to be started only on separate explicit authorization, one at a time.
