import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Route-level security for POST /api/reports/upload, mirroring the pattern
// established by routeAuthorization.test.js: only Prisma is stubbed, the
// real routes/middleware/controllers/services run.

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
};

function applyUpdateData(row, data) {
  Object.entries(data).forEach(([key, value]) => {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      Object.prototype.hasOwnProperty.call(value, "increment")
    ) {
      row[key] = (row[key] || 0) + value.increment;
    } else {
      row[key] = value;
    }
  });
}

function prismaError(code, message) {
  const error = new Error(message || `Prisma error ${code}`);
  error.code = code;
  return error;
}

// A fresh, empty store each time buildPrismaStub() is called — one per test
// via beforeEach, so no state leaks between cases.
function buildPrismaStub() {
  let nextRawReportId = 1;
  let nextRowId = 1;
  let nextFindingId = 1;
  let nextOccurrenceId = 1;
  let nextAuditId = 1;

  const rawReports = new Map();
  const rawReportRows = new Map();
  const findings = new Map();
  const occurrences = new Map();
  const auditLogs = [];

  const findRawReportBySha = (sha) =>
    [...rawReports.values()].find((r) => r.sourceFileSha256 === sha) || null;
  const findRowByPair = (rawReportId, rowNumber) =>
    [...rawReportRows.values()].find(
      (r) => r.rawReportId === rawReportId && r.rowNumber === rowNumber
    ) || null;
  const findFindingByIdentity = (identity) =>
    [...findings.values()].find(
      (f) =>
        f.indicatorValue === identity.indicatorValue &&
        f.port === identity.port &&
        f.protocol === identity.protocol &&
        f.reportType === identity.reportType
    ) || null;
  const findOccurrenceByPair = (findingId, rawReportId) =>
    [...occurrences.values()].find(
      (o) => o.findingId === findingId && o.rawReportId === rawReportId
    ) || null;

  const prismaStub = {
    rawReport: {
      findUnique: async ({ where }) => {
        if (where.sourceFileSha256 !== undefined) return findRawReportBySha(where.sourceFileSha256);
        if (where.id !== undefined) return rawReports.get(where.id) || null;
        return null;
      },
      create: async ({ data }) => {
        if (findRawReportBySha(data.sourceFileSha256)) {
          throw prismaError("P2002", "Unique constraint failed on sourceFileSha256");
        }
        const row = {
          id: nextRawReportId++,
          processingAttempts: 0,
          completedAt: null,
          errorSummary: null,
          ...data,
        };
        rawReports.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = rawReports.get(where.id);
        if (!row) throw prismaError("P2025", "record not found");
        applyUpdateData(row, data);
        return { ...row };
      },
    },
    rawReportRow: {
      findUnique: async ({ where }) => {
        const key = where.rawReportId_rowNumber;
        return findRowByPair(key.rawReportId, key.rowNumber);
      },
      create: async ({ data }) => {
        const row = { id: nextRowId++, createdAt: new Date(), ...data };
        rawReportRows.set(row.id, row);
        return { ...row };
      },
    },
    finding: {
      findUnique: async ({ where }) => {
        if (where.id !== undefined) return findings.get(where.id) || null;
        return findFindingByIdentity(where.finding_identity);
      },
      create: async ({ data }) => {
        if (findFindingByIdentity(data)) {
          throw prismaError("P2002", "Unique constraint failed on finding_identity");
        }
        const row = { id: nextFindingId++, updatedAt: new Date(), ...data };
        findings.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = findings.get(where.id);
        if (!row) throw prismaError("P2025", "record not found");
        applyUpdateData(row, data);
        row.updatedAt = new Date();
        return { ...row };
      },
    },
    findingOccurrence: {
      findUnique: async ({ where }) => {
        const key = where.findingId_rawReportId;
        return findOccurrenceByPair(key.findingId, key.rawReportId);
      },
      create: async ({ data }) => {
        if (findOccurrenceByPair(data.findingId, data.rawReportId)) {
          throw prismaError("P2002", "Unique constraint failed on findingId_rawReportId");
        }
        const row = { id: nextOccurrenceId++, createdAt: new Date(), ...data };
        occurrences.set(row.id, row);
        return { ...row };
      },
    },
    auditLog: {
      create: async ({ data }) => {
        const row = { id: nextAuditId++, occurredAt: new Date(), ...data };
        auditLogs.push(row);
        return row;
      },
    },
    $transaction: async (fn) => fn(prismaStub),
  };

  return { prismaStub, rawReports, rawReportRows, findings, auditLogs };
}

