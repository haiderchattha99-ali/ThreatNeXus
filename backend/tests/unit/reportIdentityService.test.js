import { describe, it, expect, vi } from "vitest";

const {
  CLASSIFICATION,
  PRISMA_UNIQUE_VIOLATION,
  computeSourceFileSha256,
  classifyRawReportStatus,
  classifyExistingRawReport,
  resolveRawReportIdentity,
  createRawReportRecordOrResolveExisting,
} = require("../../src/services/ingestion/reportIdentityService");

// Stub Prisma client, matching the pattern used by auditService.test.js — no
// real database, no PrismaClient construction, no backend/.env required.
function makeClient({ findUniqueImpl, createImpl } = {}) {
  return {
    rawReport: {
      findUnique: vi.fn(findUniqueImpl || (async () => null)),
      create: vi.fn(createImpl || (async ({ data }) => ({ id: 1, ...data }))),
    },
  };
}

function prismaError(code) {
  const error = new Error(`Prisma error ${code}`);
  error.code = code;
  return error;
}

describe("computeSourceFileSha256", () => {
  it("is deterministic — the same bytes always produce the same hash", () => {
    const bytes = Buffer.from("accessible-rdp synthetic content", "utf8");
    expect(computeSourceFileSha256(bytes)).toBe(computeSourceFileSha256(bytes));
  });

  it("matches the known SHA-256 vector for an empty buffer", () => {
    expect(computeSourceFileSha256(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("returns a lowercase 64-character hex string", () => {
    const hash = computeSourceFileSha256(Buffer.from("some bytes"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on filename metadata — only bytes matter", () => {
    // The function has no filename parameter at all: two logically different
    // "files" that happen to share bytes must hash identically.
    const fileA = Buffer.from("identical payload");
    const fileB = Buffer.from("identical payload");
    expect(computeSourceFileSha256(fileA)).toBe(computeSourceFileSha256(fileB));
  });

  it("produces different hashes for different bytes", () => {
    const a = computeSourceFileSha256(Buffer.from("payload A"));
    const b = computeSourceFileSha256(Buffer.from("payload B"));
    expect(a).not.toBe(b);
  });

  it("handles an empty buffer without throwing", () => {
    expect(() => computeSourceFileSha256(Buffer.alloc(0))).not.toThrow();
  });

  it("rejects a non-Buffer input as a controlled programmer error", () => {
    expect(() => computeSourceFileSha256("a string, not a Buffer")).toThrow(TypeError);
    expect(() => computeSourceFileSha256(123)).toThrow(TypeError);
    expect(() => computeSourceFileSha256(null)).toThrow(TypeError);
    expect(() => computeSourceFileSha256(undefined)).toThrow(TypeError);
    expect(() => computeSourceFileSha256({ length: 0 })).toThrow(TypeError);
    expect(() => computeSourceFileSha256(["a", "b"])).toThrow(TypeError);
  });

  it("never includes raw bytes in a thrown error message", () => {
    const secret = "SUPER-SECRET-ROW-CONTENT-MARKER";
    try {
      computeSourceFileSha256(secret);
      throw new Error("expected computeSourceFileSha256 to throw");
    } catch (error) {
      expect(error.message).not.toContain(secret);
    }
  });
});

describe("classifyRawReportStatus / classifyExistingRawReport", () => {
  it("classifies no existing report as NEW_FILE", () => {
    expect(classifyExistingRawReport(null)).toEqual({
      classification: CLASSIFICATION.NEW_FILE,
      existingReport: null,
    });
    expect(classifyExistingRawReport(undefined)).toEqual({
      classification: CLASSIFICATION.NEW_FILE,
      existingReport: null,
    });
  });

  it("classifies COMPLETED as a duplicate/no-op", () => {
    const report = { status: "COMPLETED" };
    expect(classifyExistingRawReport(report)).toEqual({
      classification: CLASSIFICATION.DUPLICATE_COMPLETED,
      existingReport: report,
    });
  });

  it("classifies PARTIALLY_VALID as a duplicate/no-op", () => {
    expect(classifyRawReportStatus("PARTIALLY_VALID")).toBe(CLASSIFICATION.DUPLICATE_COMPLETED);
  });

  it("classifies REJECTED as a duplicate/no-op, not retryable", () => {
    // Explicit behaviour: REJECTED means the exact bytes were structurally
    // rejected. Retrying identical bytes would be rejected the same way
    // again — it is a terminal, deterministic outcome, not a transient
    // failure, so it must not be classified as retryable.
    expect(classifyRawReportStatus("REJECTED")).toBe(CLASSIFICATION.DUPLICATE_COMPLETED);
  });

  it("classifies FAILED as retryable", () => {
    expect(classifyRawReportStatus("FAILED")).toBe(CLASSIFICATION.RETRYABLE_FAILED);
  });

  it("classifies RECEIVED as retryable", () => {
    expect(classifyRawReportStatus("RECEIVED")).toBe(CLASSIFICATION.RETRYABLE_RECEIVED);
  });

  it("classifies PROCESSING as duplicate-in-progress, never silently retryable", () => {
    // No approved stale-processing timeout exists anywhere in this repo yet,
    // so PROCESSING must be reported as its own outcome rather than being
    // folded into RETRYABLE_* by assumption.
    expect(classifyRawReportStatus("PROCESSING")).toBe(CLASSIFICATION.DUPLICATE_IN_PROGRESS);
    expect(classifyRawReportStatus("PROCESSING")).not.toBe(CLASSIFICATION.RETRYABLE_FAILED);
    expect(classifyRawReportStatus("PROCESSING")).not.toBe(CLASSIFICATION.RETRYABLE_RECEIVED);
  });

  it("throws on an unrecognized status rather than guessing a classification", () => {
    expect(() => classifyRawReportStatus("SOMETHING_NEW")).toThrow(/unrecognized/i);
  });

  it("throws when given a non-report-shaped value", () => {
    expect(() => classifyExistingRawReport("not an object")).toThrow(TypeError);
    expect(() => classifyExistingRawReport({})).toThrow(TypeError);
    expect(() => classifyExistingRawReport({ status: 42 })).toThrow(TypeError);
  });
});

describe("resolveRawReportIdentity", () => {
  it("returns NEW_FILE when no RawReport exists for the computed sha256", async () => {
    const client = makeClient({ findUniqueImpl: async () => null });
    const result = await resolveRawReportIdentity(Buffer.from("new content"), { client });

    expect(result.classification).toBe(CLASSIFICATION.NEW_FILE);
    expect(result.existingReport).toBeNull();
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(client.rawReport.findUnique).toHaveBeenCalledWith({
      where: { sourceFileSha256: result.sha256 },
    });
  });

  it("returns the matching classification for each terminal/retryable status", async () => {
    const cases = [
      ["COMPLETED", CLASSIFICATION.DUPLICATE_COMPLETED],
      ["PARTIALLY_VALID", CLASSIFICATION.DUPLICATE_COMPLETED],
      ["REJECTED", CLASSIFICATION.DUPLICATE_COMPLETED],
      ["FAILED", CLASSIFICATION.RETRYABLE_FAILED],
      ["RECEIVED", CLASSIFICATION.RETRYABLE_RECEIVED],
      ["PROCESSING", CLASSIFICATION.DUPLICATE_IN_PROGRESS],
    ];

    for (const [status, expected] of cases) {
      const existing = { id: 7, status, sourceFileSha256: "deadbeef" };
      const client = makeClient({ findUniqueImpl: async () => existing });
      const result = await resolveRawReportIdentity(Buffer.from("x"), { client });
      expect(result.classification).toBe(expected);
      expect(result.existingReport).toBe(existing);
    }
  });

  it("propagates an unexpected Prisma failure rather than swallowing it", async () => {
    const client = makeClient({
      findUniqueImpl: async () => {
        throw new Error("connection lost");
      },
    });
    await expect(resolveRawReportIdentity(Buffer.from("x"), { client })).rejects.toThrow(
      "connection lost"
    );
  });
});

describe("createRawReportRecordOrResolveExisting", () => {
  const createData = Object.freeze({
    reportType: "ACCESSIBLE_RDP",
    schemaVersion: "accessible-rdp.synthetic.v1",
    sourceFileName: "day-1.csv",
    sourceFileSha256: "abc123",
    fileSizeBytes: 42,
    contentType: "text/csv",
    rawContent: Buffer.from("a,b,c"),
    observationDate: new Date("2026-01-01T00:00:00.000Z"),
  });

  it("creates a new RawReport when no conflict occurs", async () => {
    const created = { id: 1, ...createData };
    const client = makeClient({ createImpl: async () => created });

    const result = await createRawReportRecordOrResolveExisting(createData, { client });

    expect(result).toEqual({
      created: true,
      rawReport: created,
      classification: CLASSIFICATION.NEW_FILE,
    });
    expect(client.rawReport.create).toHaveBeenCalledWith({ data: createData });
    expect(client.rawReport.findUnique).not.toHaveBeenCalled();
  });

  it("never creates a second row for the same sha256 — a concurrent P2002 race resolves by loading and classifying the existing report", async () => {
    const existing = { id: 9, status: "RECEIVED", sourceFileSha256: createData.sourceFileSha256 };
    const client = makeClient({
      createImpl: async () => {
        throw prismaError(PRISMA_UNIQUE_VIOLATION);
      },
      findUniqueImpl: async () => existing,
    });

    const result = await createRawReportRecordOrResolveExisting(createData, { client });

    expect(result.created).toBe(false);
    expect(result.rawReport).toBe(existing);
    expect(result.classification).toBe(CLASSIFICATION.RETRYABLE_RECEIVED);
    expect(client.rawReport.create).toHaveBeenCalledTimes(1);
    expect(client.rawReport.findUnique).toHaveBeenCalledWith({
      where: { sourceFileSha256: createData.sourceFileSha256 },
    });
  });

  it("resolves a P2002 race against a COMPLETED row as a duplicate/no-op, not a second row", async () => {
    const existing = { id: 9, status: "COMPLETED", sourceFileSha256: createData.sourceFileSha256 };
    const client = makeClient({
      createImpl: async () => {
        throw prismaError(PRISMA_UNIQUE_VIOLATION);
      },
      findUniqueImpl: async () => existing,
    });

    const result = await createRawReportRecordOrResolveExisting(createData, { client });
    expect(result.created).toBe(false);
    expect(result.classification).toBe(CLASSIFICATION.DUPLICATE_COMPLETED);
  });

  it("propagates an unexpected (non-P2002) Prisma failure rather than swallowing it", async () => {
    const client = makeClient({
      createImpl: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    });

    await expect(
      createRawReportRecordOrResolveExisting(createData, { client })
    ).rejects.toThrow("connection terminated unexpectedly");
    expect(client.rawReport.findUnique).not.toHaveBeenCalled();
  });

  it("re-throws the original P2002 error if the row cannot be found on reload", async () => {
    const originalError = prismaError(PRISMA_UNIQUE_VIOLATION);
    const client = makeClient({
      createImpl: async () => {
        throw originalError;
      },
      findUniqueImpl: async () => null,
    });

    await expect(
      createRawReportRecordOrResolveExisting(createData, { client })
    ).rejects.toBe(originalError);
  });

  it("never mutates the existing row when resolving a race", async () => {
    const existing = Object.freeze({
      id: 9,
      status: "FAILED",
      sourceFileSha256: createData.sourceFileSha256,
    });
    const client = makeClient({
      createImpl: async () => {
        throw prismaError(PRISMA_UNIQUE_VIOLATION);
      },
      findUniqueImpl: async () => existing,
    });

    await createRawReportRecordOrResolveExisting(createData, { client });

    // No update/delete call exists on the stub at all — a mutation attempt
    // would throw as "not a function", proving none was made.
    expect(existing.status).toBe("FAILED");
  });

  it("never includes rawContent bytes in the returned result's own keys", async () => {
    const created = { id: 1, ...createData };
    const client = makeClient({ createImpl: async () => created });
    const result = await createRawReportRecordOrResolveExisting(createData, { client });

    expect(Object.keys(result).sort()).toEqual(["classification", "created", "rawReport"]);
  });
});
