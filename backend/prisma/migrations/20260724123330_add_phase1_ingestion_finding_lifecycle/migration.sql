-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('ACCESSIBLE_RDP');

-- CreateEnum
CREATE TYPE "TransportProtocol" AS ENUM ('TCP');

-- CreateEnum
CREATE TYPE "RawReportStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'COMPLETED', 'PARTIALLY_VALID', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RawReportRowStatus" AS ENUM ('VALID', 'INVALID');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "FindingOccurrenceAction" AS ENUM ('CREATED', 'PERSISTED', 'RECURRED', 'HISTORICAL');

-- CreateTable
CREATE TABLE "RawReport" (
    "id" SERIAL NOT NULL,
    "reportType" "ReportType" NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "sourceFileName" TEXT NOT NULL,
    "sourceFileSha256" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL,
    "rawContent" BYTEA NOT NULL,
    "observationDate" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingestedByUserId" INTEGER,
    "tlp" "TlpLabel" NOT NULL DEFAULT 'AMBER',
    "status" "RawReportStatus" NOT NULL DEFAULT 'RECEIVED',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" JSONB,
    "processingAttempts" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RawReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawReportRow" (
    "id" SERIAL NOT NULL,
    "rawReportId" INTEGER NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "normalizedPayload" JSONB,
    "status" "RawReportRowStatus" NOT NULL,
    "validationErrors" JSONB,
    "duplicateInReport" BOOLEAN NOT NULL DEFAULT false,
    "findingOccurrenceId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawReportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" SERIAL NOT NULL,
    "indicatorValue" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "protocol" "TransportProtocol" NOT NULL,
    "reportType" "ReportType" NOT NULL,
    "status" "FindingStatus" NOT NULL DEFAULT 'OPEN',
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "recurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "closedByUserId" INTEGER,
    "closureReason" TEXT,
    "closedThroughObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingOccurrence" (
    "id" SERIAL NOT NULL,
    "findingId" INTEGER NOT NULL,
    "rawReportId" INTEGER NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "action" "FindingOccurrenceAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FindingOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RawReport_sourceFileSha256_key" ON "RawReport"("sourceFileSha256");

-- CreateIndex
CREATE INDEX "RawReport_reportType_ingestedAt_idx" ON "RawReport"("reportType", "ingestedAt");

-- CreateIndex
CREATE INDEX "RawReport_status_idx" ON "RawReport"("status");

-- CreateIndex
CREATE INDEX "RawReportRow_findingOccurrenceId_idx" ON "RawReportRow"("findingOccurrenceId");

-- CreateIndex
CREATE UNIQUE INDEX "RawReportRow_rawReportId_rowNumber_key" ON "RawReportRow"("rawReportId", "rowNumber");

-- CreateIndex
CREATE INDEX "Finding_status_idx" ON "Finding"("status");

-- CreateIndex
CREATE INDEX "Finding_lastSeen_idx" ON "Finding"("lastSeen");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_indicatorValue_port_protocol_reportType_key" ON "Finding"("indicatorValue", "port", "protocol", "reportType");

-- CreateIndex
CREATE INDEX "FindingOccurrence_rawReportId_idx" ON "FindingOccurrence"("rawReportId");

-- CreateIndex
CREATE UNIQUE INDEX "FindingOccurrence_findingId_rawReportId_key" ON "FindingOccurrence"("findingId", "rawReportId");

-- AddForeignKey
ALTER TABLE "RawReport" ADD CONSTRAINT "RawReport_ingestedByUserId_fkey" FOREIGN KEY ("ingestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawReportRow" ADD CONSTRAINT "RawReportRow_rawReportId_fkey" FOREIGN KEY ("rawReportId") REFERENCES "RawReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawReportRow" ADD CONSTRAINT "RawReportRow_findingOccurrenceId_fkey" FOREIGN KEY ("findingOccurrenceId") REFERENCES "FindingOccurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingOccurrence" ADD CONSTRAINT "FindingOccurrence_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingOccurrence" ADD CONSTRAINT "FindingOccurrence_rawReportId_fkey" FOREIGN KEY ("rawReportId") REFERENCES "RawReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
