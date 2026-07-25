import { describe, it, expect, vi } from "vitest";

const {
  PRISMA_UNIQUE_VIOLATION,
  classifyObservation,
  recordFindingObservation,
} = require("../../src/services/normalization/dedupService");

const REPORT_TYPE = "ACCESSIBLE_RDP";
const PROTOCOL = "TCP";

function prismaError(code, message) {
  const error = new Error(message || `Prisma error ${code}`);
  error.code = code;
  return error;
}

// Minimal in-memory fake of the two Prisma models dedupService touches, plus
// a pass-through $transaction — matches the stub-Prisma pattern established
// by reportIdentityService.test.js, extended to support the multi-step read/
// write coordination and compare-and-swap semantics this service relies on.
// No real database, no PrismaClient, no backend/.env.
function createFakeClient() {
  let nextFindingId = 1;
  let nextOccurrenceId = 1;
  let nextVersion = 1;
  const findings = new Map();
  const occurrences = new Map();

  function findFindingByIdentity(identity) {
    for (const f of findings.values()) {
      if (
        f.indicatorValue === identity.indicatorValue &&
        f.port === identity.port &&
        f.protocol === identity.protocol &&
        f.reportType === identity.reportType
      ) {
        return f;
      }
    }
    return null;
  }

  function findOccurrenceByPair(findingId, rawReportId) {
    for (const o of occurrences.values()) {
      if (o.findingId === findingId && o.rawReportId === rawReportId) return o;
    }
    return null;
  }

  const client = {
    finding: {
      findUnique: vi.fn(async ({ where }) => {
        if (where.id !== undefined) return findings.get(where.id) || null;
        return findFindingByIdentity(where.finding_identity);
      }),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const row = findings.get(where.id);
        if (!row) throw new Error(`finding ${where.id} not found`);
        return row;
      }),
      create: vi.fn(async ({ data }) => {
        if (findFindingByIdentity(data)) {
          throw prismaError(PRISMA_UNIQUE_VIOLATION, "Unique constraint failed on finding_identity");
        }
        const row = { id: nextFindingId, updatedAt: new Date(nextVersion), ...data };
        nextFindingId += 1;
        nextVersion += 1;
        findings.set(row.id, row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = findings.get(where.id);
        if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) {
          return { count: 0 };
        }
        Object.assign(row, data, { updatedAt: new Date(nextVersion) });
        nextVersion += 1;
        return { count: 1 };
      }),
    },
    findingOccurrence: {
      findUnique: vi.fn(async ({ where }) => {
        const key = where.findingId_rawReportId;
        return findOccurrenceByPair(key.findingId, key.rawReportId);
      }),
      create: vi.fn(async ({ data }) => {
        if (findOccurrenceByPair(data.findingId, data.rawReportId)) {
          throw prismaError(PRISMA_UNIQUE_VIOLATION, "Unique constraint failed on findingId_rawReportId");
        }
        const row = { id: nextOccurrenceId, ...data };
        nextOccurrenceId += 1;
        occurrences.set(row.id, row);
        return row;
      }),
    },
    $transaction: vi.fn(async (fn) => fn(client)),
  };

  return { client, findings, occurrences };
}

function baseInput(overrides = {}) {
  return {
    rawReportId: 1,
    reportType: REPORT_TYPE,
    indicatorValue: "203.0.113.10",
    port: 3389,
    protocol: PROTOCOL,
    observedAt: new Date("2026-01-05T12:00:00.000Z"),
    ...overrides,
  };
}

describe("classifyObservation", () => {
  it("classifies an equal-timestamp OPEN observation as PERSISTED, not HISTORICAL", () => {
    const finding = { status: "OPEN", lastSeen: new Date("2026-01-05T00:00:00Z") };
    expect(classifyObservation(finding, new Date("2026-01-05T00:00:00Z"))).toBe("PERSISTED");
  });

  it("classifies an equal-timestamp CLOSED observation as HISTORICAL, not RECURRED", () => {
    const finding = {
      status: "CLOSED",
      closedThroughObservedAt: new Date("2026-01-05T00:00:00Z"),
    };
    expect(classifyObservation(finding, new Date("2026-01-05T00:00:00Z"))).toBe("HISTORICAL");
  });

  it("throws on a CLOSED finding missing closedThroughObservedAt rather than guessing", () => {
    const finding = { status: "CLOSED", closedThroughObservedAt: null };
    expect(() => classifyObservation(finding, new Date())).toThrow(/data integrity violation/i);
  });
});

