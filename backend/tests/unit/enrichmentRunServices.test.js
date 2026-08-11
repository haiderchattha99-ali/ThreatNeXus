import { describe, it, expect } from "vitest";

// Phase 10A-1 — run-state recomputation, provider-scope validation, serializer
// safety, delegate mapping and the truthful usage payload. All pure or
// stub-driven; the real-PostgreSQL behaviour lives in
// tests/integration/phase10a1Orchestration.test.js.

const {
  RUN_ITEM_DECISIONS,
  RUN_STATES,
  JOB_STATES,
} = require("../../src/services/enrichmentOrchestration/enrichmentDecisionCodes");
const {
  EnrichmentRunValidationError,
  normalizeProviderScope,
  recomputeRunState,
} = require("../../src/services/enrichmentOrchestration/enrichmentRunService");
const {
  FORBIDDEN_OUTPUT_FIELDS,
  serializeRun,
  serializeRunItem,
  serializeRunSummary,
} = require("../../src/services/enrichmentOrchestration/enrichmentRunReadService");
const {
  resolveDelegateState,
} = require("../../src/services/enrichmentOrchestration/enrichmentReconciliationService");
const {
  ACCOUNTING_SCOPES,
  COVERAGE,
  EXCLUDED_PATHS,
  getProviderUsage,
} = require("../../src/services/enrichmentOrchestration/enrichmentUsageService");

const item = (decision, jobState, extra = {}) => ({
  decision,
  lookupJob: jobState ? { state: jobState, queriedAt: null } : null,
  provider: "censys",
  subjectType: "IPV4",
  subjectValue: "198.18.0.5",
  skipReason: null,
  ...extra,
});

describe("recomputeRunState", () => {
  it("reports SKIPPED when there are no items at all", () => {
    expect(recomputeRunState([])).toBe(RUN_STATES.SKIPPED);
  });

  it("reports SKIPPED when every item was a POLICY skip", () => {
    // This is the default-configuration ingestion case: every automatic budget
    // is 0, so nothing was ever asked of any provider.
    expect(
      recomputeRunState([
        item(RUN_ITEM_DECISIONS.SKIPPED_BUDGET, null),
        item(RUN_ITEM_DECISIONS.SKIPPED_NOT_CONFIGURED, null),
      ])
    ).toBe(RUN_STATES.SKIPPED);
  });

  it("reports PENDING while any eligible job is still non-terminal", () => {
    expect(
      recomputeRunState([
        item(RUN_ITEM_DECISIONS.ELIGIBLE, JOB_STATES.PENDING),
        item(RUN_ITEM_DECISIONS.ELIGIBLE, JOB_STATES.SUCCEEDED),
      ])
    ).toBe(RUN_STATES.PENDING);
  });

  it("reports PENDING for a job waiting on its delegate", () => {
    expect(recomputeRunState([item(RUN_ITEM_DECISIONS.ELIGIBLE, JOB_STATES.WAITING_ON_DELEGATE)])).toBe(
      RUN_STATES.PENDING
    );
  });

  it("reports RUNNING only when a worker actually holds a lease", () => {
    expect(recomputeRunState([item(RUN_ITEM_DECISIONS.ELIGIBLE, JOB_STATES.LEASED)])).toBe(
      RUN_STATES.RUNNING
    );
  });

  it("counts NO_RECORD as a real answer, not a failure", () => {
    expect(
      recomputeRunState([
        item(RUN_ITEM_DECISIONS.ELIGIBLE, JOB_STATES.SUCCEEDED),
        item(RUN_ITEM_DECISIONS.ELIGIBLE, JOB_STATES.NO_RECORD),
      ])
    ).toBe(RUN_STATES.SUCCEEDED);
  });

  it("reports PARTIAL for a mix and FAILED when nothing succeeded", () => {
    expect(
      recomputeRunState([
        item(RUN_ITEM_DECISIONS.ELIGIBLE, JOB_STATES.SUCCEEDED),
        item(RUN_ITEM_DECISIONS.ELIGIBLE, JOB_STATES.FAILED),
      ])
    ).toBe(RUN_STATES.PARTIAL);
    expect(
      recomputeRunState([
        item(RUN_ITEM_DECISIONS.ELIGIBLE, JOB_STATES.FAILED),
        item(RUN_ITEM_DECISIONS.ELIGIBLE, JOB_STATES.DEAD_LETTER),
      ])
    ).toBe(RUN_STATES.FAILED);
  });

  it("never calls an execution-time budget refusal a success", () => {
    // job.state SKIPPED_BUDGET means "we asked and were refused" — the item
    // stays ELIGIBLE and linked (Codex amendment 1), and the run must not
    // report SUCCEEDED.
    expect(recomputeRunState([item(RUN_ITEM_DECISIONS.ELIGIBLE, JOB_STATES.SKIPPED_BUDGET)])).toBe(
      RUN_STATES.FAILED
    );
  });

  it("reports PENDING rather than inventing an outcome when jobs were not loaded", () => {
    expect(recomputeRunState([item(RUN_ITEM_DECISIONS.ELIGIBLE, null)])).toBe(RUN_STATES.PENDING);
  });
});

