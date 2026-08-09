# Admin Guide

Administration facts for ThreatNeXus: roles and capabilities, provider configuration, key handling,
audit logs, rate limits, demo seeding, and the honest current limitations of admin functionality.

## User and organization management — current status

**There is no in-app user-management UI or endpoint.** Accounts are created only two ways:

1. `npm run seed:users` — creates exactly four fixed local accounts (`admin@threatnexus.local`,
   `analyst@threatnexus.local`, `reviewer@threatnexus.local`, `viewer@threatnexus.local`), touches no
   other row, and refuses to run against `NODE_ENV=production` without an explicit, deliberately
   awkward override (`SEED_USERS_FORCE_PRODUCTION_I_UNDERSTAND_THE_RISK`).
2. Public self-registration (`POST /api/auth/register`) — always creates a `VIEWER`, regardless of what
   role the request body asks for. There is no endpoint to promote a user to a higher role; that
   requires a direct database change.

`manage:users` is a declared capability, held by ADMIN, but **no route in this codebase currently
consumes it** — it exists in `roles.js` for a future user-management surface that has not been built.
Similarly, `Organization` records exist and are manageable (`/api/organizations`, ADMIN only) — but they
are used by the ownership-resolution engine and the case/notification workflow, not by any user-org
membership model; ThreatNeXus does not currently have the concept of "which organization a user belongs
to" for access-control purposes.

**This is a real gap, stated plainly**: if you need to onboard a new operator today, you edit the
database or add them to the seed script. There is no self-service or admin-console path.

## Roles and capabilities

Four roles, **not ranked as a hierarchy** — capabilities are explicit grants per role, so no role
accidentally inherits another's authority. ADMIN holds every capability; the other three hold disjoint,
purpose-built sets.

| Capability | ADMIN | ANALYST | REVIEWER | VIEWER |
|---|:-:|:-:|:-:|:-:|
| Read dashboard / findings / cases | ✅ | ✅ | ✅ | ✅ |
| Ingest reports (upload) | ✅ | ✅ | ❌ | ❌ |
| Triage findings | ✅ | ✅ | ❌ | ❌ |
| Manage cases (create/evidence/reopen) | ✅ | ✅ | ❌ | ❌ |
| Override finding ownership | ✅ | ✅ | ❌ | ❌ |
| Trigger provider enrichment (any of the 6 providers) | ✅ | ✅ | ❌ | ❌ |
| Recalculate finding risk | ✅ | ✅ | ❌ | ❌ |
| Manage/trigger vulnerability (CVE) association | ✅ | ✅ | ❌ | ❌ |
| Read notifications | ✅ | ✅ | ✅ | ❌ |
| Draft/manage notifications | ✅ | ✅ | ❌ | ❌ |
| Export notifications | ✅ | ✅ | ❌ | ❌ |
| Record notification delivery | ✅ | ✅ | ❌ | ❌ |
| **Review case closure (approve/reject)** | ✅ | ❌ | ✅ | ❌ |
| **Review notifications (approve/reject)** | ✅ | ❌ | ✅ | ❌ |
| Manage framework mappings (ATT&CK/CSF/CIS) | ✅ | ✅ | ❌ | ❌ |
| Read AI mapping/finding suggestions | ✅ | ✅ | ✅ | ❌ |
| Request AI mapping/finding suggestions | ✅ | ✅ | ❌ | ❌ |
| **Decide AI mapping suggestions** | ✅ | ✅* | ❌ | ❌ |
| **Decide (accept/reject) Finding-level AI drafts** | ✅ | ❌ | ✅ | ❌ |
| Execute enrichment/vulnerability batch workers | ✅ | ❌ | ❌ | ❌ |
| Delete records | ✅ | ❌ | ❌ | ❌ |
| Manage users, manage system, manage organizations | ✅ | ❌ | ❌ | ❌ |
| Override self-approval (closure/notification) | ✅ | ❌ | ❌ | ❌ |

\* An analyst may decide an AI *mapping* suggestion (deliberately paired with the same authority to
write a mapping manually) but not an AI *Finding-level draft* — that decision belongs to REVIEWER,
matching the notification-approval separation of duties. This asymmetry is deliberate: see
`docs/AI_GOVERNANCE.md`.

