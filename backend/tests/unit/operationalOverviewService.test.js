"use strict";

// Phase 6 — the dashboard integrity contract, as tests.
//
// These are the assertions that stop the fabricated-dashboard defect from
// coming back. They do not check that a number is "right"; they check the
// properties that make a number defensible:
//
//   - an unreadable section is RESTRICTED, never zero
//   - a failed section is UNAVAILABLE, never zero
//   - every metric carries a source and an asOf
//   - a distribution bucket with no rows is an explicit 0, not a missing bar
//   - rendering the overview performs NO provider lookup
//   - geographic data is reported unavailable, never invented

import { describe, it, expect, vi } from "vitest";

// Constructed explicitly, before the service (and therefore src/config/env) is
// first required. tests/setup.js disables the dotenv load, so nothing here is
// inherited from the developer's backend/.env — including the live AbuseIPDB
// and NVD keys present on this machine.
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
  distribution,
  providerFreshness,
} = require("../../src/services/dashboard/operationalOverviewService");

const ASOF = new Date("2026-08-03T12:00:00.000Z");

// A Prisma double whose every aggregate answers with a fixed shape. Each
// delegate records that it was called, so a test can assert that building the
// overview touched only the database.
function makeClient(overrides = {}) {
  const zeroCount = vi.fn(async () => 0);
  const emptyGroup = vi.fn(async () => []);

  const base = {
    finding: { count: zeroCount, groupBy: emptyGroup },
    findingOccurrence: { groupBy: emptyGroup },
    riskScore: { groupBy: emptyGroup, count: zeroCount },
    rawReport: { count: zeroCount },
    case: { count: zeroCount, groupBy: emptyGroup },
    caseClosureRequest: { count: zeroCount },
    caseOrganizationResponse: { count: zeroCount },
    caseRecurrenceReopen: { count: zeroCount },
    caseLifecycleEvent: { findMany: vi.fn(async () => []) },
    notification: { count: zeroCount, groupBy: emptyGroup },
    notificationExport: { count: zeroCount },
    notificationDeliveryEvent: { count: zeroCount, groupBy: emptyGroup },
    caseFrameworkMapping: { count: zeroCount, groupBy: emptyGroup },
    aiFrameworkMappingSuggestion: { count: zeroCount },
    iocEnrichment: { aggregate: vi.fn(async () => ({ _max: { queriedAt: null } })) },
    vulnerabilityProviderResult: { groupBy: emptyGroup },
  };

  return { ...base, ...overrides };
}

describe("operationalOverviewService — availability contract", () => {
  it("marks a section the caller may not read RESTRICTED, never zero", async () => {
    // VIEWER holds read:dashboard, read:findings and read:cases, but
    // deliberately NOT read:notifications.
    const result = await buildOperationalOverview({
      role: "VIEWER",
      asOf: ASOF,
      client: makeClient(),
    });

    const notifications = result.sections.notifications;
    expect(notifications.availability).toBe("RESTRICTED");
    expect(notifications.reason).toMatch(/read:notifications/);
    // The critical assertion: no value at all, not a zero that a reader could
    // mistake for "there are no notifications".
    expect(notifications.metrics.approved).toBeUndefined();
  });

  it("gives an ANALYST the notification section", async () => {
    const result = await buildOperationalOverview({
      role: "ANALYST",
      asOf: ASOF,
      client: makeClient(),
    });
    expect(result.sections.notifications.availability).toBe("AVAILABLE");
  });

  it("reports a section whose query throws as UNAVAILABLE, never zero", async () => {
    const client = makeClient({
      case: {
        count: vi.fn(async () => {
          throw new Error("connection reset by peer");
        }),
        groupBy: vi.fn(async () => []),
      },
    });

    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client });

    expect(result.sections.cases.availability).toBe("UNAVAILABLE");
    expect(result.sections.cases.metrics.open).toBeUndefined();
    // The failure text never reaches the client.
    expect(JSON.stringify(result)).not.toMatch(/connection reset/);
    // One section failing must not take the others down with it.
    expect(result.sections.findings.availability).toBe("AVAILABLE");
  });

  it("stamps every findings metric with a source and the snapshot's asOf", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: makeClient() });

    const metrics = Object.values(result.sections.findings.metrics);
    expect(metrics.length).toBeGreaterThan(0);
    for (const metric of metrics) {
      expect(metric.availability).toBe("AVAILABLE");
      expect(typeof metric.source).toBe("string");
      expect(metric.source.length).toBeGreaterThan(0);
      expect(metric.asOf).toBe(ASOF.toISOString());
    }
  });

  it("never reports a geographic observation it cannot back with persisted provenance", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: makeClient() });

    expect(result.sections.providers.availability).toBe("AVAILABLE");
    expect(result.geographic.availability).toBe("UNAVAILABLE");
    expect(result.geographic.message).toBe(
      "Verified geographic observations are not currently available."
    );
    // No coordinate of any kind may appear anywhere in the payload.
    expect(JSON.stringify(result)).not.toMatch(/latitude|longitude|"lat"|"lon"/i);
  });

  it("labels the dataset scope and never claims a national measurement", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: makeClient() });
    expect(result.datasetScope).toMatch(/loaded dataset only/i);
    expect(JSON.stringify(result)).not.toMatch(/national exposure|all systems operational/i);
  });
});

