import { describe, it, expect } from "vitest";

// P2-T3 — finding risk read service.
//
// SCOPE NOTE: in-memory fake Prisma client, same discipline as
// findingEnrichmentReadService.test.js. Proves selection (current vs history),
// ordering, pagination, the allow-listed serializer and the evidence bound —
// not PostgreSQL semantics.

const {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  FindingRiskValidationError,
  FindingRiskNotFoundError,
  serializeScore,
  safeEvidence,
  getFindingRisk,
} = require("../../src/services/risk/findingRiskReadService");

function createFakeClient() {
  const findings = new Map();
  const riskScores = [];
  const contributions = [];
  let nextScoreId = 1;

  const client = {
    finding: {
      async findUnique({ where: { id } }) {
        return findings.has(id) ? { ...findings.get(id) } : null;
      },
    },
    riskScore: {
      async findUnique({ where }) {
        const row = riskScores.find((r) => r.currentForFindingId === where.currentForFindingId);
        return row ? { ...row } : null;
      },
      async findMany({ where = {}, orderBy = [], skip = 0, take } = {}) {
        let rows = riskScores.filter((r) => r.findingId === where.findingId);
        rows = [...rows].sort((a, b) => {
          for (const clause of orderBy) {
            const [field, dir] = Object.entries(clause)[0];
            const av = a[field] instanceof Date ? a[field].getTime() : a[field] ?? -Infinity;
            const bv = b[field] instanceof Date ? b[field].getTime() : b[field] ?? -Infinity;
            if (av !== bv) return dir === "desc" ? bv - av : av - bv;
          }
          return 0;
        });
        return rows.slice(skip, take ? skip + take : undefined).map((r) => ({ ...r }));
      },
      async count({ where = {} } = {}) {
        return riskScores.filter((r) => r.findingId === where.findingId).length;
      },
    },
    riskFactorContribution: {
      async findMany({ where = {} } = {}) {
        return contributions
          .filter((row) => where.riskScoreId.in.includes(row.riskScoreId))
          .sort(
            (a, b) =>
              a.riskScoreId - b.riskScoreId || a.displayOrder - b.displayOrder || a.id - b.id
          )
          .map((row) => ({ ...row }));
      },
    },
  };

  return {
    client,
    seedFinding(overrides = {}) {
      const row = { id: 1, status: "OPEN", ...overrides };
      findings.set(row.id, row);
      return row;
    },
    seedScore(overrides = {}) {
      const id = overrides.id ?? nextScoreId++;
      const row = {
        id,
        findingId: 1,
        scoreBasisPoints: 2300,
        riskBand: "LOW",
        algorithmVersion: "risk-additive-bucketed-v1",
        configurationVersion: "v1.0.0",
        configurationFingerprint: "c".repeat(64),
        inputFingerprint: "f".repeat(64),
        asOf: new Date("2026-07-01T00:00:00Z"),
        calculatedAt: new Date("2026-07-01T00:00:01Z"),
        trigger: "INGESTION",
        actorUserId: null,
        justification: null,
        currentForFindingId: 1,
        supersededAt: null,
        ...overrides,
        id,
      };
      riskScores.push(row);
      return row;
    },
    seedContribution(riskScoreId, overrides = {}) {
      const row = {
        id: contributions.length + 1,
        riskScoreId,
        factorKey: "sourceSeverity",
        applicability: "APPLIED",
        contributionBasisPoints: 800,
        maximumContributionBasisPoints: 800,
        normalizedInputValue: "ACCESSIBLE_RDP",
        explanationCode: "SOURCE_SEVERITY_ACCESSIBLE_RDP",
        evidenceSnapshot: { reportType: "ACCESSIBLE_RDP" },
        displayOrder: 0,
        ...overrides,
      };
      contributions.push(row);
      return row;
    },
  };
}

describe("validation and lookup", () => {
  it("rejects an invalid findingId", async () => {
    const fake = createFakeClient();
    await expect(getFindingRisk(0, { client: fake.client })).rejects.toBeInstanceOf(
      FindingRiskValidationError
    );
    await expect(getFindingRisk(1.5, { client: fake.client })).rejects.toBeInstanceOf(
      FindingRiskValidationError
    );
  });

  it("throws FindingRiskNotFoundError for an unknown Finding", async () => {
    const fake = createFakeClient();
    await expect(getFindingRisk(999, { client: fake.client })).rejects.toBeInstanceOf(
      FindingRiskNotFoundError
    );
  });

  it("returns a null current score for a Finding that has never been scored", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    const result = await getFindingRisk(1, { client: fake.client });
    expect(result.current).toBeNull();
    expect(result.history).toEqual([]);
    expect(result.pagination.totalItems).toBe(0);
    expect(result.findingStatus).toBe("OPEN");
  });

  it("rejects an invalid page or pageSize", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    await expect(getFindingRisk(1, { client: fake.client, page: 0 })).rejects.toBeInstanceOf(
      FindingRiskValidationError
    );
    await expect(getFindingRisk(1, { client: fake.client, pageSize: -3 })).rejects.toBeInstanceOf(
      FindingRiskValidationError
    );
  });
});

