-- Phase 8B - Censys internet-exposure/attack-surface enrichment.
--
-- PURELY ADDITIVE. One new enum, one new table, no change to any existing
-- column, model, or relation. No row anywhere is rewritten or backfilled.
--
-- CensysEnrichment is deliberately NOT shaped like IocEnrichment's queue: no
-- PENDING status, no lease columns, no retry/dead-letter bookkeeping. Every
-- row this table ever holds is written once, already terminal, by a
-- synchronous human-triggered lookup (see censysExecutionService.js) -- this
-- phase's scope is explicitly "no queues/schedulers". It is kept in its own
-- table rather than added as nullable columns on IocEnrichment because
-- Censys returns exposure/attack-surface data (open services, AS ownership),
-- a materially different shape from AbuseIPDB's reputation score -- the same
-- reasoning that already keeps vulnerability enrichment
-- (VulnerabilityProviderResult) separate from IOC reputation enrichment.

-- CreateEnum
CREATE TYPE "CensysEnrichmentStatus" AS ENUM ('SUCCESS', 'NOT_FOUND', 'RATE_LIMITED', 'INVALID_KEY', 'TIMEOUT', 'FAILED', 'UNSUPPORTED_INDICATOR', 'SKIPPED_DISABLED');

-- CreateTable
CREATE TABLE "CensysEnrichment" (
    "id" SERIAL NOT NULL,
    "indicator" TEXT NOT NULL,
    "status" "CensysEnrichmentStatus" NOT NULL,
    "queriedAt" TIMESTAMP(3) NOT NULL,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "retryAfterSeconds" INTEGER,
    "services" JSONB,
    "autonomousSystemNumber" INTEGER,
    "autonomousSystemName" TEXT,
    "certificateCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CensysEnrichment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CensysEnrichment_indicator_queriedAt_idx" ON "CensysEnrichment"("indicator", "queriedAt");
