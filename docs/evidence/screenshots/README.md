# Superseded — see docs/assets/screenshots/final/

**Superseded by:** [`docs/assets/screenshots/final/`](../../assets/screenshots/final/)
**Date:** 2026-08-19
**Source commit (consolidation):** `fbffbe325e94969d459b690cee4bf46414f970ed`
**Original content authored at:** `2612cbcb5691b4d5348920ff239c5e7de75acea4`

This directory held four screenshots captured on the `docs/final-demo-evidence` branch. The
`docs/assets/screenshots/final/` library (41 files, `docs/final-evidence-prep` branch) is the
canonical screenshot set for the final documentation: broader coverage (master, playbook and
supporting captures across every role), a fuller capture-conditions record, and produced from the
final frontend build.

- `01-dashboard.png` and `02-findings.png` were fully redundant with that library's dashboard and
  findings captures and were removed. No unique evidence was lost — compare
  `master-dashboard-analyst.png`, `playbook-02-dashboard.png`, `playbook-03-findings-filters.png`
  and `supporting-findings-fullpage.png`.
- `03-finding-detail-decision-first.png` and `04-enrichment-coverage-before-request.png` proved a
  fact the other library did not capture — the specific pre-request enrichment state of the primary
  demonstration Finding. They were moved, pixels unaltered, to
  `docs/assets/screenshots/final/demo-readiness-finding-a-decision-first.png` and
  `docs/assets/screenshots/final/demo-readiness-enrichment-before-request.png`, and documented under
  "Demo-readiness supporting captures" in that directory's `README.md`.

Do not add files to this directory further. The full original directory remains in Git history at
commit `2612cbc` for archaeology.
