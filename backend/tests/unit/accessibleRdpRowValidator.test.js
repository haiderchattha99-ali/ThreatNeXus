import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const {
  CONTRACT_VERSION,
  ERROR_CODES,
  validateAccessibleRdpRow,
} = require("../../src/services/ingestion/accessibleRdpRowValidator");

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "accessible-rdp");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

const VALID_ROW = Object.freeze({
  timestamp: "2026-01-01T00:00:00Z",
  ip: "192.168.1.1",
  port: "3389",
  protocol: "tcp",
});

describe("validateAccessibleRdpRow — contract identity", () => {
  it("reports the accessible-rdp.synthetic.v1 contract version", () => {
    const result = validateAccessibleRdpRow(VALID_ROW, 1);
    expect(result.contractVersion).toBe("accessible-rdp.synthetic.v1");
    expect(CONTRACT_VERSION).toBe("accessible-rdp.synthetic.v1");
  });

  it("carries the caller-supplied row number through unchanged", () => {
    expect(validateAccessibleRdpRow(VALID_ROW, 1).rowNumber).toBe(1);
    expect(validateAccessibleRdpRow(VALID_ROW, 42).rowNumber).toBe(42);
  });

  it("preserves the original raw row alongside any normalized payload", () => {
    const result = validateAccessibleRdpRow(VALID_ROW, 1);
    expect(result.raw).toEqual(VALID_ROW);
  });

  it("never throws for expected validation failures", () => {
    expect(() => validateAccessibleRdpRow({}, 1)).not.toThrow();
  });
});

describe("validateAccessibleRdpRow — caller contract violations (throw)", () => {
  it("throws when rawRow is not a plain object", () => {
    expect(() => validateAccessibleRdpRow(null, 1)).toThrow(TypeError);
    expect(() => validateAccessibleRdpRow(undefined, 1)).toThrow(TypeError);
    expect(() => validateAccessibleRdpRow("row", 1)).toThrow(TypeError);
    expect(() => validateAccessibleRdpRow(["a"], 1)).toThrow(TypeError);
  });

  it("throws when rowNumber is not a positive integer", () => {
    expect(() => validateAccessibleRdpRow(VALID_ROW, 0)).toThrow(TypeError);
    expect(() => validateAccessibleRdpRow(VALID_ROW, -1)).toThrow(TypeError);
    expect(() => validateAccessibleRdpRow(VALID_ROW, 1.5)).toThrow(TypeError);
    expect(() => validateAccessibleRdpRow(VALID_ROW, "1")).toThrow(TypeError);
  });

  it("throws when a known field is neither a string, null, nor undefined", () => {
    expect(() => validateAccessibleRdpRow({ ...VALID_ROW, port: 3389 }, 1)).toThrow(TypeError);
    expect(() => validateAccessibleRdpRow({ ...VALID_ROW, asn: 12345 }, 1)).toThrow(TypeError);
  });
});

