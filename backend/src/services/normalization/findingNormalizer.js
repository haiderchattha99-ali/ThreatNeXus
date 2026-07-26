"use strict";

// Pure conversion of a VALID accessibleRdpRowValidator result into the exact
// Finding identity + observation payload the dedup service needs. No CSV/row
// parsing (that's P1-T2), no Prisma calls, no I/O. Deliberately does not
// re-validate anything the row validator already checked.

const { ReportType, RawReportRowStatus } = require("@prisma/client");

// Fixed for this normalizer: it only ever produces Accessible-RDP identities.
// A second report type gets its own normalizer, not a parameter here.
const REPORT_TYPE = ReportType.ACCESSIBLE_RDP;

/**
 * Converts a VALID `validateAccessibleRdpRow` result into the exact Finding
 * identity fields (indicatorValue, port, protocol, reportType) plus the
 * observation time (observedAt) — deliberately excludes hostname/asn/as_name/
 * country_code, none of which are part of Finding identity or are copied onto
 * a Finding. observedAt comes from the row's own (already-UTC-normalized)
 * timestamp, never from upload/ingestion time.
 *
 * Pure and deterministic: same input always produces the same output. Throws
 * a TypeError for anything that isn't a VALID validator result — an INVALID
 * row, a malformed object, or a missing normalized payload — since that is a
 * caller contract violation, not a data-quality condition for this function
 * to handle.
 *
 * @param {{status:string, normalized:{ip:string, port:number, protocol:string,
 *   timestamp:string}}} validatorResult - a VALID result from
 *   validateAccessibleRdpRow.
 * @returns {{indicatorValue:string, port:number, protocol:string,
 *   reportType:string, observedAt:Date}}
 */
function normalizeAccessibleRdpFindingIdentity(validatorResult) {
  if (!validatorResult || typeof validatorResult !== "object") {
    throw new TypeError("normalizeAccessibleRdpFindingIdentity: validatorResult must be an object");
  }
  if (validatorResult.status !== RawReportRowStatus.VALID) {
    throw new TypeError(
      "normalizeAccessibleRdpFindingIdentity: validatorResult must have status VALID"
    );
  }

  const normalized = validatorResult.normalized;
  if (!normalized || typeof normalized !== "object") {
    throw new TypeError(
      "normalizeAccessibleRdpFindingIdentity: validatorResult.normalized is missing"
    );
  }

  const { ip, port, protocol, timestamp } = normalized;
  if (typeof ip !== "string" || ip === "") {
    throw new TypeError("normalizeAccessibleRdpFindingIdentity: normalized.ip must be a non-empty string");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("normalizeAccessibleRdpFindingIdentity: normalized.port must be an integer 1-65535");
  }
  if (typeof protocol !== "string" || protocol === "") {
    throw new TypeError(
      "normalizeAccessibleRdpFindingIdentity: normalized.protocol must be a non-empty string"
    );
  }
  if (typeof timestamp !== "string" || timestamp === "") {
    throw new TypeError(
      "normalizeAccessibleRdpFindingIdentity: normalized.timestamp must be a non-empty string"
    );
  }

  const observedAt = new Date(timestamp);
  if (Number.isNaN(observedAt.getTime())) {
    throw new TypeError(
      "normalizeAccessibleRdpFindingIdentity: normalized.timestamp is not a parseable date"
    );
  }

  return {
    indicatorValue: ip,
    port,
    protocol,
    reportType: REPORT_TYPE,
    observedAt,
  };
}

module.exports = {
  REPORT_TYPE,
  normalizeAccessibleRdpFindingIdentity,
};
