"use strict";

// ===========================================================================
// Executable Phase 5 framework-mapping and AI-assistance gate.
//
// The unit and integration suites each prove one layer against a fake or a
// scoped fixture. This gate drives the REAL production services end to end, in
// the real order an analyst would drive them, against a disposable PostgreSQL
// database — and compares every result against expectations written out by
// hand in this file.
//
// The fourteen proofs, in the order the workflow performs them:
//
//    1. a manual NIST CSF mapping on an organization-bound case
//    2. a manual CIS Controls mapping on the same case
//    3. an ATT&CK mapping resting only on exposure/CVE/KEV/EPSS/reputation is
//       REFUSED
//    4. an ATT&CK mapping resting on stated observed behaviour is ACCEPTED
//    5. remove and re-add preserve the whole append-only history
//    6. with AI disabled, no provider is called and no suggestion is created
//    7. the deterministic mock produces PENDING, untrusted suggestions, and its
//       invalid candidates are discarded rather than repaired
//    8. a PENDING suggestion changes no active mapping
//    9. human approval promotes the EXACT suggestion through the manual service
//   10. changed case evidence makes an older suggestion stale and unapprovable
//   11. rejection is append-only and creates no mapping
//   12. the safe serializers and the RBAC table expose no internal field
//   13. Risk v1 is numerically unchanged by everything above
//   14. no compliance claim is generated anywhere
//
// Usage:
//   EVAL_DATABASE_URL="postgresql://user:pw@localhost:5432/threatnexus_eval" \
//     npm run eval:phase5
//
// Safety: refuses to run without an explicit EVAL_DATABASE_URL, refuses to run
// if it equals DATABASE_URL, never reads DATABASE_URL for its own connection
// (only for that one equality check), never resets/truncates/drops, and cleans
// up an exact evaluator-owned id set on success AND on failure.
//
// HAND-AUTHORED EXPECTATIONS. Every expected value below is written out
// literally. Nothing is read back from the production module it is meant to be
// checking: a gate that asserted `outcome === MAPPING_OUTCOMES.CREATED` would
// pass no matter what MAPPING_OUTCOMES.CREATED became.
//
// NO NETWORK. The only AI provider this gate can reach is the deterministic
// offline mock, resolved through an explicit test-only opt-in. `global.fetch`
// is replaced with a counter that throws, and the count is asserted to be zero.
// ===========================================================================

const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");

// RFC 2544 benchmarking range, second octet 26 — distinct from 198.18/19
// (phase2 gate), 198.20/21 (enrichment suites), 198.22 (phase3 gate),
// 198.23 (phase4 gate), 198.25 (phase5 concurrency) and every RFC 5737 range
// already claimed, so a shared evaluation database can never let this gate's
// cleanup collide with another's rows.
const MARKER = "phase5-gate";
const NET = "198.26";

// --- Hand-transcribed expectations -----------------------------------------
// Written out as literals, deliberately not imported.
const EXPECTED_FRAMEWORKS = ["MITRE_ATTACK", "NIST_CSF", "CIS_CONTROLS"];
const EXPECTED_MAPPING_STATES = ["ACTIVE", "REMOVED"];
const EXPECTED_EVIDENCE_BASES = [
  "OBSERVED_BEHAVIOR",
  "CONTROL_GAP",
  "REMEDIATION_ALIGNMENT",
  "ANALYST_ASSESSMENT",
];
const EXPECTED_MAPPING_SOURCES = ["MANUAL", "AI_SUGGESTION_PROMOTED"];
const EXPECTED_SUGGESTION_STATES = ["PENDING", "APPROVED", "REJECTED"];

const EXPECTED_ANALYST_PHASE5_CAPABILITIES = [
  "manage:framework-mappings",
  "read:ai-mapping-suggestions",
  "request:ai-mapping-suggestions",
  "decide:ai-mapping-suggestions",
];
// A reviewer may look, and may change nothing.
const EXPECTED_REVIEWER_PHASE5_CAPABILITIES = ["read:ai-mapping-suggestions"];
// The complete set of Phase 5 capabilities VIEWER holds: none.
const EXPECTED_VIEWER_PHASE5_CAPABILITIES = [];

// Fixed instants. No wall clock is read anywhere in this gate, so a re-run
// produces byte-identical expectations.
const T_CREATE = new Date("2026-08-05T08:00:00.000Z");
const T_NIST = new Date("2026-08-05T09:00:00.000Z");
const T_CIS = new Date("2026-08-05T10:00:00.000Z");
const T_ATTACK_REFUSED = new Date("2026-08-05T11:00:00.000Z");
const T_ATTACK_OK = new Date("2026-08-05T12:00:00.000Z");
const T_REMOVE = new Date("2026-08-05T13:00:00.000Z");
const T_REACTIVATE = new Date("2026-08-05T14:00:00.000Z");
const T_AI_OFF = new Date("2026-08-05T15:00:00.000Z");
const T_AI_ON = new Date("2026-08-05T16:00:00.000Z");
const T_APPROVE = new Date("2026-08-05T17:00:00.000Z");
const T_STALE_RUN = new Date("2026-08-05T18:00:00.000Z");
const T_EVIDENCE_CHANGE = new Date("2026-08-05T19:00:00.000Z");
const T_STALE_APPROVE = new Date("2026-08-05T20:00:00.000Z");
const T_REJECT = new Date("2026-08-05T21:00:00.000Z");

