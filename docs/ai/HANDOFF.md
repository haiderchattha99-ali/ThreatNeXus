# Handoff — TNX-P6.3 ATT&CK catalogue and evidence integrity

- From: Codex (takeover writer after Claude reached its usage limit)
- To: Claude, after this checkpoint is pushed, CI is green, and the writer lock is released
- Local branch: `review/tnx-p6-2`
- Push target: `feat/phase-6-frontend-demo-hardening`
- Starting commit: `96db6ce`
- Updated: 2026-08-05

## Delivered

Phase 6.3 is locally complete. ThreatNeXus now pins and verifies the official Enterprise ATT&CK
19.1 catalogue instead of accepting format-shaped technique IDs. Manual mappings and promoted AI
suggestions pass the same exact-reference, verbatim-evidence, evidence-source, staleness, and split-
confidence gates. Analysts may explicitly record that no ATT&CK mapping applies, with a reason and
auditable withdrawal, rather than leaving an ambiguous empty state.

The new `/attack` workspace is readable by every role holding `read:cases`. It presents the 15-tactic
matrix, search and mapping filters, raw mapping/case/finding counts, review flags, linked verbatim
evidence, explicit no-applicable determinations, and catalogue provenance. It deliberately computes
no coverage percentage because the system has no truthful denominator for what should apply.

## Pinned catalogue

- Enterprise ATT&CK: 19.1
- Upstream commit: `6c37199`
- SHA-256: `d59e40e9d114a92af2f170a0af729bcbd578f960c7b12f51b0f104305e816398`
- Tactics: 15
- Techniques: 858, including 493 sub-techniques
- Currently mappable: 697; revoked and deprecated references are excluded from new mappings

The application performs no runtime MITRE download. The committed reduced catalogue and manifest are
verified by `npm run attack:verify` and CI.

## Security and authority boundaries

- Backend capability checks remain authoritative; frontend navigation grants nothing.
- Mapping promotion calls the same manual writer and cannot bypass its gates.
- AI remains optional and disabled by default. No live AI adapter was added.
- No dashboard or navigator render performs a provider call.
- No external-provider key was read, printed, transmitted, copied, put in frontend code, or committed.
- `backend/.env` was never opened or modified.
- Risk v1, finding/case lifecycle, notification approval, export-versus-delivery, and both self-
  approval prohibitions are unchanged.

## Validation

| Gate | Result |
|---|---|
| ATT&CK integrity | PASS — v19.1, checksum exact, 15 tactics, 858 techniques, 697 mappable |
| Prisma | PASS — schema valid; 18 migrations from zero; none pending; no drift |
| Backend | PASS — 122 files / 2,984 tests against real PostgreSQL |
| Frontend | PASS — lint; 12 files / 143 tests; production build |
| Browser | PASS — Chromium 42/42 against the real stack |
| Phase 1 evaluator | PASS — 9 scenarios |
| Risk v1 evaluator | PASS — locked contract plus 19 scenarios |
| Phase 3 evaluator | PASS — 12 scenarios / 151 assertions |
| Phase 4 evaluator | PASS — 14 scenarios / 151 assertions |
| Phase 5 evaluator | PASS — 14 scenarios / 150 assertions |
| Phase 6.3 evaluator | PASS — 13 scenarios / 108 assertions |
| Live browser | PASS — all four roles at 1440, 1024, and 390 widths; zero console warnings/errors |
| CI workflow syntax | PASS locally; remote run pending push |

One parallel backend run had a shared-database lease collision (`NOT_CLAIM_OWNER`) in an unchanged
vulnerability concurrency scenario. The exact file immediately passed 19/19 alone, and the complete
suite passed 2,984/2,984 using serial file execution. No production change was made for that test-
runner contention.

## Honest limitations

- Finding closure still has no production write path, so recurrence/reopen is evaluator-proven but
  not reachable through the running UI.
- Browser automation is Chromium-only.
- The documented React Router RSC-only advisory remains unreachable in this client-only SPA.
- This phase adds no live AI provider, Censys adapter, or scheduled Shadowserver ingestion.

## Exact next action

1. Push the Phase 6.3 checkpoint to `feat/phase-6-frontend-demo-hardening`.
2. Wait for every required GitHub Actions job to pass.
3. Release the writer lock.
4. Merge accepted Phase 6 work into `main`.
5. Only then run the Phase 7 goal and execution prompts from updated `main`.

Do not begin Phase 7 in this worktree or before the Phase 6.3 CI gate is green.
