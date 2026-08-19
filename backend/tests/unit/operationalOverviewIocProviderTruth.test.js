"use strict";

// Regression: the operational overview must not label the IOC reputation
// provider "mock" while the execution path is contacting the real AbuseIPDB
// API and spending its quota.
//
// THE DEFECT THIS PINS
// --------------------
// `IOC_ENRICHMENT_PROVIDER` looks like an execution selector but is read by NO
// execution path in this repository:
//
//   - enrichmentRunService.establishDelegate() builds the AbuseIPDB delegate
//     identity with a hardcoded `provider: "abuseipdb"`;
//   - enrichmentRunner resolves the adapter from the STORED row
//     (`providerRegistry.resolve(record.provider)`);
//   - enrichmentBatchController likewise uses `job.provider`;
//   - enrichmentRuntime documents that an unregistered name resolves to
//     nothing rather than silently falling back to MockProvider.
//
// It is set by seedDemo.js and asserted on by the canary preflight, and it was
// ALSO read by operationalOverviewService to decide the panel's status. So a
// deployment with a real ABUSEIPDB_API_KEY and the default
// IOC_ENRICHMENT_PROVIDER=mock reported "Mock provider" on the operational
// overview (Settings.jsx renders MOCK_PROVIDER as "Mock provider") while real,
// metered AbuseIPDB lookups were being performed and stored. A mock label over
// real third-party evidence is the same class of defect as a real label over
// mock evidence, and this panel exists precisely to prevent it.
//
// This file needs its own environment because operationalOverviewService reads
// `src/config/env` once at module load, so the key-present case cannot be
// expressed in the main suite (which pins ABUSEIPDB_API_KEY to "").

import { describe, it, expect, vi } from "vitest";

// The defect's exact shape: a real key present AND the vestigial selector
// still saying "mock". Set before the service (and src/config/env) is required.
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET: "a-reasonably-strong-32-char-plus-secret-value",
  CORS_ORIGIN: "http://localhost:5173",
  IOC_ENRICHMENT_PROVIDER: "mock",
  ABUSEIPDB_API_KEY: "not-a-real-key-only-presence-is-read",
  NVD_API_KEY: "",
  AI_ENABLED: "false",
  AI_PROVIDER: "null",
});

const {
  buildOperationalOverview,
} = require("../../src/services/dashboard/operationalOverviewService");

const ASOF = new Date("2026-08-03T12:00:00.000Z");

function makeClient() {
  const zeroCount = vi.fn(async () => 0);
  const emptyGroup = vi.fn(async () => []);
  const emptyList = () => vi.fn(async () => []);
  const noMax = () => vi.fn(async () => ({ _max: { queriedAt: null } }));

  return {
    finding: { count: zeroCount, groupBy: emptyGroup, findMany: emptyList() },
    findingOccurrence: { groupBy: emptyGroup },
    riskScore: { groupBy: emptyGroup, count: zeroCount, findMany: emptyList() },
    rawReport: { count: zeroCount },
    case: { count: zeroCount, groupBy: emptyGroup, findMany: emptyList() },
    caseClosureRequest: { count: zeroCount, findMany: emptyList() },
    caseOrganizationResponse: { count: zeroCount },
    caseRecurrenceReopen: { count: zeroCount },
    caseLifecycleEvent: { findMany: emptyList() },
    notification: { count: zeroCount, groupBy: emptyGroup, findMany: emptyList() },
    notificationExport: { count: zeroCount },
    notificationDeliveryEvent: { count: zeroCount, groupBy: emptyGroup },
    riskFactorContribution: { groupBy: emptyGroup },
    caseFrameworkMapping: { count: zeroCount, groupBy: emptyGroup },
    aiFrameworkMappingSuggestion: { count: zeroCount },
    iocEnrichment: { aggregate: noMax() },
    vulnerabilityProviderResult: { groupBy: emptyGroup },
    censysEnrichment: { aggregate: noMax() },
    greyNoiseEnrichment: { aggregate: noMax() },
    shodanEnrichment: { aggregate: noMax() },
    netlasEnrichment: { aggregate: noMax() },
  };
}

describe("operationalOverviewService — IOC reputation provider truth", () => {
  it("never reports MOCK_PROVIDER when a real AbuseIPDB key is configured", async () => {
    const result = await buildOperationalOverview({
      role: "ADMIN",
      asOf: ASOF,
      client: makeClient(),
    });

    const ioc = result.sections.providers.ioc;

    // The assertion that fails against the old code: with
    // IOC_ENRICHMENT_PROVIDER=mock the panel used to answer MOCK_PROVIDER here.
    expect(ioc.status).toBe("CONFIGURED");
    expect(ioc.status).not.toBe("MOCK_PROVIDER");

    // And it names the provider the execution path actually asks, not the
    // selector's value.
    expect(ioc.selected).toBe("abuseipdb");
    expect(ioc.selected).not.toBe("mock");
  });

  // The complementary no-key branch (blank ABUSEIPDB_API_KEY ->
  // NOT_CONFIGURED, still never MOCK_PROVIDER) is asserted in
  // operationalOverviewService.test.js, whose module-level environment already
  // pins ABUSEIPDB_API_KEY to "". src/config/env resolves once at first
  // require, so the two branches genuinely need two files rather than one file
  // trying to re-resolve a frozen config.
});
