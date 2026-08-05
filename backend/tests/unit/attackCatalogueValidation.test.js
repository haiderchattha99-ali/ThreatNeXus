import { describe, it, expect } from "vitest";

// Phase 6.3 — the pinned MITRE ATT&CK catalogue, and the validation it makes
// possible.
//
// The single most important test in this file is the fail-closed one. Every
// other guarantee in the phase rests on the claim that a missing or corrupt
// catalogue REFUSES ATT&CK mappings rather than quietly reverting to the Phase
// 5 format-only check — because the silent-revert failure mode would keep
// writing rows stamped "catalogue verified" while nothing verified them.


const catalogueModule = require("../../src/services/framework/attackCatalogue");
const {
  getAttackCatalogue,
  isAttackCatalogueAvailable,
  findTechnique,
  catalogueProvenance,
  CATALOGUE_FAILURE_CODES,
} = catalogueModule;

const {
  assertAttackCatalogueReference,
  titleMatchesTechnique,
} = require("../../src/services/framework/frameworkCatalogueRules");

const {
  MAPPING_REJECTION_CODES,
  FrameworkMappingValidationError,
} = require("../../src/services/framework/frameworkMappingErrors");

const {
  normalizeMappingContent,
  FRAMEWORK_FAMILIES,
} = require("../../src/services/framework/frameworkMappingRules");

const {
  attackCatalogueForTests,
  pinnedAttackVersion,
  stubCatalogue,
  evidenceFields,
} = require("../fixtures/frameworkEvidenceFixtures");

const CATALOGUE = attackCatalogueForTests();
const VERSION = pinnedAttackVersion();

const attackContent = (overrides = {}) => ({
  framework: FRAMEWORK_FAMILIES.MITRE_ATTACK,
  frameworkVersion: VERSION,
  referenceId: "T1021.001",
  referenceTitle: "Remote Desktop Protocol",
  mappingScope: "CASE",
  evidenceBasis: "OBSERVED_BEHAVIOR",
  rationale:
    "The constituent's SOC observed an interactive remote desktop session established by an " +
    "unrecognised account and confirmed it against their own authentication logs.",
  ...evidenceFields(),
  ...overrides,
});

function rejectionCodeFor(content, options = { attackCatalogue: CATALOGUE }) {
  try {
    normalizeMappingContent(content, options);
    return null;
  } catch (error) {
    if (!(error instanceof FrameworkMappingValidationError)) throw error;
    return error.code;
  }
}

