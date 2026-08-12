-- CreateEnum
CREATE TYPE "EnrichmentSubjectType" AS ENUM ('IPV4', 'CVE');

-- CreateEnum
CREATE TYPE "EnrichmentRunTrigger" AS ENUM ('INGESTION', 'MANUAL');

-- CreateEnum
CREATE TYPE "EnrichmentRunState" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "RunItemDecision" AS ENUM ('ELIGIBLE', 'SKIPPED_CACHED', 'SKIPPED_DISABLED', 'SKIPPED_NOT_CONFIGURED', 'SKIPPED_NOT_APPLICABLE', 'SKIPPED_UNSUPPORTED_SUBJECT', 'SKIPPED_BUDGET', 'SKIPPED_EXECUTION_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "LookupJobTrigger" AS ENUM ('RUN_DELEGATED', 'RUN_DIRECT', 'MANUAL_DIRECT');

-- CreateEnum
CREATE TYPE "ProviderLookupJobState" AS ENUM ('PENDING', 'LEASED', 'RETRY_WAIT', 'WAITING_ON_DELEGATE', 'SUCCEEDED', 'NO_RECORD', 'FAILED', 'DEAD_LETTER', 'SKIPPED_DISABLED', 'SKIPPED_NOT_CONFIGURED', 'SKIPPED_UNSUPPORTED_SUBJECT', 'SKIPPED_BUDGET');

-- CreateEnum
CREATE TYPE "QuotaLane" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "AttemptState" AS ENUM ('RESERVED', 'IN_FLIGHT', 'FINISHED');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('SUCCESS', 'NOT_FOUND', 'RATE_LIMITED', 'TIMEOUT', 'TRANSPORT_ERROR', 'SERVER_ERROR', 'INVALID_KEY', 'DISABLED', 'UNSUPPORTED_SUBJECT', 'LOCAL_VALIDATION_ERROR', 'ABANDONED');

-- CreateTable
CREATE TABLE "FindingEnrichmentRun" (
    "id" SERIAL NOT NULL,
    "findingId" INTEGER NOT NULL,
    "trigger" "EnrichmentRunTrigger" NOT NULL,
    "state" "EnrichmentRunState" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "force" BOOLEAN NOT NULL DEFAULT false,
    "requestScopeHash" TEXT NOT NULL,
    "noSubjectProviders" TEXT NOT NULL DEFAULT '',
    "idempotencyKey" TEXT NOT NULL,
    "rawReportId" INTEGER,
    "actorUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FindingEnrichmentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingEnrichmentRunItem" (
    "id" SERIAL NOT NULL,
    "runId" INTEGER NOT NULL,
    "findingId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "subjectType" "EnrichmentSubjectType" NOT NULL,
    "subjectValue" TEXT NOT NULL,
    "decision" "RunItemDecision" NOT NULL,
    "skipReason" TEXT,
    "lookupJobId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FindingEnrichmentRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderLookupJob" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "subjectType" "EnrichmentSubjectType" NOT NULL,
    "subjectValue" TEXT NOT NULL,
    "queryIdentityHash" TEXT NOT NULL,
    "state" "ProviderLookupJobState" NOT NULL,
    "lane" "QuotaLane" NOT NULL,
    "trigger" "LookupJobTrigger" NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "activeLookupKey" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "terminalReasonCode" TEXT,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "retryAfterSeconds" INTEGER,
    "queriedAt" TIMESTAMP(3),
    "freshUntil" TIMESTAMP(3),
    "iocEnrichmentId" INTEGER,
    "vulnerabilityEnrichmentJobId" INTEGER,
    "censysEnrichmentId" INTEGER,
    "greyNoiseEnrichmentId" INTEGER,
    "shodanEnrichmentId" INTEGER,
    "netlasEnrichmentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderLookupJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderLookupAttempt" (
    "id" SERIAL NOT NULL,
    "lookupJobId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "lane" "QuotaLane" NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "usageDate" DATE NOT NULL,
    "state" "AttemptState" NOT NULL DEFAULT 'RESERVED',
    "contactedProvider" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "fetchStartedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "outcome" "AttemptOutcome",
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "retryAfterSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderLookupAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderDailyUsage" (
    "provider" TEXT NOT NULL,
    "usageDate" DATE NOT NULL,
    "lane" "QuotaLane" NOT NULL,
    "reservedCount" INTEGER NOT NULL DEFAULT 0,
    "limitAtLastReservation" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderDailyUsage_pkey" PRIMARY KEY ("provider","usageDate","lane")
);

-- CreateIndex
CREATE UNIQUE INDEX "FindingEnrichmentRun_idempotencyKey_key" ON "FindingEnrichmentRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "FindingEnrichmentRun_findingId_requestedAt_idx" ON "FindingEnrichmentRun"("findingId", "requestedAt");

-- CreateIndex
CREATE INDEX "FindingEnrichmentRun_state_requestedAt_idx" ON "FindingEnrichmentRun"("state", "requestedAt");

-- CreateIndex
CREATE INDEX "FindingEnrichmentRun_rawReportId_idx" ON "FindingEnrichmentRun"("rawReportId");

-- CreateIndex
CREATE INDEX "FindingEnrichmentRunItem_lookupJobId_idx" ON "FindingEnrichmentRunItem"("lookupJobId");

-- CreateIndex
CREATE INDEX "FindingEnrichmentRunItem_findingId_provider_idx" ON "FindingEnrichmentRunItem"("findingId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "FindingEnrichmentRunItem_runId_provider_subjectType_subject_key" ON "FindingEnrichmentRunItem"("runId", "provider", "subjectType", "subjectValue");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderLookupJob_activeLookupKey_key" ON "ProviderLookupJob"("activeLookupKey");

-- CreateIndex
CREATE INDEX "ProviderLookupJob_state_nextAttemptAt_requestedAt_idx" ON "ProviderLookupJob"("state", "nextAttemptAt", "requestedAt");

-- CreateIndex
CREATE INDEX "ProviderLookupJob_state_leaseExpiresAt_idx" ON "ProviderLookupJob"("state", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "ProviderLookupJob_state_provider_idx" ON "ProviderLookupJob"("state", "provider");

-- CreateIndex
CREATE INDEX "ProviderLookupJob_provider_subjectType_subjectValue_queried_idx" ON "ProviderLookupJob"("provider", "subjectType", "subjectValue", "queriedAt");

-- CreateIndex
CREATE INDEX "ProviderLookupAttempt_provider_usageDate_lane_idx" ON "ProviderLookupAttempt"("provider", "usageDate", "lane");

-- CreateIndex
CREATE INDEX "ProviderLookupAttempt_state_startedAt_idx" ON "ProviderLookupAttempt"("state", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderLookupAttempt_lookupJobId_attemptNumber_key" ON "ProviderLookupAttempt"("lookupJobId", "attemptNumber");

-- CreateIndex
CREATE INDEX "ProviderDailyUsage_usageDate_lane_idx" ON "ProviderDailyUsage"("usageDate", "lane");

-- AddForeignKey
ALTER TABLE "FindingEnrichmentRun" ADD CONSTRAINT "FindingEnrichmentRun_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEnrichmentRun" ADD CONSTRAINT "FindingEnrichmentRun_rawReportId_fkey" FOREIGN KEY ("rawReportId") REFERENCES "RawReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEnrichmentRun" ADD CONSTRAINT "FindingEnrichmentRun_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEnrichmentRunItem" ADD CONSTRAINT "FindingEnrichmentRunItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FindingEnrichmentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEnrichmentRunItem" ADD CONSTRAINT "FindingEnrichmentRunItem_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEnrichmentRunItem" ADD CONSTRAINT "FindingEnrichmentRunItem_lookupJobId_fkey" FOREIGN KEY ("lookupJobId") REFERENCES "ProviderLookupJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderLookupJob" ADD CONSTRAINT "ProviderLookupJob_iocEnrichmentId_fkey" FOREIGN KEY ("iocEnrichmentId") REFERENCES "IocEnrichment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderLookupJob" ADD CONSTRAINT "ProviderLookupJob_vulnerabilityEnrichmentJobId_fkey" FOREIGN KEY ("vulnerabilityEnrichmentJobId") REFERENCES "VulnerabilityEnrichmentJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderLookupJob" ADD CONSTRAINT "ProviderLookupJob_censysEnrichmentId_fkey" FOREIGN KEY ("censysEnrichmentId") REFERENCES "CensysEnrichment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderLookupJob" ADD CONSTRAINT "ProviderLookupJob_greyNoiseEnrichmentId_fkey" FOREIGN KEY ("greyNoiseEnrichmentId") REFERENCES "GreyNoiseEnrichment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderLookupJob" ADD CONSTRAINT "ProviderLookupJob_shodanEnrichmentId_fkey" FOREIGN KEY ("shodanEnrichmentId") REFERENCES "ShodanEnrichment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderLookupJob" ADD CONSTRAINT "ProviderLookupJob_netlasEnrichmentId_fkey" FOREIGN KEY ("netlasEnrichmentId") REFERENCES "NetlasEnrichment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderLookupAttempt" ADD CONSTRAINT "ProviderLookupAttempt_lookupJobId_fkey" FOREIGN KEY ("lookupJobId") REFERENCES "ProviderLookupJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Phase 10A-1 — seven hand-written CHECK constraints.
--
-- Prisma does not model CHECK constraints, so these cannot live in
-- schema.prisma and are invisible to `prisma migrate diff` (which is why that
-- gate stays clean). A future regenerated migration MUST re-add them.
--
-- Seven constraints, eight independently provable rejections: constraint 1
-- rejects both "more than one typed result link" and "a typed result link that
-- disagrees with provider", because a link table that does not match the
-- provider is the same class of corruption as two links at once and is cheaper
-- to keep in one expression than to split across two overlapping predicates.
-- Each rejection has its own real-PostgreSQL test.
-- ===========================================================================

-- 1. At most ONE typed result/delegate link, and whichever one is set must
--    agree with `provider`. Rejects (a) two links at once and (b) a link that
--    belongs to a different provider.
ALTER TABLE "ProviderLookupJob" ADD CONSTRAINT "ProviderLookupJob_result_link_valid" CHECK (
  (
    (CASE WHEN "iocEnrichmentId"              IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "vulnerabilityEnrichmentJobId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "censysEnrichmentId"           IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "greyNoiseEnrichmentId"        IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "shodanEnrichmentId"           IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "netlasEnrichmentId"           IS NULL THEN 0 ELSE 1 END)
  ) <= 1
  AND ("iocEnrichmentId"              IS NULL OR "provider" = 'abuseipdb')
  AND ("vulnerabilityEnrichmentJobId" IS NULL OR "provider" = 'nvd')
  AND ("censysEnrichmentId"           IS NULL OR "provider" = 'censys')
  AND ("greyNoiseEnrichmentId"        IS NULL OR "provider" = 'greynoise')
  AND ("shodanEnrichmentId"           IS NULL OR "provider" = 'shodan')
  AND ("netlasEnrichmentId"           IS NULL OR "provider" = 'netlas')
);

-- 2. A lookup job's provider must accept its subject type. The five IPv4
--    providers never carry a CVE; nvd never carries an IPv4. An unknown
--    provider string is rejected outright rather than silently allowed —
--    provider stays a String (D-007) so adding one needs no migration, but it
--    does need this list extended in the same change.
ALTER TABLE "ProviderLookupJob" ADD CONSTRAINT "ProviderLookupJob_provider_subject_valid" CHECK (
  ("provider" IN ('abuseipdb', 'greynoise', 'censys', 'shodan', 'netlas') AND "subjectType" = 'IPV4')
  OR ("provider" = 'nvd' AND "subjectType" = 'CVE')
);

-- 3. The same pairing rule on the run item, enforced independently. The item
--    is written before its job exists (and for a policy skip, no job is ever
--    written), so it cannot inherit the job's guarantee.
ALTER TABLE "FindingEnrichmentRunItem" ADD CONSTRAINT "FindingEnrichmentRunItem_provider_subject_valid" CHECK (
  ("provider" IN ('abuseipdb', 'greynoise', 'censys', 'shodan', 'netlas') AND "subjectType" = 'IPV4')
  OR ("provider" = 'nvd' AND "subjectType" = 'CVE')
);

-- 4. A MANUAL_DIRECT job never holds an activeLookupKey. That column is the
--    whole cross-Finding dedup guarantee; a synchronous expert call must not
--    coalesce with queued work, and must not block queued work by occupying
--    the unique key.
ALTER TABLE "ProviderLookupJob" ADD CONSTRAINT "ProviderLookupJob_manual_direct_no_active_key" CHECK (
  "trigger" <> 'MANUAL_DIRECT' OR "activeLookupKey" IS NULL
);

-- 5. Attempt finalization is consistent in BOTH directions: FINISHED requires
--    outcome and finishedAt; RESERVED/IN_FLIGHT may carry neither. Prevents a
--    half-finalized attempt from being counted as either complete or pending.
ALTER TABLE "ProviderLookupAttempt" ADD CONSTRAINT "ProviderLookupAttempt_finalization_consistent" CHECK (
  ("state" = 'FINISHED' AND "outcome" IS NOT NULL AND "finishedAt" IS NOT NULL)
  OR ("state" <> 'FINISHED' AND "outcome" IS NULL AND "finishedAt" IS NULL)
);

-- 6. The run item's decision and its job link agree in both directions:
--    ELIGIBLE requires a job, every skipped decision forbids one. This is what
--    makes "a policy skip creates no outbound work" a database guarantee
--    rather than a service-layer convention.
ALTER TABLE "FindingEnrichmentRunItem" ADD CONSTRAINT "FindingEnrichmentRunItem_job_link_matches_decision" CHECK (
  ("decision" = 'ELIGIBLE' AND "lookupJobId" IS NOT NULL)
  OR ("decision" <> 'ELIGIBLE' AND "lookupJobId" IS NULL)
);

-- 7. A reservation bucket can never go negative. There is no decrement path in
--    the design, so this is a backstop against one being added later without
--    the accompanying floor check.
ALTER TABLE "ProviderDailyUsage" ADD CONSTRAINT "ProviderDailyUsage_reserved_count_non_negative" CHECK (
  "reservedCount" >= 0
);
