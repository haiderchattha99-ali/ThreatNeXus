"use strict";

// Pure-function row validator for the controlled development contract
// accessible-rdp.synthetic.v1 (NOT an official Shadowserver schema). Validates
// one already-parsed row object at a time; no CSV/stream parsing, no Prisma
// calls, no I/O. Callers (the future report parser) run this per row and
// persist the result onto RawReportRow.{status,normalizedPayload,
// validationErrors} themselves.

const { TransportProtocol, RawReportRowStatus } = require("@prisma/client");

const CONTRACT_VERSION = "accessible-rdp.synthetic.v1";

const REQUIRED_FIELDS = Object.freeze(["timestamp", "ip", "port", "protocol"]);
const OPTIONAL_FIELDS = Object.freeze(["hostname", "asn", "as_name", "country_code"]);
const KNOWN_FIELDS = Object.freeze([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

const ERROR_CODES = Object.freeze({
  REQUIRED_FIELD: "REQUIRED_FIELD",
  INVALID_TIMESTAMP: "INVALID_TIMESTAMP",
  TIMESTAMP_NOT_UTC: "TIMESTAMP_NOT_UTC",
  INVALID_IPV4: "INVALID_IPV4",
  INVALID_PORT: "INVALID_PORT",
  INVALID_PROTOCOL: "INVALID_PROTOCOL",
  INVALID_ASN: "INVALID_ASN",
  INVALID_COUNTRY_CODE: "INVALID_COUNTRY_CODE",
  FIELD_TOO_LONG: "FIELD_TOO_LONG",
  NULL_BYTE: "NULL_BYTE",
});

// Blanket guard applied to every raw field before any field-specific parsing,
// so an absurdly long junk value in any column (including required ones) is
// rejected up front rather than fed to a regex.
const GENERAL_MAX_FIELD_LENGTH = 4096;

// RFC 1035 max FQDN length.
const MAX_HOSTNAME_LENGTH = 253;
// as_name is free-text, non-authoritative metadata; conservative cap only.
const MAX_AS_NAME_LENGTH = 256;

// 4-byte ASN range (RFC 7300). asn is non-authoritative metadata, not
// ownership truth — see AGENTS.md ownership-mapping boundary.
const MAX_ASN = 4294967295;

const IPV4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
// Anchored, no leading zeros per octet (e.g. "01" is rejected rather than
// silently treated as "1") — deliberately conservative, matching the "never
// silently repair" rule for a security-relevant field.
const IPV4_PATTERN = new RegExp(`^${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}$`);

// Digits only: no sign, no decimal point, no exponent, no surrounding
// whitespace — Number("07e1") etc. never reaches here as a false positive.
const PORT_PATTERN = /^\d{1,5}$/;

// Requires an explicit offset group (Z or ±hh:mm) captured separately so
// "no timezone at all" and "has a non-UTC offset" can be told apart from
// "not shaped like a timestamp at all".
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|z|[+-]\d{2}:\d{2})?$/;

const ASN_PATTERN = /^(?:AS|as)?(\d+)$/;
const COUNTRY_CODE_PATTERN = /^[A-Za-z]{2}$/;

function makeError(field, code, message) {
  return { field, code, message };
}

function hasNullByte(value) {
  return value.includes("\u0000");
}

// Returns false (and pushes an error) when the raw value fails the universal
// safety gate. Field-specific validators skip further checks in that case.
function checkGeneralFieldSafety(field, value, errors) {
  if (hasNullByte(value)) {
    errors.push(makeError(field, ERROR_CODES.NULL_BYTE, `${field} contains a null byte`));
    return false;
  }
  if (value.length > GENERAL_MAX_FIELD_LENGTH) {
    errors.push(
      makeError(field, ERROR_CODES.FIELD_TOO_LONG, `${field} exceeds the maximum allowed length`)
    );
    return false;
  }
  return true;
}

function isPresentString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// Only Date.UTC's rollover behaviour (month 13 -> next January, day 30 in
// February, etc.) needs guarding against; the regex already fixed field widths.
function isValidUtcDateTime(year, month, day, hour, minute, second) {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

function validateTimestamp(rawRow, errors) {
  const raw = rawRow.timestamp;
  if (!isPresentString(raw)) {
    errors.push(makeError("timestamp", ERROR_CODES.REQUIRED_FIELD, "timestamp is required"));
    return null;
  }
  if (!checkGeneralFieldSafety("timestamp", raw, errors)) return null;

  const match = RFC3339_PATTERN.exec(raw);
  if (!match) {
    errors.push(
      makeError(
        "timestamp",
        ERROR_CODES.INVALID_TIMESTAMP,
        "timestamp is not a recognizable RFC 3339 value"
      )
    );
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[7];

  if (!isValidUtcDateTime(year, month, day, hour, minute, second)) {
    errors.push(
      makeError(
        "timestamp",
        ERROR_CODES.INVALID_TIMESTAMP,
        "timestamp is not a valid calendar date/time"
      )
    );
    return null;
  }

  const isExplicitUtc = offset !== undefined && (offset.toUpperCase() === "Z" || offset === "+00:00");
  if (!isExplicitUtc) {
    errors.push(
      makeError(
        "timestamp",
        ERROR_CODES.TIMESTAMP_NOT_UTC,
        "timestamp must carry an explicit UTC designator (Z or +00:00)"
      )
    );
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
}

function validateIp(rawRow, errors) {
  const raw = rawRow.ip;
  if (!isPresentString(raw)) {
    errors.push(makeError("ip", ERROR_CODES.REQUIRED_FIELD, "ip is required"));
    return null;
  }
  if (!checkGeneralFieldSafety("ip", raw, errors)) return null;

  const match = IPV4_PATTERN.exec(raw);
  if (!match) {
    errors.push(makeError("ip", ERROR_CODES.INVALID_IPV4, "ip is not a valid IPv4 address"));
    return null;
  }

  return [match[1], match[2], match[3], match[4]].map(Number).join(".");
}

function validatePort(rawRow, errors) {
  const raw = rawRow.port;
  if (!isPresentString(raw)) {
    errors.push(makeError("port", ERROR_CODES.REQUIRED_FIELD, "port is required"));
    return null;
  }
  if (!checkGeneralFieldSafety("port", raw, errors)) return null;

  if (!PORT_PATTERN.test(raw)) {
    errors.push(
      makeError(
        "port",
        ERROR_CODES.INVALID_PORT,
        "port must be a plain integer with no sign, decimal point or surrounding characters"
      )
    );
    return null;
  }

  const value = Number(raw);
  if (value < 1 || value > 65535) {
    errors.push(makeError("port", ERROR_CODES.INVALID_PORT, "port must be between 1 and 65535"));
    return null;
  }

  return value;
}

function validateProtocol(rawRow, errors) {
  const raw = rawRow.protocol;
  if (!isPresentString(raw)) {
    errors.push(makeError("protocol", ERROR_CODES.REQUIRED_FIELD, "protocol is required"));
    return null;
  }
  if (!checkGeneralFieldSafety("protocol", raw, errors)) return null;

  if (raw.toLowerCase() !== "tcp") {
    errors.push(
      makeError(
        "protocol",
        ERROR_CODES.INVALID_PROTOCOL,
        "protocol must be tcp for accessible-rdp.synthetic.v1"
      )
    );
    return null;
  }

  return TransportProtocol.TCP;
}

function validateHostname(rawRow, errors) {
  const raw = rawRow.hostname;
  if (raw === undefined || raw === null) return null;
  if (!checkGeneralFieldSafety("hostname", raw, errors)) return null;

  const trimmed = raw.trim();
  if (trimmed === "") return null;

  if (trimmed.length > MAX_HOSTNAME_LENGTH) {
    errors.push(
      makeError("hostname", ERROR_CODES.FIELD_TOO_LONG, "hostname exceeds the maximum allowed length")
    );
    return null;
  }

  // No DNS resolution, ever; hostname is display metadata only and never
  // participates in Finding identity.
  return trimmed;
}

function validateAsn(rawRow, errors) {
  const raw = rawRow.asn;
  if (raw === undefined || raw === null) return null;
  if (!checkGeneralFieldSafety("asn", raw, errors)) return null;

  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const match = ASN_PATTERN.exec(trimmed);
  if (!match) {
    errors.push(
      makeError(
        "asn",
        ERROR_CODES.INVALID_ASN,
        "asn must be a plain integer or an AS-prefixed integer (e.g. 12345 or AS12345)"
      )
    );
    return null;
  }

  const digits = match[1];
  if (digits.length > 1 && digits[0] === "0") {
    errors.push(makeError("asn", ERROR_CODES.INVALID_ASN, "asn must not have leading zeros"));
    return null;
  }

  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value > MAX_ASN) {
    errors.push(makeError("asn", ERROR_CODES.INVALID_ASN, "asn is out of the valid range"));
    return null;
  }

  // Normalized to a plain non-negative integer regardless of an "AS" prefix
  // on input — one documented representation, per the synthetic-v1 contract.
  // Non-authoritative metadata only; never treated as ownership truth.
  return value;
}

function validateAsName(rawRow, errors) {
  const raw = rawRow.as_name;
  if (raw === undefined || raw === null) return null;
  if (!checkGeneralFieldSafety("as_name", raw, errors)) return null;

  const trimmed = raw.trim();
  if (trimmed === "") return null;

  if (trimmed.length > MAX_AS_NAME_LENGTH) {
    errors.push(
      makeError("as_name", ERROR_CODES.FIELD_TOO_LONG, "as_name exceeds the maximum allowed length")
    );
    return null;
  }

  return trimmed;
}

function validateCountryCode(rawRow, errors) {
  const raw = rawRow.country_code;
  if (raw === undefined || raw === null) return null;
  if (!checkGeneralFieldSafety("country_code", raw, errors)) return null;

  const trimmed = raw.trim();
  if (trimmed === "") return null;

  if (!COUNTRY_CODE_PATTERN.test(trimmed)) {
    errors.push(
      makeError(
        "country_code",
        ERROR_CODES.INVALID_COUNTRY_CODE,
        "country_code must be exactly two ASCII letters"
      )
    );
    return null;
  }

  // No geopolitical/ownership claim — just the two-letter code as supplied.
  return trimmed.toUpperCase();
}

// Any known-field value that is neither a string, null, nor undefined is a
// caller contract violation (e.g. handing this a JSON row with a numeric
// port), not a data-quality problem — that is a programmer/system error and
// throws rather than producing a misleading INVALID result.
function assertRowShape(rawRow) {
  KNOWN_FIELDS.forEach((field) => {
    const value = rawRow[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new TypeError(
        `validateAccessibleRdpRow: field "${field}" must be a string, null, or undefined`
      );
    }
  });
}

/**
 * Validates one already-parsed accessible-rdp.synthetic.v1 row.
 *
 * Pure function: no Prisma calls, no I/O, no thrown exceptions for expected
 * validation failures (those are returned as structured errors). Throws only
 * on a caller contract violation (wrong argument shapes/types).
 *
 * @param {Object} rawRow - plain object keyed by the synthetic-v1 columns;
 *   every present value must be a string (CSV parsing convention).
 * @param {number} rowNumber - 1-based row number supplied by the caller.
 * @returns {{
 *   rowNumber: number,
 *   status: "VALID"|"INVALID",
 *   contractVersion: string,
 *   raw: Object,
 *   normalized: Object|null,
 *   errors: Array<{field: string, code: string, message: string}>,
 * }}
 */
function validateAccessibleRdpRow(rawRow, rowNumber) {
  if (rawRow === null || typeof rawRow !== "object" || Array.isArray(rawRow)) {
    throw new TypeError("validateAccessibleRdpRow: rawRow must be a plain object");
  }
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new TypeError("validateAccessibleRdpRow: rowNumber must be a positive integer");
  }
  assertRowShape(rawRow);

  const errors = [];

  const timestamp = validateTimestamp(rawRow, errors);
  const ip = validateIp(rawRow, errors);
  const port = validatePort(rawRow, errors);
  const protocol = validateProtocol(rawRow, errors);
  const hostname = validateHostname(rawRow, errors);
  const asn = validateAsn(rawRow, errors);
  const asName = validateAsName(rawRow, errors);
  const countryCode = validateCountryCode(rawRow, errors);

  const status = errors.length === 0 ? RawReportRowStatus.VALID : RawReportRowStatus.INVALID;

  const normalized =
    status === RawReportRowStatus.VALID
      ? {
          timestamp,
          ip,
          port,
          protocol,
          hostname,
          asn,
          asName,
          countryCode,
        }
      : null;

  return {
    rowNumber,
    status,
    contractVersion: CONTRACT_VERSION,
    raw: rawRow,
    normalized,
    errors,
  };
}

module.exports = {
  CONTRACT_VERSION,
  REQUIRED_FIELDS,
  OPTIONAL_FIELDS,
  KNOWN_FIELDS,
  ERROR_CODES,
  validateAccessibleRdpRow,
};