describe("validateAccessibleRdpRow — timestamp", () => {
  it("accepts a Z-suffixed UTC timestamp and normalizes to canonical ISO", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, timestamp: "2026-06-15T08:30:00Z" }, 1);
    expect(result.status).toBe("VALID");
    expect(result.normalized.timestamp).toBe("2026-06-15T08:30:00.000Z");
  });

  it("accepts an explicit +00:00 offset as UTC", () => {
    const result = validateAccessibleRdpRow(
      { ...VALID_ROW, timestamp: "2026-06-15T08:30:00+00:00" },
      1
    );
    expect(result.status).toBe("VALID");
    expect(result.normalized.timestamp).toBe("2026-06-15T08:30:00.000Z");
  });

  it("rejects a missing timestamp as REQUIRED_FIELD", () => {
    const { timestamp, ...rest } = VALID_ROW;
    const result = validateAccessibleRdpRow(rest, 1);
    expect(result.status).toBe("INVALID");
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "timestamp", code: ERROR_CODES.REQUIRED_FIELD })
    );
  });

  it("rejects a timestamp with no timezone as TIMESTAMP_NOT_UTC, not INVALID_TIMESTAMP", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, timestamp: "2026-06-15T08:30:00" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "timestamp", code: ERROR_CODES.TIMESTAMP_NOT_UTC })
    );
  });

  it("rejects a non-UTC offset as TIMESTAMP_NOT_UTC", () => {
    const result = validateAccessibleRdpRow(
      { ...VALID_ROW, timestamp: "2026-06-15T08:30:00+05:00" },
      1
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "timestamp", code: ERROR_CODES.TIMESTAMP_NOT_UTC })
    );
  });

  it("rejects a malformed timestamp as INVALID_TIMESTAMP", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, timestamp: "06/15/2026 08:30:00" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "timestamp", code: ERROR_CODES.INVALID_TIMESTAMP })
    );
  });

  it("rejects an impossible calendar date as INVALID_TIMESTAMP", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, timestamp: "2026-02-30T00:00:00Z" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "timestamp", code: ERROR_CODES.INVALID_TIMESTAMP })
    );
  });

  it("does not use upload/current time as observation time — only the supplied value is normalized", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, timestamp: "2026-01-01T00:00:00Z" }, 1);
    expect(result.normalized.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("validateAccessibleRdpRow — ip", () => {
  it("accepts a canonical IPv4 address", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, ip: "10.20.30.40" }, 1);
    expect(result.status).toBe("VALID");
    expect(result.normalized.ip).toBe("10.20.30.40");
  });

  it("accepts boundary octets 0 and 255", () => {
    expect(validateAccessibleRdpRow({ ...VALID_ROW, ip: "0.0.0.0" }, 1).status).toBe("VALID");
    expect(validateAccessibleRdpRow({ ...VALID_ROW, ip: "255.255.255.255" }, 1).status).toBe(
      "VALID"
    );
  });

  it("rejects a missing ip as REQUIRED_FIELD", () => {
    const { ip, ...rest } = VALID_ROW;
    const result = validateAccessibleRdpRow(rest, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "ip", code: ERROR_CODES.REQUIRED_FIELD })
    );
  });

  it("rejects an octet greater than 255", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, ip: "203.0.113.256" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "ip", code: ERROR_CODES.INVALID_IPV4 })
    );
  });

  it("rejects an octet with a leading zero rather than silently repairing it", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, ip: "010.0.0.1" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "ip", code: ERROR_CODES.INVALID_IPV4 })
    );
  });

  it("rejects IPv6", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, ip: "2001:db8::1" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "ip", code: ERROR_CODES.INVALID_IPV4 })
    );
  });

  it("rejects CIDR notation", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, ip: "10.0.0.0/24" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "ip", code: ERROR_CODES.INVALID_IPV4 })
    );
  });

  it("rejects a hostname in place of an ip", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, ip: "host.example.test" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "ip", code: ERROR_CODES.INVALID_IPV4 })
    );
  });

  it("rejects an integer IP form", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, ip: "3232235777" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "ip", code: ERROR_CODES.INVALID_IPV4 })
    );
  });
});

describe("validateAccessibleRdpRow — port", () => {
  it("accepts boundary ports 1 and 65535", () => {
    expect(validateAccessibleRdpRow({ ...VALID_ROW, port: "1" }, 1).normalized.port).toBe(1);
    expect(validateAccessibleRdpRow({ ...VALID_ROW, port: "65535" }, 1).normalized.port).toBe(
      65535
    );
  });

  it("returns a number, not a string", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, port: "3389" }, 1);
    expect(result.normalized.port).toBe(3389);
    expect(typeof result.normalized.port).toBe("number");
  });

  it("rejects a missing port as REQUIRED_FIELD", () => {
    const { port, ...rest } = VALID_ROW;
    const result = validateAccessibleRdpRow(rest, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "port", code: ERROR_CODES.REQUIRED_FIELD })
    );
  });

  it("rejects port 0", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, port: "0" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "port", code: ERROR_CODES.INVALID_PORT })
    );
  });

  it("rejects port 65536", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, port: "65536" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "port", code: ERROR_CODES.INVALID_PORT })
    );
  });

  it("rejects a decimal port", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, port: "3389.5" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "port", code: ERROR_CODES.INVALID_PORT })
    );
  });

  it("rejects a signed port", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, port: "+3389" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "port", code: ERROR_CODES.INVALID_PORT })
    );
  });

  it("rejects scientific notation", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, port: "3.389e3" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "port", code: ERROR_CODES.INVALID_PORT })
    );
  });

  it("rejects an empty port value", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, port: "" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "port", code: ERROR_CODES.REQUIRED_FIELD })
    );
  });

  it("rejects surrounding non-numeric characters", () => {
    expect(
      validateAccessibleRdpRow({ ...VALID_ROW, port: " 3389" }, 1).errors
    ).toContainEqual(expect.objectContaining({ field: "port", code: ERROR_CODES.INVALID_PORT }));
    expect(
      validateAccessibleRdpRow({ ...VALID_ROW, port: "3389 " }, 1).errors
    ).toContainEqual(expect.objectContaining({ field: "port", code: ERROR_CODES.INVALID_PORT }));
    expect(
      validateAccessibleRdpRow({ ...VALID_ROW, port: "port3389" }, 1).errors
    ).toContainEqual(expect.objectContaining({ field: "port", code: ERROR_CODES.INVALID_PORT }));
  });
});

