"use strict";

// Phase 6.2 — the Risk v1 factor-pressure section of the operational overview.
//
// This is the ONE new dashboard visualization the phase adds, and these are the
// properties that make it defensible rather than decorative:
//
//   - it aggregates only CURRENT scores, so a heavily-rescored Finding cannot
//     dominate through its superseded history
//   - "contributed nothing" and "could not be measured" stay distinguishable,
//     because applicability is reported as three separate counts
//   - the denominator is returned AND defined, and it is a real count of
//     findings holding a current score
//   - it is a read: no write delegate is touched, and no provider is contacted
//   - it fails to RESTRICTED for a role without read:findings, never to zeros
//   - ownership confidence never appears as a factor
//
// The service is exercised through buildOperationalOverview with an injected
// client, so the real capability gate and the real section-isolation wrapper
// run — not a hand-rolled approximation of them.

import { describe, it, expect, vi } from "vitest";

// Constructed before src/config/env is first required. tests/setup.js disables
// the dotenv load, so nothing here is inherited from the developer's
// backend/.env (which on this machine holds live provider keys).
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET: "a-reasonably-strong-32-char-plus-secret-value",
  CORS_ORIGIN: "http://localhost:5173",
  IOC_ENRICHMENT_PROVIDER: "mock",
  ABUSEIPDB_API_KEY: "",
  NVD_API_KEY: "",
  AI_ENABLED: "false",
  AI_PROVIDER: "null",
});

const {
  buildOperationalOverview,
  RISK_FACTOR_APPLICABILITY,
} = require("../../src/services/dashboard/operationalOverviewService");

const ASOF = new Date("2026-08-04T09:00:00.000Z");

// Two findings' worth of contributions, deliberately covering all three
// applicability values and both a real contribution and a zero one.
const CONTRIBUTION_ROWS = [
  {
    factorKey: "exposureCriticality",
    applicability: "APPLIED",
    _count: { _all: 2 },
    _sum: { contributionBasisPoints: 3000, maximumContributionBasisPoints: 3000 },
    _min: { displayOrder: 2 },
  },
  {
    factorKey: "sourceSeverity",
    applicability: "APPLIED",
    _count: { _all: 2 },
    _sum: { contributionBasisPoints: 1600, maximumContributionBasisPoints: 1600 },
    _min: { displayOrder: 1 },
  },
  {
    // Measured, and the measurement was zero.
    factorKey: "recurrence",
    applicability: "APPLIED",
    _count: { _all: 2 },
    _sum: { contributionBasisPoints: 0, maximumContributionBasisPoints: 2600 },
    _min: { displayOrder: 4 },
  },
  {
    // Could not be measured. Also zero basis points — and that is exactly why
    // it must not be collapsed with the row above.
    factorKey: "iocReputationContext",
    applicability: "NOT_AVAILABLE",
    _count: { _all: 2 },
    _sum: { contributionBasisPoints: 0, maximumContributionBasisPoints: 2400 },
    _min: { displayOrder: 6 },
  },
  {
    factorKey: "kevStatus",
    applicability: "NOT_APPLICABLE",
    _count: { _all: 2 },
    _sum: { contributionBasisPoints: 0, maximumContributionBasisPoints: 1600 },
    _min: { displayOrder: 9 },
  },
];

const WRITE_METHODS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
];

function makeClient({ contributionRows = CONTRIBUTION_ROWS, currentScores = 2, failFactors = false } = {}) {
  const writeCalls = [];
  const zeroCount = vi.fn(async () => 0);
  const emptyGroup = vi.fn(async () => []);
  const emptyList = () => vi.fn(async () => []);

  const factorGroupBy = vi.fn(async () => {
    if (failFactors) throw new Error("simulated aggregate failure");
    return contributionRows;
  });

  const client = {
    finding: { count: zeroCount, groupBy: emptyGroup, findMany: emptyList() },
    findingOccurrence: { groupBy: emptyGroup },
    riskScore: {
      groupBy: emptyGroup,
      // Only the current-score count matters here; every other riskScore read
      // in the overview is satisfied by the empty defaults.
      count: vi.fn(async ({ where } = {}) =>
        where && where.currentForFindingId ? currentScores : 0
      ),
      findMany: emptyList(),
    },
    riskFactorContribution: { groupBy: factorGroupBy },
    rawReport: { count: zeroCount },
    case: { count: zeroCount, groupBy: emptyGroup, findMany: emptyList() },
    caseClosureRequest: { count: zeroCount, findMany: emptyList() },
    caseOrganizationResponse: { count: zeroCount },
    caseRecurrenceReopen: { count: zeroCount },
    caseLifecycleEvent: { findMany: emptyList() },
    notification: { count: zeroCount, groupBy: emptyGroup, findMany: emptyList() },
    notificationExport: { count: zeroCount },
    notificationDeliveryEvent: { count: zeroCount, groupBy: emptyGroup },
    caseFrameworkMapping: { count: zeroCount, groupBy: emptyGroup },
    aiFrameworkMappingSuggestion: { count: zeroCount },
    iocEnrichment: { aggregate: vi.fn(async () => ({ _max: { queriedAt: null } })) },
    vulnerabilityProviderResult: { groupBy: emptyGroup },
    censysEnrichment: { aggregate: vi.fn(async () => ({ _max: { queriedAt: null } })) },
    greyNoiseEnrichment: { aggregate: vi.fn(async () => ({ _max: { queriedAt: null } })) },
  };

  // Every delegate also gets every write method, recording any call. Nothing in
  // this section may write.
  for (const [name, delegate] of Object.entries(client)) {
    for (const method of WRITE_METHODS) {
      delegate[method] = vi.fn(async () => {
        writeCalls.push(`${name}.${method}`);
        return {};
      });
    }
  }

  return { client, writeCalls, factorGroupBy };
}

