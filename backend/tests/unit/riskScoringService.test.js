import { describe, it, expect, vi } from "vitest";

// P2-T3 — append-only risk scoring persistence.
//
// SCOPE NOTE: in-memory fake Prisma client. These prove the service's decision
// logic — CREATED vs UNCHANGED, supersession, append-only history, retry
// classification, input bounding. Real SERIALIZABLE semantics and the
// currentForFindingId unique race are proven against real PostgreSQL in
// tests/integration/riskScoringConcurrency.test.js.

const {
  RISK_CALCULATION_OUTCOME,
  RISK_TRIGGERS,
  RISK_TRIGGER_VALUES,
  RiskScoringValidationError,
  MAX_JUSTIFICATION_LENGTH,
  MAX_TRANSACTION_ATTEMPTS,
  representsSameInputState,
  calculateAndPersistRisk,
} = require("../../src/services/risk/riskScoringService");
const { FACTOR_DISPLAY_ORDER } = require("../../src/services/risk/riskConfiguration");

const ASOF = new Date("2026-07-01T00:00:00Z");
const DAY = 86400000;

function prismaError(code) {
  const error = new Error(`Prisma error ${code}`);
  error.code = code;
  return error;
}

function createFakeClient() {
  const state = {
    findings: new Map(),
    occurrences: [],
    ownerships: new Map(),
    organizations: new Map(),
    iocEnrichments: [],
    riskScores: [],
    contributions: [],
    transactionOptions: [],
    nextScoreId: 1,
    nextContributionId: 1,
  };

  const tx = {
    finding: {
      async findUnique({ where: { id } }) {
        return state.findings.has(id) ? { ...state.findings.get(id) } : null;
      },
    },
    findingOccurrence: {
      async findMany({ where = {} } = {}) {
        return state.occurrences
          .filter((row) => row.findingId === where.findingId)
          .filter((row) => (where.observedAt ? row.observedAt <= where.observedAt.lte : true))
          .map((row) => ({ ...row }));
      },
    },
    findingOwnership: {
      async findUnique({ where }) {
        const row = state.ownerships.get(where.currentForFindingId);
        return row ? { ...row } : null;
      },
    },
    organization: {
      async findUnique({ where: { id } }) {
        const row = state.organizations.get(id);
        return row ? { ...row } : null;
      },
    },
    iocEnrichment: {
      async findMany() {
        return [];
      },
    },
    // §2B Packet A: these cases exercise supersession, SERIALIZABLE retry and
    // fingerprint identity, none of which involve CVE evidence — so no
    // association exists and all three vulnerability factors stay
    // NOT_APPLICABLE.
    findingVulnerability: {
      async findMany() {
        return [];
      },
    },
    vulnerabilityProviderResult: {
      async findFirst() {
        return null;
      },
    },
    riskScore: {
      async findUnique({ where }) {
        const row = state.riskScores.find((r) => r.currentForFindingId === where.currentForFindingId);
        return row ? { ...row } : null;
      },
      async update({ where, data }) {
        const row = state.riskScores.find((r) => r.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
      async create({ data }) {
        const row = {
          id: state.nextScoreId++,
          calculatedAt: new Date(),
          createdAt: new Date(),
          supersededAt: null,
          ...data,
        };
        state.riskScores.push(row);
        return { ...row };
      },
    },
    riskFactorContribution: {
      async createMany({ data }) {
        data.forEach((row) => {
          state.contributions.push({ id: state.nextContributionId++, ...row });
        });
        return { count: data.length };
      },
      async findMany({ where = {}, orderBy = [] } = {}) {
        const rows = state.contributions.filter((row) => row.riskScoreId === where.riskScoreId);
        return [...rows]
          .sort((a, b) => a.displayOrder - b.displayOrder || a.id - b.id)
          .map((row) => ({ ...row }));
      },
    },
  };

  const client = {
    async $transaction(fn, options) {
      state.transactionOptions.push(options);
      return fn(tx);
    },
  };

  return {
    state,
    client,
    tx,
    seedBaselineFinding(overrides = {}) {
      const row = {
        id: 1,
        indicatorValue: "203.0.113.10",
        port: 3389,
        protocol: "TCP",
        reportType: "ACCESSIBLE_RDP",
        status: "OPEN",
        firstSeen: new Date(ASOF.getTime() - 3 * DAY),
        lastSeen: ASOF,
        ...overrides,
      };
      state.findings.set(row.id, row);
      state.occurrences.push({
        id: state.occurrences.length + 1,
        findingId: row.id,
        action: "CREATED",
        observedAt: row.firstSeen,
      });
      return row;
    },
  };
}

async function persist(fake, overrides = {}) {
  return calculateAndPersistRisk({
    findingId: 1,
    asOf: ASOF,
    trigger: RISK_TRIGGERS.INGESTION,
    client: fake.client,
    ...overrides,
  });
}

describe("input validation", () => {
  it("rejects an invalid findingId, asOf or trigger before touching the database", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();

    await expect(persist(fake, { findingId: 0 })).rejects.toBeInstanceOf(RiskScoringValidationError);
    await expect(persist(fake, { asOf: "2026-07-01" })).rejects.toBeInstanceOf(
      RiskScoringValidationError
    );
    await expect(persist(fake, { trigger: "SOMETHING_ELSE" })).rejects.toBeInstanceOf(
      RiskScoringValidationError
    );
    expect(fake.state.riskScores).toHaveLength(0);
  });

  it("accepts every approved trigger and nothing else", async () => {
    expect([...RISK_TRIGGER_VALUES].sort()).toEqual(
      ["INGESTION", "ENRICHMENT_COMPLETED", "OWNERSHIP_CHANGED", "MANUAL", "SYSTEM_RECALCULATION"].sort()
    );
  });

  it("trims a justification, treats blank as null, and rejects an over-long one", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();

    const trimmed = await persist(fake, {
      trigger: RISK_TRIGGERS.MANUAL,
      justification: "  reviewed after ticket 42  ",
    });
    expect(trimmed.riskScore.justification).toBe("reviewed after ticket 42");

    await expect(
      persist(fake, { trigger: RISK_TRIGGERS.MANUAL, justification: "x".repeat(MAX_JUSTIFICATION_LENGTH + 1) })
    ).rejects.toBeInstanceOf(RiskScoringValidationError);

    await expect(persist(fake, { justification: 42 })).rejects.toBeInstanceOf(
      RiskScoringValidationError
    );
  });

  it("rejects a malformed actorUserId rather than storing a bad attribution", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();
    await expect(persist(fake, { actorUserId: 0 })).rejects.toBeInstanceOf(RiskScoringValidationError);
    await expect(persist(fake, { actorUserId: "7" })).rejects.toBeInstanceOf(
      RiskScoringValidationError
    );
  });
});

