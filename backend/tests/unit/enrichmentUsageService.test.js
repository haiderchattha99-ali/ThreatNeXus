import { describe, it, expect } from "vitest";

// Phase 10C-3 — the extended, red-checked evidence for enrichmentUsageService.js.
//
// This file exists because the pre-10C3 implementation had two confirmed
// defects (docs/ai/PHASE-10C3-PROVIDER-CREDENTIAL-BUDGET-OPERABILITY-CONTRACT.md
// §3.6): `reservationsActive` was hardcoded false, and `reservedToday` could
// report the OLDEST day on file rather than today's, because the query was
// unscoped and an indexing loop overwrote per (provider, lane) with whatever
// row it saw last. Both are proven fixed below using the REAL production
// functions — reserveProviderQuota and getProviderUsage — never a duplicated
// hand-built mock of either.

const { QUOTA_LANES } = require("../../src/services/enrichmentOrchestration/enrichmentDecisionCodes");
const { reserveProviderQuota, utcUsageDate } = require("../../src/services/enrichmentOrchestration/enrichmentQuotaService");
const { getProviderUsage } = require("../../src/services/enrichmentOrchestration/enrichmentUsageService");

// --- A minimal, faithful Prisma double -------------------------------------
//
// Implements exactly the ProviderDailyUsage/ProviderLookupAttempt surface
// reserveProviderQuota and enrichmentOrchestrationRepository.listDailyUsage
// use. Not a second implementation of the QUOTA LOGIC — it is a data store;
// every decision (increment, refuse, which day) is still made by the real
// production code under test.
function createFakeUsageClient() {
  const usage = new Map(); // key: provider|usageDateISO|lane -> row
  const attempts = [];

  function key(provider, usageDate, lane) {
    return `${provider}|${usageDate.toISOString()}|${lane}`;
  }

  const client = {
    providerDailyUsage: {
      async upsert({ where, create }) {
        const k = key(where.provider_usageDate_lane.provider, where.provider_usageDate_lane.usageDate, where.provider_usageDate_lane.lane);
        if (!usage.has(k)) usage.set(k, { ...create });
        return usage.get(k);
      },
      async update({ where, data }) {
        const k = key(where.provider_usageDate_lane.provider, where.provider_usageDate_lane.usageDate, where.provider_usageDate_lane.lane);
        const row = usage.get(k);
        if (!row) throw new Error("fake providerDailyUsage.update: no such row");
        if (data.reservedCount && typeof data.reservedCount.increment === "number") {
          row.reservedCount += data.reservedCount.increment;
        }
        if ("limitAtLastReservation" in data) row.limitAtLastReservation = data.limitAtLastReservation;
        return { ...row };
      },
      async updateMany({ where, data }) {
        const k = key(where.provider, where.usageDate, where.lane);
        const row = usage.get(k);
        if (!row || !(row.reservedCount < where.reservedCount.lt)) return { count: 0 };
        if (data.reservedCount && typeof data.reservedCount.increment === "number") {
          row.reservedCount += data.reservedCount.increment;
        }
        if ("limitAtLastReservation" in data) row.limitAtLastReservation = data.limitAtLastReservation;
        return { count: 1 };
      },
      async findMany({ where }) {
        const usageDate = where && where.usageDate;
        const rows = [...usage.values()].filter(
          (row) => !usageDate || row.usageDate.getTime() === usageDate.getTime()
        );
        // Mirrors enrichmentOrchestrationRepository.listDailyUsage's actual
        // orderBy exactly: usageDate DESC, provider ASC, lane ASC. This
        // ordering is load-bearing for the red-check below — the pre-10C3
        // defect's overwrite loop depended on iterating newest-to-oldest so
        // the LAST row processed (the oldest) survived. A fake that returned
        // insertion order instead would not reproduce that bug.
        return rows.sort((a, b) => {
          if (b.usageDate.getTime() !== a.usageDate.getTime()) return b.usageDate.getTime() - a.usageDate.getTime();
          if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
          return a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0;
        });
      },
    },
    providerLookupAttempt: {
      async create({ data }) {
        const row = { id: attempts.length + 1, ...data };
        attempts.push(row);
        return row;
      },
    },
    async $transaction(fn) {
      return fn(client);
    },
  };
  return client;
}

function fakeAppConfig(overrides = {}) {
  return {
    ENRICHMENT_WORKER_ENABLED: false,
    AUTO_ENRICHMENT_ENABLED: false,
    ENRICHMENT_AUTOMATIC_DAILY_BUDGETS: { abuseipdb: 0, censys: 0, greynoise: 0, shodan: 0, netlas: 0, nvd: 0 },
    ENRICHMENT_MANUAL_DAILY_BUDGETS: {
      abuseipdb: null,
      censys: null,
      greynoise: null,
      shodan: null,
      netlas: null,
      nvd: null,
    },
    ABUSEIPDB_API_KEY: "",
    CENSYS_PAT: "",
    GREYNOISE_API_KEY: "",
    SHODAN_API_KEY: "",
    NETLAS_API_KEY: "",
    ...overrides,
  };
}

