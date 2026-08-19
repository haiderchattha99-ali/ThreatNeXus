# Evidence — external data access requests

Chronology of the attempts to obtain real exposure data for ThreatNeXus, and
what each attempt produced. Recorded neutrally and factually.

**Bottom line: no real constituent exposure data was obtained, and none was
used.** Every Finding in every dataset in this repository is synthetic, built on
RFC 5737 / RFC 2544 reserved address ranges. No RDP exposure evidence was
invented to compensate for the absence of a real feed.

---

## 1. Shadowserver Foundation

- The Shadowserver Foundation **responded** to the approach.
- **Ms. Ayesha** supported and helped coordinate the request.
- The related access/email request was **not approved** by **Mrs. Aasia Bibi,
  AD Threat Intelligence**.
- **Consequently, Shadowserver data and access were not treated as available**
  at any point in the project.

This is a recorded organisational outcome, not a judgement about any party. The
project proceeded on the assumption that no Shadowserver feed existed, which is
why ingestion is built against a *Shadowserver-style* synthetic reference report
rather than a live feed, and why live scheduled Shadowserver API ingestion is
explicitly out of scope.

## 2. Rapid7 Open Data

| | |
|---|---|
| Ticket | **#140718** |
| Submitted | **2026-08-11** |
| Follow-up | sent subsequently |
| Status as of **2026-08-19** | **no requested dataset, access, or report received** |

No Rapid7 data was received, and therefore none was used.

---

## 3. What this means for the product

- The ingestion pipeline is proven against a **synthetic Accessible-RDP
  reference report family**, and nothing else.
- Provider enrichment (Censys, Netlas, GreyNoise, AbuseIPDB, Shodan, NVD) is a
  **separate** concern from report ingestion and was exercised independently —
  see `CONTROLLED-LIVE-CANARY.md` and `DEMO-REHEARSAL-EVIDENCE.md`.
- No claim anywhere in this project should present its dashboards or counts as
  national cyber exposure statistics. Every view describes **the loaded
  dataset** only.