describe("first calculation", () => {
  it("creates one score row plus one contribution per approved factor", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();

    const result = await persist(fake);
    expect(result.outcome).toBe(RISK_CALCULATION_OUTCOME.CREATED);
    expect(fake.state.riskScores).toHaveLength(1);
    expect(result.contributions).toHaveLength(FACTOR_DISPLAY_ORDER.length);
    expect(result.contributions.map((c) => c.factorKey)).toEqual([...FACTOR_DISPLAY_ORDER]);
  });

  it("stores the baseline score, band and full version identity", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();

    const result = await persist(fake);
    expect(result.riskScore.scoreBasisPoints).toBe(2300);
    expect(result.riskScore.riskBand).toBe("LOW");
    expect(result.riskScore.algorithmVersion).toBe("risk-additive-bucketed-v1");
    expect(result.riskScore.configurationVersion).toBe("v1.0.0");
    expect(result.riskScore.configurationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.riskScore.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks the new row current and stores the supplied asOf and trigger", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();

    const result = await persist(fake, { trigger: RISK_TRIGGERS.ENRICHMENT_COMPLETED });
    expect(result.riskScore.currentForFindingId).toBe(1);
    expect(result.riskScore.supersededAt).toBeNull();
    expect(result.riskScore.asOf).toBe(ASOF);
    expect(result.riskScore.trigger).toBe("ENRICHMENT_COMPLETED");
  });

  it("leaves actorUserId null for an automatic trigger", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();
    const result = await persist(fake);
    expect(result.riskScore.actorUserId).toBeNull();
    expect(result.riskScore.justification).toBeNull();
  });

  it("records the actor only for a MANUAL recalculation", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();
    const result = await persist(fake, {
      trigger: RISK_TRIGGERS.MANUAL,
      actorUserId: 7,
      justification: "analyst review",
    });
    expect(result.riskScore.actorUserId).toBe(7);
    expect(result.riskScore.trigger).toBe("MANUAL");
  });

  it("runs the whole load/calculate/persist cycle at SERIALIZABLE isolation", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();
    await persist(fake);
    expect(fake.state.transactionOptions[0]).toEqual({ isolationLevel: "Serializable" });
  });
});

