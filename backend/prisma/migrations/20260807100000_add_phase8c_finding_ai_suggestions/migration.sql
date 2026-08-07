-- Phase 8C - analyst-assist AI suggestion drafts on a single Finding
-- (summary / explanation).
--
-- PURELY ADDITIVE. Two new enums, one new table, no change to any existing
-- column, model, or relation. No row anywhere is rewritten or backfilled.
--
-- Deliberately a SIMPLER shape than Phase 5's AiSuggestionRun +
-- AiFrameworkMappingSuggestion pair: a narrative draft has no downstream
-- authoritative record to promote into (unlike an ATT&CK mapping), so one
-- request produces exactly one row and there is no separate "run" table.

-- CreateEnum
CREATE TYPE "FindingAiSuggestionType" AS ENUM ('SUMMARY', 'EXPLANATION');

-- CreateEnum
CREATE TYPE "FindingAiSuggestionStatus" AS ENUM ('DRAFT', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "FindingAiSuggestion" (
    "id" SERIAL NOT NULL,
    "findingId" INTEGER NOT NULL,
    "suggestionType" "FindingAiSuggestionType" NOT NULL,
    "status" "FindingAiSuggestionStatus" NOT NULL DEFAULT 'DRAFT',
    "proposedText" TEXT NOT NULL,
    "evidenceReferences" JSONB NOT NULL,
    "providerName" TEXT NOT NULL,
    "providerModel" TEXT,
    "promptTemplateVersion" TEXT NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "requestContext" TEXT,
    "requestedByUserId" INTEGER,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" INTEGER,
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FindingAiSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FindingAiSuggestion_findingId_status_idx" ON "FindingAiSuggestion"("findingId", "status");

-- CreateIndex
CREATE INDEX "FindingAiSuggestion_findingId_suggestionType_idx" ON "FindingAiSuggestion"("findingId", "suggestionType");

-- CreateIndex
CREATE INDEX "FindingAiSuggestion_findingId_createdAt_idx" ON "FindingAiSuggestion"("findingId", "createdAt");

-- AddForeignKey
ALTER TABLE "FindingAiSuggestion" ADD CONSTRAINT "FindingAiSuggestion_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingAiSuggestion" ADD CONSTRAINT "FindingAiSuggestion_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingAiSuggestion" ADD CONSTRAINT "FindingAiSuggestion_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
