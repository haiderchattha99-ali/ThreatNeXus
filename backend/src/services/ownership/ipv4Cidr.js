"use strict";

// Pure IPv4/CIDR arithmetic for Phase 2 ownership mapping (P2-T1). No Prisma
// access, no I/O — a Finding's indicatorValue (a strict IPv4 string, per the
// Phase 1 row validator) and an AssetMapping's cidr/exactIp are the only
// inputs this module ever sees. IPv6 is explicitly out of scope for this
// task (DECISIONS.md / the approved Phase 2 packet).
//
// BigInt throughout: IPv4 as an unsigned 32-bit integer (0..4294967295)
// exceeds the safe range for JavaScript's `|`/`<<`/etc., which operate on
// *signed* 32-bit integers and would misinterpret any address at or above
// 128.0.0.0 as negative. BigInt bitwise/shift operators have no such 32-bit
// width, so the trap does not exist for them. Never returned as a raw BigInt
// across a JSON API boundary — see intToIpv4/canonicalizeCidr, which convert
// back to display strings; callers serializing an AssetMapping/FindingOwnership
// row must always go through those, never emit ipStart/ipEnd directly.

const MAX_UNSIGNED_32 = 4294967295n;

class Ipv4FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "Ipv4FormatError";
  }
}

// Exactly "0" or a non-zero digit followed by 0-2 more digits — rejects
// leading zeros ("01"), signs, whitespace, and non-digit characters in one
// pattern. Range (0-255) is checked separately since the pattern alone
// admits "300".
const OCTET_PATTERN = /^(0|[1-9]\d{0,2})$/;

function isValidOctetString(part) {
  if (typeof part !== "string" || part === "") return false;
  if (!OCTET_PATTERN.test(part)) return false;
  const value = Number(part);
  return value >= 0 && value <= 255;
}

// Exactly four dot-separated decimal octets. No trimming — a leading/trailing
// or embedded space fails the per-octet pattern and rejects the whole value.
function isValidIpv4(value) {
  if (typeof value !== "string" || value === "") return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every(isValidOctetString);
}

// Throws Ipv4FormatError on anything isValidIpv4 rejects. Returns a BigInt in
// [0, 2^32-1]. `<<`/`|` here operate on BigInt, not Number, so there is no
// signed-32-bit overflow for octets >= 128.
function ipv4ToInt(value) {
  if (!isValidIpv4(value)) {
    throw new Ipv4FormatError(`Not a strict IPv4 address: ${JSON.stringify(value)}`);
  }
  return value.split(".").reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

// Accepts a BigInt or a safe-integer Number in [0, 2^32-1] (Prisma returns
// BigInt columns as JS BigInt; some call sites may already hold a Number).
// Throws for anything outside that range or of the wrong type — this is the
// one function every ownership API response path must call before emitting
// an address, so a raw BigInt/out-of-range value can never reach a client.
function intToIpv4(value) {
  let big;
  if (typeof value === "bigint") {
    big = value;
  } else if (typeof value === "number" && Number.isInteger(value)) {
    big = BigInt(value);
  } else {
    throw new Ipv4FormatError(
      `intToIpv4: expected a BigInt or safe integer, got ${typeof value}`
    );
  }
  if (big < 0n || big > MAX_UNSIGNED_32) {
    throw new Ipv4FormatError(`intToIpv4: value out of unsigned-IPv4 range: ${big}`);
  }

  const octets = [];
  for (let shift = 24n; shift >= 0n; shift -= 8n) {
    octets.push(Number((big >> shift) & 0xffn));
  }
  return octets.join(".");
}

const CIDR_PATTERN = /^([^/]+)\/(\d{1,2})$/;
const PREFIX_PATTERN = /^(0|[1-9]\d?)$/;

// Parses "a.b.c.d/n" (0 <= n <= 32) into { network, prefixLength, ipStart,
// ipEnd }. `network` is the canonical network-address string with host bits
// zeroed — the supplied address need not already be the network address.
function cidrToRange(cidr) {
  if (typeof cidr !== "string") {
    throw new Ipv4FormatError("cidrToRange: cidr must be a string");
  }
  const match = CIDR_PATTERN.exec(cidr.trim());
  if (!match) {
    throw new Ipv4FormatError(`Not a strict CIDR: ${JSON.stringify(cidr)}`);
  }
  const [, ipPart, prefixPart] = match;
  if (!PREFIX_PATTERN.test(prefixPart)) {
    throw new Ipv4FormatError(`Not a strict CIDR prefix length: ${JSON.stringify(prefixPart)}`);
  }
  const prefixLength = Number(prefixPart);
  if (prefixLength < 0 || prefixLength > 32) {
    throw new Ipv4FormatError(`CIDR prefix length out of range 0-32: ${prefixLength}`);
  }

  const ip = ipv4ToInt(ipPart);
  const hostBits = 32 - prefixLength;
  // /0 has hostBits=32 -> blockSize covers the entire address space; /32 has
  // hostBits=0, handled explicitly since `1n << 0n` is already 1n anyway but
  // spelling it out keeps the boundary self-documenting.
  const blockSize = hostBits === 0 ? 1n : 1n << BigInt(hostBits);
  const ipStart = (ip / blockSize) * blockSize;
  const ipEnd = ipStart + blockSize - 1n;

  return {
    network: intToIpv4(ipStart),
    prefixLength,
    ipStart,
    ipEnd,
  };
}

// True when ip (a BigInt, see ipv4ToInt) falls within [range.ipStart,
// range.ipEnd] inclusive.
function rangeContains(ip, range) {
  if (typeof ip !== "bigint") {
    throw new Ipv4FormatError("rangeContains: ip must be a BigInt (see ipv4ToInt)");
  }
  if (!range || typeof range.ipStart !== "bigint" || typeof range.ipEnd !== "bigint") {
    throw new Ipv4FormatError("rangeContains: range must have BigInt ipStart/ipEnd");
  }
  return ip >= range.ipStart && ip <= range.ipEnd;
}

// Canonical "network/prefix" string for a CIDR input — network bits only,
// independent of which host address within the block was supplied
// (e.g. "10.0.0.5/24" canonicalizes to "10.0.0.0/24").
function canonicalizeCidr(cidr) {
  const { network, prefixLength } = cidrToRange(cidr);
  return `${network}/${prefixLength}`;
}

module.exports = {
  Ipv4FormatError,
  isValidIpv4,
  ipv4ToInt,
  intToIpv4,
  cidrToRange,
  rangeContains,
  canonicalizeCidr,
};
