import { describe, it, expect } from "vitest";

const {
  Ipv4FormatError,
  isValidIpv4,
  ipv4ToInt,
  intToIpv4,
  cidrToRange,
  rangeContains,
  canonicalizeCidr,
} = require("../../src/services/ownership/ipv4Cidr");

describe("isValidIpv4 / ipv4ToInt — strict address parsing", () => {
  it("accepts a normal address", () => {
    expect(isValidIpv4("203.0.113.10")).toBe(true);
    expect(ipv4ToInt("203.0.113.10")).toBe(3405803786n);
  });

  it("accepts the boundaries 0.0.0.0 and 255.255.255.255", () => {
    expect(isValidIpv4("0.0.0.0")).toBe(true);
    expect(ipv4ToInt("0.0.0.0")).toBe(0n);
    expect(isValidIpv4("255.255.255.255")).toBe(true);
    expect(ipv4ToInt("255.255.255.255")).toBe(4294967295n);
  });

  it("rejects octets out of 0-255 range", () => {
    expect(isValidIpv4("256.0.0.1")).toBe(false);
    expect(isValidIpv4("1.2.3.999")).toBe(false);
  });

  it("rejects the wrong number of octets", () => {
    expect(isValidIpv4("1.2.3")).toBe(false);
    expect(isValidIpv4("1.2.3.4.5")).toBe(false);
    expect(isValidIpv4("")).toBe(false);
  });

  it("rejects leading zeros (octal-like)", () => {
    expect(isValidIpv4("01.2.3.4")).toBe(false);
    expect(isValidIpv4("1.2.3.04")).toBe(false);
    expect(isValidIpv4("00.0.0.0")).toBe(false);
  });

  it("rejects signs and whitespace", () => {
    expect(isValidIpv4("-1.2.3.4")).toBe(false);
    expect(isValidIpv4("+1.2.3.4")).toBe(false);
    expect(isValidIpv4(" 1.2.3.4")).toBe(false);
    expect(isValidIpv4("1.2.3.4 ")).toBe(false);
    expect(isValidIpv4("1. 2.3.4")).toBe(false);
  });

  it("rejects hex-like octets", () => {
    expect(isValidIpv4("0x1.2.3.4")).toBe(false);
    expect(isValidIpv4("1a.2.3.4")).toBe(false);
  });

  it("rejects non-string / coercion attempts", () => {
    expect(isValidIpv4(null)).toBe(false);
    expect(isValidIpv4(undefined)).toBe(false);
    expect(isValidIpv4(3405803786)).toBe(false);
  });

  it("rejects IPv6, CIDR-suffixed and hostname forms", () => {
    expect(isValidIpv4("::1")).toBe(false);
    expect(isValidIpv4("203.0.113.10/24")).toBe(false);
    expect(isValidIpv4("example.com")).toBe(false);
  });

  it("ipv4ToInt throws Ipv4FormatError on invalid input", () => {
    expect(() => ipv4ToInt("not-an-ip")).toThrow(Ipv4FormatError);
  });
});

describe("intToIpv4 — round-trip and safety", () => {
  it("round-trips every address through ipv4ToInt/intToIpv4", () => {
    const samples = ["0.0.0.0", "255.255.255.255", "203.0.113.10", "128.0.0.1", "10.0.0.1"];
    samples.forEach((ip) => {
      expect(intToIpv4(ipv4ToInt(ip))).toBe(ip);
    });
  });

  it("accepts a safe-integer Number as well as a BigInt", () => {
    expect(intToIpv4(0)).toBe("0.0.0.0");
    expect(intToIpv4(4294967295)).toBe("255.255.255.255");
  });

  it("never misinterprets an address >= 128.0.0.0 as negative (no signed-32 trap)", () => {
    // 128.0.0.0 is 2^31 — the classic signed-32-bit overflow boundary.
    expect(ipv4ToInt("128.0.0.0")).toBe(2147483648n);
    expect(intToIpv4(2147483648n)).toBe("128.0.0.0");
  });

  it("throws on out-of-range values", () => {
    expect(() => intToIpv4(-1n)).toThrow(Ipv4FormatError);
    expect(() => intToIpv4(4294967296n)).toThrow(Ipv4FormatError);
  });

  it("throws on the wrong type", () => {
    expect(() => intToIpv4("3405803786")).toThrow(Ipv4FormatError);
    expect(() => intToIpv4(1.5)).toThrow(Ipv4FormatError);
  });
});

