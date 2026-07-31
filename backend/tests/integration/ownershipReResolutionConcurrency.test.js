import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// ===========================================================================
// Real-PostgreSQL concurrency and failure-isolation proofs for bounded
// ownership re-resolution (Phase 2 closing packet).
//
// WHY SEPARATE PRISMA CLIENTS
// ---------------------------
// Promise.all over ONE PrismaClient is not a concurrency proof. A single client
// multiplexes over its own connection pool and, for interactive transactions,
// serialises far more than a real deployment would — so a race that a second
// process would hit can pass every time. Each racing participant here gets its
// own pre-connected PrismaClient, connected in beforeAll so connection setup
// latency cannot accidentally stagger the race it is supposed to create.
//
// Self-skips unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_test?schema=public" \
//     npx vitest run --no-file-parallelism tests/integration/ownershipReResolutionConcurrency.test.js
// ===========================================================================

const { PrismaClient } = require("@prisma/client");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Same module-scope bootstrap as the sibling real-DB suites: services required
// below pull in src/config/env.js, which validates the full application
// configuration at require time regardless of whether this suite is skipped.
if (TEST_DATABASE_URL) {
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || "reresolution_concurrency_test_secret_not_a_real_key";
  process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
}

const {
  resolveOneFinding,
  applyOverride,
} = require("../../src/services/ownership/findingOwnershipService");
const {
  createAssetMapping,
  disableAssetMapping,
} = require("../../src/services/ownership/assetMappingService");
const {
  reResolveForMapping,
} = require("../../src/services/ownership/ownershipReResolutionService");

// RFC 2544 benchmarking range — distinct from 192.0.2.x (ownershipConcurrency),
// 198.51.100.x (P1-T4) and 203.0.113.x (phase1 gate), so cleanup here can never
// collide with another suite's rows.
const MARKER = "p2-reresolve";
const IP_PREFIX = "198.18.";

let primary;
let racerA;
let racerB;

async function cleanup() {
  const findings = await primary.finding.findMany({
    where: { indicatorValue: { startsWith: IP_PREFIX } },
    select: { id: true },
  });
  const findingIds = findings.map((f) => f.id);

  const riskScores = await primary.riskScore.findMany({
    where: { findingId: { in: findingIds } },
    select: { id: true },
  });
  const riskScoreIds = riskScores.map((r) => r.id);

  await primary.riskFactorContribution.deleteMany({ where: { riskScoreId: { in: riskScoreIds } } });
  await primary.riskScore.deleteMany({ where: { id: { in: riskScoreIds } } });
  await primary.findingOwnership.deleteMany({ where: { findingId: { in: findingIds } } });
  await primary.findingOccurrence.deleteMany({ where: { findingId: { in: findingIds } } });
  await primary.finding.deleteMany({ where: { id: { in: findingIds } } });
  await primary.assetMapping.deleteMany({
    where: { organization: { name: { startsWith: MARKER } } },
  });
  await primary.organization.deleteMany({ where: { name: { startsWith: MARKER } } });
}

async function makeOrganization(label, sector = "HEALTHCARE") {
  return primary.organization.create({
    data: {
      name: `${MARKER}-${label}`,
      industry: "synthetic",
      location: "synthetic",
      contactPerson: "synthetic",
      email: `${MARKER}-${label}-${Math.abs(label.length * 7919)}@example.test`,
      sector,
    },
  });
}

async function makeFinding(ip) {
  return primary.finding.create({
    data: {
      indicatorValue: ip,
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      status: "OPEN",
      firstSeen: new Date("2026-01-01T00:00:00Z"),
      lastSeen: new Date("2026-01-01T00:00:00Z"),
      occurrenceCount: 1,
    },
  });
}

async function currentRows(findingId) {
  const rows = await primary.findingOwnership.findMany({ where: { findingId } });
  return rows.filter((r) => r.currentForFindingId !== null);
}