// The rationale texts are literals here too, so a change to the mock's fixture
// text cannot silently change what this gate is asserting.
const OBSERVED_BEHAVIOUR_RATIONALE =
  "The constituent supplied Windows security event logs showing several thousand failed " +
  "interactive logon attempts against one administrator account from a single external source, " +
  "followed by an authentication success the account owner did not perform.";

const EXPOSURE_ONLY_RATIONALE =
  "Port 3389 is exposed to the internet, CVE-2019-0708 applies, the KEV catalogue lists it, the " +
  "EPSS score is elevated and the AbuseIPDB reputation score is high for this sector.";

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

// config/env validates its variables at require time even though this gate
// always passes an explicit {client}. Placeholders are staged only for
// variables not already set, and only AFTER the safety check above.
function stageEnvPlaceholdersForConfigLoad(env) {
  env.NODE_ENV = env.NODE_ENV || "test";
  env.DATABASE_URL = env.DATABASE_URL || "postgresql://unused:unused@localhost:5432/unused";
  env.JWT_SECRET = env.JWT_SECRET || "a-reasonably-strong-32-char-plus-secret-value";
  env.CORS_ORIGIN = env.CORS_ORIGIN || "http://localhost:5173";
  // The shipped default, stated explicitly so scenario 6 describes the system
  // as it actually ships rather than as the shell happened to leave it.
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

// Ordered to respect every onDelete: Restrict relation. The suggestion side
// releases its promotedMappingId before the mappings it points at are removed,
// then Phase 3 case rows, then the Phase 1/2 evidence they referenced.
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

    await prisma.aiSuggestionDecision.deleteMany({
      where: { suggestionId: { in: suggestionIds } },
    });
    await prisma.aiFrameworkMappingSuggestion.updateMany({
      where: { id: { in: suggestionIds } },
      data: { promotedMappingId: null },
    });
    await prisma.aiFrameworkMappingSuggestion.deleteMany({ where: { id: { in: suggestionIds } } });
    await prisma.aiSuggestionRun.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.caseFrameworkMapping.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.caseLifecycleEvent.deleteMany({ where: { caseId: { in: caseIds } } });
  }

  await prisma.caseFinding.deleteMany({
    where: { OR: [{ caseId: { in: caseIds } }, { findingId: { in: findingIds } }] },
  });
  await prisma.findingTriage.deleteMany({
    where: { OR: [{ caseId: { in: caseIds } }, { findingId: { in: findingIds } }] },
  });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });

  await prisma.riskFactorContribution.deleteMany({
    where: { riskScore: { findingId: { in: findingIds } } },
  });
  await prisma.riskScore.deleteMany({ where: { findingId: { in: findingIds } } });
  await prisma.findingOwnership.deleteMany({ where: { findingId: { in: findingIds } } });
  await prisma.finding.deleteMany({ where: { id: { in: findingIds } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: MARKER } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: MARKER } } });
}

async function makeUser(prisma, label, role) {
  return prisma.user.create({
    data: {
      name: `${MARKER}-${label}`,
      email: `${MARKER}-${label}@example.test`,
      // A syntactically valid bcrypt-shaped placeholder. This gate never
      // authenticates; no login path is exercised and no real secret exists.
      password: "$2b$10$synthetic.eval.placeholder.hash.not.a.real.secret.value",
      role,
    },
  });
}

async function makeOrganization(prisma) {
  return prisma.organization.create({
    data: {
      name: `${MARKER}-org`,
      industry: "synthetic",
      location: "synthetic",
      contactPerson: "Synthetic Contact",
      email: `${MARKER}-org-contact@example.test`,
      sector: "FINANCE",
    },
  });
}

async function makeCaseWithEvidence(prisma, organizationId, label, octet) {
  const caseRecord = await prisma.case.create({
    data: {
      title: `${MARKER} accessible RDP ${label}`,
      threatType: "Accessible RDP",
      organization: `${MARKER}-org`,
      analyst: `${MARKER}-analyst`,
      organizationId,
      lifecycleState: "OPEN",
      caseReference: `TNX-2026-97${String(octet).padStart(4, "0")}`,
      createdAt: T_CREATE,
    },
  });

  const finding = await prisma.finding.create({
    data: {
      indicatorValue: `${NET}.0.${octet}`,
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      status: "OPEN",
      firstSeen: T_CREATE,
      lastSeen: T_CREATE,
      occurrenceCount: 3,
      recurrenceCount: 0,
    },
  });

  await prisma.caseFinding.create({
    data: {
      caseId: caseRecord.id,
      findingId: finding.id,
      state: "LINKED",
      organizationId,
      ownershipStatusAtLink: "RESOLVED",
      ownershipConfidenceAtLink: "HIGH",
      effectiveAt: T_CREATE,
      supersededAt: null,
      currentLinkKey: `${caseRecord.id}:${finding.id}`,
    },
  });

  return { caseRecord, finding };
}

