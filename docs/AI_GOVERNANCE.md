# AI Governance

ThreatNeXus ships two independent AI-assistance surfaces. Both are **disabled by default**, both have
**no live AI provider anywhere in this repository**, and both are built so that even if AI were fully
enabled with a real provider, it could not close a case, send a notification, change a role's authority,
or make a final decision on its own. This document is the governance record for both — what AI can do,
what it structurally cannot do, and how a human stays accountable for every outcome.

## The one operator switch

```
AI_ENABLED=false     # shipped default
AI_PROVIDER=null      # shipped default; no real provider name resolves to anything but "disabled"
```

Both AI surfaces read the same switch. There is no per-feature toggle — "AI is optional and disabled by
default" is one decision, made once, in `docs/ai/DECISIONS.md`'s Phase 5 record, and every AI surface
added since (Phase 8C) reuses it rather than inventing a second one.

With `AI_ENABLED=false`, the **disabled provider** is resolved regardless of what `AI_PROVIDER` says, and
no suggestion request ever reaches an outbound call. This is proven in CI: `eval:phase7` replaces
`fetch` with a throwing counter and asserts it is never invoked with AI off.

**There is no live AI provider integrated in this codebase.** `AI_PROVIDER` accepts a name, but the only
two names either registry resolves to a real factory are `disabled` and a test-only `mock` — and `mock`
is reachable *only* with an explicit `allowMockProvider: true` flag that no production code path ever
passes. Setting `AI_PROVIDER` to anything else (`gpt-5`, `claude`, a typo) resolves to `null`, which
surfaces as `AI_PROVIDER_NOT_AVAILABLE`, never as a silent fallback to mock output presented as if a real
model answered it. Turning AI "on" today means turning on a provider that returns nothing, safely.

## The two AI surfaces

| | Case-level mapping suggestions (Phase 5) | Finding-level narrative drafts (Phase 8C) |
|---|---|---|
| What it proposes | ATT&CK / NIST CSF / CIS mapping candidates for a case | A **SUMMARY** or **EXPLANATION** draft for one Finding |
| Module | `backend/src/services/ai/` | `backend/src/services/aiAssist/` |
| Storage | `AiSuggestionRun`, `AiFrameworkMappingSuggestion` | `FindingAiSuggestion` |
| Snapshot handed to the provider | `caseEvidenceSnapshot.js` — named, explicit columns only | `findingEvidenceSnapshot.js` — same discipline, and structurally excludes the Finding's indicator value, port, protocol, and any organization contact detail |
| Who requests | ADMIN, ANALYST | ADMIN, ANALYST |
| Who decides | ADMIN, ANALYST (`decide:ai-mapping-suggestions`) | ADMIN, REVIEWER (`review:ai-suggestions`) |
| What acceptance does | Promotes the suggestion through the **same write path** a manual mapping uses | Flips only the suggestion's own review state — there is nothing downstream to promote into |
| Frontend surface | AI mapping panel on the case framework workspace | `FindingAiAssistPanel.jsx` on the Finding-detail page |

Both are independent — the Phase 8C ticket did not touch Phase 5's code, and each has its own provider
registry, contract shape, and audit trail, following this codebase's general rule of domain-separated
registries over one unified abstraction (see `docs/ARCHITECTURE.md`).

## Why acceptance can never exceed manual authority

**Case-level mappings**: the capability that decides a suggestion (`decide:ai-mapping-suggestions`) is
granted to exactly the same roles as the capability that creates a manual mapping
(`manage:framework-mappings`) — deliberately, not by coincidence. If a role could approve an AI
suggestion without also being allowed to write the same mapping by hand, the AI path would be a way to
obtain authority the manual path denies. That is the one rule this whole governance model exists to
enforce, and it is checked in code, not only in this document.

