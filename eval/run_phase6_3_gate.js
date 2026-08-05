"use strict";

// ===========================================================================
// Executable Phase 6.3 gate — pinned ATT&CK catalogue, exact technique
// validation, evidence integrity, and the honest "no applicable mapping" state.
//
// Drives the REAL production services against a disposable PostgreSQL database,
// in the order an analyst would drive them, and compares every result against
// expectations written out by hand in this file.
//
// The twelve proofs:
//
//    1. the pinned catalogue is an official MITRE Enterprise release, loads,
//       and matches its own recorded SHA-256
//    2. an exact, current technique is ACCEPTED and stored with MITRE's own
//       canonical spelling
//    3. a well-formed technique id that names NOTHING is REFUSED — the Phase 5
//       gap, closed
//    4. parent techniques and sub-techniques are distinguished, and an
//       approximate id is refused rather than coerced
//    5. a revoked and a deprecated technique are refused, each with its own
//       code, and a wrong title is refused rather than overwritten
//    6. a mapping naming a framework version other than the pinned catalogue's
//       is refused
//    7. an evidence quote that is not verbatim in the cited record is REFUSED,
//       and one that is verbatim records exactly where it was found
//    8. evidence confidence and mapping confidence are stored separately and
//       are never combined
//    9. a legacy row is neither rewritten nor retro-verified, is reported as
//       legacy, and remains withdrawable
//   10. "no reference in this framework applies" is recordable, audited, and
//       mutually exclusive with an active mapping in BOTH directions
//   11. an AI suggestion cannot bypass any of the above — with AI on, the
//       deterministic mock's catalogue- and evidence-invalid candidates are all
//       discarded, and a promoted one is re-verified
//   12. the navigator emits raw counts only, and NO coverage percentage, on
//       both an empty and a populated dataset
//
// Usage:
//   EVAL_DATABASE_URL="postgresql://user:pw@localhost:5432/threatnexus_eval" \
//     npm run eval:phase6.3
//
// Safety: refuses to run without an explicit EVAL_DATABASE_URL, refuses to run
// if it equals DATABASE_URL, never reads DATABASE_URL for its own connection
// (only for that one equality check), never resets/truncates/drops, and cleans
// up an exact evaluator-owned id set on success AND on failure.
//
// HAND-AUTHORED EXPECTATIONS. Every expected value below is a literal. Nothing
// is read back from the module it is meant to be checking — a gate asserting
// `code === MAPPING_REJECTION_CODES.X` would pass no matter what X became.
//
// NO NETWORK. `global.fetch` is replaced with a counter that throws, and the
// count is asserted to be zero. The only AI provider reachable is the
// deterministic offline mock, behind an explicit test-only opt-in.
// ===========================================================================

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const REPO_ROOT = path.join(__dirname, "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");

// RFC 2544 benchmarking range, second octet 27 — distinct from 198.18/19
// (phase2), 198.20/21 (enrichment), 198.22 (phase3), 198.23 (phase4),
// 198.25/26 (phase5) and every RFC 5737 range already claimed, so a shared
// evaluation database can never let this gate's cleanup collide with another's.
const MARKER = "phase6-3-gate";
const NET = "198.27";

// --- Hand-transcribed expectations -----------------------------------------
const PINNED_ATTACK_VERSION = "19.1";
const PINNED_ATTACK_DOMAIN = "enterprise-attack";

// A real, current sub-technique and its parent, with MITRE's own spellings.
const REAL_SUBTECHNIQUE = "T1021.001";
const REAL_SUBTECHNIQUE_BARE_NAME = "Remote Desktop Protocol";
const REAL_SUBTECHNIQUE_DISPLAY_NAME = "Remote Services: Remote Desktop Protocol";
const REAL_PARENT_TECHNIQUE = "T1021";
const REAL_PARENT_NAME = "Remote Services";
const REAL_SUBTECHNIQUE_TACTIC = "lateral-movement";

// Never existed.
const UNKNOWN_TECHNIQUE = "T9999";
// Revoked by MITRE in favour of T1560.
const REVOKED_TECHNIQUE = "T1002";
const REVOKED_TECHNIQUE_NAME = "Data Compressed";

const EXPECTED_CONFIDENCE_LEVELS = ["LOW", "MEDIUM", "HIGH"];
const EXPECTED_QUOTE_SOURCES = ["FINDING_RECORD", "RAW_REPORT_ROW", "CASE_RESPONSE"];

const EVAL_RESPONSE_SUMMARY =
  "The constituent confirmed an interactive administrative session was established " +
  "outside their change window and has since disabled the account.";

const EVAL_EVIDENCE = Object.freeze({
  evidenceQuote: "interactive administrative session was established",
  evidenceQuoteSource: "CASE_RESPONSE",
  evidenceConfidence: "HIGH",
  mappingConfidence: "MEDIUM",
});

