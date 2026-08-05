"use strict";

// Verbatim evidence-quote verification (Phase 6.3).
//
// frameworkEvidenceRules decides the SHAPE of an evidence claim without a
// database. This module decides whether the claim is TRUE, which needs the
// record it cites — so everything here runs inside the caller's write
// transaction, against the same snapshot the mapping will commit under.
//
// ===========================================================================
// Why this runs inside the transaction, and is re-run on every write
// ===========================================================================
// A quote verified against a record read a moment earlier, outside the
// transaction, proves nothing about the record the mapping is about to be
// stored beside. The Finding could have been unlinked from the case in between,
// or the response row could have been recorded against a different case. So the
// resolution reads through `tx`, and the mapping service calls this on every
// append — including the AI promotion path, which re-verifies rather than
// trusting what the suggestion recorded when it was generated.
//
// ===========================================================================
// What a failure means, and why it is a 409 rather than a 400
// ===========================================================================
// "This quote does not appear in that record" is not a malformed request. The
// caller's input was well formed; the world does not agree with it. That
// distinction matters to an analyst, because the fix is different: a 400 means
// "you typed something invalid", a 409 means "what you typed is not what the
// record says — go and look again".
//
// ===========================================================================
// Bounded reads
// ===========================================================================
// A Finding with years of occurrences could have a very large number of raw
// report rows behind it, and a mapping request must not become an unbounded
// scan. Reads are capped and ordered deterministically (newest first, then by
// id), so the same request checks the same records every time and a caller
// cannot widen the search by retrying.

const {
  MAPPING_REJECTION_CODES,
  FrameworkMappingStateError,
} = require("./frameworkMappingErrors");

const {
  EVIDENCE_QUOTE_SOURCES,
  locateQuoteInCandidates,
  flattenPayloadCandidates,
  buildEvidenceLocator,
} = require("./frameworkEvidenceRules");

// How many source records one verification may examine. Generous enough that a
// legitimate quote from recent evidence is found, bounded enough that the work
// per request is predictable.
const MAX_RAW_ROWS_SCANNED = 50;
const MAX_RESPONSES_SCANNED = 50;

/**
 * Quotable fields of a Finding.
 *
 * `identity` is COMPOSED by ThreatNeXus from the Finding's own columns — it is
 * not ingested text — and is offered because the individual columns are often
 * too short to quote meaningfully on their own (an IPv4 address can be seven
 * characters, below the minimum quote length that stops coincidental matches).
 * Its composition is fixed and deterministic, and the stored locator names it
 * explicitly as `identity`, so a reviewer can always tell a composed quote from
 * one taken out of an ingested field.
 *
 * Deliberately EXCLUDES every enrichment-derived value — risk band, reputation,
 * KEV, EPSS, ownership. Those are the exposure signals an ATT&CK rationale is
 * forbidden to rest on, and offering them here as quotable "evidence" would
 * hand back through the evidence door exactly what the rationale gate refuses
 * at the front.
 */
function findingQuoteCandidates(finding) {
  const protocol = String(finding.protocol || "").toLowerCase();
  return [
    { field: "identity", value: `${finding.indicatorValue} ${protocol}/${finding.port} ${finding.reportType}` },
    { field: "indicatorValue", value: String(finding.indicatorValue) },
    { field: "reportType", value: String(finding.reportType) },
    { field: "status", value: String(finding.status) },
    { field: "firstSeen", value: finding.firstSeen ? finding.firstSeen.toISOString() : null },
    { field: "lastSeen", value: finding.lastSeen ? finding.lastSeen.toISOString() : null },
    { field: "closureReason", value: finding.closureReason || null },
  ];
}

async function verifyAgainstFindingRecord(tx, content) {
  const finding = await tx.finding.findUnique({ where: { id: content.evidenceFindingId } });
  if (!finding) {
    throw new FrameworkMappingStateError(
      "The Finding cited as the evidence source does not exist",
      MAPPING_REJECTION_CODES.EVIDENCE_SOURCE_RECORD_UNAVAILABLE
    );
  }

  const located = locateQuoteInCandidates(content.evidenceQuote, findingQuoteCandidates(finding));
  if (!located) {
    throw new FrameworkMappingStateError(
      "evidenceQuote does not appear verbatim in the cited Finding record",
      MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_NOT_VERBATIM
    );
  }

  return buildEvidenceLocator(EVIDENCE_QUOTE_SOURCES.FINDING_RECORD, finding.id, located.field);
}

