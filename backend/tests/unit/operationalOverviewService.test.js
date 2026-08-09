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
  QUEUE_LIMIT,
  TREND_WINDOW_DAYS,
  utcDayStart,
} = require("../../src/services/dashboard/operationalOverviewService");

const ASOF = new Date("2026-08-03T12:00:00.000Z");

// A Prisma double whose every aggregate answers with a fixed shape. Each
// delegate records that it was called, so a test can assert that building the
// overview touched only the database.
function makeClient(overrides = {}) {
  const zeroCount = vi.fn(async () => 0);
  const emptyGroup = vi.fn(async () => []);
  const emptyList = () => vi.fn(async () => []);

  const base = {
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
    // Phase 6.2 — factor pressure. Grouped by (factorKey, applicability) with
    // _sum/_count/_min, so the double must answer groupBy like the others.
    riskFactorContribution: { groupBy: emptyGroup },
    caseFrameworkMapping: { count: zeroCount, groupBy: emptyGroup },
    aiFrameworkMappingSuggestion: { count: zeroCount },
    iocEnrichment: { aggregate: vi.fn(async () => ({ _max: { queriedAt: null } })) },
    vulnerabilityProviderResult: { groupBy: emptyGroup },
    censysEnrichment: { aggregate: vi.fn(async () => ({ _max: { queriedAt: null } })) },
    greyNoiseEnrichment: { aggregate: vi.fn(async () => ({ _max: { queriedAt: null } })) },
    shodanEnrichment: { aggregate: vi.fn(async () => ({ _max: { queriedAt: null } })) },
    netlasEnrichment: { aggregate: vi.fn(async () => ({ _max: { queriedAt: null } })) },
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
    for (const secret of [env.ABUSEIPDB_API_KEY, env.NVD_API_KEY, env.CENSYS_PAT, env.GREYNOISE_API_KEY, env.SHODAN_API_KEY]) {
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
    for (const provider of providers.exposure) {
      expect(provider.status).toMatch(/^(CONFIGURED|NOT_CONFIGURED)$/);
    }
    for (const provider of providers.reputation) {
      expect(provider.status).toMatch(/^(CONFIGURED|NOT_CONFIGURED)$/);
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

// ---------------------------------------------------------------------------
// Phase 6.1 — attention queues, trend and audience
// ---------------------------------------------------------------------------

const FINDING_ROW = Object.freeze({
  id: 41,
  indicatorValue: "203.0.113.7",
  port: 3389,
  protocol: "TCP",
  reportType: "ACCESSIBLE_RDP",
  status: "OPEN",
  occurrenceCount: 4,
  recurrenceCount: 1,
  firstSeen: new Date("2026-07-28T00:00:00.000Z"),
  lastSeen: new Date("2026-08-02T00:00:00.000Z"),
});

const CASE_ROW = Object.freeze({
  id: 9,
  caseReference: "TNX-2026-000009",
  title: "Accessible RDP on a government range",
  lifecycleState: "WAITING_FOR_ORG",
  createdAt: new Date("2026-07-30T09:00:00.000Z"),
  updatedAt: new Date("2026-07-31T09:00:00.000Z"),
  ownerOrganization: { name: "Ministry of Example" },
});

function queueClient(extra = {}) {
  return makeClient({
    finding: {
      count: vi.fn(async () => 12),
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async () => [FINDING_ROW]),
    },
    riskScore: {
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async (args) => {
        // The triage-backlog lookup asks by currentForFindingId; the priority
        // query asks for the finding relation. Distinguish on that.
        if (args?.where?.currentForFindingId?.in) {
          return [
            {
              currentForFindingId: FINDING_ROW.id,
              scoreBasisPoints: 7350,
              riskBand: "HIGH",
              asOf: new Date("2026-08-02T10:00:00.000Z"),
            },
          ];
        }
        return [
          {
            scoreBasisPoints: 9120,
            riskBand: "CRITICAL",
            asOf: new Date("2026-08-02T10:00:00.000Z"),
            finding: FINDING_ROW,
          },
        ];
      }),
    },
    caseClosureRequest: {
      count: vi.fn(async () => 3),
      findMany: vi.fn(async () => [
        {
          id: 5,
          caseId: 9,
          closureReason: "REMEDIATED",
          requestedAt: new Date("2026-08-01T08:00:00.000Z"),
          case: CASE_ROW,
        },
      ]),
    },
    case: {
      count: vi.fn(async () => 2),
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async () => [CASE_ROW]),
    },
    notification: {
      count: vi.fn(async () => 1),
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async () => [
        {
          id: 77,
          notificationReference: "TNX-NOT-2026-000077",
          lifecycleState: "PENDING_REVIEW",
          createdAt: new Date("2026-08-01T12:00:00.000Z"),
          caseId: 9,
          case: { caseReference: "TNX-2026-000009" },
          ownerOrganization: { name: "Ministry of Example" },
        },
      ]),
    },
    ...extra,
  });
}

