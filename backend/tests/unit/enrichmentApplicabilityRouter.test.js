import { describe, it, expect } from "vitest";

// Phase 10A-1 — the applicability router's full decision table.
//
// The router is the single place that decides whether outbound work should
// exist. These tests pin every branch AND the precedence between them, because
// precedence is where a plausible-looking reordering changes what an operator
// is told (e.g. reporting a budget refusal for a subject that already had a
// fresh answer).

const {
  routeTarget,
  routeTargets,
} = require("../../src/services/enrichmentOrchestration/enrichmentApplicabilityRouter");
const {
  RUN_ITEM_DECISIONS,
  SKIP_REASONS,
  QUOTA_LANES,
} = require("../../src/services/enrichmentOrchestration/enrichmentDecisionCodes");

// A context that routes to ELIGIBLE; each test perturbs exactly one field.
const eligible = () => ({
  provider: "censys",
  subjectType: "IPV4",
  subjectValue: "198.18.0.4",
  lane: QUOTA_LANES.MANUAL,
  credentialConfigured: true,
  laneDailyBudget: null, // unlimited
  hasFreshResult: false,
  force: false,
});

describe("enrichmentApplicabilityRouter — decisions", () => {
  it("routes a fully satisfied target to ELIGIBLE with no skip reason", () => {
    expect(routeTarget(eligible())).toEqual({
      decision: RUN_ITEM_DECISIONS.ELIGIBLE,
      skipReason: null,
    });
  });

  it("refuses a provider/subject category error", () => {
    expect(routeTarget({ ...eligible(), subjectType: "CVE" })).toEqual({
      decision: RUN_ITEM_DECISIONS.SKIPPED_UNSUPPORTED_SUBJECT,
      skipReason: SKIP_REASONS.PROVIDER_SUBJECT_MISMATCH,
    });
    expect(routeTarget({ ...eligible(), provider: "nvd" })).toEqual({
      decision: RUN_ITEM_DECISIONS.SKIPPED_UNSUPPORTED_SUBJECT,
      skipReason: SKIP_REASONS.PROVIDER_SUBJECT_MISMATCH,
    });
  });

  it("treats an unknown provider as a category error, not as ELIGIBLE", () => {
    expect(routeTarget({ ...eligible(), provider: "virustotal" }).decision).toBe(
      RUN_ITEM_DECISIONS.SKIPPED_UNSUPPORTED_SUBJECT
    );
  });

  it("distinguishes a missing credential from a disabled provider", () => {
    expect(routeTarget({ ...eligible(), credentialConfigured: false })).toEqual({
      decision: RUN_ITEM_DECISIONS.SKIPPED_NOT_CONFIGURED,
      skipReason: SKIP_REASONS.PROVIDER_NOT_CONFIGURED,
    });
  });

  it("skips a subject that already has a fresh answer", () => {
    expect(routeTarget({ ...eligible(), hasFreshResult: true })).toEqual({
      decision: RUN_ITEM_DECISIONS.SKIPPED_CACHED,
      skipReason: SKIP_REASONS.FRESH_RESULT_EXISTS,
    });
  });

  it("refuses a KNOWN-ZERO automatic budget at routing time", () => {
    expect(
      routeTarget({ ...eligible(), lane: QUOTA_LANES.AUTOMATIC, laneDailyBudget: 0 })
    ).toEqual({
      decision: RUN_ITEM_DECISIONS.SKIPPED_BUDGET,
      skipReason: SKIP_REASONS.AUTOMATIC_BUDGET_ZERO,
    });
  });

  it("reports a zero MANUAL budget against the lane the operator configured", () => {
    expect(routeTarget({ ...eligible(), lane: QUOTA_LANES.MANUAL, laneDailyBudget: 0 })).toEqual({
      decision: RUN_ITEM_DECISIONS.SKIPPED_BUDGET,
      skipReason: SKIP_REASONS.MANUAL_BUDGET_ZERO,
    });
  });

  it("treats a POSITIVE budget as eligible — routing never spends it", () => {
    // The atomic reservation that actually spends budget happens at execution
    // time (10A-2). A positive budget must therefore produce a job, which may
    // LATER be refused with job.state = SKIPPED_BUDGET. Conflating the two is
    // exactly what Codex amendment 1 forbids.
    expect(routeTarget({ ...eligible(), laneDailyBudget: 5 }).decision).toBe(
      RUN_ITEM_DECISIONS.ELIGIBLE
    );
  });

  it("treats a null budget as unlimited", () => {
    expect(routeTarget({ ...eligible(), laneDailyBudget: null }).decision).toBe(
      RUN_ITEM_DECISIONS.ELIGIBLE
    );
  });
});

describe("enrichmentApplicabilityRouter — precedence and force", () => {
  it("reports freshness ahead of a zero budget when both apply", () => {
    const decision = routeTarget({
      ...eligible(),
      lane: QUOTA_LANES.AUTOMATIC,
      laneDailyBudget: 0,
      hasFreshResult: true,
    });
    expect(decision.skipReason).toBe(SKIP_REASONS.FRESH_RESULT_EXISTS);
  });

  it("reports a missing credential ahead of freshness", () => {
    const decision = routeTarget({
      ...eligible(),
      credentialConfigured: false,
      hasFreshResult: true,
    });
    expect(decision.skipReason).toBe(SKIP_REASONS.PROVIDER_NOT_CONFIGURED);
  });

  it("reports a category error ahead of everything else", () => {
    const decision = routeTarget({
      ...eligible(),
      subjectType: "CVE",
      credentialConfigured: false,
      hasFreshResult: true,
      laneDailyBudget: 0,
    });
    expect(decision.skipReason).toBe(SKIP_REASONS.PROVIDER_SUBJECT_MISMATCH);
  });

  it("lets force bypass freshness ONLY", () => {
    expect(routeTarget({ ...eligible(), hasFreshResult: true, force: true }).decision).toBe(
      RUN_ITEM_DECISIONS.ELIGIBLE
    );
    // force must not buy past a missing credential...
    expect(
      routeTarget({ ...eligible(), credentialConfigured: false, force: true }).decision
    ).toBe(RUN_ITEM_DECISIONS.SKIPPED_NOT_CONFIGURED);
    // ...nor past a zero budget...
    expect(
      routeTarget({ ...eligible(), lane: QUOTA_LANES.AUTOMATIC, laneDailyBudget: 0, force: true })
        .decision
    ).toBe(RUN_ITEM_DECISIONS.SKIPPED_BUDGET);
    // ...nor past a category error.
    expect(routeTarget({ ...eligible(), subjectType: "CVE", force: true }).decision).toBe(
      RUN_ITEM_DECISIONS.SKIPPED_UNSUPPORTED_SUBJECT
    );
  });
});

describe("enrichmentApplicabilityRouter — input handling", () => {
  it("throws on a malformed lane, which is a programming error not a data condition", () => {
    expect(() => routeTarget({ ...eligible(), lane: "SOMETHING" })).toThrow(TypeError);
    expect(() => routeTarget(null)).toThrow(TypeError);
  });

  it("routes a list while preserving order", () => {
    const routed = routeTargets([
      { ...eligible(), provider: "censys" },
      { ...eligible(), provider: "shodan", credentialConfigured: false },
    ]);
    expect(routed.map((r) => r.decision)).toEqual([
      RUN_ITEM_DECISIONS.ELIGIBLE,
      RUN_ITEM_DECISIONS.SKIPPED_NOT_CONFIGURED,
    ]);
    expect(routed[0].provider).toBe("censys");
  });
});
