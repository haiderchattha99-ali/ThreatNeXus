-- CreateEnum
CREATE TYPE "OrganizationSector" AS ENUM ('CRITICAL_NATIONAL_INFRASTRUCTURE', 'GOVERNMENT', 'HEALTHCARE', 'FINANCE', 'ENERGY', 'TELECOM', 'EDUCATION', 'GENERAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AssetMappingType" AS ENUM ('EXACT_IP', 'CIDR', 'ASN');

-- CreateEnum
CREATE TYPE "AssetMappingSource" AS ENUM ('MANUAL', 'IMPORTED_RIR', 'ANALYST_OVERRIDE');

-- CreateEnum
CREATE TYPE "OwnershipConfidence" AS ENUM ('CONFIRMED', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "OwnershipResolutionStatus" AS ENUM ('RESOLVED', 'AMBIGUOUS', 'UNRESOLVED', 'OVERRIDDEN');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "sector" "OrganizationSector" NOT NULL DEFAULT 'UNKNOWN';

-- CreateTable
CREATE TABLE "AssetMapping" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "mappingType" "AssetMappingType" NOT NULL,
    "exactIp" TEXT,
    "cidr" TEXT,
    "prefixLength" INTEGER,
    "ipStart" BIGINT,
    "ipEnd" BIGINT,
    "asn" INTEGER,
    "confidence" "OwnershipConfidence" NOT NULL,
    "source" "AssetMappingSource" NOT NULL,
    "provenanceNote" TEXT,
    "mappingConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "createdByUserId" INTEGER,
    "updatedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingOwnership" (
    "id" SERIAL NOT NULL,
    "findingId" INTEGER NOT NULL,
    "organizationId" INTEGER,
    "status" "OwnershipResolutionStatus" NOT NULL,
    "confidence" "OwnershipConfidence",
    "matchedMappingId" INTEGER,
    "matchedPrefixLength" INTEGER,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "isIspAttribution" BOOLEAN NOT NULL DEFAULT false,
    "reasonCode" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "asOf" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "currentForFindingId" INTEGER,
    "overrideActorUserId" INTEGER,
    "overrideJustification" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FindingOwnership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssetMapping_organizationId_idx" ON "AssetMapping"("organizationId");

-- CreateIndex
CREATE INDEX "AssetMapping_mappingType_enabled_idx" ON "AssetMapping"("mappingType", "enabled");

-- CreateIndex
CREATE INDEX "AssetMapping_asn_idx" ON "AssetMapping"("asn");

-- CreateIndex
CREATE INDEX "AssetMapping_ipStart_ipEnd_idx" ON "AssetMapping"("ipStart", "ipEnd");

-- CreateIndex
CREATE UNIQUE INDEX "FindingOwnership_currentForFindingId_key" ON "FindingOwnership"("currentForFindingId");

-- CreateIndex
CREATE INDEX "FindingOwnership_findingId_idx" ON "FindingOwnership"("findingId");

-- CreateIndex
CREATE INDEX "FindingOwnership_status_idx" ON "FindingOwnership"("status");

-- CreateIndex
CREATE INDEX "FindingOwnership_organizationId_idx" ON "FindingOwnership"("organizationId");

-- AddForeignKey
ALTER TABLE "AssetMapping" ADD CONSTRAINT "AssetMapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMapping" ADD CONSTRAINT "AssetMapping_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMapping" ADD CONSTRAINT "AssetMapping_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingOwnership" ADD CONSTRAINT "FindingOwnership_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingOwnership" ADD CONSTRAINT "FindingOwnership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingOwnership" ADD CONSTRAINT "FindingOwnership_matchedMappingId_fkey" FOREIGN KEY ("matchedMappingId") REFERENCES "AssetMapping"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingOwnership" ADD CONSTRAINT "FindingOwnership_overrideActorUserId_fkey" FOREIGN KEY ("overrideActorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
