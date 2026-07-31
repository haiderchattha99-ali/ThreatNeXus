"use strict";

// ===========================================================================
// Executable combined Phase 2 integration gate.
//
// The three existing gates each prove one layer in isolation: run_phase1_gate
// proves ingestion/dedup/recurrence, run_risk_v1_gate proves the scoring
// contract as a pure function, run_phase2_vulnerability_gate proves the CVE /
// KEV / EPSS path. None of them proves the layers still behave when composed —
// that ownership re-resolution does not double-count against vulnerability
// evidence, that a mapping change does not disturb an unrelated Finding, that
// history stays immutable while all of this is happening.
//
// This gate drives the REAL production services end to end against a
// disposable database and compares every result against expectations written
// by hand in this file.
//
// Usage:
//   EVAL_DATABASE_URL="postgresql://user:pw@localhost:5432/threatnexus_eval" \
//     npm run eval:phase2
//
// Safety: refuses to run without an explicit EVAL_DATABASE_URL, refuses to run
// if it equals DATABASE_URL, and never reads DATABASE_URL for its own
// connection — only for that one equality check.
//
// HAND-AUTHORED EXPECTATIONS. Every expected number below is written out
// literally and derived by hand from the locked Risk v1 contract, never read
// back from riskConfiguration.js. A gate that imported the production values
// it is meant to be checking would pass no matter what those values became.
// ===========================================================================

const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");

// RFC 2544 benchmarking range — deliberately distinct from the RFC 5737 ranges
// already claimed by the other suites (192.0.2.x ownershipConcurrency,
// 198.51.100.x P1-T4, 203.0.113.x phase1-gate), so a shared evaluation
// database can never let this gate's cleanup collide with theirs.
const MARKER = "phase2-gate";
const NET = "198.18";
// A second /16 inside the same benchmarking block. The ASN scenario needs an
// address that NO exact-IP or CIDR mapping covers, because the ASN tier is only
// consulted when neither of those matched at all — putting it in NET would let
// the /16 mapping from the longest-prefix scenario win first, which is correct
// resolver behaviour but would never exercise ASN attribution.
const NET_ALT = "198.19";

// --- Hand-derived Risk v1 constants ----------------------------------------
// Transcribed by hand from the locked contract. If production drifts from
// these, this gate fails — which is the entire point.
const SECTOR_HEALTHCARE_BP = 1000;
const BAND_LOW_MIN = 1500;
const BAND_MEDIUM_MIN = 3500;
const ALGORITHM_VERSION = "risk-additive-bucketed-v1";
const CONFIGURATION_VERSION = "v1.0.0";

class GateSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "GateSafetyError";
  }
}

// Reads both URLs exactly once, before anything else in this process can
// mutate them, so the inequality check is meaningful.
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
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) record.diffs.push({ path: `${id}.${label}`, expected, actual });
    },
    ok(label, actual) {
      assertionCount += 1;
      if (actual !== true) record.diffs.push({ path: `${id}.${label}`, expected: true, actual });
    },
  };
}

// --- Fixture helpers --------------------------------------------------------
async function cleanupEvalState(prisma) {
  // Scoped strictly to this gate's own marker/address range, and ordered to
  // respect every onDelete: Restrict relation (contributions -> scores,
  // ownership -> findings, occurrences/rows -> reports).
  const findings = await prisma.finding.findMany({
    where: {
      OR: [
        { indicatorValue: { startsWith: `${NET}.` } },
        { indicatorValue: { startsWith: `${NET_ALT}.` } },
      ],
    },
    select: { id: true },
  });
  const findingIds = findings.map((f) => f.id);

  const reports = await prisma.rawReport.findMany({
    where: { sourceFileName: { startsWith: MARKER } },
    select: { id: true },
  });
  const reportIds = reports.map((r) => r.id);

  const riskScores = await prisma.riskScore.findMany({
    where: { findingId: { in: findingIds } },
    select: { id: true },
  });
  const riskScoreIds = riskScores.map((r) => r.id);

  await prisma.riskFactorContribution.deleteMany({ where: { riskScoreId: { in: riskScoreIds } } });
  await prisma.riskScore.deleteMany({ where: { id: { in: riskScoreIds } } });
  await prisma.findingVulnerability.deleteMany({ where: { findingId: { in: findingIds } } });
  await prisma.findingOwnership.deleteMany({ where: { findingId: { in: findingIds } } });
  await prisma.findingOccurrence.deleteMany({ where: { findingId: { in: findingIds } } });
  await prisma.rawReportRow.deleteMany({ where: { rawReportId: { in: reportIds } } });
  await prisma.findingOccurrence.deleteMany({ where: { rawReportId: { in: reportIds } } });
  await prisma.finding.deleteMany({ where: { id: { in: findingIds } } });
  await prisma.rawReport.deleteMany({ where: { id: { in: reportIds } } });
  await prisma.assetMapping.deleteMany({
    where: { organization: { name: { startsWith: MARKER } } },
  });
  await prisma.organization.deleteMany({ where: { name: { startsWith: MARKER } } });
}

