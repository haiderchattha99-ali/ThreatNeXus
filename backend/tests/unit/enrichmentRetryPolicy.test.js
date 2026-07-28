import { describe, it, expect } from "vitest";

const {
  EnrichmentRetryPolicyError,
  FAILURE_CLASS,
  RETRY_ACTION,
  MIN_DELAY_SECONDS,
  MAX_DELAY_SECONDS,
  DEFAULT_PROVIDER_ERROR_BASE_DELAY_SECONDS,
  DEFAULT_UNKNOWN_PROVIDER_DELAY_SECONDS,
  DEFAULT_CANCELLATION_DELAY_SECONDS,
  DEFAULT_MAX_BACKOFF_SECONDS,
  resolveEnrichmentRetry,
} = require("../../src/services/enrichment/enrichmentRetryPolicy");
const {
  ENRICHMENT_STATUS,
} = require("../../src/services/enrichment/iocEnrichmentTypes");
const {
  ENRICHMENT_TERMINAL_REASON,
  MIN_MAX_ATTEMPTS,
  MAX_MAX_ATTEMPTS,
} = require("../../src/services/enrichment/iocEnrichmentCacheRules");

// SCOPE NOTE: this module is pure — no Prisma, no provider, no wall clock.
// Every assertion below therefore pins an EXACT value against an explicit
// `now`, not a range or an approximation.

const T0 = new Date("2026-07-28T12:00:00.000Z");

function decide(overrides = {}) {
  return resolveEnrichmentRetry({
    failureClass: FAILURE_CLASS.PROVIDER_PROGRAMMER_ERROR,
    currentAttemptCount: 1,
    maxAttempts: 3,
    now: T0,
    ...overrides,
  });
}

describe("enrichmentRetryPolicy — expected provider results complete", () => {
  it("completes every terminal provider status, positive and negative alike", () => {
    const terminalStatuses = [
      ENRICHMENT_STATUS.SUCCESS,
      ENRICHMENT_STATUS.NOT_FOUND,
      ENRICHMENT_STATUS.RATE_LIMITED,
      ENRICHMENT_STATUS.INVALID_KEY,
      ENRICHMENT_STATUS.TIMEOUT,
      ENRICHMENT_STATUS.FAILED,
      ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR,
      ENRICHMENT_STATUS.SKIPPED_DISABLED,
    ];
    terminalStatuses.forEach((status) => {
      const decision = decide({ failureClass: FAILURE_CLASS.EXPECTED_PROVIDER_RESULT, status });
      expect(decision.action).toBe(RETRY_ACTION.COMPLETE);
      expect(decision.nextAttemptAt).toBeNull();
      expect(decision.delaySeconds).toBeNull();
      expect(decision.terminalReasonCode).toBeNull();
      expect(decision.policyReason).toBe(`${status}_COMPLETE`);
    });
  });

  it("completes an expected provider result even on the final allowed attempt", () => {
    // A negative provider result is evidence, not a failed attempt — the
    // attempt budget must never turn it into a dead letter.
    const decision = decide({
      failureClass: FAILURE_CLASS.EXPECTED_PROVIDER_RESULT,
      status: ENRICHMENT_STATUS.TIMEOUT,
      currentAttemptCount: 3,
      maxAttempts: 3,
    });
    expect(decision.action).toBe(RETRY_ACTION.COMPLETE);
  });

  it("rejects PENDING as a provider result", () => {
    expect(() =>
      decide({ failureClass: FAILURE_CLASS.EXPECTED_PROVIDER_RESULT, status: ENRICHMENT_STATUS.PENDING })
    ).toThrow(EnrichmentRetryPolicyError);
  });

  it("rejects DEAD_LETTER and any non-provider status as a provider result", () => {
    expect(() =>
      decide({ failureClass: FAILURE_CLASS.EXPECTED_PROVIDER_RESULT, status: "DEAD_LETTER" })
    ).toThrow(EnrichmentRetryPolicyError);
    expect(() =>
      decide({ failureClass: FAILURE_CLASS.EXPECTED_PROVIDER_RESULT, status: null })
    ).toThrow(EnrichmentRetryPolicyError);
  });
});

