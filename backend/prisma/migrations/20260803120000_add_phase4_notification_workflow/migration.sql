-- CreateEnum
CREATE TYPE "NotificationLifecycleState" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NotificationLifecycleEventType" AS ENUM ('DRAFT_CREATED', 'REVISION_CREATED', 'SUBMITTED_FOR_REVIEW', 'APPROVED', 'REJECTED', 'EXPORTED', 'DELIVERY_RECORDED');

-- CreateEnum
CREATE TYPE "NotificationExportFormat" AS ENUM ('EML', 'TXT');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('SENT_MANUALLY', 'DELIVERED', 'FAILED', 'BOUNCED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByUserId" INTEGER,
ADD COLUMN     "approvedRevisionId" INTEGER,
ADD COLUMN     "caseId" INTEGER,
ADD COLUMN     "createdByUserId" INTEGER,
ADD COLUMN     "lifecycleState" "NotificationLifecycleState" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "notificationReference" TEXT,
ADD COLUMN     "organizationId" INTEGER;

-- CreateTable
CREATE TABLE "NotificationRevision" (
    "id" SERIAL NOT NULL,
    "notificationId" INTEGER NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "remediationGuidance" TEXT,
    "recipientName" TEXT,
    "recipientEmail" TEXT,
    "analystNotes" TEXT,
    "contentChecksum" TEXT NOT NULL,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "currentForNotificationId" INTEGER,

    CONSTRAINT "NotificationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLifecycleEvent" (
    "id" SERIAL NOT NULL,
    "notificationId" INTEGER NOT NULL,
    "eventType" "NotificationLifecycleEventType" NOT NULL,
    "fromState" "NotificationLifecycleState",
    "toState" "NotificationLifecycleState" NOT NULL,
    "revisionId" INTEGER NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "actorUserId" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationExport" (
    "id" SERIAL NOT NULL,
    "notificationId" INTEGER NOT NULL,
    "revisionId" INTEGER NOT NULL,
    "format" "NotificationExportFormat" NOT NULL,
    "artifactChecksum" TEXT NOT NULL,
    "artifactByteLength" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "exportedByUserId" INTEGER,
    "exportedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDeliveryEvent" (
    "id" SERIAL NOT NULL,
    "notificationId" INTEGER NOT NULL,
    "exportId" INTEGER,
    "revisionId" INTEGER,
    "status" "NotificationDeliveryStatus" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference" TEXT,
    "note" TEXT,
    "recordedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDeliveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationRevision_currentForNotificationId_key" ON "NotificationRevision"("currentForNotificationId");

-- CreateIndex
CREATE INDEX "NotificationRevision_notificationId_createdAt_idx" ON "NotificationRevision"("notificationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationRevision_notificationId_revisionNumber_key" ON "NotificationRevision"("notificationId", "revisionNumber");

-- CreateIndex
CREATE INDEX "NotificationLifecycleEvent_notificationId_occurredAt_idx" ON "NotificationLifecycleEvent"("notificationId", "occurredAt");

-- CreateIndex
CREATE INDEX "NotificationLifecycleEvent_eventType_idx" ON "NotificationLifecycleEvent"("eventType");

-- CreateIndex
CREATE INDEX "NotificationLifecycleEvent_revisionId_idx" ON "NotificationLifecycleEvent"("revisionId");

-- CreateIndex
CREATE INDEX "NotificationExport_notificationId_exportedAt_idx" ON "NotificationExport"("notificationId", "exportedAt");

-- CreateIndex
CREATE INDEX "NotificationExport_revisionId_idx" ON "NotificationExport"("revisionId");

-- CreateIndex
CREATE INDEX "NotificationDeliveryEvent_notificationId_occurredAt_idx" ON "NotificationDeliveryEvent"("notificationId", "occurredAt");

-- CreateIndex
CREATE INDEX "NotificationDeliveryEvent_exportId_idx" ON "NotificationDeliveryEvent"("exportId");

-- CreateIndex
CREATE INDEX "NotificationDeliveryEvent_status_idx" ON "NotificationDeliveryEvent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_notificationReference_key" ON "Notification"("notificationReference");

-- CreateIndex
CREATE INDEX "Notification_lifecycleState_idx" ON "Notification"("lifecycleState");

-- CreateIndex
CREATE INDEX "Notification_caseId_idx" ON "Notification"("caseId");

-- CreateIndex
CREATE INDEX "Notification_organizationId_lifecycleState_idx" ON "Notification"("organizationId", "lifecycleState");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_approvedRevisionId_fkey" FOREIGN KEY ("approvedRevisionId") REFERENCES "NotificationRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRevision" ADD CONSTRAINT "NotificationRevision_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRevision" ADD CONSTRAINT "NotificationRevision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLifecycleEvent" ADD CONSTRAINT "NotificationLifecycleEvent_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLifecycleEvent" ADD CONSTRAINT "NotificationLifecycleEvent_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "NotificationRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLifecycleEvent" ADD CONSTRAINT "NotificationLifecycleEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationExport" ADD CONSTRAINT "NotificationExport_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationExport" ADD CONSTRAINT "NotificationExport_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "NotificationRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationExport" ADD CONSTRAINT "NotificationExport_exportedByUserId_fkey" FOREIGN KEY ("exportedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDeliveryEvent" ADD CONSTRAINT "NotificationDeliveryEvent_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDeliveryEvent" ADD CONSTRAINT "NotificationDeliveryEvent_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "NotificationExport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDeliveryEvent" ADD CONSTRAINT "NotificationDeliveryEvent_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "NotificationRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDeliveryEvent" ADD CONSTRAINT "NotificationDeliveryEvent_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

