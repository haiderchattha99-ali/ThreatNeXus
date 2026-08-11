# Handoff: TNX-DEMO-INGESTION-REPAIR

- From: claude
- Suggested next writer: codex
- Branch: fix/analyst-report-ingestion-contract
- Verified code checkpoint: 45f7105603678c2dd502e6750710c6c8e7fbb730
- Updated: 2026-08-11T12:31:36.8575448Z

## Goal

Move the Analyst Report Ingestion page onto the canonical evidence-backed POST /api/reports/upload pipeline and prove end to end that an upload creates/updates real Findings, dashboard evidence and idempotent outcomes, without weakening security or changing locked data semantics.

## Completed and current state

Read Git history and the committed diff through $checkpoint. Validation recorded in STATE.yaml must be rerun by the incoming writer before new edits.

## Exact next action

Independent review of the analyst report-ingestion contract repair on fix/analyst-report-ingestion-contract (CI green, run 31491172952). Do not open or merge a PR without explicit instruction.

## Takeover instruction

Read shared memory, repository instructions, Git state, STATE.yaml, and this handoff. Verify the checkpoint and tests. Acquire writer ownership, then continue only from the exact next action.

## Protected boundaries

- Do not redo completed work without evidence.
- Do not change architecture without updating DECISIONS.md.
- Do not expose secrets or absorb unrelated changes.
