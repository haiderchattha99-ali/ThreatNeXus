"use strict";

// Shared Phase 6.3 fixtures: the evidence-integrity fields every mapping now
// carries, and the pinned ATT&CK catalogue in injectable form.
//
// Lives here rather than being copy-pasted into five suites for one reason: the
// day the catalogue is upgraded, or the evidence contract changes, the fixtures
// must move together. Five hand-maintained copies would drift, and a suite
// still asserting the old contract while the others assert the new one is worse
// than no suite at all — it would look green while proving nothing.
//
// ---------------------------------------------------------------------------
// The catalogue used here is the REAL pinned one
// ---------------------------------------------------------------------------
// `attackCatalogueForTests()` loads the committed catalogue, checksum and all.
// That is deliberate: a hand-written stub catalogue would let a test pass while
// the real file was corrupt, missing, or shaped differently from what the
// loader expects — which is exactly the failure the fail-closed design exists
// to catch.
//
// `stubCatalogue()` is available for the handful of tests that need a technique
// with a property the real catalogue may not always contain (a specific revoked
// entry, say) without pinning the suite to one MITRE release.

const {
  getAttackCatalogue,
  findTechnique,
} = require("../../src/services/framework/attackCatalogue");

/**
 * The real pinned catalogue, in the shape frameworkCatalogueRules expects.
 */
function attackCatalogueForTests() {
  const catalogue = getAttackCatalogue();
  return {
    attackVersion: catalogue.attackVersion,
    checksum: catalogue.checksum,
    findTechnique: (referenceId) => findTechnique(referenceId),
  };
}

/** The pinned release string, e.g. "19.1". Read, never hard-coded. */
function pinnedAttackVersion() {
  return getAttackCatalogue().attackVersion;
}

/**
 * A minimal fake catalogue for tests that need an exact technique shape.
 * @param {Array<object>} techniques
 */
function stubCatalogue(techniques, { attackVersion = "19.1", checksum = "stub" } = {}) {
  const byId = new Map(techniques.map((technique) => [technique.id, technique]));
  return {
    attackVersion,
    checksum,
    findTechnique: (referenceId) => byId.get(referenceId) || null,
  };
}

// ---------------------------------------------------------------------------
// Evidence integrity fixtures
// ---------------------------------------------------------------------------

// The composed `identity` field of a Finding is
// "<indicatorValue> <protocol>/<port> <reportType>". Quoting it is the most
// portable way for a fixture to produce a quote that is genuinely verbatim in
// the record, without the suite also having to seed matching prose.
function findingIdentityQuote({
  indicatorValue = "203.0.113.45",
  protocol = "tcp",
  port = 3389,
  reportType = "ACCESSIBLE_RDP",
} = {}) {
  return `${indicatorValue} ${protocol}/${port} ${reportType}`;
}

// The verbatim text a seeded organization response must contain for
// `evidenceFields()` to verify against it. Exported so a suite seeds the same
// string it later quotes, instead of two copies drifting apart.
const CASE_RESPONSE_EVIDENCE_TEXT =
  "The constituent confirmed an interactive administrative session was established " +
  "outside their change window and has since disabled the account.";

/**
 * The four evidence fields, ready to spread into any mapping content.
 *
 * Defaults to CASE_RESPONSE, NOT to FINDING_RECORD. That is a real consequence
 * of the evidence rules rather than a convenience: FINDING_RECORD and
 * RAW_REPORT_ROW are Finding-ANCHORED, so they require an `evidenceFindingId`
 * naming which Finding the quote is in. A CASE-scoped mapping is entitled to
 * carry no Finding at all — and a mapping in that position must quote something
 * that is not a Finding. A case response is exactly that.
 *
 * Use `findingEvidenceFields()` for a mapping that does cite a Finding.
 */
function evidenceFields(overrides = {}) {
  return {
    evidenceQuote: "interactive administrative session was established",
    evidenceQuoteSource: "CASE_RESPONSE",
    evidenceConfidence: "HIGH",
    mappingConfidence: "MEDIUM",
    ...overrides,
  };
}

/**
 * Evidence fields anchored to a Finding.
 *
 * The caller must ALSO set `evidenceFindingId` on the content — this helper
 * deliberately does not, because which Finding a mapping rests on is part of
 * the mapping's own content, not part of its evidence formatting.
 */
function findingEvidenceFields(overrides = {}) {
  return {
    evidenceQuote: findingIdentityQuote(),
    evidenceQuoteSource: "FINDING_RECORD",
    evidenceConfidence: "HIGH",
    mappingConfidence: "MEDIUM",
    ...overrides,
  };
}

module.exports = {
  attackCatalogueForTests,
  pinnedAttackVersion,
  stubCatalogue,
  findingIdentityQuote,
  CASE_RESPONSE_EVIDENCE_TEXT,
  evidenceFields,
  findingEvidenceFields,
};
