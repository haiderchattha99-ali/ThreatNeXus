import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "node:crypto";

// Real-PostgreSQL tests for P2-T1 ownership mapping. These exist because a
// stubbed/in-memory Prisma client (see findingOwnershipService.test.js)
// cannot prove: the currentForFindingId unique constraint under real
// concurrency, FK Restrict enforcement, or BigInt range-containment
// filtering against actual PostgreSQL bigint columns — mirrors the scope
// split documented in dedupServiceConcurrency.test.js.
//
// Self-skips unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_test?schema=public" npx vitest run tests/integration/ownershipConcurrency.test.js

const { PrismaClient } = require("@prisma/client");
const {
  resolveOneFinding,
  applyOverride,
  clearOverride,
  getFindingOwnership,
} = require("../../src/services/ownership/findingOwnershipService");
const {
  createAssetMapping,
  disableAssetMapping,
} = require("../../src/services/ownership/assetMappingService");
const { ipv4ToInt } = require("../../src/services/ownership/ipv4Cidr");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Tests 9 and 10 lazily require reportIngestionService, which loads
// src/config/env.js at module scope and therefore needs the full application
// configuration to be present. Without this bootstrap the suite passed only
// when the developer's shell happened to already export DATABASE_URL /
// JWT_SECRET / CORS_ORIGIN, and failed with ConfigError on a clean
// environment. Same module-scope pattern already used by
// reportIngestionConcurrency, enrichmentWorkflowConcurrency, phase1Gate and
// vulnerabilityReleaseWorkflow.
if (TEST_DATABASE_URL) {
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || "ownership_concurrency_test_secret_not_a_real_key";
  process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
}

// RFC 5737 TEST-NET-1 — distinct from the 198.51.100.x (P1-T4) and
// 203.0.113.x (phase1-gate/fixtures) ranges already used by other real-DB
// suites, so cleanup here can never collide with theirs.
const MARKER = "p2t1-ownership";
const IP_PREFIX = "192.0.2.";

let prisma;

async function cleanup() {
  await prisma.findingOwnership.deleteMany({
    where: { finding: { indicatorValue: { startsWith: IP_PREFIX } } },
  });
  await prisma.assetMapping.deleteMany({
    where: { organization: { name: { startsWith: MARKER } } },
  });
  await prisma.findingOccurrence.deleteMany({
    where: { rawReport: { sourceFileName: { startsWith: MARKER } } },
  });
  await prisma.rawReportRow.deleteMany({
    where: { rawReport: { sourceFileName: { startsWith: MARKER } } },
  });
  // P2-T3: RiskFactorContribution -> RiskScore -> Finding, all Restrict.
  const riskScores = await prisma.riskScore.findMany({
    where: { finding: { indicatorValue: { startsWith: IP_PREFIX } } },
    select: { id: true },
  });
  const riskScoreIds = riskScores.map((r) => r.id);
  await prisma.riskFactorContribution.deleteMany({ where: { riskScoreId: { in: riskScoreIds } } });
  await prisma.riskScore.deleteMany({ where: { id: { in: riskScoreIds } } });
  await prisma.finding.deleteMany({ where: { indicatorValue: { startsWith: IP_PREFIX } } });
  await prisma.rawReport.deleteMany({ where: { sourceFileName: { startsWith: MARKER } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: MARKER } } });
}

async function makeOrganization(label) {
  return prisma.organization.create({
    data: {
      name: `${MARKER}-${label}`,
      industry: "Finance",
      location: "Test",
      contactPerson: "Test",
      email: `${MARKER}-${label}-${crypto.randomUUID()}@example.test`,
    },
  });
}

