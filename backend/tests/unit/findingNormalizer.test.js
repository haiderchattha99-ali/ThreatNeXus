import { describe, it, expect } from "vitest";

const { validateAccessibleRdpRow } = require("../../src/services/ingestion/accessibleRdpRowValidator");
const {
  REPORT_TYPE,
  normalizeAccessibleRdpFindingIdentity,
} = require("../../src/services/normalization/findingNormalizer");

function validRow(overrides = {}) {
  return {
    timestamp: "2026-01-05T12:00:00Z",
    ip: "203.0.113.10",
    port: "3389",
    protocol: "tcp",
    hostname: "rdp-host.example",
    asn: "AS64500",
    as_name: "Example Networks",
    country_code: "us",
    ...overrides,
  };
}

describe("normalizeAccessibleRdpFindingIdentity", () => {
  it("produces the exact Finding identity from a VALID validator result", () => {
    const validated = validateAccessibleRdpRow(validRow(), 1);
    const identity = normalizeAccessibleRdpFindingIdentity(validated);

    expect(identity).toEqual({
      indicatorValue: "203.0.113.10",
      port: 3389,
      protocol: "TCP",
      reportType: REPORT_TYPE,
      observedAt: new Date("2026-01-05T12:00:00.000Z"),
    });
  });

  it("uses the row's own observation time, never upload time", () => {
    const validated = validateAccessibleRdpRow(
      validRow({ timestamp: "2026-01-01T00:00:00Z" }),
      1
    );
    const identity = normalizeAccessibleRdpFindingIdentity(validated);
    expect(identity.observedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("excludes hostname, asn, as_name and country_code from the output", () => {
    const validated = validateAccessibleRdpRow(validRow(), 1);
    const identity = normalizeAccessibleRdpFindingIdentity(validated);
    expect(Object.keys(identity).sort()).toEqual([
      "indicatorValue",
      "observedAt",
      "port",
      "protocol",
      "reportType",
    ]);
  });

  it("is deterministic — the same validator result always normalizes the same way", () => {
    const validated = validateAccessibleRdpRow(validRow(), 1);
    const a = normalizeAccessibleRdpFindingIdentity(validated);
    const b = normalizeAccessibleRdpFindingIdentity(validated);
    expect(a).toEqual(b);
  });

  it("rejects an INVALID validator result as a controlled programmer error", () => {
    const validated = validateAccessibleRdpRow(validRow({ ip: "not-an-ip" }), 1);
    expect(validated.status).toBe("INVALID");
    expect(() => normalizeAccessibleRdpFindingIdentity(validated)).toThrow(TypeError);
  });

  it("rejects a non-object input", () => {
    expect(() => normalizeAccessibleRdpFindingIdentity(null)).toThrow(TypeError);
    expect(() => normalizeAccessibleRdpFindingIdentity(undefined)).toThrow(TypeError);
    expect(() => normalizeAccessibleRdpFindingIdentity("VALID")).toThrow(TypeError);
  });

  it("rejects a VALID-shaped object with a missing normalized payload", () => {
    expect(() => normalizeAccessibleRdpFindingIdentity({ status: "VALID" })).toThrow(TypeError);
    expect(() =>
      normalizeAccessibleRdpFindingIdentity({ status: "VALID", normalized: null })
    ).toThrow(TypeError);
  });

  it("rejects a normalized payload with an out-of-contract field type", () => {
    expect(() =>
      normalizeAccessibleRdpFindingIdentity({
        status: "VALID",
        normalized: { ip: "1.2.3.4", port: "3389", protocol: "TCP", timestamp: "2026-01-01T00:00:00Z" },
      })
    ).toThrow(TypeError);
  });

  it("rejects a normalized payload with an unparseable timestamp", () => {
    expect(() =>
      normalizeAccessibleRdpFindingIdentity({
        status: "VALID",
        normalized: { ip: "1.2.3.4", port: 3389, protocol: "TCP", timestamp: "not-a-date" },
      })
    ).toThrow(TypeError);
  });
});