describe("recordFindingObservation — new Finding", () => {
  it("creates an OPEN Finding with firstSeen/lastSeen at observedAt and a CREATED occurrence", async () => {
    const { client } = createFakeClient();
    const result = await recordFindingObservation(baseInput(), { client });

    expect(result.findingCreated).toBe(true);
    expect(result.idempotent).toBe(false);
    expect(result.action).toBe("CREATED");
    expect(result.finding.status).toBe("OPEN");
    expect(result.finding.firstSeen).toEqual(new Date("2026-01-05T12:00:00.000Z"));
    expect(result.finding.lastSeen).toEqual(new Date("2026-01-05T12:00:00.000Z"));
    expect(result.finding.occurrenceCount).toBe(1);
    expect(result.finding.recurrenceCount).toBe(0);
    expect(result.occurrence.action).toBe("CREATED");
    expect(result.occurrence.findingId).toBe(result.finding.id);
    expect(result.occurrence.rawReportId).toBe(1);
  });
});

describe("recordFindingObservation — persistence", () => {
  it("existing OPEN finding + later report: PERSISTED, lastSeen advances, firstSeen unchanged, occurrenceCount +1", async () => {
    const { client } = createFakeClient();
    const first = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z") }),
      { client }
    );

    const second = await recordFindingObservation(
      baseInput({ rawReportId: 2, observedAt: new Date("2026-01-03T00:00:00Z") }),
      { client }
    );

    expect(second.findingCreated).toBe(false);
    expect(second.idempotent).toBe(false);
    expect(second.action).toBe("PERSISTED");
    expect(second.finding.firstSeen).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(second.finding.lastSeen).toEqual(new Date("2026-01-03T00:00:00.000Z"));
    expect(second.finding.occurrenceCount).toBe(2);
    expect(second.finding.recurrenceCount).toBe(0);
    expect(second.finding.status).toBe("OPEN");
    expect(second.finding.id).toBe(first.finding.id);
  });
});

describe("recordFindingObservation — out-of-order OPEN", () => {
  it("earlier observedAt than lastSeen: HISTORICAL, firstSeen moves backward, lastSeen does not regress, stays OPEN", async () => {
    const { client } = createFakeClient();
    await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-10T00:00:00Z") }),
      { client }
    );

    const result = await recordFindingObservation(
      baseInput({ rawReportId: 2, observedAt: new Date("2026-01-05T00:00:00Z") }),
      { client }
    );

    expect(result.action).toBe("HISTORICAL");
    expect(result.historical).toBe(true);
    expect(result.recurrence).toBe(false);
    expect(result.finding.firstSeen).toEqual(new Date("2026-01-05T00:00:00.000Z"));
    expect(result.finding.lastSeen).toEqual(new Date("2026-01-10T00:00:00.000Z"));
    expect(result.finding.status).toBe("OPEN");
    expect(result.finding.occurrenceCount).toBe(2);
  });
});

describe("recordFindingObservation — equal-time OPEN", () => {
  it("observedAt equal to lastSeen: PERSISTED, no recurrence", async () => {
    const { client } = createFakeClient();
    await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-05T00:00:00Z") }),
      { client }
    );

    const result = await recordFindingObservation(
      baseInput({ rawReportId: 2, observedAt: new Date("2026-01-05T00:00:00Z") }),
      { client }
    );

    expect(result.action).toBe("PERSISTED");
    expect(result.recurrence).toBe(false);
    expect(result.finding.lastSeen).toEqual(new Date("2026-01-05T00:00:00.000Z"));
  });
});

describe("recordFindingObservation — recurrence", () => {
  async function makeClosedFinding(client, { closedThroughObservedAt }) {
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z") }),
      { client }
    );
    const closed = {
      ...created.finding,
      status: "CLOSED",
      closedAt: new Date("2026-01-02T00:00:00Z"),
      closedByUserId: 7,
      closureReason: "remediated",
      closedThroughObservedAt,
    };
    client.finding.findUnique.mockImplementationOnce(async () => closed);
    // Seed the underlying store too, since later calls in the same test may
    // look the row up again via id (findUniqueOrThrow) after this point.
    return closed;
  }

  it("observedAt after closedThroughObservedAt: RECURRED, reopens, recurrenceCount and occurrenceCount +1, closure fields cleared", async () => {
    const { client, findings } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z") }),
      { client }
    );

    // Simulate a prior manual closure directly on the store (no close
    // endpoint exists yet in this phase — this mirrors the state it would
    // leave behind).
    const stored = findings.get(created.finding.id);
    Object.assign(stored, {
      status: "CLOSED",
      closedAt: new Date("2026-01-02T00:00:00Z"),
      closedByUserId: 7,
      closureReason: "remediated",
      closedThroughObservedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await recordFindingObservation(
      baseInput({ rawReportId: 2, observedAt: new Date("2026-01-10T00:00:00Z") }),
      { client }
    );

    expect(result.action).toBe("RECURRED");
    expect(result.recurrence).toBe(true);
    expect(result.historical).toBe(false);
    expect(result.finding.status).toBe("OPEN");
    expect(result.finding.recurrenceCount).toBe(1);
    expect(result.finding.occurrenceCount).toBe(2);
    expect(result.finding.closedAt).toBeNull();
    expect(result.finding.closedByUserId).toBeNull();
    expect(result.finding.closureReason).toBeNull();
    expect(result.finding.closedThroughObservedAt).toBeNull();
    expect(result.finding.lastSeen).toEqual(new Date("2026-01-10T00:00:00.000Z"));
    expect(result.finding.firstSeen).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });
});