async function pressureFor(role, options) {
  const { client, writeCalls, factorGroupBy } = makeClient(options);
  const overview = await buildOperationalOverview({ role, asOf: ASOF, client });
  return { section: overview.sections.riskFactorPressure, overview, writeCalls, factorGroupBy };
}

describe("Phase 6.2 risk factor pressure — aggregation", () => {
  it("aggregates by factor key and orders by the engine's own displayOrder", async () => {
    const { section } = await pressureFor("ANALYST");

    expect(section.availability).toBe("AVAILABLE");
    expect(section.factors.map((f) => f.factorKey)).toEqual([
      "sourceSeverity",
      "exposureCriticality",
      "recurrence",
      "iocReputationContext",
      "kevStatus",
    ]);
    // Ordering is the stored displayOrder, not alphabetical and not by size.
    expect(section.factors.map((f) => f.displayOrder)).toEqual([1, 2, 4, 6, 9]);
  });

  it("sums the persisted contribution and the persisted cap separately", async () => {
    const { section } = await pressureFor("ANALYST");
    const exposure = section.factors.find((f) => f.factorKey === "exposureCriticality");

    expect(exposure.contributionBasisPoints).toBe(3000);
    // The cap comes from the stored maximumContributionBasisPoints column, not
    // from the live configuration table — that is what keeps an old row
    // explicable after a future configuration version changes the cap.
    expect(exposure.maximumContributionBasisPoints).toBe(3000);

    expect(section.totals.contributionBasisPoints).toBe(4600);
    expect(section.totals.maximumContributionBasisPoints).toBe(11200);
  });

  it("keeps 'measured as zero' and 'could not be measured' distinguishable", async () => {
    const { section } = await pressureFor("ANALYST");
    const recurrence = section.factors.find((f) => f.factorKey === "recurrence");
    const reputation = section.factors.find((f) => f.factorKey === "iocReputationContext");
    const kev = section.factors.find((f) => f.factorKey === "kevStatus");

    // All three contribute zero basis points...
    expect(recurrence.contributionBasisPoints).toBe(0);
    expect(reputation.contributionBasisPoints).toBe(0);
    expect(kev.contributionBasisPoints).toBe(0);

    // ...and all three mean something different.
    expect(recurrence.applied).toBe(2);
    expect(recurrence.notAvailable).toBe(0);

    expect(reputation.applied).toBe(0);
    expect(reputation.notAvailable).toBe(2);

    expect(kev.applied).toBe(0);
    expect(kev.notApplicable).toBe(2);
  });

  it("returns a real denominator and states what it means", async () => {
    const { section } = await pressureFor("ANALYST", { currentScores: 2 });

    expect(section.denominator).toBe(2);
    expect(section.denominatorDefinition).toMatch(/currentForFindingId/i);
    expect(section.source).toMatch(/RiskFactorContribution/);
    expect(section.asOf).toBe(ASOF.toISOString());
  });

  it("restricts the aggregate to current scores only", async () => {
    const { factorGroupBy } = await pressureFor("ANALYST");

    const [args] = factorGroupBy.mock.calls[0];
    expect(args.where).toEqual({ riskScore: { currentForFindingId: { not: null } } });
    expect(args.by).toEqual(["factorKey", "applicability"]);
  });

  it("never presents ownership confidence as a risk factor", async () => {
    const { section } = await pressureFor("ANALYST");
    const keys = section.factors.map((f) => f.factorKey.toLowerCase());
    expect(keys.some((k) => k.includes("ownership"))).toBe(false);
    expect(JSON.stringify(section).toLowerCase()).not.toContain("ownershipconfidence");
  });

  it("exposes exactly the three applicability values the schema defines", () => {
    expect(RISK_FACTOR_APPLICABILITY).toEqual(["APPLIED", "NOT_AVAILABLE", "NOT_APPLICABLE"]);
  });
});

describe("Phase 6.2 risk factor pressure — integrity", () => {
  it("is a read: building the overview touches no write delegate", async () => {
    const { writeCalls } = await pressureFor("ADMIN");
    expect(writeCalls).toEqual([]);
  });

  it("performs no provider lookup", async () => {
    const { overview } = await pressureFor("ADMIN");
    expect(overview.sections.providers.liveLookupPerformed).toBe(false);
  });

  it("is available to every role that holds read:findings", async () => {
    for (const role of ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"]) {
      const { section } = await pressureFor(role);
      expect(section.availability, `role ${role}`).toBe("AVAILABLE");
    }
  });

  it("is RESTRICTED — not zeroed — for a role holding no capability", async () => {
    const { section } = await pressureFor("NOT_A_ROLE");

    expect(section.availability).toBe("RESTRICTED");
    expect(section.factors).toBeUndefined();
    expect(section.denominator).toBeUndefined();
    expect(section.reason).toMatch(/read:findings/);
  });

  it("is UNAVAILABLE — not zeroed — when its aggregate fails", async () => {
    const { section, overview } = await pressureFor("ADMIN", { failFactors: true });

    expect(section.availability).toBe("UNAVAILABLE");
    expect(section.factors).toBeUndefined();
    // Section isolation: one broken aggregate does not take the page down.
    expect(overview.sections.findings.availability).toBe("AVAILABLE");
  });

  it("returns an empty factor list rather than inventing rows for an empty dataset", async () => {
    const { section } = await pressureFor("ADMIN", { contributionRows: [], currentScores: 0 });

    expect(section.availability).toBe("AVAILABLE");
    expect(section.factors).toEqual([]);
    expect(section.denominator).toBe(0);
    expect(section.totals.contributionBasisPoints).toBe(0);
  });
});