const ASOF = new Date("2026-06-01T00:00:00Z");
const LATER = new Date("2026-06-02T00:00:00Z");

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb("Phase 2 — bounded ownership re-resolution under real PostgreSQL", () => {
  beforeAll(async () => {
    primary = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    racerA = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    racerB = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    // Pre-connect: an unconnected client would spend its first call on
    // handshake and lose the race by accident rather than by design.
    await Promise.all([primary.$connect(), racerA.$connect(), racerB.$connect()]);
  }, 60000);

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!primary) return;
    await cleanup();
    await Promise.all([primary.$disconnect(), racerA.$disconnect(), racerB.$disconnect()]);
  }, 60000);

  it("1. concurrent re-resolution from two separate clients leaves exactly one current row", async () => {
    const org = await makeOrganization("concurrent");
    const ip = `${IP_PREFIX}1.10`;
    const finding = await makeFinding(ip);
    const mapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );

    // Genuinely concurrent: two independent connections, same mapping, same asOf.
    const [a, b] = await Promise.all([
      reResolveForMapping(mapping, { client: racerA, asOf: ASOF, batchSize: 10 }),
      reResolveForMapping(mapping, { client: racerB, asOf: ASOF, batchSize: 10 }),
    ]);

    expect(a.failedCount).toBe(0);
    expect(b.failedCount).toBe(0);
    expect(await currentRows(finding.id)).toHaveLength(1);
    // Exactly one of them wrote; the other saw an identical outcome.
    expect(a.changedCount + b.changedCount).toBe(1);
  }, 90000);

  it("2. competing mapping mutations do not create duplicate current rows", async () => {
    const orgA = await makeOrganization("competing-a");
    const orgB = await makeOrganization("competing-b");
    const ip = `${IP_PREFIX}2.10`;
    const finding = await makeFinding(ip);

    const mappingA = await createAssetMapping(
      { organizationId: orgA.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );
    const mappingB = await createAssetMapping(
      { organizationId: orgB.id, mappingType: "CIDR", cidr: `${IP_PREFIX}2.0/24`, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );

    await Promise.all([
      reResolveForMapping(mappingA, { client: racerA, asOf: ASOF, batchSize: 10 }),
      reResolveForMapping(mappingB, { client: racerB, asOf: ASOF, batchSize: 10 }),
    ]);

    const current = await currentRows(finding.id);
    expect(current).toHaveLength(1);
    // Exact-IP outranks CIDR whichever mutation landed last.
    expect(current[0].organizationId).toBe(orgA.id);
    expect(current[0].reasonCode).toBe("OWNERSHIP_EXACT_IP_MATCH");
  }, 90000);

  it("3. re-resolution after deactivation preserves ordered, append-only history", async () => {
    const org = await makeOrganization("ordered");
    const ip = `${IP_PREFIX}3.10`;
    const finding = await makeFinding(ip);
    const mapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );

    await reResolveForMapping(mapping, { client: primary, asOf: ASOF, batchSize: 10 });
    await disableAssetMapping(mapping.id, { client: primary });
    const disabled = await primary.assetMapping.findUnique({ where: { id: mapping.id } });
    await reResolveForMapping(disabled, { client: primary, asOf: LATER, batchSize: 10 });

    const history = await primary.findingOwnership.findMany({
      where: { findingId: finding.id },
      orderBy: { id: "asc" },
    });
    expect(history).toHaveLength(2);
    // The first row is superseded and its substantive fields are untouched.
    expect(history[0].currentForFindingId).toBeNull();
    expect(history[0].supersededAt).not.toBeNull();
    expect(history[0].organizationId).toBe(org.id);
    expect(history[0].status).toBe("RESOLVED");
    // The second is current and reflects the release.
    expect(history[1].currentForFindingId).toBe(finding.id);
    expect(history[1].status).toBe("UNRESOLVED");
    expect(history[1].organizationId).toBeNull();
    // Ordering is monotonic in both id and resolvedAt.
    expect(history[1].resolvedAt.getTime()).toBeGreaterThanOrEqual(history[0].resolvedAt.getTime());
  }, 90000);

  it("4. an explicit override survives concurrent automatic re-resolution", async () => {
    const mappingOrg = await makeOrganization("override-mapping");
    const overrideOrg = await makeOrganization("override-analyst");
    const ip = `${IP_PREFIX}4.10`;
    const finding = await makeFinding(ip);

    await applyOverride(finding.id, overrideOrg.id, "Concurrency proof: analyst-confirmed owner", {
      client: primary,
      asOf: ASOF,
    });
    const mapping = await createAssetMapping(
      { organizationId: mappingOrg.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );

    await Promise.all([
      reResolveForMapping(mapping, { client: racerA, asOf: LATER, batchSize: 10 }),
      reResolveForMapping(mapping, { client: racerB, asOf: LATER, batchSize: 10 }),
    ]);

    const current = await currentRows(finding.id);
    expect(current).toHaveLength(1);
    expect(current[0].status).toBe("OVERRIDDEN");
    expect(current[0].organizationId).toBe(overrideOrg.id);
    // No churn at all: the override row is still the only row.
    const all = await primary.findingOwnership.findMany({ where: { findingId: finding.id } });
    expect(all).toHaveLength(1);
  }, 90000);

  it("5. the mapping mutation stays committed when re-resolution fails", async () => {
    const org = await makeOrganization("mutation-persists");
    const ip = `${IP_PREFIX}5.10`;
    await makeFinding(ip);

    const mapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );

    // A client whose candidate selection always throws. reResolveForMapping
    // must absorb it and report, never propagate into the mutation path.
    const brokenClient = new Proxy(primary, {
      get(target, property, receiver) {
        if (property === "finding") {
          return {
            findMany: async () => {
              throw new Error("injected candidate selection failure");
            },
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const summary = await reResolveForMapping(mapping, {
      client: brokenClient,
      asOf: ASOF,
      batchSize: 10,
    });

    expect(summary.failureCode).toBe("CANDIDATE_SELECTION_FAILED");
    expect(summary.processedCount).toBe(0);
    // The mapping the analyst created is still there, enabled, unchanged.
    const persisted = await primary.assetMapping.findUnique({ where: { id: mapping.id } });
    expect(persisted).not.toBeNull();
    expect(persisted.enabled).toBe(true);
    expect(persisted.organizationId).toBe(org.id);
  }, 90000);

  it("6. the ownership change persists when risk recalculation fails", async () => {
    const org = await makeOrganization("risk-fails");
    const ip = `${IP_PREFIX}6.10`;
    const finding = await makeFinding(ip);
    const mapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );

    // Break only the risk write path. Ownership uses findingOwnership/finding;
    // risk scoring needs riskScore, so failing that isolates the two.
    const riskBrokenClient = new Proxy(primary, {
      get(target, property, receiver) {
        if (property === "riskScore") {
          return new Proxy(target.riskScore, {
            get(model, modelProperty) {
              if (modelProperty === "create" || modelProperty === "findMany") {
                return async () => {
                  throw new Error("injected risk failure");
                };
              }
              const value = model[modelProperty];
              return typeof value === "function" ? value.bind(model) : value;
            },
          });
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const summary = await reResolveForMapping(mapping, {
      client: riskBrokenClient,
      asOf: ASOF,
      batchSize: 10,
    });

    // Ownership committed despite the risk failure.
    expect(summary.changedCount).toBe(1);
    const current = await currentRows(finding.id);
    expect(current).toHaveLength(1);
    expect(current[0].organizationId).toBe(org.id);
  }, 90000);

  it("7. an audit failure does not roll back the mapping or the ownership change", async () => {
    const org = await makeOrganization("audit-fails");
    const ip = `${IP_PREFIX}7.10`;
    const finding = await makeFinding(ip);
    const mapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );

    const auditBrokenClient = new Proxy(primary, {
      get(target, property, receiver) {
        if (property === "auditLog") {
          return new Proxy(target.auditLog, {
            get(model, modelProperty) {
              if (modelProperty === "create") {
                return async () => {
                  throw new Error("injected audit failure");
                };
              }
              const value = model[modelProperty];
              return typeof value === "function" ? value.bind(model) : value;
            },
          });
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const summary = await reResolveForMapping(mapping, {
      client: auditBrokenClient,
      asOf: ASOF,
      batchSize: 10,
    });

    expect(summary.changedCount).toBe(1);
    expect(await currentRows(finding.id)).toHaveLength(1);
    const persisted = await primary.assetMapping.findUnique({ where: { id: mapping.id } });
    expect(persisted.enabled).toBe(true);
  }, 90000);

  it("8. bounded pagination processes every candidate exactly once, skipping none", async () => {
    const org = await makeOrganization("pagination");
    const findings = [];
    for (let i = 1; i <= 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      findings.push(await makeFinding(`${IP_PREFIX}8.${i}`));
    }
    const mapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "CIDR", cidr: `${IP_PREFIX}8.0/24`, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );

    // Walk the whole candidate set in batches of 2 using only the cursor the
    // previous batch returned — the same contract the ADMIN continuation
    // endpoint enforces through its signed token.
    const processed = [];
    let afterId = 0;
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 20) throw new Error("pagination did not terminate");
      // eslint-disable-next-line no-await-in-loop
      const summary = await reResolveForMapping(mapping, {
        client: primary,
        asOf: ASOF,
        batchSize: 2,
        afterId,
      });
      processed.push(summary.processedCount);
      if (!summary.truncated) break;
      afterId = summary.nextAfterId;
    }

    const total = processed.reduce((a, b) => a + b, 0);
    expect(total).toBe(7);
    // Every finding got exactly one ownership row — none skipped, none twice.
    for (const finding of findings) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await primary.findingOwnership.findMany({ where: { findingId: finding.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].organizationId).toBe(org.id);
    }
  }, 120000);

  it("9. Findings outside the mapping are never processed at all", async () => {
    const org = await makeOrganization("unrelated");
    const inRange = await makeFinding(`${IP_PREFIX}9.10`);
    const outOfRange = await makeFinding(`${IP_PREFIX}99.10`);

    // Give the out-of-range finding a real ownership row first, so "untouched"
    // means "not rewritten", not merely "still absent".
    await resolveOneFinding(outOfRange.id, { client: primary, asOf: ASOF });
    const before = await primary.findingOwnership.findMany({ where: { findingId: outOfRange.id } });

    const mapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "CIDR", cidr: `${IP_PREFIX}9.0/24`, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );
    const summary = await reResolveForMapping(mapping, {
      client: primary,
      asOf: LATER,
      batchSize: 50,
    });

    expect(summary.candidateCount).toBe(1);
    expect(summary.processedCount).toBe(1);

    const after = await primary.findingOwnership.findMany({ where: { findingId: outOfRange.id } });
    expect(after).toHaveLength(before.length);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].resolvedAt.getTime()).toBe(before[0].resolvedAt.getTime());

    const inRangeRows = await currentRows(inRange.id);
    expect(inRangeRows[0].organizationId).toBe(org.id);
  }, 90000);

  it("10. FK Restrict still prevents orphaning ownership history after re-resolution", async () => {
    const org = await makeOrganization("restrict");
    const ip = `${IP_PREFIX}10.10`;
    const finding = await makeFinding(ip);
    const mapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );
    await reResolveForMapping(mapping, { client: primary, asOf: ASOF, batchSize: 10 });

    // The ownership row references the mapping; the mapping cannot vanish.
    await expect(primary.assetMapping.delete({ where: { id: mapping.id } })).rejects.toThrow();
    // The Finding carries ownership history; it cannot vanish either.
    await expect(primary.finding.delete({ where: { id: finding.id } })).rejects.toThrow();
  }, 90000);

  it("11. concurrent risk recalculation after ownership change preserves one current score", async () => {
    const org = await makeOrganization("risk-current");
    const ip = `${IP_PREFIX}11.10`;
    const finding = await makeFinding(ip);
    const mapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );

    await Promise.all([
      reResolveForMapping(mapping, { client: racerA, asOf: ASOF, batchSize: 10 }),
      reResolveForMapping(mapping, { client: racerB, asOf: ASOF, batchSize: 10 }),
    ]);

    const scores = await primary.riskScore.findMany({ where: { findingId: finding.id } });
    const currentScores = scores.filter((s) => s.currentForFindingId !== null);
    expect(currentScores).toHaveLength(1);
  }, 90000);

  it("12. repeated identical re-resolution floods neither ownership nor risk history", async () => {
    const org = await makeOrganization("no-flood");
    const ip = `${IP_PREFIX}12.10`;
    const finding = await makeFinding(ip);
    const mapping = await createAssetMapping(
      { organizationId: org.id, mappingType: "EXACT_IP", exactIp: ip, confidence: "HIGH", source: "MANUAL" },
      { client: primary }
    );

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await reResolveForMapping(mapping, {
        client: primary,
        // A LATER asOf each time: an identical decision reached at a different
        // moment must still count as unchanged.
        asOf: new Date(ASOF.getTime() + i * 3600_000),
        batchSize: 10,
      });
    }

    const ownershipRows = await primary.findingOwnership.findMany({
      where: { findingId: finding.id },
    });
    expect(ownershipRows).toHaveLength(1);

    const scores = await primary.riskScore.findMany({ where: { findingId: finding.id } });
    expect(scores.length).toBeLessThanOrEqual(1);
  }, 120000);
});