describe("cidrToRange — canonical range calculation", () => {
  it("computes /32 as a single address", () => {
    const range = cidrToRange("203.0.113.10/32");
    expect(range.network).toBe("203.0.113.10");
    expect(range.ipStart).toBe(range.ipEnd);
    expect(range.prefixLength).toBe(32);
  });

  it("computes /0 as the entire address space", () => {
    const range = cidrToRange("10.20.30.40/0");
    expect(range.network).toBe("0.0.0.0");
    expect(range.ipStart).toBe(0n);
    expect(range.ipEnd).toBe(4294967295n);
  });

  it("computes a /24 block correctly", () => {
    const range = cidrToRange("203.0.113.55/24");
    expect(range.network).toBe("203.0.113.0");
    expect(intToIpv4(range.ipEnd)).toBe("203.0.113.255");
  });

  it("computes a /16 block correctly", () => {
    const range = cidrToRange("172.16.5.9/16");
    expect(range.network).toBe("172.16.0.0");
    expect(intToIpv4(range.ipEnd)).toBe("172.16.255.255");
  });

  it("zeroes host bits even when given a non-network address", () => {
    expect(cidrToRange("10.0.0.5/24").network).toBe("10.0.0.0");
  });

  it("rejects a malformed prefix length", () => {
    expect(() => cidrToRange("10.0.0.0/33")).toThrow(Ipv4FormatError);
    expect(() => cidrToRange("10.0.0.0/-1")).toThrow(Ipv4FormatError);
    expect(() => cidrToRange("10.0.0.0/01")).toThrow(Ipv4FormatError);
    expect(() => cidrToRange("10.0.0.0/")).toThrow(Ipv4FormatError);
  });

  it("rejects a malformed address part", () => {
    expect(() => cidrToRange("10.0.0/24")).toThrow(Ipv4FormatError);
    expect(() => cidrToRange("not-an-ip/24")).toThrow(Ipv4FormatError);
  });

  it("rejects a missing slash", () => {
    expect(() => cidrToRange("10.0.0.0")).toThrow(Ipv4FormatError);
  });

  it("rejects non-string input", () => {
    expect(() => cidrToRange(null)).toThrow(Ipv4FormatError);
  });
});

describe("rangeContains — containment", () => {
  it("includes both range boundaries", () => {
    const range = cidrToRange("203.0.113.0/24");
    expect(rangeContains(ipv4ToInt("203.0.113.0"), range)).toBe(true);
    expect(rangeContains(ipv4ToInt("203.0.113.255"), range)).toBe(true);
  });

  it("excludes an address just outside the range", () => {
    const range = cidrToRange("203.0.113.0/24");
    expect(rangeContains(ipv4ToInt("203.0.114.0"), range)).toBe(false);
    expect(rangeContains(ipv4ToInt("203.0.112.255"), range)).toBe(false);
  });

  it("a /32 contains only its own address", () => {
    const range = cidrToRange("203.0.113.10/32");
    expect(rangeContains(ipv4ToInt("203.0.113.10"), range)).toBe(true);
    expect(rangeContains(ipv4ToInt("203.0.113.11"), range)).toBe(false);
  });

  it("a /0 contains the full address space", () => {
    const range = cidrToRange("0.0.0.0/0");
    expect(rangeContains(0n, range)).toBe(true);
    expect(rangeContains(4294967295n, range)).toBe(true);
  });

  it("throws when ip is not a BigInt", () => {
    const range = cidrToRange("203.0.113.0/24");
    expect(() => rangeContains("203.0.113.5", range)).toThrow(Ipv4FormatError);
  });

  it("throws when range is malformed", () => {
    expect(() => rangeContains(1n, {})).toThrow(Ipv4FormatError);
  });
});

describe("canonicalizeCidr", () => {
  it("normalizes a non-network address down to its network/prefix form", () => {
    expect(canonicalizeCidr("10.0.0.5/24")).toBe("10.0.0.0/24");
  });

  it("is idempotent on an already-canonical value", () => {
    expect(canonicalizeCidr("10.0.0.0/24")).toBe("10.0.0.0/24");
  });

  it("handles /32 and /0", () => {
    expect(canonicalizeCidr("203.0.113.10/32")).toBe("203.0.113.10/32");
    expect(canonicalizeCidr("203.0.113.10/0")).toBe("0.0.0.0/0");
  });
});