describe("current score and history", () => {
  it("returns the current score with its contributions and rendered explanation", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    const score = fake.seedScore();
    fake.seedContribution(score.id);
    fake.seedContribution(score.id, {
      factorKey: "exposureCriticality",
      displayOrder: 1,
      contributionBasisPoints: 1500,
      maximumContributionBasisPoints: 1500,
      normalizedInputValue: "TCP/3389",
      explanationCode: "EXPOSURE_CRITICALITY_REMOTE_ACCESS_RDP",
      evidenceSnapshot: { protocol: "TCP", port: 3389 },
    });

    const result = await getFindingRisk(1, { client: fake.client });
    expect(result.current.scoreBasisPoints).toBe(2300);
    expect(result.current.displayScore).toBe(23);
    expect(result.current.riskBand).toBe("LOW");
    expect(result.current.isCurrent).toBe(true);
    expect(result.current.contributions).toHaveLength(2);
    expect(result.current.explanation.factors[0].sentence).toBe(
      "Reported by the source as an Accessible RDP exposure."
    );
  });

  it("marks a superseded row as not current and keeps it in history", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedScore({
      id: 1,
      currentForFindingId: null,
      supersededAt: new Date("2026-07-02T00:00:00Z"),
      calculatedAt: new Date("2026-07-01T00:00:01Z"),
    });
    fake.seedScore({
      id: 2,
      scoreBasisPoints: 2700,
      calculatedAt: new Date("2026-07-02T00:00:01Z"),
    });

    const result = await getFindingRisk(1, { client: fake.client });
    expect(result.current.id).toBe(2);
    expect(result.history.map((r) => r.id)).toEqual([2, 1]);
    expect(result.history[1].isCurrent).toBe(false);
    expect(result.history[1].supersededAt).toEqual(new Date("2026-07-02T00:00:00Z"));
  });

  it("orders history newest-calculated-first, tie-broken by highest id", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    const sameInstant = new Date("2026-07-01T00:00:01Z");
    fake.seedScore({ id: 1, currentForFindingId: null, calculatedAt: sameInstant });
    fake.seedScore({ id: 2, currentForFindingId: null, calculatedAt: sameInstant });
    fake.seedScore({ id: 3, calculatedAt: sameInstant });

    const result = await getFindingRisk(1, { client: fake.client });
    expect(result.history.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it("paginates history and bounds pageSize at the documented maximum", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    for (let i = 1; i <= 5; i += 1) {
      fake.seedScore({
        id: i,
        currentForFindingId: i === 5 ? 1 : null,
        calculatedAt: new Date(`2026-07-0${i}T00:00:00Z`),
      });
    }

    const page1 = await getFindingRisk(1, { client: fake.client, page: 1, pageSize: 2 });
    expect(page1.history.map((r) => r.id)).toEqual([5, 4]);
    expect(page1.pagination).toEqual({ page: 1, pageSize: 2, totalItems: 5, totalPages: 3 });

    const page3 = await getFindingRisk(1, { client: fake.client, page: 3, pageSize: 2 });
    expect(page3.history.map((r) => r.id)).toEqual([1]);

    const capped = await getFindingRisk(1, { client: fake.client, pageSize: 5000 });
    expect(capped.pagination.pageSize).toBe(MAX_PAGE_SIZE);
  });

  it("defaults to a bounded page size", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedScore();
    const result = await getFindingRisk(1, { client: fake.client });
    expect(result.pagination.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it("skips the history query entirely when includeHistory is false", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedScore();
    const result = await getFindingRisk(1, { client: fake.client, includeHistory: false });
    expect(result.history).toEqual([]);
    expect(result.pagination).toBeNull();
    expect(result.current).not.toBeNull();
  });

  it("explains a historical score from its OWN stored rows, not the current ones", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedScore({
      id: 1,
      currentForFindingId: null,
      scoreBasisPoints: 2300,
      calculatedAt: new Date("2026-07-01T00:00:00Z"),
    });
    fake.seedScore({
      id: 2,
      scoreBasisPoints: 3600,
      riskBand: "MEDIUM",
      calculatedAt: new Date("2026-07-02T00:00:00Z"),
    });
    fake.seedContribution(1, {
      factorKey: "sectorCriticality",
      displayOrder: 6,
      applicability: "NOT_AVAILABLE",
      contributionBasisPoints: 0,
      maximumContributionBasisPoints: 1300,
      normalizedInputValue: null,
      explanationCode: "SECTOR_NOT_AVAILABLE_NO_OWNERSHIP",
      evidenceSnapshot: null,
    });
    fake.seedContribution(2, {
      factorKey: "sectorCriticality",
      displayOrder: 6,
      contributionBasisPoints: 1300,
      maximumContributionBasisPoints: 1300,
      normalizedInputValue: "CRITICAL_NATIONAL_INFRASTRUCTURE",
      explanationCode: "SECTOR_CNI",
      evidenceSnapshot: { sector: "CRITICAL_NATIONAL_INFRASTRUCTURE" },
    });

    const result = await getFindingRisk(1, { client: fake.client });
    const older = result.history.find((r) => r.id === 1);
    const newer = result.history.find((r) => r.id === 2);
    expect(older.explanation.factors[0].sentence).toContain("no owning organization has been resolved");
    expect(newer.explanation.factors[0].sentence).toContain("critical national infrastructure");
  });
});

