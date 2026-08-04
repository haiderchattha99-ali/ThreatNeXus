# ThreatNeXus — frontend

The analyst-facing React application for ThreatNeXus, a defensive
cyber-threat-intelligence orchestration and incident-response **research
prototype** built for PKCERT. It is not a deployed product; see `/STATUS.md` for
the current state and the documented gaps.

Authoritative context lives at the repository root: `/README.md`, `/STATUS.md`,
`/AGENTS.md`. The superseded pre-Phase-0 scaffold documentation is archived under
`docs/archive/` and should not be trusted — see the notice in that folder.

## Stack

React 19 · Vite 8 (rolldown/oxc) · MUI v9 · React Router 7 · Axios · GSAP.

No charting library. Every chart on screen is hand-built SVG or CSS over the one
snapshot the backend returns, which is why chart.js, react-chartjs-2, leaflet and
react-leaflet were removed in Phase 6 and have not come back.

## Running it

The frontend needs the backend (default `http://localhost:5000/api`, overridable
with `VITE_API_BASE_URL`) and a PostgreSQL database with migrations applied.

```bash
npm install
npm run dev          # dev server
npm run build        # production build
npm run preview      # serve the production build
```

| Command | What it gates |
|---|---|
| `npm run lint` | oxlint |
| `npm test` | Vitest unit/component suite (jsdom) |
| `npm run test:e2e` | Playwright browser suite, Chromium only |

## The browser suite

`e2e/` drives the real stack — real backend, real PostgreSQL, real REST routes,
real JWTs. Nothing is stubbed, deliberately: a mocked end-to-end suite would have
passed against the fabricated dashboard Phase 6 had to delete.

It requires accounts seeded by `backend/src/scripts/seedUsers.js` and takes their
password from the environment. There is no default and no committed literal:

```bash
E2E_PASSWORD='<the-password-you-seeded-with>' npm run test:e2e
```

Set `E2E_SKIP_WEBSERVER=1` if a preview server is already running, and
`E2E_BASE_URL` to point at something other than `http://127.0.0.1:4173`. The
backend must allow the suite's origin via `CORS_ORIGIN`.

## Two rules this UI is built around

**Unknown is never zero.** Every figure arrives as
`{ value, availability, source, asOf }`. A section the role may not read renders
as `RESTRICTED` with a reason; one whose query failed renders as `UNAVAILABLE`.
Both show an em dash. Neither is ever allowed to look like a counted zero, and a
counted zero is never allowed to look like missing data.

**Motion never sits between an analyst and a decision.** Nothing operational is
hidden behind a hover, a drawer or a transition; no content waits on a scroll
trigger to become visible; and with `prefers-reduced-motion` set — or the in-app
preference in Settings — no animation timeline is constructed at all and the
final state renders immediately.

## Layout

```
src/
  components/
    dashboard/   dashboard sections and their presentation model
    ui/          the design-system primitives — pages import from here and nowhere else
  constants/     role and workflow vocabularies mirrored from the backend
  context/       auth context (UX only; the server is the boundary)
  hooks/         useAuth, useReducedMotion
  pages/         one file per route
  services/      the configured axios client
  theme/         design tokens, and the MUI theme built on them
e2e/             Playwright browser suite
```

Frontend permission checks are **presentation only**. Every route enforces its
own capability check server-side; hiding a control here never grants or denies
anything.
