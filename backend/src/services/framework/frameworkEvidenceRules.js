"use strict";

// Evidence integrity for framework mappings (Phase 6.3). Pure and
// dependency-free: no Prisma, no clock, no network.
//
// ===========================================================================
// What the build guard requires, and what Phase 5 actually stored
// ===========================================================================
// The locked architecture requires every mapping to store a framework version,
// an evidence reference, a VERBATIM EVIDENCE QUOTE, an explanation, and TWO
// SEPARATE confidence values. Phase 5 stored the version, the reference, and
// the explanation. It stored no quote and no confidence at all. That gap is
// what this module closes.
//
// ===========================================================================
// Why a verbatim quote, and not a summary
// ===========================================================================
// A rationale is the analyst's argument. A quote is the thing the argument is
// about. Without one, "the RDP session was established from an external
// address" is unfalsifiable prose: a reviewer cannot tell whether it restates
// something in the record or was written from memory, and neither can an
// auditor six months later.
//
// So the quote must occur CHARACTER FOR CHARACTER in a specific, named source
// record. The service resolves the record from the database and performs the
// match; this module decides the shape, the bounds, and which sources are
// coherent with which evidence. A quote that cannot be found is a 409 — the
// input was well formed, the record simply does not say that.
//
// Only whitespace is normalized before comparison (runs collapsed, ends
// trimmed), because a value copied out of a table or a JSON payload routinely
// arrives with different spacing and that is not a substantive difference.
// Nothing else is normalized: case, punctuation, digits and ordering must match
// exactly, or "verbatim" would be a claim this module does not actually check.
//
// ===========================================================================
// Two confidences, never one
// ===========================================================================
// evidenceConfidence answers "how sure am I this record says what I think it
// says?". mappingConfidence answers "how sure am I that this framework
// reference is the right one for it?". They fail independently — a perfectly
// clear log line can support a shaky technique attribution, and a strong
// technique match can rest on an ambiguous record.
//
// They are stored in separate columns and are NEVER combined. Nothing in this
// repository averages them, multiplies them, takes their minimum, or derives a
// single "confidence" from the pair. Collapsing them would destroy exactly the
// distinction that makes them worth recording, and would invite a downstream
// threshold — which would in turn create pressure to inflate whichever input
// moved the composite. tests/unit/frameworkEvidenceRules.test.js asserts the
// absence of any such combinator.

const {
  MAPPING_REJECTION_CODES,
  FrameworkMappingValidationError,
} = require("./frameworkMappingErrors");

// Ordered weakest to strongest for DISPLAY only. Nothing compares two of these
// to a threshold, and no code path treats LOW as a reason to refuse a mapping:
// an honestly-declared low confidence is a better record than a coerced high
// one, and refusing it would simply teach analysts to always pick HIGH.
const CONFIDENCE_LEVELS = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
});

const CONFIDENCE_LEVEL_VALUES = Object.freeze(Object.values(CONFIDENCE_LEVELS));

// Which record the quote must be found in. A closed set: each value names a
// resolution strategy that frameworkEvidenceService implements, and a fourth
// value cannot appear without someone writing the code that resolves it.
const EVIDENCE_QUOTE_SOURCES = Object.freeze({
  // The Finding's own normalized fields (indicator, port, protocol, report
  // type, observation timestamps, counts).
  FINDING_RECORD: "FINDING_RECORD",
  // The raw ingested report row(s) behind that Finding's occurrences — the
  // closest thing this system holds to the original Shadowserver-style data.
  RAW_REPORT_ROW: "RAW_REPORT_ROW",
  // An analyst-recorded organization response on this case.
  CASE_RESPONSE: "CASE_RESPONSE",
});

const EVIDENCE_QUOTE_SOURCE_VALUES = Object.freeze(Object.values(EVIDENCE_QUOTE_SOURCES));

// The two Finding-anchored sources cannot be resolved without knowing WHICH
// Finding. Enforced structurally rather than left to the service, so a
// malformed combination is a 400 at the boundary and never opens a transaction.
const FINDING_ANCHORED_QUOTE_SOURCES = Object.freeze([
  EVIDENCE_QUOTE_SOURCES.FINDING_RECORD,
  EVIDENCE_QUOTE_SOURCES.RAW_REPORT_ROW,
]);

