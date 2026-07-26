import { describe, it, expect, vi } from "vitest";

// SCOPE NOTE — what these tests are and are not.
//
// These are unit tests against an in-memory fake Prisma client. They prove
// the service's *decision logic*: lifecycle classification, projection
// arithmetic, idempotent replay, the retry policy, and input validation.
//
// They are explicitly NOT proof of PostgreSQL transaction semantics. A fake
// cannot reproduce SERIALIZABLE conflict detection or the 25P02
// aborted-transaction behaviour that motivated the P1-T4 concurrency repair.
// The fake models rollback-on-throw so the whole-transaction retry path can
// be exercised realistically, but real-database guarantees are covered by
// backend/tests/integration/dedupServiceConcurrency.test.js, which runs
// against a disposable PostgreSQL instance.

const {
  PRISMA_UNIQUE_VIOLATION,
  PRISMA_TRANSACTION_CONFLICT,
  MAX_TRANSACTION_ATTEMPTS,
  TRANSACTION_ISOLATION_LEVEL,
  isRetryableConcurrencyError,
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

// In-memory fake of the two models dedupService touches, plus a $transaction
// that models atomicity: on a thrown error the store is restored to its
// pre-transaction snapshot, exactly as a real ROLLBACK would. `setAfterRollback`
// lets a test simulate a *different* transaction having committed first — that
// write is applied after the rollback, so it survives, which is what makes the
// whole-transaction retry path testable.
function createFakeClient() {
  let nextFindingId = 1;
  let nextOccurrenceId = 1;
  let findings = new Map();
  let occurrences = new Map();
  const isolationLevels = [];
  let afterRollback = null;

  function snapshot() {
    return {
      findings: new Map([...findings].map(([k, v]) => [k, { ...v }])),
      occurrences: new Map([...occurrences].map(([k, v]) => [k, { ...v }])),
      nextFindingId,
      nextOccurrenceId,
    };
  }
  function restore(snap) {
    findings = snap.findings;
    occurrences = snap.occurrences;
    nextFindingId = snap.nextFindingId;
    nextOccurrenceId = snap.nextOccurrenceId;
  }

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
      create: vi.fn(async ({ data }) => {
        if (findFindingByIdentity(data)) {
          throw prismaError(PRISMA_UNIQUE_VIOLATION, "Unique constraint failed on finding_identity");
        }
        const row = { id: nextFindingId, updatedAt: new Date("2026-01-01T00:00:00Z"), ...data };
        nextFindingId += 1;
        findings.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = findings.get(where.id);
        if (!row) throw prismaError("P2025", "Record to update not found");
        Object.assign(row, data, { updatedAt: new Date("2026-06-01T00:00:00Z") });
        return { ...row };
      }),
    },
    findingOccurrence: {
      findUnique: vi.fn(async ({ where }) => {
        const key = where.findingId_rawReportId;
        return findOccurrenceByPair(key.findingId, key.rawReportId);
      }),
      create: vi.fn(async ({ data }) => {
        if (findOccurrenceByPair(data.findingId, data.rawReportId)) {
          throw prismaError(
            PRISMA_UNIQUE_VIOLATION,
            "Unique constraint failed on findingId_rawReportId"
          );
        }
        const row = { id: nextOccurrenceId, ...data };
        nextOccurrenceId += 1;
        occurrences.set(row.id, row);
        return row;
      }),
    },
    $transaction: vi.fn(async (fn, options) => {
      isolationLevels.push(options && options.isolationLevel);
      const snap = snapshot();
      try {
        return await fn(client);
      } catch (error) {
        restore(snap);
        if (afterRollback) {
          const apply = afterRollback;
          afterRollback = null;
          apply({ findings, occurrences });
        }
        throw error;
      }
    }),
  };

  return {
    client,
    isolationLevels,
    getFindings: () => findings,
    getOccurrences: () => occurrences,
    setAfterRollback: (fn) => {
      afterRollback = fn;
    },
  };
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

