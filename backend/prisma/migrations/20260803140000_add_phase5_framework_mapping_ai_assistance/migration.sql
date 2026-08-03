-- CreateEnum
CREATE TYPE "FrameworkFamily" AS ENUM ('MITRE_ATTACK', 'NIST_CSF', 'CIS_CONTROLS');

-- CreateEnum
CREATE TYPE "FrameworkMappingScope" AS ENUM ('CASE', 'FINDING');

-- CreateEnum
CREATE TYPE "FrameworkMappingState" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "FrameworkEvidenceBasis" AS ENUM ('OBSERVED_BEHAVIOR', 'CONTROL_GAP', 'REMEDIATION_ALIGNMENT', 'ANALYST_ASSESSMENT');

-- CreateEnum
CREATE TYPE "FrameworkMappingSource" AS ENUM ('MANUAL', 'AI_SUGGESTION_PROMOTED');

-- CreateEnum
CREATE TYPE "AiSuggestionRunStatus" AS ENUM ('DISABLED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiSuggestionState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AiSuggestionDecisionType" AS ENUM ('APPROVE', 'REJECT');

-- CreateTable
CREATE TABLE "CaseFrameworkMapping" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "framework" "FrameworkFamily" NOT NULL,
    "frameworkVersion" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "referenceTitle" TEXT NOT NULL,
    "mappingScope" "FrameworkMappingScope" NOT NULL,
    "evidenceBasis" "FrameworkEvidenceBasis" NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidenceFindingId" INTEGER,
    "state" "FrameworkMappingState" NOT NULL,
    "source" "FrameworkMappingSource" NOT NULL DEFAULT 'MANUAL',
    "actorUserId" INTEGER,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "currentMappingKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseFrameworkMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSuggestionRun" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "status" "AiSuggestionRunStatus" NOT NULL,
    "providerName" TEXT NOT NULL,
    "providerModel" TEXT,
    "promptTemplateVersion" TEXT NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "suggestionCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "reasonCode" TEXT NOT NULL,
    "requestContext" TEXT,
    "actorUserId" INTEGER,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSuggestionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiFrameworkMappingSuggestion" (
    "id" SERIAL NOT NULL,
    "runId" INTEGER NOT NULL,
    "caseId" INTEGER NOT NULL,
    "framework" "FrameworkFamily" NOT NULL,
    "frameworkVersion" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "referenceTitle" TEXT NOT NULL,
    "mappingScope" "FrameworkMappingScope" NOT NULL,
    "evidenceBasis" "FrameworkEvidenceBasis" NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidenceFindingId" INTEGER,
    "providerConfidence" INTEGER,
    "inputFingerprint" TEXT NOT NULL,
    "state" "AiSuggestionState" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" INTEGER,
    "decisionReason" TEXT,
    "promotedMappingId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiFrameworkMappingSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSuggestionDecision" (
    "id" SERIAL NOT NULL,
    "suggestionId" INTEGER NOT NULL,
    "decision" "AiSuggestionDecisionType" NOT NULL,
    "outcomeCode" TEXT NOT NULL,
    "reason" TEXT,
    "actorUserId" INTEGER,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSuggestionDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CaseFrameworkMapping_currentMappingKey_key" ON "CaseFrameworkMapping"("currentMappingKey");

-- CreateIndex
CREATE INDEX "CaseFrameworkMapping_caseId_state_idx" ON "CaseFrameworkMapping"("caseId", "state");

-- CreateIndex
CREATE INDEX "CaseFrameworkMapping_caseId_framework_state_idx" ON "CaseFrameworkMapping"("caseId", "framework", "state");

-- CreateIndex
CREATE INDEX "CaseFrameworkMapping_evidenceFindingId_idx" ON "CaseFrameworkMapping"("evidenceFindingId");

-- CreateIndex
CREATE INDEX "CaseFrameworkMapping_organizationId_idx" ON "CaseFrameworkMapping"("organizationId");

-- CreateIndex
CREATE INDEX "CaseFrameworkMapping_caseId_effectiveAt_idx" ON "CaseFrameworkMapping"("caseId", "effectiveAt");

-- CreateIndex
CREATE INDEX "AiSuggestionRun_caseId_requestedAt_idx" ON "AiSuggestionRun"("caseId", "requestedAt");

-- CreateIndex
CREATE INDEX "AiSuggestionRun_status_idx" ON "AiSuggestionRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AiFrameworkMappingSuggestion_promotedMappingId_key" ON "AiFrameworkMappingSuggestion"("promotedMappingId");

-- CreateIndex
CREATE INDEX "AiFrameworkMappingSuggestion_caseId_state_idx" ON "AiFrameworkMappingSuggestion"("caseId", "state");

-- CreateIndex
CREATE INDEX "AiFrameworkMappingSuggestion_runId_idx" ON "AiFrameworkMappingSuggestion"("runId");

-- CreateIndex
CREATE INDEX "AiFrameworkMappingSuggestion_caseId_createdAt_idx" ON "AiFrameworkMappingSuggestion"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "AiSuggestionDecision_suggestionId_decidedAt_idx" ON "AiSuggestionDecision"("suggestionId", "decidedAt");

-- CreateIndex
CREATE INDEX "AiSuggestionDecision_decision_idx" ON "AiSuggestionDecision"("decision");

-- AddForeignKey
ALTER TABLE "CaseFrameworkMapping" ADD CONSTRAINT "CaseFrameworkMapping_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFrameworkMapping" ADD CONSTRAINT "CaseFrameworkMapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFrameworkMapping" ADD CONSTRAINT "CaseFrameworkMapping_evidenceFindingId_fkey" FOREIGN KEY ("evidenceFindingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFrameworkMapping" ADD CONSTRAINT "CaseFrameworkMapping_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSuggestionRun" ADD CONSTRAINT "AiSuggestionRun_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSuggestionRun" ADD CONSTRAINT "AiSuggestionRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSuggestionRun" ADD CONSTRAINT "AiSuggestionRun_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFrameworkMappingSuggestion" ADD CONSTRAINT "AiFrameworkMappingSuggestion_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiSuggestionRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFrameworkMappingSuggestion" ADD CONSTRAINT "AiFrameworkMappingSuggestion_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFrameworkMappingSuggestion" ADD CONSTRAINT "AiFrameworkMappingSuggestion_evidenceFindingId_fkey" FOREIGN KEY ("evidenceFindingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFrameworkMappingSuggestion" ADD CONSTRAINT "AiFrameworkMappingSuggestion_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFrameworkMappingSuggestion" ADD CONSTRAINT "AiFrameworkMappingSuggestion_promotedMappingId_fkey" FOREIGN KEY ("promotedMappingId") REFERENCES "CaseFrameworkMapping"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSuggestionDecision" ADD CONSTRAINT "AiSuggestionDecision_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "AiFrameworkMappingSuggestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSuggestionDecision" ADD CONSTRAINT "AiSuggestionDecision_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