describe("the pinned catalogue is real, official and internally consistent", () => {
  it("loads, and reports a genuine Enterprise release", () => {
    expect(isAttackCatalogueAvailable()).toBe(true);
    const catalogue = getAttackCatalogue();
    expect(catalogue.domain).toBe("enterprise-attack");
    expect(catalogue.attackVersion).toMatch(/^\d+\.\d+$/);
    // A partial or hand-written list would not have this shape. The real
    // Enterprise matrix has 14+ tactics and several hundred techniques.
    expect(catalogue.counts.tactics).toBeGreaterThanOrEqual(14);
    expect(catalogue.counts.techniques).toBeGreaterThan(500);
    expect(catalogue.counts.subTechniques).toBeGreaterThan(300);
  });

  it("records where it came from, so the pin is auditable", () => {
    const provenance = catalogueProvenance();
    expect(provenance.source.url).toMatch(/^https:\/\//);
    // A branch reference would not be a pin — the file behind it can change.
    expect(provenance.source.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.source.upstreamSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.attribution).toMatch(/MITRE/);
  });

  it("resolves parent techniques and sub-techniques distinctly", () => {
    const parent = findTechnique("T1021");
    const sub = findTechnique("T1021.001");

    expect(parent.isSubTechnique).toBe(false);
    expect(parent.parentId).toBeNull();

    expect(sub.isSubTechnique).toBe(true);
    expect(sub.parentId).toBe("T1021");
    // MITRE's own composed display name, so no renderer has to know the rule.
    expect(sub.displayName).toBe(`${parent.name}: ${sub.name}`);
  });

  it("carries lifecycle flags, including what a revoked technique became", () => {
    const catalogue = getAttackCatalogue();
    const revoked = catalogue.techniques.find((t) => t.revoked && t.revokedBy);
    expect(revoked).toBeDefined();
    expect(revoked.revokedBy).toMatch(/^T\d{4}(\.\d{3})?$/);
    expect(catalogue.counts.mappable).toBeLessThan(catalogue.counts.techniques);
  });
});

describe("exact technique validation", () => {
  it("accepts a real technique and returns MITRE's canonical spelling", () => {
    const content = normalizeMappingContent(attackContent(), { attackCatalogue: CATALOGUE });
    expect(content.referenceId).toBe("T1021.001");
    expect(content.referenceTitle).toBe("Remote Services: Remote Desktop Protocol");
    expect(content.attackIsSubTechnique).toBe(true);
    expect(content.attackParentTechniqueId).toBe("T1021");
    expect(content.attackTactics).toContain("lateral-movement");
    expect(content.catalogueVerified).toBe(true);
    expect(content.catalogueVersion).toBe(VERSION);
    expect(content.catalogueChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a parent technique and does not promote it to a sub-technique", () => {
    const content = normalizeMappingContent(
      attackContent({ referenceId: "T1021", referenceTitle: "Remote Services" }),
      { attackCatalogue: CATALOGUE }
    );
    expect(content.referenceId).toBe("T1021");
    expect(content.attackIsSubTechnique).toBe(false);
    expect(content.attackParentTechniqueId).toBeNull();
  });

  it("REFUSES a well-formed id that names nothing — the Phase 5 gap, now closed", () => {
    expect(rejectionCodeFor(attackContent({ referenceId: "T9999", referenceTitle: "Invented" }))).toBe(
      MAPPING_REJECTION_CODES.ATTACK_TECHNIQUE_NOT_IN_CATALOGUE
    );
  });

  it("refuses a revoked technique separately from an unknown one", () => {
    const revoked = getAttackCatalogue().techniques.find((t) => t.revoked);
    expect(
      rejectionCodeFor(
        attackContent({ referenceId: revoked.id, referenceTitle: revoked.displayName })
      )
    ).toBe(MAPPING_REJECTION_CODES.ATTACK_TECHNIQUE_REVOKED);
  });

  it("refuses a deprecated technique separately again", () => {
    const deprecated = getAttackCatalogue().techniques.find((t) => t.deprecated && !t.revoked);
    if (!deprecated) return; // no deprecated-but-not-revoked entry in this release
    expect(
      rejectionCodeFor(
        attackContent({ referenceId: deprecated.id, referenceTitle: deprecated.displayName })
      )
    ).toBe(MAPPING_REJECTION_CODES.ATTACK_TECHNIQUE_DEPRECATED);
  });

  it("does not silently coerce an approximate id", () => {
    // "T1021.1" is what a human typing quickly produces. It is NOT corrected to
    // T1021.001 — a stored mapping citing a technique the analyst never chose
    // would be recorded, audited and reported as their decision.
    expect(rejectionCodeFor(attackContent({ referenceId: "T1021.1" }))).toBe(
      MAPPING_REJECTION_CODES.ATTACK_TECHNIQUE_NOT_IN_CATALOGUE
    );
  });

  it("refuses a title that names a different technique, rather than overwriting it", () => {
    expect(rejectionCodeFor(attackContent({ referenceTitle: "SQL Injection" }))).toBe(
      MAPPING_REJECTION_CODES.ATTACK_TITLE_MISMATCH
    );
  });

  it("accepts either MITRE spelling of a sub-technique title", () => {
    const sub = findTechnique("T1021.001");
    expect(titleMatchesTechnique("Remote Desktop Protocol", sub)).toBe(true);
    expect(titleMatchesTechnique("Remote Services: Remote Desktop Protocol", sub)).toBe(true);
    expect(titleMatchesTechnique("  remote   desktop protocol ", sub)).toBe(true);
    expect(titleMatchesTechnique("Remote Services", sub)).toBe(false);
  });

  it("refuses a mapping claiming a framework version the pinned catalogue is not", () => {
    expect(rejectionCodeFor(attackContent({ frameworkVersion: "17.1" }))).toBe(
      MAPPING_REJECTION_CODES.ATTACK_VERSION_NOT_PINNED_CATALOGUE
    );
    // A leading "v" is a display convention, not a different release.
    expect(() =>
      normalizeMappingContent(attackContent({ frameworkVersion: `v${VERSION}` }), {
        attackCatalogue: CATALOGUE,
      })
    ).not.toThrow();
  });
});

describe("fail closed: no catalogue means no ATT&CK mapping", () => {
  // The load-bearing test of the whole phase.
  it("REFUSES rather than degrading to the Phase 5 format-only check", () => {
    expect(rejectionCodeFor(attackContent(), {})).toBe(
      MAPPING_REJECTION_CODES.ATTACK_CATALOGUE_REQUIRED
    );
    expect(rejectionCodeFor(attackContent(), { attackCatalogue: null })).toBe(
      MAPPING_REJECTION_CODES.ATTACK_CATALOGUE_REQUIRED
    );
    // An object that is not a usable catalogue is refused too, rather than
    // being probed for whatever methods it happens to have.
    expect(rejectionCodeFor(attackContent(), { attackCatalogue: { attackVersion: VERSION } })).toBe(
      MAPPING_REJECTION_CODES.ATTACK_CATALOGUE_REQUIRED
    );
  });

  it("never marks a mapping catalogue-verified when no catalogue ran", () => {
    // The only way to skip the check is to fail it, so there is no code path
    // that produces catalogueVerified: true without a real lookup.
    let thrown = null;
    try {
      normalizeMappingContent(attackContent(), {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrameworkMappingValidationError);
  });

  it("leaves NIST CSF and CIS unaffected — they never had a catalogue to lose", () => {
    const csf = normalizeMappingContent(
      {
        framework: FRAMEWORK_FAMILIES.NIST_CSF,
        frameworkVersion: "2.0",
        referenceId: "PR.AA-05",
        referenceTitle: "Access permissions and authorizations are defined and managed",
        mappingScope: "CASE",
        evidenceBasis: "CONTROL_GAP",
        rationale:
          "Administrative remote access is reachable from any network, indicating permissions " +
          "are not constrained to authorised sources.",
        ...evidenceFields(),
      },
      {} // no catalogue at all
    );
    expect(csf.catalogueVerified).toBe(false);
    expect(csf.catalogueVersion).toBeNull();
  });

  it("names its failure modes as a closed vocabulary", () => {
    expect(Object.values(CATALOGUE_FAILURE_CODES)).toContain("ATTACK_CATALOGUE_CHECKSUM_MISMATCH");
    expect(Object.values(CATALOGUE_FAILURE_CODES)).toContain("ATTACK_CATALOGUE_MISSING");
  });
});

describe("injected catalogues are honoured exactly", () => {
  it("uses the supplied catalogue and nothing else", () => {
    const stub = stubCatalogue([
      {
        id: "T0001",
        name: "Stub Technique",
        displayName: "Stub Technique",
        isSubTechnique: false,
        parentId: null,
        tactics: ["execution"],
        deprecated: false,
        revoked: false,
        revokedBy: null,
        url: null,
      },
    ]);

    const resolved = assertAttackCatalogueReference(
      { referenceId: "T0001", referenceTitle: "Stub Technique", frameworkVersion: "19.1" },
      stub
    );
    expect(resolved.referenceId).toBe("T0001");

    // A technique that exists in the REAL catalogue is unknown to this stub,
    // proving the injected catalogue is the only source consulted.
    expect(() =>
      assertAttackCatalogueReference(
        { referenceId: "T1021.001", referenceTitle: "Remote Desktop Protocol", frameworkVersion: "19.1" },
        stub
      )
    ).toThrow(FrameworkMappingValidationError);
  });
});