async function makeOrganization(prisma, label, sector) {
  return prisma.organization.create({
    data: {
      name: `${MARKER}-${label}`,
      industry: "synthetic",
      location: "synthetic",
      contactPerson: "synthetic",
      email: `${MARKER}-${label}@example.test`,
      sector,
    },
  });
}

async function makeFinding(prisma, octets, observedAt) {
  return prisma.finding.create({
    data: {
      indicatorValue: `${NET}.${octets}`,
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      status: "OPEN",
      firstSeen: observedAt,
      lastSeen: observedAt,
      occurrenceCount: 1,
      recurrenceCount: 0,
    },
  });
}

async function currentOwnership(prisma, findingId) {
  return prisma.findingOwnership.findUnique({ where: { currentForFindingId: findingId } });
}

async function ownershipHistoryCount(prisma, findingId) {
  return prisma.findingOwnership.count({ where: { findingId } });
}

// --- Mutation seam ----------------------------------------------------------
//
// A passing gate proves nothing unless it would FAIL when a rule breaks. The
// sibling mutation gate re-runs this file in a child process with
// PHASE2_GATE_MUTATION set, breaking exactly one load-bearing ownership rule,
// and requires this gate to fail and to name the scenario that guards it.
//
// Mutations wrap CROSS-MODULE entry points only. Patching a function a module
// calls internally would have no effect (the call never goes through exports),
// which would make the mutation silently vacuous.
const OWNERSHIP_MUTATIONS = Object.freeze({
  // Exact-IP must outrank CIDR. Break it by demoting an exact-IP win so the
  // CIDR tier's answer stands instead.
  M01_exact_ip_precedence(modules) {
    const original = modules.resolverModule.resolveOwnership;
    modules.resolverModule.resolveOwnership = (observation, context) => {
      const result = original(observation, context);
      if (result.reasonCode === "OWNERSHIP_EXACT_IP_MATCH") {
        return { ...result, confidence: "MEDIUM", reasonCode: "OWNERSHIP_CIDR_MATCH" };
      }
      return result;
    };
  },

  // The longest matching prefix must win. Break it by reporting the broader
  // prefix length, as a min-instead-of-max bug would.
  M02_longest_cidr_precedence(modules) {
    const original = modules.resolverModule.resolveOwnership;
    modules.resolverModule.resolveOwnership = (observation, context) => {
      const result = original(observation, context);
      if (result.reasonCode === "OWNERSHIP_CIDR_MATCH") {
        return { ...result, matchedPrefixLength: 16 };
      }
      return result;
    };
  },

  // Tied specificity must stay AMBIGUOUS. Break it by silently picking a winner
  // — the single most dangerous ownership bug, since it attributes a Finding to
  // an organization nobody decided on.
  M03_tied_specificity_ambiguity(modules) {
    const original = modules.resolverModule.resolveOwnership;
    modules.resolverModule.resolveOwnership = (observation, context) => {
      const result = original(observation, context);
      if (result.status === "AMBIGUOUS") {
        const first = context.mappings.find((m) => m.organizationId !== undefined);
        return {
          ...result,
          status: "RESOLVED",
          organizationId: first ? first.organizationId : 1,
          confidence: "MEDIUM",
          candidateCount: 1,
          reasonCode: "OWNERSHIP_CIDR_MATCH",
        };
      }
      return result;
    };
  },

  // An explicit analyst override must survive automatic re-resolution.
  M04_override_preservation(modules) {
    const original = modules.resolverModule.resolveOwnership;
    modules.resolverModule.resolveOwnership = (observation, context) =>
      original(observation, { ...context, currentOverride: null });
  },

  // sectorCriticality must be gated on ownership strength. Break the gate open.
  M05_sector_applicability_gate(modules) {
    const original = modules.snapshotModule.loadOwnershipContext;
    modules.snapshotModule.loadOwnershipContext = async (client, findingId) => {
      const context = await original(client, findingId);
      return { ...context, sectorAttributable: true, nonAttributableReason: null };
    };
  },

  // Re-resolution must touch only the Findings a mapping actually affects.
  // Break it by returning every Finding as a candidate — the exact regression
  // the database-pushed selection replaced.
  M06_unaffected_finding_exclusion(modules) {
    const original = modules.candidateModule.selectCandidateFindingIdPage;
    modules.candidateModule.selectCandidateFindingIdPage = async (client, mapping, options) => {
      const page = await original(client, mapping, options);
      const all = await client.finding.findMany({
        select: { id: true },
        orderBy: { id: "asc" },
        take: options && options.take ? options.take : 100,
      });
      return { ...page, findingIds: [...new Set([...page.findingIds, ...all.map((f) => f.id)])] };
    };
  },
});

