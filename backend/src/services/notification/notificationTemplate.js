"use strict";

// The deterministic initial-draft template (Phase 4).
//
// ---------------------------------------------------------------------------
// This module invents nothing
// ---------------------------------------------------------------------------
// Every value it emits is either (a) copied from a row the caller already
// loaded out of the database, or (b) fixed template text defined as a constant
// in this file. There is no third source. In particular it never produces:
//
//   - a Finding, an indicator, a port or an occurrence count that was not
//     passed in from a persisted, currently-LINKED CaseFinding row
//   - a CVE, a CVSS score, a KEV/EPSS statement or any risk number — Phase 2
//     owns those, they are a separate surface, and none of them belongs in a
//     constituent notification produced by a template
//   - a remediation claim ("this was fixed", "you have patched") — the
//     guidance below is prospective advice for the report type, never an
//     assertion about what the recipient has or has not done
//   - a recipient address (the caller supplies the organization's own contact
//     record, or the draft simply has no recipient and cannot be exported
//     until an analyst supplies one)
//   - an organization response, an acknowledgement, or a deadline this system
//     has no authority to set
//
// It is also PURE and deterministic: same rows in, byte-identical content out,
// no wall-clock read, no random value, no database access. That is what makes
// the content checksum of a freshly created draft reproducible, and what lets
// the evaluator assert the exact text a draft is created with.
//
// AI is not involved here and cannot be. AI_ENABLED is false by default and no
// AI provider exists in this phase at all; the initial draft is a template
// substitution, and everything after it is an analyst's own edit.

const REPORT_TYPE_LABELS = Object.freeze({
  ACCESSIBLE_RDP: "Accessible RDP service",
});

// Fixed, prospective, report-type-scoped guidance. Deliberately generic and
// non-accusatory, and deliberately free of any claim about what the recipient
// has already done. An analyst may replace it entirely by editing the draft —
// which creates a revision, exactly like any other edit.
const REMEDIATION_GUIDANCE = Object.freeze({
  ACCESSIBLE_RDP: [
    "Recommended actions:",
    "",
    "1. Confirm whether the listed service is intended to be reachable from the public internet.",
    "2. If it is not intended, restrict access at the network boundary (firewall, security group",
    "   or ACL) so that only known administrative sources can reach the service.",
    "3. If remote administrative access is required, place it behind a VPN or an authenticated",
    "   gateway rather than exposing it directly.",
    "4. Enforce multi-factor authentication and account lockout on any remaining remote access.",
    "5. Apply the vendor's current security updates to the affected host.",
    "",
    "Please reply to this message with the action taken or with any correction to the",
    "information above, including whether the address listed belongs to your organization.",
  ].join("\n"),
});

const DEFAULT_GUIDANCE_KEY = "ACCESSIBLE_RDP";

const UNKNOWN_VALUE = "not recorded";

function reportTypeLabel(reportType) {
  return REPORT_TYPE_LABELS[reportType] || String(reportType || "Exposure");
}

// ISO-8601 UTC, or an explicit "not recorded". Never a locale-dependent
// rendering: the template must produce identical bytes on every machine.
function formatInstant(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return UNKNOWN_VALUE;
  return value.toISOString();
}

function formatCount(value) {
  return Number.isInteger(value) ? String(value) : UNKNOWN_VALUE;
}

/**
 * Renders one evidence block from a persisted Finding row.
 *
 * Only identity and observation fields are included. Ownership, enrichment,
 * reputation and risk are deliberately excluded: they are internal assessments,
 * some of them derived from third-party providers, and a constituent
 * notification is a statement about what was OBSERVED, not a disclosure of how
 * we scored it.
 */