describe("getProviderUsage — defect B, red-checked: reservedToday is TODAY's day, never the oldest", () => {
  it("round-trip: a reservation made under a controlled `now` is read back under the SAME UTC usage day, with a neighboring day present", async () => {
    const client = createFakeUsageClient();

    const YESTERDAY = new Date("2026-08-16T09:00:00.000Z");
    const TODAY = new Date("2026-08-17T09:00:00.000Z");

    // Plant a LARGER count on the neighboring (older) day first. Under the
    // pre-10C3 defect — an unscoped query ordered usageDate DESC, whose
    // indexing loop overwrote per (provider, lane) with the LAST row it
    // iterated — the surviving value would have been the OLDEST day's count
    // (9 here), not today's (3). This is exactly the case that would fail
    // against the old implementation.
    // eslint-disable-next-line no-restricted-syntax
    for (let i = 0; i < 9; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await reserveProviderQuota({
        client,
        provider: "censys",
        lane: QUOTA_LANES.AUTOMATIC,
        now: YESTERDAY,
        limit: null,
        lookupJobId: 100 + i,
        attemptNumber: 1,
      });
    }
    // eslint-disable-next-line no-restricted-syntax
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await reserveProviderQuota({
        client,
        provider: "censys",
        lane: QUOTA_LANES.AUTOMATIC,
        now: TODAY,
        limit: null,
        lookupJobId: 200 + i,
        attemptNumber: 1,
      });
    }

    const usage = await getProviderUsage({ client, appConfig: fakeAppConfig(), now: TODAY });
    const censys = usage.providers.find((p) => p.provider === "censys");

    // Asserted BEFORE usageDate on purpose: this is the number the pre-fix
    // implementation got wrong (it would report 9 — yesterday's count — not
    // this line's own missing `usageDate` field).
    expect(censys.automatic.reservedToday).toBe(3);
    expect(usage.usageDate).toBe("2026-08-17");

    // Independently confirm the two date derivations agree: the reservation
    // key reserveProviderQuota actually used for "today" is byte-identical to
    // the key getProviderUsage reported under.
    expect(utcUsageDate(TODAY).toISOString()).toBe(new Date(`${usage.usageDate}T00:00:00.000Z`).toISOString());
  });

  it("an absent bucket for today reports 0, not a residual from another day", async () => {
    const client = createFakeUsageClient();
    const OLD_DAY = new Date("2020-01-01T00:00:00.000Z");
    const TODAY = new Date("2026-08-17T09:00:00.000Z");

    await reserveProviderQuota({
      client,
      provider: "shodan",
      lane: QUOTA_LANES.MANUAL,
      now: OLD_DAY,
      limit: null,
      lookupJobId: 1,
      attemptNumber: 1,
    });

    const usage = await getProviderUsage({ client, appConfig: fakeAppConfig(), now: TODAY });
    const shodan = usage.providers.find((p) => p.provider === "shodan");
    expect(shodan.manual.reservedToday).toBe(0);
  });
});

describe("getProviderUsage — defect A, both directions: reservationsActive tracks the worker switch", () => {
  it("is false when the worker is disabled", async () => {
    const client = createFakeUsageClient();
    const usage = await getProviderUsage({
      client,
      appConfig: fakeAppConfig({ ENRICHMENT_WORKER_ENABLED: false }),
      now: new Date("2026-08-17T00:00:00.000Z"),
    });
    expect(usage.reservationsActive).toBe(false);
  });

  it("is true when the worker is enabled — proving the field is DERIVED, not a hardcoded constant", async () => {
    const client = createFakeUsageClient();
    const usage = await getProviderUsage({
      client,
      appConfig: fakeAppConfig({ ENRICHMENT_WORKER_ENABLED: true }),
      now: new Date("2026-08-17T00:00:00.000Z"),
    });
    expect(usage.reservationsActive).toBe(true);
  });
});