describe("enrichmentRetryPolicy — unknown database state holds the lease", () => {
  it("holds for a completion database error, whatever the attempt count", () => {
    [0, 1, 2, 3, 9].forEach((currentAttemptCount) => {
      const decision = decide({
        failureClass: FAILURE_CLASS.COMPLETION_DATABASE_ERROR,
        currentAttemptCount,
        maxAttempts: 3,
      });
      expect(decision.action).toBe(RETRY_ACTION.HOLD_UNKNOWN_STATE);
      expect(decision.nextAttemptAt).toBeNull();
      expect(decision.terminalReasonCode).toBeNull();
      expect(decision.refundAttempt).toBe(false);
    });
  });

  it("never dead-letters an unknown completion state even past the budget", () => {
    const decision = decide({
      failureClass: FAILURE_CLASS.COMPLETION_DATABASE_ERROR,
      currentAttemptCount: 10,
      maxAttempts: 3,
    });
    expect(decision.action).not.toBe(RETRY_ACTION.DEAD_LETTER);
    expect(decision.action).toBe(RETRY_ACTION.HOLD_UNKNOWN_STATE);
  });

  it("holds for a release database error too", () => {
    const decision = decide({ failureClass: FAILURE_CLASS.RELEASE_DATABASE_ERROR });
    expect(decision.action).toBe(RETRY_ACTION.HOLD_UNKNOWN_STATE);
  });
});

describe("enrichmentRetryPolicy — cancellation", () => {
  it("releases with a short bounded delay and refunds the attempt", () => {
    const decision = decide({ failureClass: FAILURE_CLASS.CALLER_CANCELLATION });
    expect(decision.action).toBe(RETRY_ACTION.RELEASE_WITH_DELAY);
    expect(decision.delaySeconds).toBe(DEFAULT_CANCELLATION_DELAY_SECONDS);
    expect(decision.nextAttemptAt.getTime()).toBe(T0.getTime() + DEFAULT_CANCELLATION_DELAY_SECONDS * 1000);
    expect(decision.refundAttempt).toBe(true);
    expect(decision.terminalReasonCode).toBeNull();
  });

  it("NEVER dead-letters, even with the budget fully spent", () => {
    // An operator stopping a batch repeatedly must not permanently bury a
    // healthy job.
    const decision = decide({
      failureClass: FAILURE_CLASS.CALLER_CANCELLATION,
      currentAttemptCount: 3,
      maxAttempts: 3,
    });
    expect(decision.action).toBe(RETRY_ACTION.RELEASE_WITH_DELAY);
    expect(decision.refundAttempt).toBe(true);
  });
});

describe("enrichmentRetryPolicy — attempt boundaries", () => {
  it("backs off below the budget and dead-letters exactly AT it (provider error)", () => {
    const below = decide({ currentAttemptCount: 2, maxAttempts: 3 });
    expect(below.action).toBe(RETRY_ACTION.RELEASE_WITH_DELAY);
    expect(below.terminalReasonCode).toBeNull();

    const at = decide({ currentAttemptCount: 3, maxAttempts: 3 });
    expect(at.action).toBe(RETRY_ACTION.DEAD_LETTER);
    expect(at.terminalReasonCode).toBe(ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_PROVIDER_ERROR);
    expect(at.nextAttemptAt).toBeNull();

    const past = decide({ currentAttemptCount: 4, maxAttempts: 3 });
    expect(past.action).toBe(RETRY_ACTION.DEAD_LETTER);
  });

  it("dead-letters an unknown provider at the budget with its own reason code", () => {
    const below = decide({ failureClass: FAILURE_CLASS.UNKNOWN_PROVIDER, currentAttemptCount: 1, maxAttempts: 3 });
    expect(below.action).toBe(RETRY_ACTION.RELEASE_WITH_DELAY);
    expect(below.delaySeconds).toBe(DEFAULT_UNKNOWN_PROVIDER_DELAY_SECONDS);

    const at = decide({ failureClass: FAILURE_CLASS.UNKNOWN_PROVIDER, currentAttemptCount: 3, maxAttempts: 3 });
    expect(at.action).toBe(RETRY_ACTION.DEAD_LETTER);
    expect(at.terminalReasonCode).toBe(ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_UNKNOWN_PROVIDER);
  });

  it("dead-letters a completion validation error at the budget with its own reason code", () => {
    const below = decide({
      failureClass: FAILURE_CLASS.COMPLETION_VALIDATION_ERROR,
      currentAttemptCount: 1,
      maxAttempts: 3,
    });
    expect(below.action).toBe(RETRY_ACTION.RELEASE_WITH_DELAY);

    const at = decide({
      failureClass: FAILURE_CLASS.COMPLETION_VALIDATION_ERROR,
      currentAttemptCount: 3,
      maxAttempts: 3,
    });
    expect(at.action).toBe(RETRY_ACTION.DEAD_LETTER);
    expect(at.terminalReasonCode).toBe(ENRICHMENT_TERMINAL_REASON.MAX_ATTEMPTS_COMPLETION_VALIDATION);
  });

  it("dead-letters on the very first attempt when maxAttempts is 1", () => {
    const decision = decide({ currentAttemptCount: 1, maxAttempts: MIN_MAX_ATTEMPTS });
    expect(decision.action).toBe(RETRY_ACTION.DEAD_LETTER);
  });
});

