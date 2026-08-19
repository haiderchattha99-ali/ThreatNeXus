# External Data Access — Permanent Record

**Record created:** 2026-08-19
**Status date for every "current status" statement below:** 2026-08-19
**Purpose:** to record, in one permanent place, which external data sources were pursued for
ThreatNeXus, what was obtained, and what was not — so that the final documentation can cite a
single factual source instead of inferring availability from the absence of data in the repository.

**Canonical source:** this file is the single canonical record of external data access. A second,
independently-written record (`docs/evidence/EXTERNAL-DATA-ACCESS.md`, produced on the
`docs/final-demo-evidence` branch without knowledge of this file) was merged into it on
**2026-08-19** at commit `fbffbe3`. Every fact unique to that document — the "not national exposure
statistics" caution in §5 below — was carried forward before the duplicate was marked superseded.

## How to read this record

Each subject below is split into three clearly separated classes. They are never merged.

| Class | Meaning |
|---|---|
| **REPOSITORY-DOCUMENTED FACT** | Verifiable from files, commits or configuration in this repository. |
| **PROJECT-TEAM ATTESTATION** | Confirmed by the project owner from their own records of correspondence and coordination. Not independently verifiable from this repository. |
| **CURRENT STATUS** | The state as at the status date above. |

A statement in the attestation class is a record of what the project team reports, and is labelled
as such precisely so that a reader can weigh it differently from a repository fact.

## 1. Shadowserver Foundation

### REPOSITORY-DOCUMENTED FACT

- External access to Shadowserver data was pursued as part of the project. A support
  ticket/reference, `#7ibziiin`, is recorded in the project status record
  (`STATUS.md`, "External dependency").
- Approval from the competent authority was a required precondition for access.
- An access and email coordination path involving AD Threat Intelligence was prepared.
- **Live scheduled Shadowserver API ingestion was never a required runtime dependency.** It is
  recorded as out of scope in `docs/PROJECT_PLAYBOOK.md` and `docs/PROVIDER_GUIDE.md`, and the
  system contains no Shadowserver API client, scheduler, or credential field.
- The system ingests **Shadowserver-*style*** Accessible RDP exposure reports through a documented
  CSV contract (`accessible-rdp.synthetic.v1`). This schema is a project-defined format modelled on
  the shape of such reports; it is not an official Shadowserver schema and is documented as such in
  `data/synthetic/README.md`.
- No Shadowserver data of any kind is present in this repository.

### PROJECT-TEAM ATTESTATION

The project owner confirms the following historical facts about the coordination process:

- The Shadowserver team responded to the project inquiry.
- The project supervisor, Ms. Ayesha, was supportive and helpful throughout the coordination
  process.
- The related email/access request did not receive the required approval from AD Threat
  Intelligence, Mrs. Aasia Bibi.
- Shadowserver data and API access were therefore not treated as available project inputs.

### CURRENT STATUS

Shadowserver data and API access are **not available project inputs**. All Accessible RDP exposure
data used in development, testing, evaluation and demonstration is synthetic and deterministic.

This is an **external-data access status**, not a software limitation. The ingestion pipeline,
deduplication, persistence, recurrence, ownership attribution, risk scoring and case workflow are
all implemented and exercised end to end against the synthetic dataset; they consume a report file,
and are indifferent to who produced it.

## 2. Rapid7 / Project Sonar

### REPOSITORY-DOCUMENTED FACT

- No Rapid7 or Project Sonar data exists anywhere in this repository.
- No Rapid7 or Sonar adapter, client, provider integration or runtime dependency exists. Rapid7 is
  not among the supported provider integrations, and there is no configuration surface for it.
- `README.md` records a real Shadowserver-style Accessible-RDP report — naming Rapid7 Open Data as
  an example source — as an input the system could accept, not as one it has received.

### PROJECT-TEAM ATTESTATION

The project owner confirms:

- A Rapid7 Open Data request was submitted as **Ticket #140718** on **2026-08-11**.
- A follow-up was subsequently sent.

### CURRENT STATUS

As at **2026-08-19**, no requested Rapid7 or Project Sonar dataset, access grant, or report has
been received.

This is recorded as an **external-data / access dependency**. It is not a software limitation, not
a failed feature, and not a received dataset. **No claim is made that an RDP exposure dataset was
obtained from Rapid7 or from any other external provider.**

## 3. Data categories used by the project

These four categories are distinct and are not interchangeable. Documentation must not present a
source in one category as evidence for another.

### A. Synthetic deterministic project data

The exposure data the system was built, tested, evaluated and demonstrated against.

- Location: `data/synthetic/` and `data/demo/`.
- Schema: `accessible-rdp.synthetic.v1` — a project-defined CSV contract modelled on the shape of
  Shadowserver-style Accessible RDP reports. Not an official Shadowserver schema.
- Deterministic, with ground truth committed alongside it (`data/synthetic/ground_truth.yaml`,
  `data/synthetic/risk_ground_truth.yaml`) so that deduplication, persistence and recurrence counts
  are compared by the evaluation harness rather than by eye.
- Addresses are drawn only from ranges reserved for documentation and benchmarking
  (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `198.18.0.0/15`). No real constituent data
  is present.

### B. Public / keyless sources actually supported

Vulnerability enrichment sources that require no credential and are genuinely integrated: CISA KEV,
EPSS, and NVD. These describe **vulnerabilities**, not the exposure inventory, and are a separate
path from IOC reputation enrichment. Neither substitutes for the other.

### C. Optional external provider integrations

IOC reputation and host-attribute providers behind a provider abstraction — AbuseIPDB, GreyNoise,
Censys, Shodan, Netlas. Every one is **optional and off by default**. With no credential the
application starts normally and every core workflow completes; enrichment records a truthful
unavailable or not-configured outcome rather than blocking ingestion.

Exactly one of these has been exercised live, under bounded human authorisation: a single GreyNoise
Community request against `1.1.1.1`. See `docs/evidence/CONTROLLED-LIVE-CANARY-RECORD.md` for the
full record and its scope limits.

### D. Requested but unavailable external datasets / access

- Shadowserver data and API access (section 1).
- Rapid7 / Project Sonar Open Data (section 2).

Neither was received. Neither is a runtime dependency of the system.

## 4. Category rule that must be preserved

**Scanner-source IP addresses are not the same thing as exposed-RDP destination hosts.**

A provider such as GreyNoise reports on the behaviour of an address that is *performing* scanning
or other internet-wide activity. A Shadowserver-style Accessible RDP report enumerates addresses
that are *exposing* an RDP service and are therefore the subject of a finding and, potentially, of
a notification to a constituent.

These are opposite ends of the same interaction. Presenting a scanner-reputation dataset as though
it could substitute for an exposure inventory — or counting entries from one as though they were
entries of the other — would misstate what the system knows and what any figure derived from it
means. The two categories are never to be merged in any document, figure, or count.

## 5. Presentation rule that must be preserved

**No claim anywhere in this project may present its dashboards or counts as national cyber exposure
statistics.** Every view — dashboard KPI, Findings count, case count — describes the loaded
demonstration dataset only (category A above), never a real-world or national population. This
holds regardless of which external-data section above is being discussed; it is a rule about how
any number from this system may be presented, not a fact about any one data source.

See also `docs/evidence/DEMO-REHEARSAL-EVIDENCE.md` for how provider enrichment (a data source
independent of report ingestion) was exercised under bounded live authorisation, and
`docs/evidence/CONTROLLED-LIVE-CANARY-RECORD.md` for the one live provider contact this project has
ever made.
