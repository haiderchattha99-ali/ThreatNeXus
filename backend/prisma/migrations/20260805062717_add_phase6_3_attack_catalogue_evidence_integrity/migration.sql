-- Phase 6.3 - pinned MITRE ATT&CK catalogue validation and evidence integrity.
--
-- PURELY ADDITIVE. Every column added here is NULLABLE, or BOOLEAN NOT NULL
-- DEFAULT false. No existing column is altered, narrowed, renamed or dropped,
-- and no row is rewritten or backfilled.
--
-- That is deliberate rather than incidental. Mappings written before this
-- migration were format-checked only and carry no evidence quote and no
-- confidences. Backfilling them - with a default, a guess, or a retroactive
-- catalogue lookup - would either destroy the record of what was actually
-- known when the mapping was made, or mark rows verified that nothing
-- verified. They keep their NULLs, catalogueVerified stays false, and every
-- read path labels them legacy/unverified. See
-- services/framework/frameworkMappingRules.js LEGACY_MAPPING_NOTE.
--
-- CaseFrameworkNoMappingAssertion is new: it records the explicit, honest
-- determination that no reference in a framework applies to a case, so that
-- state stops being indistinguishable from "nobody has looked yet".

-- CreateEnum
CREATE TYPE "FrameworkConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "FrameworkEvidenceQuoteSource" AS ENUM ('FINDING_RECORD', 'RAW_REPORT_ROW', 'CASE_RESPONSE');

-- CreateEnum
CREATE TYPE "FrameworkNoMappingState" AS ENUM ('ASSERTED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "AiFrameworkMappingSuggestion" ADD COLUMN     "catalogueVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "catalogueVersion" TEXT,
ADD COLUMN     "evidenceConfidence" "FrameworkConfidence",
ADD COLUMN     "evidenceQuote" TEXT,
ADD COLUMN     "evidenceQuoteSource" "FrameworkEvidenceQuoteSource",
ADD COLUMN     "mappingConfidence" "FrameworkConfidence";

-- AlterTable
ALTER TABLE "CaseFrameworkMapping" ADD COLUMN     "catalogueChecksum" TEXT,
ADD COLUMN     "catalogueVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "catalogueVersion" TEXT,
ADD COLUMN     "evidenceConfidence" "FrameworkConfidence",
ADD COLUMN     "evidenceQuote" TEXT,
ADD COLUMN     "evidenceQuoteLocator" TEXT,
ADD COLUMN     "evidenceQuoteSource" "FrameworkEvidenceQuoteSource",
ADD COLUMN     "mappingConfidence" "FrameworkConfidence";

-- CreateTable
CREATE TABLE "CaseFrameworkNoMappingAssertion" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "framework" "FrameworkFamily" NOT NULL,
    "rationale" TEXT NOT NULL,
    "state" "FrameworkNoMappingState" NOT NULL,
    "actorUserId" INTEGER,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "currentAssertionKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseFrameworkNoMappingAssertion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CaseFrameworkNoMappingAssertion_currentAssertionKey_key" ON "CaseFrameworkNoMappingAssertion"("currentAssertionKey");

-- CreateIndex
CREATE INDEX "CaseFrameworkNoMappingAssertion_caseId_state_idx" ON "CaseFrameworkNoMappingAssertion"("caseId", "state");

-- CreateIndex
CREATE INDEX "CaseFrameworkNoMappingAssertion_organizationId_idx" ON "CaseFrameworkNoMappingAssertion"("organizationId");

-- CreateIndex
CREATE INDEX "CaseFrameworkNoMappingAssertion_caseId_effectiveAt_idx" ON "CaseFrameworkNoMappingAssertion"("caseId", "effectiveAt");

-- CreateIndex
CREATE INDEX "CaseFrameworkMapping_catalogueVerified_idx" ON "CaseFrameworkMapping"("catalogueVerified");

-- AddForeignKey
ALTER TABLE "CaseFrameworkNoMappingAssertion" ADD CONSTRAINT "CaseFrameworkNoMappingAssertion_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFrameworkNoMappingAssertion" ADD CONSTRAINT "CaseFrameworkNoMappingAssertion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFrameworkNoMappingAssertion" ADD CONSTRAINT "CaseFrameworkNoMappingAssertion_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
