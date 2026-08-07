-- Phase 8D - GreyNoise internet-noise/reputation enrichment.
--
-- PURELY ADDITIVE. One new enum, one new table, no change to any existing
-- column, model, or relation. No row anywhere is rewritten or backfilled.
--
-- GreyNoiseEnrichment is deliberately NOT shaped like IocEnrichment's queue:
-- no PENDING status, no lease columns, no retry/dead-letter bookkeeping.
-- Every row this table ever holds is written once, already terminal, by a
-- synchronous human-triggered lookup (see greyNoiseExecutionService.js) --
-- this phase's scope is explicitly "no queues/schedulers", the same as
-- Phase 8B's Censys table. It is kept in its own table rather than added as
-- nullable columns on IocEnrichment because GreyNoise returns
-- noise/classification/actor context, a materially different shape from
-- AbuseIPDB's reputation score -- the same reasoning that already keeps
-- CensysEnrichment separate.

-- CreateEnum
CREATE TYPE "GreyNoiseEnrichmentStatus" AS ENUM ('SUCCESS', 'NOT_FOUND', 'RATE_LIMITED', 'INVALID_KEY', 'TIMEOUT', 'FAILED', 'UNSUPPORTED_INDICATOR', 'SKIPPED_DISABLED');

-- CreateTable
CREATE TABLE "GreyNoiseEnrichment" (
    "id" SERIAL NOT NULL,
    "indicator" TEXT NOT NULL,
    "status" "GreyNoiseEnrichmentStatus" NOT NULL,
    "queriedAt" TIMESTAMP(3) NOT NULL,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "retryAfterSeconds" INTEGER,
    "noise" BOOLEAN,
    "riot" BOOLEAN,
    "classification" TEXT,
    "actorName" TEXT,
    "link" TEXT,
    "lastSeen" TEXT,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GreyNoiseEnrichment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GreyNoiseEnrichment_indicator_queriedAt_idx" ON "GreyNoiseEnrichment"("indicator", "queriedAt");