describe("operationalOverviewService — attention queues", () => {
  it("bounds every queue and orders it deterministically down to a unique tiebreaker", async () => {
    const client = queueClient();
    await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client });

    const listCalls = [
      ...client.riskScore.findMany.mock.calls,
      ...client.finding.findMany.mock.calls,
      ...client.case.findMany.mock.calls,
      ...client.caseClosureRequest.findMany.mock.calls,
      ...client.notification.findMany.mock.calls,
    ].map(([args]) => args);

    // Every listing query that carries an ordering is bounded and ends in a
    // unique column. (The one query without an ordering is the bounded
    // score lookup by id, which selects an already-unique set.)
    const ordered = listCalls.filter((args) => Array.isArray(args?.orderBy));
    expect(ordered.length).toBeGreaterThanOrEqual(5);
    for (const args of ordered) {
      expect(args.take).toBe(QUEUE_LIMIT);
      const last = args.orderBy[args.orderBy.length - 1];
      const tiebreaker = Object.keys(last)[0];
      expect(["id", "findingId"]).toContain(tiebreaker);
      // An explicit allowlist, never a bare findMany that returns whole rows.
      expect(args.select).toBeTruthy();
    }
  });

  it("reports the real total beside the bounded page, so 6 shown is never 6 exist", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: queueClient() });
    const q = result.sections.findingQueues;

    expect(q.availability).toBe("AVAILABLE");
    expect(q.limit).toBe(QUEUE_LIMIT);
    expect(q.priority.total).toBe(12);
    expect(q.priority.items.length).toBeLessThanOrEqual(QUEUE_LIMIT);
    expect(q.priority.source).toMatch(/RiskScore\.scoreBasisPoints/);
    expect(q.priority.asOf).toBe(ASOF.toISOString());
    expect(result.sections.caseQueues.closureReview.total).toBe(3);
    expect(result.sections.notificationQueue.awaitingReview.total).toBe(1);
  });

  it("publishes only allowlisted fields for a queued finding", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: queueClient() });
    const item = result.sections.findingQueues.priority.items[0];

    expect(Object.keys(item).sort()).toEqual(
      [
        "firstSeen",
        "id",
        "indicatorValue",
        "lastSeen",
        "occurrenceCount",
        "persistent",
        "port",
        "protocol",
        "recurred",
        "recurrenceCount",
        "reportType",
        "risk",
        "status",
      ].sort()
    );
    expect(item.risk.state).toBe("SCORED");
    expect(item.risk.band).toBe("CRITICAL");
    // floor(scoreBasisPoints / 100) — the same projection the Finding read
    // path uses. Nothing is rescored here.
    expect(item.risk.displayScore).toBe(91);
    expect(item.persistent).toBe(true);
    expect(item.recurred).toBe(true);
  });

  it("publishes only allowlisted fields for a queued case and notification", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: queueClient() });

    const caseItem = result.sections.caseQueues.waitingOnOrganization.items[0];
    expect(Object.keys(caseItem).sort()).toEqual(
      ["caseReference", "createdAt", "id", "lifecycleState", "organizationName", "title", "updatedAt"].sort()
    );

    const closure = result.sections.caseQueues.closureReview.items[0];
    // The analyst's written justification never reaches the dashboard.
    expect(closure).not.toHaveProperty("justification");
    expect(closure.case.caseReference).toBe("TNX-2026-000009");

    const notification = result.sections.notificationQueue.awaitingReview.items[0];
    // Constituent-addressed content stays on the notification screen.
    expect(notification).not.toHaveProperty("title");
    expect(notification).not.toHaveProperty("message");
    expect(notification.notificationReference).toBe("TNX-NOT-2026-000077");
  });

  it("marks a finding with no current score NOT_SCORED, never zero and never the lowest band", async () => {
    const client = queueClient({
      riskScore: {
        count: vi.fn(async () => 0),
        groupBy: vi.fn(async () => []),
        // No current score exists for anything.
        findMany: vi.fn(async () => []),
      },
    });
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client });
    const item = result.sections.findingQueues.awaitingTriage.items[0];

    expect(item.risk.state).toBe("NOT_SCORED");
    expect(item.risk.band).toBeNull();
    expect(item.risk.displayScore).toBeNull();
    expect(item.risk.scoreBasisPoints).toBeNull();
  });

  it("restricts the notification queue for VIEWER without zeroing it", async () => {
    const result = await buildOperationalOverview({ role: "VIEWER", asOf: ASOF, client: queueClient() });
    const q = result.sections.notificationQueue;

    expect(q.availability).toBe("RESTRICTED");
    expect(q.reason).toMatch(/read:notifications/);
    expect(q.awaitingReview).toBeUndefined();
    // The queues VIEWER may read are still there.
    expect(result.sections.findingQueues.availability).toBe("AVAILABLE");
    expect(result.sections.caseQueues.availability).toBe("AVAILABLE");
  });

  it("isolates a failing queue as UNAVAILABLE without taking the page down", async () => {
    const client = queueClient({
      caseClosureRequest: {
        count: vi.fn(async () => {
          throw new Error("relation \"CaseClosureRequest\" does not exist");
        }),
        findMany: vi.fn(async () => []),
      },
    });

    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client });

    expect(result.sections.caseQueues.availability).toBe("UNAVAILABLE");
    expect(result.sections.caseQueues.closureReview).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/does not exist/);
    expect(result.sections.findingQueues.availability).toBe("AVAILABLE");
    expect(result.sections.ingestionTrend.availability).toBe("AVAILABLE");
  });

  it("returns an empty queue as an empty list, distinct from restricted and unavailable", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: makeClient() });
    const q = result.sections.findingQueues;

    expect(q.availability).toBe("AVAILABLE");
    expect(q.priority.items).toEqual([]);
    expect(q.priority.total).toBe(0);
  });
});

