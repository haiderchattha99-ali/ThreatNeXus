# Architecture Decision Log

Use `F:\Ismail-AI-Dev-Team\handoffs\DECISION-TEMPLATE.md` for new decisions.

Product and architecture decisions for ThreatNeXus itself live in
`../../../ThreatNeXus-Planning/planning/DECISIONS.md`, which is authoritative and read-only from
this repository. This file records decisions about how the AI development team operates *on* this
repository.

| ID | Date | Status | Decision | Ticket |
|---|---|---|---|---|
| D-AI-001 | 2026-08-05 | Accepted | One-time dirty-worktree onboarding exception for the in-flight Phase 6.2 checkpoint | TNX-P6.2-FINALIZE |

---

## D-AI-001 — one-time dirty-worktree onboarding exception

**Status:** Accepted, and spent. It applies to exactly one checkpoint and cannot be reused.

### Context

The AI-team framework (`docs/ai/`, `.cursor/rules/00-ai-team.mdc`, `GEMINI.md`, and the writer-lock
protocol) was initialized *after* the Phase 6.2 work was already underway and uncommitted. The
ordinary `start-task` and `continue-task` scripts refuse a dirty worktree by design — correctly, because
a writer that inherits unattributed changes cannot say what it is responsible for. Applying that
rule literally here would have left legitimate, already-verified work stranded: it could be neither
committed under the protocol nor discarded.

Three paths were available and two were rejected:

- **Weaken or bypass the scripts.** Rejected. The dirty-worktree refusal is the only thing standing
  between "one active writer" and two agents silently overwriting each other. A guard that is
  relaxed the first time it is inconvenient is not a guard.
- **Fabricate a `WRITER_LOCK.json` by hand.** Rejected. A lock that no script issued records
  ownership that was never negotiated, which is worse than no lock because it reads as authoritative.
- **Grandfather this one checkpoint under an explicit, recorded exception.** Accepted.

### Decision

For the `TNX-P6.2-FINALIZE` checkpoint only, Claude finished the already-started work in the dirty
worktree under explicit user authorization, subject to these constraints:

1. **No workflow script was overridden, weakened or edited.** `checkpoint-task.ps1` was deliberately
   *not* used, because it stages with `git add --all` and would have absorbed foreign paths.
   `handoff-task.ps1` was not used while foreign paths remained in the tree.
2. **No writer-lock file was invented.** `.ai-team/WRITER_LOCK.json` does not exist in this
   repository and was not created.
3. **Every commit stages explicit paths only.** No `git add -A`, no `git add .`.
4. **Two paths were treated as protected foreign work** and were not edited, staged, moved,
   restored, stashed, reset, cleaned or committed:
   - `backend/tests/integration/phase6ReadRouteAuthorization.test.js`
   - `docs/codex/`
   No destructive recovery command (`git reset --hard`, `git clean`, `git checkout` on a foreign
   path, or a broad stash) was run at any point.
5. **State and handoff were updated by hand**, accurately, rather than by a script that would have
   mis-attributed the tree.

### Consequence

This exception is now spent. **All future work on this repository must begin in a clean AI-team
worktree using the normal start / checkpoint / handoff writer-lock protocol.** A future agent that
finds a dirty tree must stop and review, not repeat this exception — the authorization was for one
named checkpoint, not a precedent.
