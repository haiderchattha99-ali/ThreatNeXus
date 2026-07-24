# Accessible-RDP synthetic-v1 fixtures

Small, controlled development/test fixtures for the `accessible-rdp.synthetic.v1`
row validator (`backend/src/services/ingestion/accessibleRdpRowValidator.js`).

**Not the ground-truth dataset.** These files make no dedup/persistence/
recurrence claims and carry no `ground_truth.yaml` — that dataset is a separate,
critical-path deliverable (see `../../ThreatNeXus-Planning/planning/BUILD_PLAN.md`,
"Synthetic dataset + ground truth"). These fixtures exist only to exercise the
row validator in isolation, one row at a time.

Each file is JSON: `{ contractVersion, description, rows: [...] }`. Row entries
carry only the eight synthetic-v1 columns as string values (the shape a CSV
parser would hand the validator) plus, where useful, a `label` and
`expectedErrorCode`/`expectedField` for self-documenting invalid-row fixtures.
The validator ignores any key it doesn't recognize, so this metadata never
reaches validation logic.

Deliberately **not** represented here: duplicate CSV headers or other
malformed-CSV-structure cases. Those are report-level parser/rejection
concerns (a later Phase 1 task), not row-validation concerns.

| File | Purpose |
|---|---|
| `valid-report.synthetic.json` | Fully valid report — every row passes. |
| `mixed-validity-report.synthetic.json` | A realistic mix of valid and invalid rows. |
| `duplicate-rows-report.synthetic.json` | Repeated identical natural keys within one report, for future duplicate-in-report detection; each row still validates independently. |
| `boundary-values-report.synthetic.json` | IPv4 octets 0 and 255; ports 1 and 65535. |
| `invalid-rows-report.synthetic.json` | One row per invalid case, each labelled with its expected error code/field. |