describe("idempotent rescoring", () => {
  it("returns UNCHANGED and appends nothing when the input state is identical", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();

    const first = await persist(fake);
    const second = await persist(fake);

    expect(first.outcome).toBe(RISK_CALCULATION_OUTCOME.CREATED);
    expect(second.outcome).toBe(RISK_CALCULATION_OUTCOME.UNCHANGED);
    expect(fake.state.riskScores).toHaveLength(1);
    expect(fake.state.contributions).toHaveLength(FACTOR_DISPLAY_ORDER.length);
    expect(second.riskScore.id).toBe(first.riskScore.id);
  });

  it("still returns the stored contributions on an UNCHANGED result", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();
    await persist(fake);
    const second = await persist(fake);
    expect(second.contributions).toHaveLength(FACTOR_DISPLAY_ORDER.length);
  });

  it("returns UNCHANGED even when asOf moves, as long as no scored input changed", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();
    await persist(fake);
    const later = await persist(fake, { asOf: new Date(ASOF.getTime() + 3600000) });
    expect(later.outcome).toBe(RISK_CALCULATION_OUTCOME.UNCHANGED);
    expect(fake.state.riskScores).toHaveLength(1);
  });
});

describe("supersession and append-only history", () => {
  it("appends a new current row and supersedes the previous one when inputs change", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();
    const first = await persist(fake);

    // A second accepted report observation: persistence moves 1 -> 2 (+400).
    fake.state.occurrences.push({
      id: 2,
      findingId: 1,
      action: "PERSISTED",
      observedAt: new Date(ASOF.getTime() - DAY),
    });

    const second = await persist(fake);
    expect(second.outcome).toBe(RISK_CALCULATION_OUTCOME.CREATED);
    expect(second.riskScore.scoreBasisPoints).toBe(2700);
    expect(fake.state.riskScores).toHaveLength(2);

    const superseded = fake.state.riskScores.find((r) => r.id === first.riskScore.id);
    expect(superseded.currentForFindingId).toBeNull();
    expect(superseded.supersededAt).toBe(ASOF);
    expect(second.riskScore.currentForFindingId).toBe(1);
  });

  it("never edits a superseded row's score, band or contributions", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();
    const first = await persist(fake);
    const originalScore = first.riskScore.scoreBasisPoints;
    const originalBand = first.riskScore.riskBand;
    const originalContributions = fake.state.contributions
      .filter((c) => c.riskScoreId === first.riskScore.id)
      .map((c) => ({ ...c }));

    fake.state.occurrences.push({
      id: 2,
      findingId: 1,
      action: "PERSISTED",
      observedAt: new Date(ASOF.getTime() - DAY),
    });
    await persist(fake);

    const superseded = fake.state.riskScores.find((r) => r.id === first.riskScore.id);
    expect(superseded.scoreBasisPoints).toBe(originalScore);
    expect(superseded.riskBand).toBe(originalBand);
    expect(
      fake.state.contributions.filter((c) => c.riskScoreId === first.riskScore.id)
    ).toEqual(originalContributions);
  });

  it("keeps exactly one current row per Finding across several rescorings", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();
    await persist(fake);
    for (let i = 2; i <= 4; i += 1) {
      fake.state.occurrences.push({
        id: i,
        findingId: 1,
        action: "PERSISTED",
        observedAt: new Date(ASOF.getTime() - i * 3600000),
      });
      // eslint-disable-next-line no-await-in-loop
      await persist(fake);
    }
    const current = fake.state.riskScores.filter((r) => r.currentForFindingId === 1);
    expect(current).toHaveLength(1);
    expect(fake.state.riskScores).toHaveLength(4);
  });

  it("writes a complete contribution set for every appended snapshot", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();
    await persist(fake);
    fake.state.occurrences.push({
      id: 2,
      findingId: 1,
      action: "PERSISTED",
      observedAt: new Date(ASOF.getTime() - DAY),
    });
    await persist(fake);

    fake.state.riskScores.forEach((scoreRow) => {
      const rows = fake.state.contributions.filter((c) => c.riskScoreId === scoreRow.id);
      expect(rows).toHaveLength(FACTOR_DISPLAY_ORDER.length);
    });
  });
});

