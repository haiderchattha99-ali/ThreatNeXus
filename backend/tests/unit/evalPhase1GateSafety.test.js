import { describe, it, expect } from "vitest";

const fs = require("fs");
const path = require("path");
const {
  GateSafetyError,
  GateStateError,
  assertSafeEvalDatabaseUrl,
  runPhase1Gate,
} = require("../../../eval/run_phase1_gate");

const EVAL_GATE_SOURCE_PATH = path.join(__dirname, "..", "..", "..", "eval", "run_phase1_gate.js");
const GROUND_TRUTH_PATH = path.join(__dirname, "..", "..", "..", "data", "synthetic", "ground_truth.yaml");

describe("assertSafeEvalDatabaseUrl", () => {
  it("rejects a missing EVAL_DATABASE_URL", () => {
    expect(() => assertSafeEvalDatabaseUrl({})).toThrow(GateSafetyError);
    expect(() => assertSafeEvalDatabaseUrl({})).toThrow(/EVAL_DATABASE_URL is required/);
  });

  it("rejects an empty-string EVAL_DATABASE_URL", () => {
    expect(() => assertSafeEvalDatabaseUrl({ EVAL_DATABASE_URL: "   " })).toThrow(GateSafetyError);
  });

  it("rejects EVAL_DATABASE_URL equal to DATABASE_URL", () => {
    const url = "postgresql://user:pw@localhost:5432/threatnexus";
    expect(() =>
      assertSafeEvalDatabaseUrl({ EVAL_DATABASE_URL: url, DATABASE_URL: url })
    ).toThrow(/must not equal DATABASE_URL/);
  });

  it("accepts a distinct EVAL_DATABASE_URL even when DATABASE_URL is also set", () => {
    const result = assertSafeEvalDatabaseUrl({
      EVAL_DATABASE_URL: "postgresql://user:pw@localhost:5432/threatnexus_eval",
      DATABASE_URL: "postgresql://user:pw@localhost:5432/threatnexus",
    });
    expect(result).toBe("postgresql://user:pw@localhost:5432/threatnexus_eval");
  });

  it("accepts EVAL_DATABASE_URL when DATABASE_URL is entirely unset", () => {
    const result = assertSafeEvalDatabaseUrl({
      EVAL_DATABASE_URL: "postgresql://user:pw@localhost:5432/threatnexus_eval",
    });
    expect(result).toBe("postgresql://user:pw@localhost:5432/threatnexus_eval");
  });

  it("never echoes the credential-bearing URL value in its error messages", () => {
    const url = "postgresql://secretuser:secretpassword@localhost:5432/threatnexus";
    try {
      assertSafeEvalDatabaseUrl({ EVAL_DATABASE_URL: url, DATABASE_URL: url });
      throw new Error("expected assertSafeEvalDatabaseUrl to throw");
    } catch (error) {
      expect(error.message).not.toContain("secretuser");
      expect(error.message).not.toContain("secretpassword");
    }
  });
});

describe("Phase 1 gate — missing fixture rejected", () => {
  it("throws GateStateError before touching the database when a scenario's fixture file is missing", async () => {
    // assertFixturesExist runs before any prisma call, so a prisma stub that
    // throws on any use proves the rejection genuinely happens first.
    const untouchedPrisma = new Proxy(
      {},
      {
        get() {
          throw new Error("prisma should never be touched when a fixture is missing");
        },
      }
    );

    const brokenGroundTruthPath = path.join(__dirname, "fixtures", "eval-broken-ground-truth.yaml");
    fs.mkdirSync(path.dirname(brokenGroundTruthPath), { recursive: true });
    fs.writeFileSync(
      brokenGroundTruthPath,
      `
version: 1
schemaVersion: "v1"
findingIdentities:
  FINDING_A: { indicatorValue: "203.0.113.11", port: 3389, protocol: "TCP", reportType: "ACCESSIBLE_RDP" }
scenarios:
  - id: "s1"
    order: 1
    kind: "ingest"
    fixtureFile: "accessible-rdp/this-file-does-not-exist.csv"
    source: "SYNTHETIC_UPLOAD"
    expected:
      outcome: "PROCESSED"
      rawReportCountDelta: 1
      rawReportRowCountDelta: 1
      findingCountDelta: 1
      findingOccurrenceCountDelta: 1
`
    );

    try {
      await expect(
        runPhase1Gate({
          groundTruthPath: brokenGroundTruthPath,
          fixturesRoot: path.dirname(GROUND_TRUTH_PATH),
          prisma: untouchedPrisma,
        })
      ).rejects.toThrow(GateStateError);
    } finally {
      fs.rmSync(brokenGroundTruthPath, { force: true });
    }
  });
});

describe("Phase 1 gate — unsafe cleanup pattern impossible by construction", () => {
  it("never deletes Finding or RawReportRow rows by a loose attribute filter, only by an id set derived from this run's own evidence", () => {
    const source = fs.readFileSync(EVAL_GATE_SOURCE_PATH, "utf8");

    // The only permitted broad filter is the initial RawReport lookup by the
    // MARKER prefix (which just SELECTs ids — it never deletes by prefix
    // directly). Every deleteMany call on Finding/RawReportRow/
    // FindingOccurrence/RawReport must be scoped by an `{ in: ... }` id set.
    const deleteManyCalls = [...source.matchAll(/prisma\.(\w+)\.deleteMany\(\{\s*where:\s*\{([^}]*)\}/g)];
    expect(deleteManyCalls.length).toBeGreaterThan(0);

    deleteManyCalls.forEach(([, model, whereClause]) => {
      expect(whereClause).toMatch(/\{\s*in:/);
      expect(whereClause).not.toMatch(/startsWith/);
      expect(whereClause).not.toMatch(/contains/);
    });
  });

  it("derives the cleanup id set from this run's own RawReport/FindingOccurrence chain, not a database-wide reset", () => {
    const source = fs.readFileSync(EVAL_GATE_SOURCE_PATH, "utf8");
    expect(source).toMatch(/async function cleanupEvalState/);
    expect(source).not.toMatch(/\.deleteMany\(\)/); // no unconditional whole-table delete
    expect(source).not.toMatch(/TRUNCATE/i);
    expect(source).not.toMatch(/DROP\s+(TABLE|DATABASE)/i);
  });
});