const OBSERVED_BEHAVIOUR_RATIONALE =
  "The constituent supplied Windows security event logs showing several thousand failed " +
  "interactive logon attempts against one administrator account from a single external source, " +
  "followed by an authentication success the account owner did not perform.";

const NO_APPLICABLE_RATIONALE =
  "The evidence for this case is an exposed RDP service and nothing more. No adversary " +
  "behaviour was observed or reported by the constituent, so no ATT&CK technique applies.";

// Fixed instants. No wall clock is read anywhere, so a re-run produces
// byte-identical expectations.
const T = (hour) => new Date(`2026-08-05T${String(hour).padStart(2, "0")}:00:00.000Z`);

class GateSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "GateSafetyError";
  }
}

function assertSafeEvalDatabaseUrl(env) {
  const evalDatabaseUrl = env.EVAL_DATABASE_URL;
  const originalDatabaseUrl = env.DATABASE_URL;

  if (!evalDatabaseUrl || evalDatabaseUrl.trim() === "") {
    throw new GateSafetyError(
      "EVAL_DATABASE_URL is required. Refusing to run without an explicit, dedicated evaluation database."
    );
  }
  if (originalDatabaseUrl && evalDatabaseUrl.trim() === originalDatabaseUrl.trim()) {
    throw new GateSafetyError(
      "EVAL_DATABASE_URL must not equal DATABASE_URL. Refusing to run against the development database."
    );
  }
  return evalDatabaseUrl;
}

function stageEnvPlaceholdersForConfigLoad(env) {
  env.NODE_ENV = env.NODE_ENV || "test";
  env.DATABASE_URL = env.DATABASE_URL || "postgresql://unused:unused@localhost:5432/unused";
  env.JWT_SECRET = env.JWT_SECRET || "a-reasonably-strong-32-char-plus-secret-value";
  env.CORS_ORIGIN = env.CORS_ORIGIN || "http://localhost:5173";
  // The shipped default, stated explicitly so every scenario below describes
  // the system as it actually ships rather than as the shell left it.
  env.AI_ENABLED = "false";
  env.AI_PROVIDER = "null";
}

function requireBackend(relativePath) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(BACKEND_DIR, relativePath));
}

// --- Assertion harness ------------------------------------------------------
const results = [];
let assertionCount = 0;

function scenario(id, title) {
  const record = { id, title, diffs: [] };
  results.push(record);
  return {
    eq(label, actual, expected) {
      assertionCount += 1;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        record.diffs.push({ path: `${id}.${label}`, expected, actual });
      }
    },
    ok(label, actual) {
      assertionCount += 1;
      if (actual !== true) record.diffs.push({ path: `${id}.${label}`, expected: true, actual });
    },
    async throws(label, promise, expectedName, expectedCode) {
      assertionCount += 1;
      try {
        await promise;
        record.diffs.push({ path: `${id}.${label}`, expected: expectedName, actual: "resolved" });
      } catch (error) {
        const actualName = error && error.name;
        if (actualName !== expectedName) {
          record.diffs.push({ path: `${id}.${label}`, expected: expectedName, actual: actualName });
          return;
        }
        if (expectedCode !== undefined) {
          assertionCount += 1;
          if (error.code !== expectedCode) {
            record.diffs.push({
              path: `${id}.${label}.code`,
              expected: expectedCode,
              actual: error.code,
            });
          }
        }
      }
    },
  };
}

// --- Fixture helpers --------------------------------------------------------

async function cleanupEvalState(prisma) {
  const cases = await prisma.case.findMany({
    where: { organization: { startsWith: MARKER } },
    select: { id: true },
  });
  const caseIds = cases.map((row) => row.id);

  const findings = await prisma.finding.findMany({
    where: { indicatorValue: { startsWith: `${NET}.` } },
    select: { id: true },
  });
  const findingIds = findings.map((row) => row.id);

  if (caseIds.length > 0) {
    const suggestions = await prisma.aiFrameworkMappingSuggestion.findMany({
      where: { caseId: { in: caseIds } },
      select: { id: true },
    });
    const suggestionIds = suggestions.map((row) => row.id);
    if (suggestionIds.length > 0) {
      await prisma.aiSuggestionDecision.deleteMany({
        where: { suggestionId: { in: suggestionIds } },
      });
      // Released before the mappings they point at, or Restrict blocks the
      // delete.
      await prisma.aiFrameworkMappingSuggestion.updateMany({
        where: { id: { in: suggestionIds } },
        data: { promotedMappingId: null },
      });
      await prisma.aiFrameworkMappingSuggestion.deleteMany({
        where: { id: { in: suggestionIds } },
      });
    }
    await prisma.aiSuggestionRun.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.caseFrameworkMapping.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.caseFrameworkNoMappingAssertion.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.caseOrganizationResponse.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.caseLifecycleEvent.deleteMany({ where: { caseId: { in: caseIds } } });
  }

  await prisma.caseFinding.deleteMany({
    where: { OR: [{ caseId: { in: caseIds } }, { findingId: { in: findingIds } }] },
  });
  await prisma.findingTriage.deleteMany({
    where: { OR: [{ caseId: { in: caseIds } }, { findingId: { in: findingIds } }] },
  });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.findingOwnership.deleteMany({ where: { findingId: { in: findingIds } } });
  await prisma.finding.deleteMany({ where: { id: { in: findingIds } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: MARKER } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: MARKER } } });
}

