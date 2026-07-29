import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// P2-T3 — safe automatic rescoring at state-change boundaries.
//
// The two guarantees under test:
//   1. FAILURE ISOLATION — nothing here ever throws into an ingestion,
//      enrichment or ownership caller, and an exception message never escapes
//      as anything but a closed failure code.
//   2. BOUNDED AUDIT — one aggregate event per operation, counts only, never
//      one event per factor or per finding.

const {
  AUDIT_ACTIONS,
  AUDIT_BATCH_ENTITY_TYPE,
  RISK_FAILURE_CODE,
  MAX_FINDINGS_PER_TRIGGER,
  classifyFailure,
  recalculateFindingRisk,
  recalculateFindingRiskBatch,
  recalculateAfterIngestion,
  recalculateAfterEnrichment,
  recalculateAfterOwnershipChange,
} = require("../../src/services/risk/riskRecalculationService");

const ASOF = new Date("2026-07-01T00:00:00Z");
const DAY = 86400000;

function createFakeClient({ failOnFindingIds = [], throwFrom = null } = {}) {
  const state = {
    findings: new Map(),
    occurrences: [],
    riskScores: [],
    contributions: [],
    auditLogs: [],
    nextScoreId: 1,
    nextContributionId: 1,
  };

  const tx = {
    finding: {
      async findUnique({ where: { id } }) {
        if (throwFrom === "finding") {
          const error = new Error("connection reset");
          error.code = "P1001";
          throw error;
        }
        return state.findings.has(id) ? { ...state.findings.get(id) } : null;
      },
    },
    findingOccurrence: {
      async findMany({ where = {} } = {}) {
        return state.occurrences
          .filter((row) => row.findingId === where.findingId)
          .map((row) => ({ ...row }));
      },
    },
    findingOwnership: { async findUnique() { return null; } },
    organization: { async findUnique() { return null; } },
    iocEnrichment: { async findMany() { return []; } },
    riskScore: {
      async findUnique({ where }) {
        const row = state.riskScores.find(
          (r) => r.currentForFindingId === where.currentForFindingId
        );
        return row ? { ...row } : null;
      },
      async update({ where, data }) {
        const row = state.riskScores.find((r) => r.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
      async create({ data }) {
        if (failOnFindingIds.includes(data.findingId)) {
          const error = new Error("write failed");
          error.code = "P2003";
          throw error;
        }
        const row = { id: state.nextScoreId++, calculatedAt: new Date(), supersededAt: null, ...data };
        state.riskScores.push(row);
        return { ...row };
      },
    },
    riskFactorContribution: {
      async createMany({ data }) {
        data.forEach((row) => state.contributions.push({ id: state.nextContributionId++, ...row }));
        return { count: data.length };
      },
      async findMany({ where = {} } = {}) {
        return state.contributions
          .filter((row) => row.riskScoreId === where.riskScoreId)
          .sort((a, b) => a.displayOrder - b.displayOrder)
          .map((row) => ({ ...row }));
      },
    },
    auditLog: {
      async create({ data }) {
        const row = { id: state.auditLogs.length + 1, ...data };
        state.auditLogs.push(row);
        return row;
      },
    },
  };

  const client = {
    ...tx,
    async $transaction(fn) {
      return fn(tx);
    },
  };

  return {
    state,
    client,
    seedFinding(id, overrides = {}) {
      const row = {
        id,
        indicatorValue: `203.0.113.${id}`,
        port: 3389,
        protocol: "TCP",
        reportType: "ACCESSIBLE_RDP",
        status: "OPEN",
        firstSeen: new Date(ASOF.getTime() - 3 * DAY),
        lastSeen: ASOF,
        ...overrides,
      };
      state.findings.set(id, row);
      state.occurrences.push({
        id: state.occurrences.length + 1,
        findingId: id,
        action: "CREATED",
        observedAt: row.firstSeen,
      });
      return row;
    },
  };
}

let errorSpy;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
});