describe("validateAccessibleRdpRow — protocol", () => {
  it("accepts tcp case-insensitively and normalizes to Prisma's TransportProtocol.TCP", () => {
    expect(validateAccessibleRdpRow({ ...VALID_ROW, protocol: "tcp" }, 1).normalized.protocol).toBe(
      "TCP"
    );
    expect(validateAccessibleRdpRow({ ...VALID_ROW, protocol: "TCP" }, 1).normalized.protocol).toBe(
      "TCP"
    );
    expect(validateAccessibleRdpRow({ ...VALID_ROW, protocol: "Tcp" }, 1).normalized.protocol).toBe(
      "TCP"
    );
  });

  it("rejects a missing protocol as REQUIRED_FIELD", () => {
    const { protocol, ...rest } = VALID_ROW;
    const result = validateAccessibleRdpRow(rest, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "protocol", code: ERROR_CODES.REQUIRED_FIELD })
    );
  });

  it("rejects udp", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, protocol: "udp" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "protocol", code: ERROR_CODES.INVALID_PROTOCOL })
    );
  });

  it("rejects a mixed/unknown protocol value", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, protocol: "tcp/udp" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "protocol", code: ERROR_CODES.INVALID_PROTOCOL })
    );
  });
});

describe("validateAccessibleRdpRow — hostname (optional)", () => {
  it("is null when absent or empty", () => {
    expect(validateAccessibleRdpRow(VALID_ROW, 1).normalized.hostname).toBeNull();
    expect(
      validateAccessibleRdpRow({ ...VALID_ROW, hostname: "" }, 1).normalized.hostname
    ).toBeNull();
    expect(
      validateAccessibleRdpRow({ ...VALID_ROW, hostname: "   " }, 1).normalized.hostname
    ).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, hostname: "  host.example  " }, 1);
    expect(result.normalized.hostname).toBe("host.example");
  });

  it("rejects a value longer than the conservative maximum length", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, hostname: "a".repeat(300) }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "hostname", code: ERROR_CODES.FIELD_TOO_LONG })
    );
  });

  it("is never used as finding identity — only ip/port/protocol are", () => {
    const withHostname = validateAccessibleRdpRow({ ...VALID_ROW, hostname: "a.example" }, 1);
    const withoutHostname = validateAccessibleRdpRow(VALID_ROW, 1);
    expect(withHostname.normalized.ip).toBe(withoutHostname.normalized.ip);
    expect(withHostname.normalized.port).toBe(withoutHostname.normalized.port);
    expect(withHostname.normalized.protocol).toBe(withoutHostname.normalized.protocol);
  });
});

describe("validateAccessibleRdpRow — asn (optional)", () => {
  it("is null when absent or empty", () => {
    expect(validateAccessibleRdpRow(VALID_ROW, 1).normalized.asn).toBeNull();
    expect(validateAccessibleRdpRow({ ...VALID_ROW, asn: "" }, 1).normalized.asn).toBeNull();
  });

  it("accepts a plain integer", () => {
    expect(validateAccessibleRdpRow({ ...VALID_ROW, asn: "64500" }, 1).normalized.asn).toBe(64500);
  });

  it("accepts an AS-prefixed form and normalizes to a plain integer", () => {
    const lower = validateAccessibleRdpRow({ ...VALID_ROW, asn: "as64500" }, 1);
    const upper = validateAccessibleRdpRow({ ...VALID_ROW, asn: "AS64500" }, 1);
    expect(lower.normalized.asn).toBe(64500);
    expect(upper.normalized.asn).toBe(64500);
  });

  it("rejects a malformed value", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, asn: "not-an-asn" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "asn", code: ERROR_CODES.INVALID_ASN })
    );
  });

  it("rejects a value with leading zeros rather than silently repairing it", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, asn: "0700" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "asn", code: ERROR_CODES.INVALID_ASN })
    );
  });

  it("rejects a value outside the 4-byte ASN range", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, asn: "4294967296" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "asn", code: ERROR_CODES.INVALID_ASN })
    );
  });
});

describe("validateAccessibleRdpRow — as_name (optional)", () => {
  it("is null when absent or empty, and trims otherwise", () => {
    expect(validateAccessibleRdpRow(VALID_ROW, 1).normalized.asName).toBeNull();
    expect(
      validateAccessibleRdpRow({ ...VALID_ROW, as_name: "  Example ISP  " }, 1).normalized.asName
    ).toBe("Example ISP");
  });

  it("rejects a value longer than the conservative maximum length", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, as_name: "a".repeat(300) }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "as_name", code: ERROR_CODES.FIELD_TOO_LONG })
    );
  });
});

