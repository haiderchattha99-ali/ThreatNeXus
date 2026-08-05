# Product

Orientation note. The authoritative product definition is
`../../../ThreatNeXus-Planning/planning/BUILD_PLAN.md`.

## Problem

A national CERT receives recurring third-party exposure reports (Shadowserver-style) as flat files.
Handled by hand, the same exposure is re-reported, re-triaged and re-notified without anyone being
able to say whether it was ever fixed, whether it came back, or which constituent owns it.

## Users

PKCERT analysts, reviewers, administrators, and read-only oversight — four roles with genuinely
different authority, not four skins on one screen.

## User value

Deduplicated, persistent findings with recurrence detection; a deterministic and explainable risk
score; an auditable case workflow with independent review; and constituent notifications that a
human approves before anything leaves the building.

## Core journeys

Ingest a report → triage what needs a decision → open an organization-bound case → gather evidence →
request closure → have a *different* person approve it → draft a notification → have a *different*
person approve the exact revision → export it manually → record what actually happened.

## Scope

One report type (Accessible RDP exposure) carried to closure. AbuseIPDB as the first real IOC
reputation provider behind an abstraction. KEV / EPSS / NVD as separate vulnerability enrichment.
Manual framework mapping (ATT&CK, NIST CSF, CIS) before any AI assistance.

## Out of scope

Live scheduled Shadowserver ingestion; automatic notification sending (no SMTP or webhook client at
all); automatic remediation verification; SIEM/EDR integration; threat-actor attribution; automatic
compliance assessment.

## Success measures

The evaluators are the measure: hand-authored ground truth that the real services must reproduce
exactly. Nine evaluator gates currently pass. Nothing on screen may assert a figure the database did
not produce — **unknown is never zero**, and no coverage percentage, system-health claim, map,
attack-traffic figure or AI result may be fabricated.

Do not invent users, metrics, or shipped capabilities. Link evidence where claims matter.
