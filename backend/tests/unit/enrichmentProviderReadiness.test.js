import { describe, it, expect } from "vitest";

// Phase 10C-3 — the closed, server-derived readiness ladder.
//
// The v1 design defect this suite exists to keep dead: with the shipped
// default AUTO_ENRICHMENT_ENABLED=false, an earlier draft of this ladder
// returned READY for the AUTOMATIC lane even though no automatic job could
// ever be recorded. Every precedence-boundary case below is the test that
// would have caught it.

const { KNOWN_PROVIDERS } = require("../../src/services/enrichmentOrchestration/enrichmentSubject");
const { QUOTA_LANES } = require("../../src/services/enrichmentOrchestration/enrichmentDecisionCodes");
const {
  ProviderReadinessError,
  PROVIDER_READINESS,
  PROVIDER_READINESS_PRECEDENCE,
  resolveProviderReadiness,
} = require("../../src/services/enrichmentOrchestration/enrichmentProviderReadiness");

// A fully "everything is fine" baseline for a non-delegated, non-nvd
// provider — every test below overrides exactly the field(s) it is testing.
function baseInput(overrides = {}) {
  return {
    provider: "censys",
    lane: QUOTA_LANES.MANUAL,
    credentialConfigured: true,
    workerEnabled: true,
    automaticIngestionEnabled: true,
    dailyBudget: null,
    reservedToday: 0,
    ...overrides,
  };
}

describe("resolveProviderReadiness — the closed vocabulary", () => {
  it("PROVIDER_READINESS and PROVIDER_READINESS_PRECEDENCE name exactly the same set", () => {
    // The same guard SUMMARY_STATUS_PRECEDENCE carries: a value added later
    // without a ranking cannot silently fall through undetected.
    expect([...PROVIDER_READINESS_PRECEDENCE].sort()).toEqual(Object.values(PROVIDER_READINESS).sort());
  });

  it("returns READY when every deployment-level control passes", () => {
    expect(resolveProviderReadiness(baseInput())).toBe(PROVIDER_READINESS.READY);
  });

  it("nvd is DELEGATED_BATCH_REQUIRED unconditionally — outranks every other input", () => {
    // Fully configured, funded, worker-active — and still delegated, on both
    // lanes, because it is structural (subjectTypeForProvider === CVE).
    expect(
      resolveProviderReadiness(
        baseInput({ provider: "nvd", lane: QUOTA_LANES.AUTOMATIC, dailyBudget: 100, reservedToday: 0 })
      )
    ).toBe(PROVIDER_READINESS.DELEGATED_BATCH_REQUIRED);
    expect(
      resolveProviderReadiness(baseInput({ provider: "nvd", credentialConfigured: false, workerEnabled: false }))
    ).toBe(PROVIDER_READINESS.DELEGATED_BATCH_REQUIRED);
  });

  it("NOT_CONFIGURED outranks EXECUTION_PAUSED", () => {
    expect(
      resolveProviderReadiness(baseInput({ credentialConfigured: false, workerEnabled: false }))
    ).toBe(PROVIDER_READINESS.NOT_CONFIGURED);
  });

  it("EXECUTION_PAUSED fires when the worker is off, on EITHER lane", () => {
    expect(resolveProviderReadiness(baseInput({ workerEnabled: false, lane: QUOTA_LANES.MANUAL }))).toBe(
      PROVIDER_READINESS.EXECUTION_PAUSED
    );
    expect(
      resolveProviderReadiness(
        baseInput({ workerEnabled: false, lane: QUOTA_LANES.AUTOMATIC, automaticIngestionEnabled: true })
      )
    ).toBe(PROVIDER_READINESS.EXECUTION_PAUSED);
  });

  it("EXECUTION_PAUSED outranks AUTOMATIC_INGESTION_DISABLED — the broader refusal reports first", () => {
    expect(
      resolveProviderReadiness(
        baseInput({ lane: QUOTA_LANES.AUTOMATIC, workerEnabled: false, automaticIngestionEnabled: false })
      )
    ).toBe(PROVIDER_READINESS.EXECUTION_PAUSED);
  });

  it("AUTOMATIC_INGESTION_DISABLED fires ONLY on the AUTOMATIC lane, never MANUAL — the v1 defect, closed", () => {
    // The exact shipped-default deployment: credential present, worker on,
    // budget unlimited, but AUTO_ENRICHMENT_ENABLED=false. No automatic job
    // can ever be recorded, so this must never read READY.
    expect(
      resolveProviderReadiness(
        baseInput({
          lane: QUOTA_LANES.AUTOMATIC,
          workerEnabled: true,
          automaticIngestionEnabled: false,
          dailyBudget: null,
        })
      )
    ).toBe(PROVIDER_READINESS.AUTOMATIC_INGESTION_DISABLED);

    // The MANUAL lane is unaffected by the same switch — an analyst pressing
    // a button does not go through ingestion at all.
    expect(
      resolveProviderReadiness(
        baseInput({ lane: QUOTA_LANES.MANUAL, workerEnabled: true, automaticIngestionEnabled: false })
      )
    ).toBe(PROVIDER_READINESS.READY);
  });

  it("BUDGET_ZERO fires for a known-zero budget, on either lane", () => {
    expect(resolveProviderReadiness(baseInput({ dailyBudget: 0 }))).toBe(PROVIDER_READINESS.BUDGET_ZERO);
    expect(
      resolveProviderReadiness(baseInput({ lane: QUOTA_LANES.AUTOMATIC, automaticIngestionEnabled: true, dailyBudget: 0 }))
    ).toBe(PROVIDER_READINESS.BUDGET_ZERO);
  });

  it("BUDGET_ZERO outranks BUDGET_EXHAUSTED — zero never resets at midnight, exhaustion always does", () => {
    // Both would technically describe "0 remaining"; BUDGET_ZERO is the more
    // specific, more durable fact.
    expect(resolveProviderReadiness(baseInput({ dailyBudget: 0, reservedToday: 0 }))).toBe(
      PROVIDER_READINESS.BUDGET_ZERO
    );
  });

  it("null dailyBudget (unlimited) never yields BUDGET_ZERO or BUDGET_EXHAUSTED, however high reservedToday is", () => {
    expect(resolveProviderReadiness(baseInput({ dailyBudget: null, reservedToday: 1_000_000 }))).toBe(
      PROVIDER_READINESS.READY
    );
  });

  it("BUDGET_EXHAUSTED boundary: reservedToday === dailyBudget is exhausted, dailyBudget - 1 is READY", () => {
    expect(resolveProviderReadiness(baseInput({ dailyBudget: 5, reservedToday: 5 }))).toBe(
      PROVIDER_READINESS.BUDGET_EXHAUSTED
    );
    expect(resolveProviderReadiness(baseInput({ dailyBudget: 5, reservedToday: 4 }))).toBe(
      PROVIDER_READINESS.READY
    );
  });

  it("BUDGET_EXHAUSTED also fires when reservedToday exceeds dailyBudget (a lowered mid-day budget)", () => {
    expect(resolveProviderReadiness(baseInput({ dailyBudget: 3, reservedToday: 7 }))).toBe(
      PROVIDER_READINESS.BUDGET_EXHAUSTED
    );
  });
});

