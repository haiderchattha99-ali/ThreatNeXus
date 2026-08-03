"use strict";

// The bounded, allow-listed case snapshot that is the ONLY thing an AI
// provider ever receives — and the deterministic fingerprint over it that makes
// staleness detectable.
//
// ===========================================================================
// Prompt minimization is done by CONSTRUCTION, not by redaction
// ===========================================================================
// This module builds a fresh object out of named fields. It never takes a
// database row and strips it, because a strip-based minimizer silently starts
// leaking whatever the next migration adds. Everything not listed in
// buildCaseEvidenceSnapshot below is absent because it was never fetched into
// the object in the first place.
//
// STRUCTURALLY EXCLUDED, and asserted by tests/unit/aiSnapshotSafety.test.js:
//   - indicator values, ports, protocols     (the constituent's addresses)
//   - the organization's NAME, email, phone, contact person, industry,
//     location                                (only the coarse sector goes)
//   - notification subjects, bodies, recipients, delivery records
//   - AuditLog rows of any kind
//   - API keys, tokens, credentials, base URLs, provider configuration
//   - internal fingerprints (the risk inputFingerprint, this snapshot's own
//     fingerprint, cache keys, claim tokens, current-row keys)
//   - Error messages, stack traces, Prisma errors
//   - raw database rows, arbitrary files, anything not enumerated here
//
// What DOES go: the case reference and title, the lifecycle state, the coarse
// organization sector, and per linked Finding — the report type, the analyst's
// triage decision, the deterministic Risk v1 band with its STORED explanation,
// and the CVE ids an analyst has explicitly asserted. Plus the framework
// mappings already in force, so the assistant does not re-propose them.
//
// The case title is analyst-authored free text and IS included, bounded. That
// is a deliberate decision rather than an oversight: an assistant given no
// description of the case can only pattern-match on the report type, and the
// title is the one field an analyst writes knowing it summarises the incident.
// It is bounded and the organization NAME is separately excluded, so the usual
// leak path (org identity) is closed regardless of what a title contains.
//
// ===========================================================================
// The fingerprint is over EVIDENCE ONLY
// ===========================================================================
// requestContext — what the analyst asked for this time — is part of the
// snapshot sent to the provider but is EXCLUDED from the fingerprint. It
// describes the question, not the case, so changing it must not retroactively
// invalidate a suggestion made about unchanged evidence.
//
// Everything else IS in the fingerprint, canonicalized by key-sorted
// serialization (never insertion order), so the hash is reproducible across
// processes and Node versions. Linking a Finding, retriaging one, rescoring
// one, asserting a CVE, or adding a mapping all change it — which is exactly
// the set of changes that should force a suggestion to be re-derived rather
// than approved against a case that has moved on.

const crypto = require("crypto");

const { renderScoreExplanation } = require("../risk/riskExplanation");
const { MAPPING_STATES } = require("../framework/frameworkMappingRules");

// Bounds. A snapshot is an input to somebody else's system; it is capped so a
// case with hundreds of linked Findings cannot produce an unbounded payload.
const MAX_SNAPSHOT_FINDINGS = 25;
const MAX_SNAPSHOT_MAPPINGS = 50;
const MAX_SNAPSHOT_CVES_PER_FINDING = 20;
const MAX_TITLE_LENGTH = 200;
const MAX_RISK_EXPLANATION_LENGTH = 600;

function boundedString(value, maxLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * Canonical JSON: object keys sorted recursively, arrays kept in their given
 * order (the caller sorts them deterministically before getting here).
 *
 * Insertion-order serialization would make the fingerprint depend on how the
 * object happened to be built, which is exactly the bug the Phase 2 enrichment
 * cache key avoided by serializing a key-sorted pair array.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        out[key] = canonicalize(value[key]);
        return out;
      }, {});
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

function fingerprintOf(evidence) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(evidence)))
    .digest("hex");
}

/**
 * Loads the bounded evidence for one case.
 *
 * Every query below selects NAMED columns. None of them is a bare `findMany`
 * that would pull a whole row into memory where a later refactor could forward
 * it.
 *
 * @returns {Promise<{evidence:object, linkedFindingIds:number[]}>}
 */
