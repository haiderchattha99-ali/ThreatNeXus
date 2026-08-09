-- Phase 8F - Netlas cross-source attack-surface/DNS/certificate/service
-- intelligence enrichment.
--
-- PURELY ADDITIVE. One new enum, one new table, no change to any existing
-- column, model, or relation. No row anywhere is rewritten or backfilled.
--
-- NetlasEnrichment is deliberately NOT shaped like IocEnrichment's queue:
-- no PENDING status, no lease columns, no retry/dead-letter bookkeeping.
-- Every row this table ever holds is written once, already terminal, by a
-- synchronous human-triggered lookup (see netlasExecutionService.js) --
-- this phase's scope is explicitly "no queues/schedulers", the same as
-- Phase 8B's Censys table, Phase 8D's GreyNoise table, and Phase 8E's
-- Shodan table. It is kept in its own table rather than added as nullable
-- columns on CensysEnrichment or ShodanEnrichment because Netlas returns
-- reverse-DNS/associated-domain names, WHOIS/ASN ownership, open ports,
-- per-service software banners, AND certificate subject/issuer/SAN data in
-- one response -- a materially different shape from either existing
-- exposure table.

-- CreateEnum
CREATE TYPE "NetlasEnrichmentStatus" AS ENUM ('SUCCESS', 'NOT_FOUND', 'RATE_LIMITED', 'INVALID_KEY', 'TIMEOUT', 'FAILED', 'UNSUPPORTED_INDICATOR', 'SKIPPED_DISABLED');

-- CreateTable
CREATE TABLE "NetlasEnrichment" (
    "id" SERIAL NOT NULL,
    "indicator" TEXT NOT NULL,
    "status" "NetlasEnrichmentStatus" NOT NULL,
    "queriedAt" TIMESTAMP(3) NOT NULL,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "retryAfterSeconds" INTEGER,
    "services" JSONB,
    "products" JSONB,
    "hostnames" JSONB,
    "dnsNames" JSONB,
    "organization" TEXT,
    "asn" INTEGER,
    "asnOrg" TEXT,
    "country" TEXT,
    "certificateSubject" TEXT,
    "certificateIssuer" TEXT,
    "certificateSan" JSONB,
    "lastSeen" TEXT,
    "firstSeen" TEXT,
    "link" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetlasEnrichment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NetlasEnrichment_indicator_queriedAt_idx" ON "NetlasEnrichment"("indicator", "queriedAt");