let originalEnv;
let currentStore;

function reloadAppWithFreshCache() {
  const marker = `${path.sep}src${path.sep}`;
  Object.keys(require.cache).forEach((key) => {
    if (key.includes(marker)) delete require.cache[key];
  });

  const prismaPath = require.resolve("../../src/config/prisma");
  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: currentStore.prismaStub,
  };

  return require("../../src/app");
}

let app;
const tokens = {};

beforeAll(() => {
  originalEnv = { ...process.env };
  Object.assign(process.env, BASE_ENV);

  ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"].forEach((role, index) => {
    tokens[role] = jwt.sign(
      { id: index + 1, email: `${role.toLowerCase()}@example.test`, role },
      JWT_SECRET
    );
  });
});

afterAll(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

let errorSpy;
let logSpy;

beforeEach(() => {
  currentStore = buildPrismaStub();
  app = reloadAppWithFreshCache();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  vi.clearAllMocks();
});

const HEADER = "timestamp,ip,port,protocol,hostname,asn,as_name,country_code";
function csvRow(r) {
  return [r.timestamp, r.ip, r.port, r.protocol, r.hostname || "", r.asn || "", r.as_name || "", r.country_code || ""].join(
    ","
  );
}
function buildCsv(rows) {
  return Buffer.from([HEADER, ...rows.map(csvRow)].join("\n") + "\n", "utf8");
}

const VALID_CSV = buildCsv([
  { timestamp: "2026-01-01T00:00:00Z", ip: "203.0.113.10", port: "3389", protocol: "tcp" },
]);

function uploadAs(role, buffer = VALID_CSV, filename = "report.csv") {
  const req = request(app).post("/api/reports/upload");
  if (role) req.set("Authorization", `Bearer ${tokens[role]}`);
  return req.attach("file", buffer, filename);
}

// The real uploads/ directory is shared with other test files
// (cleanupUpload.test.js, threat-upload route tests) that Vitest can run
// concurrently in separate workers, so any directory-wide listing here is
// inherently flaky — it can observe files this route never touched. Instead,
// spy on fs.createWriteStream (what multer's disk storage calls per accepted
// file — see node_modules/multer/storage/disk.js) to observe exactly which
// path *this test's own request* wrote, then assert against that specific
// path. The spy calls through to the real implementation; it only observes.
function spyOnWrites() {
  return vi.spyOn(fs, "createWriteStream");
}

// cleanupUpload is deliberately fire-and-forget (see cleanupUpload.test.js):
// it unlinks after the response's "finish"/"close" event, not before
// supertest's client-side promise resolves. Tests must poll for the
// filesystem to settle rather than assuming synchronous completion.
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("POST /api/reports/upload — authentication and authorization", () => {
  // authenticate/requireCapability deny before multer ever runs, so no file
  // for *this* request can be written regardless. Proven via a
  // fs.createWriteStream spy (see spyOnWrites) rather than a directory
  // listing, since the real uploads/ directory is shared with other test
  // files that Vitest can run concurrently in separate workers — a
  // directory-wide "before === after" comparison there would be flaky for
  // reasons unrelated to this route.
  it("denies an unauthenticated request with 401 before any file is created", async () => {
    const writeSpy = spyOnWrites();
    try {
      const res = await uploadAs(null);

      expect(res.status).toBe(401);
      expect(res.body.message).toBe("Authentication required.");
      expect(currentStore.rawReports.size).toBe(0);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("denies a VIEWER (no ingest:reports capability) with 403 before any file is created", async () => {
    const writeSpy = spyOnWrites();
    try {
      const res = await uploadAs("VIEWER");

      expect(res.status).toBe(403);
      expect(res.body.message).toBe("Forbidden.");
      expect(currentStore.rawReports.size).toBe(0);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("denies a REVIEWER (no ingest:reports capability) with 403", async () => {
    const res = await uploadAs("REVIEWER");
    expect(res.status).toBe(403);
    expect(currentStore.rawReports.size).toBe(0);
  });

  it("accepts an authorized ANALYST upload", async () => {
    const res = await uploadAs("ANALYST");
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.report.status).toBe("COMPLETED");
  });

  it("accepts an authorized ADMIN upload", async () => {
    const res = await uploadAs("ADMIN");
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

describe("POST /api/reports/upload — file handling", () => {
  it("rejects a request with no file attached", async () => {
    const res = await request(app)
      .post("/api/reports/upload")
      .set("Authorization", `Bearer ${tokens.ANALYST}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(currentStore.rawReports.size).toBe(0);
  });

  it("rejects a non-.csv file without writing it to disk (multer fileFilter)", async () => {
    const writeSpy = spyOnWrites();
    try {
      const res = await uploadAs("ANALYST", Buffer.from("not a csv"), "report.txt");

      expect(res.status).toBe(400);
      expect(currentStore.rawReports.size).toBe(0);
      // fileFilter rejects before multer's storage engine ever opens a
      // write stream, so no temp file is created for this request at all.
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("cleans up the temp file after a successful upload", async () => {
    const writeSpy = spyOnWrites();
    try {
      const res = await uploadAs("ANALYST");
      expect(res.status).toBe(201);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const [writtenPath] = writeSpy.mock.calls[0];
      expect(await waitFor(() => !fs.existsSync(writtenPath))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("cleans up the temp file after a REJECTED upload", async () => {
    const writeSpy = spyOnWrites();
    try {
      const brokenCsv = Buffer.from("timestamp,ip,port\n2026-01-01T00:00:00Z,1.2.3.4,80\n", "utf8");
      const res = await uploadAs("ANALYST", brokenCsv);

      expect(res.status).toBe(400);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const [writtenPath] = writeSpy.mock.calls[0];
      expect(await waitFor(() => !fs.existsSync(writtenPath))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("cleans up the temp file after a duplicate/idempotent upload", async () => {
    await uploadAs("ANALYST");
    const writeSpy = spyOnWrites();
    try {
      const res = await uploadAs("ANALYST"); // same bytes again

      expect(res.status).toBe(200);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const [writtenPath] = writeSpy.mock.calls[0];
      expect(await waitFor(() => !fs.existsSync(writtenPath))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("cleans up the temp file even when processing fails unexpectedly", async () => {
    currentStore.prismaStub.finding.create = async () => {
      throw new Error("simulated failure");
    };
    const writeSpy = spyOnWrites();
    try {
      const res = await uploadAs("ANALYST");

      expect(res.status).toBe(500);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const [writtenPath] = writeSpy.mock.calls[0];
      expect(await waitFor(() => !fs.existsSync(writtenPath))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe("POST /api/reports/upload — oversized file", () => {
  afterEach(() => {
    // BASE_ENV never sets this, so removing it (not just leaving whatever
    // this test assigned) restores the default 5MB limit for every test
    // that runs after this describe block.
    delete process.env.UPLOAD_MAX_BYTES;
  });

  it("rejects a file over UPLOAD_MAX_BYTES with a safe 413, before any processing", async () => {
    process.env.UPLOAD_MAX_BYTES = "50";
    app = reloadAppWithFreshCache();

    const oversized = buildCsv(
      Array.from({ length: 5 }, (_, i) => ({
        timestamp: "2026-01-01T00:00:00Z",
        ip: `203.0.113.${i + 1}`,
        port: "3389",
        protocol: "tcp",
      }))
    );
    expect(oversized.length).toBeGreaterThan(50);

    const res = await uploadAs("ANALYST", oversized);

    expect(res.status).toBe(413);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Payload too large.");
    expect(res.body.stack).toBeUndefined();
    expect(currentStore.rawReports.size).toBe(0);
  });
});

describe("POST /api/reports/upload — response safety", () => {
  it("never returns filesystem paths, stack traces, or raw bytes", async () => {
    const res = await uploadAs("ANALYST");
    const serialized = JSON.stringify(res.body);

    expect(serialized).not.toMatch(/[A-Za-z]:\\/); // Windows absolute path
    expect(serialized).not.toContain("uploads" + path.sep);
    expect(serialized).not.toContain("rawContent");
    expect(res.body.stack).toBeUndefined();
  });

  it("only returns the documented safe response fields", async () => {
    const res = await uploadAs("ANALYST");

    expect(Object.keys(res.body).sort()).toEqual(
      ["findingCounts", "message", "report", "success"].sort()
    );
    expect(Object.keys(res.body.report).sort()).toEqual(
      [
        "id",
        "invalidRows",
        "processingAttempts",
        "reportType",
        "schemaVersion",
        "sourceFileName",
        "sourceFileSha256",
        "status",
        "totalRows",
        "validRows",
      ].sort()
    );
  });

  it("carries a requestId for correlation on a denied request", async () => {
    const res = await uploadAs("VIEWER");
    expect(typeof res.body.requestId).toBe("string");
    expect(res.headers["x-request-id"]).toBe(res.body.requestId);
  });
});

describe("POST /api/reports/upload — trusted source (P1-T6a)", () => {
  it("a normal analyst upload is accepted under the server's SYNTHETIC_UPLOAD source", async () => {
    const res = await uploadAs("ANALYST");
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  // If the controller ever read a client-supplied "source" field instead of
  // assigning SYNTHETIC_UPLOAD itself, this exact request would be rejected
  // (SHADOWSERVER is not a trusted source) — a 201 here is the proof the
  // field was never consumed.
  it("a client-supplied source field cannot override the server-controlled source", async () => {
    const res = await request(app)
      .post("/api/reports/upload")
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .field("source", "SHADOWSERVER")
      .attach("file", VALID_CSV, "report.csv");

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  // Same proof for reportType/schemaVersion: both are fixed server-side
  // (ReportType.ACCESSIBLE_RDP / accessibleRdpRowValidator's CONTRACT_VERSION)
  // and never read from the request body.
  it("client-supplied reportType/schemaVersion fields cannot override the server's fixed contract", async () => {
    const res = await request(app)
      .post("/api/reports/upload")
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .field("reportType", "SOMETHING_ELSE")
      .field("schemaVersion", "bogus-version")
      .attach("file", VALID_CSV, "report.csv");

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it("still denies before multer for an unauthenticated request, source override attempt included", async () => {
    const writeSpy = spyOnWrites();
    try {
      const res = await request(app)
        .post("/api/reports/upload")
        .field("source", "SHADOWSERVER")
        .attach("file", VALID_CSV, "report.csv");

      expect(res.status).toBe(401);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(currentStore.rawReports.size).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("temp-file cleanup still runs correctly for a request carrying override attempts", async () => {
    const writeSpy = spyOnWrites();
    try {
      const res = await request(app)
        .post("/api/reports/upload")
        .set("Authorization", `Bearer ${tokens.ANALYST}`)
        .field("source", "SHADOWSERVER")
        .field("reportType", "SOMETHING_ELSE")
        .attach("file", VALID_CSV, "report.csv");

      expect(res.status).toBe(201);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const [writtenPath] = writeSpy.mock.calls[0];
      expect(await waitFor(() => !fs.existsSync(writtenPath))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
