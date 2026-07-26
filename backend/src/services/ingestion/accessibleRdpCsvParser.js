"use strict";

// Structural CSV parser for the controlled development contract
// accessible-rdp.synthetic.v1 (NOT an official Shadowserver schema).
// Deliberately separate from row *validation* (P1-T2, accessibleRdpRowValidator.js):
// this module only establishes whether the uploaded bytes are a well-formed
// CSV report with a recognizable header, and if so, splits them into raw
// per-row objects. It never decides whether a cell's *value* is valid — that
// is exactly what P1-T2 does next, per row.
//
// Pure function: takes the exact uploaded Buffer, does no I/O, no Prisma
// calls, throws only on a caller contract violation (wrong argument type).
// Every other failure mode (bad UTF-8, missing headers, malformed quoting,
// row-count overflow, ...) is a structural rejection and comes back as a
// data result, never a thrown exception — mirroring the "no thrown exception
// for expected validation failures" rule the row validator already follows.

const { REQUIRED_FIELDS: REQUIRED_ROW_FIELDS } = require("./accessibleRdpRowValidator");

const CONTRACT_VERSION = "accessible-rdp.synthetic.v1";

const REQUIRED_HEADERS = Object.freeze([...REQUIRED_ROW_FIELDS]);

const DEFAULT_MAX_DATA_ROWS = 5000;

const PARSE_ERROR_CODES = Object.freeze({
  INVALID_UTF8: "INVALID_UTF8",
  EMPTY_FILE: "EMPTY_FILE",
  HEADER_ONLY: "HEADER_ONLY",
  MISSING_REQUIRED_HEADERS: "MISSING_REQUIRED_HEADERS",
  DUPLICATE_HEADER: "DUPLICATE_HEADER",
  NULL_BYTE_IN_HEADER: "NULL_BYTE_IN_HEADER",
  MALFORMED_CSV: "MALFORMED_CSV",
  ROW_LIMIT_EXCEEDED: "ROW_LIMIT_EXCEEDED",
});

// Written via String.fromCharCode rather than a literal escape in source, so
// there is no ambiguity about what character this file actually contains.
const NULL_BYTE = String.fromCharCode(0);
const BOM_CHAR_CODE = 0xfeff;

class CsvStructureError extends Error {}
class CsvRowLimitExceededError extends Error {}

function rejected(code, message) {
  return { ok: false, code, message, contractVersion: CONTRACT_VERSION };
}

// Single-pass RFC 4180-style tokenizer. A quote is only meaningful at the
// very start of a field (opens a quoted field); "" inside a quoted field is
// an escaped literal quote; an unterminated quote at end-of-input, or a bare
// quote appearing after other unquoted content in the same field, is
// malformed and throws CsvStructureError rather than guessing intent. A
// newline, a CRLF pair, and a bare CR are all treated as one record
// separator — but only outside an open quote, so a legitimate embedded
// newline inside a quoted field is preserved as data.
//
// maxDataRows bounds work done: parsing stops (throwing
// CsvRowLimitExceededError) the moment more than maxDataRows records after
// the header have been produced, rather than fully tokenizing an arbitrarily
// large payload before rejecting it.
function tokenizeCsv(text, maxDataRows) {
  const records = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  function pushField() {
    record.push(field);
    field = "";
  }

  function pushRecord() {
    pushField();
    records.push(record);
    record = [];
    // records.length includes the header once it exists; guard once at least
    // one record (the header) is present.
    if (records.length - 1 > maxDataRows) {
      throw new CsvRowLimitExceededError(
        `report exceeds the maximum of ${maxDataRows} data rows`
      );
    }
  }

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      if (field.length !== 0) {
        throw new CsvStructureError(
          "malformed quoting: unexpected quote inside an unquoted field"
        );
      }
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }

    if (ch === "\r") {
      pushRecord();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }

    if (ch === "\n") {
      pushRecord();
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (inQuotes) {
    throw new CsvStructureError("malformed quoting: unterminated quoted field");
  }

  // Trailing content with no final line break still forms the last record.
  if (field !== "" || record.length > 0) {
    pushRecord();
  }

  return records;
}

function hasNullByte(value) {
  return typeof value === "string" && value.indexOf(NULL_BYTE) !== -1;
}

function findDuplicateHeaders(headerRow) {
  const seen = new Set();
  const duplicates = new Set();
  headerRow.forEach((name) => {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  });
  return [...duplicates];
}