async function seedCase(prisma, label, octet) {
  const organization = await prisma.organization.create({
    data: {
      name: `${MARKER}-org-${label}`,
      sector: "FINANCE",
      industry: "synthetic",
      location: "synthetic",
      contactPerson: "Synthetic Contact",
      email: `${MARKER}-${label}@example.test`,
    },
  });

  const finding = await prisma.finding.create({
    data: {
      indicatorValue: `${NET}.0.${octet}`,
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      firstSeen: T(8),
      lastSeen: T(8),
      occurrenceCount: 1,
      recurrenceCount: 0,
    },
  });

  const caseRecord = await prisma.case.create({
    data: {
      title: `Accessible RDP ${label}`,
      threatType: "Accessible RDP",
      organization: `${MARKER}-org-${label}`,
      analyst: `${MARKER}-analyst`,
      organizationId: organization.id,
      lifecycleState: "OPEN",
      caseReference: `TNX-2026-6300${octet}`,
    },
  });

  await prisma.caseFinding.create({
    data: {
      caseId: caseRecord.id,
      findingId: finding.id,
      state: "LINKED",
      organizationId: organization.id,
      ownershipStatusAtLink: "RESOLVED",
      ownershipConfidenceAtLink: "HIGH",
      effectiveAt: T(8),
      supersededAt: null,
      currentLinkKey: `${caseRecord.id}:${finding.id}`,
    },
  });

  // The record every CASE-scoped evidence quote below is verified against.
  await prisma.caseOrganizationResponse.create({
    data: {
      caseId: caseRecord.id,
      responseType: "ACKNOWLEDGED",
      summary: EVAL_RESPONSE_SUMMARY,
      occurredAt: T(8),
    },
  });

  return { organization, caseRecord, finding };
}

const attackContent = (overrides = {}) => ({
  framework: "MITRE_ATTACK",
  frameworkVersion: PINNED_ATTACK_VERSION,
  referenceId: REAL_SUBTECHNIQUE,
  referenceTitle: REAL_SUBTECHNIQUE_BARE_NAME,
  mappingScope: "CASE",
  evidenceBasis: "OBSERVED_BEHAVIOR",
  rationale: OBSERVED_BEHAVIOUR_RATIONALE,
  ...EVAL_EVIDENCE,
  ...overrides,
});