describe("representsSameInputState", () => {
  const calculation = {
    inputFingerprint: "fp",
    configurationVersion: "v1.0.0",
    algorithmVersion: "risk-additive-bucketed-v1",
  };

  it("is false when there is no current row", () => {
    expect(representsSameInputState(null, calculation)).toBe(false);
  });

  it("is true only when fingerprint, configuration version and algorithm version all match", () => {
    expect(representsSameInputState({ ...calculation }, calculation)).toBe(true);
    expect(representsSameInputState({ ...calculation, inputFingerprint: "other" }, calculation)).toBe(
      false
    );
    expect(
      representsSameInputState({ ...calculation, configurationVersion: "v1.1.0" }, calculation)
    ).toBe(false);
    expect(
      representsSameInputState({ ...calculation, algorithmVersion: "risk-v2" }, calculation)
    ).toBe(false);
  });
});

describe("concurrency retry", () => {
  it("re-runs the whole transaction on a P2002 unique race and succeeds", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();

    const realTransaction = fake.client.$transaction.bind(fake.client);
    let attempts = 0;
    fake.client.$transaction = async (fn, options) => {
      attempts += 1;
      if (attempts === 1) throw prismaError("P2002");
      return realTransaction(fn, options);
    };

    const result = await persist(fake);
    expect(attempts).toBe(2);
    expect(result.outcome).toBe(RISK_CALCULATION_OUTCOME.CREATED);
    expect(fake.state.riskScores).toHaveLength(1);
  });

  it("re-runs on a P2034 write conflict too", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();

    const realTransaction = fake.client.$transaction.bind(fake.client);
    let attempts = 0;
    fake.client.$transaction = async (fn, options) => {
      attempts += 1;
      if (attempts <= 2) throw prismaError("P2034");
      return realTransaction(fn, options);
    };

    const result = await persist(fake);
    expect(attempts).toBe(3);
    expect(result.outcome).toBe(RISK_CALCULATION_OUTCOME.CREATED);
  });

  it("gives up after the bounded attempt limit rather than retrying forever", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();

    let attempts = 0;
    fake.client.$transaction = async () => {
      attempts += 1;
      throw prismaError("P2034");
    };

    await expect(persist(fake)).rejects.toMatchObject({ code: "P2034" });
    expect(attempts).toBe(MAX_TRANSACTION_ATTEMPTS);
  });

  it("never retries a non-concurrency error", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding();

    let attempts = 0;
    fake.client.$transaction = async () => {
      attempts += 1;
      throw prismaError("P2003");
    };

    await expect(persist(fake)).rejects.toMatchObject({ code: "P2003" });
    expect(attempts).toBe(1);
  });

  it("propagates a missing Finding rather than persisting an empty score", async () => {
    const fake = createFakeClient();
    await expect(persist(fake)).rejects.toMatchObject({ name: "RiskFindingNotFoundError" });
    expect(fake.state.riskScores).toHaveLength(0);
  });
});

describe("no network, no clock inside scoring", () => {
  it("never reads the wall clock — every duration comes from the supplied asOf", async () => {
    const fake = createFakeClient();
    fake.seedBaselineFinding({ firstSeen: new Date(ASOF.getTime() - 45 * DAY) });
    fake.state.occurrences[0].observedAt = new Date(ASOF.getTime() - 45 * DAY);

    // Freeze "now" far away from asOf: the stored score must reflect asOf.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2030-01-01T00:00:00Z").getTime());
    try {
      const result = await persist(fake);
      const days = result.contributions.find((c) => c.factorKey === "daysUnresolved");
      expect(days.normalizedInputValue).toBe("45");
      expect(days.contributionBasisPoints).toBe(800);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
