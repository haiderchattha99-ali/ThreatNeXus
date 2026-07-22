-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'ANALYST', 'REVIEWER', 'VIEWER');

-- CreateEnum
CREATE TYPE "TlpLabel" AS ENUM ('CLEAR', 'GREEN', 'AMBER', 'AMBER_STRICT', 'RED');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "outcome" "AuditOutcome" NOT NULL,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "actorRole" "Role",
    "sourceIp" TEXT,
    "requestId" TEXT,
    "method" TEXT,
    "path" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "tlp" "TlpLabel" NOT NULL DEFAULT 'AMBER',
    "reason" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_occurredAt_idx" ON "AuditLog"("occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");