describe("operationalOverviewService — stored observation trend", () => {
  it("returns exactly the window in whole ascending UTC days, ending on the snapshot's day", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: makeClient() });
    const trend = result.sections.ingestionTrend;

    expect(trend.windowDays).toBe(TREND_WINDOW_DAYS);
    expect(trend.days).toHaveLength(TREND_WINDOW_DAYS);
    expect(trend.days[TREND_WINDOW_DAYS - 1].date).toBe("2026-08-03");
    expect(trend.days[0].date).toBe("2026-07-28");

    const dates = trend.days.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("counts a day with no rows as a factual zero and interpolates nothing", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: makeClient() });
    const trend = result.sections.ingestionTrend;

    for (const day of trend.days) {
      expect(day.observations).toBe(0);
      expect(day.reportsIngested).toBe(0);
      // Every action bucket is present as an explicit zero rather than absent.
      expect(day.byAction.map((b) => b.key)).toEqual([
        "CREATED",
        "PERSISTED",
        "RECURRED",
        "HISTORICAL",
      ]);
    }
    expect(trend.totals).toEqual({ observations: 0, reportsIngested: 0 });
    expect(trend.source).toMatch(/persisted rows only/i);
    expect(trend.note).toMatch(/counted zero, not an interpolated point/i);
  });

  it("queries whole UTC day boundaries, not a rolling wall-clock window", async () => {
    const client = makeClient();
    await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client });

    const ranges = client.findingOccurrence.groupBy.mock.calls
      .map(([args]) => args?.where?.observedAt)
      .filter(Boolean);

    expect(ranges).toHaveLength(TREND_WINDOW_DAYS);
    for (const range of ranges) {
      expect(range.gte.toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(range.lt.getTime() - range.gte.getTime()).toBe(24 * 60 * 60 * 1000);
    }
    expect(utcDayStart(ASOF).toISOString()).toBe("2026-08-03T00:00:00.000Z");
  });
});

describe("operationalOverviewService — provider freshness summary and audience", () => {
  it("rolls provider freshness up from the entries in the same snapshot", async () => {
    const result = await buildOperationalOverview({ role: "ADMIN", asOf: ASOF, client: makeClient() });
    const { summary, ioc, vulnerability, exposure, reputation } = result.sections.providers;

    expect(summary.total).toBe(1 + vulnerability.length + exposure.length + reputation.length);
    expect(summary.fresh + summary.stale + summary.noSuccessfulLookup).toBe(summary.total);
    // With no stored lookup anywhere, nothing may be reported as fresh.
    expect(summary.noSuccessfulLookup).toBe(summary.total);
    expect(summary.fresh).toBe(0);
    expect(ioc.state).toBe("NO_SUCCESSFUL_LOOKUP_RECORDED");
    // A roll-up must never become a health or uptime claim.
    expect(JSON.stringify(summary)).not.toMatch(/health|uptime|operational|latency/i);
  });

  it("reports the server-resolved role the snapshot was gated against", async () => {
    for (const role of ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"]) {
      const result = await buildOperationalOverview({ role, asOf: ASOF, client: makeClient() });
      expect(result.audience.role).toBe(role);
    }
    // An unrecognized role resolves to null — never silently to VIEWER.
    const odd = await buildOperationalOverview({ role: "SUPERUSER", asOf: ASOF, client: makeClient() });
    expect(odd.audience.role).toBeNull();
    expect(odd.sections.findings.availability).toBe("RESTRICTED");
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