describe("validateAccessibleRdpRow — country_code (optional)", () => {
  it("is null when absent or empty", () => {
    expect(validateAccessibleRdpRow(VALID_ROW, 1).normalized.countryCode).toBeNull();
    expect(
      validateAccessibleRdpRow({ ...VALID_ROW, country_code: "" }, 1).normalized.countryCode
    ).toBeNull();
  });

  it("trims and uppercases", () => {
    expect(
      validateAccessibleRdpRow({ ...VALID_ROW, country_code: " us " }, 1).normalized.countryCode
    ).toBe("US");
  });

  it("rejects a value that is not exactly two ASCII letters", () => {
    const three = validateAccessibleRdpRow({ ...VALID_ROW, country_code: "USA" }, 1);
    const withDigit = validateAccessibleRdpRow({ ...VALID_ROW, country_code: "U1" }, 1);
    expect(three.errors).toContainEqual(
      expect.objectContaining({ field: "country_code", code: ERROR_CODES.INVALID_COUNTRY_CODE })
    );
    expect(withDigit.errors).toContainEqual(
      expect.objectContaining({ field: "country_code", code: ERROR_CODES.INVALID_COUNTRY_CODE })
    );
  });
});

describe("validateAccessibleRdpRow — general field safety", () => {
  it("rejects a null byte in any field with the NULL_BYTE code", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, hostname: "evil\u0000host" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "hostname", code: ERROR_CODES.NULL_BYTE })
    );
  });

  it("rejects a null byte in a required field too", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, ip: "1.2.3.4\u0000" }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "ip", code: ERROR_CODES.NULL_BYTE })
    );
  });

  it("rejects a raw value far beyond any reasonable field length", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, ip: "1".repeat(5000) }, 1);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "ip", code: ERROR_CODES.FIELD_TOO_LONG })
    );
  });

  it("does not throw and does not execute or evaluate field content", () => {
    const trap = "'; DROP TABLE findings; --";
    expect(() => validateAccessibleRdpRow({ ...VALID_ROW, as_name: trap }, 1)).not.toThrow();
    const result = validateAccessibleRdpRow({ ...VALID_ROW, as_name: trap }, 1);
    expect(result.normalized.asName).toBe(trap);
  });
});

describe("validateAccessibleRdpRow — overall VALID/INVALID contract", () => {
  it("returns normalized: null for an invalid row rather than a partial payload", () => {
    const result = validateAccessibleRdpRow({ ...VALID_ROW, port: "0" }, 1);
    expect(result.status).toBe("INVALID");
    expect(result.normalized).toBeNull();
  });

  it("accumulates every field error, not just the first", () => {
    const result = validateAccessibleRdpRow(
      { timestamp: "garbage", ip: "garbage", port: "garbage", protocol: "garbage" },
      1
    );
    const fields = result.errors.map((e) => e.field).sort();
    expect(fields).toEqual(["ip", "port", "protocol", "timestamp"]);
  });
});

describe("validateAccessibleRdpRow — synthetic fixtures", () => {
  it("validates the fully-valid report fixture with zero invalid rows", () => {
    const fixture = loadFixture("valid-report.synthetic.json");
    const results = fixture.rows.map((row, i) => validateAccessibleRdpRow(row, i + 1));
    expect(results.every((r) => r.status === "VALID")).toBe(true);
  });

  it("matches the declared valid/invalid split in the mixed-validity fixture", () => {
    const fixture = loadFixture("mixed-validity-report.synthetic.json");
    const results = fixture.rows.map((row, i) => validateAccessibleRdpRow(row, i + 1));
    const validCount = results.filter((r) => r.status === "VALID").length;
    const invalidCount = results.filter((r) => r.status === "INVALID").length;
    expect(validCount).toBe(fixture.expectedValidCount);
    expect(invalidCount).toBe(fixture.expectedInvalidCount);
  });

  it("validates each row in the duplicate-rows fixture independently (no cross-row state)", () => {
    const fixture = loadFixture("duplicate-rows-report.synthetic.json");
    const results = fixture.rows.map((row, i) => validateAccessibleRdpRow(row, i + 1));
    expect(results.every((r) => r.status === "VALID")).toBe(true);
    expect(new Set(results.map((r) => r.normalized.ip)).size).toBe(1);
  });

  it("validates every boundary-value row as VALID", () => {
    const fixture = loadFixture("boundary-values-report.synthetic.json");
    const results = fixture.rows.map((row, i) => validateAccessibleRdpRow(row, i + 1));
    expect(results.every((r) => r.status === "VALID")).toBe(true);
  });

  it("matches every labelled invalid-row fixture to its declared field and error code", () => {
    const fixture = loadFixture("invalid-rows-report.synthetic.json");
    fixture.rows.forEach((row, i) => {
      const { label, expectedField, expectedCode, ...rawRow } = row;
      const result = validateAccessibleRdpRow(rawRow, i + 1);
      expect(result.status, `row "${label}" should be INVALID`).toBe("INVALID");
      expect(
        result.errors,
        `row "${label}" should report ${expectedField}/${expectedCode}`
      ).toContainEqual(expect.objectContaining({ field: expectedField, code: expectedCode }));
    });
  });
});