**Finding-level drafts**: accepting a draft is even more constrained — it writes exactly one row (the
suggestion's own status), never anything else. There is no Finding field an acceptance can change, no
score it can move, no case it can close.

## What AI is structurally unable to do

The provider contract has exactly one method and it returns data. A provider factory receives no Prisma
client, no transaction handle, no repository, no HTTP session, and no capability token — there is
nothing on which it could score, approve, close, reopen, export, notify, enrich, or write anything at
all. This is enforced by what the interface *omits*, not by a rule someone has to remember to follow,
and `aiSafetyBoundaries.test.js` (mapping suggestions) proves the omission holds.

Concretely, AI in this system **never**:

- makes a final framework-mapping decision, a risk-scoring decision, or a case/notification decision
- sends a notification, exports anything, or triggers delivery
- closes, reopens, or reclassifies a Finding or a Case
- gains write access to anything beyond its own suggestion row
- has its output trusted verbatim — see the next section

## AI output is untrusted input

A provider response is treated exactly as a request body from an anonymous client would be: unknown
keys are **rejected**, not silently dropped; every value is type-and-bound checked; and mapping content
must clear the same framework rules a hand-written mapping clears — including the server-side ATT&CK
evidence rule (a mapping needs *observed adversary behaviour* as evidence; exposure, CVE, KEV, EPSS,
reputation and risk score are each individually insufficient, and this is enforced whether the mapping
came from a human or a suggestion). A candidate that fails is **discarded and counted** — never repaired,
never coerced, never partially persisted, and never shown to an analyst.

For Finding-level drafts, only `text` and `evidenceReferences` are ever read off a provider result;
`evidenceReferences` must name only fields present in the snapshot's own closed allow-list; everything
else in the provider's response is discarded by construction.

## Staleness

If a Finding's evidence has changed since a draft was generated, an accept attempt transitions the draft
to `EXPIRED` and is refused — never silently re-derived against the new evidence. Rejecting is always
allowed, unconditionally.

## Prompt-injection handling

Analyst-supplied request context and provider-returned text are plain string values on a data object;
nothing in this codebase parses instructions out of either one. `findingAiPromptInjection.test.js` drives
an adversarial payload (text designed to look like an instruction to the system) through the real path
end to end and asserts: no Finding mutation occurs, and nothing is auto-accepted. The defense is
structural (the string is never interpreted as anything but display text) rather than a filter that
could be bypassed by a cleverer payload.

## Audit logging

Every AI action is audited: `ai.suggestion.requested`, `.generated`, `.failed`, `.accepted`, `.rejected`,
`.unavailable` — actor and role, provider name, and a closed reason code. **Never the proposed text, the
evidence snapshot, or any internal fingerprint.** An auditor can reconstruct who requested what and who
decided it, without the audit log itself becoming a second place sensitive draft text could leak from.

## Frontend behavior

`FindingAiAssistPanel.jsx` (and the equivalent case-level panel) render role visibility from the
capabilities the server actually returned at login — never a locally hardcoded role table — but this is
UX convenience only; the backend re-checks every capability on every request regardless of what the
panel shows, and a denied request creates no row.

A draft is **never rendered as a finding fact**. Every draft carries its own status badge
(`DRAFT`/`ACCEPTED`/`REJECTED`/`EXPIRED` — label, icon and color together, never color alone), its
evidence references as human-readable tags from a closed allow-list, and an advisory note that accepting
only records a human reviewer's decision — it never closes, scores, or reclassifies anything. No raw
provider error, prompt, or backend exception text ever reaches the browser; every AI error path renders
through a mapper that translates a closed set of backend codes into prose, falling back to a generic
message for anything unrecognized.

Because the mock provider is unreachable in production, the panel's only observable live state today is
"disabled" (the shipped default) or "no provider configured" — there is no code path by which a browser
session can see live-provider content, because there is no live provider.

## Limitations, stated honestly

- **No live AI provider ships.** Enabling `AI_ENABLED=true` today activates a provider that resolves to
  "disabled" regardless — there is nothing to point at a real model without writing a new provider
  adapter first, which is a deliberate, out-of-scope decision, not an oversight.
- **No catalogue validation on AI mapping candidates.** A syntactically valid but non-existent ATT&CK
  technique id passes shape validation and reaches review, because no pinned catalogue existed at the
  time Phase 5 shipped (Phase 6.3 later added one for the manual/AI-shared navigator, but the mapping
  *suggestion* pipeline's validation predates it — stated as a known gap, not smoothed over).
- **A human must still read every suggestion.** Nothing in this system measures suggestion quality,
  flags a suspicious pattern of accept/reject, or second-guesses a reviewer's decision. The audit trail
  makes decisions traceable; it does not make them automatically correct.
