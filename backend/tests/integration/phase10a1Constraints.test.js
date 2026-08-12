import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

// Phase 10A-1 — REAL-PostgreSQL proof of all seven CHECK constraints.
//
// ===========================================================================
// Why raw SQL, and why every rejection is proven separately
// ===========================================================================
// These constraints are the last line of defence: they must reject a bad row
// even when the service layer that normally prevents it is bypassed, buggy or
// replaced. So every case here writes RAW SQL straight at the table rather
// than going through Prisma or through any orchestration service — a test that
// only proves "the service refuses" proves nothing about the database.
//
// Seven constraints, EIGHT independent rejection proofs: constraint 1
// (ProviderLookupJob_result_link_valid) rejects both "two typed result links
// at once" and "a typed result link that disagrees with provider", so it earns
// two separate tests. Codex amendment 3 requires each rejection proven on its
// own; it is not satisfied by six examples relabelled as seven.
//
// Each test also asserts the CONSTRAINT NAME in the error, so a row that
// happens to be rejected by some unrelated NOT NULL or foreign key cannot be
// miscounted as proof that the intended CHECK exists.
//
// Self-skips unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_test?schema=public" npx vitest run tests/integration/phase10a1Constraints.test.js

const { PrismaClient } = require("@prisma/client");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// RFC 5737 TEST-NET-3, distinct from every other real-DB suite's range so this
// file can run alongside them without collision.
const IP = "203.0.113.201";
const MARKER_PORT = 33891;

let prisma;
let findingId;

async function cleanup() {
  // Ordered by FK dependency. Only rows this file created.
  await prisma.$executeRawUnsafe(
    `DELETE FROM "ProviderLookupAttempt" WHERE "provider" LIKE 'p10a1c-%'
       OR "lookupJobId" IN (SELECT id FROM "ProviderLookupJob" WHERE "subjectValue" = $1)`,
    IP
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "FindingEnrichmentRunItem" WHERE "findingId" IN
       (SELECT id FROM "Finding" WHERE "indicatorValue" = $1 AND "port" = $2)`,
    IP,
    MARKER_PORT
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "FindingEnrichmentRun" WHERE "findingId" IN
       (SELECT id FROM "Finding" WHERE "indicatorValue" = $1 AND "port" = $2)`,
    IP,
    MARKER_PORT
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "ProviderLookupJob" WHERE "subjectValue" IN ($1, 'CVE-2099-0001')`,
    IP
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "ProviderDailyUsage" WHERE "provider" LIKE 'p10a1c-%'`);
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Finding" WHERE "indicatorValue" = $1 AND "port" = $2`,
    IP,
    MARKER_PORT
  );
}

/**
 * Runs a statement expected to be refused, and asserts WHICH constraint
 * refused it. Returns the error so a caller can assert further.
 */