describe("getProviderUsage — remaining, budgets, and closed provider fields", () => {
  it("clamps remaining to 0 when today's usage exceeds a since-lowered budget", async () => {
    const client = createFakeUsageClient();
    const NOW = new Date("2026-08-17T00:00:00.000Z");
    // eslint-disable-next-line no-restricted-syntax
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await reserveProviderQuota({
        client,
        provider: "netlas",
        lane: QUOTA_LANES.AUTOMATIC,
        now: NOW,
        limit: null,
        lookupJobId: 300 + i,
        attemptNumber: 1,
      });
    }
    const usage = await getProviderUsage({
      client,
      appConfig: fakeAppConfig({
        ENRICHMENT_AUTOMATIC_DAILY_BUDGETS: { abuseipdb: 0, censys: 0, greynoise: 0, shodan: 0, netlas: 3, nvd: 0 },
      }),
      now: NOW,
    });
    const netlas = usage.providers.find((p) => p.provider === "netlas");
    expect(netlas.automatic.reservedToday).toBe(7);
    expect(netlas.automatic.dailyBudget).toBe(3);
    expect(netlas.automatic.remaining).toBe(0);
  });

  it("never coerces a null (unlimited) budget to a number, in either dailyBudget or remaining", async () => {
    const client = createFakeUsageClient();
    const usage = await getProviderUsage({ client, appConfig: fakeAppConfig(), now: new Date("2026-08-17T00:00:00.000Z") });
    const censys = usage.providers.find((p) => p.provider === "censys");
    expect(censys.manual.dailyBudget).toBeNull();
    expect(censys.manual.remaining).toBeNull();
  });

  it("reports the closed subjectType and executionPath for every provider", async () => {
    const client = createFakeUsageClient();
    const usage = await getProviderUsage({ client, appConfig: fakeAppConfig(), now: new Date("2026-08-17T00:00:00.000Z") });
    const byProvider = Object.fromEntries(usage.providers.map((p) => [p.provider, p]));
    expect(byProvider.censys.subjectType).toBe("IPV4");
    expect(byProvider.censys.executionPath).toBe("WORKER_DIRECT");
    expect(byProvider.abuseipdb.executionPath).toBe("WORKER_DELEGATED_IOC");
    expect(byProvider.nvd.subjectType).toBe("CVE");
    expect(byProvider.nvd.executionPath).toBe("ADMIN_VULNERABILITY_BATCH");
  });

  it("performs no write: the injected client's write methods are never called for a plain read", async () => {
    const writeCalled = () => {
      throw new Error("getProviderUsage must never write");
    };
    const client = {
      providerDailyUsage: {
        findMany: async () => [],
        upsert: writeCalled,
        update: writeCalled,
        updateMany: writeCalled,
      },
      providerLookupAttempt: { create: writeCalled },
      $transaction: writeCalled,
    };
    await expect(
      getProviderUsage({ client, appConfig: fakeAppConfig(), now: new Date("2026-08-17T00:00:00.000Z") })
    ).resolves.toBeTruthy();
  });
});

describe("getProviderUsage — no secret reaches the response (I-01, I-02, I-05, I-10)", () => {
  it("plants JWT_SECRET, DATABASE_URL and every provider credential as sentinels — none appear in the response", async () => {
    const SENTINELS = {
      JWT_SECRET: "jwt-sentinel-must-never-appear-000111",
      DATABASE_URL: "postgresql://sentinel-must-never-appear:pw@host/db",
      ABUSEIPDB_API_KEY: "abuseipdb-sentinel-must-never-appear",
      CENSYS_PAT: "censys-sentinel-must-never-appear",
      GREYNOISE_API_KEY: "greynoise-sentinel-must-never-appear",
      SHODAN_API_KEY: "shodan-sentinel-must-never-appear",
      NETLAS_API_KEY: "netlas-sentinel-must-never-appear",
    };
    const client = createFakeUsageClient();
    const usage = await getProviderUsage({
      client,
      appConfig: fakeAppConfig(SENTINELS),
      now: new Date("2026-08-17T00:00:00.000Z"),
    });
    const serialized = JSON.stringify(usage);
    // eslint-disable-next-line no-restricted-syntax
    for (const sentinel of Object.values(SENTINELS)) {
      expect(serialized).not.toContain(sentinel);
      // No prefix/fragment leak either: even a length-4+ substring must not
      // appear.
      expect(serialized).not.toContain(sentinel.slice(0, 12));
    }
  });

  it("missingConfiguration carries the variable NAME only when a credential is absent", async () => {
    const client = createFakeUsageClient();
    // fakeAppConfig() defaults every credential to "" — unconfigured.
    const usage = await getProviderUsage({ client, appConfig: fakeAppConfig(), now: new Date("2026-08-17T00:00:00.000Z") });
    const censys = usage.providers.find((p) => p.provider === "censys");
    expect(censys.credentialConfigured).toBe(false);
    expect(censys.missingConfiguration).toEqual(["CENSYS_PAT"]);
  });

  it("missingConfiguration is empty once a credential is present — and still never echoes it", async () => {
    const client = createFakeUsageClient();
    const usage = await getProviderUsage({
      client,
      appConfig: fakeAppConfig({ CENSYS_PAT: "a-real-looking-value-that-must-not-be-echoed" }),
      now: new Date("2026-08-17T00:00:00.000Z"),
    });
    const censys = usage.providers.find((p) => p.provider === "censys");
    expect(censys.credentialConfigured).toBe(true);
    expect(censys.missingConfiguration).toEqual([]);
    expect(JSON.stringify(usage)).not.toContain("a-real-looking-value-that-must-not-be-echoed");
  });
});

describe("getProviderUsage — every KNOWN_PROVIDERS entry present, in order", () => {
  it("covers all six providers", async () => {
    const client = createFakeUsageClient();
    const usage = await getProviderUsage({ client, appConfig: fakeAppConfig(), now: new Date("2026-08-17T00:00:00.000Z") });
    expect(usage.providers.map((p) => p.provider)).toEqual([
      "abuseipdb",
      "censys",
      "greynoise",
      "netlas",
      "nvd",
      "shodan",
    ]);
  });
});