describe("resolveProviderReadiness — malformed input THROWS, never resolves to a plausible value (§8.3)", () => {
  it("throws for a provider outside KNOWN_PROVIDERS", () => {
    expect(() => resolveProviderReadiness(baseInput({ provider: "virustotal" }))).toThrow(ProviderReadinessError);
  });

  it("throws for a non-string provider", () => {
    expect(() => resolveProviderReadiness(baseInput({ provider: null }))).toThrow(ProviderReadinessError);
    expect(() => resolveProviderReadiness(baseInput({ provider: 5 }))).toThrow(ProviderReadinessError);
  });

  it("throws for a lane outside QUOTA_LANES", () => {
    expect(() => resolveProviderReadiness(baseInput({ lane: "BOTH" }))).toThrow(ProviderReadinessError);
  });

  it("throws when credentialConfigured/workerEnabled/automaticIngestionEnabled are not real booleans", () => {
    // The exact shape a caller would produce by accidentally passing a raw
    // environment map (strings) where a resolved boolean was expected.
    expect(() => resolveProviderReadiness(baseInput({ credentialConfigured: "true" }))).toThrow(
      ProviderReadinessError
    );
    expect(() => resolveProviderReadiness(baseInput({ workerEnabled: "false" }))).toThrow(ProviderReadinessError);
    expect(() => resolveProviderReadiness(baseInput({ automaticIngestionEnabled: undefined }))).toThrow(
      ProviderReadinessError
    );
  });

  it("throws for a dailyBudget that is neither null nor a non-negative integer", () => {
    expect(() => resolveProviderReadiness(baseInput({ dailyBudget: -1 }))).toThrow(ProviderReadinessError);
    expect(() => resolveProviderReadiness(baseInput({ dailyBudget: 1.5 }))).toThrow(ProviderReadinessError);
    expect(() => resolveProviderReadiness(baseInput({ dailyBudget: "0" }))).toThrow(ProviderReadinessError);
    expect(() => resolveProviderReadiness(baseInput({ dailyBudget: undefined }))).toThrow(ProviderReadinessError);
  });

  it("throws for a reservedToday that is not a non-negative integer", () => {
    expect(() => resolveProviderReadiness(baseInput({ reservedToday: -1 }))).toThrow(ProviderReadinessError);
    expect(() => resolveProviderReadiness(baseInput({ reservedToday: null }))).toThrow(ProviderReadinessError);
    expect(() => resolveProviderReadiness(baseInput({ reservedToday: "0" }))).toThrow(ProviderReadinessError);
  });

  it("throws for a non-object input", () => {
    expect(() => resolveProviderReadiness(null)).toThrow(ProviderReadinessError);
    expect(() => resolveProviderReadiness(undefined)).toThrow(ProviderReadinessError);
    expect(() => resolveProviderReadiness([])).toThrow(ProviderReadinessError);
  });

  it("never returns READY as a fallback for any malformed input — every case above throws, none resolves", () => {
    // Belt-and-braces: re-runs the malformed cases and asserts the function
    // never completes normally, closing the fail-open this replaces.
    const malformed = [
      baseInput({ provider: "unknown-provider" }),
      baseInput({ dailyBudget: undefined }),
      baseInput({ credentialConfigured: "true" }),
    ];
    // eslint-disable-next-line no-restricted-syntax
    for (const input of malformed) {
      let threw = false;
      try {
        resolveProviderReadiness(input);
      } catch (error) {
        threw = error instanceof ProviderReadinessError;
      }
      expect(threw).toBe(true);
    }
  });
});

describe("resolveProviderReadiness — covers all six known providers without a crash", () => {
  it("resolves a value for every KNOWN_PROVIDERS entry", () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const provider of KNOWN_PROVIDERS) {
      const value = resolveProviderReadiness(baseInput({ provider }));
      expect(Object.values(PROVIDER_READINESS)).toContain(value);
    }
  });
});