async function loadCaseEvidence(client, caseRecord) {
  const organization = await client.organization.findUnique({
    where: { id: caseRecord.organizationId },
    // Sector ONLY. Name, email, phone, contactPerson, industry and location are
    // never read here, so they cannot be forwarded by accident.
    select: { sector: true },
  });

  const links = await client.caseFinding.findMany({
    where: { caseId: caseRecord.id, state: "LINKED", supersededAt: null },
    orderBy: [{ findingId: "asc" }],
    take: MAX_SNAPSHOT_FINDINGS,
    select: { findingId: true },
  });
  const linkedFindingIds = links.map((link) => link.findingId);

  const findings =
    linkedFindingIds.length === 0
      ? []
      : await client.finding.findMany({
          where: { id: { in: linkedFindingIds } },
          orderBy: [{ id: "asc" }],
          // reportType only. indicatorValue, port and protocol are deliberately
          // not selected — they identify the constituent's infrastructure.
          select: { id: true, reportType: true },
        });

  const triageRows =
    linkedFindingIds.length === 0
      ? []
      : await client.findingTriage.findMany({
          where: { findingId: { in: linkedFindingIds }, supersededAt: null },
          select: { findingId: true, decision: true },
        });
  const triageByFinding = new Map(triageRows.map((row) => [row.findingId, row.decision]));

  const scoreRows =
    linkedFindingIds.length === 0
      ? []
      : await client.riskScore.findMany({
          where: { findingId: { in: linkedFindingIds }, supersededAt: null },
          select: {
            id: true,
            findingId: true,
            riskBand: true,
            scoreBasisPoints: true,
            algorithmVersion: true,
            configurationVersion: true,
          },
        });
  const scoreByFinding = new Map(scoreRows.map((row) => [row.findingId, row]));

  const contributionRows =
    scoreRows.length === 0
      ? []
      : await client.riskFactorContribution.findMany({
          where: { riskScoreId: { in: scoreRows.map((row) => row.id) } },
          orderBy: [{ id: "asc" }],
        });
  const contributionsByScore = new Map();
  contributionRows.forEach((row) => {
    if (!contributionsByScore.has(row.riskScoreId)) contributionsByScore.set(row.riskScoreId, []);
    contributionsByScore.get(row.riskScoreId).push(row);
  });

  const vulnerabilityRows =
    linkedFindingIds.length === 0
      ? []
      : await client.findingVulnerability.findMany({
          where: {
            findingId: { in: linkedFindingIds },
            state: "ACTIVE",
            supersededAt: null,
          },
          orderBy: [{ id: "asc" }],
          select: { findingId: true, vulnerability: { select: { cveId: true } } },
        });
  const cvesByFinding = new Map();
  vulnerabilityRows.forEach((row) => {
    if (!cvesByFinding.has(row.findingId)) cvesByFinding.set(row.findingId, []);
    const list = cvesByFinding.get(row.findingId);
    if (list.length < MAX_SNAPSHOT_CVES_PER_FINDING && row.vulnerability) {
      list.push(row.vulnerability.cveId);
    }
  });

  const mappings = await client.caseFrameworkMapping.findMany({
    where: { caseId: caseRecord.id, state: MAPPING_STATES.ACTIVE, supersededAt: null },
    orderBy: [{ framework: "asc" }, { referenceId: "asc" }],
    take: MAX_SNAPSHOT_MAPPINGS,
    select: { framework: true, referenceId: true, mappingScope: true },
  });

  const findingEntries = findings.map((finding) => {
    const score = scoreByFinding.get(finding.id) || null;
    // The explanation is rendered from the STORED score row and its STORED
    // contributions — the same self-contained rendering the risk read service
    // performs. It is never recomputed against today's configuration, so a
    // snapshot describes what was actually decided about this Finding.
    const explanation = score
      ? renderScoreExplanation(score, contributionsByScore.get(score.id) || [])
      : null;

    return {
      findingId: finding.id,
      reportType: finding.reportType,
      triageDecision: triageByFinding.get(finding.id) || "UNTRIAGED",
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
      analystVerifiedCveIds: (cvesByFinding.get(finding.id) || []).slice().sort(),
    };
  });

  return {
    evidence: {
      caseReference: caseRecord.caseReference || null,
      caseTitle: boundedString(caseRecord.title, MAX_TITLE_LENGTH),
      lifecycleState: caseRecord.lifecycleState,
      organizationSector: organization ? organization.sector : "UNKNOWN",
      findings: findingEntries,
      currentMappings: mappings.map((row) => ({
        framework: row.framework,
        referenceId: row.referenceId,
        mappingScope: row.mappingScope,
      })),
    },
    linkedFindingIds,
  };
}

/**
 * Builds the provider snapshot and its evidence fingerprint.
 *
 * @param {object} client        Prisma client or transaction
 * @param {object} caseRecord    an already-loaded, organization-bound Case
 * @param {object} [options]
 * @param {string|null} [options.requestContext]  bounded analyst request text
 * @returns {Promise<{snapshot:object, fingerprint:string, linkedFindingIds:number[]}>}
 */
async function buildCaseEvidenceSnapshot(client, caseRecord, options = {}) {
  const { evidence, linkedFindingIds } = await loadCaseEvidence(client, caseRecord);
  const requestContext =
    typeof options.requestContext === "string" && options.requestContext.trim() !== ""
      ? options.requestContext.trim()
      : null;

  // Fingerprint FIRST, over evidence alone. requestContext is attached
  // afterwards so it structurally cannot influence the hash — a comment saying
  // "we exclude it" would be weaker than not having it in scope.
  const fingerprint = fingerprintOf(evidence);

  const snapshot = Object.freeze({
    ...structuredClone(evidence),
    requestContext,
    // Carried into the prompt itself: the instruction that the assistant is
    // proposing analyst context, not asserting compliance or coverage. The real
    // control is that the provider has no side effects at all, but a prompt
    // that also says so costs nothing.
    assistantContract:
      "Propose candidate framework references for analyst review only. Do not assert compliance, " +
      "implementation, audit status, or that any ATT&CK technique occurred without observed " +
      "behaviour evidence stated in the case.",
  });

  return { snapshot, fingerprint, linkedFindingIds };
}

module.exports = {
  MAX_SNAPSHOT_FINDINGS,
  MAX_SNAPSHOT_MAPPINGS,
  MAX_SNAPSHOT_CVES_PER_FINDING,
  MAX_TITLE_LENGTH,
  MAX_RISK_EXPLANATION_LENGTH,
  boundedString,
  canonicalize,
  fingerprintOf,
  loadCaseEvidence,
  buildCaseEvidenceSnapshot,
};
