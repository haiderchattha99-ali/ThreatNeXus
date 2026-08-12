import { describe, it, expect } from "vitest";

// Phase 10A-1 — subject canonicalization and provider/subject compatibility.
// Pure module, so no database and no environment is involved.
//
// These tests have teeth: they fail against an implementation that accepts a
// non-canonical IPv4 (which would fragment activeLookupKey into one job per
// spelling), that lets an exposure provider take a CVE, or that canonicalizes
// after hashing rather than before.

const {
  EnrichmentSubjectError,
  SUBJECT_TYPES,
  KNOWN_PROVIDERS,
  isKnownProvider,
  subjectTypeForProvider,
  isProviderSubjectCompatible,
  canonicalizeSubjectValue,
  buildSubject,
  sortTargets,
} = require("../../src/services/enrichmentOrchestration/enrichmentSubject");

describe("enrichmentSubject — provider registry", () => {
  it("knows exactly the six Phase-10 providers", () => {
    expect(KNOWN_PROVIDERS).toEqual([
      "abuseipdb",
      "censys",
      "greynoise",
      "netlas",
      "nvd",
      "shodan",
    ]);
  });

  it("maps the five reputation/exposure providers to IPV4 and nvd to CVE", () => {
    expect(subjectTypeForProvider("abuseipdb")).toBe(SUBJECT_TYPES.IPV4);
    expect(subjectTypeForProvider("greynoise")).toBe(SUBJECT_TYPES.IPV4);
    expect(subjectTypeForProvider("censys")).toBe(SUBJECT_TYPES.IPV4);
    expect(subjectTypeForProvider("shodan")).toBe(SUBJECT_TYPES.IPV4);
    expect(subjectTypeForProvider("netlas")).toBe(SUBJECT_TYPES.IPV4);
    expect(subjectTypeForProvider("nvd")).toBe(SUBJECT_TYPES.CVE);
  });

  it("rejects an unknown provider rather than defaulting it to a subject type", () => {
    expect(isKnownProvider("virustotal")).toBe(false);
    expect(subjectTypeForProvider("virustotal")).toBeNull();
    // Case matters: "AbuseIPDB" is a different string, not a spelling variant.
    expect(isKnownProvider("AbuseIPDB")).toBe(false);
  });

  it("refuses every cross-type pairing", () => {
    expect(isProviderSubjectCompatible("shodan", SUBJECT_TYPES.CVE)).toBe(false);
    expect(isProviderSubjectCompatible("censys", SUBJECT_TYPES.CVE)).toBe(false);
    expect(isProviderSubjectCompatible("nvd", SUBJECT_TYPES.IPV4)).toBe(false);
    expect(isProviderSubjectCompatible("abuseipdb", SUBJECT_TYPES.IPV4)).toBe(true);
    expect(isProviderSubjectCompatible("nvd", SUBJECT_TYPES.CVE)).toBe(true);
  });
});

describe("enrichmentSubject — IPV4 canonicalization", () => {
  it("accepts a canonical dotted quad and trims transport whitespace", () => {
    expect(canonicalizeSubjectValue(SUBJECT_TYPES.IPV4, "8.8.8.8")).toBe("8.8.8.8");
    expect(canonicalizeSubjectValue(SUBJECT_TYPES.IPV4, "  198.18.0.7  ")).toBe("198.18.0.7");
  });

  it("rejects the near-miss forms that would fragment work identity", () => {
    // Each of these, if silently normalized, would create a SECOND lookup job
    // for an address that already has one.
    const rejected = [
      "08.8.8.8", // leading zero
      "8.8.8.8/32", // CIDR suffix
      "8.8.8", // short
      "8.8.8.8.8", // long
      "256.1.1.1", // out of range
      "::1", // IPv6
      "example.com", // hostname
      "8.8.8.8:443", // port
      "",
    ];
    // eslint-disable-next-line no-restricted-syntax
    for (const value of rejected) {
      expect(() => canonicalizeSubjectValue(SUBJECT_TYPES.IPV4, value)).toThrow(
        EnrichmentSubjectError
      );
    }
  });
});

describe("enrichmentSubject — CVE canonicalization", () => {
  it("folds case to the canonical uppercase form", () => {
    expect(canonicalizeSubjectValue(SUBJECT_TYPES.CVE, "cve-2024-3094")).toBe("CVE-2024-3094");
    expect(canonicalizeSubjectValue(SUBJECT_TYPES.CVE, " CVE-2021-44228 ")).toBe("CVE-2021-44228");
  });

  it("rejects malformed identifiers", () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const value of ["CVE-24-3094", "2024-3094", "CVE-2024", "NOT-A-CVE", ""]) {
      expect(() => canonicalizeSubjectValue(SUBJECT_TYPES.CVE, value)).toThrow(
        EnrichmentSubjectError
      );
    }
  });
});

describe("enrichmentSubject — buildSubject and ordering", () => {
  it("returns a frozen canonical subject", () => {
    const subject = buildSubject({ subjectType: SUBJECT_TYPES.CVE, subjectValue: "cve-2024-3094" });
    expect(subject).toEqual({ subjectType: "CVE", subjectValue: "CVE-2024-3094" });
    expect(Object.isFrozen(subject)).toBe(true);
  });

  it("rejects an unknown subject type instead of passing it through", () => {
    expect(() => canonicalizeSubjectValue("DOMAIN", "example.com")).toThrow(EnrichmentSubjectError);
  });

  it("sorts targets deterministically regardless of input order", () => {
    const a = { provider: "censys", subjectType: "IPV4", subjectValue: "8.8.8.8" };
    const b = { provider: "abuseipdb", subjectType: "IPV4", subjectValue: "8.8.8.8" };
    const c = { provider: "nvd", subjectType: "CVE", subjectValue: "CVE-2024-3094" };

    expect(sortTargets([a, b, c])).toEqual(sortTargets([c, a, b]));
    expect(sortTargets([a, b, c])[0].provider).toBe("abuseipdb");
  });

  it("does not mutate the array it was given", () => {
    const targets = [
      { provider: "shodan", subjectType: "IPV4", subjectValue: "1.1.1.1" },
      { provider: "censys", subjectType: "IPV4", subjectValue: "1.1.1.1" },
    ];
    sortTargets(targets);
    expect(targets[0].provider).toBe("shodan");
  });
});
