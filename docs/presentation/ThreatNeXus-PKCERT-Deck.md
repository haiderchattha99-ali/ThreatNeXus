# ThreatNeXus — PKCERT Presentation Deck (Source)

**Phase 9B.1 — premium redesign.** Slide-by-slide content, kept deliberately short — one idea per
slide, full delivery language lives in `SPEAKER_NOTES.md`, one section per slide number below. This
file is the source for `ThreatNeXus-PKCERT-Deck.pptx`; edit here first. Visual/design rules are in
`STYLE_GUIDE.md`; slide-build animation instructions are in `ANIMATION_CUE_SHEET.md`.

17 slides. No appendix — every required topic fits inside the core deck without padding.

---

## 1. Title

**ThreatNeXus**
Connecting Intelligence with Action

*A defensive CERT triage and constituent-notification workflow*
Research prototype — built during a PKCERT/NCERT internship

---

## 2. A report comes back. Nobody can say if it's new.

- An analyst re-triages the same exposure by hand, from memory, under time pressure
- Evidence lives across six provider tabs, never in one record
- Nothing ties today's report to the one from three months ago

---

## 3. Why fragmented CTI slows response

- One provider, one portal, one login — repeated six times over
- Judgment happens from memory, not from a durable evidence trail
- A notification can leave without a second reviewer ever seeing it
- When it's over, there's no record of who decided what, or why

---

## 4. What ThreatNeXus solves

**One workflow. One record. One accountable analyst per decision.**

A flat exposure report becomes a persistent, deduplicated Finding — enriched, scored, triaged, and
closed with a named human attached to every step that matters.

---

## 5. The end-to-end workflow

```
Upload  →  Triage  →  Enrich  →  Map (ATT&CK/CSF/CIS)  →  AI draft (optional)  →  Review  →  Act
```

Every arrow writes its own audit event. Nothing skips a step.

---

## 6. Live product surface

[Screenshot placeholder — Dashboard overview, `SCREENSHOT_PLAN.md` slot P-01]

Value, availability, source, and as-of timestamp on every tile. Unknown is never rendered as zero.

---

## 7. A six-provider intelligence stack

**AbuseIPDB · NVD + CISA KEV + FIRST EPSS · Censys · GreyNoise · Shodan · Netlas**

All optional. All fail safe. One shared, rate-limited execution path.

---

## 8. Evidence, not proof

Provider data supports an analyst's decision. It never replaces the analyst who makes it.

- Unknown is never zero
- A risk factor is `Applied`, `Not available`, or `Not applicable` — never collapsed into a false "clean"

---

## 9. AI assistance — drafts only

- Disabled by default. No live AI provider ships in this codebase.
- Drafts a mapping suggestion or a finding summary — nothing more
- A provider gets one method and a stripped snapshot: no database access, no capability token
- Every draft needs a named human's accept before it counts as anything

---

## 10. ATT&CK mapping and evidence integrity

An ATT&CK mapping requires **observed adversary behaviour** as evidence. Exposure, a CVE, a risk
score — each is individually insufficient, and the rule is enforced server-side, whether the mapping
came from an analyst or an accepted AI suggestion.

---

## 11. Security controls

- Capability-based RBAC — the backend is the only enforcement boundary
- Every write audited from the service layer
- Rate limiting on auth, upload, and provider execution
- No secret ever reaches a log, a response, or the browser bundle — checked on every CI push

---

## 12. Architecture

React frontend → Express REST API → domain services → PostgreSQL (via Prisma), with provider
adapters reaching out only on a human-triggered lookup. Every provider: its own table, its own
closed error vocabulary, one shared quota.

---

## 13. What a PKCERT reviewer will see in the demo

Dashboard integrity model → a Finding's risk explanation → a case closure refused to its own
requester, approved by a reviewer → a weak ATT&CK justification refused → notification export vs.
delivery, tracked separately.

---

## 14. Meet the team

| | |
|---|---|
| **M. Ismail** | Threat Intelligence and System Coordination |
| **Ali Haider** | Software Engineering and Backend Systems |
| **Aun Zulfiqar** | Frontend and UX |
| **Eshaal Khan** | Security Workflow and QA |

---

## 15. Validation proof

- **23** additive-only migrations
- **145** backend test files, a **9**-spec browser suite against the real stack
- **9** evaluator gates reproducing hand-authored ground truth
- CI on every push — schema integrity, secrets scan, zero live provider calls, proven structurally

---

## 16. Honest limits and roadmap

- No in-app user management yet
- No production deployment — Docker Compose only
- Finding closure has no UI write path yet (the recurrence engine is tested and correct regardless)
- No live AI provider, no live Shadowserver feed — deliberate scope boundaries

**Next**: a seventh provider, in-app user management, a production write path for Finding closure.

---

## 17. Close

**ThreatNeXus is ready for technical review: a working, tested, audited analyst workflow — with its
gaps stated as plainly as its guarantees.**

Questions.
