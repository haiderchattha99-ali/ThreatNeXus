"use strict";

// `npm run demo:preflight` is the gate that stops an operator walking into the
// PKCERT demonstration with a database that has already been rehearsed on.
//
// The assertion that matters most is D2: a first analyst click must not be
// answerable with "Skipped — a fresh result already exists". A preflight that
// cannot go red on that exact state is worse than no preflight, so every hard
// gate below is tested in BOTH directions.

import { describe, it, expect } from "vitest";

const {
  evaluateDemoPreflight,
  parseDemoFindingIds,
  parseDemoProviders,
  extractDatabaseName,
  DEFAULT_DEMO_PROVIDERS,
  MAX_DEMO_MANUAL_BUDGET,
  LIVE_SMOKE_OPT_IN_VARS,
} = require("../../src/scripts/demoPreflight");

// The fully-ready demonstration environment.
const READY_ENV = Object.freeze({
  DATABASE_URL: "postgresql://u:p@postgres:5432/threatnexus_demo?schema=public",
  DEMO_FINDING_IDS: "7,5,8",
  DEMO_PROVIDERS: "censys,netlas,greynoise",
  DEMO_EXPECT_WORKER: "true",
  AUTO_ENRICHMENT_ENABLED: "false",
  ENRICHMENT_WORKER_ENABLED: "true",
  ABUSEIPDB_AUTOMATIC_DAILY_BUDGET: "0",
  CENSYS_AUTOMATIC_DAILY_BUDGET: "0",
  GREYNOISE_AUTOMATIC_DAILY_BUDGET: "0",
  SHODAN_AUTOMATIC_DAILY_BUDGET: "0",
  NETLAS_AUTOMATIC_DAILY_BUDGET: "0",
  NVD_AUTOMATIC_DAILY_BUDGET: "0",
  CENSYS_MANUAL_DAILY_BUDGET: "3",
  NETLAS_MANUAL_DAILY_BUDGET: "3",
  GREYNOISE_MANUAL_DAILY_BUDGET: "3",
  ABUSEIPDB_MANUAL_DAILY_BUDGET: "0",
  SHODAN_MANUAL_DAILY_BUDGET: "0",
  NVD_MANUAL_DAILY_BUDGET: "0",
  CENSYS_PAT: "present",
  NETLAS_API_KEY: "present",
  GREYNOISE_API_KEY: "present",
});

const CLEAN_FACTS = Object.freeze({
  findings: [
    { id: 5, indicatorValue: "198.51.100.21" },
    { id: 7, indicatorValue: "203.0.113.11" },
    { id: 8, indicatorValue: "203.0.113.12" },
  ],
  enrichmentRunCount: 0,
  freshConflicts: [],
  legacyLookupAuditCount: 0,
  reservedToday: new Map(),
  appliedMigrationCount: 25,
  unfinishedMigrationCount: 0,
});

function run(envOverrides = {}, factOverrides = {}) {
  return evaluateDemoPreflight({
    env: { ...READY_ENV, ...envOverrides },
    dbFacts: { ...CLEAN_FACTS, ...factOverrides },
    expectedMigrationCount: 25,
  });
}

function failedIds(result) {
  return result.assertions.filter((a) => !a.pass).map((a) => a.id);
}

describe("demoPreflight — the ready case", () => {
  it("reports DEMO READY when everything holds", () => {
    const result = run();
    expect(failedIds(result)).toEqual([]);
    expect(result.ready).toBe(true);
  });
});

describe("demoPreflight — D1/D2 first-click hard gates", () => {
  it("goes red when ANY enrichment run already exists on a demo Finding", () => {
    const result = run({}, { enrichmentRunCount: 1 });
    expect(result.ready).toBe(false);
    expect(failedIds(result)).toContain("D1");
  });

  it("goes red when a fresh provider result would skip the first click", () => {
    // The exact rehearsal state that produced "Skipped — a fresh result
    // already exists" in front of the operator.
    const result = run(
      {},
      { freshConflicts: [{ findingId: 7, provider: "censys", jobId: 1 }] }
    );
    expect(result.ready).toBe(false);
    expect(failedIds(result)).toContain("D2");
  });

  it("names the blocking Finding, provider and job so the operator can act", () => {
    const result = run(
      {},
      { freshConflicts: [{ findingId: 7, provider: "greynoise", jobId: 42 }] }
    );
    const d2 = result.assertions.find((a) => a.id === "D2");
    expect(d2.detail).toContain("7");
    expect(d2.detail).toContain("greynoise");
    expect(d2.detail).toContain("42");
  });
});