function closeFindingInStore(findings, findingId, closedThroughObservedAt) {
  Object.assign(findings.get(findingId), {
    status: "CLOSED",
    closedAt: new Date("2026-01-06T00:00:00Z"),
    closedByUserId: 7,
    closureReason: "remediated",
    closedThroughObservedAt,
  });
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

describe("isRetryableConcurrencyError", () => {
  it("retries only P2002 and P2034", () => {
    expect(isRetryableConcurrencyError(prismaError(PRISMA_UNIQUE_VIOLATION))).toBe(true);
    expect(isRetryableConcurrencyError(prismaError(PRISMA_TRANSACTION_CONFLICT))).toBe(true);
  });

  it("does not retry validation, programmer, or unknown-code errors", () => {
    // A PrismaClientUnknownRequestError has code undefined — this is exactly
    // the 25P02 aborted-transaction signature and must never be retried.
    expect(isRetryableConcurrencyError(new Error("current transaction is aborted"))).toBe(false);
    expect(isRetryableConcurrencyError(new TypeError("bad input"))).toBe(false);
    expect(isRetryableConcurrencyError(prismaError("P2025"))).toBe(false);
    expect(isRetryableConcurrencyError(prismaError("P1001"))).toBe(false);
    expect(isRetryableConcurrencyError(null)).toBe(false);
    expect(isRetryableConcurrencyError(undefined)).toBe(false);
  });
});

describe("recordFindingObservation — transaction configuration", () => {
  it("runs at SERIALIZABLE isolation", async () => {
    const { client, isolationLevels } = createFakeClient();
    await recordFindingObservation(baseInput(), { client });
    expect(isolationLevels).toEqual([TRANSACTION_ISOLATION_LEVEL]);
    expect(TRANSACTION_ISOLATION_LEVEL).toBe("Serializable");
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

  it("returns the actual committed post-update Finding row, not a locally merged object", async () => {
    const { client, getFindings } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z") }),
      { client }
    );
    const result = await recordFindingObservation(
      baseInput({ rawReportId: 2, observedAt: new Date("2026-01-03T00:00:00Z") }),
      { client }
    );

    const stored = getFindings().get(created.finding.id);
    expect(result.finding).toEqual(stored);
    // updatedAt reflects the update the database actually performed, not the
    // pre-update value that was read at the start of the transaction.
    expect(result.finding.updatedAt).toEqual(new Date("2026-06-01T00:00:00Z"));
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
  it("observedAt after closedThroughObservedAt: RECURRED, reopens, counters +1, closure fields cleared", async () => {
    const { client, getFindings } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z") }),
      { client }
    );
    closeFindingInStore(getFindings(), created.finding.id, new Date("2026-01-01T00:00:00Z"));

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
    const { client, getFindings } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-05T00:00:00Z") }),
      { client }
    );
    closeFindingInStore(getFindings(), created.finding.id, new Date("2026-01-05T00:00:00Z"));

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
    const { client, getFindings } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-05T00:00:00Z") }),
      { client }
    );
    closeFindingInStore(getFindings(), created.finding.id, new Date("2026-01-05T00:00:00Z"));

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
  it("same Finding + same RawReport twice: existing occurrence returned, no second occurrence, no counter mutation", async () => {
    const { client, getOccurrences } = createFakeClient();
    const input = baseInput({ rawReportId: 1, observedAt: new Date("2026-01-05T00:00:00Z") });

    const first = await recordFindingObservation(input, { client });
    const second = await recordFindingObservation(input, { client });

    expect(second.idempotent).toBe(true);
    expect(second.findingCreated).toBe(false);
    expect(second.occurrence.id).toBe(first.occurrence.id);
    expect(second.finding.occurrenceCount).toBe(1);
    expect(getOccurrences().size).toBe(1);
  });

  it("duplicate rows in one report: one occurrence only, one occurrenceCount increment only", async () => {
    const { client, getOccurrences } = createFakeClient();
    const input = baseInput({ rawReportId: 1, observedAt: new Date("2026-01-05T00:00:00Z") });

    await recordFindingObservation(input, { client });
    await recordFindingObservation(input, { client });
    const third = await recordFindingObservation(input, { client });

    expect(getOccurrences().size).toBe(1);
    expect(third.finding.occurrenceCount).toBe(1);
  });
});

describe("recordFindingObservation — whole-transaction retry", () => {
  it("recomputes the lifecycle action from fresh state: a Finding reopened by another transaction before the retry is not RECURRED again", async () => {
    const { client, getFindings, setAfterRollback } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z") }),
      { client }
    );
    const findingId = created.finding.id;
    closeFindingInStore(getFindings(), findingId, new Date("2026-01-05T00:00:00Z"));

    // First attempt classifies RECURRED (observedAt > closedThrough) and then
    // loses the projection write to a concurrent transaction that reopened the
    // same Finding first — the P2034 SERIALIZABLE conflict proven to occur on
    // real PostgreSQL. The winner's committed state is applied after rollback.
    let updateCalls = 0;
    const realUpdate = client.finding.update.getMockImplementation();
    client.finding.update.mockImplementation(async (args) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        setAfterRollback(({ findings }) => {
          Object.assign(findings.get(findingId), {
            status: "OPEN",
            recurrenceCount: 1,
            occurrenceCount: 2,
            lastSeen: new Date("2026-02-01T00:00:00Z"),
            closedAt: null,
            closedByUserId: null,
            closureReason: null,
            closedThroughObservedAt: null,
          });
        });
        throw prismaError(PRISMA_TRANSACTION_CONFLICT);
      }
      return realUpdate(args);
    });

    const result = await recordFindingObservation(
      baseInput({ rawReportId: 2, observedAt: new Date("2026-02-01T00:00:00Z") }),
      { client }
    );

    // Re-classified against the committed OPEN state — NOT a second RECURRED.
    expect(result.action).toBe("PERSISTED");
    expect(result.recurrence).toBe(false);
    // Exactly one increment for the single real CLOSED -> OPEN transition.
    expect(result.finding.recurrenceCount).toBe(1);
    expect(result.finding.status).toBe("OPEN");
    expect(result.occurrence.action).toBe("PERSISTED");
    expect(client.$transaction).toHaveBeenCalledTimes(3); // 1 setup + 2 attempts
  });

  it("rolls back the first attempt's occurrence so the retry leaves exactly one", async () => {
    const { client, getOccurrences, getFindings } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z") }),
      { client }
    );

    let updateCalls = 0;
    const realUpdate = client.finding.update.getMockImplementation();
    client.finding.update.mockImplementation(async (args) => {
      updateCalls += 1;
      if (updateCalls === 1) throw prismaError(PRISMA_TRANSACTION_CONFLICT);
      return realUpdate(args);
    });

    const result = await recordFindingObservation(
      baseInput({ rawReportId: 2, observedAt: new Date("2026-01-03T00:00:00Z") }),
      { client }
    );

    expect(getOccurrences().size).toBe(2);
    expect(result.finding.occurrenceCount).toBe(2);
    expect(getFindings().get(created.finding.id).occurrenceCount).toBe(2);
  });

  it("resolves a P2002 Finding-create race by re-running the transaction and reading the winner", async () => {
    const { client, getFindings, setAfterRollback } = createFakeClient();
    const input = baseInput({ rawReportId: 2, observedAt: new Date("2026-01-05T00:00:00Z") });

    // First attempt sees no Finding and loses the create race; the winner's row
    // becomes visible after the rollback, so the retry reads it.
    let createCalls = 0;
    const realCreate = client.finding.create.getMockImplementation();
    client.finding.create.mockImplementation(async (args) => {
      createCalls += 1;
      if (createCalls === 1) {
        const winner = {
          id: 99,
          ...args.data,
          firstSeen: new Date("2026-01-01T00:00:00Z"),
          lastSeen: new Date("2026-01-01T00:00:00Z"),
          occurrenceCount: 1,
          recurrenceCount: 0,
          closedAt: null,
          closedByUserId: null,
          closureReason: null,
          closedThroughObservedAt: null,
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        };
        // Applied after the rollback, so it survives it — like a concurrent
        // transaction's commit becoming visible to our next attempt.
        setAfterRollback(({ findings }) => findings.set(99, winner));
        throw prismaError(PRISMA_UNIQUE_VIOLATION);
      }
      return realCreate(args);
    });

    const result = await recordFindingObservation(input, { client });

    expect(result.findingCreated).toBe(false);
    expect(result.finding.id).toBe(99);
    expect(result.action).toBe("PERSISTED");
    expect(getFindings().size).toBe(1);
    expect(result.finding.occurrenceCount).toBe(2);
  });

  it("resolves a P2002 occurrence-create race idempotently, without double-counting", async () => {
    const { client, getFindings, getOccurrences, setAfterRollback } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z") }),
      { client }
    );

    let occCreateCalls = 0;
    const realOccCreate = client.findingOccurrence.create.getMockImplementation();
    client.findingOccurrence.create.mockImplementation(async (args) => {
      occCreateCalls += 1;
      if (occCreateCalls === 1) {
        // A concurrent transaction created this occurrence AND committed its
        // projection increment; both are applied after our rollback so they
        // survive it, as a real concurrent commit would.
        setAfterRollback(({ findings, occurrences }) => {
          occurrences.set(999, {
            id: 999,
            findingId: created.finding.id,
            rawReportId: 2,
            observedAt: new Date("2026-01-03T00:00:00Z"),
            action: "PERSISTED",
          });
          Object.assign(findings.get(created.finding.id), {
            occurrenceCount: 2,
            lastSeen: new Date("2026-01-03T00:00:00Z"),
          });
        });
        throw prismaError(PRISMA_UNIQUE_VIOLATION);
      }
      return realOccCreate(args);
    });

    const result = await recordFindingObservation(
      baseInput({ rawReportId: 2, observedAt: new Date("2026-01-03T00:00:00Z") }),
      { client }
    );

    expect(result.idempotent).toBe(true);
    expect(result.occurrence.id).toBe(999);
    expect(getOccurrences().size).toBe(2);
    // Not incremented a second time for the same (finding, report) pair.
    expect(getFindings().get(created.finding.id).occurrenceCount).toBe(2);
  });

  it("bounds the retry count and re-throws the final concurrency error", async () => {
    const { client } = createFakeClient();
    client.finding.create.mockImplementation(async () => {
      throw prismaError(PRISMA_TRANSACTION_CONFLICT, "persistent write conflict");
    });

    await expect(recordFindingObservation(baseInput(), { client })).rejects.toMatchObject({
      code: PRISMA_TRANSACTION_CONFLICT,
    });
    expect(client.$transaction).toHaveBeenCalledTimes(MAX_TRANSACTION_ATTEMPTS);
    expect(MAX_TRANSACTION_ATTEMPTS).toBe(5);
  });

  it("does not retry an unexpected Prisma error", async () => {
    const { client } = createFakeClient();
    client.finding.create.mockImplementation(async () => {
      throw new Error("connection terminated unexpectedly");
    });

    await expect(recordFindingObservation(baseInput(), { client })).rejects.toThrow(
      "connection terminated unexpectedly"
    );
    expect(client.$transaction).toHaveBeenCalledTimes(1);
  });

  it("does not retry an aborted-transaction style error with no Prisma code", async () => {
    const { client } = createFakeClient();
    client.finding.create.mockImplementation(async () => {
      throw new Error(
        "current transaction is aborted, commands ignored until end of transaction block"
      );
    });

    await expect(recordFindingObservation(baseInput(), { client })).rejects.toThrow(/aborted/);
    expect(client.$transaction).toHaveBeenCalledTimes(1);
  });

  it("does not retry the CLOSED-without-threshold data-integrity error", async () => {
    const { client, getFindings } = createFakeClient();
    const created = await recordFindingObservation(
      baseInput({ rawReportId: 1, observedAt: new Date("2026-01-01T00:00:00Z") }),
      { client }
    );
    Object.assign(getFindings().get(created.finding.id), {
      status: "CLOSED",
      closedThroughObservedAt: null,
    });

    await expect(
      recordFindingObservation(baseInput({ rawReportId: 2 }), { client })
    ).rejects.toThrow(/data integrity violation/i);
    expect(client.$transaction).toHaveBeenCalledTimes(2); // 1 setup + 1 failed, not retried
  });
});

describe("recordFindingObservation — input validation", () => {
  it("rejects an invalid reportType before Prisma is called", async () => {
    const { client } = createFakeClient();
    await expect(
      recordFindingObservation(baseInput({ reportType: "OPEN_MEMCACHED" }), { client })
    ).rejects.toThrow(/reportType must be one of ACCESSIBLE_RDP/);
    await expect(
      recordFindingObservation(baseInput({ reportType: "accessible_rdp" }), { client })
    ).rejects.toThrow(TypeError);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid protocol before Prisma is called", async () => {
    const { client } = createFakeClient();
    await expect(
      recordFindingObservation(baseInput({ protocol: "UDP" }), { client })
    ).rejects.toThrow(/protocol must be one of TCP/);
    await expect(
      recordFindingObservation(baseInput({ protocol: "tcp" }), { client })
    ).rejects.toThrow(TypeError);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

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
    expect(client.$transaction).not.toHaveBeenCalled();
  });
});