describe("normalizeProviderScope", () => {
  it("defaults to every known provider", () => {
    expect(normalizeProviderScope(undefined)).toEqual([
      "abuseipdb",
      "censys",
      "greynoise",
      "netlas",
      "nvd",
      "shodan",
    ]);
  });

  it("deduplicates a caller list while preserving order", () => {
    expect(normalizeProviderScope(["censys", "abuseipdb", "censys"])).toEqual([
      "censys",
      "abuseipdb",
    ]);
  });

  it("rejects an unknown provider instead of silently dropping it", () => {
    expect(() => normalizeProviderScope(["censys", "virustotal"])).toThrow(
      EnrichmentRunValidationError
    );
    expect(() => normalizeProviderScope([])).toThrow(EnrichmentRunValidationError);
    expect(() => normalizeProviderScope("censys")).toThrow(EnrichmentRunValidationError);
  });
});

describe("serializers — cross-Finding isolation", () => {
  const run = {
    id: 41,
    findingId: 7,
    trigger: "MANUAL",
    state: RUN_STATES.PENDING,
    force: false,
    requestedAt: new Date("2026-08-11T16:00:00.000Z"),
    completedAt: null,
    // Fields that MUST NOT survive serialization:
    idempotencyKey: "man:deadbeef:cafebabe",
    requestScopeHash: "d".repeat(64),
  };
  const items = [
    {
      ...item(RUN_ITEM_DECISIONS.ELIGIBLE, JOB_STATES.PENDING),
      // A shared job's id would let a holder of Finding 7's summary correlate
      // it with every other Finding pointing at the same job.
      lookupJobId: 99,
      lookupJob: {
        id: 99,
        state: JOB_STATES.PENDING,
        queriedAt: null,
        queryIdentityHash: "e".repeat(64),
        activeLookupKey: "e".repeat(64),
        claimToken: "a-claim-token",
        censysEnrichmentId: 5,
      },
    },
  ];

  it("emits no identifier or hash that is shared across Findings", () => {
    const serialized = JSON.stringify(serializeRun(run, items));
    // eslint-disable-next-line no-restricted-syntax
    for (const field of FORBIDDEN_OUTPUT_FIELDS) {
      expect(serialized).not.toContain(field);
    }
    expect(serialized).not.toContain("man:deadbeef");
    expect(serialized).not.toContain("d".repeat(64));
    expect(serialized).not.toContain("e".repeat(64));
    expect(serialized).not.toContain("a-claim-token");
    // The job's own primary key must not appear either.
    expect(serialized).not.toContain('"id":99');
  });

  it("publishes the shared job's STATE, which is progress rather than identity", () => {
    const serialized = serializeRunItem(items[0]);
    expect(serialized.lookupState).toBe(JOB_STATES.PENDING);
    expect(serialized.contacted).toBe(false);
  });

  it("keeps this Finding's own subject value, which the caller already sees", () => {
    expect(serializeRunItem(items[0]).subjectValue).toBe("198.18.0.5");
  });

  it("suppresses a skipReason outside the closed vocabulary", () => {
    const leaky = serializeRunItem({
      ...item(RUN_ITEM_DECISIONS.SKIPPED_DISABLED, null),
      skipReason: "TypeError: connect ECONNREFUSED 10.0.0.1:443",
    });
    expect(leaky.skipReason).toBeNull();
  });

  it("states on every response that nothing was executed", () => {
    const serialized = serializeRun(run, items);
    expect(serialized.execution).toEqual({
      performed: false,
      reason: "PHASE_10A1_ORCHESTRATION_ONLY",
    });
  });

  it("reports providers that had no subject on this Finding", () => {
    const serialized = serializeRun(run, items, { unsubjectedProviders: ["nvd"] });
    expect(serialized.consideredProviders.noSubject).toEqual(["nvd"]);
  });

  it("leaks nothing through the compact list serializer either", () => {
    const serialized = JSON.stringify(serializeRunSummary(run));
    expect(serialized).not.toContain("idempotencyKey");
    expect(serialized).not.toContain("requestScopeHash");
  });
});

