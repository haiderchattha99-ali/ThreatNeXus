-- CreateEnum
CREATE TYPE "FindingTriageDecision" AS ENUM ('IN_REVIEW', 'ESCALATED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "FindingTriageSource" AS ENUM ('ANALYST_DECISION', 'CASE_LINK', 'RECURRENCE_REOPEN');

-- CreateEnum
CREATE TYPE "CaseLifecycleState" AS ENUM ('OPEN', 'WAITING_FOR_ORG', 'CLOSURE_PENDING', 'CLOSED');

-- CreateEnum
CREATE TYPE "CaseLifecycleEventType" AS ENUM ('CREATED', 'STATE_CHANGED', 'CLOSURE_REQUESTED', 'CLOSURE_APPROVED', 'CLOSURE_REJECTED', 'REOPENED');

-- CreateEnum
CREATE TYPE "CaseFindingLinkState" AS ENUM ('LINKED', 'UNLINKED');

-- CreateEnum
CREATE TYPE "OrganizationResponseType" AS ENUM ('ACKNOWLEDGED', 'INVESTIGATING', 'REMEDIATED', 'DISPUTED', 'NO_RESPONSE', 'OTHER');

-- CreateEnum
CREATE TYPE "CaseClosureReason" AS ENUM ('REMEDIATED', 'FALSE_POSITIVE', 'ACCEPTED_RISK', 'DUPLICATE', 'OTHER');

-- CreateEnum
CREATE TYPE "CaseClosureRequestState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CaseReopenTrigger" AS ENUM ('MANUAL', 'RECURRENCE');

-- CreateEnum
CREATE TYPE "CaseRecurrenceReopenOutcome" AS ENUM ('REOPENED', 'SKIPPED_NOT_CLOSED', 'SKIPPED_CLOSURE_REASON_NOT_REMEDIATED');

-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "caseReference" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedByUserId" INTEGER,
ADD COLUMN     "closureReason" "CaseClosureReason",
ADD COLUMN     "createdByUserId" INTEGER,
ADD COLUMN     "lastReopenTrigger" "CaseReopenTrigger",
ADD COLUMN     "lastReopenedAt" TIMESTAMP(3),
ADD COLUMN     "lifecycleState" "CaseLifecycleState" NOT NULL DEFAULT 'OPEN',
ADD COLUMN     "organizationId" INTEGER,
ADD COLUMN     "reopenedCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "FindingTriage" (
    "id" SERIAL NOT NULL,
    "findingId" INTEGER NOT NULL,
    "decision" "FindingTriageDecision" NOT NULL,
    "source" "FindingTriageSource" NOT NULL DEFAULT 'ANALYST_DECISION',
    "reason" TEXT,
    "caseId" INTEGER,
    "actorUserId" INTEGER,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "currentForFindingId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FindingTriage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseFinding" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "findingId" INTEGER NOT NULL,
    "state" "CaseFindingLinkState" NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "ownershipStatusAtLink" "OwnershipResolutionStatus" NOT NULL,
    "ownershipConfidenceAtLink" "OwnershipConfidence",
    "reason" TEXT,
    "actorUserId" INTEGER,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "currentLinkKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseLifecycleEvent" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "eventType" "CaseLifecycleEventType" NOT NULL,
    "fromState" "CaseLifecycleState",
    "toState" "CaseLifecycleState" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "actorUserId" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseOrganizationResponse" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "responseType" "OrganizationResponseType" NOT NULL,
    "summary" TEXT NOT NULL,
    "reference" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseOrganizationResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseClosureRequest" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "state" "CaseClosureRequestState" NOT NULL DEFAULT 'PENDING',
    "closureReason" "CaseClosureReason" NOT NULL,
    "justification" TEXT NOT NULL,
    "requestedByUserId" INTEGER,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "reviewedByUserId" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "supportingResponseId" INTEGER,
    "activeCaseId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseClosureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseRecurrenceReopen" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "findingId" INTEGER NOT NULL,
    "findingOccurrenceId" INTEGER NOT NULL,
    "outcome" "CaseRecurrenceReopenOutcome" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseRecurrenceReopen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FindingTriage_currentForFindingId_key" ON "FindingTriage"("currentForFindingId");

-- CreateIndex
CREATE INDEX "FindingTriage_findingId_decidedAt_idx" ON "FindingTriage"("findingId", "decidedAt");

-- CreateIndex
CREATE INDEX "FindingTriage_decision_idx" ON "FindingTriage"("decision");

-- CreateIndex
CREATE INDEX "FindingTriage_caseId_idx" ON "FindingTriage"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseFinding_currentLinkKey_key" ON "CaseFinding"("currentLinkKey");

-- CreateIndex
CREATE INDEX "CaseFinding_caseId_state_idx" ON "CaseFinding"("caseId", "state");

-- CreateIndex
CREATE INDEX "CaseFinding_findingId_effectiveAt_idx" ON "CaseFinding"("findingId", "effectiveAt");

-- CreateIndex
CREATE INDEX "CaseFinding_organizationId_idx" ON "CaseFinding"("organizationId");

-- CreateIndex
CREATE INDEX "CaseLifecycleEvent_caseId_occurredAt_idx" ON "CaseLifecycleEvent"("caseId", "occurredAt");

-- CreateIndex
CREATE INDEX "CaseLifecycleEvent_eventType_idx" ON "CaseLifecycleEvent"("eventType");

-- CreateIndex
CREATE INDEX "CaseOrganizationResponse_caseId_occurredAt_idx" ON "CaseOrganizationResponse"("caseId", "occurredAt");

-- CreateIndex
CREATE INDEX "CaseOrganizationResponse_caseId_responseType_idx" ON "CaseOrganizationResponse"("caseId", "responseType");

-- CreateIndex
CREATE UNIQUE INDEX "CaseClosureRequest_activeCaseId_key" ON "CaseClosureRequest"("activeCaseId");

-- CreateIndex
CREATE INDEX "CaseClosureRequest_caseId_requestedAt_idx" ON "CaseClosureRequest"("caseId", "requestedAt");

-- CreateIndex
CREATE INDEX "CaseClosureRequest_state_idx" ON "CaseClosureRequest"("state");

-- CreateIndex
CREATE INDEX "CaseRecurrenceReopen_caseId_processedAt_idx" ON "CaseRecurrenceReopen"("caseId", "processedAt");

-- CreateIndex
CREATE INDEX "CaseRecurrenceReopen_findingId_idx" ON "CaseRecurrenceReopen"("findingId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseRecurrenceReopen_findingOccurrenceId_caseId_key" ON "CaseRecurrenceReopen"("findingOccurrenceId", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "Case_caseReference_key" ON "Case"("caseReference");

-- CreateIndex
CREATE INDEX "Case_lifecycleState_idx" ON "Case"("lifecycleState");

-- CreateIndex
CREATE INDEX "Case_organizationId_lifecycleState_idx" ON "Case"("organizationId", "lifecycleState");

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingTriage" ADD CONSTRAINT "FindingTriage_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingTriage" ADD CONSTRAINT "FindingTriage_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingTriage" ADD CONSTRAINT "FindingTriage_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFinding" ADD CONSTRAINT "CaseFinding_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFinding" ADD CONSTRAINT "CaseFinding_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFinding" ADD CONSTRAINT "CaseFinding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseFinding" ADD CONSTRAINT "CaseFinding_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseLifecycleEvent" ADD CONSTRAINT "CaseLifecycleEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseLifecycleEvent" ADD CONSTRAINT "CaseLifecycleEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseOrganizationResponse" ADD CONSTRAINT "CaseOrganizationResponse_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseOrganizationResponse" ADD CONSTRAINT "CaseOrganizationResponse_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseClosureRequest" ADD CONSTRAINT "CaseClosureRequest_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseClosureRequest" ADD CONSTRAINT "CaseClosureRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseClosureRequest" ADD CONSTRAINT "CaseClosureRequest_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseClosureRequest" ADD CONSTRAINT "CaseClosureRequest_supportingResponseId_fkey" FOREIGN KEY ("supportingResponseId") REFERENCES "CaseOrganizationResponse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseRecurrenceReopen" ADD CONSTRAINT "CaseRecurrenceReopen_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseRecurrenceReopen" ADD CONSTRAINT "CaseRecurrenceReopen_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseRecurrenceReopen" ADD CONSTRAINT "CaseRecurrenceReopen_findingOccurrenceId_fkey" FOREIGN KEY ("findingOccurrenceId") REFERENCES "FindingOccurrence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