describe("demoPreflight — B base/stack gates", () => {
  it("goes red when the database is not a disposable demo database", () => {
    const result = run({
      DATABASE_URL: "postgresql://u:p@h:5432/threatnexus?schema=public",
    });
    expect(failedIds(result)).toContain("B1");
  });

  it("goes red on unfinished migrations and on a migration count mismatch", () => {
    expect(failedIds(run({}, { unfinishedMigrationCount: 1 }))).toContain("B2");
    expect(failedIds(run({}, { appliedMigrationCount: 24 }))).toContain("B3");
  });

  it("requires a primary plus at least two backups, all present", () => {
    expect(failedIds(run({ DEMO_FINDING_IDS: "7,5" }))).toContain("B4");
    expect(failedIds(run({}, { findings: [{ id: 7, indicatorValue: "203.0.113.11" }] }))).toContain("B4");
    expect(failedIds(run({ DEMO_FINDING_IDS: "" }))).toContain("B4");
  });
});

describe("demoPreflight — S safety gates", () => {
  it("goes red when automatic enrichment is on", () => {
    expect(failedIds(run({ AUTO_ENRICHMENT_ENABLED: "true" }))).toContain("S1");
  });

  it("goes red when any AUTOMATIC budget is not exactly 0", () => {
    expect(failedIds(run({ CENSYS_AUTOMATIC_DAILY_BUDGET: "1" }))).toContain("S2");
  });

  it("goes red when the worker state does not match the intended demo state", () => {
    expect(failedIds(run({ ENRICHMENT_WORKER_ENABLED: "false" }))).toContain("S3");
    // And the intent is configurable in BOTH directions, so a worker-off
    // rehearsal can also be gated.
    expect(
      failedIds(run({ DEMO_EXPECT_WORKER: "false", ENRICHMENT_WORKER_ENABLED: "true" }))
    ).toContain("S3");
  });

  it("goes red on a BLANK manual budget, because blank means UNLIMITED", () => {
    // The single most dangerous configuration in this system:
    // DEFAULT_MANUAL_DAILY_BUDGET is null, and null never refuses.
    const result = run({ CENSYS_MANUAL_DAILY_BUDGET: "" });
    expect(failedIds(result)).toContain("S4");
  });

  it("goes red on a manual budget that is zero, negative or too large", () => {
    expect(failedIds(run({ GREYNOISE_MANUAL_DAILY_BUDGET: "0" }))).toContain("S4");
    expect(
      failedIds(run({ GREYNOISE_MANUAL_DAILY_BUDGET: String(MAX_DEMO_MANUAL_BUDGET + 1) }))
    ).toContain("S4");
  });

  it("requires every NON-demo provider to be pinned to 0, not left blank", () => {
    expect(failedIds(run({ SHODAN_MANUAL_DAILY_BUDGET: "" }))).toContain("S4");
    expect(failedIds(run({ ABUSEIPDB_MANUAL_DAILY_BUDGET: "2" }))).toContain("S4");
  });

  it("goes red when the legacy unmetered path has been used", () => {
    // A provider-table row count would NOT prove this — the orchestration path
    // writes those same tables. Only the <provider>.lookup.* audit signature is
    // unique to the legacy synchronous routes.
    expect(failedIds(run({}, { legacyLookupAuditCount: 1 }))).toContain("S5");
  });

  it("goes red when any live-smoke opt-in is armed, on any non-blank value", () => {
    LIVE_SMOKE_OPT_IN_VARS.forEach((name) => {
      expect(failedIds(run({ [name]: "0" }))).toContain("S6");
      expect(failedIds(run({ [name]: "1" }))).toContain("S6");
    });
  });

  it("goes red when an EXCLUDED provider still has a credential", () => {
    // A zero budget bounds the orchestration lane only. The legacy synchronous
    // routes and the ADMIN batch path can still reach a credentialed provider,
    // and ingestion leaves PENDING abuseipdb rows on the legacy queue after
    // every report, so the credential's absence is the real guarantee.
    expect(failedIds(run({ ABUSEIPDB_API_KEY: "present" }))).toContain("S7");
    expect(failedIds(run({ SHODAN_API_KEY: "present" }))).toContain("S7");
  });

  it("passes S7 when every excluded provider is uncredentialed", () => {
    const s7 = run().assertions.find((a) => a.id === "S7");
    expect(s7.pass).toBe(true);
    expect(s7.detail).toContain("abuseipdb");
    expect(s7.detail).toContain("shodan");
  });
});