describe("delegate reconciliation mapping", () => {
  it("maps IOC delegate outcomes onto the Phase-10 vocabulary", () => {
    const ioc = (status) => ({ provider: "abuseipdb", iocEnrichment: { status } });
    expect(resolveDelegateState(ioc("SUCCESS"))).toBe(JOB_STATES.SUCCEEDED);
    expect(resolveDelegateState(ioc("NOT_FOUND"))).toBe(JOB_STATES.NO_RECORD);
    expect(resolveDelegateState(ioc("FAILED"))).toBe(JOB_STATES.FAILED);
    expect(resolveDelegateState(ioc("SKIPPED_DISABLED"))).toBe(JOB_STATES.SKIPPED_DISABLED);
    expect(resolveDelegateState(ioc("UNSUPPORTED_INDICATOR"))).toBe(
      JOB_STATES.SKIPPED_UNSUPPORTED_SUBJECT
    );
  });

  it("leaves a still-working delegate alone", () => {
    // PENDING and RATE_LIMITED both mean the delegate's own retry policy still
    // owns the work. Copying either over as terminal would fabricate an
    // outcome no provider gave.
    expect(resolveDelegateState({ provider: "abuseipdb", iocEnrichment: { status: "PENDING" } })).toBeNull();
    expect(
      resolveDelegateState({ provider: "abuseipdb", iocEnrichment: { status: "RATE_LIMITED" } })
    ).toBeNull();
  });

  it("never reads a dead-lettered CVE batch job as evidence of no vulnerability", () => {
    expect(
      resolveDelegateState({ provider: "nvd", vulnerabilityEnrichmentJob: { status: "DEAD_LETTER" } })
    ).toBe(JOB_STATES.DEAD_LETTER);
    expect(
      resolveDelegateState({ provider: "nvd", vulnerabilityEnrichmentJob: { status: "COMPLETED" } })
    ).toBe(JOB_STATES.SUCCEEDED);
  });

  it("returns null when there is no delegate row at all", () => {
    expect(resolveDelegateState({ provider: "censys" })).toBeNull();
    expect(resolveDelegateState({ provider: "abuseipdb" })).toBeNull();
  });
});

describe("usage API — truthful partial coverage (Codex amendment 5)", () => {
  // Phase 10A-1 writes no reservation rows, so the stub returns none.
  const stubClient = { providerDailyUsage: { findMany: async () => [] } };

  it("labels its scope, coverage and inactive reservations explicitly", async () => {
    const usage = await getProviderUsage({ client: stubClient, env: {} });
    expect(usage.accountingScope).toBe(ACCOUNTING_SCOPES.PHASE_10_RESERVATIONS);
    expect(usage.coverage).toBe(COVERAGE.PARTIAL);
    expect(usage.reservationsActive).toBe(false);
  });

  it("names the paths it does NOT account for", async () => {
    const usage = await getProviderUsage({ client: stubClient, env: {} });
    expect(usage.excludedPaths).toEqual(EXCLUDED_PATHS);
    expect(usage.excludedPaths).toContain("LEGACY_ADMIN_IOC_BATCH");
    expect(usage.excludedPaths).toContain("ADMIN_VULNERABILITY_BATCH");
    expect(usage.excludedPaths).toContain("PRE_10A2_SYNCHRONOUS_DIRECT_PROVIDER_ROUTES");
  });

  it("fabricates no total provider-call count", async () => {
    const usage = await getProviderUsage({ client: stubClient, env: {} });
    const keys = Object.keys(usage);
    // Nothing that could be misread as "all provider calls, ever".
    expect(keys).not.toContain("totalProviderCalls");
    expect(keys).not.toContain("totalCalls");
    expect(usage.note).toContain("NOT a total of provider calls");
  });

  it("reports configured budgets, with unlimited as null rather than a number", async () => {
    const usage = await getProviderUsage({ client: stubClient, env: {} });
    const censys = usage.providers.find((p) => p.provider === "censys");
    expect(censys.automatic.dailyBudget).toBe(0);
    expect(censys.manual.dailyBudget).toBeNull();
    expect(censys.automatic.reservedToday).toBe(0);
  });

  it("covers all six providers", async () => {
    const usage = await getProviderUsage({ client: stubClient, env: {} });
    expect(usage.providers.map((p) => p.provider).sort()).toEqual([
      "abuseipdb",
      "censys",
      "greynoise",
      "netlas",
      "nvd",
      "shodan",
    ]);
  });
});