describe("serializer allow-list", () => {
  it("exposes exactly the intended score fields", () => {
    const serialized = serializeScore(
      {
        id: 1,
        findingId: 1,
        scoreBasisPoints: 2300,
        riskBand: "LOW",
        algorithmVersion: "risk-additive-bucketed-v1",
        configurationVersion: "v1.0.0",
        configurationFingerprint: "c".repeat(64),
        inputFingerprint: "f".repeat(64),
        asOf: new Date("2026-07-01T00:00:00Z"),
        calculatedAt: new Date("2026-07-01T00:00:01Z"),
        trigger: "INGESTION",
        supersededAt: null,
        currentForFindingId: 1,
        justification: null,
        // Fields a raw row dump would leak:
        actorUserId: 42,
        createdAt: new Date("2026-07-01T00:00:01Z"),
      },
      []
    );
    expect(Object.keys(serialized).sort()).toEqual(
      [
        "id",
        "findingId",
        "scoreBasisPoints",
        "displayScore",
        "riskBand",
        "algorithmVersion",
        "configurationVersion",
        "configurationFingerprint",
        "inputFingerprint",
        "asOf",
        "calculatedAt",
        "trigger",
        "supersededAt",
        "isCurrent",
        "justification",
        "contributions",
        "explanation",
      ].sort()
    );
    // actorUserId is deliberately NOT exposed: who ran a recalculation is
    // audit-log information, not part of a finding's risk read surface.
    expect(serialized).not.toHaveProperty("actorUserId");
  });

  it("returns null for a null score row", () => {
    expect(serializeScore(null, [])).toBeNull();
  });

  it("derives displayScore rather than trusting a stored value", () => {
    const serialized = serializeScore({ scoreBasisPoints: 8543, riskBand: "CRITICAL" }, []);
    expect(serialized.displayScore).toBe(85);
  });
});

describe("safeEvidence", () => {
  it("passes bounded scalars through", () => {
    expect(safeEvidence({ observationCount: 6, sector: "FINANCE", flag: true })).toEqual({
      observationCount: 6,
      sector: "FINANCE",
      flag: true,
    });
  });

  it("drops nested objects, arrays and nulls rather than forwarding them", () => {
    expect(
      safeEvidence({ ok: 1, nested: { a: 1 }, list: [1, 2], nothing: null })
    ).toEqual({ ok: 1 });
  });

  it("truncates a long string and bounds the key count", () => {
    const long = "x".repeat(500);
    expect(safeEvidence({ value: long }).value).toHaveLength(64);

    const many = {};
    for (let i = 0; i < 30; i += 1) many[`k${i}`] = i;
    expect(Object.keys(safeEvidence(many))).toHaveLength(8);
  });

  it("returns null for a non-object, an array, or an empty result", () => {
    expect(safeEvidence(null)).toBeNull();
    expect(safeEvidence("string")).toBeNull();
    expect(safeEvidence([1, 2])).toBeNull();
    expect(safeEvidence({ nested: { a: 1 } })).toBeNull();
  });

  it("bounds a malformed legacy evidence blob rather than emitting it whole", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    const score = fake.seedScore();
    fake.seedContribution(score.id, {
      evidenceSnapshot: {
        secret: "SECRET-CLAIM-TOKEN-SHOULD-BE-TRUNCATED-BUT-STILL-VISIBLE-AS-PREFIX-ONLY-XYZ",
        raw: { provider: "payload" },
      },
    });

    const result = await getFindingRisk(1, { client: fake.client });
    const evidence = result.current.contributions[0].evidenceSummary;
    expect(evidence.raw).toBeUndefined();
    expect(evidence.secret).toHaveLength(64);
  });
});