function renderFindingBlock(finding, index) {
  const lines = [
    `${index + 1}. ${finding.indicatorValue} port ${finding.port}/${String(
      finding.protocol || ""
    ).toLowerCase()}`,
    `   Report type:      ${reportTypeLabel(finding.reportType)}`,
    `   First observed:   ${formatInstant(finding.firstSeen)}`,
    `   Most recently:    ${formatInstant(finding.lastSeen)}`,
    `   Times observed:   ${formatCount(finding.occurrenceCount)}`,
  ];

  // Only stated when it actually happened. A "Recurrences: 0" line on every
  // notification would train recipients to ignore the field that matters.
  if (Number.isInteger(finding.recurrenceCount) && finding.recurrenceCount > 0) {
    lines.push(`   Recurrences:      ${formatCount(finding.recurrenceCount)}`);
  }

  return lines.join("\n");
}

/**
 * Builds the initial draft content for a case.
 *
 * @param {object} input
 * @param {object} input.caseRecord   - the persisted Case row (caseReference,
 *                                      title, threatType)
 * @param {object|null} input.organization - the bound Organization row
 *                                      (name, contactPerson, email)
 * @param {Array<object>} input.findings   - persisted Finding rows for the
 *                                      case's CURRENTLY LINKED evidence, in a
 *                                      caller-determined deterministic order
 * @returns {{subject:string, body:string, remediationGuidance:string,
 *   recipientName:string|null, recipientEmail:string|null, analystNotes:null}}
 */
function buildInitialDraft({ caseRecord, organization, findings }) {
  const rows = Array.isArray(findings) ? findings : [];
  const organizationName =
    organization && typeof organization.name === "string" ? organization.name : "your organization";
  const reference =
    caseRecord && typeof caseRecord.caseReference === "string"
      ? caseRecord.caseReference
      : `case ${caseRecord && caseRecord.id}`;

  // The report type is taken from the evidence, never guessed. With no linked
  // evidence there is nothing to name, so the subject stays generic rather
  // than asserting a type this case has not demonstrated.
  const primaryReportType = rows.length > 0 ? rows[0].reportType : null;
  const subject = primaryReportType
    ? `${reportTypeLabel(primaryReportType)} exposure notification — ${reference}`
    : `Security exposure notification — ${reference}`;

  const evidenceSection =
    rows.length === 0
      ? [
          "No evidence is currently linked to this case. Link the relevant findings to the",
          "case and re-draft, or describe the exposure here before submitting for review.",
        ].join("\n")
      : rows.map(renderFindingBlock).join("\n\n");

  const body = [
    `Dear ${organizationName} security contact,`,
    "",
    "The national CERT function has observed the following exposure on infrastructure",
    "attributed to your organization. This notification is sent so that you can verify",
    "and act on it; it is not an assertion that your systems have been compromised.",
    "",
    `Reference: ${reference}`,
    "",
    "Observed exposure:",
    "",
    evidenceSection,
    "",
    "All times are UTC. The information above reflects what was observed in the source",
    "reporting available to us and may not be complete.",
  ].join("\n");

  const guidanceKey =
    primaryReportType && REMEDIATION_GUIDANCE[primaryReportType]
      ? primaryReportType
      : DEFAULT_GUIDANCE_KEY;

  // The organization's own contact record, or nothing. This module never
  // invents an address, and a draft with no recipient is a valid draft — it
  // simply cannot be exported until an analyst supplies one (see
  // notificationRules.evaluateExportEligibility, RECIPIENT_MISSING).
  const recipientName =
    organization && typeof organization.contactPerson === "string" && organization.contactPerson.trim() !== ""
      ? organization.contactPerson.trim()
      : null;
  const recipientEmail =
    organization && typeof organization.email === "string" && organization.email.trim() !== ""
      ? organization.email.trim()
      : null;

  return {
    subject,
    body,
    remediationGuidance: REMEDIATION_GUIDANCE[guidanceKey],
    recipientName,
    recipientEmail,
    // Internal working notes always start empty. Pre-filling them would put
    // template text into a field an auditor reads as analyst reasoning.
    analystNotes: null,
  };
}

module.exports = {
  REPORT_TYPE_LABELS,
  REMEDIATION_GUIDANCE,
  UNKNOWN_VALUE,
  reportTypeLabel,
  formatInstant,
  renderFindingBlock,
  buildInitialDraft,
};