describe("recordFindingObservation — historical CLOSED", () => {
  it("observedAt before closedThroughObservedAt: HISTORICAL, remains CLOSED, recurrenceCount unchanged", async () => {
    const { client, findings } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-05T00:00:00Z") }),
      { client }
    );
    const stored = findings.get(created.finding.id);
    Object.assign(stored, {
      status: "CLOSED",
      closedAt: new Date("2026-01-06T00:00:00Z"),
      closedByUserId: 7,
      closureReason: "remediated",
      closedThroughObservedAt: new Date("2026-01-05T00:00:00Z"),
    });

    const result = await recordFindingObservation(
      baseInput({ rawReportId: 2, observedAt: new Date("2026-01-02T00:00:00Z") }),
      { client }
    );

    expect(result.action).toBe("HISTORICAL");
    expect(result.recurrence).toBe(false);
    expect(result.finding.status).toBe("CLOSED");
    expect(result.finding.recurrenceCount).toBe(0);
    expect(result.finding.occurrenceCount).toBe(2);
    expect(result.finding.firstSeen).toEqual(new Date("2026-01-02T00:00:00.000Z"));
    expect(result.finding.closedAt).toEqual(new Date("2026-01-06T00:00:00.000Z"));
    expect(result.finding.closedThroughObservedAt).toEqual(new Date("2026-01-05T00:00:00.000Z"));
  });
});

describe("recordFindingObservation — equal-time CLOSED", () => {
  it("observedAt equal to closedThroughObservedAt: does not reopen, HISTORICAL", async () => {
    const { client, findings } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-05T00:00:00Z") }),
      { client }
    );
    const stored = findings.get(created.finding.id);
    Object.assign(stored, {
      status: "CLOSED",
      closedAt: new Date("2026-01-06T00:00:00Z"),
      closedByUserId: 7,
      closureReason: "remediated",
      closedThroughObservedAt: new Date("2026-01-05T00:00:00Z"),
    });

    const result = await recordFindingObservation(
      baseInput({ rawReportId: 2, observedAt: new Date("2026-01-05T00:00:00Z") }),
      { client }
    );

    expect(result.action).toBe("HISTORICAL");
    expect(result.finding.status).toBe("CLOSED");
    expect(result.recurrence).toBe(false);
  });
});

describe("recordFindingObservation — idempotency", () => {
  it("same Finding + same RawReport invoked twice: returns the existing occurrence, no second occurrence, no projection increment, idempotent=true", async () => {
    const { client, occurrences } = createFakeClient();
    const input = baseInput({ rawReportId: 1, observedAt: new Date("2026-01-05T00:00:00Z") });

    const first = await recordFindingObservation(input, { client });
    const second = await recordFindingObservation(input, { client });

    expect(second.idempotent).toBe(true);
    expect(second.findingCreated).toBe(false);
    expect(second.occurrence.id).toBe(first.occurrence.id);
    expect(second.finding.occurrenceCount).toBe(1);
    expect(occurrences.size).toBe(1);
  });

  it("duplicate rows in one report: one occurrence only, one occurrenceCount increment only", async () => {
    const { client, occurrences } = createFakeClient();
    const input = baseInput({ rawReportId: 1, observedAt: new Date("2026-01-05T00:00:00Z") });

    await recordFindingObservation(input, { client });
    await recordFindingObservation(input, { client });
    const third = await recordFindingObservation(input, { client });

    expect(occurrences.size).toBe(1);
    expect(third.finding.occurrenceCount).toBe(1);
  });
});

