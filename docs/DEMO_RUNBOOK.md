# ThreatNeXus — demonstration runbook

A twelve-minute walkthrough of the implemented workflow, using the deterministic
synthetic dataset. Everything below is reproducible from a clean checkout.

> **Positioning.** ThreatNeXus is a defensive cyber-threat-intelligence
> orchestration and incident-response **research prototype**, developed during an
> internship with PKCERT/NCERT. It is not an official PKCERT platform, not a
> national deployment, and not certified, endorsed or production-approved by
> PKCERT/NCERT. It performs no autonomous Internet scanning, no automatic
> remediation and no automatic email delivery.

---

## 0. Start the stack

```bash
# From the repository root.
JWT_SECRET="$(openssl rand -base64 48)" docker compose up --build
```

The backend applies all 17 migrations from zero on start and refuses to boot
without `JWT_SECRET`. PostgreSQL is health-checked before the backend is allowed
to start, so a cold machine does not race the database.

Create the four local accounts, then load the demonstration dataset:

```bash
docker compose exec -e SEED_USER_PASSWORD='<a-strong-local-password>' \
  backend npm run seed:users

docker compose exec -e DEMO_MODE=true -e DEMO_USER_PASSWORD='<same password>' \
  backend npm run seed:demo
```

Open <http://localhost:5173>.

| Role | Account |
|---|---|
| Administrator | `admin@threatnexus.local` |
| Analyst | `analyst@threatnexus.local` |
| Reviewer | `reviewer@threatnexus.local` |
| Viewer | `viewer@threatnexus.local` |

The seed refuses to run with `NODE_ENV=production`, refuses to run without
`DEMO_MODE=true`, and never prints the password.

---

## 1. Sign in — the opening (1 min)

Sign in as the **analyst**.

Points to make:
- The opening animation runs for about 1.7 seconds, plays once per browser
  session, and never blocks the form — the fields are usable from the first
  paint. Turn on the operating system's "reduce motion" setting and reload: the
  motif renders in its final state and no animation object is constructed at all.
- The motif is a **brand** graphic. It is not telemetry, not a map, not a threat
  count, and it is not fed by any data.

---

## 2. Operations overview — the integrity contract (3 min)

This is the centre of the Phase 6 work. Every figure carries four things:

```
value · availability · source · asOf
```

Point at the caption under any tile. It names the actual table and column —
`Finding.occurrenceCount > 1`, `RiskScore.currentForFindingId IS NOT NULL` — and
the instant the whole snapshot was evaluated at.

Things to show deliberately:

| What | Why it matters |
|---|---|
| "Loaded dataset only" under the title | This is not a national or Internet-wide measurement, and never claims to be. |
| "no provider request is made to render this page" | Rendering the dashboard contacts no third party. Provider status is read from configuration plus previously stored rows. |
| **Scored** vs **Not yet scored** | A Finding with no current risk score is counted separately, never folded into the lowest band. |
| Framework panel titled *Analyst-associated framework context* | Mappings are analyst assertions. There is no coverage percentage, no compliance claim and no denominator over any catalogue. |
| Notification panel banner: *Export is not delivery* | Producing an artifact is not sending it. This system has no SMTP or webhook client at all. |
| Geographic panel | *"Verified geographic observations are not currently available."* No coordinate is persisted anywhere and location is never inferred. |

Then sign out and sign in as the **viewer**. The notifications section now reads
**"Not available to your role"** — not zero. That distinction is the whole point:
an unreadable figure and a counted zero must never look the same.

---

## 3. Findings — evidence and explainable risk (3 min)

**Findings** in the sidebar.

- One row is one `(indicator, port, protocol, report type)` identity. Uploading
  the same host again does not create a second row; it appends an occurrence.
- Filters are sent to the server, which **rejects** an invalid value by naming
  the field rather than silently returning different rows. The count under the
  table always describes the filter that was actually applied.
- Ownership shows how the owner was resolved and at what confidence. The
  ASN-attributed rows are labelled low-confidence ISP attribution, because an
  ASN identifies a network operator, not the affected constituent.

Open a Finding. The **Risk v1 explanation** table is the thing to dwell on: it
is rendered entirely from the factor contribution rows the engine stored. The
three applicability values are never collapsed:

- `APPLIED` — real evidence was scored, including a legitimate zero
- `NOT_AVAILABLE` — the evidence could not be obtained
- `NOT_APPLICABLE` — the factor cannot apply to this kind of finding

"We could not check" is never displayed as "clean".

---

## 4. Cases — separation of duties (2 min)

**Cases** → open the Meridian Health Trust case.

Walk the timeline: created → evidence linked → waiting for organization →
organization response recorded.

Then the point worth making out loud: the **analyst who requests a closure can
never approve one**. The seed proves this rather than asserting it — during
`seed:demo` the analyst's own self-approval attempt is issued and refused with
403, and only the reviewer token can grant it. The same holds for notifications.

A `REMEDIATED` closure additionally requires the organization to have actually
said so: requesting one without a recorded `REMEDIATED` response is refused with
`REMEDIATED_RESPONSE_REQUIRED`.

---

## 5. Framework mappings — the ATT&CK rule (1 min)

On the case, open the framework workspace.

- A NIST CSF mapping exists on a **control-gap** basis.
- Try to add `T1133 External Remote Services` justified by *"the host exposes RDP
  and has a high risk score"*. It is **refused**. ATT&CK requires observed
  adversary behaviour; exposure, CVE, KEV, EPSS, reputation and risk score are
  each insufficient on their own.

AI assistance is disabled by default and there is no live provider in this
repository. A suggestion is inert until a human approves it, and approval
promotes it through the *same* service a manual mapping uses — so AI can never
obtain an authority the manual path denies.

---

## 6. Notifications — approval, export, delivery (2 min)

**Notifications** → the drafted notification for the case.

1. Content is built from the case's persisted evidence.
2. Revisions are immutable; editing an approved draft invalidates the approval
   by stored state, not by a comparison someone might forget to write.
3. Approval binds to the **exact** revision reviewed.
4. Export produces an RFC 5322 `.eml` file for the analyst to send by hand.
5. Delivery is a **separate**, explicitly recorded human observation.

Show the export and delivery counts on the dashboard side by side. They are
never summed, because producing a file and sending it are different events.

---

## What this demonstration does not show, and why

| Not shown | Reason |
|---|---|
| A live threat feed | There is no live ingestion. Reports are uploaded files. |
| A geographic map | No provenance-backed coordinate is persisted by any phase. |
| An ATT&CK coverage percentage | Mappings are analyst context, not coverage of a catalogue. |
| Provider latency or uptime | Never measured, so never displayed. |
| A recurrence-reopened case | See below. |

**Recurrence.** The recurrence chain (a Finding observed again after closure
reopening a `REMEDIATED` case) is implemented, tested and proven by
`npm run eval:phase1` and `npm run eval:phase3`. It cannot be demonstrated
through the UI because **no route or service in `src/` writes
`Finding.status = CLOSED`** — Finding closure has no production write path in
the current build. The engine reads that state correctly; nothing reachable
produces it. This is an honest gap carried forward, not a Phase 6 regression,
and Phase 6 deliberately did not add a write path to locked lifecycle semantics.

---

## Attribution

> This product uses the NVD API but is not endorsed or certified by the NVD.

CISA KEV and FIRST EPSS are public sources used strictly as context for
analyst-verified CVE associations. AbuseIPDB is IP reputation context — never
proof, and never a discovery source. MITRE ATT&CK, NIST CSF and CIS Controls are
referenced as versioned public catalogues.
