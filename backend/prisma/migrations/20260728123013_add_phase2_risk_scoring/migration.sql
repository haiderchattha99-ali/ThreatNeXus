-- CreateEnum
CREATE TYPE "RiskBand" AS ENUM ('INFORMATIONAL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskCalculationTrigger" AS ENUM ('INGESTION', 'ENRICHMENT_COMPLETED', 'OWNERSHIP_CHANGED', 'MANUAL', 'SYSTEM_RECALCULATION');

-- CreateEnum
CREATE TYPE "RiskFactorApplicability" AS ENUM ('APPLIED', 'NOT_AVAILABLE', 'NOT_APPLICABLE');

-- CreateTable
CREATE TABLE "RiskScore" (
    "id" SERIAL NOT NULL,
    "findingId" INTEGER NOT NULL,
    "algorithmVersion" TEXT NOT NULL,
    "configurationVersion" TEXT NOT NULL,
    "configurationFingerprint" TEXT NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "scoreBasisPoints" INTEGER NOT NULL,
    "riskBand" "RiskBand" NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger" "RiskCalculationTrigger" NOT NULL,
    "actorUserId" INTEGER,
    "justification" TEXT,
    "currentForFindingId" INTEGER,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskFactorContribution" (
    "id" SERIAL NOT NULL,
    "riskScoreId" INTEGER NOT NULL,
    "factorKey" TEXT NOT NULL,
    "applicability" "RiskFactorApplicability" NOT NULL,
    "contributionBasisPoints" INTEGER NOT NULL,
    "maximumContributionBasisPoints" INTEGER NOT NULL,
    "normalizedInputValue" TEXT,
    "explanationCode" TEXT NOT NULL,
    "evidenceSnapshot" JSONB,
    "displayOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskFactorContribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RiskScore_currentForFindingId_key" ON "RiskScore"("currentForFindingId");

-- CreateIndex
CREATE INDEX "RiskScore_findingId_calculatedAt_idx" ON "RiskScore"("findingId", "calculatedAt");

-- CreateIndex
CREATE INDEX "RiskScore_findingId_inputFingerprint_configurationVersion_idx" ON "RiskScore"("findingId", "inputFingerprint", "configurationVersion");

-- CreateIndex
CREATE INDEX "RiskScore_riskBand_idx" ON "RiskScore"("riskBand");

-- CreateIndex
CREATE INDEX "RiskFactorContribution_riskScoreId_displayOrder_idx" ON "RiskFactorContribution"("riskScoreId", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "RiskFactorContribution_riskScoreId_factorKey_key" ON "RiskFactorContribution"("riskScoreId", "factorKey");

-- AddForeignKey
ALTER TABLE "RiskScore" ADD CONSTRAINT "RiskScore_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskScore" ADD CONSTRAINT "RiskScore_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskFactorContribution" ADD CONSTRAINT "RiskFactorContribution_riskScoreId_fkey" FOREIGN KEY ("riskScoreId") REFERENCES "RiskScore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
