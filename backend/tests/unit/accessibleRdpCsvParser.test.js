import { describe, it, expect } from "vitest";

const {
  DEFAULT_MAX_DATA_ROWS,
  PARSE_ERROR_CODES,
  parseAccessibleRdpCsv,
} = require("../../src/services/ingestion/accessibleRdpCsvParser");

const HEADER = "timestamp,ip,port,protocol,hostname,asn,as_name,country_code";
const NUL = String.fromCharCode(0);

function csvBuffer(text) {
  return Buffer.from(text, "utf8");
}

describe("parseAccessibleRdpCsv — well-formed input", () => {
  it("parses valid headers and rows", () => {
    const csv = `${HEADER}\n2026-01-01T00:00:00Z,203.0.113.10,3389,tcp,host1,64500,Example ASN,US\n`;
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.ok).toBe(true);
    expect(result.contractVersion).toBe("accessible-rdp.synthetic.v1");
    expect(result.headers).toEqual([
      "timestamp",
      "ip",
      "port",
      "protocol",
      "hostname",
      "asn",
      "as_name",
      "country_code",
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
      rowNumber: 1,
      rawRow: {
        timestamp: "2026-01-01T00:00:00Z",
        ip: "203.0.113.10",
        port: "3389",
        protocol: "tcp",
        hostname: "host1",
        asn: "64500",
        as_name: "Example ASN",
        country_code: "US",
      },
    });
  });

  it("strips exactly one leading UTF-8 BOM for parsing without touching row content", () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const csv = Buffer.concat([
      bom,
      csvBuffer("timestamp,ip,port,protocol\n2026-01-01T00:00:00Z,203.0.113.10,3389,tcp\n"),
    ]);
    const result = parseAccessibleRdpCsv(csv);

    expect(result.ok).toBe(true);
    expect(result.headers[0]).toBe("timestamp");
    expect(result.rows[0].rawRow.timestamp).toBe("2026-01-01T00:00:00Z");
  });

  it("accepts and preserves unknown extra columns without affecting known fields", () => {
    const csv = "timestamp,ip,port,protocol,extra_col\n2026-01-01T00:00:00Z,203.0.113.10,3389,tcp,unexpected\n";
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.ok).toBe(true);
    expect(result.headers).toContain("extra_col");
    expect(result.rows[0].rawRow).toEqual({
      timestamp: "2026-01-01T00:00:00Z",
      ip: "203.0.113.10",
      port: "3389",
      protocol: "tcp",
      extra_col: "unexpected",
    });
  });

  it("assigns deterministic 1-based data row numbers regardless of row count", () => {
    const csv =
      "timestamp,ip,port,protocol\n" +
      "2026-01-01T00:00:00Z,203.0.113.1,1,tcp\n" +
      "2026-01-01T00:00:01Z,203.0.113.2,2,tcp\n" +
      "2026-01-01T00:00:02Z,203.0.113.3,3,tcp\n";
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.rows.map((r) => r.rowNumber)).toEqual([1, 2, 3]);
  });

  it("handles quoted fields with embedded commas and escaped quotes", () => {
    const csv = 'timestamp,ip,port,protocol,as_name\n2026-01-01T00:00:00Z,203.0.113.10,3389,tcp,"Example, ""Quoted"" ASN"\n';
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.ok).toBe(true);
    expect(result.rows[0].rawRow.as_name).toBe('Example, "Quoted" ASN');
  });

  it("tolerates a short row by leaving missing trailing fields undefined", () => {
    const csv = "timestamp,ip,port,protocol,hostname\n2026-01-01T00:00:00Z,203.0.113.10,3389,tcp\n";
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.ok).toBe(true);
    expect(result.rows[0].rawRow.hostname).toBeUndefined();
  });
});