// A quote short enough to appear by coincidence proves nothing. "22" occurs in
// almost any record; twelve characters is roughly the point at which a match
// starts to be evidence rather than a collision. The ceiling stops a caller
// from pasting an entire record and calling it a quote.
const MIN_EVIDENCE_QUOTE_LENGTH = 12;
const MAX_EVIDENCE_QUOTE_LENGTH = 500;

/**
 * Comparison form for verbatim matching: trimmed, with internal whitespace runs
 * collapsed to one space. Case and punctuation are deliberately preserved.
 */
function normalizeQuoteForComparison(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

/**
 * True when `quote` occurs verbatim in `haystack`, under whitespace
 * normalization only.
 *
 * An empty or whitespace-only quote never matches, so a caller cannot satisfy
 * the check with a value that would be a substring of everything.
 */
function quoteAppearsVerbatim(quote, haystack) {
  if (typeof quote !== "string" || typeof haystack !== "string") return false;
  const needle = normalizeQuoteForComparison(quote);
  if (needle.length === 0) return false;
  return normalizeQuoteForComparison(haystack).includes(needle);
}

/**
 * Searches a set of named candidate fields and returns the FIRST that contains
 * the quote, as `{ field, value }`, or null.
 *
 * Returning the field name is what makes the stored evidence locator precise:
 * "verbatim in rawReportRow 88, field `asn`" is checkable by a reviewer,
 * "verbatim somewhere in the evidence" is not. Candidates are searched in the
 * order given, so the caller controls which field wins a tie.
 *
 * @param {string} quote
 * @param {Array<{field:string, value:unknown}>} candidates
 */
function locateQuoteInCandidates(quote, candidates) {
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.field !== "string") continue;
    if (typeof candidate.value !== "string") continue;
    if (quoteAppearsVerbatim(quote, candidate.value)) {
      return { field: candidate.field, value: candidate.value };
    }
  }
  return null;
}

/**
 * Flattens a JSON payload into quotable `{field, value}` candidates.
 *
 * Used for RawReportRow.rawPayload / normalizedPayload, which are ingested
 * third-party data of no fixed shape. Scalars are stringified so a numeric port
 * or an ASN is quotable; nested objects are walked with a dotted path so the
 * locator still names one specific field. Arrays are indexed for the same
 * reason.
 *
 * Depth-bounded: ingested data is untrusted, and an adversarial or merely
 * pathological payload must not be able to turn one mapping request into an
 * unbounded traversal.
 */
function flattenPayloadCandidates(payload, prefix = "", depth = 0, accumulated = []) {
  const MAX_DEPTH = 4;
  const MAX_CANDIDATES = 200;
  if (depth > MAX_DEPTH || accumulated.length >= MAX_CANDIDATES) return accumulated;
  if (payload === null || payload === undefined) return accumulated;

  if (typeof payload === "string" || typeof payload === "number" || typeof payload === "boolean") {
    accumulated.push({ field: prefix || "value", value: String(payload) });
    return accumulated;
  }

  if (Array.isArray(payload)) {
    payload.forEach((entry, index) => {
      flattenPayloadCandidates(entry, `${prefix}[${index}]`, depth + 1, accumulated);
    });
    return accumulated;
  }

  if (typeof payload === "object") {
    Object.keys(payload)
      .sort()
      .forEach((key) => {
        flattenPayloadCandidates(
          payload[key],
          prefix ? `${prefix}.${key}` : key,
          depth + 1,
          accumulated
        );
      });
  }
  return accumulated;
}

function assertConfidence(value, field, code) {
  if (value === undefined || value === null || value === "") {
    throw new FrameworkMappingValidationError(`${field} is required`, [field], code);
  }
  if (!CONFIDENCE_LEVEL_VALUES.includes(value)) {
    throw new FrameworkMappingValidationError(
      `${field} must be one of ${CONFIDENCE_LEVEL_VALUES.join(", ")}`,
      [field],
      code
    );
  }
  return value;
}

/**
 * Normalizes and validates the evidence-integrity portion of a mapping.
 *
 * Everything decidable WITHOUT the database happens here. The verbatim match
 * itself needs the source record and therefore lives in the service, which
 * re-reads the record inside the write transaction.
 *
 * @param {object} raw
 * @param {string|null} raw.evidenceQuote
 * @param {string|null} raw.evidenceQuoteSource
 * @param {string|null} raw.evidenceConfidence
 * @param {string|null} raw.mappingConfidence
 * @param {number|null} raw.evidenceFindingId  already normalized by the caller
 */
