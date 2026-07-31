import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "node:crypto";

// Real-PostgreSQL tests for P2-T3 deterministic risk scoring. These exist
// because a stubbed/in-memory Prisma client (see riskScoringService.test.js)
// cannot prove:
//
//   * the currentForFindingId @unique "at most one current score per Finding"
//     rule under genuine concurrency (multiple NULLs are distinct in a
//     PostgreSQL unique index — the same D-006/D-007 mechanism);
//   * onDelete: Restrict actually refusing to orphan a score or a
//     contribution;
//   * the RiskFactorContribution (riskScoreId, factorKey) unique constraint;
//   * SERIALIZABLE retry behaviour against a real engine.
//
// Mirrors the scope split documented in ownershipConcurrency.test.js.
//
// Self-skips unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_test?schema=public" npx vitest run tests/integration/riskScoringConcurrency.test.js

const { PrismaClient } = require("@prisma/client");
const {
  RISK_CALCULATION_OUTCOME,
  RISK_TRIGGERS,
  calculateAndPersistRisk,
} = require("../../src/services/risk/riskScoringService");
const { getFindingRisk } = require("../../src/services/risk/findingRiskReadService");
const {
  FACTOR_DISPLAY_ORDER,
  RISK_CONFIGURATION_FINGERPRINT,
} = require("../../src/services/risk/riskConfiguration");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// RFC 5737 TEST-NET-3 — distinct from 192.0.2.x (P2-T1), 198.51.100.x (P1-T4)
// and the 203.0.113.x fixtures, so cleanup here can never collide.
const MARKER = "p2t3-risk";
const IP_PREFIX = "203.0.113.2";

const ASOF = new Date("2026-07-01T00:00:00Z");

// Separate PrismaClient instances used only by the concurrency proofs.
let racers = [];
const DAY = 86400000;

let prisma;

async function cleanup() {
  const findings = await prisma.finding.findMany({
    where: { indicatorValue: { startsWith: IP_PREFIX } },
    select: { id: true },
  });
  const findingIds = findings.map((f) => f.id);

  const scores = await prisma.riskScore.findMany({
    where: { findingId: { in: findingIds } },
    select: { id: true },
  });
  const scoreIds = scores.map((s) => s.id);

  await prisma.riskFactorContribution.deleteMany({ where: { riskScoreId: { in: scoreIds } } });
  await prisma.riskScore.deleteMany({ where: { id: { in: scoreIds } } });
  await prisma.findingOwnership.deleteMany({ where: { findingId: { in: findingIds } } });
  await prisma.findingOccurrence.deleteMany({ where: { findingId: { in: findingIds } } });
  await prisma.rawReportRow.deleteMany({
    where: { rawReport: { sourceFileName: { startsWith: MARKER } } },
  });
  await prisma.finding.deleteMany({ where: { id: { in: findingIds } } });
  await prisma.rawReport.deleteMany({ where: { sourceFileName: { startsWith: MARKER } } });
  await prisma.assetMapping.deleteMany({
    where: { organization: { name: { startsWith: MARKER } } },
  });
  await prisma.organization.deleteMany({ where: { name: { startsWith: MARKER } } });
}

async function makeFinding(suffix, overrides = {}) {
  return prisma.finding.create({
    data: {
      indicatorValue: `${IP_PREFIX}${suffix}`,
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      status: "OPEN",
      firstSeen: new Date(ASOF.getTime() - 3 * DAY),
      lastSeen: ASOF,
      occurrenceCount: 1,
      ...overrides,
    },
  });
}

async function makeRawReport(label) {
  const content = Buffer.from(`${MARKER}-${label}-${crypto.randomUUID()}`, "utf8");
  return prisma.rawReport.create({
    data: {
      reportType: "ACCESSIBLE_RDP",
      schemaVersion: "accessible-rdp.synthetic.v1",
      sourceFileName: `${MARKER}-${label}-${crypto.randomUUID()}.csv`,
      sourceFileSha256: crypto.createHash("sha256").update(content).digest("hex"),
      fileSizeBytes: content.length,
      contentType: "text/csv",
      rawContent: content,
      observationDate: ASOF,
      status: "COMPLETED",
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
    },
  });
}

async function makeOccurrence(findingId, { action = "CREATED", observedAt } = {}) {
  const report = await makeRawReport(action.toLowerCase());
  return prisma.findingOccurrence.create({
    data: {
      findingId,
      rawReportId: report.id,
      action,
      observedAt: observedAt || new Date(ASOF.getTime() - 3 * DAY),
    },
  });
}

