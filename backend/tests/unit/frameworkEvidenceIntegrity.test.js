import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Phase 6.3 — evidence integrity.
//
// Two claims are under test, and they are different claims:
//
//   1. SHAPE. Every mapping carries a quote, a named source, and TWO separate
//      confidences. Decided without a database.
//   2. TRUTH. The quote actually occurs, character for character, in the record
//      it cites. Decided against the record, inside the write transaction.
//
// The second is the one that matters. A system that required a quote field but
// never checked it would have added a text box, not an evidence obligation.

const { createWorkflowPrismaFake } = require("./fixtures/workflowPrismaFake");

const mappingService = require("../../src/services/framework/frameworkMappingService");
const evidenceService = require("../../src/services/framework/frameworkEvidenceService");
const {
  CONFIDENCE_LEVEL_VALUES,
  EVIDENCE_QUOTE_SOURCE_VALUES,
  MIN_EVIDENCE_QUOTE_LENGTH,
  quoteAppearsVerbatim,
  normalizeEvidenceIntegrity,
  flattenPayloadCandidates,
  buildEvidenceLocator,
} = require("../../src/services/framework/frameworkEvidenceRules");

const {
  MAPPING_REJECTION_CODES,
  FrameworkMappingValidationError,
  FrameworkMappingStateError,
} = require("../../src/services/framework/frameworkMappingErrors");

const {
  evidenceFields,
  findingEvidenceFields,
  CASE_RESPONSE_EVIDENCE_TEXT,
} = require("../fixtures/frameworkEvidenceFixtures");

const T = (n) => new Date(Date.UTC(2026, 7, 5, 0, n, 0));

let fake;
let client;
let state;
let errorSpy;
let ORG_ID;
let CASE_ID;
let FINDING_ID;
let ACTOR_ID;

const NIST = (overrides = {}) => ({
  framework: "NIST_CSF",
  frameworkVersion: "2.0",
  referenceId: "PR.AA-01",
  referenceTitle: "Identities and credentials are managed",
  mappingScope: "CASE",
  evidenceBasis: "CONTROL_GAP",
  rationale:
    "Administrative remote access is reachable from any network, indicating access permissions " +
    "are not constrained to authorised sources.",
  ...evidenceFields(),
  ...overrides,
});

async function seed() {
  const organization = await client.organization.create({
    data: { name: "Evidence Co", sector: "FINANCE", contactPerson: "SOC", email: "soc@ev.example" },
  });
  ORG_ID = organization.id;

  const actor = await client.user.create({
    data: { name: "E. Analyst", email: "evidence@example.test", role: "ANALYST" },
  });
  ACTOR_ID = actor.id;

  const finding = await client.finding.create({
    data: {
      indicatorValue: "203.0.113.45",
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      firstSeen: T(1),
      lastSeen: T(1),
      occurrenceCount: 1,
    },
  });
  FINDING_ID = finding.id;

  const record = await client.case.create({
    data: {
      title: "Accessible RDP",
      threatType: "Accessible RDP",
      organization: "Evidence Co",
      analyst: "e.analyst",
      organizationId: ORG_ID,
      lifecycleState: "OPEN",
      caseReference: "TNX-2026-000063",
    },
  });
  CASE_ID = record.id;

  await client.caseFinding.create({
    data: {
      caseId: CASE_ID,
      findingId: FINDING_ID,
      state: "LINKED",
      organizationId: ORG_ID,
      ownershipStatusAtLink: "RESOLVED",
      ownershipConfidenceAtLink: "HIGH",
      effectiveAt: T(1),
      supersededAt: null,
      currentLinkKey: `${CASE_ID}:${FINDING_ID}`,
    },
  });

  await client.caseOrganizationResponse.create({
    data: {
      caseId: CASE_ID,
      responseType: "ACKNOWLEDGED",
      summary: CASE_RESPONSE_EVIDENCE_TEXT,
      occurredAt: T(1),
      recordedByUserId: ACTOR_ID,
    },
  });
}

const base = () => ({ client, actorUserId: ACTOR_ID });

