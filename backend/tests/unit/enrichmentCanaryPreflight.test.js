import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Phase 10C-4 — deterministic red/green coverage for the canary preflight
// harness (contract §12.2, P1-P17). No real database, no network, no live
// provider — every fact P1-P17 needs is fabricated here exactly like
// enrichmentProviderReadiness.test.js fabricates resolveProviderReadiness's
// input.
//
// Load-bearing cases named by contract §14's file-surface table:
//   - P5: a blank/null/"unlimited" MANUAL budget must FAIL, not pass — the
//     single fact the whole preflight exists to enforce (§3.3).
//   - P4: a correctly-configured canary environment must PASS, proving nvd's
//     keyless exemption does not make the assertion unsatisfiable.
//   - P13: a pre-existing GreyNoiseEnrichment row OR audit row must refuse.
//   - P14: an environment too close to UTC midnight must refuse.
//   - No-network-contact: this module imports no provider/execution-service
//     code and never calls fetch.

const {
  CANARY_PROVIDER,
  CANARY_SUBJECT,
  DATABASE_NAME_CANARY_MARKER,
  extractDatabaseName,
  msUntilNextUtcMidnight,
  gatherDbFacts,
  evaluateCanaryPreflight,
} = require("../../src/scripts/enrichmentCanaryPreflight");
const { KNOWN_PROVIDERS } = require("../../src/services/enrichmentOrchestration/enrichmentSubject");

// Deliberately not near a UTC boundary — every test that isn't specifically
// exercising P14 uses this fixed instant so P14 is never an accidental
// failure reason for an unrelated assertion.
const SAFE_NOW = new Date("2026-08-17T12:00:00.000Z");

function baseConfig(overrides = {}) {
  return {
    ENRICHMENT_WORKER_ENABLED: false,
    AUTO_ENRICHMENT_ENABLED: false,
    GREYNOISE_API_KEY: "fake-greynoise-key-for-preflight-tests-only",
    CENSYS_PAT: "",
    SHODAN_API_KEY: "",
    NETLAS_API_KEY: "",
    ABUSEIPDB_API_KEY: "",
    ENRICHMENT_MANUAL_DAILY_BUDGETS: {
      greynoise: 1,
      censys: 0,
      shodan: 0,
      netlas: 0,
      abuseipdb: 0,
      nvd: 0,
    },
    ENRICHMENT_AUTOMATIC_DAILY_BUDGETS: {
      greynoise: 0,
      censys: 0,
      shodan: 0,
      netlas: 0,
      abuseipdb: 0,
      nvd: 0,
    },
    ENRICHMENT_WORKER_BATCH_SIZE: 1,
    ENRICHMENT_WORKER_LEASE_SECONDS: 120,
    ENRICHMENT_WORKER_POLL_INTERVAL_MS: 15000,
    IOC_ENRICHMENT_PROVIDER: "mock",
    DATABASE_URL: "postgresql://user:pw@localhost:5432/threatnexus_canary?schema=public",
    ...overrides,
  };
}

function baseDbFacts(overrides = {}) {
  return {
    providerDailyUsageRows: [],
    nonTerminalJobCount: 0,
    findings: [{ id: 1, indicatorValue: CANARY_SUBJECT }],
    greyNoiseEnrichmentCount: 0,
    greynoiseLookupAuditCount: 0,
    workerStartedCount: 0,
    workerStoppedCount: 0,
    reservedTodayGreyNoiseManual: 0,
    ...overrides,
  };
}

function assertionFor(result, id) {
  const found = result.assertions.find((assertion) => assertion.id === id);
  if (!found) throw new Error(`no assertion ${id} in result`);
  return found;
}

function run(configOverrides = {}, dbFactsOverrides = {}, rawEnv = {}, now = SAFE_NOW) {
  return evaluateCanaryPreflight({
    config: baseConfig(configOverrides),
    dbFacts: baseDbFacts(dbFactsOverrides),
    rawEnv,
    now,
  });
}

