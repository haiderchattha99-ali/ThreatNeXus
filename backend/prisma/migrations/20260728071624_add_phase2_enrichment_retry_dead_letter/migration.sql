-- AlterEnum
ALTER TYPE "IocEnrichmentStatus" ADD VALUE 'DEAD_LETTER';

-- AlterTable
ALTER TABLE "IocEnrichment" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deadLetteredAt" TIMESTAMP(3),
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "terminalReasonCode" TEXT;

-- CreateIndex
CREATE INDEX "IocEnrichment_status_nextAttemptAt_requestedAt_idx" ON "IocEnrichment"("status", "nextAttemptAt", "requestedAt");