async function verifyAgainstRawReportRow(tx, content) {
  // Occurrences are the lifecycle bridge from a Finding back to the report rows
  // that produced it. Newest first: an analyst quoting "the report" almost
  // always means the most recent one.
  const occurrences = await tx.findingOccurrence.findMany({
    where: { findingId: content.evidenceFindingId },
    orderBy: [{ observedAt: "desc" }, { id: "desc" }],
    take: MAX_RAW_ROWS_SCANNED,
    select: { id: true },
  });

  if (occurrences.length === 0) {
    throw new FrameworkMappingStateError(
      "The cited Finding has no ingested report rows to quote from",
      MAPPING_REJECTION_CODES.EVIDENCE_SOURCE_RECORD_UNAVAILABLE
    );
  }

  const rows = await tx.rawReportRow.findMany({
    where: { findingOccurrenceId: { in: occurrences.map((occurrence) => occurrence.id) } },
    orderBy: [{ id: "desc" }],
    take: MAX_RAW_ROWS_SCANNED,
    select: { id: true, rawPayload: true, normalizedPayload: true },
  });

  if (rows.length === 0) {
    throw new FrameworkMappingStateError(
      "The cited Finding has no ingested report rows to quote from",
      MAPPING_REJECTION_CODES.EVIDENCE_SOURCE_RECORD_UNAVAILABLE
    );
  }

  for (const row of rows) {
    // rawPayload before normalizedPayload: the raw row is what the source
    // actually sent, and a quote found there is the stronger claim. The
    // normalized payload is this system's own interpretation, so it is searched
    // second and the locator says which one matched.
    const candidates = [
      ...flattenPayloadCandidates(row.rawPayload, "rawPayload"),
      ...flattenPayloadCandidates(row.normalizedPayload, "normalizedPayload"),
    ];
    const located = locateQuoteInCandidates(content.evidenceQuote, candidates);
    if (located) {
      return buildEvidenceLocator(EVIDENCE_QUOTE_SOURCES.RAW_REPORT_ROW, row.id, located.field);
    }
  }

  throw new FrameworkMappingStateError(
    "evidenceQuote does not appear verbatim in any ingested report row behind the cited Finding",
    MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_NOT_VERBATIM
  );
}

async function verifyAgainstCaseResponse(tx, caseId, content) {
  const responses = await tx.caseOrganizationResponse.findMany({
    where: { caseId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: MAX_RESPONSES_SCANNED,
    select: { id: true, summary: true, reference: true },
  });

  if (responses.length === 0) {
    throw new FrameworkMappingStateError(
      "This case has no recorded organization response to quote from",
      MAPPING_REJECTION_CODES.EVIDENCE_SOURCE_RECORD_UNAVAILABLE
    );
  }

  for (const response of responses) {
    const located = locateQuoteInCandidates(content.evidenceQuote, [
      { field: "summary", value: response.summary },
      { field: "reference", value: response.reference },
    ]);
    if (located) {
      return buildEvidenceLocator(EVIDENCE_QUOTE_SOURCES.CASE_RESPONSE, response.id, located.field);
    }
  }

  throw new FrameworkMappingStateError(
    "evidenceQuote does not appear verbatim in any organization response recorded on this case",
    MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_NOT_VERBATIM
  );
}

/**
 * Verifies the quote and returns the server-derived locator.
 *
 * @param {object} tx      an open Prisma transaction client
 * @param {number} caseId
 * @param {object} content normalized mapping content (already shape-validated
 *                         by frameworkMappingRules.normalizeMappingContent)
 * @returns {Promise<string>} "<source>:<recordId>:<field>"
 * @throws  {FrameworkMappingStateError} with a closed rejection code
 */
async function verifyEvidenceQuote(tx, caseId, content) {
  switch (content.evidenceQuoteSource) {
    case EVIDENCE_QUOTE_SOURCES.FINDING_RECORD:
      return verifyAgainstFindingRecord(tx, content);
    case EVIDENCE_QUOTE_SOURCES.RAW_REPORT_ROW:
      return verifyAgainstRawReportRow(tx, content);
    case EVIDENCE_QUOTE_SOURCES.CASE_RESPONSE:
      return verifyAgainstCaseResponse(tx, caseId, content);
    default:
      // Unreachable: the rules module validated this against a closed set
      // before any transaction opened. Present so that adding a fourth source
      // to the enum without writing its resolver fails CLOSED rather than
      // silently skipping verification.
      throw new FrameworkMappingStateError(
        "evidenceQuoteSource has no verification strategy",
        MAPPING_REJECTION_CODES.EVIDENCE_SOURCE_RECORD_UNAVAILABLE
      );
  }
}

module.exports = {
  MAX_RAW_ROWS_SCANNED,
  MAX_RESPONSES_SCANNED,
  findingQuoteCandidates,
  verifyEvidenceQuote,
};