describe("evaluateCanaryPreflight — green baseline", () => {
  it("passes every one of P1-P17 for the exact contract-approved canary shape", () => {
    const result = run();
    expect(result.assertions).toHaveLength(17);
    // eslint-disable-next-line no-restricted-syntax
    for (const assertion of result.assertions) {
      expect(assertion.pass, `${assertion.id} unexpectedly failed: ${assertion.detail}`).toBe(true);
    }
    expect(result.pass).toBe(true);
  });

  it("P4 is satisfiable at all — nvd's unconditional 'true' credential does not refuse the baseline", () => {
    // nvd carries no credential field in baseConfig and isProviderCredentialConfigured('nvd', _)
    // is unconditionally true regardless — the green baseline still passes P4, proving the
    // exemption works rather than merely being asserted.
    expect(assertionFor(run(), "P4").pass).toBe(true);
  });
});

describe("evaluateCanaryPreflight — P1/P2/P3 switches and credential", () => {
  it("P1 fails when the worker switch is already on", () => {
    const result = run({ ENRICHMENT_WORKER_ENABLED: true });
    expect(assertionFor(result, "P1").pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("P2 fails when AUTO_ENRICHMENT_ENABLED is true", () => {
    expect(assertionFor(run({ AUTO_ENRICHMENT_ENABLED: true }), "P2").pass).toBe(false);
  });

  it("P3 fails when greynoise has no credential", () => {
    expect(assertionFor(run({ GREYNOISE_API_KEY: "" }), "P3").pass).toBe(false);
  });
});

describe("evaluateCanaryPreflight — P4 every-other-provider-except-nvd credential red checks", () => {
  it.each(KNOWN_PROVIDERS.filter((p) => p !== CANARY_PROVIDER && p !== "nvd"))(
    "fails when %s unexpectedly has a credential configured",
    (provider) => {
      const fieldByProvider = {
        censys: "CENSYS_PAT",
        shodan: "SHODAN_API_KEY",
        netlas: "NETLAS_API_KEY",
        abuseipdb: "ABUSEIPDB_API_KEY",
      };
      const result = run({ [fieldByProvider[provider]]: "unexpected-credential" });
      const p4 = assertionFor(result, "P4");
      expect(p4.pass).toBe(false);
      expect(p4.detail).toContain(provider);
    }
  );
});

describe("evaluateCanaryPreflight — P5 the load-bearing budget assertion", () => {
  it("PASSES only for the exact literal 1", () => {
    expect(assertionFor(run(), "P5").pass).toBe(true);
  });

  it("FAILS on undefined (blank env var — resolves to null/unlimited upstream)", () => {
    const result = run({
      ENRICHMENT_MANUAL_DAILY_BUDGETS: { greynoise: undefined, censys: 0, shodan: 0, netlas: 0, abuseipdb: 0, nvd: 0 },
    });
    expect(assertionFor(result, "P5").pass).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("FAILS on null (the resolved shape of a blank GREYNOISE_MANUAL_DAILY_BUDGET)", () => {
    const result = run({
      ENRICHMENT_MANUAL_DAILY_BUDGETS: { greynoise: null, censys: 0, shodan: 0, netlas: 0, abuseipdb: 0, nvd: 0 },
    });
    expect(assertionFor(result, "P5").pass).toBe(false);
  });

  it('FAILS on the literal string "unlimited"', () => {
    const result = run({
      ENRICHMENT_MANUAL_DAILY_BUDGETS: {
        greynoise: "unlimited",
        censys: 0,
        shodan: 0,
        netlas: 0,
        abuseipdb: 0,
        nvd: 0,
      },
    });
    expect(assertionFor(result, "P5").pass).toBe(false);
  });

  it("FAILS on 0", () => {
    const result = run({
      ENRICHMENT_MANUAL_DAILY_BUDGETS: { greynoise: 0, censys: 0, shodan: 0, netlas: 0, abuseipdb: 0, nvd: 0 },
    });
    expect(assertionFor(result, "P5").pass).toBe(false);
  });

  it("FAILS on any value greater than 1", () => {
    const result = run({
      ENRICHMENT_MANUAL_DAILY_BUDGETS: { greynoise: 2, censys: 0, shodan: 0, netlas: 0, abuseipdb: 0, nvd: 0 },
    });
    expect(assertionFor(result, "P5").pass).toBe(false);
  });
});

describe("evaluateCanaryPreflight — P6 every-other-MANUAL-budget-zero, including nvd and abuseipdb", () => {
  it.each(KNOWN_PROVIDERS.filter((p) => p !== CANARY_PROVIDER))(
    "fails when %s's MANUAL budget is not explicitly 0",
    (provider) => {
      const budgets = { greynoise: 1, censys: 0, shodan: 0, netlas: 0, abuseipdb: 0, nvd: 0, [provider]: 5 };
      const result = run({ ENRICHMENT_MANUAL_DAILY_BUDGETS: budgets });
      const p6 = assertionFor(result, "P6");
      expect(p6.pass).toBe(false);
      expect(p6.detail).toContain(provider);
    }
  );
});

describe("evaluateCanaryPreflight — P7 every AUTOMATIC budget zero, including greynoise itself", () => {
  it.each(KNOWN_PROVIDERS)("fails when %s's AUTOMATIC budget is not 0", (provider) => {
    const budgets = { greynoise: 0, censys: 0, shodan: 0, netlas: 0, abuseipdb: 0, nvd: 0, [provider]: 1 };
    const result = run({ ENRICHMENT_AUTOMATIC_DAILY_BUDGETS: budgets });
    expect(assertionFor(result, "P7").pass).toBe(false);
  });
});

describe("evaluateCanaryPreflight — P8 worker batch size", () => {
  it("fails when the batch size is not exactly 1", () => {
    expect(assertionFor(run({ ENRICHMENT_WORKER_BATCH_SIZE: 5 }), "P8").pass).toBe(false);
  });
});

describe("evaluateCanaryPreflight — P9/P10/P11/P13 database-state assertions", () => {
  it("P9 fails when a prior greynoise reservation exists on any day", () => {
    const result = run(
      {},
      { providerDailyUsageRows: [{ usageDate: new Date("2026-08-01"), lane: "MANUAL", reservedCount: 1 }] }
    );
    expect(assertionFor(result, "P9").pass).toBe(false);
  });

  it("P9 passes when a zero-reservation row exists (never touches the strictly-greater-than-zero branch)", () => {
    const result = run(
      {},
      { providerDailyUsageRows: [{ usageDate: new Date("2026-08-01"), lane: "MANUAL", reservedCount: 0 }] }
    );
    expect(assertionFor(result, "P9").pass).toBe(true);
  });

  it("P10 fails when any non-terminal job exists", () => {
    expect(assertionFor(run({}, { nonTerminalJobCount: 1 }), "P10").pass).toBe(false);
  });

  it("P11 fails when zero Findings exist", () => {
    expect(assertionFor(run({}, { findings: [] }), "P11").pass).toBe(false);
  });

  it("P11 fails when more than one Finding exists", () => {
    const result = run(
      {},
      { findings: [{ id: 1, indicatorValue: CANARY_SUBJECT }, { id: 2, indicatorValue: CANARY_SUBJECT }] }
    );
    expect(assertionFor(result, "P11").pass).toBe(false);
  });

  it("P11 fails when the one Finding is not the approved canary subject", () => {
    const result = run({}, { findings: [{ id: 1, indicatorValue: "8.8.8.8" }] });
    expect(assertionFor(result, "P11").pass).toBe(false);
  });

  it("P13 fails on a pre-existing GreyNoiseEnrichment row — the legacy-path baseline", () => {
    expect(assertionFor(run({}, { greyNoiseEnrichmentCount: 1 }), "P13").pass).toBe(false);
  });

  it("P13 fails on a pre-existing greynoise.lookup.% audit row even with zero attempt-shaped evidence", () => {
    // This is precisely the legacy-path detection contract §3.2/I-13 require: the Phase-10
    // ledger (attempts, usage) is structurally blind to this path, so P13 must catch it
    // through the audit signature alone.
    expect(assertionFor(run({}, { greynoiseLookupAuditCount: 1 }), "P13").pass).toBe(false);
  });
});

describe("evaluateCanaryPreflight — P12 readiness masking, corrected per contract §12.2", () => {
  it("P12 fails (READY, not EXECUTION_PAUSED) once the worker switch is on", () => {
    const result = run({ ENRICHMENT_WORKER_ENABLED: true });
    const p12 = assertionFor(result, "P12");
    expect(p12.pass).toBe(false);
    expect(p12.detail).toContain("READY");
  });

  it("P12 alone does NOT catch a bad budget — it is masked by EXECUTION_PAUSED while the worker is off", () => {
    // The regression this test guards against: an earlier contract revision called P12 "the
    // sharpest single assertion". It is not — with the worker off, P12 reports EXECUTION_PAUSED
    // regardless of budget state, so the overall preflight must still fail via P5, not P12.
    const result = run({
      ENRICHMENT_MANUAL_DAILY_BUDGETS: { greynoise: null, censys: 0, shodan: 0, netlas: 0, abuseipdb: 0, nvd: 0 },
    });
    expect(assertionFor(result, "P12").pass).toBe(true);
    expect(assertionFor(result, "P5").pass).toBe(false);
    expect(result.pass).toBe(false);
  });
});

describe("evaluateCanaryPreflight — P14 UTC-midnight margin", () => {
  it("fails when too little time remains before the daily budget bucket resets", () => {
    // Default lease(120s) + poll(15000ms) + 10min margin = 735000ms (~12.25min) required;
    // 5 minutes before midnight is not enough.
    const almostMidnight = new Date("2026-08-17T23:55:00.000Z");
    const result = run({}, {}, {}, almostMidnight);
    expect(assertionFor(result, "P14").pass).toBe(false);
  });

  it("passes with the full day ahead", () => {
    expect(assertionFor(run(), "P14").pass).toBe(true);
  });
});

describe("evaluateCanaryPreflight — P15 execution-binding / database-name convention", () => {
  it("fails when the database name does not carry the disposable-canary marker", () => {
    const result = run({ DATABASE_URL: "postgresql://user:pw@localhost:5432/threatnexus?schema=public" });
    expect(assertionFor(result, "P15").pass).toBe(false);
  });

  it("fails when DATABASE_URL is blank", () => {
    expect(assertionFor(run({ DATABASE_URL: "" }), "P15").pass).toBe(false);
  });

  it("passes when the database name contains the marker", () => {
    expect(extractDatabaseName("postgresql://u:p@host:5432/threatnexus_canary")).toBe("threatnexus_canary");
    expect(assertionFor(run(), "P15").pass).toBe(true);
  });
});

describe("evaluateCanaryPreflight — P16 legacy ADMIN IOC batch closure", () => {
  it("fails unless IOC_ENRICHMENT_PROVIDER is exactly 'mock'", () => {
    expect(assertionFor(run({ IOC_ENRICHMENT_PROVIDER: "abuseipdb" }), "P16").pass).toBe(false);
  });
});

describe("evaluateCanaryPreflight — P17 live-smoke opt-in and worker start/stop balance", () => {
  it("fails when any LIVE_*_SMOKE opt-in variable is set", () => {
    const result = run({}, {}, { LIVE_GREYNOISE_SMOKE: "1" });
    expect(assertionFor(result, "P17").pass).toBe(false);
  });

  it("fails on a non-'1' but non-blank opt-in value too — fails closed rather than trusting the exact literal", () => {
    const result = run({}, {}, { LIVE_CENSYS_SMOKE: "true" });
    expect(assertionFor(result, "P17").pass).toBe(false);
  });

  it("fails when a worker-started audit row has no matching worker-stopped row", () => {
    const result = run({}, { workerStartedCount: 1, workerStoppedCount: 0 });
    expect(assertionFor(result, "P17").pass).toBe(false);
  });

  it("passes when no opt-in var is set and started/stopped counts balance", () => {
    expect(assertionFor(run(), "P17").pass).toBe(true);
  });
});

describe("gatherDbFacts — composes real Prisma-shaped queries, no business logic reimplemented", () => {
  function fakePrisma({
    usageRows = [],
    nonTerminalJobCount = 0,
    findings = [],
    greyNoiseEnrichmentCount = 0,
    greynoiseLookupAuditCount = 0,
    workerStartedCount = 0,
    workerStoppedCount = 0,
  } = {}) {
    return {
      providerDailyUsage: { findMany: vi.fn(async () => usageRows) },
      providerLookupJob: { count: vi.fn(async () => nonTerminalJobCount) },
      finding: { findMany: vi.fn(async () => findings) },
      greyNoiseEnrichment: { count: vi.fn(async () => greyNoiseEnrichmentCount) },
      auditLog: {
        count: vi.fn(async ({ where }) => {
          if (where && where.action && typeof where.action === "object" && "startsWith" in where.action) {
            return greynoiseLookupAuditCount;
          }
          if (where && where.action === "enrichment.worker.started") return workerStartedCount;
          if (where && where.action === "enrichment.worker.stopped") return workerStoppedCount;
          return 0;
        }),
      },
    };
  }

  it("only counts TODAY's MANUAL reservation, but keeps every day's row for P9's all-days check", () => {
    const prisma = fakePrisma({
      usageRows: [
        { usageDate: new Date("2026-08-17T00:00:00.000Z"), lane: "MANUAL", reservedCount: 1 },
        { usageDate: new Date("2026-08-16T00:00:00.000Z"), lane: "MANUAL", reservedCount: 3 },
        { usageDate: new Date("2026-08-17T00:00:00.000Z"), lane: "AUTOMATIC", reservedCount: 9 },
      ],
    });
    return gatherDbFacts(prisma, { now: SAFE_NOW }).then((facts) => {
      expect(facts.reservedTodayGreyNoiseManual).toBe(1);
      expect(facts.providerDailyUsageRows).toHaveLength(3);
    });
  });

  it("scopes providerDailyUsage.findMany to the greynoise provider only", async () => {
    const prisma = fakePrisma();
    await gatherDbFacts(prisma, { now: SAFE_NOW });
    expect(prisma.providerDailyUsage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { provider: CANARY_PROVIDER } })
    );
  });

  it("feeds evaluateCanaryPreflight a green result end to end when the database is genuinely empty", async () => {
    const prisma = fakePrisma({ findings: [{ id: 1, indicatorValue: CANARY_SUBJECT }] });
    const dbFacts = await gatherDbFacts(prisma, { now: SAFE_NOW });
    const result = evaluateCanaryPreflight({ config: baseConfig(), dbFacts, rawEnv: {}, now: SAFE_NOW });
    expect(result.pass).toBe(true);
  });
});

describe("no-network-contact proof", () => {
  const SOURCE_PATH = join(__dirname, "../../src/scripts/enrichmentCanaryPreflight.js");
  const SOURCE_TEXT = readFileSync(SOURCE_PATH, "utf8");

  // Static import-boundary check: the preflight must never import a module
  // capable of issuing a provider HTTP request. If any of these substrings
  // appear, the preflight has stopped being read-only.
  const FORBIDDEN_IMPORT_FRAGMENTS = [
    "reputation/greyNoiseProvider",
    "reputation/greyNoiseExecutionService",
    "exposure/censysExecutionService",
    "exposure/shodanExecutionService",
    "exposure/netlasExecutionService",
    "enrichmentWorker",
    "enrichmentDirectExecutionService",
    "enrichmentTargetedIocService",
    "enrichmentQuotaService\").reserveProviderQuota",
  ];

  it.each(FORBIDDEN_IMPORT_FRAGMENTS)("does not import/reference %s", (fragment) => {
    expect(SOURCE_TEXT.includes(fragment)).toBe(false);
  });

  it("never calls global fetch while gathering facts or evaluating assertions", async () => {
    const originalFetch = global.fetch;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    try {
      const prisma = {
        providerDailyUsage: { findMany: async () => [] },
        providerLookupJob: { count: async () => 0 },
        finding: { findMany: async () => [{ id: 1, indicatorValue: CANARY_SUBJECT }] },
        greyNoiseEnrichment: { count: async () => 0 },
        auditLog: { count: async () => 0 },
      };
      const dbFacts = await gatherDbFacts(prisma, { now: SAFE_NOW });
      evaluateCanaryPreflight({ config: baseConfig(), dbFacts, rawEnv: {}, now: SAFE_NOW });
    } finally {
      global.fetch = originalFetch;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("pure helpers", () => {
  it("msUntilNextUtcMidnight returns the exact remaining milliseconds", () => {
    expect(msUntilNextUtcMidnight(new Date("2026-08-17T23:59:00.000Z"))).toBe(60 * 1000);
    expect(msUntilNextUtcMidnight(new Date("2026-08-17T00:00:00.000Z"))).toBe(24 * 60 * 60 * 1000);
  });

  it("extractDatabaseName handles blank and unparseable input safely", () => {
    expect(extractDatabaseName("")).toBeNull();
    expect(extractDatabaseName(undefined)).toBeNull();
    expect(extractDatabaseName("not-a-url")).toBeNull();
    expect(extractDatabaseName("postgresql://u:p@host:5432/threatnexus_canary?schema=public")).toBe(
      "threatnexus_canary"
    );
  });

  it("DATABASE_NAME_CANARY_MARKER is the literal string this suite documents", () => {
    expect(DATABASE_NAME_CANARY_MARKER).toBe("canary");
  });
});