async function makeFinding(ip, overrides = {}) {
  return prisma.finding.create({
    data: {
      indicatorValue: ip,
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      status: "OPEN",
      firstSeen: new Date("2026-01-01T00:00:00Z"),
      lastSeen: new Date("2026-01-01T00:00:00Z"),
      occurrenceCount: 1,
      ...overrides,
    },
  });
}

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb("P2-T1 ownership — real PostgreSQL", () => {
  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
  });

  it("1. append-only supersede: a mapping change inserts a new current row and supersedes the old one, never mutating its substantive fields", async () => {
    const orgA = await makeOrganization("append-a");
    const orgB = await makeOrganization("append-b");
    const ip = `${IP_PREFIX}10`;
    const finding = await makeFinding(ip);

    const mappingA = await createAssetMapping(
      { organizationId: orgA.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: prisma }
    );

    const first = await resolveOneFinding(finding.id, { client: prisma, asOf: new Date("2026-06-01T00:00:00Z") });
    expect(first.changed).toBe(true);
    expect(first.current.organizationId).toBe(orgA.id);

    await disableAssetMapping(mappingA.id, { client: prisma });
    await createAssetMapping(
      { organizationId: orgB.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: prisma }
    );

    const second = await resolveOneFinding(finding.id, { client: prisma, asOf: new Date("2026-06-02T00:00:00Z") });
    expect(second.changed).toBe(true);
    expect(second.current.organizationId).toBe(orgB.id);

    const supersededRow = await prisma.findingOwnership.findUnique({ where: { id: first.current.id } });
    expect(supersededRow.currentForFindingId).toBeNull();
    expect(supersededRow.supersededAt).not.toBeNull();
    // Substantive fields of the superseded row are untouched — append-only.
    expect(supersededRow.organizationId).toBe(orgA.id);
    expect(supersededRow.status).toBe("RESOLVED");

    const history = await prisma.findingOwnership.findMany({ where: { findingId: finding.id } });
    expect(history).toHaveLength(2);

    const currentRows = history.filter((r) => r.currentForFindingId !== null);
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0].organizationId).toBe(orgB.id);
  }, 60000);

  it("2. identical re-resolution creates no new row", async () => {
    const org = await makeOrganization("idempotent");
    const ip = `${IP_PREFIX}11`;
    const finding = await makeFinding(ip);
    await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: prisma }
    );

    await resolveOneFinding(finding.id, { client: prisma, asOf: new Date("2026-06-01T00:00:00Z") });
    await resolveOneFinding(finding.id, { client: prisma, asOf: new Date("2026-06-02T00:00:00Z") });
    await resolveOneFinding(finding.id, { client: prisma, asOf: new Date("2026-06-03T00:00:00Z") });

    const history = await prisma.findingOwnership.findMany({ where: { findingId: finding.id } });
    expect(history).toHaveLength(1);
  }, 60000);

  it("3. concurrent resolution attempts leave exactly one current row, no aborted-transaction error", async () => {
    const org = await makeOrganization("concurrency");
    const ip = `${IP_PREFIX}12`;
    const finding = await makeFinding(ip);
    await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: prisma }
    );

    const asOf = new Date("2026-06-01T00:00:00Z");
    await Promise.all([
      resolveOneFinding(finding.id, { client: prisma, asOf }),
      resolveOneFinding(finding.id, { client: prisma, asOf }),
      resolveOneFinding(finding.id, { client: prisma, asOf }),
    ]);

    const allRows = await prisma.findingOwnership.findMany({ where: { findingId: finding.id } });
    const currentRows = allRows.filter((r) => r.currentForFindingId !== null);
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0].organizationId).toBe(org.id);
  }, 60000);

  it("4. AssetMapping FK Restrict: cannot be hard-deleted while a FindingOwnership row references it", async () => {
    const org = await makeOrganization("fk-mapping");
    const ip = `${IP_PREFIX}13`;
    const finding = await makeFinding(ip);
    const mapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: prisma }
    );
    await resolveOneFinding(finding.id, { client: prisma, asOf: new Date("2026-06-01T00:00:00Z") });

    await expect(prisma.assetMapping.delete({ where: { id: mapping.id } })).rejects.toMatchObject({
      code: "P2003",
    });
  }, 60000);

  it("5a. Organization FK Restrict via AssetMapping: cannot be deleted while an AssetMapping references it", async () => {
    const org = await makeOrganization("fk-org-mapping");
    const ip = `${IP_PREFIX}14`;
    await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: prisma }
    );
    // No Finding/FindingOwnership involved at all — isolates AssetMapping's
    // own organizationId Restrict relation from FindingOwnership's.

    await expect(prisma.organization.delete({ where: { id: org.id } })).rejects.toMatchObject({
      code: "P2003",
    });
  }, 60000);

  it("5b. Organization FK Restrict via FindingOwnership: still blocks deletion once no AssetMapping references the org", async () => {
    const org = await makeOrganization("fk-org-ownership");
    const unusedMappingIp = `${IP_PREFIX}19`;
    const ip = `${IP_PREFIX}20`;
    const finding = await makeFinding(ip);

    // A mapping is created for this org and then hard-deleted directly
    // (never resolved against, so no FindingOwnership.matchedMappingId ever
    // references it — see test 4's proof that a referenced mapping cannot be
    // deleted). Once gone, AssetMapping no longer provides any blocking
    // condition for this org at all.
    const unusedMapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: unusedMappingIp, confidence: "HIGH", source: "MANUAL" },
      { client: prisma }
    );
    await prisma.assetMapping.delete({ where: { id: unusedMapping.id } });
    const remainingMappings = await prisma.assetMapping.count({ where: { organizationId: org.id } });
    expect(remainingMappings).toBe(0);

    // The only remaining reference to this org is a FindingOwnership row
    // written by an analyst override (matchedMappingId null — no AssetMapping
    // involved at all), so this isolates FindingOwnership.organizationId's
    // own Restrict relation.
    await applyOverride(finding.id, org.id, "isolating the FindingOwnership FK", {
      client: prisma,
      asOf: new Date("2026-06-01T00:00:00Z"),
    });

    await expect(prisma.organization.delete({ where: { id: org.id } })).rejects.toMatchObject({
      code: "P2003",
    });
  }, 60000);

  it("6. override apply/clear writes real history and reverts to automatic resolution", async () => {
    const orgAuto = await makeOrganization("override-auto");
    const orgOverride = await makeOrganization("override-manual");
    const ip = `${IP_PREFIX}15`;
    const finding = await makeFinding(ip);
    await createAssetMapping(
      {
        organizationId: orgAuto.id,
        mappingType: "EXACT_IP",
        exactIp: ip,
        confidence: "HIGH",
        source: "MANUAL",
      },
      { client: prisma }
    );
    await resolveOneFinding(finding.id, { client: prisma, asOf: new Date("2026-06-01T00:00:00Z") });

    const applied = await applyOverride(finding.id, orgOverride.id, "confirmed manually", {
      client: prisma,
      actorUserId: null,
      asOf: new Date("2026-06-02T00:00:00Z"),
    });
    expect(applied.current.status).toBe("OVERRIDDEN");
    expect(applied.current.organizationId).toBe(orgOverride.id);

    const cleared = await clearOverride(finding.id, {
      client: prisma,
      justification: "auto-resolution confirmed",
      asOf: new Date("2026-06-03T00:00:00Z"),
    });
    expect(cleared.current.status).toBe("RESOLVED");
    expect(cleared.current.organizationId).toBe(orgAuto.id);

    const { history } = await getFindingOwnership(finding.id, { client: prisma });
    expect(history).toHaveLength(3); // automatic -> override -> cleared-back-to-automatic
    expect(history.map((h) => h.status)).toEqual(["RESOLVED", "OVERRIDDEN", "RESOLVED"]);
  }, 60000);

  it("7. re-resolution after a mapping validity change picks up the new state", async () => {
    const org = await makeOrganization("revalidate");
    const ip = `${IP_PREFIX}16`;
    const finding = await makeFinding(ip);

    const mapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: prisma }
    );
    const before = await resolveOneFinding(finding.id, { client: prisma, asOf: new Date("2026-06-01T00:00:00Z") });
    expect(before.current.status).toBe("RESOLVED");

    await disableAssetMapping(mapping.id, { client: prisma });
    const after = await resolveOneFinding(finding.id, { client: prisma, asOf: new Date("2026-06-02T00:00:00Z") });
    expect(after.current.status).toBe("UNRESOLVED");
  }, 60000);

  it("8. BigInt range containment against real PostgreSQL: CIDR longest-prefix match via real bigint columns", async () => {
    const orgWide = await makeOrganization("bigint-wide");
    const orgNarrow = await makeOrganization("bigint-narrow");
    const ip = `${IP_PREFIX}200`;
    const finding = await makeFinding(ip);

    await createAssetMapping(
      { organizationId: orgWide.id, mappingType: "CIDR", cidr: `${IP_PREFIX}0/24`, confidence: "LOW", source: "MANUAL" },
      { client: prisma }
    );
    await createAssetMapping(
      { organizationId: orgNarrow.id, mappingType: "CIDR", cidr: `${IP_PREFIX}192/28`, confidence: "HIGH", source: "MANUAL" },
      { client: prisma }
    );

    const outcome = await resolveOneFinding(finding.id, { client: prisma, asOf: new Date("2026-06-01T00:00:00Z") });
    expect(outcome.current.status).toBe("RESOLVED");
    expect(outcome.current.organizationId).toBe(orgNarrow.id);
    expect(outcome.current.matchedPrefixLength).toBe(28);

    // Sanity: the persisted range really is a BigInt round-trip through Postgres.
    const mapping = await prisma.assetMapping.findFirst({ where: { organizationId: orgNarrow.id } });
    expect(typeof mapping.ipStart).toBe("bigint");
    expect(mapping.ipStart).toBe(ipv4ToInt(`${IP_PREFIX}192`));
  }, 60000);

  it("9. ingestion integration writes a FindingOwnership row without affecting the ingestion outcome", async () => {
    const { ingestAccessibleRdpReport } = require("../../src/services/ingestion/reportIngestionService");
    const org = await makeOrganization("ingestion");
    const ip = `${IP_PREFIX}17`;
    await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: prisma }
    );

    const csv = `timestamp,ip,port,protocol\n2026-06-01T00:00:00Z,${ip},3389,tcp\n`;
    const result = await ingestAccessibleRdpReport(
      {
        fileBytes: Buffer.from(csv, "utf8"),
        source: "SYNTHETIC_UPLOAD",
        sourceFileName: `${MARKER}-ingest.csv`,
        contentType: "text/csv",
        ingestedByUserId: null,
      },
      { client: prisma }
    );

    expect(result.outcome).toBe("PROCESSED");

    const finding = await prisma.finding.findFirst({ where: { indicatorValue: ip } });
    expect(finding).not.toBeNull();

    const { current } = await getFindingOwnership(finding.id, { client: prisma });
    expect(current.status).toBe("RESOLVED");
    expect(current.organizationId).toBe(org.id);
  }, 60000);

  it("10. idempotent report replay does not duplicate ownership history", async () => {
    const { ingestAccessibleRdpReport } = require("../../src/services/ingestion/reportIngestionService");
    const org = await makeOrganization("replay");
    const ip = `${IP_PREFIX}18`;
    await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: prisma }
    );

    const csv = `timestamp,ip,port,protocol\n2026-06-01T00:00:00Z,${ip},3389,tcp\n`;
    const input = {
      fileBytes: Buffer.from(csv, "utf8"),
      source: "SYNTHETIC_UPLOAD",
      sourceFileName: `${MARKER}-replay.csv`,
      contentType: "text/csv",
      ingestedByUserId: null,
    };

    const first = await ingestAccessibleRdpReport(input, { client: prisma });
    expect(first.outcome).toBe("PROCESSED");
    const second = await ingestAccessibleRdpReport(input, { client: prisma });
    expect(second.outcome).toBe("DUPLICATE_COMPLETED");

    const finding = await prisma.finding.findFirst({ where: { indicatorValue: ip } });
    const history = await prisma.findingOwnership.findMany({ where: { findingId: finding.id } });
    expect(history).toHaveLength(1);
  }, 60000);
});