**The load-bearing pattern across this whole table**: whoever *requests or drafts* something never also
*approves* it, except ADMIN, which holds an explicit, separate override capability
(`override:closure-self-approval`, `override:notification-self-approval`) rather than simply being
exempt from the rule by role name. This is enforced server-side on every write, not only in this table
— see `docs/ARCHITECTURE.md` → "Audit, rate-limit and auth model".

An unrecognized role in a JWT resolves to **no capabilities at all**, never to VIEWER's read-only set —
an unknown role is denied everywhere, including reads.

## Provider configuration

All six live providers (`docs/PROVIDER_GUIDE.md`) are configured entirely through environment
variables — there is no in-app provider-configuration screen, only a read-only Settings page showing
current status. To configure a provider:

1. Obtain a key from the provider (see `docs/PROVIDER_GUIDE.md` for each provider's signup URL).
2. Export it in the shell that runs `docker compose up`, or set it in your own untracked local `.env`
   (backend reads `process.env` directly — see `docs/DEPLOYMENT.md`).
3. Restart the backend. No key requires a database migration or code change.

A provider with no key is not broken — it is `NOT_CONFIGURED`/`SKIPPED_DISABLED`, a normal state every
core workflow tolerates.

## API key handling

- Every key is read from `process.env` only, once, at request time — never cached in a way that could
  leak into an error message.
- No key is ever included in a log line, an audit row, an HTTP response, or the frontend bundle — this
  is proven per provider by a dedicated redaction test, and by CI's own bundle scan
  (`docs/TESTING_AND_CI.md`).
- `backend/.env.example` is the only committed env-shaped file, and it contains placeholders only.
- **Never** paste a real key into `docker-compose.yml`, a commit, an issue, or a chat log. If a key is
  ever accidentally exposed, rotate it at the provider immediately — this application has no way to
  "un-leak" a key once it has left your shell.

## Audit logs

Every write path in this codebase calls `safeLogAuditEvent` — enforced at the service layer, not the
controller layer, so a service that forgets to audit fails a test rather than silently omitting an
entry. An audit row records actor, role, action, outcome (`SUCCESS`/`FAILURE`/`DENIED`), entity
type/id, and a small allow-listed summary — **never** a raw request body, a provider key, a raw upstream
response, or free-text/PII fields (case descriptions, notification message bodies, organization contact
details are deliberately excluded from summaries).

A failed audit write never blocks the operation it's auditing — but a denied authorization attempt is
itself always audited (`action: "authorization.denied"`), which is how "someone tried to do X without
permission" stays visible even though the 403 response body never names the missing capability to the
caller.

There is currently no in-app audit-log viewer UI — reviewing the audit trail means querying the
`AuditLog` table directly (`docker compose exec postgres psql ...`).

## Rate limits

See `docs/OPERATIONS_RUNBOOK.md` → "Rate-limit behavior" for the three buckets (auth, upload, provider
execution) and their defaults. As an administrator, you can raise any of the three via environment
variables for a specific run (e.g., a large browser-test suite) without weakening the default for normal
traffic — always prefer a scoped override over lowering a control globally.

## Demo seed

`npm run seed:users` and `npm run seed:demo` — see `docs/DEPLOYMENT.md` → "Seed data and demo mode" for
the exact commands and safety guarantees (refuses production, refuses without `DEMO_MODE=true`, never
prints the password, idempotent, never truncates). As an administrator running a demonstration, this is
the only supported way to populate realistic data — there is no "import sample data" button in the UI.

## Known admin limitations

Stated plainly, not smoothed over:

- No in-app user management (create/promote/disable an account).
- No in-app audit-log viewer.
- No token revocation — disabling or changing a user's role does not take effect until their existing
  JWT expires (up to `JWT_EXPIRES_IN`, default 24h).
- No in-app provider-key configuration screen — keys are environment-only.
- No production deployment target exists for this project (`docs/DEPLOYMENT.md`), so "admin" here means
  administering a local or demonstration Compose stack, not a live constituent-facing service.
- `manage:users` is granted to ADMIN but unrouted — reserved for a future user-management feature.
