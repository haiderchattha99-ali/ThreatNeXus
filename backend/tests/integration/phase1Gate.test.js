import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Real-PostgreSQL test for the P1-GATE executable Phase 1 evaluator
// (eval/run_phase1_gate.js). Two things are proven here, against a real
// disposable database:
//   1. the gate genuinely passes end-to-end against the committed
//      data/synthetic fixtures and ground_truth.yaml (the actual gate);
//   2. the gate is *capable* of failing — a deliberately tampered copy of
//      ground truth (never the committed file) is compared against the same
//      real ingestion pipeline and must be rejected with the mismatch
//      identified.
//
// Self-skips unless EVAL_DATABASE_URL is set, so `npm test` stays green on a
// bare checkout and never touches a real database. Run against a disposable
// database only:
//   EVAL_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_eval?schema=public" \
//     npx vitest run tests/integration/phase1Gate.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");

const EVAL_DATABASE_URL = process.env.EVAL_DATABASE_URL;

// Mirrors reportIngestionConcurrency.test.js: Vitest imports this file (and
// therefore reportIngestionService.js, transitively required by
// run_phase1_gate.js) to discover its tests even when describeDb below is
// describe.skip, so these placeholders must exist unconditionally.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://unused:unused@localhost:5432/unused";
process.env.JWT_SECRET = process.env.JWT_SECRET || "a-reasonably-strong-32-char-plus-secret-value";
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

const { createPrismaClient } = require("../../src/config/prismaFactory");
const { runPhase1Gate } = require("../../../eval/run_phase1_gate");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const GROUND_TRUTH_PATH = path.join(REPO_ROOT, "data", "synthetic", "ground_truth.yaml");
const FIXTURES_ROOT = path.dirname(GROUND_TRUTH_PATH);

let prisma;

const describeDb = EVAL_DATABASE_URL ? describe : describe.skip;

describeDb("Phase 1 Gate — real PostgreSQL", () => {
  beforeAll(() => {
    prisma = createPrismaClient(EVAL_DATABASE_URL);
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it("passes end-to-end against the committed fixtures and ground truth", async () => {
    const { pass, scenarioResults } = await runPhase1Gate({
      groundTruthPath: GROUND_TRUTH_PATH,
      fixturesRoot: FIXTURES_ROOT,
      prisma,
    });

    if (!pass) {
      const failures = scenarioResults
        .filter((r) => !r.pass)
        .map((r) => `${r.id}: ${JSON.stringify(r.diffs)}${r.ingestionError ? ` error=${r.ingestionError.message}` : ""}`)
        .join("\n");
      throw new Error(`Phase 1 gate failed:\n${failures}`);
    }

    expect(pass).toBe(true);
    expect(scenarioResults).toHaveLength(9);
    expect(scenarioResults.every((r) => r.pass)).toBe(true);
  }, 60000);

  it("is capable of failing: a deliberately tampered ground-truth value is rejected with the mismatch identified", async () => {
    const realText = fs.readFileSync(GROUND_TRUTH_PATH, "utf8");

    // Tamper exactly one expected value — FINDING_A's occurrenceCount after
    // scenario 03_persistence is genuinely 2 (see ground_truth.yaml's own
    // comment); bump it to an impossible 999. Written only to a temp file —
    // the committed ground_truth.yaml is never touched.
    const tamperedText = realText.replace(
      "          occurrenceCount: 2\n          recurrenceCount: 0\n          closedThroughObservedAt: null\n        - identity: \"FINDING_C\"",
      "          occurrenceCount: 999\n          recurrenceCount: 0\n          closedThroughObservedAt: null\n        - identity: \"FINDING_C\""
    );
    expect(tamperedText).not.toBe(realText); // the replace actually matched something

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-phase1-gate-tamper-"));
    const tamperedPath = path.join(tmpDir, "tampered-ground-truth.yaml");
    fs.writeFileSync(tamperedPath, tamperedText);

    try {
      const { pass, scenarioResults } = await runPhase1Gate({
        groundTruthPath: tamperedPath,
        fixturesRoot: FIXTURES_ROOT,
        prisma,
      });

      expect(pass).toBe(false);
      const persistence = scenarioResults.find((r) => r.id === "03_persistence");
      expect(persistence.pass).toBe(false);
      expect(
        persistence.diffs.some((d) => d.path === "findings[FINDING_A].occurrenceCount" && d.expected === 999)
      ).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // The committed file must be provably untouched by this test.
    expect(fs.readFileSync(GROUND_TRUTH_PATH, "utf8")).toBe(realText);
  }, 60000);
});