async function expectRejectedBy(constraintName, sql, ...params) {
  let caught = null;
  try {
    await prisma.$executeRawUnsafe(sql, ...params);
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${constraintName} to reject the row, but it was accepted`).not.toBeNull();
  expect(String(caught.message)).toContain(constraintName);
  return caught;
}

const describeOrSkip = TEST_DATABASE_URL ? describe : describe.skip;

describeOrSkip("Phase 10A-1 — seven CHECK constraints, eight rejections (real PostgreSQL)", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    await prisma.$connect();
  });

  beforeEach(async () => {
    await cleanup();
    const finding = await prisma.finding.create({
      data: {
        indicatorValue: IP,
        port: MARKER_PORT,
        protocol: "TCP",
        reportType: "ACCESSIBLE_RDP",
        firstSeen: new Date("2026-08-11T00:00:00.000Z"),
        lastSeen: new Date("2026-08-11T00:00:00.000Z"),
      },
    });
    findingId = finding.id;
  });

  afterAll(async () => {
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
  });

  // --- Constraint 1, rejection (a) --------------------------------------
  it("1a. refuses MORE THAN ONE evidence/delegate link on a lookup job", async () => {
    const ioc = await prisma.iocEnrichment.create({
      data: {
        provider: "p10a1c-ioc",
        indicatorType: "IPV4",
        indicator: IP,
        queryParams: {},
        queryParamsHash: "h",
        cacheKey: `p10a1c-${IP}`,
      },
    });
    const censys = await prisma.censysEnrichment.create({
      data: { indicator: IP, status: "SUCCESS", queriedAt: new Date() },
    });

    await expectRejectedBy(
      "ProviderLookupJob_result_link_valid",
      `INSERT INTO "ProviderLookupJob"
         ("provider","subjectType","subjectValue","queryIdentityHash","state","lane","trigger",
          "requestedAt","updatedAt","iocEnrichmentId","censysEnrichmentId")
       VALUES ('abuseipdb','IPV4',$1,'qh-1a','PENDING','AUTOMATIC','RUN_DELEGATED',NOW(),NOW(),$2,$3)`,
      IP,
      ioc.id,
      censys.id
    );

    await prisma.censysEnrichment.delete({ where: { id: censys.id } });
    await prisma.iocEnrichment.delete({ where: { id: ioc.id } });
  });

  // --- Constraint 1, rejection (b) --------------------------------------
  it("1b. refuses a result link that DISAGREES with the job's provider", async () => {
    const censys = await prisma.censysEnrichment.create({
      data: { indicator: IP, status: "SUCCESS", queriedAt: new Date() },
    });

    // A censys evidence row hung off a shodan job: exactly one link is set, so
    // only the provider-agreement half of the constraint can catch this.
    await expectRejectedBy(
      "ProviderLookupJob_result_link_valid",
      `INSERT INTO "ProviderLookupJob"
         ("provider","subjectType","subjectValue","queryIdentityHash","state","lane","trigger",
          "requestedAt","updatedAt","censysEnrichmentId")
       VALUES ('shodan','IPV4',$1,'qh-1b','SUCCEEDED','MANUAL','RUN_DIRECT',NOW(),NOW(),$2)`,
      IP,
      censys.id
    );

    await prisma.censysEnrichment.delete({ where: { id: censys.id } });
  });

  // --- Constraint 2 -------------------------------------------------------
  it("2. refuses an invalid ProviderLookupJob provider/subject pairing", async () => {
    // Shodan does not answer questions about CVEs.
    await expectRejectedBy(
      "ProviderLookupJob_provider_subject_valid",
      `INSERT INTO "ProviderLookupJob"
         ("provider","subjectType","subjectValue","queryIdentityHash","state","lane","trigger",
          "requestedAt","updatedAt")
       VALUES ('shodan','CVE','CVE-2099-0001','qh-2a','PENDING','MANUAL','RUN_DIRECT',NOW(),NOW())`
    );

    // ...and nvd does not answer questions about IP addresses.
    await expectRejectedBy(
      "ProviderLookupJob_provider_subject_valid",
      `INSERT INTO "ProviderLookupJob"
         ("provider","subjectType","subjectValue","queryIdentityHash","state","lane","trigger",
          "requestedAt","updatedAt")
       VALUES ('nvd','IPV4',$1,'qh-2b','PENDING','MANUAL','RUN_DIRECT',NOW(),NOW())`,
      IP
    );

    // An unknown provider is refused outright rather than silently allowed.
    await expectRejectedBy(
      "ProviderLookupJob_provider_subject_valid",
      `INSERT INTO "ProviderLookupJob"
         ("provider","subjectType","subjectValue","queryIdentityHash","state","lane","trigger",
          "requestedAt","updatedAt")
       VALUES ('virustotal','IPV4',$1,'qh-2c','PENDING','MANUAL','RUN_DIRECT',NOW(),NOW())`,
      IP
    );
  });

  // --- Constraint 3 -------------------------------------------------------
  it("3. refuses an invalid FindingEnrichmentRunItem provider/subject pairing", async () => {
    const run = await prisma.findingEnrichmentRun.create({
      data: {
        findingId,
        trigger: "MANUAL",
        requestedAt: new Date(),
        requestScopeHash: "rsh-3",
        idempotencyKey: "man:rsh-3:bucket",
      },
    });

    // The item is written BEFORE its job exists (and for a policy skip, no job
    // is ever written), so it cannot inherit constraint 2's guarantee.
    await expectRejectedBy(
      "FindingEnrichmentRunItem_provider_subject_valid",
      `INSERT INTO "FindingEnrichmentRunItem"
         ("runId","findingId","provider","subjectType","subjectValue","decision")
       VALUES ($1,$2,'censys','CVE','CVE-2099-0001','SKIPPED_CACHED')`,
      run.id,
      findingId
    );
  });

  // --- Constraint 4 -------------------------------------------------------
  it("4. refuses a MANUAL_DIRECT job that carries an activeLookupKey", async () => {
    // A synchronous expert call must never coalesce with queued work, and must
    // never occupy the unique key that queued work depends on.
    await expectRejectedBy(
      "ProviderLookupJob_manual_direct_no_active_key",
      `INSERT INTO "ProviderLookupJob"
         ("provider","subjectType","subjectValue","queryIdentityHash","state","lane","trigger",
          "requestedAt","updatedAt","activeLookupKey")
       VALUES ('censys','IPV4',$1,'qh-4','PENDING','MANUAL','MANUAL_DIRECT',NOW(),NOW(),'qh-4')`,
      IP
    );

    // The same row WITHOUT an activeLookupKey is accepted, which proves the
    // constraint targets the key and not the trigger itself.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ProviderLookupJob"
         ("provider","subjectType","subjectValue","queryIdentityHash","state","lane","trigger",
          "requestedAt","updatedAt")
       VALUES ('censys','IPV4',$1,'qh-4-ok','PENDING','MANUAL','MANUAL_DIRECT',NOW(),NOW())`,
      IP
    );
  });

  // --- Constraint 5 -------------------------------------------------------
  it("5. refuses an inconsistent attempt finalization in BOTH directions", async () => {
    const job = await prisma.providerLookupJob.create({
      data: {
        provider: "censys",
        subjectType: "IPV4",
        subjectValue: IP,
        queryIdentityHash: "qh-5",
        state: "PENDING",
        lane: "MANUAL",
        trigger: "RUN_DIRECT",
        requestedAt: new Date(),
      },
    });

    // FINISHED without an outcome/finishedAt would be a half-finalized attempt
    // that could be counted as complete.
    await expectRejectedBy(
      "ProviderLookupAttempt_finalization_consistent",
      `INSERT INTO "ProviderLookupAttempt"
         ("lookupJobId","provider","lane","attemptNumber","usageDate","state","startedAt")
       VALUES ($1,'censys','MANUAL',1,CURRENT_DATE,'FINISHED',NOW())`,
      job.id
    );

    // ...and the other direction: a still-RESERVED attempt must not already
    // carry a final outcome.
    await expectRejectedBy(
      "ProviderLookupAttempt_finalization_consistent",
      `INSERT INTO "ProviderLookupAttempt"
         ("lookupJobId","provider","lane","attemptNumber","usageDate","state","startedAt",
          "outcome","finishedAt")
       VALUES ($1,'censys','MANUAL',2,CURRENT_DATE,'RESERVED',NOW(),'SUCCESS',NOW())`,
      job.id
    );
  });

  // --- Constraint 6 -------------------------------------------------------
  it("6. refuses an ELIGIBLE item without a job, and a skipped item WITH one", async () => {
    const run = await prisma.findingEnrichmentRun.create({
      data: {
        findingId,
        trigger: "MANUAL",
        requestedAt: new Date(),
        requestScopeHash: "rsh-6",
        idempotencyKey: "man:rsh-6:bucket",
      },
    });
    const job = await prisma.providerLookupJob.create({
      data: {
        provider: "censys",
        subjectType: "IPV4",
        subjectValue: IP,
        queryIdentityHash: "qh-6",
        state: "PENDING",
        lane: "MANUAL",
        trigger: "RUN_DIRECT",
        requestedAt: new Date(),
      },
    });

    // ELIGIBLE means work should exist — so a job must be linked.
    await expectRejectedBy(
      "FindingEnrichmentRunItem_job_link_matches_decision",
      `INSERT INTO "FindingEnrichmentRunItem"
         ("runId","findingId","provider","subjectType","subjectValue","decision")
       VALUES ($1,$2,'censys','IPV4',$3,'ELIGIBLE')`,
      run.id,
      findingId,
      IP
    );

    // A POLICY skip must create NO outbound work. This is the database
    // guarantee behind "policy skips create no jobs".
    await expectRejectedBy(
      "FindingEnrichmentRunItem_job_link_matches_decision",
      `INSERT INTO "FindingEnrichmentRunItem"
         ("runId","findingId","provider","subjectType","subjectValue","decision","lookupJobId")
       VALUES ($1,$2,'censys','IPV4',$3,'SKIPPED_BUDGET',$4)`,
      run.id,
      findingId,
      IP,
      job.id
    );
  });

  // --- Constraint 7 -------------------------------------------------------
  it("7. refuses a negative ProviderDailyUsage.reservedCount", async () => {
    await expectRejectedBy(
      "ProviderDailyUsage_reserved_count_non_negative",
      `INSERT INTO "ProviderDailyUsage"
         ("provider","usageDate","lane","reservedCount","updatedAt")
       VALUES ('p10a1c-usage',CURRENT_DATE,'AUTOMATIC',-1,NOW())`
    );

    // Zero is legal, so the constraint is a floor and not an "must be
    // positive" rule that would block the initial row.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ProviderDailyUsage"
         ("provider","usageDate","lane","reservedCount","updatedAt")
       VALUES ('p10a1c-usage',CURRENT_DATE,'AUTOMATIC',0,NOW())`
    );
  });

  it("has all seven constraints present in the live schema", async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname IN (
         'ProviderLookupJob_result_link_valid',
         'ProviderLookupJob_provider_subject_valid',
         'FindingEnrichmentRunItem_provider_subject_valid',
         'ProviderLookupJob_manual_direct_no_active_key',
         'ProviderLookupAttempt_finalization_consistent',
         'FindingEnrichmentRunItem_job_link_matches_decision',
         'ProviderDailyUsage_reserved_count_non_negative'
       ) ORDER BY conname`
    );
    expect(rows.map((r) => r.conname)).toEqual([
      "FindingEnrichmentRunItem_job_link_matches_decision",
      "FindingEnrichmentRunItem_provider_subject_valid",
      "ProviderDailyUsage_reserved_count_non_negative",
      "ProviderLookupAttempt_finalization_consistent",
      "ProviderLookupJob_manual_direct_no_active_key",
      "ProviderLookupJob_provider_subject_valid",
      "ProviderLookupJob_result_link_valid",
    ]);
  });
});
