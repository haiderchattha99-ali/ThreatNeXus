# Screenshot Plan

**No screenshots were captured this phase.** Docker was not running in this environment (the daemon
was unreachable and Docker Desktop was not found at its standard install path), so no local stack could
be brought up to capture from — starting a debug session to force one up was out of scope for this
documentation-only phase per instruction. Every slot below is a placeholder with exact capture
instructions; capture them the next time the stack is run and drop the files in
`docs/presentation/assets/` at the paths given.

## How to capture

1. Bring up the stack and seed it: `docs/DEPLOYMENT.md` → "Starting the stack" and "Seed data and demo
   mode."
2. Use a desktop browser window at **1440×900**, light OS chrome hidden if possible (full-page browser
   screenshot, not a cropped element).
3. Sign in with the role each slot specifies.
4. Save as PNG (not JPEG — the dashboard and tables have small text that compresses poorly) to
   `docs/presentation/assets/<id>-<name>.png` using the exact filename given below.
5. Once captured, update `ThreatNeXus-PKCERT-Deck.md` / the `.pptx` to embed the image in place of the
   placeholder box, and update `README.md`'s visual-tour section to link it.

## Slots

| ID | Screen | Role | Filename | Used in |
|---|---|---|---|---|
| **P-01** | Dashboard / operations overview, full page, scrolled to show at least the provider-freshness and framework panels | Analyst | `p01-dashboard-overview.png` | Deck Slide 4/13, README visual tour |
| **P-02** | Findings list, with the filter bar visible | Analyst | `p02-findings-list.png` | README visual tour |
| **P-03** | Finding detail page, scrolled to show the Risk v1 explanation table with all three applicability states visible if the seeded data has them | Analyst | `p03-finding-detail-risk.png` | Deck Slide 8/13, README visual tour |
| **P-04** | Finding detail, provider-evidence panel section (whichever provider has a result, live or `NOT_CONFIGURED`) | Analyst | `p04-provider-evidence.png` | Deck Slide 7 |
| **P-05** | Settings page, full provider status matrix (all six providers' configured/not-configured state) | Admin | `p05-provider-matrix.png` | Deck Slide 7, README visual tour |
| **P-06** | Finding detail, AI assistance panel — capture BOTH the disabled state (default) and, if AI is enabled in that session, a populated draft with its status badge | Analyst / Reviewer | `p06-ai-panel-disabled.png`, `p06-ai-panel-draft.png` | Deck Slide 9 |
| **P-07** | Framework mapping workspace on a case, showing an ATT&CK mapping attempt refused server-side (the validation error message visible) | Analyst | `p07-attack-refusal.png` | Deck Slide 10 |
| **P-08** | GitHub Actions run page for a green `ci.yml` run, all jobs visible and passed | — (browser, not the app) | `p08-ci-green.png` | Deck Slide 14, README visual tour |
| **P-09** | The architecture diagram from `docs/ARCHITECTURE.md`, rendered (GitHub renders the Mermaid block automatically — screenshot that rendered view, or export via a Mermaid CLI/live-editor for a cleaner crop) | — | `p09-architecture-diagram.png` | Deck Slide 12 |

## Notes

- **P-06 is two files deliberately** — the disabled state is the one that will actually appear in most
  real demos (AI is off by default), and it needs to be shown as a legitimate, honest state, not skipped
  in favor of only the more visually interesting populated-draft version.
- **P-08 does not require the local stack** — it can be captured any time by opening the latest green
  run at `https://github.com/haiderchattha99-ali/ThreatNeXus/actions/workflows/ci.yml`.
- **P-09 does not require the local stack either** — it can be captured directly from
  `docs/ARCHITECTURE.md` on GitHub, which renders the embedded Mermaid diagram automatically.
- None of these screenshots should ever show a real provider API key, a real JWT, or any browser
  extension/bookmark bar revealing unrelated personal information — crop or use a clean browser profile.
- Do not stage a screenshot showing a state the running code cannot actually produce (e.g., don't
  hand-edit the DOM to fake a populated AI draft if AI is disabled) — every image here must be a real
  capture of real running behavior.