function applyMutation(id, modules) {
  if (!id) return;
  const mutation = OWNERSHIP_MUTATIONS[id];
  if (!mutation) {
    throw new GateSafetyError(`Unknown PHASE2_GATE_MUTATION: ${id}`);
  }
  mutation(modules);
  console.log(`[MUTATED] ${id}`);
}

// ===========================================================================
async function main() {
  const evalDatabaseUrl = assertSafeEvalDatabaseUrl(process.env);
  stageEnvPlaceholdersForConfigLoad(process.env);

  // No provider call may reach the internet. Any attempt fails loudly and is
  // asserted at the end (scenario 22).
  let networkAttempts = 0;
  global.fetch = async () => {
    networkAttempts += 1;
    throw new Error("network access is forbidden in this gate");
  };

  const { PrismaClient } = require(path.join(BACKEND_DIR, "node_modules", "@prisma", "client"));
  const prisma = new PrismaClient({ datasources: { db: { url: evalDatabaseUrl } } });
  await prisma.$connect();

  // Mutation seam (see run_phase2_ownership_mutation_gate.js). The two modules
  // a mutation can patch are required FIRST and patched BEFORE their consumers
  // load, because those consumers destructure at require time — patching after
  // they load would silently do nothing and every mutation would "pass".
  const resolverModule = requireBackend("src/services/ownership/ownershipResolver");
  const candidateModule = requireBackend("src/services/ownership/ownershipCandidateSelection");
  const snapshotModule = requireBackend("src/services/risk/riskInputSnapshot");
  applyMutation(process.env.PHASE2_GATE_MUTATION, {
    resolverModule,
    candidateModule,
    snapshotModule,
  });

  const ownership = requireBackend("src/services/ownership/findingOwnershipService");
  const mappings = requireBackend("src/services/ownership/assetMappingService");
  const reResolution = requireBackend("src/services/ownership/ownershipReResolutionService");
  const consistency = requireBackend("src/services/ownership/ownershipConsistencyService");
  const sectorContext = requireBackend("src/services/ownership/ownershipSectorContext");
  const risk = requireBackend("src/services/risk/riskRecalculationService");
  const ingestion = requireBackend("src/services/ingestion/reportIngestionService");
  const roles = requireBackend("src/lib/roles");

  const T0 = new Date("2026-05-01T00:00:00Z");
  const T1 = new Date("2026-05-02T00:00:00Z");
  const T2 = new Date("2026-05-03T00:00:00Z");

  try {
    await cleanupEvalState(prisma);

    // --- Fixtures ----------------------------------------------------------
    const healthcare = await makeOrganization(prisma, "healthcare", "HEALTHCARE");
    const general = await makeOrganization(prisma, "general", "GENERAL");
    const isp = await makeOrganization(prisma, "isp", "TELECOM");
    const unknownSector = await makeOrganization(prisma, "unknown", "UNKNOWN");

    // ------------------------------------------------------------------
    // 1. Synthetic Accessible RDP ingestion creates one canonical Finding.
    // 2. Duplicate rows deduplicate correctly.
    // 3. Repeated report persists the Finding.
    // ------------------------------------------------------------------
    const s1 = scenario("01_ingestion_canonical_finding", "one canonical Finding per identity");
    const csvHeader = "timestamp,ip,port,protocol,hostname,asn,as_name,country_code\n";
    const dupRow = `2026-05-01T00:00:00Z,${NET}.0.10,3389,tcp,,64500,synthetic-as,GB\n`;
    const firstCsv = Buffer.from(csvHeader + dupRow + dupRow, "utf8");

    const ingest1 = await ingestion.ingestAccessibleRdpReport(
      {
        fileBytes: firstCsv,
        source: "SYNTHETIC_UPLOAD",
        sourceFileName: `${MARKER}-report-1.csv`,
        contentType: "text/csv",
        observationDate: T0,
        ingestedByUserId: null,
      },
      { client: prisma }
    );
    s1.eq("report.status", ingest1.report.status, "COMPLETED");

    const ingestedFindings = await prisma.finding.findMany({
      where: { indicatorValue: `${NET}.0.10` },
    });
    // Two identical rows, one canonical Finding — the dedup key collapsed them.
    s1.eq("canonicalFindingCount", ingestedFindings.length, 1);

    const s2 = scenario("02_duplicate_rows_dedupe", "identical rows collapse to one Finding");
    s2.eq("occurrenceCountAfterFirstReport", ingestedFindings[0].occurrenceCount, 1);

    const s3 = scenario("03_repeat_report_persists", "a repeated report persists, never duplicates");
    const secondCsv = Buffer.from(
      csvHeader + `2026-05-02T00:00:00Z,${NET}.0.10,3389,tcp,,64500,synthetic-as,GB\n`,
      "utf8"
    );
    await ingestion.ingestAccessibleRdpReport(
      {
        fileBytes: secondCsv,
        source: "SYNTHETIC_UPLOAD",
        sourceFileName: `${MARKER}-report-2.csv`,
        contentType: "text/csv",
        observationDate: T1,
        ingestedByUserId: null,
      },
      { client: prisma }
    );
    const persisted = await prisma.finding.findMany({ where: { indicatorValue: `${NET}.0.10` } });
    s3.eq("stillOneFinding", persisted.length, 1);
    s3.eq("occurrenceCountBumped", persisted[0].occurrenceCount, 2);
    s3.eq("recurrenceCountUnchanged", persisted[0].recurrenceCount, 0);
    s3.eq("statusStillOpen", persisted[0].status, "OPEN");

    // ------------------------------------------------------------------
    // 4. Exact-IP ownership resolves.
    // ------------------------------------------------------------------
    const s4 = scenario("04_exact_ip_resolves", "exact-IP mapping wins and is HIGH confidence");
    const exactFinding = await makeFinding(prisma, "1.10", T0);
    await mappings.createAssetMapping(
      {
        organizationId: healthcare.id,
        mappingType: "EXACT_IP",
        exactIp: `${NET}.1.10`,
        confidence: "HIGH",
        source: "MANUAL",
      },
      { client: prisma }
    );
    await ownership.resolveOneFinding(exactFinding.id, { client: prisma, asOf: T0 });
    const exactRow = await currentOwnership(prisma, exactFinding.id);
    s4.eq("status", exactRow.status, "RESOLVED");
    s4.eq("organizationId", exactRow.organizationId, healthcare.id);
    s4.eq("confidence", exactRow.confidence, "HIGH");
    s4.eq("reasonCode", exactRow.reasonCode, "OWNERSHIP_EXACT_IP_MATCH");
    s4.eq("isIspAttribution", exactRow.isIspAttribution, false);

    // ------------------------------------------------------------------
    // 5. More-specific CIDR overrides broader CIDR.
    // ------------------------------------------------------------------
    const s5 = scenario("05_longest_prefix_wins", "a /28 beats an overlapping /16");
    const cidrFinding = await makeFinding(prisma, "2.5", T0);
    await mappings.createAssetMapping(
      {
        organizationId: general.id,
        mappingType: "CIDR",
        cidr: `${NET}.0.0/16`,
        confidence: "LOW",
        source: "MANUAL",
      },
      { client: prisma }
    );
    await mappings.createAssetMapping(
      {
        organizationId: healthcare.id,
        mappingType: "CIDR",
        cidr: `${NET}.2.0/28`,
        confidence: "HIGH",
        source: "MANUAL",
      },
      { client: prisma }
    );
    await ownership.resolveOneFinding(cidrFinding.id, { client: prisma, asOf: T0 });
    const cidrRow = await currentOwnership(prisma, cidrFinding.id);
    s5.eq("status", cidrRow.status, "RESOLVED");
    s5.eq("winnerIsMoreSpecific", cidrRow.organizationId, healthcare.id);
    s5.eq("matchedPrefixLength", cidrRow.matchedPrefixLength, 28);
    // /28 >= 24 -> HIGH by the locked prefix-confidence ladder.
    s5.eq("confidence", cidrRow.confidence, "HIGH");

    // ------------------------------------------------------------------
    // 6. Equal-specificity conflict becomes ambiguous.
    // ------------------------------------------------------------------
    const s6 = scenario("06_tied_specificity_ambiguous", "two /24s, two orgs, no silent winner");
    const tiedFinding = await makeFinding(prisma, "3.5", T0);
    for (const org of [healthcare.id, general.id]) {
      // eslint-disable-next-line no-await-in-loop
      await mappings.createAssetMapping(
        {
          organizationId: org,
          mappingType: "CIDR",
          cidr: `${NET}.3.0/24`,
          confidence: "MEDIUM",
          source: "MANUAL",
        },
        { client: prisma }
      );
    }
    await ownership.resolveOneFinding(tiedFinding.id, { client: prisma, asOf: T0 });
    const tiedRow = await currentOwnership(prisma, tiedFinding.id);
    s6.eq("status", tiedRow.status, "AMBIGUOUS");
    // Ambiguity is never silently resolved to one of the candidates.
    s6.eq("organizationId", tiedRow.organizationId, null);
    s6.eq("confidence", tiedRow.confidence, null);
    s6.eq("candidateCount", tiedRow.candidateCount, 2);
    s6.eq("reasonCode", tiedRow.reasonCode, "OWNERSHIP_AMBIGUOUS_CIDR");

    // ------------------------------------------------------------------
    // 7. ASN resolution is LOW / ISP-attributed as approved.
    // ------------------------------------------------------------------
    const s7 = scenario("07_asn_is_low_and_isp", "ASN attribution is honest about being an ISP");
    // Deliberately in NET_ALT — outside every exact-IP/CIDR mapping this gate
    // creates, so the ASN tier is genuinely the one that decides.
    const asnFinding = await prisma.finding.create({
      data: {
        indicatorValue: `${NET_ALT}.4.5`,
        port: 3389,
        protocol: "TCP",
        reportType: "ACCESSIBLE_RDP",
        status: "OPEN",
        firstSeen: T0,
        lastSeen: T0,
        occurrenceCount: 1,
        recurrenceCount: 0,
      },
    });
    const asnMapping = await mappings.createAssetMapping(
      {
        organizationId: isp.id,
        mappingType: "ASN",
        asn: 64500,
        confidence: "LOW",
        source: "MANUAL",
      },
      { client: prisma }
    );
    // asn is supplied explicitly — it exists only at ingestion time.
    await ownership.resolveOneFinding(asnFinding.id, { client: prisma, asOf: T0, asn: 64500 });
    const asnRow = await currentOwnership(prisma, asnFinding.id);
    s7.eq("status", asnRow.status, "RESOLVED");
    s7.eq("organizationId", asnRow.organizationId, isp.id);
    s7.eq("confidence", asnRow.confidence, "LOW");
    s7.eq("isIspAttribution", asnRow.isIspAttribution, true);
    s7.eq("reasonCode", asnRow.reasonCode, "OWNERSHIP_ASN_MATCH");

    // ------------------------------------------------------------------
    // 8. Mapping mutation re-resolves ONLY affected Findings.
    // 9. Unrelated Findings remain untouched.
    // ------------------------------------------------------------------
    const s8 = scenario("08_mapping_change_affects_only_targets", "bounded, targeted re-resolution");
    const s9 = scenario("09_unrelated_findings_untouched", "an unrelated Finding is never rewritten");

    const inRange = await makeFinding(prisma, "5.5", T0);
    const outOfRange = await makeFinding(prisma, "6.5", T0);
    await ownership.resolveOneFinding(inRange.id, { client: prisma, asOf: T0 });
    await ownership.resolveOneFinding(outOfRange.id, { client: prisma, asOf: T0 });
    const outBefore = await currentOwnership(prisma, outOfRange.id);
    const outHistoryBefore = await ownershipHistoryCount(prisma, outOfRange.id);

    const targetedMapping = await mappings.createAssetMapping(
      {
        organizationId: healthcare.id,
        mappingType: "CIDR",
        cidr: `${NET}.5.0/24`,
        confidence: "HIGH",
        source: "MANUAL",
      },
      { client: prisma }
    );
    const summary8 = await reResolution.reResolveForMapping(targetedMapping, {
      client: prisma,
      asOf: T1,
      batchSize: 100,
    });
    s8.eq("candidateCount", summary8.candidateCount, 1);
    s8.eq("changedCount", summary8.changedCount, 1);
    s8.eq("failedCount", summary8.failedCount, 0);
    s8.eq("truncated", summary8.truncated, false);
    const inRow = await currentOwnership(prisma, inRange.id);
    s8.eq("inRangeResolvedToMappingOrg", inRow.organizationId, healthcare.id);

    const outAfter = await currentOwnership(prisma, outOfRange.id);
    s9.eq("unrelatedCurrentRowId", outAfter.id, outBefore.id);
    s9.eq("unrelatedStatus", outAfter.status, outBefore.status);
    s9.eq("unrelatedHistoryCount", await ownershipHistoryCount(prisma, outOfRange.id), outHistoryBefore);

    // ------------------------------------------------------------------
    // 10. Mapping deactivation re-resolves previously attributed Findings.
    // ------------------------------------------------------------------
    const s10 = scenario("10_deactivation_releases", "disabling a mapping releases what it owned");
    await mappings.disableAssetMapping(targetedMapping.id, { client: prisma });
    const summary10 = await reResolution.reResolveForMapping(
      await prisma.assetMapping.findUnique({ where: { id: targetedMapping.id } }),
      { client: prisma, asOf: T2, batchSize: 100 }
    );
    s10.eq("changedCount", summary10.changedCount, 1);
    const releasedRow = await currentOwnership(prisma, inRange.id);
    // The /16 general mapping created in scenario 5 still covers this address,
    // so it falls back to that rather than to UNRESOLVED — the honest outcome.
    s10.eq("fallsBackToBroaderMapping", releasedRow.organizationId, general.id);
    s10.eq("historyIsAppendOnly", (await ownershipHistoryCount(prisma, inRange.id)) >= 3, true);

    // ------------------------------------------------------------------
    // 11. Explicit override is not overwritten.
    // ------------------------------------------------------------------
    const s11 = scenario("11_override_preserved", "automatic re-resolution never discards an override");
    const overridden = await makeFinding(prisma, "7.5", T0);
    await ownership.applyOverride(overridden.id, unknownSector.id, "Gate: analyst-confirmed owner", {
      client: prisma,
      asOf: T0,
    });
    const overrideMapping = await mappings.createAssetMapping(
      {
        organizationId: healthcare.id,
        mappingType: "CIDR",
        cidr: `${NET}.7.0/24`,
        confidence: "HIGH",
        source: "MANUAL",
      },
      { client: prisma }
    );
    const summary11 = await reResolution.reResolveForMapping(overrideMapping, {
      client: prisma,
      asOf: T1,
      batchSize: 100,
    });
    s11.eq("changedCount", summary11.changedCount, 0);
    s11.eq("overriddenPreservedCount", summary11.overriddenPreservedCount, 1);
    const overrideRow = await currentOwnership(prisma, overridden.id);
    s11.eq("statusStillOverridden", overrideRow.status, "OVERRIDDEN");
    s11.eq("organizationUnchanged", overrideRow.organizationId, unknownSector.id);
    s11.eq("confidence", overrideRow.confidence, "CONFIRMED");

    // ------------------------------------------------------------------
    // 12. Ownership change activates/deactivates sectorCriticality correctly.
    // ------------------------------------------------------------------
    const s12 = scenario("12_sector_gate_follows_ownership", "sector applicability tracks ownership");

    const ambiguousContext = await sectorContext.buildSectorContext(prisma, tiedFinding.id, tiedRow);
    s12.eq("ambiguousNotApplicable", ambiguousContext.sectorCriticalityApplicability, "NOT_APPLICABLE_AMBIGUOUS");

    const ispContext = await sectorContext.buildSectorContext(prisma, asnFinding.id, asnRow);
    // ISP is reported ahead of confidence: the honest reason is "carrier, not victim".
    s12.eq("ispNotApplicable", ispContext.sectorCriticalityApplicability, "NOT_APPLICABLE_ISP_ATTRIBUTION");

    const healthcareContext = await sectorContext.buildSectorContext(prisma, exactFinding.id, exactRow);
    s12.eq("resolvedHighIsApplicable", healthcareContext.sectorCriticalityApplicability, "APPLICABLE");
    s12.eq("sector", healthcareContext.sector, "HEALTHCARE");

    const unknownContext = await sectorContext.buildSectorContext(prisma, overridden.id, overrideRow);
    // Attribution is strong (an override) but the sector itself is UNKNOWN —
    // missing context, never silently treated as the least risky sector.
    s12.eq("unknownSectorNotApplicable", unknownContext.sectorCriticalityApplicability, "NOT_APPLICABLE_UNKNOWN_SECTOR");

    // ------------------------------------------------------------------
    // 13. AbuseIPDB (IOC reputation) stays independent of vulnerability evidence.
    // ------------------------------------------------------------------
    const s13 = scenario("13_ioc_reputation_independent", "IOC reputation is its own factor");
    await risk.recalculateFindingRisk({
      findingId: exactFinding.id,
      asOf: T1,
      trigger: "SYSTEM_RECALCULATION",
      client: prisma,
      auditContext: { actorUserId: null, source: MARKER },
    });
    const exactScore = await prisma.riskScore.findUnique({
      where: { currentForFindingId: exactFinding.id },
    });
    const exactContribs = await prisma.riskFactorContribution.findMany({
      where: { riskScoreId: exactScore.id },
    });
    const byKey = new Map(exactContribs.map((c) => [c.factorKey, c]));
    // No enrichment row exists, so reputation is NOT_AVAILABLE — a distinct
    // state from the vulnerability factors' NOT_APPLICABLE.
    s13.eq("iocApplicability", byKey.get("iocReputationContext").applicability, "NOT_AVAILABLE");
    s13.eq("cveApplicability", byKey.get("cvePresence").applicability, "NOT_APPLICABLE");
    s13.eq("kevApplicability", byKey.get("kevStatus").applicability, "NOT_APPLICABLE");
    s13.eq("epssApplicability", byKey.get("epssScore").applicability, "NOT_APPLICABLE");

    // ------------------------------------------------------------------
    // 14. No CVE is ever inferred from an exposed RDP port.
    // ------------------------------------------------------------------
    const s14 = scenario("14_no_inferred_cve", "port 3389 alone never activates cvePresence");
    s14.eq("cveContribution", byKey.get("cvePresence").contributionBasisPoints, 0);
    const associations = await prisma.findingVulnerability.count({
      where: { findingId: exactFinding.id },
    });
    s14.eq("noAssociationsCreated", associations, 0);

    // ------------------------------------------------------------------
    // 15/16. Sector applicability is additive with the rest of the model and
    //        is never double-counted across an ownership change.
    // ------------------------------------------------------------------
    const s15 = scenario("15_sector_contribution_is_exact", "HEALTHCARE contributes exactly 1000bp");
    s15.eq("sectorApplicability", byKey.get("sectorCriticality").applicability, "APPLIED");
    s15.eq("sectorContributionBasisPoints", byKey.get("sectorCriticality").contributionBasisPoints, SECTOR_HEALTHCARE_BP);
    s15.eq("algorithmVersion", exactScore.algorithmVersion, ALGORITHM_VERSION);
    s15.eq("configurationVersion", exactScore.configurationVersion, CONFIGURATION_VERSION);
    // The total is exactly the sum of its stored contributions — no hidden term.
    const summed = exactContribs.reduce((acc, c) => acc + c.contributionBasisPoints, 0);
    s15.eq("totalEqualsSumOfContributions", exactScore.scoreBasisPoints, summed);
    // Band is re-derived here from the hand-transcribed thresholds rather than
    // trusted from the engine, so a silently shifted band table fails the gate.
    const expectedBand =
      exactScore.scoreBasisPoints >= BAND_MEDIUM_MIN
        ? "MEDIUM"
        : exactScore.scoreBasisPoints >= BAND_LOW_MIN
          ? "LOW"
          : "INFORMATIONAL";
    s15.eq("bandMatchesHandDerivedTable", exactScore.riskBand, expectedBand);

    const s16 = scenario("16_no_double_count_on_reresolution", "repeat re-resolution adds no score");
    const scoreCountBefore = await prisma.riskScore.count({ where: { findingId: exactFinding.id } });
    // Re-resolving the same mapping twice more must be a no-op: identical
    // ownership fingerprint -> UNCHANGED -> no new ownership row, no new score.
    const exactMapping = await prisma.assetMapping.findFirst({
      where: { exactIp: `${NET}.1.10` },
    });
    await reResolution.reResolveForMapping(exactMapping, { client: prisma, asOf: T2, batchSize: 10 });
    await reResolution.reResolveForMapping(exactMapping, { client: prisma, asOf: T2, batchSize: 10 });
    s16.eq("noNewRiskScores", await prisma.riskScore.count({ where: { findingId: exactFinding.id } }), scoreCountBefore);
    s16.eq("noNewOwnershipRows", await ownershipHistoryCount(prisma, exactFinding.id), 1);
    // Ownership itself contributes zero basis points, always.
    s16.eq("ownershipIsUnscored", exactContribs.some((c) => c.factorKey === "ownership"), false);

    // ------------------------------------------------------------------
    // 17. Historical rows remain unchanged after later updates.
    // ------------------------------------------------------------------
    const s17 = scenario("17_history_immutable", "superseded rows are never rewritten");
    const historyRows = await prisma.findingOwnership.findMany({
      where: { findingId: inRange.id },
      orderBy: { id: "asc" },
    });
    const superseded = historyRows.filter((r) => r.currentForFindingId === null);
    s17.ok("hasSupersededRows", superseded.length >= 2);
    // Every superseded row carries a supersededAt and has released the
    // current-row key — exactly one row is current.
    s17.eq("allSupersededStamped", superseded.every((r) => r.supersededAt !== null), true);
    s17.eq("exactlyOneCurrent", historyRows.filter((r) => r.currentForFindingId !== null).length, 1);

    // ------------------------------------------------------------------
    // 18. Absence from a later report does not auto-close a Finding.
    // ------------------------------------------------------------------
    const s18 = scenario("18_absence_does_not_close", "a Finding is never auto-closed by absence");
    const absentCsv = Buffer.from(
      csvHeader + `2026-05-03T00:00:00Z,${NET}.9.99,3389,tcp,,64500,synthetic-as,GB\n`,
      "utf8"
    );
    await ingestion.ingestAccessibleRdpReport(
      {
        fileBytes: absentCsv,
        source: "SYNTHETIC_UPLOAD",
        sourceFileName: `${MARKER}-report-3.csv`,
        contentType: "text/csv",
        observationDate: T2,
        ingestedByUserId: null,
      },
      { client: prisma }
    );
    const stillOpen = await prisma.finding.findFirst({ where: { indicatorValue: `${NET}.0.10` } });
    s18.eq("statusStillOpen", stillOpen.status, "OPEN");
    s18.eq("closedAtStillNull", stillOpen.closedAt, null);

    // ------------------------------------------------------------------
    // 19. Manual closure plus a newer occurrence reopens it (recurrence).
    // ------------------------------------------------------------------
    const s19 = scenario("19_recurrence_reopens", "a closed Finding reopens on a newer observation");
    await prisma.finding.update({
      where: { id: stillOpen.id },
      data: {
        status: "CLOSED",
        closedAt: T2,
        closureReason: "Gate: manual closure",
        closedThroughObservedAt: T1,
      },
    });
    const reopenCsv = Buffer.from(
      csvHeader + `2026-05-04T00:00:00Z,${NET}.0.10,3389,tcp,,64500,synthetic-as,GB\n`,
      "utf8"
    );
    await ingestion.ingestAccessibleRdpReport(
      {
        fileBytes: reopenCsv,
        source: "SYNTHETIC_UPLOAD",
        sourceFileName: `${MARKER}-report-4.csv`,
        contentType: "text/csv",
        observationDate: new Date("2026-05-04T00:00:00Z"),
        ingestedByUserId: null,
      },
      { client: prisma }
    );
    const reopened = await prisma.finding.findFirst({ where: { indicatorValue: `${NET}.0.10` } });
    s19.eq("statusReopened", reopened.status, "OPEN");
    s19.eq("recurrenceCountBumped", reopened.recurrenceCount, 1);
    s19.eq("closedAtCleared", reopened.closedAt, null);

    // ------------------------------------------------------------------
    // 20. Safe API surfaces exclude internal keys.
    // ------------------------------------------------------------------
    const s20 = scenario("20_no_internal_keys_leak", "safe surfaces expose no internal machinery");
    const ctx = await sectorContext.buildSectorContext(prisma, exactFinding.id, exactRow);
    const serializedContext = JSON.stringify(ctx);
    const forbiddenKeys = [
      "currentForFindingId",
      "leaseExpiresAt",
      "leaseOwner",
      "cacheKey",
      "nextAttemptAt",
      "inputFingerprint",
      "ipStart",
      "ipEnd",
      "provenanceNote",
      "contactPerson",
      "securityScore",
    ];
    forbiddenKeys.forEach((key) => s20.eq(`contextExcludes.${key}`, serializedContext.includes(key), false));

    const mappingList = await mappings.listAssetMappings({}, { client: prisma });
    const serializedMappings = JSON.stringify(
      mappingList.items.map(mappings.serializeAssetMapping)
    );
    s20.eq("mappingsExcludeIpStart", serializedMappings.includes("ipStart"), false);
    s20.eq("mappingsExcludeIpEnd", serializedMappings.includes("ipEnd"), false);

    const reResolveSummary = reResolution.reResolutionAuditSummary(summary8);
    // A bounded aggregate audit payload must not carry a cursor or an address.
    s20.eq("auditSummaryExcludesCursor", Object.keys(reResolveSummary).includes("nextAfterId"), false);
    s20.eq("auditSummaryHasNoAddress", /\d+\.\d+\.\d+\.\d+/.test(JSON.stringify(reResolveSummary)), false);

    // ------------------------------------------------------------------
    // 21. Role/capability restrictions remain enforced.
    // ------------------------------------------------------------------
    const s21 = scenario("21_capabilities_enforced", "the ADMIN-only boundary is intact");
    const adminOnly = ["manage:ownership-mappings", "manage:system", "manage:users", "delete:records"];
    adminOnly.forEach((capability) => {
      s21.eq(`admin.${capability}`, roles.ROLE_CAPABILITIES.ADMIN.includes(capability), true);
      ["ANALYST", "REVIEWER", "VIEWER"].forEach((role) => {
        s21.eq(`${role}.${capability}`, roles.ROLE_CAPABILITIES[role].includes(capability), false);
      });
    });
    // An analyst may still correct ownership on a Finding they triage.
    s21.eq("analystHasOverride", roles.ROLE_CAPABILITIES.ANALYST.includes("override:finding-ownership"), true);
    s21.eq("viewerHasNoOverride", roles.ROLE_CAPABILITIES.VIEWER.includes("override:finding-ownership"), false);
    // An unrecognised role holds nothing at all — authorization fails closed.
    s21.eq("unknownRoleHasNoCapabilities", roles.ROLE_CAPABILITIES.superuser === undefined, true);

    // ------------------------------------------------------------------
    // 22. Consistency, isolation and no external network.
    // ------------------------------------------------------------------
    const s22 = scenario("22_consistency_and_isolation", "no drift, no generated artifacts, no network");
    const report = await consistency.checkOwnershipConsistency(prisma, {
      batchSize: 500,
      asOf: T2,
    });
    // Every structural defect class must be zero across everything this gate built.
    [
      "DUPLICATE_CURRENT_ROW",
      "RESOLVED_WITHOUT_ORGANIZATION",
      "AMBIGUOUS_WITH_ORGANIZATION",
      "UNRESOLVED_WITH_ORGANIZATION",
      "OVERRIDE_RELIES_ON_MAPPING",
      "INVALID_STATUS_CONFIDENCE_COMBINATION",
      "ISP_ATTRIBUTION_INCOMPATIBLE",
    ].forEach((code) => s22.eq(`consistency.${code}`, report.countsByCode[code], 0));
    s22.eq("noExternalNetwork", networkAttempts, 0);

    // --- Report -------------------------------------------------------------
    let failed = 0;
    results.forEach((record) => {
      if (record.diffs.length === 0) {
        console.log(`PASS  ${record.id}`);
      } else {
        failed += 1;
        console.log(`FAIL  ${record.id} — ${record.title}`);
        record.diffs.forEach((d) => {
          console.log(`        ${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`);
        });
      }
    });

    console.log("\nFinal:");
    if (failed === 0) {
      console.log(
        `PASS — ${results.length} combined Phase 2 scenarios and ${assertionCount} manually authored assertions match exactly`
      );
    } else {
      console.log(`FAIL — ${failed} of ${results.length} scenarios did not match`);
      process.exitCode = 1;
    }
  } finally {
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