async function main() {
  const evalDatabaseUrl = assertSafeEvalDatabaseUrl(process.env);
  stageEnvPlaceholdersForConfigLoad(process.env);

  // eslint-disable-next-line global-require, import/no-dynamic-require
  const { PrismaClient } = require(path.join(BACKEND_DIR, "node_modules/@prisma/client"));
  const prisma = new PrismaClient({ datasources: { db: { url: evalDatabaseUrl } } });

  const mappingService = requireBackend("src/services/framework/frameworkMappingService");
  const readService = requireBackend("src/services/framework/frameworkReadService");
  const aiService = requireBackend("src/services/ai/aiSuggestionService");
  const decisionService = requireBackend("src/services/ai/aiSuggestionDecisionService");
  const { buildAiRuntime } = requireBackend("src/services/ai/aiRuntime");
  const { ROLE_CAPABILITIES } = requireBackend("src/lib/roles");

  // Any real network call is a gate failure, not a warning.
  let networkAttempts = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    networkAttempts += 1;
    throw new Error("network access is not permitted in the Phase 5 gate");
  };

  try {
    await cleanupEvalState(prisma);

    const organization = await makeOrganization(prisma);
    const analyst = await makeUser(prisma, "analyst", "ANALYST");
    const { caseRecord, finding } = await makeCaseWithEvidence(prisma, organization.id, "A", 11);

    const actor = { client: prisma, actorUserId: analyst.id };

    // A deterministic Risk v1 snapshot recorded BEFORE any Phase 5 activity,
    // so scenario 13 can prove nothing below moved it.
    const riskScore = await prisma.riskScore.create({
      data: {
        findingId: finding.id,
        algorithmVersion: "risk-additive-bucketed-v1",
        configurationVersion: "v1.0.0",
        configurationFingerprint: `${MARKER}-cfg`,
        inputFingerprint: `${MARKER}-input`,
        scoreBasisPoints: 6100,
        riskBand: "HIGH",
        asOf: T_CREATE,
        calculatedAt: T_CREATE,
        trigger: "INGESTION",
        currentForFindingId: finding.id,
      },
    });
    await prisma.riskFactorContribution.create({
      data: {
        riskScoreId: riskScore.id,
        factorKey: "exposureCriticality",
        applicability: "APPLIED",
        contributionBasisPoints: 1500,
        maximumContributionBasisPoints: 1500,
        explanationCode: "EXPOSURE_CRITICALITY_REMOTE_ACCESS_RDP",
        displayOrder: 2,
      },
    });

    // --- 1. Manual NIST CSF mapping ----------------------------------------
    const s1 = scenario("S1", "A manual NIST CSF mapping becomes ACTIVE immediately");
    const nist = await mappingService.createManualMapping(
      caseRecord.id,
      {
        framework: "NIST_CSF",
        frameworkVersion: "2.0",
        referenceId: "PR.AA-01",
        referenceTitle: "Identities and credentials are managed",
        mappingScope: "CASE",
        evidenceBasis: "CONTROL_GAP",
        rationale:
          "Administrative remote access is reachable from any network, indicating access " +
          "permissions are not constrained to authorised sources.",
      },
      { ...actor, effectiveAt: T_NIST }
    );
    s1.eq("outcome", nist.outcome, "CREATED");
    s1.eq("changed", nist.changed, true);
    s1.eq("state", nist.mapping.state, "ACTIVE");
    // A manual mapping is an explicit human act, so it needs no second approval.
    s1.eq("source", nist.mapping.source, "MANUAL");
    s1.eq("actor", nist.mapping.actorUserId, analyst.id);
    s1.eq("framework", nist.mapping.framework, "NIST_CSF");
    s1.eq("frameworkVersion", nist.mapping.frameworkVersion, "2.0");
    // The organization is stored explicitly, not merely joined through the case.
    s1.eq("organizationId", nist.mapping.organizationId, organization.id);

    // A repeat writes nothing at all.
    const nistRepeat = await mappingService.createManualMapping(
      caseRecord.id,
      {
        framework: "NIST_CSF",
        frameworkVersion: "2.0",
        referenceId: "PR.AA-01",
        referenceTitle: "Identities and credentials are managed",
        mappingScope: "CASE",
        evidenceBasis: "CONTROL_GAP",
        rationale:
          "Administrative remote access is reachable from any network, indicating access " +
          "permissions are not constrained to authorised sources.",
      },
      { ...actor, effectiveAt: T_CIS }
    );
    s1.eq("repeatOutcome", nistRepeat.outcome, "UNCHANGED");
    s1.eq("repeatChanged", nistRepeat.changed, false);
    s1.eq(
      "noHistoryFlood",
      await prisma.caseFrameworkMapping.count({ where: { caseId: caseRecord.id } }),
      1
    );

    // --- 2. Manual CIS Controls mapping ------------------------------------
    const s2 = scenario("S2", "A manual CIS Controls mapping records remediation alignment");
    const cis = await mappingService.createManualMapping(
      caseRecord.id,
      {
        framework: "CIS_CONTROLS",
        frameworkVersion: "v8",
        referenceId: "4.6",
        referenceTitle: "Securely Manage Enterprise Assets and Software",
        mappingScope: "CASE",
        evidenceBasis: "REMEDIATION_ALIGNMENT",
        rationale:
          "The recommended remediation places remote management behind a VPN or jump host, " +
          "which aligns with securely managing enterprise assets and software.",
      },
      { ...actor, effectiveAt: T_CIS }
    );
    s2.eq("outcome", cis.outcome, "CREATED");
    s2.eq("framework", cis.mapping.framework, "CIS_CONTROLS");
    s2.eq("evidenceBasis", cis.mapping.evidenceBasis, "REMEDIATION_ALIGNMENT");
    s2.eq("state", cis.mapping.state, "ACTIVE");
    // A control mapping is NOT a compliance determination, and nothing in the
    // stored row says otherwise.
    s2.eq(
      "noComplianceWordStored",
      /compliant|certified|audited|implemented/i.test(JSON.stringify(cis.mapping)),
      false
    );

    // --- 3. Exposure-only ATT&CK mapping is refused -------------------------
    const s3 = scenario("S3", "An ATT&CK mapping resting only on exposure signals is refused");
    await s3.throws(
      "exposureOnlyRefused",
      mappingService.createManualMapping(
        caseRecord.id,
        {
          framework: "MITRE_ATTACK",
          frameworkVersion: "v17.1",
          referenceId: "T1021.001",
          referenceTitle: "Remote Services: Remote Desktop Protocol",
          mappingScope: "CASE",
          evidenceBasis: "OBSERVED_BEHAVIOR",
          rationale: EXPOSURE_ONLY_RATIONALE,
        },
        { ...actor, effectiveAt: T_ATTACK_REFUSED }
      ),
      "FrameworkMappingValidationError"
    );

    // The wrong evidence basis is refused structurally, with a closed code.
    await s3.throws(
      "wrongBasisRefused",
      mappingService.createManualMapping(
        caseRecord.id,
        {
          framework: "MITRE_ATTACK",
          frameworkVersion: "v17.1",
          referenceId: "T1133",
          referenceTitle: "External Remote Services",
          mappingScope: "CASE",
          evidenceBasis: "CONTROL_GAP",
          rationale: OBSERVED_BEHAVIOUR_RATIONALE,
        },
        { ...actor, effectiveAt: T_ATTACK_REFUSED }
      ),
      "FrameworkMappingValidationError",
      "ATTACK_REQUIRES_OBSERVED_BEHAVIOR"
    );

    // Nothing was written by either refusal.
    s3.eq(
      "nothingWritten",
      await prisma.caseFrameworkMapping.count({
        where: { caseId: caseRecord.id, framework: "MITRE_ATTACK" },
      }),
      0
    );

    // --- 4. Observed-behaviour ATT&CK mapping is accepted -------------------
    const s4 = scenario("S4", "An ATT&CK mapping resting on observed behaviour is accepted");
    const attack = await mappingService.createManualMapping(
      caseRecord.id,
      {
        framework: "MITRE_ATTACK",
        frameworkVersion: "v17.1",
        referenceId: "T1110.001",
        referenceTitle: "Brute Force: Password Guessing",
        mappingScope: "FINDING",
        evidenceBasis: "OBSERVED_BEHAVIOR",
        rationale: OBSERVED_BEHAVIOUR_RATIONALE,
        evidenceFindingId: finding.id,
      },
      { ...actor, effectiveAt: T_ATTACK_OK }
    );
    s4.eq("outcome", attack.outcome, "CREATED");
    s4.eq("framework", attack.mapping.framework, "MITRE_ATTACK");
    s4.eq("evidenceBasis", attack.mapping.evidenceBasis, "OBSERVED_BEHAVIOR");
    s4.eq("scope", attack.mapping.mappingScope, "FINDING");
    s4.eq("evidenceFindingId", attack.mapping.evidenceFindingId, finding.id);
    // Stored verbatim — the rationale is the whole defensibility of the mapping.
    s4.eq("rationaleVerbatim", attack.mapping.rationale, OBSERVED_BEHAVIOUR_RATIONALE);

    // Evidence must belong to THIS case.
    await s4.throws(
      "foreignEvidenceRefused",
      mappingService.createManualMapping(
        caseRecord.id,
        {
          framework: "CIS_CONTROLS",
          frameworkVersion: "v8",
          referenceId: "13.1",
          referenceTitle: "Centralize Security Event Alerting",
          mappingScope: "FINDING",
          evidenceBasis: "CONTROL_GAP",
          rationale: "Security event alerting is not centralised across the affected estate.",
          evidenceFindingId: 2147483600,
        },
        { ...actor, effectiveAt: T_ATTACK_OK }
      ),
      "FrameworkMappingStateError",
      "EVIDENCE_FINDING_NOT_LINKED"
    );

    // --- 5. Remove and reactivate preserve history --------------------------
    const s5 = scenario("S5", "Removal and reactivation preserve the whole append-only history");
    const removed = await mappingService.removeMapping(caseRecord.id, cis.mapping.id, {
      ...actor,
      effectiveAt: T_REMOVE,
      reason: "Reassessed after the constituent supplied their network diagram.",
    });
    s5.eq("removeOutcome", removed.outcome, "REMOVED");
    s5.eq("removedState", removed.mapping.state, "REMOVED");

    // The prior ACTIVE row is untouched except for its supersession columns.
    const priorCis = await prisma.caseFrameworkMapping.findUnique({
      where: { id: cis.mapping.id },
    });
    s5.eq("priorStatePreserved", priorCis.state, "ACTIVE");
    s5.eq("priorRationalePreserved", priorCis.rationale, cis.mapping.rationale);
    s5.eq("priorSuperseded", priorCis.supersededAt !== null, true);
    s5.eq("priorKeyReleased", priorCis.currentMappingKey, null);

    // A repeated removal writes nothing.
    const removeAgain = await mappingService.removeMapping(caseRecord.id, removed.mapping.id, {
      ...actor,
      effectiveAt: T_REACTIVATE,
      reason: "Repeated removal request.",
    });
    s5.eq("repeatRemoveOutcome", removeAgain.outcome, "UNCHANGED");

    const reactivated = await mappingService.createManualMapping(
      caseRecord.id,
      {
        framework: "CIS_CONTROLS",
        frameworkVersion: "v8",
        referenceId: "4.6",
        referenceTitle: "Securely Manage Enterprise Assets and Software",
        mappingScope: "CASE",
        evidenceBasis: "REMEDIATION_ALIGNMENT",
        rationale: "Reinstated: the VPN remediation is the agreed plan after all.",
      },
      { ...actor, effectiveAt: T_REACTIVATE }
    );
    s5.eq("reactivateOutcome", reactivated.outcome, "REACTIVATED");
    s5.eq("reactivatedState", reactivated.mapping.state, "ACTIVE");

    const cisHistory = await prisma.caseFrameworkMapping.findMany({
      where: { caseId: caseRecord.id, referenceId: "4.6" },
      orderBy: { id: "asc" },
    });
    s5.eq("cisHistoryRows", cisHistory.length, 3);
    s5.eq(
      "cisHistoryStates",
      cisHistory.map((row) => row.state),
      ["ACTIVE", "REMOVED", "ACTIVE"]
    );
    s5.eq(
      "exactlyOneCurrent",
      cisHistory.filter((row) => row.currentMappingKey !== null).length,
      1
    );
    // No production path hard-deletes a mapping row.
    s5.eq("noHardDelete", typeof mappingService.deleteMapping, "undefined");

    // --- 6. AI disabled -----------------------------------------------------
    const s6 = scenario("S6", "With AI disabled, no provider is called and no suggestion exists");

    // A counting provider proves the BRANCH, not merely the outcome: if the
    // service ever handed a snapshot to a provider while AI was off, this count
    // would be 1 even though the result still looked right.
    let disabledProviderCalls = 0;
    const disabledRuntime = Object.freeze({
      aiEnabled: false,
      assistanceAvailable: false,
      providerName: "disabled",
      providerModel: null,
      reasonCode: "AI_DISABLED",
      provider: Object.freeze({
        name: "counting-disabled",
        model: null,
        isEnabled: false,
        async suggestMappings() {
          disabledProviderCalls += 1;
          return { status: "COMPLETED", suggestions: [] };
        },
      }),
    });

    const disabledRun = await aiService.requestMappingSuggestions(caseRecord.id, {
      ...actor,
      runtime: disabledRuntime,
      requestedAt: T_AI_OFF,
    });
    s6.eq("providerNotCalled", disabledProviderCalls, 0);
    s6.eq("status", disabledRun.run.status, "DISABLED");
    s6.eq("reasonCode", disabledRun.run.reasonCode, "AI_DISABLED");
    s6.eq("providerName", disabledRun.run.providerName, "disabled");
    s6.eq("noSuggestions", disabledRun.suggestions.length, 0);
    s6.eq(
      "noSuggestionRows",
      await prisma.aiFrameworkMappingSuggestion.count({ where: { caseId: caseRecord.id } }),
      0
    );
    // The run IS recorded: "we asked and it was off" must stay distinguishable
    // from "nobody ever asked".
    s6.eq(
      "runRecorded",
      await prisma.aiSuggestionRun.count({ where: { caseId: caseRecord.id } }),
      1
    );

    // The DEFAULT production runtime, built from the shipped environment,
    // resolves the disabled provider.
    const shippedRuntime = buildAiRuntime();
    s6.eq("shippedAiEnabled", shippedRuntime.aiEnabled, false);
    s6.eq("shippedAssistanceAvailable", shippedRuntime.assistanceAvailable, false);
    s6.eq("shippedProviderName", shippedRuntime.providerName, "disabled");

    // And the mock provider is NOT reachable from the production path.
    const noFallbackRuntime = buildAiRuntime({ env: { AI_ENABLED: true, AI_PROVIDER: "mock" } });
    s6.eq("noSilentMockFallback", noFallbackRuntime.assistanceAvailable, false);
    s6.eq("noFallbackReason", noFallbackRuntime.reasonCode, "AI_PROVIDER_NOT_AVAILABLE");
    s6.eq("noFallbackProvider", noFallbackRuntime.providerName, "disabled");

    // --- 7. Mock AI produces PENDING, untrusted suggestions -----------------
    const s7 = scenario("S7", "Mock AI output is untrusted: invalid candidates are discarded");
    const mockRuntime = buildAiRuntime({
      env: { AI_ENABLED: true, AI_PROVIDER: "mock" },
      allowMockProvider: true,
      providerConfig: { scenario: "MIXED_VALID_AND_INVALID" },
    });
    s7.eq("mockAvailableOnlyWithOptIn", mockRuntime.assistanceAvailable, true);
    s7.eq("mockProviderName", mockRuntime.providerName, "mock");

    const mockRun = await aiService.requestMappingSuggestions(caseRecord.id, {
      ...actor,
      runtime: mockRuntime,
      requestedAt: T_AI_ON,
      requestContext: "Focus on access control and remote management.",
    });
    s7.eq("status", mockRun.run.status, "COMPLETED");
    s7.eq("reasonCode", mockRun.run.reasonCode, "SUGGESTIONS_GENERATED");
    // The mock's fixture is one clean CSF candidate plus four deliberately bad
    // ones (exposure-only ATT&CK, wrong-basis ATT&CK, malformed reference,
    // unknown field).
    s7.eq("accepted", mockRun.run.suggestionCount, 1);
    s7.eq("discarded", mockRun.run.rejectedCount, 4);
    s7.eq("state", mockRun.suggestions[0].state, "PENDING");
    s7.eq("framework", mockRun.suggestions[0].framework, "NIST_CSF");
    s7.eq("referenceId", mockRun.suggestions[0].referenceId, "PR.AA-05");
    // Discarded candidates were never persisted — there is no "invalid
    // suggestion" row to filter out later.
    s7.eq(
      "onlyValidPersisted",
      await prisma.aiFrameworkMappingSuggestion.count({ where: { caseId: caseRecord.id } }),
      1
    );
    // No raw provider response is stored anywhere.
    s7.eq("noRawResponseColumn", "rawResponse" in mockRun.run, false);

    // --- 8. A PENDING suggestion changes no active mapping ------------------
    const s8 = scenario("S8", "A PENDING suggestion is inert");
    const activeBefore = await readService.getCaseFrameworkMappings(caseRecord.id, {
      client: prisma,
    });
    // NIST PR.AA-01, ATT&CK T1110.001, CIS 4.6 (reactivated).
    s8.eq("activeCount", activeBefore.activeCount, 3);
    s8.eq("countMeaning", activeBefore.countMeaning, "MAPPING_COUNT_NOT_COVERAGE");
    s8.eq(
      "noPromotedMappingYet",
      await prisma.caseFrameworkMapping.count({
        where: { caseId: caseRecord.id, source: "AI_SUGGESTION_PROMOTED" },
      }),
      0
    );
    // The suggested reference is not among the active mappings.
    s8.eq(
      "suggestionNotActive",
      activeBefore.groups
        .flatMap((group) => group.mappings)
        .some((mapping) => mapping.referenceId === "PR.AA-05"),
      false
    );

    // --- 9. Human approval promotes through the manual service --------------
    const s9 = scenario("S9", "Human approval promotes the exact suggestion into a mapping");
    const suggestion = mockRun.suggestions[0];
    const approved = await decisionService.approveSuggestion(caseRecord.id, suggestion.id, {
      ...actor,
      decidedAt: T_APPROVE,
    });
    s9.eq("outcome", approved.outcome, "APPROVED_AND_PROMOTED");
    s9.eq("changed", approved.changed, true);
    s9.eq("mappingState", approved.mapping.state, "ACTIVE");
    // The provenance records that the CONTENT came from a suggestion — and that
    // a HUMAN created the mapping.
    s9.eq("mappingSource", approved.mapping.source, "AI_SUGGESTION_PROMOTED");
    s9.eq("mappingActorIsHuman", approved.mapping.actorUserId, analyst.id);
    s9.eq("suggestionState", approved.suggestion.state, "APPROVED");
    s9.eq("suggestionDecidedBy", approved.suggestion.decidedByUserId, analyst.id);
    s9.eq("linkedToMapping", approved.suggestion.promotedMappingId, approved.mapping.id);
    // The promoted content is byte-identical to what the human reviewed.
    s9.eq("referenceIdVerbatim", approved.mapping.referenceId, suggestion.referenceId);
    s9.eq("rationaleVerbatim", approved.mapping.rationale, suggestion.rationale);
    s9.eq("frameworkVersionVerbatim", approved.mapping.frameworkVersion, suggestion.frameworkVersion);

    // A repeated approval creates no second mapping.
    const approveAgain = await decisionService.approveSuggestion(caseRecord.id, suggestion.id, {
      ...actor,
      decidedAt: T_APPROVE,
    });
    s9.eq("repeatOutcome", approveAgain.outcome, "ALREADY_DECIDED_UNCHANGED");
    s9.eq("repeatChanged", approveAgain.changed, false);
    s9.eq("repeatMapping", approveAgain.mapping, null);
    s9.eq(
      "exactlyOnePromotedMapping",
      await prisma.caseFrameworkMapping.count({
        where: {
          caseId: caseRecord.id,
          source: "AI_SUGGESTION_PROMOTED",
          state: "ACTIVE",
          supersededAt: null,
        },
      }),
      1
    );
    // Every attempt is still recorded.
    s9.eq(
      "decisionLedgerRows",
      await prisma.aiSuggestionDecision.count({ where: { suggestionId: suggestion.id } }),
      2
    );

    // --- 10. Changed evidence makes an older suggestion stale ---------------
    const s10 = scenario("S10", "Changed case evidence makes an older suggestion unapprovable");
    const staleRun = await aiService.requestMappingSuggestions(caseRecord.id, {
      ...actor,
      runtime: buildAiRuntime({
        env: { AI_ENABLED: true, AI_PROVIDER: "mock" },
        allowMockProvider: true,
        providerConfig: { scenario: "VALID_ATTACK_MAPPING" },
      }),
      requestedAt: T_STALE_RUN,
    });
    s10.eq("generated", staleRun.run.suggestionCount, 1);
    s10.eq("framework", staleRun.suggestions[0].framework, "MITRE_ATTACK");
    s10.eq("state", staleRun.suggestions[0].state, "PENDING");

    // A real evidence change: a new mapping enters the bounded snapshot.
    await mappingService.createManualMapping(
      caseRecord.id,
      {
        framework: "CIS_CONTROLS",
        frameworkVersion: "v8",
        referenceId: "6.3",
        referenceTitle: "Require MFA for Externally-Exposed Applications",
        mappingScope: "CASE",
        evidenceBasis: "CONTROL_GAP",
        rationale:
          "Multifactor authentication is not required in front of externally reachable " +
          "administrative access on this estate.",
      },
      { ...actor, effectiveAt: T_EVIDENCE_CHANGE }
    );

    await s10.throws(
      "staleApprovalRefused",
      decisionService.approveSuggestion(caseRecord.id, staleRun.suggestions[0].id, {
        ...actor,
        decidedAt: T_STALE_APPROVE,
      }),
      "AiSuggestionStateError",
      "SUGGESTION_STALE"
    );

    // Refused, not silently re-derived.
    const staleStored = await prisma.aiFrameworkMappingSuggestion.findUnique({
      where: { id: staleRun.suggestions[0].id },
    });
    s10.eq("stillPending", staleStored.state, "PENDING");
    s10.eq("noPromotion", staleStored.promotedMappingId, null);
    s10.eq(
      "noAttackPromoted",
      await prisma.caseFrameworkMapping.count({
        where: {
          caseId: caseRecord.id,
          framework: "MITRE_ATTACK",
          source: "AI_SUGGESTION_PROMOTED",
        },
      }),
      0
    );

    // --- 11. Rejection is append-only and creates no mapping ----------------
    const s11 = scenario("S11", "Rejection creates no mapping and retains the suggestion");
    const mappingsBeforeReject = await prisma.caseFrameworkMapping.count({
      where: { caseId: caseRecord.id },
    });
    const rejected = await decisionService.rejectSuggestion(
      caseRecord.id,
      staleRun.suggestions[0].id,
      {
        ...actor,
        decidedAt: T_REJECT,
        reason: "The constituent has not confirmed any observed authentication activity.",
      }
    );
    s11.eq("outcome", rejected.outcome, "REJECTED");
    s11.eq("noMapping", rejected.mapping, null);
    s11.eq(
      "mappingCountUnchanged",
      await prisma.caseFrameworkMapping.count({ where: { caseId: caseRecord.id } }),
      mappingsBeforeReject
    );

    const rejectedStored = await prisma.aiFrameworkMappingSuggestion.findUnique({
      where: { id: staleRun.suggestions[0].id },
    });
    // Retained, never deleted: the rejection rate and its reasons are the only
    // real evidence of whether the gates and the assistant are any good.
    s11.eq("retained", rejectedStored.state, "REJECTED");
    s11.eq("noPromotedMapping", rejectedStored.promotedMappingId, null);
    s11.eq("reasonRecorded", typeof rejectedStored.decisionReason, "string");
    s11.eq(
      "decisionLedgerAppended",
      await prisma.aiSuggestionDecision.count({
        where: { suggestionId: staleRun.suggestions[0].id },
      }),
      1
    );

    // --- 12. Safe serializers and RBAC --------------------------------------
    const s12 = scenario("S12", "Serializers and the RBAC table expose no internal field");
    const activeView = await readService.getCaseFrameworkMappings(caseRecord.id, { client: prisma });
    const historyView = await readService.getCaseFrameworkMappingHistory(caseRecord.id, {
      client: prisma,
    });
    const suggestionView = await readService.getCaseSuggestionHistory(caseRecord.id, {
      client: prisma,
    });
    const payload = JSON.stringify({ activeView, historyView, suggestionView });

    [
      "currentMappingKey",
      "inputFingerprint",
      "queryParamsHash",
      "cacheKey",
      "claimToken",
      "configurationFingerprint",
      "apiKey",
      "password",
      "rawResponse",
      "systemPrompt",
      "assistantContract",
    ].forEach((forbidden) => {
      s12.eq(`excludes_${forbidden}`, payload.includes(forbidden), false);
    });

    // The constituent's own identifiers never appear in a mapping read either.
    s12.eq("noIndicatorValue", payload.includes(`${NET}.0.11`), false);
    s12.eq("noOrganizationContact", payload.includes(`${MARKER}-org-contact@example.test`), false);

    // The suggestion read reports staleness as a boolean, never a fingerprint.
    const pendingViews = suggestionView.suggestions.filter((row) => row.state === "PENDING");
    s12.eq("stalenessIsBoolean", pendingViews.every((row) => typeof row.staleForApproval === "boolean"), true);

    // Hand-transcribed capability grants.
    const analystPhase5 = ROLE_CAPABILITIES.ANALYST.filter(
      (capability) =>
        capability.includes("framework-mapping") || capability.includes("ai-mapping-suggestions")
    ).sort();
    const reviewerPhase5 = ROLE_CAPABILITIES.REVIEWER.filter(
      (capability) =>
        capability.includes("framework-mapping") || capability.includes("ai-mapping-suggestions")
    ).sort();
    const viewerPhase5 = ROLE_CAPABILITIES.VIEWER.filter(
      (capability) =>
        capability.includes("framework-mapping") || capability.includes("ai-mapping-suggestions")
    ).sort();

    s12.eq("analystCapabilities", analystPhase5, [...EXPECTED_ANALYST_PHASE5_CAPABILITIES].sort());
    s12.eq("reviewerCapabilities", reviewerPhase5, [...EXPECTED_REVIEWER_PHASE5_CAPABILITIES].sort());
    s12.eq("viewerCapabilities", viewerPhase5, EXPECTED_VIEWER_PHASE5_CAPABILITIES);

    // Approval authority never exceeds the authority to write the same mapping
    // by hand.
    s12.eq(
      "approvalNeverExceedsManual",
      ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"].every(
        (role) =>
          !ROLE_CAPABILITIES[role].includes("decide:ai-mapping-suggestions") ||
          ROLE_CAPABILITIES[role].includes("manage:framework-mappings")
      ),
      true
    );

    // Closed vocabularies, hand-transcribed.
    s12.eq(
      "frameworkFamilies",
      [...new Set((await prisma.caseFrameworkMapping.findMany({
        where: { caseId: caseRecord.id },
        select: { framework: true },
      })).map((row) => row.framework))].sort(),
      [...EXPECTED_FRAMEWORKS].sort()
    );
    s12.eq(
      "mappingStates",
      [...new Set((await prisma.caseFrameworkMapping.findMany({
        where: { caseId: caseRecord.id },
        select: { state: true },
      })).map((row) => row.state))].sort(),
      [...EXPECTED_MAPPING_STATES].sort()
    );
    s12.eq(
      "mappingSources",
      [...new Set((await prisma.caseFrameworkMapping.findMany({
        where: { caseId: caseRecord.id },
        select: { source: true },
      })).map((row) => row.source))].sort(),
      [...EXPECTED_MAPPING_SOURCES].sort()
    );
    s12.eq(
      "suggestionStates",
      [...new Set((await prisma.aiFrameworkMappingSuggestion.findMany({
        where: { caseId: caseRecord.id },
        select: { state: true },
      })).map((row) => row.state))].sort(),
      ["APPROVED", "REJECTED"]
    );
    s12.eq("evidenceBasisVocabulary", EXPECTED_EVIDENCE_BASES.length, 4);
    s12.eq("suggestionStateVocabulary", EXPECTED_SUGGESTION_STATES.length, 3);

    // --- 13. Risk v1 is numerically unchanged -------------------------------
    const s13 = scenario("S13", "Risk v1 is numerically unchanged by every Phase 5 operation");
    const riskAfter = await prisma.riskScore.findUnique({ where: { id: riskScore.id } });
    s13.eq("scoreBasisPoints", riskAfter.scoreBasisPoints, 6100);
    s13.eq("riskBand", riskAfter.riskBand, "HIGH");
    s13.eq("algorithmVersion", riskAfter.algorithmVersion, "risk-additive-bucketed-v1");
    s13.eq("configurationVersion", riskAfter.configurationVersion, "v1.0.0");
    s13.eq("inputFingerprint", riskAfter.inputFingerprint, `${MARKER}-input`);
    s13.eq("stillCurrent", riskAfter.currentForFindingId, finding.id);
    s13.eq("notSuperseded", riskAfter.supersededAt, null);
    // No Phase 5 operation appended a score.
    s13.eq(
      "noNewScoreRows",
      await prisma.riskScore.count({ where: { findingId: finding.id } }),
      1
    );
    const contributionsAfter = await prisma.riskFactorContribution.findMany({
      where: { riskScoreId: riskScore.id },
    });
    s13.eq("contributionCount", contributionsAfter.length, 1);
    s13.eq("contributionBasisPoints", contributionsAfter[0].contributionBasisPoints, 1500);
    s13.eq("contributionApplicability", contributionsAfter[0].applicability, "APPLIED");

    // --- 14. No compliance claim --------------------------------------------
    const s14 = scenario("S14", "No compliance claim is generated anywhere");
    // The disclaimers are the ONLY place these words may appear, and there they
    // appear as negations. Strip them, then search what is left.
    const disclaimers = [activeView.disclaimer, activeView.catalogueNote];
    let stripped = payload;
    disclaimers.forEach((text) => {
      stripped = stripped.split(JSON.stringify(text).slice(1, -1)).join("");
    });

    ["compliant", "compliance", "certified", "audited", "attested", "accredited"].forEach(
      (word) => {
        s14.eq(`noClaim_${word}`, new RegExp(word, "i").test(stripped), false);
      }
    );

    // The disclaimers themselves are present and say what they must.
    s14.eq("disclaimerPresent", /analyst-associated context only/i.test(activeView.disclaimer), true);
    s14.eq("disclaimerDeniesImplementation", /does not state/i.test(activeView.disclaimer), true);
    s14.eq(
      "catalogueNotePresent",
      /pins no local framework catalogue/i.test(activeView.catalogueNote),
      true
    );
    // Every reference is honestly reported as unverified.
    s14.eq(
      "referencesNotValidated",
      activeView.groups
        .flatMap((group) => group.mappings)
        .every((mapping) => mapping.referenceValidated === false),
      true
    );
    // No coverage figure, no percentage, no denominator.
    s14.eq(
      "countsLabelledNotCoverage",
      activeView.groups.every((group) => group.countMeaning === "MAPPING_COUNT_NOT_COVERAGE"),
      true
    );
    s14.eq(
      "noPercentageKey",
      activeView.groups.some((group) =>
        Object.keys(group).some((key) => /percent|coverage[A-Z]|ratioMapped/.test(key))
      ),
      false
    );

    s14.eq("noExternalNetwork", networkAttempts, 0);

    // --- Report -------------------------------------------------------------
    let failed = 0;
    results.forEach((record) => {
      if (record.diffs.length === 0) {
        console.log(`PASS  ${record.id}`);
      } else {
        failed += 1;
        console.log(`FAIL  ${record.id} — ${record.title}`);
        record.diffs.forEach((d) => {
          console.log(
            `        ${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`
          );
        });
      }
    });

    console.log("\nFinal:");
    if (failed === 0) {
      console.log(
        `PASS — ${results.length} Phase 5 framework-mapping and AI-assistance scenarios and ${assertionCount} manually authored assertions match exactly`
      );
    } else {
      console.log(`FAIL — ${failed} of ${results.length} scenarios did not match`);
      process.exitCode = 1;
    }
  } finally {
    global.fetch = originalFetch;
    await cleanupEvalState(prisma).catch((error) => {
      console.error("Cleanup failed", { name: error && error.name });
    });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