function normalizeEvidenceIntegrity(raw) {
  const quoteSource = raw.evidenceQuoteSource;
  if (quoteSource === undefined || quoteSource === null || quoteSource === "") {
    throw new FrameworkMappingValidationError(
      "evidenceQuoteSource is required",
      ["evidenceQuoteSource"],
      MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_REQUIRED
    );
  }
  if (!EVIDENCE_QUOTE_SOURCE_VALUES.includes(quoteSource)) {
    throw new FrameworkMappingValidationError(
      `evidenceQuoteSource must be one of ${EVIDENCE_QUOTE_SOURCE_VALUES.join(", ")}`,
      ["evidenceQuoteSource"],
      MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_REQUIRED
    );
  }

  if (typeof raw.evidenceQuote !== "string" || raw.evidenceQuote.trim() === "") {
    throw new FrameworkMappingValidationError(
      "evidenceQuote is required: a mapping must quote the record it rests on",
      ["evidenceQuote"],
      MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_REQUIRED
    );
  }

  // Trimmed but NOT otherwise rewritten. The stored value is what the analyst
  // claimed to be quoting, and rewriting it would make the stored text and the
  // verified text two different strings.
  const evidenceQuote = raw.evidenceQuote.trim();

  // Rejected rather than stripped, the same choice normalizeBoundedText makes: a
  // stripped quote would no longer be the text the analyst claimed to quote.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(evidenceQuote)) {
    throw new FrameworkMappingValidationError(
      "evidenceQuote must not contain control characters",
      ["evidenceQuote"],
      MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_REQUIRED
    );
  }
  if (evidenceQuote.length > MAX_EVIDENCE_QUOTE_LENGTH) {
    throw new FrameworkMappingValidationError(
      `evidenceQuote must be at most ${MAX_EVIDENCE_QUOTE_LENGTH} characters`,
      ["evidenceQuote"],
      MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_REQUIRED
    );
  }
  if (normalizeQuoteForComparison(evidenceQuote).length < MIN_EVIDENCE_QUOTE_LENGTH) {
    throw new FrameworkMappingValidationError(
      `evidenceQuote must be at least ${MIN_EVIDENCE_QUOTE_LENGTH} characters: a shorter fragment can match a record by coincidence`,
      ["evidenceQuote"],
      MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_TOO_SHORT
    );
  }

  if (
    FINDING_ANCHORED_QUOTE_SOURCES.includes(quoteSource) &&
    (raw.evidenceFindingId === null || raw.evidenceFindingId === undefined)
  ) {
    throw new FrameworkMappingValidationError(
      `evidenceQuoteSource ${quoteSource} requires evidenceFindingId, because the quote must be located in a specific Finding`,
      ["evidenceFindingId"],
      MAPPING_REJECTION_CODES.EVIDENCE_SOURCE_REQUIRES_FINDING
    );
  }

  const evidenceConfidence = assertConfidence(
    raw.evidenceConfidence,
    "evidenceConfidence",
    MAPPING_REJECTION_CODES.EVIDENCE_CONFIDENCE_REQUIRED
  );
  const mappingConfidence = assertConfidence(
    raw.mappingConfidence,
    "mappingConfidence",
    MAPPING_REJECTION_CODES.MAPPING_CONFIDENCE_REQUIRED
  );

  return Object.freeze({
    evidenceQuote,
    evidenceQuoteSource: quoteSource,
    evidenceConfidence,
    mappingConfidence,
  });
}

/**
 * A stored, checkable pointer to exactly where the quote was verified.
 *
 * Format: "<source>:<recordId>:<field>", e.g. "RAW_REPORT_ROW:88:asn". Built by
 * the SERVER from the record it actually matched against — never accepted from
 * a caller, because a client-supplied locator would be an unverified claim
 * wearing the costume of a verified one.
 */
function buildEvidenceLocator(source, recordId, field) {
  return `${source}:${recordId}:${field}`;
}

module.exports = {
  CONFIDENCE_LEVELS,
  CONFIDENCE_LEVEL_VALUES,
  EVIDENCE_QUOTE_SOURCES,
  EVIDENCE_QUOTE_SOURCE_VALUES,
  FINDING_ANCHORED_QUOTE_SOURCES,
  MIN_EVIDENCE_QUOTE_LENGTH,
  MAX_EVIDENCE_QUOTE_LENGTH,
  normalizeQuoteForComparison,
  quoteAppearsVerbatim,
  locateQuoteInCandidates,
  flattenPayloadCandidates,
  normalizeEvidenceIntegrity,
  buildEvidenceLocator,
};