describe("enrichmentRetryPolicy — bounded, deterministic delays", () => {
  it("doubles the provider-error delay per attempt, deterministically", () => {
    expect(decide({ currentAttemptCount: 1, maxAttempts: 9 }).delaySeconds).toBe(
      DEFAULT_PROVIDER_ERROR_BASE_DELAY_SECONDS
    );
    expect(decide({ currentAttemptCount: 2, maxAttempts: 9 }).delaySeconds).toBe(
      DEFAULT_PROVIDER_ERROR_BASE_DELAY_SECONDS * 2
    );
    expect(decide({ currentAttemptCount: 3, maxAttempts: 9 }).delaySeconds).toBe(
      DEFAULT_PROVIDER_ERROR_BASE_DELAY_SECONDS * 4
    );
  });

  it("caps the exponential growth rather than letting it run away", () => {
    const decision = decide({ currentAttemptCount: 9, maxAttempts: 10 });
    expect(decision.delaySeconds).toBe(DEFAULT_MAX_BACKOFF_SECONDS);
    expect(decision.delaySeconds).toBeLessThanOrEqual(MAX_DELAY_SECONDS);
  });

  it("never produces a zero, negative or infinite delay", () => {
    const classes = [
      FAILURE_CLASS.CALLER_CANCELLATION,
      FAILURE_CLASS.PROVIDER_PROGRAMMER_ERROR,
      FAILURE_CLASS.UNKNOWN_PROVIDER,
      FAILURE_CLASS.COMPLETION_VALIDATION_ERROR,
    ];
    classes.forEach((failureClass) => {
      [0, 1, 2].forEach((currentAttemptCount) => {
        const decision = decide({ failureClass, currentAttemptCount, maxAttempts: 5 });
        expect(decision.delaySeconds).toBeGreaterThanOrEqual(MIN_DELAY_SECONDS);
        expect(decision.delaySeconds).toBeLessThanOrEqual(MAX_DELAY_SECONDS);
        expect(Number.isFinite(decision.delaySeconds)).toBe(true);
        // The whole point: the job cannot be eligible again immediately.
        expect(decision.nextAttemptAt.getTime()).toBeGreaterThan(T0.getTime());
      });
    });
  });

  it("is deterministic — the same input always yields the same instant", () => {
    const a = decide({ currentAttemptCount: 2, maxAttempts: 5 });
    const b = decide({ currentAttemptCount: 2, maxAttempts: 5 });
    expect(a.nextAttemptAt.getTime()).toBe(b.nextAttemptAt.getTime());
    expect(a.delaySeconds).toBe(b.delaySeconds);
  });

  it("derives nextAttemptAt from the explicit `now`, never the wall clock", () => {
    const farFuture = new Date("2099-01-01T00:00:00.000Z");
    const decision = decide({ now: farFuture, failureClass: FAILURE_CLASS.UNKNOWN_PROVIDER });
    expect(decision.nextAttemptAt.getTime()).toBe(
      farFuture.getTime() + DEFAULT_UNKNOWN_PROVIDER_DELAY_SECONDS * 1000
    );
  });
});