async function main() {
  const evalDatabaseUrl = assertSafeEvalDatabaseUrl(process.env);
  stageEnvPlaceholdersForConfigLoad(process.env);

  // eslint-disable-next-line global-require, import/no-dynamic-require
  const { PrismaClient } = require(path.join(BACKEND_DIR, "node_modules/@prisma/client"));
  const prisma = new PrismaClient({ datasources: { db: { url: evalDatabaseUrl } } });

  const mappingService = requireBackend("src/services/framework/frameworkMappingService");
  const noMappingService = requireBackend("src/services/framework/frameworkNoMappingService");
  const readService = requireBackend("src/services/framework/frameworkReadService");
  const analyticsService = requireBackend("src/services/framework/attackAnalyticsService");
  const catalogueModule = requireBackend("src/services/framework/attackCatalogue");
  const aiService = requireBackend("src/services/ai/aiSuggestionService");
  const decisionService = requireBackend("src/services/ai/aiSuggestionDecisionService");
  const { buildAiRuntime } = requireBackend("src/services/ai/aiRuntime");

  // No network, proven rather than asserted.
  let fetchCalls = 0;
  global.fetch = () => {
    fetchCalls += 1;
    throw new Error("This gate must not make a network request.");
  };

  const base = (client) => ({ client, actorUserId: null });

  try {
    await cleanupEvalState(prisma);

    // ---------------------------------------------------------------------
    const s1 = scenario("S1", "The pinned catalogue is an official MITRE release with a verified checksum");
    const catalogue = catalogueModule.getAttackCatalogue();
    s1.eq("attackVersion", catalogue.attackVersion, PINNED_ATTACK_VERSION);
    s1.eq("domain", catalogue.domain, PINNED_ATTACK_DOMAIN);
    s1.ok("hasFullMatrix", catalogue.counts.tactics >= 14);
    s1.ok("hasManyTechniques", catalogue.counts.techniques > 500);
    s1.ok("hasSubTechniques", catalogue.counts.subTechniques > 300);
    s1.ok("mappableExcludesRetired", catalogue.counts.mappable < catalogue.counts.techniques);

    // Re-hashed here, independently of the loader, from the committed file.
    const cataloguePath = path.join(
      BACKEND_DIR,
      "src/data/attack/enterprise-attack-catalogue.json"
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(BACKEND_DIR, "src/data/attack/enterprise-attack-manifest.json"), "utf8")
    );
    const recomputed = crypto.createHash("sha256").update(fs.readFileSync(cataloguePath)).digest("hex");
    s1.eq("checksumMatchesManifest", recomputed, manifest.derived.sha256);
    s1.eq("loaderReportsSameChecksum", catalogue.checksum, manifest.derived.sha256);
    s1.ok("pinnedToImmutableCommit", /^[0-9a-f]{40}$/.test(manifest.source.upstreamCommit));
    s1.ok("recordsUpstreamDigest", /^[0-9a-f]{64}$/.test(manifest.source.upstreamSha256));
    s1.ok("carriesMitreAttribution", /MITRE/.test(manifest.attribution));

    // ---------------------------------------------------------------------
    const s2 = scenario("S2", "An exact, current technique is accepted and stored canonically");
    const { caseRecord: caseA, finding: findingA } = await seedCase(prisma, "a", 11);

    const accepted = await mappingService.createManualMapping(caseA.id, attackContent(), {
      ...base(prisma),
      effectiveAt: T(9),
    });
    s2.eq("outcome", accepted.outcome, "CREATED");
    s2.eq("changed", accepted.changed, true);
    s2.eq("referenceId", accepted.mapping.referenceId, REAL_SUBTECHNIQUE);
    // MITRE's own composed display name, adopted only after the supplied title
    // was confirmed to name this technique.
    s2.eq("referenceTitle", accepted.mapping.referenceTitle, REAL_SUBTECHNIQUE_DISPLAY_NAME);
    s2.eq("catalogueVerified", accepted.mapping.catalogueVerified, true);
    s2.eq("catalogueVersion", accepted.mapping.catalogueVersion, PINNED_ATTACK_VERSION);
    s2.eq("catalogueChecksum", accepted.mapping.catalogueChecksum, manifest.derived.sha256);

    // ---------------------------------------------------------------------
    const s3 = scenario("S3", "A well-formed technique id naming nothing is refused");
    await s3.throws(
      "unknownTechnique",
      mappingService.createManualMapping(
        caseA.id,
        attackContent({ referenceId: UNKNOWN_TECHNIQUE, referenceTitle: "Invented Technique" }),
        { ...base(prisma), effectiveAt: T(10) }
      ),
      "FrameworkMappingValidationError",
      "ATTACK_TECHNIQUE_NOT_IN_CATALOGUE"
    );
    const afterUnknown = await prisma.caseFrameworkMapping.count({
      where: { caseId: caseA.id, referenceId: UNKNOWN_TECHNIQUE },
    });
    s3.eq("noRowWritten", afterUnknown, 0);

    // ---------------------------------------------------------------------
    const s4 = scenario("S4", "Parent and sub-technique are distinguished; approximate ids are refused");
    const parent = await mappingService.createManualMapping(
      caseA.id,
      attackContent({ referenceId: REAL_PARENT_TECHNIQUE, referenceTitle: REAL_PARENT_NAME }),
      { ...base(prisma), effectiveAt: T(11) }
    );
    s4.eq("parentAccepted", parent.mapping.referenceId, REAL_PARENT_TECHNIQUE);
    s4.eq("parentTitle", parent.mapping.referenceTitle, REAL_PARENT_NAME);

    const parentEntry = catalogueModule.findTechnique(REAL_PARENT_TECHNIQUE);
    const subEntry = catalogueModule.findTechnique(REAL_SUBTECHNIQUE);
    s4.eq("parentIsNotSub", parentEntry.isSubTechnique, false);
    s4.eq("parentHasNoParent", parentEntry.parentId, null);
    s4.eq("subIsSub", subEntry.isSubTechnique, true);
    s4.eq("subResolvesParent", subEntry.parentId, REAL_PARENT_TECHNIQUE);
    s4.eq("subTactic", subEntry.tactics.includes(REAL_SUBTECHNIQUE_TACTIC), true);

    // Not corrected to T1021.001. A stored mapping citing a technique the
    // analyst never chose would be recorded and reported as their decision.
    await s4.throws(
      "approximateIdNotCoerced",
      mappingService.createManualMapping(caseA.id, attackContent({ referenceId: "T1021.1" }), {
        ...base(prisma),
        effectiveAt: T(11),
      }),
      "FrameworkMappingValidationError",
      "ATTACK_TECHNIQUE_NOT_IN_CATALOGUE"
    );

    // ---------------------------------------------------------------------
    const s5 = scenario("S5", "Revoked, deprecated and mistitled references are each refused distinctly");
    await s5.throws(
      "revoked",
      mappingService.createManualMapping(
        caseA.id,
        attackContent({ referenceId: REVOKED_TECHNIQUE, referenceTitle: REVOKED_TECHNIQUE_NAME }),
        { ...base(prisma), effectiveAt: T(12) }
      ),
      "FrameworkMappingValidationError",
      "ATTACK_TECHNIQUE_REVOKED"
    );
    const revokedEntry = catalogueModule.findTechnique(REVOKED_TECHNIQUE);
    s5.eq("revokedFlagged", revokedEntry.revoked, true);
    s5.ok("revokedNamesReplacement", typeof revokedEntry.revokedBy === "string");

    const deprecatedEntry = catalogue.techniques.find((t) => t.deprecated && !t.revoked);
    if (deprecatedEntry) {
      await s5.throws(
        "deprecated",
        mappingService.createManualMapping(
          caseA.id,
          attackContent({
            referenceId: deprecatedEntry.id,
            referenceTitle: deprecatedEntry.displayName,
          }),
          { ...base(prisma), effectiveAt: T(12) }
        ),
        "FrameworkMappingValidationError",
        "ATTACK_TECHNIQUE_DEPRECATED"
      );
    }

    // Refused, not silently overwritten: the mismatch is the only signal that
    // the analyst meant a different technique.
    await s5.throws(
      "titleMismatch",
      mappingService.createManualMapping(
        caseA.id,
        attackContent({ referenceTitle: "SQL Injection" }),
        { ...base(prisma), effectiveAt: T(12) }
      ),
      "FrameworkMappingValidationError",
      "ATTACK_TITLE_MISMATCH"
    );

    // ---------------------------------------------------------------------
    const s6 = scenario("S6", "A mapping may not claim a framework version the catalogue is not");
    await s6.throws(
      "wrongVersion",
      mappingService.createManualMapping(caseA.id, attackContent({ frameworkVersion: "17.1" }), {
        ...base(prisma),
        effectiveAt: T(13),
      }),
      "FrameworkMappingValidationError",
      "ATTACK_VERSION_NOT_PINNED_CATALOGUE"
    );
    // A leading "v" is a display convention, not a different release.
    const vPrefixed = await mappingService.createManualMapping(
      caseA.id,
      attackContent({
        referenceId: "T1133",
        referenceTitle: "External Remote Services",
        frameworkVersion: `v${PINNED_ATTACK_VERSION}`,
      }),
      { ...base(prisma), effectiveAt: T(13) }
    );
    s6.eq("vPrefixAccepted", vPrefixed.changed, true);
    s6.eq("versionStoredCanonically", vPrefixed.mapping.frameworkVersion, PINNED_ATTACK_VERSION);

    // ---------------------------------------------------------------------
    const s7 = scenario("S7", "An evidence quote must be verbatim in the record it cites");
    await s7.throws(
      "notVerbatim",
      mappingService.createManualMapping(
        caseA.id,
        attackContent({
          referenceId: "T1078",
          referenceTitle: "Valid Accounts",
          evidenceQuote: "the constituent admitted running the malware themselves",
        }),
        { ...base(prisma), effectiveAt: T(14) }
      ),
      // 409, not 400: the input was well formed, the record does not say that.
      "FrameworkMappingStateError",
      "EVIDENCE_QUOTE_NOT_VERBATIM"
    );

    const response = await prisma.caseOrganizationResponse.findFirst({
      where: { caseId: caseA.id },
      select: { id: true },
    });
    s7.eq(
      "locatorNamesTheExactRecordAndField",
      accepted.mapping.evidenceQuoteLocator,
      `CASE_RESPONSE:${response.id}:summary`
    );

    // A quote from the Finding's own record resolves to that Finding.
    const fromFinding = await mappingService.createManualMapping(
      caseA.id,
      attackContent({
        referenceId: "T1110",
        referenceTitle: "Brute Force",
        evidenceFindingId: findingA.id,
        evidenceQuote: `${NET}.0.11 tcp/3389 ACCESSIBLE_RDP`,
        evidenceQuoteSource: "FINDING_RECORD",
      }),
      { ...base(prisma), effectiveAt: T(14) }
    );
    s7.eq(
      "findingLocator",
      fromFinding.mapping.evidenceQuoteLocator,
      `FINDING_RECORD:${findingA.id}:identity`
    );

    // ---------------------------------------------------------------------
    const s8 = scenario("S8", "The two confidences are stored separately and never combined");
    s8.eq("evidenceConfidence", accepted.mapping.evidenceConfidence, "HIGH");
    s8.eq("mappingConfidence", accepted.mapping.mappingConfidence, "MEDIUM");

    const lowLow = await mappingService.createManualMapping(
      caseA.id,
      attackContent({
        referenceId: "T1190",
        referenceTitle: "Exploit Public-Facing Application",
        evidenceConfidence: "LOW",
        mappingConfidence: "LOW",
      }),
      { ...base(prisma), effectiveAt: T(15) }
    );
    // An honestly-declared LOW is never a reason to refuse.
    s8.eq("lowConfidenceAccepted", lowLow.changed, true);

    const serialized = await readService.getCaseFrameworkMappings(caseA.id, { client: prisma });
    const anyMapping = serialized.groups.flatMap((group) => group.mappings)[0];
    s8.eq(
      "confidencesLabelledSeparate",
      anyMapping.confidenceMeaning,
      "EVIDENCE_AND_MAPPING_CONFIDENCE_ARE_SEPARATE_NEVER_COMBINED"
    );
    // No combined figure exists to be read.
    const serializedBlob = JSON.stringify(serialized);
    s8.eq("noCombinedConfidenceKey", /"(combined|overall)Confidence"/i.test(serializedBlob), false);
    s8.eq("confidenceVocabulary", EXPECTED_CONFIDENCE_LEVELS, ["LOW", "MEDIUM", "HIGH"]);
    s8.eq("quoteSourceVocabulary", EXPECTED_QUOTE_SOURCES, [
      "FINDING_RECORD",
      "RAW_REPORT_ROW",
      "CASE_RESPONSE",
    ]);

    // ---------------------------------------------------------------------
    const s9 = scenario("S9", "A legacy row is not rewritten, not retro-verified, and stays withdrawable");
    const legacy = await prisma.caseFrameworkMapping.create({
      data: {
        caseId: caseA.id,
        organizationId: caseA.organizationId,
        framework: "MITRE_ATTACK",
        frameworkVersion: "17.1",
        referenceId: "T1566",
        referenceTitle: "Phishing",
        mappingScope: "CASE",
        evidenceBasis: "OBSERVED_BEHAVIOR",
        rationale: "Recorded before the Phase 6.3 obligations existed.",
        state: "ACTIVE",
        source: "MANUAL",
        effectiveAt: T(7),
        supersededAt: null,
        currentMappingKey: `${caseA.id}:MITRE_ATTACK:CASE:T1566`,
      },
    });
    s9.eq("legacyHasNoQuote", legacy.evidenceQuote, null);
    s9.eq("legacyNotVerified", legacy.catalogueVerified, false);
    s9.eq("legacyHasNoConfidences", [legacy.evidenceConfidence, legacy.mappingConfidence], [null, null]);

    const legacyView = await readService.getCaseFrameworkMappings(caseA.id, { client: prisma });
    const legacyRow = legacyView.groups
      .flatMap((group) => group.mappings)
      .find((mapping) => mapping.referenceId === "T1566");
    s9.eq("reportedAsLegacy", legacyRow.legacyUnverified, true);
    s9.eq("reportedAsNotValidated", legacyRow.referenceValidated, false);
    s9.ok("carriesLegacyNote", typeof legacyRow.legacyNote === "string");
    s9.ok("caseReportsLegacyCount", legacyView.legacyUnverifiedCount >= 1);

    // A legacy row that could not be withdrawn would trap exactly the mappings
    // most in need of revisiting.
    const withdrawnLegacy = await mappingService.removeMapping(caseA.id, legacy.id, {
      ...base(prisma),
      effectiveAt: T(16),
      reason: "Superseded by a mapping recorded under the current evidence rules.",
    });
    s9.eq("legacyWithdrawable", withdrawnLegacy.outcome, "REMOVED");
    s9.eq("removedRowKeepsLegacyNulls", withdrawnLegacy.mapping.evidenceQuote, null);
    s9.eq("removedRowNotRetroVerified", withdrawnLegacy.mapping.catalogueVerified, false);

    const legacyOriginal = await prisma.caseFrameworkMapping.findUnique({ where: { id: legacy.id } });
    s9.eq("originalRationaleUntouched", legacyOriginal.rationale, "Recorded before the Phase 6.3 obligations existed.");
    s9.eq("originalStateUntouched", legacyOriginal.state, "ACTIVE");

    // ---------------------------------------------------------------------
    const s10 = scenario("S10", '"No applicable mapping" is recordable and mutually exclusive with mappings');
    const { caseRecord: caseB } = await seedCase(prisma, "b", 12);

    const asserted = await noMappingService.assertNoApplicableMapping(caseB.id, "MITRE_ATTACK", {
      ...base(prisma),
      effectiveAt: T(9),
      rationale: NO_APPLICABLE_RATIONALE,
    });
    s10.eq("outcome", asserted.outcome, "ASSERTED");
    s10.eq("state", asserted.assertion.state, "ASSERTED");

    // Repeating it writes nothing.
    const repeated = await noMappingService.assertNoApplicableMapping(caseB.id, "MITRE_ATTACK", {
      ...base(prisma),
      effectiveAt: T(10),
      rationale: NO_APPLICABLE_RATIONALE,
    });
    s10.eq("repeatUnchanged", repeated.outcome, "UNCHANGED");
    s10.eq("repeatWroteNothing", repeated.changed, false);

    // A mapping is refused while the determination stands.
    await s10.throws(
      "mappingRefusedWhileAsserted",
      mappingService.createManualMapping(caseB.id, attackContent(), {
        ...base(prisma),
        effectiveAt: T(11),
      }),
      "FrameworkMappingStateError",
      "MAPPING_CONFLICTS_WITH_NO_APPLICABLE_ASSERTION"
    );

    // Withdraw it, then map; then the reverse direction is refused.
    const withdrawn = await noMappingService.withdrawNoApplicableMapping(
      caseB.id,
      asserted.assertion.id,
      { ...base(prisma), effectiveAt: T(12), reason: "The constituent later reported observed behaviour." }
    );
    s10.eq("withdrawn", withdrawn.outcome, "WITHDRAWN");
    s10.eq("appendOnly", (await prisma.caseFrameworkNoMappingAssertion.count({ where: { caseId: caseB.id } })), 2);

    await mappingService.createManualMapping(caseB.id, attackContent(), {
      ...base(prisma),
      effectiveAt: T(13),
    });
    await s10.throws(
      "assertionRefusedWhileMapped",
      noMappingService.assertNoApplicableMapping(caseB.id, "MITRE_ATTACK", {
        ...base(prisma),
        effectiveAt: T(14),
        rationale: NO_APPLICABLE_RATIONALE,
      }),
      "FrameworkMappingStateError",
      "NO_APPLICABLE_CONFLICTS_WITH_ACTIVE_MAPPING"
    );

    const auditActions = (
      await prisma.auditLog.findMany({
        where: { entityType: "CaseFrameworkNoMappingAssertion" },
        select: { action: true },
      })
    ).map((row) => row.action);
    s10.ok("assertionAudited", auditActions.includes("framework.no_mapping.asserted"));
    s10.ok("withdrawalAudited", auditActions.includes("framework.no_mapping.withdrawn"));

    // ---------------------------------------------------------------------
    const s11 = scenario("S11", "An AI suggestion cannot bypass the catalogue or evidence gates");
    const { caseRecord: caseC, finding: findingC } = await seedCase(prisma, "c", 13);

    const invalidRuntime = buildAiRuntime({
      env: { AI_ENABLED: true, AI_PROVIDER: "mock" },
      allowMockProvider: true,
      providerConfig: { scenario: "CATALOGUE_AND_EVIDENCE_INVALID" },
    });
    const invalidRun = await aiService.requestMappingSuggestions(caseC.id, {
      ...base(prisma),
      runtime: invalidRuntime,
      requestedAt: T(9),
    });
    // Unknown technique, revoked technique, title mismatch and no evidence
    // quote — every one discarded by a gate that did not exist in Phase 5.
    s11.eq("acceptedNone", invalidRun.run.suggestionCount, 0);
    s11.eq("rejectedAll", invalidRun.run.rejectedCount, 4);
    s11.eq("reasonCode", invalidRun.run.reasonCode, "ALL_CANDIDATES_REJECTED");
    s11.eq("noSuggestionRows", invalidRun.suggestions.length, 0);

    // A clean candidate is stored WITH its evidence, and promotion re-verifies.
    const cleanRuntime = buildAiRuntime({
      env: { AI_ENABLED: true, AI_PROVIDER: "mock" },
      allowMockProvider: true,
      providerConfig: { scenario: "VALID_ATTACK_MAPPING" },
    });
    const cleanRun = await aiService.requestMappingSuggestions(caseC.id, {
      ...base(prisma),
      runtime: cleanRuntime,
      requestedAt: T(10),
    });
    s11.eq("cleanAccepted", cleanRun.run.suggestionCount, 1);
    const suggestion = cleanRun.suggestions[0];
    s11.eq("suggestionCarriesQuote", suggestion.evidenceQuote, EVAL_EVIDENCE.evidenceQuote);
    s11.eq("suggestionCatalogueVerified", suggestion.catalogueVerified, true);
    s11.eq("suggestionIsInert", suggestion.state, "PENDING");

    const promoted = await decisionService.approveSuggestion(caseC.id, suggestion.id, {
      ...base(prisma),
      decidedAt: T(11),
    });
    s11.eq("promotedThroughManualWriter", promoted.mapping.source, "AI_SUGGESTION_PROMOTED");
    s11.eq("promotedIsVerified", promoted.mapping.catalogueVerified, true);
    // Re-verified against the live record at promotion time, not trusted from
    // what the suggestion recorded when it was generated.
    s11.ok(
      "promotionReVerifiedTheQuote",
      typeof promoted.mapping.evidenceQuoteLocator === "string" &&
        promoted.mapping.evidenceQuoteLocator.startsWith("CASE_RESPONSE:")
    );

    // ---------------------------------------------------------------------
    const s12 = scenario("S12", "The navigator emits raw counts only, and no coverage percentage");
    const { caseRecord: caseD } = await seedCase(prisma, "d", 14);
    const emptyOrgId = caseD.organizationId;

    const emptyView = await analyticsService.getAttackNavigator({
      client: prisma,
      organizationIds: [emptyOrgId],
      asOf: T(17),
    });
    s12.eq("emptyAvailability", emptyView.availability, "AVAILABLE");
    s12.eq("emptyActiveMappings", emptyView.totals.activeMappings, 0);
    s12.eq("emptyMappedTechniques", emptyView.totals.mappedTechniques, 0);
    s12.ok("emptyStillRendersEveryTactic", emptyView.tactics.length >= 14);
    s12.eq("emptyTacticsAreEmptyNotGaps", emptyView.tactics.every((t) => t.status === "EMPTY"), true);
    s12.eq("emptyCoverageIsNull", emptyView.coveragePercentage, null);
    s12.eq(
      "emptyCoverageExplained",
      emptyView.coveragePercentageMeaning,
      "NOT_COMPUTED_NO_HONEST_DENOMINATOR_EXISTS"
    );

    const populated = await analyticsService.getAttackNavigator({
      client: prisma,
      organizationIds: null,
      asOf: T(17),
    });
    s12.eq("populatedCountMeaning", populated.countMeaning, "MAPPING_COUNT_NOT_COVERAGE");
    s12.eq("populatedCoverageIsNull", populated.coveragePercentage, null);
    s12.ok("populatedHasMappings", populated.totals.activeMappings > 0);
    s12.ok("populatedHasMappedTechniques", populated.totals.mappedTechniques > 0);

    const subTechnique = populated.techniques.find((t) => t.id === REAL_SUBTECHNIQUE);
    s12.eq("techniqueStatus", subTechnique.status, "MAPPED");
    s12.ok("techniqueCountsCases", subTechnique.caseCount >= 1);
    s12.eq("techniqueCountsAreIntegers", Number.isInteger(subTechnique.mappingCount), true);

    const navigatorBlob = JSON.stringify(populated);
    s12.eq("noCoverageKeyAnywhere", /"coverage(Percent|Ratio|Score)"/i.test(navigatorBlob), false);
    s12.eq("noPercentMappedKey", /"percent(age)?Mapped"/i.test(navigatorBlob), false);
    s12.eq(
      "noTotalIsNamedForCoverage",
      Object.keys(populated.totals).some((key) => /percent|ratio|coverage/i.test(key)),
      false
    );

    // A mapping whose technique was retired after it was written is reported,
    // not silently dropped — otherwise the cells would not sum to the total.
    s12.eq("orphanedReported", Array.isArray(populated.orphanedMappings), true);
    s12.eq("truncationDeclared", populated.totals.truncated, false);

    // ---------------------------------------------------------------------
    const sNet = scenario("SNET", "No network request was made");
    sNet.eq("fetchCalls", fetchCalls, 0);
  } finally {
    try {
      await cleanupEvalState(prisma);
    } catch (error) {
      console.error("Cleanup failed", { name: error && error.name });
    }
    await prisma.$disconnect();
  }

  let failed = 0;
  results.forEach((record) => {
    if (record.diffs.length === 0) {
      process.stdout.write(`PASS  ${record.id}\n`);
      return;
    }
    failed += 1;
    process.stdout.write(`FAIL  ${record.id} — ${record.title}\n`);
    record.diffs.forEach((diff) => {
      process.stdout.write(
        `        ${diff.path}: expected ${JSON.stringify(diff.expected)}, got ${JSON.stringify(diff.actual)}\n`
      );
    });
  });

  process.stdout.write("\nFinal:\n");
  if (failed > 0) {
    process.stdout.write(`FAIL — ${failed} of ${results.length} scenarios did not match\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `PASS — ${results.length} Phase 6.3 ATT&CK catalogue and evidence-integrity scenarios and ` +
      `${assertionCount} manually authored assertions match exactly\n`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
