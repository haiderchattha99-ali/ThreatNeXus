-- Phase 8E - Shodan exposed-service/banner/port intelligence enrichment.
--
-- PURELY ADDITIVE. One new enum, one new table, no change to any existing
-- column, model, or relation. No row anywhere is rewritten or backfilled.
--
-- ShodanEnrichment is deliberately NOT shaped like IocEnrichment's queue:
-- no PENDING status, no lease columns, no retry/dead-letter bookkeeping.
-- Every row this table ever holds is written once, already terminal, by a
-- synchronous human-triggered lookup (see shodanExecutionService.js) --
-- this phase's scope is explicitly "no queues/schedulers", the same as
-- Phase 8B's Censys table and Phase 8D's GreyNoise table. It is kept in its
-- own table rather than added as nullable columns on CensysEnrichment
-- because Shodan returns hostnames/organization/ISP/geo/per-service
-- product+version banners/CVE identifiers -- a materially different shape
-- from Censys's services/AS-ownership columns.

-- CreateEnum
CREATE TYPE "ShodanEnrichmentStatus" AS ENUM ('SUCCESS', 'NOT_FOUND', 'RATE_LIMITED', 'INVALID_KEY', 'TIMEOUT', 'FAILED', 'UNSUPPORTED_INDICATOR', 'SKIPPED_DISABLED');

-- CreateTable
CREATE TABLE "ShodanEnrichment" (
    "id" SERIAL NOT NULL,
    "indicator" TEXT NOT NULL,
    "status" "ShodanEnrichmentStatus" NOT NULL,
    "queriedAt" TIMESTAMP(3) NOT NULL,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "retryAfterSeconds" INTEGER,
    "services" JSONB,
    "hostnames" JSONB,
    "organization" TEXT,
    "isp" TEXT,
    "country" TEXT,
    "countryCode" TEXT,
    "city" TEXT,
    "vulnerabilities" JSONB,
    "lastUpdate" TEXT,
    "link" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShodanEnrichment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShodanEnrichment_indicator_queriedAt_idx" ON "ShodanEnrichment"("indicator", "queriedAt");
