import { describe, it, expect } from "vitest";

const { ReportType } = require("@prisma/client");
const {
  REPORT_SOURCES,
  TRUSTED_REPORT_CONTRACTS,
  REASON_CODES,
  isTrustedReportContract,
  validateReportSource,
} = require("../../src/services/ingestion/reportSourceRegistry");

const APPROVED_TUPLE = Object.freeze({
  source: REPORT_SOURCES.SYNTHETIC_UPLOAD,
  reportType: ReportType.ACCESSIBLE_RDP,
  schemaVersion: "accessible-rdp.synthetic.v1",
});

describe("reportSourceRegistry", () => {
  it("accepts the one approved tuple", () => {
    expect(isTrustedReportContract(APPROVED_TUPLE)).toBe(true);
    expect(validateReportSource(APPROVED_TUPLE)).toEqual({ ok: true });
  });

  it("rejects an unknown source", () => {
    const result = validateReportSource({ ...APPROVED_TUPLE, source: "SHADOWSERVER" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(REASON_CODES.UNTRUSTED_SOURCE_REPORT_COMBINATION);
  });

  it("is case-sensitive on source", () => {
    expect(isTrustedReportContract({ ...APPROVED_TUPLE, source: "synthetic_upload" })).toBe(false);
    expect(isTrustedReportContract({ ...APPROVED_TUPLE, source: "Synthetic_Upload" })).toBe(false);
  });

  it("is case-sensitive and exact on reportType and schemaVersion too", () => {
    expect(isTrustedReportContract({ ...APPROVED_TUPLE, reportType: "accessible_rdp" })).toBe(false);
    expect(
      isTrustedReportContract({ ...APPROVED_TUPLE, schemaVersion: "ACCESSIBLE-RDP.SYNTHETIC.V1" })
    ).toBe(false);
  });

  it("does not trim or coerce whitespace-padded values", () => {
    expect(isTrustedReportContract({ ...APPROVED_TUPLE, source: " SYNTHETIC_UPLOAD" })).toBe(false);
    expect(isTrustedReportContract({ ...APPROVED_TUPLE, source: "SYNTHETIC_UPLOAD " })).toBe(false);
  });

  it("rejects a wrong reportType even with an otherwise-correct tuple", () => {
    const result = validateReportSource({ ...APPROVED_TUPLE, reportType: "SOMETHING_ELSE" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(REASON_CODES.UNTRUSTED_SOURCE_REPORT_COMBINATION);
  });

  it("rejects a wrong schemaVersion even with an otherwise-correct tuple", () => {
    const result = validateReportSource({ ...APPROVED_TUPLE, schemaVersion: "accessible-rdp.synthetic.v2" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(REASON_CODES.UNTRUSTED_SOURCE_REPORT_COMBINATION);
  });

  it("rejects a tuple that matches only source (partial match is insufficient)", () => {
    expect(
      isTrustedReportContract({
        source: REPORT_SOURCES.SYNTHETIC_UPLOAD,
        reportType: "WRONG_TYPE",
        schemaVersion: "wrong-version",
      })
    ).toBe(false);
  });

  it("rejects a tuple that matches only reportType and schemaVersion (source missing)", () => {
    expect(
      isTrustedReportContract({
        source: "UNKNOWN_SOURCE",
        reportType: APPROVED_TUPLE.reportType,
        schemaVersion: APPROVED_TUPLE.schemaVersion,
      })
    ).toBe(false);
  });

  it("rejects a missing source", () => {
    const { source, ...rest } = APPROVED_TUPLE;
    expect(isTrustedReportContract(rest)).toBe(false);
    expect(validateReportSource(rest).ok).toBe(false);
  });

  it("rejects a missing reportType", () => {
    const { reportType, ...rest } = APPROVED_TUPLE;
    expect(isTrustedReportContract(rest)).toBe(false);
  });

  it("rejects a missing schemaVersion", () => {
    const { schemaVersion, ...rest } = APPROVED_TUPLE;
    expect(isTrustedReportContract(rest)).toBe(false);
  });

  it("rejects null/undefined fields rather than throwing", () => {
    expect(isTrustedReportContract({ source: null, reportType: null, schemaVersion: null })).toBe(
      false
    );
    expect(
      isTrustedReportContract({ source: undefined, reportType: undefined, schemaVersion: undefined })
    ).toBe(false);
  });

  it("throws only for a caller contract violation (non-object input), never for expected-invalid data", () => {
    expect(() => validateReportSource(null)).toThrow(TypeError);
    expect(() => validateReportSource(undefined)).toThrow(TypeError);
    expect(() => validateReportSource("SYNTHETIC_UPLOAD")).toThrow(TypeError);
  });

  it("returns a stable machine-readable reason code and a safe, non-echoing message", () => {
    const result = validateReportSource({
      source: "ATTACKER_CONTROLLED",
      reportType: "ATTACKER_CONTROLLED",
      schemaVersion: "ATTACKER_CONTROLLED",
    });
    expect(result.code).toBe("UNTRUSTED_SOURCE_REPORT_COMBINATION");
    expect(typeof result.message).toBe("string");
    expect(result.message).not.toContain("ATTACKER_CONTROLLED");
    // The safe message must not enumerate the registry's actual contents.
    expect(result.message).not.toContain(REPORT_SOURCES.SYNTHETIC_UPLOAD);
  });

  // Attempts a mutation without letting either possible outcome fail the
  // test: a frozen object throws under strict-mode assignment (this test
  // file, as an ES module, runs strict) but the spec only guarantees a
  // silent no-op under sloppy mode. Either way, the object itself must never
  // actually change — that is the one thing this test asserts.
  function attemptMutation(fn) {
    try {
      fn();
    } catch (error) {
      // Expected under strict mode for a frozen target; ignored on purpose.
    }
  }

  it("exposes a frozen source-identifier collection that cannot be mutated through normal access", () => {
    expect(Object.isFrozen(REPORT_SOURCES)).toBe(true);

    attemptMutation(() => {
      REPORT_SOURCES.SYNTHETIC_UPLOAD = "TAMPERED";
    });
    expect(REPORT_SOURCES.SYNTHETIC_UPLOAD).toBe("SYNTHETIC_UPLOAD");

    attemptMutation(() => {
      REPORT_SOURCES.NEW_SOURCE = "INJECTED";
    });
    expect(REPORT_SOURCES.NEW_SOURCE).toBeUndefined();
  });

  it("exposes a frozen trusted-contract registry (array and each tuple) that cannot be mutated", () => {
    expect(Object.isFrozen(TRUSTED_REPORT_CONTRACTS)).toBe(true);
    TRUSTED_REPORT_CONTRACTS.forEach((contract) => {
      expect(Object.isFrozen(contract)).toBe(true);
    });

    const originalLength = TRUSTED_REPORT_CONTRACTS.length;
    // Array.prototype.push always throws on a non-extensible array,
    // regardless of strict/sloppy mode (per the spec's Array.prototype.push
    // steps) — this one is safe to assert unconditionally.
    expect(() => {
      TRUSTED_REPORT_CONTRACTS.push({ source: "X", reportType: "Y", schemaVersion: "Z" });
    }).toThrow();
    expect(TRUSTED_REPORT_CONTRACTS.length).toBe(originalLength);

    attemptMutation(() => {
      TRUSTED_REPORT_CONTRACTS[0].source = "TAMPERED";
    });
    expect(TRUSTED_REPORT_CONTRACTS[0].source).toBe(REPORT_SOURCES.SYNTHETIC_UPLOAD);
  });

  it("exposes a frozen reason-codes collection", () => {
    expect(Object.isFrozen(REASON_CODES)).toBe(true);
    expect(REASON_CODES.UNTRUSTED_SOURCE_REPORT_COMBINATION).toBe(
      "UNTRUSTED_SOURCE_REPORT_COMBINATION"
    );
  });
});