describe("demoPreflight — P provider gates", () => {
  it("goes red on an unsupported provider name", () => {
    expect(failedIds(run({ DEMO_PROVIDERS: "censys,nonsuch" }))).toContain("P1");
  });

  it("goes red when a demo provider's credential variable is absent", () => {
    expect(failedIds(run({ CENSYS_PAT: "" }))).toContain("P2");
  });

  it("does NOT claim credential validity — only presence", () => {
    const p2 = run().assertions.find((a) => a.id === "P2");
    expect(p2.description).toMatch(/presence only/i);
    expect(p2.description).toMatch(/NOT proof/i);
  });

  it("excludes nvd from the credential gate, whose check is unconditionally true", () => {
    // isProviderCredentialConfigured("nvd") returns true no matter what, so
    // asserting on it would be vacuous rather than reassuring.
    const result = run({ DEMO_PROVIDERS: "nvd" });
    const p2 = result.assertions.find((a) => a.id === "P2");
    expect(p2.pass).toBe(true);
    expect(p2.detail).not.toContain("nvd");
  });

  it("goes red when a demo provider is not READY on the MANUAL lane", () => {
    // Budget fully spent today.
    const result = run({}, { reservedToday: new Map([["greynoise", 3]]) });
    expect(failedIds(result)).toContain("P3");
    expect(result.assertions.find((a) => a.id === "P3").detail).toContain("BUDGET_EXHAUSTED");
  });
});

describe("demoPreflight — parsing", () => {
  it("parses finding ids and rejects junk rather than coercing it", () => {
    expect(parseDemoFindingIds("7, 5 ,8")).toEqual([7, 5, 8]);
    expect(parseDemoFindingIds("7,abc,-1,0")).toEqual([7]);
    expect(parseDemoFindingIds("")).toEqual([]);
    expect(parseDemoFindingIds(undefined)).toEqual([]);
  });

  it("falls back to the documented default provider set", () => {
    expect(parseDemoProviders("")).toEqual([...DEFAULT_DEMO_PROVIDERS]);
    expect(parseDemoProviders("Censys, NETLAS")).toEqual(["censys", "netlas"]);
  });

  it("extractDatabaseName never returns embedded credentials", () => {
    expect(extractDatabaseName("postgresql://u:pw@h:5432/threatnexus_demo")).toBe("threatnexus_demo");
    expect(extractDatabaseName("nonsense")).toBeNull();
  });
});

describe("demoPreflight — no provider contact", () => {
  it("imports no provider, adapter, or execution-service module", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "scripts", "demoPreflight.js"),
      "utf8"
    );
    const requires = [...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
    requires.forEach((specifier) => {
      expect(specifier).not.toMatch(/Provider(?!Readiness)|ExecutionService|Adapter|axios|node-fetch/);
    });
  });

  it("never exposes a credential value in its report", () => {
    const result = run({ CENSYS_PAT: "super-secret-pat-value" });
    expect(JSON.stringify(result)).not.toContain("super-secret-pat-value");
  });
});