describe("enrichmentRetryPolicy — retryAfterSeconds", () => {
  it("extends a delay when the provider asks for longer", () => {
    const decision = decide({ currentAttemptCount: 1, maxAttempts: 5, retryAfterSeconds: 7200 });
    expect(decision.delaySeconds).toBe(7200);
  });

  it("never shortens the policy's own delay when the provider asks for less", () => {
    const decision = decide({ currentAttemptCount: 1, maxAttempts: 5, retryAfterSeconds: 1 });
    expect(decision.delaySeconds).toBe(DEFAULT_PROVIDER_ERROR_BASE_DELAY_SECONDS);
  });

  it("rounds a fractional retryAfterSeconds UP, never down", () => {
    const decision = decide({ currentAttemptCount: 1, maxAttempts: 5, retryAfterSeconds: 7200.2 });
    expect(decision.delaySeconds).toBe(7201);
  });

  it("clamps an extreme retryAfterSeconds to the absolute maximum", () => {
    const decision = decide({ currentAttemptCount: 1, maxAttempts: 5, retryAfterSeconds: 999999999 });
    expect(decision.delaySeconds).toBe(MAX_DELAY_SECONDS);
  });

  it("rejects a negative or non-finite retryAfterSeconds", () => {
    expect(() => decide({ retryAfterSeconds: -1 })).toThrow(EnrichmentRetryPolicyError);
    expect(() => decide({ retryAfterSeconds: Number.POSITIVE_INFINITY })).toThrow(EnrichmentRetryPolicyError);
    expect(() => decide({ retryAfterSeconds: "600" })).toThrow(EnrichmentRetryPolicyError);
  });
});

describe("enrichmentRetryPolicy — input validation", () => {
  it("rejects an unknown failure class", () => {
    expect(() => decide({ failureClass: "SOMETHING_ELSE" })).toThrow(EnrichmentRetryPolicyError);
    expect(() => decide({ failureClass: undefined })).toThrow(EnrichmentRetryPolicyError);
  });

  it("rejects a non-integer or negative currentAttemptCount", () => {
    expect(() => decide({ currentAttemptCount: -1 })).toThrow(EnrichmentRetryPolicyError);
    expect(() => decide({ currentAttemptCount: 1.5 })).toThrow(EnrichmentRetryPolicyError);
  });

  it("enforces maxAttempts bounds", () => {
    expect(() => decide({ maxAttempts: 0 })).toThrow(EnrichmentRetryPolicyError);
    expect(() => decide({ maxAttempts: MAX_MAX_ATTEMPTS + 1 })).toThrow(EnrichmentRetryPolicyError);
    expect(() => decide({ maxAttempts: MIN_MAX_ATTEMPTS })).not.toThrow();
    expect(() => decide({ maxAttempts: MAX_MAX_ATTEMPTS })).not.toThrow();
  });

  it("requires an explicit valid now", () => {
    expect(() => decide({ now: undefined })).toThrow(EnrichmentRetryPolicyError);
    expect(() => decide({ now: "2026-07-28" })).toThrow(EnrichmentRetryPolicyError);
    expect(() => decide({ now: new Date(NaN) })).toThrow(EnrichmentRetryPolicyError);
  });

  it("rejects an out-of-range policy override rather than clamping it", () => {
    expect(() => decide({ policyOverrides: { unknownProviderDelaySeconds: 1 } })).toThrow(
      EnrichmentRetryPolicyError
    );
    expect(() => decide({ policyOverrides: { maxBackoffSeconds: MAX_DELAY_SECONDS + 1 } })).toThrow(
      EnrichmentRetryPolicyError
    );
  });

  it("honours a valid policy override", () => {
    const decision = decide({
      failureClass: FAILURE_CLASS.UNKNOWN_PROVIDER,
      policyOverrides: { unknownProviderDelaySeconds: 600 },
    });
    expect(decision.delaySeconds).toBe(600);
  });

  it("returns a frozen decision", () => {
    const decision = decide();
    expect(Object.isFrozen(decision)).toBe(true);
  });
});