describe("recordFindingObservation — concurrency", () => {
  it("concurrent Finding-create P2002: loads the winning Finding, continues safely, no duplicate Finding", async () => {
    const { client, findings } = createFakeClient();
    const input = baseInput({ rawReportId: 2, observedAt: new Date("2026-01-05T00:00:00Z") });

    // Simulate a concurrent transaction that already created the Finding
    // between our findUnique check and our create call.
    const winner = {
      id: 99,
      indicatorValue: input.indicatorValue,
      port: input.port,
      protocol: input.protocol,
      reportType: input.reportType,
      status: "OPEN",
      firstSeen: new Date("2026-01-01T00:00:00Z"),
      lastSeen: new Date("2026-01-01T00:00:00Z"),
      occurrenceCount: 1,
      recurrenceCount: 0,
      closedAt: null,
      closedByUserId: null,
      closureReason: null,
      closedThroughObservedAt: null,
      updatedAt: new Date(1),
    };

    // The initial identity check (before our own create attempt) must see
    // nothing yet — the "other" transaction's Finding becomes visible only
    // once our create() loses the race, exactly like a real concurrent
    // commit landing between our SELECT and our INSERT.
    client.finding.findUnique.mockImplementationOnce(async () => null);
    client.finding.create.mockImplementationOnce(async () => {
      findings.set(winner.id, winner);
      throw prismaError(PRISMA_UNIQUE_VIOLATION);
    });

    const result = await recordFindingObservation(input, { client });

    expect(result.findingCreated).toBe(false);
    expect(result.finding.id).toBe(99);
    expect(findings.size).toBe(1);
    expect(result.action).toBe("PERSISTED");
  });

  it("concurrent occurrence-create P2002: loads the existing occurrence, does not double-update projections", async () => {
    const { client, findings, occurrences } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z") }),
      { client }
    );

    // A concurrent transaction wins the occurrence-create race for report 2
    // between our existence check and our own create call.
    const racingOccurrence = {
      id: 999,
      findingId: created.finding.id,
      rawReportId: 2,
      observedAt: new Date("2026-01-03T00:00:00Z"),
      action: "PERSISTED",
    };

    // The initial existence check must miss it — the "other" transaction's
    // occurrence becomes visible only once our own create() loses the race.
    client.findingOccurrence.findUnique.mockImplementationOnce(async () => null);
    client.findingOccurrence.create.mockImplementationOnce(async () => {
      occurrences.set(racingOccurrence.id, racingOccurrence);
      throw prismaError(PRISMA_UNIQUE_VIOLATION);
    });

    const before = findings.get(created.finding.id).occurrenceCount;
    const result = await recordFindingObservation(
      baseInput({ rawReportId: 2, observedAt: new Date("2026-01-05T00:00:00Z") }),
      { client }
    );

    expect(result.idempotent).toBe(true);
    expect(result.occurrence.id).toBe(999);
    expect(findings.get(created.finding.id).occurrenceCount).toBe(before);
  });

  it("propagates an unexpected (non-P2002) Prisma error rather than swallowing it", async () => {
    const { client } = createFakeClient();
    client.finding.create.mockImplementationOnce(async () => {
      throw new Error("connection terminated unexpectedly");
    });

    await expect(recordFindingObservation(baseInput(), { client })).rejects.toThrow(
      "connection terminated unexpectedly"
    );
  });

  it("resolves a lost projection-update compare-and-swap by retrying against the freshly committed row", async () => {
    const { client, findings } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z") }),
      { client }
    );

    let calls = 0;
    const originalUpdateMany = client.finding.updateMany.getMockImplementation();
    client.finding.updateMany.mockImplementation(async (args) => {
      calls += 1;
      if (calls === 1) {
        // Simulate another transaction committing first: bump the stored
        // row's version out from under this call, forcing a CAS miss.
        const row = findings.get(args.where.id);
        row.updatedAt = new Date(row.updatedAt.getTime() + 1000);
        row.occurrenceCount += 1;
        return { count: 0 };
      }
      return originalUpdateMany(args);
    });

    const result = await recordFindingObservation(
      baseInput({ rawReportId: 2, observedAt: new Date("2026-01-03T00:00:00Z") }),
      { client }
    );

    expect(result.idempotent).toBe(false);
    expect(result.finding.occurrenceCount).toBe(3);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(created.finding.id).toBe(result.finding.id);
  });
});

describe("recordFindingObservation — input validation", () => {
  it("throws a controlled programmer error for a malformed input contract", async () => {
    const { client } = createFakeClient();
    await expect(recordFindingObservation(null, { client })).rejects.toThrow(TypeError);
    await expect(recordFindingObservation(baseInput({ rawReportId: 0 }), { client })).rejects.toThrow(
      TypeError
    );
    await expect(recordFindingObservation(baseInput({ port: 0 }), { client })).rejects.toThrow(TypeError);
    await expect(recordFindingObservation(baseInput({ port: 70000 }), { client })).rejects.toThrow(
      TypeError
    );
    await expect(
      recordFindingObservation(baseInput({ observedAt: "2026-01-01" }), { client })
    ).rejects.toThrow(TypeError);
    await expect(
      recordFindingObservation(baseInput({ indicatorValue: "" }), { client })
    ).rejects.toThrow(TypeError);
  });
});
