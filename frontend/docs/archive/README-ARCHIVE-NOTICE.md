# Archived — superseded scaffold documentation. Do not trust anything in this folder.

Every file in this directory was written for the **pre-Phase-0 scaffold** of the
ThreatNeXus frontend. They are kept for provenance only. They describe a product
that no longer exists, and several of their claims were never true.

**Nothing here is authoritative. Do not use these files to understand, run, test
or evaluate the current application.**

## What is authoritative instead

| For | Read |
|---|---|
| What the system is and its current status | `/README.md`, `/STATUS.md` |
| Working rules and invariants | `/AGENTS.md`, `/CLAUDE.md` |
| The API contract | `/docs/API_CONTRACT_PHASE0.md` and the route files under `backend/src/routes/` |
| Running the demo | `/docs/DEMO_RUNBOOK.md` |
| Frontend overview | `frontend/README.md` |

## Specifically wrong, and why it matters

These are not stylistic quibbles. Each one would mislead a reader into a false
statement about the product.

- **"Complete, production-ready"** / **"COMPLETE AND PRODUCTION-READY"**
  (`DELIVERABLES.md`, `PROJECT_SUMMARY.md`). This is a graded research prototype
  built for a PKCERT presentation. It has never been deployed, never held real
  constituent data, and carries documented gaps in `/STATUS.md`.

- **Committed credential literals.** `API_INTEGRATION.md` contains
  `ali@example.com` / `password123` in several request examples. No account with
  those details exists. Local accounts are created by `backend/src/scripts/seedUsers.js`,
  which takes its password from `SEED_USER_PASSWORD` and never prints or defaults
  it.

- **`/api/threats` endpoints** (`API_INTEGRATION.md`). These describe the legacy
  `Threat` table, which is *not* the deduplicated `Finding` lifecycle the product
  actually reasons about. The frontend no longer calls them.

- **"Charts: Recharts"** / **"Recharts 3.9.2"**. Recharts is not a dependency and
  never was in the shipped tree. Phase 6 removed chart.js, react-chartjs-2,
  leaflet and react-leaflet; the current charts are hand-built SVG and CSS over
  the one provenance-carrying snapshot.

- **"Real-time statistics"**, **"Live data syncing"**, **"Real-time Updates"**.
  There is no websocket, no polling and no live feed. The dashboard renders one
  bounded read-only snapshot, on demand, and every figure on it carries the
  instant it was evaluated at.

- **The old dashboard itself.** The screens these documents describe — a threat
  map, a live threat feed, an ATT&CK coverage percentage, per-country attack
  statistics, service-latency figures — were removed in Phase 6 because none of
  them came from the database. See the header comment in
  `backend/src/services/dashboard/operationalOverviewService.js`.
