# Final demonstration screenshots

Captured **2026-08-19** against the disposable demonstration stack
(`threatnexus_demo`) running current `origin/main` (`2bda0e5`) plus this branch.

**Captured only AFTER** the bounded rehearsal was completed, the demonstration
database was reset, and the non-contact preflight returned **`DEMO READY`
(16/16)**. None of these images shows a rehearsed or "skipped — a fresh result
already exists" state.

Signed in as the seeded `analyst@threatnexus.local` account. **0 browser console
errors** during capture. 1600×1000 viewport at 2× device scale, full page.

| File | What it shows |
|---|---|
| `01-dashboard.png` | Operational overview. Every figure carries a source and an as-of; unreadable or uncomputable sections report RESTRICTED/UNAVAILABLE rather than a silent zero. |
| `02-findings.png` | The Findings workspace over the loaded demonstration dataset (11 synthetic Accessible-RDP Findings). |
| `03-finding-detail-decision-first.png` | Finding **A** (`203.0.113.11`, 3389/TCP) — risk, ownership and confidence, triage, evidence provenance, observation history. |
| `04-enrichment-coverage-before-request.png` | The same Finding with Enrichment coverage expanded, in the **pre-request** state the demonstration begins from. |

## Why `04` is the important one

It is the direct evidence that the demonstration's opening state is correct:

- every provider row reads **"Not requested"** — no fresh result exists, so the
  first analyst click cannot be skipped;
- the primary action offered is **Request enrichment**, not the repeated-run
  path;
- **"Execution active"** confirms the worker will pick up recorded work;
- **NVD** truthfully reports **no qualifying subject on this Finding** — no CVE
  was fabricated to enable an NVD demonstration;
- the IP reputation panel shows **Queued**, not a value, and says so: *"No
  reputation values are shown, because the lookup did not succeed. This is not a
  clean result."* That is the legacy `IocEnrichment` queue row ingestion always
  creates, rendered honestly rather than as evidence;
- **AI assistance is Disabled**, and the risk score is reconstructed from stored
  factor contributions — including three factors explicitly marked *Not
  applicable* because no CVE is associated.

## Contents

All data is synthetic. Organizations are fictional and every address is an
RFC 5737 / RFC 2544 reserved range. **No real constituent data, and no
credential or credential fragment, appears in any image.**
