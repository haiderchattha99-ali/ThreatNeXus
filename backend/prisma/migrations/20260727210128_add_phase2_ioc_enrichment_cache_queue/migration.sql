-- CreateEnum
CREATE TYPE "IocIndicatorType" AS ENUM ('IPV4');

-- CreateEnum
CREATE TYPE "IocEnrichmentStatus" AS ENUM ('PENDING', 'SUCCESS', 'NOT_FOUND', 'RATE_LIMITED', 'INVALID_KEY', 'TIMEOUT', 'FAILED', 'UNSUPPORTED_INDICATOR', 'SKIPPED_DISABLED');

-- CreateTable
CREATE TABLE "IocEnrichment" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "indicatorType" "IocIndicatorType" NOT NULL,
    "indicator" TEXT NOT NULL,
    "queryParams" JSONB NOT NULL,
    "queryParamsHash" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "status" "IocEnrichmentStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "activeCacheKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "queriedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "abuseConfidenceScore" INTEGER,
    "totalReports" INTEGER,
    "countryCode" TEXT,
    "isp" TEXT,
    "domain" TEXT,
    "usageType" TEXT,
    "isWhitelisted" BOOLEAN,
    "lastReportedAt" TIMESTAMP(3),
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryAfterSeconds" INTEGER,

    CONSTRAINT "IocEnrichment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IocEnrichment_activeCacheKey_key" ON "IocEnrichment"("activeCacheKey");

-- CreateIndex
CREATE INDEX "IocEnrichment_cacheKey_status_expiresAt_idx" ON "IocEnrichment"("cacheKey", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "IocEnrichment_status_requestedAt_idx" ON "IocEnrichment"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "IocEnrichment_status_leaseExpiresAt_idx" ON "IocEnrichment"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "IocEnrichment_provider_indicatorType_indicator_queriedAt_idx" ON "IocEnrichment"("provider", "indicatorType", "indicator", "queriedAt");
