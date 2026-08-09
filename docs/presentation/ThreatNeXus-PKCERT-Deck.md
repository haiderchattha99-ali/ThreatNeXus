# ThreatNeXus — PKCERT Presentation Deck (Source)

Slide-by-slide content, kept short by design — full delivery language lives in
`SPEAKER_NOTES.md`, one section per slide number below. This file is the source for
`ThreatNeXus-PKCERT-Deck.pptx`; edit here first. Visual/design rules are in `STYLE_GUIDE.md`.

---

## 1. Title

**ThreatNeXus**
Connecting Intelligence with Action

*A defensive threat-intelligence orchestration and incident-response workflow*

Research prototype — built during a PKCERT/NCERT internship

---

## 2. The problem

**A CERT gets the same exposure report twice, and has no way to know it.**

- Recurring exposure reports arrive as flat files
- Handled by hand, the same host gets re-reported, re-triaged, re-notified
- Nobody can say: was it fixed? Did it come back? Who owns it?

---

## 3. Why current workflows break down

- Analysts move between separate provider portals, one tab per source
- Evidence is judged from memory, under time pressure, with no consistent record
- Notifications leave without a required second reviewer
- The accountability trail doesn't survive the process

---

## 4. ThreatNeXus in one sentence

**One analyst flow — ingest, triage, enrich, map, draft, review, act — with every step audited.**

A Shadowserver-style report becomes a persistent, deduplicated Finding with a real identity, not a
fresh row every time it's re-reported.

---

## 5. The end-to-end workflow

```
Upload  →  Triage  →  Enrich  →  Map (ATT&CK/CSF/CIS)  →  AI draft (optional)  →  Review  →  Act
```

Every arrow in this chain writes its own audit event. Nothing skips a step.

---

## 6. Role model

| Role | Does |
|---|---|
| **Admin** | Every capability, including the closure/notification override grants |
| **Analyst** | Ingests, triages, builds cases, drafts notifications, requests enrichment/AI |
| **Reviewer** | Approves — case closures, notification content, AI-suggestion decisions |
| **Viewer** | Read-only oversight — deliberately excluded from notification visibility |

No role inherits another's authority.

---

## 7. A six-provider intelligence stack

**AbuseIPDB · NVD + CISA KEV + FIRST EPSS · Censys · GreyNoise · Shodan · Netlas**

All optional. All fail safe. One shared, rate-limited execution path.

---

## 8. Evidence, not proof

Every provider result is supporting context for an analyst decision — never automatic proof.

- **Unknown is never zero.**
- A risk factor is `Applied`, `Not available`, or `Not applicable` — never collapsed into a false "clean."

---

## 9. AI assistance — drafts only

- Disabled by default. No live AI provider ships in this codebase.
- Drafts a mapping suggestion or a finding summary — nothing more
- A provider gets one method and a stripped snapshot: no database access, no capability token
- Every draft needs a human accept before it counts as anything

---

## 10. ATT&CK mapping and evidence integrity

An ATT&CK mapping requires **observed adversary behaviour** as evidence. Exposure, a CVE, a risk score —
each is individually insufficient, and the rule is enforced server-side, whether the mapping came from
an analyst or an AI suggestion.

---

## 11. Security controls

- Capability-based RBAC — the backend is the only enforcement boundary
- Every write audited from the service layer
- Rate limiting on auth, upload, and provider execution
- No secret ever reaches a log, a response, or the browser bundle — checked on every CI push

---

## 12. Architecture

React frontend → Express REST API → domain services → PostgreSQL (via Prisma), with provider adapters
reaching out only on a human-triggered lookup. Every provider: its own table, its own closed error
vocabulary, one shared quota.

---

## 13. What a reviewer will see in the demo

Dashboard integrity model → a Finding's risk explanation → a case closure refused to its own
requester, approved by a reviewer → a weak ATT&CK justification refused → notification export vs.
delivery, tracked separately.

---

## 14. Validation proof

- **23** additive-only migrations
- **145** backend test files, a **9**-spec browser suite against the real stack
- **9** evaluator gates reproducing hand-authored ground truth
- CI on every push — schema integrity, secrets scan, zero live provider calls, proven structurally

---

## 15. Honest limits

- No in-app user management yet
- No production deployment — Docker Compose only
- Finding closure has no UI write path yet (the recurrence engine is tested and correct regardless)
- No live AI provider, no live Shadowserver feed — deliberate scope boundaries

---

## 16. Close

**ThreatNeXus is ready for technical review: a working, tested, audited analyst workflow — with its
gaps stated as plainly as its guarantees.**

Next: a seventh provider, in-app user management, a production write path for Finding closure.

Questions.