describe("classifyFailure — a closed failure vocabulary", () => {
  it("maps each recognised error onto its code", () => {
    expect(classifyFailure({ name: "RiskFindingNotFoundError" })).toBe(
      RISK_FAILURE_CODE.FINDING_NOT_FOUND
    );
    expect(classifyFailure({ name: "RiskScoringValidationError" })).toBe(
      RISK_FAILURE_CODE.VALIDATION_ERROR
    );
    expect(classifyFailure({ name: "RiskInputValidationError" })).toBe(
      RISK_FAILURE_CODE.VALIDATION_ERROR
    );
  });

  it("falls back to PERSISTENCE_ERROR for anything else, including a bare value", () => {
    expect(classifyFailure(new Error("boom"))).toBe(RISK_FAILURE_CODE.PERSISTENCE_ERROR);
    expect(classifyFailure(null)).toBe(RISK_FAILURE_CODE.PERSISTENCE_ERROR);
    expect(classifyFailure("string")).toBe(RISK_FAILURE_CODE.PERSISTENCE_ERROR);
  });
});

describe("recalculateFindingRisk — single finding", () => {
  it("scores the finding and emits exactly one completed audit event", async () => {
    const fake = createFakeClient();
    fake.seedFinding(1);

    const result = await recalculateFindingRisk({
      findingId: 1,
      asOf: ASOF,
      trigger: "SYSTEM_RECALCULATION",
      client: fake.client,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("CREATED");
    expect(result.riskScore.scoreBasisPoints).toBe(2300);
    expect(fake.state.auditLogs).toHaveLength(1);
    expect(fake.state.auditLogs[0].action).toBe(AUDIT_ACTIONS.COMPLETED);
    expect(fake.state.auditLogs[0].entityType).toBe("Finding");
    // AuditLog.entityId is a String column; auditService normalizes it.
    expect(fake.state.auditLogs[0].entityId).toBe("1");
  });

  it("uses the unchanged action when nothing about the finding changed", async () => {
    const fake = createFakeClient();
    fake.seedFinding(1);
    const params = { findingId: 1, asOf: ASOF, trigger: "SYSTEM_RECALCULATION", client: fake.client };

    await recalculateFindingRisk(params);
    await recalculateFindingRisk(params);

    expect(fake.state.riskScores).toHaveLength(1);
    expect(fake.state.auditLogs.map((e) => e.action)).toEqual([
      AUDIT_ACTIONS.COMPLETED,
      AUDIT_ACTIONS.UNCHANGED,
    ]);
  });

  it("emits one audit event per calculation, never one per factor", async () => {
    const fake = createFakeClient();
    fake.seedFinding(1);
    await recalculateFindingRisk({
      findingId: 1,
      asOf: ASOF,
      trigger: "INGESTION",
      client: fake.client,
    });
    // Ten factor contributions were written, but only one audit event.
    expect(fake.state.contributions).toHaveLength(10);
    expect(fake.state.auditLogs).toHaveLength(1);
  });

  it("never throws for a missing Finding — it returns a closed failure code", async () => {
    const fake = createFakeClient();

    const result = await recalculateFindingRisk({
      findingId: 999,
      asOf: ASOF,
      trigger: "OWNERSHIP_CHANGED",
      client: fake.client,
    });

    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe(RISK_FAILURE_CODE.FINDING_NOT_FOUND);
    expect(result.riskScore).toBeNull();
    expect(result.contributions).toEqual([]);
  });

  it("never throws for a validation error or a persistence error", async () => {
    const fake = createFakeClient({ failOnFindingIds: [1] });
    fake.seedFinding(1);

    const invalid = await recalculateFindingRisk({
      findingId: -1,
      asOf: ASOF,
      trigger: "MANUAL",
      client: fake.client,
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.failureCode).toBe(RISK_FAILURE_CODE.VALIDATION_ERROR);

    const persistence = await recalculateFindingRisk({
      findingId: 1,
      asOf: ASOF,
      trigger: "MANUAL",
      client: fake.client,
    });
    expect(persistence.ok).toBe(false);
    expect(persistence.failureCode).toBe(RISK_FAILURE_CODE.PERSISTENCE_ERROR);
  });

  it("records only the failure code in the audit payload — never the exception text", async () => {
    const fake = createFakeClient({ failOnFindingIds: [1] });
    fake.seedFinding(1);

    await recalculateFindingRisk({
      findingId: 1,
      asOf: ASOF,
      trigger: "INGESTION",
      client: fake.client,
    });

    const event = fake.state.auditLogs.at(-1);
    expect(event.action).toBe(AUDIT_ACTIONS.FAILED);
    expect(event.outcome).toBe("FAILURE");
    expect(event.after).toEqual({ trigger: "INGESTION", failureCode: "PERSISTENCE_ERROR" });
    expect(JSON.stringify(event)).not.toContain("write failed");
  });

  it("suppresses its own audit event when the caller asked for an aggregate one", async () => {
    const fake = createFakeClient();
    fake.seedFinding(1);

    await recalculateFindingRisk({
      findingId: 1,
      asOf: ASOF,
      trigger: "INGESTION",
      client: fake.client,
      emitAudit: false,
    });

    expect(fake.state.riskScores).toHaveLength(1);
    expect(fake.state.auditLogs).toHaveLength(0);
  });

  it("still returns a result when the audit write itself fails", async () => {
    const fake = createFakeClient();
    fake.seedFinding(1);
    fake.client.auditLog.create = async () => {
      throw new Error("audit table unavailable");
    };

    const result = await recalculateFindingRisk({
      findingId: 1,
      asOf: ASOF,
      trigger: "INGESTION",
      client: fake.client,
    });

    expect(result.ok).toBe(true);
    expect(fake.state.riskScores).toHaveLength(1);
  });
});

describe("recalculateFindingRiskBatch — bounded and aggregate-audited", () => {
  it("processes each distinct finding once and emits ONE aggregate event", async () => {
    const fake = createFakeClient();
    [1, 2, 3].forEach((id) => fake.seedFinding(id));

    const summary = await recalculateFindingRiskBatch({
      findingIds: [3, 1, 2, 1, 2],
      asOf: ASOF,
      trigger: "INGESTION",
      client: fake.client,
    });

    expect(summary).toEqual({
      requestedCount: 3,
      processedCount: 3,
      createdCount: 3,
      unchangedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });
    expect(fake.state.riskScores).toHaveLength(3);
    expect(fake.state.auditLogs).toHaveLength(1);
  });

  it("counts unchanged results separately on a replay", async () => {
    const fake = createFakeClient();
    [1, 2].forEach((id) => fake.seedFinding(id));
    const params = { findingIds: [1, 2], asOf: ASOF, trigger: "INGESTION", client: fake.client };

    await recalculateFindingRiskBatch(params);
    const replay = await recalculateFindingRiskBatch(params);

    expect(replay.createdCount).toBe(0);
    expect(replay.unchangedCount).toBe(2);
    expect(fake.state.riskScores).toHaveLength(2);
  });

  it("keeps scoring the rest of the batch when one finding fails", async () => {
    const fake = createFakeClient({ failOnFindingIds: [2] });
    [1, 2, 3].forEach((id) => fake.seedFinding(id));

    const summary = await recalculateFindingRiskBatch({
      findingIds: [1, 2, 3],
      asOf: ASOF,
      trigger: "INGESTION",
      client: fake.client,
    });

    expect(summary.createdCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.processedCount).toBe(3);
  });

  it("marks the aggregate event FAILURE when any finding failed", async () => {
    const fake = createFakeClient({ failOnFindingIds: [1] });
    fake.seedFinding(1);

    await recalculateFindingRiskBatch({
      findingIds: [1],
      asOf: ASOF,
      trigger: "INGESTION",
      client: fake.client,
      completedAction: "risk.test.completed",
      failedAction: "risk.test.failed",
    });

    const event = fake.state.auditLogs.at(-1);
    expect(event.action).toBe("risk.test.failed");
    expect(event.outcome).toBe("FAILURE");
  });

  it("carries counts only — never an indicator or a finding id list", async () => {
    const fake = createFakeClient();
    fake.seedFinding(1, { indicatorValue: "203.0.113.77" });

    await recalculateFindingRiskBatch({
      findingIds: [1],
      asOf: ASOF,
      trigger: "INGESTION",
      client: fake.client,
    });

    const event = fake.state.auditLogs.at(-1);
    expect(event.after).toEqual({
      trigger: "INGESTION",
      requestedCount: 1,
      processedCount: 1,
      createdCount: 1,
      unchangedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });
    expect(JSON.stringify(event)).not.toContain("203.0.113.77");
  });

  it("bounds the batch and reports the remainder as skipped rather than truncating silently", async () => {
    const fake = createFakeClient();
    const ids = [];
    for (let id = 1; id <= 12; id += 1) {
      fake.seedFinding(id);
      ids.push(id);
    }

    const summary = await recalculateFindingRiskBatch({
      findingIds: ids,
      asOf: ASOF,
      trigger: "INGESTION",
      client: fake.client,
      maxFindings: 5,
    });

    expect(summary.requestedCount).toBe(12);
    expect(summary.processedCount).toBe(5);
    expect(summary.skippedCount).toBe(7);
    expect(fake.state.riskScores).toHaveLength(5);
  });

  it("defaults to the documented per-trigger ceiling", () => {
    expect(MAX_FINDINGS_PER_TRIGGER).toBe(100);
  });

  it("discards malformed ids and does nothing for an empty or non-array input", async () => {
    const fake = createFakeClient();
    fake.seedFinding(1);

    const summary = await recalculateFindingRiskBatch({
      findingIds: [1, 0, -3, null, "2", 1.5],
      asOf: ASOF,
      trigger: "INGESTION",
      client: fake.client,
    });
    expect(summary.requestedCount).toBe(1);
    expect(summary.createdCount).toBe(1);

    const empty = await recalculateFindingRiskBatch({
      findingIds: "not an array",
      asOf: ASOF,
      trigger: "INGESTION",
      client: fake.client,
    });
    expect(empty.requestedCount).toBe(0);
    expect(empty.processedCount).toBe(0);
  });

  it("processes findings in a deterministic order", async () => {
    const fake = createFakeClient();
    [1, 2, 3].forEach((id) => fake.seedFinding(id));

    await recalculateFindingRiskBatch({
      findingIds: [3, 1, 2],
      asOf: ASOF,
      trigger: "INGESTION",
      client: fake.client,
    });

    expect(fake.state.riskScores.map((r) => r.findingId)).toEqual([1, 2, 3]);
  });
});

describe("trigger boundaries", () => {
  it("ingestion tags its aggregate event to the RawReport it came from", async () => {
    const fake = createFakeClient();
    fake.seedFinding(1);

    await recalculateAfterIngestion({
      findingIds: [1],
      asOf: ASOF,
      client: fake.client,
      rawReportId: 55,
    });

    const event = fake.state.auditLogs.at(-1);
    expect(event.action).toBe(AUDIT_ACTIONS.INGESTION_COMPLETED);
    expect(event.entityType).toBe("RawReport");
    expect(event.entityId).toBe("55");
    expect(fake.state.riskScores[0].trigger).toBe("INGESTION");
  });

  it("enrichment tags its aggregate event to the batch entity", async () => {
    const fake = createFakeClient();
    fake.seedFinding(1);

    await recalculateAfterEnrichment({ findingIds: [1], asOf: ASOF, client: fake.client });

    const event = fake.state.auditLogs.at(-1);
    expect(event.action).toBe(AUDIT_ACTIONS.ENRICHMENT_COMPLETED);
    expect(event.entityType).toBe(AUDIT_BATCH_ENTITY_TYPE);
    expect(fake.state.riskScores[0].trigger).toBe("ENRICHMENT_COMPLETED");
  });

  it("ownership rescores one finding under its own action pair", async () => {
    const fake = createFakeClient();
    fake.seedFinding(1);

    const result = await recalculateAfterOwnershipChange({
      findingId: 1,
      asOf: ASOF,
      client: fake.client,
    });

    expect(result.ok).toBe(true);
    expect(fake.state.riskScores[0].trigger).toBe("OWNERSHIP_CHANGED");
    expect(fake.state.auditLogs.at(-1).action).toBe(AUDIT_ACTIONS.OWNERSHIP_COMPLETED);
  });

  it("an ownership rescore failure never throws into the ownership caller", async () => {
    const fake = createFakeClient({ failOnFindingIds: [1] });
    fake.seedFinding(1);

    const result = await recalculateAfterOwnershipChange({
      findingId: 1,
      asOf: ASOF,
      client: fake.client,
    });

    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe(RISK_FAILURE_CODE.PERSISTENCE_ERROR);
    expect(fake.state.auditLogs.at(-1).action).toBe(AUDIT_ACTIONS.OWNERSHIP_FAILED);
  });

  it("an ingestion rescore failure never throws into the ingestion caller", async () => {
    const fake = createFakeClient({ throwFrom: "finding" });
    fake.seedFinding(1);

    const summary = await recalculateAfterIngestion({
      findingIds: [1],
      asOf: ASOF,
      client: fake.client,
      rawReportId: 7,
    });

    expect(summary.failedCount).toBe(1);
    expect(fake.state.auditLogs.at(-1).action).toBe(AUDIT_ACTIONS.INGESTION_FAILED);
  });
});