/**
 * Parses the exact uploaded bytes of an accessible-rdp.synthetic.v1 CSV
 * report into raw per-row objects, ready to be handed one at a time to
 * validateAccessibleRdpRow. Never mutates or hashes fileBytes; the caller is
 * responsible for preserving the same Buffer as RawReport.rawContent.
 *
 * @param {Buffer} fileBytes - the exact uploaded bytes.
 * @param {{maxDataRows?: number}} [options]
 * @returns {
 *   {ok: true, contractVersion: string, headers: string[],
 *    rows: {rowNumber: number, rawRow: Object}[]} |
 *   {ok: false, code: string, message: string, contractVersion: string}
 * }
 */
function parseAccessibleRdpCsv(fileBytes, options = {}) {
  if (!Buffer.isBuffer(fileBytes)) {
    throw new TypeError("parseAccessibleRdpCsv: fileBytes must be a Buffer");
  }

  const maxDataRows =
    Number.isInteger(options.maxDataRows) && options.maxDataRows > 0
      ? options.maxDataRows
      : DEFAULT_MAX_DATA_ROWS;

  let text;
  try {
    // fatal: true rejects any byte sequence that is not valid UTF-8, rather
    // than silently substituting the replacement character for bad bytes.
    text = new TextDecoder("utf-8", { fatal: true }).decode(fileBytes);
  } catch (error) {
    return rejected(PARSE_ERROR_CODES.INVALID_UTF8, "file is not valid UTF-8");
  }

  // Exactly one leading BOM is stripped for parsing only. fileBytes itself
  // (what becomes RawReport.rawContent) is never touched.
  if (text.length > 0 && text.charCodeAt(0) === BOM_CHAR_CODE) {
    text = text.slice(1);
  }

  let records;
  try {
    records = tokenizeCsv(text, maxDataRows);
  } catch (error) {
    if (error instanceof CsvRowLimitExceededError) {
      return rejected(PARSE_ERROR_CODES.ROW_LIMIT_EXCEEDED, error.message);
    }
    if (error instanceof CsvStructureError) {
      return rejected(PARSE_ERROR_CODES.MALFORMED_CSV, error.message);
    }
    throw error;
  }

  if (records.length === 0) {
    return rejected(PARSE_ERROR_CODES.EMPTY_FILE, "file is empty");
  }

  const headerRow = records[0];

  if (headerRow.some(hasNullByte)) {
    return rejected(PARSE_ERROR_CODES.NULL_BYTE_IN_HEADER, "header row contains a null byte");
  }

  const duplicates = findDuplicateHeaders(headerRow);
  if (duplicates.length > 0) {
    return rejected(
      PARSE_ERROR_CODES.DUPLICATE_HEADER,
      `duplicate header name(s): ${duplicates.join(", ")}`
    );
  }

  const missingHeaders = REQUIRED_HEADERS.filter((name) => !headerRow.includes(name));
  if (missingHeaders.length > 0) {
    return rejected(
      PARSE_ERROR_CODES.MISSING_REQUIRED_HEADERS,
      `missing required header(s): ${missingHeaders.join(", ")}`
    );
  }

  if (records.length === 1) {
    return rejected(PARSE_ERROR_CODES.HEADER_ONLY, "report has a header row but no data rows");
  }

  const dataRecords = records.slice(1);
  const rows = [];
  for (let index = 0; index < dataRecords.length; index += 1) {
    const record = dataRecords[index];

    // More fields than named columns has no header to attribute the extra
    // value to — a structural inconsistency (typically unescaped quoting),
    // not an ordinary row-level data problem. Fewer fields is tolerated: a
    // missing trailing column simply becomes undefined for that field, which
    // validateAccessibleRdpRow already treats as REQUIRED_FIELD/optional-absent
    // on that specific row — an ordinary invalid row, not a report rejection.
    if (record.length > headerRow.length) {
      return rejected(
        PARSE_ERROR_CODES.MALFORMED_CSV,
        `data row ${index + 1} has more fields than the header row`
      );
    }

    // A short row's missing trailing columns are omitted entirely (never
    // assigned as an explicit `undefined` property). This matters beyond
    // style: an object with an explicit undefined-valued key has that key in
    // Object.keys(), but the same object round-tripped through a Postgres
    // Json column will not — omitting it here keeps a freshly-parsed row
    // structurally identical to one reloaded from RawReportRow.rawPayload,
    // which the ingestion orchestrator's retry-integrity check depends on.
    const rawRow = {};
    headerRow.forEach((name, columnIndex) => {
      if (columnIndex < record.length) {
        rawRow[name] = record[columnIndex];
      }
    });

    rows.push({ rowNumber: index + 1, rawRow });
  }

  return { ok: true, contractVersion: CONTRACT_VERSION, headers: headerRow, rows };
}

module.exports = {
  CONTRACT_VERSION,
  REQUIRED_HEADERS,
  DEFAULT_MAX_DATA_ROWS,
  PARSE_ERROR_CODES,
  parseAccessibleRdpCsv,
};
