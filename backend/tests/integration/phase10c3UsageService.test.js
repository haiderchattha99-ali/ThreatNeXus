import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Phase 10C-3 — real-PostgreSQL corroboration of the defect-B round-trip.
//
// The unit-level round-trip test (tests/unit/enrichmentUsageService.test.js)
// proves the SAME property against a faithful in-memory Prisma double. This
// file proves it again against a REAL ProviderDailyUsage table, so the fix
// is not resting on a fake's fidelity to Prisma's actual upsert/updateMany/
// findMany semantics or its actual @@id uniqueness.
//
// Self-skips unless TEST_DATABASE_URL is set — same convention as
// phase10a2Execution.test.js.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

process.env.DATABASE_URL = process.env.DATABASE_URL || TEST_DATABASE_URL || "postgresql://x:y@localhost:5432/x";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-32-chars-min!!";
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

const { PrismaClient } = require("@prisma/client");
const { reserveProviderQuota, utcUsageDate } = require("../../src/services/enrichmentOrchestration/enrichmentQuotaService");
const { getProviderUsage } = require("../../src/services/enrichmentOrchestration/enrichmentUsageService");
const { QUOTA_LANES } = require("../../src/services/enrichmentOrchestration/enrichmentDecisionCodes");

const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

// Distinctive usage dates, far outside any range another suite anchors to,
// so this file's cleanup (scoped to exactly these two dates) can never
// collide with concurrent suites writing real-time "today" rows.
const YESTERDAY = new Date("2099-03-14T09:00:00.000Z");
const TODAY = new Date("2099-03-15T09:00:00.000Z");
const PROVIDER = "shodan"; // an arbitrary WORKER_DIRECT provider; nothing shodan-specific is exercised
// RFC 5737 TEST-NET-3, distinctive to this file. reserveProviderQuota's real
// ProviderLookupAttempt row has a genuine FK to ProviderLookupJob, so each
// reservation needs a real (throwaway) job row, exactly as phase10a2Execution
// .test.js's own fixtures do — a JS-object fake cannot reproduce that
// constraint, which is part of why this real-PG corroboration exists.
const INDICATOR_YESTERDAY = "203.0.113.201";
const INDICATOR_TODAY = "203.0.113.202";

let prisma;
const jobIds = [];

async function createJob(subjectValue) {
  const job = await prisma.providerLookupJob.create({
    data: {
      provider: PROVIDER,
      subjectType: "IPV4",
      subjectValue,
      queryIdentityHash: `p10c3-${PROVIDER}-${subjectValue}`,
      state: "PENDING",
      lane: QUOTA_LANES.AUTOMATIC,
      trigger: "RUN_DIRECT",
      requestedAt: TODAY,
      activeLookupKey: `p10c3-${PROVIDER}-${subjectValue}`,
      maxAttempts: 10,
    },
  });
  jobIds.push(job.id);
  return job;
}

describeOrSkip("Phase 10C-3 — real-PostgreSQL round-trip: reserveProviderQuota and getProviderUsage agree on the UTC day", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.providerLookupAttempt.deleteMany({ where: { lookupJobId: { in: jobIds } } });
    await prisma.providerLookupJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.providerDailyUsage.deleteMany({
      where: { provider: PROVIDER, usageDate: { in: [utcUsageDate(YESTERDAY), utcUsageDate(TODAY)] } },
    });
    await prisma.$disconnect();
  });

  it("reports only TODAY's reservations, never a neighboring day's, against a real table", async () => {
    await prisma.providerDailyUsage.deleteMany({
      where: { provider: PROVIDER, usageDate: { in: [utcUsageDate(YESTERDAY), utcUsageDate(TODAY)] } },
    });

    const yesterdayJob = await createJob(INDICATOR_YESTERDAY);
    const todayJob = await createJob(INDICATOR_TODAY);

    // Plant MORE reservations on the older day, exactly as the unit-level
    // red-check does — this is the shape that would have exposed the
    // pre-10C3 unscoped-query-plus-overwrite defect.
    // eslint-disable-next-line no-restricted-syntax
    for (let attemptNumber = 1; attemptNumber <= 6; attemptNumber += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await reserveProviderQuota({
        client: prisma,
        provider: PROVIDER,
        lane: QUOTA_LANES.AUTOMATIC,
        now: YESTERDAY,
        limit: null,
        lookupJobId: yesterdayJob.id,
        attemptNumber,
      });
      expect(result.outcome).toBe("GRANTED");
    }
    // eslint-disable-next-line no-restricted-syntax
    for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await reserveProviderQuota({
        client: prisma,
        provider: PROVIDER,
        lane: QUOTA_LANES.AUTOMATIC,
        now: TODAY,
        limit: null,
        lookupJobId: todayJob.id,
        attemptNumber,
      });
      expect(result.outcome).toBe("GRANTED");
    }

    const usage = await getProviderUsage({
      client: prisma,
      now: TODAY,
      appConfig: {
        ENRICHMENT_WORKER_ENABLED: true,
        AUTO_ENRICHMENT_ENABLED: true,
        ENRICHMENT_AUTOMATIC_DAILY_BUDGETS: { abuseipdb: 0, censys: 0, greynoise: 0, shodan: 0, netlas: 0, nvd: 0 },
        ENRICHMENT_MANUAL_DAILY_BUDGETS: {
          abuseipdb: null,
          censys: null,
          greynoise: null,
          shodan: null,
          netlas: null,
          nvd: null,
        },
      },
    });

    const provider = usage.providers.find((p) => p.provider === PROVIDER);
    // Asserted first, on purpose: this is the number the pre-10C3
    // implementation got wrong (it would have reported 6 — the older day's
    // count — never 2, today's real count).
    expect(provider.automatic.reservedToday).toBe(2);
    expect(usage.usageDate).toBe(utcUsageDate(TODAY).toISOString().slice(0, 10));

    // Corroborate directly against the table: exactly two rows exist for
    // these two dates, and the real committed reservedCount values match
    // what was reserved on each day independently.
    const rows = await prisma.providerDailyUsage.findMany({
      where: { provider: PROVIDER, usageDate: { in: [utcUsageDate(YESTERDAY), utcUsageDate(TODAY)] } },
    });
    expect(rows).toHaveLength(2);
    const todayRow = rows.find((row) => row.usageDate.getTime() === utcUsageDate(TODAY).getTime());
    const yesterdayRow = rows.find((row) => row.usageDate.getTime() === utcUsageDate(YESTERDAY).getTime());
    expect(todayRow.reservedCount).toBe(2);
    expect(yesterdayRow.reservedCount).toBe(6);
  });
});
