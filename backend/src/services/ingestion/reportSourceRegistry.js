"use strict";

// Trusted report-source registry (P1-T6a). Verifies that a
// (source, reportType, schemaVersion) tuple is a known, approved ingestion
// contract — distinct from CSV structural parsing and per-row validation,
// which only check that the *bytes* are well-formed, never who they claim to
// be from.
//
// Deliberately NOT a ReportSchema Prisma model / database-configured
// registry: with exactly one approved contract for the whole MVP, a
// database-backed registry would be premature machinery (the same reasoning
// schema.prisma already recorded for deferring a ReportSchema model in
// P1-T1). This is a small, code-level, additive-only registry instead — no
// migration, no Prisma access, no filesystem access, pure function only.
//
// Security-critical: `source` is never a value a client can supply. It is
// chosen by the server (the controller — see reportIngestionController.js)
// and passed explicitly into the ingestion service. A multipart field,
// filename, CSV column, or header must never be read as a claimed source
// identity; nothing in this module or its callers accepts one from the
// request.

const { ReportType } = require("@prisma/client");
const { CONTRACT_VERSION: ACCESSIBLE_RDP_SCHEMA_VERSION } = require("./accessibleRdpRowValidator");

// The only server-controlled source identifiers this repository recognizes.
// Adding a second source (e.g. an eventual SHADOWSERVER/PKCERT connector) is
// an additive change here, not a rewrite.
const REPORT_SOURCES = Object.freeze({
  SYNTHETIC_UPLOAD: "SYNTHETIC_UPLOAD",
});

// The single approved MVP contract. reportType/schemaVersion are sourced from
// the existing generated enum / row-validator constant so this registry
// cannot silently drift from them.
const TRUSTED_REPORT_CONTRACTS = Object.freeze([
  Object.freeze({
    source: REPORT_SOURCES.SYNTHETIC_UPLOAD,
    reportType: ReportType.ACCESSIBLE_RDP,
    schemaVersion: ACCESSIBLE_RDP_SCHEMA_VERSION,
  }),
]);

const REASON_CODES = Object.freeze({
  UNTRUSTED_SOURCE_REPORT_COMBINATION: "UNTRUSTED_SOURCE_REPORT_COMBINATION",
});

// Fixed, generic message only — this never echoes back what the caller sent,
// and never enumerates the registry's contents (that would hand an attacker
// the exact tuple needed to pass validation next time).
const UNTRUSTED_MESSAGE = "This report source, type, or schema version is not trusted for ingestion.";

// Exact, case-sensitive, no trimming/coercion/fuzzy matching: "Synthetic_Upload"
// or " SYNTHETIC_UPLOAD" are not the same tuple as SYNTHETIC_UPLOAD. All three
// fields are required; matching only one or two is not sufficient.
function isTrustedReportContract(tuple) {
  if (!tuple || typeof tuple !== "object") return false;
  const { source, reportType, schemaVersion } = tuple;
  if (
    typeof source !== "string" ||
    typeof reportType !== "string" ||
    typeof schemaVersion !== "string"
  ) {
    return false;
  }
  return TRUSTED_REPORT_CONTRACTS.some(
    (contract) =>
      contract.source === source &&
      contract.reportType === reportType &&
      contract.schemaVersion === schemaVersion
  );
}

// Pure validation result, mirroring the { ok, code, message } shape already
// used by accessibleRdpCsvParser.js for expected (non-exceptional) rejection
// outcomes — no Prisma access, no filesystem access, throws only if `tuple`
// itself isn't an object (a caller contract violation, not a data condition).
function validateReportSource(tuple) {
  if (!tuple || typeof tuple !== "object") {
    throw new TypeError("validateReportSource: tuple must be an object");
  }
  if (isTrustedReportContract(tuple)) {
    return { ok: true };
  }
  return {
    ok: false,
    code: REASON_CODES.UNTRUSTED_SOURCE_REPORT_COMBINATION,
    message: UNTRUSTED_MESSAGE,
  };
}

module.exports = {
  REPORT_SOURCES,
  TRUSTED_REPORT_CONTRACTS,
  REASON_CODES,
  isTrustedReportContract,
  validateReportSource,
};