async function makeOrganization(label, sector) {
  return prisma.organization.create({
    data: {
      name: `${MARKER}-${label}`,
      industry: "Test",
      location: "Test",
      contactPerson: "Test",
      email: `${MARKER}-${label}-${crypto.randomUUID()}@example.test`,
      sector,
    },
  });
}

function persist(findingId, overrides = {}) {
  return calculateAndPersistRisk({
    findingId,
    asOf: ASOF,
    trigger: RISK_TRIGGERS.SYSTEM_RECALCULATION,
    client: prisma,
    ...overrides,
  });
}

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb("P2-T3 risk scoring — real PostgreSQL", () => {
  beforeAll(async () => {
    const datasources = { db: { url: TEST_DATABASE_URL } };
    prisma = new PrismaClient({ datasources });
    // SEPARATE, PRE-CONNECTED clients for the concurrency proof. Promise.all
    // over ONE shared PrismaClient does NOT prove a database concurrency
    // invariant: that client's connection pool serializes the calls enough to
    // hide the race, so such a test passes even against an implementation with
    // no invariant at all (measured directly during P2-T2b — six schedulers on
    // one shared client produced 1 row with the unique index dropped, while six
    // separate clients produced 6). Connecting up front keeps connection setup
    // out of the racing window.
    racers = Array.from({ length: 8 }, () => new PrismaClient({ datasources }));
    await Promise.all([prisma.$connect(), ...racers.map((client) => client.$connect())]);
  }, 60000);

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
    await Promise.all(racers.map((client) => client.$disconnect()));
    racers = [];
  });

  it("1. writes one score plus a complete contribution set, atomically", async () => {
    const finding = await makeFinding("10");
    await makeOccurrence(finding.id);

    const result = await persist(finding.id);
    expect(result.outcome).toBe(RISK_CALCULATION_OUTCOME.CREATED);
    expect(result.riskScore.scoreBasisPoints).toBe(2300);
    expect(result.riskScore.riskBand).toBe("LOW");
    expect(result.riskScore.configurationFingerprint).toBe(RISK_CONFIGURATION_FINGERPRINT);

    const stored = await prisma.riskFactorContribution.findMany({
      where: { riskScoreId: result.riskScore.id },
      orderBy: { displayOrder: "asc" },
    });
    expect(stored.map((r) => r.factorKey)).toEqual([...FACTOR_DISPLAY_ORDER]);
    // Every factor stores a row, including the unavailable and not-applicable
    // ones — that is what stops an explanation omitting missing context.
    expect(stored.filter((r) => r.applicability === "NOT_AVAILABLE")).toHaveLength(2);
    expect(stored.filter((r) => r.applicability === "NOT_APPLICABLE")).toHaveLength(3);
  });

  it("2. keeps at most one current score per Finding across serial rescorings", async () => {
    const finding = await makeFinding("11");
    await makeOccurrence(finding.id);
    await persist(finding.id);

    // Three genuinely different input states -> three appended snapshots.
    for (let i = 1; i <= 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await makeOccurrence(finding.id, {
        action: "PERSISTED",
        observedAt: new Date(ASOF.getTime() - i * 3600000),
      });
      // eslint-disable-next-line no-await-in-loop
      await persist(finding.id);
    }

    const all = await prisma.riskScore.findMany({ where: { findingId: finding.id } });
    const current = all.filter((r) => r.currentForFindingId !== null);
    expect(all).toHaveLength(4);
    expect(current).toHaveLength(1);
    expect(current[0].scoreBasisPoints).toBe(2300 + 800); // 4 observations
  });

  it("3. concurrent rescoring of the same Finding still leaves exactly one current row", async () => {
    const finding = await makeFinding("12");
    await makeOccurrence(finding.id);

    // Eight racing calculations. Each either creates the first snapshot or
    // recognises the identical input state and returns UNCHANGED; the
    // currentForFindingId unique index makes any lost race retry from scratch.
    // Eight SEPARATE pre-connected clients, one per racer, so the calls
    // genuinely contend inside PostgreSQL rather than being serialized by a
    // single client's pool.
    const results = await Promise.all(
      racers.map((client) => persist(finding.id, { client }))
    );

    results.forEach((result) => {
      expect([RISK_CALCULATION_OUTCOME.CREATED, RISK_CALCULATION_OUTCOME.UNCHANGED]).toContain(
        result.outcome
      );
    });

    const all = await prisma.riskScore.findMany({ where: { findingId: finding.id } });
    const current = all.filter((r) => r.currentForFindingId !== null);
    expect(current).toHaveLength(1);
    // Every appended snapshot has a complete, consistent contribution set —
    // no partial snapshot ever became visible.
    // eslint-disable-next-line no-restricted-syntax
    for (const row of all) {
      // eslint-disable-next-line no-await-in-loop
      const contributions = await prisma.riskFactorContribution.findMany({
        where: { riskScoreId: row.id },
      });
      expect(contributions).toHaveLength(FACTOR_DISPLAY_ORDER.length);
    }
  });

  it("4. concurrent rescoring of DIFFERENT Findings does not interfere", async () => {
    const findings = await Promise.all([makeFinding("13"), makeFinding("14"), makeFinding("15")]);
    // eslint-disable-next-line no-restricted-syntax
    for (const finding of findings) {
      // eslint-disable-next-line no-await-in-loop
      await makeOccurrence(finding.id);
    }

    const results = await Promise.all(findings.map((f) => persist(f.id)));
    results.forEach((result) => {
      expect(result.outcome).toBe(RISK_CALCULATION_OUTCOME.CREATED);
      expect(result.riskScore.scoreBasisPoints).toBe(2300);
    });

    // eslint-disable-next-line no-restricted-syntax
    for (const finding of findings) {
      // eslint-disable-next-line no-await-in-loop
      const current = await prisma.riskScore.findUnique({
        where: { currentForFindingId: finding.id },
      });
      expect(current).not.toBeNull();
    }
  });

  it("5. supersession never mutates the superseded score, band or contributions", async () => {
    const finding = await makeFinding("16");
    await makeOccurrence(finding.id);
    const first = await persist(finding.id);

    const originalContributions = await prisma.riskFactorContribution.findMany({
      where: { riskScoreId: first.riskScore.id },
      orderBy: { displayOrder: "asc" },
    });

    await makeOccurrence(finding.id, {
      action: "PERSISTED",
      observedAt: new Date(ASOF.getTime() - DAY),
    });
    const second = await persist(finding.id);
    expect(second.riskScore.scoreBasisPoints).toBe(2700);

    const superseded = await prisma.riskScore.findUnique({ where: { id: first.riskScore.id } });
    expect(superseded.currentForFindingId).toBeNull();
    expect(superseded.supersededAt).not.toBeNull();
    expect(superseded.scoreBasisPoints).toBe(2300);
    expect(superseded.riskBand).toBe("LOW");
    expect(superseded.inputFingerprint).toBe(first.riskScore.inputFingerprint);

    const afterContributions = await prisma.riskFactorContribution.findMany({
      where: { riskScoreId: first.riskScore.id },
      orderBy: { displayOrder: "asc" },
    });
    expect(afterContributions).toEqual(originalContributions);
  });

  it("6. refuses to orphan scoring history: Finding and RiskScore are both Restrict", async () => {
    const finding = await makeFinding("17");
    await makeOccurrence(finding.id);
    const result = await persist(finding.id);

    await expect(prisma.finding.delete({ where: { id: finding.id } })).rejects.toMatchObject({
      code: "P2003",
    });
    await expect(
      prisma.riskScore.delete({ where: { id: result.riskScore.id } })
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("7. enforces one contribution per factor per score", async () => {
    const finding = await makeFinding("18");
    await makeOccurrence(finding.id);
    const result = await persist(finding.id);

    await expect(
      prisma.riskFactorContribution.create({
        data: {
          riskScoreId: result.riskScore.id,
          factorKey: "persistence",
          applicability: "APPLIED",
          contributionBasisPoints: 400,
          maximumContributionBasisPoints: 1200,
          explanationCode: "PERSISTENCE_REPEATED",
          displayOrder: 2,
        },
      })
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("8. amendment 3 — a recurrence restarts the unresolved clock in real stored data", async () => {
    const finding = await makeFinding("19", {
      firstSeen: new Date(ASOF.getTime() - 400 * DAY),
      lastSeen: ASOF,
    });
    await makeOccurrence(finding.id, {
      action: "CREATED",
      observedAt: new Date(ASOF.getTime() - 400 * DAY),
    });
    await makeOccurrence(finding.id, {
      action: "RECURRED",
      observedAt: new Date(ASOF.getTime() - 10 * DAY),
    });

    const result = await persist(finding.id);
    const days = result.contributions.find((c) => c.factorKey === "daysUnresolved");
    // 10, not 400: time spent CLOSED between episodes is never scored.
    expect(days.normalizedInputValue).toBe("10");
    expect(days.contributionBasisPoints).toBe(400);

    const recurrence = result.contributions.find((c) => c.factorKey === "recurrence");
    expect(recurrence.contributionBasisPoints).toBe(700);
    // 800 baseline + 1500 exposure + 400 persistence(2) + 700 recurrence + 400 days
    expect(result.riskScore.scoreBasisPoints).toBe(3800);
    expect(result.riskScore.riskBand).toBe("MEDIUM");
  });

  it("9. amendment 3 — a CLOSED finding scores daysUnresolved as NOT_APPLICABLE", async () => {
    const finding = await makeFinding("20", {
      status: "CLOSED",
      firstSeen: new Date(ASOF.getTime() - 300 * DAY),
    });
    await makeOccurrence(finding.id, {
      observedAt: new Date(ASOF.getTime() - 300 * DAY),
    });

    const result = await persist(finding.id);
    const days = result.contributions.find((c) => c.factorKey === "daysUnresolved");
    expect(days.applicability).toBe("NOT_APPLICABLE");
    expect(days.contributionBasisPoints).toBe(0);
    expect(days.explanationCode).toBe("DAYS_UNRESOLVED_NOT_APPLICABLE_CLOSED");
    expect(result.riskScore.scoreBasisPoints).toBe(2300);
  });

  it("10. amendment 2 — a RESOLVED/LOW ownership row does not attribute a sector", async () => {
    const organization = await makeOrganization("low-confidence", "HEALTHCARE");
    const finding = await makeFinding("21");
    await makeOccurrence(finding.id);
    await prisma.findingOwnership.create({
      data: {
        findingId: finding.id,
        currentForFindingId: finding.id,
        organizationId: organization.id,
        status: "RESOLVED",
        confidence: "LOW",
        isIspAttribution: false,
        resolvedAt: ASOF,
        asOf: ASOF,
        reasonCode: "ASN_MATCH",
      },
    });

    const result = await persist(finding.id);
    const sector = result.contributions.find((c) => c.factorKey === "sectorCriticality");
    expect(sector.applicability).toBe("NOT_AVAILABLE");
    expect(sector.contributionBasisPoints).toBe(0);
    expect(sector.explanationCode).toBe("SECTOR_NOT_AVAILABLE_LOW_CONFIDENCE");
    expect(result.riskScore.scoreBasisPoints).toBe(2300);
  });

  it("11. amendment 2 — an OVERRIDDEN ownership row does attribute its sector", async () => {
    const organization = await makeOrganization("overridden", "CRITICAL_NATIONAL_INFRASTRUCTURE");
    const finding = await makeFinding("22");
    await makeOccurrence(finding.id);
    await prisma.findingOwnership.create({
      data: {
        findingId: finding.id,
        currentForFindingId: finding.id,
        organizationId: organization.id,
        status: "OVERRIDDEN",
        confidence: "CONFIRMED",
        isIspAttribution: false,
        resolvedAt: ASOF,
        asOf: ASOF,
        reasonCode: "ANALYST_OVERRIDE",
      },
    });

    const result = await persist(finding.id);
    const sector = result.contributions.find((c) => c.factorKey === "sectorCriticality");
    expect(sector.applicability).toBe("APPLIED");
    expect(sector.contributionBasisPoints).toBe(1300);
    expect(sector.explanationCode).toBe("SECTOR_CNI");
    expect(result.riskScore.scoreBasisPoints).toBe(3600);
    expect(result.riskScore.riskBand).toBe("MEDIUM");
  });

  it("12. amendment 1 — a fresh NOT_FOUND is unavailable, a fresh SUCCESS-0 is clean", async () => {
    const notFoundFinding = await makeFinding("23");
    await makeOccurrence(notFoundFinding.id);
    await prisma.iocEnrichment.create({
      data: {
        provider: "abuseipdb",
        indicatorType: "IPV4",
        indicator: notFoundFinding.indicatorValue,
        cacheKey: `${MARKER}-notfound-${crypto.randomUUID()}`,
        queryParams: { maxAgeInDays: 90 },
        queryParamsHash: "hash",
        status: "NOT_FOUND",
        requestedAt: new Date(ASOF.getTime() - DAY),
        queriedAt: new Date(ASOF.getTime() - DAY),
        expiresAt: new Date(ASOF.getTime() + DAY),
      },
    });

    const notFound = await persist(notFoundFinding.id);
    const notFoundIoc = notFound.contributions.find((c) => c.factorKey === "iocReputationContext");
    expect(notFoundIoc.applicability).toBe("NOT_AVAILABLE");
    expect(notFoundIoc.explanationCode).toBe("IOC_REPUTATION_NOT_FOUND");
    expect(notFoundIoc.normalizedInputValue).toBeNull();

    const cleanFinding = await makeFinding("24");
    await makeOccurrence(cleanFinding.id);
    await prisma.iocEnrichment.create({
      data: {
        provider: "abuseipdb",
        indicatorType: "IPV4",
        indicator: cleanFinding.indicatorValue,
        cacheKey: `${MARKER}-clean-${crypto.randomUUID()}`,
        queryParams: { maxAgeInDays: 90 },
        queryParamsHash: "hash",
        status: "SUCCESS",
        requestedAt: new Date(ASOF.getTime() - DAY),
        queriedAt: new Date(ASOF.getTime() - DAY),
        expiresAt: new Date(ASOF.getTime() + DAY),
        abuseConfidenceScore: 0,
      },
    });

    const clean = await persist(cleanFinding.id);
    const cleanIoc = clean.contributions.find((c) => c.factorKey === "iocReputationContext");
    expect(cleanIoc.applicability).toBe("APPLIED");
    expect(cleanIoc.explanationCode).toBe("IOC_REPUTATION_NONE");
    expect(cleanIoc.normalizedInputValue).toBe("0");

    // Same basis points, deliberately different meaning.
    expect(notFound.riskScore.scoreBasisPoints).toBe(clean.riskScore.scoreBasisPoints);
  });

  it("13. the read service explains a historical score from its own stored rows", async () => {
    const organization = await makeOrganization("history", "GOVERNMENT");
    const finding = await makeFinding("25");
    await makeOccurrence(finding.id);

    const before = await persist(finding.id);
    expect(before.riskScore.scoreBasisPoints).toBe(2300);

    await prisma.findingOwnership.create({
      data: {
        findingId: finding.id,
        currentForFindingId: finding.id,
        organizationId: organization.id,
        status: "OVERRIDDEN",
        confidence: "CONFIRMED",
        isIspAttribution: false,
        resolvedAt: ASOF,
        asOf: ASOF,
        reasonCode: "ANALYST_OVERRIDE",
      },
    });
    const after = await persist(finding.id);
    expect(after.riskScore.scoreBasisPoints).toBe(3400);

    const context = await getFindingRisk(finding.id, { client: prisma });
    expect(context.current.id).toBe(after.riskScore.id);
    expect(context.history).toHaveLength(2);

    const older = context.history.find((r) => r.id === before.riskScore.id);
    const newer = context.history.find((r) => r.id === after.riskScore.id);
    // The older score still says "no owning organization", even though the
    // Finding now HAS one — it renders from its own rows, never live state.
    expect(
      older.explanation.factors.find((f) => f.factorKey === "sectorCriticality").sentence
    ).toContain("no owning organization has been resolved");
    expect(
      newer.explanation.factors.find((f) => f.factorKey === "sectorCriticality").sentence
    ).toContain("government organization");
  });

  it("14. an identical rescore appends nothing, so replays cannot flood history", async () => {
    const finding = await makeFinding("26");
    await makeOccurrence(finding.id);

    await persist(finding.id);
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const replay = await persist(finding.id, { asOf: new Date(ASOF.getTime() + i * 60000) });
      expect(replay.outcome).toBe(RISK_CALCULATION_OUTCOME.UNCHANGED);
    }

    const all = await prisma.riskScore.findMany({ where: { findingId: finding.id } });
    expect(all).toHaveLength(1);
    const contributions = await prisma.riskFactorContribution.findMany({
      where: { riskScoreId: all[0].id },
    });
    expect(contributions).toHaveLength(FACTOR_DISPLAY_ORDER.length);
  });

  it("15. stores the version identity on every snapshot so an old score stays explicable", async () => {
    const finding = await makeFinding("27");
    await makeOccurrence(finding.id);
    const result = await persist(finding.id);

    const stored = await prisma.riskScore.findUnique({ where: { id: result.riskScore.id } });
    expect(stored.algorithmVersion).toBe("risk-additive-bucketed-v1");
    expect(stored.configurationVersion).toBe("v1.0.0");
    expect(stored.configurationFingerprint).toBe(RISK_CONFIGURATION_FINGERPRINT);
    expect(stored.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.asOf).toEqual(ASOF);
    expect(stored.trigger).toBe("SYSTEM_RECALCULATION");
    expect(stored.actorUserId).toBeNull();
  });
});