describe("parseAccessibleRdpCsv — structural rejections", () => {
  it("rejects a missing required header", () => {
    const csv = "timestamp,ip,port\n2026-01-01T00:00:00Z,203.0.113.10,3389\n";
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PARSE_ERROR_CODES.MISSING_REQUIRED_HEADERS);
    expect(result.message).toMatch(/protocol/);
  });

  it("rejects a duplicate header name", () => {
    const csv = "timestamp,ip,port,protocol,ip\n2026-01-01T00:00:00Z,203.0.113.10,3389,tcp,203.0.113.11\n";
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PARSE_ERROR_CODES.DUPLICATE_HEADER);
    expect(result.message).toMatch(/ip/);
  });

  it("rejects a null byte in the header", () => {
    const csv = `time${NUL}stamp,ip,port,protocol\n2026-01-01T00:00:00Z,203.0.113.10,3389,tcp\n`;
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PARSE_ERROR_CODES.NULL_BYTE_IN_HEADER);
  });

  it("rejects invalid UTF-8 bytes", () => {
    // 0xFF is not a valid UTF-8 lead byte in any position.
    const invalid = Buffer.concat([csvBuffer(HEADER + "\n"), Buffer.from([0xff, 0xfe, 0x00, 0x01])]);
    const result = parseAccessibleRdpCsv(invalid);

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PARSE_ERROR_CODES.INVALID_UTF8);
  });

  it("rejects an empty file", () => {
    const result = parseAccessibleRdpCsv(Buffer.alloc(0));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PARSE_ERROR_CODES.EMPTY_FILE);
  });

  it("rejects a header-only file (no data rows)", () => {
    const result = parseAccessibleRdpCsv(csvBuffer(`${HEADER}\n`));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PARSE_ERROR_CODES.HEADER_ONLY);
  });

  it("rejects a header-only file with no trailing newline", () => {
    const result = parseAccessibleRdpCsv(csvBuffer(HEADER));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PARSE_ERROR_CODES.HEADER_ONLY);
  });

  it("rejects malformed quoting: unterminated quote", () => {
    const csv = 'timestamp,ip,port,protocol,as_name\n2026-01-01T00:00:00Z,203.0.113.10,3389,tcp,"unterminated\n';
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PARSE_ERROR_CODES.MALFORMED_CSV);
  });

  it("rejects malformed quoting: a bare quote appearing mid-unquoted-field", () => {
    const csv = 'timestamp,ip,port,protocol,as_name\n2026-01-01T00:00:00Z,203.0.113.10,3389,tcp,abc"def\n';
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PARSE_ERROR_CODES.MALFORMED_CSV);
  });

  it("rejects a data row with more fields than the header row", () => {
    const csv = "timestamp,ip,port,protocol\n2026-01-01T00:00:00Z,203.0.113.10,3389,tcp,extra,evenmore\n";
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PARSE_ERROR_CODES.MALFORMED_CSV);
  });

  it("rejects a report exceeding the row limit and stops rather than fully tokenizing", () => {
    const rows = Array.from(
      { length: 5 },
      (_, i) => `2026-01-01T00:00:0${i}Z,203.0.113.${i + 1},3389,tcp`
    ).join("\n");
    const csv = `${HEADER}\n${rows}\n`;
    const result = parseAccessibleRdpCsv(csvBuffer(csv), { maxDataRows: 3 });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PARSE_ERROR_CODES.ROW_LIMIT_EXCEEDED);
  });

  it("uses DEFAULT_MAX_DATA_ROWS (5000) when no override is supplied", () => {
    expect(DEFAULT_MAX_DATA_ROWS).toBe(5000);
    const rows = Array.from(
      { length: DEFAULT_MAX_DATA_ROWS + 1 },
      (_, i) => `2026-01-01T00:00:00Z,203.0.113.10,3389,tcp`
    ).join("\n");
    const csv = `${HEADER}\n${rows}\n`;
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(PARSE_ERROR_CODES.ROW_LIMIT_EXCEEDED);
  });

  it("accepts exactly the row limit", () => {
    const rows = Array.from(
      { length: 3 },
      (_, i) => `2026-01-01T00:00:0${i}Z,203.0.113.${i + 1},3389,tcp`
    ).join("\n");
    const csv = `${HEADER}\n${rows}\n`;
    const result = parseAccessibleRdpCsv(csvBuffer(csv), { maxDataRows: 3 });

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(3);
  });
});

describe("parseAccessibleRdpCsv — caller contract", () => {
  it("throws a TypeError for a non-Buffer input", () => {
    expect(() => parseAccessibleRdpCsv("not a buffer")).toThrow(TypeError);
    expect(() => parseAccessibleRdpCsv(null)).toThrow(TypeError);
    expect(() => parseAccessibleRdpCsv(undefined)).toThrow(TypeError);
  });

  it("never executes or evaluates cell contents", () => {
    const csv = `${HEADER}\n2026-01-01T00:00:00Z,203.0.113.10,3389,tcp,=1+1,,,\n`;
    const result = parseAccessibleRdpCsv(csvBuffer(csv));

    expect(result.ok).toBe(true);
    expect(result.rows[0].rawRow.hostname).toBe("=1+1");
  });
});
