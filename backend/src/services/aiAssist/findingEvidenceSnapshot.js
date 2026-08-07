"use strict";

// The bounded, allow-listed single-Finding snapshot that is the ONLY thing an
// AI assist provider ever receives — and the deterministic fingerprint over
// it that makes staleness detectable. Mirrors services/ai/caseEvidenceSnapshot.js
// exactly in spirit and reuses its canonicalization/hashing helpers directly,
// scoped to one Finding instead of a whole Case.
//
// ===========================================================================
// Prompt minimization is done by CONSTRUCTION, not by redaction
// ===========================================================================
// This module builds a fresh object out of named, explicitly SELECTed
// columns. It never takes a database row and strips it.
//
// STRUCTURALLY EXCLUDED, same list services/ai/caseEvidenceSnapshot.js
// documents and tests/unit/aiAssistSnapshotSafety.test.js asserts here too:
//   - indicator value, port, protocol      (the constituent's addresses)
//   - the organization's name, email, phone, contact person, location
//   - AuditLog rows of any kind
//   - API keys, tokens, credentials, base URLs, provider configuration
//   - internal fingerprints, cache keys, claim tokens
//   - error messages, stack traces, Prisma errors
//   - raw database rows, arbitrary files, anything not enumerated here
//
// What DOES go: the report type, the analyst's triage decision, the
// deterministic Risk v1 band with its STORED explanation, and the CVE ids an
// analyst has explicitly asserted — exactly the same per-Finding fields
// services/ai/caseEvidenceSnapshot.js already includes in a Case snapshot's
// `findings[]` entries, just without requiring a Case.
//
// ===========================================================================
// Untrusted text is quoted as DATA, never as an instruction
// ===========================================================================
// requestContext (analyst-supplied) and the stored risk explanation
// (server-rendered, but ultimately derived from ingested report data) are
// both plain string VALUES on this plain object. Nothing in this module, or
// anywhere downstream of it, parses, evaluates, or treats any string field as
// a command — the safety control is structural (see aiAssistProvider.js's
// contract, which hands a provider a plain data object and nothing else),
// not a filter that could be bypassed by clever phrasing.
// tests/unit/findingAiPromptInjection.test.js proves this end to end with an
// adversarial requestContext.

const crypto = require("crypto");

const { renderScoreExplanation } = require("../risk/riskExplanation");
const { canonicalize, boundedString } = require("../ai/caseEvidenceSnapshot");

const MAX_RISK_EXPLANATION_LENGTH = 600;
const MAX_CVES = 20;

function fingerprintOf(evidence) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(evidence))).digest("hex");
}

/**
 * Loads the bounded evidence for one Finding. Every query selects NAMED
 * columns only.
 */
async function loadFindingEvidence(client, finding) {
  const [triage, score] = await Promise.all([
    client.findingTriage.findFirst({
      where: { findingId: finding.id, supersededAt: null },
      select: { decision: true },
    }),
    client.riskScore.findFirst({
      where: { findingId: finding.id, supersededAt: null },
      select: {
        id: true,
        riskBand: true,
        scoreBasisPoints: true,
        algorithmVersion: true,
        configurationVersion: true,
      },
    }),
  ]);

  const contributions = score
    ? await client.riskFactorContribution.findMany({ where: { riskScoreId: score.id } })
    : [];

  const vulnerabilityRows = await client.findingVulnerability.findMany({
    where: { findingId: finding.id, state: "ACTIVE", supersededAt: null },
    orderBy: [{ id: "asc" }],
    take: MAX_CVES,
    select: { vulnerability: { select: { cveId: true } } },
  });

  const explanation = score ? renderScoreExplanation(score, contributions) : null;

  return {
    findingId: finding.id,
    reportType: finding.reportType,
    triageDecision: triage ? triage.decision : "UNTRIAGED",
    riskBand: score ? score.riskBand : null,
    riskAlgorithmVersion: score ? score.algorithmVersion : null,
    riskExplanation: boundedString(
      explanation && typeof explanation.summary === "string"
        ? explanation.summary
        : typeof explanation === "string"
          ? explanation
          : null,
      MAX_RISK_EXPLANATION_LENGTH
    ),
    analystVerifiedCveIds: vulnerabilityRows
      .map((row) => (row.vulnerability ? row.vulnerability.cveId : null))
      .filter(Boolean)
      .sort(),
  };
}

/**
 * Builds the provider snapshot and its evidence fingerprint for one Finding.
 *
 * @param {object} client        Prisma client or transaction
 * @param {object} finding       an already-loaded Finding row (id, reportType)
 * @param {object} [options]
 * @param {string|null} [options.requestContext]  bounded analyst request text
 * @returns {Promise<{snapshot:object, fingerprint:string}>}
 */
async function buildFindingEvidenceSnapshot(client, finding, options = {}) {
  const evidence = await loadFindingEvidence(client, finding);
  const requestContext =
    typeof options.requestContext === "string" && options.requestContext.trim() !== ""
      ? options.requestContext.trim()
      : null;

  // Fingerprint FIRST, over evidence alone — requestContext is attached
  // afterwards so it structurally cannot influence the hash.
  const fingerprint = fingerprintOf(evidence);

  const snapshot = Object.freeze({
    ...structuredClone(evidence),
    requestContext,
    assistantContract:
      "Draft a short analyst-facing summary or explanation of this Finding for human review only. " +
      "Do not assert compliance, remediation status, or that any action has been taken. This text is " +
      "a suggestion; a human analyst decides whether to accept it.",
  });

  return { snapshot, fingerprint };
}

module.exports = {
  MAX_RISK_EXPLANATION_LENGTH,
  MAX_CVES,
  fingerprintOf,
  loadFindingEvidence,
  buildFindingEvidenceSnapshot,
};