beforeEach(async () => {
  fake = createWorkflowPrismaFake();
  client = fake.client;
  state = fake.state;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  await seed();
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("shape: what every mapping must carry", () => {
  it("requires a quote, a named source, and BOTH confidences", () => {
    const required = [
      ["evidenceQuote", MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_REQUIRED],
      ["evidenceQuoteSource", MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_REQUIRED],
      ["evidenceConfidence", MAPPING_REJECTION_CODES.EVIDENCE_CONFIDENCE_REQUIRED],
      ["mappingConfidence", MAPPING_REJECTION_CODES.MAPPING_CONFIDENCE_REQUIRED],
    ];

    required.forEach(([field, code]) => {
      const raw = { ...evidenceFields(), evidenceFindingId: null, [field]: undefined };
      try {
        normalizeEvidenceIntegrity(raw);
        throw new Error(`expected ${field} to be required`);
      } catch (error) {
        expect(error).toBeInstanceOf(FrameworkMappingValidationError);
        expect(error.code).toBe(code);
      }
    });
  });

  it("refuses a quote short enough to match a record by coincidence", () => {
    try {
      normalizeEvidenceIntegrity({
        ...evidenceFields({ evidenceQuote: "rdp" }),
        evidenceFindingId: null,
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error.code).toBe(MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_TOO_SHORT);
    }
    expect(MIN_EVIDENCE_QUOTE_LENGTH).toBeGreaterThan(8);
  });

  it("requires a Finding when the quote source is Finding-anchored", () => {
    ["FINDING_RECORD", "RAW_REPORT_ROW"].forEach((source) => {
      try {
        normalizeEvidenceIntegrity({
          ...findingEvidenceFields({ evidenceQuoteSource: source }),
          evidenceFindingId: null,
        });
        throw new Error(`expected ${source} to require a Finding`);
      } catch (error) {
        expect(error.code).toBe(MAPPING_REJECTION_CODES.EVIDENCE_SOURCE_REQUIRES_FINDING);
      }
    });

    // CASE_RESPONSE is not Finding-anchored, so it is coherent without one.
    expect(() =>
      normalizeEvidenceIntegrity({ ...evidenceFields(), evidenceFindingId: null })
    ).not.toThrow();
  });

  it("rejects a quote containing control characters rather than stripping them", () => {
    const withNul = `interactive administrative${String.fromCharCode(0)} session was established`;
    expect(() =>
      normalizeEvidenceIntegrity({
        ...evidenceFields({ evidenceQuote: withNul }),
        evidenceFindingId: null,
      })
    ).toThrow(FrameworkMappingValidationError);
  });
});

describe("the two confidences are separate, and stay separate", () => {
  it("accepts them independently, including a genuinely LOW mapping confidence", () => {
    const normalized = normalizeEvidenceIntegrity({
      ...evidenceFields({ evidenceConfidence: "HIGH", mappingConfidence: "LOW" }),
      evidenceFindingId: null,
    });
    expect(normalized.evidenceConfidence).toBe("HIGH");
    expect(normalized.mappingConfidence).toBe("LOW");
  });

  it("never derives a combined confidence from the pair", () => {
    const normalized = normalizeEvidenceIntegrity({
      ...evidenceFields(),
      evidenceFindingId: null,
    });
    // If a combinator is ever added, it will land here as a new key — and this
    // assertion is what will notice. A single "confidence" would invite a
    // downstream threshold, and a threshold creates pressure to inflate
    // whichever input moves it.
    expect(Object.keys(normalized).sort()).toEqual([
      "evidenceConfidence",
      "evidenceQuote",
      "evidenceQuoteSource",
      "mappingConfidence",
    ]);
    expect(normalized).not.toHaveProperty("confidence");
    expect(normalized).not.toHaveProperty("combinedConfidence");
    expect(normalized).not.toHaveProperty("overallConfidence");
  });

  it("never refuses a mapping for declaring LOW confidence", async () => {
    const outcome = await mappingService.createManualMapping(
      CASE_ID,
      NIST({ evidenceConfidence: "LOW", mappingConfidence: "LOW" }),
      { ...base(), effectiveAt: T(2) }
    );
    // An honestly-declared LOW is a better record than a coerced HIGH, and a
    // system that punished it would simply teach analysts to always pick HIGH.
    expect(outcome.changed).toBe(true);
    expect(outcome.mapping.evidenceConfidence).toBe("LOW");
    expect(outcome.mapping.mappingConfidence).toBe("LOW");
  });

  it("exposes both vocabularies as closed sets", () => {
    expect(CONFIDENCE_LEVEL_VALUES).toEqual(["LOW", "MEDIUM", "HIGH"]);
    expect(EVIDENCE_QUOTE_SOURCE_VALUES).toEqual([
      "FINDING_RECORD",
      "RAW_REPORT_ROW",
      "CASE_RESPONSE",
    ]);
  });
});

describe("truth: the quote must actually be in the record", () => {
  it("verifies against a recorded organization response and stores where it was found", async () => {
    const outcome = await mappingService.createManualMapping(CASE_ID, NIST(), {
      ...base(),
      effectiveAt: T(2),
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.mapping.evidenceQuoteSource).toBe("CASE_RESPONSE");
    // "<source>:<recordId>:<field>" — a reviewer can go and read the original.
    expect(outcome.mapping.evidenceQuoteLocator).toMatch(/^CASE_RESPONSE:\d+:summary$/);
  });

  it("REFUSES a quote that appears in no record, as a state conflict not a validation error", async () => {
    let thrown;
    try {
      await mappingService.createManualMapping(
        CASE_ID,
        NIST({ evidenceQuote: "the constituent admitted to running the malware themselves" }),
        { ...base(), effectiveAt: T(2) }
      );
    } catch (error) {
      thrown = error;
    }

    // 409, not 400: the input was well formed, the record simply does not say
    // that. The analyst's fix is to go and look again, not to retype.
    expect(thrown).toBeInstanceOf(FrameworkMappingStateError);
    expect(thrown.code).toBe(MAPPING_REJECTION_CODES.EVIDENCE_QUOTE_NOT_VERBATIM);
    expect(state.caseFrameworkMappings).toHaveLength(0);
  });

  it("verifies against the Finding's own record and names the field", async () => {
    const outcome = await mappingService.createManualMapping(
      CASE_ID,
      NIST({
        ...findingEvidenceFields(),
        evidenceFindingId: FINDING_ID,
      }),
      { ...base(), effectiveAt: T(2) }
    );

    expect(outcome.changed).toBe(true);
    expect(outcome.mapping.evidenceQuoteLocator).toBe(
      `FINDING_RECORD:${FINDING_ID}:identity`
    );
  });

  it("refuses a Finding-anchored quote when the cited Finding has no ingested rows", async () => {
    let thrown;
    try {
      await mappingService.createManualMapping(
        CASE_ID,
        NIST({
          ...findingEvidenceFields({ evidenceQuoteSource: "RAW_REPORT_ROW" }),
          evidenceFindingId: FINDING_ID,
        }),
        { ...base(), effectiveAt: T(2) }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrameworkMappingStateError);
    expect(thrown.code).toBe(MAPPING_REJECTION_CODES.EVIDENCE_SOURCE_RECORD_UNAVAILABLE);
  });

  it("matches only on whitespace normalization — case and punctuation must be exact", () => {
    const record = "The constituent confirmed an interactive administrative session.";
    expect(quoteAppearsVerbatim("interactive   administrative session", record)).toBe(true);
    expect(quoteAppearsVerbatim("  interactive administrative session ", record)).toBe(true);
    // Case differs.
    expect(quoteAppearsVerbatim("Interactive Administrative Session", record)).toBe(false);
    // Punctuation differs.
    expect(quoteAppearsVerbatim("interactive, administrative session", record)).toBe(false);
    // An empty quote must never be a substring of everything.
    expect(quoteAppearsVerbatim("   ", record)).toBe(false);
  });
});

describe("quoting ingested report data", () => {
  it("flattens a nested payload into individually-named quotable fields", () => {
    const candidates = flattenPayloadCandidates(
      { asn: 64500, geo: { country: "PK", city: "Islamabad" }, tags: ["rdp", "exposed"] },
      "rawPayload"
    );
    const fields = candidates.map((candidate) => candidate.field);
    expect(fields).toContain("rawPayload.asn");
    expect(fields).toContain("rawPayload.geo.country");
    expect(fields).toContain("rawPayload.tags[0]");
    // Numbers are stringified so a port or an ASN is quotable.
    expect(candidates.find((c) => c.field === "rawPayload.asn").value).toBe("64500");
  });

  it("is depth- and size-bounded against a pathological payload", () => {
    let deep = "leaf";
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(() => flattenPayloadCandidates(deep, "rawPayload")).not.toThrow();

    const wide = {};
    for (let i = 0; i < 1000; i += 1) wide[`k${i}`] = `v${i}`;
    expect(flattenPayloadCandidates(wide, "rawPayload").length).toBeLessThanOrEqual(200);
  });

  it("builds a locator a reviewer can follow", () => {
    expect(buildEvidenceLocator("RAW_REPORT_ROW", 88, "rawPayload.asn")).toBe(
      "RAW_REPORT_ROW:88:rawPayload.asn"
    );
  });

  it("offers no enrichment-derived value as quotable evidence", () => {
    const fields = evidenceService
      .findingQuoteCandidates({
        indicatorValue: "203.0.113.45",
        port: 3389,
        protocol: "TCP",
        reportType: "ACCESSIBLE_RDP",
        status: "OPEN",
        firstSeen: T(1),
        lastSeen: T(1),
        closureReason: null,
      })
      .map((candidate) => candidate.field);

    // Risk band, reputation, KEV and EPSS are exactly the exposure signals an
    // ATT&CK rationale is forbidden to rest on. Offering them here would hand
    // them back through the evidence door.
    ["riskBand", "riskScore", "reputation", "abuseConfidence", "kev", "epss", "ownership"].forEach(
      (forbidden) => expect(fields).not.toContain(forbidden)
    );
  });
});

describe("history stays honest", () => {
  it("leaves a legacy row's nulls alone and does not retro-verify it", async () => {
    // A row exactly as Phase 5 would have written it.
    const legacy = await client.caseFrameworkMapping.create({
      data: {
        caseId: CASE_ID,
        organizationId: ORG_ID,
        framework: "NIST_CSF",
        frameworkVersion: "2.0",
        referenceId: "PR.AA-02",
        referenceTitle: "Identities are proofed and bound to credentials",
        mappingScope: "CASE",
        evidenceBasis: "CONTROL_GAP",
        rationale: "Recorded before the Phase 6.3 evidence obligations existed.",
        state: "ACTIVE",
        source: "MANUAL",
        actorUserId: ACTOR_ID,
        effectiveAt: T(1),
        supersededAt: null,
        currentMappingKey: `${CASE_ID}:NIST_CSF:CASE:PR.AA-02`,
      },
    });

    expect(legacy.evidenceQuote).toBeNull();
    expect(legacy.catalogueVerified).toBe(false);

    // Withdrawing it must still work — a legacy row that could not be removed
    // would trap exactly the mappings most in need of revisiting.
    const outcome = await mappingService.removeMapping(CASE_ID, legacy.id, {
      ...base(),
      effectiveAt: T(3),
      reason: "Superseded by a mapping recorded under the current evidence rules.",
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.mapping.state).toBe("REMOVED");
    // The REMOVED row carries the legacy nulls forward rather than inventing
    // evidence that was never recorded.
    expect(outcome.mapping.evidenceQuote).toBeNull();
    expect(outcome.mapping.catalogueVerified).toBe(false);

    // And the original row is untouched apart from being superseded.
    const original = state.caseFrameworkMappings.find((row) => row.id === legacy.id);
    expect(original.rationale).toBe("Recorded before the Phase 6.3 evidence obligations existed.");
    expect(original.state).toBe("ACTIVE");
  });
});
