import { describe, it, expect } from "vitest";

// The sector context API must distinguish every way sector criticality can be
// inapplicable — "no organization", "ambiguous", "ISP", "confidence too low"
// and "sector UNKNOWN" are five different analyst conversations, and collapsing
// them into one false is the failure mode these tests exist to prevent.
//
// Applicability itself is NOT recomputed by the module under test: it delegates
// to riskInputSnapshot.loadOwnershipContext, the same gate the risk engine
// scores with. These tests therefore also pin that delegation.

const {
  SECTOR_APPLICABILITY,
  ATTRIBUTION_TYPE,
  deriveAttributionType,
  buildSectorContext,
} = require("../../src/services/ownership/ownershipSectorContext");

function createClient({ ownership = null, organization = null, mapping = null } = {}) {
  return {
    findingOwnership: {
      findUnique: async () => (ownership ? { ...ownership } : null),
    },
    organization: {
      findUnique: async () => (organization ? { ...organization } : null),
    },
    assetMapping: {
      findUnique: async () => (mapping ? { ...mapping } : null),
    },
  };
}

function ownershipRow(overrides = {}) {
  return {
    id: 1,
    findingId: 1,
    organizationId: 7,
    status: "RESOLVED",
    confidence: "HIGH",
    matchedMappingId: null,
    matchedPrefixLength: 24,
    candidateCount: 1,
    isIspAttribution: false,
    reasonCode: "OWNERSHIP_CIDR_MATCH",
    resolvedAt: new Date("2026-06-01T00:00:00Z"),
    asOf: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("deriveAttributionType", () => {
  it("names each derivation path with a closed code", () => {
    expect(deriveAttributionType(null)).toBe(ATTRIBUTION_TYPE.NONE);
    expect(deriveAttributionType(ownershipRow({ status: "OVERRIDDEN" }))).toBe(
      ATTRIBUTION_TYPE.ANALYST_OVERRIDE
    );
    expect(deriveAttributionType(ownershipRow({ status: "AMBIGUOUS" }))).toBe(
      ATTRIBUTION_TYPE.AMBIGUOUS
    );
    expect(deriveAttributionType(ownershipRow({ isIspAttribution: true }))).toBe(
      ATTRIBUTION_TYPE.ISP_ASN
    );
    expect(
      deriveAttributionType(ownershipRow({ reasonCode: "OWNERSHIP_EXACT_IP_MATCH" }))
    ).toBe(ATTRIBUTION_TYPE.EXACT_IP);
    expect(deriveAttributionType(ownershipRow())).toBe(ATTRIBUTION_TYPE.CIDR);
  });

  it("reports ISP-ness ahead of the matched tier", () => {
    // An ASN match that did resolve an organization is still only an ISP.
    const row = ownershipRow({ isIspAttribution: true, reasonCode: "OWNERSHIP_ASN_MATCH" });
    expect(deriveAttributionType(row)).toBe(ATTRIBUTION_TYPE.ISP_ASN);
  });
});

describe("buildSectorContext — applicability states", () => {
  it("is APPLICABLE for a high-confidence resolved row with a known sector", async () => {
    const row = ownershipRow();
    const client = createClient({
      ownership: row,
      organization: { name: "Acme Health", sector: "HEALTHCARE" },
    });
    const context = await buildSectorContext(client, 1, row);

    expect(context.sectorCriticalityApplicability).toBe(SECTOR_APPLICABILITY.APPLICABLE);
    expect(context.sectorCriticalityApplicable).toBe(true);
    expect(context.sector).toBe("HEALTHCARE");
    expect(context.organizationName).toBe("Acme Health");
    expect(context.attributionType).toBe(ATTRIBUTION_TYPE.CIDR);
  });

  it("distinguishes a known sector blocked by low confidence", async () => {
    const row = ownershipRow({ confidence: "LOW" });
    const client = createClient({
      ownership: row,
      organization: { name: "Acme Health", sector: "HEALTHCARE" },
    });
    const context = await buildSectorContext(client, 1, row);
    expect(context.sectorCriticalityApplicability).toBe(
      SECTOR_APPLICABILITY.NOT_APPLICABLE_LOW_CONFIDENCE
    );
    expect(context.sectorCriticalityApplicable).toBe(false);
  });

  it("distinguishes an UNKNOWN sector from a missing organization", async () => {
    const row = ownershipRow();
    const unknownSector = await buildSectorContext(
      createClient({ ownership: row, organization: { name: "Acme", sector: "UNKNOWN" } }),
      1,
      row
    );
    expect(unknownSector.sectorCriticalityApplicability).toBe(
      SECTOR_APPLICABILITY.NOT_APPLICABLE_UNKNOWN_SECTOR
    );

    const noOrgRow = ownershipRow({ organizationId: null, status: "UNRESOLVED", confidence: null });
    const noOrg = await buildSectorContext(createClient({ ownership: noOrgRow }), 1, noOrgRow);
    expect(noOrg.sectorCriticalityApplicability).toBe(
      SECTOR_APPLICABILITY.NOT_APPLICABLE_UNRESOLVED
    );
  });

  it("distinguishes ambiguous ownership", async () => {
    const row = ownershipRow({ status: "AMBIGUOUS", confidence: null, organizationId: null });
    const context = await buildSectorContext(createClient({ ownership: row }), 1, row);
    expect(context.sectorCriticalityApplicability).toBe(
      SECTOR_APPLICABILITY.NOT_APPLICABLE_AMBIGUOUS
    );
  });

  it("distinguishes ISP attribution even when an organization resolved", async () => {
    const row = ownershipRow({ confidence: "LOW", isIspAttribution: true });
    const client = createClient({
      ownership: row,
      organization: { name: "Some ISP", sector: "TELECOM" },
    });
    const context = await buildSectorContext(client, 1, row);
    // ISP is reported ahead of confidence: the honest reason is "this is the
    // carrier, not the victim", not "we were not sure enough".
    expect(context.sectorCriticalityApplicability).toBe(
      SECTOR_APPLICABILITY.NOT_APPLICABLE_ISP_ATTRIBUTION
    );
    expect(context.isIspAttribution).toBe(true);
  });

  it("reports NO_OWNERSHIP when there is no current row at all", async () => {
    const context = await buildSectorContext(createClient(), 1, null);
    expect(context.sectorCriticalityApplicability).toBe(
      SECTOR_APPLICABILITY.NOT_APPLICABLE_NO_OWNERSHIP
    );
    expect(context.attributionType).toBe(ATTRIBUTION_TYPE.NONE);
    expect(context.resolvedAt).toBeNull();
  });

  it("treats an explicit override as applicable", async () => {
    const row = ownershipRow({
      status: "OVERRIDDEN",
      confidence: "CONFIRMED",
      matchedMappingId: null,
    });
    const client = createClient({
      ownership: row,
      organization: { name: "Acme Health", sector: "HEALTHCARE" },
    });
    const context = await buildSectorContext(client, 1, row);
    expect(context.sectorCriticalityApplicability).toBe(SECTOR_APPLICABILITY.APPLICABLE);
    expect(context.attributionType).toBe(ATTRIBUTION_TYPE.ANALYST_OVERRIDE);
  });
});

describe("buildSectorContext — what it must never expose", () => {
  it("exposes mapping provenance but no address internals or analyst note", async () => {
    const row = ownershipRow({ matchedMappingId: 3 });
    const client = createClient({
      ownership: row,
      organization: { name: "Acme Health", sector: "HEALTHCARE" },
      mapping: {
        id: 3,
        mappingType: "CIDR",
        source: "MANUAL",
        mappingConfirmed: true,
        // Fields the select must not pull through even if present here:
        ipStart: 123n,
        ipEnd: 456n,
        provenanceNote: "internal analyst note",
      },
    });
    const context = await buildSectorContext(client, 1, row);

    expect(context.matchedMapping).toEqual({
      id: 3,
      mappingType: "CIDR",
      source: "MANUAL",
      mappingConfirmed: true,
    });
    const serialized = JSON.stringify(context, (k, v) =>
      typeof v === "bigint" ? v.toString() : v
    );
    expect(serialized).not.toContain("provenanceNote");
    expect(serialized).not.toContain("ipStart");
    expect(serialized).not.toContain("internal analyst note");
  });

  it("never carries organization contact details or internal scoring fields", async () => {
    const row = ownershipRow();
    const client = createClient({
      ownership: row,
      organization: { name: "Acme Health", sector: "HEALTHCARE" },
    });
    const context = await buildSectorContext(client, 1, row);

    ["email", "phone", "contactPerson", "securityScore", "activeThreats", "currentForFindingId"]
      .forEach((forbidden) => expect(context).not.toHaveProperty(forbidden));
    // Applicability is a gate, not a number — points stay in the risk surface.
    expect(context).not.toHaveProperty("contributionBasisPoints");
  });
});