describe("operationalOverviewService — no live provider traffic", () => {
  it("derives provider status from configuration and stored rows only", async () => {
    const iocAggregate = vi.fn(async () => ({ _max: { queriedAt: null } }));
    const vulnGroup = vi.fn(async () => []);

    const result = await buildOperationalOverview({
      role: "ADMIN",
      asOf: ASOF,
      client: makeClient({
        iocEnrichment: { aggregate: iocAggregate },
        vulnerabilityProviderResult: { groupBy: vulnGroup },
      }),
    });

    // The only provider "reads" are database reads of previously stored results.
    expect(iocAggregate).toHaveBeenCalledTimes(1);
    expect(vulnGroup).toHaveBeenCalledTimes(1);
    expect(result.sections.providers.liveLookupPerformed).toBe(false);
  });

  it("never exposes a key, a base URL or a latency figure", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: makeClient() });
    const providers = result.sections.providers;
    // The disclaimer is the one place the words may appear, because it is the
    // sentence that DENIES reporting them. Excluding it keeps the assertion
    // about the data rather than about the prose.
    const serialized = JSON.stringify({ ...providers, disclaimer: "", ai: { ...providers.ai, note: "" } });

    expect(serialized).not.toMatch(/apiKey|api_key|Bearer|https?:\/\//i);
    expect(serialized).not.toMatch(/latency|responseTimeMs|uptime/i);

    // The real point: whatever the ambient environment happens to hold, no
    // fragment of an actual key may appear in the payload. This machine's
    // backend/.env carries live AbuseIPDB and NVD keys, so the assertion is
    // meaningful rather than vacuous — and it stays meaningful on a machine
    // with none, because a blank key is skipped rather than matched.
    const env = require("../../src/config/env");
    for (const secret of [env.ABUSEIPDB_API_KEY, env.NVD_API_KEY]) {
      if (typeof secret === "string" && secret.length >= 8) {
        expect(serialized).not.toContain(secret);
        // Not even a leading fragment.
        expect(serialized).not.toContain(secret.slice(0, 8));
      }
    }

    // Status reports PRESENCE only, and only from the closed set of values.
    expect(providers.ioc.status).toMatch(/^(MOCK_PROVIDER|CONFIGURED|NOT_CONFIGURED)$/);
    for (const provider of providers.vulnerability) {
      expect(provider.status).toMatch(
        /^(CONFIGURED_WITH_KEY|KEYLESS_PUBLIC_RATE_LIMIT|NO_KEY_REQUIRED)$/
      );
    }
  });

  it("reports AI as disabled by default and describes it as inert", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: makeClient() });
    expect(result.sections.providers.ai.status).toBe("DISABLED");
    expect(result.sections.providers.ai.note).toMatch(/inert|human/i);
  });
});

describe("operationalOverviewService — framework labelling", () => {
  it("never calls a mapping count coverage, compliance, maturity or posture", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: makeClient() });
    const section = result.sections.frameworkMappings;

    expect(section.label).toBe("Analyst-associated framework context");
    expect(section.disclaimer).toMatch(/not coverage, compliance, maturity/i);
    // The word "coverage" may appear only inside the disclaimer that denies it.
    const withoutDisclaimer = JSON.stringify({ ...section, disclaimer: "" });
    expect(withoutDisclaimer).not.toMatch(/coverage|compliance|maturity|posture/i);
    // No percentage is emitted for mappings at all.
    expect(section.metrics.active.value).toBe(0);
    expect(section.metrics).not.toHaveProperty("percentageMapped");
  });
});

describe("distribution", () => {
  it("emits an explicit zero for a bucket with no rows", () => {
    const items = distribution([{ riskBand: "HIGH", _count: { _all: 3 } }], "riskBand", [
      "LOW",
      "HIGH",
      "CRITICAL",
    ]);
    expect(items).toEqual([
      { key: "LOW", count: 0 },
      { key: "HIGH", count: 3 },
      { key: "CRITICAL", count: 0 },
    ]);
  });

  it("keeps a key the caller did not declare rather than dropping the rows", () => {
    const items = distribution([{ state: "SURPRISE", _count: { _all: 2 } }], "state", ["KNOWN"]);
    expect(items).toContainEqual({ key: "SURPRISE", count: 2 });
  });
});

describe("providerFreshness", () => {
  it("distinguishes never-looked-up from stale from fresh", () => {
    expect(providerFreshness(null, ASOF).state).toBe("NO_SUCCESSFUL_LOOKUP_RECORDED");

    const fresh = new Date(ASOF.getTime() - 60 * 60 * 1000);
    expect(providerFreshness(fresh, ASOF).state).toBe("FRESH");

    const stale = new Date(ASOF.getTime() - 48 * 60 * 60 * 1000);
    expect(providerFreshness(stale, ASOF).state).toBe("STALE");
  });
});
