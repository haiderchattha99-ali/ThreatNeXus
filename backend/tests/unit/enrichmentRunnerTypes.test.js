import { describe, it, expect } from "vitest";

const {
  EnrichmentRunnerValidationError,
  RUNNER_OUTCOME,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  MIN_LEASE_SECONDS,
  MAX_LEASE_SECONDS,
  MAX_WORKER_ID_LENGTH,
  assertValidRunnerConfig,
  isAborted,
  buildJobResult,
  buildBatchSummary,
} = require("../../src/services/enrichment/enrichmentRunnerTypes");

const T0 = new Date("2026-07-28T12:00:00.000Z");

function validOptions(overrides = {}) {
  return {
    prisma: { iocEnrichment: {} },
    providerRegistry: { resolve: () => null },
    now: T0,
    batchSize: 10,
    leaseDurationSeconds: 60,
    ttlPolicy: () => ({ expiresAt: T0, ttlSeconds: 60, policyReason: "TEST" }),
    workerId: "worker-1",
    ...overrides,
  };
}

describe("enrichmentRunnerTypes — assertValidRunnerConfig", () => {
  it("accepts a fully valid configuration and normalizes leaseMs", () => {
    const config = assertValidRunnerConfig(validOptions());
    expect(config.leaseMs).toBe(60000);
    expect(config.signal).toBeNull();
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("rejects a missing options object", () => {
    expect(() => assertValidRunnerConfig(undefined)).toThrow(EnrichmentRunnerValidationError);
    expect(() => assertValidRunnerConfig(null)).toThrow(EnrichmentRunnerValidationError);
    expect(() => assertValidRunnerConfig([])).toThrow(EnrichmentRunnerValidationError);
  });

  it("rejects a prisma client missing iocEnrichment", () => {
    expect(() => assertValidRunnerConfig(validOptions({ prisma: {} }))).toThrow(EnrichmentRunnerValidationError);
    expect(() => assertValidRunnerConfig(validOptions({ prisma: null }))).toThrow(EnrichmentRunnerValidationError);
  });

  it("rejects a providerRegistry without a resolve function", () => {
    expect(() => assertValidRunnerConfig(validOptions({ providerRegistry: {} }))).toThrow(
      EnrichmentRunnerValidationError
    );
    expect(() => assertValidRunnerConfig(validOptions({ providerRegistry: { resolve: "nope" } }))).toThrow(
      EnrichmentRunnerValidationError
    );
  });

  it("requires an explicit, valid now", () => {
    expect(() => assertValidRunnerConfig(validOptions({ now: undefined }))).toThrow(EnrichmentRunnerValidationError);
    expect(() => assertValidRunnerConfig(validOptions({ now: "2026-07-28" }))).toThrow(
      EnrichmentRunnerValidationError
    );
    expect(() => assertValidRunnerConfig(validOptions({ now: new Date(NaN) }))).toThrow(
      EnrichmentRunnerValidationError
    );
  });

  it("enforces batchSize bounds", () => {
    expect(() => assertValidRunnerConfig(validOptions({ batchSize: 0 }))).toThrow(EnrichmentRunnerValidationError);
    expect(() => assertValidRunnerConfig(validOptions({ batchSize: -1 }))).toThrow(EnrichmentRunnerValidationError);
    expect(() => assertValidRunnerConfig(validOptions({ batchSize: 1.5 }))).toThrow(EnrichmentRunnerValidationError);
    expect(() => assertValidRunnerConfig(validOptions({ batchSize: MAX_BATCH_SIZE + 1 }))).toThrow(
      EnrichmentRunnerValidationError
    );
    expect(assertValidRunnerConfig(validOptions({ batchSize: MIN_BATCH_SIZE })).batchSize).toBe(MIN_BATCH_SIZE);
    expect(assertValidRunnerConfig(validOptions({ batchSize: MAX_BATCH_SIZE })).batchSize).toBe(MAX_BATCH_SIZE);
  });

  it("enforces leaseDurationSeconds bounds", () => {
    expect(() => assertValidRunnerConfig(validOptions({ leaseDurationSeconds: 0 }))).toThrow(
      EnrichmentRunnerValidationError
    );
    expect(() =>
      assertValidRunnerConfig(validOptions({ leaseDurationSeconds: MAX_LEASE_SECONDS + 1 }))
    ).toThrow(EnrichmentRunnerValidationError);
    expect(
      assertValidRunnerConfig(validOptions({ leaseDurationSeconds: MIN_LEASE_SECONDS })).leaseMs
    ).toBe(MIN_LEASE_SECONDS * 1000);
  });

  it("requires ttlPolicy to be a function", () => {
    expect(() => assertValidRunnerConfig(validOptions({ ttlPolicy: null }))).toThrow(
      EnrichmentRunnerValidationError
    );
    expect(() => assertValidRunnerConfig(validOptions({ ttlPolicy: "resolveEnrichmentTtl" }))).toThrow(
      EnrichmentRunnerValidationError
    );
  });

  it("enforces workerId bounds", () => {
    expect(() => assertValidRunnerConfig(validOptions({ workerId: "" }))).toThrow(EnrichmentRunnerValidationError);
    expect(() => assertValidRunnerConfig(validOptions({ workerId: "   " }))).toThrow(
      EnrichmentRunnerValidationError
    );
    expect(() => assertValidRunnerConfig(validOptions({ workerId: " worker-1" }))).toThrow(
      EnrichmentRunnerValidationError
    );
    expect(() => assertValidRunnerConfig(validOptions({ workerId: "worker\n1" }))).toThrow(
      EnrichmentRunnerValidationError
    );
    expect(() => assertValidRunnerConfig(validOptions({ workerId: "w".repeat(MAX_WORKER_ID_LENGTH + 1) }))).toThrow(
      EnrichmentRunnerValidationError
    );
    expect(assertValidRunnerConfig(validOptions({ workerId: "w".repeat(MAX_WORKER_ID_LENGTH) })).workerId).toBe(
      "w".repeat(MAX_WORKER_ID_LENGTH)
    );
  });

  it("rejects a malformed signal but accepts a well-shaped one or none", () => {
    expect(() => assertValidRunnerConfig(validOptions({ signal: {} }))).toThrow(EnrichmentRunnerValidationError);
    expect(() => assertValidRunnerConfig(validOptions({ signal: { aborted: "no" } }))).toThrow(
      EnrichmentRunnerValidationError
    );
    expect(assertValidRunnerConfig(validOptions({ signal: undefined })).signal).toBeNull();
    const controller = new AbortController();
    expect(assertValidRunnerConfig(validOptions({ signal: controller.signal })).signal).toBe(controller.signal);
  });
});

describe("enrichmentRunnerTypes — isAborted", () => {
  it("is false for null/undefined and a non-aborted signal", () => {
    expect(isAborted(null)).toBe(false);
    expect(isAborted(undefined)).toBe(false);
    const controller = new AbortController();
    expect(isAborted(controller.signal)).toBe(false);
  });

  it("is true once the signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAborted(controller.signal)).toBe(true);
  });
});

describe("enrichmentRunnerTypes — buildJobResult", () => {
  it("builds a closed, frozen result with exactly the allow-listed fields", () => {
    const result = buildJobResult({
      enrichmentId: 7,
      provider: "mock",
      indicatorType: "IPV4",
      indicator: "198.18.0.1",
      outcome: RUNNER_OUTCOME.COMPLETED,
      terminalStatus: "SUCCESS",
      queriedAt: T0,
      expiresAt: new Date(T0.getTime() + 1000),
    });
    expect(Object.keys(result).sort()).toEqual(
      ["enrichmentId", "expiresAt", "indicator", "indicatorType", "outcome", "provider", "queriedAt", "terminalStatus"].sort()
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty("claimToken");
    expect(result).not.toHaveProperty("activeCacheKey");
  });

  it("clones Date fields rather than sharing the caller's instance", () => {
    const queriedAt = new Date(T0.getTime());
    const result = buildJobResult({
      enrichmentId: 1,
      provider: "mock",
      indicatorType: "IPV4",
      indicator: "198.18.0.1",
      outcome: RUNNER_OUTCOME.COMPLETED,
      terminalStatus: "SUCCESS",
      queriedAt,
      expiresAt: null,
    });
    queriedAt.setFullYear(1999);
    expect(result.queriedAt.getFullYear()).toBe(2026);
  });

  it("rejects an outcome outside the closed taxonomy", () => {
    expect(() =>
      buildJobResult({
        enrichmentId: 1,
        provider: "mock",
        indicatorType: "IPV4",
        indicator: "198.18.0.1",
        outcome: "MADE_UP_OUTCOME",
      })
    ).toThrow(EnrichmentRunnerValidationError);
  });

  it("rejects a non-positive-integer enrichmentId", () => {
    expect(() => buildJobResult({ enrichmentId: 0, provider: "mock", indicatorType: "IPV4", indicator: "x", outcome: RUNNER_OUTCOME.SKIPPED_NOT_CLAIMED })).toThrow(
      EnrichmentRunnerValidationError
    );
  });
});

describe("enrichmentRunnerTypes — buildBatchSummary", () => {
  it("derives exact counts from the results array, never tracked separately", () => {
    const results = [
      buildJobResult({ enrichmentId: 1, provider: "mock", indicatorType: "IPV4", indicator: "a", outcome: RUNNER_OUTCOME.COMPLETED, terminalStatus: "SUCCESS", queriedAt: T0, expiresAt: T0 }),
      buildJobResult({ enrichmentId: 2, provider: "mock", indicatorType: "IPV4", indicator: "b", outcome: RUNNER_OUTCOME.COMPLETED, terminalStatus: "SUCCESS", queriedAt: T0, expiresAt: T0 }),
      buildJobResult({ enrichmentId: 3, provider: "mock", indicatorType: "IPV4", indicator: "c", outcome: RUNNER_OUTCOME.COMPLETED, terminalStatus: "NOT_FOUND", queriedAt: T0, expiresAt: T0 }),
      buildJobResult({ enrichmentId: 4, provider: "mock", indicatorType: "IPV4", indicator: "d", outcome: RUNNER_OUTCOME.SKIPPED_NOT_CLAIMED }),
      buildJobResult({ enrichmentId: 5, provider: "mock", indicatorType: "IPV4", indicator: "e", outcome: RUNNER_OUTCOME.RELEASED_AFTER_INTERNAL_ERROR }),
      buildJobResult({ enrichmentId: 6, provider: "mock", indicatorType: "IPV4", indicator: "f", outcome: RUNNER_OUTCOME.RELEASED_AFTER_CANCELLATION }),
      buildJobResult({ enrichmentId: 7, provider: "mock", indicatorType: "IPV4", indicator: "g", outcome: RUNNER_OUTCOME.STALE_CLAIM_ON_COMPLETION }),
      buildJobResult({ enrichmentId: 8, provider: "ghost", indicatorType: "IPV4", indicator: "h", outcome: RUNNER_OUTCOME.UNKNOWN_PROVIDER }),
      buildJobResult({ enrichmentId: 9, provider: "mock", indicatorType: "IPV4", indicator: "i", outcome: RUNNER_OUTCOME.CLAIM_FAILED }),
      buildJobResult({ enrichmentId: 10, provider: "mock", indicatorType: "IPV4", indicator: "j", outcome: RUNNER_OUTCOME.COMPLETION_FAILED }),
      buildJobResult({ enrichmentId: 11, provider: "mock", indicatorType: "IPV4", indicator: "k", outcome: RUNNER_OUTCOME.RELEASE_FAILED }),
    ];

    const summary = buildBatchSummary({ requestedBatchSize: 25, candidateCount: 11, cancelled: false, results });

    expect(summary.requestedBatchSize).toBe(25);
    expect(summary.candidateCount).toBe(11);
    expect(summary.completedCount).toBe(3);
    expect(summary.statusCounts).toEqual({ SUCCESS: 2, NOT_FOUND: 1 });
    expect(summary.skippedNotClaimedCount).toBe(1);
    // released: internal-error + cancellation + unknown-provider = 3
    expect(summary.releasedCount).toBe(3);
    expect(summary.staleCompletionCount).toBe(1);
    // internal failures: claim-failed + released-after-internal-error + completion-failed + release-failed = 4
    expect(summary.internalFailureCount).toBe(4);
    expect(summary.unknownProviderCount).toBe(1);
    // claimed: everything except SKIPPED_NOT_CLAIMED and CLAIM_FAILED = 9
    expect(summary.claimedCount).toBe(9);
    expect(summary.cancelled).toBe(false);
    expect(summary.results).toHaveLength(11);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.results)).toBe(true);
    expect(Object.isFrozen(summary.statusCounts)).toBe(true);
  });

  it("produces all-zero counts for an empty batch", () => {
    const summary = buildBatchSummary({ requestedBatchSize: 10, candidateCount: 0, cancelled: false, results: [] });
    expect(summary.claimedCount).toBe(0);
    expect(summary.completedCount).toBe(0);
    expect(summary.statusCounts).toEqual({});
    expect(summary.results).toHaveLength(0);
  });
});
